import * as vscode from 'vscode';
import type { ChangescopeConfig } from '../core/config';
import { buildRepoSnapshot, headChanged } from '../core/git/gitModel';
import type { RawRepo, RepoSnapshot } from '../core/git/gitModel';
import { isUnder } from '../core/pathUtils';
import type { FileKey, GitContext, Scheduler } from '../core/types';
import { fileKeyFromUri, uriFromKey } from './uriKey';

/**
 * Minimal local view of the API of the built-in `vscode.git` extension (`getAPI(1)`).
 * Nothing is imported from that extension: what it hands over is checked before it is used.
 */
interface GitChangeLike {
  readonly uri: vscode.Uri;
  readonly status: number;
}
interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly name?: string; readonly commit?: string; readonly ahead?: number; readonly behind?: number };
    readonly indexChanges?: readonly GitChangeLike[];
    readonly workingTreeChanges?: readonly GitChangeLike[];
    readonly mergeChanges?: readonly GitChangeLike[];
    readonly untrackedChanges?: readonly GitChangeLike[];
    readonly onDidChange: vscode.Event<void>;
  };
}
interface GitApiLike {
  readonly repositories: readonly GitRepositoryLike[];
  readonly onDidOpenRepository: vscode.Event<GitRepositoryLike>;
  readonly onDidCloseRepository: vscode.Event<GitRepositoryLike>;
  readonly state?: string;
  readonly onDidChangeState?: vscode.Event<string>;
}
interface GitExtensionLike {
  readonly enabled?: boolean;
  readonly onDidChangeEnablement?: vscode.Event<boolean>;
  getAPI(version: 1): GitApiLike;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Reads a property of an object from another extension. The Git API exposes its state as getters on a prototype, so a spread would lose them. */
function read(obj: unknown, name: string): unknown {
  return isObject(obj) ? Reflect.get(obj, name) : undefined;
}

function isGitExtension(v: unknown): v is GitExtensionLike {
  return isObject(v) && typeof v['getAPI'] === 'function';
}

function isGitApi(v: unknown): v is GitApiLike {
  return isObject(v) && Array.isArray(v['repositories']) && typeof v['onDidOpenRepository'] === 'function' && typeof v['onDidCloseRepository'] === 'function';
}

function isRepository(v: unknown): v is GitRepositoryLike {
  return isObject(v) && isObject(v['rootUri']) && isObject(v['state']) && typeof v['state']['onDidChange'] === 'function';
}

function changes(list: unknown): Array<{ key: FileKey; status: number }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ key: FileKey; status: number }> = [];
  for (const c of list as unknown[]) {
    const status = read(c, 'status');
    const uri = read(c, 'uri');
    if (typeof status !== 'number' || !isObject(uri) || typeof uri['scheme'] !== 'string' || typeof uri['fsPath'] !== 'string') continue;
    const key = fileKeyFromUri(uri as unknown as vscode.Uri);
    if (key !== undefined) out.push({ key, status });
  }
  return out;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Reads one repository defensively; undefined when it does not look like one. */
function readRepository(repo: unknown): RawRepo | undefined {
  if (!isRepository(repo)) return undefined;
  const root = fileKeyFromUri(repo.rootUri);
  if (root === undefined) return undefined;
  const state: unknown = repo.state;
  const head = read(state, 'HEAD');
  const name = root.split('/').filter((s) => s !== '').pop() ?? root;
  const untracked = read(state, 'untrackedChanges');
  return {
    root,
    name,
    branch: optionalString(read(head, 'name')),
    commit: optionalString(read(head, 'commit')),
    ahead: optionalNumber(read(head, 'ahead')),
    behind: optionalNumber(read(head, 'behind')),
    index: changes(read(state, 'indexChanges')),
    workingTree: changes(read(state, 'workingTreeChanges')),
    merge: changes(read(state, 'mergeChanges')),
    untracked: untracked === undefined ? undefined : changes(untracked),
  };
}

export type GitServiceState = 'disabled' | 'unavailable' | 'loading' | 'ready';

export interface GitServiceDeps {
  scheduler: Scheduler;
  getConfig(): ChangescopeConfig;
  log(msg: string): void;
  /** quiet time before repository state is read again; 0 reads at once and uses no timer */
  debounceMs: number;
}

