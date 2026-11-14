import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVENT_STORE_OPTIONS, EventStore, deleteTargets } from '../../src/core/activity/eventStore';
import type { FileActivity, NewEvent } from '../../src/core/activity/eventStore';
import { ManualClock } from '../../src/core/clock';
import type { ActivityEvent } from '../../src/core/types';
import { must } from '../support/fixtures';

const T0 = 10_000_000;
const A = '/ws/a.ts';
const B = '/ws/b.ts';
const C = '/ws/c.ts';
const DAY = 24 * 60 * 60 * 1000;

function setup(options: ConstructorParameters<typeof EventStore>[2] = {}): { clock: ManualClock; store: EventStore } {
  const clock = new ManualClock(T0);
  return { clock, store: new EventStore(clock, 'ws-1', options) };
}

const external = { sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 } as const;
const developer = { sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9 } as const;
const agent = { sourceType: 'ai-agent', sourceId: 'claude-code', detectionMethod: 'agent-signal', confidence: 0.95 } as const;

function ev(key: string, at: number, o: Partial<NewEvent> = {}): NewEvent {
  return { key, eventType: 'modify', at, ...external, ...o };
}

function stored(o: Partial<ActivityEvent> & { id: string; filePath: string }): ActivityEvent {
  return {
    workspaceId: 'ws-1',
    eventType: 'modify',
    sourceType: 'external',
    detectionMethod: 'disk-write',
    confidence: 0.7,
    timestamp: T0,
    lastTimestamp: T0,
    count: 1,
    reviewStatus: 'unreviewed',
    ...o,
  };
}

describe('EventStore: defaults and add', () => {
  it('defaults are 1000 events, 14 days, 5000 ms', () => {
    assert.deepEqual(DEFAULT_EVENT_STORE_OPTIONS, { maxEvents: 1000, retentionMs: 14 * DAY, coalesceMs: 5000 });
  });

  it('starts empty with revision 0', () => {
    const { store } = setup();
    assert.equal(store.size, 0);
    assert.equal(store.revision, 0);
    assert.deepEqual(store.events(), []);
    assert.deepEqual(store.files(), []);
    assert.deepEqual(store.recent(10), []);
    assert.equal(store.unreviewedFiles(), 0);
  });

  it('add creates a fully populated event with ids e1, e2, ... in base 36', () => {
    const { store } = setup();
    const first = store.add(ev(A, T0));
    assert.deepEqual(first, {
      id: 'e1',
      workspaceId: 'ws-1',
      filePath: A,
      eventType: 'modify',
      sourceType: 'external',
      detectionMethod: 'disk-write',
      confidence: 0.7,
      timestamp: T0,
      lastTimestamp: T0,
      count: 1,
      reviewStatus: 'unreviewed',
    });
    for (let i = 2; i <= 40; i += 1) store.add(ev(`/ws/f${i}.ts`, T0));
    const ids = store.events().map((e) => e.id);
    assert.equal(ids[0], 'e1');
    assert.equal(ids[9], 'ea', 'the tenth id is base 36');
    assert.equal(ids[34], 'ez');
    assert.equal(ids[35], 'e10');
    assert.equal(new Set(ids).size, ids.length);
  });

  it('non-developer events start unreviewed, developer events carry no review status at all', () => {
    const { store } = setup();
    assert.equal(store.add(ev(A, T0)).reviewStatus, 'unreviewed');
    assert.equal(store.add(ev(B, T0, agent)).reviewStatus, 'unreviewed');
    for (const sourceType of ['git', 'automated', 'unknown'] as const) {
      assert.equal(store.add(ev(`/ws/${sourceType}`, T0, { sourceType })).reviewStatus, 'unreviewed', sourceType);
    }
    const dev = store.add(ev(C, T0, developer));
    assert.equal('reviewStatus' in dev, false);
  });

  it('keeps source id and session id only when given', () => {
    const { store } = setup();
    const plain = store.add(ev(A, T0));
    assert.equal('sourceId' in plain, false);
    assert.equal('sessionId' in plain, false);
    const full = store.add(ev(B, T0, { ...agent, sessionId: 's1' }));
    assert.equal(full.sourceId, 'claude-code');
    assert.equal(full.sessionId, 's1');
  });

  it('confidence is clamped to 0..1 and NaN becomes 0', () => {
    const { store } = setup();
    assert.equal(store.add(ev(A, T0, { confidence: 7 })).confidence, 1);
    assert.equal(store.add(ev(B, T0, { confidence: -3 })).confidence, 0);
    assert.equal(store.add(ev(C, T0, { confidence: Number.NaN })).confidence, 0);
    assert.equal(store.add(ev('/ws/d', T0, { confidence: Number.POSITIVE_INFINITY })).confidence, 0, 'a non-finite confidence is 0, not 1');
  });

  it('a non-finite timestamp is replaced by the clock', () => {
    const { clock, store } = setup();
    clock.set(T0 + 123);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const e = store.add(ev(`/ws/${String(at)}`, at));
      assert.equal(e.timestamp, T0 + 123);
      assert.equal(e.lastTimestamp, T0 + 123);
    }
  });

  it('the workspace id is stamped on every event and never a path', () => {
    const { store } = setup();
    assert.equal(store.add(ev(A, T0)).workspaceId, 'ws-1');
  });

  it('revision increments on every change and not on reads', () => {
    const { store } = setup();
    const r0 = store.revision;
    store.add(ev(A, T0));
    const r1 = store.revision;
    assert.ok(r1 > r0);
    store.add(ev(A, T0 + 1)); // a merge is a change too
    const r2 = store.revision;
    assert.ok(r2 > r1);
    store.events();
    store.files();
    store.recent(5);
    store.unreviewedFiles();
    assert.equal(store.revision, r2, 'reads never touch the revision');
  });
});

