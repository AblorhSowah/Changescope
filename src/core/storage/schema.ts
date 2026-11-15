import { DETECTION_METHODS, EVENT_TYPES, SESSION_STATUSES, SOURCE_TYPES } from '../dashboard/protocol';
import { MAX_SESSION_FILES } from '../sessions/sessionManager';
import type { ActivityEvent, ActivitySourceType, DevelopmentSession, GitContext, ReviewStatus } from '../types';

/** Version of the persisted history (workspace Memento key `changescope.history`). */
export const STORAGE_SCHEMA = 1;
export const STORAGE_KEY = 'changescope.history';

/** Hard bounds on what is read back, whatever a stored value claims. */
export const STORAGE_LIMITS = { EVENTS: 5000, SESSIONS: 200, PATH: 4096, ID: 64, TEXT: 200 } as const;

type Obj = Record<string, unknown>;

/** Converters from older schemas to the current one. Empty for now: schema 1 is the first. */
const migrate: Readonly<Record<number, (raw: Obj) => Obj>> = {};

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number, allowEmpty = false): string | undefined {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0) ? v : undefined;
}

function time(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  for (const a of allowed) if (a === v) return a;
  return undefined;
}

const REVIEW: readonly ReviewStatus[] = ['reviewed', 'unreviewed'];

function readEvent(v: unknown): ActivityEvent | undefined {
  if (!isObj(v)) return undefined;
  const id = text(v['id'], STORAGE_LIMITS.ID);
  const workspaceId = text(v['workspaceId'], STORAGE_LIMITS.TEXT);
  const filePath = text(v['filePath'], STORAGE_LIMITS.PATH);
  const eventType = oneOf(v['eventType'], EVENT_TYPES);
  const sourceType = oneOf(v['sourceType'], SOURCE_TYPES);
  const detectionMethod = oneOf(v['detectionMethod'], DETECTION_METHODS);
  const confidence = v['confidence'];
  const timestamp = time(v['timestamp']);
  const lastTimestamp = time(v['lastTimestamp']);
  const count = v['count'];
  if (
    id === undefined ||
    workspaceId === undefined ||
    filePath === undefined ||
    eventType === undefined ||
    sourceType === undefined ||
    detectionMethod === undefined ||
    typeof confidence !== 'number' ||
    !(confidence >= 0 && confidence <= 1) ||
    timestamp === undefined ||
    lastTimestamp === undefined ||
    lastTimestamp < timestamp ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 1
  ) {
    return undefined;
  }
  const event: ActivityEvent = { id, workspaceId, filePath, eventType, sourceType, detectionMethod, confidence, timestamp, lastTimestamp, count };
  if (v['sessionId'] !== undefined) {
    const sessionId = text(v['sessionId'], STORAGE_LIMITS.ID);
    if (sessionId === undefined) return undefined;
    event.sessionId = sessionId;
  }
  if (v['sourceId'] !== undefined) {
    const sourceId = text(v['sourceId'], STORAGE_LIMITS.TEXT);
    if (sourceId === undefined) return undefined;
    event.sourceId = sourceId;
  }
  if (v['reviewStatus'] !== undefined) {
    const reviewStatus = oneOf(v['reviewStatus'], REVIEW);
    if (reviewStatus === undefined) return undefined;
    event.reviewStatus = reviewStatus;
  }
  // the two must agree: your own changes carry no review state, everything else does
  if (sourceType === 'developer') delete event.reviewStatus;
  else event.reviewStatus ??= 'unreviewed';
  return event;
}

function readGit(v: unknown): GitContext | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  const out: GitContext = {};
  if (v['branch'] !== undefined) {
    const branch = text(v['branch'], STORAGE_LIMITS.TEXT);
    if (branch === undefined) return null;
    out.branch = branch;
  }
  if (v['commit'] !== undefined) {
    const commit = text(v['commit'], STORAGE_LIMITS.TEXT);
    if (commit === undefined) return null;
    out.commit = commit;
  }
  return out;
}

