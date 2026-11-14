import type {
  ActivityEventType,
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
  DashSummary,
  DashTimelineItem,
  DashboardState,
  DetectionMethod,
  GitChangeStatus,
  ImpactLevel,
  Phase,
  RelationshipType,
  ReviewStatus,
  SessionStatus,
  ShakeParams,
  ViewMode,
} from '../types';

/**
 * Message contract between the extension host and the dashboard webview (DESIGN-0.3.0 section 7).
 * Both directions are deep-validated; a malformed message is dropped (null), never thrown on.
 * The webview can only name things by id: the host resolves ids against the last state it sent.
 */

export const DASHBOARD_PROTOCOL_VERSION = 1;

export type DashboardHostMessage = { type: 'state'; state: DashboardState };

export type DashboardWebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'openDiff'; id: string }
  | { type: 'select'; id: string }
  | { type: 'setMode'; mode: ViewMode }
  | { type: 'setAnimate'; value: boolean }
  | { type: 'setPaused'; value: boolean }
  | { type: 'markReviewed'; id: string }
  | { type: 'markAllReviewed' }
  | { type: 'sessionStart'; title: string }
  | { type: 'sessionStop' }
  | { type: 'sessionRename'; id: string; title: string }
  | { type: 'sessionExport'; id: string }
  | { type: 'clearHistory' }
  | { type: 'openSettings' }
  | { type: 'summarize' }
  | { type: 'error'; message: string };

export const DASH_LIMITS = {
  FILES: 300,
  TIMELINE: 100,
  GIT_CHANGES: 200,
  REPOS: 20,
  SESSIONS: 50,
  DEPS: 200,
  IMPACTS: 50,
  IMPACT_FILES: 50,
  REASONS: 12,
  AGENTS: 12,
  STRING: 10_000,
  TITLE: 120,
  ERROR: 500,
} as const;

export const SOURCE_TYPES: readonly ActivitySourceType[] = ['developer', 'ai-agent', 'external', 'git', 'automated', 'unknown'];
export const EVENT_TYPES: readonly ActivityEventType[] = ['create', 'modify', 'delete'];
export const DETECTION_METHODS: readonly DetectionMethod[] = [
  'focused-editor-edit',
  'undo-redo',
  'workbench-file-operation',
  'workspace-edit',
  'disk-write',
  'reload-from-disk',
  'disk-delete',
  'git-state-change',
  'agent-signal',
  'restored',
];
export const VIEW_MODES: readonly ViewMode[] = ['live', 'compact', 'impact'];
export const IMPACT_LEVELS: readonly ImpactLevel[] = ['low', 'medium', 'high', 'critical'];
export const RELATIONSHIP_TYPES: readonly RelationshipType[] = ['import', 'export', 'reference', 'inheritance', 'unknown'];
export const GIT_STATUSES: readonly GitChangeStatus[] = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'other'];
export const SESSION_STATUSES: readonly SessionStatus[] = ['active', 'paused', 'completed'];

type Obj = Record<string, unknown>;

/** Thrown internally by the field readers; caught at the two public entry points. */
class Invalid extends Error {}

function fail(): never {
  throw new Invalid('invalid');
}

function obj(v: unknown): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail();
  return v as Obj;
}

function str(v: unknown, max: number = DASH_LIMITS.STRING): string {
  if (typeof v !== 'string' || v.length > max) fail();
  return v;
}

function strOrNull(v: unknown, max: number = DASH_LIMITS.STRING): string | null {
  return v === null ? null : str(v, max);
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail();
  return v;
}

function count(v: unknown): number {
  const n = num(v);
  if (n < 0) fail();
  return n;
}

function unit(v: unknown): number {
  const n = num(v);
  if (n < 0 || n > 1) fail();
  return n;
}

function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') fail();
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail();
  return v as T;
}

function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return v === null ? null : oneOf(v, allowed);
}

function list<T>(v: unknown, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) fail();
  const out: T[] = [];
  for (let i = 0; i < v.length; i += 1) {
    // a hole is not an item: `map` would skip it and the item validator would never see it
    if (!(i in v)) fail();
    out.push(item(v[i]));
  }
  return out;
}

function fileRef(v: unknown): DashFileRef {
  const o = obj(v);
  return { id: str(o['id']), name: str(o['name']), dir: str(o['dir']) };
}

function shake(v: unknown): ShakeParams {
  const o = obj(v);
  return { amp: num(o['amp']), dur: num(o['dur']), rot: num(o['rot']) };
}

function sourceCounts(v: unknown, complete: boolean): Partial<Record<ActivitySourceType, number>> {
  const o = obj(v);
  const out: Partial<Record<ActivitySourceType, number>> = {};
  for (const s of SOURCE_TYPES) {
    if (o[s] === undefined) {
      if (complete) fail();
      continue;
    }
    out[s] = count(o[s]);
  }
  return out;
}

