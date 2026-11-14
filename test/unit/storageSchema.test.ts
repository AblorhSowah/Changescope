import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DETECTION_METHODS, EVENT_TYPES, SESSION_STATUSES, SOURCE_TYPES } from '../../src/core/dashboard/protocol';
import { STORAGE_KEY, STORAGE_LIMITS, STORAGE_SCHEMA, deserialise, serialise } from '../../src/core/storage/schema';
import type { ActivityEvent, DevelopmentSession } from '../../src/core/types';
import { must } from '../support/fixtures';

const T0 = 1_700_000_000_000;

function event(o: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'e1',
    workspaceId: 'ws-1',
    filePath: '/ws/a.ts',
    eventType: 'modify',
    sourceType: 'external',
    detectionMethod: 'disk-write',
    confidence: 0.7,
    timestamp: T0,
    lastTimestamp: T0 + 10,
    count: 2,
    reviewStatus: 'unreviewed',
    ...o,
  };
}

function session(o: Partial<DevelopmentSession> = {}): DevelopmentSession {
  return {
    id: 's1',
    title: 'Work',
    workspaceId: 'ws-1',
    startedAt: T0,
    endedAt: T0 + 1000,
    status: 'completed',
    activityCount: 3,
    modifiedFiles: ['/ws/a.ts'],
    sources: { developer: 2, external: 1 },
    gitStart: { branch: 'main', commit: 'abc' },
    gitEnd: { branch: 'main' },
    ...o,
  };
}

function stored(events: unknown[], sessions: unknown[] = [], schema: unknown = STORAGE_SCHEMA): unknown {
  return { schema, savedAt: T0, events, sessions };
}

/** Everything goes through JSON, as a Memento would store it. */
const viaJson = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

describe('storage schema: constants and serialise', () => {
  it('schema 1 under the key fileShake.history', () => {
    assert.equal(STORAGE_SCHEMA, 1);
    assert.equal(STORAGE_KEY, 'fileShake.history');
    assert.deepEqual({ ...STORAGE_LIMITS }, { EVENTS: 5000, SESSIONS: 200, PATH: 4096, ID: 64, TEXT: 200 });
  });

  it('serialise writes { schema, savedAt, events, sessions } of plain data', () => {
    const out = serialise([event()], [session()], T0) as Record<string, unknown>;
    assert.equal(out['schema'], 1);
    assert.equal(out['savedAt'], T0);
    assert.deepEqual(Object.keys(out).sort(), ['events', 'savedAt', 'schema', 'sessions']);
    assert.ok(Array.isArray(out['events']) && Array.isArray(out['sessions']));
  });

  it('serialise copies: changing the source afterwards does not change what was serialised', () => {
    const e = event();
    const s = session();
    const out = serialise([e], [s], T0);
    e.count = 999;
    s.modifiedFiles.push('/ws/zzz.ts');
    s.sources['git'] = 5;
    if (s.gitStart) s.gitStart.branch = 'changed';
    const back = deserialise(viaJson(out));
    assert.equal(must(back.events[0]).count, 2);
    assert.deepEqual(must(back.sessions[0]).modifiedFiles, ['/ws/a.ts']);
    assert.deepEqual(must(back.sessions[0]).sources, { developer: 2, external: 1 });
    assert.equal(must(back.sessions[0]).gitStart?.branch, 'main');
  });

  it('the serialised value survives JSON unchanged (no undefined, NaN or functions that JSON would alter)', () => {
    const out = serialise([event(), event({ id: 'e2', sourceType: 'developer', reviewStatus: undefined })], [session()], T0);
    assert.deepEqual(viaJson(out), viaJson(viaJson(out)));
  });
});

