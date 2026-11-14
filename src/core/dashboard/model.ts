import type { FileActivity } from '../activity/eventStore';
import type { RepoSnapshot } from '../git/gitModel';
import type { DepEdge } from '../intelligence/depGraph';
import { isTestFile } from '../intelligence/testMatch';
import { clamp01, scaleShake, shakeParams } from '../intensity';
import { toDisplayPath } from '../pathUtils';
import type {
  ActivityEvent,
  ActivitySourceType,
  ChangeImpact,
  DashAgentAdapter,
  DashDep,
  DashFileRef,
  DashFileRow,
  DashGit,
  DashGitChange,
  DashGitRepo,
  DashImpact,
  DashIndexStatus,
  DashSelection,
  DashSession,
  DashSettings,
  DashSummary,
  DashTimelineItem,
  DashboardState,
  DevelopmentSession,
  FileKey,
  Phase,
  WorkspaceRoot,
} from '../types';
import { DASH_LIMITS, SOURCE_TYPES } from './protocol';

/** What the tracker knows about a file that is shaking (or just stopped). */
export interface FileLiveState {
  phase: Phase;
  intensity: number;
}

export interface SelectionInput {
  file: FileKey | undefined;
  imports: readonly DepEdge[];
  importedBy: readonly DepEdge[];
  impact: ChangeImpact | undefined;
}

/** Plain data only: the builder reads no clock, no store and no file system. */
export interface DashboardInput {
  now: number;
  seq: number;
  enabled: boolean;
  roots: readonly WorkspaceRoot[];
  /** one entry per file of the kept history, newest first (`EventStore.files()`) */
  files: readonly FileActivity[];
  live: ReadonlyMap<FileKey, FileLiveState>;
  /** newest first */
  events: readonly ActivityEvent[];
  eventCount: number;
  unreviewed: number;
  sessions: readonly DevelopmentSession[];
  git: { state: DashGit['state']; detail: string; repos: readonly RepoSnapshot[] };
  selection: SelectionInput;
  impacts: ReadonlyMap<FileKey, ChangeImpact>;
  index: DashIndexStatus;
  settings: DashSettings;
  agents: readonly DashAgentAdapter[];
  summary: DashSummary | null;
}

function cap(s: string, max: number = DASH_LIMITS.STRING): string {
  return s.length <= max ? s : s.slice(0, max);
}

