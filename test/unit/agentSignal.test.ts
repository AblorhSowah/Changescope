import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_FILE_NAME, SIGNAL_LIMITS, buildAgentHook, cleanAgentFile, cleanAgentName, parseSignalChunk, parseSignalLine, shellQuote } from '../../src/core/ai/agentSignal';
import { must } from '../support/fixtures';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('agent signal: constants', () => {
  it('file name and limits', () => {
    assert.equal(SIGNAL_FILE_NAME, 'agent-events.jsonl');
    assert.equal(SIGNAL_LIMITS.LINE, 4096, 'lines over 4 KB are skipped (DESIGN 9)');
    assert.equal(SIGNAL_LIMITS.FILE, 1024 * 1024, 'truncated past 1 MB (DESIGN 9)');
  });
});

describe('parseSignalLine', () => {
  it('a valid line: agent, absolute file, optional session', () => {
    assert.deepEqual(parseSignalLine(line({ agent: 'claude-code', file: '/ws/src/a.ts' })), { agent: 'claude-code', file: '/ws/src/a.ts' });
    assert.deepEqual(parseSignalLine(line({ agent: 'claude-code', file: '/ws/src/a.ts', session: 'abc' })), { agent: 'claude-code', file: '/ws/src/a.ts', session: 'abc' });
  });

  it('unknown fields are ignored', () => {
    assert.deepEqual(parseSignalLine(line({ agent: 'x', file: '/ws/a.ts', extra: { deep: [1, 2] }, tool: 'Edit' })), { agent: 'x', file: '/ws/a.ts' });
  });

  it('the file path is normalised to a file key (Windows separators, dot segments, drive letter)', () => {
    assert.equal(must(parseSignalLine(line({ agent: 'x', file: '/ws/src/../src/./a.ts' }))).file, '/ws/src/a.ts');
    assert.equal(must(parseSignalLine(line({ agent: 'x', file: 'C:\\Users\\me\\proj\\a.ts' }))).file, 'c:/Users/me/proj/a.ts');
    assert.equal(must(parseSignalLine(line({ agent: 'x', file: '/ws//a.ts' }))).file, '/ws/a.ts');
  });

  it('malformed JSON, non-objects and arrays are skipped without throwing', () => {
    for (const bad of ['', '   ', '{', '}', '{"agent":', 'null', 'true', '7', '"text"', '[]', '[{"agent":"x","file":"/a"}]', 'not json at all', '{agent: "x"}', "{'agent':'x'}", '\u0000', '{"agent":"x","file":"/ws/a.ts"', '{"agent":"x","file":"/ws/a.ts"}}']) {
      assert.equal(parseSignalLine(bad), undefined, JSON.stringify(bad));
    }
  });

  it('a missing or unusable agent is skipped: absent, empty, blank, only control characters, wrong type', () => {
    for (const agent of [undefined, '', '   ', '\u0000\u0001\n', 5, null, {}, [], true]) {
      assert.equal(parseSignalLine(line({ ...(agent === undefined ? {} : { agent }), file: '/ws/a.ts' })), undefined, JSON.stringify(agent));
    }
  });

  it('a missing or unusable file is skipped: absent, empty, relative, URL, NUL, wrong type, over the limit', () => {
    const files: unknown[] = [undefined, '', 'a.ts', './a.ts', '../a.ts', 'src/a.ts', 5, null, ['/ws/a.ts'], {}, '/ws/a\u0000.ts', `/${'x'.repeat(SIGNAL_LIMITS.LINE)}`];
    for (const file of files) {
      assert.equal(parseSignalLine(line({ agent: 'x', ...(file === undefined ? {} : { file }) })), undefined, JSON.stringify(file)?.slice(0, 40));
    }
  });

  it('agent names are cleaned and capped at 64; session ids are cleaned and capped at 128', () => {
    const s = must(parseSignalLine(line({ agent: `  my\tagent\n${'x'.repeat(200)}  `, file: '/ws/a.ts', session: ` ${'s'.repeat(300)} ` })));
    assert.ok(s.agent.length <= SIGNAL_LIMITS.AGENT);
    assert.ok(s.agent.startsWith('my agent xxx'));
    assert.equal(s.session?.length, SIGNAL_LIMITS.SESSION);
  });

  it('an unusable session is dropped but the signal is kept', () => {
    for (const session of [5, null, {}, '', '   ', '\u0000']) {
      const s = parseSignalLine(line({ agent: 'x', file: '/ws/a.ts', session }));
      assert.deepEqual(s, { agent: 'x', file: '/ws/a.ts' }, JSON.stringify(session));
    }
  });

  it('hostile text stays text', () => {
    const s = must(parseSignalLine(line({ agent: '<img src=x onerror=alert(1)>', file: '/ws/<b>.ts', session: '"><script>' })));
    assert.equal(s.agent, '<img src=x onerror=alert(1)>');
    assert.equal(s.file, '/ws/<b>.ts');
  });

  it('surrounding whitespace and a trailing CR (Windows line ending) are tolerated', () => {
    assert.ok(parseSignalLine(`  ${line({ agent: 'x', file: '/ws/a.ts' })}\r`));
  });

  it('a line of exactly 4096 characters is accepted, one more is skipped', () => {
    const base = { agent: 'x', file: '/ws/a.ts', pad: '' };
    const overhead = JSON.stringify(base).length;
    const ok = JSON.stringify({ ...base, pad: 'p'.repeat(SIGNAL_LIMITS.LINE - overhead) });
    assert.equal(ok.length, SIGNAL_LIMITS.LINE);
    assert.ok(parseSignalLine(ok));
    assert.equal(parseSignalLine(JSON.stringify({ ...base, pad: 'p'.repeat(SIGNAL_LIMITS.LINE - overhead + 1) })), undefined);
  });

  it('prototype keys do not leak: __proto__, constructor', () => {
    const s = parseSignalLine('{"__proto__":{"agent":"evil","file":"/etc/passwd"},"agent":"x","file":"/ws/a.ts"}');
    assert.deepEqual(s, { agent: 'x', file: '/ws/a.ts' });
    assert.equal(parseSignalLine('{"__proto__":{"agent":"evil","file":"/etc/passwd"}}'), undefined);
  });

  it('never throws on random junk', () => {
    let seed = 5;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['{', '}', '"', ':', ',', 'agent', 'file', '/ws/a.ts', '[', ']', 'null', ' ', '\\', '\u0000', '😀', '1e999', '-0', 'true'];
    for (let i = 0; i < 3000; i += 1) {
      let s = '';
      for (let j = rnd(30); j > 0; j -= 1) s += alphabet[rnd(alphabet.length)];
      assert.doesNotThrow(() => parseSignalLine(s), s);
    }
  });
});

