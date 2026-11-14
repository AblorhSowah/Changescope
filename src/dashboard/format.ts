import type {
  ActivityEventType,
  ActivitySourceType,
  DashFileRef,
  DashFileRow,
  DetectionMethod,
  GitChangeStatus,
  ImpactLevel,
  RelationshipType,
  ViewMode,
} from '../core/types';

/** Pure display formatting. No clock is read here: ages are always measured against the host's `now`. */

export const SOURCE_LABEL: Readonly<Record<ActivitySourceType, string>> = {
  developer: 'Developer',
  'ai-agent': 'AI agent',
  external: 'External',
  git: 'Git',
  automated: 'Automated',
  unknown: 'Unknown',
};

/** What each source label means, shown as a tooltip. States the limit of the detection, not more. */
export const SOURCE_HINT: Readonly<Record<ActivitySourceType, string>> = {
  developer: 'Typed or done by you in this window.',
  'ai-agent': 'Reported by an agent adapter.',
  external: 'Changed outside your typing. VS Code does not say which program wrote it.',
  git: 'Changed at the same moment as a Git state change. A time correlation, not proof.',
  automated: 'Edited in the background by VS Code or an extension.',
  unknown: 'Restored from history without enough detail to tell.',
};

export const EVENT_LABEL: Readonly<Record<ActivityEventType, string>> = {
  create: 'created',
  modify: 'modified',
  delete: 'deleted',
};

export const METHOD_LABEL: Readonly<Record<DetectionMethod, string>> = {
  'focused-editor-edit': 'editor edit',
  'undo-redo': 'undo or redo',
  'workbench-file-operation': 'file operation',
  'workspace-edit': 'background edit',
  'disk-write': 'disk write',
  'reload-from-disk': 'reload from disk',
  'disk-delete': 'deleted on disk',
  'git-state-change': 'Git state change',
  'agent-signal': 'agent signal',
  restored: 'restored',
};

export const LEVEL_LABEL: Readonly<Record<ImpactLevel, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const MODE_LABEL: Readonly<Record<ViewMode, string>> = {
  live: 'Live',
  compact: 'Compact',
  impact: 'Impact',
};

export const GIT_STATUS_LABEL: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  conflicted: 'conflicted',
  other: 'changed',
};

export const GIT_STATUS_LETTER: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  other: '?',
};

export const RELATIONSHIP_LABEL: Readonly<Record<RelationshipType, string>> = {
  import: 'import',
  export: 're-export',
  reference: 'reference',
  inheritance: 'inheritance',
  unknown: 'link',
};

/** 1200 -> "1,200". Fixed grouping so the text does not depend on the machine's locale. */
export function formatCount(n: number): string {
  const whole = Math.round(Number.isFinite(n) ? n : 0);
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** plural(1, 'file', 'files') -> "1 file"; plural(1200, ...) -> "1,200 files". */
export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

interface Age {
  n: number;
  unit: 's' | 'm' | 'h' | 'd';
}

/** null = under five seconds (or a timestamp ahead of the host clock). */
function age(now: number, at: number): Age | null {
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  if (!Number.isFinite(seconds) || seconds < 5) return null;
  if (seconds < 60) return { n: seconds, unit: 's' };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { n: minutes, unit: 'm' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { n: hours, unit: 'h' };
  return { n: Math.floor(hours / 24), unit: 'd' };
}

/** "now", "45s", "2m", "3h", "2d" */
export function ageCompact(now: number, at: number): string {
  const a = age(now, at);
  return a ? `${formatCount(a.n)}${a.unit}` : 'now';
}

/** "just now", "2m ago" */
export function agoShort(now: number, at: number): string {
  const a = age(now, at);
  return a ? `${formatCount(a.n)}${a.unit} ago` : 'just now';
}

const UNIT_WORD: Readonly<Record<Age['unit'], [string, string]>> = {
  s: ['second', 'seconds'],
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
};

/** "just now", "2 minutes ago" (for accessible names) */
export function agoLong(now: number, at: number): string {
  const a = age(now, at);
  if (!a) return 'just now';
  const [one, many] = UNIT_WORD[a.unit];
  return `${plural(a.n, one, many)} ago`;
}

/** "under 1m", "12m", "2h 5m", "3d 4h" */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60_000);
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${formatCount(days)}d` : `${formatCount(days)}d ${hours % 24}h`;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock time of a timestamp, for tooltips: "2026-11-12 21:14". */
export function formatClock(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One history event in words: "created", "modified once", "modified 3 times", "deleted 2 times". */
export function eventPhrase(type: ActivityEventType, count: number): string {
  const word = EVENT_LABEL[type];
  if (count <= 1) return type === 'modify' ? 'modified once' : word;
  return `${word} ${formatCount(count)} times`;
}

/** One history event, short: "modified", "modified ×3". */
export function eventShort(type: ActivityEventType, count: number): string {
  return count <= 1 ? EVENT_LABEL[type] : `${EVENT_LABEL[type]} ×${formatCount(count)}`;
}

/**
 * A file's history in words. The newest event gives the verb and `changes` counts every occurrence,
 * so a file changed five times and then deleted reads "deleted, 6 changes", not "deleted 6 times".
 */
export function filePhrase(type: ActivityEventType, changes: number): string {
  if (type === 'modify') return eventPhrase('modify', changes);
  return changes <= 1 ? EVENT_LABEL[type] : `${EVENT_LABEL[type]}, ${plural(changes, 'change', 'changes')}`;
}

/** 0.9 -> "90%" */
export function percent(unit: number): string {
  return `${Math.round(Math.min(1, Math.max(0, unit)) * 100)}%`;
}

/** Workspace-relative display path of a file reference. */
export function displayPath(f: DashFileRef): string {
  return f.dir === '' ? f.name : `${f.dir}/${f.name}`;
}

export function sourceText(source: ActivitySourceType, sourceId: string | null): string {
  return sourceId === null || sourceId === '' ? SOURCE_LABEL[source] : `${SOURCE_LABEL[source]} (${sourceId})`;
}

/** Accessible name of an activity row: "app.ts, Developer, modified 3 times, 2 minutes ago, unreviewed". */
export function rowSummary(row: DashFileRow, now: number): string {
  const parts = [row.name, SOURCE_LABEL[row.source], filePhrase(row.lastEventType, row.changes), agoLong(now, row.lastAt)];
  if (row.review !== null) parts.push(row.review);
  return parts.join(', ');
}
