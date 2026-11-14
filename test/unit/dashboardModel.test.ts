import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileActivity } from '../../src/core/activity/eventStore';
import { buildDashboardState, stateSignature } from '../../src/core/dashboard/model';
import type { DashboardInput, FileLiveState } from '../../src/core/dashboard/model';
import { DASH_LIMITS, SOURCE_TYPES, parseDashboardHostMessage } from '../../src/core/dashboard/protocol';
import type { RepoSnapshot } from '../../src/core/git/gitModel';
import type { DepEdge } from '../../src/core/intelligence/depGraph';
import { scaleShake, shakeParams } from '../../src/core/intensity';
import type { ActivityEvent, ActivitySourceType, ChangeImpact, DashSettings, DevelopmentSession, FileKey, WorkspaceRoot } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../support/dashState';
import { must } from '../support/fixtures';

const NOW = 1_700_000_000_000;
const ROOT = '/Users/dev/proj';
const ROOTS: WorkspaceRoot[] = [{ key: ROOT, name: 'proj' }];

const settings = (o: Partial<DashSettings> = {}): DashSettings => ({ ...DEFAULT_SETTINGS, ...o });

function activity(key: FileKey, o: Partial<FileActivity> = {}): FileActivity {
  return { key, sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9, lastEventType: 'modify', firstAt: NOW - 60_000, lastAt: NOW - 1000, changes: 1, review: undefined, exists: true, ...o };
}

function event(id: string, filePath: FileKey, o: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id, workspaceId: 'w', filePath, eventType: 'modify', sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9, timestamp: NOW - 2000, lastTimestamp: NOW - 1000, count: 1, ...o };
}

function session(id: string, o: Partial<DevelopmentSession> = {}): DevelopmentSession {
  return { id, title: id, workspaceId: 'w', startedAt: NOW - 100_000, status: 'completed', endedAt: NOW - 50_000, activityCount: 2, modifiedFiles: [`${ROOT}/a.ts`], sources: { developer: 2 }, ...o };
}

function impact(file: FileKey, o: Partial<ChangeImpact> = {}): ChangeImpact {
  return { filePath: file, directDependants: [], indirectDependants: [], affectedFiles: [], affectedTests: [], configFiles: [], impactLevel: 'low', reasons: ['No dependants were found.'], complete: true, analysedAt: NOW - 5000, ...o };
}

function repo(o: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return { root: ROOT, name: 'proj', branch: 'main', commit: 'abcdef0123456789', ahead: 1, behind: 2, staged: [], unstaged: [], untracked: [], truncated: false, ...o };
}

function input(o: Partial<DashboardInput> = {}): DashboardInput {
  return {
    now: NOW,
    seq: 1,
    enabled: true,
    roots: ROOTS,
    files: [],
    live: new Map(),
    events: [],
    eventCount: 0,
    unreviewed: 0,
    sessions: [],
    git: { state: 'ready', detail: '', repos: [] },
    selection: { file: undefined, imports: [], importedBy: [], impact: undefined },
    impacts: new Map(),
    index: { state: 'idle', indexed: 0, total: 0, truncated: false },
    settings: settings(),
    agents: [{ id: 'api', label: 'Extension API', state: 'listening', detail: '' }],
    summary: null,
    ...o,
  };
}

const wire = (s: unknown): unknown => ({ type: 'state', state: JSON.parse(JSON.stringify(s)) });
const accepted = (s: unknown): boolean => parseDashboardHostMessage(wire(s)) !== null;
const live = (...entries: Array<[FileKey, FileLiveState]>): Map<FileKey, FileLiveState> => new Map(entries);
const k = (n: string): FileKey => `${ROOT}/src/${n}.ts`;

describe('buildDashboardState: shape and pass-through', () => {
  it('an empty input gives a valid, empty state', () => {
    const s = buildDashboardState(input());
    assert.equal(s.v, 1);
    assert.equal(s.seq, 1);
    assert.equal(s.now, NOW);
    assert.equal(s.enabled, true);
    assert.deepEqual(s.files, []);
    assert.deepEqual(s.timeline, []);
    assert.deepEqual(s.impacts, []);
    assert.deepEqual(s.sessions, { active: null, previous: [] });
    assert.deepEqual(s.selection, { file: null, imports: [], importedBy: [], impact: null });
    assert.deepEqual(s.git, { state: 'ready', detail: '', repos: [] });
    assert.equal(s.summary, null);
    assert.deepEqual(s.overview, { modifiedFiles: 0, bySource: { developer: 0, 'ai-agent': 0, external: 0, git: 0, automated: 0, unknown: 0 }, unreviewed: 0, activeSessions: 0, events: 0 });
    assert.ok(accepted(s));
  });

  it('seq, now, enabled, settings, index, agents and summary are passed through', () => {
    const st = settings({ mode: 'impact', animate: false, paused: true, aiMode: 'assisted', aiProvider: 'acme.llm' });
    const s = buildDashboardState(
      input({
        seq: 77,
        now: NOW + 5,
        enabled: false,
        settings: st,
        index: { state: 'indexing', indexed: 340, total: 1200, truncated: false },
        agents: [{ id: 'signal-file', label: 'Agent signal file', state: 'off', detail: 'Turn it on.' }],
        summary: { text: 'Hello.', provider: 'local', at: NOW - 3 },
      }),
    );
    assert.equal(s.seq, 77);
    assert.equal(s.now, NOW + 5);
    assert.equal(s.enabled, false);
    assert.deepEqual(s.settings, st);
    assert.deepEqual(s.index, { state: 'indexing', indexed: 340, total: 1200, truncated: false });
    assert.deepEqual(s.agents, [{ id: 'signal-file', label: 'Agent signal file', state: 'off', detail: 'Turn it on.' }]);
    assert.deepEqual(s.summary, { text: 'Hello.', provider: 'local', at: NOW - 3 });
    assert.ok(accepted(s));
  });

  it('a non-finite now becomes 0 (the webview then shows "just now" instead of NaN)', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) assert.equal(buildDashboardState(input({ now: bad })).now, 0);
  });
});

