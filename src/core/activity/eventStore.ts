import { extname, isUnder } from '../pathUtils';
import type { ActivityEvent, ActivityEventType, ActivitySourceType, Clock, DetectionMethod, FileKey, ReviewStatus } from '../types';
import type { Attribution } from './attribution';

export interface EventStoreOptions {
  maxEvents: number;
  retentionMs: number;
  coalesceMs: number;
}

export const DEFAULT_EVENT_STORE_OPTIONS: EventStoreOptions = {
  maxEvents: 1000,
  retentionMs: 14 * 24 * 60 * 60 * 1000,
  coalesceMs: 5000,
};

/** One file's place in the kept history. */
export interface FileActivity {
  key: FileKey;
  sourceType: ActivitySourceType;
  sourceId?: string;
  detectionMethod: DetectionMethod;
  confidence: number;
  lastEventType: ActivityEventType;
  firstAt: number;
  lastAt: number;
  /** occurrences in the kept history */
  changes: number;
  review: ReviewStatus | undefined;
  sessionId?: string;
  /** false when the newest event is a delete */
  exists: boolean;
}

export interface NewEvent extends Attribution {
  key: FileKey;
  eventType: ActivityEventType;
  at: number;
  sessionId?: string;
}

const ID_PATTERN = /^e([0-9a-z]{1,10})$/;

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}

