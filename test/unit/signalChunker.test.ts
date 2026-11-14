// QA-110: the signal file is read as bytes. SignalChunker decodes a line only after its newline arrived; signalTail and
// signalPrefixKept decide whether the file was appended to or replaced.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_LIMITS, SIGNAL_TAIL_BYTES, SignalChunker, parseSignalChunk, signalPrefixKept, signalTail } from '../../src/core/ai/agentSignal';
import type { AgentSignal } from '../../src/core/ai/agentSignal';
import { must } from '../support/fixtures';

const enc = new TextEncoder();
const bytesOf = (s: string): Uint8Array => enc.encode(s);
const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** Feeds `chunks` to a fresh chunker and collects everything. */
function feed(chunks: Uint8Array[]): { signals: AgentSignal[]; skipped: number } {
  const c = new SignalChunker();
  const signals: AgentSignal[] = [];
  let skipped = 0;
  for (const chunk of chunks) {
    const r = c.push(chunk);
    signals.push(...r.signals);
    skipped += r.skipped;
  }
  return { signals, skipped };
}

describe('SignalChunker: lines that contain 2-, 3- and 4-byte characters, split at every byte', () => {
  // a path with a 2-byte (é), 3-byte (日, 語) and 4-byte (😀, 𝒳) character
  const hard = line({ agent: 'claude-code', file: '/ws/é日語/😀𝒳.ts', session: 'séssion-日' });
  const all = bytesOf(`${hard}${line({ agent: 'x', file: '/ws/plain.ts' })}`);
  const expected = [
    { agent: 'claude-code', file: '/ws/é日語/😀𝒳.ts', session: 'séssion-日' },
    { agent: 'x', file: '/ws/plain.ts' },
  ];

  it('in one piece it parses both lines', () => {
    assert.deepEqual(feed([all]).signals, expected);
    assert.ok(all.length > hard.length, 'sanity: multi-byte characters make the byte length longer than the character length');
    assert.ok([...bytesOf(hard)].some((b) => b >= 0xf0), 'a 4-byte character is in the line');
    assert.ok([...bytesOf(hard)].some((b) => b >= 0xe0 && b < 0xf0), 'a 3-byte character is in the line');
  });

  it('split in two at EVERY byte offset (including inside a character) gives exactly the same signals and no skipped line', () => {
    for (let cut = 0; cut <= all.length; cut += 1) {
      const r = feed([all.subarray(0, cut), all.subarray(cut)]);
      assert.deepEqual(r.signals, expected, `cut at byte ${cut}`);
      assert.equal(r.skipped, 0, `cut at byte ${cut}`);
    }
  });

  it('split in THREE at every pair of offsets inside the first line', () => {
    const n = bytesOf(hard).length;
    for (let a = 0; a <= n; a += 1) {
      for (let b = a; b <= n; b += 1) {
        const r = feed([all.subarray(0, a), all.subarray(a, b), all.subarray(b)]);
        assert.deepEqual(r.signals, expected, `cuts at ${a} and ${b}`);
      }
    }
  });

  it('one byte at a time gives the same signals', () => {
    const r = feed(Array.from(all, (_, i) => all.subarray(i, i + 1)));
    assert.deepEqual(r.signals, expected);
    assert.equal(r.skipped, 0);
  });

  it('the OLD text-based reader would have lost the line (the reason for the chunker): decoding the two halves separately breaks it', () => {
    const cut = bytesOf('{"agent":"x","file":"/ws/').length + 1; // inside the 3-byte character of the path below
    const text = bytesOf(line({ agent: 'x', file: '/ws/日.ts' }));
    const first = new TextDecoder('utf-8').decode(text.subarray(0, cut));
    const second = new TextDecoder('utf-8').decode(text.subarray(cut));
    const oldWay = parseSignalChunk('', first + second);
    assert.equal(oldWay.signals[0]?.file === '/ws/日.ts', false, 'a character cut in half decodes as U+FFFD');
    assert.deepEqual(feed([text.subarray(0, cut), text.subarray(cut)]).signals, [{ agent: 'x', file: '/ws/日.ts' }]);
  });
});

