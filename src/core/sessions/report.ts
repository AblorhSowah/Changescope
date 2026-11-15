import { SOURCE_LABELS } from '../activity/attribution';
import { SOURCE_TYPES } from '../dashboard/protocol';
import { formatDuration, formatLocalMinute, toIsoUtc } from '../timeFormat';
import type { ActivityEvent, ActivityEventType, ActivitySourceType, DevelopmentSession, FileKey, GitContext } from '../types';

const EVENT_WORDS: Readonly<Record<ActivityEventType, string>> = { create: 'created', modify: 'modified', delete: 'deleted' };

interface FileLine {
  path: string;
  sources: ActivitySourceType[];
  changes: number;
  lastEvent: ActivityEventType | undefined;
  lastAt: number;
}

/** Text for one Markdown table cell or list item: no line breaks, no cell separators, no markup taken from a file name. */
function cell(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) out += ' ';
    else if ('\\`*_[]<>|#'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function gitText(g: GitContext | undefined): string {
  if (g === undefined || (g.branch === undefined && g.commit === undefined)) return 'not recorded';
  const commit = g.commit === undefined ? '' : g.commit.slice(0, 7);
  if (g.branch !== undefined && commit !== '') return `${g.branch} (${commit})`;
  return g.branch ?? commit;
}

function fileLines(s: DevelopmentSession, events: readonly ActivityEvent[], toDisplay: (k: FileKey) => string): FileLine[] {
  const byFile = new Map<FileKey, FileLine>();
  for (const key of s.modifiedFiles) byFile.set(key, { path: toDisplay(key), sources: [], changes: 0, lastEvent: undefined, lastAt: -Infinity });
  for (const e of events) {
    if (e.sessionId !== s.id) continue;
    let line = byFile.get(e.filePath);
    if (line === undefined) {
      line = { path: toDisplay(e.filePath), sources: [], changes: 0, lastEvent: undefined, lastAt: -Infinity };
      byFile.set(e.filePath, line);
    }
    if (!line.sources.includes(e.sourceType)) line.sources.push(e.sourceType);
    line.changes += e.count;
    if (e.lastTimestamp >= line.lastAt) {
      line.lastAt = e.lastTimestamp;
      line.lastEvent = e.eventType;
    }
  }
  const lines = [...byFile.values()];
  for (const l of lines) l.sources.sort((a, b) => SOURCE_TYPES.indexOf(a) - SOURCE_TYPES.indexOf(b));
  lines.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return lines;
}

/**
 * The report of one session, as Markdown or JSON. `events` may be the whole history: only events of this
 * session are used. Paths go through `toDisplay` (workspace relative), so no absolute path and no file
 * content ever appears in a report.
 */
export function buildSessionReport(
  s: DevelopmentSession,
  events: readonly ActivityEvent[],
  toDisplay: (k: FileKey) => string,
  format: 'markdown' | 'json',
): string {
  const lines = fileLines(s, events, toDisplay);
  const durationMs = s.endedAt === undefined ? undefined : Math.max(0, s.endedAt - s.startedAt);
  const sources = SOURCE_TYPES.filter((t) => (s.sources[t] ?? 0) > 0).map((t) => ({ type: t, count: s.sources[t] ?? 0 }));

  if (format === 'json') {
    return JSON.stringify(
      {
        title: s.title,
        status: s.status,
        startedAt: toIsoUtc(s.startedAt),
        endedAt: s.endedAt === undefined ? null : toIsoUtc(s.endedAt),
        durationMs: durationMs ?? null,
        gitStart: { branch: s.gitStart?.branch ?? null, commit: s.gitStart?.commit ?? null },
        gitEnd: { branch: s.gitEnd?.branch ?? null, commit: s.gitEnd?.commit ?? null },
        activityCount: s.activityCount,
        sources: Object.fromEntries(sources.map((x) => [x.type, x.count])),
        files: lines.map((l) => ({ path: l.path, sources: l.sources, changes: l.changes, lastEvent: l.lastEvent ?? null })),
      },
      null,
      2,
    );
  }

  const out: string[] = [];
  out.push(`# Changescope session report: ${cell(s.title)}`, '');
  out.push(`- Status: ${s.status}`);
  out.push(`- Started: ${formatLocalMinute(s.startedAt)} (local time)`);
  out.push(`- Ended: ${s.endedAt === undefined ? 'still running' : `${formatLocalMinute(s.endedAt)} (local time)`}`);
  out.push(`- Duration: ${durationMs === undefined ? 'still running' : formatDuration(durationMs)}`);
  out.push(`- Git at start: ${cell(gitText(s.gitStart))}`);
  out.push(`- Git at end: ${cell(gitText(s.gitEnd))}`);
  out.push(`- Recorded changes: ${s.activityCount} in ${s.modifiedFiles.length} ${s.modifiedFiles.length === 1 ? 'file' : 'files'}`);
  out.push('', '## Changes by source', '');
  if (sources.length === 0) {
    out.push('No changes were recorded in this session.');
  } else {
    out.push('| Source | Changes |', '|---|---|');
    for (const x of sources) out.push(`| ${SOURCE_LABELS[x.type]} | ${x.count} |`);
  }
  out.push('', '## Files', '');
  if (lines.length === 0) {
    out.push('No files were changed in this session.');
  } else {
    out.push('| File | Source | Changes | Last event |', '|---|---|---|---|');
    for (const l of lines) {
      const source = l.sources.length === 0 ? 'no longer in the kept history' : l.sources.map((t) => SOURCE_LABELS[t]).join(', ');
      const changes = l.sources.length === 0 ? '' : String(l.changes);
      out.push(`| ${cell(l.path)} | ${source} | ${changes} | ${l.lastEvent === undefined ? '' : EVENT_WORDS[l.lastEvent]} |`);
    }
  }
  out.push(
    '',
    '---',
    '',
    'Sources are how Changescope classified each change from the way it arrived, not proof of who made it. ' +
      'Changes written by a tool or an agent show as External unless an adapter reported them. ' +
      'This report contains paths and counts only, no file contents.',
    '',
  );
  return out.join('\n');
}
