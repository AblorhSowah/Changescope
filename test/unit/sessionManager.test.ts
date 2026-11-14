import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../src/core/clock';
import { DEFAULT_MAX_SESSIONS, MAX_SESSION_FILES, SessionManager } from '../../src/core/sessions/sessionManager';
import { formatLocalMinute } from '../../src/core/timeFormat';
import type { ActivityEvent, DevelopmentSession } from '../../src/core/types';
import { must } from '../support/fixtures';

const T0 = new Date(2026, 10, 12, 21, 14, 30).getTime();

function setup(max?: number): { clock: ManualClock; mgr: SessionManager } {
  const clock = new ManualClock(T0);
  return { clock, mgr: new SessionManager(clock, 'ws-1', max) };
}

function event(filePath: string, o: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'e1',
    workspaceId: 'ws-1',
    filePath,
    eventType: 'modify',
    sourceType: 'developer',
    detectionMethod: 'focused-editor-edit',
    confidence: 0.9,
    timestamp: T0,
    lastTimestamp: T0,
    count: 1,
    ...o,
  };
}

function stored(o: Partial<DevelopmentSession> & { id: string }): DevelopmentSession {
  return { title: 'Stored', workspaceId: 'ws-1', startedAt: T0 - 10_000, status: 'completed', activityCount: 0, modifiedFiles: [], sources: {}, ...o };
}

