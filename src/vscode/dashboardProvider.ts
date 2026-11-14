import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildSummaryInput } from '../core/ai/provider';
import type { FileShakeConfig } from '../core/config';
import { buildDashboardState, stateSignature } from '../core/dashboard/model';
import type { FileLiveState } from '../core/dashboard/model';
import { DASH_LIMITS, parseDashboardWebviewMessage } from '../core/dashboard/protocol';
import type { DashboardHostMessage, DashboardWebviewMessage } from '../core/dashboard/protocol';
import { createExcludeMatcher, relativeForMatch } from '../core/glob';
import { toSafeDisplayPath } from '../core/pathUtils';
import { buildWebviewHtml, makeNonce } from '../core/webviewHtml';
import type {
  ChangeImpact,
  DashAgentAdapter,
  DashSettings,
  DashSummary,
  DashboardState,
  FileKey,
  Scheduler,
  TrackedFile,
  WorkspaceRoot,
} from '../core/types';
import type { ActivityService } from './activityService';
import type { AiService } from './aiService';
import { updateSetting } from './config';
import type { DependencyIndex } from './dependencyIndex';
import type { GitService } from './gitService';
import { uriFromKey } from './uriKey';

/** Rebuilds while a target is visible are batched: one rebuild at most this long after the first trigger. */
export const DASHBOARD_DEBOUNCE_MS = 250;
const IMPACT_ROWS = 50;

export interface DashboardDeps {
  extensionUri: vscode.Uri;
  /** `publisher.name`, used to open the settings page filtered to this extension */
  extensionId: string;
  scheduler: Scheduler;
  now(): number;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  activity: ActivityService;
  git: GitService;
  index: DependencyIndex;
  ai: AiService;
  /** files the tracker currently shows (phase and intensity) */
  tracked(): readonly TrackedFile[];
  adapters(): DashAgentAdapter[];
  log(msg: string): void;
}

interface Target {
  readonly webview: vscode.Webview;
  visible(): boolean;
}

/** Everything the webview may name, taken from the last state that was sent to it. */
interface KnownIds {
  files: Set<FileKey>;
  gitFiles: Set<FileKey>;
  sessions: Set<string>;
}

export interface DashboardStats {
  resolved: number;
  ready: number;
  sent: number;
  visible: boolean;
  panelOpen: boolean;
  lastSeq: number;
}

/**
 * The dashboard: a webview view in the File Shake Activity Bar container, and optionally the same page in
 * an editor tab. It rebuilds and posts state only while a target is visible, never trusts an id from the
 * webview beyond looking it up in the state it last sent, and holds no logic of its own.
 */