describe('EventStore: the coalescing rule', () => {
  it('merges rapid successive changes of one file by one source into one event', () => {
    const { store } = setup();
    const first = store.add(ev(A, T0));
    const second = store.add(ev(A, T0 + 1000));
    const third = store.add(ev(A, T0 + 2500));
    assert.equal(store.size, 1);
    assert.equal(first, second, 'the merged event is returned');
    assert.equal(third.id, 'e1');
    assert.equal(third.count, 3);
    assert.equal(third.timestamp, T0);
    assert.equal(third.lastTimestamp, T0 + 2500);
  });

  it('the gap is measured from the LAST occurrence, so a steady stream stays one event', () => {
    const { store } = setup();
    for (let i = 0; i < 20; i += 1) store.add(ev(A, T0 + i * 4000));
    assert.equal(store.size, 1);
    assert.equal(must(store.events()[0]).count, 20);
  });

  it('boundary: a gap of exactly coalesceMs merges, one millisecond more does not', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 5000));
    assert.equal(store.size, 1);
    store.add(ev(A, T0 + 5000 + 5001));
    assert.equal(store.size, 2);
    assert.equal(must(store.events()[1]).count, 1);
  });

  it('coalesceMs 0 merges only occurrences at the same millisecond', () => {
    const { store } = setup({ coalesceMs: 0 });
    store.add(ev(A, T0));
    store.add(ev(A, T0));
    assert.equal(store.size, 1);
    store.add(ev(A, T0 + 1));
    assert.equal(store.size, 2);
  });

  it('setOptions changes the window for later adds', () => {
    const { store } = setup({ coalesceMs: 100 });
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 1000));
    assert.equal(store.size, 2);
    store.setOptions({ coalesceMs: 10_000 });
    store.add(ev(A, T0 + 2000));
    assert.equal(store.size, 2);
    assert.equal(must(store.events()[1]).count, 2);
  });

  it('does not merge when the event type, source type, source id or session id differs', () => {
    const variants: Array<[string, Partial<NewEvent>, Partial<NewEvent>]> = [
      ['event type', {}, { eventType: 'create' }],
      ['event type (delete)', {}, { eventType: 'delete' }],
      ['source type', {}, { sourceType: 'git' }],
      ['source id', agent, { ...agent, sourceId: 'another-agent' }],
      ['source id present vs absent', agent, { sourceType: 'ai-agent' }],
      ['session id', { sessionId: 's1' }, { sessionId: 's2' }],
      ['session id present vs absent', { sessionId: 's1' }, {}],
    ];
    for (const [name, one, two] of variants) {
      const { store } = setup();
      store.add(ev(A, T0, one));
      store.add(ev(A, T0 + 1, two));
      assert.equal(store.size, 2, name);
    }
  });

  it('does not merge different files, and only the NEWEST event of a file is a merge target', () => {
    const { store } = setup();
    store.add(ev(A, T0)); // e1
    store.add(ev(B, T0 + 1)); // e2
    const again = store.add(ev(A, T0 + 2)); // merges into e1 although e2 is newer overall
    assert.equal(again.id, 'e1');
    assert.equal(again.count, 2);
    store.add(ev(A, T0 + 3, developer)); // e3, developer
    const third = store.add(ev(A, T0 + 4)); // the newest A event is now the developer one: a new event
    assert.equal(third.id, 'e4');
    assert.equal(store.size, 4);
  });

  it('a late occurrence (older timestamp) merges but never moves lastTimestamp backwards', () => {
    const { store } = setup();
    store.add(ev(A, T0 + 3000));
    const e = store.add(ev(A, T0 + 1000));
    assert.equal(e.count, 2);
    assert.equal(e.lastTimestamp, T0 + 3000);
    assert.equal(e.timestamp, T0 + 3000);
  });

  it('a change after the file was reviewed is a new event, and is unreviewed (it must not be swallowed by the reviewed one)', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.markReviewed(A);
    const next = store.add(ev(A, T0 + 10));
    assert.equal(store.size, 2);
    assert.equal(next.reviewStatus, 'unreviewed');
    assert.equal(store.unreviewedFiles(), 1);
    // DESIGN-0.3.0 4.3 does not list this condition: recorded in QA_REPORT as a doc deviation
  });

  it('developer events merge like any other (no review state to block them)', () => {
    const { store } = setup();
    store.add(ev(A, T0, developer));
    store.add(ev(A, T0 + 10, developer));
    assert.equal(store.size, 1);
    assert.equal(must(store.events()[0]).count, 2);
  });

  it('typing a paragraph (300 edits in a minute) is one event, 300 changes', () => {
    const { store } = setup();
    for (let i = 0; i < 300; i += 1) store.add(ev(A, T0 + i * 200, developer));
    assert.equal(store.size, 1);
    const [file] = store.files();
    assert.equal(must(file).changes, 300);
  });
});

