import * as vscode from 'vscode';
import { HINT_WINDOW_MS, HintBook, attribute, hintCovers, upgradeWithHint } from '../core/activity/attribution';
import type { Attribution, Hint, RawEvent } from '../core/activity/attribution';
import { EventStore, deleteTargets } from '../core/activity/eventStore';
import type { FileShakeConfig } from '../core/config';
import { toSafeDisplayPath } from '../core/pathUtils';
import { buildSessionReport } from '../core/sessions/report';
import { SessionManager } from '../core/sessions/sessionManager';
import { serialise } from '../core/storage/schema';
import type { ActivityEvent, ActivitySourceType, Clock, DevelopmentSession, FileKey, GitContext, Scheduler, WorkspaceRoot } from '../core/types';
import { HistoryStorage } from './storage';
import type { MementoLike } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PAUSED_CONTEXT_KEY = 'fileShake.paused';

export interface ActivityServiceDeps {
  clock: Clock;
  scheduler: Scheduler;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  /** opaque id of the workspace (never a path) */
  workspaceId: string;
  memento: MementoLike;
  gitContext(key?: FileKey): GitContext | undefined;
  log(msg: string): void;
}

/**
 * Owns the activity history, the sessions, the attribution hints, the pause flag and persistence.
 * It is fed by the edit watcher (through the controller) and by adapters that report agent writes.
 */
export class ActivityService implements vscode.Disposable {
  readonly events: EventStore;
  readonly sessions: SessionManager;
  readonly storage: HistoryStorage;
  private readonly hints = new HintBook();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  private paused = false;
  /** whether history was being kept on disk at the last look, so only a switch is acted on */
  private persisting: boolean;
  private extraRevision = 0;
  private disposed = false;

  constructor(private readonly deps: ActivityServiceDeps) {
    const cfg = deps.getConfig();
    this.events = new EventStore(deps.clock, deps.workspaceId, { maxEvents: cfg.historyMaxEvents, retentionMs: cfg.historyRetentionDays * DAY_MS });
    this.sessions = new SessionManager(deps.clock, deps.workspaceId);
    this.storage = new HistoryStorage({ memento: deps.memento, scheduler: deps.scheduler, log: deps.log });
    this.persisting = cfg.historyPersist;
  }

  /** Reads the stored history (an in-memory read of the workspace Memento, no file IO of our own). */
  load(): void {
    if (!this.deps.getConfig().historyPersist) {
      if (this.storage.hasStored()) void this.storage.remove();
      return;
    }
    const stored = this.storage.load();
    if (stored.recovered > 0) this.deps.log(`stored history: ${stored.recovered} invalid or surplus record(s) were dropped`);
    this.events.load(stored.events);
    const lastEventAt = new Map<string, number>();
    for (const e of this.events.events()) {
      if (e.sessionId !== undefined) lastEventAt.set(e.sessionId, Math.max(lastEventAt.get(e.sessionId) ?? 0, e.lastTimestamp));
    }
    this.sessions.load(stored.sessions, (id) => lastEventAt.get(id));
    if (stored.recovered > 0 || stored.events.length > 0 || stored.sessions.length > 0) this.changed(false);
  }

  /** Combined change counter of everything the dashboard shows from this service. */
  get revision(): number {
    return this.events.revision + this.sessions.revision + this.extraRevision;
  }

  // ---- events ------------------------------------------------------------------

  /** One accepted or deleted file event from the edit watcher. */
  onEvent(raw: RawEvent): void {
    if (this.disposed || this.paused) return;
    this.hints.prune(raw.at);
    const attr = attribute(raw, this.hints.match(raw));
    const sessionId = this.sessions.activeSessionId;
    for (const key of this.targetsOf(raw)) {
      const event = this.events.add({ key, eventType: raw.eventType, at: raw.at, ...attr, ...(sessionId === undefined ? {} : { sessionId }) });
      this.sessions.record(event, true);
    }
    this.changed(true);
  }

  /** A deleted folder arrives as one event for the folder: the history says which files went. */
  private targetsOf(raw: RawEvent): FileKey[] {
    if (raw.eventType !== 'delete') return [raw.key];
    const files = this.events.files();
    const own = files.find((f) => f.key === raw.key);
    if (own !== undefined && !own.exists) return [];
    return deleteTargets(raw.key, files);
  }

