import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepGraph } from '../../src/core/intelligence/depGraph';
import { IMPACT, analyseImpact, isConfigFile } from '../../src/core/intelligence/impact';
import type { ImpactLevel } from '../../src/core/types';
import { must } from '../support/fixtures';

const NOW = 1_700_000_000_000;
const TARGET = '/ws/src/core.ts';

/** `direct` files import TARGET; `viaEach` further files import each of the first `chained` direct files. */
function build(direct: number, indirectChains = 0, perChain = 1): { graph: DepGraph; all: Set<string> } {
  const graph = new DepGraph();
  const all = new Set<string>([TARGET]);
  graph.setFile(TARGET, [], 'ts');
  for (let i = 0; i < direct; i += 1) {
    const d = `/ws/src/d${String(i).padStart(3, '0')}.ts`;
    graph.setFile(d, [{ key: TARGET, count: 1 }], 'ts');
    all.add(d);
    if (i < indirectChains) {
      for (let j = 0; j < perChain; j += 1) {
        const ind = `/ws/src/i${String(i).padStart(3, '0')}_${j}.ts`;
        graph.setFile(ind, [{ key: d, count: 1 }], 'ts');
        all.add(ind);
      }
    }
  }
  return { graph, all };
}

function level(direct: number, indirect = 0, file = TARGET): ImpactLevel {
  const { graph, all } = build(direct, indirect);
  return analyseImpact({ file, graph, allFiles: all, indexComplete: true, now: NOW }).impactLevel;
}

describe('IMPACT constants (DESIGN-0.3.0 7.3)', () => {
  it('values', () => {
    assert.deepEqual({ ...IMPACT }, { MAX_DEPTH: 3, MAX_NODES: 200, MEDIUM: 3, HIGH: 10, CRITICAL: 25 });
  });
});

describe('analyseImpact: level thresholds at their exact boundaries', () => {
  it('low: 0, 1 and 2 direct dependants', () => {
    for (const n of [0, 1, 2]) assert.equal(level(n), 'low', `${n} direct`);
  });

  it('medium starts at 3 direct (boundary), and holds through 9', () => {
    assert.equal(level(2), 'low');
    assert.equal(level(3), 'medium');
    assert.equal(level(9), 'medium');
  });

  it('high starts at 10 direct (boundary), and holds through 24', () => {
    assert.equal(level(9), 'medium');
    assert.equal(level(10), 'high');
    assert.equal(level(24), 'high');
  });

  it('critical starts at 25 direct (boundary)', () => {
    assert.equal(level(24), 'high');
    assert.equal(level(25), 'critical');
    assert.equal(level(60), 'critical');
  });

  it('combined direct + indirect: medium from 8, even with only 2 direct dependants', () => {
    const six = build(2, 2, 2); // 2 direct + 4 indirect = 6
    const r6 = analyseImpact({ file: TARGET, graph: six.graph, allFiles: six.all, indexComplete: true, now: NOW });
    assert.equal(r6.directDependants.length + r6.indirectDependants.length, 6);
    assert.equal(r6.impactLevel, 'low', '6 combined is still low');
    const eight = build(2, 2, 3); // 2 direct + 6 indirect = 8
    const r8 = analyseImpact({ file: TARGET, graph: eight.graph, allFiles: eight.all, indexComplete: true, now: NOW });
    assert.equal(r8.directDependants.length, 2);
    assert.equal(r8.indirectDependants.length, 6);
    assert.equal(r8.impactLevel, 'medium', '2 + 6 = 8 reaches the combined medium threshold');
  });

  it('combined exactly 7 is low and exactly 8 is medium', () => {
    const b7 = build(1, 1, 6); // 1 direct + 6 indirect = 7
    const r7 = analyseImpact({ file: TARGET, graph: b7.graph, allFiles: b7.all, indexComplete: true, now: NOW });
    assert.equal(r7.directDependants.length + r7.indirectDependants.length, 7);
    assert.equal(r7.impactLevel, 'low');
    const b8 = build(1, 1, 7);
    const r8 = analyseImpact({ file: TARGET, graph: b8.graph, allFiles: b8.all, indexComplete: true, now: NOW });
    assert.equal(r8.directDependants.length + r8.indirectDependants.length, 8);
    assert.equal(r8.impactLevel, 'medium');
  });

  it('combined exactly 29 is medium and exactly 30 is high (with fewer than 10 direct)', () => {
    const b29 = build(2, 1, 27); // 2 direct + 27 indirect via one of them = 29
    const r29 = analyseImpact({ file: TARGET, graph: b29.graph, allFiles: b29.all, indexComplete: true, now: NOW });
    assert.equal(r29.directDependants.length + r29.indirectDependants.length, 29);
    assert.equal(r29.impactLevel, 'medium');
    const b30 = build(2, 1, 28);
    const r30 = analyseImpact({ file: TARGET, graph: b30.graph, allFiles: b30.all, indexComplete: true, now: NOW });
    assert.equal(r30.directDependants.length + r30.indirectDependants.length, 30);
    assert.equal(r30.impactLevel, 'high');
  });

  it('indirect dependants never reach critical on their own, however many there are', () => {
    const b = build(2, 2, 90);
    const r = analyseImpact({ file: TARGET, graph: b.graph, allFiles: b.all, indexComplete: true, now: NOW });
    assert.ok(r.indirectDependants.length >= 150);
    assert.equal(r.impactLevel, 'high');
  });

  it('the level never goes down as dependants are added (monotone over 0..40 direct)', () => {
    const order: ImpactLevel[] = ['low', 'medium', 'high', 'critical'];
    let prev = 0;
    for (let n = 0; n <= 40; n += 1) {
      const idx = order.indexOf(level(n));
      assert.ok(idx >= prev, `${n} direct`);
      prev = idx;
    }
  });
});