describe('EventStore: limits and retention', () => {
  it('over maxEvents the oldest go first', () => {
    const { store } = setup({ maxEvents: 3 });
    for (let i = 0; i < 5; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
    assert.equal(store.size, 3);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      ['/ws/f2.ts', '/ws/f3.ts', '/ws/f4.ts'],
    );
  });

  it('after the oldest event of a file was trimmed, a new change of that file starts a fresh event (no merge into a dropped one)', () => {
    const { store } = setup({ maxEvents: 2 });
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1));
    store.add(ev(C, T0 + 2)); // drops A
    const again = store.add(ev(A, T0 + 3));
    assert.equal(again.count, 1);
    assert.equal(store.size, 2);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      [C, A],
    );
    assert.equal(store.files().length, 2);
  });

  it('maxEvents 1 keeps only the newest event', () => {
    const { store } = setup({ maxEvents: 1 });
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1));
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      [B],
    );
  });

  it('setOptions shrinks immediately and bumps the revision; an unchanged limit does not', () => {
    const { store } = setup({ maxEvents: 10 });
    for (let i = 0; i < 6; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
    const r = store.revision;
    store.setOptions({ maxEvents: 10 });
    assert.equal(store.revision, r, 'nothing dropped, nothing changed');
    store.setOptions({ maxEvents: 2 });
    assert.equal(store.size, 2);
    assert.ok(store.revision > r);
  });

  it('nonsensical options keep the previous value: NaN, 0, negative, Infinity', () => {
    const { store } = setup({ maxEvents: 4, retentionMs: DAY, coalesceMs: 100 });
    store.setOptions({ maxEvents: Number.NaN, retentionMs: -5, coalesceMs: Number.NaN });
    store.setOptions({ maxEvents: 0 });
    store.setOptions({ maxEvents: Number.POSITIVE_INFINITY, retentionMs: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 10; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i * 1000));
    assert.equal(store.size, 4);
    store.add(ev('/ws/f9.ts', T0 + 9000 + 101));
    assert.equal(store.size, 4);
    assert.equal(must(store.events()[3]).count, 1, '101 ms is beyond the old 100 ms window, so no merge');
  });

  it('a fractional maxEvents is floored but never below 1', () => {
    const { store } = setup({ maxEvents: 3.9 });
    for (let i = 0; i < 6; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
    assert.equal(store.size, 3);
    store.setOptions({ maxEvents: 0.4 });
    assert.equal(store.size, 1);
  });

  it('prune drops events whose LAST occurrence is older than retentionMs, boundary kept', () => {
    const { clock, store } = setup({ retentionMs: 1000 });
    store.add(ev(A, T0 - 1001)); // older than the cutoff
    store.add(ev(B, T0 - 1000)); // exactly at the cutoff: kept
    store.add(ev(C, T0));
    assert.equal(store.prune(), 1);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      [B, C],
    );
    clock.advance(5000);
    assert.equal(store.prune(), 2);
    assert.equal(store.size, 0);
  });

  it('retention looks at the last occurrence: a long-running merged event survives', () => {
    const { store } = setup({ retentionMs: 10_000, coalesceMs: 5000 });
    for (let i = 0; i < 10; i += 1) store.add(ev(A, T0 - 40_000 + i * 4000)); // first at T0-40s, last at T0-4s
    assert.equal(store.size, 1);
    assert.equal(store.prune(), 0);
  });

  it('prune returns 0 and leaves the revision alone when nothing is old', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    assert.equal(store.prune(), 0);
    assert.equal(store.revision, r);
  });

  it('setOptions applies a shorter retention at once', () => {
    const { store } = setup();
    store.add(ev(A, T0 - 5000));
    store.add(ev(B, T0));
    store.setOptions({ retentionMs: 1000 });
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      [B],
    );
  });

  it('after a prune, a new change of a pruned file starts a fresh event', () => {
    const { store } = setup({ retentionMs: 1000 });
    store.add(ev(A, T0 - 2000));
    store.prune();
    const e = store.add(ev(A, T0));
    assert.equal(e.count, 1);
    assert.equal(store.size, 1);
  });
});