describe('SignalChunker: partial tail, line endings, junk', () => {
  it('a line without its newline is kept and produces nothing; the next push completes it', () => {
    const c = new SignalChunker();
    const full = line({ agent: 'x', file: '/ws/a.ts' });
    const half = bytesOf(full).subarray(0, 12);
    assert.deepEqual(c.push(half), { signals: [], skipped: 0 });
    assert.deepEqual(c.push(bytesOf(full).subarray(12)).signals, [{ agent: 'x', file: '/ws/a.ts' }]);
  });

  it('a complete line followed by a partial one: the first is delivered at once, the second waits', () => {
    const c = new SignalChunker();
    const a = line({ agent: 'x', file: '/ws/a.ts' });
    const b = line({ agent: 'y', file: '/ws/b.ts' });
    const first = c.push(bytesOf(a + b.slice(0, 10)));
    assert.deepEqual(first.signals, [{ agent: 'x', file: '/ws/a.ts' }]);
    assert.deepEqual(c.push(bytesOf(b.slice(10))).signals, [{ agent: 'y', file: '/ws/b.ts' }]);
  });

  it('CRLF line endings work, also when the CR and the LF arrive in different pushes', () => {
    const text = `${JSON.stringify({ agent: 'x', file: '/ws/a.ts' })}\r\n${JSON.stringify({ agent: 'y', file: '/ws/b.ts' })}\r\n`;
    const whole = feed([bytesOf(text)]);
    assert.equal(whole.signals.length, 2);
    assert.equal(whole.skipped, 0);
    const b = bytesOf(text);
    const cut = text.indexOf('\r') + 1;
    assert.equal(feed([b.subarray(0, cut), b.subarray(cut)]).signals.length, 2);
  });

  it('blank lines are ignored and not counted; malformed lines are counted as skipped', () => {
    const r = feed([bytesOf(`\n\n   \nnot json\n${line({ agent: 'x' })}[]\n${line({ agent: 'x', file: '/ws/a.ts' })}`)]);
    assert.equal(r.signals.length, 1);
    assert.equal(r.skipped, 3);
  });

  it('invalid UTF-8 bytes never throw: the line is skipped or its text replaced, the next line is fine', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0x0a]);
    const good = bytesOf(line({ agent: 'x', file: '/ws/a.ts' }));
    const all = new Uint8Array(bad.length + good.length);
    all.set(bad, 0);
    all.set(good, bad.length);
    assert.doesNotThrow(() => feed([all]));
    assert.deepEqual(feed([all]).signals, [{ agent: 'x', file: '/ws/a.ts' }]);
  });

  it('empty pushes are harmless, and reset() forgets an unfinished line and a skip in progress', () => {
    const c = new SignalChunker();
    assert.deepEqual(c.push(new Uint8Array(0)), { signals: [], skipped: 0 });
    c.push(bytesOf('{"agent":"x","fi'));
    c.reset();
    const after = c.push(bytesOf(line({ agent: 'y', file: '/ws/b.ts' })));
    assert.deepEqual(after.signals, [{ agent: 'y', file: '/ws/b.ts' }], 'the half line is not glued to the next one');
    const big = new SignalChunker();
    big.push(new Uint8Array(SIGNAL_LIMITS.LINE * 4 + 10).fill(0x71));
    big.reset();
    assert.equal(big.push(bytesOf(line({ agent: 'z', file: '/ws/c.ts' }))).signals.length, 1, 'reset also ends a skip');
  });

  it('at most 500 signals per push; the surplus is counted as skipped', () => {
    const many = Array.from({ length: 700 }, (_, i) => line({ agent: 'x', file: `/ws/f${i}.ts` })).join('');
    const r = feed([bytesOf(many)]);
    assert.equal(r.signals.length, SIGNAL_LIMITS.RECORDS);
    assert.equal(r.skipped, 200);
  });
});