function clampUnit(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Bounded history of file activity. Rapid successive changes of one file by one source are merged
 * into one event, so typing a paragraph is one line in the timeline and not three hundred.
 * Every operation is O(events) at worst, and events are bounded by `maxEvents`.
 */
export class EventStore {
  private list: ActivityEvent[] = [];
  /** newest event of each file, for the merge check */
  private readonly newest = new Map<FileKey, ActivityEvent>();
  private options: EventStoreOptions;
  private counter = 0;
  private rev = 0;
  private filesCache: { rev: number; files: FileActivity[] } | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly workspaceId: string,
    options: Partial<EventStoreOptions> = {},
  ) {
    this.options = { ...DEFAULT_EVENT_STORE_OPTIONS };
    this.applyOptions(options);
  }

  setOptions(patch: Partial<EventStoreOptions>): void {
    this.applyOptions(patch);
    const dropped = this.trim() + this.prune();
    if (dropped > 0) this.touch();
  }

  /** Records one occurrence. Returns the event it became part of (a merged one or a new one). */
  add(e: NewEvent): ActivityEvent {
    const at = Number.isFinite(e.at) ? e.at : this.clock.now();
    const last = this.newest.get(e.key);
    if (
      last !== undefined &&
      last.eventType === e.eventType &&
      last.sourceType === e.sourceType &&
      last.sourceId === e.sourceId &&
      last.sessionId === e.sessionId &&
      // a change that arrives after you reviewed the file is a new thing to look at
      last.reviewStatus !== 'reviewed' &&
      at - last.lastTimestamp <= this.options.coalesceMs
    ) {
      last.count += 1;
      if (at > last.lastTimestamp) last.lastTimestamp = at;
      this.touch();
      return last;
    }

    this.counter += 1;
    const event: ActivityEvent = {
      id: `e${this.counter.toString(36)}`,
      workspaceId: this.workspaceId,
      filePath: e.key,
      eventType: e.eventType,
      sourceType: e.sourceType,
      detectionMethod: e.detectionMethod,
      confidence: clampUnit(e.confidence),
      timestamp: at,
      lastTimestamp: at,
      count: 1,
    };
    if (e.sessionId !== undefined) event.sessionId = e.sessionId;
    if (e.sourceId !== undefined) event.sourceId = e.sourceId;
    if (e.sourceType !== 'developer') event.reviewStatus = 'unreviewed';
    this.list.push(event);
    this.newest.set(e.key, event);
    this.trim();
    this.touch();
    return event;
  }

  /** Oldest first (in the order the events were created). */
  events(): readonly ActivityEvent[] {
    return this.list.slice();
  }

  /** Newest first, by the last occurrence of each event. */
  recent(limit: number): ActivityEvent[] {
    // +Infinity means "all of them"; NaN and anything that is not a number mean none
    if (typeof limit !== 'number' || Number.isNaN(limit)) return [];
    const n = limit === Number.POSITIVE_INFINITY ? this.list.length : Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    const indexed = this.list.map((event, index) => ({ event, index }));
    indexed.sort((a, b) => b.event.lastTimestamp - a.event.lastTimestamp || b.index - a.index);
    return indexed.slice(0, n).map((x) => x.event);
  }

  /** One summary per file, newest first, built from the kept events. */
  files(): FileActivity[] {
    if (this.filesCache?.rev !== this.rev) this.filesCache = { rev: this.rev, files: this.buildFiles() };
    return this.filesCache.files.map((f) => ({ ...f }));
  }

  /**
   * Lets a late hint correct recent events. `match` is asked about every event whose last occurrence
   * is at or after `sinceMs` (a clock time) and returns the new attribution, or undefined to leave it.
   * Returns how many events changed.
   */
  reattribute(match: (e: ActivityEvent) => Attribution | undefined, sinceMs: number): number {
    let changed = 0;
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      const e = this.list[i];
      if (e === undefined || e.lastTimestamp < sinceMs) continue;
      const next = match(e);
      if (next === undefined) continue;
      const confidence = clampUnit(next.confidence);
      if (
        next.sourceType === e.sourceType &&
        next.sourceId === e.sourceId &&
        next.detectionMethod === e.detectionMethod &&
        confidence === e.confidence
      ) {
        continue;
      }
      e.sourceType = next.sourceType;
      if (next.sourceId === undefined) delete e.sourceId;
      else e.sourceId = next.sourceId;
      e.detectionMethod = next.detectionMethod;
      e.confidence = confidence;
      if (next.sourceType === 'developer') delete e.reviewStatus;
      else e.reviewStatus ??= 'unreviewed';
      changed += 1;
    }
    if (changed > 0) this.touch();
    return changed;
  }

  /** Marks every unreviewed event of one file as reviewed. Returns how many events changed. */
  markReviewed(key: FileKey): number {
    let changed = 0;
    for (const e of this.list) {
      if (e.filePath === key && e.reviewStatus === 'unreviewed') {
        e.reviewStatus = 'reviewed';
        changed += 1;
      }
    }
    if (changed > 0) this.touch();
    return changed;
  }

  markAllReviewed(): number {
    let changed = 0;
    for (const e of this.list) {
      if (e.reviewStatus === 'unreviewed') {
        e.reviewStatus = 'reviewed';
        changed += 1;
      }
    }
    if (changed > 0) this.touch();
    return changed;
  }

  /** Number of files that still have an unreviewed event. */
  unreviewedFiles(): number {
    const seen = new Set<FileKey>();
    for (const e of this.list) if (e.reviewStatus === 'unreviewed') seen.add(e.filePath);
    return seen.size;
  }

  /** Re-keys the events of a renamed file or folder. Returns how many events moved. */
  rename(oldPrefix: FileKey, newPrefix: FileKey): number {
    if (oldPrefix === '' || oldPrefix === newPrefix) return 0;
    let moved = 0;
    for (const e of this.list) {
      if (!isUnder(oldPrefix, e.filePath)) continue;
      e.filePath = e.filePath === oldPrefix ? newPrefix : `${newPrefix}${e.filePath.slice(oldPrefix.length)}`;
      moved += 1;
    }
    if (moved > 0) {
      this.reindex();
      this.touch();
    }
    return moved;
  }

  /** Replaces the content (for example with history read from storage) and applies the limits. */
  load(events: readonly ActivityEvent[]): void {
    const seen = new Set<string>();
    const copies: ActivityEvent[] = [];
    let highest = 0;
    for (const e of events) {
      const m = ID_PATTERN.exec(e.id);
      if (m && m[1] !== undefined) highest = Math.max(highest, Number.parseInt(m[1], 36));
    }
    this.counter = Number.isSafeInteger(highest) ? highest : 0;
    for (const e of events) {
      const copy: ActivityEvent = { ...e, workspaceId: this.workspaceId };
      if (seen.has(copy.id)) {
        this.counter += 1;
        copy.id = `e${this.counter.toString(36)}`;
      }
      seen.add(copy.id);
      copies.push(copy);
    }
    copies.sort((a, b) => a.timestamp - b.timestamp);
    this.list = copies;
    this.prune();
    this.trim();
    this.reindex();
    this.touch();
  }

  clear(): void {
    if (this.list.length === 0) return;
    this.list = [];
    this.newest.clear();
    this.touch();
  }

  /** Drops events whose last occurrence is older than `retentionMs`. Returns how many were dropped. */
  prune(): number {
    const cutoff = this.clock.now() - this.options.retentionMs;
    const before = this.list.length;
    if (!this.list.some((e) => e.lastTimestamp < cutoff)) return 0;
    this.list = this.list.filter((e) => e.lastTimestamp >= cutoff);
    this.reindex();
    this.touch();
    return before - this.list.length;
  }

  get size(): number {
    return this.list.length;
  }

  /** Increments on every change, so callers can tell cheaply whether anything happened. */
  get revision(): number {
    return this.rev;
  }

  // ----------------------------------------------------------------------------

  private applyOptions(patch: Partial<EventStoreOptions>): void {
    this.options = {
      maxEvents: Math.max(1, Math.floor(positive(patch.maxEvents, this.options.maxEvents))),
      retentionMs: positive(patch.retentionMs, this.options.retentionMs),
      coalesceMs:
        patch.coalesceMs !== undefined && Number.isFinite(patch.coalesceMs) && patch.coalesceMs >= 0
          ? patch.coalesceMs
          : this.options.coalesceMs,
    };
  }

  private touch(): void {
    this.rev += 1;
  }

  /** Over `maxEvents` the oldest go. Returns how many were dropped. */
  private trim(): number {
    const excess = this.list.length - this.options.maxEvents;
    if (excess <= 0) return 0;
    const dropped = this.list.splice(0, excess);
    for (const e of dropped) if (this.newest.get(e.filePath) === e) this.newest.delete(e.filePath);
    return excess;
  }

  private reindex(): void {
    this.newest.clear();
    for (const e of this.list) {
      const current = this.newest.get(e.filePath);
      if (current === undefined || e.lastTimestamp >= current.lastTimestamp) this.newest.set(e.filePath, e);
    }
  }

  private buildFiles(): FileActivity[] {
    const byFile = new Map<FileKey, { newest: ActivityEvent; firstAt: number; changes: number; unreviewed: boolean; reviewed: boolean }>();
    for (const e of this.list) {
      const acc = byFile.get(e.filePath);
      if (acc === undefined) {
        byFile.set(e.filePath, {
          newest: e,
          firstAt: e.timestamp,
          changes: e.count,
          unreviewed: e.reviewStatus === 'unreviewed',
          reviewed: e.reviewStatus === 'reviewed',
        });
        continue;
      }
      if (e.lastTimestamp >= acc.newest.lastTimestamp) acc.newest = e;
      if (e.timestamp < acc.firstAt) acc.firstAt = e.timestamp;
      acc.changes += e.count;
      if (e.reviewStatus === 'unreviewed') acc.unreviewed = true;
      else if (e.reviewStatus === 'reviewed') acc.reviewed = true;
    }
    const files: FileActivity[] = [];
    for (const [key, acc] of byFile) {
      const n = acc.newest;
      const file: FileActivity = {
        key,
        sourceType: n.sourceType,
        detectionMethod: n.detectionMethod,
        confidence: n.confidence,
        lastEventType: n.eventType,
        firstAt: acc.firstAt,
        lastAt: n.lastTimestamp,
        changes: acc.changes,
        review: acc.unreviewed ? 'unreviewed' : acc.reviewed ? 'reviewed' : undefined,
        exists: n.eventType !== 'delete',
      };
      if (n.sourceId !== undefined) file.sourceId = n.sourceId;
      if (n.sessionId !== undefined) file.sessionId = n.sessionId;
      files.push(file);
    }
    files.sort((a, b) => b.lastAt - a.lastAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return files;
  }
}

/**
 * Which files a reported delete of `key` stands for. A deleted folder arrives as one event for the
 * folder, and by then nothing can be asked about it on disk, so the history decides: files of the
 * history below `key` that still existed are the ones that went. Without any, `key` is taken as a
 * file when the history knows it or when it has a file extension.
 */
export function deleteTargets(key: FileKey, files: readonly FileActivity[], max = 50): FileKey[] {
  const below: FileKey[] = [];
  let known = false;
  for (const f of files) {
    if (f.key === key) known = true;
    else if (f.exists && isUnder(key, f.key)) below.push(f.key);
  }
  if (below.length > 0) return below.sort().slice(0, Math.max(0, max));
  return known || extname(key) !== '' ? [key] : [];
}
