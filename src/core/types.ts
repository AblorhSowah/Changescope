/** All shared data types live here and only here. */

/** Normalised absolute POSIX path; drive letter lower-cased ("/home/u/p/a.ts", "c:/p/a.ts", UNC "//srv/share/a.ts"). */
export type FileKey = string;
export type EditSource = 'you' | 'external';
export type Phase = 'active' | 'idle';
export type Role = 'edited' | 'referenced';

export interface WorkspaceRoot {
  key: FileKey;
  name: string;
}

/** Shake parameters: px, ms, deg. */
export interface ShakeParams {
  amp: number;
  dur: number;
  rot: number;
}

export interface TrackedFile {
  key: FileKey;
  source: EditSource;
  phase: Phase;
  intensity: number;
  /** windowRate at now, even when idle */
  rate: number;
  firstEditAt: number;
  lastEditAt: number;
  editCount: number;
}

export interface ViewRow {
  id: FileKey;
  uri: string;
  name: string;
  dir: string;
  folderPath: string[];
  role: Role;
  /** which "user" this row is shown under: the writer of an edited row, or the writer whose file references a yellow row */
  actor: EditSource;
  /** null for referenced rows */
  source: EditSource | null;
  phase: Phase;
  intensity: number;
  shake: ShakeParams;
  /** 0 for edited rows */
  refCount: number;
  badge: string;
  tooltip: string;
}

export interface Snapshot {
  v: 1;
  seq: number;
  enabled: boolean;
  animate: boolean;
  /** '' = follow the theme colour */
  colors: { edited: string; referenced: string };
  rows: ViewRow[];
}

export interface DecorationSpec {
  role: Role;
  badge: string;
  tooltip: string;
  colorId: 'fileShake.editedForeground' | 'fileShake.referencedForeground';
  propagate: boolean;
}

