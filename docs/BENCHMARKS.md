# File Shake 0.3.0 benchmarks

Measured by the Tester with `test/perf/bench030.ts`. These are measurements on one machine, not certificates: the thresholds in
`docs/DESIGN-0.3.0.md` section 13 are regression guards (`test/unit/performance030.test.ts`), not promises.

**Updated 2026-11-14 (round 3), after the Host Builder's QA-108 fix.** The first version of this file (round 2, earlier the same day)
measured `analyseImpact` BEFORE the fix, when every call scanned every indexed file. Those numbers are kept in the "Round 2" column so the
change can be read off; they are not current.

## Environment

| | |
|---|---|
| Date | 2026-11-14, three passes at 19:22:46, 19:23:03 and 19:23:19 UTC (round 3). The "Round 2" column is the pass of 2026-11-14 17:10 UTC, before the fix |
| Machine | darwin 24.2.0 arm64; Apple M3 (8 logical); 16 GiB |
| Node | v24.20.0 |
| Method | each case builds a fresh input, 2 warm-up rounds, then 7 timed rounds; median, min and max of the timed rounds. Inputs are deterministic (fixed seeds, see `test/support/synthetic.ts`); only timings vary. Wall clock via `performance.now()`. The table shows, per row, the middle one of the three passes (the median of the three medians); the three passes agree within 5 percent except where noted below. |
| Machine state | load average 2.7 to 3.0 during the passes, the charger connected (battery 13 percent and charging), VS Code with the coding assistant and a browser open. Not as empty as in round 2 (no VS Code then) but the unchanged rows agree with round 2 within noise (`DepGraph.dependants` x 1,000 at 10,000 files 13.7 ms against 12.8 ms, `storage serialise` 0.12 ms against 0.118 ms, jsdom first render 50 ms against 52 ms). |
| **A discarded earlier attempt** | I first measured at 18:01 to 18:06 UTC, while the laptop was on battery at 1 to 3 percent with 22 GB of swap in use. Unchanged code was 2 to 3 times slower than in round 2 (for example `storage serialise` 0.32 ms, jsdom first render 147 ms). Those numbers describe the machine, not the code, and are not used anywhere in this file. |

## Commands

```
node --import tsx test/perf/bench030.ts            # table plus JSON on the last line
node --import tsx test/perf/bench030.ts --json     # JSON only
node --import tsx --test test/unit/performance030.test.ts   # the regression guards (best of 3 to 5 runs each)
```

## Results

"Round 2" is the median before the fix (`new` = a row that did not exist then). For the `analyseImpact` rows the Round 2 value is the old
scan-per-call implementation, compared with the call that passes the prebuilt `testIndex` (what the host does).

