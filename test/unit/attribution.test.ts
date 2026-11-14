import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HINT_WINDOW_MS, HintBook, SOURCE_LABELS, attribute, baseAttribution, hintCovers, upgradeWithHint } from '../../src/core/activity/attribution';
import type { Attribution, Hint, RawEvent } from '../../src/core/activity/attribution';
import { SOURCE_TYPES } from '../../src/core/dashboard/protocol';
import type { ActivityEventType, ClassifyReason } from '../../src/core/types';

const T0 = 1_000_000;
const A = '/ws/a.ts';
const B = '/ws/b.ts';

function raw(o: Partial<RawEvent> = {}): RawEvent {
  return { key: A, eventType: 'modify', decision: 'external', reason: 'disk-write', origin: 'watcher', at: T0, ...o };
}

const REASONS: ClassifyReason[] = [
  'no-content-change',
  'saving',
  'undo-redo',
  'reload-from-disk',
  'active-focused-edit',
  'background-edit',
  'disk-write',
  'self-save',
  'dedupe',
  'excluded',
  'burst',
  'scheme',
  'disabled',
  'external-detection-off',
  'paused',
];
const EVENT_TYPES: ActivityEventType[] = ['create', 'modify', 'delete'];
const DECISIONS = ['you', 'external'] as const;
const ORIGINS = ['doc', 'watcher', 'workbench'] as const;

/** The table of DESIGN-0.3.0 4.2, written out independently of the implementation (first match wins). */
function oracle(e: RawEvent): Attribution {
  if (e.origin === 'workbench') return { sourceType: 'developer', detectionMethod: 'workbench-file-operation', confidence: 0.95 };
  if (e.decision === 'you' && e.reason === 'undo-redo') return { sourceType: 'developer', detectionMethod: 'undo-redo', confidence: 0.95 };
  if (e.decision === 'you') return { sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9 };
  if (e.reason === 'background-edit') return { sourceType: 'automated', detectionMethod: 'workspace-edit', confidence: 0.6 };
  if (e.reason === 'reload-from-disk') return { sourceType: 'external', detectionMethod: 'reload-from-disk', confidence: 0.7 };
  if (e.eventType === 'delete' && e.origin === 'watcher') return { sourceType: 'external', detectionMethod: 'disk-delete', confidence: 0.7 };
  if (e.reason === 'disk-write') return { sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 };
  return { sourceType: 'unknown', detectionMethod: 'restored', confidence: 0.2 };
}

describe('baseAttribution: the table of DESIGN-0.3.0 4.2', () => {
  it('constants', () => {
    assert.equal(HINT_WINDOW_MS, 3000);
    assert.deepEqual(Object.keys(SOURCE_LABELS).sort(), [...SOURCE_TYPES].sort());
  });

  it('row 1: a workbench operation is a developer file operation, whatever else the event says', () => {
    for (const decision of DECISIONS) {
      for (const reason of REASONS) {
        for (const eventType of EVENT_TYPES) {
          assert.deepEqual(baseAttribution(raw({ origin: 'workbench', decision, reason, eventType })), {
            sourceType: 'developer',
            detectionMethod: 'workbench-file-operation',
            confidence: 0.95,
          });
        }
      }
    }
  });

  it('row 2: you + undo-redo', () => {
    assert.deepEqual(baseAttribution(raw({ decision: 'you', reason: 'undo-redo', origin: 'doc' })), {
      sourceType: 'developer',
      detectionMethod: 'undo-redo',
      confidence: 0.95,
    });
  });

  it('row 3: you + anything else is a focused editor edit (0.9)', () => {
    for (const reason of REASONS.filter((r) => r !== 'undo-redo')) {
      assert.deepEqual(baseAttribution(raw({ decision: 'you', reason, origin: 'doc' })), {
        sourceType: 'developer',
        detectionMethod: 'focused-editor-edit',
        confidence: 0.9,
      });
    }
  });

  it('row 4: external + background-edit is Automated (0.6)', () => {
    assert.deepEqual(baseAttribution(raw({ reason: 'background-edit', origin: 'doc' })), {
      sourceType: 'automated',
      detectionMethod: 'workspace-edit',
      confidence: 0.6,
    });
  });

  it('row 5: external + reload-from-disk (0.7)', () => {
    assert.deepEqual(baseAttribution(raw({ reason: 'reload-from-disk', origin: 'doc' })), {
      sourceType: 'external',
      detectionMethod: 'reload-from-disk',
      confidence: 0.7,
    });
  });

  it('row 6: a watcher delete is External disk-delete, but a doc "delete" is not', () => {
    assert.deepEqual(baseAttribution(raw({ eventType: 'delete', reason: 'disk-write', origin: 'watcher' })), {
      sourceType: 'external',
      detectionMethod: 'disk-delete',
      confidence: 0.7,
    });
    // a delete reported from a document is not a watcher delete: it falls through to the reason rows
    assert.equal(baseAttribution(raw({ eventType: 'delete', reason: 'disk-write', origin: 'doc' })).detectionMethod, 'disk-write');
  });

  it('row 7: external + disk-write', () => {
    assert.deepEqual(baseAttribution(raw({})), { sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 });
  });

  it('row 8: anything else is unknown / restored (0.2)', () => {
    for (const reason of ['no-content-change', 'saving', 'active-focused-edit', 'self-save', 'dedupe', 'excluded', 'burst', 'scheme', 'disabled', 'external-detection-off', 'paused'] as const) {
      assert.deepEqual(baseAttribution(raw({ reason, eventType: 'modify' })), { sourceType: 'unknown', detectionMethod: 'restored', confidence: 0.2 }, reason);
    }
  });

  it('precedence: background-edit beats the watcher-delete row; reload-from-disk beats it too', () => {
    assert.equal(baseAttribution(raw({ reason: 'background-edit', eventType: 'delete' })).sourceType, 'automated');
    assert.equal(baseAttribution(raw({ reason: 'reload-from-disk', eventType: 'delete' })).detectionMethod, 'reload-from-disk');
  });

  it('exhaustive: all 2 x 3 x 15 x 3 = 270 combinations match the independent table', () => {
    let n = 0;
    for (const decision of DECISIONS) {
      for (const origin of ORIGINS) {
        for (const reason of REASONS) {
          for (const eventType of EVENT_TYPES) {
            const e = raw({ decision, origin, reason, eventType });
            assert.deepEqual(baseAttribution(e), oracle(e), JSON.stringify(e));
            n += 1;
          }
        }
      }
    }
    assert.equal(n, 270);
  });

  it('confidence is always within 0..1 and no base attribution carries a source id', () => {
    for (const decision of DECISIONS) {
      for (const origin of ORIGINS) {
        for (const reason of REASONS) {
          const a = baseAttribution(raw({ decision, origin, reason }));
          assert.ok(a.confidence >= 0 && a.confidence <= 1);
          assert.equal(a.sourceId, undefined);
        }
      }
    }
  });
});

