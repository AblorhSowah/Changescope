import { cleanTitle } from '../dashboard/protocol';
import { formatLocalMinute } from '../timeFormat';
import type { ActivityEvent, ActivitySourceType, Clock, DevelopmentSession, FileKey, GitContext } from '../types';

export const MAX_SESSION_FILES = 500;
export const DEFAULT_MAX_SESSIONS = 50;

function copyGit(g: GitContext | undefined): GitContext | undefined {
  if (g === undefined) return undefined;
  const out: GitContext = {};
  if (g.branch !== undefined) out.branch = g.branch;
  if (g.commit !== undefined) out.commit = g.commit;
  return out;
}

function copySession(s: DevelopmentSession): DevelopmentSession {
  const out: DevelopmentSession = {
    id: s.id,
    title: s.title,
    workspaceId: s.workspaceId,
    startedAt: s.startedAt,
    status: s.status,
    activityCount: s.activityCount,
    modifiedFiles: [...s.modifiedFiles],
    sources: { ...s.sources },
  };
  if (s.endedAt !== undefined) out.endedAt = s.endedAt;
  const start = copyGit(s.gitStart);
  if (start !== undefined) out.gitStart = start;
  const end = copyGit(s.gitEnd);
  if (end !== undefined) out.gitEnd = end;
  return out;
}

/**
 * User-controlled development sessions: one active at a time, started and stopped by the user.
 * A session only collects what the activity engine already records; it tracks nothing by itself.
 */
export class SessionManager {
  private sessions: DevelopmentSession[] = [];
  private activeId: string | undefined;
  /** files of the active session, for the membership check */
  private activeFiles = new Set<FileKey>();
  private readonly maxSessions: number;
  private rev = 0;

  constructor(
    private readonly clock: Clock,
    private readonly workspaceId: string,
    maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.maxSessions = Number.isFinite(maxSessions) && maxSessions >= 1 ? Math.floor(maxSessions) : DEFAULT_MAX_SESSIONS;
  }

  /** Starts a session (and stops the active one first). An empty title becomes "Session YYYY-MM-DD HH:mm" in local time. */
  start(title: string, git?: GitContext): DevelopmentSession {
    this.stop(git);
    const now = this.clock.now();
    const clean = cleanTitle(typeof title === 'string' ? title : '');
    const session: DevelopmentSession = {
      id: this.newId(now),
      title: clean !== '' ? clean : `Session ${formatLocalMinute(now)}`.trim(),
      workspaceId: this.workspaceId,
      startedAt: now,
      status: 'active',
      activityCount: 0,
      modifiedFiles: [],
      sources: {},
    };
    const start = copyGit(git);
    if (start !== undefined) session.gitStart = start;
    this.sessions.push(session);
    this.activeId = session.id;
    this.activeFiles = new Set();
    this.enforceLimit();
    this.rev += 1;
    return copySession(session);
  }

  stop(git?: GitContext): DevelopmentSession | undefined {
    const session = this.current();
    if (session === undefined) return undefined;
    session.status = 'completed';
    session.endedAt = Math.max(session.startedAt, this.clock.now());
    const end = copyGit(git);
    if (end !== undefined) session.gitEnd = end;
    this.activeId = undefined;
    this.activeFiles = new Set();
    this.rev += 1;
    return copySession(session);
  }

  rename(id: string, title: string): boolean {
    const session = this.sessions.find((s) => s.id === id);
    const clean = cleanTitle(typeof title === 'string' ? title : '');
    if (session === undefined || clean === '') return false;
    if (session.title !== clean) {
      session.title = clean;
      this.rev += 1;
    }
    return true;
  }

