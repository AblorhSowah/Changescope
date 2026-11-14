// QA-108: relatedTests is now answered from a prebuilt TestIndex. The index must give exactly what a scan of every file gave.
// The reference implementation below is written independently from DESIGN-0.3.0 7.2 (it does not call the product's helpers
// except isTestFile, whose own tests are in testMatch.test.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepGraph } from '../../src/core/intelligence/depGraph';
import { analyseImpact } from '../../src/core/intelligence/impact';
import { buildTestIndex, isTestFile, relatedTests, relatedTestsIn } from '../../src/core/intelligence/testMatch';
import { synthetic } from '../support/synthetic';
import { scaled } from '../support/perfGuard';

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);

function relativeParts(key: string, roots: readonly string[] | undefined): { dirs: string[]; base: string } {
  let path = key;
  if (roots !== undefined) {
    let best: string | undefined;
    for (const r of roots) {
      const rel = key.startsWith(`${r}/`) ? key.slice(r.length + 1) : undefined;
      if (rel !== undefined && rel !== '' && (best === undefined || rel.length < best.length)) best = rel;
    }
    if (best !== undefined) path = best;
  }
  const segs = path.split('/').filter((s) => s !== '');
  const base = segs.pop() ?? '';
  return { dirs: segs, base };
}

function refMarked(base: string): string | undefined {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  const stem = base.slice(0, dot);
  const infix = /^(.+)\.(?:test|spec)$/i.exec(stem);
  if (infix) return infix[1];
  if (ext === '.go' && stem.endsWith('_test') && stem.length > 5) return stem.slice(0, -5);
  if (ext === '.py' && stem.startsWith('test_') && stem.length > 5) return stem.slice(5);
  if (ext === '.py' && stem.endsWith('_test') && stem.length > 5) return stem.slice(0, -5);
  if (['.php', '.java', '.kt'].includes(ext) && stem.endsWith('Test') && stem.length > 4) return stem.slice(0, -4);
  return undefined;
}

const refPlain = (base: string): string => {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
};

function refRelated(key: string, all: readonly string[], roots: readonly string[] | undefined, max: number): string[] {
  if (isTestFile(key, roots)) return [];
  const own = relativeParts(key, roots);
  const stem = refPlain(own.base);
  if (stem === '') return [];
  const found: Array<{ key: string; d: number }> = [];
  for (const candidate of all) {
    if (candidate === key) continue;
    const c = relativeParts(candidate, roots);
    const cStem = refMarked(c.base) ?? (c.dirs.some((d) => TEST_DIRS.has(d)) ? refPlain(c.base) : undefined);
    if (cStem !== stem) continue;
    let common = 0;
    while (common < own.dirs.length && common < c.dirs.length && own.dirs[common] === c.dirs[common]) common += 1;
    found.push({ key: candidate, d: own.dirs.length - common + (c.dirs.length - common) });
  }
  found.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return found.slice(0, Math.max(0, max)).map((f) => f.key);
}

function rngOf(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

function randomFiles(r: (n: number) => number, count: number): string[] {
  const stems = ['util', 'app', 'main', 'foo', 'Bar', 'x', 'a.b', 'index', 'Foo'];
  const dirs = ['', 'src', 'test', 'tests', '__tests__', 'spec', 'src/lib', 'lib/test', 'a/b/c', 'pkg/src', 'pkg/tests', 'deep/er/test/x'];
  const names = (stem: string): string[] => [`${stem}.ts`, `${stem}.js`, `${stem}.test.ts`, `${stem}.spec.js`, `${stem}.TEST.ts`, `${stem}_test.go`, `test_${stem}.py`, `${stem}_test.py`, `${stem}Test.php`, `${stem}Test.java`, `${stem}Test.kt`, `${stem}.py`, `${stem}.go`, `${stem}.md`, stem];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const stem = stems[r(stems.length)] as string;
    const list = names(stem);
    const dir = dirs[r(dirs.length)] as string;
    out.push(`/ws/${dir === '' ? '' : `${dir}/`}${list[r(list.length)]}`);
  }
  return out;
}