describe('hintCovers: same file or repository, inclusive window', () => {
  const agent = (o: Partial<Extract<Hint, { kind: 'agent' }>> = {}): Hint => ({ kind: 'agent', agent: 'claude-code', file: A, at: T0, ...o });
  const git = (o: Partial<Extract<Hint, { kind: 'git' }>> = {}): Hint => ({ kind: 'git', root: '/ws', at: T0, ...o });

  it('the window is inclusive at exactly +-3000 ms and exclusive one millisecond beyond', () => {
    for (const make of [agent, git]) {
      assert.equal(hintCovers(make({ at: T0 - HINT_WINDOW_MS }), A, T0, T0), true);
      assert.equal(hintCovers(make({ at: T0 + HINT_WINDOW_MS }), A, T0, T0), true);
      assert.equal(hintCovers(make({ at: T0 - HINT_WINDOW_MS - 1 }), A, T0, T0), false);
      assert.equal(hintCovers(make({ at: T0 + HINT_WINDOW_MS + 1 }), A, T0, T0), false);
    }
  });

  it('an agent hint is for that file only (no prefix match, no sibling)', () => {
    assert.equal(hintCovers(agent(), A, T0, T0), true);
    assert.equal(hintCovers(agent(), B, T0, T0), false);
    assert.equal(hintCovers(agent({ file: '/ws/a' }), '/ws/a.ts', T0, T0), false);
    assert.equal(hintCovers(agent({ file: '/ws/src' }), '/ws/src/a.ts', T0, T0), false, 'a folder report is not a file report');
  });

  it('a git hint covers files below its root, never a sibling folder that shares a prefix', () => {
    assert.equal(hintCovers(git({ root: '/ws' }), '/ws/deep/a.ts', T0, T0), true);
    assert.equal(hintCovers(git({ root: '/ws' }), '/ws', T0, T0), true);
    assert.equal(hintCovers(git({ root: '/ws' }), '/ws2/a.ts', T0, T0), false);
    assert.equal(hintCovers(git({ root: '/ws/sub' }), '/ws/a.ts', T0, T0), false);
  });

  it('a coalesced event covers the span of its occurrences, in either argument order', () => {
    const h = git({ at: T0 + 10_000 });
    assert.equal(hintCovers(h, A, T0, T0 + 8000), true);
    assert.equal(hintCovers(h, A, T0 + 8000, T0), true);
    assert.equal(hintCovers(h, A, T0, T0 + 6000), false);
  });

  it('a custom window is honoured; NaN never matches', () => {
    assert.equal(hintCovers(agent({ at: T0 + 500 }), A, T0, T0, 400), false);
    assert.equal(hintCovers(agent({ at: T0 + 400 }), A, T0, T0, 400), true);
    assert.equal(hintCovers(agent({ at: Number.NaN }), A, T0, T0), false);
    assert.equal(hintCovers(agent(), A, Number.NaN, Number.NaN), false);
  });
});

