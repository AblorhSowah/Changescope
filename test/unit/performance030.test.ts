// Regression guards for the 0.3.0 budgets (DESIGN-0.3.0 section 13). Thresholds are deliberately generous: they catch
// an accidental quadratic loop, they do not certify a speed. Measured numbers live in docs/BENCHMARKS.md
// (`node --import tsx test/perf/bench030.ts`). Each guard takes the best of 5 runs to ride out scheduler noise.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EventStore } from '../../src/core/activity/eventStore';
import { ManualClock } from '../../src/core/clock';
import { buildDashboardState, stateSignature } from '../../src/core/dashboard/model';
import { parseDashboardHostMessage } from '../../src/core/dashboard/protocol';
import { analyseImpact } from '../../src/core/intelligence/impact';
import { buildTestIndex } from '../../src/core/intelligence/testMatch';
import { deserialise, serialise } from '../../src/core/storage/schema';
import { mountDashboard } from '../../src/dashboard/app';
import type { ActivityEvent } from '../../src/core/types';
import { FakeDashEnv, FakeDashHost } from '../support/dashDom';
import { dashState, hostMessage, manyRows } from '../support/dashState';
import { dashboardInput, synthetic } from '../support/synthetic';
import { scaled } from '../support/perfGuard';

function best(runs: number, fn: () => void): number {
  let min = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

const T0 = 1_700_000_000_000;

describe('performance guards (DESIGN-0.3.0 13)', () => {
  it('EventStore.add x 10,000 stays under 250 ms (distinct files, trimming at the default limit)', () => {
    const ms = best(5, () => {
      const store = new EventStore(new ManualClock(T0), 'w');
      for (let i = 0; i < 10_000; i += 1) store.add({ key: `/ws/f${i}.ts`, eventType: 'modify', at: T0 + i, sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 });
      assert.equal(store.size, 1000);
    });
    assert.ok(ms < scaled(250), `10,000 adds took ${ms.toFixed(1)} ms`);
  });

  it('EventStore.add x 10,000 at the maximum limit of 5,000 events stays under 250 ms too', () => {
    const ms = best(5, () => {
      const store = new EventStore(new ManualClock(T0), 'w', { maxEvents: 5000 });
      for (let i = 0; i < 10_000; i += 1) store.add({ key: `/ws/f${i}.ts`, eventType: 'modify', at: T0 + i, sourceType: 'external', detectionMethod: 'disk-write', confidence: 0.7 });
      assert.equal(store.size, 5000);
    });
    assert.ok(ms < scaled(250), `${ms.toFixed(1)} ms`);
  });

  it('DepGraph.dependants on a 10,000 file graph stays under 100 ms (hub and 1,000 typical files)', () => {
    const s = synthetic(10_000);
    const hub = best(5, () => {
      const r = s.graph.dependants(s.hub, 3, 200);
      assert.equal(r.direct.length + r.indirect.length, 200);
    });
    assert.ok(hub < scaled(100), `hub took ${hub.toFixed(2)} ms`);
    const many = best(5, () => {
      for (let i = 0; i < 1000; i += 1) s.graph.dependants(s.files[(i * 7) % 10_000] as string, 3, 200);
    });
    assert.ok(many < scaled(100 * 20), `1,000 lookups took ${many.toFixed(1)} ms`);
  });

  it('building a 10,000 file graph (setFile for every file) stays under 1 s', () => {
    const ms = best(3, () => {
      const s = synthetic(10_000);
      assert.equal(s.graph.fileCount, 10_000);
    });
    assert.ok(ms < scaled(1000), `${ms.toFixed(1)} ms`);
  });

  it('analyseImpact for the 50 newest files of a 10,000 file index (Impact mode, once per state build), with the prebuilt TestIndex the host passes, stays under 1.5 s', () => {
    const s = synthetic(10_000);
    const testIndex = buildTestIndex(s.allFiles);
    const ms = best(3, () => {
      for (let i = 0; i < 50; i += 1) analyseImpact({ file: s.files[i * 7] as string, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: T0, testIndex });
    });
    assert.ok(ms < scaled(1500), `${ms.toFixed(1)} ms`);
  });

  it('QA-108 regression guard: the same 50 lookups with the prebuilt TestIndex stay under 100 ms, so an analyseImpact that stops using the index fails here', () => {
    // Measured about 4 ms with the index and 270 to 980 ms without it (50 index builds), so the 1.5 s guard above could
    // not tell the two apart; this one can.
    const s = synthetic(10_000);
    const testIndex = buildTestIndex(s.allFiles);
    const ms = best(5, () => {
      for (let i = 0; i < 50; i += 1) analyseImpact({ file: s.files[i * 7] as string, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: T0, testIndex });
    });
    assert.ok(ms < scaled(100), `${ms.toFixed(1)} ms`);
  });

  it('buildTestIndex over 10,000 files (once per change of the indexed path set) stays under 250 ms', () => {
    const s = synthetic(10_000);
    const ms = best(5, () => {
      assert.ok(buildTestIndex(s.allFiles).byStem.size > 100);
    });
    assert.ok(ms < scaled(250), `${ms.toFixed(1)} ms`);
  });

  it('buildDashboardState at 300 files and 1,000 events stays under 50 ms (DESIGN-0.3.0 13), and also under 50 ms for 1,000 files', () => {
    const small = dashboardInput(300, 1000);
    const ms = best(5, () => {
      assert.equal(buildDashboardState(small).files.length, 300);
    });
    assert.ok(ms < scaled(50), `${ms.toFixed(2)} ms`);
    const larger = dashboardInput(1000, 1000);
    const ms2 = best(5, () => {
      assert.equal(buildDashboardState(larger).files.length, 300);
    });
    assert.ok(ms2 < scaled(50), `${ms2.toFixed(2)} ms`);
  });

  it('stateSignature of that state (computed on every rebuild) stays under 20 ms', () => {
    const state = buildDashboardState(dashboardInput(300, 1000));
    const ms = best(5, () => {
      assert.ok(stateSignature(state).length > 1000);
    });
    assert.ok(ms < scaled(20), `${ms.toFixed(2)} ms`);
  });

  it('deserialise of a full history (5,000 events, 200 sessions) stays under 250 ms', () => {
    const events: ActivityEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `e${i.toString(36)}`,
      workspaceId: 'w',
      filePath: `/ws/f${i}.ts`,
      eventType: 'modify',
      sourceType: 'external',
      detectionMethod: 'disk-write',
      confidence: 0.7,
      timestamp: T0 + i,
      lastTimestamp: T0 + i,
      count: 1,
      reviewStatus: 'unreviewed',
    }));
    const stored = JSON.parse(JSON.stringify(serialise(events, [], T0))) as unknown;
    const ms = best(5, () => {
      assert.equal(deserialise(stored).events.length, 5000);
    });
    assert.ok(ms < scaled(250), `${ms.toFixed(1)} ms`);
  });

  it('validating a 300-row state message stays under 50 ms', () => {
    const msg = hostMessage(dashState({ files: manyRows(300) }));
    const ms = best(5, () => {
      assert.ok(parseDashboardHostMessage(msg));
    });
    assert.ok(ms < scaled(50), `${ms.toFixed(2)} ms`);
  });

  it('dashboard first render of 300 rows in jsdom stays under 500 ms', () => {
    const msg = hostMessage(dashState({ seq: 1, files: manyRows(300) }));
    const ms = best(5, () => {
      const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
      const app = mountDashboard(dom.window.document.getElementById('app') as HTMLElement, new FakeDashHost().api, new FakeDashEnv().env);
      app.handleMessage(msg);
      assert.equal(dom.window.document.querySelectorAll('li.fd-row').length, 300);
      app.dispose();
      dom.window.close();
    });
    assert.ok(ms < scaled(500), `${ms.toFixed(1)} ms`);
  });

  it('200 rapid state updates of a 300-row dashboard (10 rows changing each time) stay in place (no row is recreated) and cost a small multiple of ONE first render', () => {
    // The guard is relative to a first render measured in the same process, so a busy machine slows both sides alike
    // (an absolute "under 3 s" guard failed once at 10 s while the machine had a load average of 33; it measures about 0.5 s when idle).
    // Re-creating every row on every update would cost about 200 first renders, so a factor of 60 still catches it.
    const rows = manyRows(300);
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const root = dom.window.document.getElementById('app') as HTMLElement;
    const app = mountDashboard(root, new FakeDashHost().api, new FakeDashEnv().env);
    const t0 = performance.now();
    app.handleMessage(hostMessage(dashState({ seq: 1, files: rows })));
    const first = performance.now() - t0;
    const before = [...root.querySelectorAll('li.fd-row')];
    const msgs = Array.from({ length: 200 }, (_, k) => hostMessage(dashState({ seq: k + 2, files: rows.map((r, i) => (i % 30 === k % 30 ? { ...r, changes: r.changes + k, intensity: 0.3, phase: 'active' as const } : r)) })));
    const t1 = performance.now();
    for (const m of msgs) app.handleMessage(m);
    const rapid = performance.now() - t1;
    assert.ok(rapid < 60 * first + 500, `200 updates took ${rapid.toFixed(0)} ms, one first render ${first.toFixed(0)} ms`);
    const after = [...root.querySelectorAll('li.fd-row')];
    assert.equal(after.length, 300);
    assert.ok(after.every((el, i) => el === before[i]), 'the same 300 elements, in the same order');
    app.dispose();
    dom.window.close();
  });
});