/** Milliseconds clock. */
export interface Clock {
  now(): number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export type ClassifyReason =
  | 'no-content-change'
  | 'saving'
  | 'undo-redo'
  | 'reload-from-disk'
  | 'active-focused-edit'
  | 'background-edit'
  | 'disk-write'
  | 'self-save'
  | 'dedupe'
  | 'excluded'
  | 'burst'
  | 'scheme'
  | 'disabled'
  | 'external-detection-off'
  | 'paused';

export interface LogEntry {
  at: number;
  key: string;
  origin: 'doc' | 'watcher';
  decision: 'you' | 'external' | 'ignore';
  reason: ClassifyReason;
  weight: number;
}

// ---------------------------------------------------------------------------
// Reference detection types (DESIGN section 8). Re-exported from references/index.ts.
// ---------------------------------------------------------------------------

export type LanguageKey =
  | 'ts'
  | 'js'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'c'
  | 'cpp'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'markdown';

/** `imported`: a name, 'default' or '*'. `local` may be dotted (python "a.b.c"). */
export interface ImportBinding {
  local: string;
  imported: string;
}

export type ImportKind =
  | 'import'
  | 'export-from'
  | 'require'
  | 'dynamic'
  | 'include'
  | 'use'
  | 'mod'
  | 'link'
  | 'style-import'
  | 'markdown-link';

export interface ImportStatement {
  specifier: string;
  kind: ImportKind;
  /** 1-based */
  line: number;
  /** 1-based, inclusive */
  endLine: number;
  bindings: ImportBinding[];
  typeOnly: boolean;
  /** python leading dots; ruby `require_relative` and php `__DIR__ .` use 1 as a "relative to this file" marker; else 0 */
  relativeLevel: number;
  /** C `<...>` */
  angle: boolean;
  /** java static import */
  isStatic: boolean;
}

export interface ScanResult {
  /** same length as the input; comments and string contents replaced by spaces, newlines kept */
  masked: string;
  /** offset of each opening quote -> raw string contents */
  strings: ReadonlyMap<number, string>;
}

export interface ProbeFs {
  isFile(p: FileKey): Promise<boolean>;
  /** names; [] if missing */
  listDir(p: FileKey): Promise<string[]>;
  readText(p: FileKey, maxBytes: number): Promise<string | undefined>;
}

export interface ProjectInfo {
  roots: FileKey[];
  tsconfig?: { dir: FileKey; baseUrl?: FileKey; paths: Record<string, string[]> };
  goModule?: { dir: FileKey; modulePath: string };
  psr4?: Record<string, FileKey[]>;
}

/** python `from pkg import a, b` can yield several targets, each with its own bindings. */
export interface ResolvedTarget {
  key: FileKey;
  bindings: readonly ImportBinding[];
}

export interface ResolveContext {
  fs: ProbeFs;
  project: ProjectInfo;
  isExcluded(key: FileKey): boolean;
  budget: { probes: number };
  memo: Map<string, boolean>;
  /** java/kotlin: package of the analysed file, if already known (avoids re-reading it) */
  packageName?: string | undefined;
}

export interface ReferenceTarget {
  key: FileKey;
  count: number;
  statements: number;
  usages: number;
  lines: number[];
  specifiers: string[];
  /** kinds of the statements that produced this target (0.3.0, used for dependency relationship types) */
  kinds?: ImportKind[];
}

export interface ReferenceResult {
  source: FileKey;
  language: LanguageKey | undefined;
  targets: ReferenceTarget[];
  truncated: boolean;
  unresolved: number;
  skipped?: 'unsupported-language' | 'too-large' | 'binary' | 'unreadable' | 'excluded';
  parseMs: number;
}

export interface AnalyzeInput {
  path: FileKey;
  languageId: string;
  text: string;
  fs: ProbeFs;
  project: ProjectInfo;
  isExcluded(key: FileKey): boolean;
  now?: () => number;
  maxFileSizeKb?: number;
}

// ---------------------------------------------------------------------------
// 0.3.0: activity intelligence, sessions, dependencies, dashboard (docs/DESIGN-0.3.0.md).
// ---------------------------------------------------------------------------

export type ActivitySourceType = 'developer' | 'ai-agent' | 'external' | 'git' | 'automated' | 'unknown';
export type ActivityEventType = 'create' | 'modify' | 'delete';
export type ReviewStatus = 'reviewed' | 'unreviewed';
/** How a source was decided. Never free text, so it can be shown and tested. */
export type DetectionMethod =
  | 'focused-editor-edit'
  | 'undo-redo'
  | 'workbench-file-operation'
  | 'workspace-edit'
  | 'disk-write'
  | 'reload-from-disk'
  | 'disk-delete'
  | 'git-state-change'
  | 'agent-signal'
  | 'restored';

export interface ActivityEvent {
  id: string;
  /** opaque id of the workspace (never a path) */
  workspaceId: string;
  sessionId?: string;
  filePath: FileKey;
  eventType: ActivityEventType;
  sourceType: ActivitySourceType;
  /** e.g. the agent name reported by an adapter */
  sourceId?: string;
  detectionMethod: DetectionMethod;
  /** 0..1: how sure the classifier is about `sourceType` */
  confidence: number;
  /** first occurrence (ms) */
  timestamp: number;
  /** last occurrence merged into this event (ms); equals `timestamp` when `count` is 1 */
  lastTimestamp: number;
  /** occurrences merged into this event (rapid successive changes of one file by one source) */
  count: number;
  /** absent for developer events: your own typing needs no review */
  reviewStatus?: ReviewStatus;
}

export type SessionStatus = 'active' | 'paused' | 'completed';

export interface GitContext {
  branch?: string;
  /** full commit id */
  commit?: string;
}

export interface DevelopmentSession {
  id: string;
  title: string;
  workspaceId: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  activityCount: number;
  modifiedFiles: FileKey[];
  sources: Partial<Record<ActivitySourceType, number>>;
  gitStart?: GitContext;
  gitEnd?: GitContext;
}

export type RelationshipType = 'import' | 'export' | 'reference' | 'inheritance' | 'unknown';

export interface DependencyRelationship {
  sourceFile: FileKey;
  targetFile: FileKey;
  relationshipType: RelationshipType;
  language: string;
  confidence: number;
}

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ChangeImpact {
  filePath: FileKey;
  directDependants: FileKey[];
  indirectDependants: FileKey[];
  /** direct + indirect, capped */
  affectedFiles: FileKey[];
  affectedTests: FileKey[];
  configFiles: FileKey[];
  impactLevel: ImpactLevel;
  /** plain sentences that explain the level; an estimate, never a confirmed defect */
  reasons: string[];
  /** false while the dependency index is still being built or was truncated */
  complete: boolean;
  analysedAt: number;
}

export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'other';

export type ViewMode = 'live' | 'compact' | 'impact';

// ---- dashboard state: everything is display-ready, the webview holds no business logic ----

export interface DashFileRef {
  id: FileKey;
  name: string;
  dir: string;
}

export interface DashFileRow extends DashFileRef {
  source: ActivitySourceType;
  sourceId: string | null;
  method: DetectionMethod;
  confidence: number;
  lastEventType: ActivityEventType;
  firstAt: number;
  lastAt: number;
  /** total occurrences in the kept history */
  changes: number;
  /** active = receiving changes right now */
  phase: Phase;
  intensity: number;
  shake: ShakeParams;
  sessionTitle: string | null;
  /** null for developer changes */
  review: ReviewStatus | null;
  /** false after a delete */
  exists: boolean;
  /** null = not analysed yet */
  impactLevel: ImpactLevel | null;
  dependants: number | null;
}

export interface DashTimelineItem {
  id: string;
  fileId: FileKey;
  name: string;
  dir: string;
  source: ActivitySourceType;
  sourceId: string | null;
  eventType: ActivityEventType;
  at: number;
  count: number;
  sessionTitle: string | null;
}

export interface DashOverview {
  modifiedFiles: number;
  bySource: Record<ActivitySourceType, number>;
  unreviewed: number;
  activeSessions: number;
  events: number;
}

export interface DashAgentAdapter {
  id: string;
  label: string;
  state: 'listening' | 'off' | 'unavailable';
  detail: string;
}

export interface DashGitChange extends DashFileRef {
  status: GitChangeStatus;
}

export interface DashGitRepo {
  id: FileKey;
  name: string;
  branch: string | null;
  /** short commit id */
  commit: string | null;
  ahead: number;
  behind: number;
  staged: DashGitChange[];
  unstaged: DashGitChange[];
  untracked: DashGitChange[];
  truncated: boolean;
}

export interface DashGit {
  state: 'ready' | 'loading' | 'unavailable' | 'disabled';
  detail: string;
  repos: DashGitRepo[];
}

export interface DashSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  activityCount: number;
  fileCount: number;
  bySource: Partial<Record<ActivitySourceType, number>>;
  branch: string | null;
}