describe('upgradeWithHint and attribute', () => {
  const agent: Hint = { kind: 'agent', agent: 'claude-code', file: A, at: T0 };
  const git: Hint = { kind: 'git', root: '/ws', at: T0 };

  it('an agent hint upgrades every non-developer base to ai-agent / agent-signal / 0.95 with the agent as source id', () => {
    for (const reason of ['disk-write', 'reload-from-disk', 'background-edit', 'dedupe'] as const) {
      const out = attribute(raw({ reason }), agent);
      assert.deepEqual(out, { sourceType: 'ai-agent', sourceId: 'claude-code', detectionMethod: 'agent-signal', confidence: 0.95 }, reason);
    }
    assert.equal(attribute(raw({ eventType: 'delete' }), agent).sourceType, 'ai-agent', 'a delete by an agent');
  });

  it('a git hint upgrades a non-developer base to git / git-state-change / 0.8 with no source id', () => {
    for (const reason of ['disk-write', 'reload-from-disk', 'background-edit', 'dedupe'] as const) {
      assert.deepEqual(attribute(raw({ reason }), git), { sourceType: 'git', detectionMethod: 'git-state-change', confidence: 0.8 }, reason);
    }
  });

  it('developer events are never re-labelled, by either kind of hint, in either direction of time', () => {
    for (const hint of [agent, git, { ...agent, at: T0 - 100 }, { ...git, at: T0 + 100 }]) {
      for (const e of [raw({ decision: 'you', reason: 'active-focused-edit', origin: 'doc' }), raw({ decision: 'you', reason: 'undo-redo', origin: 'doc' }), raw({ origin: 'workbench' })]) {
        assert.equal(attribute(e, hint).sourceType, 'developer');
        assert.equal(attribute(e, hint).sourceId, undefined);
      }
    }
    assert.equal(upgradeWithHint({ sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9 }, agent), undefined);
    assert.equal(upgradeWithHint({ sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9 }, git), undefined);
  });

  it('a hint outside the window, for another file or under another root changes nothing', () => {
    const base = baseAttribution(raw());
    assert.deepEqual(attribute(raw(), { ...agent, at: T0 + HINT_WINDOW_MS + 1 }), base);
    assert.deepEqual(attribute(raw(), { ...agent, file: B }), base);
    assert.deepEqual(attribute(raw(), { ...git, root: '/other' }), base);
    assert.deepEqual(attribute(raw(), { ...git, at: T0 - HINT_WINDOW_MS - 1 }), base);
    assert.deepEqual(attribute(raw(), undefined), base);
  });

  it('hints just inside the window (before or after the event) do apply', () => {
    assert.equal(attribute(raw(), { ...agent, at: T0 - HINT_WINDOW_MS }).sourceType, 'ai-agent');
    assert.equal(attribute(raw(), { ...git, at: T0 + HINT_WINDOW_MS }).sourceType, 'git');
  });

  it('a window passed to attribute overrides the default', () => {
    assert.equal(attribute(raw(), { ...agent, at: T0 + 1000 }, 500).sourceType, 'external');
    assert.equal(attribute(raw(), { ...agent, at: T0 + 400 }, 500).sourceType, 'ai-agent');
  });

  it('upgradeWithHint: an agent report is never replaced by git; the same agent again changes nothing; another agent replaces it', () => {
    const byAgent: Attribution = { sourceType: 'ai-agent', sourceId: 'claude-code', detectionMethod: 'agent-signal', confidence: 0.95 };
    assert.equal(upgradeWithHint(byAgent, git), undefined);
    assert.equal(upgradeWithHint(byAgent, agent), undefined);
    assert.equal(upgradeWithHint(byAgent, { ...agent, agent: 'other' })?.sourceId, 'other');
    const byGit: Attribution = { sourceType: 'git', detectionMethod: 'git-state-change', confidence: 0.8 };
    assert.equal(upgradeWithHint(byGit, git), undefined, 'already git');
    assert.equal(upgradeWithHint(byGit, agent)?.sourceType, 'ai-agent', 'agent beats git');
  });

  it('the base attribution object is not mutated', () => {
    const e = raw();
    const before = JSON.stringify(baseAttribution(e));
    attribute(e, agent);
    assert.equal(JSON.stringify(baseAttribution(e)), before);
  });
});