describe('buildDashboardState: ordering (active first, then newest change)', () => {
  const files = [
    activity(k('idle-new'), { lastAt: NOW - 1000 }),
    activity(k('active-old'), { lastAt: NOW - 90_000 }),
    activity(k('idle-old'), { lastAt: NOW - 50_000 }),
    activity(k('active-new'), { lastAt: NOW - 500 }),
    activity(k('idle-mid'), { lastAt: NOW - 20_000 }),
  ];
  const lv = live([k('active-old'), { phase: 'active', intensity: 0.3 }], [k('active-new'), { phase: 'active', intensity: 0.9 }], [k('idle-mid'), { phase: 'idle', intensity: 0.8 }]);

  it('active files come first (even with an older change), then everything by lastAt descending', () => {
    const s = buildDashboardState(input({ files, live: lv }));
    assert.deepEqual(
      s.files.map((f) => f.name),
      ['active-new.ts', 'active-old.ts', 'idle-new.ts', 'idle-mid.ts', 'idle-old.ts'],
    );
  });

  it('a file whose live phase is idle is NOT promoted, and its intensity is reported as 0', () => {
    const s = buildDashboardState(input({ files, live: lv }));
    const mid = must(s.files.find((f) => f.name === 'idle-mid.ts'));
    assert.equal(mid.phase, 'idle');
    assert.equal(mid.intensity, 0);
    assert.deepEqual(mid.shake, { amp: 0, dur: shakeParams(0).dur, rot: 0 });
  });

  it('equal times keep the input order (a stable order, so rows do not jump between builds)', () => {
    const same = [activity(k('b'), { lastAt: NOW }), activity(k('a'), { lastAt: NOW }), activity(k('c'), { lastAt: NOW })];
    assert.deepEqual(
      buildDashboardState(input({ files: same })).files.map((f) => f.name),
      ['b.ts', 'a.ts', 'c.ts'],
    );
  });

  it('the order does not depend on the order of the input when times differ', () => {
    const shuffled = [files[3], files[1], files[4], files[0], files[2]] as FileActivity[];
    assert.deepEqual(
      buildDashboardState(input({ files: shuffled, live: lv })).files.map((f) => f.name),
      buildDashboardState(input({ files, live: lv })).files.map((f) => f.name),
    );
  });

  it('the 300 cap is applied AFTER ordering: an active file at the end of 500 is kept, the oldest idle ones are cut', () => {
    const many = Array.from({ length: 500 }, (_, i) => activity(k(`f${String(i).padStart(3, '0')}`), { lastAt: NOW - i * 1000 }));
    const s = buildDashboardState(input({ files: many, live: live([k('f499'), { phase: 'active', intensity: 0.5 }]) }));
    assert.equal(s.files.length, DASH_LIMITS.FILES);
    assert.equal(must(s.files[0]).name, 'f499.ts');
    assert.equal(must(s.files[1]).name, 'f000.ts');
    assert.ok(!s.files.some((f) => f.name === 'f450.ts'), 'idle files from the tail are dropped');
    assert.equal(s.overview.modifiedFiles, 500, 'the overview still counts every file of the history');
  });
});

describe('buildDashboardState: overview', () => {
  it('modifiedFiles counts the files of the kept history; bySource counts files by CURRENT source; unreviewed and events pass through', () => {
    const files: FileActivity[] = [];
    const want = { developer: 3, 'ai-agent': 2, external: 4, git: 1, automated: 5, unknown: 2 } as Record<ActivitySourceType, number>;
    let n = 0;
    for (const t of SOURCE_TYPES) for (let i = 0; i < want[t]; i += 1) files.push(activity(k(`f${n++}`), { sourceType: t }));
    const s = buildDashboardState(input({ files, unreviewed: 9, eventCount: 321 }));
    assert.equal(s.overview.modifiedFiles, 17);
    assert.deepEqual(s.overview.bySource, want);
    assert.equal(s.overview.unreviewed, 9);
    assert.equal(s.overview.events, 321);
    assert.equal(Object.values(s.overview.bySource).reduce((a, b) => a + b, 0), s.overview.modifiedFiles);
  });

  it('activeSessions is 1 only when a session is active (a paused or completed one does not count)', () => {
    assert.equal(buildDashboardState(input({ sessions: [session('a')] })).overview.activeSessions, 0);
    assert.equal(buildDashboardState(input({ sessions: [session('a', { status: 'paused' })] })).overview.activeSessions, 0);
    assert.equal(buildDashboardState(input({ sessions: [session('a'), session('b', { status: 'active', endedAt: undefined })] })).overview.activeSessions, 1);
  });
});