export interface DashDep extends DashFileRef {
  relationship: RelationshipType;
  count: number;
  isTest: boolean;
}

export interface DashImpact {
  file: DashFileRef;
  level: ImpactLevel;
  reasons: string[];
  direct: number;
  indirect: number;
  affected: DashFileRef[];
  tests: DashFileRef[];
  configs: DashFileRef[];
  complete: boolean;
  analysedAt: number;
}

export interface DashIndexStatus {
  state: 'off' | 'idle' | 'indexing' | 'ready';
  indexed: number;
  total: number;
  truncated: boolean;
}

export interface DashSelection {
  file: DashFileRef | null;
  imports: DashDep[];
  importedBy: DashDep[];
  impact: DashImpact | null;
}

export interface DashSettings {
  mode: ViewMode;
  animate: boolean;
  animationIntensity: number;
  paused: boolean;
  collisions: boolean;
  dependencyIndex: boolean;
  gitEnabled: boolean;
  historyLimit: number;
  retentionDays: number;
  aiMode: 'local' | 'assisted';
  /** id of the registered provider in use, null in local mode or when none is registered */
  aiProvider: string | null;
}

export interface DashSummary {
  text: string;
  /** 'local' or a provider id */
  provider: string;
  at: number;
}

export interface DashboardState {
  v: 1;
  seq: number;
  /** host clock (ms) when the state was built; relative times are computed against it */
  now: number;
  enabled: boolean;
  settings: DashSettings;
  overview: DashOverview;
  timeline: DashTimelineItem[];
  files: DashFileRow[];
  agents: DashAgentAdapter[];
  git: DashGit;
  sessions: { active: DashSession | null; previous: DashSession[] };
  selection: DashSelection;
  impacts: DashImpact[];
  index: DashIndexStatus;
  summary: DashSummary | null;
}
