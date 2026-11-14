import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_PROTOCOL_VERSION, DASH_LIMITS, VIEW_MODES, cleanTitle, parseDashboardHostMessage, parseDashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import type { DashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import type { DashboardState } from '../../src/core/types';
import { activeRow, busyState, change, dashSession, dashState, dep, hostMessage, impact, manyRows, ref, repo, timelineItem } from '../support/dashState';
import { must } from '../support/fixtures';

type Json = Record<string, unknown>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A state in which every nullable field holds a value, so that every path can be mutated meaningfully. */
function maximal(): Json {
  const s = busyState({
    files: [activeRow('a.ts', 'src', { sourceId: 'claude-code', sessionTitle: 'S', review: 'unreviewed', impactLevel: 'high', dependants: 3 })],
    timeline: [timelineItem('a.ts', 'src', { sourceId: 'claude-code', sessionTitle: 'S' })],
    agents: [{ id: 'api', label: 'API', state: 'listening', detail: 'd' }],
    git: { state: 'ready', detail: 'd', repos: [repo('r', { staged: [change('a.ts', 'src')], unstaged: [change('b.ts', 'src', 'deleted')], untracked: [change('c.ts', 'src', 'untracked')] })] },
    sessions: { active: dashSession('s1', 'T', { branch: 'main' }), previous: [dashSession('s2', 'U', { status: 'completed', endedAt: 5, branch: 'dev' })] },
    selection: { file: ref('a.ts', 'src'), imports: [dep('b.ts', 'src')], importedBy: [dep('c.ts', 'src')], impact: impact('a.ts', 'src', { tests: [ref('t.ts', 'test')], configs: [ref('package.json')] }) },
    impacts: [impact('a.ts', 'src', { tests: [ref('t.ts', 'test')], configs: [ref('package.json')] })],
    settings: { aiProvider: 'acme.llm', aiMode: 'assisted' },
    summary: { text: 't', provider: 'local', at: 1 },
  });
  return clone(s) as unknown as Json;
}

const accepted = (state: unknown): boolean => parseDashboardHostMessage({ type: 'state', state }) !== null;

describe('parseDashboardHostMessage: valid states', () => {
  it('the protocol version is 1 and the limits are the documented ones', () => {
    assert.equal(DASHBOARD_PROTOCOL_VERSION, 1);
    assert.deepEqual({ ...DASH_LIMITS }, { FILES: 300, TIMELINE: 100, GIT_CHANGES: 200, REPOS: 20, SESSIONS: 50, DEPS: 200, IMPACTS: 50, IMPACT_FILES: 50, REASONS: 12, AGENTS: 12, STRING: 10_000, TITLE: 120, ERROR: 500 });
  });

  it('an empty state, a busy state and the maximal state are all accepted and come back deeply equal', () => {
    for (const state of [dashState(), busyState(), maximal() as unknown as DashboardState]) {
      const parsed = parseDashboardHostMessage(hostMessage(state));
      assert.ok(parsed);
      assert.deepEqual(clone(must(parsed).state), clone(state));
    }
  });

  it('returns a fresh object: the input is not aliased', () => {
    const input = hostMessage(busyState()) as { type: string; state: DashboardState };
    const parsed = must(parseDashboardHostMessage(input));
    assert.notEqual(parsed.state, input.state);
    assert.notEqual(parsed.state.files, input.state.files);
    input.state.files.length = 0;
    assert.ok(parsed.state.files.length > 0);
  });

  it('unknown fields are dropped at every level, and __proto__ keys do nothing', () => {
    const m = maximal();
    m['extra'] = 1;
    (m['settings'] as Json)['extra'] = { a: 1 };
    ((m['files'] as Json[])[0] as Json)['evil'] = '<script>';
    const raw = JSON.parse(JSON.stringify({ type: 'state', state: m, more: true }).replace('{"v":1', '{"__proto__":{"polluted":1},"v":1')) as unknown;
    const parsed = must(parseDashboardHostMessage(raw)).state as unknown as Json;
    assert.equal(parsed['extra'], undefined);
    assert.equal((parsed['settings'] as Json)['extra'], undefined);
    assert.equal(((parsed['files'] as Json[])[0] as Json)['evil'], undefined);
    assert.equal(({} as Json)['polluted'], undefined);
  });

  it('limits are inclusive: exactly 300 files, 100 timeline items, 12 agents, 20 repos, 50 sessions, 50 impacts are accepted', () => {
    const s = busyState({
      files: manyRows(300),
      timeline: Array.from({ length: 100 }, (_, i) => timelineItem(`f${i}.ts`, 'src', { id: `t${i}` })),
      agents: Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, label: 'A', state: 'off' as const, detail: '' })),
      git: { state: 'ready', repos: Array.from({ length: 20 }, (_, i) => repo(`r${i}`)) },
      sessions: { active: null, previous: Array.from({ length: 50 }, (_, i) => dashSession(`s${i}`, 'S', { status: 'completed', endedAt: 5 })) },
      impacts: Array.from({ length: 50 }, (_, i) => impact(`f${i}.ts`, 'src')),
    });
    assert.ok(accepted(clone(s)));
  });

  it('strings up to 10 000 characters are accepted, 10 001 are not', () => {
    const ok = maximal();
    ((ok['files'] as Json[])[0] as Json)['name'] = 'x'.repeat(10_000);
    assert.ok(accepted(ok));
    ((ok['files'] as Json[])[0] as Json)['name'] = 'x'.repeat(10_001);
    assert.equal(accepted(ok), false);
  });

  it('unit values at 0 and 1 and counts at 0 are accepted', () => {
    const m = maximal();
    const f = (m['files'] as Json[])[0] as Json;
    f['confidence'] = 0;
    f['intensity'] = 1;
    f['changes'] = 0;
    assert.ok(accepted(m));
  });

  it('the dashboard does not trust the other direction either: webview-to-host messages are not host messages', () => {
    assert.equal(parseDashboardHostMessage({ type: 'ready' }), null);
    assert.equal(parseDashboardHostMessage({ type: 'open', id: 'x' }), null);
  });
});

