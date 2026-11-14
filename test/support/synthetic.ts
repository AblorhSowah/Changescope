// Deterministic synthetic workspaces for the performance probes and guards (no real time, no randomness source
// other than a fixed-seed generator).
import { DepGraph } from '../../src/core/intelligence/depGraph';

export function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

export interface Synthetic {
  graph: DepGraph;
  files: string[];
  allFiles: Set<string>;
  /** the file that many others import */
  hub: string;
  /** a typical leaf-ish file */
  sample: string;
}

/**
 * `n` TypeScript-looking files under 40 folders. Every file imports 1 to 8 others (a quarter of the choices
 * go to 20 shared "hub" files, so some files have thousands of importers), plus a test file for every tenth file.
 */
export function synthetic(n: number, seed = 42): Synthetic {
  const r = rng(seed);
  const files: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const isTest = i % 10 === 9;
    const stem = `m${i}`;
    files.push(`/ws/proj/pkg${i % 40}/src/${isTest ? `${stem}.test.ts` : `${stem}.ts`}`);
  }
  const hubs = files.slice(0, Math.min(20, n));
  const graph = new DepGraph();
  for (let i = 0; i < n; i += 1) {
    const targets = new Map<string, number>();
    const fan = 1 + r(8);
    for (let k = 0; k < fan; k += 1) {
      const t = r(4) === 0 ? hubs[r(hubs.length)] : files[r(n)];
      if (t !== undefined && t !== files[i]) targets.set(t, (targets.get(t) ?? 0) + 1);
    }
    graph.setFile(files[i] as string, [...targets].map(([key, count]) => ({ key, count })), 'ts');
  }
  return { graph, files, allFiles: new Set(files), hub: hubs[0] as string, sample: files[Math.floor(n / 2)] as string };
}

/**
 * A dashboard input with `files` files and `events` events in the history, 40 of the files shaking,
 * 5 sessions, a Git repository with 150 changes and an impact map of 50 entries. Used by the benchmark and the
 * regression guard for buildDashboardState.
 */
export function dashboardInput(files: number, events: number): import('../../src/core/dashboard/model').DashboardInput {
  const r = rng(7);
  const sources = ['developer', 'ai-agent', 'external', 'git', 'automated', 'unknown'] as const;
  const T = 1_700_000_000_000;
  const keys = Array.from({ length: files }, (_, i) => `/ws/proj/pkg${i % 40}/src/m${i}.ts`);
  const fileActivity = keys.map((key, i) => ({
    key,
    sourceType: sources[i % 6] as (typeof sources)[number],
    detectionMethod: 'disk-write' as const,
    confidence: 0.7,
    lastEventType: 'modify' as const,
    firstAt: T - 100_000 - i,
    lastAt: T - i * 50,
    changes: 1 + r(9),
    review: i % 3 === 0 ? ('unreviewed' as const) : undefined,
    exists: true,
  }));
  const eventList = Array.from({ length: events }, (_, i) => ({
    id: `e${i.toString(36)}`,
    workspaceId: 'w',
    filePath: keys[r(files)] as string,
    eventType: 'modify' as const,
    sourceType: sources[i % 6] as (typeof sources)[number],
    detectionMethod: 'disk-write' as const,
    confidence: 0.7,
    timestamp: T - i * 100,
    lastTimestamp: T - i * 100 + 20,
    count: 1 + r(3),
    ...(i % 5 === 0 ? { sessionId: `s${r(5)}` } : {}),
  }));
  const graph = synthetic(Math.min(files, 2000)).graph;
  const impacts = new Map<string, import('../../src/core/types').ChangeImpact>();
  for (const key of keys.slice(0, 50)) {
    impacts.set(key, { filePath: key, directDependants: graph.dependants(key, 3, 200).direct, indirectDependants: [], affectedFiles: [], affectedTests: [], configFiles: [], impactLevel: 'medium', reasons: ['3 files import this file directly.'], complete: true, analysedAt: T - 1000 });
  }
  return {
    now: T,
    seq: 1,
    enabled: true,
    roots: [{ key: '/ws/proj', name: 'proj' }],
    files: fileActivity,
    live: new Map(keys.slice(0, 40).map((key) => [key, { phase: 'active' as const, intensity: 0.5 }])),
    events: eventList,
    eventCount: events,
    unreviewed: Math.ceil(files / 3),
    sessions: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, title: `Session ${i}`, workspaceId: 'w', startedAt: T - i * 1_000_000, status: i === 0 ? ('active' as const) : ('completed' as const), ...(i === 0 ? {} : { endedAt: T - i * 1_000_000 + 500_000 }), activityCount: 40, modifiedFiles: keys.slice(0, 20), sources: { developer: 20, external: 20 } })),
    git: { state: 'ready', detail: '', repos: [{ root: '/ws/proj', name: 'proj', branch: 'main', commit: 'abcdef0123456789', ahead: 0, behind: 0, staged: keys.slice(0, 50).map((key) => ({ key, status: 'modified' as const })), unstaged: keys.slice(50, 100).map((key) => ({ key, status: 'modified' as const })), untracked: keys.slice(100, 150).map((key) => ({ key, status: 'untracked' as const })), truncated: false }] },
    selection: { file: keys[0], imports: graph.importsOf(keys[0] as string), importedBy: graph.importedBy(keys[0] as string), impact: impacts.get(keys[0] as string) },
    impacts,
    index: { state: 'ready', indexed: files, total: files, truncated: false },
    settings: { mode: 'live', animate: true, animationIntensity: 1, paused: false, collisions: true, dependencyIndex: true, gitEnabled: true, historyLimit: 1000, retentionDays: 14, aiMode: 'local', aiProvider: null },
    agents: [{ id: 'api', label: 'Extension API', state: 'listening', detail: '' }],
    summary: { text: '300 files changed.', provider: 'local', at: T - 5000 },
  };
}