describe('HintBook', () => {
  it('starts empty; add grows; size counts hints', () => {
    const book = new HintBook();
    assert.equal(book.size, 0);
    book.add({ kind: 'git', root: '/ws', at: T0 });
    book.add({ kind: 'agent', agent: 'x', file: A, at: T0 });
    assert.equal(book.size, 2);
  });

  it('match: nothing recorded, nothing matched', () => {
    assert.equal(new HintBook().match({ key: A, at: T0 }), undefined);
  });

  it('agent beats git whichever was added first and whichever is closer in time', () => {
    const agentFar: Hint = { kind: 'agent', agent: 'claude-code', file: A, at: T0 + 2900 };
    const gitNear: Hint = { kind: 'git', root: '/ws', at: T0 };
    for (const order of [[agentFar, gitNear], [gitNear, agentFar]]) {
      const book = new HintBook();
      for (const h of order) book.add(h);
      assert.deepEqual(book.match({ key: A, at: T0 }), agentFar);
    }
  });

  it('within one kind the closest in time wins; a tie goes to the later added', () => {
    const book = new HintBook();
    const far: Hint = { kind: 'git', root: '/ws', at: T0 + 2000 };
    const near: Hint = { kind: 'git', root: '/ws', at: T0 + 100 };
    book.add(far);
    book.add(near);
    assert.deepEqual(book.match({ key: A, at: T0 }), near);

    const b2 = new HintBook();
    const first: Hint = { kind: 'agent', agent: 'one', file: A, at: T0 - 500 };
    const second: Hint = { kind: 'agent', agent: 'two', file: A, at: T0 + 500 };
    b2.add(first);
    b2.add(second);
    assert.equal((b2.match({ key: A, at: T0 }) as Extract<Hint, { kind: 'agent' }>).agent, 'two');
  });

  it('only hints that cover the event are candidates', () => {
    const book = new HintBook();
    book.add({ kind: 'agent', agent: 'x', file: B, at: T0 });
    book.add({ kind: 'git', root: '/elsewhere', at: T0 });
    book.add({ kind: 'git', root: '/ws', at: T0 + HINT_WINDOW_MS + 1 });
    assert.equal(book.match({ key: A, at: T0 }), undefined);
  });

  it('a custom window is used by match', () => {
    const book = new HintBook(100);
    book.add({ kind: 'agent', agent: 'x', file: A, at: T0 + 150 });
    assert.equal(book.match({ key: A, at: T0 }), undefined);
    book.add({ kind: 'agent', agent: 'y', file: A, at: T0 + 100 });
    assert.ok(book.match({ key: A, at: T0 }));
  });

  it('a nonsensical window (NaN, negative, Infinity) falls back to 3000 ms', () => {
    for (const w of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      const book = new HintBook(w);
      book.add({ kind: 'agent', agent: 'x', file: A, at: T0 + 2999 });
      assert.ok(book.match({ key: A, at: T0 }), String(w));
    }
  });

  it('prune drops hints older than the window relative to now and keeps the rest (boundary inclusive)', () => {
    const book = new HintBook();
    book.add({ kind: 'git', root: '/ws', at: T0 });
    book.add({ kind: 'git', root: '/ws', at: T0 + 1000 });
    book.add({ kind: 'git', root: '/ws', at: T0 + 5000 });
    book.prune(T0 + HINT_WINDOW_MS);
    assert.equal(book.size, 3, 'exactly the window old is kept');
    book.prune(T0 + HINT_WINDOW_MS + 1);
    assert.equal(book.size, 2);
    book.prune(T0 + 100_000);
    assert.equal(book.size, 0);
  });

  it('a hint in the future of now is kept by prune (a clock that moved back must not lose fresh hints)', () => {
    const book = new HintBook();
    book.add({ kind: 'git', root: '/ws', at: T0 + 10_000 });
    book.prune(T0);
    assert.equal(book.size, 1);
  });

  it('the book is bounded: a flood of hints never grows it past a fixed cap, and the newest survive', () => {
    const book = new HintBook();
    for (let i = 0; i < 5000; i += 1) book.add({ kind: 'agent', agent: `a${i}`, file: `/ws/f${i}.ts`, at: T0 + i });
    assert.ok(book.size <= 1000, `size ${book.size}`);
    assert.ok(book.size > 0);
    const newest = book.match({ key: '/ws/f4999.ts', at: T0 + 4999 });
    assert.ok(newest, 'the newest hint is still there');
    assert.equal(book.match({ key: '/ws/f0.ts', at: T0 }), undefined, 'the oldest was dropped');
  });

  it('match does not mutate the book', () => {
    const book = new HintBook();
    book.add({ kind: 'git', root: '/ws', at: T0 });
    book.match({ key: A, at: T0 });
    book.match({ key: A, at: T0 + 10 });
    assert.equal(book.size, 1);
  });
});