describe('SessionManager: start, stop, single active session', () => {
  it('constants', () => {
    assert.equal(MAX_SESSION_FILES, 500);
    assert.equal(DEFAULT_MAX_SESSIONS, 50);
  });

  it('starts empty', () => {
    const { mgr } = setup();
    assert.equal(mgr.active(), undefined);
    assert.deepEqual(mgr.list(), []);
    assert.equal(mgr.activeSessionId, undefined);
    assert.equal(mgr.get('nope'), undefined);
  });

  it('start creates an active session with the given title, time and git context', () => {
    const { mgr } = setup();
    const s = mgr.start('Refactor', { branch: 'main', commit: 'abc1234def' });
    assert.equal(s.title, 'Refactor');
    assert.equal(s.status, 'active');
    assert.equal(s.startedAt, T0);
    assert.equal(s.endedAt, undefined);
    assert.equal(s.workspaceId, 'ws-1');
    assert.equal(s.activityCount, 0);
    assert.deepEqual(s.modifiedFiles, []);
    assert.deepEqual(s.sources, {});
    assert.deepEqual(s.gitStart, { branch: 'main', commit: 'abc1234def' });
    assert.equal(mgr.active()?.id, s.id);
    assert.equal(mgr.activeSessionId, s.id);
  });

  it('an empty or whitespace-only title becomes "Session YYYY-MM-DD HH:mm" in local time from the clock', () => {
    for (const title of ['', '   ', '\n\t', '\u0000\u0001']) {
      const { mgr } = setup();
      assert.equal(mgr.start(title).title, `Session ${formatLocalMinute(T0)}`, JSON.stringify(title));
    }
    const { mgr } = setup();
    assert.match(mgr.start('').title, /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('the default title follows the injected clock, not the real one', () => {
    const { clock, mgr } = setup();
    clock.set(new Date(2031, 0, 5, 3, 7, 0).getTime());
    assert.equal(mgr.start('').title, 'Session 2031-01-05 03:07');
  });

  it('a non-string title is treated as empty (never throws)', () => {
    const { mgr } = setup();
    for (const bad of [undefined, null, 7, {}, []] as unknown as string[]) {
      assert.doesNotThrow(() => mgr.start(bad));
    }
    assert.match(mgr.start(undefined as unknown as string).title, /^Session /);
  });

  it('titles are cleaned (control characters, whitespace runs) and capped at 120 characters', () => {
    const { mgr } = setup();
    assert.equal(mgr.start('  a\u0000b\nc\t  d  ').title, 'a b c d');
    assert.equal(mgr.start('x'.repeat(500)).title.length, 120);
  });

  it('only one session is active: starting another stops the first, which gets endedAt and the new git context as gitEnd', () => {
    const { clock, mgr } = setup();
    const first = mgr.start('one');
    clock.advance(60_000);
    const second = mgr.start('two', { branch: 'dev' });
    const stoppedFirst = must(mgr.get(first.id));
    assert.equal(stoppedFirst.status, 'completed');
    assert.equal(stoppedFirst.endedAt, T0 + 60_000);
    assert.deepEqual(stoppedFirst.gitEnd, { branch: 'dev' });
    assert.equal(mgr.active()?.id, second.id);
    assert.equal(mgr.list().filter((s) => s.status === 'active').length, 1);
  });

  it('stop completes the active session, sets endedAt and gitEnd, and returns a copy; stopping again is a no-op', () => {
    const { clock, mgr } = setup();
    mgr.start('work');
    clock.advance(5000);
    const s = mgr.stop({ branch: 'main', commit: 'deadbeef' });
    assert.equal(s?.status, 'completed');
    assert.equal(s?.endedAt, T0 + 5000);
    assert.deepEqual(s?.gitEnd, { branch: 'main', commit: 'deadbeef' });
    assert.equal(mgr.active(), undefined);
    assert.equal(mgr.activeSessionId, undefined);
    assert.equal(mgr.stop(), undefined);
  });

  it('endedAt is never before startedAt, even when the clock moved backwards', () => {
    const { clock, mgr } = setup();
    mgr.start('x');
    clock.set(T0 - 99_999);
    assert.equal(mgr.stop()?.endedAt, T0);
  });

  it('after stop, record is a no-op', () => {
    const { mgr } = setup();
    mgr.start('x');
    mgr.stop();
    const rev = mgr.revision;
    mgr.record(event('/ws/a.ts'), true);
    assert.equal(mgr.revision, rev);
    assert.equal(must(mgr.list()[0]).activityCount, 0);
  });

  it('returned sessions are copies: mutating them does not change the manager', () => {
    const { mgr } = setup();
    const s = mgr.start('x');
    s.title = 'hacked';
    s.modifiedFiles.push('/etc/passwd');
    s.sources['git'] = 9;
    const again = must(mgr.get(s.id));
    assert.equal(again.title, 'x');
    assert.deepEqual(again.modifiedFiles, []);
    assert.deepEqual(again.sources, {});
    const listed = mgr.list();
    must(listed[0]).title = 'hacked again';
    assert.equal(must(mgr.active()).title, 'x');
  });

  it('ids are unique even for sessions started in the same millisecond', () => {
    const { mgr } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 30; i += 1) ids.add(mgr.start(`s${i}`).id);
    assert.equal(ids.size, 30);
  });

  it('list is newest first with the active session included; ties keep the later started first', () => {
    const { clock, mgr } = setup();
    const a = mgr.start('a');
    clock.advance(1000);
    const b = mgr.start('b');
    clock.advance(1000);
    const c = mgr.start('c');
    assert.deepEqual(
      mgr.list().map((s) => s.id),
      [c.id, b.id, a.id],
    );
    assert.equal(mgr.list()[0]?.status, 'active');
    const { mgr: m2 } = setup();
    const x = m2.start('x');
    const y = m2.start('y');
    assert.deepEqual(
      m2.list().map((s) => s.id),
      [y.id, x.id],
    );
  });

  it('start and stop bump the revision', () => {
    const { mgr } = setup();
    const r0 = mgr.revision;
    mgr.start('x');
    const r1 = mgr.revision;
    assert.ok(r1 > r0);
    mgr.stop();
    assert.ok(mgr.revision > r1);
    const r2 = mgr.revision;
    mgr.stop();
    assert.equal(mgr.revision, r2, 'a no-op stop is not a change');
  });
});

describe('SessionManager: rename and remove', () => {
  it('rename changes the title (cleaned) and reports success', () => {
    const { mgr } = setup();
    const s = mgr.start('old');
    assert.equal(mgr.rename(s.id, '  new\ttitle '), true);
    assert.equal(mgr.get(s.id)?.title, 'new title');
  });

  it('rename of an unknown id, or to an empty cleaned title, is refused and changes nothing', () => {
    const { mgr } = setup();
    const s = mgr.start('keep');
    const r = mgr.revision;
    assert.equal(mgr.rename('nope', 'x'), false);
    for (const empty of ['', '   ', '\u0000\n']) assert.equal(mgr.rename(s.id, empty), false, JSON.stringify(empty));
    assert.equal(mgr.rename(s.id, undefined as unknown as string), false);
    assert.equal(mgr.get(s.id)?.title, 'keep');
    assert.equal(mgr.revision, r);
  });

  it('renaming to the same title succeeds without a revision bump', () => {
    const { mgr } = setup();
    const s = mgr.start('same');
    const r = mgr.revision;
    assert.equal(mgr.rename(s.id, 'same'), true);
    assert.equal(mgr.revision, r);
  });

  it('a completed session can be renamed too', () => {
    const { mgr } = setup();
    const s = mgr.start('a');
    mgr.stop();
    assert.equal(mgr.rename(s.id, 'b'), true);
    assert.equal(mgr.get(s.id)?.title, 'b');
  });

  it('a renamed title is capped at 120', () => {
    const { mgr } = setup();
    const s = mgr.start('a');
    mgr.rename(s.id, 'y'.repeat(999));
    assert.equal(mgr.get(s.id)?.title.length, 120);
  });

  it('remove deletes a completed session; removing the active one also ends the activity', () => {
    const { mgr } = setup();
    const a = mgr.start('a');
    mgr.stop();
    const b = mgr.start('b');
    assert.equal(mgr.remove(a.id), true);
    assert.equal(mgr.get(a.id), undefined);
    assert.equal(mgr.remove(a.id), false);
    assert.equal(mgr.remove(b.id), true);
    assert.equal(mgr.active(), undefined);
    assert.equal(mgr.activeSessionId, undefined);
    mgr.record(event('/ws/a.ts'), true); // must not resurrect anything
    assert.deepEqual(mgr.list(), []);
  });
});

describe('SessionManager: record', () => {
  it('without an active session it is a no-op', () => {
    const { mgr } = setup();
    const r = mgr.revision;
    mgr.record(event('/ws/a.ts'), true);
    assert.equal(mgr.revision, r);
  });

  it('counts occurrences per source and links each file once, in first-seen order', () => {
    const { mgr } = setup();
    mgr.start('x');
    mgr.record(event('/ws/a.ts'), true);
    mgr.record(event('/ws/a.ts'), true);
    mgr.record(event('/ws/b.ts', { sourceType: 'external' }), true);
    mgr.record(event('/ws/a.ts', { sourceType: 'ai-agent' }), true);
    const s = must(mgr.active());
    assert.equal(s.activityCount, 4);
    assert.deepEqual(s.modifiedFiles, ['/ws/a.ts', '/ws/b.ts']);
    assert.deepEqual(s.sources, { developer: 2, external: 1, 'ai-agent': 1 });
  });

  it('isNewOccurrence=false only links the file: no count, no per-source total', () => {
    const { mgr } = setup();
    mgr.start('x');
    mgr.record(event('/ws/a.ts'), false);
    const s = must(mgr.active());
    assert.equal(s.activityCount, 0);
    assert.deepEqual(s.sources, {});
    assert.deepEqual(s.modifiedFiles, ['/ws/a.ts']);
  });

  it('an event that belongs to another session is ignored', () => {
    const { mgr } = setup();
    mgr.start('x');
    mgr.record(event('/ws/a.ts', { sessionId: 'someone-else' }), true);
    assert.equal(must(mgr.active()).activityCount, 0);
    mgr.record(event('/ws/a.ts', { sessionId: mgr.activeSessionId }), true);
    assert.equal(must(mgr.active()).activityCount, 1);
  });

  it('modifiedFiles is capped at 500 but the activity count keeps counting', () => {
    const { mgr } = setup();
    mgr.start('x');
    for (let i = 0; i < 600; i += 1) mgr.record(event(`/ws/f${i}.ts`), true);
    const s = must(mgr.active());
    assert.equal(s.modifiedFiles.length, 500);
    assert.equal(s.activityCount, 600);
    assert.equal(s.modifiedFiles[0], '/ws/f0.ts');
    assert.equal(s.modifiedFiles[499], '/ws/f499.ts');
  });

  it('a file seen again beyond the cap is not added and not counted twice as a file', () => {
    const { mgr } = setup();
    mgr.start('x');
    for (let i = 0; i < 520; i += 1) mgr.record(event(`/ws/f${i}.ts`), false);
    mgr.record(event('/ws/f3.ts'), true);
    assert.equal(must(mgr.active()).modifiedFiles.length, 500);
  });

  it('a revision bump happens only when something changed', () => {
    const { mgr } = setup();
    mgr.start('x');
    mgr.record(event('/ws/a.ts'), false);
    const r = mgr.revision;
    mgr.record(event('/ws/a.ts'), false);
    assert.equal(mgr.revision, r, 'same file, no occurrence: nothing to change');
    mgr.record(event('/ws/a.ts'), true);
    assert.ok(mgr.revision > r);
  });

  it('a new session starts with a clean file set (a file of the previous session is linked again)', () => {
    const { mgr } = setup();
    mgr.start('one');
    mgr.record(event('/ws/a.ts'), true);
    mgr.start('two');
    mgr.record(event('/ws/a.ts'), true);
    assert.deepEqual(must(mgr.active()).modifiedFiles, ['/ws/a.ts']);
    assert.equal(must(mgr.active()).activityCount, 1);
  });
});

describe('SessionManager: reattribute and renameFiles', () => {
  it('moves occurrences from one source to another, bounded by what the source has', () => {
    const { mgr } = setup();
    const s = mgr.start('x');
    mgr.record(event('/ws/a.ts', { sourceType: 'external' }), true);
    mgr.record(event('/ws/b.ts', { sourceType: 'external' }), true);
    assert.equal(mgr.reattribute(s.id, 'external', 'ai-agent', 1), true);
    assert.deepEqual(must(mgr.get(s.id)).sources, { external: 1, 'ai-agent': 1 });
    assert.equal(mgr.reattribute(s.id, 'external', 'git', 50), true);
    assert.deepEqual(must(mgr.get(s.id)).sources, { 'ai-agent': 1, git: 1 }, 'the emptied source is removed, not left at 0');
    assert.equal(must(mgr.get(s.id)).activityCount, 2, 'the total does not change');
  });

  it('refuses nonsense: unknown id, same source, zero or negative count, source that has nothing', () => {
    const { mgr } = setup();
    const s = mgr.start('x');
    mgr.record(event('/ws/a.ts', { sourceType: 'external' }), true);
    assert.equal(mgr.reattribute('nope', 'external', 'git', 1), false);
    assert.equal(mgr.reattribute(s.id, 'external', 'external', 1), false);
    assert.equal(mgr.reattribute(s.id, 'external', 'git', 0), false);
    assert.equal(mgr.reattribute(s.id, 'external', 'git', -2), false);
    assert.equal(mgr.reattribute(s.id, 'external', 'git', Number.NaN), false);
    assert.equal(mgr.reattribute(s.id, 'unknown', 'git', 1), false);
    assert.deepEqual(must(mgr.get(s.id)).sources, { external: 1 });
  });

  it('renameFiles re-keys files of every session, exact and below, not siblings', () => {
    const { mgr } = setup();
    const a = mgr.start('a');
    mgr.record(event('/ws/src/x.ts'), true);
    mgr.record(event('/ws/src2/y.ts'), true);
    mgr.stop();
    const b = mgr.start('b');
    mgr.record(event('/ws/src'), true);
    assert.equal(mgr.renameFiles('/ws/src', '/ws/lib'), 2);
    assert.deepEqual(must(mgr.get(a.id)).modifiedFiles, ['/ws/lib/x.ts', '/ws/src2/y.ts']);
    assert.deepEqual(must(mgr.get(b.id)).modifiedFiles, ['/ws/lib']);
    assert.equal(mgr.renameFiles('', '/x'), 0);
    assert.equal(mgr.renameFiles('/ws/lib', '/ws/lib'), 0);
  });

  it('after renameFiles the active session still recognises the new name as already linked', () => {
    const { mgr } = setup();
    mgr.start('a');
    mgr.record(event('/ws/old.ts'), true);
    mgr.renameFiles('/ws/old.ts', '/ws/new.ts');
    mgr.record(event('/ws/new.ts'), true);
    assert.deepEqual(must(mgr.active()).modifiedFiles, ['/ws/new.ts']);
  });
});

describe('SessionManager: load (a window closed without stopping a session)', () => {
  it('a session stored as active is loaded as completed, ended at its start when nothing better is known', () => {
    const { mgr } = setup();
    mgr.load([stored({ id: 's1', status: 'active', startedAt: T0 - 5000 })]);
    const s = must(mgr.get('s1'));
    assert.equal(s.status, 'completed');
    assert.equal(s.endedAt, T0 - 5000);
    assert.equal(mgr.active(), undefined);
    assert.equal(mgr.activeSessionId, undefined);
  });

  it('it ends at the last recorded event of the session when the lookup knows one, never before the start', () => {
    const { mgr } = setup();
    mgr.load(
      [stored({ id: 's1', status: 'active', startedAt: T0 - 5000 }), stored({ id: 's2', status: 'active', startedAt: T0 - 5000 }), stored({ id: 's3', status: 'paused', startedAt: T0 - 5000 })],
      (id) => (id === 's1' ? T0 - 1000 : id === 's2' ? T0 - 99_999 : undefined),
    );
    assert.equal(mgr.get('s1')?.endedAt, T0 - 1000);
    assert.equal(mgr.get('s2')?.endedAt, T0 - 5000, 'an event before the start cannot end it before it began');
    assert.equal(mgr.get('s3')?.endedAt, T0 - 5000);
    assert.equal(mgr.get('s3')?.status, 'completed');
  });

  it('a completed session keeps its own endedAt and is not asked about', () => {
    const { mgr } = setup();
    let asked = 0;
    mgr.load([stored({ id: 's1', status: 'completed', startedAt: T0 - 9000, endedAt: T0 - 4000 })], () => {
      asked += 1;
      return T0;
    });
    assert.equal(mgr.get('s1')?.endedAt, T0 - 4000);
    assert.equal(asked, 0);
  });

  it('replaces the content, drops duplicate ids (first wins), stamps this workspace id, and sorts oldest first internally', () => {
    const { mgr } = setup();
    mgr.start('transient');
    mgr.load([
      stored({ id: 's2', title: 'second', startedAt: T0 - 100 }),
      stored({ id: 's1', title: 'first', startedAt: T0 - 200, workspaceId: 'other-ws' }),
      stored({ id: 's1', title: 'duplicate', startedAt: T0 - 300 }),
    ]);
    assert.deepEqual(
      mgr.list().map((s) => s.title),
      ['second', 'first'],
    );
    assert.equal(mgr.get('s1')?.workspaceId, 'ws-1');
    assert.equal(mgr.active(), undefined, 'the previously active session is gone');
  });

  it('modifiedFiles of a loaded session are capped at 500', () => {
    const { mgr } = setup();
    mgr.load([stored({ id: 's1', modifiedFiles: Array.from({ length: 900 }, (_, i) => `/ws/f${i}.ts`) })]);
    assert.equal(must(mgr.get('s1')).modifiedFiles.length, 500);
  });

  it('is cut to the maximum, dropping the oldest completed sessions', () => {
    const { mgr } = setup(3);
    mgr.load(Array.from({ length: 6 }, (_, i) => stored({ id: `s${i}`, startedAt: T0 - (6 - i) * 1000 })));
    assert.deepEqual(
      mgr.list().map((s) => s.id),
      ['s5', 's4', 's3'],
    );
  });

  it('loaded input is copied (later changes to it do not leak in)', () => {
    const { mgr } = setup();
    const input = stored({ id: 's1', modifiedFiles: ['/ws/a.ts'] });
    mgr.load([input]);
    input.modifiedFiles.push('/ws/x.ts');
    input.title = 'changed';
    assert.deepEqual(must(mgr.get('s1')).modifiedFiles, ['/ws/a.ts']);
    assert.equal(must(mgr.get('s1')).title, 'Stored');
  });

  it('a new session after a load gets an id that does not clash with loaded ones', () => {
    const { clock, mgr } = setup();
    const id = `s${T0.toString(36)}`;
    mgr.load([stored({ id, startedAt: T0 - 1 })]);
    clock.set(T0);
    const s = mgr.start('new');
    assert.notEqual(s.id, id);
    assert.equal(mgr.list().length, 2);
  });
});

describe('SessionManager: caps, clear, clearCompleted', () => {
  it('keeps at most the maximum number of sessions (default 50), dropping the oldest completed first and never the active one', () => {
    const { clock, mgr } = setup();
    const first = mgr.start('first');
    for (let i = 0; i < 60; i += 1) {
      clock.advance(1000);
      mgr.start(`s${i}`);
    }
    const list = mgr.list();
    assert.equal(list.length, 50);
    assert.equal(list[0]?.status, 'active');
    assert.equal(mgr.get(first.id), undefined, 'the oldest is gone');
    assert.equal(list.filter((s) => s.status === 'active').length, 1);
  });

  it('a limit of 1 leaves exactly the active session', () => {
    const { clock, mgr } = setup(1);
    mgr.start('a');
    clock.advance(10);
    const b = mgr.start('b');
    assert.deepEqual(
      mgr.list().map((s) => s.id),
      [b.id],
    );
  });

  it('nonsense limits fall back to 50', () => {
    for (const bad of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { clock, mgr } = setup(bad);
      for (let i = 0; i < 55; i += 1) {
        clock.advance(10);
        mgr.start(`s${i}`);
      }
      assert.equal(mgr.list().length, 50, String(bad));
    }
  });

  it('clear removes everything including the active session', () => {
    const { mgr } = setup();
    mgr.start('a');
    mgr.stop();
    mgr.start('b');
    mgr.clear();
    assert.deepEqual(mgr.list(), []);
    assert.equal(mgr.active(), undefined);
    const r = mgr.revision;
    mgr.clear();
    assert.equal(mgr.revision, r, 'clearing nothing is not a change');
  });

  it('clearCompleted removes completed sessions and empties (but keeps) the active one, returning how many were removed', () => {
    const { mgr } = setup();
    mgr.start('old1');
    mgr.stop();
    mgr.start('old2');
    mgr.stop();
    const live = mgr.start('live');
    mgr.record(event('/ws/a.ts'), true);
    assert.equal(mgr.clearCompleted(), 2);
    const s = must(mgr.get(live.id));
    assert.equal(s.title, 'live');
    assert.equal(s.status, 'active');
    assert.equal(s.activityCount, 0);
    assert.deepEqual(s.modifiedFiles, []);
    assert.deepEqual(s.sources, {});
    assert.equal(mgr.list().length, 1);
    mgr.record(event('/ws/a.ts'), true);
    assert.deepEqual(must(mgr.active()).modifiedFiles, ['/ws/a.ts'], 'the active session still collects after a clear');
  });

  it('clearCompleted with nothing to clear is a no-op', () => {
    const { mgr } = setup();
    assert.equal(mgr.clearCompleted(), 0);
    mgr.start('live');
    const r = mgr.revision;
    assert.equal(mgr.clearCompleted(), 0);
    assert.equal(mgr.revision, r);
  });
});
