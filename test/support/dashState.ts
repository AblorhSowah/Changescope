// Builders for valid DashboardState mocks. Every state a test creates is checked with the real
// parseDashboardHostMessage, so a mock can never drift away from the protocol without a test failing at once.
import { parseDashboardHostMessage } from '../../src/core/dashboard/protocol';
import { SOURCE_TYPES } from '../../src/core/dashboard/protocol';
import type {
  ActivitySourceType,
  DashAgentAdapter,
  DashDep,
  DashFileRef,
  DashFileRow,
  DashGit,
  DashGitChange,
  DashGitRepo,
  DashImpact,
  DashIndexStatus,
  DashOverview,
  DashSelection,
  DashSession,
  DashSettings,
  DashTimelineItem,
  DashboardState,
} from '../../src/core/types';

/** 2026-11-12 14:30:00 UTC. Relative times in the webview are measured against `state.now`, never the real clock. */
export const NOW = Date.UTC(2026, 10, 12, 14, 30, 0);
export const S = 1000;
export const MIN = 60 * S;
export const HOUR = 60 * MIN;

export const WS = '/ws/proj';

export function ref(name: string, dir = ''): DashFileRef {
  return { id: `${WS}/${dir === '' ? '' : `${dir}/`}${name}`, name, dir };
}

export interface RowOptions extends Partial<DashFileRow> {
  /** seconds before NOW of the last change */
  ago?: number;
}

/** One activity row. Defaults: a developer edit 10 s ago, idle, one change. */
export function row(name: string, dir = 'src', o: RowOptions = {}): DashFileRow {
  const { ago, ...rest } = o;
  const base = ref(name, dir);
  const lastAt = NOW - (ago ?? 10) * S;
  const source: ActivitySourceType = rest.source ?? 'developer';
  return {
    ...base,
    source,
    sourceId: null,
    method: source === 'developer' ? 'focused-editor-edit' : 'disk-write',
    confidence: source === 'developer' ? 0.9 : 0.7,
    lastEventType: 'modify',
    firstAt: lastAt - 30 * S,
    lastAt,
    changes: 1,
    phase: 'idle',
    intensity: 0,
    shake: { amp: 0.5, dur: 160, rot: 0.2 },
    sessionTitle: null,
    review: source === 'developer' ? null : 'unreviewed',
    exists: true,
    impactLevel: null,
    dependants: null,
    ...rest,
  };
}

/** A row that is shaking right now. */
export function activeRow(name: string, dir = 'src', o: RowOptions = {}): DashFileRow {
  return row(name, dir, { phase: 'active', intensity: 0.6, shake: { amp: 2.6, dur: 100, rot: 0.8 }, changes: 4, ago: 2, ...o });
}

export function timelineItem(name: string, dir = 'src', o: Partial<DashTimelineItem> & { ago?: number } = {}): DashTimelineItem {
  const { ago, ...rest } = o;
  const f = ref(name, dir);
  return {
    id: `t-${dir}-${name}`,
    fileId: f.id,
    name,
    dir,
    source: 'developer',
    sourceId: null,
    eventType: 'modify',
    at: NOW - (ago ?? 10) * S,
    count: 1,
    sessionTitle: null,
    ...rest,
  };
}

export function dashSession(id: string, title: string, o: Partial<DashSession> = {}): DashSession {
  return {
    id,
    title,
    startedAt: NOW - 20 * MIN,
    endedAt: null,
    status: 'active',
    activityCount: 3,
    fileCount: 2,
    bySource: { developer: 2, external: 1 },
    branch: 'main',
    ...o,
  };
}

export function change(name: string, dir: string, status: DashGitChange['status'] = 'modified'): DashGitChange {
  return { ...ref(name, dir), status };
}

export function repo(name: string, o: Partial<DashGitRepo> = {}): DashGitRepo {
  return { id: `${WS}-${name}`, name, branch: 'main', commit: 'a3f9c21', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], truncated: false, ...o };
}