describe('TestIndex: lookups equal a scan of every file', () => {
  const rootSets: Array<readonly string[] | undefined> = [undefined, ['/ws'], ['/ws', '/ws/pkg'], ['/elsewhere'], []];

  it('4,000 random lookups over random file sets, with and without roots, with every `max`', () => {
    const r = rngOf(2025);
    let lookups = 0;
    let nonEmpty = 0;
    for (let round = 0; round < 40; round += 1) {
      const files = randomFiles(r, 60 + r(120));
      const roots = rootSets[r(rootSets.length)];
      const index = buildTestIndex(files, roots);
      for (let q = 0; q < 100; q += 1) {
        const key = r(8) === 0 ? '/ws/not/in/the/set.ts' : (files[r(files.length)] as string);
        const max = [0, 1, 3, 10, 12][r(5)] as number;
        const want = refRelated(key, files, roots, max);
        assert.deepEqual(relatedTestsIn(index, key, max), want, `index: ${key} roots=${JSON.stringify(roots)} max=${max}`);
        assert.deepEqual(relatedTests(key, files, roots, max), want, `scan API: ${key}`);
        lookups += 1;
        if (want.length > 0) nonEmpty += 1;
      }
    }
    assert.equal(lookups, 4000);
    assert.ok(nonEmpty > 300, `only ${nonEmpty} lookups found tests, so the comparison is not vacuous`);
  });

  it('the default max is 10', () => {
    const files = Array.from({ length: 30 }, (_, i) => `/ws/t${i}/util.test.ts`);
    assert.equal(relatedTestsIn(buildTestIndex(files), '/ws/util.ts').length, 10);
    assert.equal(relatedTestsIn(buildTestIndex(files), '/ws/util.ts', 3).length, 3);
    assert.deepEqual(relatedTestsIn(buildTestIndex(files), '/ws/util.ts', 0), []);
    assert.deepEqual(relatedTestsIn(buildTestIndex(files), '/ws/util.ts', -2), []);
  });

  it('one index serves many lookups and is not changed by them', () => {
    const files = ['/ws/src/util.ts', '/ws/src/util.test.ts', '/ws/test/util.test.ts', '/ws/src/app.ts', '/ws/src/app.spec.ts'];
    const index = buildTestIndex(files);
    const before = JSON.stringify([...index.byStem]);
    const first = relatedTestsIn(index, '/ws/src/util.ts');
    for (let i = 0; i < 50; i += 1) assert.deepEqual(relatedTestsIn(index, '/ws/src/util.ts'), first);
    assert.deepEqual(relatedTestsIn(index, '/ws/src/app.ts'), ['/ws/src/app.spec.ts']);
    assert.equal(JSON.stringify([...index.byStem]), before);
    assert.deepEqual(first, ['/ws/src/util.test.ts', '/ws/test/util.test.ts']);
  });

  it('groups by stem: only test files are in the index, and the stems are the unmarked names', () => {
    const index = buildTestIndex(['/ws/a.ts', '/ws/a.test.ts', '/ws/b.spec.js', '/ws/test/c.ts', '/ws/pkg_test.go', '/ws/d.ts']);
    assert.deepEqual([...index.byStem.keys()].sort(), ['a', 'b', 'c', 'pkg']);
    assert.deepEqual(index.byStem.get('c')?.map((e) => e.key), ['/ws/test/c.ts']);
  });

  it('a test file asks for nothing; the file itself and duplicates in the input are handled like the scan', () => {
    const files = ['/ws/util.test.ts', '/ws/util.test.ts', '/ws/util.ts'];
    const index = buildTestIndex(files);
    assert.deepEqual(relatedTestsIn(index, '/ws/util.test.ts'), []);
    assert.deepEqual(relatedTestsIn(index, '/ws/util.ts'), refRelated('/ws/util.ts', files, undefined, 10));
  });

  it('a file with no stem (dotfile) or no tests gives nothing; an empty index gives nothing', () => {
    const index = buildTestIndex(['/ws/a.test.ts']);
    assert.deepEqual(relatedTestsIn(index, '/ws/.env'), []);
    assert.deepEqual(relatedTestsIn(index, '/ws/zzz.ts'), []);
    assert.deepEqual(relatedTestsIn(buildTestIndex([]), '/ws/a.ts'), []);
  });

  it('accepts a Set and a one-shot generator', () => {
    const set = new Set(['/ws/util.test.ts', '/ws/util.ts']);
    assert.deepEqual(relatedTestsIn(buildTestIndex(set), '/ws/util.ts'), ['/ws/util.test.ts']);
    function* gen(): Generator<string> {
      yield '/ws/util.test.ts';
      yield '/ws/other.ts';
    }
    assert.deepEqual(relatedTestsIn(buildTestIndex(gen()), '/ws/util.ts'), ['/ws/util.test.ts']);
  });

  it('the index remembers the roots it was built with and uses them for the lookup key as well', () => {
    const files = ['/home/me/test/proj/src/util.test.ts', '/home/me/test/proj/src/util.ts'];
    const withRoots = buildTestIndex(files, ['/home/me/test/proj']);
    assert.deepEqual(withRoots.roots, ['/home/me/test/proj']);
    assert.deepEqual(relatedTestsIn(withRoots, '/home/me/test/proj/src/util.ts'), ['/home/me/test/proj/src/util.test.ts']);
    // without roots the whole project is "below a folder called test", so util.ts itself is a test and has none
    assert.deepEqual(relatedTestsIn(buildTestIndex(files), '/home/me/test/proj/src/util.ts'), []);
  });

  it('nearest directory first, ties by path (same order as before the index)', () => {
    const files = ['/ws/lib/deep/util.test.ts', '/ws/src/util.test.ts', '/ws/src/util.spec.ts', '/ws/test/util.test.ts'];
    assert.deepEqual(relatedTestsIn(buildTestIndex(files), '/ws/src/util.ts'), ['/ws/src/util.spec.ts', '/ws/src/util.test.ts', '/ws/test/util.test.ts', '/ws/lib/deep/util.test.ts']);
  });
});

