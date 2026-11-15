# QA Report - Changescope 0.1.0 (Tester)

Status: **Phase 2 complete** (adversarial reads, mutation sampling, package audit, `.vsix` install check, real-time variant).
Phase 2 found five defects (QA-002..QA-006). QA-003..QA-006 are fixed and verified in real VS Code; QA-002 is fixed by reasoning only (see 3).
The Tester (an earlier session's agent) was cut off by a usage limit before it could write this up; the final verification and this
section were completed in a later session. Phase 1 text below is unchanged where it is still true.

Everything below was actually run on this machine (macOS 24.2, Node v24.20.0, VS Code 1.129.1 at
`/Applications/Visual Studio Code.app`). Nothing is reported that was not executed.

## 1. Summary

| Area | Result |
|---|---|
| Unit + webview (`npm run test:unit`) | **1284 / 1284 pass**, 0 fail, 0 skipped (about 10 s) |
| `npm run lint` (`eslint .` + all three `tsc` projects) | exit 0 |
| Integration, dev build, real VS Code 1.129.1, all four variants | single **86 pass**, multi **25**, none **24**, real **6**; 0 fail; 1 pending (QA-002, see 3). Two consecutive full runs. |
| Integration against the installed `.vsix` (`FS_INSTALLED_VSIX`) | same four variants, **all pass**; two consecutive full runs on the final package |
| Package audit | `file-shake-0.1.0.vsix`: 10 files, 52 KB; no `.map`, `src`, `test`, `node_modules`, `.ts` |
| Standalone CLI install (isolated user-data and extensions dirs) | `Extension 'file-shake-0.1.0.vsix' was successfully installed.`; `--list-extensions --show-versions` prints `changescope.changescope@0.1.0` |
| Mutation sampling (scratch copies, never `src/`) | unit level: 76 mutants, 75 killed (72 at first, 3 more after the tests were strengthened), 1 survivor that is equivalent (`>=` vs `>` at exactly `idleTimeoutMs`, where the intensity formula is already 0). Integration level: partial, see 6. |

Open bugs: **none known**. Unverified: QA-002, Windows/Linux, VS Code 1.85, visible rendering in light/dark/HC themes (see 5).

## 2. Commands run

```
npx tsc -p test/tsconfig.json --noEmit                  # exit 0
npx eslint test                                         # exit 0 (clean)
npm run lint                                            # exit 0
npm run test:unit                                       # tests 1257, pass 1257, fail 0
npm run build && npm run build:test
FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
  node --import tsx test/integration/runTest.ts         # variants single, multi, none: all PASSED
FS_TEST_VARIANTS=single FS_TEST_GREP="undo is classified|saving is not activity" ...   # targeted re-run while debugging
```

The integration run printed `[runTest] scrubbed from the environment: ELECTRON_RUN_AS_NODE, VSCODE_CODE_CACHE_PATH,
VSCODE_CRASH_REPORTER_PROCESS_TYPE, VSCODE_CWD, VSCODE_ESM_ENTRYPOINT, VSCODE_HANDLES_UNCAUGHT_ERRORS, VSCODE_IPC_HOOK,
VSCODE_L10N_BUNDLE_LOCATION, VSCODE_NLS_CONFIG, VSCODE_PID`: the environment trap from DESIGN 13 is real in this shell and
the harness handles it. VS Code was never downloaded (`FS_VSCODE_EXE`). Each launch used an isolated `--user-data-dir` /
`--extensions-dir` under `/tmp/fs-XXXXXX`, so the user's own VS Code was untouched.

## 3. Bugs

| ID | Severity | Status | Failing test(s) / repro | Expected | Actual |
|---|---|---|---|---|---|
| QA-001 | low | **fixed** (verified) | `test/unit/resolver.test.ts` > "root-relative specifiers try every workspace root" and `test/unit/resolver.test.ts` > "a leading slash is relative to the workspace root(s)". Repro: `analyzeReferences` for `/w1/a.ts` with roots `['/w1','/w2']` and `import x from '/shared/only-in-second'` where only `/w2/shared/only-in-second.ts` exists. | DESIGN 8.5: `/x` is resolved "relative to each workspace root" (TS/JS) / "workspace root(s)" (HTML, Markdown). | At first run only the root containing the importing file was searched, so the target in the other root was reported unresolved (2 failures). The Builder then made it try every root, containing root(s) first, and recorded it in DESIGN Deviations. Re-run after the change: both tests pass. |

| QA-002 | medium | **fixed, not demonstrated** | `75-adversarial.single` > "[QA-002] closing a document without saving and re-opening it must not reuse ..." | A document closed unsaved and re-opened is a new object whose `version` restarts at 1; the reference cache must not reuse the discarded buffer's result when the new buffer reaches the same version number. | Cache key was `doc:<version>` only. Now `doc:<identity>:<version>` (`referenceService.ts`). The reproducer needs VS Code to dispose the text model after the editor closes; on 1.129.1 the model outlives the editor, so the test skips itself. |
| QA-003 | medium | **fixed** (verified) | `75-adversarial.single` > "[QA-003] ..." | With `showWhenIdle` on, renaming an unrelated file must not drop the references shown for idle files. | After a rename only active sources were re-analysed, so idle rows lost their yellow references. Now every source on screen is re-requested. |
| QA-004 | low | **fixed** (verified) | "[QA-004] ..." | Turning `showWhenIdle` off while a file is idle schedules its removal. | No timer was pending, so the idle row stayed until something else happened. `applyConfig` now restarts the tick. |
| QA-005 | medium | **fixed** (verified) | "[QA-005] ..." | Renaming a file you are typing in keeps it `you`. | The watcher's echo of the rename was classified `external` and flipped the source. The echo is now `self-save` when tracked state moved. |
| QA-006 | medium | **fixed** (verified) | "[QA-006] ..." | A checkout rewriting 45 files that are open in editors is suppressed by `BurstGuard` like any flood. | Reloads of open documents bypassed `BurstGuard`; 40 of 45 files were shown. `external` document events now pass it. |

No other test failed against the Builder's implementation once the test-side mistakes below were corrected.

Test-side corrections made during Phase 1 (not product bugs, listed so the history is honest):
* `integration`: "undo is classified as you" and "saving is not activity" first failed (`6 !== 0`, `27 !== 29`) because the event log is
  a shared ring buffer that still held `reload-from-disk` entries from earlier tests' reverts. Both tests now look only at entries
  stamped after a fake-clock mark; both pass, in isolation and in the full run.
* `glob`: a lone `!` entry matches everything (picomatch negation); removed from the "weird glob" list (that is picomatch semantics, not a defect).
* `webview`: I had asserted that `ul.fs-tree` is absent in the empty state and that Space on a folder toggle flips it; the contract
  says neither, so the assertions were relaxed / removed (Space on a `<button>` is native click behaviour).

Test-side corrections made in Phase 2 (not product bugs):
* `76-folders.multi` "a folder added at runtime is watched ...": the test wrote one file right after the workspace-folder change event. VS Code starts
  watching an added folder asynchronously, so that single write is sometimes never reported. Measured on a pristine copy of the unmodified code: 5 failures
  in 8 runs; the extension's event log held no entry at all for the new folder, i.e. VS Code never delivered the event. The test now rewrites the file every
  500 ms until it is seen; 10 / 10 runs pass, and the watcher always saw the file within one rewrite.
* `75-adversarial.single` QA-006: the wait for "reload events classified" now also accepts reason `burst`, which is the correct outcome once the flood is suppressed.

Observation, not a bug: the test host prints `rejected promise not handled within 1 second: cannot open file .../scratch-rename-4/after.ts`
after the rename test. Changescope never calls `openTextDocument`; this is a built-in extension (TypeScript "update imports on file
move") opening the renamed file after the test removed it. Harmless noise.

## 4. Test inventory

Counts are test cases as reported by `node --test` (unit, webview) or defined `test(...)` blocks (integration).

### Unit (`test/unit`, 1132 cases)

| File | Cases | What it asserts |
|---|---|---|
| `intensity.test.ts` | 91 | every row of every DESIGN 6 table, boundaries (0, 1, huge, NaN, negative, +-Infinity), monotonicity |
| `pathUtils.test.ts` | 46 | normalise/dirname/basename/extname/join/isUnder/relativeTo/hasSegment/toDisplayPath; Windows, UNC, drive letters, nested and multi roots |
| `clock.test.ts` | 17 | `ManualClock`, `ManualScheduler` ordering/cancel/nesting, system clock, `EventLog` ring buffer |
| `config.test.ts` | 52 | defaults, clamps, rounding, booleans, globs, colours, 500 fuzz combinations, `toTrackerOptions` |
| `constants.test.ts` | 29 | DESIGN 5 values literally (other tests compare against `K.*`, so they would not notice a changed constant) |
| `activityTracker.test.ts` | 55 | window/decay tables through the tracker, idle boundary at exactly `idleTimeoutMs`, retain, dedupe, eviction, rename/forgetUnder, clock regression, 512-event cap |
| `sourceClassifier.test.ts` | 25 | all six rows, precedence (all 144 combinations), watcher rule, `BurstGuard` incl. "100 files in 1 s -> exactly 30" |
| `glob.test.ts` | 52 | default globs on 38 paths, invalid entries, nocase, `relativeForMatch` |
| `scan.test.ts` | 50 | `scanCode` per family (comments, strings, templates, regex vs division, Rust nesting/raw/lifetimes, Go raw, Java text blocks, Python prefixes/triple quotes, Ruby `=begin`, PHP blocks, CSS vs SCSS `//`, HTML, Markdown) + shape fuzz |
| `parsers.test.ts` | 201 | one positive+negative fixture per language (16), `detectLanguage`, MAX_STATEMENTS, specifier limits, CRLF, token-soup fuzz |
| `usage.test.ts` | 17 | `countUsages` boundaries, dotted locals, excluded lines, documented non-modelled behaviours |
| `projectInfo.test.ts` | 10 | tsconfig/jsconfig/go.mod/composer.json discovery, malformed config, fs failures |
| `resolver.test.ts` | 159 | per-language resolution (TS/JS incl. paths/extends/baseUrl and the full extension order, Python, Go, Java/Kotlin, C/C++, Rust, Ruby, PHP, CSS/SCSS/Less, HTML, Markdown), probe budget and memo |
| `analyze.test.ts` | 39 | the four DESIGN 14 counting examples, filtering (self, node_modules, excluded, missing), 30-target truncation, skipped files (too-large, binary, excluded, unsupported), deadline, probe budget |
| `viewModel.test.ts` | 24 | rows, green wins, sources limit, idle/showWhenIdle, summed counts, ordering, trimming to `maxFiles` |
| `tree.test.ts` | 18 | compaction, ids, ordering (never by intensity), aggregates, multi-root, hostile names |
| `decorations.test.ts` | 16 | badges (`9+`, <= 2 UTF-16 units over 2,000 inputs), colours, propagate, idle rule, `changedKeys`, no per-keystroke churn |
| `statusText.test.ts` | 11 | all `buildStatus` rules and tooltip format |
| `protocol.test.ts` | 79 | 59 individually named malformed-field mutations (25 snapshot-level, 34 row-level), 500/501 rows, cyclic/deep/throwing-getter/proxy input, fuzz, webview-to-host messages, truncation |
| `webviewHtml.test.ts` | 13 | exact CSP, nonce, single script, escaping, `makeNonce` |
| `performance.test.ts` | 11 | 5,000-line file <= 400 ms, 32 pathological 500 KB patterns x 16 languages in a child process with a hard timeout (each <= 1000 ms), 200 rapid edits <= 20 ms, 10k events, model refresh, 500-row validation |
| `staticChecks.test.ts` | 22 | `src/core` purity, webview bundle closure, no `any`, no HTML sinks, no inline style/handlers, no sync fs, no direct timers outside `core/clock`, commands match the manifest |
| `manifest.test.ts` | 76 | package.json fields, exact pins, scripts, colours, 14 settings vs `core/config`, README honesty (DESIGN 2/9), LICENSE, CHANGELOG, `.vscodeignore`, 128x128 RGBA icon |
| `harness.test.ts` | 19 | env scrub trap, temp dirs, fixture copy, layouts per variant, suite selection, no sleeps in suites |

### Webview (`test/webview`, 125 cases, jsdom)

| File | Cases | What it asserts |
|---|---|---|
| `render.test.ts` | 35 | the DOM contract, exact CSS variable strings (`2.25px`, `110ms`, `0.7deg`, `0.5`), colour overrides, folders/compaction/ordering, in-place updates, `seq` ordering |
| `motion.test.ts` | 10 | `.is-shaking` iff motion on and active and intensity > 0; reduced motion (initial and live) and `animate:false` keep colour/badge/meter |
| `interaction.test.ts` | 23 | open on click/Enter/Space, collapse + persistence + auto-expand on new file, `preventDefault` on Enter, leaving/revive timers (`LEAVE_MS`) |
| `security.test.ts` | 24 | 14 hostile names as text only, selector-breaking ids, runtime guard on `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`setAttribute('style')`, 20 malformed messages |
| `lifecycle.test.ts` | 9 | dispose twice, post-dispose messages and clicks, subscription release, two independent views |
| `css.test.ts` | 15 | `media/webview.css` contract (keyframes, reduced-motion, HC, colour chains, no remote URLs) + jsdom cascade: collapsed children really hidden |
| `bundle.test.ts` | 9 | the **shipped** `dist/webview.js` executed in a page from `buildWebviewHtml` with a stubbed `acquireVsCodeApi` (covers `main.ts`) |

### Integration (`test/integration`, 78 cases, real VS Code, mocha `tdd`)

| File | Variant | Cases | What it asserts |
|---|---|---|---|
| `01-activation.test.ts` | all | 12 | activation, exports, commands incl. `changescope.view.focus`, empty model, setting defaults served by VS Code, opening files is not activity, view resolves + posts `ready`, toggle both ways, clear, debug info* |
| `10-editing.single.test.ts` | single | 23 | typing -> `edited/you` row, `●` + ThemeColor + tooltip, status text, `a.ts` -> `b.ts` (count 4) / `c.ts` (1) yellow with `4`/`1` badges, green wins, Python and SCSS targets, intensity 0.2835 / 0.5905 / 0.9639 on the fake clock, idle at exactly 2500 ms and removal at 6500 ms, unfocused window -> `external`, `WorkspaceEdit` -> `external`, undo -> `you`, save is not activity, untitled/excluded ignored, clear, symlink target, file outside the workspace, 200 rapid edits, odd file names |
| `20-watcher.single.test.ts` | single | 12 | disk write/create -> `external` row + `◆` + 0.8647, references from an externally written file, delete, folder delete, rename, 60-file burst suppressed, directory create ignored, excluded paths, > 512 KB file and NUL file tracked but not scanned, reload de-duplication |
| `30-settings.single.test.ts` | single | 13 | live `enableAnimation`, colours (valid/invalid), `enable`, `idleTimeoutMs` (and clamp), `sensitivity`, `showWhenIdle`, `decorateFolders`, `detectExternalEdits`, `excludeGlobs`, `maxFiles`, junk values, concurrent updates |
| `40-view.test.ts` | all | 4 | `ready` handshake, snapshots while visible, nothing sent while hidden and resend on show, focus while disabled |
| `50-multiroot.multi.test.ts` | multi | 7 | two folders, same file name in both roots stays distinct, root-name prefixes, cross-root reference, one watcher per folder, outside-workspace file |
| `60-noworkspace.none.test.ts` | none | 7 | no folder: tracking, `(outside workspace)` grouping, neighbour references, exclude globs on absolute paths, commands, idle clean-up |
| `70-scenarios.single.test.ts` | single | 8 | real-world scenarios: external edit of an open clean file and of an open dirty file, edit -> idle -> removed lifecycle, a file importing six others (counts 1..6), rename + delete while the importer is edited, 50 files created in one second, toggling `enable` with the view open, atomic replace (temp file renamed over an open file) |
| `75-adversarial.single.test.ts` | single | 11 | probes written to break the adapters: QA-002..QA-006, references following the text of an open document, folder rename re-keying, format-on-save edits, autosave echo |
| `76-folders.multi.test.ts` | multi | 1 | a workspace folder added and removed at runtime: watched, displayed under its own name, cross-root imports resolve |
| `80-performance.single.test.ts` | single | 3 | 200 rapid edits (overhead per edit), model refresh with 40 files x 30 references <= 5 ms, typing in a 400 KB file |
| `90-realtime.real.test.ts` | real | 6 | launch variant without the test seam: the production configuration, real window focus, first keystroke never a reload, real tick chain (active -> idle -> removed), external write, burst of 150 keystrokes, real rename/delete |

Totals after Phase 2: unit and webview 1284 (the table above lists the Phase 1 counts of 1132 + 125), integration 142 defined across the four variants (141 pass, 1 skipped).

## 5. Not executed / not covered (what stays unverified)

* **Visible rendering inside a real VS Code window has not been looked at.** What is proven: DOM, classes, CSS custom properties and CSS text (jsdom),
  the shipped bundle running under a stub (jsdom), the Builder's headless-Chromium run of the webview on a mock page (colours, `transform` changing
  frame to frame, reduced motion, light theme), and in real VS Code that the view resolves, posts `ready` and receives snapshots, that the explorer
  badge and colours are set, and that the status bar text is right. What no run covered: the sidebar webview actually shaking on screen in VS Code, dark and
  high-contrast themes, and whether the CSP lets the nonce'd script run in a real webview beyond the observed `ready` handshake.
* **QA-002** is fixed by reasoning; its reproducer skips itself on VS Code 1.129.1 because the text model outlives the editor (1 pending test).
* **Skipped by design:** "showDebugInfo writes JSON" (the Output channel text cannot be read through the API; the command runs without error).
  "Deactivate / dispose twice" (DESIGN 12, row I) cannot be driven through the public API; it is covered statically (`staticChecks.test.ts`), not dynamically.
  The former "zero timers when idle" skip is gone: `ChangescopeApi.testing.pendingTimers()` exists and the test runs.
* **Only VS Code 1.129.1 on macOS was run.** The engine floor (1.85.0) was not launched (`VSCODE_TEST_VERSION=1.85.0` re-runs the suite on it, about a 124 MB download).
  Windows and Linux were not run; Windows behaviour is covered at the key/path level in unit tests only.
* **Not published.** `package.json` has placeholder `publisher` (`file-shake`) and `repository.url` (`.../OWNER/file-shake.git`); see `docs/BUILD_STATUS.md` "Release checklist".
* Writes to a workspace folder in the first few hundred milliseconds after it is added can be missed. That is VS Code's asynchronous watcher start, not Changescope (see 3).

## 6. Mutation sampling (preliminary Phase 2 item, done in a scratch copy under the session scratchpad)

23 single-line mutants, each run against the most relevant test files; all killed:
idle boundary `<` to `<=`; retain boundary; `FLOOR` removed; `MIN_SPAN_MS` removed; burst `>` to `>=`; glob `dot:true` to `false`;
node_modules filter removed; badge `9+` threshold; webview ignores `animate`; `MAX_REFS_PER_SOURCE` 30 to 31; `REF_SATURATION` 32 to 31;
Python relative level off by one; referenced sort order; `is-idle` class removed; config max clamp removed; protocol colour check removed;
`EXTERNAL_EVENT_WEIGHT` 6 to 5; external dedupe removed; Enter-on-toggle `preventDefault` removed; folder auto-expand removed;
Rust nested comments off; `name` via `innerHTML`; `.tsx` probed before `.ts` (TS extension order).
Two survived at first (`MAX_REFS_PER_SOURCE`, TS extension order) because the tests compared against `K.*` / did not probe `.ts` vs `.tsx`;
`constants.test.ts` and the full extension-order tests were added and then killed them.

Phase 2 extended this to **76 unit-level mutants**: 72 killed in the first pass, the 4 survivors were re-checked after strengthening the tests and 3 of them are now killed. The one survivor, idle boundary `>=` to `>` in
`core/intensity.ts`, is an equivalent mutant: at exactly `idleTimeoutMs` the formula `1 - since / idleTimeoutMs` already returns 0. Mutants that survived the first pass and were then killed
by new tests: burst guard counting repeated keys, `lastEditAt` moving backwards, target cap off by one.

**Integration-level** mutation (about 35 mutants of `src/vscode/**`, run in scratch copies) was interrupted by the usage limit and is not conclusive: several survivors are
not observable through the public API (status bar visibility, dispose paths, which row a webview click opens), and the scratch copies did not carry the nested `node_modules` fixtures,
so every run had two baseline failures. Re-checked afterwards with the fixtures restored (clean baseline: 85 pass, 0 fail):
* removing the dirty-flag settling entirely (the real bug found in the Builder's smoke test: the first keystroke classified `external`): **killed by 17 tests**;
* shortening the settle delay from 150 ms to 0 (`DIRTY_SETTLE_MS`): **survives** in `single` and `real`; on VS Code 1.129.1 the dirty-state event arrives in the same batch, so the two are not distinguishable by behaviour.

## 7. Assumptions (where DESIGN is ambiguous, the reading the tests encode)

1. **Module homes.** References API is imported through one barrel, `test/support/refs.ts` (`references/{scan,usage,projectInfo,resolver,index}`, `parsers/index`); shared types through `test/support/types.ts` (`core/types`); `ManualClock`/`ManualScheduler`/`EventLog` from `core/clock`, `core/eventLog`; `buildWebviewHtml`/`makeNonce` from `core/webviewHtml`. If a module moves, only those barrels change.
2. **`api.testing.advance(0)` is a pure model refresh** (clock does not move, `onDidUpdate` fires). The integration helpers use it to re-read state.
3. **`parseImports` order is not specified**: tests sort by (line, specifier).
4. **Python relative imports**: the specifier may or may not include the leading dots; tests strip them and assert `relativeLevel` separately.
5. **Go grouped imports**: each member's `[line, endLine]` must cover the member's own line (a statement may report the whole group's range).
6. **Java/Kotlin wildcards**: compared after stripping a trailing `.*`; they must bind nothing.
7. **Rust `use`**: only the specifier prefix and the union of bindings are asserted (brace group = one or several statements).
8. **Ruby / PHP relative markers** are not asserted (encoding left to the Builder); only the path tail is.
9. **`export ... from` creates no bindings** (the re-exported names are not locals of the file). `import x = require()` kind may be `import` or `require`.
10. **Markdown links** are optional per the design: tests accept support or a recorded Deviation (the Builder implemented it, so the full assertions run).
11. **Config numerics**: `Infinity` may clamp or fall back to the default (only "in range" asserted); `idleTimeoutMs`/`windowMs` are not rounded, `maxFiles`/`maxFileSizeKb` are.
12. **Tracker**: external dedupe is asserted at 299 ms (dropped) and 301 ms (accepted) only, since the boundary is unspecified; shrinking `maxFiles` via `setOptions` must be honoured by the next `record` (size never stays above the cap); `msSinceOwnSave < 0` is treated as "just saved".
13. **`buildRows`** receives `tracked` already in tracker order (recency desc) and keeps that order; referenced rows sort by `refCount` desc then key asc.
14. **Decoration churn (design intent, DESIGN 1/10)**: a per-edit counter must not make the native decoration change; tested with `changedKeys` (the Builder recorded this as a Deviation).
15. **`buildStatus`**: with only idle edited rows either the plain label or the first idle row is accepted.
16. **Tree**: a folder whose only child is a *file* is not compacted; only folder-only chains merge.
17. **Webview**: `ul.fs-tree` may exist in the empty state (only "no `li`" is asserted); a folder toggle must `preventDefault()` on Enter, otherwise a real browser also fires `click` and toggles twice; Space on the toggle is native and not asserted; `lastSeq` initial value is not asserted.
18. **Collapsed state restore**: after the first snapshot a restored collapsed folder stays collapsed (Builder Deviation: first snapshot is a baseline); asserted only in `bundle.test.ts`.
19. **Integration naming**: `x.single.test.ts` / `x.multi.test.ts` / `x.none.test.ts` pin a suite to a launch variant, untagged suites run in all three. Settings are written at `Global` scope (isolated `--user-data-dir`), tests create uniquely named scratch directories, and every wait is a bounded re-read of state, never a fixed sleep.
20. **Fake clock vs real events**: VS Code reports the first edit of a clean document and its dirty-state change as two events; the helper `typeAndWait` waits until the edit is recorded before advancing the fake clock so the 150 ms settle timer cannot race the second event.
21. **Fixtures** carry a `.fixture` suffix (stripped on copy) so deliberately odd sources never reach `tsc`, `eslint` or the `.vsix`.
22. **Performance** budgets are best-of-N wall times (3 or 5 runs) to tolerate scheduler noise; budgets are those of the design (400 ms / 1000 ms / 20 ms).

## 8. What I need from the Builder

1. Optional but requested: `ChangescopeApi.testing.pendingTimers(): number` (see 5).
2. Nothing blocks Phase 2. If any module is renamed or any `K` value changes, tell me: the literal-value tests (`constants.test.ts`, `manifest.test.ts`) will fail by design.
3. Please keep `lastSeq`-style details and the Deviations list current: several tests read DESIGN.md's `## Deviations` (markdown support) and the manifest.

## 9. How to re-run

See `test/README.md`. Short form: `npm run test:unit`; `npm run lint`; `FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:integration`.


---

# 0.3.0 round 1 (Tester): core modules, dashboard webview, performance, mutation sanity

## 0.3.0 status at the end of round 2

| | |
|---|---|
| Unit and webview (`npm run test:unit`) | tests 2409, pass 2403, fail 0, skipped 0, todo 6 (the six todo are open bugs QA-102 to QA-107) |
| Lint, typecheck of all four projects | clean |
| Integration, standard launch, single | 160 pass, 2 pending, 4 fail: the four open bugs below |
| Integration, standard launch, multi / none / real | 28 pass / 30 pass and 1 fail (QA-101) / 6 pass |
| Integration, installed `.vsix` | single 159 pass, 2 pending, 5 fail (the four bugs and the focus-dependent "undo" test); multi 28 pass; none 30 pass, 1 fail (QA-101); real 6 pass |
| Package | `changescope-0.3.0.vsix`, 13 files, 113 KB; the audit tests ran; isolated CLI install lists `changescope.changescope@0.3.0` |
| Open bugs | (historic, at the end of round 2) QA-101 to QA-111. **All eleven were fixed by the Host Builder and verified in round 3: see the last section of this file** |
| Not verified | Git lists in a host, VS Code 1.85, Windows, Linux, GitHub Actions, real restart persistence, the dashboard in a real webview (details in R2.9) |

Written incrementally: this section was added first and is updated as round 2 (pins, `buildDashboardState`, integration suites,
real runs, adversarial probing) proceeds. Anything not listed as run here was not run.

Machine: macOS 24.2 (arm64, Apple M3), Node v24.20.0. Nothing here touched `src/`, `media/`, `package.json` or the manifest.
The only non-test file edited was `.gitignore` (allowed).

## R1.1 Counts

| Run | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| `npm run test:unit` at the start of round 1 (before any change of mine) | 1322 | 1299 | 11 | 12 | 0 |
| `npm run test:unit` at the end of round 1 | 2262 | 2234 | 10 | 12 | 6 |

The 11 failures at the start were the 10 pins to 0.2.0 shapes (config x3, manifest x7, listed in R2 below once updated) and
`harness.test.ts` "the workspace fixture copies into real, importable TypeScript files". The harness failure is fixed:
`test/fixtures/workspace/node_modules/pkg/index.js.fixture` was swallowed by the `node_modules/` line of `.gitignore` and was not
in the repository, so it never existed. `.gitignore` now has `!test/fixtures/**/node_modules/` after the `node_modules/` line
(`git check-ignore -v` prints nothing for the file, `git add -n` accepts it) and the fixture file was created.

`todo`: six tests reproduce open bugs (QA-102 to QA-107). They are written with `{ todo: 'open: QA-nnn' }` so `node --test` reports them as
`todo` (a warning sign in the output) and does not fail the run. When the product is fixed they turn into plain passes: remove the
`todo` option then.

## R1.2 Files added (all under `test/`)

Unit (core, written from `docs/DESIGN-0.3.0.md`): `attribution`, `eventStore`, `collision`, `sessionManager`, `sessionReport`,
`storageSchema`, `depGraph`, `testMatch`, `impact`, `gitModel`, `aiProvider` (provider registry, consent gate, summary input and
`localSummary`), `agentSignal`, `timeFormat`, `dashboardProtocol`, `historyRoundTrip` (stores -> storage -> stores), `references030`
(`ReferenceTarget.kinds`, `scaleShake`, `clampAnimationIntensity`), `staticChecksDashboard` (the 0.2.0 static policy did not
scan `src/dashboard`), `performance030`. All as `test/unit/*.test.ts`.

Webview (jsdom, against `mountDashboard`): `dashboard-render`, `dashboard-interaction`, `dashboard-motion`, `dashboard-security`,
`dashboard-css`, `dashboard-fuzz` (8 seeded random walks of 160 steps with invariants after every step), `dashboard-bundle`
(executes the real `dist/dashboard.js` in a page from `buildWebviewHtml`; run `node esbuild.mjs` first, skips with a reason if
missing). All as `test/webview/dashboard-*.test.ts`.

Support: `test/support/dashState.ts` (valid `DashboardState` builders, every mock is checked with `parseDashboardHostMessage`),
`test/support/dashDom.ts` (jsdom harness with a fake `AppEnv`, fake host, event helpers), `test/support/synthetic.ts`
(deterministic synthetic workspaces), `test/perf/bench030.ts` (benchmark script).

## R1.3 Commands run (round 1)

```
npx eslint test                         # clean
npx tsc -p test/tsconfig.json --noEmit  # clean
npm run lint                            # clean (eslint . + the four tsc projects)
npm run test:unit                       # tests 2262, pass 2234, fail 10, skipped 12, todo 6
node esbuild.mjs                        # before the bundle test
node --import tsx test/perf/bench030.ts # numbers in docs/BENCHMARKS.md
```

The 10 failing tests at the end of round 1 were exactly the pins listed in the Host Builder's report (all updated in round 2).

## R1.4 Bugs (round 1)

IDs continue the table of section 3. All statuses are **open**. QA-102 to QA-107 have a reproducing test marked `todo`.

| ID | Severity | Status | Repro / test | Expected | Actual |
|---|---|---|---|---|---|
| QA-101 | medium (privacy) | fixed (round 3) | **Confirmed in real VS Code in round 2 (R2.4).** Found by reading `src/vscode/activityService.ts` (`sessionReport`) and `src/vscode/dashboardProvider.ts` (`summarize`): both build the display path as `d.dir === '' ? d.name : d.dir + '/' + d.name` from `toDisplayPath(key, roots)`. For a file outside every workspace folder `toDisplayPath` returns the ABSOLUTE folder as `dir` (probe: `/Users/frank/other/secret.ts` -> `"/Users/frank/other/secret.ts"`). Changescope tracks such files (the 0.2.0 "(outside workspace)" section). To reproduce in a host: edit a file outside the workspace folder, start a session, run "Export Session Report"; or set `ai.mode` assisted with a registered provider and press Summarize. Pinned by `dashboardModel.test.ts` ("for a file OUTSIDE every workspace folder ..."); confirmed by three integration tests (R2.4). | DESIGN-0.3.0 5: the report "uses display paths (workspace relative), never absolute paths"; section 9 and `PAYLOAD_DESCRIPTION`: the request carries "workspace-relative paths". | The report and the AI request contain the absolute path (home folder name and all) of any tracked file outside the workspace. |
| QA-102 | low | fixed (round 3) | `depGraph.test.ts` > "[QA-102] dependants() with an unbounded depth or node limit (Infinity) finds the dependants" (todo). `dependants(k, Infinity, 200)` returns nothing; `dependants(k, 3, Infinity)` returns nothing and `truncated: true`. | An unbounded limit means unbounded (or is rejected); never "nothing found" or a false "truncated". | `Number.isFinite` guards turn Infinity into 0. Not reachable today (callers pass 3 and 200). |
| QA-103 | low | fixed (round 3) | `depGraph.test.ts` > "[QA-103] ..." (todo). `setFile` with two entries for one target, `export` then `import`, keeps `export`; the other order keeps `import`. | DESIGN 7.1: `export` only when every statement is a re-export, so the result is `import` in both orders. | The first entry's type wins. Not reachable through `targetsFromReference` (targets are unique there). |
| QA-104 | low | fixed (round 3) | `dashboardProtocol.test.ts` > "[QA-104] a sparse array ..." (todo). `parseDashboardHostMessage` with `files: new Array(2)` returns a state whose `files` has holes. | Malformed messages are rejected (the app would throw on `row.id` of `undefined`). | `list()` uses `Array.prototype.map`, which skips holes, so the item validator never runs. Structured clone keeps holes, JSON turns them into `null` (rejected), so only a host bug could send one. |
| QA-105 | low (info) | fixed (round 3) | `dashboardProtocol.test.ts` > "[QA-105] ..." (todo). A message object whose `type` getter returns `ready` first and `open` second comes out as `{ type: 'open' }` with no id. | The validated type is the returned type. | `parseDashboardWebviewMessage` returns `{ type: m['type'] }`, reading the field a second time. Not reachable with data that came through `postMessage` (plain clones, no getters). |
| QA-106 | low | fixed (round 3) | `dashboardProtocol.test.ts` > "[QA-106] C1 control characters ..." (todo). `cleanTitle('a\u0085b\u0090c')` keeps U+0085 and U+0090. | "Titles cleaned of control characters": Unicode category Cc includes U+0080 to U+009F. | Only U+0000 to U+001F and U+007F are replaced. (Bidi overrides and zero-width characters, category Cf, also survive; they are shown as text only, so this is cosmetic.) |
| QA-107 | low | fixed (round 3) | `eventStore.test.ts` > "[QA-107] recent(Infinity) ..." (todo). | `recent(Infinity)` returns everything. | Returns `[]` (non-finite limit is treated as 0). Not reachable today (the callers pass 100 and 50). |
| QA-108 | low-medium (performance) | fixed (round 3) | `node --import tsx test/perf/bench030.ts`: `analyseImpact` x 50 takes about 110 ms at 10,000 files and about 230 ms at 20,000 (docs/BENCHMARKS.md). `relatedTests` scans every indexed file for every call. In Impact mode `buildDashboardState` input is built from 50 impacts on every rebuild (throttled to one per 250 ms while active). | A rebuild that stays well under the 50 ms budget of DESIGN-0.3.0 13 at the 5,000 file default cap. | About 55 ms for 50 impacts at 5,000 files (the default cap), about 110 ms at 10,000, about 230 ms at 20,000 (the maximum cap). An index of test files by stem would make each call O(1). Not yet confirmed in a real host (R2). |
| QA-109 | low (privacy) | fixed (round 3) | Found by reading `dashboardProvider.isSensitive` and `dependencyIndex`: both compile `sensitiveGlobs` with `nocase: process.platform === 'win32'`. On macOS (case-insensitive by default) a folder `Secrets/` or a file `.ENV` does not match `**/secrets/**` or `**/.env*`. | Sensitive files are skipped whatever the case on a case-insensitive file system. | Matching is case-sensitive on macOS, so those files would be read by the dependency index and listed in an AI request. Not reproduced in a host. |

Observations that are not bugs (recorded so they are not lost):

* **Contract difference, not in the Deviations list.** `EventStore.add` does not merge a new change into the newest event of a file when that event is already `reviewed` (the change starts a new `unreviewed` event). DESIGN-0.3.0 4.3 lists no such condition. It is sensible (otherwise a change made after review would be silently counted as reviewed) and the tests pin it (`eventStore.test.ts` "a change after the file was reviewed is a new event"), but the contract should say so.
* `buildDashboardState` passes `settings`, `index` and `summary.at` through unchanged, although its comment says every number is finite. Today the values come from the sanitised config, so a non-finite number cannot occur; if one did, the webview would reject the whole state and stay on "Loading activity.".
* `changescope.exportSessionReport` accepts a session id as an argument from any caller (`executeCommand`); it only reads. Fine.

## R1.5 Mutation sanity (scratch copy under the session scratchpad, never `src/`)

Each mutant is one edit of a product file, run against the tests of that module. 88 mutants in total: **87 killed at the first run, 1 survived and was killed after the test was strengthened.**
The four modules asked for:

| Module | Mutants | Result | Examples |
|---|---|---|---|
| `core/activity/attribution.ts` | 7 | 7 killed | workbench row disabled; developer re-labelling allowed; git beats agent; hint window `>=` to `>`; confidence 0.9 to 0.95; delete row without the watcher condition; prune boundary |
| `core/activity/eventStore.ts` | 10 | 10 killed | coalesce `<=` to `<`; session id ignored; developer events get a review state; retention sign flipped; trim drops the newest; changes sum counts as 1; `exists` always true; reattribute boundary; id counter ignores loaded ids; reviewed barrier removed |
| `core/intelligence/impact.ts` | 8 | 8 killed | critical `>=` to `>`; high combined `>=` to `>`; medium combined removed; `complete` ignores truncation; config no longer critical; `requirements*.txt` removed; "No dependants" condition changed; related tests dropped |
| `core/dashboard/protocol.ts` | 10 | 10 killed | unit range upper bound; empty rename title; error text not truncated; array cap; string cap; control characters; negative counts; boolean coercion; version check; title cap 121 |

Extra modules: sessions manager and report 7/7, storage schema 5/5, depGraph 6/6, testMatch 2/2 (**one survivor first**: removing the "a test file has no related tests" guard of `relatedTests`; the test only used a helper with a different stem; a case with a same-stem helper in another test folder was added and the mutant is killed), AI provider and local summary 6/6, agent signal 4/4, git model 4/4, collision 1/1, time format 1/1, dashboard app, rows, filters, format and views 17/17 (stale `seq` `<` to `<=`, `state.enabled` removed from the shake rule, focus restore removed, `intensity > 0` removed, Left key wrap, External filter, reduced-motion term, rename validation, timer clear on dispose, 5 s boundary, timeline cap, unchanged-attribute skip, External card total, `--fd-amp` not set, filter click, Inspect tab switch, `main.ts` persisted-state validation). Two further mutants of the first run were invalid (compile errors) and were replaced by valid ones.

## R1.6 Performance

Measured numbers: `docs/BENCHMARKS.md`. Guards (`test/unit/performance030.test.ts`, 11 tests) pass. One finding, QA-108 above.

## R1.7 Not run or not verified in round 1

* Integration tests (real VS Code): none in round 1 (see R2).
* Windows and Linux; VS Code 1.85; GitHub Actions workflows.
* `src/vscode/**` adapters: only read, not tested, in round 1. QA-101 and QA-109 come from reading and are not yet reproduced in a host.
* The dashboard in a real browser or real webview: only jsdom (no layout, no paint, no real CSP enforcement). The CSS is checked as text.


---

# 0.3.0 round 2 (Tester): pins, `buildDashboardState`, integration suites, real runs

Also written incrementally; each step is recorded when it is finished.

## R2.1 Pins changed (each one pins the new documented value; nothing was weakened)

After the pin updates `npm run test:unit` reports tests 2409, pass 2403, fail 0, skipped 0, todo 6. The 12 skipped tests of round 1 were
the `.vsix` audit tests; they now run because `changescope-0.3.0.vsix` exists in the repository root (rebuilt later in this round, see R2.5).

| File | Test | Old pin | New pin |
|---|---|---|---|
| `test/unit/config.test.ts` | "has exactly the documented keys" | 15 keys | 28 keys (the 13 new field names of the Host Builder's Deviations) |
| `test/unit/config.test.ts` | "unknown keys are dropped; the result has exactly the documented keys" | 15 keys | 28 keys |
| `test/unit/config.test.ts` | "valid values pass through unchanged" | 15 values | 28 values, and an assertion that the sample covers every key |
| `test/unit/config.test.ts` | added (not a change of a pin) | | 0.3.0 defaults (`viewMode` live, `aiMode` local, `agentSignals` false, ...), ranges of the four new numbers, enum fallback for three enums, `aiProvider` id rules, `sensitiveGlobs` list and copy semantics, fuzz keys |
| `test/unit/manifest.test.ts` | "identity" | version `0.2.0` | `0.3.0` |
| `test/unit/manifest.test.ts` | "npm run typecheck" | three `tsc` projects | four (adds `src/dashboard/tsconfig.json`) |
| `test/unit/manifest.test.ts` | "npm run package" | `vsce package --no-dependencies --allow-missing-repository` | `vsce package --no-dependencies` |
| `test/unit/manifest.test.ts` | "the four commands with the Changescope category" | 4 commands | exactly 20 (4 old, all still present, plus the 16 of DESIGN-0.3.0 section 12), each in the Changescope category; icons on the four view-title commands |
| `test/unit/manifest.test.ts` | "view title menu offers clear + toggle for this view only" | 2 entries | 6 entries (Explorer: clear, toggle; dashboard: pause, resume with `changescope.paused` conditions, mark all reviewed, open in editor) and the command palette entries for pause and resume |
| `test/unit/manifest.test.ts` | "exactly the documented 15 settings" | 15 | 28, with defaults equal to `DEFAULT_CONFIG`, numeric ranges, three enums with descriptions, the ten-glob `sensitiveGlobs` default, the `ai.provider` pattern equal to core's rule, privacy defaults (AI local, agent signal off), every setting at `window` scope |
| `test/unit/manifest.test.ts` | ".vscodeignore excludes everything and un-ignores exactly the shipped files" | `!media/**`, no `dashboard.js` | adds `!dist/dashboard.js` and `!media/*` (and asserts `!media/**` is absent and no screenshots line), per the Dashboard Builder's Deviation (`vsce` cannot override a matching `!` line) |
| `test/unit/manifest.test.ts` | "CHANGELOG.md exists and mentions 0.2.0" | `0.2.0` heading | `0.3.0`, `0.2.0`, `0.1.0` headings in that order |
| `test/unit/manifest.test.ts` | views, marketplace keywords, media files | | adds the Activity Bar container and `changescope.dashboard` view, keywords `dashboard`, `git`, `dependencies`, `impact`, `sessions`, and the existence of `media/dashboard.css` and `media/activity.svg` (monochrome `currentColor`) |
| `test/unit/vsix.test.ts` | file name, version, file list | `file-shake-0.2.0.vsix`, 10 files, `Version="0.2.0"` | `changescope-0.3.0.vsix`, 13 files (adds `dist/dashboard.js`, `media/dashboard.css`, `media/activity.svg`), `Version="0.3.0"`; adds a `vsce ls` cross-check, `dashboard.js` self-containment, no `url()` in the dashboard CSS, packaged dashboard files equal the repository files |
| `test/integration/suite/01-activation.test.ts` | "changescope.showDebugInfo writes the documented JSON" | `extensionVersion === '0.2.0'` | `'0.3.0'` |
| `test/README.md` | vsix row | 10-file list of 0.2.0 | 13-file list of 0.3.0 |

`grep -rn "0\.2\.0" test/` finds nothing else that pins a version (the remaining hits are comments and test names about 0.2.0 history).

## R2.2 `core/dashboard/model.ts`

`test/unit/dashboardModel.test.ts` (50 tests): caps from `DASH_LIMITS` (files 300 after ordering, timeline 100, previous sessions 50,
repositories 20, git changes 200 per list with `truncated`, dependencies 200, impacts 50, reasons 12, impact file lists 50, agents 12, strings 10,000, titles 120);
ordering (active first, then `lastAt` descending, stable); overview counts (including that the cap does not change `modifiedFiles`);
file row mapping (null fields, intensity clamp, shake scaled by `animationIntensity`, impact fields, session titles); timeline; sessions
(active split, branch, zero counts dropped, no file list sent); selection and impact mapping; git mapping; every output passes `parseDashboardHostMessage`
(a maximal input and 300 seeded random inputs with hostile strings and non-finite numbers); no absolute path outside `id` and `fileId` for files inside the
workspace; purity (deep-frozen input); `stateSignature` ignores `seq` and `now` and nothing else. Result: 50 pass.
Benchmark rows for `buildDashboardState` and `stateSignature` are in `docs/BENCHMARKS.md` (0.70 ms at 300 files and 1,000 events; guard under 50 ms).
No bug found in `model.ts` itself; QA-101 is about the callers' display function (outside-workspace files).

## R2.3 Integration baseline before any new suite (real VS Code 1.129.1, macOS)

`FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:integration` on the 0.3.0 code with the
`01-activation` version pin updated: **single 98 pass, 1 pending, 0 fail; multi 24 pass; none 23 pass; real 6 pass; all variants passed**
(35 s for single). The pending test is the existing QA-002 reproducer that skips itself on VS Code 1.129.1.

A first attempt at this run failed (single 6 fail, multi 1, real 1) with timeouts "waiting for the watcher echo", "removed only after
1,024,686 ms" and "ptyHost was unable to resolve shell environment": the laptop went to sleep in the middle of the run (the mocha
summary said "85 passing (2h)"). It was not a product failure; the rerun under `caffeinate -i` passed. Long runs below use `caffeinate -i`.

## R2.4 Bugs confirmed or found in round 2 (interim; status of every one is **open**, no product code was touched)

| ID | Severity | Status | Failing test (real VS Code 1.129.1) | Expected | Actual |
|---|---|---|---|---|---|
| QA-101 (confirmed) | medium (privacy) | fixed (round 3) | `82-activity.single` > "[QA-101] the report of a session that touched a file OUTSIDE the workspace has no absolute path either"; `84-ai-agents.single` > "[QA-101] a file outside the workspace is sent as a display path, not as an absolute path"; `65-dashboard.none` > "[QA-101] with no folder open the exported report has no absolute path". Repro: type in a file outside the workspace folder (or open no folder at all), start a session, "Changescope: Export Session Report"; or register an AI provider, set `ai.mode` assisted and press Summarize. | Workspace-relative display paths only (DESIGN-0.3.0 5 and 9). | The report and the provider request contain the absolute path, for example `/private/tmp/fs-aTHLaC/outside/o1.ts` (a home folder name on a real machine). With NO folder open every path is absolute, so every report and every request carries absolute paths. |
| QA-110 | low | fixed (round 3) | `84-ai-agents.single` > "[QA-110] a signal file that is emptied and refilled with a LONGER line than before is still read from the start". Repro: let Changescope read a line from `agent-events.jsonl`, then replace the file by one longer line in one go. | The new line is read (the file was emptied: DESIGN-0.3.0 9 says the file is read from the last offset and may be truncated). | Timed out after 30 s: `SignalFileAdapter.read` only detects an emptied file when `size < offset`; a refill that is as long as or longer than what was read leaves the stored offset inside the new line, so the line is decoded from the middle and skipped. (A refill that is SHORTER works: the sibling test passes.) |
| QA-111 | medium-low | fixed (round 3) | `83-intelligence.single` > "[QA-111] a file that is deleted and created again (a tool replacing it) keeps its importers in the index". Repro: build the index, delete `lib/util.ts` (imported by 4 files), create it again with the same content, select it in the dashboard. | `importedBy` still lists the 4 importers: their text did not change. | `importedBy` is empty and impact says "No dependants were found." (a low estimate, not an error message). `DependencyIndex.onFileDeleted` calls `graph.removeUnder(key)`, which drops every edge pointing at the file, and the re-creation only re-analyses the file itself, never its importers. Atomic replace (`git checkout`, `sed -i`, some formatters) deletes and creates a file. |

## R2.5 Integration suites added (real VS Code 1.129.1; mocha `tdd`; no fixed sleeps; fake clock through `api.testing`)

79 new tests: single 67, multi 4, none 8. Names and what each file covers:

| File | Variant | Covers |
|---|---|---|
| `81-dashboard.single` | single | manifest contributions reached VS Code (Activity Bar container, view, 20 commands, 28 settings and their defaults); API and test seams present; the Activity Bar view loads `dist/dashboard.js` and posts `ready`, then a state; a visible dashboard is posted a new state after an edit (throttled on the injected scheduler) and nothing when idle; the host-built state is valid for the protocol; valid messages (`setMode`, `setAnimate`, `setPaused`) act; 16 kinds of malformed message are ignored; messages naming ids that are not in the state (`open`, `openDiff`, `select`, `markReviewed`, `sessionRename`, `sessionExport`, six ghost ids) do nothing; the editor panel opens once and closing it leaves no timer; compact mode and `animationIntensity` reach the Explorer snapshot (speed never scaled); zero pending timers when idle |
| `82-activity.single` | single | Developer attribution (method `focused-editor-edit`, 0.9) and External (`disk-write`, 0.7, unreviewed); coalescing and the 5 s gap; create and delete events (`disk-delete`); review state and `markAllReviewed`; pause and resume (reason `paused` logged, rows stay, a storm of 12 toggles with an edit between each); sessions (start, collect, rename with cleaning, stop, default title, second start completes the first); the exported report (relative paths, no absolute path, no file content); a session started during an external flood stays consistent; renaming a file and a folder with history and an open session; persistence through the Memento (schema 1, reload, a running session comes back completed, debounce of one write per burst, `history.persist` off and on, `clearHistory` confirmation both ways, `maxEvents` applied live keeping the newest, retention pruning) |
| `83-intelligence.single` | single | the index does not start by itself (state `idle`, no timers); once built: reverse edges, `import` relationship, test flag, impact level, reasons, related tests, config file critical, sensitive and `node_modules` files not read; incremental updates (an edit that drops an import, a delete, a new importer) after the 500 ms debounce; `dependencies.index` off; collision warning (once, names the file, two actions, buffer untouched, 30 s quiet period on the fake clock, no warning when clean, for a delete, or with the setting off, "Compare with Saved" opens a diff); sensitive files listed by name only; Git states (`unavailable` with the standard launch, `disabled` by the setting), plus a Git-lists test that **skips itself with a printed reason** (see R2.8) |
| `84-ai-agents.single` | single | local mode never calls a provider or asks; assisted without a provider or with an empty provider setting is local; consent asked once, naming the provider and what is sent; declining remembered and reset by the command; dismissing asks again; a provider that throws, rejects, answers empty or answers a non-string falls back to local; a provider that never answers is abandoned after 30 s (fake clock); disposing a handle; an invalid provider is refused; the request carries no sensitive file, no absolute workspace path, no content, only `path`, `source`, `changes`, `eventType`; agent signal file (off by default, turned on, line before and after the change, malformed, oversized and partial lines, emptied file, 1 MB self-truncation, turned off, hook command copied); `reportAgentActivity` (label, cleaning, never re-labels developer typing, outside the 3 s window, invalid input, outside-workspace files) |
| `55-dashboard.multi` | multi | display folders lead with the root name, equal file names in two roots are two rows, report and assisted request use `alpha/...` and `beta/...`, the index follows an import from one root into the other |
| `65-dashboard.none` | none | valid state without a folder, the view loads, opaque workspace id, agent signal adapter `unavailable` with a reason and the hook command does not fail, the index with nothing to index, sessions, pause and history without a folder, zero timers |
| `helpers030.ts` | | support only |

## R2.6 Commands run and results (round 2)

```
npm run lint                                                    # exit 0
npm run test:unit                                               # tests 2409, pass 2403, fail 0, skipped 0, todo 6
node esbuild.mjs --production && npm run package                # changescope-0.3.0.vsix, 13 files, 113.03 KB
npm run test:unit                                               # again, with the vsix present: same counts; the .vsix audit tests RAN (skipped 0)
FS_VSCODE_EXE=".../Electron" npm run test:integration           # (below)
FS_INSTALLED_VSIX=$PWD/changescope-0.3.0.vsix FS_VSCODE_EXE=".../Electron" node --import tsx test/integration/runTest.ts
env <scrubbed> ".../bin/code" --user-data-dir <tmp>/ud --extensions-dir <tmp>/ext --install-extension changescope-0.3.0.vsix   # "successfully installed"
env <scrubbed> ".../bin/code" ... --list-extensions --show-versions    # changescope.changescope@0.3.0
```

Integration, dev build, standard launch (`--disable-extensions`), one full run (all variants): single 158 pass / 2 pending / 6 fail; multi 28 pass; none 30 pass / 1 fail; real 6 pass.
The 6 single failures were the four open bugs below (QA-101 twice, QA-110, QA-111), one test-side mistake of mine (the collision counter is cumulative over the launch; fixed) and the existing "undo is classified as you" test.
After the fix, the single variant alone: **160 pass, 2 pending, 4 fail** (exactly the four open bugs); pending = the QA-002 reproducer and the Git-lists test.
Installed-`.vsix` run (the packaged production bundle installed into an isolated extensions dir, built-in extensions NOT disabled): single 159 pass / 2 pending / 5 fail (the four bugs plus the undo test again), multi 28 pass, none 30 pass / 1 fail (QA-101), real 6 pass.

* **"undo is classified as you (undo-redo), never as a reload"** (existing 0.2.0 test, `10-editing.single`) failed in 2 of the 3 full single runs and in the installed run ("no undo-redo event after 4 attempts"), and passed in the baseline run, in the last single run and when run alone. BUILD_STATUS already records that it depends on desktop focus. Not a 0.3.0 failure; I did not find its cause.
* The `none` variant failure is `[QA-101] with no folder open the exported report has no absolute path`.
* The Host Builder's final one-line change to the pause gate in `EditWatcher.accept` is covered: the pause suite (including the 12-toggle storm) passes.

## R2.7 Mutation sanity, final tally

Round 1 (88 mutants, 87 killed first time, 1 killed after strengthening) plus round 2: **`core/dashboard/model.ts` 15 of 15 killed** (ordering terms removed, files and timeline caps removed, `modifiedFiles` from the capped list, commit not shortened, truncation flag, `stateSignature` including `now`, idle files keeping intensity, `animationIntensity` ignored, branch from start only, `isTestFile` without roots, reasons cap, impacts order, `activeSessions` counting all sessions). Total 103 mutants, all killed (one after a test was strengthened).

## R2.8 Adversarial probing (task 5)

| Case | How | Result |
|---|---|---|
| rapid events while pause is toggled | 12 rounds of pause, edit, resume, edit | passes: exactly the running edits are recorded, every paused edit is logged |
| session started during a flood | 80 files created by another process, `sessionStart` after the first flood event | passes: `activityCount`, per-source counts and files equal what the events with that session id say; one active session |
| corrupt stored history | **not possible through the extension API** (the Memento belongs to the extension; `testing.storedHistory()` is read only) | covered at unit level only: `storageSchema.test.ts` (every field kind, 3,000 fuzz inputs, never throws) and `historyRoundTrip.test.ts`; not exercised in a host |
| rename of a file with history and an open session | `WorkspaceEdit.renameFile` on a file and on a folder | passes: events and session entry move to the new name, no create or delete is invented, typing continues the same history |
| huge number of Git changes | 330 untracked files in a repository | **not run**: the Git extension is not usable in this host (R2.9). The cap of 200 per list with `truncated` is covered by `gitModel.test.ts` and `dashboardModel.test.ts` |
| agent signal file truncated mid-run | emptied then refilled shorter (works) and longer (fails) | **QA-110** |
| `reportAgentActivity` outside the workspace | `/etc/passwd`, `/`, a `file:` URI, 400 further paths, an outside file | passes: no throw, no event for `/etc/passwd`, at most 200 files used, the outside file is labelled when it changes through VS Code |
| sensitive file names in the timeline | `.env`, `secrets/token.txt`, `cert.pem` changed externally | by design they are listed by name; no file content appears in the state; they are never read by the index and never in a request |
| dashboard messages naming ids no longer in the state | six ghost ids times six message types | passes: nothing opened, selected, reviewed, renamed or exported |
| deleted and re-created file | index built, file deleted then created again | **QA-111** |
| session report and AI request for files outside the workspace | see QA-101 | **QA-101 confirmed** |
| a multi-byte character split across two appends of the signal file | read by code only | `SignalFileAdapter.read` decodes from a byte offset, so a character split across two reads decodes as U+FFFD and the line is skipped. Not reproduced (a hook normally appends a whole line); recorded here, not filed |

## R2.9 Not run or not verified (stated plainly)

* **Git lists were not verified in a real host.** The test `83-intelligence.single` > "with Git available ..." ran but **skipped itself** in every launch, including the installed-`.vsix` launch that does not pass `--disable-extensions`, with the printed reason: `the repository did not appear (Changescope reports: unavailable, "The Git extension is disabled or its API is not available.")`. The standard launch sets `git.enabled` to false and starts with `--disable-extensions`; I set `git.enabled` true at run time and called `git.openRepository`, but the built-in Git extension did not offer its API here (the machine has git 2.15.0, which may be too old for it; I did not establish the cause). What is verified: Changescope degrades to `unavailable` with the reason, `disabled` by its own setting, sessions work without a Git context. What is not: branch and commit display, staged / changes / untracked lists, the 200 cap, and the head-change relabelling to "Git" (the Host Builder's report says its scratch smoke test saw them; there is no permanent test that ran).
* **VS Code 1.85 (the engine floor)** was not run: no 1.85 binary is cached under `.vscode-test/` (the directory does not exist) and I did not download one. Everything ran on VS Code 1.129.1.
* **Windows and Linux** were not run. **GitHub Actions** (`.github/workflows/ci.yml`, `release.yml`) never ran.
* **Real restart persistence** was not verified: the Memento of an extension-test host is in memory, so only `flushHistory` / `reloadHistory` (a write and a read back inside one session) were tested. That the stored value survives a real window close was not tested.
* **The dashboard in a real webview**: jsdom only (and the real `dist/dashboard.js` in jsdom). The `ready` handshake and the state flow were observed in real VS Code through counters, but no one looked at the rendered page, themes, high contrast, or real CSP enforcement.
* **Corrupt stored history** in a host (R2.8). **Activation time** in a host: not measured.
* Large workspaces: the dependency index was exercised on small workspaces only; its cost on a real 5,000 file workspace is not measured (BENCHMARKS uses in-memory graphs).


---

# 0.3.0 round 3 (Tester): the Host Builder's fixes for QA-101 to QA-111, verified

Written incrementally. Numbers below are copied from the command output; anything not listed as run was not run.

## R3.0 Summary

| | |
|---|---|
| QA-101 to QA-111 | **all eleven `fixed`**, each with the tests that prove it (R3.2). No `todo` option is left in `test/` (the unit run reports `todo 0`). No new product bug was found |
| Unit and webview (`npm run test:unit`), after the fixes and with the packaged `.vsix` present, three runs in a row | **tests 2501, pass 2501, fail 0, skipped 0, todo 0**, three times (88.8 s, 97.1 s, 87.5 s) |
| Unit, a fourth run after my last edits, on the recovered machine | tests 2501, pass 2501, fail 0, skipped 0, todo 0, **15.1 s** (the three earlier runs took 88 to 97 s on the degraded machine, R3.7) |
| Unit, the three runs before the pathological-test change (R3.5) | tests 2498, pass 2497, **fail 1** each time: always the same test, a wall-clock guard (R3.5) |
| Lint and typecheck of all four projects (`npm run lint`) | exit 0 |
| Integration, standard launch, final full run (VS Code kept in front, machine recovered) | **single 169 pass, 2 pending, 0 fail; multi 28 pass; none 31 pass (QA-101 passes); real 6 pass; all four variants passed** |
| Integration, earlier full runs in round 3 | run 1: single 161 / 2 pending / 7 fail (4 were my fixture mistake, 3 are timing and focus, R3.6); run 2: single 166 / 2 pending / 3 fail (focus and two timing tests while the machine was swapping, R3.7). multi, none, real passed in both |
| Installed `.vsix` (production bundle, built-in extensions not disabled) | final run **single 169 pass, 2 pending, 0 fail; multi 28; none 31; real 6**; an earlier run during the swap storm took 42 minutes and failed 4 timing and focus tests (R3.7). The Git-lists test skipped itself again (R3.9) |
| Isolated CLI install | `Extension 'changescope-0.3.0.vsix' was successfully installed.`; `--list-extensions --show-versions` prints `changescope.changescope@0.3.0` |
| "undo is classified as you" with the test VS Code brought to the front | **passes** (alone, and in the full runs held in front); fails without focus (R3.8) |
| Mutation sanity of the new code | 36 mutants of the round 3 code: **32 killed, 4 equivalent** (explained); 2 survivors showed real test gaps and got new tests (R3.4) |
| Not verified | Git lists in a real host, the dashboard in a real webview, Windows, Linux, GitHub Actions, VS Code 1.85, real restart persistence (R3.9) |

## R3.1 Files changed in round 3 (all under `test/`, plus `docs/`)

* Edited tests: `test/unit/depGraph.test.ts`, `dashboardProtocol.test.ts`, `eventStore.test.ts`, `dashboardModel.test.ts` (QA tests no longer `todo`; clamping tests for numbers that pass through `buildDashboardState`; the outside-workspace test retitled), `performance030.test.ts`, `performance.test.ts`, `tree.test.ts`, `test/webview/render.test.ts` (wall-clock guards use `scaled(...)`), `test/integration/suite/83-intelligence.single.test.ts` and `84-ai-agents.single.test.ts` (sensitive-file tests), `test/perf/bench030.ts` (rows with and without the prebuilt `testIndex`), `test/support/pathologicalRunner.ts` (reports CPU time too), `test/README.md`.
* New tests: `test/unit/safeDisplayPath.test.ts` (22), `signalChunker.test.ts` (34), `testIndex.test.ts` (13), `perfGuard.test.ts` (5); new helper `test/support/perfGuard.ts`.
* Docs: `docs/BENCHMARKS.md` (regenerated, with the date and the "before the fix" column), this file.
* Not touched: `src/`, `media/`, `package.json`, the manifest, `.gitignore`.

## R3.2 Status of every item, with the tests that prove it

| ID | Status | Fix (Host Builder) | Proving tests (all pass) |
|---|---|---|---|
| QA-101 | **fixed** | `toSafeDisplayPath` in `core/pathUtils.ts` is the display path of session reports and AI requests: inside a folder it is relative (with the folder name when more than one folder is open); anywhere else it is `(outside workspace)/<file name>` and nothing but `(outside workspace)` when the name is empty | `safeDisplayPath.test.ts` (22 tests): one folder, several, nested, sibling with a shared prefix, outside, no folder, the folder itself, empty name, Windows drive and UNC keys, hostile names, dot segments, a property test over 3,000 random keys and folder sets (never an absolute prefix, exactly one separator after `(outside workspace)`), and end to end: `buildSessionReport` in Markdown and JSON and `buildSummaryInput` plus `localSummary` for no folder, one folder and two folders contain no path separator before the file name beyond `(outside workspace)/` (leak strings `/Users/frank/other`, `/home/dev`, `server/share`, `/private/tmp`); one test proves the OLD function would have leaked (so the tests can fail). Integration (real VS Code): `82-activity.single` `[QA-101]`, `84-ai-agents.single` `[QA-101]`, `65-dashboard.none` `[QA-101]` all pass; `55-dashboard.multi` passes. The sidebar state still keeps the absolute folder of an outside file on purpose (it goes only to the local webview, as in 0.2.0): `dashboardModel.test.ts` pins that |
| QA-102 | **fixed** | `dependants(k, Infinity, ...)` and `(k, 3, Infinity)` mean unbounded | `depGraph.test.ts` `[QA-102]` x 3: both limits unbounded, a 60-node chain and cycles terminate, NaN, negative and non-numeric limits still mean none |
| QA-103 | **fixed** | duplicate edges resolve by the precedence `import > reference > inheritance > export > unknown` | `depGraph.test.ts` `[QA-103]` x 3: order independence for every ordered pair, the full precedence matrix, a default (untyped) edge counts as `import`, three duplicates resolve like two |
| QA-104 | **fixed** | sparse arrays are rejected | `dashboardProtocol.test.ts` `[QA-104]`: 16 list paths, each with holes made by `new Array(n)`, by deleted elements and by mixed holes, are rejected; the honest lists are accepted |
| QA-105 | **fixed** | the message type is read once | `[QA-105]`: a getter that changes its answer is called exactly once (`calls === 1`) for several message types |
| QA-106 | **fixed** | `cleanTitle` strips U+0080 to U+009F | `[QA-106]`: every code point U+0080 to U+009F and U+00A0 is replaced, and a rename made only of C1 controls is `null` |
| QA-107 | **fixed** | `recent(Infinity)` returns everything | `eventStore.test.ts` `[QA-107]`: Infinity gives all events newest first; NaN, -Infinity and non-numbers still give none |
| QA-108 | **fixed** | `buildTestIndex` / `relatedTestsIn` / optional `testIndex` of `analyseImpact`; `DependencyIndex` keeps one index per set of indexed paths | `testIndex.test.ts` (13): an independent reference implementation agrees with `relatedTestsIn` on 4,000 random lookups (more than 300 of them non-empty) with and without roots; `analyseImpact` with and without the index is identical for 150 files at two root settings on a 2,000 file workspace. `performance030.test.ts`: `buildTestIndex` at 10,000 files < 250 ms, and a new guard of 50 lookups with the index < 100 ms. Measured (`docs/BENCHMARKS.md`): **50 lookups at 10,000 files: 111 ms before, 4.08 ms now** (2,000 files: 24.6 to 5.77 ms; 20,000 files: 226 to 5.17 ms); the cost no longer grows with the file count. I read `dependencyIndex.ts`: every change of the indexed paths calls `pathsChanged()`, which drops the cached index, and `impactFor` passes it. Not timed in a real host |
| QA-109 | **fixed** | `sensitiveGlobs` always match case-insensitively and `ReferenceService` skips sensitive files too | integration `83-intelligence.single`: "a source file that matches sensitiveGlobs is listed by name but its imports are never read" (a normal file importing the same target does make it yellow), "the match ignores case" (`SECRETS/`, `.ENV`), "the dependency index matches sensitiveGlobs in any case too" (an importer in `SECRETS/` is not listed as an importer), "changing sensitiveGlobs re-analyses"; `84-ai-agents.single` `[QA-109]` (`Secrets/`, `.ENV`, `CERT.PEM`, `ID_RSA` are not sent, the request has exactly one file). All pass |
| QA-110 | **fixed** | `SignalFileAdapter` detects a refilled file by the 64 bytes before the offset (`signalTail`, `signalPrefixKept`) and reads bytes through `SignalChunker` | `signalChunker.test.ts` (34): a line with 2-, 3- and 4-byte characters cut at every byte and at every pair of offsets, one byte at a time, the old text decoder would lose it (shown), partial tail kept, CRLF, junk and invalid UTF-8, `reset`, the 500 record cap, oversize rules (including a valid line that is over 4,096 bytes but under 4,096 characters), a 600 round fuzz against `parseSignalChunk`; `signalTail` and `signalPrefixKept` (append, shorter, longer, same length, limits, a shrunk file with an empty tail). Integration `84` `[QA-110]` (refill with a longer line) passes. Documented limit, pinned by a test: a replacement that keeps the same last 64 bytes is taken for an append |
| QA-111 | **fixed** | `DependencyIndex` remembers the importers of a deleted path and re-analyses them when it is created again; `DepGraph.importersUnder` | `depGraph.test.ts` `DepGraph.importersUnder` (7): keyed importers sorted, prefix semantics, never-analysed targets, cap 500 and `maxFiles`, copy semantics, delete and recreate round trip, a folder. Integration `83` `[QA-111]` passes |

Every `[QA-nnn]` integration test that was red in round 2 is green now: QA-101 in single, none (and multi has no such test); QA-110; QA-111.

## R3.3 Commands run (round 3), exact

```
npx tsc -p test/tsconfig.json --noEmit ; npx eslint test         # clean
npm run lint                                                     # exit 0
npm run test:unit                                                # x3, before the pathological-test change: tests 2498, pass 2497, fail 1, skipped 0, todo 0 (each time)
node esbuild.mjs --production ; npm run package                  # changescope-0.3.0.vsix, 13 files, 114.68 KB
npm run test:unit                                                # x3, vsix present: tests 2501, pass 2501, fail 0, skipped 0, todo 0 (each time)
FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" caffeinate -i npm run test:integration   # twice (below)
node --import tsx test/perf/bench030.ts                          # three passes -> docs/BENCHMARKS.md
python3 <scratch>/mutate3.py                                     # mutation sanity in a scratch copy, never src/
```

## R3.4 Mutation sanity of the round 3 code (scratch copy under the session scratchpad)

36 single-edit mutants run against the tests of their module (32 killed, 4 equivalent):

| Module | Mutants | Result |
|---|---|---|
| `toSafeDisplayPath` | 5 (outside returns the key; folder prefix dropped; shortest folder wins; empty name; the folder itself counted as inside) | 5 killed (two survived the first run only because my script replaced the same text in `toDisplayPath`, which comes first in the file; replaced in the right function, both killed) |
| `SignalChunker` | 5 (decode the wrong bytes; unfinished line not kept; byte cap per character; `reset`; skipped count) | 5 killed; **one survived the first run** (the cap `LINE * 4` changed to `LINE`: no test had a valid line over 4,096 bytes but under 4,096 characters), a test was added and the mutant is killed |
| `signalTail`, `signalPrefixKept` | 5 | 5 killed; **one survived the first run** (an offset beyond the data with an empty tail), a test was added and the mutant is killed |
| `DepGraph.importersUnder` | 4 | 3 killed; 1 equivalent (`prefix === ''` guard: `isUnder('', x)` is already false for every key) |
| `buildTestIndex`, `relatedTestsIn`, `analyseImpact` index use | 5 | 4 killed; 1 equivalent (dropping `candidate.key !== key`: a key in its own bucket is a test file and `relatedTestsIn` returns before the loop). Ignoring `testIndex` in `analyseImpact` is killed by `testIndex.test.ts` and by the new 100 ms guard |
| QA-102 to QA-107, model clamps | 11 (precedence table and rule, `Infinity` limit, non-finite limit, `recent` x 2, C1 range, hole check, sparse arrays through the old `.map`, `nat`, `finite`) | 9 killed; 2 equivalent: `recent(Infinity)` without the special case (`slice(0, Infinity)` already returns everything) and removing only the explicit hole check (every item validator rejects `undefined` today); the old `.map` form of `list()` is killed |
| The pathological-input guard | 1 (1.3 s of CPU burned in one combination) | killed: `go/open-parens: 1349 ms of CPU` |

## R3.5 The flaky unit failure, identified

In each of the three runs of `npm run test:unit` after the first round 3 edits, **exactly one** test failed, and always the same one:
`performance: pathological inputs (500 KB, hard timeout, child process)` > "no language x pattern combination takes more than 1000 ms, throws, or hangs"
(a 0.2.0 test). Different combinations were over the limit each time (`python/rust-lifetimes` 2,564 ms; `js/go-grouped-open` 2,762 ms, `python/quote-soup` 2,758 ms, `python/single-quote-soup` 3,391 ms).
Cause: it timed wall-clock time in a child process while `node --test` ran the other test files in parallel (load average 18 to 35). Measured alone on the recovered machine, the 512 combinations take
a **median of 7 ms and a maximum of 194 ms of CPU** (`css/css-import-open`; an earlier measurement on the degraded machine gave a median of 17 ms and a maximum of 538 ms), against the guard of 1,000 ms; on the degraded machine the same work
needed about 200 ms of CPU and showed 2.5 to 3.4 s on the wall clock. It is not a regression of the product.
Fix (test side): the runner now records CPU time and the test guards on **CPU time** (1,000 ms per combination, unchanged); a combination that stalls for 30 s of wall time, or a runner that does not finish in 200 s, still fails.
Before the `scaled` helper existed, three earlier runs failed 2 to 3 guards each (dashboard first render of 300 rows 6.7 s against 500 ms, a 500-row tree, full `analyzeReferences`, this pathological test) at load averages of 17 to 44. After the changes the unit suite passed three times in a row (R3.0). The other wall-clock guards that failed under load earlier in round 3, with measured values and guards, are listed in `docs/BENCHMARKS.md` ("Wall-clock guards and machine load"); they now go through `scaled(ms)` in `test/support/perfGuard.ts`
(the guard is relaxed by how much slower the machine is than an idle one, at most 30 times, and is exactly the documented value on an idle machine). This is load compensation, not a weaker threshold, and I list it here because it touches 0.2.0 tests.

## R3.6 Integration runs (real VS Code 1.129.1)

Run 1 (before I fixed a mistake of mine in `83`): single 161 pass, 2 pending, 7 fail; multi 28 pass; none 31 pass; real 6 pass. The seven:

| # | Test | Cause |
|---|---|---|
| 4 to 7 | four tests of `83-intelligence.single` ("the index does not start by itself", "once built", "kept current", `[QA-111]`) | **my test mistake**: I added `Secrets/keys2.ts` to the shared project next to `secrets/keys.ts`; on a case-insensitive file system (macOS) that is the same folder, and the watcher reported the file under the other spelling, so `createSettled` timed out after 60 s. Fixed: the file is gone from the shared project and a separate project (`sens-index-case`) covers the index with `SECRETS/` |
| 2 | "undo is classified as you" | see R3.8 |
| 1 | `10-editing.single` "idle: the row goes idle at exactly idleTimeoutMs": `'idle' !== 'active'` "1 ms before the boundary" | **not reproduced**: it passed in run 2, in the final runs and in a re-run alone, and in every earlier run. It drives the fake clock, but it starts from `settleRefs`, which waits for real asynchronous reference analysis; the machine was degraded at that time (R3.7). I did not establish the cause; listed as a load-sensitive test that failed once |
| 3 | `80-performance.single` "typing in a 400 KB TypeScript file": 28.2 ms per edit against the budget of 25 ms | machine state (R3.7) |

Run 2 (after the fix): **single 166 pass, 2 pending, 3 fail; multi 28 pass; none 31 pass; real 6 pass.** The three single failures: "undo is classified as you" (R3.8); `80-performance.single` "200 rapid edits: extension overhead per edit <= 2 ms": **2.014 ms** against 2 ms; "typing in a 400 KB TypeScript file": **37.4 ms per edit** against 25 ms.
The two pending tests are the QA-002 reproducer (skips itself on VS Code 1.129.1) and the Git-lists test (R3.9).

## R3.7 The timing failures and the state of the machine

Several 0.2.0 wall-clock tests failed in round 3 and passed again when the machine recovered. They passed in every earlier run (for example "overhead 0.057 to 0.153 ms per edit; 400 KB file 4.0 to 8.2 ms per edit").
The evidence that the machine, not the product, was slow:

* The cost of a plain edit with Changescope **disabled** (a baseline the extension does not influence) rose from 0.46 to 0.66 ms to **6.9 to 11.9 ms per edit** (`PERF disabled` lines: run 1 9.698 ms, run 2 7.822 ms, a run alone 6.861 ms, the installed run 11.879 ms), 10 to 20 times slower.
* `pmset -g batt` showed the laptop **on battery at 1 percent, final warning**; `vm.swapusage` showed 22.4 of 23.5 GB in use with 81 MB free; the load average reached **442**; the installed-`.vsix` single run took **42 minutes** instead of 2.
* After the charger was connected and the load fell, the same tests passed: a re-run alone of `10-editing` "idle", `Adversarial probes` "autosave: the save and its watcher echo are not activity" and the three `80-performance` tests gave **5 passing** (`PERF disabled 1.221 ms/edit, overhead 0.150 ms/edit; 400 KB file 7.16 ms/edit`), and the final full runs passed completely (`PERF disabled 0.966 ms/edit, overhead 0.215 ms/edit, 400 KB 10.52 ms/edit` standard; `0.626 / 0.169 / 8.51` installed).

The tests that failed while the machine was degraded: `80-performance.single` "200 rapid edits: extension overhead per edit <= 2 ms" (2.014 ms in run 2, 3.327 ms in the installed run), "typing in a 400 KB TypeScript file" (28.2, 37.4, 45.8 ms against 25 ms), `10-editing.single` "idle ..." once, `Adversarial probes` "autosave: the save and its watcher echo are not activity" once in the installed run (`autosave must not add activity: 2 !== 1`; passes alone and in the final runs). I did not change any of their thresholds.
The `0.2.0` perf budgets are absolute and unscaled in the integration suites (`scaled()` is used by the unit guards only); on a healthy machine the margin is about 2.4 times for the 400 KB file (10.5 ms against 25 ms) and about 9 times for the overhead (0.215 ms against 2 ms).

## R3.8 "undo is classified as you (undo-redo), never as a reload" and window focus

The test (`10-editing.single`, 0.2.0) failed in run 1 ("no undo-redo event after 4 attempts"), run 2 (the same) and the installed run (a 60 s timeout) of round 3, and in 2 of the 3 full single runs of round 2, and passed when run alone.
**With the test VS Code brought to the front it passes:** I ran it alone while a loop (`osascript`, `System Events`, `frontmost` of the test's Electron process) kept the window in front: `✔ undo is classified as you (undo-redo), never as a reload (203ms)`, 1 passing (the machine was still degraded at that moment, load average 56). The two later full runs (standard and installed) were also run with the window held in front and passed it. So it is a focus dependency of the test environment, not a regression (`docs/BUILD_STATUS.md` already records that this test depends on desktop focus; I did not inspect the mechanism): the product behaves as the test expects whenever the window has focus. One passing run with focus, plus two full runs, is thin evidence for the negative; it is not proof. The test is neither skipped nor weakened. The failures above (three of the four full single runs of round 3 without the window in front) are the evidence that without focus it fails.

## R3.9 Not run or not verified (stated plainly)

* **Git lists in a real host with focus**: not verified. The Git-lists test (`83-intelligence.single`) skipped itself again in the standard launch (`vscode.git` is not loaded because of `--disable-extensions`) and in the installed-`.vsix` launch, with the printed reason `the repository did not appear (Changescope reports: unavailable, "The Git extension is disabled or its API is not available.")`. That leaves branch and commit display, the staged / changes / untracked lists, the 200 cap and the "Git" relabelling of a branch switch covered by `gitModel.test.ts` and `dashboardModel.test.ts` only. This is the largest remaining hole in what has been verified in a host.
* **The rendered dashboard in a real webview**: jsdom and the real `dist/dashboard.js` in jsdom only; the `ready` and state flow were observed in VS Code through counters. Nobody looked at the page, themes, high contrast or the real CSP.
* **Windows and Linux**: not run (macOS only). `toSafeDisplayPath` is covered with Windows-style keys at unit level only.
* **GitHub Actions** (`.github/workflows/ci.yml`, `release.yml`): never ran.
* **VS Code 1.85 (the engine floor)**: not run, no 1.85 binary is cached (`.vscode-test/` does not exist) and I did not download one. Everything ran on VS Code 1.129.1.
* **Real restart persistence**: only `flushHistory` / `reloadHistory` inside one session were exercised; that the stored value survives a real window close was not tested.
* **QA-108 in a real host**: the host passes the shared `TestIndex` (read from `dependencyIndex.ts`) but the cost of `impactFor` was not timed in a host; BENCHMARKS uses in-memory graphs. Large real workspaces were not tried.
* **Idle-machine wall-clock margins of the integration performance tests** were measured once on the recovered machine (R3.7), not repeatedly.
* **The pending QA-002 reproducer** still skips itself on VS Code 1.129.1.

## R3.10 New bugs, and observations that are not bugs

* **No new product bug was found in round 3.** I tried to break the fixes with: a 3,000 case property test and a no-leak test for `toSafeDisplayPath`; a hard line (2-, 3- and 4-byte characters) cut at every byte and every pair of offsets, plus a 600 round fuzz against the text parser, for `SignalChunker`; a 4,000 lookup equivalence fuzz and a 150 file by two root settings equality test for the test index; sparse arrays at 16 list paths; a getter that changes its answer; every code point of the C1 range; and a 300 round clamping property for numbers that pass through `buildDashboardState`.
* **Observation, by design:** `analyseImpact` called without a `testIndex` now builds an index on every call, which is slower than the 0.2.0 scan (about 170 ms for 50 calls at 10,000 files against 111 ms). The host always passes one; any new caller must too. The new 100 ms guard and `testIndex.test.ts` pin that.
* **Documented limit (not a bug, pinned by a test):** a signal file that is replaced by different content whose last 64 bytes before the old offset are identical (for example the same line written again) is taken for an append, so the replacement is read from the old offset. Hooks that rewrite an identical file lose nothing real, but the contract should say it.
* **Two mistakes of mine, both fixed in `test/`:** (1) the shared `83` project held `secrets/keys.ts` and `Secrets/keys2.ts`, which are one folder on a case-insensitive file system, so four tests timed out waiting for a watcher event under the other spelling; the QA-109 index test now has its own project. (2) My first pathological-test fix scaled a wall-clock budget by a load factor measured after the child had run, which was not reliable; it now uses CPU time.
* **Test-environment finding:** the load compensation (`scaled`) and the CPU-time guard exist because wall-clock guards fail on a busy or swapping machine. If CI runners are slow or shared, the unit guards will adapt, but the integration performance budgets (R3.7) are absolute and may flake there.