export function dep(name: string, dir = 'src', o: Partial<DashDep> = {}): DashDep {
  return { ...ref(name, dir), relationship: 'import', count: 1, isTest: false, ...o };
}

export function impact(name: string, dir = 'src', o: Partial<DashImpact> = {}): DashImpact {
  return {
    file: ref(name, dir),
    level: 'medium',
    reasons: ['3 files import this file directly.'],
    direct: 3,
    indirect: 0,
    affected: [ref('a.ts', 'src'), ref('b.ts', 'src'), ref('c.ts', 'src')],
    tests: [],
    configs: [],
    complete: true,
    analysedAt: NOW - 5 * S,
    ...o,
  };
}

export function overviewOf(files: readonly DashFileRow[], extra: Partial<DashOverview> = {}): DashOverview {
  const bySource = Object.fromEntries(SOURCE_TYPES.map((t) => [t, 0])) as Record<ActivitySourceType, number>;
  for (const f of files) bySource[f.source] += 1;
  return {
    modifiedFiles: files.length,
    bySource,
    unreviewed: files.filter((f) => f.review === 'unreviewed').length,
    activeSessions: 0,
    events: files.reduce((n, f) => n + f.changes, 0),
    ...extra,
  };
}

export const DEFAULT_SETTINGS: DashSettings = {
  mode: 'live',
  animate: true,
  animationIntensity: 1,
  paused: false,
  collisions: true,
  dependencyIndex: true,
  gitEnabled: true,
  historyLimit: 1000,
  retentionDays: 14,
  aiMode: 'local',
  aiProvider: null,
};

export interface StateInput {
  seq?: number;
  now?: number;
  enabled?: boolean;
  settings?: Partial<DashSettings>;
  overview?: Partial<DashOverview>;
  timeline?: DashTimelineItem[];
  files?: DashFileRow[];
  agents?: DashAgentAdapter[];
  git?: Partial<DashGit>;
  sessions?: Partial<DashboardState['sessions']>;
  selection?: Partial<DashSelection>;
  impacts?: DashImpact[];
  index?: Partial<DashIndexStatus>;
  summary?: DashboardState['summary'];
}

export const API_ADAPTER: DashAgentAdapter = { id: 'api', label: 'Extension API', state: 'listening', detail: 'Reports from other extensions.' };

/**
 * A valid state. `overview` is derived from `files` unless given. Throws when the result is not accepted by the
 * protocol validator, so a typo in a test cannot produce a mock that the real app would silently ignore.
 */
export function dashState(input: StateInput = {}): DashboardState {
  const files = input.files ?? [];
  const sessions = { active: null, previous: [], ...input.sessions };
  const state: DashboardState = {
    v: 1,
    seq: input.seq ?? 1,
    now: input.now ?? NOW,
    enabled: input.enabled ?? true,
    settings: { ...DEFAULT_SETTINGS, ...input.settings },
    overview: { ...overviewOf(files, { activeSessions: sessions.active ? 1 : 0 }), ...input.overview },
    timeline: input.timeline ?? [],
    files,
    agents: input.agents ?? [API_ADAPTER],
    git: { state: 'ready', detail: '', repos: [], ...input.git },
    sessions,
    selection: { file: null, imports: [], importedBy: [], impact: null, ...input.selection },
    impacts: input.impacts ?? [],
    index: { state: 'idle', indexed: 0, total: 0, truncated: false, ...input.index },
    summary: input.summary ?? null,
  };
  const checked = parseDashboardHostMessage({ type: 'state', state: JSON.parse(JSON.stringify(state)) });
  if (checked === null) throw new Error('test mock is not a valid DashboardState (parseDashboardHostMessage returned null)');
  return state;
}

/** Wraps a state in the host message, as it arrives through window.postMessage (structured clone ~ JSON). */
export function hostMessage(state: DashboardState): unknown {
  return JSON.parse(JSON.stringify({ type: 'state', state }));
}

