import type { FileActivity } from '../activity/eventStore';
import { PROVIDER_ID_PATTERN } from '../config';
import { SOURCE_TYPES } from '../dashboard/protocol';
import type { ActivityEventType, ActivitySourceType, FileKey } from '../types';

/**
 * Provider-independent AI interface (DESIGN-0.3.0 section 9). Changescope ships no network provider:
 * another extension can register one through the API, and nothing is sent to it without consent.
 */

/** What a summary is built from: names, counts and labels. Never file contents. */
export interface SummaryInput {
  files: Array<{
    /** display path (workspace relative), never an absolute path */
    path: string;
    source: ActivitySourceType;
    changes: number;
    eventType: ActivityEventType;
  }>;
  /** number of files per current source */
  bySource: Record<ActivitySourceType, number>;
  session?: { title: string; durationMs: number };
  branch?: string;
}

export interface AiRequest {
  kind: 'changes' | 'session' | 'impact';
  metadata: SummaryInput;
  /** 0.3.0 never sends source code */
  includesSource: false;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  summarize(req: AiRequest, token: { isCancellationRequested: boolean }): Promise<string>;
}

export const SUMMARY_FILE_LIMIT = 100;
export const PROVIDER_LABEL_LIMIT = 80;

/** Is this value usable as a provider: a short opaque id, a label and a `summarize` function. */
export function isAiProvider(v: unknown): v is AiProvider {
  if (typeof v !== 'object' || v === null) return false;
  const id: unknown = 'id' in v ? v.id : undefined;
  const label: unknown = 'label' in v ? v.label : undefined;
  const summarize: unknown = 'summarize' in v ? v.summarize : undefined;
  return (
    typeof id === 'string' &&
    PROVIDER_ID_PATTERN.test(id) &&
    typeof label === 'string' &&
    label.trim() !== '' &&
    label.length <= PROVIDER_LABEL_LIMIT &&
    typeof summarize === 'function'
  );
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();

  /** Registers a provider (replacing one with the same id). Disposing removes it, unless it was replaced meanwhile. */
  register(p: AiProvider): { dispose(): void } {
    if (!isAiProvider(p)) throw new TypeError('An AI provider needs an id (letters, digits, ".", "_", "-"), a label and a summarize function.');
    this.providers.set(p.id, p);
    return {
      dispose: () => {
        if (this.providers.get(p.id) === p) this.providers.delete(p.id);
      },
    };
  }

  get(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  /** Sorted by id. */
  list(): AiProvider[] {
    return [...this.providers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

export type Consent = 'granted' | 'denied' | 'unset';

/** The single gate in front of every provider call. `reason` is a full sentence that can be shown to the user. */
export function canSend(mode: 'local' | 'assisted', consent: Consent, provider: AiProvider | undefined): { ok: boolean; reason: string } {
  if (mode !== 'assisted') return { ok: false, reason: 'AI mode is local: summaries are built on this machine and nothing is sent anywhere.' };
  if (provider === undefined) return { ok: false, reason: 'No AI provider with the configured id is registered, so the local summary is used.' };
  if (consent === 'denied') return { ok: false, reason: `You declined to share activity metadata with ${provider.label}, so the local summary is used.` };
  if (consent !== 'granted') return { ok: false, reason: `${provider.label} has not been allowed to receive activity metadata yet.` };
  return { ok: true, reason: `Activity metadata may be sent to ${provider.label}.` };
}

/** Exactly what an assisted request contains, as shown in the consent prompt. */
export const PAYLOAD_DESCRIPTION: readonly string[] = [
  'Workspace-relative paths of changed files (files matching changescope.sensitiveGlobs are left out)',
  'How many times each file changed and whether it was created, modified or deleted',
  'The source label of each change (Developer, External, AI agent, Git, Automated, Unknown)',
  'The current Git branch name and, for a session, its title and duration',
];

export function consentMessage(provider: Pick<AiProvider, 'id' | 'label'>): { message: string; detail: string } {
  return {
    message: `Allow Changescope to send activity metadata to "${provider.label}" (${provider.id})?`,
    detail:
      'This provider was registered by another extension. When you ask for a summary, Changescope will send it:\n\n' +
      PAYLOAD_DESCRIPTION.map((l) => `- ${l}`).join('\n') +
      '\n\nFile contents are never sent. This choice is stored for this workspace only, and you can undo it with the command ' +
      '"Changescope: Reset AI Consent".',
  };
}

export interface SummaryInputArgs {
  /** newest first, as `EventStore.files()` returns them */
  files: readonly FileActivity[];
  toDisplay(key: FileKey): string;
  /** files matching `changescope.sensitiveGlobs` */
  isSensitive(key: FileKey): boolean;
  session?: { title: string; durationMs: number } | undefined;
  branch?: string | undefined;
}

/**
 * Builds the metadata a summary is made from. Sensitive files are dropped entirely (not even counted),
 * paths are display paths, and at most `SUMMARY_FILE_LIMIT` files are listed.
 */
export function buildSummaryInput(a: SummaryInputArgs): SummaryInput {
  const bySource = Object.fromEntries(SOURCE_TYPES.map((t) => [t, 0])) as Record<ActivitySourceType, number>;
  const files: SummaryInput['files'] = [];
  for (const f of a.files) {
    let sensitive: boolean;
    try {
      sensitive = a.isSensitive(f.key);
    } catch {
      // if the check itself fails, the file is treated as sensitive
      sensitive = true;
    }
    if (sensitive) continue;
    bySource[f.sourceType] += 1;
    if (files.length < SUMMARY_FILE_LIMIT) {
      files.push({ path: a.toDisplay(f.key), source: f.sourceType, changes: f.changes, eventType: f.lastEventType });
    }
  }
  const input: SummaryInput = { files, bySource };
  if (a.session !== undefined) input.session = { title: a.session.title, durationMs: Math.max(0, a.session.durationMs) };
  if (a.branch !== undefined && a.branch !== '') input.branch = a.branch;
  return input;
}