describe('buildDashboardState: file rows', () => {
  it('maps source, source id, method, confidence, event type, times, changes, review, exists', () => {
    const f = activity(k('x'), { sourceType: 'ai-agent', sourceId: 'claude-code', detectionMethod: 'agent-signal', confidence: 0.95, lastEventType: 'create', firstAt: NOW - 9000, lastAt: NOW - 100, changes: 7, review: 'unreviewed', exists: false });
    const row = must(buildDashboardState(input({ files: [f] })).files[0]);
    assert.deepEqual(
      { source: row.source, sourceId: row.sourceId, method: row.method, confidence: row.confidence, type: row.lastEventType, firstAt: row.firstAt, lastAt: row.lastAt, changes: row.changes, review: row.review, exists: row.exists },
      { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal', confidence: 0.95, type: 'create', firstAt: NOW - 9000, lastAt: NOW - 100, changes: 7, review: 'unreviewed', exists: false },
    );
  });

  it('absent source id and review state become null (never undefined: the protocol requires null)', () => {
    const row = must(buildDashboardState(input({ files: [activity(k('x'))] })).files[0]);
    assert.equal(row.sourceId, null);
    assert.equal(row.review, null);
    assert.equal(row.sessionTitle, null);
    assert.equal(row.impactLevel, null);
    assert.equal(row.dependants, null);
  });

  it('the name and folder are display values: workspace-relative, never the absolute path', () => {
    const rows = buildDashboardState(input({ files: [activity(`${ROOT}/a.ts`), activity(`${ROOT}/src/deep/er/b.ts`)] })).files;
    assert.deepEqual(
      rows.map((r) => [r.name, r.dir]),
      [
        ['a.ts', ''],
        ['b.ts', 'src/deep/er'],
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      [`${ROOT}/a.ts`, `${ROOT}/src/deep/er/b.ts`],
      'the id is the file key: the one place where the absolute path travels (it is how the host finds the file again)',
    );
  });

  it('several workspace folders: the folder name leads the display folder', () => {
    const roots: WorkspaceRoot[] = [
      { key: '/ws/alpha', name: 'alpha' },
      { key: '/ws/beta', name: 'beta' },
    ];
    const rows = buildDashboardState(input({ roots, files: [activity('/ws/alpha/src/a.ts'), activity('/ws/beta/b.ts')] })).files;
    assert.deepEqual(
      rows.map((r) => r.dir),
      ['alpha/src', 'beta'],
    );
  });

  it('live state: an active file reports its intensity (clamped to 0..1, non-finite = 0) and a shake from the intensity scaled by animationIntensity', () => {
    const f = [activity(k('a')), activity(k('b'), { lastAt: NOW - 5000 }), activity(k('c'), { lastAt: NOW - 6000 })];
    const lv = live([k('a'), { phase: 'active', intensity: 0.6 }], [k('b'), { phase: 'active', intensity: 7 }], [k('c'), { phase: 'active', intensity: Number.NaN }]);
    const rows = buildDashboardState(input({ files: f, live: lv, settings: settings({ animationIntensity: 2 }) })).files;
    const a = must(rows.find((r) => r.name === 'a.ts'));
    assert.equal(a.phase, 'active');
    assert.equal(a.intensity, 0.6);
    assert.deepEqual(a.shake, scaleShake(shakeParams(0.6), 2));
    assert.equal(must(rows.find((r) => r.name === 'b.ts')).intensity, 1);
    assert.equal(must(rows.find((r) => r.name === 'c.ts')).intensity, 0);
    assert.ok(a.shake.amp > shakeParams(0.6).amp, 'a factor of 2 shakes further');
    assert.equal(a.shake.dur, shakeParams(0.6).dur, 'and never faster');
  });

  it('files the tracker does not know are idle with intensity 0', () => {
    const row = must(buildDashboardState(input({ files: [activity(k('a'))], live: new Map() })).files[0]);
    assert.equal(row.phase, 'idle');
    assert.equal(row.intensity, 0);
  });

  it('impact fields come from the impact map: level and direct + indirect dependants', () => {
    const imp = impact(k('a'), { impactLevel: 'high', directDependants: [k('x'), k('y')], indirectDependants: [k('z')] });
    const rows = buildDashboardState(input({ files: [activity(k('a')), activity(k('b'), { lastAt: NOW - 9000 })], impacts: new Map([[k('a'), imp]]) })).files;
    assert.equal(must(rows[0]).impactLevel, 'high');
    assert.equal(must(rows[0]).dependants, 3);
    assert.equal(must(rows[1]).impactLevel, null);
    assert.equal(must(rows[1]).dependants, null);
  });

  it('session title comes from the session of the file, capped at 120; an unknown session id gives null', () => {
    const long = 'T'.repeat(300);
    const s = buildDashboardState(input({ files: [activity(k('a'), { sessionId: 's1' }), activity(k('b'), { sessionId: 'gone', lastAt: NOW - 5000 }), activity(k('c'), { lastAt: NOW - 9000 })], sessions: [session('s1', { title: long })] }));
    assert.equal(must(s.files[0]).sessionTitle, 'T'.repeat(120));
    assert.equal(must(s.files[1]).sessionTitle, null);
    assert.equal(must(s.files[2]).sessionTitle, null);
  });

  it('confidence outside 0..1 and non-finite times cannot reach the webview', () => {
    const rows = buildDashboardState(input({ files: [activity(k('a'), { confidence: 4, firstAt: Number.NaN, lastAt: Infinity })] })).files;
    assert.equal(must(rows[0]).confidence, 1);
    assert.equal(must(rows[0]).firstAt, 0);
    assert.equal(must(rows[0]).lastAt, 0);
    assert.ok(accepted(buildDashboardState(input({ files: [activity(k('a'), { confidence: -4 })] }))));
  });
});

describe('buildDashboardState: timeline', () => {
  it('one item per event in the given (newest first) order, capped at 100, with the file shown as a display name', () => {
    const events = Array.from({ length: 150 }, (_, i) => event(`e${i}`, k(`f${i}`), { lastTimestamp: NOW - i * 1000, count: i + 1, sourceType: 'external', sourceId: i === 0 ? 'claude-code' : undefined, eventType: i === 1 ? 'create' : 'modify' }));
    const s = buildDashboardState(input({ events, eventCount: 150 }));
    assert.equal(s.timeline.length, DASH_LIMITS.TIMELINE);
    assert.deepEqual(
      s.timeline.map((t) => t.id),
      events.slice(0, 100).map((e) => e.id),
    );
    const first = must(s.timeline[0]);
    assert.deepEqual(first, { id: 'e0', fileId: k('f0'), name: 'f0.ts', dir: 'src', source: 'external', sourceId: 'claude-code', eventType: 'modify', at: NOW, count: 1, sessionTitle: null });
    assert.equal(must(s.timeline[1]).eventType, 'create');
    assert.equal(must(s.timeline[1]).sourceId, null);
    assert.equal(must(s.timeline[99]).count, 100);
  });

  it('the time of an item is the LAST occurrence of its (coalesced) event', () => {
    const t = must(buildDashboardState(input({ events: [event('e1', k('a'), { timestamp: NOW - 50_000, lastTimestamp: NOW - 3000, count: 9 })] })).timeline[0]);
    assert.equal(t.at, NOW - 3000);
    assert.equal(t.count, 9);
  });

  it('session titles are looked up by session id', () => {
    const s = buildDashboardState(input({ events: [event('e1', k('a'), { sessionId: 's1' }), event('e2', k('b'), { sessionId: 'nope' })], sessions: [session('s1', { title: 'Refactor' })] }));
    assert.equal(must(s.timeline[0]).sessionTitle, 'Refactor');
    assert.equal(must(s.timeline[1]).sessionTitle, null);
  });
});

describe('buildDashboardState: sessions', () => {
  it('the active session is split from the previous ones, which are newest first', () => {
    const s = buildDashboardState(
      input({
        sessions: [session('old', { startedAt: NOW - 900_000 }), session('act', { status: 'active', startedAt: NOW - 100, endedAt: undefined }), session('mid', { startedAt: NOW - 500_000 }), session('paused', { status: 'paused', startedAt: NOW - 700_000, endedAt: undefined })],
      }),
    );
    assert.equal(s.sessions.active?.id, 'act');
    assert.deepEqual(
      s.sessions.previous.map((x) => x.id),
      ['mid', 'paused', 'old'],
    );
    assert.equal(s.sessions.active?.endedAt, null);
  });

  it('no active session gives null; previous is capped at 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => session(`s${i}`, { startedAt: NOW - i * 1000 }));
    const s = buildDashboardState(input({ sessions: many }));
    assert.equal(s.sessions.active, null);
    assert.equal(s.sessions.previous.length, DASH_LIMITS.SESSIONS);
    assert.equal(must(s.sessions.previous[0]).id, 's0');
    const withActive = buildDashboardState(input({ sessions: [...many, session('live', { status: 'active', startedAt: NOW + 1, endedAt: undefined })] }));
    assert.equal(withActive.sessions.active?.id, 'live');
    assert.equal(withActive.sessions.previous.length, DASH_LIMITS.SESSIONS);
  });

  it('counts, files, per-source counts (zero entries left out), branch from the end then the start, title capped', () => {
    const s = buildDashboardState(
      input({
        sessions: [
          session('a', { activityCount: 9, modifiedFiles: ['/x/1', '/x/2', '/x/3'], sources: { developer: 5, git: 0, external: 4 }, gitStart: { branch: 'main' }, gitEnd: { branch: 'feature' }, title: 'x'.repeat(500) }),
          session('b', { startedAt: NOW - 200_000, gitStart: { branch: 'only-start' } }),
          session('c', { startedAt: NOW - 300_000 }),
        ],
      }),
    );
    const [a, b, c] = s.sessions.previous;
    assert.equal(must(a).activityCount, 9);
    assert.equal(must(a).fileCount, 3);
    assert.deepEqual(must(a).bySource, { developer: 5, external: 4 });
    assert.equal(must(a).branch, 'feature');
    assert.equal(must(a).title.length, 120);
    assert.equal(must(b).branch, 'only-start');
    assert.equal(must(c).branch, null);
    assert.equal(must(c).endedAt, NOW - 50_000);
  });

  it('modifiedFiles themselves are never sent (only their number): a session cannot leak a path list', () => {
    const s = buildDashboardState(input({ sessions: [session('a', { modifiedFiles: [`${ROOT}/secret/.env`] })] }));
    assert.ok(!JSON.stringify(s).includes('.env'));
  });
});

describe('buildDashboardState: selection and impact', () => {
  const edge = (key: FileKey, o: Partial<DepEdge> = {}): DepEdge => ({ key, count: 1, relationshipType: 'import', ...o });

  it('no selected file: everything is empty even when edges were passed in', () => {
    const s = buildDashboardState(input({ selection: { file: undefined, imports: [edge(k('a'))], importedBy: [edge(k('b'))], impact: impact(k('z')) } }));
    assert.deepEqual(s.selection, { file: null, imports: [], importedBy: [], impact: null });
  });

  it('a selected file: its display reference, imports and importers with relationship, count and the test flag', () => {
    const s = buildDashboardState(
      input({
        selection: {
          file: k('sel'),
          imports: [edge(k('dep'), { count: 3 }), edge(`${ROOT}/src/re.ts`, { relationshipType: 'export' })],
          importedBy: [edge(`${ROOT}/test/sel.test.ts`), edge(k('app'), { relationshipType: 'reference', count: 2 }), edge(`${ROOT}/tests/helper.ts`)],
          impact: undefined,
        },
      }),
    );
    assert.deepEqual(s.selection.file, { id: k('sel'), name: 'sel.ts', dir: 'src' });
    assert.deepEqual(
      s.selection.imports.map((d) => [d.name, d.relationship, d.count, d.isTest]),
      [
        ['dep.ts', 'import', 3, false],
        ['re.ts', 'export', 1, false],
      ],
    );
    assert.deepEqual(
      s.selection.importedBy.map((d) => [d.name, d.relationship, d.isTest]),
      [
        ['sel.test.ts', 'import', true],
        ['app.ts', 'reference', false],
        ['helper.ts', 'import', true],
      ],
    );
    assert.equal(s.selection.impact, null);
    assert.ok(accepted(s));
  });

  it('a project that lives below a folder called "test" is not all tests (the roots are passed to isTestFile)', () => {
    const roots: WorkspaceRoot[] = [{ key: '/home/me/test/proj', name: 'proj' }];
    const s = buildDashboardState(input({ roots, selection: { file: '/home/me/test/proj/a.ts', imports: [edge('/home/me/test/proj/src/b.ts')], importedBy: [], impact: undefined } }));
    assert.equal(must(s.selection.imports[0]).isTest, false);
  });

  it('imports and importers are capped at 200 each', () => {
    const many = Array.from({ length: 260 }, (_, i) => edge(k(`d${i}`)));
    const s = buildDashboardState(input({ selection: { file: k('sel'), imports: many, importedBy: many, impact: undefined } }));
    assert.equal(s.selection.imports.length, DASH_LIMITS.DEPS);
    assert.equal(s.selection.importedBy.length, DASH_LIMITS.DEPS);
    assert.ok(accepted(s));
  });

  it('the impact of the selection: level, reasons, counts, lists, completeness and time', () => {
    const imp = impact(k('sel'), {
      impactLevel: 'critical',
      reasons: ['31 files import this file directly.', 'This is a project configuration file; changes can affect the whole workspace.'],
      directDependants: [k('a'), k('b')],
      indirectDependants: [k('c')],
      affectedFiles: [k('a'), k('b'), k('c')],
      affectedTests: [`${ROOT}/test/sel.test.ts`],
      configFiles: [`${ROOT}/package.json`],
      complete: false,
      analysedAt: NOW - 777,
    });
    const d = must(buildDashboardState(input({ selection: { file: k('sel'), imports: [], importedBy: [], impact: imp } })).selection.impact);
    assert.equal(d.level, 'critical');
    assert.deepEqual(d.reasons, imp.reasons);
    assert.equal(d.direct, 2);
    assert.equal(d.indirect, 1);
    assert.deepEqual(
      d.affected.map((f) => f.name),
      ['a.ts', 'b.ts', 'c.ts'],
    );
    assert.deepEqual(d.tests, [{ id: `${ROOT}/test/sel.test.ts`, name: 'sel.test.ts', dir: 'test' }]);
    assert.deepEqual(d.configs, [{ id: `${ROOT}/package.json`, name: 'package.json', dir: '' }]);
    assert.equal(d.complete, false);
    assert.equal(d.analysedAt, NOW - 777);
    assert.deepEqual(d.file, { id: k('sel'), name: 'sel.ts', dir: 'src' });
  });

  it('reasons are capped at 12 and each list of files at 50; the counts keep the true totals', () => {
    const files = Array.from({ length: 120 }, (_, i) => k(`x${i}`));
    const imp = impact(k('sel'), { reasons: Array.from({ length: 30 }, (_, i) => `Reason ${i}.`), directDependants: files, affectedFiles: files, affectedTests: files, configFiles: files });
    const d = must(buildDashboardState(input({ selection: { file: k('sel'), imports: [], importedBy: [], impact: imp } })).selection.impact);
    assert.equal(d.reasons.length, DASH_LIMITS.REASONS);
    assert.equal(d.affected.length, DASH_LIMITS.IMPACT_FILES);
    assert.equal(d.tests.length, DASH_LIMITS.IMPACT_FILES);
    assert.equal(d.configs.length, DASH_LIMITS.IMPACT_FILES);
    assert.equal(d.direct, 120, 'the number is the real count, not the capped list length');
  });

  it('the impacts list: newest analysis first, ties by path, capped at 50, the selected file is not added by itself', () => {
    const map = new Map<FileKey, ChangeImpact>();
    for (let i = 0; i < 80; i += 1) map.set(k(`i${String(i).padStart(2, '0')}`), impact(k(`i${String(i).padStart(2, '0')}`), { analysedAt: NOW - Math.floor(i / 2) * 1000 }));
    const s = buildDashboardState(input({ impacts: map, selection: { file: k('i79'), imports: [], importedBy: [], impact: undefined } }));
    assert.equal(s.impacts.length, DASH_LIMITS.IMPACTS);
    assert.deepEqual(
      s.impacts.slice(0, 4).map((i) => i.file.name),
      ['i00.ts', 'i01.ts', 'i02.ts', 'i03.ts'],
      'two analyses per timestamp, ties by path',
    );
    assert.equal(s.selection.impact, null);
  });
});

describe('buildDashboardState: git', () => {
  it('a repository: root as id, branch and a SHORT commit, ahead and behind, the three lists with display paths and statuses', () => {
    const s = buildDashboardState(
      input({
        git: {
          state: 'ready',
          detail: '',
          repos: [
            repo({
              staged: [{ key: `${ROOT}/package.json`, status: 'modified' }],
              unstaged: [{ key: k('a'), status: 'deleted' }],
              untracked: [{ key: `${ROOT}/notes/n.md`, status: 'untracked' }],
            }),
          ],
        },
      }),
    );
    const r = must(s.git.repos[0]);
    assert.equal(r.id, ROOT);
    assert.equal(r.name, 'proj');
    assert.equal(r.branch, 'main');
    assert.equal(r.commit, 'abcdef0', 'seven characters, not the full id');
    assert.equal(r.ahead, 1);
    assert.equal(r.behind, 2);
    assert.deepEqual(r.staged, [{ id: `${ROOT}/package.json`, name: 'package.json', dir: '', status: 'modified' }]);
    assert.deepEqual(r.unstaged, [{ id: k('a'), name: 'a.ts', dir: 'src', status: 'deleted' }]);
    assert.deepEqual(r.untracked, [{ id: `${ROOT}/notes/n.md`, name: 'n.md', dir: 'notes', status: 'untracked' }]);
    assert.equal(r.truncated, false);
  });

  it('a detached HEAD or a fresh repository has null branch and commit', () => {
    const r = must(buildDashboardState(input({ git: { state: 'ready', detail: '', repos: [repo({ branch: undefined, commit: undefined })] } })).git.repos[0]);
    assert.equal(r.branch, null);
    assert.equal(r.commit, null);
  });

  it('state and detail are passed through whatever the state is; repositories are only listed as given', () => {
    for (const state of ['ready', 'loading', 'unavailable', 'disabled'] as const) {
      const s = buildDashboardState(input({ git: { state, detail: `because ${state}`, repos: [] } }));
      assert.equal(s.git.state, state);
      assert.equal(s.git.detail, `because ${state}`);
    }
  });

  it('a huge number of changes: each list is cut at 200 and the repository says it was truncated', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ key: k(`g${i}`), status: 'modified' as const }));
    const s = buildDashboardState(input({ git: { state: 'ready', detail: '', repos: [repo({ staged: many, unstaged: many, untracked: many })] } }));
    const r = must(s.git.repos[0]);
    assert.equal(r.staged.length, DASH_LIMITS.GIT_CHANGES);
    assert.equal(r.unstaged.length, DASH_LIMITS.GIT_CHANGES);
    assert.equal(r.untracked.length, DASH_LIMITS.GIT_CHANGES);
    assert.equal(r.truncated, true, 'a list was cut by this builder even though the snapshot did not say so');
    assert.ok(accepted(s));
  });

  it('the snapshot own truncation flag is kept; at most 20 repositories are listed', () => {
    const repos = Array.from({ length: 30 }, (_, i) => repo({ root: `/r/${i}`, name: `r${i}`, truncated: i === 0 }));
    const s = buildDashboardState(input({ git: { state: 'ready', detail: '', repos } }));
    assert.equal(s.git.repos.length, DASH_LIMITS.REPOS);
    assert.equal(must(s.git.repos[0]).truncated, true);
    assert.equal(must(s.git.repos[1]).truncated, false);
  });
});