describe('parseDashboardHostMessage: envelope', () => {
  const good = (): Json => clone(maximal());

  it('not an object, wrong type, missing or non-object state, wrong version', () => {
    for (const raw of [undefined, null, 0, 'state', true, [], [1], () => 1, { type: 'state' }, { type: 'State', state: good() }, { type: 'snapshot', state: good() }, { state: good() }, { type: 'state', state: null }, { type: 'state', state: [] }, { type: 'state', state: 'x' }]) {
      assert.equal(parseDashboardHostMessage(raw), null, JSON.stringify(raw)?.slice(0, 60));
    }
    for (const v of [0, 2, '1', null, true, undefined, 1.0000001]) {
      const s = good();
      if (v === undefined) delete s['v'];
      else s['v'] = v;
      assert.equal(accepted(s), false, String(v));
    }
  });

  it('seq and now must be finite numbers', () => {
    for (const key of ['seq', 'now']) {
      for (const bad of [Number.NaN, Infinity, -Infinity, '5', null, true, {}, []]) {
        const s = good();
        s[key] = bad;
        assert.equal(accepted(s), false, `${key}=${String(bad)}`);
      }
    }
    // negative and fractional seq are numbers: the contract only says "number"
    const s = good();
    s['seq'] = -1;
    assert.ok(accepted(s));
  });

  it('every top-level key is required (deleting any makes the state invalid)', () => {
    for (const key of Object.keys(good())) {
      const s = good();
      delete s[key];
      assert.equal(accepted(s), false, `missing ${key}`);
    }
  });
});

/** Walks a JSON value and calls `visit` for every leaf and every array, with its path. */
function walk(value: unknown, path: Array<string | number>, visit: (path: Array<string | number>, v: unknown, kind: 'leaf' | 'array' | 'object') => void): void {
  if (Array.isArray(value)) {
    visit(path, value, 'array');
    if (value.length > 0) walk(value[0], [...path, 0], visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    visit(path, value, 'object');
    for (const [k, v] of Object.entries(value as Json)) walk(v, [...path, k], visit);
    return;
  }
  visit(path, value, 'leaf');
}

function setAt(root: Json, path: Array<string | number>, value: unknown): void {
  let cur: unknown = root;
  for (const p of path.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Json)[p as string];
  }
  if (cur === null || typeof cur !== 'object') return;
  const last = must(path[path.length - 1]);
  if (value === undefined) delete (cur as Json)[last as string];
  else (cur as Json)[last as string] = value;
}

const ENUM_KEYS = new Set(['source', 'method', 'lastEventType', 'phase', 'review', 'impactLevel', 'eventType', 'state', 'status', 'relationship', 'level', 'mode', 'aiMode']);
const COUNT_KEYS = new Set(['changes', 'dependants', 'count', 'ahead', 'behind', 'activityCount', 'fileCount', 'modifiedFiles', 'unreviewed', 'activeSessions', 'events', 'direct', 'indirect', 'indexed', 'total', 'animationIntensity', 'historyLimit', 'retentionDays']);
const UNIT_KEYS = new Set(['confidence', 'intensity']);
const BY_SOURCE = new Set(['developer', 'ai-agent', 'external', 'git', 'automated', 'unknown']);