describe('storage schema: round trip', () => {
  it('events and sessions of every source type, event type and method come back deeply equal', () => {
    const events: ActivityEvent[] = [];
    let n = 0;
    for (const sourceType of SOURCE_TYPES) {
      for (const eventType of EVENT_TYPES) {
        n += 1;
        events.push(
          event({
            id: `e${n}`,
            sourceType,
            eventType,
            detectionMethod: must(DETECTION_METHODS[n % DETECTION_METHODS.length]),
            ...(sourceType === 'developer' ? { reviewStatus: undefined } : { reviewStatus: n % 2 === 0 ? 'reviewed' : 'unreviewed' }),
            ...(n % 3 === 0 ? { sourceId: 'claude-code', sessionId: 's1' } : {}),
          }),
        );
      }
    }
    const sessions = SESSION_STATUSES.map((status, i) => session({ id: `s${i}`, status, ...(status === 'active' ? { endedAt: undefined } : {}) }));
    const cleaned = events.map((e) => {
      const c = { ...e };
      if (c.reviewStatus === undefined) delete c.reviewStatus;
      return c;
    });
    const cleanedSessions = sessions.map((s) => {
      const c = { ...s };
      if (c.endedAt === undefined) delete c.endedAt;
      return c;
    });
    const back = deserialise(viaJson(serialise(cleaned, cleanedSessions, T0)));
    assert.equal(back.recovered, 0);
    assert.deepEqual(back.events, cleaned);
    assert.deepEqual(back.sessions, cleanedSessions);
  });

  it('empty history round trips to empty', () => {
    assert.deepEqual(deserialise(viaJson(serialise([], [], T0))), { events: [], sessions: [], recovered: 0 });
  });

  it('a session without git context or end time round trips without gaining fields', () => {
    const s = session();
    delete s.gitStart;
    delete s.gitEnd;
    delete s.endedAt;
    const back = must(deserialise(viaJson(serialise([], [s], T0))).sessions[0]);
    assert.equal('gitStart' in back, false);
    assert.equal('gitEnd' in back, false);
    assert.equal('endedAt' in back, false);
  });

  it('unicode, quotes and long-but-allowed strings survive', () => {
    const path = `/ws/日本語/😀/"quoted"/${'x'.repeat(4000)}.ts`;
    assert.ok(path.length <= STORAGE_LIMITS.PATH);
    const back = deserialise(viaJson(serialise([event({ filePath: path })], [session({ title: '<b>"é" 😀</b>' })], T0)));
    assert.equal(must(back.events[0]).filePath, path);
    assert.equal(must(back.sessions[0]).title, '<b>"é" 😀</b>');
  });

  it('is stable: serialising what was read gives the same thing again', () => {
    const first = deserialise(viaJson(serialise([event()], [session()], T0)));
    const second = deserialise(viaJson(serialise(first.events, first.sessions, T0)));
    assert.deepEqual(second, first);
  });
});

describe('storage schema: unknown, missing and wrong schema', () => {
  const empty = { events: [], sessions: [], recovered: 0 };
  const good = [event()];

  it('missing schema gives an empty history', () => {
    assert.deepEqual(deserialise({ savedAt: T0, events: good, sessions: [] }), empty);
  });

  it('a newer schema gives an empty history (never guess at a future format)', () => {
    for (const schema of [2, 3, 99, 1e9]) assert.deepEqual(deserialise(stored(good, [], schema)), empty, String(schema));
  });

  it('schema 0 and negative numbers: no migration exists, so empty', () => {
    for (const schema of [0, -1, -1e9]) assert.deepEqual(deserialise(stored(good, [], schema)), empty, String(schema));
  });

  it('a schema of the wrong type gives an empty history', () => {
    for (const schema of ['1', null, true, [], {}, Number.NaN, 1.5]) assert.deepEqual(deserialise(stored(good, [], schema)), empty, String(schema));
  });

  it('not an object at all gives an empty history', () => {
    for (const raw of [undefined, null, 0, 1, 'text', true, [], [1, 2], () => 1, Symbol('x'), 10n]) assert.deepEqual(deserialise(raw), empty, String(typeof raw));
  });

  it('events and sessions that are not arrays are treated as empty (the file still loads)', () => {
    const out = deserialise({ schema: 1, events: 'nope', sessions: { a: 1 } });
    assert.deepEqual(out.events, []);
    assert.deepEqual(out.sessions, []);
  });

  it('missing events or sessions keys are fine', () => {
    assert.deepEqual(deserialise({ schema: 1 }), empty);
    assert.equal(deserialise({ schema: 1, events: good }).events.length, 1);
  });
});