describe('buildDashboardState: limits, strings and the protocol', () => {
  it('agents are capped at 12; every string is capped at 10 000 characters (titles at 120)', () => {
    const huge = 'H'.repeat(50_000);
    const s = buildDashboardState(
      input({
        agents: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, label: huge, state: 'off' as const, detail: huge })),
        files: [activity(`/${'p'.repeat(20_000)}.ts`, { sourceId: huge })],
        summary: { text: huge, provider: 'local', at: NOW },
        git: { state: 'unavailable', detail: huge, repos: [] },
      }),
    );
    assert.equal(s.agents.length, DASH_LIMITS.AGENTS);
    assert.equal(must(s.agents[0]).label.length, DASH_LIMITS.STRING);
    assert.equal(must(s.agents[0]).detail.length, DASH_LIMITS.STRING);
    assert.equal(must(s.files[0]).sourceId?.length, DASH_LIMITS.STRING);
    assert.equal(must(s.files[0]).name.length, DASH_LIMITS.STRING);
    assert.equal(s.summary?.text.length, DASH_LIMITS.STRING);
    assert.equal(s.git.detail.length, DASH_LIMITS.STRING);
    assert.ok(accepted(s), 'and the protocol accepts the result');
  });

  it('a maximal input (every cap hit at once) still passes parseDashboardHostMessage', () => {
    const files = Array.from({ length: 500 }, (_, i) => activity(k(`m${i}`), { lastAt: NOW - i, sourceType: SOURCE_TYPES[i % 6] as ActivitySourceType, review: i % 2 === 0 ? 'unreviewed' : undefined }));
    const edges = Array.from({ length: 300 }, (_, i) => ({ key: k(`e${i}`), count: i, relationshipType: 'import' as const }));
    const imp = impact(k('m0'), { reasons: Array.from({ length: 40 }, (_, i) => `R${i}.`), directDependants: files.map((f) => f.key), affectedFiles: files.map((f) => f.key), affectedTests: files.map((f) => f.key), configFiles: files.map((f) => f.key) });
    const impacts = new Map<FileKey, ChangeImpact>(Array.from({ length: 90 }, (_, i) => [k(`im${i}`), impact(k(`im${i}`), { analysedAt: NOW - i })]));
    const s = buildDashboardState(
      input({
        files,
        live: new Map(files.slice(0, 40).map((f) => [f.key, { phase: 'active' as const, intensity: 0.5 }])),
        events: Array.from({ length: 400 }, (_, i) => event(`e${i}`, k(`m${i % 50}`))),
        eventCount: 400,
        unreviewed: 250,
        sessions: Array.from({ length: 90 }, (_, i) => session(`s${i}`, { startedAt: NOW - i })),
        git: { state: 'ready', detail: '', repos: Array.from({ length: 40 }, (_, i) => repo({ root: `/r/${i}`, name: `r${i}`, staged: edges.map((e) => ({ key: e.key, status: 'added' as const })) })) },
        selection: { file: k('m0'), imports: edges, importedBy: edges, impact: imp },
        impacts,
        agents: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, label: 'L', state: 'listening' as const, detail: '' })),
      }),
    );
    assert.equal(s.files.length, 300);
    assert.equal(s.timeline.length, 100);
    assert.equal(s.impacts.length, 50);
    assert.equal(s.git.repos.length, 20);
    assert.ok(accepted(s));
  });

  it('property: 300 seeded random inputs (hostile strings, NaN, empty and huge lists) always give a state the protocol accepts', () => {
    let seed = 99;
    const r = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const names = ['a.ts', '<img src=x onerror=alert(1)>.ts', '日本語.ts', '', 'x'.repeat(300), "q'\"uote.ts", '\u0000nul.ts'];
    const nums = [0, 1, -1, 0.5, 1e9, Number.NaN, Infinity, -Infinity];
    const levels = ['low', 'medium', 'high', 'critical'] as const;
    for (let round = 0; round < 300; round += 1) {
      const files = Array.from({ length: r(8) === 0 ? 400 : r(25) }, (_, i) =>
        activity(`${r(5) === 0 ? '/elsewhere' : ROOT}/${names[r(names.length)]}${i}`, {
          sourceType: SOURCE_TYPES[r(6)] as ActivitySourceType,
          confidence: nums[r(nums.length)] as number,
          firstAt: nums[r(nums.length)] as number,
          lastAt: nums[r(nums.length)] as number,
          changes: r(4),
          sessionId: r(3) === 0 ? 's1' : undefined,
          ...(r(2) === 0 ? { sourceId: names[r(names.length)] as string } : {}),
        }),
      );
      const lv = new Map<FileKey, FileLiveState>(files.filter(() => r(3) === 0).map((f) => [f.key, { phase: r(2) === 0 ? ('active' as const) : ('idle' as const), intensity: nums[r(nums.length)] as number }]));
      const imps = new Map<FileKey, ChangeImpact>(files.filter(() => r(4) === 0).map((f) => [f.key, impact(f.key, { impactLevel: levels[r(4)] as (typeof levels)[number], analysedAt: nums[r(nums.length)] as number, directDependants: files.slice(0, r(10)).map((x) => x.key) })]));
      const s = buildDashboardState(
        input({
          now: nums[r(nums.length)] as number,
          seq: r(100),
          files,
          live: lv,
          impacts: imps,
          events: files.slice(0, r(20)).map((f, i) => event(`e${i}`, f.key, { lastTimestamp: nums[r(nums.length)] as number, count: 1 + r(3), sessionId: r(2) === 0 ? 's1' : undefined })),
          sessions: r(2) === 0 ? [session('s1', { title: names[r(names.length)] as string, startedAt: nums[r(nums.length)] as number })] : [],
          // settings come from the sanitized configuration, which never yields a non-finite number
          settings: settings({ animationIntensity: [0.25, 1, 2][r(3)] as number }),
          selection: files.length > 0 && r(2) === 0 ? { file: must(files[0]).key, imports: [], importedBy: [], impact: must(imps.values().next().value as ChangeImpact | undefined ?? impact(must(files[0]).key)) } : { file: undefined, imports: [], importedBy: [], impact: undefined },
        }),
      );
      assert.ok(accepted(s), `round ${round}: ${JSON.stringify(parseDashboardHostMessage(wire(s)))}`);
    }
  });
});