describe('parseDashboardHostMessage: every field of the state, mutated to something invalid, is rejected', () => {
  const base = maximal();
  const leaves: Array<{ path: Array<string | number>; value: unknown }> = [];
  const arrays: Array<{ path: Array<string | number>; value: unknown[] }> = [];
  walk(base, [], (path, value, kind) => {
    if (path.length === 0) return;
    if (kind === 'leaf') leaves.push({ path, value });
    if (kind === 'array') arrays.push({ path, value: value as unknown[] });
  });
  const name = (path: Array<string | number>): string => path.join('.');

  it('the walk really reaches a large number of fields (so the test below is not vacuous)', () => {
    assert.ok(leaves.length > 120, `${leaves.length} leaves`);
    assert.ok(arrays.length >= 14, `${arrays.length} arrays`);
  });

  it('a missing field is rejected, for every leaf (a session\'s bySource is the one partial object: its keys are optional)', () => {
    for (const { path } of leaves) {
      if (path[0] === 'sessions' && path.includes('bySource')) continue;
      if (typeof path[path.length - 1] === 'number') continue; // deleting an array item leaves a hole: see QA-104
      const s = clone(base);
      setAt(s, path, undefined);
      assert.equal(accepted(s), false, `missing ${name(path)}`);
    }
  });

  it('a field of the wrong type is rejected, for every leaf', () => {
    for (const { path, value } of leaves) {
      const wrong: unknown[] =
        typeof value === 'string'
          ? [5, true, {}, [], ['x']]
          : typeof value === 'number'
            ? ['1', true, {}, [], Number.NaN, Infinity, -Infinity]
            : typeof value === 'boolean'
              ? ['true', 0, 1, {}, []]
              : [{}, [], 'x', true];
      for (const bad of wrong) {
        const s = clone(base);
        setAt(s, path, bad);
        assert.equal(accepted(s), false, `${name(path)} = ${JSON.stringify(bad)}`);
      }
      // null is only valid where the field is nullable: for a populated nullable field it IS valid, everywhere else not
    }
  });

  it('a non-nullable field set to null is rejected (null is only for the documented nullable fields)', () => {
    const nullable = new Set(['sourceId', 'sessionTitle', 'review', 'impactLevel', 'dependants', 'branch', 'commit', 'endedAt', 'aiProvider']);
    for (const { path } of leaves) {
      const key = String(path[path.length - 1]);
      const s = clone(base);
      setAt(s, path, null);
      const ok = nullable.has(key);
      assert.equal(accepted(s), ok, `${name(path)} = null should be ${ok ? 'accepted' : 'rejected'}`);
    }
  });

  it('unknown enum values are rejected: any string that is not one of the listed values', () => {
    let n = 0;
    for (const { path, value } of leaves) {
      const key = String(path[path.length - 1]);
      if (!ENUM_KEYS.has(key) || typeof value !== 'string') continue;
      for (const bad of ['bogus', '', ' ', value.toUpperCase() === value ? value.toLowerCase() : value.toUpperCase(), `${value} `, `${value}\u0000`]) {
        if (bad === value) continue;
        const s = clone(base);
        setAt(s, path, bad);
        assert.equal(accepted(s), false, `${name(path)} = ${JSON.stringify(bad)}`);
      }
      n += 1;
    }
    assert.ok(n >= 15, `${n} enum fields checked`);
  });

  it('counts must not be negative; confidence and intensity must be within 0..1', () => {
    let counts = 0;
    let units = 0;
    for (const { path, value } of leaves) {
      const key = String(path[path.length - 1]);
      const parent = String(path[path.length - 2]);
      if (typeof value !== 'number') continue;
      if (COUNT_KEYS.has(key) || (parent === 'bySource' && BY_SOURCE.has(key))) {
        const s = clone(base);
        setAt(s, path, -1);
        assert.equal(accepted(s), false, `${name(path)} = -1`);
        counts += 1;
      }
      if (UNIT_KEYS.has(key)) {
        for (const bad of [-0.001, 1.001, 2, -1]) {
          const s = clone(base);
          setAt(s, path, bad);
          assert.equal(accepted(s), false, `${name(path)} = ${bad}`);
        }
        units += 1;
      }
    }
    assert.ok(counts >= 20, `${counts} count fields`);
    assert.equal(units, 2, 'files[].confidence and files[].intensity');
  });

  it('every string longer than 10 000 characters is rejected, for every string leaf', () => {
    for (const { path, value } of leaves) {
      if (typeof value !== 'string') continue;
      const s = clone(base);
      setAt(s, path, 'y'.repeat(10_001));
      assert.equal(accepted(s), false, name(path));
    }
  });

  it('every array replaced by an object, a string or null is rejected', () => {
    for (const { path } of arrays) {
      for (const bad of [{}, 'abc', null, 5, { length: 1, 0: {} }]) {
        const s = clone(base);
        setAt(s, path, bad);
        assert.equal(accepted(s), false, `${name(path)} = ${JSON.stringify(bad)}`);
      }
    }
  });

  it('every array over its limit is rejected (and the same array at its limit is fine)', () => {
    const limits: Record<string, number> = {
      files: DASH_LIMITS.FILES,
      timeline: DASH_LIMITS.TIMELINE,
      agents: DASH_LIMITS.AGENTS,
      'git.repos': DASH_LIMITS.REPOS,
      'git.repos.0.staged': DASH_LIMITS.GIT_CHANGES,
      'git.repos.0.unstaged': DASH_LIMITS.GIT_CHANGES,
      'git.repos.0.untracked': DASH_LIMITS.GIT_CHANGES,
      'sessions.previous': DASH_LIMITS.SESSIONS,
      'selection.imports': DASH_LIMITS.DEPS,
      'selection.importedBy': DASH_LIMITS.DEPS,
      'selection.impact.reasons': DASH_LIMITS.REASONS,
      'selection.impact.affected': DASH_LIMITS.IMPACT_FILES,
      'selection.impact.tests': DASH_LIMITS.IMPACT_FILES,
      'selection.impact.configs': DASH_LIMITS.IMPACT_FILES,
      impacts: DASH_LIMITS.IMPACTS,
      'impacts.0.reasons': DASH_LIMITS.REASONS,
      'impacts.0.affected': DASH_LIMITS.IMPACT_FILES,
      'impacts.0.tests': DASH_LIMITS.IMPACT_FILES,
      'impacts.0.configs': DASH_LIMITS.IMPACT_FILES,
    };
    const covered = new Set<string>();
    for (const { path, value } of arrays) {
      const limit = limits[name(path)];
      if (limit === undefined) continue;
      covered.add(name(path));
      const item = must(value[0]);
      const atLimit = clone(base);
      setAt(atLimit, path, Array.from({ length: limit }, () => clone(item)));
      assert.ok(accepted(atLimit), `${name(path)} at ${limit}`);
      const over = clone(base);
      setAt(over, path, Array.from({ length: limit + 1 }, () => clone(item)));
      assert.equal(accepted(over), false, `${name(path)} at ${limit + 1}`);
    }
    assert.deepEqual([...covered].sort(), Object.keys(limits).sort(), 'every limited array was found in the maximal state');
  });

  it('an array element that is not an object is rejected (null, number, string, array, boolean)', () => {
    for (const { path } of arrays) {
      const key = name(path);
      if (key === 'selection.impact.reasons' || key === 'impacts.0.reasons') continue; // those are arrays of strings
      for (const bad of [null, 5, 'x', [], true]) {
        const s = clone(base);
        setAt(s, [...path, 0], bad);
        assert.equal(accepted(s), false, `${key}[0] = ${JSON.stringify(bad)}`);
      }
    }
    for (const bad of [null, 5, {}, [], true]) {
      const s = clone(base);
      setAt(s, ['impacts', 0, 'reasons', 0], bad);
      assert.equal(accepted(s), false, `reasons[0] = ${JSON.stringify(bad)}`);
    }
  });

  it('[QA-104] a sparse array (holes) cannot smuggle undefined items past the validator: every list of the state rejects it', () => {
    const lists: Array<Array<string | number>> = [['files'], ['timeline'], ['agents'], ['impacts'], ['git', 'repos'], ['git', 'repos', 0, 'staged'], ['git', 'repos', 0, 'unstaged'], ['git', 'repos', 0, 'untracked'], ['sessions', 'previous'], ['selection', 'imports'], ['selection', 'importedBy'], ['selection', 'impact', 'reasons'], ['selection', 'impact', 'affected'], ['selection', 'impact', 'tests'], ['selection', 'impact', 'configs'], ['impacts', 0, 'reasons']];
    for (const path of lists) {
      for (const holes of [new Array(1), new Array(3), (() => { const a: unknown[] = [undefined, undefined]; delete a[1]; return a; })()]) {
        const s = clone(base);
        setAt(s, path, holes);
        assert.equal(accepted(s), false, `${path.join('.')} with holes`);
      }
      // a list with a hole between two real items is rejected too, not only an all-hole list
      const first = (() => {
        let cur: unknown = base;
        for (const p of path) cur = (cur as Json)[p as string];
        return (cur as unknown[])[0];
      })();
      const mixed: unknown[] = [clone(first), clone(first), clone(first)];
      delete mixed[1];
      const t = clone(base);
      setAt(t, path, mixed);
      assert.equal(accepted(t), false, `${path.join('.')} with a hole between items`);
      // and an honest list of the same items is still fine
      const ok = clone(base);
      setAt(ok, path, [clone(first), clone(first)]);
      assert.equal(accepted(ok), true, `${path.join('.')} without holes`);
    }
  });
});