  /** An adapter reports that `agent` wrote these files. Events of the last few seconds are re-attributed. */
  reportAgent(agent: string, files: readonly FileKey[], at: number, sessionId?: string): void {
    for (const file of files) this.addHint({ kind: 'agent', agent, file, at, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  /** The repository state at `root` changed (branch or commit). */
  noteGitChange(root: FileKey, at: number): void {
    this.addHint({ kind: 'git', root, at });
  }

  private addHint(hint: Hint): void {
    if (this.disposed) return;
    this.hints.prune(hint.at);
    this.hints.add(hint);
    const moved: Array<{ sessionId: string; from: ActivitySourceType; to: ActivitySourceType; count: number }> = [];
    const match = (e: ActivityEvent): Attribution | undefined => {
      if (!hintCovers(hint, e.filePath, e.timestamp, e.lastTimestamp)) return undefined;
      const current: Attribution = { sourceType: e.sourceType, detectionMethod: e.detectionMethod, confidence: e.confidence };
      if (e.sourceId !== undefined) current.sourceId = e.sourceId;
      const next = upgradeWithHint(current, hint);
      if (next !== undefined && e.sessionId !== undefined && next.sourceType !== e.sourceType) {
        moved.push({ sessionId: e.sessionId, from: e.sourceType, to: next.sourceType, count: e.count });
      }
      return next;
    };
    const changedEvents = this.events.reattribute(match, hint.at - HINT_WINDOW_MS - 1);
    for (const m of moved) this.sessions.reattribute(m.sessionId, m.from, m.to, m.count);
    if (changedEvents > 0) this.changed(true);
  }

  /** A file or folder was renamed: the history follows it. */
  onRenamed(oldKey: FileKey, newKey: FileKey): void {
    const moved = this.events.rename(oldKey, newKey) + this.sessions.renameFiles(oldKey, newKey);
    if (moved > 0) this.changed(true);
  }

  // ---- review ------------------------------------------------------------------

  markReviewed(key: FileKey): void {
    if (this.events.markReviewed(key) > 0) this.changed(true);
  }

  markAllReviewed(): void {
    if (this.events.markAllReviewed() > 0) this.changed(true);
  }

  // ---- pause -------------------------------------------------------------------

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(value: boolean): void {
    if (this.disposed || this.paused === value) return;
    this.paused = value;
    this.extraRevision += 1;
    void vscode.commands.executeCommand('setContext', PAUSED_CONTEXT_KEY, value);
    this.emitter.fire();
  }

  // ---- sessions ----------------------------------------------------------------

  startSession(title: string): DevelopmentSession {
    const session = this.sessions.start(title, this.deps.gitContext());
    this.changed(true);
    return session;
  }

  stopSession(): DevelopmentSession | undefined {
    const session = this.sessions.stop(this.deps.gitContext());
    if (session !== undefined) this.changed(true);
    return session;
  }

  renameSession(id: string, title: string): boolean {
    const ok = this.sessions.rename(id, title);
    if (ok) this.changed(true);
    return ok;
  }

  /** The Markdown report of a session, with workspace-relative paths only. */
  sessionReport(id: string, format: 'markdown' | 'json' = 'markdown'): string | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    const roots = this.deps.getRoots();
    // a report is a document that gets saved and shared: workspace-relative paths only, never an absolute one
    return buildSessionReport(session, this.events.events(), (k) => toSafeDisplayPath(k, roots), format);
  }

  // ---- history -----------------------------------------------------------------

  /** Clears the events and the completed sessions (the active session stays, emptied) and the stored copy. */
  async clearHistory(): Promise<void> {
    this.events.clear();
    this.sessions.clearCompleted();
    this.changed(false);
    await this.storage.remove();
  }

  /** Settings changed: history limits, and whether history is kept on disk at all. */
  applyConfig(): void {
    const cfg = this.deps.getConfig();
    const before = this.events.revision;
    this.events.setOptions({ maxEvents: cfg.historyMaxEvents, retentionMs: cfg.historyRetentionDays * DAY_MS });
    const wasPersisting = this.persisting;
    this.persisting = cfg.historyPersist;
    // act only on a real change: an unrelated setting must not leave a write pending
    if (!cfg.historyPersist) {
      if (wasPersisting) void this.storage.remove();
    } else if (!wasPersisting || this.events.revision !== before) {
      this.persistSoon();
    }
    if (this.events.revision !== before) this.emitter.fire();
  }

  flush(): Promise<void> {
    return this.storage.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.storage.dispose();
    this.disposed = true;
    this.emitter.dispose();
  }

  // ----------------------------------------------------------------------------

  private changed(persist: boolean): void {
    if (persist) this.persistSoon();
    this.emitter.fire();
  }

  private persistSoon(): void {
    if (this.disposed || !this.deps.getConfig().historyPersist) return;
    this.storage.schedule(() => {
      this.events.prune();
      return serialise(this.events.events(), this.sessions.list(), this.deps.clock.now());
    });
  }
}
