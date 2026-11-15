import * as vscode from 'vscode';
import type { AiProvider } from './core/ai/provider';
import { cleanAgentFile, cleanAgentName } from './core/ai/agentSignal';
import { ManualClock, ManualScheduler, systemClock, systemScheduler } from './core/clock';
import { basename, normalizePath } from './core/pathUtils';
import type { ActivityEvent, Clock, DashAgentAdapter, DashboardState, DevelopmentSession, FileKey, LogEntry, Scheduler, Snapshot, TrackedFile, ViewRow } from './core/types';
import { ActivityService, PAUSED_CONTEXT_KEY } from './vscode/activityService';
import { ApiAgentAdapter, SignalFileAdapter } from './vscode/agentSignal';
import { AiService } from './vscode/aiService';
import type { ConsentPrompt, ProviderHandle } from './vscode/aiService';
import { CollisionNotifier } from './vscode/collisionNotifier';
import type { NotifyFn } from './vscode/collisionNotifier';
import { realConfirm, registerCommands } from './vscode/commands';
import { onDidChangeConfig, readConfig, toggleEnabled } from './vscode/config';
import { ShakeController } from './vscode/controller';
import { DashboardProvider } from './vscode/dashboardProvider';
import type { DashboardStats } from './vscode/dashboardProvider';
import { ShakeDecorationProvider } from './vscode/decorationProvider';
import { DependencyIndex } from './vscode/dependencyIndex';
import { EditWatcher } from './vscode/editWatcher';
import { GitService } from './vscode/gitService';
import { ShakeViewProvider } from './vscode/shakeViewProvider';
import { StatusBar } from './vscode/statusBar';
import { fileKeyFromUri, getRoots } from './vscode/uriKey';

/** What an extension reports when an agent it knows about wrote files. Everything is validated before use. */
export interface AgentActivityReport {
  /** short display name of the agent, for example "my-agent" */
  agent: string;
  /** absolute paths or `file:` URIs */
  files: ReadonlyArray<string | vscode.Uri>;
  sessionId?: string;
}

export interface ChangescopeApi {
  readonly apiVersion: 1;
  getRows(): readonly ViewRow[];
  getTracked(): readonly TrackedFile[];
  getSnapshot(): Snapshot;
  /** calls the decoration provider synchronously */
  getDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
  getStatusText(): string;
  getEventLog(): readonly LogEntry[];
  isEnabled(): boolean;
  /** fires after every model rebuild */
  readonly onDidUpdate: vscode.Event<void>;
  whenReferencesIdle(): Promise<void>;
  // ---- 0.3.0 (additive; apiVersion stays 1) ----
  /**
   * Registers a summary provider. It is only used when the user sets `changescope.ai.mode` to `assisted`, picks
   * it in `changescope.ai.provider` and agrees in the consent dialog; it then receives metadata only, never file
   * contents. `getKey()` returns the key the user stored for this provider id in VS Code secret storage.
   */
  registerAiProvider(provider: AiProvider): ProviderHandle;
  /** Tells Changescope that an agent wrote these files, so recent changes to them are labelled "AI agent". */
  reportAgentActivity(report: AgentActivityReport): void;
  getActivityEvents(): readonly ActivityEvent[];
  getSessions(): readonly DevelopmentSession[];
  getDashboardState(): DashboardState;
  /** only defined when CHANGESCOPE_TEST=1: advance = clock + scheduler (ticks, debounces), then a refresh */
  readonly testing?: {
    advance(ms: number): void;
    overrideFocus(v: boolean | undefined): void;
    /** how often the view was resolved, posted `ready`, and was sent a snapshot */
    viewStats(): { resolved: number; ready: number; sent: number; visible: boolean };
    /** timers still pending on the (single, shared) ManualScheduler: tick chain, reference debounces, save/dirty-settle timers, storage, dashboard and re-index debounces */
    pendingTimers(): number;
    /** same as the VS Code window gaining (true) or losing (false) focus; the real window state is ignored in test mode */
    windowFocusChanged(focused: boolean): void;
    /** same as clicking the row of `key` (a file key) in the Changescope view, just before the file opens */
    noteOpenedFromView(key: string): void;
    // ---- 0.3.0 ----
    /** builds the whole dependency index and resolves when it is done (the index never starts by itself in test mode) */
    buildDependencyIndex(): Promise<void>;
    /** resolves when the index is not building or re-analysing a file (a debounce waiting for `advance` does not count) */
    dependencyIndexIdle(): Promise<void>;
    /** counters of the Activity Bar dashboard view / editor panel */
    dashboardStats(): DashboardStats;
    /** handles a message as if the dashboard webview had sent it (ids are resolved against the state as it is now) */
    dashboardMessage(raw: unknown): void;
    /** writes the history to workspace storage now and resolves when the Memento has taken it */
    flushHistory(): Promise<void>;
    /** replaces the "changed on disk while you have unsaved edits" warning; `undefined` restores the real one */
    overrideCollisionNotify(fn: NotifyFn | undefined): void;
    collisionStats(): { shown: number; last: string | undefined };
    /** replaces the AI consent dialog; `undefined` restores the real one */
    overrideConsentPrompt(fn: ConsentPrompt | undefined): void;
    /** replaces the "are you sure" dialog of `changescope.clearHistory`; `undefined` restores the real one */
    overrideConfirm(fn: ((message: string, action: string) => Thenable<boolean>) | undefined): void;
    /** absolute path of the agent signal file, or undefined without workspace storage */
    agentSignalPath(): string | undefined;
    /** how many times the history was written to the Memento */
    historyWrites(): number;
    /** the raw value under `changescope.history` in workspace storage (undefined when nothing is stored) */
    storedHistory(): unknown;
    /** writes pending history, then replaces events and sessions with what is stored: what a restart does (a running session comes back completed) */
    reloadHistory(): Promise<void>;
  };
}