describe('storage schema: every kind of corrupt event is dropped and counted', () => {
  const corrupt: Array<[string, (e: Record<string, unknown>) => void]> = [
    ['missing id', (e) => delete e['id']],
    ['empty id', (e) => (e['id'] = '')],
    ['id too long', (e) => (e['id'] = 'e'.repeat(65))],
    ['id of the wrong type', (e) => (e['id'] = 7)],
    ['missing workspaceId', (e) => delete e['workspaceId']],
    ['empty workspaceId', (e) => (e['workspaceId'] = '')],
    ['workspaceId too long', (e) => (e['workspaceId'] = 'w'.repeat(201))],
    ['missing filePath', (e) => delete e['filePath']],
    ['empty filePath', (e) => (e['filePath'] = '')],
    ['filePath over the limit', (e) => (e['filePath'] = 'p'.repeat(4097))],
    ['filePath not a string', (e) => (e['filePath'] = ['/ws/a.ts'])],
    ['unknown eventType', (e) => (e['eventType'] = 'rename')],
    ['eventType of the wrong type', (e) => (e['eventType'] = 1)],
    ['unknown sourceType', (e) => (e['sourceType'] = 'claude')],
    ['missing sourceType', (e) => delete e['sourceType']],
    ['unknown detectionMethod', (e) => (e['detectionMethod'] = 'magic')],
    ['confidence above 1', (e) => (e['confidence'] = 1.01)],
    ['confidence below 0', (e) => (e['confidence'] = -0.01)],
    ['confidence NaN (as null after JSON)', (e) => (e['confidence'] = null)],
    ['confidence a string', (e) => (e['confidence'] = '0.5')],
    ['timestamp missing', (e) => delete e['timestamp']],
    ['timestamp negative', (e) => (e['timestamp'] = -1)],
    ['timestamp a string', (e) => (e['timestamp'] = '1700000000000')],
    ['timestamp null (NaN after JSON)', (e) => (e['timestamp'] = null)],
    ['lastTimestamp before timestamp', (e) => (e['lastTimestamp'] = T0 - 1)],
    ['lastTimestamp missing', (e) => delete e['lastTimestamp']],
    ['count zero', (e) => (e['count'] = 0)],
    ['count negative', (e) => (e['count'] = -3)],
    ['count fractional', (e) => (e['count'] = 1.5)],
    ['count not a safe integer', (e) => (e['count'] = 2 ** 60)],
    ['count a string', (e) => (e['count'] = '2')],
    ['sessionId of the wrong type', (e) => (e['sessionId'] = 5)],
    ['sessionId empty', (e) => (e['sessionId'] = '')],
    ['sessionId null', (e) => (e['sessionId'] = null)],
    ['sourceId empty', (e) => (e['sourceId'] = '')],
    ['sourceId too long', (e) => (e['sourceId'] = 's'.repeat(201))],
    ['sourceId of the wrong type', (e) => (e['sourceId'] = {})],
    ['reviewStatus unknown', (e) => (e['reviewStatus'] = 'maybe')],
    ['reviewStatus null', (e) => (e['reviewStatus'] = null)],
  ];

  for (const [name, mutate] of corrupt) {
    it(name, () => {
      const bad = viaJson(event()) as Record<string, unknown>;
      mutate(bad);
      const out = deserialise(stored([event({ id: 'e0' }), bad, event({ id: 'e2' })]));
      assert.deepEqual(
        out.events.map((e) => e.id),
        ['e0', 'e2'],
        'the two good events survive, in order',
      );
      assert.equal(out.recovered, 1);
    });
  }

  it('records that are not objects are dropped and counted: null, numbers, strings, arrays', () => {
    const out = deserialise(stored([null, 7, 'event', [], [event()], undefined, event()]));
    assert.equal(out.events.length, 1);
    assert.equal(out.recovered, 6);
  });

  it('the count of dropped records adds up over events and sessions', () => {
    const out = deserialise(stored([{ id: 'x' }, event()], [{ id: 'y' }, session(), 5]));
    assert.equal(out.events.length, 1);
    assert.equal(out.sessions.length, 1);
    assert.equal(out.recovered, 3);
  });

  it('a developer event keeps no review state whatever was stored; a non-developer event always has one', () => {
    const out = deserialise(stored([event({ id: 'e1', sourceType: 'developer', reviewStatus: 'reviewed' }), event({ id: 'e2', sourceType: 'external', reviewStatus: undefined })]));
    assert.equal(out.recovered, 0);
    assert.equal('reviewStatus' in must(out.events[0]), false);
    assert.equal(must(out.events[1]).reviewStatus, 'unreviewed');
  });

  it('unknown extra fields on a record are not carried over', () => {
    const e = { ...event(), secret: 'x', __proto__: { polluted: true }, extra: { deep: 1 } };
    const out = deserialise(stored([JSON.parse(JSON.stringify(e)) as unknown]));
    assert.deepEqual(Object.keys(must(out.events[0])).sort(), ['confidence', 'count', 'detectionMethod', 'eventType', 'filePath', 'id', 'lastTimestamp', 'reviewStatus', 'sourceType', 'timestamp', 'workspaceId']);
  });

  it('the boundary values that are allowed are accepted: confidence 0 and 1, timestamp 0, count 1, id and path at their limits', () => {
    const edges = [
      event({ id: 'a', confidence: 0 }),
      event({ id: 'b', confidence: 1 }),
      event({ id: 'c', timestamp: 0, lastTimestamp: 0 }),
      event({ id: 'd', count: 1 }),
      event({ id: 'i'.repeat(64) }),
      event({ id: 'p', filePath: 'f'.repeat(4096) }),
      event({ id: 't', timestamp: T0, lastTimestamp: T0 }),
    ];
    const out = deserialise(stored(edges));
    assert.equal(out.recovered, 0);
    assert.equal(out.events.length, edges.length);
  });
});

