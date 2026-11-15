# Changescope 0.3.0: Experience and Intelligence Foundation (design contract)

Extends `docs/DESIGN.md` (still binding for everything that exists in 0.2.0). Where the two differ for new 0.3.0 work, this file wins. Builder deviations go in `## Deviations` at the bottom, never silently.

Shared types are already written and are part of this contract: `src/core/types.ts` (the block marked 0.3.0) and `src/core/dashboard/protocol.ts`. Do not change their shapes without recording a deviation, because the host and the dashboard are built in parallel against them.

## 1. Audit of 0.2.0 (what exists, what stays)

| Area | 0.2.0 state | 0.3.0 decision |
|---|---|---|
| Live view (`changescope.view`, Explorer, `src/webview`) | Shaking tree of edited and referenced files, You / External sections, 480-line app, strict CSP | **Unchanged.** It is "Live Mode, the original experience". Only two additive inputs: compact mode sends `animate: false`, `animationIntensity` scales `shake.amp` and `shake.rot` when the snapshot is built |
| Source detection (`editWatcher`, `sourceClassifier`) | `you` or `external` plus a `ClassifyReason`; cannot name the writer | Kept as the detection layer. A new attribution step maps it to six source types with a method and a confidence |
| Reference analysis (`core/references`, `referenceService`) | Forward imports of the edited file only, 16 language keys, LRU 50 | Reused as the parser for a workspace dependency index (forward and reverse edges) |
| Tracker, decorations, status bar | Stable, 1,300 tests | Unchanged |
| Storage | None (memory only) | Workspace `Memento` for history and sessions, versioned, validated on load |
| Git, sessions, impact, dashboard, AI | Absent | New (sections 4 to 9) |
| Manifest | `publisher` and `repository.url` are placeholders | Repository set to `https://github.com/AblorhSowah/file-shake.git`. Publisher stays a placeholder (now `changescope`) until the owner supplies a Marketplace publisher id |
| Baseline | build, lint clean; unit 1,309 pass, 1 fail, 12 skipped | The failure is `harness.test.ts` (fixture `test/fixtures/workspace/node_modules/pkg/index.js.fixture` is swallowed by `.gitignore`). Fix: un-ignore `test/fixtures/**/node_modules/` and add the fixture |

No 0.2.0 behaviour, setting, command, view id, colour id or API member is removed or renamed.

## 2. Scope of 0.3.0 against the roadmap priorities

| Priority | Delivered in 0.3.0 | Depth |
|---|---|---|
| P0 | Activity Bar container with the dashboard; three visual modes; activity history with six source classes, method and confidence; Git awareness; new settings; pause; reduced motion; accessibility | Complete |
| P1 | Dependency index (forward and reverse), impact estimate with reasons and related tests, user-controlled sessions with export, collision notification | Complete for the supported languages of `core/references` (TS, JS, PHP and Python first) |
| P2 | Provider-independent AI interface, local summaries, consent gate, SecretStorage plumbing, agent adapter registry, one experimental adapter (agent signal file) | Foundation. **No network AI provider ships in 0.3.0.** Assisted mode works only when another extension registers a provider through the API |
| P3 | Nothing | Future |

Honest limits that the README and the UI must state:
1. VS Code gives extensions no writer identity. A change is `ai-agent` only when an adapter reported it (the agent signal file, or `reportAgentActivity`). Everything else an agent writes shows as `external`. No "Claude", "Copilot" or "Cursor" integration is claimed.
2. `git` attribution is a time correlation with a repository state change (confidence 0.8), not proof.
3. Impact levels are estimates from import edges. They are never presented as defects.
4. Dependency edges come from the regex scanners of 0.2.0 (not an AST or a language server).

## 3. Layout (new files only)

```
src/core/                      # PURE: no vscode / node imports (lint enforces)
  activity/attribution.ts      # ClassifyReason -> source type, method, confidence; hints
  activity/eventStore.ts       # bounded, coalescing history + per-file summaries + review state
  sessions/sessionManager.ts   # start / stop / rename / remove, event association
  sessions/report.ts           # Markdown and JSON report (relative paths only)
  intelligence/depGraph.ts     # forward + reverse edges, incremental update
  intelligence/testMatch.ts    # is this a test file; which tests belong to a file
  intelligence/impact.ts       # ChangeImpact with reasons
  git/gitModel.ts              # pure mapping of git status numbers and repo snapshots
  ai/provider.ts               # AiProvider interface, registry, consent gate, payload builder
  ai/localSummary.ts           # metadata-only summary (no source code)
  storage/schema.ts            # serialise / validate / migrate persisted history
  dashboard/protocol.ts        # (written) validated messages
  dashboard/model.ts           # buildDashboardState(...) from the stores
src/vscode/
  activityService.ts           # owns EventStore + SessionManager + attribution; persistence; pause
  gitService.ts                # vscode.git API adapter, degrades to 'unavailable'
  dependencyIndex.ts           # background, incremental workspace index
  collisionNotifier.ts         # external change to a dirty document -> notification
  agentSignal.ts               # experimental agent signal file adapter
  aiService.ts                 # provider registry, consent, SecretStorage
  dashboardProvider.ts         # WebviewViewProvider + optional editor panel
  storage.ts                   # Memento adapter with debounce and flush
src/dashboard/  main.ts app.ts (+ small view modules)   # second browser bundle -> dist/dashboard.js
media/dashboard.css  media/activity.svg (Activity Bar icon, monochrome, currentColor)
.github/workflows/ci.yml  release.yml
```

Rules carried over: core stays pure; the dashboard bundle may import only from `src/core` modules that do not pull `picomatch` or `jsonc-parser` (`types`, `constants`, `intensity`, `dashboard/protocol`); no `innerHTML`, no `style` attributes, CSS custom properties only through `style.setProperty`; every timer goes through the injected `Scheduler`; every disposable goes to `context.subscriptions`; activation does no file IO.

Lint: extend the `src/webview/**` ESLint block (browser globals, banned DOM properties, no `vscode` import) to `src/dashboard/**`. Add `src/dashboard/tsconfig.json` like the webview one and add it to `npm run typecheck`.

## 4. Activity engine and source attribution

### 4.1 Hook points (minimal change to 0.2.0)
`ActivitySink` gains one optional method, called by `EditWatcher` for every accepted or deleted event, after the existing calls:
```ts
onEvent?(e: { key: FileKey; eventType: ActivityEventType; decision: 'you' | 'external'; reason: ClassifyReason; origin: 'doc' | 'watcher' | 'workbench'; at: number }): void;
```
- modify: from `accept(...)` when `sink.onActivity` returned true (so tracker dedupe also dedupes history).
- create: watcher `onDidCreate` (file, not directory) reports `eventType: 'create'`. `workspace.onDidCreateFiles` reports `origin: 'workbench'`, `decision: 'you'`.
- delete: watcher `onDidDelete` reports `eventType: 'delete'`, `decision: 'external'`, reason `disk-write`. `workspace.onDidDeleteFiles` reports `origin: 'workbench'`, `decision: 'you'`. A watcher create or delete within `SELF_SAVE_WINDOW_MS` of a workbench operation on the same path is the echo and is not reported twice.
- Excluded paths, burst floods and disabled or paused states produce no event (same gates as today). Paused adds `ClassifyReason` `'paused'`.

