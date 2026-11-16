// Shared helpers for the integration suites. Runs inside VS Code's extension host (bundled by
// esbuild with `vscode` and `mocha` external). Synchronisation is event/state based: the model is
// driven by the extension's ManualClock/ManualScheduler through api.testing, and real asynchrony
// (file watchers, reference analysis) is awaited with a bounded poll that re-reads state, never a
// fixed sleep.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChangescopeApi } from '../../../src/extension';
import type { LogEntry, TrackedFile, ViewRow } from '../../../src/core/types';
import { normalizePath } from '../../../src/core/pathUtils';
import { K } from '../../../src/core/constants';

export const EXT_ID = 'changescope.changescope';
export type TestingApi = NonNullable<ChangescopeApi['testing']>;

let cachedApi: ChangescopeApi | undefined;

export async function getApi(): Promise<ChangescopeApi> {
  if (cachedApi) return cachedApi;
  const ext = vscode.extensions.getExtension<ChangescopeApi>(EXT_ID);
  if (!ext) throw new Error(`extension ${EXT_ID} is not installed in the test host`);
  const api = await ext.activate();
  if (!api || api.apiVersion !== 1) throw new Error('extension did not return the ChangescopeApi');
  cachedApi = api;
  return api;
}

export function testing(api: ChangescopeApi): TestingApi {
  if (!api.testing) throw new Error('api.testing is undefined: CHANGESCOPE_TEST=1 must be set in the launch environment');
  return api.testing;
}

/** FileKey of a file-system path. */
export const keyOf = (fsPath: string): string => normalizePath(fsPath);