describe('parseDashboardHostMessage never throws', () => {
  const trap = (): never => {
    throw new Error('boom');
  };

  it('getters that throw at every level of a state', () => {
    const paths: Array<Array<string | number>> = [['seq'], ['settings'], ['settings', 'mode'], ['files'], ['files', 0], ['files', 0, 'name'], ['git', 'repos', 0, 'staged'], ['selection', 'impact', 'reasons'], ['sessions', 'active'], ['summary', 'text']];
    for (const path of paths) {
      const s = maximal();
      let cur: Json = s;
      for (const p of path.slice(0, -1)) cur = cur[p as string] as Json;
      Object.defineProperty(cur, must(path[path.length - 1]), { get: trap, enumerable: true, configurable: true });
      assert.doesNotThrow(() => parseDashboardHostMessage({ type: 'state', state: s }), path.join('.'));
      assert.equal(parseDashboardHostMessage({ type: 'state', state: s }), null, path.join('.'));
    }
    assert.doesNotThrow(() => parseDashboardHostMessage({ get type(): string { return trap(); } }));
    assert.equal(parseDashboardHostMessage({ type: 'state', get state(): unknown { return trap(); } }), null);
  });

  it('proxies that throw on every trap, and revoked proxies', () => {
    const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const raw of [hostile, revocable.proxy, { type: 'state', state: hostile }, { type: 'state', state: { ...maximal(), files: hostile } }]) {
      assert.doesNotThrow(() => parseDashboardHostMessage(raw));
      assert.equal(parseDashboardHostMessage(raw), null);
      assert.doesNotThrow(() => parseDashboardWebviewMessage(raw));
    }
  });

  it('cyclic structures', () => {
    const s = maximal();
    s['self'] = s;
    (s['files'] as unknown[])[0] = s;
    assert.equal(parseDashboardHostMessage({ type: 'state', state: s }), null);
    const m: Json = { type: 'open' };
    m['id'] = m;
    assert.equal(parseDashboardWebviewMessage(m), null);
    const loop: Json = { type: 'state' };
    loop['state'] = loop;
    assert.equal(parseDashboardHostMessage(loop), null);
  });

  it('absurdly deep and absurdly wide values', () => {
    let deep: unknown = {};
    for (let i = 0; i < 50_000; i += 1) deep = { next: deep };
    assert.doesNotThrow(() => parseDashboardHostMessage({ type: 'state', state: deep }));
    assert.doesNotThrow(() => parseDashboardWebviewMessage({ type: 'open', id: deep }));
    const s = maximal();
    s['files'] = new Array(10_000_000);
    assert.equal(parseDashboardHostMessage({ type: 'state', state: s }), null, 'an over-limit array is rejected before it is walked');
  });

  it('fuzz: 4000 mutated copies of a valid state never throw; if accepted, the result is again accepted (idempotent)', () => {
    let seed = 777;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const junk: unknown[] = [null, undefined, 0, -1, 1, 0.5, Number.NaN, Infinity, '', 'x', 'live', 'developer', true, false, {}, [], [{}], { a: 1 }, 'z'.repeat(10_001)];
    const base = maximal();
    const paths: Array<Array<string | number>> = [];
    walk(base, [], (p, _v, kind) => {
      if (p.length > 0 && kind !== 'object') paths.push(p);
    });
    let accepted_ = 0;
    for (let i = 0; i < 4000; i += 1) {
      const s = clone(base);
      for (let k = 1 + rnd(3); k > 0; k -= 1) setAt(s, must(paths[rnd(paths.length)]), junk[rnd(junk.length)]);
      const out = parseDashboardHostMessage({ type: 'state', state: s });
      if (out !== null) {
        accepted_ += 1;
        assert.ok(parseDashboardHostMessage(clone(out)), 'an accepted state re-validates');
      }
    }
    assert.ok(accepted_ >= 0);
  });
});