The controller forwards `onEvent` to `ActivityService`. The tracker, rows and decorations do not change.

### 4.2 `core/activity/attribution.ts`
```ts
export interface Attribution { sourceType: ActivitySourceType; sourceId?: string; detectionMethod: DetectionMethod; confidence: number }
export interface RawEvent { key: FileKey; eventType: ActivityEventType; decision: 'you' | 'external'; reason: ClassifyReason; origin: 'doc' | 'watcher' | 'workbench'; at: number }
export type Hint =
  | { kind: 'git'; root: FileKey; at: number }                         // repository state changed
  | { kind: 'agent'; agent: string; file: FileKey; at: number; sessionId?: string };
export const HINT_WINDOW_MS = 3000;
export function baseAttribution(e: RawEvent): Attribution;
export class HintBook { constructor(windowMs?: number); add(h: Hint): void; match(e: { key: FileKey; at: number }): Hint | undefined; prune(now: number): void; readonly size: number }
export function attribute(e: RawEvent, hint: Hint | undefined): Attribution;
```
`baseAttribution` (first match):

| Condition | sourceType | method | confidence |
|---|---|---|---|
| `origin: 'workbench'` | developer | workbench-file-operation | 0.95 |
| decision `you`, reason `undo-redo` | developer | undo-redo | 0.95 |
| decision `you` (other) | developer | focused-editor-edit | 0.9 |
| reason `background-edit` | automated | workspace-edit | 0.6 |
| reason `reload-from-disk` | external | reload-from-disk | 0.7 |
| eventType `delete` from the watcher | external | disk-delete | 0.7 |
| reason `disk-write` | external | disk-write | 0.7 |
| anything else | unknown | restored | 0.2 |

`attribute`: a hint only upgrades a non-developer base. Agent hint (same file, `|at - hint.at| <= window`) gives `ai-agent`, `sourceId = agent`, method `agent-signal`, confidence 0.95. Git hint (file under `root`, within window) gives `git`, method `git-state-change`, confidence 0.8. Agent beats git. Developer events are never re-labelled. Hints may arrive after the event: `ActivityService` re-attributes events of the last `HINT_WINDOW_MS` when a hint is added (`EventStore.reattribute`).

### 4.3 `core/activity/eventStore.ts`
```ts
export interface EventStoreOptions { maxEvents: number; retentionMs: number; coalesceMs: number }   // defaults 1000, 14 days, 5000
export interface FileActivity { key: FileKey; sourceType: ActivitySourceType; sourceId?: string; detectionMethod: DetectionMethod; confidence: number; lastEventType: ActivityEventType; firstAt: number; lastAt: number; changes: number; review: ReviewStatus | undefined; sessionId?: string; exists: boolean }
export class EventStore {
  constructor(clock: Clock, workspaceId: string, options?: Partial<EventStoreOptions>);
  setOptions(patch: Partial<EventStoreOptions>): void;
  add(e: { key: FileKey; eventType: ActivityEventType; at: number; sessionId?: string } & Attribution): ActivityEvent;
  events(): readonly ActivityEvent[];               // oldest first
  recent(limit: number): ActivityEvent[];           // newest first
  files(): FileActivity[];                          // one per file, newest first, from the kept events
  reattribute(match: (e: ActivityEvent) => Attribution | undefined, sinceMs: number): number;
  markReviewed(key: FileKey): number; markAllReviewed(): number; unreviewedFiles(): number;
  rename(oldPrefix: FileKey, newPrefix: FileKey): number;
  load(events: readonly ActivityEvent[]): void;      // replaces content; applies limits
  clear(): void; prune(): number; readonly size: number; readonly revision: number;   // revision increments on every change
}
```
Rules: an `add` merges into the newest event of the same file when event type, source type, source id and session id are equal and `at - lastTimestamp <= coalesceMs` (`count += 1`, `lastTimestamp = at`); otherwise a new event with id `e<base36 counter>` (the counter continues past loaded ids). Non-developer events start `unreviewed`; developer events carry no review status. A file's summary takes source, method and confidence from its newest event, `changes` = sum of counts, `review` = `unreviewed` if any kept event of it is unreviewed, else `reviewed` if any was, else undefined; `exists` is false when the newest event is a delete. Over `maxEvents` the oldest go; `prune` drops events older than `retentionMs`. Everything is O(events) at worst and events are bounded, so no index is needed.

### 4.4 Pause
`changescope.pause` / `changescope.resume` (and the dashboard toggle) set an in-memory flag held by `ActivityService` and mirrored to the context key `changescope.paused`. While paused the watcher ignores everything with reason `paused`; existing rows stay. Paused is not persisted across restarts.

## 5. Sessions (`core/sessions`)
```ts
export class SessionManager {
  constructor(clock: Clock, workspaceId: string, maxSessions?: number /* 50 */);
  start(title: string, git?: GitContext): DevelopmentSession;       // '' -> "Session YYYY-MM-DD HH:mm" (local time from the clock); stops the active one first
  stop(git?: GitContext): DevelopmentSession | undefined;
  rename(id: string, title: string): boolean; remove(id: string): boolean;
  record(e: ActivityEvent, isNewOccurrence: boolean): void;          // no-op without an active session
  active(): DevelopmentSession | undefined; list(): DevelopmentSession[];   // newest first, active included
  get(id: string): DevelopmentSession | undefined;
  load(sessions: readonly DevelopmentSession[]): void; clear(): void; readonly revision: number;
}
export function buildSessionReport(s: DevelopmentSession, events: readonly ActivityEvent[], toDisplay: (k: FileKey) => string, format: 'markdown' | 'json'): string;
```
One active session at a time. A session loaded as `active` from storage (the window closed without stopping it) is loaded as `completed` with `endedAt` = its last event time or `startedAt`. `activityCount` counts occurrences (coalesced merges count). `modifiedFiles` is capped at 500. The report lists title, times, duration, branch and commit at start and end, counts per source, and files with source labels and change counts. It uses display paths (workspace relative), never absolute paths, and contains no file contents. Export opens the Markdown report in an untitled editor; nothing is written to disk by Changescope.