describe('storage schema: every kind of corrupt session is dropped and counted', () => {
  const corrupt: Array<[string, (s: Record<string, unknown>) => void]> = [
    ['missing id', (s) => delete s['id']],
    ['empty title', (s) => (s['title'] = '')],
    ['title over the limit', (s) => (s['title'] = 't'.repeat(201))],
    ['title of the wrong type', (s) => (s['title'] = 5)],
    ['missing workspaceId', (s) => delete s['workspaceId']],
    ['startedAt negative', (s) => (s['startedAt'] = -5)],
    ['startedAt missing', (s) => delete s['startedAt']],
    ['startedAt a string', (s) => (s['startedAt'] = 'now')],
    ['unknown status', (s) => (s['status'] = 'running')],
    ['activityCount negative', (s) => (s['activityCount'] = -1)],
    ['activityCount fractional', (s) => (s['activityCount'] = 0.5)],
    ['activityCount a string', (s) => (s['activityCount'] = '3')],
    ['modifiedFiles not an array', (s) => (s['modifiedFiles'] = '/ws/a.ts')],
    ['modifiedFiles over 500', (s) => (s['modifiedFiles'] = Array.from({ length: 501 }, (_, i) => `/ws/f${i}`))],
    ['modifiedFiles with a non-string', (s) => (s['modifiedFiles'] = ['/ws/a.ts', 5])],
    ['modifiedFiles with an empty path', (s) => (s['modifiedFiles'] = [''])],
    ['modifiedFiles with a path over the limit', (s) => (s['modifiedFiles'] = ['p'.repeat(4097)])],
    ['sources missing', (s) => delete s['sources']],
    ['sources an array', (s) => (s['sources'] = [1, 2])],
    ['sources with a negative count', (s) => (s['sources'] = { developer: -1 })],
    ['sources with a fractional count', (s) => (s['sources'] = { developer: 1.5 })],
    ['sources with a string count', (s) => (s['sources'] = { developer: '2' })],
    ['endedAt before startedAt', (s) => (s['endedAt'] = T0 - 1)],
    ['endedAt a string', (s) => (s['endedAt'] = 'later')],
    ['endedAt null', (s) => (s['endedAt'] = null)],
    ['gitStart not an object', (s) => (s['gitStart'] = 'main')],
    ['gitStart null', (s) => (s['gitStart'] = null)],
    ['gitStart branch of the wrong type', (s) => (s['gitStart'] = { branch: 7 })],
    ['gitStart commit empty', (s) => (s['gitStart'] = { commit: '' })],
    ['gitEnd branch too long', (s) => (s['gitEnd'] = { branch: 'b'.repeat(201) })],
  ];

  for (const [name, mutate] of corrupt) {
    it(name, () => {
      const bad = viaJson(session()) as Record<string, unknown>;
      mutate(bad);
      const out = deserialise(stored([], [session({ id: 's0' }), bad, session({ id: 's2' })]));
      assert.deepEqual(
        out.sessions.map((s) => s.id),
        ['s0', 's2'],
      );
      assert.equal(out.recovered, 1);
    });
  }

  it('an empty sources object, unknown source keys and a zero count are normalised', () => {
    const out = deserialise(stored([], [{ ...viaJson(session()) as object, sources: { developer: 0, robot: 4, external: 2 } }]));
    assert.equal(out.recovered, 0);
    assert.deepEqual(must(out.sessions[0]).sources, { external: 2 });
  });

  it('allowed boundaries: 500 files, 200-character title, activityCount 0, endedAt equal to startedAt', () => {
    const edge = session({ title: 't'.repeat(200), modifiedFiles: Array.from({ length: 500 }, (_, i) => `/ws/f${i}`), activityCount: 0, endedAt: T0 });
    const out = deserialise(stored([], [edge]));
    assert.equal(out.recovered, 0);
    assert.equal(out.sessions.length, 1);
  });

  it('all three statuses are accepted as stored (the SessionManager turns active into completed on load)', () => {
    const out = deserialise(stored([], SESSION_STATUSES.map((status, i) => session({ id: `s${i}`, status }))));
    assert.deepEqual(
      out.sessions.map((s) => s.status),
      [...SESSION_STATUSES],
    );
  });
});