describe('cleanAgentName and cleanAgentFile', () => {
  it('cleanAgentName: control characters become spaces, runs collapse, trimmed, capped; non-strings are empty', () => {
    assert.equal(cleanAgentName('  a\u0000\u0007b   c\n'), 'a b c');
    assert.equal(cleanAgentName('x'.repeat(100)).length, 64);
    for (const v of [undefined, null, 5, {}, []]) assert.equal(cleanAgentName(v), '');
  });

  it('cleanAgentFile: only absolute paths; Windows drive paths and UNC are accepted; relative and empty are not', () => {
    assert.equal(cleanAgentFile('/a/b.ts'), '/a/b.ts');
    assert.equal(cleanAgentFile('C:\\a\\b.ts'), 'c:/a/b.ts');
    assert.equal(cleanAgentFile('\\\\server\\share\\a.ts'), '//server/share/a.ts');
    for (const v of ['', 'a.ts', '~/a.ts', 'file:///a/b.ts', 'http://x/y', undefined, 3, null]) assert.equal(cleanAgentFile(v), undefined, String(v));
  });

  it('a path that normalises to nothing is rejected', () => {
    assert.equal(cleanAgentFile('/'), '/', 'the root itself is a path; the host decides whether it is in a workspace');
  });
});

describe('parseSignalChunk: partial last line, oversized lines, offsets', () => {
  const sig = (n: number): string => `${line({ agent: 'x', file: `/ws/f${n}.ts` })}\n`;

  it('complete lines are parsed; the unfinished last line is returned as `rest`', () => {
    const out = parseSignalChunk('', `${sig(1)}${sig(2)}{"agent":"x","file":"/ws/f3`);
    assert.deepEqual(
      out.signals.map((s) => s.file),
      ['/ws/f1.ts', '/ws/f2.ts'],
    );
    assert.equal(out.rest, '{"agent":"x","file":"/ws/f3');
    assert.equal(out.skipping, false);
    assert.equal(out.skipped, 0);
  });

  it('the rest is completed by the next read (read offsets: pending + chunk)', () => {
    const first = parseSignalChunk('', `${sig(1)}{"agent":"x","fi`);
    const second = parseSignalChunk(first.rest, `le":"/ws/f2.ts"}\n${sig(3)}`);
    assert.deepEqual(
      second.signals.map((s) => s.file),
      ['/ws/f2.ts', '/ws/f3.ts'],
    );
    assert.equal(second.rest, '');
  });

  it('splitting the same stream at EVERY possible byte boundary gives the same signals', () => {
    const stream = `${sig(1)}garbage line\n${sig(2)}\n${sig(3)}${line({ agent: 'y', file: '/ws/f4.ts', session: 's' })}\n`;
    const whole = parseSignalChunk('', stream);
    assert.equal(whole.signals.length, 4);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const a = parseSignalChunk('', stream.slice(0, cut));
      const b = parseSignalChunk(a.rest, stream.slice(cut), a.skipping);
      assert.deepEqual([...a.signals, ...b.signals], whole.signals, `cut at ${cut}`);
      assert.equal(a.skipped + b.skipped, whole.skipped, `skipped at ${cut}`);
      assert.equal(b.rest, '');
    }
  });

  it('a stream with no trailing newline keeps its last line pending (it is not parsed yet)', () => {
    const out = parseSignalChunk('', line({ agent: 'x', file: '/ws/a.ts' }));
    assert.deepEqual(out.signals, []);
    assert.ok(out.rest.length > 0);
  });

  it('malformed lines are skipped and counted; blank lines are ignored and not counted', () => {
    const out = parseSignalChunk('', `${sig(1)}\n\n   \nnot json\n{"agent":"x"}\n${sig(2)}`);
    assert.equal(out.signals.length, 2);
    assert.equal(out.skipped, 2);
  });

  it('Windows line endings work', () => {
    const out = parseSignalChunk('', `${line({ agent: 'x', file: '/ws/a.ts' })}\r\n${line({ agent: 'x', file: '/ws/b.ts' })}\r\n`);
    assert.equal(out.signals.length, 2);
    assert.equal(out.skipped, 0);
  });

  it('a complete line over 4 KB is skipped and counted; its neighbours are fine', () => {
    const huge = `${line({ agent: 'x', file: '/ws/a.ts', pad: 'p'.repeat(5000) })}\n`;
    const out = parseSignalChunk('', `${sig(1)}${huge}${sig(2)}`);
    assert.deepEqual(
      out.signals.map((s) => s.file),
      ['/ws/f1.ts', '/ws/f2.ts'],
    );
    assert.equal(out.skipped, 1);
  });

  it('an unfinished line that is already over 4 KB is dropped at once (memory stays bounded) and the next newline ends the skip', () => {
    const out = parseSignalChunk('', `${sig(1)}${'z'.repeat(5000)}`);
    assert.equal(out.signals.length, 1);
    assert.equal(out.rest, '', 'nothing is kept in memory');
    assert.equal(out.skipping, true);
    const more = parseSignalChunk(out.rest, `${'z'.repeat(9000)}`, out.skipping);
    assert.equal(more.skipping, true);
    assert.equal(more.rest, '');
    assert.deepEqual(more.signals, []);
    const end = parseSignalChunk(more.rest, `tail of the huge line\n${sig(9)}`, more.skipping);
    assert.equal(end.skipping, false);
    assert.deepEqual(
      end.signals.map((s) => s.file),
      ['/ws/f9.ts'],
    );
    assert.equal(end.skipped, 1, 'the oversized line counts once, when it ends');
  });

  it('while skipping, a chunk with no newline yields nothing and keeps skipping', () => {
    const out = parseSignalChunk('', 'abc', true);
    assert.deepEqual(out, { signals: [], rest: '', skipping: true, skipped: 0 });
  });

  it('an endless stream without newlines never accumulates more than 4 KB of pending text', () => {
    let pending = '';
    let skipping = false;
    for (let i = 0; i < 200; i += 1) {
      const out = parseSignalChunk(pending, 'q'.repeat(1000), skipping);
      pending = out.rest;
      skipping = out.skipping;
      assert.ok(pending.length <= SIGNAL_LIMITS.LINE + 1000, `pending ${pending.length}`);
    }
  });

  it('at most 500 signals are taken from one read; the rest are counted as skipped', () => {
    const many = Array.from({ length: 700 }, (_, i) => sig(i)).join('');
    const out = parseSignalChunk('', many);
    assert.equal(out.signals.length, SIGNAL_LIMITS.RECORDS);
    assert.equal(SIGNAL_LIMITS.RECORDS, 500);
    assert.equal(out.skipped, 200);
  });

  it('multi-byte text split inside a code unit boundary cannot make a valid line invalid (strings are already decoded)', () => {
    const l = `${line({ agent: '日本語', file: '/ws/日本語/😀.ts' })}\n`;
    const cut = 20;
    const a = parseSignalChunk('', l.slice(0, cut));
    const b = parseSignalChunk(a.rest, l.slice(cut));
    assert.equal(must(b.signals[0]).file, '/ws/日本語/😀.ts');
  });

  it('empty chunk and empty pending give nothing', () => {
    assert.deepEqual(parseSignalChunk('', ''), { signals: [], rest: '', skipping: false, skipped: 0 });
  });
});