/** A rich, realistic state: every tab has something to show. Used by the interaction and mutation tests. */
export function busyState(o: StateInput = {}): DashboardState {
  const files = [
    activeRow('app.ts', 'src/dashboard', { changes: 14, sessionTitle: 'Refactor', impactLevel: 'high', dependants: 12 }),
    row('eventStore.ts', 'src/core', { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal', confidence: 0.95, ago: 40, changes: 9, review: 'unreviewed', sessionTitle: 'Refactor', impactLevel: 'medium', dependants: 4 }),
    row('schema.ts', 'src/core', { source: 'external', ago: 120, changes: 2, review: 'unreviewed' }),
    row('package.json', '', { source: 'git', method: 'git-state-change', confidence: 0.8, ago: 300, review: 'unreviewed', impactLevel: 'critical', dependants: 0 }),
    row('formatted.ts', 'src/core', { source: 'automated', method: 'workspace-edit', confidence: 0.6, ago: 600, changes: 4, review: 'reviewed' }),
    row('restored.ts', 'src/vscode', { source: 'unknown', method: 'restored', confidence: 0.2, ago: 3 * 3600, review: 'unreviewed' }),
    row('old-helper.ts', 'src/core', { source: 'external', method: 'disk-delete', lastEventType: 'delete', exists: false, ago: 2700, changes: 2, review: 'unreviewed' }),
    row('config.ts', 'src/core', { ago: 900, changes: 8, impactLevel: 'low', dependants: 1 }),
  ];
  const active = dashSession('s-active', 'Refactor dashboard', { activityCount: 25, fileCount: 8 });
  const previous = [dashSession('s-2', 'Fix the notifier', { status: 'completed', endedAt: NOW - 3 * HOUR, startedAt: NOW - 4 * HOUR, activityCount: 40, fileCount: 6, bySource: { developer: 30, 'ai-agent': 10 } })];
  return dashState({
    files,
    timeline: files.map((f, i) => timelineItem(f.name, f.dir, { id: `e${i}`, source: f.source, sourceId: f.sourceId, ago: (NOW - f.lastAt) / S, eventType: f.lastEventType, count: Math.min(f.changes, 3) })),
    sessions: { active, previous },
    git: {
      state: 'ready',
      repos: [
        repo('proj', {
          ahead: 2,
          behind: 1,
          staged: [change('package.json', '', 'modified')],
          unstaged: [change('app.ts', 'src/dashboard', 'modified'), change('old-helper.ts', 'src/core', 'deleted')],
          untracked: [change('notes.md', 'docs', 'untracked')],
        }),
      ],
    },
    selection: {
      file: ref('app.ts', 'src/dashboard'),
      imports: [dep('model.ts', 'src/dashboard', { count: 3 }), dep('protocol.ts', 'src/core/dashboard', { relationship: 'export' })],
      importedBy: [dep('main.ts', 'src/dashboard'), dep('app.test.ts', 'test', { isTest: true })],
      impact: impact('app.ts', 'src/dashboard', { level: 'high', reasons: ['12 files import this file directly.'], direct: 12 }),
    },
    impacts: [impact('app.ts', 'src/dashboard', { level: 'high', direct: 12 }), impact('package.json', '', { level: 'critical', direct: 0, indirect: 0, reasons: ['This is a project configuration file; changes can affect the whole workspace.'], affected: [] })],
    index: { state: 'ready', indexed: 1204, total: 1204, truncated: false },
    summary: { text: '8 files changed: 2 by you.', provider: 'local', at: NOW - 30 * S },
    ...o,
  });
}

/** `n` distinct rows for size tests. */
export function manyRows(n: number, o: RowOptions = {}): DashFileRow[] {
  const sources: ActivitySourceType[] = ['developer', 'ai-agent', 'external', 'git', 'automated', 'unknown'];
  return Array.from({ length: n }, (_, i) => row(`file${String(i).padStart(4, '0')}.ts`, `src/d${i % 12}`, { source: sources[i % sources.length] as ActivitySourceType, ago: i + 1, changes: 1 + (i % 7), ...o }));
}