function fileRow(v: unknown): DashFileRow {
  const o = obj(v);
  return {
    ...fileRef(o),
    source: oneOf(o['source'], SOURCE_TYPES),
    sourceId: strOrNull(o['sourceId']),
    method: oneOf(o['method'], DETECTION_METHODS),
    confidence: unit(o['confidence']),
    lastEventType: oneOf(o['lastEventType'], EVENT_TYPES),
    firstAt: num(o['firstAt']),
    lastAt: num(o['lastAt']),
    changes: count(o['changes']),
    phase: oneOf<Phase>(o['phase'], ['active', 'idle']),
    intensity: unit(o['intensity']),
    shake: shake(o['shake']),
    sessionTitle: strOrNull(o['sessionTitle']),
    review: oneOfOrNull<ReviewStatus>(o['review'], ['reviewed', 'unreviewed']),
    exists: bool(o['exists']),
    impactLevel: oneOfOrNull(o['impactLevel'], IMPACT_LEVELS),
    dependants: o['dependants'] === null ? null : count(o['dependants']),
  };
}

function timelineItem(v: unknown): DashTimelineItem {
  const o = obj(v);
  return {
    id: str(o['id']),
    fileId: str(o['fileId']),
    name: str(o['name']),
    dir: str(o['dir']),
    source: oneOf(o['source'], SOURCE_TYPES),
    sourceId: strOrNull(o['sourceId']),
    eventType: oneOf(o['eventType'], EVENT_TYPES),
    at: num(o['at']),
    count: count(o['count']),
    sessionTitle: strOrNull(o['sessionTitle']),
  };
}

function overview(v: unknown): DashOverview {
  const o = obj(v);
  return {
    modifiedFiles: count(o['modifiedFiles']),
    bySource: sourceCounts(o['bySource'], true) as Record<ActivitySourceType, number>,
    unreviewed: count(o['unreviewed']),
    activeSessions: count(o['activeSessions']),
    events: count(o['events']),
  };
}

function agent(v: unknown): DashAgentAdapter {
  const o = obj(v);
  return {
    id: str(o['id']),
    label: str(o['label']),
    state: oneOf(o['state'], ['listening', 'off', 'unavailable'] as const),
    detail: str(o['detail']),
  };
}

function gitChange(v: unknown): DashGitChange {
  const o = obj(v);
  return { ...fileRef(o), status: oneOf(o['status'], GIT_STATUSES) };
}

function gitRepo(v: unknown): DashGitRepo {
  const o = obj(v);
  return {
    id: str(o['id']),
    name: str(o['name']),
    branch: strOrNull(o['branch']),
    commit: strOrNull(o['commit']),
    ahead: count(o['ahead']),
    behind: count(o['behind']),
    staged: list(o['staged'], DASH_LIMITS.GIT_CHANGES, gitChange),
    unstaged: list(o['unstaged'], DASH_LIMITS.GIT_CHANGES, gitChange),
    untracked: list(o['untracked'], DASH_LIMITS.GIT_CHANGES, gitChange),
    truncated: bool(o['truncated']),
  };
}

function git(v: unknown): DashGit {
  const o = obj(v);
  return {
    state: oneOf(o['state'], ['ready', 'loading', 'unavailable', 'disabled'] as const),
    detail: str(o['detail']),
    repos: list(o['repos'], DASH_LIMITS.REPOS, gitRepo),
  };
}

function session(v: unknown): DashSession {
  const o = obj(v);
  return {
    id: str(o['id']),
    title: str(o['title']),
    startedAt: num(o['startedAt']),
    endedAt: o['endedAt'] === null ? null : num(o['endedAt']),
    status: oneOf(o['status'], SESSION_STATUSES),
    activityCount: count(o['activityCount']),
    fileCount: count(o['fileCount']),
    bySource: sourceCounts(o['bySource'], false),
    branch: strOrNull(o['branch']),
  };
}

function dep(v: unknown): DashDep {
  const o = obj(v);
  return {
    ...fileRef(o),
    relationship: oneOf(o['relationship'], RELATIONSHIP_TYPES),
    count: count(o['count']),
    isTest: bool(o['isTest']),
  };
}

function impact(v: unknown): DashImpact {
  const o = obj(v);
  return {
    file: fileRef(o['file']),
    level: oneOf(o['level'], IMPACT_LEVELS),
    reasons: list(o['reasons'], DASH_LIMITS.REASONS, (x) => str(x)),
    direct: count(o['direct']),
    indirect: count(o['indirect']),
    affected: list(o['affected'], DASH_LIMITS.IMPACT_FILES, fileRef),
    tests: list(o['tests'], DASH_LIMITS.IMPACT_FILES, fileRef),
    configs: list(o['configs'], DASH_LIMITS.IMPACT_FILES, fileRef),
    complete: bool(o['complete']),
    analysedAt: num(o['analysedAt']),
  };
}

