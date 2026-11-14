import * as vscode from 'vscode';
import type { FileShakeConfig } from '../core/config';
import { createExcludeMatcher, relativeForMatch } from '../core/glob';
import { DepGraph, targetsFromReference } from '../core/intelligence/depGraph';
import { analyseImpact } from '../core/intelligence/impact';
import { buildTestIndex } from '../core/intelligence/testMatch';
import type { TestIndex } from '../core/intelligence/testMatch';
import { dirname, extname, isUnder } from '../core/pathUtils';
import { analyzeReferences, detectLanguage, loadProjectInfo } from '../core/references';
import type { ChangeImpact, DashIndexStatus, FileKey, ProbeFs, ProjectInfo, Scheduler, WorkspaceRoot } from '../core/types';
import { createProbeFs } from './referenceService';
import { fileKeyFromUri, uriFromKey } from './uriKey';

/** Re-analysis of one edited file waits this long, so a burst of edits costs one analysis. */
export const REINDEX_DEBOUNCE_MS = 500;
const PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json', 'go.mod', 'composer.json']);
/** Files the scanners understand; everything else is not indexed. */
const INCLUDE_GLOB =
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,go,java,kt,kts,c,h,cc,cpp,cxx,hpp,hh,hxx,rs,rb,php,css,scss,less,html,htm,md,markdown}';
const ALWAYS_EXCLUDE = '{**/node_modules/**,**/.git/**}';
const PROGRESS_EVERY = 25;
/** Deleted files whose importers are remembered (oldest forgotten first), and importers kept per file. */
const MAX_REMEMBERED_FILES = 500;
const MAX_REMEMBERED_IMPORTERS = 500;

export interface DependencyIndexDeps {
  scheduler: Scheduler;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  now(): number;
  log(msg: string): void;
  /** false in test mode: the index then only runs when asked (`build()`), never by itself */
  autoStart: boolean;
}