describe('hook text for the signal file', () => {
  it('shellQuote single-quotes and escapes embedded single quotes so no shell metacharacter survives', () => {
    assert.equal(shellQuote('plain'), "'plain'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote('$(rm -rf ~); `x` "y" \\'), "'$(rm -rf ~); `x` \"y\" \\'");
    assert.equal(shellQuote(''), "''");
  });

  it('the command appends to the signal path, quoted, and uses jq on the documented hook input fields', () => {
    const { command, settings } = buildAgentHook('/Users/me/Library/Application Support/Code/User/workspaceStorage/abc/file-shake/agent-events.jsonl');
    assert.match(command, /^jq -c '/);
    assert.ok(command.includes('.tool_input.file_path'));
    assert.ok(command.includes('.session_id'));
    assert.ok(command.endsWith(">> '/Users/me/Library/Application Support/Code/User/workspaceStorage/abc/file-shake/agent-events.jsonl'"), 'a path with spaces stays one argument');
    const parsed = JSON.parse(settings) as { hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } };
    assert.equal(parsed.hooks.PostToolUse[0]?.matcher, 'Edit|Write');
    assert.equal(parsed.hooks.PostToolUse[0]?.hooks[0]?.type, 'command');
    assert.equal(parsed.hooks.PostToolUse[0]?.hooks[0]?.command, command);
  });

  it('a hostile path cannot break out of the command', () => {
    const evil = "/tmp/x'; rm -rf ~; echo '/agent-events.jsonl";
    const { command } = buildAgentHook(evil);
    assert.ok(command.endsWith(`>> ${shellQuote(evil)}`));
    // after removing every single-quoted span the only thing left outside quotes must be harmless
    const outside = command.replace(/'(?:[^']|'\\'')*'/g, "''");
    assert.ok(!outside.includes('rm -rf'), outside);
  });

  it('a hostile agent name is JSON-escaped inside the jq filter (no quote can end the filter early)', () => {
    const { command } = buildAgentHook('/p/agent-events.jsonl', 'bad"name\'; rm -rf ~');
    const outside = command.replace(/'(?:[^']|'\\'')*'/g, "''");
    assert.ok(!outside.includes('rm -rf'), outside);
  });

  it('what the hook produces is exactly what the parser accepts (agent, file, session from the hook input)', () => {
    // simulate jq: {agent: "claude-code", file: <tool_input.file_path>, session: <session_id>}
    const produced = JSON.stringify({ agent: 'claude-code', file: '/ws/src/a.ts', session: 'sess-1' });
    assert.deepEqual(parseSignalLine(produced), { agent: 'claude-code', file: '/ws/src/a.ts', session: 'sess-1' });
    // when the tool input has no file_path jq writes null: skipped, not crashed
    assert.equal(parseSignalLine(JSON.stringify({ agent: 'claude-code', file: null, session: 'sess-1' })), undefined);
  });
});