describe('analyseImpact: result shape', () => {
  it('echoes the file and time; lists are sorted; affected = direct then indirect', () => {
    const { graph, all } = build(4, 2, 1);
    const r = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.equal(r.filePath, TARGET);
    assert.equal(r.analysedAt, NOW);
    assert.equal(r.directDependants.length, 4);
    assert.equal(r.indirectDependants.length, 2);
    assert.deepEqual([...r.directDependants].sort(), r.directDependants);
    assert.deepEqual(r.affectedFiles, [...r.directDependants, ...r.indirectDependants]);
  });

  it('a file the graph has never seen is low with "No dependants were found."', () => {
    const r = analyseImpact({ file: '/ws/never.ts', graph: new DepGraph(), allFiles: new Set(), indexComplete: true, now: NOW });
    assert.equal(r.impactLevel, 'low');
    assert.deepEqual(r.reasons, ['No dependants were found.']);
    assert.deepEqual(r.affectedFiles, []);
    assert.deepEqual(r.affectedTests, []);
    assert.deepEqual(r.configFiles, []);
    assert.equal(r.complete, true);
  });

  it('is deterministic and does not mutate the graph', () => {
    const { graph, all } = build(5, 2, 2);
    const before = graph.edgeCount;
    const a = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    const b = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.deepEqual(a, b);
    assert.equal(graph.edgeCount, before);
  });

  it('the node cap of 200 truncates the lists and says so', () => {
    const { graph, all } = build(260);
    const r = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.equal(r.directDependants.length, 200);
    assert.equal(r.impactLevel, 'critical');
    assert.equal(r.complete, false, 'a truncated search is not complete');
    assert.ok(r.reasons.includes('The search stopped at 200 files, so more files may be affected.'), r.reasons.join(' | '));
  });

  it('exactly 200 dependants is complete (no truncation message)', () => {
    const { graph, all } = build(200);
    const r = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.equal(r.directDependants.length, 200);
    assert.equal(r.complete, true);
    assert.ok(!r.reasons.some((x) => x.includes('search stopped')));
  });

  it('depth stops at 3 levels', () => {
    const graph = new DepGraph();
    const chain = ['/ws/f0.ts', '/ws/f1.ts', '/ws/f2.ts', '/ws/f3.ts', '/ws/f4.ts', '/ws/f5.ts'];
    for (let i = 0; i < chain.length; i += 1) graph.setFile(must(chain[i]), i === 0 ? [] : [{ key: must(chain[i - 1]), count: 1 }], 'ts');
    const r = analyseImpact({ file: '/ws/f0.ts', graph, allFiles: new Set(chain), indexComplete: true, now: NOW });
    assert.deepEqual(r.directDependants, ['/ws/f1.ts']);
    assert.deepEqual(r.indirectDependants, ['/ws/f2.ts', '/ws/f3.ts']);
  });
});