| Case | Median ms | Min ms | Max ms | Round 2 median ms | What it measures |
|---|---|---|---|---|---|
| EventStore.add x 10,000 | 2.43 | 2.27 | 2.51 | 2.40 | 10,000 distinct files, default limit 1,000 (every add past 1,000 trims) |
| EventStore.add x 10,000 | 3.70 | 3.63 | 4.93 | 3.69 | 10,000 distinct files, limit 5,000 |
| EventStore.add x 10,000 | 0.47 | 0.42 | 0.61 | 0.471 | 50 files edited in turn, 100 ms apart (almost every add coalesces) |
| EventStore.files() x 100 | 2.58 | 2.03 | 3.14 | 2.39 | after 1,000 events on 1,000 files; cached by revision, so one build and 99 hits |
| EventStore add + files() x 1,000 | 70.6 | 69.9 | 72.4 | 70.1 | 1,000 events on 1,000 files; every add invalidates the per-file cache (worst case for the dashboard) |
| DepGraph build, 500 files | 0.58 | 0.52 | 0.73 | 0.554 | 1 to 8 imports per file, a quarter of them to 20 shared hubs (setFile for every file) |
| DepGraph.dependants(hub, 3, 200), 500 files | 0.054 | 0.051 | 0.060 | 0.054 | the most imported file (hits the 200-node cap) |
| DepGraph.dependants x 1,000 typical files, 500 files | 13.8 | 13.4 | 15.7 | 13.5 | 1,000 different files |
| DepGraph build, 2,000 files | 2.29 | 2.06 | 2.88 | 2.23 | 1 to 8 imports per file, a quarter of them to 20 shared hubs (setFile for every file) |
| DepGraph.dependants(hub, 3, 200), 2,000 files | 0.030 | 0.029 | 0.033 | 0.031 | the most imported file (hits the 200-node cap) |
| DepGraph.dependants x 1,000 typical files, 2,000 files | 12.5 | 12.3 | 13.3 | 13.2 | 1,000 different files |
| DepGraph build, 5,000 files | 5.83 | 5.54 | 6.66 | 5.45 | 1 to 8 imports per file, a quarter of them to 20 shared hubs (setFile for every file) |
| DepGraph.dependants(hub, 3, 200), 5,000 files | 0.036 | 0.034 | 0.042 | 0.039 | the most imported file (hits the 200-node cap) |
| DepGraph.dependants x 1,000 typical files, 5,000 files | 12.8 | 12.6 | 13.8 | 12.6 | 1,000 different files |
| DepGraph build, 10,000 files | 12.8 | 11.7 | 14.3 | 12.4 | 1 to 8 imports per file, a quarter of them to 20 shared hubs (setFile for every file) |
| DepGraph.dependants(hub, 3, 200), 10,000 files | 0.072 | 0.068 | 0.083 | 0.072 | the most imported file (hits the 200-node cap) |
| DepGraph.dependants x 1,000 typical files, 10,000 files | 13.7 | 13.0 | 14.2 | 12.8 | 1,000 different files |
| DepGraph.setFile, one incremental update, 10,000 files | 0.42 | 0.41 | 0.45 | 0.415 | re-analysing one edited file (replaces its edges), x 1,000 |
| DepGraph.removeUnder(folder), 10,000 files | 1.19 | 1.07 | 1.79 | 1.09 | a folder of 250 files |
| buildTestIndex, 2,000 files | 0.53 | 0.50 | 0.69 | new | built once per change of the indexed path set, then shared by every impact lookup |
| analyseImpact x 1 with testIndex, 2,000 files | 0.019 | 0.016 | 0.030 | 0.708 | one typical file (dependants + related tests from the prebuilt index) |
| analyseImpact x 50 with testIndex, 2,000 files | 2.10 | 1.98 | 4.62 | 24.6 | what Impact mode does for the 50 newest files on every state build (the real code path) |
| analyseImpact x 50 without testIndex, 2,000 files | 35.5 | 32.9 | 45.2 | new | for comparison: a caller that does not pass testIndex, so every call builds its own index (50 index builds) |
| buildTestIndex, 10,000 files | 2.58 | 2.49 | 10.3 | new | built once per change of the indexed path set, then shared by every impact lookup |
| analyseImpact x 1 with testIndex, 10,000 files | 0.011 | 0.011 | 0.012 | 2.45 | one typical file (dependants + related tests from the prebuilt index) |
| analyseImpact x 50 with testIndex, 10,000 files | 1.71 | 1.70 | 6.15 | 111 | what Impact mode does for the 50 newest files on every state build (the real code path) |
| analyseImpact x 50 without testIndex, 10,000 files | 169 | 160 | 176 | new | for comparison: a caller that does not pass testIndex, so every call builds its own index (50 index builds) |
| buildTestIndex, 20,000 files | 5.12 | 5.06 | 11.8 | new | built once per change of the indexed path set, then shared by every impact lookup |
| analyseImpact x 1 with testIndex, 20,000 files | 0.026 | 0.026 | 0.031 | 4.99 | one typical file (dependants + related tests from the prebuilt index) |
| analyseImpact x 50 with testIndex, 20,000 files | 2.26 | 2.22 | 2.43 | 226 | what Impact mode does for the 50 newest files on every state build (the real code path) |
| analyseImpact x 50 without testIndex, 20,000 files | 341 | 328 | 353 | new | for comparison: a caller that does not pass testIndex, so every call builds its own index (50 index builds) |
| storage deserialise, 5,000 events + 50 sessions of 200 files | 0.64 | 0.61 | 7.02 | 0.626 | validates every record field by field |
| storage serialise, 5,000 events + 50 sessions | 0.12 | 0.12 | 0.15 | 0.118 | plain copy for the Memento |
| buildSessionReport, 500 files, Markdown | 0.35 | 0.25 | 3.88 | 0.310 | one session with the cap of 500 files |
| parseDashboardHostMessage, 300 rows | 0.094 | 0.051 | 0.11 | 0.090 | the validation every state message goes through in the webview |
| buildDashboardState, 300 files + 1,000 events | 0.71 | 0.66 | 0.76 | 0.693 | 40 files shaking, 5 sessions, a repository with 150 changes, 50 impacts, a selection |
| buildDashboardState, 1,000 files + 1,000 events | 0.77 | 0.74 | 0.79 | 0.760 | 40 files shaking, 5 sessions, a repository with 150 changes, 50 impacts, a selection |
| buildDashboardState, 5,000 files + 5,000 events | 0.98 | 0.93 | 1.07 | 0.978 | 40 files shaking, 5 sessions, a repository with 150 changes, 50 impacts, a selection |
| stateSignature, 300 files + 1,000 events | 0.27 | 0.26 | 0.28 | 0.253 | the JSON text used to decide whether a state changed (computed on every rebuild) |
| dashboard first render, 300 rows (jsdom) | 49.9 | 47.2 | 53.7 | 52.1 | mountDashboard + one state, Overview tab selected (all six panels are rendered) |
| dashboard update, 300 rows, 1 row changed (jsdom) | 3.71 | 3.46 | 4.25 | 3.71 | second state in which one row got a new change count and intensity |
| dashboard update, 300 rows, nothing changed (jsdom) | 3.36 | 3.24 | 10.3 | 3.23 | a later state identical to the last one (no DOM writes expected) |
| dashboard 200 rapid states, 300 rows (jsdom) | 532 | 494 | 551 | 484 | after the first render: 200 more states, each with 10 rows changed and a new seq |