## 6. Git (`core/git/gitModel.ts`, `vscode/gitService.ts`)
The adapter uses the built-in `vscode.git` extension API (`getExtension('vscode.git')`, `exports.getAPI(1)`), declared locally as minimal interfaces (no new dependency). It is acquired after activation without blocking it. States: `disabled` (`changescope.git.enabled` false), `unavailable` (extension missing, disabled, or `getAPI` throws; detail says which), `loading`, `ready`.
```ts
export function mapGitStatus(status: number): GitChangeStatus;      // vscode.git Status enum numbers
export interface RepoSnapshot { root: FileKey; name: string; branch?: string; commit?: string; ahead: number; behind: number; staged: Array<{ key: FileKey; status: GitChangeStatus }>; unstaged: [...]; untracked: [...] }
export function headChanged(prev: RepoSnapshot | undefined, next: RepoSnapshot): boolean;   // branch or commit differs
// gitService: snapshots(): RepoSnapshot[]; state(); contextFor(key?): GitContext | undefined; onDidChange; onDidChangeHead(root); openDiff(key): Thenable<void>
```
Untracked files are `Status.UNTRACKED` entries of `workingTreeChanges` (and `untrackedChanges` where the API has it). Each list is capped at 200 with `truncated`. `openDiff` runs `git.openChange` for the file URI and falls back to opening the file. A head change adds a `git` hint for that root. Repository state events are debounced 300 ms before the dashboard is rebuilt.

## 7. Dependencies and impact

### 7.1 `core/intelligence/depGraph.ts`
```ts
export class DepGraph {
  setFile(source: FileKey, targets: ReadonlyArray<{ key: FileKey; count: number; relationshipType?: RelationshipType }>, language: string): void;  // replaces the file's outgoing edges
  removeFile(key: FileKey): void; removeUnder(prefix: FileKey): number; clear(): void;
  has(key: FileKey): boolean; readonly fileCount: number; readonly edgeCount: number;
  importsOf(key: FileKey): Array<{ key: FileKey; count: number; relationshipType: RelationshipType }>;
  importedBy(key: FileKey): Array<{ key: FileKey; count: number; relationshipType: RelationshipType }>;
  dependants(key: FileKey, maxDepth: number, maxNodes: number): { direct: FileKey[]; indirect: FileKey[]; truncated: boolean };   // BFS over reverse edges, cycle safe, the file itself excluded
  relationships(): DependencyRelationship[];
}
```
`relationshipType` is `export` when every statement that produced the edge is `export-from`, else `import`; non-code links (HTML, Markdown, CSS) are `reference`. Confidence 0.8 for resolved code imports, 0.6 for references. To carry this, `ReferenceTarget` gains an optional `kinds?: ImportKind[]` filled by `analyzeReferences` (additive, existing tests unaffected).

### 7.2 `core/intelligence/testMatch.ts`
`isTestFile(key)`: `.test.` / `.spec.` before the extension, `_test.go`, `test_*.py`, `*_test.py`, `*Test.php|java|kt`, or a path segment `test`, `tests`, `__tests__`, `spec`. `relatedTests(key, allFiles)`: test files whose base name with the test marker removed equals the file's stem (any directory), nearest directory first, max 10.

### 7.3 `core/intelligence/impact.ts`
```ts
export const IMPACT = { MAX_DEPTH: 3, MAX_NODES: 200, MEDIUM: 3, HIGH: 10, CRITICAL: 25 } as const;
export function isConfigFile(key: FileKey): boolean;   // package.json, tsconfig*.json, jsconfig.json, composer.json, go.mod, pyproject.toml, requirements*.txt, Dockerfile, docker-compose*.yml, .env*, *.config.{js,ts,mjs,cjs}, .github/workflows/*
export function analyseImpact(i: { file: FileKey; graph: DepGraph; allFiles: ReadonlySet<FileKey>; indexComplete: boolean; now: number }): ChangeImpact;
```
Level (highest that applies): `critical` when the file is a config file or direct dependants >= 25; `high` when direct >= 10 or direct + indirect >= 30; `medium` when direct >= 3 or direct + indirect >= 8; else `low`. `reasons` are full sentences such as "12 files import this file directly.", "This is a project configuration file; changes can affect the whole workspace.", "No dependants were found." and, when `complete` is false, "The dependency index is still being built, so this estimate may be low." `affectedTests` = dependants that are test files plus `relatedTests`. `configFiles` = the file itself when it is one.

### 7.4 `vscode/dependencyIndex.ts`
Built on demand: the first time the dashboard needs dependencies or impact (a selection, Impact mode, or the Dependencies or Impact section opened) and `changescope.dependencies.index` is `onDemand`. `workspace.findFiles` with the supported extensions, `excludeGlobs` and `sensitiveGlobs` excluded, capped at `changescope.dependencies.maxFiles` (default 5000, `truncated` when hit). Files are analysed one at a time with the existing `analyzeReferences` and a shared `ProbeFs` whose `isFile` and `listDir` results are memoised for the indexing run; the loop yields to the event loop between files and stops when disposed. After the initial run it is incremental: an activity event re-analyses that one file (debounced 500 ms, coalesced), a delete removes it, a rename or project file change (`tsconfig.json` and friends) marks the index stale and rebuilds it in the background. No full rescan per edit. Status: `off | idle | indexing | ready` with `indexed / total`. Memory only in 0.3.0 (not persisted). In test mode the index runs only when a test asks (`testing.buildDependencyIndex()`), so existing suites keep `pendingTimers() === 0`.

## 8. Collisions (`vscode/collisionNotifier.ts`)
When an event with base decision `external` (origin `watcher`) arrives for a file whose document is open and dirty, show one warning: "<name> was changed on disk while you have unsaved edits." with actions `Compare with Saved` (`workbench.files.action.compareWithSaved` after showing the document) and `Dismiss`. At most once per file per 30 s. Setting `changescope.collisions.notify` (default true). Changescope never writes to or reloads the document; VS Code keeps the unsaved buffer. The pure decision (`shouldNotify(lastAt, now, enabled)`) is unit-tested; the notification call is injectable for integration tests.