/** Adapter over the built-in Git extension. Acquired after activation without blocking it; never throws. */
export class GitService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly headEmitter = new vscode.EventEmitter<FileKey>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeHead = this.headEmitter.event;

  private current: GitServiceState = 'loading';
  private reason = 'Looking for the Git extension.';
  private snaps: RepoSnapshot[] = [];
  private api: GitApiLike | undefined;
  private readonly repoSubs = new Map<GitRepositoryLike, vscode.Disposable>();
  private apiSubs: vscode.Disposable[] = [];
  private timer: { cancel(): void } | undefined;
  private starting = false;
  private disposed = false;

  constructor(private readonly deps: GitServiceDeps) {}

  /** Finds and connects to the Git extension. Safe to call again (settings change, extension enabled). */
  async start(): Promise<void> {
    if (this.disposed || this.starting) return;
    this.starting = true;
    try {
      this.release();
      if (!this.deps.getConfig().gitEnabled) return this.set('disabled', 'Git integration is turned off (changescope.git.enabled).');
      this.set('loading', 'Looking for the Git extension.');
      const ext = vscode.extensions.getExtension<unknown>('vscode.git');
      if (ext === undefined) return this.set('unavailable', 'The built-in Git extension (vscode.git) is not installed.');
      let exports: unknown;
      try {
        exports = ext.isActive ? ext.exports : await ext.activate();
      } catch (err) {
        this.deps.log(`git extension failed to activate: ${String(err)}`);
        return this.set('unavailable', 'The built-in Git extension could not be activated.');
      }
      if (this.disposed) return;
      if (!isGitExtension(exports)) return this.set('unavailable', 'The Git extension did not offer its API.');
      if (exports.enabled === false) {
        this.set('unavailable', 'The Git extension is disabled (git.enabled is off).');
        if (typeof exports.onDidChangeEnablement === 'function') {
          this.apiSubs.push(exports.onDidChangeEnablement(() => void this.start()));
        }
        return;
      }
      let api: unknown;
      try {
        api = exports.getAPI(1);
      } catch (err) {
        this.deps.log(`git getAPI failed: ${String(err)}`);
        return this.set('unavailable', 'The Git extension is disabled or its API is not available.');
      }
      if (!isGitApi(api)) return this.set('unavailable', 'The Git extension API has an unexpected shape.');
      this.api = api;
      this.apiSubs.push(
        api.onDidOpenRepository((r) => this.watch(r)),
        api.onDidCloseRepository((r) => this.unwatch(r)),
      );
      if (typeof api.onDidChangeState === 'function') this.apiSubs.push(api.onDidChangeState(() => this.read()));
      for (const r of api.repositories) this.watch(r);
      this.read();
    } catch (err) {
      this.deps.log(`git service failed: ${String(err)}`);
      this.set('unavailable', 'Git information could not be read.');
    } finally {
      this.starting = false;
    }
  }

  /** The setting changed: connect, or disconnect and say why. */
  applyConfig(): void {
    const enabled = this.deps.getConfig().gitEnabled;
    if (enabled && (this.current === 'disabled' || (this.current === 'unavailable' && this.api === undefined))) void this.start();
    else if (!enabled && this.current !== 'disabled') {
      this.release();
      this.set('disabled', 'Git integration is turned off (changescope.git.enabled).');
    }
  }

  state(): GitServiceState {
    return this.current;
  }

  detail(): string {
    return this.reason;
  }

  snapshots(): RepoSnapshot[] {
    return this.snaps;
  }

  /** Branch and commit of the repository that contains `key`, else of the first repository. */
  contextFor(key?: FileKey): GitContext | undefined {
    const repo = (key === undefined ? undefined : this.snaps.find((s) => isUnder(s.root, key))) ?? this.snaps[0];
    if (repo === undefined) return undefined;
    const ctx: GitContext = {};
    if (repo.branch !== undefined) ctx.branch = repo.branch;
    if (repo.commit !== undefined) ctx.commit = repo.commit;
    return ctx.branch === undefined && ctx.commit === undefined ? undefined : ctx;
  }

  /** Opens the diff of a changed file with the Git extension, or the file itself when that is not possible. */
  async openDiff(key: FileKey): Promise<void> {
    const uri = uriFromKey(key);
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
    } catch (err) {
      this.deps.log(`git.openChange failed for ${key}: ${String(err)}`);
      try {
        await vscode.window.showTextDocument(uri, { preview: true });
      } catch (err2) {
        this.deps.log(`open failed for ${key}: ${String(err2)}`);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.changeEmitter.dispose();
    this.headEmitter.dispose();
  }

  // ----------------------------------------------------------------------------

  private set(state: GitServiceState, reason: string): void {
    if (this.current === state && this.reason === reason) return;
    this.current = state;
    this.reason = reason;
    if (state !== 'ready') this.snaps = [];
    if (!this.disposed) this.changeEmitter.fire();
  }

  private release(): void {
    this.timer?.cancel();
    this.timer = undefined;
    for (const d of this.repoSubs.values()) d.dispose();
    this.repoSubs.clear();
    for (const d of this.apiSubs) d.dispose();
    this.apiSubs = [];
    this.api = undefined;
    this.snaps = [];
  }

  private watch(repo: unknown): void {
    if (this.disposed || !isRepository(repo) || this.repoSubs.has(repo)) return;
    this.repoSubs.set(repo, repo.state.onDidChange(() => this.schedule()));
    this.schedule();
  }

  private unwatch(repo: unknown): void {
    if (!isRepository(repo)) return;
    this.repoSubs.get(repo)?.dispose();
    this.repoSubs.delete(repo);
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.deps.debounceMs <= 0) return this.read();
    if (this.timer !== undefined) return;
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.read();
    }, this.deps.debounceMs);
  }

  private read(): void {
    const api = this.api;
    if (this.disposed || api === undefined) return;
    try {
      const next: RepoSnapshot[] = [];
      for (const repo of api.repositories) {
        const raw = readRepository(repo);
        if (raw !== undefined) next.push(buildRepoSnapshot(raw));
      }
      const previous = new Map(this.snaps.map((s) => [s.root, s] as const));
      const before = JSON.stringify(this.snaps);
      this.snaps = next.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
      const wasReady = this.current === 'ready';
      this.current = 'ready';
      this.reason = next.length === 0 ? 'No Git repository is open in this workspace.' : `${next.length} ${next.length === 1 ? 'repository' : 'repositories'}.`;
      for (const s of this.snaps) {
        const before = previous.get(s.root);
        // a repository whose HEAD was not known yet is loading, not switching branch
        if (before !== undefined && (before.branch !== undefined || before.commit !== undefined) && headChanged(before, s)) {
          this.headEmitter.fire(s.root);
        }
      }
      if (!wasReady || before !== JSON.stringify(this.snaps)) this.changeEmitter.fire();
    } catch (err) {
      this.deps.log(`git state could not be read: ${String(err)}`);
      this.set('unavailable', 'Git information could not be read.');
    }
  }
}