### What changed in the `analyseImpact` rows (QA-108)

| Files | x 50 before the fix | x 50 now, with `testIndex` | x 50 now, without `testIndex` | `buildTestIndex`, once |
|---|---|---|---|---|
| 2,000 | 24.6 ms | 2.10 ms | 35.5 ms | 0.53 ms |
| 10,000 | 111 ms | 1.71 ms | 169 ms | 2.58 ms |
| 20,000 | 226 ms | 2.26 ms | 341 ms | 5.12 ms |

With the index the cost of the 50 lookups no longer depends on the number of files (it is the dependants walk and the reasons): about 65 times
less than before at 10,000 files and 100 times less at 20,000. The index itself is built once per change of the indexed path set. A caller that
does **not** pass `testIndex` is slower than the old code (about 170 ms against 111 ms at 10,000 files): it pays for an index on every call. The host passes
it (`DependencyIndex.impactFor`, cached per revision of the indexed paths, read from the code and not timed in a real host), a test
(`testIndex.test.ts`, "analyseImpact with and without a prebuilt index give the same answer") pins that both forms return the same result, and a
guard (below) fails if `analyseImpact` stops using the index.

Rows with a wider spread between passes: `EventStore add + files() x 1,000` and `storage serialise` (one pass met a busy moment: 0.502 ms against
0.116 and 0.121). The JSON of each pass is printed by the command above.

## Against the DESIGN-0.3.0 section 13 thresholds and the guards

| Threshold (regression guard) | Measured median | Result |
|---|---|---|
| `EventStore.add` x 10,000 under 250 ms | 2.43 ms (distinct files, limit 1,000); 3.70 ms (limit 5,000) | within |
| `buildDashboardState` under 50 ms (300 files, 1,000 events) | 0.71 ms | within |
| `DepGraph.dependants` on a 10,000 file graph under 100 ms | 0.072 ms for the busiest file; 13.7 ms for 1,000 lookups | within |
| dashboard render of 300 rows in jsdom under 500 ms | 49.9 ms (first render); 3.71 ms (one-row update); 532 ms for 200 rapid states | within |
| `analyseImpact` x 50 at 10,000 files, with the prebuilt index, under 1.5 s (guard kept) | 1.71 ms | within, but 1.5 s cannot tell the fast path from the slow one (the slow form measures about 170 ms), so a second guard was added: **under 100 ms** with the index (about 60 times the measurement, below the slow form). Mutating `analyseImpact` to ignore `testIndex` fails it |
| `buildTestIndex` at 10,000 files under 250 ms (new guard) | 2.58 ms | within |