describe('storage schema: hard bounds on what is read back', () => {
  it('more than 5000 events: the NEWEST 5000 are kept and every skipped record is counted', () => {
    const many = Array.from({ length: 5003 }, (_, i) => event({ id: `e${i.toString(36)}`, filePath: `/ws/f${i}.ts` }));
    const out = deserialise(stored(many));
    assert.equal(out.events.length, 5000);
    assert.equal(out.recovered, 3);
    assert.equal(must(out.events[0]).filePath, '/ws/f3.ts');
    assert.equal(must(out.events[4999]).filePath, '/ws/f5002.ts');
  });

  it('more than 200 sessions: the newest 200 are kept', () => {
    const many = Array.from({ length: 205 }, (_, i) => session({ id: `s${i}` }));
    const out = deserialise(stored([], many));
    assert.equal(out.sessions.length, 200);
    assert.equal(out.recovered, 5);
    assert.equal(must(out.sessions[0]).id, 's5');
  });

  it('exactly 5000 events and 200 sessions lose nothing', () => {
    const out = deserialise(stored(Array.from({ length: 5000 }, (_, i) => event({ id: `e${i}` })), Array.from({ length: 200 }, (_, i) => session({ id: `s${i}` }))));
    assert.equal(out.recovered, 0);
    assert.equal(out.events.length, 5000);
    assert.equal(out.sessions.length, 200);
  });
});