describe('SignalChunker: oversize lines', () => {
  it('a complete line over 4096 characters is skipped and counted, its neighbours are read', () => {
    const huge = line({ agent: 'x', file: '/ws/a.ts', pad: 'p'.repeat(5000) });
    const r = feed([bytesOf(line({ agent: 'a', file: '/ws/1.ts' }) + huge + line({ agent: 'b', file: '/ws/2.ts' }))]);
    assert.deepEqual(
      r.signals.map((s) => s.file),
      ['/ws/1.ts', '/ws/2.ts'],
    );
    assert.equal(r.skipped, 1);
  });

  it('an unfinished line that is already far too long is dropped from memory and ends at its newline (counted once)', () => {
    const c = new SignalChunker();
    const first = c.push(new Uint8Array(SIGNAL_LIMITS.LINE * 4 + 1).fill(0x71));
    assert.deepEqual(first, { signals: [], skipped: 0 });
    // more of the same line, still no newline: nothing is kept, nothing is reported
    assert.deepEqual(c.push(new Uint8Array(50_000).fill(0x71)), { signals: [], skipped: 0 });
    const end = c.push(bytesOf(`tail of the long line\n${line({ agent: 'x', file: '/ws/ok.ts' })}`));
    assert.deepEqual(end.signals, [{ agent: 'x', file: '/ws/ok.ts' }]);
    assert.equal(end.skipped, 1);
  });

  it('an endless stream without a newline never keeps more than the limit in memory (checked through behaviour: it still recovers at the next line)', () => {
    const c = new SignalChunker();
    for (let i = 0; i < 400; i += 1) c.push(new Uint8Array(1000).fill(0x61));
    const r = c.push(bytesOf(`\n${line({ agent: 'x', file: '/ws/ok.ts' })}`));
    assert.deepEqual(r.signals, [{ agent: 'x', file: '/ws/ok.ts' }]);
    assert.equal(r.skipped, 1);
  });

  it('a line just over the character limit but under 4 bytes per character is read as a skipped line, not kept forever', () => {
    const c = new SignalChunker();
    const justOver = new Uint8Array(SIGNAL_LIMITS.LINE + 100).fill(0x71);
    assert.deepEqual(c.push(justOver), { signals: [], skipped: 0 });
    const r = c.push(bytesOf(`\n${line({ agent: 'x', file: '/ws/ok.ts' })}`));
    assert.equal(r.signals.length, 1);
    assert.equal(r.skipped, 1, 'the over-long line was skipped when its end arrived');
  });

  it('a VALID line that is under the limit in characters but over it in bytes (3-byte characters) is kept while unfinished and read when its newline arrives', () => {
    const wide = JSON.stringify({ agent: 'x', file: `/ws/${'日'.repeat(1400)}.ts` });
    const wideBytes = bytesOf(`${wide}\n`);
    assert.ok(wide.length < SIGNAL_LIMITS.LINE, 'sanity: within the character limit');
    assert.ok(wideBytes.length > SIGNAL_LIMITS.LINE + 100, 'sanity: over the limit in bytes');
    // the whole line without its newline, then the newline
    const a = new SignalChunker();
    assert.deepEqual(a.push(wideBytes.subarray(0, wideBytes.length - 1)), { signals: [], skipped: 0 });
    const done = a.push(bytesOf('\n'));
    assert.deepEqual(
      done.signals.map((x) => x.file),
      [`/ws/${'日'.repeat(1400)}.ts`],
    );
    assert.equal(done.skipped, 0);
    // as the unfinished rest after a complete line in the same read
    const b = new SignalChunker();
    const first = b.push(bytesOf(`${line({ agent: 'a', file: '/ws/1.ts' })}${wide}`));
    assert.deepEqual(first.signals.map((x) => x.file), ['/ws/1.ts']);
    const second = b.push(bytesOf('\n'));
    assert.equal(second.signals.length, 1);
    assert.equal(second.skipped, 0);
  });

  it('multi-byte characters in a long line do not fool the byte limit: 4000 four-byte characters is a valid length in characters? no, 8000 UTF-16 units: skipped', () => {
    const wide = `${JSON.stringify({ agent: 'x', file: `/ws/${'😀'.repeat(2100)}.ts` })}\n`;
    assert.ok(wide.length > SIGNAL_LIMITS.LINE);
    const r = feed([bytesOf(wide)]);
    assert.equal(r.signals.length, 0);
    assert.equal(r.skipped, 1);
  });
});