describe('EventStore: recent and events', () => {
  it('events() is oldest first (creation order) and a fresh array each call', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1));
    const one = store.events();
    const two = store.events();
    assert.notEqual(one, two);
    (one as ActivityEvent[]).length = 0;
    assert.equal(store.size, 2, 'emptying the returned array does not empty the store');
  });

  it('recent() is newest first by last occurrence, ties newest created first, and respects the limit', () => {
    const { store } = setup();
    store.add(ev(A, T0)); // e1
    store.add(ev(B, T0 + 100)); // e2
    store.add(ev(A, T0 + 200)); // merges into e1: last occurrence T0+200
    store.add(ev(C, T0 + 200)); // e3, same time as e1's last occurrence, created later
    assert.deepEqual(
      store.recent(10).map((e) => e.id),
      ['e3', 'e1', 'e2'],
    );
    assert.deepEqual(
      store.recent(2).map((e) => e.id),
      ['e3', 'e1'],
    );
  });

  it('recent() with 0, negative, NaN or a fraction below 1 gives an empty list; a fraction is floored', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1));
    for (const n of [0, -1, Number.NaN, 0.9]) assert.deepEqual(store.recent(n), [], String(n));
    assert.equal(store.recent(1.9).length, 1);
  });

  it('[QA-107] recent(Infinity) means "everything", not "nothing"; NaN, -Infinity and non-numbers still give none', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1));
    assert.equal(store.recent(Number.POSITIVE_INFINITY).length, 2);
    assert.deepEqual(
      store.recent(Number.POSITIVE_INFINITY).map((e) => e.filePath),
      [B, A],
      'newest first, as for a finite limit',
    );
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, '2' as unknown as number, null as unknown as number, undefined as unknown as number]) assert.deepEqual(store.recent(bad), [], String(bad));
  });

  it('recent() with a limit larger than the store returns everything', () => {
    const { store } = setup();
    for (let i = 0; i < 5; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
    assert.equal(store.recent(1_000_000).length, 5);
  });
});

