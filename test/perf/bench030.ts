// Performance probe for the 0.3.0 core and the dashboard webview. Not a test: it prints measured numbers
// (docs/BENCHMARKS.md records one run). Run from the repository root:
//
//   node --import tsx test/perf/bench030.ts            # table + JSON
//   node --import tsx test/perf/bench030.ts --json     # JSON only
//
// Every case runs 2 warm-up rounds and then `RUNS` timed rounds on freshly built inputs; the table shows the
// median and the range. Inputs are deterministic (fixed seeds); only the timings vary.
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { JSDOM } from 'jsdom';
import { EventStore } from '../../src/core/activity/eventStore';
import { ManualClock } from '../../src/core/clock';
import { buildDashboardState, stateSignature } from '../../src/core/dashboard/model';
import { parseDashboardHostMessage } from '../../src/core/dashboard/protocol';
import { analyseImpact } from '../../src/core/intelligence/impact';
import { buildTestIndex } from '../../src/core/intelligence/testMatch';
import { buildSessionReport } from '../../src/core/sessions/report';
import { deserialise, serialise } from '../../src/core/storage/schema';
import { mountDashboard } from '../../src/dashboard/app';
import type { ActivityEvent, DevelopmentSession } from '../../src/core/types';
import { FakeDashEnv, FakeDashHost } from '../support/dashDom';
import { dashState, hostMessage, manyRows } from '../support/dashState';
import { dashboardInput, synthetic } from '../support/synthetic';

const RUNS = 7;
const WARMUP = 2;