describe('SignalChunker: the same answer as the text parser for any way of cutting a stream (fuzz)', () => {
  it('600 random streams, each cut into random pieces', () => {
    let seed = 4242;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const names = ['a.ts', 'é.ts', '日本語.ts', '😀.ts', 'x y.ts'];
    const junk = ['', 'not json', '{"agent":', '[]', '{"agent":"x"}', '   ', 'é日'];
    for (let round = 0; round < 600; round += 1) {
      const parts: string[] = [];
      for (let n = 1 + rnd(8); n > 0; n -= 1) parts.push(rnd(3) === 0 ? junk[rnd(junk.length)] ?? '' : JSON.stringify({ agent: `agent${rnd(3)}`, file: `/ws/${names[rnd(names.length)]}`, ...(rnd(2) === 0 ? { session: 's😀' } : {}) }));
      const ending = rnd(2) === 0 ? '\n' : '\r\n';
      const text = parts.join(ending) + ending;
      const all = bytesOf(text);
      const want = parseSignalChunk('', text);
      const cuts: number[] = [];
      for (let k = rnd(6); k > 0; k -= 1) cuts.push(rnd(all.length + 1));
      cuts.sort((a, b) => a - b);
      const pieces: Uint8Array[] = [];
      let from = 0;
      for (const cut of cuts) {
        pieces.push(all.subarray(from, cut));
        from = cut;
      }
      pieces.push(all.subarray(from));
      const got = feed(pieces);
      assert.deepEqual(got.signals, want.signals, `round ${round}, cuts ${cuts.join(',')}`);
      assert.equal(got.skipped, want.skipped, `round ${round} skipped`);
    }
  });
});

describe('signalTail', () => {
  it('constant and the last 64 bytes before the end', () => {
    assert.equal(SIGNAL_TAIL_BYTES, 64);
    const data = Uint8Array.from({ length: 200 }, (_, i) => i);
    const t = signalTail(data, 150);
    assert.equal(t.length, 64);
    assert.deepEqual([...t], Array.from({ length: 64 }, (_, i) => 86 + i));
  });

  it('fewer than 64 bytes available gives what there is; an end beyond the data or below zero is clamped', () => {
    const data = Uint8Array.from([1, 2, 3, 4, 5]);
    assert.deepEqual([...signalTail(data, 5)], [1, 2, 3, 4, 5]);
    assert.deepEqual([...signalTail(data, 3)], [1, 2, 3]);
    assert.deepEqual([...signalTail(data, 999)], [1, 2, 3, 4, 5]);
    assert.deepEqual([...signalTail(data, 0)], []);
    assert.deepEqual([...signalTail(data, -4)], []);
    assert.deepEqual([...signalTail(new Uint8Array(0), 10)], []);
    assert.deepEqual([...signalTail(data, Number.NaN)], [], 'NaN is treated as nothing');
  });

  it('the result is a copy: changing the data afterwards does not change it', () => {
    const data = Uint8Array.from([9, 9, 9, 9]);
    const t = signalTail(data, 4);
    data.fill(0);
    assert.deepEqual([...t], [9, 9, 9, 9]);
  });
});