describe('storage schema: deserialise never throws', () => {
  it('a hostile object: throwing getters at every level', () => {
    const trap = (): never => {
      throw new Error('boom');
    };
    const top = {
      get schema(): number {
        return trap();
      },
    };
    const events = { schema: 1, get events(): unknown[] { return trap(); }, sessions: [] };
    const record = { schema: 1, events: [{ get id(): string { return trap(); } }], sessions: [] };
    const nested = { schema: 1, events: [], sessions: [{ id: 's', get sources(): object { return trap(); } }] };
    for (const raw of [top, events, record, nested]) assert.doesNotThrow(() => deserialise(raw));
    // a getter that throws loses the whole value, not the process
    assert.deepEqual(deserialise(top), { events: [], sessions: [], recovered: 0 });
  });

  it('a Proxy that throws on every trap', () => {
    const p = new Proxy({}, { get: () => { throw new Error('boom'); }, has: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => deserialise(p));
    assert.doesNotThrow(() => deserialise({ schema: 1, events: [p], sessions: [p] }));
  });

  it('cyclic structures', () => {
    const a: Record<string, unknown> = { schema: 1, events: [], sessions: [] };
    a['self'] = a;
    (a['events'] as unknown[]).push(a);
    (a['sessions'] as unknown[]).push(a);
    assert.doesNotThrow(() => deserialise(a));
    const out = deserialise(a);
    assert.equal(out.recovered, 2);
  });

  it('a very deep or very wide value', () => {
    let deep: unknown = {};
    for (let i = 0; i < 20_000; i += 1) deep = { next: deep };
    assert.doesNotThrow(() => deserialise({ schema: 1, events: [deep], sessions: [deep] }));
    assert.doesNotThrow(() => deserialise({ schema: 1, events: new Array(100_000).fill(null) }));
  });

  it('fuzz: 3000 random junk values never throw and never yield an invalid record', () => {
    let seed = 2024;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms: unknown[] = [null, undefined, true, false, 0, -1, 1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 60, '', 'a', 'e1', 'x'.repeat(5000), '/ws/a.ts', 'developer', 'modify', 'unreviewed', 'active', [], {}, [[]], { schema: 1 }];
    const junk = (depth: number): unknown => {
      const k = rnd(10);
      if (depth <= 0 || k < 5) return atoms[rnd(atoms.length)];
      if (k < 7) return Array.from({ length: rnd(4) }, () => junk(depth - 1));
      const o: Record<string, unknown> = {};
      const keys = ['id', 'workspaceId', 'filePath', 'eventType', 'sourceType', 'detectionMethod', 'confidence', 'timestamp', 'lastTimestamp', 'count', 'title', 'startedAt', 'status', 'activityCount', 'modifiedFiles', 'sources', 'gitStart', 'schema', 'events', 'sessions', 'reviewStatus', 'sessionId', 'sourceId', 'endedAt', 'developer', 'branch', 'commit'];
      for (let i = rnd(8); i > 0; i -= 1) o[keys[rnd(keys.length)] ?? 'id'] = junk(depth - 1);
      return o;
    };
    // half of the cases get a valid-looking envelope so the record validators are really exercised
    const envelope = (): unknown => ({ schema: 1, events: Array.from({ length: rnd(6) }, () => junk(3)), sessions: Array.from({ length: rnd(6) }, () => junk(3)) });
    for (let i = 0; i < 3000; i += 1) {
      const raw = i % 2 === 0 ? junk(4) : envelope();
      const out = deserialise(raw);
      assert.ok(Array.isArray(out.events) && Array.isArray(out.sessions) && Number.isInteger(out.recovered) && out.recovered >= 0);
      for (const e of out.events) {
        assert.ok(e.id.length > 0 && e.filePath.length > 0 && e.count >= 1 && e.confidence >= 0 && e.confidence <= 1 && e.lastTimestamp >= e.timestamp, JSON.stringify(e));
        assert.ok((SOURCE_TYPES as readonly string[]).includes(e.sourceType) && (EVENT_TYPES as readonly string[]).includes(e.eventType));
        assert.equal(e.sourceType === 'developer', e.reviewStatus === undefined);
      }
      for (const s of out.sessions) {
        assert.ok(s.id.length > 0 && s.title.length > 0 && s.activityCount >= 0 && s.modifiedFiles.length <= 500, JSON.stringify(s));
        assert.ok((SESSION_STATUSES as readonly string[]).includes(s.status));
        if (s.endedAt !== undefined) assert.ok(s.endedAt >= s.startedAt);
      }
    }
  });

  it('prototype pollution attempts are inert', () => {
    const raw = JSON.parse('{"schema":1,"__proto__":{"polluted":true},"events":[{"__proto__":{"polluted":true},"id":"e1"}],"sessions":[]}') as unknown;
    deserialise(raw);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});