### Wall-clock guards and machine load (round 3)

Absolute wall-clock thresholds failed in three consecutive `npm run test:unit` runs while the machine was degraded (`node --test` runs the test
files in parallel, so the guards compete with each other and with everything else; the load average went from 4 to 35 during a run, on a laptop that was on
battery and swapping). The table lists each guard that failed, the value it failed with, and what it measures on the recovered machine (charger
connected, load about 3), so the real margin can be judged:

| Guard (test) | Guard | Measured now, recovered machine | Failed with (degraded machine) |
|---|---|---|---|
| dashboard first render of 300 rows in jsdom (`performance030`) | 500 ms | 49.9 ms median (benchmark row above) | 6,700 ms |
| 200 rapid dashboard states (`performance030`) | was 3,000 ms absolute; now relative (below) | 532 ms | 10,200 ms |
| full `analyzeReferences` of a 5,000 line file (`performance.test.ts`, 0.2.0) | 1,000 ms | about 102 ms (test duration, three runs) | above 1,000 ms |
| `buildTree` of 500 rows (`tree.test.ts`, 0.2.0) | 200 ms | 72 to 79 ms (whole test, three runs; the timed call is part of it) | above 200 ms |
| 500 KB pathological inputs, 512 combinations (`performance.test.ts`, 0.2.0) | 1,000 ms per combination, wall clock in 0.2.0 | median 7 ms, **maximum 194 ms** (`css/css-import-open`), in CPU time | 2.5 to 3.4 s of wall time for `js/go-grouped-open`, `python/quote-soup`, `python/single-quote-soup` and `python/rust-lifetimes`; one such failure in each of the three runs |

What I did, and what I did not do:

* `test/support/perfGuard.ts` measures how fast this machine is right now (a fixed workload, the minimum of five timings, compared with the 8 ms it
  takes on an idle M3) and relaxes each guard by that factor, never below 1 and never above 30. **On an idle machine the factor is 1, so every
  threshold is exactly the documented one.** The 0.2.0 guards were wrapped in `scaled(...)` too; their numbers did not change. This is load
  compensation, not a weaker guard: a real regression of 10 times or more still fails.
* The pathological test now guards on **CPU time** of each combination (measured in the child process with `process.cpuUsage`), not on wall
  time: wall time says nothing about the code when the machine is swapping. The limit is still 1,000 ms per combination (5 times the maximum
  measured now); a combination that stalls for 30 s of wall time, or a runner that does not finish within 200 s, still fails. A simulated
  regression (1.3 s of CPU burned in one combination) fails it: `go/open-parens: 1349 ms of CPU`.
* The 200-rapid-states guard is now relative: it must cost less than 60 times the first render plus 500 ms, and no row element may be recreated.
* On a healthy machine none of these was close to its guard; the failures came from the machine (R3.5 and R3.7 in `docs/QA_REPORT.md`).

## Not measured here (and why)

| Item | Status |
|---|---|
| Activation time in a real VS Code host | not measured (the extension is already active when the integration tests start, so there is no clean timing point) |
| Real indexing of a real workspace (`findFiles` plus `analyzeReferences` on disk) | not measured: the numbers above use in-memory graphs built by `setFile`; the cost of reading and scanning files from disk is not in them |
| `buildDashboardState` inside a real host (with the real `EventStore`, tracker and Git service feeding it) | not measured: the row above times the pure function on prepared plain data |
| `DependencyIndex` building and sharing the `TestIndex` in a real host | not measured: the benchmark calls `buildTestIndex` and `analyseImpact` directly |
| Memory use | not measured |
| Windows and Linux | not run |

jsdom has no layout or paint, so the render numbers are DOM construction and update cost only. They say nothing about how
a real browser paints 300 rows.