function readSession(v: unknown): DevelopmentSession | undefined {
  if (!isObj(v)) return undefined;
  const id = text(v['id'], STORAGE_LIMITS.ID);
  const title = text(v['title'], STORAGE_LIMITS.TEXT);
  const workspaceId = text(v['workspaceId'], STORAGE_LIMITS.TEXT);
  const startedAt = time(v['startedAt']);
  const status = oneOf(v['status'], SESSION_STATUSES);
  const activityCount = v['activityCount'];
  const files = v['modifiedFiles'];
  const rawSources = v['sources'];
  if (
    id === undefined ||
    title === undefined ||
    workspaceId === undefined ||
    startedAt === undefined ||
    status === undefined ||
    typeof activityCount !== 'number' ||
    !Number.isSafeInteger(activityCount) ||
    activityCount < 0 ||
    !Array.isArray(files) ||
    files.length > MAX_SESSION_FILES ||
    !isObj(rawSources)
  ) {
    return undefined;
  }
  const modifiedFiles: string[] = [];
  for (const f of files) {
    const path = text(f, STORAGE_LIMITS.PATH);
    if (path === undefined) return undefined;
    modifiedFiles.push(path);
  }
  const sources: Partial<Record<ActivitySourceType, number>> = {};
  for (const type of SOURCE_TYPES) {
    const n = rawSources[type];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return undefined;
    if (n > 0) sources[type] = n;
  }
  const session: DevelopmentSession = { id, title, workspaceId, startedAt, status, activityCount, modifiedFiles, sources };
  if (v['endedAt'] !== undefined) {
    const endedAt = time(v['endedAt']);
    if (endedAt === undefined || endedAt < startedAt) return undefined;
    session.endedAt = endedAt;
  }
  const gitStart = readGit(v['gitStart']);
  const gitEnd = readGit(v['gitEnd']);
  if (gitStart === null || gitEnd === null) return undefined;
  if (gitStart !== undefined) session.gitStart = gitStart;
  if (gitEnd !== undefined) session.gitEnd = gitEnd;
  return session;
}

/** The value written to storage. Plain data, safe to hand to a Memento. */
export function serialise(events: readonly ActivityEvent[], sessions: readonly DevelopmentSession[], now: number): unknown {
  return {
    schema: STORAGE_SCHEMA,
    savedAt: now,
    events: events.map((e) => ({ ...e })),
    sessions: sessions.map((s) => ({
      ...s,
      modifiedFiles: [...s.modifiedFiles],
      sources: { ...s.sources },
      ...(s.gitStart ? { gitStart: { ...s.gitStart } } : {}),
      ...(s.gitEnd ? { gitEnd: { ...s.gitEnd } } : {}),
    })),
  };
}

/**
 * Reads a stored value back. Every record is checked field by field and an invalid one is dropped
 * (`recovered` counts them); a missing or unknown schema gives an empty history. Never throws.
 */
export function deserialise(raw: unknown): { events: ActivityEvent[]; sessions: DevelopmentSession[]; recovered: number } {
  const empty = { events: [], sessions: [], recovered: 0 };
  try {
    if (!isObj(raw)) return empty;
    let data = raw;
    let schema = data['schema'];
    // older schemas are brought forward one step at a time
    for (let guard = 0; typeof schema === 'number' && schema < STORAGE_SCHEMA && guard < 32; guard += 1) {
      const step = migrate[schema];
      if (step === undefined) return empty;
      data = step(data);
      schema = data['schema'];
    }
    if (schema !== STORAGE_SCHEMA) return empty;

    let recovered = 0;
    const events: ActivityEvent[] = [];
    const rawEvents: unknown[] = Array.isArray(data['events']) ? data['events'] : [];
    // when more is stored than may be read, the newest (the end of the list) is what is kept
    const firstEvent = Math.max(0, rawEvents.length - STORAGE_LIMITS.EVENTS);
    recovered += firstEvent;
    for (let i = firstEvent; i < rawEvents.length; i += 1) {
      const e = readEvent(rawEvents[i]);
      if (e === undefined) recovered += 1;
      else events.push(e);
    }

    const sessions: DevelopmentSession[] = [];
    const rawSessions: unknown[] = Array.isArray(data['sessions']) ? data['sessions'] : [];
    const firstSession = Math.max(0, rawSessions.length - STORAGE_LIMITS.SESSIONS);
    recovered += firstSession;
    for (let i = firstSession; i < rawSessions.length; i += 1) {
      const s = readSession(rawSessions[i]);
      if (s === undefined) recovered += 1;
      else sessions.push(s);
    }
    return { events, sessions, recovered };
  } catch {
    return empty;
  }
}
