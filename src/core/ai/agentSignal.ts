import { isAbsolutePath, normalizePath } from '../pathUtils';
import type { FileKey } from '../types';

/**
 * The experimental agent signal file (DESIGN-0.3.0 section 9): a JSON Lines file that a user-configured
 * hook appends to. Changescope only reads it. One object per line:
 *   {"agent": string, "file": absolute path, "session"?: string}
 */

/** An adapter that can tell Changescope which agent wrote a file. */
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  state(): 'listening' | 'off' | 'unavailable';
  detail(): string;
  dispose(): void;
}

export const SIGNAL_FILE_NAME = 'agent-events.jsonl';
export const SIGNAL_LIMITS = {
  /** longer lines are skipped */
  LINE: 4096,
  /** the file is emptied by Changescope once it is larger than this */
  FILE: 1024 * 1024,
  AGENT: 64,
  SESSION: 128,
  /** most records taken from one read */
  RECORDS: 500,
} as const;

export interface AgentSignal {
  agent: string;
  file: FileKey;
  session?: string;
}

function cleanLabel(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The name an agent is shown under: control characters removed, trimmed, capped. '' when nothing usable is left. */
export function cleanAgentName(raw: unknown): string {
  return typeof raw === 'string' ? cleanLabel(raw, SIGNAL_LIMITS.AGENT) : '';
}

/** An absolute path as a file key, or undefined when the value is not a usable absolute path. */
export function cleanAgentFile(raw: unknown): FileKey | undefined {
  if (typeof raw !== 'string' || raw === '' || raw.length > SIGNAL_LIMITS.LINE || raw.includes('\u0000')) return undefined;
  if (!isAbsolutePath(raw)) return undefined;
  const key = normalizePath(raw);
  return key === '' ? undefined : key;
}

/** One line of the signal file. Unknown fields are ignored; anything malformed gives undefined. Never throws. */
export function parseSignalLine(line: string): AgentSignal | undefined {
  const text = line.trim();
  if (text === '' || text.length > SIGNAL_LIMITS.LINE) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const agent = cleanAgentName('agent' in value ? value.agent : undefined);
  const file = cleanAgentFile('file' in value ? value.file : undefined);
  if (agent === '' || file === undefined) return undefined;
  const signal: AgentSignal = { agent, file };
  const session: unknown = 'session' in value ? value.session : undefined;
  if (typeof session === 'string') {
    const clean = cleanLabel(session, SIGNAL_LIMITS.SESSION);
    if (clean !== '') signal.session = clean;
  }
  return signal;
}

/**
 * Splits newly read text into complete lines. `rest` is the unfinished last line, to be put in front
 * of the next read; an unfinished line that is already too long is dropped (`rest` is then '' and
 * `skipping` true until the next line break).
 */
export function parseSignalChunk(
  pending: string,
  chunk: string,
  skipping = false,
): { signals: AgentSignal[]; rest: string; skipping: boolean; skipped: number } {
  const signals: AgentSignal[] = [];
  let skipped = 0;
  let text = pending + chunk;
  let skip = skipping;
  if (skip) {
    const nl = text.indexOf('\n');
    if (nl < 0) return { signals, rest: '', skipping: true, skipped };
    text = text.slice(nl + 1);
    skip = false;
    skipped += 1;
  }
  const lines = text.split('\n');
  let rest = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const signal = parseSignalLine(line);
    if (signal === undefined) skipped += 1;
    else if (signals.length < SIGNAL_LIMITS.RECORDS) signals.push(signal);
    else skipped += 1;
  }
  if (rest.length > SIGNAL_LIMITS.LINE) {
    rest = '';
    skip = true;
  }
  return { signals, rest, skipping: skip, skipped };
}

const NEWLINE = 0x0a;
const EMPTY = new Uint8Array(0);

/** The bytes that decide whether a file was replaced rather than appended to: its last few bytes before an offset. */
export const SIGNAL_TAIL_BYTES = 64;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The last `SIGNAL_TAIL_BYTES` bytes of `bytes[0 .. end)`, copied. */
export function signalTail(bytes: Uint8Array, end: number): Uint8Array {
  const stop = Math.max(0, Math.min(end, bytes.length));
  return bytes.slice(Math.max(0, stop - SIGNAL_TAIL_BYTES), stop);
}

/**
 * Did the file keep what was read before? True when the bytes just before `offset` are still `tail`.
 * An append leaves them alone; a file that was emptied and written again (of any length) almost never does.
 * Nothing read yet (offset 0) is trivially kept.
 */
export function signalPrefixKept(bytes: Uint8Array, offset: number, tail: Uint8Array): boolean {
  if (offset <= 0) return true;
  if (offset > bytes.length || tail.length > offset) return false;
  for (let i = 0; i < tail.length; i += 1) {
    if (bytes[offset - tail.length + i] !== tail[i]) return false;
  }
  return true;
}

/**
 * Feeds the signal file to the line parser as bytes. A line is only decoded once its newline has arrived, so a
 * multi-byte character split across two appends is never cut in half (it would decode as U+FFFD and the line
 * would be lost). An unfinished line is kept as bytes; one that is already too long is dropped up to its newline.
 */
export class SignalChunker {
  private pending: Uint8Array = EMPTY;
  private skipping = false;

  /** Forget the unfinished line (the file was replaced or emptied). */
  reset(): void {
    this.pending = EMPTY;
    this.skipping = false;
  }

  push(bytes: Uint8Array): { signals: AgentSignal[]; skipped: number } {
    let data = concat(this.pending, bytes);
    this.pending = EMPTY;
    let skipped = 0;
    if (this.skipping) {
      const nl = data.indexOf(NEWLINE);
      if (nl < 0) return { signals: [], skipped };
      data = data.subarray(nl + 1);
      this.skipping = false;
      skipped += 1;
    }
    const last = data.lastIndexOf(NEWLINE);
    if (last < 0) {
      // a character is at most 4 bytes, so a line longer than that in bytes is longer than the limit in characters
      if (data.length > SIGNAL_LIMITS.LINE * 4) this.skipping = true;
      else this.pending = data.slice();
      return { signals: [], skipped };
    }
    const parsed = parseSignalChunk('', new TextDecoder('utf-8').decode(data.subarray(0, last + 1)));
    skipped += parsed.skipped;
    const rest = data.subarray(last + 1);
    if (rest.length > SIGNAL_LIMITS.LINE * 4) this.skipping = true;
    else this.pending = rest.slice();
    return { signals: parsed.signals, skipped };
  }
}

/** Single-quotes a string for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook a user can add to their own agent configuration so that it appends to the signal file.
 * Written for the hook input that Claude Code documents for `PostToolUse` (JSON on stdin with
 * `tool_input.file_path` and `session_id`); it needs `jq` and a POSIX shell.
 */
export function buildAgentHook(signalPath: string, agent = 'claude-code'): { command: string; settings: string } {
  const filter = `{agent: ${JSON.stringify(agent)}, file: .tool_input.file_path, session: .session_id}`;
  const command = `jq -c ${shellQuote(filter)} >> ${shellQuote(signalPath)}`;
  const settings = JSON.stringify(
    { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command }] }] } },
    null,
    2,
  );
  return { command, settings };
}