export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'fileShake.dashboard';
  static readonly panelType = 'fileShake.dashboardPanel';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private viewSubs: vscode.Disposable[] = [];
  private panelSubs: vscode.Disposable[] = [];

  private seq = 0;
  private lastSignature = '';
  private lastState: DashboardState | undefined;
  private liveSignature = '';
  private known: KnownIds = { files: new Set(), gitFiles: new Set(), sessions: new Set() };
  private selection: FileKey | undefined;
  private summary: DashSummary | null = null;
  private timer: { cancel(): void } | undefined;
  private disposed = false;
  private resolved = 0;
  private ready = 0;
  private sent = 0;

  constructor(private readonly deps: DashboardDeps) {}

  // ---- hosting -----------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.releaseView();
    this.resolved += 1;
    this.view = view;
    this.setup(view.webview, 'Activity');
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.rebuild(true);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.releaseView();
      }),
    );
  }

  /** Opens the same page in an editor tab (one at a time), or brings the open one forward. */
  openPanel(): void {
    if (this.disposed) return;
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(DashboardProvider.panelType, 'File Shake', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: this.roots(),
    });
    this.panel = panel;
    this.setup(panel.webview, 'Activity');
    this.panelSubs.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.rebuild(true);
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) this.releasePanel();
      }),
    );
  }

  /** Focuses the Activity Bar view (the auto-generated `<view id>.focus` command). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${DashboardProvider.viewType}.focus`);
  }

  isVisible(): boolean {
    return this.targets().length > 0;
  }

  stats(): DashboardStats {
    return {
      resolved: this.resolved,
      ready: this.ready,
      sent: this.sent,
      visible: this.isVisible(),
      panelOpen: this.panel !== undefined,
      lastSeq: this.lastState?.seq ?? -1,
    };
  }

  // ---- state -------------------------------------------------------------------

  /** Asks for a rebuild after something changed. Coalesced; does nothing while no target is visible. */
  invalidate(): void {
    if (this.disposed || !this.isVisible() || this.timer !== undefined) return;
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.rebuild(false);
    }, DASHBOARD_DEBOUNCE_MS);
  }

  /**
   * The model was rebuilt (every 200 ms while something is active, and on every refresh). Only a change in what is
   * shaking matters here, so an unchanged model never schedules a timer and an idle workspace stays timer-free.
   */
  invalidateLive(): void {
    const signature = this.deps
      .tracked()
      .map((t) => `${t.key}:${t.phase}:${Math.round(t.intensity * 100)}`)
      .join('|');
    if (signature === this.liveSignature) return;
    this.liveSignature = signature;
    this.invalidate();
  }

  /** The state as it is right now, without posting it (extension API and tests). */
  currentState(): DashboardState {
    return this.build(this.seq);
  }

  /** The user selected a file elsewhere (a command): show its dependencies and impact. */
  select(key: FileKey | undefined): void {
    this.selection = key;
    if (key !== undefined) this.deps.index.ensureBuilt();
    this.rebuild(true);
  }

  private build(seq: number): DashboardState {
    const cfg = this.deps.getConfig();
    const roots = this.deps.getRoots();
    const { activity, git, index } = this.deps;

    const live = new Map<FileKey, FileLiveState>();
    for (const t of this.deps.tracked()) live.set(t.key, { phase: t.phase, intensity: t.intensity });
    const files = activity.events.files();

    const wantImpacts = cfg.dependencyIndex !== 'off' && (this.selection !== undefined || cfg.viewMode === 'impact');
    const impacts = new Map<FileKey, ChangeImpact>();
    if (wantImpacts && index.status().state !== 'idle') {
      if (cfg.viewMode === 'impact') {
        for (const f of files) {
          if (impacts.size >= IMPACT_ROWS) break;
          if (f.exists) impacts.set(f.key, index.impactFor(f.key));
        }
      }
      if (this.selection !== undefined && !impacts.has(this.selection)) impacts.set(this.selection, index.impactFor(this.selection));
    }
    const selected = this.selection;

    const settings: DashSettings = {
      mode: cfg.viewMode,
      animate: cfg.enableAnimation,
      animationIntensity: cfg.animationIntensity,
      paused: activity.isPaused(),
      collisions: cfg.collisionsNotify,
      dependencyIndex: cfg.dependencyIndex !== 'off',
      gitEnabled: cfg.gitEnabled,
      historyLimit: cfg.historyMaxEvents,
      retentionDays: cfg.historyRetentionDays,
      aiMode: cfg.aiMode,
      aiProvider: this.deps.ai.activeProvider()?.id ?? null,
    };

    return buildDashboardState({
      now: this.deps.now(),
      seq,
      enabled: cfg.enable,
      roots,
      files,
      live,
      events: activity.events.recent(DASH_LIMITS.TIMELINE),
      eventCount: activity.events.size,
      unreviewed: activity.events.unreviewedFiles(),
      sessions: activity.sessions.list(),
      git: { state: git.state(), detail: git.detail(), repos: git.snapshots() },
      selection: {
        file: selected,
        imports: selected === undefined ? [] : index.graph.importsOf(selected),
        importedBy: selected === undefined ? [] : index.graph.importedBy(selected),
        impact: selected === undefined ? undefined : impacts.get(selected),
      },
      impacts,
      index: index.status(),
      settings,
      agents: this.deps.adapters(),
      summary: this.summary,
    });
  }

  /** Rebuilds; posts only when something other than the clock changed (or when `force`, for a webview that just appeared). */
  private rebuild(force: boolean): void {
    if (this.disposed) return;
    const state = this.build(this.seq + 1);
    const signature = stateSignature(state);
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.seq = state.seq;
    this.lastState = state;
    this.remember(state);
    this.post({ type: 'state', state });
  }

  private remember(state: DashboardState): void {
    const files = new Set<FileKey>();
    for (const f of state.files) files.add(f.id);
    for (const t of state.timeline) files.add(t.fileId);
    const sel = state.selection;
    if (sel.file !== null) files.add(sel.file.id);
    for (const d of [...sel.imports, ...sel.importedBy]) files.add(d.id);
    for (const i of [...state.impacts, ...(sel.impact === null ? [] : [sel.impact])]) {
      files.add(i.file.id);
      for (const r of [...i.affected, ...i.tests, ...i.configs]) files.add(r.id);
    }
    const gitFiles = new Set<FileKey>();
    for (const repo of state.git.repos) for (const c of [...repo.staged, ...repo.unstaged, ...repo.untracked]) gitFiles.add(c.id);
    const sessions = new Set<string>();
    if (state.sessions.active !== null) sessions.add(state.sessions.active.id);
    for (const s of state.sessions.previous) sessions.add(s.id);
    this.known = { files: new Set([...files, ...gitFiles]), gitFiles, sessions };
  }

  // ---- messages ----------------------------------------------------------------

  /** Test seam: handles a message as if the webview had sent it, after refreshing what ids may refer to. */
  handleForTest(raw: unknown): void {
    this.remember(this.build(this.seq));
    this.onMessage(raw);
  }

  private onMessage(raw: unknown): void {
    const msg = parseDashboardWebviewMessage(raw);
    if (msg === null || this.disposed) return;
    try {
      this.handle(msg);
    } catch (err) {
      this.deps.log(`dashboard message ${msg.type} failed: ${String(err)}`);
    }
  }

  private handle(msg: DashboardWebviewMessage): void {
    const { activity } = this.deps;
    switch (msg.type) {
      case 'ready':
        this.ready += 1;
        this.rebuild(true);
        return;
      case 'error':
        this.deps.log(`dashboard error: ${msg.message}`);
        return;
      case 'open':
        if (this.known.files.has(msg.id)) void this.open(msg.id);
        return;
      case 'openDiff':
        if (this.known.gitFiles.has(msg.id)) void this.deps.git.openDiff(msg.id);
        return;
      case 'select':
        if (this.known.files.has(msg.id)) this.select(msg.id);
        return;
      case 'setMode':
        void updateSetting('viewMode', msg.mode);
        return;
      case 'setAnimate':
        void updateSetting('enableAnimation', msg.value);
        return;
      case 'setPaused':
        activity.setPaused(msg.value);
        return;
      case 'markReviewed':
        if (this.known.files.has(msg.id)) activity.markReviewed(msg.id);
        return;
      case 'markAllReviewed':
        activity.markAllReviewed();
        return;
      case 'sessionStart':
        activity.startSession(msg.title);
        return;
      case 'sessionStop':
        activity.stopSession();
        return;
      case 'sessionRename':
        if (this.known.sessions.has(msg.id)) activity.renameSession(msg.id, msg.title);
        return;
      case 'sessionExport':
        if (this.known.sessions.has(msg.id)) void vscode.commands.executeCommand('fileShake.exportSessionReport', msg.id);
        return;
      case 'clearHistory':
        void vscode.commands.executeCommand('fileShake.clearHistory');
        return;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.deps.extensionId}`);
        return;
      case 'summarize':
        void this.summarize();
        return;
    }
  }

  private async open(key: FileKey): Promise<void> {
    try {
      await vscode.window.showTextDocument(uriFromKey(key), { preview: true });
    } catch (err) {
      // a deleted or moved file: the row stays, the editor just does not open
      this.deps.log(`open failed for ${key}: ${String(err)}`);
    }
  }

  /** Builds a summary from metadata (local, or through a registered provider with consent) and shows it. */
  async summarize(): Promise<DashSummary> {
    const { activity, git } = this.deps;
    const roots = this.deps.getRoots();
    const cfg = this.deps.getConfig();
    const session = activity.sessions.active();
    const input = buildSummaryInput({
      files: activity.events.files(),
      // the request may leave the machine: workspace-relative paths only, never an absolute one
      toDisplay: (k) => toSafeDisplayPath(k, roots),
      isSensitive: (k) => this.isSensitive(k, cfg, roots),
      session: session === undefined ? undefined : { title: session.title, durationMs: this.deps.now() - session.startedAt },
      branch: git.contextFor()?.branch,
    });
    const result = await this.deps.ai.summarize(session === undefined ? 'changes' : 'session', input);
    this.summary = result;
    this.rebuild(true);
    return result;
  }

  private sensitiveCache: { key: string; fn: (rel: string) => boolean } | undefined;

  private isSensitive(key: FileKey, cfg: FileShakeConfig, roots: readonly WorkspaceRoot[]): boolean {
    const id = JSON.stringify(cfg.sensitiveGlobs);
    if (this.sensitiveCache?.key !== id) {
      this.sensitiveCache = { key: id, fn: createExcludeMatcher(cfg.sensitiveGlobs, { nocase: true }) };
    }
    return this.sensitiveCache.fn(relativeForMatch(key, roots));
  }

  // ---- plumbing ----------------------------------------------------------------

  private roots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.deps.extensionUri, 'dist'), vscode.Uri.joinPath(this.deps.extensionUri, 'media')];
  }

  private setup(webview: vscode.Webview, title: string): void {
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(this.deps.extensionUri, 'media');
    webview.html = buildWebviewHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce((n) => randomBytes(n)),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'dashboard.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(),
      title: `File Shake ${title}`,
    });
  }

  private targets(): Target[] {
    const out: Target[] = [];
    if (this.view?.visible === true) out.push({ webview: this.view.webview, visible: () => true });
    if (this.panel?.visible === true) out.push({ webview: this.panel.webview, visible: () => true });
    return out;
  }

  private post(message: DashboardHostMessage): void {
    for (const t of this.targets()) {
      this.sent += 1;
      Promise.resolve(t.webview.postMessage(message)).catch((err: unknown) => this.deps.log(`dashboard postMessage failed: ${String(err)}`));
    }
  }

  private releaseView(): void {
    for (const d of this.viewSubs) d.dispose();
    this.viewSubs = [];
    this.view = undefined;
  }

  private releasePanel(): void {
    for (const d of this.panelSubs) d.dispose();
    this.panelSubs = [];
    this.panel = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.releaseView();
    const panel = this.panel;
    this.releasePanel();
    panel?.dispose();
  }
}