describe('parseDashboardWebviewMessage: valid messages', () => {
  const valid: Array<[string, unknown, DashboardWebviewMessage]> = [
    ['ready', { type: 'ready' }, { type: 'ready' }],
    ['markAllReviewed', { type: 'markAllReviewed' }, { type: 'markAllReviewed' }],
    ['sessionStop', { type: 'sessionStop' }, { type: 'sessionStop' }],
    ['clearHistory', { type: 'clearHistory' }, { type: 'clearHistory' }],
    ['openSettings', { type: 'openSettings' }, { type: 'openSettings' }],
    ['summarize', { type: 'summarize' }, { type: 'summarize' }],
    ['open', { type: 'open', id: '/ws/a.ts' }, { type: 'open', id: '/ws/a.ts' }],
    ['openDiff', { type: 'openDiff', id: '/ws/a.ts' }, { type: 'openDiff', id: '/ws/a.ts' }],
    ['select', { type: 'select', id: '/ws/a.ts' }, { type: 'select', id: '/ws/a.ts' }],
    ['markReviewed', { type: 'markReviewed', id: '/ws/a.ts' }, { type: 'markReviewed', id: '/ws/a.ts' }],
    ['sessionExport', { type: 'sessionExport', id: 's1' }, { type: 'sessionExport', id: 's1' }],
    ['setMode live', { type: 'setMode', mode: 'live' }, { type: 'setMode', mode: 'live' }],
    ['setMode compact', { type: 'setMode', mode: 'compact' }, { type: 'setMode', mode: 'compact' }],
    ['setMode impact', { type: 'setMode', mode: 'impact' }, { type: 'setMode', mode: 'impact' }],
    ['setAnimate true', { type: 'setAnimate', value: true }, { type: 'setAnimate', value: true }],
    ['setAnimate false', { type: 'setAnimate', value: false }, { type: 'setAnimate', value: false }],
    ['setPaused true', { type: 'setPaused', value: true }, { type: 'setPaused', value: true }],
    ['setPaused false', { type: 'setPaused', value: false }, { type: 'setPaused', value: false }],
    ['sessionStart', { type: 'sessionStart', title: 'Refactor' }, { type: 'sessionStart', title: 'Refactor' }],
    ['sessionStart empty', { type: 'sessionStart', title: '' }, { type: 'sessionStart', title: '' }],
    ['sessionRename', { type: 'sessionRename', id: 's1', title: 'New' }, { type: 'sessionRename', id: 's1', title: 'New' }],
    ['error', { type: 'error', message: 'boom' }, { type: 'error', message: 'boom' }],
  ];

  for (const [name, raw, want] of valid) it(name, () => assert.deepEqual(parseDashboardWebviewMessage(raw), want));

  it('every one of the 17 message types is covered above', () => {
    const types = new Set(valid.map(([, , m]) => m.type));
    assert.equal(types.size, 17);
  });

  it('the result is a fresh object that carries only the documented fields', () => {
    const input = { type: 'open', id: '/ws/a.ts', path: '/etc/passwd', command: 'rm -rf', uri: 'file:///etc/passwd', setting: 'x' };
    const out = must(parseDashboardWebviewMessage(input));
    assert.deepEqual(out, { type: 'open', id: '/ws/a.ts' });
    assert.notEqual(out, input);
  });

  it('a setMode value for every view mode that exists is accepted, nothing else', () => {
    for (const mode of VIEW_MODES) assert.ok(parseDashboardWebviewMessage({ type: 'setMode', mode }));
    assert.equal(VIEW_MODES.length, 3);
  });
});