describe('analyseImpact with a prebuilt testIndex', () => {
  it('the result is identical with and without the index, for 150 files of a synthetic 2,000 file workspace, with and without roots', () => {
    const s = synthetic(2000);
    const roots = ['/ws/proj'];
    for (const withRoots of [undefined, roots]) {
      const index = buildTestIndex(s.allFiles, withRoots);
      for (let i = 0; i < 150; i += 1) {
        const file = s.files[(i * 13) % s.files.length] as string;
        const base = { file, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: 1, ...(withRoots ? { roots: withRoots } : {}) };
        assert.deepEqual(analyseImpact({ ...base, testIndex: index }), analyseImpact(base), `${file} roots=${JSON.stringify(withRoots)}`);
      }
    }
  });

  it('related tests come from the index, not from allFiles (a stale or different index wins): the cache of the host is only as fresh as its rebuild', () => {
    const graph = new DepGraph();
    graph.setFile('/ws/a.ts', [], 'ts');
    const fresh = buildTestIndex(['/ws/a.test.ts']);
    const r = analyseImpact({ file: '/ws/a.ts', graph, allFiles: new Set(['/ws/a.ts', '/ws/a.spec.ts']), indexComplete: true, now: 1, testIndex: fresh });
    assert.deepEqual(r.affectedTests, ['/ws/a.test.ts']);
    const noIndex = analyseImpact({ file: '/ws/a.ts', graph, allFiles: new Set(['/ws/a.ts', '/ws/a.spec.ts']), indexComplete: true, now: 1 });
    assert.deepEqual(noIndex.affectedTests, ['/ws/a.spec.ts']);
  });

  it('dependants that are tests are still found without the index (that part never used it)', () => {
    const graph = new DepGraph();
    graph.setFile('/ws/a.ts', [], 'ts');
    graph.setFile('/ws/x.test.ts', [{ key: '/ws/a.ts', count: 1 }], 'ts');
    const r = analyseImpact({ file: '/ws/a.ts', graph, allFiles: new Set(['/ws/a.ts', '/ws/x.test.ts']), indexComplete: true, now: 1, testIndex: buildTestIndex([]) });
    assert.deepEqual(r.affectedTests, ['/ws/x.test.ts']);
  });

  it('with a prebuilt index 50 impacts at 10,000 files stay under 100 ms (regression guard; the scan needed about 111 ms, the index about 2 ms)', () => {
    const s = synthetic(10_000);
    const index = buildTestIndex(s.allFiles);
    let best = Infinity;
    for (let run = 0; run < 5; run += 1) {
      const t0 = performance.now();
      for (let i = 0; i < 50; i += 1) analyseImpact({ file: s.files[i * 7] as string, graph: s.graph, allFiles: s.allFiles, indexComplete: true, now: 1, testIndex: index });
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < scaled(100), `${best.toFixed(1)} ms`);
  });
});