export function envPath(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (launched without the runTest.ts harness?)`);
  return v;
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function nextUpdate(api: ChangescopeApi): Promise<void> {
  return new Promise<void>((resolve) => {
    const sub = api.onDidUpdate(() => {
      sub.dispose();
      resolve();
    });
  });
}

/**
 * Waits until `cond()` holds. Each round refreshes the model (api.testing.advance(0): clock does not move) and
 * then waits for the next model update or a short real-time tick, so real file-watcher latency is tolerated
 * without a fixed sleep. Throws with `what` on timeout.
 */
export async function waitUntil(api: ChangescopeApi, cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    testing(api).advance(0);
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await Promise.race([delay(40), nextUpdate(api)]);
  }
}

/**
 * Run a debounce window, let the reference analysis finish, refresh. Real file-system events can schedule a NEW
 * debounce while we are waiting (the fake scheduler only fires it when advanced), so wait in bounded slices and
 * advance again if the service is not idle yet.
 */
export async function settleRefs(api: ChangescopeApi): Promise<void> {
  const t = testing(api);
  for (let i = 0; i < 20; i++) {
    t.advance(K.REF_DEBOUNCE_MS + 1);
    const idle = await Promise.race([api.whenReferencesIdle().then(() => true), delay(150).then(() => false)]);
    if (idle) break;
  }
  t.advance(0);
}

export const rowOf = (api: ChangescopeApi, key: string): ViewRow | undefined => api.getRows().find((r) => r.id === key);
export const trackedOf = (api: ChangescopeApi, key: string): TrackedFile | undefined => api.getTracked().find((t) => t.key === key);
export const logFor = (api: ChangescopeApi, pred: (e: LogEntry) => boolean): LogEntry[] => api.getEventLog().filter(pred);

export function uriOfKey(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath);
}

export async function openDoc(fsPath: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
}

/** Types `text` at the end of the document in the (newly focused) editor, like a user would. */
export async function typeInto(doc: vscode.TextDocument, text = ' '): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  const ok = await editor.edit((b) => b.insert(end, text));
  if (!ok) throw new Error('TextEditor.edit was rejected');
  return editor;
}

export async function revertDirtyDocuments(): Promise<void> {
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty) {
      await vscode.window.showTextDocument(d, { preview: false });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
}

/** Puts the extension, the editors and the fake clock back to a neutral state between tests. */
export async function resetState(api: ChangescopeApi): Promise<void> {
  await revertDirtyDocuments();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  testing(api).overrideFocus(undefined);
  await vscode.commands.executeCommand('changescope.clear');
  testing(api).advance(60_000);
  await api.whenReferencesIdle();
  testing(api).advance(0);
}

export async function setConfig(name: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('changescope').update(name, value, vscode.ConfigurationTarget.Global);
}

export async function resetConfig(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  const pkg = ext?.packageJSON as { contributes?: { configuration?: { properties?: Record<string, unknown> } } } | undefined;
  const names = Object.keys(pkg?.contributes?.configuration?.properties ?? {}).map((k) => k.replace(/^changescope\./, ''));
  const cfg = vscode.workspace.getConfiguration('changescope');
  for (const n of names) {
    if (cfg.inspect(n)?.globalValue !== undefined) await cfg.update(n, undefined, vscode.ConfigurationTarget.Global);
  }
}

/** Creates (or overwrites) a file under `base`, making directories as needed. */
export function writeFile(base: string, rel: string, content: string): string {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function removePath(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** A fresh, uniquely named scratch directory inside `base` (so tests never touch each other's files). */
let scratchCounter = 0;
const livePool = new Map<string, string[]>();
export function scratchDir(base: string, label: string): string {
  const pooled = livePool.get(base)?.shift(); // a directory the watcher is known to be live in (see warmScratchPool)
  if (pooled) return pooled;
  scratchCounter += 1;
  const dir = join(base, `scratch-${label}-${scratchCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Keeps `size` empty scratch directories ready in `base`, each one verified with ensureWatched, for scratchDir to hand out. Call it from an
 * async setup: scratchDir itself is synchronous, and a directory that was created a moment ago may not be watched yet (see ensureWatched).
 */
export async function warmScratchPool(api: ChangescopeApi, base: string, size = 3): Promise<void> {
  const pool = livePool.get(base) ?? [];
  livePool.set(base, pool);
  while (pool.length < size) {
    scratchCounter += 1;
    const dir = join(base, `scratch-pool-${scratchCounter}`);
    await ensureWatched(api, dir);
    pool.push(dir);
  }
}

export function workspaceDir(): string {
  return envPath('FS_TEST_WORKSPACE');
}

export function decorationOf(api: ChangescopeApi, fsPath: string): vscode.FileDecoration | undefined {
  return api.getDecoration(vscode.Uri.file(fsPath));
}

export function colorIdOf(d: vscode.FileDecoration | undefined): string | undefined {
  // ThemeColor.id exists at runtime but is not part of the public typings
  return d?.color instanceof vscode.ThemeColor ? (d.color as unknown as { id?: string }).id : undefined;
}

export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
  return value;
}

/**
 * Like waitUntil, but moves the fake clock forward by `stepMs` each round (for flows that depend on timers,
 * e.g. the short settle delay for a clean-after-change document event).
 */
export async function waitUntilAdvancing(api: ChangescopeApi, stepMs: number, cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    testing(api).advance(stepMs);
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await Promise.race([delay(40), nextUpdate(api)]);
  }
}

/**
 * Types into `doc` and waits until the extension has actually recorded that edit (editCount grew) before
 * returning, so the fake clock can safely be advanced afterwards. VS Code reports the first edit of a clean
 * document and its dirty-state change as two events; waiting here keeps the fake clock from racing them.
 */
export async function typeAndWait(api: ChangescopeApi, doc: vscode.TextDocument, text = ' '): Promise<TrackedFile> {
  const key = keyOf(doc.uri.fsPath);
  const before = trackedOf(api, key)?.editCount ?? 0;
  await typeInto(doc, text);
  await waitUntil(api, () => (trackedOf(api, key)?.editCount ?? 0) > before, `edit #${before + 1} of ${key} to be recorded`);
  return must(trackedOf(api, key), `tracked entry for ${key}`);
}

/**
 * Runs `node -e <code>` in a SEPARATE process (the extension host's own binary in ELECTRON_RUN_AS_NODE mode), so a
 * file written this way is a genuine external edit: it does not come from the test process or the editor.
 */
