import { isUnder } from '../pathUtils';
import type { ActivityEventType, ActivitySourceType, ClassifyReason, DetectionMethod, FileKey } from '../types';

/** Who Changescope thinks made a change, how it decided, and how sure it is (DESIGN-0.3.0 section 4.2). */
export interface Attribution {
  sourceType: ActivitySourceType;
  sourceId?: string;
  detectionMethod: DetectionMethod;
  confidence: number;
}

/** What the edit watcher reports for every accepted or deleted event. */
export interface RawEvent {
  key: FileKey;
  eventType: ActivityEventType;
  decision: 'you' | 'external';
  reason: ClassifyReason;
  origin: 'doc' | 'watcher' | 'workbench';
  at: number;
}

export type Hint =
  /** the state of the repository at `root` changed (branch or commit) */
  | { kind: 'git'; root: FileKey; at: number }
  /** an adapter reported that `agent` wrote `file` */
  | { kind: 'agent'; agent: string; file: FileKey; at: number; sessionId?: string };

export const HINT_WINDOW_MS = 3000;

export const SOURCE_LABELS: Readonly<Record<ActivitySourceType, string>> = {
  developer: 'Developer',
  'ai-agent': 'AI agent',
  external: 'External',
  git: 'Git',
  automated: 'Automated',
  unknown: 'Unknown',
};

/** Attribution from the event alone. First matching row wins. */
export function baseAttribution(e: RawEvent): Attribution {
  if (e.origin === 'workbench') return { sourceType: 'developer', detectionMethod: 'workbench-file-operation', confidence: 0.95 };
  if (e.decision === 'you') {
    return e.reason === 'undo-redo'
      ? { sourceType: 'developer', detectionMethod: 'undo-redo', confidence: 0.95 }
      : { sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9 };
  }
  if (e.reason === 'background-edit') return { sourceType: 'automated', detectionMethod: 'workspace-edit', confidence: 0.6 };
  if (e.reason === 'reload-from-disk') return { sourceType: 'external', detectionMethod: 'reload-from-disk', confidence: 0.7 };
  if (e.eventType === 'delete' && e.origin === 'watcher') return { sourceType: 'external', detectionMethod: 'disk-delete', confidence: 0.7 };
  if (e.reason === 'disk-write') return { sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 };
  return { sourceType: 'unknown', detectionMethod: 'restored', confidence: 0.2 };
}

/**
 * Does `hint` cover something that happened to `key` between `from` and `to`?
 * A single event has `from === to`; a coalesced one spans its first and last occurrence.
 */
export function hintCovers(hint: Hint, key: FileKey, from: number, to: number, windowMs: number = HINT_WINDOW_MS): boolean {
  const lo = Math.min(from, to) - windowMs;
  const hi = Math.max(from, to) + windowMs;
  if (!(hint.at >= lo && hint.at <= hi)) return false;
  return hint.kind === 'agent' ? hint.file === key : isUnder(hint.root, key);
}

/**
 * What a hint turns a current attribution into, or undefined when it changes nothing.
 * Developer changes are never re-labelled, and an agent report is never replaced by a git correlation.
 */
export function upgradeWithHint(current: Attribution, hint: Hint): Attribution | undefined {
  if (current.sourceType === 'developer') return undefined;
  if (hint.kind === 'agent') {
    if (current.sourceType === 'ai-agent' && current.sourceId === hint.agent) return undefined;
    return { sourceType: 'ai-agent', sourceId: hint.agent, detectionMethod: 'agent-signal', confidence: 0.95 };
  }
  if (current.sourceType === 'ai-agent' || current.sourceType === 'git') return undefined;
  return { sourceType: 'git', detectionMethod: 'git-state-change', confidence: 0.8 };
}

/** Base attribution, upgraded by `hint` when the hint really covers the event (same file or repository, within the window). */
export function attribute(e: RawEvent, hint: Hint | undefined, windowMs: number = HINT_WINDOW_MS): Attribution {
  const base = baseAttribution(e);
  if (hint === undefined || !hintCovers(hint, e.key, e.at, e.at, windowMs)) return base;
  return upgradeWithHint(base, hint) ?? base;
}

const MAX_HINTS = 500;

/** Recent hints from adapters. Bounded, and pruned by age. */
export class HintBook {
  private hints: Hint[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = HINT_WINDOW_MS) {
    this.windowMs = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : HINT_WINDOW_MS;
  }

  add(h: Hint): void {
    this.hints.push(h);
    if (this.hints.length > MAX_HINTS) this.hints.splice(0, this.hints.length - MAX_HINTS);
  }

  /** The best hint for an event: an agent report beats a git correlation; within a kind the closest in time wins. */
  match(e: { key: FileKey; at: number }): Hint | undefined {
    let best: Hint | undefined;
    let bestDistance = Infinity;
    for (const h of this.hints) {
      if (!hintCovers(h, e.key, e.at, e.at, this.windowMs)) continue;
      const distance = Math.abs(h.at - e.at);
      const better =
        best === undefined ||
        (h.kind === 'agent' && best.kind === 'git') ||
        (h.kind === best.kind && distance <= bestDistance);
      if (better && !(h.kind === 'git' && best?.kind === 'agent')) {
        best = h;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Drops hints that can no longer match an event happening at `now`. */
  prune(now: number): void {
    this.hints = this.hints.filter((h) => now - h.at <= this.windowMs);
  }

  get size(): number {
    return this.hints.length;
  }
}