describe('EventStore: per-file summaries', () => {
  it('one summary per file, newest first, ties by key', () => {
    const { store } = setup();
    store.add(ev(B, T0 + 5));
    store.add(ev(A, T0 + 5));
    store.add(ev(C, T0 + 9));
    assert.deepEqual(
      store.files().map((f) => f.key),
      [C, A, B],
    );
  });

  it('source, method and confidence come from the newest event; changes is the sum of counts; firstAt is the earliest', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 1)); // count 2
    store.add(ev(A, T0 + 60_000, agent)); // new event, agent
    const [f] = store.files();
    const file = must(f);
    assert.equal(file.sourceType, 'ai-agent');
    assert.equal(file.sourceId, 'claude-code');
    assert.equal(file.detectionMethod, 'agent-signal');
    assert.equal(file.confidence, 0.95);
    assert.equal(file.changes, 3);
    assert.equal(file.firstAt, T0);
    assert.equal(file.lastAt, T0 + 60_000);
    assert.equal(file.lastEventType, 'modify');
  });

  it('review: unreviewed if any kept event is unreviewed, else reviewed if any was, else undefined', () => {
    const { store } = setup();
    store.add(ev(A, T0, developer));
    assert.equal(must(store.files()[0]).review, undefined);
    store.add(ev(A, T0 + 10_000)); // external, unreviewed
    assert.equal(must(store.files()[0]).review, 'unreviewed');
    store.markReviewed(A);
    assert.equal(must(store.files()[0]).review, 'reviewed');
    store.add(ev(A, T0 + 20_000));
    assert.equal(must(store.files()[0]).review, 'unreviewed');
  });

  it('exists follows the newest event: false after a delete, true again after a create', () => {
    const { store } = setup();
    store.add(ev(A, T0, { eventType: 'create' }));
    assert.equal(must(store.files()[0]).exists, true);
    store.add(ev(A, T0 + 10, { eventType: 'delete' }));
    const gone = must(store.files()[0]);
    assert.equal(gone.exists, false);
    assert.equal(gone.lastEventType, 'delete');
    store.add(ev(A, T0 + 20, { eventType: 'create' }));
    assert.equal(must(store.files()[0]).exists, true);
  });

  it('a delete that merges (two quick delete reports) still counts both', () => {
    const { store } = setup();
    store.add(ev(A, T0, { eventType: 'delete' }));
    store.add(ev(A, T0 + 5, { eventType: 'delete' }));
    assert.equal(must(store.files()[0]).changes, 2);
  });

  it('the returned summaries are copies: editing one does not change the next call', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const one = store.files();
    must(one[0]).changes = 999;
    must(one[0]).review = 'reviewed';
    assert.equal(must(store.files()[0]).changes, 1);
    assert.equal(must(store.files()[0]).review, 'unreviewed');
  });

  it('is cached by revision: identical content between changes, fresh content after a change', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const a = store.files();
    const b = store.files();
    assert.deepEqual(a, b);
    store.add(ev(B, T0 + 1));
    assert.equal(store.files().length, 2);
  });

  it('sessionId comes from the newest event', () => {
    const { store } = setup();
    store.add(ev(A, T0, { sessionId: 's1' }));
    store.add(ev(A, T0 + 10_000, { sessionId: 's2' }));
    assert.equal(must(store.files()[0]).sessionId, 's2');
  });
});

describe('EventStore: reattribute', () => {
  const asAgent = (): { sourceType: 'ai-agent'; sourceId: string; detectionMethod: 'agent-signal'; confidence: number } => ({
    sourceType: 'ai-agent',
    sourceId: 'claude-code',
    detectionMethod: 'agent-signal',
    confidence: 0.95,
  });

  it('only looks at events whose last occurrence is at or after sinceMs', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 1000));
    store.add(ev(C, T0 + 2000));
    const seen: string[] = [];
    const n = store.reattribute((e) => {
      seen.push(e.filePath);
      return asAgent();
    }, T0 + 1000);
    assert.equal(n, 2);
    assert.deepEqual(seen.sort(), [B, C]);
    assert.equal(must(store.events()[0]).sourceType, 'external');
    assert.equal(must(store.events()[1]).sourceType, 'ai-agent');
  });

  it('a long merged event is judged by its LAST occurrence', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 4000));
    store.add(ev(A, T0 + 8000));
    assert.equal(store.reattribute(() => asAgent(), T0 + 8000), 1);
  });

  it('applies source, source id, method and confidence and returns how many events changed', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0));
    const n = store.reattribute((e) => (e.filePath === A ? asAgent() : undefined), 0);
    assert.equal(n, 1);
    const changed = must(store.events().find((e) => e.filePath === A));
    assert.equal(changed.sourceType, 'ai-agent');
    assert.equal(changed.sourceId, 'claude-code');
    assert.equal(changed.detectionMethod, 'agent-signal');
    assert.equal(changed.confidence, 0.95);
    assert.equal(changed.reviewStatus, 'unreviewed');
  });

  it('an attribution identical to the current one is not a change and does not bump the revision', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    assert.equal(
      store.reattribute(() => ({ ...external }), 0),
      0,
    );
    assert.equal(store.revision, r);
    assert.equal(store.reattribute(() => undefined, 0), 0);
    assert.equal(store.revision, r);
  });

  it('a developer result removes the review state; going back to non-developer adds "unreviewed"; a reviewed non-developer stays reviewed', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.reattribute(() => ({ ...developer }), 0);
    assert.equal('reviewStatus' in must(store.events()[0]), false);
    store.reattribute(() => ({ ...external }), 0);
    assert.equal(must(store.events()[0]).reviewStatus, 'unreviewed');
    store.markReviewed(A);
    store.reattribute(() => asAgent(), 0);
    assert.equal(must(store.events()[0]).reviewStatus, 'reviewed');
  });

  it('dropping the source id when the new attribution has none', () => {
    const { store } = setup();
    store.add(ev(A, T0, agent));
    store.reattribute(() => ({ sourceType: 'git', detectionMethod: 'git-state-change', confidence: 0.8 }), 0);
    const e = must(store.events()[0]);
    assert.equal('sourceId' in e, false);
    assert.equal(e.sourceType, 'git');
  });

  it('the confidence of a reattribution is clamped like add', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.reattribute(() => ({ sourceType: 'git', detectionMethod: 'git-state-change', confidence: 9 }), 0);
    assert.equal(must(store.events()[0]).confidence, 1);
  });

  it('bumps the revision when something changed, so the dashboard rebuilds', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    store.reattribute(() => asAgent(), 0);
    assert.ok(store.revision > r);
    assert.equal(must(store.files()[0]).sourceType, 'ai-agent', 'the per-file cache was invalidated');
  });
});