interface Result {
  name: string;
  detail: string;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

const results: Result[] = [];

/** `setup` builds a fresh input and returns what to time; `done` (optional) runs after the timer stops. */
type Setup = () => (() => void) | { run: () => void; done?: () => void };

function measure(name: string, detail: string, setup: Setup): void {
  const times: number[] = [];
  for (let i = 0; i < WARMUP + RUNS; i += 1) {
    const prepared = setup();
    const run = typeof prepared === 'function' ? prepared : prepared.run;
    const t0 = performance.now();
    run();
    const dt = performance.now() - t0;
    if (typeof prepared !== 'function') prepared.done?.();
    if (i >= WARMUP) times.push(dt);
  }
  times.sort((a, b) => a - b);
  results.push({ name, detail, medianMs: times[Math.floor(times.length / 2)] as number, minMs: times[0] as number, maxMs: times[times.length - 1] as number });
}

const T0 = 1_700_000_000_000;
const ev = (key: string, at: number) => ({ key, eventType: 'modify' as const, at, sourceType: 'external' as const, detectionMethod: 'disk-write' as const, confidence: 0.7 });

// ----- EventStore.add x 10,000 ------------------------------------------------------------------
measure('EventStore.add x 10,000', '10,000 distinct files, default limit 1,000 (every add past 1,000 trims)', () => {
  const store = new EventStore(new ManualClock(T0), 'w');
  return () => {
    for (let i = 0; i < 10_000; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
  };
});
measure('EventStore.add x 10,000', '10,000 distinct files, limit 5,000', () => {
  const store = new EventStore(new ManualClock(T0), 'w', { maxEvents: 5000 });
  return () => {
    for (let i = 0; i < 10_000; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
  };
});
measure('EventStore.add x 10,000', '50 files edited in turn, 100 ms apart (almost every add coalesces)', () => {
  const store = new EventStore(new ManualClock(T0), 'w');
  return () => {
    for (let i = 0; i < 10_000; i += 1) store.add(ev(`/ws/f${i % 50}.ts`, T0 + i * 100));
  };
});
measure('EventStore.files() x 100', 'after 1,000 events on 1,000 files; cached by revision, so one build and 99 hits', () => {
  const store = new EventStore(new ManualClock(T0), 'w');
  for (let i = 0; i < 1000; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
  return () => {
    for (let i = 0; i < 100; i += 1) store.files();
  };
});
measure('EventStore add + files() x 1,000', '1,000 events on 1,000 files; every add invalidates the per-file cache (worst case for the dashboard)', () => {
  const store = new EventStore(new ManualClock(T0), 'w');
  for (let i = 0; i < 1000; i += 1) store.add(ev(`/ws/f${i}.ts`, T0 + i));
  return () => {
    for (let i = 0; i < 1000; i += 1) {
      store.add(ev(`/ws/f${i % 1000}.ts`, T0 + 100_000 + i * 6000));
      store.files();
    }
  };
});

// ----- DepGraph ---------------------------------------------------------------------------------
for (const n of [500, 2000, 5000, 10_000]) {
  measure(`DepGraph build, ${n.toLocaleString('en-US')} files`, '1 to 8 imports per file, a quarter of them to 20 shared hubs (setFile for every file)', () => () => {
    synthetic(n);
  });
  const s = synthetic(n);
  measure(`DepGraph.dependants(hub, 3, 200), ${n.toLocaleString('en-US')} files`, 'the most imported file (hits the 200-node cap)', () => () => {
    s.graph.dependants(s.hub, 3, 200);
  });
  measure(`DepGraph.dependants x 1,000 typical files, ${n.toLocaleString('en-US')} files`, '1,000 different files', () => () => {
    for (let i = 0; i < 1000; i += 1) s.graph.dependants(s.files[(i * 7) % n] as string, 3, 200);
  });
}
{
  const s = synthetic(10_000);
  measure('DepGraph.setFile, one incremental update, 10,000 files', 're-analysing one edited file (replaces its edges), x 1,000', () => () => {
    for (let i = 0; i < 1000; i += 1) s.graph.setFile(s.files[i] as string, [{ key: s.files[i + 1] as string, count: 1 }, { key: s.files[i + 2] as string, count: 2 }], 'ts');
  });
  measure('DepGraph.removeUnder(folder), 10,000 files', 'a folder of 250 files', () => {
    const g = synthetic(10_000);
    return () => {
      g.graph.removeUnder('/ws/proj/pkg3');
    };
  });
}

// ----- analyseImpact ----------------------------------------------------------------------------
// The host keeps one TestIndex per set of indexed paths and passes it to every call (QA-108). Both forms are timed: the
// call without an index builds one per call (50 index builds for 50 lookups), which is what QA-108 measured as slow.
for (const n of [2000, 10_000, 20_000]) {
  const s = synthetic(n);
  const testIndex = buildTestIndex(s.allFiles);
  measure(`buildTestIndex, ${n.toLocaleString('en-US')} files`, 'built once per change of the indexed path set, then shared by every impact lookup', () => () => {
    buildTestIndex(s.allFiles);
  });
  measure(`analyseImpact x 1 with testIndex, ${n.toLocaleString('en-US')} files`, 'one typical file (dependants + related tests from the prebuilt index)', () => () => {
    analyseImpact({ file: s.sample, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: T0, testIndex });
  });
  measure(`analyseImpact x 50 with testIndex, ${n.toLocaleString('en-US')} files`, 'what Impact mode does for the 50 newest files on every state build (the real code path)', () => () => {
    for (let i = 0; i < 50; i += 1) analyseImpact({ file: s.files[i * 7] as string, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: T0, testIndex });
  });
  measure(`analyseImpact x 50 without testIndex, ${n.toLocaleString('en-US')} files`, 'for comparison: a caller that does not pass testIndex, so every call builds its own index (50 index builds)', () => () => {
    for (let i = 0; i < 50; i += 1) analyseImpact({ file: s.files[i * 7] as string, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: T0 });
  });
}

// ----- storage, report, protocol ------------------------------------------------------------------
{
  const events: ActivityEvent[] = Array.from({ length: 5000 }, (_, i) => ({
    id: `e${i.toString(36)}`,
    workspaceId: 'w',
    filePath: `/ws/proj/pkg${i % 40}/src/m${i}.ts`,
    eventType: 'modify',
    sourceType: i % 3 === 0 ? 'developer' : 'external',
    detectionMethod: i % 3 === 0 ? 'focused-editor-edit' : 'disk-write',
    confidence: 0.8,
    timestamp: T0 + i,
    lastTimestamp: T0 + i + 5,
    count: 2,
    ...(i % 3 === 0 ? {} : { reviewStatus: 'unreviewed' as const }),
  }));
  const sessions: DevelopmentSession[] = Array.from({ length: 50 }, (_, i) => ({
    id: `s${i}`,
    title: `Session ${i}`,
    workspaceId: 'w',
    startedAt: T0 + i,
    endedAt: T0 + i + 1000,
    status: 'completed' as const,
    activityCount: 100,
    modifiedFiles: Array.from({ length: 200 }, (_, j) => `/ws/proj/f${j}.ts`),
    sources: { developer: 60, external: 40 },
  }));
  const stored = JSON.parse(JSON.stringify(serialise(events, sessions, T0))) as unknown;
  measure('storage deserialise, 5,000 events + 50 sessions of 200 files', 'validates every record field by field', () => () => {
    deserialise(stored);
  });
  measure('storage serialise, 5,000 events + 50 sessions', 'plain copy for the Memento', () => () => {
    serialise(events, sessions, T0);
  });
  const big = sessions[0] as DevelopmentSession;
  const bigSession = { ...big, modifiedFiles: Array.from({ length: 500 }, (_, j) => `/ws/proj/f${j}.ts`) };
  const sessionEvents = bigSession.modifiedFiles.map((f, i): ActivityEvent => ({ ...(events[i] as ActivityEvent), filePath: f, sessionId: bigSession.id }));
  measure('buildSessionReport, 500 files, Markdown', 'one session with the cap of 500 files', () => () => {
    buildSessionReport(bigSession, sessionEvents, (k) => k.slice(4), 'markdown');
  });
  const state300 = hostMessage(dashState({ files: manyRows(300) }));
  measure('parseDashboardHostMessage, 300 rows', 'the validation every state message goes through in the webview', () => () => {
    parseDashboardHostMessage(state300);
  });
}

// ----- buildDashboardState --------------------------------------------------------------------------
for (const [files, events] of [[300, 1000], [1000, 1000], [5000, 5000]] as const) {
  const inp = dashboardInput(files, events);
  measure(`buildDashboardState, ${files.toLocaleString('en-US')} files + ${events.toLocaleString('en-US')} events`, '40 files shaking, 5 sessions, a repository with 150 changes, 50 impacts, a selection', () => () => {
    buildDashboardState(inp);
  });
}
{
  const state = buildDashboardState(dashboardInput(300, 1000));
  measure('stateSignature, 300 files + 1,000 events', 'the JSON text used to decide whether a state changed (computed on every rebuild)', () => () => {
    stateSignature(state);
  });
}

// ----- dashboard render in jsdom ----------------------------------------------------------------
{
  const rows = manyRows(300);
  const first = dashState({ seq: 1, files: rows });
  measure('dashboard first render, 300 rows (jsdom)', 'mountDashboard + one state, Overview tab selected (all six panels are rendered)', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const env = new FakeDashEnv();
    const host = new FakeDashHost();
    const app = mountDashboard(dom.window.document.getElementById('app') as HTMLElement, host.api, env.env);
    const msg = hostMessage(first);
    return {
      run: () => app.handleMessage(msg),
      done: () => {
        app.dispose();
        dom.window.close();
      },
    };
  });
  measure('dashboard update, 300 rows, 1 row changed (jsdom)', 'second state in which one row got a new change count and intensity', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const env = new FakeDashEnv();
    const host = new FakeDashHost();
    const app = mountDashboard(dom.window.document.getElementById('app') as HTMLElement, host.api, env.env);
    app.handleMessage(hostMessage(first));
    const changed = rows.map((r, i) => (i === 0 ? { ...r, changes: r.changes + 1, intensity: 0.5, phase: 'active' as const } : r));
    const msg = hostMessage(dashState({ seq: 2, files: changed }));
    return {
      run: () => app.handleMessage(msg),
      done: () => {
        app.dispose();
        dom.window.close();
      },
    };
  });
  measure('dashboard update, 300 rows, nothing changed (jsdom)', 'a later state identical to the last one (no DOM writes expected)', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const env = new FakeDashEnv();
    const host = new FakeDashHost();
    const app = mountDashboard(dom.window.document.getElementById('app') as HTMLElement, host.api, env.env);
    app.handleMessage(hostMessage(first));
    const msg = hostMessage(dashState({ seq: 2, files: rows }));
    return {
      run: () => app.handleMessage(msg),
      done: () => {
        app.dispose();
        dom.window.close();
      },
    };
  });
}

{
  const rows = manyRows(300);
  measure('dashboard 200 rapid states, 300 rows (jsdom)', 'after the first render: 200 more states, each with 10 rows changed and a new seq', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const env = new FakeDashEnv();
    const host = new FakeDashHost();
    const app = mountDashboard(dom.window.document.getElementById('app') as HTMLElement, host.api, env.env);
    app.handleMessage(hostMessage(dashState({ seq: 1, files: rows })));
    const msgs = Array.from({ length: 200 }, (_, k) =>
      hostMessage(dashState({ seq: k + 2, files: rows.map((r, i) => (i % 30 === k % 30 ? { ...r, changes: r.changes + k, intensity: 0.3, phase: 'active' as const } : r)) })),
    );
    return {
      run: () => {
        for (const m of msgs) app.handleMessage(m);
      },
      done: () => {
        app.dispose();
        dom.window.close();
      },
    };
  });
}

// ----- output -----------------------------------------------------------------------------------
const info = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} logical)`,
  memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
  runs: RUNS,
};

const fmt = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(3));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ info, results }, null, 2));
} else {
  console.log(`Changescope 0.3.0 benchmarks: ${info.date}`);
  console.log(`${info.platform}; ${info.cpu}; ${info.memoryGiB} GiB; Node ${info.node}; median of ${RUNS} runs after ${WARMUP} warm-ups\n`);
  console.log('| Case | Median ms | Min ms | Max ms | Detail |');
  console.log('|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.name} | ${fmt(r.medianMs)} | ${fmt(r.minMs)} | ${fmt(r.maxMs)} | ${r.detail} |`);
  console.log(`\n${JSON.stringify({ info, results })}`);
}