describe('signalPrefixKept: appended, or replaced?', () => {
  const original = bytesOf(line({ agent: 'x', file: '/ws/a.ts' }) + line({ agent: 'y', file: '/ws/b.ts' }));
  const offset = original.length;
  const tail = signalTail(original, offset);

  it('nothing read yet (offset 0) is trivially kept', () => {
    assert.equal(signalPrefixKept(new Uint8Array(0), 0, new Uint8Array(0)), true);
    assert.equal(signalPrefixKept(original, 0, tail), true);
    assert.equal(signalPrefixKept(original, -5, tail), true);
  });

  it('an append keeps the prefix', () => {
    const appended = bytesOf(line({ agent: 'x', file: '/ws/a.ts' }) + line({ agent: 'y', file: '/ws/b.ts' }) + line({ agent: 'z', file: '/ws/c.ts' }));
    assert.equal(signalPrefixKept(appended, offset, tail), true);
  });

  it('the file as it was (nothing new) keeps the prefix', () => {
    assert.equal(signalPrefixKept(original, offset, tail), true);
  });

  it('a file that is now SHORTER than the offset was replaced', () => {
    assert.equal(signalPrefixKept(original.subarray(0, offset - 1), offset, tail), false);
    assert.equal(signalPrefixKept(new Uint8Array(0), offset, tail), false);
  });

  it('a file emptied and refilled with a LONGER, different line was replaced (QA-110)', () => {
    const refilled = bytesOf(line({ agent: 'b', file: '/ws/b.ts', pad: 'n'.repeat(offset + 40) }));
    assert.ok(refilled.length > offset);
    assert.equal(signalPrefixKept(refilled, offset, tail), false);
  });

  it('a file refilled with as many bytes of different content (same length) was replaced', () => {
    const same = bytesOf(line({ agent: 'q', file: '/ws/q.ts' }) + line({ agent: 'r', file: '/ws/r.ts' }));
    assert.equal(same.length, offset);
    assert.equal(signalPrefixKept(same, offset, tail), false);
  });

  it('a single changed byte inside the tail is noticed; a change before the tail is not (the documented limit)', () => {
    const long = bytesOf(line({ agent: 'x', file: '/ws/a.ts', pad: 'p'.repeat(100) }) + line({ agent: 'y', file: '/ws/b.ts', pad: 'q'.repeat(100) }));
    assert.ok(long.length > SIGNAL_TAIL_BYTES * 2);
    const longTail = signalTail(long, long.length);
    const edited = long.slice();
    edited[long.length - 1] = (edited[long.length - 1] ?? 0) ^ 0x01;
    assert.equal(signalPrefixKept(edited, long.length, longTail), false);
    const insideTail = long.slice();
    insideTail[long.length - SIGNAL_TAIL_BYTES] = (insideTail[long.length - SIGNAL_TAIL_BYTES] ?? 0) ^ 0x01;
    assert.equal(signalPrefixKept(insideTail, long.length, longTail), false, 'the first byte of the tail counts');
    const early = long.slice();
    early[0] = (early[0] ?? 0) ^ 0x01;
    assert.equal(signalPrefixKept(early, long.length, longTail), true, 'bytes earlier than the last 64 are not compared');
  });

  it('an identical replacement is taken for an append: the documented limit', () => {
    assert.equal(signalPrefixKept(original.slice(), offset, tail), true);
  });

  it('a tail longer than the offset, or an offset beyond the data, is not kept', () => {
    assert.equal(signalPrefixKept(original, 10, tail), false);
    assert.equal(signalPrefixKept(original, original.length + 1, tail), false);
  });

  it('a file that shrank below the offset is never "kept", even when there is no tail to compare (an empty tail proves nothing)', () => {
    assert.equal(signalPrefixKept(new Uint8Array(0), 10, new Uint8Array(0)), false);
    assert.equal(signalPrefixKept(bytesOf('abc'), 10, new Uint8Array(0)), false);
    assert.equal(signalPrefixKept(bytesOf('abc'), 3, new Uint8Array(0)), true, 'an offset at the end of the data is fine');
  });

  it('with a short file the whole prefix is the tail', () => {
    const short = bytesOf('{"a":1}\n');
    assert.equal(signalPrefixKept(bytesOf('{"a":1}\n{"b":2}\n'), short.length, signalTail(short, short.length)), true);
    assert.equal(signalPrefixKept(bytesOf('{"x":1}\n{"b":2}\n'), short.length, signalTail(short, short.length)), false);
  });

  it('end to end: the adapter loop decides "append" or "replaced" and the chunker reads from there (model of SignalFileAdapter.read)', () => {
    // state of the adapter after reading `original`
    let file: Uint8Array = original.slice();
    let off = file.length;
    let kept = signalTail(file, off);
    const chunker = new SignalChunker();
    chunker.push(file);
    const step = (next: Uint8Array): AgentSignal[] => {
      file = next;
      if (file.length < off || !signalPrefixKept(file, off, kept)) {
        off = 0;
        chunker.reset();
      }
      const fresh = file.subarray(off);
      off = file.length;
      kept = signalTail(file, off);
      return chunker.push(fresh).signals;
    };
    const append = bytesOf(line({ agent: 'z', file: '/ws/c.ts' }));
    const appended = new Uint8Array(file.length + append.length);
    appended.set(file, 0);
    appended.set(append, file.length);
    assert.deepEqual(step(appended).map((s) => s.file), ['/ws/c.ts']);
    assert.deepEqual(step(bytesOf(line({ agent: 'long', file: '/ws/new.ts', pad: 'n'.repeat(500) }))).map((s) => s.file), ['/ws/new.ts'], 'refilled with a longer line');
    assert.deepEqual(step(bytesOf(line({ agent: 'q', file: '/ws/q.ts' }))).map((s) => s.file), ['/ws/q.ts'], 'then a shorter one');
    assert.deepEqual(step(new Uint8Array(0)), [], 'emptied');
    assert.deepEqual(step(bytesOf(line({ agent: 'w', file: '/ws/w.ts' }))).map((s) => s.file), ['/ws/w.ts'], 'written again');
    assert.equal(must(file.length), file.length);
  });
});