describe('EventStore: review state', () => {
  it('markReviewed handles one file and reports how many events changed', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 10_000)); // second event of A
    store.add(ev(B, T0));
    assert.equal(store.markReviewed(A), 2);
    assert.equal(store.unreviewedFiles(), 1);
    assert.equal(store.markReviewed(A), 0, 'idempotent');
    assert.equal(store.markReviewed('/ws/missing.ts'), 0);
  });

  it('markReviewed does not touch developer events (they have no state to change)', () => {
    const { store } = setup();
    store.add(ev(A, T0, developer));
    assert.equal(store.markReviewed(A), 0);
    assert.equal('reviewStatus' in must(store.events()[0]), false);
  });

  it('markAllReviewed clears everything and unreviewedFiles counts files, not events', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(A, T0 + 10_000));
    store.add(ev(B, T0));
    store.add(ev(C, T0, developer));
    assert.equal(store.unreviewedFiles(), 2);
    assert.equal(store.markAllReviewed(), 3);
    assert.equal(store.unreviewedFiles(), 0);
    assert.equal(store.markAllReviewed(), 0);
  });

  it('review operations change the revision only when something changed', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    store.markReviewed(B);
    store.markAllReviewed();
    assert.ok(store.revision > r);
    const r2 = store.revision;
    store.markAllReviewed();
    store.markReviewed(A);
    assert.equal(store.revision, r2);
  });
});

describe('EventStore: rename', () => {
  it('re-keys a renamed file', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    assert.equal(store.rename(A, '/ws/z.ts'), 1);
    assert.equal(must(store.events()[0]).filePath, '/ws/z.ts');
    assert.deepEqual(
      store.files().map((f) => f.key),
      ['/ws/z.ts'],
    );
  });

  it('re-keys everything below a renamed folder and keeps the rest of the path', () => {
    const { store } = setup();
    store.add(ev('/ws/src/a.ts', T0));
    store.add(ev('/ws/src/deep/b.ts', T0 + 1));
    store.add(ev('/ws/src', T0 + 2));
    store.add(ev('/ws/other.ts', T0 + 3));
    assert.equal(store.rename('/ws/src', '/ws/lib'), 3);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      ['/ws/lib/a.ts', '/ws/lib/deep/b.ts', '/ws/lib', '/ws/other.ts'],
    );
  });

  it('a sibling that merely shares a prefix is not renamed', () => {
    const { store } = setup();
    store.add(ev('/ws/src2/a.ts', T0));
    store.add(ev('/ws/src.bak', T0));
    assert.equal(store.rename('/ws/src', '/ws/lib'), 0);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      ['/ws/src2/a.ts', '/ws/src.bak'],
    );
  });

  it('degenerate renames do nothing and do not bump the revision', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    assert.equal(store.rename('', '/ws/x'), 0);
    assert.equal(store.rename(A, A), 0);
    assert.equal(store.rename('/ws/none', '/ws/x'), 0);
    assert.equal(store.revision, r);
  });

  it('a change to the NEW name after a rename merges into the renamed event (the merge index follows)', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.rename(A, '/ws/z.ts');
    store.add(ev('/ws/z.ts', T0 + 100));
    assert.equal(store.size, 1);
    assert.equal(must(store.events()[0]).count, 2);
    // and the old name is free again
    store.add(ev(A, T0 + 200));
    assert.equal(store.size, 2);
  });

  it('renaming onto a name that already has history keeps both histories under one file', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.add(ev(B, T0 + 10));
    store.rename(A, B);
    const files = store.files();
    assert.equal(files.length, 1);
    assert.equal(must(files[0]).changes, 2);
  });
});