  remove(id: string): boolean {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index < 0) return false;
    this.sessions.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = undefined;
      this.activeFiles = new Set();
    }
    this.rev += 1;
    return true;
  }

  /**
   * Associates an event with the active session; a no-op without one. `isNewOccurrence` is true when the
   * call stands for a change that just happened (merged into an existing event or not): it then counts
   * towards `activityCount` and the per-source totals. False only links the file.
   */
  record(e: ActivityEvent, isNewOccurrence: boolean): void {
    const session = this.current();
    if (session === undefined) return;
    if (e.sessionId !== undefined && e.sessionId !== session.id) return;
    let changed = false;
    if (!this.activeFiles.has(e.filePath) && session.modifiedFiles.length < MAX_SESSION_FILES) {
      this.activeFiles.add(e.filePath);
      session.modifiedFiles.push(e.filePath);
      changed = true;
    }
    if (isNewOccurrence) {
      session.activityCount += 1;
      session.sources[e.sourceType] = (session.sources[e.sourceType] ?? 0) + 1;
      changed = true;
    }
    if (changed) this.rev += 1;
  }

  /** Moves `count` occurrences of a session from one source to another (a late hint corrected an event). */
  reattribute(id: string, from: ActivitySourceType, to: ActivitySourceType, count: number): boolean {
    const session = this.sessions.find((s) => s.id === id);
    if (session === undefined || from === to || !(count > 0)) return false;
    const moved = Math.min(count, session.sources[from] ?? 0);
    if (moved <= 0) return false;
    const left = (session.sources[from] ?? 0) - moved;
    if (left > 0) session.sources[from] = left;
    else delete session.sources[from];
    session.sources[to] = (session.sources[to] ?? 0) + moved;
    this.rev += 1;
    return true;
  }

  /** Re-keys the files of every session after a rename of a file or folder. */
  renameFiles(oldPrefix: FileKey, newPrefix: FileKey): number {
    if (oldPrefix === '' || oldPrefix === newPrefix) return 0;
    let moved = 0;
    for (const s of this.sessions) {
      s.modifiedFiles = s.modifiedFiles.map((f) => {
        if (f !== oldPrefix && !f.startsWith(`${oldPrefix}/`)) return f;
        moved += 1;
        return f === oldPrefix ? newPrefix : `${newPrefix}${f.slice(oldPrefix.length)}`;
      });
      if (s.id === this.activeId) this.activeFiles = new Set(s.modifiedFiles);
    }
    if (moved > 0) this.rev += 1;
    return moved;
  }

  active(): DevelopmentSession | undefined {
    const session = this.current();
    return session === undefined ? undefined : copySession(session);
  }

  /** Newest first, the active one included. */
  list(): DevelopmentSession[] {
    return this.sessions
      .map((s, index) => ({ s, index }))
      .sort((a, b) => b.s.startedAt - a.s.startedAt || b.index - a.index)
      .map((x) => copySession(x.s));
  }

  get(id: string): DevelopmentSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    return session === undefined ? undefined : copySession(session);
  }

  /**
   * Replaces the content with sessions read from storage. A session stored as active (the window closed
   * without stopping it) comes back completed; it ended at its last recorded event when `lastEventAt`
   * knows one, otherwise when it started.
   */
  load(sessions: readonly DevelopmentSession[], lastEventAt?: (sessionId: string) => number | undefined): void {
    const seen = new Set<string>();
    const loaded: DevelopmentSession[] = [];
    for (const raw of sessions) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const s = copySession(raw);
      s.workspaceId = this.workspaceId;
      s.modifiedFiles = s.modifiedFiles.slice(0, MAX_SESSION_FILES);
      if (s.status !== 'completed') {
        s.status = 'completed';
        s.endedAt = Math.max(s.startedAt, lastEventAt?.(s.id) ?? s.startedAt);
      }
      loaded.push(s);
    }
    loaded.sort((a, b) => a.startedAt - b.startedAt);
    this.sessions = loaded;
    this.activeId = undefined;
    this.activeFiles = new Set();
    this.enforceLimit();
    this.rev += 1;
  }

  /** Removes every session, the active one included. */
  clear(): void {
    if (this.sessions.length === 0) return;
    this.sessions = [];
    this.activeId = undefined;
    this.activeFiles = new Set();
    this.rev += 1;
  }

  /**
   * Removes the completed sessions and empties the active one (it keeps its title and start):
   * what "clear history" means while a session is running. Returns how many sessions were removed.
   */
  clearCompleted(): number {
    const active = this.current();
    const removed = this.sessions.length - (active === undefined ? 0 : 1);
    const hadActivity = active !== undefined && (active.activityCount > 0 || active.modifiedFiles.length > 0);
    if (removed === 0 && !hadActivity) return 0;
    this.sessions = active === undefined ? [] : [active];
    if (active !== undefined) {
      active.activityCount = 0;
      active.modifiedFiles = [];
      active.sources = {};
      this.activeFiles = new Set();
    }
    this.rev += 1;
    return removed;
  }

  get revision(): number {
    return this.rev;
  }

  /** Id of the active session without copying it (called for every recorded event). */
  get activeSessionId(): string | undefined {
    return this.activeId;
  }

  // ----------------------------------------------------------------------------

  private current(): DevelopmentSession | undefined {
    return this.activeId === undefined ? undefined : this.sessions.find((s) => s.id === this.activeId);
  }

  /** Time based, so an id is not reused after a restart even when the newest session was removed. */
  private newId(now: number): string {
    const base = `s${Math.max(0, Math.floor(Number.isFinite(now) ? now : 0)).toString(36)}`;
    let id = base;
    for (let n = 2; this.sessions.some((s) => s.id === id); n += 1) id = `${base}-${n.toString(36)}`;
    return id;
  }

  /** Over the limit the oldest completed sessions go; the active one always stays. */
  private enforceLimit(): void {
    while (this.sessions.length > this.maxSessions) {
      const index = this.sessions.findIndex((s) => s.id !== this.activeId);
      if (index < 0) break;
      this.sessions.splice(index, 1);
    }
  }
}
