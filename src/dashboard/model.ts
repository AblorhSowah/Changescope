import type { DashboardWebviewMessage } from '../core/dashboard/protocol';
import type { DashboardState, ViewMode } from '../core/types';

export type TabId = 'overview' | 'activity' | 'code' | 'git' | 'sessions' | 'settings';
export type FilterId = 'live' | 'mine' | 'external' | 'ai' | 'all';
export type CodeViewId = 'dependencies' | 'impact';

/** What survives a hide / show of the webview (vscode.setState). Nothing here is data, only where the user was. */
export interface DashPersisted {
  tab: TabId;
  activityFilter: FilterId;
  codeView: CodeViewId;
}

export interface DashHostApi {
  postMessage(m: DashboardWebviewMessage): void;
  getState(): DashPersisted | undefined;
  setState(s: DashPersisted): void;
}

export interface AppEnv {
  reducedMotion(): boolean;
  onReducedMotionChange(cb: () => void): () => void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface DashApp {
  handleMessage(raw: unknown): void;
  dispose(): void;
  readonly lastSeq: number;
}

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'code', label: 'Code' },
  { id: 'git', label: 'Git' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'settings', label: 'Settings' },
];

export const FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'mine', label: 'Mine' },
  { id: 'external', label: 'External' },
  { id: 'ai', label: 'AI agents' },
  { id: 'all', label: 'All' },
];

export const CODE_VIEWS: ReadonlyArray<{ id: CodeViewId; label: string }> = [
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'impact', label: 'Impact' },
];

export const DEFAULT_PERSISTED: DashPersisted = { tab: 'overview', activityFilter: 'all', codeView: 'dependencies' };

export function isTabId(v: unknown): v is TabId {
  return TABS.some((t) => t.id === v);
}

export function isFilterId(v: unknown): v is FilterId {
  return FILTERS.some((f) => f.id === v);
}

export function isCodeViewId(v: unknown): v is CodeViewId {
  return CODE_VIEWS.some((c) => c.id === v);
}

/** Total: anything that is not a valid field falls back to its default. Never throws. */
export function parsePersisted(raw: unknown): DashPersisted {
  const out: DashPersisted = { ...DEFAULT_PERSISTED };
  if (typeof raw !== 'object' || raw === null) return out;
  if ('tab' in raw && isTabId(raw.tab)) out.tab = raw.tab;
  if ('activityFilter' in raw && isFilterId(raw.activityFilter)) out.activityFilter = raw.activityFilter;
  if ('codeView' in raw && isCodeViewId(raw.codeView)) out.codeView = raw.codeView;
  return out;
}

/** Everything a view needs for one render. Views keep no copy of it: the next frame replaces it. */
export interface Frame {
  state: DashboardState;
  /** host clock of the state; every relative time is computed against it */
  now: number;
  mode: ViewMode;
  /** value of data-motion: animation on, not compact mode, no reduced motion */
  motion: boolean;
  /** rows may shake: `motion` and live mode */
  shake: boolean;
  /** the operating system asks for reduced motion */
  reducedMotion: boolean;
  ui: DashPersisted;
  /** false when the newest event of that file is a delete; unknown files count as existing */
  exists(id: string): boolean;
  /** the file has an uncommitted change that Git can show */
  hasDiff(id: string): boolean;
}

export interface View {
  readonly el: HTMLElement;
  render(f: Frame): void;
}