describe('EventStore: load', () => {
  it('replaces the content, sorts by time, and continues the id counter past the loaded ids', () => {
    const { store } = setup();
    store.add(ev('/ws/old.ts', T0));
    store.load([stored({ id: 'e5', filePath: B, timestamp: T0 + 50, lastTimestamp: T0 + 50 }), stored({ id: 'ez', filePath: A, timestamp: T0 + 10, lastTimestamp: T0 + 10 })]);
    assert.deepEqual(
      store.events().map((e) => e.id),
      ['ez', 'e5'],
      'sorted by first timestamp',
    );
    const next = store.add(ev(C, T0 + 100));
    assert.equal(next.id, 'e10', 'the counter continues after the highest loaded id (ez = 35)');
  });

  it('loading nothing empties the store', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    store.load([]);
    assert.equal(store.size, 0);
  });

  it('stamps this workspace id on loaded events (a foreign id from storage is not trusted)', () => {
    const { store } = setup();
    store.load([stored({ id: 'e1', filePath: A, workspaceId: 'someone-elses' })]);
    assert.equal(must(store.events()[0]).workspaceId, 'ws-1');
  });

  it('duplicate ids are made unique', () => {
    const { store } = setup();
    store.load([stored({ id: 'e1', filePath: A, timestamp: T0 }), stored({ id: 'e1', filePath: B, timestamp: T0 + 1, lastTimestamp: T0 + 1 }), stored({ id: 'e2', filePath: C, timestamp: T0 + 2, lastTimestamp: T0 + 2 })]);
    const ids = store.events().map((e) => e.id);
    assert.equal(new Set(ids).size, 3, ids.join(','));
    const e = store.add(ev('/ws/d.ts', T0 + 10));
    assert.ok(!ids.includes(e.id), 'a new id never collides with a loaded one');
  });

  it('applies maxEvents (keeping the newest) and retention', () => {
    const { store } = setup({ maxEvents: 2, retentionMs: DAY });
    store.load([
      stored({ id: 'e1', filePath: '/ws/ancient.ts', timestamp: T0 - 3 * DAY, lastTimestamp: T0 - 3 * DAY }),
      stored({ id: 'e2', filePath: A, timestamp: T0 - 30, lastTimestamp: T0 - 30 }),
      stored({ id: 'e3', filePath: B, timestamp: T0 - 20, lastTimestamp: T0 - 20 }),
      stored({ id: 'e4', filePath: C, timestamp: T0 - 10, lastTimestamp: T0 - 10 }),
    ]);
    assert.deepEqual(
      store.events().map((e) => e.filePath),
      [B, C],
    );
  });

  it('the loaded events are copies: changing the input array or objects later does not change the store', () => {
    const { store } = setup();
    const input = [stored({ id: 'e1', filePath: A })];
    store.load(input);
    must(input[0]).count = 99;
    input.length = 0;
    assert.equal(store.size, 1);
    assert.equal(must(store.events()[0]).count, 1);
  });

  it('after load, a change merges into the newest loaded event of that file', () => {
    const { store } = setup();
    store.load([stored({ id: 'e1', filePath: A, timestamp: T0 - 100, lastTimestamp: T0 - 100 })]);
    const e = store.add(ev(A, T0));
    assert.equal(e.id, 'e1');
    assert.equal(e.count, 2);
  });

  it('after load, the newest event per file is the one with the latest last occurrence', () => {
    const { store } = setup({ coalesceMs: 10 });
    store.load([stored({ id: 'e1', filePath: A, timestamp: T0, lastTimestamp: T0 + 500 }), stored({ id: 'e2', filePath: A, timestamp: T0 + 100, lastTimestamp: T0 + 100 })]);
    const e = store.add(ev(A, T0 + 505));
    assert.equal(e.id, 'e1');
  });

  it('bumps the revision', () => {
    const { store } = setup();
    const r = store.revision;
    store.load([]);
    assert.ok(store.revision > r);
  });

  it('ids that do not look like ours ("abc", "e", huge) are kept and do not break the counter', () => {
    const { store } = setup();
    store.load([stored({ id: 'abc', filePath: A }), stored({ id: 'e', filePath: B, timestamp: T0 + 1, lastTimestamp: T0 + 1 }), stored({ id: 'ezzzzzzzzzzzzzz', filePath: C, timestamp: T0 + 2, lastTimestamp: T0 + 2 })]);
    const e = store.add(ev('/ws/d.ts', T0 + 5));
    assert.equal(e.id, 'e1');
    assert.equal(store.size, 4);
  });

  it('survives events with a NaN timestamp without throwing', () => {
    const { store } = setup();
    assert.doesNotThrow(() => store.load([stored({ id: 'e1', filePath: A, timestamp: Number.NaN, lastTimestamp: Number.NaN }), stored({ id: 'e2', filePath: B })]));
    assert.doesNotThrow(() => store.files());
    assert.doesNotThrow(() => store.recent(5));
  });
});