describe('buildDashboardState: no absolute path travels except as an id', () => {
  it('for files inside the workspace no string of the state other than ids contains the workspace location', () => {
    const files = [activity(`${ROOT}/src/a.ts`, { sessionId: 's1' }), activity(`${ROOT}/b.ts`, { lastAt: NOW - 5000 })];
    const s = buildDashboardState(
      input({
        files,
        events: [event('e1', `${ROOT}/src/a.ts`, { sessionId: 's1' })],
        sessions: [session('s1', { title: 'Work', modifiedFiles: [`${ROOT}/src/a.ts`] })],
        git: { state: 'ready', detail: '', repos: [repo({ staged: [{ key: `${ROOT}/src/a.ts`, status: 'modified' }] })] },
        selection: { file: `${ROOT}/src/a.ts`, imports: [{ key: `${ROOT}/b.ts`, count: 1, relationshipType: 'import' }], importedBy: [], impact: impact(`${ROOT}/src/a.ts`, { affectedFiles: [`${ROOT}/b.ts`], directDependants: [`${ROOT}/b.ts`] }) },
        impacts: new Map([[`${ROOT}/src/a.ts`, impact(`${ROOT}/src/a.ts`)]]),
      }),
    );
    const leaks: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') {
        const last = path.split('.').pop() ?? '';
        const isId = last === 'id' || last === 'fileId';
        if (!isId && v.includes('/Users/dev')) leaks.push(`${path}=${v}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === 'object') for (const [key, x] of Object.entries(v)) walk(x, `${path}.${key}`);
    };
    walk(s, 'state');
    assert.deepEqual(leaks, []);
  });

  it('for a file OUTSIDE every workspace folder the SIDEBAR state keeps its absolute folder (the 0.2.0 view does the same; it only goes to the local webview). Reports and AI requests use toSafeDisplayPath instead (QA-101, safeDisplayPath.test.ts)', () => {
    const row = must(buildDashboardState(input({ files: [activity('/Users/dev/other/secret.ts')] })).files[0]);
    assert.equal(row.dir, '/Users/dev/other');
  });
});

describe('buildDashboardState: purity', () => {
  const big = (): DashboardInput =>
    input({
      files: Array.from({ length: 60 }, (_, i) => activity(k(`p${i}`), { lastAt: NOW - i * 10, review: i % 3 === 0 ? 'unreviewed' : undefined })),
      live: live([k('p3'), { phase: 'active', intensity: 0.4 }]),
      events: [event('e1', k('p1'))],
      sessions: [session('s1', { status: 'active', endedAt: undefined })],
      git: { state: 'ready', detail: '', repos: [repo({ staged: [{ key: k('p1'), status: 'added' }] })] },
      impacts: new Map([[k('p1'), impact(k('p1'))]]),
    });

  it('the same input always gives the same output', () => {
    const a = buildDashboardState(big());
    const b = buildDashboardState(big());
    assert.deepEqual(a, b);
    assert.equal(stateSignature(a), stateSignature(b));
  });

  it('the input is not changed (deep-frozen input does not throw, and an untouched copy compares equal)', () => {
    const deepFreeze = (o: unknown): void => {
      if (o instanceof Map) {
        for (const [, v] of o) deepFreeze(v);
        return;
      }
      if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
    };
    const i = big();
    const before = JSON.stringify({ ...i, live: [...i.live], impacts: [...i.impacts] });
    deepFreeze(i);
    assert.doesNotThrow(() => buildDashboardState(i));
    assert.equal(JSON.stringify({ ...i, live: [...i.live], impacts: [...i.impacts] }), before);
  });
});

describe('buildDashboardState: numbers that pass through are clamped (the state is always valid for the webview)', () => {
  const bad = [Number.NaN, Infinity, -Infinity, -1, -1e9];

  it('settings: animationIntensity, historyLimit, retentionDays become finite and non-negative; the rest of the settings are kept', () => {
    for (const v of bad) {
      const s = buildDashboardState(input({ settings: settings({ animationIntensity: v, historyLimit: v, retentionDays: v, mode: 'compact', paused: true }) }));
      assert.equal(s.settings.animationIntensity, 0, String(v));
      assert.equal(s.settings.historyLimit, 0, String(v));
      assert.equal(s.settings.retentionDays, 0, String(v));
      assert.equal(s.settings.mode, 'compact');
      assert.equal(s.settings.paused, true);
      assert.ok(accepted(s), `accepted with ${String(v)}`);
    }
    assert.equal(buildDashboardState(input({ settings: settings({ animationIntensity: 1.5, historyLimit: 1000, retentionDays: 14 }) })).settings.animationIntensity, 1.5);
  });

  it('index: indexed and total; summary: at; seq and now', () => {
    for (const v of bad) {
      const s = buildDashboardState(input({ seq: v, now: v, index: { state: 'indexing', indexed: v, total: v, truncated: false }, summary: { text: 't', provider: 'local', at: v } }));
      const finiteOrZero = Number.isFinite(v) ? v : 0; // a negative time or sequence number is still a number the protocol accepts
      assert.equal(s.index.indexed, 0, String(v));
      assert.equal(s.index.total, 0, String(v));
      assert.equal(must(s.summary).at, finiteOrZero, String(v));
      assert.equal(s.seq, finiteOrZero, String(v));
      assert.equal(s.now, finiteOrZero, String(v));
      assert.ok(accepted(s), `accepted with ${String(v)}`);
    }
  });

  it('counts of events, sessions, files, timeline items, git, dependencies', () => {
    for (const v of bad) {
      const s = buildDashboardState(
        input({
          unreviewed: v,
          eventCount: v,
          files: [activity(k('a'), { changes: v })],
          events: [event('e1', k('a'), { count: v })],
          sessions: [session('s1', { activityCount: v })],
          git: { state: 'ready', detail: '', repos: [repo({ ahead: v, behind: v })] },
          selection: { file: k('a'), imports: [{ key: k('b'), count: v, relationshipType: 'import' }], importedBy: [], impact: undefined },
        }),
      );
      assert.equal(s.overview.unreviewed, 0, String(v));
      assert.equal(s.overview.events, 0, String(v));
      assert.equal(must(s.files[0]).changes, 0, String(v));
      assert.equal(must(s.timeline[0]).count, 0, String(v));
      assert.equal(must(s.sessions.previous[0]).activityCount, 0, String(v));
      assert.equal(must(s.git.repos[0]).ahead, 0, String(v));
      assert.equal(must(s.git.repos[0]).behind, 0, String(v));
      assert.equal(must(s.selection.imports[0]).count, 0, String(v));
      assert.ok(accepted(s), `accepted with ${String(v)}`);
    }
  });

  it('settings and index are copied: changing the input afterwards cannot change a state that was already built', () => {
    const i = input({ settings: settings({ mode: 'live' }), index: { state: 'idle', indexed: 0, total: 0, truncated: false } });
    const s = buildDashboardState(i);
    const before = JSON.stringify(s);
    i.settings.mode = 'compact';
    i.index.state = 'ready';
    assert.equal(JSON.stringify(s), before);
    assert.notEqual(s.settings, i.settings);
    assert.notEqual(s.index, i.index);
  });

  it('property: 300 random inputs where EVERY pass-through number is non-finite or negative still give a state the protocol accepts', () => {
    let seed = 5;
    const r = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const pick = (): number => [Number.NaN, Infinity, -Infinity, -1, 0, 7][r(6)] as number;
    for (let round = 0; round < 300; round += 1) {
      const files = Array.from({ length: r(5) }, (_, i) => activity(k(`p${i}`), { changes: pick(), confidence: pick(), firstAt: pick(), lastAt: pick() }));
      const s = buildDashboardState(
        input({
          seq: pick(),
          now: pick(),
          unreviewed: pick(),
          eventCount: pick(),
          settings: settings({ animationIntensity: pick(), historyLimit: pick(), retentionDays: pick() }),
          index: { state: 'ready', indexed: pick(), total: pick(), truncated: false },
          summary: r(2) === 0 ? { text: 't', provider: 'local', at: pick() } : null,
          files,
          live: new Map(files.map((f) => [f.key, { phase: 'active' as const, intensity: pick() }])),
          events: files.map((f, n) => event(`e${n}`, f.key, { count: pick(), lastTimestamp: pick() })),
          sessions: [session('s1', { activityCount: pick(), startedAt: pick() })],
          git: { state: 'ready', detail: '', repos: [repo({ ahead: pick(), behind: pick() })] },
        }),
      );
      assert.ok(accepted(s), `round ${round}`);
    }
  });
});

describe('stateSignature', () => {
  const base = (): ReturnType<typeof buildDashboardState> => buildDashboardState(input({ files: [activity(k('a'))], live: live([k('a'), { phase: 'active', intensity: 0.5 }]) }));

  it('ignores seq and now (they change on every build) and nothing else', () => {
    const a = base();
    assert.equal(stateSignature({ ...a, seq: a.seq + 100, now: a.now + 99_999 }), stateSignature(a));
  });

  it('is a stable string: the same state always gives the same text', () => {
    const a = base();
    assert.equal(typeof stateSignature(a), 'string');
    assert.equal(stateSignature(a), stateSignature(JSON.parse(JSON.stringify(a)) as typeof a));
  });

  it('changes when anything else changes: every top-level section, a single row field, a setting', () => {
    const a = base();
    const sig = stateSignature(a);
    const variants: Array<[string, (s: typeof a) => void]> = [
      ['enabled', (s) => (s.enabled = !s.enabled)],
      ['setting', (s) => (s.settings.paused = !s.settings.paused)],
      ['overview', (s) => (s.overview.unreviewed += 1)],
      ['row intensity', (s) => (must(s.files[0]).intensity = 0.51)],
      ['row phase', (s) => (must(s.files[0]).phase = 'idle')],
      ['row changes', (s) => (must(s.files[0]).changes += 1)],
      ['timeline', (s) => s.timeline.push({ id: 'x', fileId: 'f', name: 'n', dir: '', source: 'developer', sourceId: null, eventType: 'modify', at: 1, count: 1, sessionTitle: null })],
      ['agents', (s) => (must(s.agents[0]).state = 'off')],
      ['git', (s) => (s.git.state = 'unavailable')],
      ['sessions', (s) => (s.sessions.previous = [{ id: 's', title: 't', startedAt: 1, endedAt: 2, status: 'completed', activityCount: 0, fileCount: 0, bySource: {}, branch: null }])],
      ['selection', (s) => (s.selection.file = { id: 'a', name: 'a', dir: '' })],
      ['impacts', (s) => s.impacts.push({ file: { id: 'a', name: 'a', dir: '' }, level: 'low', reasons: [], direct: 0, indirect: 0, affected: [], tests: [], configs: [], complete: true, analysedAt: 1 })],
      ['index', (s) => (s.index.indexed += 1)],
      ['summary', (s) => (s.summary = { text: 't', provider: 'local', at: 1 })],
    ];
    for (const [name, change] of variants) {
      const s = JSON.parse(JSON.stringify(a)) as typeof a;
      change(s);
      assert.notEqual(stateSignature(s), sig, name);
    }
  });

  it('the relative times in the webview need no new state: an identical build with a later clock has the same signature', () => {
    const a = buildDashboardState(input({ now: NOW, seq: 1, files: [activity(k('a'))] }));
    const b = buildDashboardState(input({ now: NOW + 60_000, seq: 2, files: [activity(k('a'))] }));
    assert.equal(stateSignature(a), stateSignature(b));
  });

  it('does not mutate its argument', () => {
    const a = base();
    const copy = JSON.stringify(a);
    stateSignature(a);
    assert.equal(JSON.stringify(a), copy);
  });
});