describe('analyseImpact: reasons are full sentences', () => {
  const reasons = (direct: number, indirect = 0, extra: Partial<Parameters<typeof analyseImpact>[0]> = {}): string[] => {
    const { graph, all } = build(direct, indirect, 1);
    return analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW, ...extra }).reasons;
  };

  it('direct dependants: singular and plural', () => {
    assert.ok(reasons(1).includes('1 file imports this file directly.'));
    assert.ok(reasons(12).includes('12 files import this file directly.'));
    assert.ok(reasons(2).includes('2 files import this file directly.'));
  });

  it('indirect dependants: singular and plural, with the depth', () => {
    assert.ok(reasons(3, 1).includes('1 more file depends on it through other files (up to 3 levels).'));
    assert.ok(reasons(3, 3).includes('3 more files depend on it through other files (up to 3 levels).'));
  });

  it('"No dependants were found." appears only when there are none', () => {
    assert.ok(reasons(0).includes('No dependants were found.'));
    assert.ok(!reasons(1).includes('No dependants were found.'));
  });

  it('every reason is a sentence: starts with a capital or digit and ends with a full stop; none is empty or repeated', () => {
    for (const r of [reasons(0), reasons(1), reasons(30, 5), reasons(300), reasons(2, 0, { indexComplete: false })]) {
      assert.equal(new Set(r).size, r.length, 'no duplicates');
      for (const sentence of r) assert.match(sentence, /^[A-Z0-9].*\.$/, sentence);
    }
  });

  it('reasons never claim a defect: no "break", "bug", "error", "will fail" wording', () => {
    for (const r of [reasons(0), reasons(30, 5), reasons(300), reasons(2, 0, { indexComplete: false })]) {
      for (const sentence of r) assert.doesNotMatch(sentence, /\b(break|breaks|broken|bug|bugs|defect|error|errors|will fail|crash)\b/i, sentence);
    }
  });

  it('an incomplete index adds exactly the documented sentence and marks the result incomplete', () => {
    const { graph, all } = build(2);
    const r = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: false, now: NOW });
    assert.equal(r.complete, false);
    assert.ok(r.reasons.includes('The dependency index is still being built, so this estimate may be low.'));
    assert.equal(r.reasons[r.reasons.length - 1], 'The dependency index is still being built, so this estimate may be low.', 'it comes last');
    const done = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.ok(!done.reasons.some((x) => x.includes('still being built')));
  });

  it('an incomplete index never lowers the level (it is computed from what is known)', () => {
    const { graph, all } = build(10);
    assert.equal(analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: false, now: NOW }).impactLevel, 'high');
  });
});

describe('isConfigFile', () => {
  const yes = [
    '/ws/package.json',
    '/ws/sub/package.json',
    '/ws/tsconfig.json',
    '/ws/tsconfig.base.json',
    '/ws/tsconfig.build.json',
    '/ws/jsconfig.json',
    '/ws/composer.json',
    '/ws/go.mod',
    '/ws/pyproject.toml',
    '/ws/requirements.txt',
    '/ws/requirements-dev.txt',
    '/ws/Dockerfile',
    '/ws/docker-compose.yml',
    '/ws/docker-compose.prod.yml',
    '/ws/.env',
    '/ws/.env.local',
    '/ws/.env.production',
    '/ws/vite.config.ts',
    '/ws/webpack.config.js',
    '/ws/rollup.config.mjs',
    '/ws/jest.config.cjs',
    '/ws/.github/workflows/ci.yml',
    '/ws/.github/workflows/release.yaml',
    '/ws/sub/.github/workflows/x.yml',
  ];
  const no = [
    '/ws/src/a.ts',
    '/ws/package-lock.json',
    '/ws/package.jsonc',
    '/ws/my-package.json',
    '/ws/tsconfig.txt',
    '/ws/tsconfig',
    '/ws/Dockerfile.dev',
    '/ws/docker-compose.json',
    '/ws/requirements.md',
    '/ws/config.ts',
    '/ws/vite.config.json',
    '/ws/app.config.tsx',
    '/ws/go.sum',
    '/ws/github/workflows/ci.yml',
    '/ws/.github/ci.yml',
    '/ws/.github/workflows/sub/ci.yml',
    '/ws/.github/workflows',
    '/ws/README.md',
    '',
  ];
  for (const p of yes) it(`config file: ${p}`, () => assert.equal(isConfigFile(p), true));
  for (const p of no) it(`not a config file: ${JSON.stringify(p)}`, () => assert.equal(isConfigFile(p), false));
});