function readVersion(context: vscode.ExtensionContext): string {
  const pkg: unknown = context.extension.packageJSON;
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

const MAX_REPORTED_FILES = 200;

/** Turns what another extension passed into file keys, dropping everything that is not an absolute file path. */
function reportedFiles(files: unknown): FileKey[] {
  if (!Array.isArray(files)) return [];
  const out: FileKey[] = [];
  for (const f of files.slice(0, MAX_REPORTED_FILES) as unknown[]) {
    let key: FileKey | undefined;
    if (typeof f === 'string') key = cleanAgentFile(f);
    else if (typeof f === 'object' && f !== null && 'scheme' in f && f.scheme === 'file' && 'fsPath' in f && typeof f.fsPath === 'string') {
      key = cleanAgentFile(f.fsPath);
    }
    if (key !== undefined) out.push(key);
  }
  return out;
}

export function activate(context: vscode.ExtensionContext): ChangescopeApi {
  const subs = context.subscriptions;
  const testMode = process.env['CHANGESCOPE_TEST'] === '1';

  let clock: Clock = systemClock;
  let scheduler: Scheduler = systemScheduler;
  let manual: ManualScheduler | undefined;
  if (testMode) {
    const manualClock = new ManualClock(Date.now());
    manual = new ManualScheduler(manualClock);
    clock = manualClock;
    scheduler = manual;
  }
  let focusOverride: boolean | undefined;
  const isWindowFocused = (): boolean => focusOverride ?? (testMode ? true : vscode.window.state.focused);

  let config = readConfig();
  const getConfig = (): typeof config => config;

  const output = vscode.window.createOutputChannel('Changescope');
  subs.push(output);
  const log = (msg: string): void => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  // an opaque id of this workspace's storage folder; never a path
  const workspaceId = context.storageUri ? basename(normalizePath(context.storageUri.fsPath)) || 'no-workspace' : 'no-workspace';

  // ---- 0.3.0 services: none of them does file IO or waits for anything during activation ----
  const git = new GitService({ scheduler, getConfig, log, debounceMs: testMode ? 0 : 300 });
  subs.push(git);

  const activity = new ActivityService({
    clock,
    scheduler,
    getConfig,
    getRoots,
    workspaceId,
    memento: context.workspaceState,
    gitContext: (key) => git.contextFor(key),
    log,
  });
  activity.load();
  subs.push(activity);

  const index = new DependencyIndex({ scheduler, getConfig, getRoots, now: () => clock.now(), log, autoStart: !testMode });
  subs.push(index);

  const collisions = new CollisionNotifier({ clock, getConfig, log });
  subs.push(collisions);

  const ai = new AiService({ clock, scheduler, getConfig, secrets: context.secrets, memento: context.workspaceState, log });
  subs.push(ai);

  const apiAdapter = new ApiAgentAdapter();
  const signal = new SignalFileAdapter({
    storageUri: context.storageUri,
    getConfig,
    onSignal: (s) => activity.reportAgent(s.agent, [s.file], clock.now(), s.session),
    log,
  });
  subs.push(apiAdapter, signal);
  const adapters = (): DashAgentAdapter[] =>
    [apiAdapter, signal].map((a) => ({ id: a.id, label: a.label, state: a.state(), detail: a.detail() }));

  const decorations = new ShakeDecorationProvider();
  subs.push(decorations, vscode.window.registerFileDecorationProvider(decorations));

  const view = new ShakeViewProvider(context.extensionUri, log);
  subs.push(
    view,
    vscode.window.registerWebviewViewProvider(ShakeViewProvider.viewType, view, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  const status = new StatusBar();
  subs.push(status);

  const controller = new ShakeController({
    clock,
    scheduler,
    getConfig,
    getRoots,
    decorations,
    view,
    status,
    extensionVersion: readVersion(context),
    vscodeVersion: vscode.version,
    log,
    hooks: {
      onEvent: (e) => {
        activity.onEvent(e);
        collisions.onEvent(e);
        if (e.eventType === 'delete') index.onFileDeleted(e.key);
        else index.onFileChanged(e.key);
      },
      onRenamed: (oldKey, newKey) => {
        activity.onRenamed(oldKey, newKey);
        index.markStale();
      },
    },
  });
  subs.push(controller);

  const dashboard = new DashboardProvider({
    extensionUri: context.extensionUri,
    extensionId: context.extension.id,
    scheduler,
    now: () => clock.now(),
    getConfig,
    getRoots,
    activity,
    git,
    index,
    ai,
    tracked: () => controller.tracker.snapshot(),
    adapters,
    log,
  });
  subs.push(
    dashboard,
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  const watcher = new EditWatcher({
    clock,
    scheduler,
    getConfig,
    getRoots,
    isWindowFocused,
    log: controller.eventLog,
    burst: controller.burst,
    sink: controller,
    isPaused: () => activity.isPaused(),
  });
  subs.push(watcher);

  let confirm: (message: string, action: string) => Thenable<boolean> = realConfirm;
  subs.push(...registerCommands({ activity, ai, dashboard, index, signal, confirm: (m, a) => confirm(m, a) }));

  subs.push(
    onDidChangeConfig(() => {
      config = readConfig();
      controller.applyConfig();
      activity.applyConfig();
      git.applyConfig();
      index.applyConfig();
      void signal.applyConfig();
      dashboard.invalidate();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller.onRootsChanged();
      index.markStale();
    }),
    // "you" persist until you move to another file or leave the window
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      controller.onActiveEditorChanged(editor ? fileKeyFromUri(editor.document.uri) : undefined),
    ),
    // test mode runs on a fake clock and a pretend window focus; the real window state would make runs depend on the desktop
    ...(testMode ? [] : [vscode.window.onDidChangeWindowState((state) => controller.onWindowFocusChanged(state.focused))]),
    vscode.commands.registerCommand('changescope.toggle', () => toggleEnabled()),
    vscode.commands.registerCommand('changescope.clear', () => controller.clear()),
    vscode.commands.registerCommand('changescope.focusView', () => vscode.commands.executeCommand('changescope.view.focus')),
    vscode.commands.registerCommand('changescope.showDebugInfo', () => {
      output.clear();
      output.appendLine(
        JSON.stringify(
          {
            ...controller.getDebugInfo(),
            // 0.3.0: states and counts only; never keys, request payloads or file contents
            history: { events: activity.events.size, sessions: activity.sessions.list().length, paused: activity.isPaused(), persist: config.historyPersist },
            git: { state: git.state(), detail: git.detail(), repositories: git.snapshots().length },
            dependencyIndex: index.status(),
            agents: adapters(),
            ai: { mode: config.aiMode, provider: config.aiProvider, registered: ai.providers().map((p) => p.id) },
          },
          null,
          2,
        ),
      );
      output.show(true);
    }),
    // changes that reach the dashboard
    activity.onDidChange(() => dashboard.invalidate()),
    git.onDidChange(() => dashboard.invalidate()),
    git.onDidChangeHead((root) => activity.noteGitChange(root, clock.now())),
    index.onDidChange(() => dashboard.invalidate()),
    ai.onDidChange(() => dashboard.invalidate()),
  );

  view.onOpenRow = (id) => controller.noteOpenedFromView(id);

  // publish the initial (empty) model: no file IO, no timers
  controller.refresh();
  void vscode.commands.executeCommand('setContext', PAUSED_CONTEXT_KEY, false);

  const updates = new vscode.EventEmitter<void>();
  subs.push(updates, controller.onDidUpdate(() => updates.fire()), controller.onDidUpdate(() => dashboard.invalidateLive()));

  // after activation, without waiting: the Git extension and (only when the user turned it on) the signal file
  void git.start();
  void signal.applyConfig();

  const api: ChangescopeApi = {
    apiVersion: 1,
    getRows: () => controller.peekRows(),
    getTracked: () => controller.tracker.snapshot(),
    getSnapshot: () => controller.peekSnapshot(),
    getDecoration: (uri) => decorations.provideFileDecoration(uri),
    getStatusText: () => controller.getStatusText(),
    getEventLog: () => controller.eventLog.entries(),
    isEnabled: () => config.enable,
    onDidUpdate: updates.event,
    whenReferencesIdle: () => controller.references.whenIdle(),
    registerAiProvider: (provider) => ai.register(provider),
    reportAgentActivity: (report) => {
      if (typeof report !== 'object' || report === null) return;
      const agent = cleanAgentName(report.agent);
      const files = reportedFiles(report.files);
      if (agent === '' || files.length === 0) return;
      const session = typeof report.sessionId === 'string' && report.sessionId !== '' ? report.sessionId.slice(0, 128) : undefined;
      activity.reportAgent(agent, files, clock.now(), session);
    },
    getActivityEvents: () => activity.events.events(),
    getSessions: () => activity.sessions.list(),
    getDashboardState: () => dashboard.currentState(),
    ...(manual
      ? {
          testing: {
            advance: (ms: number): void => {
              manual.advance(ms);
              controller.refresh();
            },
            overrideFocus: (v: boolean | undefined): void => {
              focusOverride = v;
            },
            viewStats: () => view.stats(),
            pendingTimers: (): number => manual.pending,
            windowFocusChanged: (focused: boolean): void => controller.onWindowFocusChanged(focused),
            noteOpenedFromView: (key: string): void => controller.noteOpenedFromView(key),
            buildDependencyIndex: () => index.build(),
            dependencyIndexIdle: () => index.whenIdle(),
            dashboardStats: () => dashboard.stats(),
            dashboardMessage: (raw: unknown): void => dashboard.handleForTest(raw),
            flushHistory: () => activity.flush(),
            overrideCollisionNotify: (fn: NotifyFn | undefined): void => collisions.overrideNotify(fn),
            collisionStats: () => collisions.stats(),
            overrideConsentPrompt: (fn: ConsentPrompt | undefined): void => ai.overridePrompt(fn),
            overrideConfirm: (fn: ((message: string, action: string) => Thenable<boolean>) | undefined): void => {
              confirm = fn ?? realConfirm;
            },
            agentSignalPath: () => signal.filePath(),
            historyWrites: () => activity.storage.writes,
            storedHistory: (): unknown => context.workspaceState.get<unknown>('changescope.history'),
            reloadHistory: async (): Promise<void> => {
              await activity.flush();
              activity.load();
            },
          },
        }
      : {}),
  };
  return api;
}

export function deactivate(): void {
  // everything is disposed through context.subscriptions
}