/** Wraps a ProbeFs so repeated questions during one indexing run are answered from memory. */
function memoised(base: ProbeFs): ProbeFs {
  const files = new Map<FileKey, Promise<boolean>>();
  const dirs = new Map<FileKey, Promise<string[]>>();
  return {
    isFile: (p) => {
      let r = files.get(p);
      if (r === undefined) {
        r = base.isFile(p);
        files.set(p, r);
      }
      return r;
    },
    listDir: (p) => {
      let r = dirs.get(p);
      if (r === undefined) {
        r = base.listDir(p);
        dirs.set(p, r);
      }
      return r;
    },
    readText: (p, max) => base.readText(p, max),
  };
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Workspace dependency index: forward and reverse import edges, built in the background on demand and
 * then kept current one file at a time. Memory only; nothing is written anywhere.
 */
export class DependencyIndex implements vscode.Disposable {
  readonly graph = new DepGraph();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  private current: DashIndexStatus['state'] = 'idle';
  private indexed = 0;
  private total = 0;
  private truncated = false;
  private paths = new Set<FileKey>();
  private generation = 0;
  private running: Promise<void> | undefined;
  private runAgain = false;
  private readonly dirty = new Set<FileKey>();
  /**
   * Who imported a file when it was deleted. A delete cuts every edge that points at the file; when a file with the
   * same path appears again (a tool replacing it, `git checkout`), its importers are re-analysed to bring the edges
   * back. Their own text never changed, so nothing else would ever look at them.
   */
  private readonly droppedImporters = new Map<FileKey, FileKey[]>();
  /** counts changes of the set of indexed paths; the cached test index is valid for one value of it */
  private pathsRev = 0;
  private testIdx: { id: string; index: TestIndex } | undefined;
  private timer: { cancel(): void } | undefined;
  private reindexing: Promise<void> = Promise.resolve();
  private matcher: { key: string; exclude: (rel: string) => boolean; sensitive: (rel: string) => boolean } | undefined;
  private disposed = false;
  revision = 0;

  constructor(private readonly deps: DependencyIndexDeps) {}

  status(): DashIndexStatus {
    const cfg = this.deps.getConfig();
    return { state: cfg.dependencyIndex === 'off' ? 'off' : this.current, indexed: this.indexed, total: this.total, truncated: this.truncated };
  }

  /** Every indexed file path (for related-test matching). */
  allFiles(): ReadonlySet<FileKey> {
    return this.paths;
  }

  /** Starts building when it has not been built yet. A no-op when the index is off, running, or `autoStart` is false. */
  ensureBuilt(): void {
    if (!this.deps.autoStart || this.disposed) return;
    if (this.deps.getConfig().dependencyIndex === 'off' || this.current !== 'idle') return;
    void this.build();
  }

  /** Builds (or rebuilds) the whole index and resolves when it is done. Concurrent calls share one run. */
  build(): Promise<void> {
    if (this.disposed || this.deps.getConfig().dependencyIndex === 'off') return Promise.resolve();
    if (this.running !== undefined) {
      this.runAgain = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.runAgain && !this.disposed) {
        this.runAgain = false;
        void this.build();
      }
    });
    return this.running;
  }

  /** The "Rebuild Dependency Index" command: forget everything and build again. */
  rebuild(): Promise<void> {
    this.generation += 1;
    this.graph.clear();
    this.paths = new Set();
    this.pathsChanged();
    this.droppedImporters.clear();
    this.current = 'idle';
    this.indexed = 0;
    this.total = 0;
    this.truncated = false;
    this.touch();
    if (this.running !== undefined) {
      this.runAgain = true;
      return this.running;
    }
    return this.build();
  }

  /** Resolves when nothing is being built or re-analysed. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      await this.running;
      await this.reindexing;
      if (this.running === undefined && this.timer === undefined && this.dirty.size === 0) return;
      if (this.timer !== undefined) return; // a debounce is waiting for the scheduler; the caller decides when it runs
    }
  }

  impactFor(file: FileKey): ChangeImpact {
    const state = this.status();
    const roots = this.deps.getRoots().map((r) => r.key);
    return analyseImpact({
      file,
      graph: this.graph,
      allFiles: this.paths,
      indexComplete: state.state === 'ready' && !state.truncated,
      now: this.deps.now(),
      roots,
      testIndex: this.testIndex(roots),
    });
  }

  // ---- incremental updates -----------------------------------------------------

  /** A file changed (or was created). Re-analysed after a short quiet time, only once the index exists. */
  onFileChanged(key: FileKey): void {
    if (this.disposed || this.deps.getConfig().dependencyIndex === 'off') return;
    const base = key.split('/').pop() ?? '';
    if (PROJECT_FILES.has(base)) return this.markStale();
    // a path that was deleted comes back: the files that imported it get their edges back by being analysed again
    const importers = this.droppedImporters.get(key) ?? [];
    this.droppedImporters.delete(key);
    const supported = detectLanguage('', key) !== undefined;
    if (this.current === 'indexing') {
      if (supported) this.dirty.add(key);
      for (const importer of importers) this.dirty.add(importer);
      return;
    }
    if (this.current !== 'ready' || (!supported && importers.length === 0)) return;
    if (supported) this.dirty.add(key);
    for (const importer of importers) this.dirty.add(importer);
    if (this.timer !== undefined) return;
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.reindexing = this.reindexing.then(() => this.reindexDirty()).catch((err: unknown) => this.deps.log(`re-index failed: ${String(err)}`));
    }, REINDEX_DEBOUNCE_MS);
  }

  onFileDeleted(key: FileKey): void {
    if (this.disposed || this.current === 'idle') return;
    this.dirty.delete(key);
    // remember whom this cuts loose (not the files that are deleted with it) before the edges are dropped
    for (const [target, importers] of this.graph.importersUnder(key, MAX_REMEMBERED_FILES)) {
      this.rememberImporters(target, importers.filter((i) => !isUnder(key, i)));
    }
    const removed = this.graph.removeUnder(key);
    let dropped = removed;
    for (const p of [...this.paths]) {
      if (isUnder(key, p)) {
        this.paths.delete(p);
        dropped += 1;
      }
    }
    if (dropped > 0) this.pathsChanged();
    if (dropped > 0) {
      this.indexed = this.graph.fileCount;
      this.touch();
    }
  }

  /** A rename or a project file change makes resolution results stale: rebuild in the background. */
  markStale(): void {
    if (this.disposed || this.current === 'idle' || this.current === 'off') return;
    this.generation += 1;
    this.current = 'idle';
    this.timer?.cancel();
    this.timer = undefined;
    this.dirty.clear();
    this.droppedImporters.clear();
    this.touch();
    this.ensureBuilt();
  }

  /** The settings that decide what is indexed changed. */
  applyConfig(): void {
    const key = this.settingsKey();
    if (this.settingsId === undefined) {
      this.settingsId = key;
      return;
    }
    if (key === this.settingsId) return;
    this.settingsId = key;
    if (this.deps.getConfig().dependencyIndex === 'off') {
      this.generation += 1;
      this.graph.clear();
      this.paths = new Set();
      this.pathsChanged();
      this.droppedImporters.clear();
      this.current = 'idle';
      this.indexed = 0;
      this.total = 0;
      this.touch();
    } else if (this.current !== 'idle') {
      this.markStale();
    }
  }
  private settingsId: string | undefined;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.timer?.cancel();
    this.timer = undefined;
    this.dirty.clear();
    this.emitter.dispose();
  }

  // ----------------------------------------------------------------------------

  private settingsKey(): string {
    const c = this.deps.getConfig();
    return JSON.stringify([c.dependencyIndex, c.dependencyMaxFiles, c.excludeGlobs, c.sensitiveGlobs, c.maxFileSizeKb]);
  }

  /** Call after every change of `paths`: the cached test index no longer matches. */
  private pathsChanged(): void {
    this.pathsRev += 1;
    this.testIdx = undefined;
  }

  /** Test files of the indexed paths by stem, rebuilt only when the paths (or the workspace folders) changed. */
  private testIndex(roots: readonly FileKey[]): TestIndex {
    const id = `${this.pathsRev}|${roots.join(',')}`;
    if (this.testIdx?.id !== id) this.testIdx = { id, index: buildTestIndex(this.paths, roots) };
    return this.testIdx.index;
  }

  private rememberImporters(target: FileKey, importers: readonly FileKey[]): void {
    if (importers.length === 0) return;
    this.droppedImporters.delete(target);
    this.droppedImporters.set(target, importers.slice(0, MAX_REMEMBERED_IMPORTERS));
    while (this.droppedImporters.size > MAX_REMEMBERED_FILES) {
      const oldest = this.droppedImporters.keys().next();
      if (oldest.done) break;
      this.droppedImporters.delete(oldest.value);
    }
  }

  private touch(): void {
    this.revision += 1;
    if (!this.disposed) this.emitter.fire();
  }

  private isIgnored(cfg: FileShakeConfig): (key: FileKey) => boolean {
    const id = JSON.stringify([cfg.excludeGlobs, cfg.sensitiveGlobs]);
    if (this.matcher?.key !== id) {
      this.matcher = {
        key: id,
        exclude: createExcludeMatcher(cfg.excludeGlobs, { nocase: process.platform === 'win32' }),
        // sensitivity is a safety filter: matching more than needed is the safe error, so case never matters
        sensitive: createExcludeMatcher(cfg.sensitiveGlobs, { nocase: true }),
      };
    }
    const { exclude, sensitive } = this.matcher;
    const roots = this.deps.getRoots();
    return (key) => {
      const rel = relativeForMatch(key, roots);
      return exclude(rel) || sensitive(rel);
    };
  }

  private async run(): Promise<void> {
    const generation = ++this.generation;
    const cfg = this.deps.getConfig();
    this.settingsId = this.settingsKey();
    this.current = 'indexing';
    this.indexed = 0;
    this.total = 0;
    this.truncated = false;
    this.graph.clear();
    this.paths = new Set();
    this.pathsChanged();
    this.droppedImporters.clear();
    this.dirty.clear();
    this.touch();
    const alive = (): boolean => !this.disposed && generation === this.generation;
    try {
      const ignored = this.isIgnored(cfg);
      const limit = cfg.dependencyMaxFiles;
      const found = await vscode.workspace.findFiles(INCLUDE_GLOB, ALWAYS_EXCLUDE, limit * 3);
      if (!alive()) return;
      const keys: FileKey[] = [];
      for (const uri of found) {
        const key = fileKeyFromUri(uri);
        if (key !== undefined && !ignored(key)) keys.push(key);
      }
      keys.sort();
      this.truncated = found.length >= limit * 3 || keys.length > limit;
      if (keys.length > limit) keys.length = limit;
      this.paths = new Set(keys);
      this.pathsChanged();
      this.total = keys.length;
      this.touch();

      const fs = memoised(createProbeFs());
      const projects = new Map<string, Promise<ProjectInfo>>();
      const roots = this.deps.getRoots().map((r) => r.key);
      for (const key of keys) {
        if (!alive()) return;
        await this.analyseOne(key, cfg, fs, projects, roots, ignored);
        this.indexed += 1;
        if (this.indexed % PROGRESS_EVERY === 0) this.touch();
        await yieldToEventLoop();
      }
      if (!alive()) return;
      this.current = 'ready';
      this.indexed = this.total;
      this.touch();
      if (this.dirty.size > 0) {
        this.timer ??= this.deps.scheduler.setTimeout(() => {
          this.timer = undefined;
          this.reindexing = this.reindexing.then(() => this.reindexDirty()).catch((err: unknown) => this.deps.log(`re-index failed: ${String(err)}`));
        }, REINDEX_DEBOUNCE_MS);
      }
    } catch (err) {
      this.deps.log(`dependency index failed: ${String(err)}`);
      if (alive()) {
        this.current = 'ready';
        this.touch();
      }
    }
  }

  private async reindexDirty(): Promise<void> {
    if (this.disposed || this.current !== 'ready') return;
    const cfg = this.deps.getConfig();
    const keys = [...this.dirty];
    this.dirty.clear();
    const ignored = this.isIgnored(cfg);
    const fs = memoised(createProbeFs());
    const projects = new Map<string, Promise<ProjectInfo>>();
    const roots = this.deps.getRoots().map((r) => r.key);
    for (const key of keys) {
      if (this.disposed) return;
      if (ignored(key)) continue;
      if (!this.paths.has(key)) {
        this.paths.add(key);
        this.pathsChanged();
      }
      await this.analyseOne(key, cfg, fs, projects, roots, ignored);
    }
    this.indexed = Math.max(this.indexed, this.graph.fileCount);
    this.total = Math.max(this.total, this.paths.size);
    this.touch();
  }

  /** Reads one file (its open document when there is one) and replaces its edges. A file that cannot be read keeps its old edges out. */
  private async analyseOne(
    key: FileKey,
    cfg: FileShakeConfig,
    fs: ProbeFs,
    projects: Map<string, Promise<ProjectInfo>>,
    roots: readonly FileKey[],
    ignored: (key: FileKey) => boolean,
  ): Promise<void> {
    try {
      const doc = vscode.workspace.textDocuments.find((d) => fileKeyFromUri(d.uri) === key);
      let text: string | undefined;
      if (doc !== undefined) {
        text = doc.getText();
      } else {
        const uri = uriFromKey(key);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > cfg.maxFileSizeKb * 1024) {
          this.graph.setFile(key, [], detectLanguage('', key) ?? extname(key));
          return;
        }
        text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      }
      const inRoot = roots.filter((r) => isUnder(r, key));
      const projectRoots = inRoot.length > 0 ? [...roots] : [dirname(key)];
      const cacheKey = `${dirname(key)}|${projectRoots.join(',')}`;
      let project = projects.get(cacheKey);
      if (project === undefined) {
        project = loadProjectInfo(fs, key, projectRoots);
        projects.set(cacheKey, project);
      }
      const result = await analyzeReferences({
        path: key,
        languageId: doc?.languageId ?? '',
        text,
        fs,
        project: await project,
        isExcluded: ignored,
        maxFileSizeKb: cfg.maxFileSizeKb,
      });
      this.graph.setFile(key, targetsFromReference(result), result.language ?? extname(key));
    } catch {
      // deleted between listing and reading, or unreadable: it simply has no edges
      this.graph.removeFile(key);
    }
  }
}