function indexStatus(v: unknown): DashIndexStatus {
  const o = obj(v);
  return {
    state: oneOf(o['state'], ['off', 'idle', 'indexing', 'ready'] as const),
    indexed: count(o['indexed']),
    total: count(o['total']),
    truncated: bool(o['truncated']),
  };
}

function selection(v: unknown): DashSelection {
  const o = obj(v);
  return {
    file: o['file'] === null ? null : fileRef(o['file']),
    imports: list(o['imports'], DASH_LIMITS.DEPS, dep),
    importedBy: list(o['importedBy'], DASH_LIMITS.DEPS, dep),
    impact: o['impact'] === null ? null : impact(o['impact']),
  };
}

function settings(v: unknown): DashSettings {
  const o = obj(v);
  return {
    mode: oneOf(o['mode'], VIEW_MODES),
    animate: bool(o['animate']),
    animationIntensity: count(o['animationIntensity']),
    paused: bool(o['paused']),
    collisions: bool(o['collisions']),
    dependencyIndex: bool(o['dependencyIndex']),
    gitEnabled: bool(o['gitEnabled']),
    historyLimit: count(o['historyLimit']),
    retentionDays: count(o['retentionDays']),
    aiMode: oneOf(o['aiMode'], ['local', 'assisted'] as const),
    aiProvider: strOrNull(o['aiProvider']),
  };
}

function summary(v: unknown): DashSummary {
  const o = obj(v);
  return { text: str(o['text']), provider: str(o['provider']), at: num(o['at']) };
}

/** Deep-validates a message from the extension host. Returns a fresh object, or null when malformed. Never throws. */
export function parseDashboardHostMessage(raw: unknown): DashboardHostMessage | null {
  try {
    const m = obj(raw);
    if (m['type'] !== 'state') return null;
    const s = obj(m['state']);
    if (s['v'] !== DASHBOARD_PROTOCOL_VERSION) return null;
    const sessions = obj(s['sessions']);
    const state: DashboardState = {
      v: 1,
      seq: num(s['seq']),
      now: num(s['now']),
      enabled: bool(s['enabled']),
      settings: settings(s['settings']),
      overview: overview(s['overview']),
      timeline: list(s['timeline'], DASH_LIMITS.TIMELINE, timelineItem),
      files: list(s['files'], DASH_LIMITS.FILES, fileRow),
      agents: list(s['agents'], DASH_LIMITS.AGENTS, agent),
      git: git(s['git']),
      sessions: {
        active: sessions['active'] === null ? null : session(sessions['active']),
        previous: list(sessions['previous'], DASH_LIMITS.SESSIONS, session),
      },
      selection: selection(s['selection']),
      impacts: list(s['impacts'], DASH_LIMITS.IMPACTS, impact),
      index: indexStatus(s['index']),
      summary: s['summary'] === null ? null : summary(s['summary']),
    };
    return { type: 'state', state };
  } catch {
    return null;
  }
}

/** Removes control characters, collapses whitespace, trims and caps a user-typed session title. */
export function cleanTitle(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 (U+0000 to U+001F), DEL and C1 (U+0080 to U+009F) are all category Cc
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, DASH_LIMITS.TITLE);
}

/** Validates a message from the dashboard webview. Titles are cleaned, `error` text is truncated. Never throws. */
export function parseDashboardWebviewMessage(raw: unknown): DashboardWebviewMessage | null {
  try {
    const m = obj(raw);
    // read once: the type that is checked is the type that is returned
    const type = m['type'];
    switch (type) {
      case 'ready':
      case 'markAllReviewed':
      case 'sessionStop':
      case 'clearHistory':
      case 'openSettings':
      case 'summarize':
        return { type };
      case 'open':
      case 'openDiff':
      case 'select':
      case 'markReviewed':
      case 'sessionExport':
        return { type, id: str(m['id']) };
      case 'setMode':
        return { type: 'setMode', mode: oneOf(m['mode'], VIEW_MODES) };
      case 'setAnimate':
      case 'setPaused':
        return { type, value: bool(m['value']) };
      case 'sessionStart':
        return { type: 'sessionStart', title: cleanTitle(str(m['title'])) };
      case 'sessionRename': {
        const title = cleanTitle(str(m['title']));
        if (title === '') return null;
        return { type: 'sessionRename', id: str(m['id']), title };
      }
      case 'error': {
        const text = m['message'];
        return typeof text === 'string' ? { type: 'error', message: text.slice(0, DASH_LIMITS.ERROR) } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