describe('analyseImpact: configuration files', () => {
  it('a config file is critical on its own, with the documented reason first and configFiles set', () => {
    for (const file of ['/ws/package.json', '/ws/tsconfig.json', '/ws/.env', '/ws/.github/workflows/ci.yml']) {
      const graph = new DepGraph();
      graph.setFile(file, [], 'json');
      const r = analyseImpact({ file, graph, allFiles: new Set([file]), indexComplete: true, now: NOW });
      assert.equal(r.impactLevel, 'critical', file);
      assert.deepEqual(r.configFiles, [file]);
      assert.equal(r.reasons[0], 'This is a project configuration file; changes can affect the whole workspace.');
      assert.ok(r.reasons.includes('No dependants were found.'), 'and still says that nothing imports it');
    }
  });

  it('an ordinary file has no configFiles', () => {
    assert.deepEqual(analyseImpact({ file: TARGET, graph: new DepGraph(), allFiles: new Set(), indexComplete: true, now: NOW }).configFiles, []);
  });

  it('a config file with dependants lists both reasons', () => {
    const graph = new DepGraph();
    graph.setFile('/ws/a.ts', [{ key: '/ws/package.json', count: 1 }], 'ts');
    const r = analyseImpact({ file: '/ws/package.json', graph, allFiles: new Set(['/ws/a.ts']), indexComplete: true, now: NOW });
    assert.equal(r.reasons[0], 'This is a project configuration file; changes can affect the whole workspace.');
    assert.equal(r.reasons[1], '1 file imports this file directly.');
  });
});

describe('analyseImpact: affected tests', () => {
  it('dependants that are test files plus related tests by name, without duplicates, sorted', () => {
    const graph = new DepGraph();
    graph.setFile('/ws/src/util.ts', [], 'ts');
    graph.setFile('/ws/src/util.test.ts', [{ key: '/ws/src/util.ts', count: 1 }], 'ts'); // both a dependant and a related test
    graph.setFile('/ws/test/integration.ts', [{ key: '/ws/src/util.ts', count: 1 }], 'ts'); // a dependant in a test folder
    graph.setFile('/ws/src/app.ts', [{ key: '/ws/src/util.ts', count: 1 }], 'ts'); // not a test
    const all = new Set(['/ws/src/util.ts', '/ws/src/util.test.ts', '/ws/test/integration.ts', '/ws/src/app.ts', '/ws/spec/util.spec.ts']);
    const r = analyseImpact({ file: '/ws/src/util.ts', graph, allFiles: all, indexComplete: true, now: NOW });
    assert.deepEqual(r.affectedTests, ['/ws/spec/util.spec.ts', '/ws/src/util.test.ts', '/ws/test/integration.ts']);
    assert.ok(r.reasons.includes('3 test files are related to this change.'));
  });

  it('one test file: singular wording', () => {
    const graph = new DepGraph();
    graph.setFile('/ws/a.ts', [], 'ts');
    const r = analyseImpact({ file: '/ws/a.ts', graph, allFiles: new Set(['/ws/a.test.ts']), indexComplete: true, now: NOW });
    assert.deepEqual(r.affectedTests, ['/ws/a.test.ts']);
    assert.ok(r.reasons.includes('1 test file is related to this change.'));
  });

  it('roots keep a project below a folder called test from being all tests', () => {
    const graph = new DepGraph();
    graph.setFile('/home/me/test/proj/src/a.ts', [], 'ts');
    graph.setFile('/home/me/test/proj/src/b.ts', [{ key: '/home/me/test/proj/src/a.ts', count: 1 }], 'ts');
    const input = { file: '/home/me/test/proj/src/a.ts', graph, allFiles: new Set(['/home/me/test/proj/src/b.ts']), indexComplete: true, now: NOW };
    assert.deepEqual(analyseImpact(input).affectedTests, ['/home/me/test/proj/src/b.ts'], 'without roots everything below "test" counts as a test (documented limit)');
    assert.deepEqual(analyseImpact({ ...input, roots: ['/home/me/test/proj'] }).affectedTests, []);
  });

  it('no tests: the reasons do not mention tests', () => {
    const { graph, all } = build(3);
    const r = analyseImpact({ file: TARGET, graph, allFiles: all, indexComplete: true, now: NOW });
    assert.ok(!r.reasons.some((x) => /test file/.test(x)));
  });
});