export function runNode(code: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited with ${String(c)}: ${err}`))));
  });
}

/** Writes `content` to `file` from a separate process. */
export function externalWrite(file: string, content: string): Promise<void> {
  return runNode(`require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})`);
}

/**
 * Creates files on disk, waits until the watcher has reported all of them, then resets the model, so the test starts
 * with files that exist but are not "recently edited" (otherwise green would win over yellow).
 */
export async function createSettled(api: ChangescopeApi, base: string, files: Record<string, string>): Promise<Record<string, string>> {
  // The watcher must be live in every directory before a file is written into it (see ensureWatched), parents first.
  const dirs = new Set<string>([base]);
  for (const rel of Object.keys(files)) {
    for (let d = dirname(join(base, rel)); d.length > base.length; d = dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) await ensureWatched(api, d);
  const out: Record<string, string> = {};
  const contents: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    out[rel] = writeFile(base, rel, content);
    contents[out[rel] as string] = content;
  }
  await waitUntilSeen(api, contents, (p) => trackedOf(api, keyOf(p)) !== undefined, 'the watcher to report every created file', 60_000);
  await resetState(api);
  return out;
}

let probeCounter = 0;

/**
 * Makes sure VS Code's recursive file watcher is live in `dir`, creating the directory if it does not exist. Call it before writing
 * files into a directory that was created moments ago.
 *
 * On Linux the watcher is inotify based, and inotify cannot watch a directory before it exists. A directory created in the short gap
 * between its parent's scan and the new watch is then never watched at all, and no later write into it is ever reported (macOS and
 * Windows do not have that gap). So this writes a probe file until the extension reports it. If it never does, the directory is
 * removed and created again, which the parent's watch reports as a new directory; that is only done while the directory is empty, so
 * it can never delete anything of value.
 *
 * The probe is a `*.log` file: excluded by default, so the extension logs the event but never tracks the file, records no history for
 * it and does not react to its deletion. Probing therefore leaves no state behind and no late event for the next test.
 */
export async function ensureWatched(api: ChangescopeApi, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const text = 'probe\n';
  for (let attempt = 0; attempt < 6; attempt++) {
    probeCounter += 1;
    const probe = join(dir, `.live-probe-${probeCounter}.log`);
    writeFileSync(probe, text);
    let live = true;
    try {
      await waitUntilSeen(api, { [probe]: text }, (p) => logFor(api, (e) => e.key === keyOf(p)).length > 0, 'the file watcher to be live in a directory', 4_000);
    } catch {
      live = false;
    }
    rmSync(probe, { force: true });
    if (live) return;
    if (readdirSync(dir).length > 0) break; // never remove a directory that has content
    rmSync(dir, { recursive: true, force: true });
    await delay(300);
    mkdirSync(dir, { recursive: true });
  }
  throw new Error(`the file watcher did not become live in ${dir}`);
}

/**
 * Like waitUntil for "the watcher has reported these files", but it also rewrites the files that are still unseen every ~750 ms of
 * real time. Recursive inotify watchers (Linux) cannot watch a directory before it exists, so a file written into a directory in
 * the first moments after the directory was created can be missed entirely; macOS (FSEvents) and Windows do not have that gap.
 * A later write is a change event that the now-live watch does see. `files` maps absolute paths to the content to write.
 */
export async function waitUntilSeen(
  api: ChangescopeApi,
  files: Record<string, string>,
  isSeen: (path: string) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  let nextRewrite = Date.now() + 750;
  try {
    await waitUntil(
      api,
      () => {
        const unseen = Object.keys(files).filter((p) => !isSeen(p));
        if (unseen.length === 0) return true;
        if (Date.now() >= nextRewrite) {
          nextRewrite = Date.now() + 750;
          for (const p of unseen) writeFileSync(p, files[p] as string);
        }
        return false;
      },
      what,
      timeoutMs,
    );
  } catch (e) {
    const unseen = Object.keys(files).filter((p) => !isSeen(p));
    throw new Error(`${e instanceof Error ? e.message : String(e)} (never seen: ${unseen.map((p) => basename(p)).join(', ') || 'none'})`, { cause: e });
  }
}

/** Real-time wait (system clock, no seam): polls `cond` every 25 ms until it holds or `timeoutMs` passes. */
export async function waitReal(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms (real time) waiting for: ${what}`);
    await delay(25);
  }
}