describe('parseDashboardWebviewMessage: invalid messages are rejected', () => {
  const reject = (raw: unknown, why: string): void => assert.equal(parseDashboardWebviewMessage(raw), null, why);

  it('not an object, no type, unknown type, wrong-case type', () => {
    for (const raw of [undefined, null, 0, 'ready', true, [], [{ type: 'ready' }], () => 1, {}, { type: 5 }, { type: null }, { type: 'Ready' }, { type: 'READY' }, { type: ' ready' }, { type: 'ready ' }, { type: 'snapshot' }, { type: 'state' }, { type: 'rm -rf' }, { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' }, { type: ['ready'] }]) {
      reject(raw, JSON.stringify(raw) ?? String(raw));
    }
  });

  it('id messages need a string id of at most 10 000 characters', () => {
    for (const type of ['open', 'openDiff', 'select', 'markReviewed', 'sessionExport']) {
      for (const id of [undefined, null, 5, true, {}, [], ['/ws/a.ts'], 'x'.repeat(10_001)]) {
        reject(id === undefined ? { type } : { type, id }, `${type} id=${JSON.stringify(id)?.slice(0, 20)}`);
      }
      assert.ok(parseDashboardWebviewMessage({ type, id: 'x'.repeat(10_000) }), `${type} at the limit`);
    }
  });

  it('setMode: unknown, wrong-case, non-string and missing modes', () => {
    for (const mode of ['LIVE', 'Live', 'full', '', ' live', 'live ', 'compact\n', 5, null, undefined, {}, ['live'], true]) {
      reject(mode === undefined ? { type: 'setMode' } : { type: 'setMode', mode }, `mode=${JSON.stringify(mode)}`);
    }
  });

  it('setAnimate and setPaused need a real boolean', () => {
    for (const type of ['setAnimate', 'setPaused']) {
      for (const value of ['true', 'false', 0, 1, null, undefined, {}, [], [true], 'yes']) {
        reject(value === undefined ? { type } : { type, value }, `${type} value=${JSON.stringify(value)}`);
      }
    }
  });

  it('sessionStart needs a string title (it may be empty)', () => {
    for (const title of [undefined, null, 5, true, {}, [], ['a'], 'x'.repeat(10_001)]) {
      reject(title === undefined ? { type: 'sessionStart' } : { type: 'sessionStart', title }, `title=${JSON.stringify(title)?.slice(0, 20)}`);
    }
  });

  it('sessionRename needs a string id and a title that is not empty once cleaned', () => {
    for (const id of [undefined, null, 5, {}]) reject(id === undefined ? { type: 'sessionRename', title: 'x' } : { type: 'sessionRename', id, title: 'x' }, `id=${String(id)}`);
    for (const title of [undefined, null, 5, {}, '', '   ', '\t\n', '\u0000', '\u0001\u0002 \u007f', ' \u0000 \n ']) {
      reject(title === undefined ? { type: 'sessionRename', id: 's1' } : { type: 'sessionRename', id: 's1', title }, `title=${JSON.stringify(title)}`);
    }
    assert.ok(parseDashboardWebviewMessage({ type: 'sessionRename', id: 's1', title: ' a ' }));
  });

  it('error needs a string message', () => {
    for (const message of [undefined, null, 5, {}, [], ['x'], true]) reject(message === undefined ? { type: 'error' } : { type: 'error', message }, `message=${JSON.stringify(message)}`);
  });
});

describe('parseDashboardWebviewMessage: titles and error text', () => {
  it('cleanTitle removes control characters, collapses whitespace, trims and caps at 120', () => {
    assert.equal(cleanTitle('  hello \t world\n'), 'hello world');
    assert.equal(cleanTitle('a\u0000b\u0001c\u007fd'), 'a b c d');
    assert.equal(cleanTitle('a\r\nb'), 'a b');
    assert.equal(cleanTitle('x'.repeat(121)).length, 120);
    assert.equal(cleanTitle('x'.repeat(120)).length, 120);
    assert.equal(cleanTitle(`${' '.repeat(200)}x`), 'x', 'trimmed before the cap');
    assert.equal(cleanTitle(''), '');
    assert.equal(cleanTitle('\u0000'), '');
  });

  it('[QA-106] C1 control characters (U+0080 to U+009F, category Cc) are removed from titles like the C0 ones', () => {
    assert.equal(cleanTitle('a\u0085b\u0090c\u009fd'), 'a b c d');
    for (let code = 0x80; code <= 0x9f; code += 1) assert.equal(cleanTitle(`x${String.fromCharCode(code)}y`), 'x y', `U+${code.toString(16)}`);
    assert.equal(cleanTitle('a\u00a0b'), 'a b', 'the no-break space (U+00A0) is whitespace and collapses');
    assert.equal(cleanTitle('caf\u00e9 \u00ff \u0100'), 'caf\u00e9 \u00ff \u0100', 'letters just above the C1 block are untouched');
    assert.equal(parseDashboardWebviewMessage({ type: 'sessionStart', title: 'a\u0085b' }) !== null && (parseDashboardWebviewMessage({ type: 'sessionStart', title: 'a\u0085b' }) as { title: string }).title, 'a b');
    assert.equal(parseDashboardWebviewMessage({ type: 'sessionRename', id: 's', title: '\u0085\u0086' }), null, 'a title of only C1 controls is empty once cleaned');
  });

  it('the cap counts characters after cleaning, so leading control characters do not eat the budget', () => {
    assert.equal(cleanTitle(`${'\u0001'.repeat(300)}${'y'.repeat(50)}`), 'y'.repeat(50));
  });

  it('the cap never splits a surrogate pair into a lone surrogate', () => {
    const out = cleanTitle('😀'.repeat(100));
    for (let i = 0; i < out.length; i += 1) {
      const c = out.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) assert.ok(out.charCodeAt(i + 1) >= 0xdc00 && out.charCodeAt(i + 1) <= 0xdfff, `high surrogate at ${i} has no partner`);
    }
  });

  it('sessionStart and sessionRename titles are cleaned and capped on the way through', () => {
    assert.deepEqual(parseDashboardWebviewMessage({ type: 'sessionStart', title: '  a\u0000b\nc  ' }), { type: 'sessionStart', title: 'a b c' });
    assert.equal((must(parseDashboardWebviewMessage({ type: 'sessionStart', title: 'x'.repeat(5000) })) as { title: string }).title.length, 120);
    assert.deepEqual(parseDashboardWebviewMessage({ type: 'sessionRename', id: 's', title: '\u0007 new \u0007' }), { type: 'sessionRename', id: 's', title: 'new' });
    assert.equal((must(parseDashboardWebviewMessage({ type: 'sessionRename', id: 's', title: 'x'.repeat(5000) })) as { title: string }).title.length, 120);
  });

  it('a start title that cleans to nothing is allowed (the host names the session)', () => {
    assert.deepEqual(parseDashboardWebviewMessage({ type: 'sessionStart', title: ' \u0000 ' }), { type: 'sessionStart', title: '' });
  });

  it('error text is truncated to 500 characters, not rejected', () => {
    assert.equal((must(parseDashboardWebviewMessage({ type: 'error', message: 'e'.repeat(499) })) as { message: string }).message.length, 499);
    assert.equal((must(parseDashboardWebviewMessage({ type: 'error', message: 'e'.repeat(500) })) as { message: string }).message.length, 500);
    assert.equal((must(parseDashboardWebviewMessage({ type: 'error', message: 'e'.repeat(501) })) as { message: string }).message.length, 500);
    assert.equal((must(parseDashboardWebviewMessage({ type: 'error', message: 'e'.repeat(1_000_000) })) as { message: string }).message.length, 500);
    assert.equal((must(parseDashboardWebviewMessage({ type: 'error', message: '' })) as { message: string }).message, '');
  });

  it('hostile text in a title stays text (no stripping of markup: it is escaped where it is shown)', () => {
    const t = (must(parseDashboardWebviewMessage({ type: 'sessionStart', title: '<img src=x onerror=alert(1)>' })) as { title: string }).title;
    assert.equal(t, '<img src=x onerror=alert(1)>');
  });
});

describe('parseDashboardWebviewMessage never throws', () => {
  const trap = (): never => {
    throw new Error('boom');
  };

  it('a throwing getter on any field that its message type reads gives null, never an exception', () => {
    const reads: Record<string, string[]> = {
      open: ['id'],
      openDiff: ['id'],
      select: ['id'],
      markReviewed: ['id'],
      sessionExport: ['id'],
      setMode: ['mode'],
      setAnimate: ['value'],
      setPaused: ['value'],
      sessionStart: ['title'],
      sessionRename: ['id', 'title'],
      error: ['message'],
    };
    const valid: Record<string, Json> = {
      open: { id: 'a' },
      openDiff: { id: 'a' },
      select: { id: 'a' },
      markReviewed: { id: 'a' },
      sessionExport: { id: 'a' },
      setMode: { mode: 'live' },
      setAnimate: { value: true },
      setPaused: { value: true },
      sessionStart: { title: 't' },
      sessionRename: { id: 'a', title: 't' },
      error: { message: 'm' },
    };
    for (const [type, fields] of Object.entries(reads)) {
      for (const field of fields) {
        const m: Json = { type, ...valid[type] };
        Object.defineProperty(m, field, { get: trap, enumerable: true, configurable: true });
        assert.doesNotThrow(() => parseDashboardWebviewMessage(m), `${type}.${field}`);
        assert.equal(parseDashboardWebviewMessage(m), null, `${type}.${field}`);
      }
    }
    const t: Json = { id: 'a' };
    Object.defineProperty(t, 'type', { get: trap, enumerable: true });
    assert.equal(parseDashboardWebviewMessage(t), null);
  });

  it('a getter that returns a different value each time cannot make a validated message differ from what is returned', () => {
    let calls = 0;
    const m = {
      type: 'open',
      get id(): string {
        calls += 1;
        return calls === 1 ? '/ws/ok.ts' : '/etc/passwd';
      },
    };
    const out = must(parseDashboardWebviewMessage(m)) as { id: string };
    assert.equal(out.id, '/ws/ok.ts', 'the id that was checked is the id that is returned');
    assert.equal(calls, 1, 'the field is read exactly once');
  });

  it('[QA-105] the type that was validated is the type that is returned (the field is read once, not twice)', () => {
    let calls = 0;
    const m = {
      get type(): string {
        calls += 1;
        return calls === 1 ? 'ready' : 'open';
      },
      id: '/ws/a.ts',
    };
    const out = parseDashboardWebviewMessage(m);
    // either rejected, or exactly the message that was checked: never a type that was not validated
    assert.ok(out === null || out.type === 'ready', `got ${JSON.stringify(out)} after ${calls} reads of type`);
    assert.equal(calls, 1, 'type is read exactly once');
    // the same for every message type that carries other fields: flip the type on the second read
    for (const [first, second] of [['open', 'ready'], ['setMode', 'open'], ['sessionRename', 'sessionStop'], ['error', 'clearHistory'], ['setPaused', 'summarize']] as const) {
      let reads = 0;
      const flip = {
        get type(): string {
          reads += 1;
          return reads === 1 ? first : second;
        },
        id: 'x',
        mode: 'live',
        value: true,
        title: 't',
        message: 'm',
      };
      const got = parseDashboardWebviewMessage(flip);
      assert.ok(got === null || got.type === first, `${first}/${second}: got ${JSON.stringify(got)}`);
      assert.equal(reads, 1, `${first}: type read once`);
    }
  });

  it('fuzz: 4000 random values never throw and anything accepted is a known message type', () => {
    let seed = 31;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const types = ['ready', 'open', 'openDiff', 'select', 'setMode', 'setAnimate', 'setPaused', 'markReviewed', 'markAllReviewed', 'sessionStart', 'sessionStop', 'sessionRename', 'sessionExport', 'clearHistory', 'openSettings', 'summarize', 'error', 'x', ''];
    const vals: unknown[] = [null, undefined, 0, 1, -1, Number.NaN, '', 'a', 'live', true, false, {}, [], ['a'], 'x'.repeat(20_000), '\u0000', { type: 'ready' }];
    for (let i = 0; i < 4000; i += 1) {
      const m: Json = {};
      if (rnd(10) > 0) m['type'] = rnd(5) === 0 ? vals[rnd(vals.length)] : types[rnd(types.length)];
      for (const k of ['id', 'mode', 'value', 'title', 'message']) if (rnd(2) === 0) m[k] = vals[rnd(vals.length)];
      const out = parseDashboardWebviewMessage(m);
      if (out !== null) assert.ok(types.slice(0, 17).includes(out.type), out.type);
    }
  });
});