describe('EventStore: clear', () => {
  it('empties the store, bumps the revision, and never reuses an id', () => {
    const { store } = setup();
    store.add(ev(A, T0));
    const r = store.revision;
    store.clear();
    assert.equal(store.size, 0);
    assert.ok(store.revision > r);
    assert.deepEqual(store.files(), []);
    const e = store.add(ev(A, T0 + 1));
    assert.equal(e.id, 'e2');
    assert.equal(e.count, 1, 'no merge into a cleared event');
  });

  it('clearing an empty store changes nothing', () => {
    const { store } = setup();
    const r = store.revision;
    store.clear();
    assert.equal(store.revision, r);
  });
});

describe('deleteTargets: which files a reported delete stands for', () => {
  const file = (key: string, exists = true): FileActivity => ({
    key,
    sourceType: 'developer',
    detectionMethod: 'focused-editor-edit',
    confidence: 0.9,
    lastEventType: exists ? 'modify' : 'delete',
    firstAt: T0,
    lastAt: T0,
    changes: 1,
    review: undefined,
    exists,
  });

  it('a deleted folder stands for the existing files of the history below it, sorted', () => {
    const files = [file('/ws/src/b.ts'), file('/ws/src/a.ts'), file('/ws/src/gone.ts', false), file('/ws/other.ts')];
    assert.deepEqual(deleteTargets('/ws/src', files), ['/ws/src/a.ts', '/ws/src/b.ts']);
  });

  it('a sibling sharing a prefix is not below the folder', () => {
    assert.deepEqual(deleteTargets('/ws/src', [file('/ws/src2/a.ts')]), []);
  });

  it('without history below, a known file is itself, an unknown path with an extension is a file, a bare name is not', () => {
    assert.deepEqual(deleteTargets('/ws/a.ts', [file('/ws/a.ts')]), ['/ws/a.ts']);
    assert.deepEqual(deleteTargets('/ws/new.ts', []), ['/ws/new.ts']);
    assert.deepEqual(deleteTargets('/ws/somefolder', []), []);
    assert.deepEqual(deleteTargets('/ws/Makefile', [file('/ws/Makefile')]), ['/ws/Makefile']);
  });

  it('is capped at `max`, and a max of 0 or less gives nothing', () => {
    const files = Array.from({ length: 80 }, (_, i) => file(`/ws/d/f${String(i).padStart(2, '0')}.ts`));
    assert.equal(deleteTargets('/ws/d', files).length, 50);
    assert.equal(deleteTargets('/ws/d', files, 3).length, 3);
    assert.deepEqual(deleteTargets('/ws/d', files, 0), []);
    assert.deepEqual(deleteTargets('/ws/d', files, -4), []);
  });
});

describe('EventStore: a long random session keeps its invariants', () => {
  it('sizes, ids, counts and ordering stay consistent under a seeded random mix of operations', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const { clock, store } = setup({ maxEvents: 50, retentionMs: 60_000, coalesceMs: 1000 });
    let occurrences = 0;
    for (let step = 0; step < 3000; step += 1) {
      clock.advance(rnd(700));
      const op = rnd(20);
      const key = `/ws/d${rnd(4)}/f${rnd(12)}.ts`;
      if (op < 14) {
        store.add(ev(key, clock.now(), rnd(2) === 0 ? developer : external));
        occurrences += 1;
      } else if (op === 14) store.markReviewed(key);
      else if (op === 15) store.rename(`/ws/d${rnd(4)}`, `/ws/d${rnd(4)}`);
      else if (op === 16) store.prune();
      else if (op === 17) store.reattribute(() => ({ ...external }), clock.now() - 2000);
      else if (op === 18) store.markAllReviewed();
      else store.recent(5);

      assert.ok(store.size <= 50, `size ${store.size}`);
      if (step % 100 === 0) {
        const events = store.events();
        const ids = events.map((e) => e.id);
        assert.equal(new Set(ids).size, ids.length, 'ids are unique');
        for (const e of events) {
          assert.ok(e.count >= 1);
          assert.ok(e.lastTimestamp >= e.timestamp);
          assert.equal('reviewStatus' in e, e.sourceType !== 'developer', `${e.sourceType} review state`);
        }
        const files = store.files();
        assert.equal(
          files.reduce((n, f) => n + f.changes, 0),
          events.reduce((n, e) => n + e.count, 0),
          'per-file changes add up to the event counts',
        );
        assert.equal(new Set(files.map((f) => f.key)).size, files.length);
        assert.ok(store.unreviewedFiles() <= files.length);
      }
    }
    assert.ok(occurrences > 1000);
  });
});
