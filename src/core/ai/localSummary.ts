import { SOURCE_TYPES } from '../dashboard/protocol';
import { formatDuration } from '../timeFormat';
import type { ActivitySourceType } from '../types';
import type { SummaryInput } from './provider';

const SOURCE_PHRASES: Readonly<Record<ActivitySourceType, string>> = {
  developer: 'by you',
  'ai-agent': 'by an AI agent',
  external: 'external',
  git: 'from Git',
  automated: 'automated',
  unknown: 'of unknown origin',
};

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

function changes(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`;
}

/**
 * A summary made from metadata only: counts, names and source labels. Deterministic, built on this
 * machine, no network and no model. The same input always gives the same sentences.
 */
export function localSummary(input: SummaryInput): string {
  const total = SOURCE_TYPES.reduce((sum, t) => sum + (input.bySource[t] ?? 0), 0);
  if (total === 0) return 'No file activity has been recorded yet.';

  const sentences: string[] = [];
  const parts = SOURCE_TYPES.filter((t) => (input.bySource[t] ?? 0) > 0).map((t) => `${input.bySource[t]} ${SOURCE_PHRASES[t]}`);
  sentences.push(`${total === 1 ? '1 file changed' : `${total} files changed`}: ${list(parts)}.`);

  const busiest = [...input.files]
    .sort((a, b) => b.changes - a.changes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 3)
    .filter((f) => f.changes > 0);
  if (busiest.length > 0) {
    sentences.push(`Most changed: ${list(busiest.map((f) => `${f.path} (${changes(f.changes)})`))}.`);
  }

  const created = input.files.filter((f) => f.eventType === 'create').length;
  const deleted = input.files.filter((f) => f.eventType === 'delete').length;
  if (created > 0 || deleted > 0) {
    const bits: string[] = [];
    if (created > 0) bits.push(created === 1 ? '1 file was created' : `${created} files were created`);
    if (deleted > 0) bits.push(deleted === 1 ? '1 file was deleted' : `${deleted} files were deleted`);
    sentences.push(`${list(bits)}.`);
  }

  const notYours = total - (input.bySource.developer ?? 0);
  if (notYours > 0) {
    sentences.push(
      notYours === 1
        ? '1 file was changed by something other than your typing.'
        : `${notYours} files were changed by something other than your typing.`,
    );
  }

  if (input.session !== undefined) sentences.push(`Session "${input.session.title}" has been running for ${formatDuration(input.session.durationMs)}.`);
  if (input.branch !== undefined) sentences.push(`Current branch: ${input.branch}.`);
  if (input.files.length < total) sentences.push(`Only the ${input.files.length} most recent files are listed here.`);
  return sentences.join(' ');
}
