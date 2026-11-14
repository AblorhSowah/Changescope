// Everything the live stores produce must survive storage: EventStore + SessionManager -> serialise -> JSON ->
// deserialise -> load. A record that the validator would drop is a record that vanishes after a restart.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../../src/core/activity/eventStore';
import { ManualClock } from '../../src/core/clock';
import { SessionManager } from '../../src/core/sessions/sessionManager';
import { deserialise, serialise } from '../../src/core/storage/schema';
import type { ActivitySourceType, DetectionMethod } from '../../src/core/types';

const T0 = 1_700_000_000_000;

function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

const SOURCES: ActivitySourceType[] = ['developer', 'ai-agent', 'external', 'git', 'automated', 'unknown'];
const METHODS: DetectionMethod[] = ['focused-editor-edit', 'undo-redo', 'workbench-file-operation', 'workspace-edit', 'disk-write', 'reload-from-disk', 'disk-delete', 'git-state-change', 'agent-signal', 'restored'];

describe('history round trip: what the stores produce is what storage accepts', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    it(`seed ${seed}: 400 random operations, then save, restart and compare`, () => {
      const r = rng(seed * 104729);
      const clock = new ManualClock(T0);
      const store = new EventStore(clock, 'ws-1', { maxEvents: 120, coalesceMs: 2000 });
      const sessions = new SessionManager(clock, 'ws-1', 6);
      for (let step = 0; step < 400; step += 1) {
        clock.advance(r(3000));
        const op = r(30);
        const key = `/ws/d${r(5)}/f${r(15)}.ts`;
        if (op < 20) {
          const sourceType = SOURCES[r(6)] as ActivitySourceType;
          const event = store.add({
            key,
            eventType: (['create', 'modify', 'delete'] as const)[r(3)] as 'create' | 'modify' | 'delete',
            at: clock.now(),
            sourceType,
            ...(sourceType === 'ai-agent' ? { sourceId: ['claude-code', 'a', 'x'.repeat(64)][r(3)] as string } : {}),
            detectionMethod: METHODS[r(10)] as DetectionMethod,
            confidence: [0, 0.2, 0.7, 0.95, 1, 1.7, -1, Number.NaN][r(8)] as number,
            ...(sessions.activeSessionId !== undefined && r(4) > 0 ? { sessionId: sessions.activeSessionId } : {}),
          });
          sessions.record(event, true);
        } else if (op === 20) sessions.start(['', 'Refactor', 'x'.repeat(200), '  spaced  out  '][r(4)] as string, r(2) === 0 ? { branch: 'main', commit: 'abc123' } : undefined);
        else if (op === 21) sessions.stop(r(2) === 0 ? { branch: 'dev' } : undefined);
        else if (op === 22) store.markReviewed(key);
        else if (op === 23) store.markAllReviewed();
        else if (op === 24) store.rename(`/ws/d${r(5)}`, `/ws/d${r(5)}`);
        else if (op === 25) store.reattribute(() => ({ sourceType: SOURCES[r(6)] as ActivitySourceType, detectionMethod: METHODS[r(10)] as DetectionMethod, confidence: 0.8 }), clock.now() - 3000);
        else if (op === 26) sessions.renameFiles(`/ws/d${r(5)}`, `/ws/d${r(5)}`);
        else if (op === 27) sessions.rename(sessions.list()[0]?.id ?? 'none', 'Renamed');
        else if (op === 28) store.prune();
        else sessions.clearCompleted();
      }

      const wire = JSON.parse(JSON.stringify(serialise(store.events(), sessions.list(), clock.now()))) as unknown;
      const back = deserialise(wire);
      assert.equal(back.recovered, 0, 'storage dropped records that the live stores produced');
      assert.deepEqual(back.events, store.events().map((e) => JSON.parse(JSON.stringify(e)) as unknown));
      assert.deepEqual(back.sessions, sessions.list().map((s) => JSON.parse(JSON.stringify(s)) as unknown));

      // restart: a fresh store and manager loaded from storage show the same thing
      const store2 = new EventStore(clock, 'ws-1', { maxEvents: 120, coalesceMs: 2000 });
      store2.load(back.events);
      assert.deepEqual(store2.events(), store.events());
      assert.deepEqual(store2.files(), store.files());
      assert.equal(store2.unreviewedFiles(), store.unreviewedFiles());
      const sessions2 = new SessionManager(clock, 'ws-1', 6);
      sessions2.load(back.sessions);
      const activeBefore = sessions.active();
      const expectedList = sessions.list().map((s) => (s.status === 'active' ? { ...s, status: 'completed', endedAt: s.startedAt } : s));
      assert.deepEqual(sessions2.list(), expectedList, 'a session that was running comes back completed, nothing else changes');
      assert.equal(sessions2.active(), undefined);
      if (activeBefore !== undefined) assert.equal(sessions2.get(activeBefore.id)?.status, 'completed');

      // and the store keeps working after the restart: ids stay unique, a new change merges or appends correctly
      const next = store2.add({ key: '/ws/new.ts', eventType: 'modify', at: clock.now(), sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 });
      const ids = store2.events().map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'ids are unique after load + add');
      assert.ok(next.id.length > 0);
    });
  }

  it('a re-saved history is byte-for-byte the same JSON as the first save (storage is a fixed point)', () => {
    const clock = new ManualClock(T0);
    const store = new EventStore(clock, 'ws-1');
    for (let i = 0; i < 50; i += 1) {
      clock.advance(1500);
      store.add({ key: `/ws/f${i % 7}.ts`, eventType: 'modify', at: clock.now(), sourceType: i % 2 === 0 ? 'developer' : 'external', detectionMethod: i % 2 === 0 ? 'focused-editor-edit' : 'disk-write', confidence: 0.8 });
    }
    const first = JSON.stringify(serialise(store.events(), [], T0));
    const back = deserialise(JSON.parse(first) as unknown);
    const second = JSON.stringify(serialise(back.events, back.sessions, T0));
    assert.equal(second, first);
  });
});
