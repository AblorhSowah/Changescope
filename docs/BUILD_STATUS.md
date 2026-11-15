# BUILD_STATUS (Builder)

Maintained by the Builder after every milestone. A successor must be able to continue from this file.

## Current milestone: 0.2.0 (persistence + two users) done on top of M0..M7 and the Phase 2 fixes (QA-002..QA-006). Remaining: publish to the Marketplace (needs a publisher account), see "Release checklist" below.

## Milestone log

### M0 - scaffold + npm install: DONE
- Files: `package.json` (exact pinned versions, full manifest per DESIGN 13), `.npmrc` (save-exact, no fund/audit noise), `tsconfig.json`, `src/webview/tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `LICENSE`, `.gitignore`.
- `npm install` (run once, by Builder only): `added 353 packages in 51s`, exit 0 (warnings only: deprecated inflight/glob inside mocha/vsce; install-scripts notice for esbuild/vsce-sign, ignored). `npm ls --depth=0` matches DESIGN 3 exactly.

### M1 - core basics: DONE
`src/core/{constants,types,pathUtils,clock,eventLog,config,intensity,activityTracker,sourceClassifier,burstGuard,glob}.ts`.
All DESIGN 6 worked-example tables were checked with a scratch script (all match, incl. shakeParams values).

### M2 - references: DONE
`src/core/references/{scan,usage,projectInfo,resolver,index}.ts`, `parsers/{index,util,jsTs,python,go,jvm,cfamily,rust,ruby,php,css,html,markdown}.ts` (markdown links implemented, no Deviation needed).
Counting examples (1)-(4) of DESIGN 14 give 4/1, 3/3, 2, 5. Perf: 400 KB / 5000-line TS file analysed in ~150 ms; pathological inputs (500 KB of `(`, `"a"`, backticks, `import `, `'`, `/*`, `(/[`) across 7 languages all under 300 ms.

### M3 - view model / protocol: DONE
`src/core/{viewModel,tree,decorations,statusText,protocol,webviewHtml}.ts`.

### M4 - webview: DONE and looked at
`src/webview/{app,main}.ts`, `media/webview.css`. Verified in a real headless Chromium with the browser-automation skill on a mock page (mock page + driver scripts live in the session scratchpad, not in the repo):
- green rows (rgb 63,185,80) and yellow rows (rgb 227,179,65), badges, meters, folder counts with role dot; light theme screenshot also checked.
- computed `transform` of a shaking row changes frame to frame (matrix with translate/rotate), idle row `none`.
- reduced motion (`emulateMedia`) -> `data-motion="off"`, zero `.is-shaking`, `animation-name: none`, meters and badges still present.
- folder collapse persists via `setState`, auto-expands when a new file appears, click posts `{type:'open', id}`, row removal -> `.is-leaving` then removed after 400 ms, revival works, colour override applies, disabled state, out-of-order seq ignored, hostile file name `<img src=x onerror=alert(1)>.ts` rendered as text (0 injected `<img>`), 0 console errors.

### M5 - adapters + extension.ts: DONE
`src/vscode/{uriKey,config,decorationProvider,statusBar,shakeViewProvider,referenceService,controller,editWatcher}.ts`, `src/extension.ts` (exports `ChangescopeApi`, `activate`, `deactivate`).
`npm run build` OK (`dist/extension.js` 211 KB unminified, `dist/webview.js` 21 KB). Not yet launched in a real VS Code by the Builder (Tester owns the integration suite; M7 includes the CLI install check).

### M6 - icon, README, CHANGELOG, LICENSE: DONE
`scripts/make-icon.mjs` -> `media/icon.png` (128x128 RGBA, 879 bytes, looked at: dark rounded tile with one green and two yellow bars). `README.md` (states DESIGN 2 items 1-6, DESIGN 9 reliability, reference limits, commands, settings, privacy), `CHANGELOG.md`, `LICENSE` (MIT, "Copyright (c) 2026 Changescope contributors").

### M7 - package + install: DONE
- `npm run package` (runs `vscode:prepublish` = production build first) -> `file-shake-0.1.0.vsix`, 53,149 bytes, 10 files: `[Content_Types].xml`, `extension.vsixmanifest`, `extension/{LICENSE.txt, changelog.md, readme.md, package.json, dist/extension.js (102 KB), dist/webview.js (11 KB), media/icon.png, media/webview.css}`. No `.map`, `src`, `test`, `node_modules`.
- `npx vsce ls --no-dependencies` lists exactly the 8 source files expected by DESIGN 13.
- Isolated CLI install (env scrubbed of `ELECTRON_RUN_AS_NODE` and every `VSCODE_*`; `--user-data-dir`/`--extensions-dir` in the scratchpad): `Extension 'file-shake-0.1.0.vsix' was successfully installed.` and `--list-extensions --show-versions` prints `changescope.changescope@0.1.0`.
- Real VS Code smoke test (Builder scratch script, not in `test/`; VS Code 1.129.1 via `FS_VSCODE_EXE`-style local executable, `CHANGESCOPE_TEST=1`), run against BOTH the repo (dev build) and the unzipped production `.vsix` contents: activates; 5 commands incl. `changescope.view.focus` registered; Explorer view resolved, posted `ready`, received a snapshot; `TextEditor.edit` -> row `edited/you`, decoration badge `●` with ThemeColor `changescope.editedForeground`; `a.ts` importing `b.ts` -> `b.ts` referenced row, count 4 (1 import + 3 usages), badge `4`, ThemeColor `changescope.referencedForeground`; status text `$(pulse) a.ts · typing · 1 ref`; `fs.writeFileSync` of another file -> `external` row; rows removed after idle + retain; `enable=false/true` applied live; toggle/clear/debug commands run. The smoke test found one real bug (first keystroke classified `external`), fixed - see DESIGN Deviations.

## Commands run and results (latest)
- `npm run build` -> exit 0.
- `npm run test:unit` -> 1197 tests, 1197 pass, 0 fail (Tester's unit + webview tests at the time of the last run).
- `npx eslint src scripts esbuild.mjs eslint.config.mjs` and `tsc -p tsconfig.json` and `tsc -p src/webview/tsconfig.json` -> clean (no `any`, no `innerHTML`/`eval`, no vscode/node imports in `src/core`).
- `npm run package` -> OK (see M7). `test:integration` was not run by the Builder (Tester-owned; `test/integration/` was still empty at the last check).
- `npx eslint .` -> clean for `src/` and `scripts/`; see "Open problems" for Tester-owned files.

## Open problems (not Builder files)
- `test/unit/parsers.test.ts:869` ESLint `no-control-regex` (regex with `\x00`) and `test/unit/staticChecks.test.ts:155` `no-unused-vars` (`i`): `npm run lint` fails on them (`eslint .` is clean for everything the Builder owns). Tester-owned.
- `test/unit/protocol.test.ts` lines 100-112: `tsc -p test/tsconfig.json` errors (TS2790/TS2322/TS2740: `delete` on required fields, `string` vs `Json`): `npm run typecheck` fails on it. Tester-owned.
- `esbuild.mjs --tests` skips `test/integration/runTest.ts` (it runs under tsx and imports @vscode/test-electron). Recorded in DESIGN Deviations.

## Notes for a successor
- Source/WorkspaceRoot behaviour: `loadProjectInfo` keeps the roots it is given; the adapter (`referenceService.ts`) passes `[dirname(file)]` for files outside every workspace folder.
- `analyzeReferences` blanks the exact source spans of import statements before counting usages (so `import {a} from 'x'; a()` on ONE line still counts the usage); `countUsages` itself keeps the documented line-based `excludeLines` parameter.
- `docs/DESIGN.md` Deviations section lists every departure from the contract.

## Follow-up: test seam
- pendingTimers added: `ChangescopeApi.testing.pendingTimers(): number` returns `ManualScheduler.pending` (one shared scheduler for controller, referenceService and editWatcher, including the 150 ms dirty-state parking timer). Test mode only. Recorded in DESIGN Deviations.

## Phase 2 fixes (after the Tester's adversarial pass; all reproduced in real VS Code first)
- QA-003 `controller.ts`: `rerequestActive` -> `rerequestShown` (active files, plus idle ones while `showWhenIdle` keeps them listed). Idle rows no longer lose their references after a rename.
- QA-004 `controller.ts`: `applyConfig` calls `ensureTick()` when `needsTick()`, so turning `showWhenIdle` off schedules the removal of idle rows.
- QA-005 `editWatcher.ts` + `controller.ts` + `core/activityTracker.ts`: `renameUnder` returns a count, `onRenamed` returns whether state moved, and the watcher treats the rename's echo as VS Code's own write (`recentMoves`, `lastOwnWriteAt`) so a typed file stays `you`.
- QA-006 `editWatcher.ts`: `external` document events pass `BurstGuard` (reason `burst`).
- QA-002 `referenceService.ts`: cache key is `doc:<identity>:<version>`. Not demonstrable on VS Code 1.129.1 (the text model outlives the editor), see DESIGN Deviations.
- Test-side changes: `test/integration/suite/75-adversarial.single.test.ts` (QA-006 wait also accepts `burst`), `test/integration/suite/76-folders.multi.test.ts` (rewrites the probe file every 500 ms until the new folder's watcher is live; a single write raced VS Code's asynchronous watcher start and failed about half the time on the unmodified code too), `test/unit/activityTracker.test.ts` (`renameUnder` return value).

## Release checklist
- `npm run lint`, `npm run test:unit` (1322), `FS_VSCODE_EXE=... npm run test:integration` and `FS_INSTALLED_VSIX=$PWD/file-shake-0.2.0.vsix ... node --import tsx test/integration/runTest.ts` (154 pass, 1 skipped; the undo test in 10-editing depends on desktop focus and can fail if another window is in front while the suite runs) are green.
- `npm run package` -> `file-shake-0.2.0.vsix` (10 files, about 52 KB). Local install: `code --install-extension file-shake-0.2.0.vsix`.
- Not done: `vsce publish` / Open VSX. `package.json` still has placeholders: `publisher` is `file-shake` (must be a real Marketplace publisher id you own, and the extension id becomes `<publisher>.file-shake`) and `repository.url` is `https://github.com/OWNER/file-shake.git` (the package script passes `--allow-missing-repository` because of it). Publishing also needs a personal access token. Also not done: Windows/Linux runs, VS Code 1.85 floor run.

## 0.2.0: persistence and the two users
- Spec and rules: `docs/DESIGN.md` section 15 and the last Deviations bullet.
- Core: `ActivityTracker` (`persist`, `release`, superseded-file rule), `viewModel` (`ViewRow.actor`, per-user source cap), `tree` (`buildActorTree`, id prefix), `protocol` (`actor`), `config` (`persistUntilNextFile`).
- Adapters: `controller` (`keepsIdle`, `onActiveEditorChanged`, `onWindowFocusChanged`, `noteOpenedFromView`), `extension` (editor and window listeners, two test seams), `shakeViewProvider` (`onOpenRow`).
- Webview: sections rendered by the existing folder code (`data-actor`), `media/webview.css` section styles.
- Tests: tracker persist mode (14), view model actor (5), tree sections (7), protocol actor (3), webview sections (6), integration suite `77-persistence.single` (13, real VS Code). Seven older integration tests assert timed removal and set `persistUntilNextFile` to `false` explicitly. Version pins moved to 0.2.0.
- Checked by mutation in scratch copies (each killed by the matching tests): switching files never releases you; window blur never releases you; the view-click guard removed; an idle file never replaced by the same user's next file.
- Release checklist above still applies; the package is now `file-shake-0.2.0.vsix`.

## 0.3.0 host build (Host Builder) : DONE, awaiting Tester pin updates and the dashboard visual pass
Contract: `docs/DESIGN-0.3.0.md` (its `## Deviations` section lists every departure, the test seams and the extra exports). Host Builder owns src/core (except the fixed type block and `core/dashboard/protocol.ts`), src/vscode, src/extension.ts, package.json, README, CHANGELOG, .github, this file.

### What exists
- Core (pure, no vscode/node): `activity/{attribution,eventStore,collision}`, `sessions/{sessionManager,report}`, `storage/schema`, `intelligence/{depGraph,testMatch,impact}`, `git/gitModel`, `ai/{provider,localSummary,agentSignal}`, `dashboard/model` (buildDashboardState, stateSignature), `timeFormat`, config (13 new fields), `intensity.scaleShake`, `ReferenceTarget.kinds`, `ClassifyReason 'paused'`.
- Adapters: `vscode/{storage,activityService,gitService,dependencyIndex,collisionNotifier,agentSignal,aiService,dashboardProvider,commands}.ts`; `editWatcher` (onEvent hook, workbench create/delete, pause gate), `controller` (hooks, compact mode, animationIntensity), `extension.ts` (wiring, 5 API additions, test seams).
- Manifest 0.3.0 (16 commands, 13 settings, Activity Bar container + view, dashboard view title menu), README, CHANGELOG, `.github/workflows/{ci,release}.yml`.

### Verification (latest)
- `npm run build`, `npm run lint` (eslint . + typecheck of all four tsconfigs): clean.
- `npm run test:unit`: 1358 tests, 1336 pass, 10 fail, 12 skip. All 10 failures are pins to 0.2.0 shapes (see below); the Tester must update them.
- `npm run package` (no `--allow-missing-repository` needed): `changescope-0.3.0.vsix`, 13 files, 113 KB: package.json, readme, changelog, LICENSE.txt, dist/{extension,webview,dashboard}.js, media/{activity.svg,dashboard.css,icon.png,webview.css}. No maps, sources, tests or node_modules. CLI install into isolated dirs lists `changescope.changescope@0.3.0`.
- Integration (`FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:integration`, VS Code 1.129.1): variant single 97 pass, 1 pending, 1 fail; multi 23 pass, 1 fail; none 22 pass, 1 fail; real 6 pass. The one failure in each variant is the `extensionVersion === '0.2.0'` pin in `01-activation`. Run before the last one-line change to `editWatcher.accept` (extra pause gate); lint, unit and the smoke test were re-run after it, the integration suite was not.
- Real-host smoke test of the 0.3.0 features (scratch script, NOT in the repo, driven through `ChangescopeApi.testing`; passes 25 of 25 steps in 3 of 3 runs on the dev build and 2 of 2 on the packaged production bundle; one earlier run timed out after 40 s waiting for the Git lists to show an untracked and a modified file, not reproduced and cause not established): 25 steps pass: api surface and 16 commands, dashboard view loads `dist/dashboard.js` and posts ready, developer / external / agent / git attribution with method and confidence, pause, sessions and report (no absolute paths), dependency index (reverse edges, impact, related tests, not started by itself), incremental re-index, collision warning, git lists and head-change relabelling, AI local / assisted / consent once / provider error falls back / sensitive files and absolute paths never in a request, agent signal file, review counts, compact mode and animationIntensity reach the Explorer snapshot, malformed messages ignored, copyAgentHook, Memento round trip and reload, clearHistory confirmation, history.persist off/on, maxEvents, editor panel (one at a time), zero timers when idle.

### Existing tests that the 0.3.0 changes break (all pins, Tester to update)
- `test/unit/config.test.ts`: `has exactly the documented keys`, `unknown keys are dropped; the result has exactly the documented keys`, `valid values pass through unchanged` (DEFAULT_CONFIG / ChangescopeConfig gained 13 fields).
- `test/unit/manifest.test.ts`: `identity` (version), `npm run typecheck` (script now also checks `src/dashboard/tsconfig.json`), `npm run package` (flag removed), `the four commands with the Changescope category` (20 commands now), `view title menu offers clear + toggle for this view only` (dashboard view title entries added), `exactly the documented 15 settings` (28 now), `.vscodeignore excludes everything and un-ignores exactly the shipped files` (Dashboard Builder added `dist/dashboard.js`, `media/*`).
- `test/integration/suite/01-activation.test.ts`: `changescope.showDebugInfo writes the documented JSON...` asserts `extensionVersion === '0.2.0'`.
- Likely also pinned (skipped here because no 0.2.0 vsix exists): `test/unit/vsix.test.ts` (file name, file list, version).
- A timing test (`no language x pattern combination takes more than 1000 ms`) failed once while VS Code was running the integration suite on the same machine; it passes alone (212/212 in `performance` + `parsers`).

### Things to know when continuing
- The 0.3.0 timers (storage 1000 ms, dashboard 250 ms throttle, re-index 500 ms, AI timeout) all use the injected Scheduler and are cancelled on dispose. In test mode the index never starts by itself, Git reads state immediately, and an unrelated settings change or an unchanged model schedules nothing. Do not make `controller.onDidUpdate` call `dashboard.invalidate()` directly: every `testing.advance()` refreshes the controller and would leave a timer pending forever (use `invalidateLive`).
- `vscode.git`'s repository state is a class with prototype getters: never spread it, read properties (`gitService.read`).
- VS Code keeps workspace storage in memory for an extension-test host (no `state.vscdb` is written), so restart persistence cannot be tested through `@vscode/test-electron`. The suite can use `testing.storedHistory()` and `testing.reloadHistory()` (Memento round trip in one session).
- Not verified: CI workflows (never run on GitHub), the Windows and Linux unit runs, VS Code 1.85 floor, the dashboard in a real browser (Dashboard Builder's job), a restart against real storage.
- Not done: publishing (publisher id is still a placeholder, `changescope`), no network AI provider (by design).

## 0.3.0 bug-fix round (Host Builder): DONE
Source: docs/QA_REPORT.md "0.3.0 round 1" and "round 2". Every item is fixed at its root cause; details and decisions are in `docs/DESIGN-0.3.0.md` under "Host Builder, bug-fix round".

| ID | Fix |
|---|---|
| QA-101 | `core/pathUtils.toSafeDisplayPath` (workspace-relative, or `(outside workspace)/<name>`); used by `ActivityService.sessionReport` and `DashboardProvider.summarize`. `toDisplayPath` and the dashboard state are unchanged. |
| QA-102 / QA-103 | `DepGraph.dependants` treats Infinity as unbounded; duplicate edges keep the strongest type (import, reference, inheritance, export, unknown). |
| QA-104 / QA-105 / QA-106 | `core/dashboard/protocol.ts`: holes rejected, `type` read once, C1 controls stripped. |
| QA-107 | `EventStore.recent(Infinity)` returns all. |
| QA-108 | `TestIndex` (`buildTestIndex`, `relatedTestsIn`), cached by `DependencyIndex` per change of the indexed paths; 50 impacts at 10,000 files: about 127 ms to about 2 ms; fuzz equivalence 14,400 lookups, 0 differences. |
| QA-109 | `sensitiveGlobs` always case-insensitive (index, AI request, and the Explorer view analysis no longer reads sensitive sources). |
| QA-110 | `SignalChunker` (bytes, line decoded after its newline) plus replaced-file detection (last 64 bytes before the offset and mtime). |
| QA-111 | `DependencyIndex` remembers the importers of a deleted path (bounded) and re-analyses them when the path reappears. |
| doc + hardening | `EventStore.add` review barrier documented; `buildDashboardState` clamps every number it passes through. |

### Verification (this round)
- `npx tsc -p tsconfig.json --noEmit`, `npm run lint`, `npm run build`: clean.
- `npm run test:unit` (final run, 2026-11-14): 2501 tests, 2501 pass, 0 fail, 0 skipped, 0 todo (the QA-102 to QA-107 tests no longer carry the `todo` option).
- Integration (`FS_VSCODE_EXE=... caffeinate -i npm run test:integration`), 2026-11-14, calm machine: with the test VS Code window held in front (Tester's final run, repeated against the installed `.vsix`): single 169 pass, 2 pending, 0 fail; multi 28; none 31; real 6. A run of mine without keeping the window in front: single 168 pass, 2 pending, 1 fail; the failure is the unchanged 0.2.0 test `undo is classified as you (undo-redo), never as a reload`, which acts on the focused editor and fails when another window holds the OS focus (it passes alone with VS Code in front). The 2 pending are the QA-002 reproducer and the Git-lists test, which skips itself when the built-in Git extension is unavailable. Runs made while the machine was swapping (load average 200 to 350, battery at 1 to 3 percent; one run took 42 minutes instead of 3) failed up to 7 wall-clock tests; they passed once it recovered.
- `node esbuild.mjs --production && npm run package`: `changescope-0.3.0.vsix`, exactly 13 files, about 115 KB; no maps, sources, tests or screenshots.
- The scratch real-host smoke test (not in the repo) passes 24 of 25 steps in this session: the Git-lists step times out because the built-in Git extension only refreshes after file changes while the window is focused (checked in its `main.js`: `whenIdleAndFocused()` before every `status()`); after `git.refresh` Changescope's lists match `git status` exactly. Earlier in the day, with the window focused, all 25 passed.
- `docs/BENCHMARKS.md` and the benchmark script are the Tester's; round 3 re-measured `analyseImpact` with `buildTestIndex` (the real code path) and keeps the old scan-per-call figures for comparison.