function ref(key: FileKey, roots: readonly WorkspaceRoot[]): DashFileRef {
  const d = toDisplayPath(key, roots);
  return { id: cap(key), name: cap(d.name), dir: cap(d.dir) };
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** A count: finite and never negative. */
function nat(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dashSettings(s: DashSettings): DashSettings {
  return {
    ...s,
    animationIntensity: nat(s.animationIntensity),
    historyLimit: nat(s.historyLimit),
    retentionDays: nat(s.retentionDays),
  };
}

function dashIndex(i: DashIndexStatus): DashIndexStatus {
  return { ...i, indexed: nat(i.indexed), total: nat(i.total) };
}

function dashImpact(i: ChangeImpact, roots: readonly WorkspaceRoot[]): DashImpact {
  return {
    file: ref(i.filePath, roots),
    level: i.impactLevel,
    reasons: i.reasons.slice(0, DASH_LIMITS.REASONS).map((r) => cap(r)),
    direct: i.directDependants.length,
    indirect: i.indirectDependants.length,
    affected: i.affectedFiles.slice(0, DASH_LIMITS.IMPACT_FILES).map((k) => ref(k, roots)),
    tests: i.affectedTests.slice(0, DASH_LIMITS.IMPACT_FILES).map((k) => ref(k, roots)),
    configs: i.configFiles.slice(0, DASH_LIMITS.IMPACT_FILES).map((k) => ref(k, roots)),
    complete: i.complete,
    analysedAt: finite(i.analysedAt),
  };
}

function dep(e: DepEdge, roots: readonly WorkspaceRoot[]): DashDep {
  return {
    ...ref(e.key, roots),
    relationship: e.relationshipType,
    count: nat(e.count),
    isTest: isTestFile(e.key, roots.map((r) => r.key)),
  };
}

function gitChange(c: { key: FileKey; status: DashGitChange['status'] }, roots: readonly WorkspaceRoot[]): DashGitChange {
  return { ...ref(c.key, roots), status: c.status };
}

function gitRepo(r: RepoSnapshot, roots: readonly WorkspaceRoot[]): DashGitRepo {
  const lists = [r.staged, r.unstaged, r.untracked];
  return {
    id: cap(r.root),
    name: cap(r.name),
    branch: r.branch === undefined ? null : cap(r.branch),
    commit: r.commit === undefined ? null : r.commit.slice(0, 7),
    ahead: nat(r.ahead),
    behind: nat(r.behind),
    staged: r.staged.slice(0, DASH_LIMITS.GIT_CHANGES).map((c) => gitChange(c, roots)),
    unstaged: r.unstaged.slice(0, DASH_LIMITS.GIT_CHANGES).map((c) => gitChange(c, roots)),
    untracked: r.untracked.slice(0, DASH_LIMITS.GIT_CHANGES).map((c) => gitChange(c, roots)),
    truncated: r.truncated || lists.some((l) => l.length > DASH_LIMITS.GIT_CHANGES),
  };
}

function dashSession(s: DevelopmentSession): DashSession {
  const bySource: DashSession['bySource'] = {};
  for (const t of SOURCE_TYPES) {
    const n = s.sources[t];
    if (n !== undefined && n > 0) bySource[t] = n;
  }
  const branch = s.gitEnd?.branch ?? s.gitStart?.branch;
  return {
    id: cap(s.id),
    title: cap(s.title, DASH_LIMITS.TITLE),
    startedAt: finite(s.startedAt),
    endedAt: s.endedAt === undefined ? null : finite(s.endedAt),
    status: s.status,
    activityCount: nat(s.activityCount),
    fileCount: s.modifiedFiles.length,
    bySource,
    branch: branch === undefined ? null : cap(branch),
  };
}

/**
 * Builds the complete, display-ready state of the dashboard (DESIGN-0.3.0 section 11.1). Pure: the same
 * input always gives the same output, every list is capped by `DASH_LIMITS`, and every number is finite.
 */
export function buildDashboardState(i: DashboardInput): DashboardState {
  const sessionTitles = new Map<string, string>();
  for (const s of i.sessions) sessionTitles.set(s.id, cap(s.title, DASH_LIMITS.TITLE));

  const bySource = Object.fromEntries(SOURCE_TYPES.map((t) => [t, 0])) as Record<ActivitySourceType, number>;
  for (const f of i.files) bySource[f.sourceType] += 1;

  // active files first, then by the time of the last change
  const ordered = i.files
    .map((f, index) => ({ f, index, active: i.live.get(f.key)?.phase === 'active' }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.f.lastAt - a.f.lastAt || a.index - b.index)
    .slice(0, DASH_LIMITS.FILES);

  const files: DashFileRow[] = ordered.map(({ f }) => {
    const live = i.live.get(f.key);
    const intensity = live?.phase === 'active' ? clamp01(live.intensity) : 0;
    const impact = i.impacts.get(f.key);
    return {
      ...ref(f.key, i.roots),
      source: f.sourceType,
      sourceId: f.sourceId === undefined ? null : cap(f.sourceId),
      method: f.detectionMethod,
      confidence: clamp01(f.confidence),
      lastEventType: f.lastEventType,
      firstAt: finite(f.firstAt),
      lastAt: finite(f.lastAt),
      changes: nat(f.changes),
      phase: live?.phase ?? 'idle',
      intensity,
      shake: scaleShake(shakeParams(intensity), i.settings.animationIntensity),
      sessionTitle: f.sessionId === undefined ? null : (sessionTitles.get(f.sessionId) ?? null),
      review: f.review ?? null,
      exists: f.exists,
      impactLevel: impact?.impactLevel ?? null,
      dependants: impact === undefined ? null : impact.directDependants.length + impact.indirectDependants.length,
    };
  });

  const timeline: DashTimelineItem[] = i.events.slice(0, DASH_LIMITS.TIMELINE).map((e) => {
    const r = ref(e.filePath, i.roots);
    return {
      id: cap(e.id),
      fileId: r.id,
      name: r.name,
      dir: r.dir,
      source: e.sourceType,
      sourceId: e.sourceId === undefined ? null : cap(e.sourceId),
      eventType: e.eventType,
      at: finite(e.lastTimestamp),
      count: nat(e.count),
      sessionTitle: e.sessionId === undefined ? null : (sessionTitles.get(e.sessionId) ?? null),
    };
  });

  const sessions = [...i.sessions].sort((a, b) => b.startedAt - a.startedAt);
  const active = sessions.find((s) => s.status === 'active');
  const previous = sessions.filter((s) => s !== active).slice(0, DASH_LIMITS.SESSIONS);

  const selected = i.selection.file;
  const selection: DashSelection =
    selected === undefined
      ? { file: null, imports: [], importedBy: [], impact: null }
      : {
          file: ref(selected, i.roots),
          imports: i.selection.imports.slice(0, DASH_LIMITS.DEPS).map((e) => dep(e, i.roots)),
          importedBy: i.selection.importedBy.slice(0, DASH_LIMITS.DEPS).map((e) => dep(e, i.roots)),
          impact: i.selection.impact === undefined ? null : dashImpact(i.selection.impact, i.roots),
        };

  const impacts = [...i.impacts.values()]
    .sort((a, b) => b.analysedAt - a.analysedAt || (a.filePath < b.filePath ? -1 : 1))
    .slice(0, DASH_LIMITS.IMPACTS)
    .map((x) => dashImpact(x, i.roots));

  return {
    v: 1,
    seq: finite(i.seq),
    now: finite(i.now),
    enabled: i.enabled,
    settings: dashSettings(i.settings),
    overview: {
      modifiedFiles: i.files.length,
      bySource,
      unreviewed: nat(i.unreviewed),
      activeSessions: active === undefined ? 0 : 1,
      events: nat(i.eventCount),
    },
    timeline,
    files,
    agents: i.agents.slice(0, DASH_LIMITS.AGENTS).map((a) => ({ ...a, id: cap(a.id), label: cap(a.label), detail: cap(a.detail) })),
    git: {
      state: i.git.state,
      detail: cap(i.git.detail),
      repos: i.git.repos.slice(0, DASH_LIMITS.REPOS).map((r) => gitRepo(r, i.roots)),
    },
    sessions: { active: active === undefined ? null : dashSession(active), previous: previous.map(dashSession) },
    selection,
    impacts,
    index: dashIndex(i.index),
    summary: i.summary === null ? null : { ...i.summary, text: cap(i.summary.text), at: finite(i.summary.at) },
  };
}

/**
 * Identity of a state for "did anything change": everything except the sequence number and the clock,
 * which differ on every build. The webview formats relative times itself, so an unchanged state is not re-posted.
 */
export function stateSignature(s: DashboardState): string {
  return JSON.stringify({ ...s, seq: 0, now: 0 });
}