## 9. AI foundation (`core/ai`, `vscode/aiService.ts`, `vscode/agentSignal.ts`)
```ts
export interface AiRequest { kind: 'changes' | 'session' | 'impact'; metadata: SummaryInput; includesSource: false }
export interface AiProvider { readonly id: string; readonly label: string; summarize(req: AiRequest, token: { isCancellationRequested: boolean }): Promise<string> }
export class ProviderRegistry { register(p: AiProvider): { dispose(): void }; get(id: string): AiProvider | undefined; list(): AiProvider[] }
export type Consent = 'granted' | 'denied' | 'unset';
export function canSend(mode: 'local' | 'assisted', consent: Consent, provider: AiProvider | undefined): { ok: boolean; reason: string };
export interface SummaryInput { files: Array<{ path: string /* display path */; source: ActivitySourceType; changes: number; eventType: ActivityEventType }>; bySource: Record<ActivitySourceType, number>; session?: { title: string; durationMs: number }; branch?: string }
export function buildSummaryInput(...): SummaryInput;      // drops files matching sensitiveGlobs; display paths only; at most 100 files
export function localSummary(input: SummaryInput): string; // deterministic sentences from metadata only
```
- Local mode (default): `summarize` returns `localSummary`. No network, no key, nothing leaves the machine.
- Assisted mode: only when `changescope.ai.mode` is `assisted`, a provider with id `changescope.ai.provider` is registered, and consent for that provider is `granted`. Consent is asked once per provider per workspace with a modal that names the provider and lists exactly what is sent (display paths, counts, source labels, branch name; never file contents in 0.3.0), stored in `workspaceState`, and revocable with `changescope.ai.resetConsent`. Any provider error or rejection falls back to the local summary and logs the error without the payload.
- Credentials: `aiService.setKey(providerId)` / `clearKey` use `context.secrets` (`changescope.ai.key.<providerId>`); providers receive the key through `getKey()` only. Keys are never logged or put in debug info.
- API additions on `ChangescopeApi` (additive, `apiVersion` stays 1): `registerAiProvider(p)`, `reportAgentActivity({ agent, files, sessionId? })`, `getActivityEvents()`, `getSessions()`, `getDashboardState()`.
- Agent adapters: `interface AgentAdapter { id; label; state(); detail(); dispose() }`. Two ship: `api` (always listening; `reportAgentActivity` adds agent hints) and `signal-file` (experimental, `changescope.experimental.agentSignals`, default false). The signal file is `<context.storageUri>/agent-events.jsonl`: one JSON object per line, `{"agent": string, "file": absolute path, "session"?: string}`; unknown fields ignored, lines over 4 KB or malformed are skipped, the file is read from the last offset and truncated by Changescope when it passes 1 MB. `changescope.copyAgentHook` copies a ready hook command for the signal file path (for Claude Code, a `PostToolUse` hook on the edit tools that appends the tool's `file_path`; the Builder must check the current hook input format in the Claude Code hooks documentation before writing the snippet, and the README must call this experimental and user-configured). With no workspace storage the adapter is `unavailable`.

## 10. Storage (`core/storage/schema.ts`, `vscode/storage.ts`)
Workspace `Memento` key `changescope.history`: `{ schema: 1, savedAt, events: ActivityEvent[], sessions: DevelopmentSession[] }`.
```ts
export const STORAGE_SCHEMA = 1;
export function serialise(events, sessions, now): unknown;
export function deserialise(raw: unknown): { events: ActivityEvent[]; sessions: DevelopmentSession[]; recovered: number };  // never throws
```
`deserialise` validates every record field by field and drops invalid ones (`recovered` = dropped count); a missing or unknown `schema` yields empty history (older schemas go through a `migrate` table, empty for now). Writes are debounced 1000 ms on the injected scheduler and flushed on dispose. `changescope.history.persist` false keeps history in memory only and deletes the stored key. `changescope.clearHistory` (confirmation modal) clears events and completed sessions and the stored key. History is per workspace (Memento isolation); `workspaceId` is the workspace storage folder name or `no-workspace`, never a path.

## 11. Dashboard

### 11.1 Host (`vscode/dashboardProvider.ts`, `core/dashboard/model.ts`)
Manifest: `viewsContainers.activitybar: [{ id: "changescope", title: "Changescope", icon: "media/activity.svg" }]`, `views.changescope: [{ type: "webview", id: "changescope.dashboard", name: "Activity" }]`. The Explorer view stays as it is. `changescope.openDashboard` focuses the view; `changescope.openDashboardPanel` opens the same page in an editor tab (one panel at a time). Same CSP builder (`buildWebviewHtml`) with `dist/dashboard.js` and `media/dashboard.css`.

`buildDashboardState(input): DashboardState` is pure and takes plain data (file activity, tracker phases and intensities, events, sessions, repo snapshots, selection, impacts, index status, settings, adapters, summary, roots, `now`, `seq`). Caps from `DASH_LIMITS`. Files are ordered active first, then by `lastAt` desc. `overview.modifiedFiles` counts files with kept events; `bySource` counts files by current source; `unreviewed` = `EventStore.unreviewedFiles()`.

The provider rebuilds and posts state only while a target is visible, debounced 250 ms (trailing) on the scheduler, triggered by: store, session, git, index or settings revision changes and the controller's update event while files are active. Unchanged state (same JSON without `seq` and `now`) is not re-posted, except that relative times need `now`, so the webview formats times itself from `now` and re-renders them only when a state arrives. Every incoming message goes through `parseDashboardWebviewMessage`; ids are looked up in the last posted state (`files`, `timeline`, git lists, selection, impact lists, sessions) and anything else is ignored. No message can name a path, a URI, a command or a setting key.

Message handling: `open` shows the document; `openDiff` calls `gitService.openDiff`; `select` sets the selection and triggers the index; `setMode` writes `changescope.viewMode`; `setAnimate` writes `changescope.enableAnimation`; `setPaused` toggles pause; `markReviewed` / `markAllReviewed`; `sessionStart|Stop|Rename|Export`; `clearHistory` runs the command (with its confirmation); `openSettings` runs `workbench.action.openSettings` with `@ext:<extension id>`; `summarize` produces a summary through `aiService`.

### 11.2 Webview (`src/dashboard`, `media/dashboard.css`)
```ts
export interface DashPersisted { tab: TabId; activityFilter: FilterId; codeView: 'dependencies' | 'impact' }
export type TabId = 'overview' | 'activity' | 'code' | 'git' | 'sessions' | 'settings';
export type FilterId = 'live' | 'mine' | 'external' | 'ai' | 'all';
export interface DashHostApi { postMessage(m: DashboardWebviewMessage): void; getState(): DashPersisted | undefined; setState(s: DashPersisted): void }
export interface DashApp { handleMessage(raw: unknown): void; dispose(): void; readonly lastSeq: number }
export function mountDashboard(root: HTMLElement, host: DashHostApi, env?: Partial<AppEnv>): DashApp;
```
Ten sections of the roadmap in six tabs, so a 300 px sidebar is not a wall of panels:

| Tab | Roadmap sections | Content |
|---|---|---|
| Overview | Overview | Six stat cards (modified files, your changes, external, AI agent, unreviewed, active session), mode switch, pause, local summary, timeline (latest 50) |
| Activity | Live Activity, My Changes, External Changes, AI Agent Activity | Filter chips `Live`, `Mine`, `External`, `AI agents`, `All`; one row list |
| Code | Dependencies, Change Impact | Segmented `Dependencies` / `Impact`; selected file, imports, imported by; impact cards with level, reasons, tests |
| Git | Git Changes | Per repository: branch, commit, ahead/behind; Staged, Changes, Untracked |
| Sessions | Development Sessions | Start (title input), stop, rename, export; previous sessions |
| Settings | Settings | Mode, animation, pause, history, AI mode and consent state, "Open all settings" |

Wireframe (sidebar width):
```
+--------------------------------------------+
| Overview Activity Code Git Sessions Settings|   role=tablist, arrow keys, roving tabindex
+--------------------------------------------+
| [ 12 files ] [ 7 yours ] [ 4 external ]     |   stat cards: number + label, 3 per row,
| [ 1 AI     ] [ 5 to review ] [ 1 session ]  |   2 per row under 260 px
| Mode: (Live) Compact Impact     [Pause]     |
| Summary: 12 files changed: 7 by you, ...    |
| Timeline                                    |
|  * app.ts      Developer   modified   2m    |
|  + new.py      External    created    5m    |
+--------------------------------------------+
Activity row:
| [icon] app.ts  src/core        Developer    |   icon shape + text label per source
|        modified 3 times  2m ago  [====  ]   |   meter = intensity (non-motion cue)
|        session: Refactor  [Review] [Diff]   |
```
DOM contract (the Tester selects on these):
```
#app[data-mode=live|compact|impact][data-motion=on|off][data-tab=<TabId>][data-enabled=true|false]
  nav.fd-tabs[role=tablist] > button.fd-tab[role=tab][data-tab][aria-selected][aria-controls]
  section.fd-panel[role=tabpanel][data-panel=<TabId>][hidden?]
  .fd-card[data-card=modified|developer|external|ai|unreviewed|sessions] > .fd-card-value + .fd-card-label
  ul.fd-list > li.fd-row[data-id][data-source][data-phase][.is-shaking] ; button.fd-open (the file name) ; .fd-source (icon + label) ; .fd-meter > i
  button[data-action=<message type>][data-id?]      # every control that sends a message
  .fd-chip[data-filter], .fd-mode[data-mode], .fd-empty, .fd-impact[data-level], .fd-timeline > li[data-source]
  .fd-notice[role=status]                            # index progress, git unavailable, paused, disabled
```
Rules: rows keyed by id and updated in place (animations do not restart, focus is kept across state updates); a state with `seq < lastSeq` is ignored; `data-motion="off"` when `settings.animate` is false, the mode is `compact`, or reduced motion is requested, and then nothing has `.is-shaking`; `.is-shaking` only in `live` mode for `phase: active` and `intensity > 0`. Compact mode shows single-line rows without meters or secondary lines. Impact mode shows the impact level badge and dependant count on each row and the Code tab opens on Impact. Switching mode or tab never drops data: every panel renders from the same last state.

Sources (never colour alone: each has a distinct icon shape drawn in CSS or inline SVG built with DOM calls, plus the text label):

| Source | Label | Colour variable (fallback) | Icon |
|---|---|---|---|
| developer | Developer | `--vscode-changescope-editedForeground` (#3fb950) | filled circle |
| ai-agent | AI agent | `--vscode-charts-blue` (#3794ff) | diamond |
| external | External | `--vscode-charts-yellow` (#cca700) | square |
| git | Git | `--vscode-charts-purple` (#b180d7) | branch (two dots and a line) |
| automated | Automated | `--vscode-terminal-ansiCyan` (#29b8db) | gear or hexagon |
| unknown | Unknown | `--vscode-descriptionForeground` | ring with question mark |

Accessibility: tabs follow the ARIA tabs pattern (Left/Right/Home/End, roving tabindex); every control is a real `button` or `input` with a visible label or `aria-label`; lists use `ul/li` with row summaries in `aria-label` ("app.ts, Developer, modified 3 times, 2 minutes ago, unreviewed"); focus rings use `--vscode-focusBorder`; status changes go to one polite live region, throttled; high contrast themes get `--vscode-contrastBorder` outlines; text contrast relies on VS Code foreground variables. Reduced motion: `@media (prefers-reduced-motion: reduce)` and `data-motion="off"` both force `animation: none` and remove transitions. All colours, fonts and spacing use VS Code theme variables; no separate design system.

Empty and limited states must say what is true: no activity yet; tracking paused; Changescope off; Git unavailable (with the reason); index building (`340 of 1,200 files`); AI agents: "No agent adapter is reporting. Changes made by agents appear under External." plus the adapter list with states.

## 12. Settings and commands (additions)

| Setting | Type, default | Meaning |
|---|---|---|
| `changescope.viewMode` | `live` \| `compact` \| `impact`, `live` | Visual mode of the dashboard; `compact` also stops shaking in the Explorer view |
| `changescope.animationIntensity` | number 0.25 to 2, 1 | Multiplies shake distance and rotation (both views) |
| `changescope.history.persist` | boolean, true | Keep activity history and sessions across restarts (workspace storage) |
| `changescope.history.maxEvents` | integer 100 to 5000, 1000 | History size |
| `changescope.history.retentionDays` | integer 1 to 90, 14 | History age limit |
| `changescope.git.enabled` | boolean, true | Git section and git attribution |
| `changescope.dependencies.index` | `onDemand` \| `off`, `onDemand` | Workspace dependency index |
| `changescope.dependencies.maxFiles` | integer 200 to 20000, 5000 | Index size cap |
| `changescope.collisions.notify` | boolean, true | Warn when a file with unsaved edits changes on disk |
| `changescope.sensitiveGlobs` | string[], `**/.env*`, `**/*.pem`, `**/*.key`, `**/*.pfx`, `**/*.p12`, `**/id_rsa*`, `**/id_ed25519*`, `**/secrets/**`, `**/.npmrc`, `**/.netrc` | Files that are never read for dependency analysis and never included in any AI request (their activity is still listed by name) |
| `changescope.ai.mode` | `local` \| `assisted`, `local` | Assisted needs a registered provider and consent |
| `changescope.ai.provider` | string, `""` | Id of the registered provider to use |
| `changescope.experimental.agentSignals` | boolean, false | Read the agent signal file |

`ChangescopeConfig` gains the matching fields (`sanitizeConfig` stays total; integers rounded and clamped; enums fall back to the default). Existing `idleTimeoutMs` is the animation duration control and `persistUntilNextFile` / `showWhenIdle` are the activity expiration controls; the README maps the roadmap's control names to them.

Commands (category `Changescope`): `openDashboard`, `openDashboardPanel`, `setViewMode` (quick pick), `pause`, `resume`, `startSession` (input box), `stopSession`, `renameSession`, `exportSessionReport`, `markAllReviewed`, `clearHistory`, `rebuildDependencyIndex`, `copyAgentHook`, `ai.setKey`, `ai.clearKey`, `ai.resetConsent`. Existing four stay. Dashboard view title menu: pause/resume, mark all reviewed, open in editor.

## 13. Performance and benchmarks
Targets from the roadmap are engineering targets. The Tester records measured numbers in `docs/BENCHMARKS.md` (machine, date, commands): activation time in the integration host; `EventStore.add` (10,000 adds); `buildDashboardState` at 300 files and 1,000 events; `DepGraph` build and `dependants` at 500, 2,000, 5,000 and 10,000 synthetic files (in-memory `ProbeFs`); `analyseImpact`; dashboard first render in jsdom at 300 rows. Unit thresholds (generous, to catch regressions, not to certify): `EventStore.add` x 10,000 under 250 ms; `buildDashboardState` under 50 ms; `dependants` on a 10,000 file graph under 100 ms; dashboard render of 300 rows under 500 ms in jsdom.

## 14. Milestones and ownership
- **Host Builder** owns `src/core/**` (except `dashboard/protocol.ts` and the type block, which are fixed), `src/vscode/**`, `src/extension.ts`, `package.json`, `README.md`, `CHANGELOG.md`, `.github/**`, `docs/BUILD_STATUS.md`. Order: H1 config + attribution + event store + sessions + storage schema; H2 depGraph + testMatch + impact + gitModel + ai core + dashboard model; H3 adapters and wiring (`activityService`, `gitService`, `dependencyIndex`, `collisionNotifier`, `agentSignal`, `aiService`, `dashboardProvider`, `storage`, `extension.ts`, manifest); H4 README, CHANGELOG, CI workflows, version 0.3.0.
- **Dashboard Builder** owns `src/dashboard/**`, `media/dashboard.css`, `media/activity.svg`, `esbuild.mjs`, `.vscodeignore`, `eslint.config.mjs`, `src/dashboard/tsconfig.json` (and asks the Host Builder's file `package.json` only for the `typecheck` script line, recorded in its report). Must look at the real page in a browser with mock state in light, dark and high contrast, at 280 px and 900 px, with reduced motion.
- **Tester** owns `test/**`, `docs/QA_REPORT.md`, `docs/BENCHMARKS.md`, `.gitignore` fixture fix. Updates the 0.2.0 pins (version, vsix file list, manifest views), adds unit tests for every new core module, jsdom tests for the dashboard, integration suites for the dashboard view, sessions, pause, persistence and Git degradation, and runs the full matrix.
- Do not advance on a red `npm run build`, `npm run lint` or `npm run test:unit` for files you own.

Acceptance for 0.3.0: build, lint, typecheck, unit and integration suites green (or the exact reason a suite could not run); `npm run package` produces `changescope-0.3.0.vsix` that installs; the vsix contains only `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE.txt`, `dist/extension.js`, `dist/webview.js`, `dist/dashboard.js`, `media/*`; no 0.2.0 test was deleted to make it pass (changed pins are listed in the QA report); README describes only what exists; benchmarks recorded.

## Deviations
_(Builders: append `- <what>: <why>` here.)_

### Host Builder

**Fixed contract files.** The 0.3.0 type block of `src/core/types.ts` and `src/core/dashboard/protocol.ts` are unchanged. Only two additive edits were made to `types.ts` outside that block: `ClassifyReason` gained `'paused'` (section 4.1 asks for it) and `ReferenceTarget` gained the optional `kinds?: ImportKind[]` (section 7.1 asks for it).

- Names of the new `ChangescopeConfig` fields (section 12 gives only setting keys): `viewMode`, `animationIntensity`, `historyPersist`, `historyMaxEvents`, `historyRetentionDays`, `gitEnabled`, `dependencyIndex` (`'onDemand' | 'off'`), `dependencyMaxFiles`, `collisionsNotify`, `sensitiveGlobs`, `aiMode`, `aiProvider`, `agentSignals`. `aiProvider` must match `PROVIDER_ID_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, also the manifest pattern) else it is `''`.
- Extra optional or additional parameters, all backwards compatible with the signatures in the sections above: `attribute(e, hint, windowMs?)`; `SessionManager.load(sessions, lastEventAt?)` (to end a stored "active" session at its last event); `isTestFile(key, roots?)` and `relatedTests(key, allFiles, roots?, max?)` (folder names are read relative to the workspace folder so a project that lives under a folder called `test` is not all tests); `analyseImpact({..., roots?})`.
- Extra exports the design did not name: `core/timeFormat.ts` (`formatLocalMinute`, `toIsoUtc`, `formatDuration`; no clock access, used by the session title and report); `core/ai/agentSignal.ts` (the `AgentAdapter` interface, signal-file line parser, hook builder); `core/activity/collision.ts` (`shouldNotify`, message and action labels); in `attribution.ts` `hintCovers`, `upgradeWithHint`, `SOURCE_LABELS`; in `eventStore.ts` `deleteTargets` (a deleted folder is one watcher event; the history says which files went); `SessionManager.reattribute / renameFiles / clearCompleted / activeSessionId`; `DepGraph.files()`, `targetsFromReference`, `relationshipConfidence`; `gitModel` `RawRepo`, `buildRepoSnapshot`, `GIT_LIST_LIMIT`, and `RepoSnapshot.truncated`; `intensity.scaleShake` and `clampAnimationIntensity`; `core/dashboard/model.ts` `DashboardInput`, `FileLiveState`, `stateSignature`.
- `mapGitStatus` relies on the numeric order of the Git extension's `Status` enum (a `const enum`, so only numbers exist at run time); the order was checked against the published `git.d.ts` and `INDEX_COPIED` and `INTENT_TO_ADD` map to `added`, `TYPE_CHANGED` to `modified`.
- `registerAiProvider(p)` returns `{ dispose(), getKey() }` (`ProviderHandle`), not only a disposable: section 9 says providers get their key "through `getKey()` only", and `AiProvider.summarize` has no key parameter, so the handle is the one place a provider can ask for its own key.
- `reportAgentActivity({ agent, files, sessionId? })`: `files` accepts absolute path strings and `file:` URIs; everything is validated and capped at 200 files per call.
- Workbench create and delete events use `ClassifyReason` `'active-focused-edit'` as a placeholder reason (`ClassifyReason` has no workbench value and attribution decides on `origin` first). They go to the history only: no tracker row, no `EventLog` entry (`LogEntry.origin` has no `workbench`). A watcher create or delete that echoes a workbench operation (same path or a folder above, same kind, within `SELF_SAVE_WINDOW_MS`, including rename sources and destinations) is still seen by the tracker as in 0.2.0 but is not reported to the history twice.
- Watcher deletes are reported to the history only when `detectExternalEdits` is on (the same switch as for modifications), and are gated by pause, exclusion and `BurstGuard`.
- `changescope.clear` still only clears tracked rows and reference caches; it does not touch the history (that is `changescope.clearHistory`).
- Pause stops all recording including workbench events; it does not remove rows already shown, and deleting a tracked file still forgets its row (the file is gone).
- The dashboard's 250 ms is a throttle (the first trigger starts one timer; later triggers join it), not a restart-debounce, so continuous activity cannot starve updates. State is posted when it differs from the last one (ignoring `seq` and `now`); a webview that just appeared or said `ready` always gets one.
- Impact data in the dashboard state: the selected file always (once the index is built or building); the 50 newest existing files only while `viewMode` is `impact`. The index is started by `select` or by Impact mode (the protocol has no "tab opened" message).
- Dependency index: `findFiles` with a fixed supported-extension include glob and `{**/node_modules/**,**/.git/**}` as exclude, up to `maxFiles * 3` results, then `excludeGlobs` and `sensitiveGlobs` are applied by our own matcher and the list is cut to `maxFiles` (`truncated` also when the `findFiles` cap was hit). Open documents are analysed from their in-memory text.
- Timers in test mode (`CHANGESCOPE_TEST=1`): the index never starts by itself (`autoStart: false`); `GitService` reads repository state immediately (no 300 ms debounce, so no timer); the storage (1000 ms), dashboard (250 ms, only while a target is visible), re-index (500 ms, only after the index was built) and AI timeout timers all use the injected `ManualScheduler` and are cancelled on dispose. Storage is scheduled only by a change to events, sessions or review state, or by a settings change that actually changed history; an unrelated settings change leaves no timer. (An earlier version scheduled a write on every settings change and left `pendingTimers() > 0` after `changescope.persistUntilNextFile` changed; found by the 77-persistence integration test and fixed.)
- Manifest: the four existing commands and the Explorer view are unchanged. Added: `viewsContainers.activitybar`, `views.changescope`, 16 commands (four with codicons for the view title), `view/title` entries for the dashboard view (pause or resume by the `changescope.paused` context key, mark all reviewed, open in editor), `commandPalette` `when` clauses for pause and resume, 13 settings. `npm run package` no longer passes `--allow-missing-repository`: `vsce package` works without it now that `repository.url` is set (13 files, about 104 KB). `publisher` is still a placeholder (`changescope`).
- `src/vscode/commands.ts` (new, not in section 3) holds the 16 command handlers so `extension.ts` stays wiring only. `createProbeFs` is exported from `referenceService.ts` for the index. `updateSetting` was added to `vscode/config.ts` (`toggleEnabled` now uses it).
- Test seams (only when `CHANGESCOPE_TEST=1`), all on `ChangescopeApi.testing`: `buildDependencyIndex(): Promise<void>`, `dependencyIndexIdle(): Promise<void>`, `dashboardStats(): { resolved, ready, sent, visible, panelOpen, lastSeq }`, `dashboardMessage(raw: unknown): void` (refreshes the ids a message may name from the state as it is now, so it works without a rendered webview; production resolves ids against the last posted state), `flushHistory(): Promise<void>`, `historyWrites(): number`, `overrideCollisionNotify(fn | undefined)`, `collisionStats(): { shown, last }`, `overrideConsentPrompt(fn | undefined)`, `overrideConfirm(fn | undefined)` (the "are you sure" of `changescope.clearHistory`, a modal that would hang a headless run), `agentSignalPath(): string | undefined`. Public API additions are as section 9 lists, plus `ProviderHandle` above.
- Agent hook: `buildAgentHook` writes `jq -c '{agent, file: .tool_input.file_path, session: .session_id}' >> <file>` under a `PostToolUse` matcher `Edit|Write`. The settings shape, the matcher syntax and the `tool_input.file_path` and `session_id` fields were checked against code.claude.com/docs/en/hooks. Multi-edit and notebook-edit tool inputs were not found in the part of the page that was read, so they are not matched. Needs `jq` and a POSIX shell.

### Dashboard Builder

Files: `src/dashboard/**` (entry `main.ts`, `mountDashboard` in `app.ts`, view modules in `views/`), `media/dashboard.css`, `media/activity.svg`, `media/screenshots/*.png`, plus `esbuild.mjs` (third bundle), `eslint.config.mjs` (the `src/webview/**` block now also covers `src/dashboard/**`), `.vscodeignore`, `src/dashboard/tsconfig.json`. `src/core/types.ts` and `src/core/dashboard/protocol.ts` were used as they are. The `typecheck` script of `package.json` already carries `tsc -p src/dashboard/tsconfig.json --noEmit`.

- `.vscodeignore` un-ignores `!media/*` instead of `!media/**`: with `vsce`, an ignore line cannot override a matching `!` line, so `!media/**` would always ship `media/screenshots/`. `!media/*` keeps `icon.png`, `webview.css`, `dashboard.css` and `activity.svg` and drops the screenshots (checked with `npx vsce ls --no-dependencies`). The 0.2.0 pin in `test/unit/manifest.test.ts` (`'!media/**'`, and no `!dist/dashboard.js`) must change accordingly.
- `.is-shaking` is also withheld when `state.enabled` is false (a turned-off Changescope records nothing, so a leftover `phase: active` row must not keep moving). The contract's own conditions (live mode, `phase: active`, `intensity > 0`, `data-motion="on"`) still all apply.
- `#app` carries two attributes beyond the contract: `data-state` (`loading` until the first valid state, then `ready`) and `data-paused` (`true|false`). `#app[data-motion]` is `on` in Impact mode (only compact mode, `animate: false` and reduced motion turn it off); rows still never shake outside Live mode.
- Stat cards are `button.fd-card[data-card]` (not a `div`) with `data-goto=<TabId>` and, for the list cards, `data-goto-filter=<FilterId>`. A click only changes tab and filter locally and sends no message. The External card counts every source that is neither Developer nor AI agent (External, Git, Automated, Unknown) so that Yours + External + AI agent equals the file count; the `External` filter chip uses the same rule, and `Live` means `phase: active`.
- The same control can occur in more than one place, so tests should scope by panel: `.fd-mode[data-mode]` and `button[data-action=setMode]` exist in the Overview and Settings panels; `button[data-action=setPaused]` exists as the Overview `.fd-pause` button, the Settings `role=switch` and the Resume button of the paused notice. All of them carry `data-value` (the value a click sends: the opposite of the current state), as does the `setAnimate` switch.
- Activity row: `li.fd-row` always has `data-id`, `data-source`, `data-phase`, `data-exists`, plus `data-review` and `data-level` when the host sent those values; `aria-label` is the summary sentence. Its parts are `.fd-row-head` (`button.fd-open`, `.fd-flag` when unreviewed, `.fd-dir`, `.fd-source`), `.fd-row-meta` (`.fd-row-event`, `.fd-row-time`, `.fd-row-method`, `.fd-meter > i`) and `.fd-row-foot` (impact level and dependants in Impact mode, session, `Reviewed`, `.fd-actions`). Compact mode renders only `.fd-row-head` (plus `.fd-when`); idle rows keep `.fd-meter` in the DOM but CSS hides it. The review button reads `Review` (its `aria-label` is "Mark <name> reviewed").
- `button.fd-open` (the file name) is used for rows, timeline entries, dependency lists and impact lists. Deleted files render it `disabled`. `Diff` (`data-action=openDiff`) shows only for files that are in a Git staged or unstaged list; `Inspect` (`data-action=select`) only while the dependency index is not off. `select` also switches to the Code tab.
- Timeline: `ul.fd-timeline > li.fd-tl[data-source][data-event]`, newest first by `at`, at most 50 rows (`TIMELINE_SHOWN`).
- Sessions: the start input is `input#fd-session-title[data-field=sessionTitle]` (Enter or the `Start session` button sends `sessionStart`; an empty title is sent as `''` so the host names it). While a session is active the start form is replaced by the session card. Rename is an inline input `input[data-field=sessionRename][data-id]` opened by `button[data-edit=rename]`; `Save` or Enter sends `sessionRename`, Escape or `Cancel` (`data-edit=cancel`) sends nothing, an empty title sends nothing and sets `aria-invalid`. `Clear history` sends only `clearHistory`.
- The Code tab shows its `Dependencies` / `Impact` choice as `button.fd-seg-btn[data-code-view][aria-pressed]`; entering Impact mode (also when the page loads in it) switches the choice to Impact and persists it.
- Exports (all from `src/dashboard/app.ts`): `mountDashboard`, `DashPersisted`, `TabId`, `FilterId`, `CodeViewId`, `DashHostApi`, `DashApp`, `AppEnv`, and the constants `ANNOUNCE_MS`, `DISABLED_TEXT`, `PAUSED_TEXT`, `LOADING_TEXT`. Pure helpers a test may import: `src/dashboard/format.ts` (relative time, durations, labels), `model.ts` (`parsePersisted`, `TABS`, `FILTERS`), `views/activity.ts` (`matchesFilter`), `views/code.ts` (`indexNotice`), `views/git.ts` (`gitNotice`), `views/settings.ts` (`aiText`).
- `main.ts` reads `vscode.getState()` field by field through `parsePersisted`, so state left by another version or junk falls back to the defaults.
- The live region is one visually hidden `div.fd-live.fd-sr[aria-live=polite]`; announcements are throttled to one per `ANNOUNCE_MS` (1500 ms) through the injected `env.setTimeout`, and the timer is cleared in `dispose`. Visible `.fd-notice` elements carry `role=status` and an explicit `aria-live="off"` so that they do not announce on their own.

### Host Builder, bug-fix round (QA-101 to QA-111)

- **`EventStore.add` does not merge into an already-reviewed event (contract note, not a code change).** Section 4.3 lists the merge conditions as equal event type, source type, source id and session id within `coalesceMs`. The implementation adds one: the newest event of the file must not be `reviewed`. A change that arrives after the user reviewed the file starts a new `unreviewed` event; otherwise it would be counted as reviewed without anyone having seen it. `eventStore.test.ts` pins this ("a change after the file was reviewed is a new event").
- **QA-101: safe display path.** `core/pathUtils.toSafeDisplayPath(key, roots)` is new and is the only path form used where text leaves the sidebar: `ActivityService.sessionReport` (Markdown and JSON reports) and `DashboardProvider.summarize` (the `SummaryInput` of an AI request and therefore the local summary). Inside a folder it is workspace-relative (prefixed with the folder name when several folders are open); outside every folder, and in a window with no folder open, it is `(outside workspace)/<file name>` with no directory. `toDisplayPath` is unchanged (0.2.0 view behaviour, pinned by `dashboardModel.test.ts`). The dashboard state (`files`, `timeline`, selection) keeps `toDisplayPath` and the absolute `id`: that state goes only to the local webview and the extension API, and `id` has to be a real path to open the file. The debug-info command also still prints absolute paths (local output channel, 0.2.0 behaviour).
- **`core/dashboard/protocol.ts` was edited (validators only, no shape changed).** QA-104: `list()` rejects arrays with holes (it used `map`, which skips them). QA-105: `parseDashboardWebviewMessage` reads `type` once into a local and returns that value. QA-106: `cleanTitle` also replaces U+0080 to U+009F (C1 controls) with a space.
- **QA-107:** `EventStore.recent(Infinity)` returns every event; `NaN` and non-numbers return none; a finite limit is floored as before.
- **QA-102:** `DepGraph.dependants` treats `Infinity` (depth or node limit) as unbounded (the search ends when no new file is found, and cycles are skipped); `NaN`, negative and non-numbers still mean none.
- **QA-103: duplicate edges.** When `setFile` is given the same target more than once, the relationship type is the strongest of them, independent of order. Precedence, strongest first: `import`, `reference`, `inheritance`, `export`, `unknown`. `export` is the weakest real claim on purpose, because an edge is `export` only when every statement behind it is a re-export (section 7.1). Counts still add up.
- **`DepGraph.importersUnder(prefix, maxFiles = 500)`** is new: the importers of every file at or below a path, keyed by the imported file. `DependencyIndex.onFileDeleted` reads it before dropping edges.
- **`buildDashboardState` output is always valid for `parseDashboardHostMessage`.** Counts (`unreviewed`, `events`, session `activityCount`, file `changes`, timeline `count`, git `ahead` and `behind`, dependency `count`, index `indexed` and `total`, `settings.animationIntensity`, `historyLimit`, `retentionDays`) are clamped to finite and non-negative; `seq` and `summary.at` are made finite (non-finite becomes 0).
- **QA-109: `changescope.sensitiveGlobs` is matched case-insensitively on every platform** (index, AI request, and now the Explorer view's reference analysis). `excludeGlobs` keep their platform rule (case-insensitive only on Windows). New behaviour beyond the QA item: `ReferenceService` no longer reads a source file that matches `sensitiveGlobs` (it stores a `skipped: 'excluded'` result before any read), so "never read for dependency analysis" is true for the Live view as well as the index. Its row still appears (activity is listed by name); it just has no yellow references. The analysis cache key and the controller's `analysisSettings` include `sensitiveGlobs`, so changing the setting re-analyses.
- **QA-108: `TestIndex`.** `core/intelligence/testMatch` gained `buildTestIndex(allFiles, roots?)` and `relatedTestsIn(index, key, max?)`; `relatedTests` is now implemented through them, so results are unchanged (fuzzed against the old scan: 14,400 lookups, 0 differences). `analyseImpact` takes an optional `testIndex`; without one it builds an index per call, which is as slow as the old scan. `DependencyIndex.impactFor` always passes a cached index that is rebuilt only when the set of indexed paths (or the workspace folders) changes. Measured at 10,000 files: 50 impacts took about 127 ms before and about 2 ms with the cached index; the index itself takes about 2.5 ms (20 ms at 20,000 files) once per change. The Tester's `analyseImpact` benchmark and guard call it without an index and will therefore still show the old cost until they pass `buildTestIndex(allFiles)`.
- **QA-111: importers of a deleted file.** `DependencyIndex` remembers, per deleted path, the files that imported it (at most 500 deleted paths and 500 importers each, oldest forgotten first; cleared on rebuild, stale or off). When a file with that path reappears (a create or change event), those importers are queued with the file itself for the normal 500 ms incremental re-analysis, so their edges come back without a rescan. This also works for files that are not an indexed language (for example a `.json` that TypeScript files import), which the old language check skipped.
- **QA-110: the signal file.** New in `core/ai/agentSignal.ts`: `SignalChunker` (feeds bytes, decodes a line only after its newline has arrived, so a multi-byte character split across two appends is intact; an over-long unfinished line is dropped up to its newline), `signalTail` and `signalPrefixKept`. `SignalFileAdapter` remembers the last 64 bytes before its offset and the modification time; it re-reads when either the size or the time changed, and starts from byte 0 when the file is shorter than the offset or those 64 bytes are no longer there (emptied and written again, of any length). Limit: a replacement whose bytes just before the old offset happen to be identical is taken for an append; an identical repeated line is then read once from the point where the new file is longer.
