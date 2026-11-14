import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepGraph, relationshipConfidence, targetsFromReference } from '../../src/core/intelligence/depGraph';
import type { ReferenceResult, ReferenceTarget } from '../../src/core/types';
import { must } from '../support/fixtures';

const k = (n: string): string => `/ws/${n}.ts`;

/** a -> b means "a imports b". */
function graph(edges: Array<[string, string]>): DepGraph {
  const g = new DepGraph();
  const out = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = out.get(from) ?? [];
    list.push(to);
    out.set(from, list);
    if (!out.has(to)) out.set(to, []);
  }
  for (const [from, tos] of out) g.setFile(k(from), tos.map((t) => ({ key: k(t), count: 1 })), 'ts');
  return g;
}

describe('DepGraph: forward and reverse edges', () => {
  it('starts empty', () => {
    const g = new DepGraph();
    assert.equal(g.fileCount, 0);
    assert.equal(g.edgeCount, 0);
    assert.equal(g.has(k('a')), false);
    assert.deepEqual(g.importsOf(k('a')), []);
    assert.deepEqual(g.importedBy(k('a')), []);
    assert.deepEqual(g.relationships(), []);
    assert.deepEqual(g.dependants(k('a'), 3, 200), { direct: [], indirect: [], truncated: false });
  });

  it('setFile records forward edges and the matching reverse edges', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('b'), count: 3 }, { key: k('c'), count: 1 }], 'ts');
    assert.deepEqual(g.importsOf(k('a')), [
      { key: k('b'), count: 3, relationshipType: 'import' },
      { key: k('c'), count: 1, relationshipType: 'import' },
    ]);
    assert.deepEqual(g.importedBy(k('b')), [{ key: k('a'), count: 3, relationshipType: 'import' }]);
    assert.deepEqual(g.importedBy(k('c')), [{ key: k('a'), count: 1, relationshipType: 'import' }]);
    assert.equal(g.edgeCount, 2);
    assert.equal(g.fileCount, 1, 'only analysed files are counted; targets are not');
    assert.equal(g.has(k('a')), true);
    assert.equal(g.has(k('b')), false);
  });

  it('a file with no targets is still a known (analysed) file', () => {
    const g = new DepGraph();
    g.setFile(k('leaf'), [], 'ts');
    assert.equal(g.has(k('leaf')), true);
    assert.equal(g.fileCount, 1);
    assert.equal(g.edgeCount, 0);
  });

  it('importsOf and importedBy are sorted by count (most first), then by path', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('z'), count: 1 }, { key: k('m'), count: 5 }, { key: k('b'), count: 1 }], 'ts');
    assert.deepEqual(
      g.importsOf(k('a')).map((e) => e.key),
      [k('m'), k('b'), k('z')],
    );
    const h = new DepGraph();
    h.setFile(k('x'), [{ key: k('t'), count: 2 }], 'ts');
    h.setFile(k('y'), [{ key: k('t'), count: 9 }], 'ts');
    h.setFile(k('w'), [{ key: k('t'), count: 2 }], 'ts');
    assert.deepEqual(
      h.importedBy(k('t')).map((e) => e.key),
      [k('y'), k('w'), k('x')],
    );
  });

  it('the relationship type defaults to import and an explicit one is kept', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('b'), count: 1, relationshipType: 'export' }, { key: k('c'), count: 1, relationshipType: 'reference' }, { key: k('d'), count: 1 }], 'ts');
    const types = Object.fromEntries(g.importsOf(k('a')).map((e) => [e.key, e.relationshipType]));
    assert.deepEqual(types, { [k('b')]: 'export', [k('c')]: 'reference', [k('d')]: 'import' });
  });

  it('a self reference is ignored (no self edge, no self dependant)', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('a'), count: 4 }, { key: k('b'), count: 1 }], 'ts');
    assert.equal(g.edgeCount, 1);
    assert.deepEqual(g.importedBy(k('a')), []);
    assert.deepEqual(g.dependants(k('a'), 3, 200), { direct: [], indirect: [], truncated: false });
  });

  it('empty target keys are ignored; bad counts become 1', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: '', count: 1 }, { key: k('b'), count: Number.NaN }, { key: k('c'), count: -4 }, { key: k('d'), count: 0 }, { key: k('e'), count: Infinity }], 'ts');
    assert.deepEqual(
      g.importsOf(k('a')).map((e) => [e.key, e.count]),
      [
        [k('b'), 1],
        [k('c'), 1],
        [k('d'), 1],
        [k('e'), 1],
      ],
    );
    assert.equal(g.edgeCount, 4);
  });

  it('the same target listed twice is one edge with the counts added', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('b'), count: 2 }, { key: k('b'), count: 3 }], 'ts');
    assert.equal(g.edgeCount, 1);
    assert.equal(must(g.importsOf(k('a'))[0]).count, 5);
    assert.equal(g.importedBy(k('b')).length, 1);
  });

  it('relationships() lists every edge sorted by source then target, with the language and a confidence', () => {
    const g = new DepGraph();
    g.setFile(k('b'), [{ key: k('z'), count: 1 }, { key: k('a'), count: 1, relationshipType: 'reference' }], 'css');
    g.setFile(k('a'), [{ key: k('b'), count: 1, relationshipType: 'export' }], 'ts');
    const rels = g.relationships();
    assert.deepEqual(
      rels.map((r) => `${r.sourceFile}>${r.targetFile}`),
      [`${k('a')}>${k('b')}`, `${k('b')}>${k('a')}`, `${k('b')}>${k('z')}`],
    );
    assert.deepEqual(rels.map((r) => r.language), ['ts', 'css', 'css']);
    assert.deepEqual(rels.map((r) => r.confidence), [0.8, 0.6, 0.8]);
    assert.deepEqual(rels.map((r) => r.relationshipType), ['export', 'reference', 'import']);
  });

  it('relationshipConfidence: 0.8 import and export, 0.6 reference, 0.5 anything else', () => {
    assert.equal(relationshipConfidence('import'), 0.8);
    assert.equal(relationshipConfidence('export'), 0.8);
    assert.equal(relationshipConfidence('reference'), 0.6);
    assert.equal(relationshipConfidence('inheritance'), 0.5);
    assert.equal(relationshipConfidence('unknown'), 0.5);
  });
});

describe('DepGraph: replacing, removing, clearing', () => {
  it('setFile replaces the outgoing edges of that file and nothing else', () => {
    const g = graph([['a', 'b'], ['a', 'c'], ['x', 'c']]);
    g.setFile(k('a'), [{ key: k('d'), count: 1 }], 'ts');
    assert.deepEqual(g.importsOf(k('a')).map((e) => e.key), [k('d')]);
    assert.deepEqual(g.importedBy(k('b')), [], 'the dropped edge left the reverse index');
    assert.deepEqual(g.importedBy(k('c')).map((e) => e.key), [k('x')], 'x still imports c');
    assert.deepEqual(g.importedBy(k('d')).map((e) => e.key), [k('a')]);
    assert.equal(g.edgeCount, 2, 'a>d and x>c');
  });

  it('replacing with the same list changes nothing, however often it is repeated (the edge count does not drift)', () => {
    const g = new DepGraph();
    for (let i = 0; i < 50; i += 1) g.setFile(k('a'), [{ key: k('b'), count: 2 }, { key: k('c'), count: 1 }], 'ts');
    assert.equal(g.edgeCount, 2);
    assert.equal(g.importedBy(k('b')).length, 1);
    assert.equal(g.fileCount, 1);
  });

  it('replacing with an empty list removes all edges but keeps the file known', () => {
    const g = graph([['a', 'b'], ['a', 'c']]);
    g.setFile(k('a'), [], 'ts');
    assert.equal(g.edgeCount, 0);
    assert.equal(g.has(k('a')), true);
    assert.deepEqual(g.importedBy(k('b')), []);
  });

  it('a later setFile may change the language', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('b'), count: 1 }], 'ts');
    g.setFile(k('a'), [{ key: k('b'), count: 1 }], 'js');
    assert.equal(must(g.relationships()[0]).language, 'js');
  });

  it('removeFile drops the file, its outgoing edges and every edge that points at it', () => {
    const g = graph([['a', 'b'], ['b', 'c'], ['d', 'b']]);
    g.removeFile(k('b'));
    assert.equal(g.has(k('b')), false);
    assert.deepEqual(g.importsOf(k('a')), []);
    assert.deepEqual(g.importsOf(k('d')), []);
    assert.deepEqual(g.importedBy(k('c')), []);
    assert.deepEqual(g.importedBy(k('b')), []);
    assert.equal(g.edgeCount, 0);
    assert.equal(g.has(k('a')), true, 'importers stay known');
  });

  it('removing an unknown file is a no-op', () => {
    const g = graph([['a', 'b']]);
    g.removeFile(k('nothing'));
    assert.equal(g.edgeCount, 1);
    assert.equal(g.fileCount, 2);
  });

  it('removeFile of a leaf that is only a target (never analysed) removes the incoming edges', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('ghost'), count: 1 }], 'ts');
    g.removeFile(k('ghost'));
    assert.equal(g.edgeCount, 0);
    assert.deepEqual(g.importsOf(k('a')), []);
  });

  it('removeFile keeps the edge count exact when files import each other', () => {
    const g = graph([['a', 'b'], ['b', 'a'], ['a', 'c'], ['c', 'a']]);
    assert.equal(g.edgeCount, 4);
    g.removeFile(k('a'));
    assert.equal(g.edgeCount, 0);
    assert.equal(g.fileCount, 2);
  });

  it('removeUnder removes a folder and everything below it, and returns how many analysed files were among them', () => {
    const g = new DepGraph();
    g.setFile('/ws/src/a.ts', [{ key: '/ws/src/b.ts', count: 1 }, { key: '/ws/lib/x.ts', count: 1 }], 'ts');
    g.setFile('/ws/src/b.ts', [], 'ts');
    g.setFile('/ws/src/deep/c.ts', [{ key: '/ws/lib/x.ts', count: 1 }], 'ts');
    g.setFile('/ws/lib/x.ts', [{ key: '/ws/src/a.ts', count: 1 }], 'ts');
    g.setFile('/ws/srcother/y.ts', [{ key: '/ws/src/a.ts', count: 1 }], 'ts');
    assert.equal(g.removeUnder('/ws/src'), 3);
    assert.equal(g.has('/ws/src/a.ts'), false);
    assert.equal(g.has('/ws/src/deep/c.ts'), false);
    assert.equal(g.has('/ws/lib/x.ts'), true);
    assert.equal(g.has('/ws/srcother/y.ts'), true, 'a sibling sharing a prefix stays');
    assert.deepEqual(g.importsOf('/ws/lib/x.ts'), []);
    assert.deepEqual(g.importsOf('/ws/srcother/y.ts'), []);
    assert.deepEqual(g.importedBy('/ws/lib/x.ts'), []);
    assert.equal(g.edgeCount, 0);
  });

  it('removeUnder also forgets target-only entries below the prefix', () => {
    const g = new DepGraph();
    g.setFile('/ws/a.ts', [{ key: '/ws/gone/ghost.ts', count: 1 }], 'ts');
    assert.equal(g.removeUnder('/ws/gone'), 0);
    assert.equal(g.edgeCount, 0);
    assert.deepEqual(g.importsOf('/ws/a.ts'), []);
  });

  it('removeUnder with an empty prefix does nothing; removing a single file path works too', () => {
    const g = graph([['a', 'b']]);
    assert.equal(g.removeUnder(''), 0);
    assert.equal(g.edgeCount, 1);
    assert.equal(g.removeUnder(k('a')), 1);
    assert.equal(g.has(k('a')), false);
  });

  it('clear empties everything', () => {
    const g = graph([['a', 'b'], ['b', 'c']]);
    g.clear();
    assert.equal(g.fileCount, 0);
    assert.equal(g.edgeCount, 0);
    assert.deepEqual(g.relationships(), []);
    assert.deepEqual(g.dependants(k('c'), 3, 100), { direct: [], indirect: [], truncated: false });
  });

  it('files() lists the analysed files', () => {
    const g = graph([['a', 'b']]);
    assert.deepEqual([...g.files()].sort(), [k('a'), k('b')]);
  });
});

describe('DepGraph.dependants: breadth-first over reverse edges', () => {
  it('direct at distance 1, indirect at 2..maxDepth, sorted', () => {
    // d -> c -> b -> a ; x -> a
    const g = graph([['b', 'a'], ['c', 'b'], ['d', 'c'], ['x', 'a']]);
    assert.deepEqual(g.dependants(k('a'), 3, 200), { direct: [k('b'), k('x')], indirect: [k('c'), k('d')], truncated: false });
    assert.deepEqual(g.dependants(k('a'), 2, 200), { direct: [k('b'), k('x')], indirect: [k('c')], truncated: false });
    assert.deepEqual(g.dependants(k('a'), 1, 200), { direct: [k('b'), k('x')], indirect: [], truncated: false });
  });

  it('depth limit: a dependant at distance maxDepth+1 is not reported and is not "truncated" (that flag is for the node cap)', () => {
    const chain: Array<[string, string]> = [];
    for (let i = 0; i < 6; i += 1) chain.push([`f${i + 1}`, `f${i}`]);
    const g = graph(chain);
    const r = g.dependants(k('f0'), 3, 200);
    assert.deepEqual(r.direct, [k('f1')]);
    assert.deepEqual(r.indirect, [k('f2'), k('f3')]);
    assert.equal(r.truncated, false);
  });

  it('maxDepth below 1 (0, negative, NaN) returns nothing', () => {
    const g = graph([['b', 'a']]);
    for (const d of [0, -1, Number.NaN, 0.9]) assert.deepEqual(g.dependants(k('a'), d, 200), { direct: [], indirect: [], truncated: false }, String(d));
  });

  it('a fractional depth is floored', () => {
    const g = graph([['b', 'a'], ['c', 'b'], ['d', 'c']]);
    assert.equal(g.dependants(k('a'), 2.9, 200).indirect.length, 1);
  });

  it('cycles: the search terminates and every file is listed once', () => {
    const g = graph([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']]);
    const r = g.dependants(k('a'), 10, 200);
    assert.deepEqual(r.direct, [k('c')]);
    assert.deepEqual(r.indirect, [k('b')]);
    assert.equal(r.truncated, false);
    // a is in a cycle with itself but is never its own dependant
    assert.ok(![...r.direct, ...r.indirect].includes(k('a')));
  });

  it('a self edge cannot exist, so a file never lists itself', () => {
    const g = new DepGraph();
    g.setFile(k('a'), [{ key: k('a'), count: 1 }], 'ts');
    assert.deepEqual(g.dependants(k('a'), 3, 200).direct, []);
  });

  it('a diamond lists the shared dependant once, at its shortest distance', () => {
    // top -> left -> base ; top -> right -> base ; top -> base (direct too)
    const g = graph([['left', 'base'], ['right', 'base'], ['top', 'left'], ['top', 'right'], ['top', 'base']]);
    const r = g.dependants(k('base'), 3, 200);
    assert.deepEqual(r.direct, [k('left'), k('right'), k('top')]);
    assert.deepEqual(r.indirect, []);
  });

  it('node cap: stops at maxNodes, direct first, and reports truncation', () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 10; i += 1) edges.push([`d${i}`, 'hub']);
    for (let i = 0; i < 10; i += 1) edges.push([`i${i}`, 'd0']);
    const g = graph(edges);
    const r = g.dependants(k('hub'), 3, 12);
    assert.equal(r.direct.length, 10, 'direct dependants always come first');
    assert.equal(r.indirect.length, 2);
    assert.equal(r.truncated, true);
    const none = g.dependants(k('hub'), 3, 0);
    assert.deepEqual(none.direct, []);
    assert.equal(none.truncated, true);
  });

  it('exactly maxNodes dependants is NOT truncated; one more is', () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 5; i += 1) edges.push([`d${i}`, 'hub']);
    const g = graph(edges);
    assert.equal(g.dependants(k('hub'), 3, 5).truncated, false);
    assert.equal(g.dependants(k('hub'), 3, 5).direct.length, 5);
    assert.equal(g.dependants(k('hub'), 3, 4).truncated, true);
    assert.equal(g.dependants(k('hub'), 3, 4).direct.length, 4);
  });

  it('maxNodes of 200 on a 1000-file fan-in gives exactly 200 and truncated (the IMPACT limits)', () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 1000; i += 1) edges.push([`d${i}`, 'hub']);
    const r = graph(edges).dependants(k('hub'), 3, 200);
    assert.equal(r.direct.length, 200);
    assert.equal(r.truncated, true);
  });

  it('a negative or NaN maxNodes returns nothing and says truncated when there was something to find', () => {
    const g = graph([['b', 'a']]);
    for (const n of [-5, Number.NaN]) {
      const r = g.dependants(k('a'), 3, n);
      assert.deepEqual(r.direct, []);
      assert.equal(r.truncated, true);
    }
  });

  it('an unknown file or a file nobody imports has no dependants', () => {
    const g = graph([['a', 'b']]);
    assert.deepEqual(g.dependants(k('unknown'), 3, 200), { direct: [], indirect: [], truncated: false });
    assert.deepEqual(g.dependants(k('a'), 3, 200), { direct: [], indirect: [], truncated: false });
  });

  it('follows changes: after setFile removes an edge the dependant disappears; after removeFile the chain is cut', () => {
    const g = graph([['b', 'a'], ['c', 'b']]);
    assert.equal(g.dependants(k('a'), 3, 200).indirect.length, 1);
    g.setFile(k('b'), [], 'ts');
    assert.deepEqual(g.dependants(k('a'), 3, 200), { direct: [], indirect: [], truncated: false });
    g.setFile(k('b'), [{ key: k('a'), count: 1 }], 'ts');
    g.removeFile(k('c'));
    assert.deepEqual(g.dependants(k('a'), 3, 200).indirect, []);
  });

  it('the result does not alias internal state', () => {
    const g = graph([['b', 'a']]);
    const r = g.dependants(k('a'), 3, 200);
    r.direct.push('/hacked');
    assert.deepEqual(g.dependants(k('a'), 3, 200).direct, [k('b')]);
    const imp = g.importsOf(k('b'));
    imp.pop();
    assert.equal(g.importsOf(k('b')).length, 1);
  });

  it('property: for random graphs every reported dependant really reaches the file within the depth, and none is missed', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 40; round += 1) {
      const n = 4 + rnd(14);
      const edges: Array<[string, string]> = [];
      for (let i = 0; i < n * 2; i += 1) edges.push([`n${rnd(n)}`, `n${rnd(n)}`]);
      const g = new DepGraph();
      const forward = new Map<string, Set<string>>();
      for (const [a, b] of edges) {
        if (a === b) continue;
        const set = forward.get(a) ?? new Set<string>();
        set.add(b);
        forward.set(a, set);
      }
      for (let i = 0; i < n; i += 1) g.setFile(k(`n${i}`), [...(forward.get(`n${i}`) ?? [])].map((t) => ({ key: k(t), count: 1 })), 'ts');
      const target = `n${rnd(n)}`;
      const depth = 1 + rnd(4);
      // reference: plain BFS by distance
      const dist = new Map<string, number>([[target, 0]]);
      let frontier = [target];
      for (let d = 1; d <= depth; d += 1) {
        const next: string[] = [];
        for (const t of frontier) {
          for (const [src, tos] of forward) {
            if (tos.has(t) && !dist.has(src)) {
              dist.set(src, d);
              next.push(src);
            }
          }
        }
        frontier = next;
      }
      const wantDirect = [...dist].filter(([, d]) => d === 1).map(([x]) => k(x)).sort();
      const wantIndirect = [...dist].filter(([, d]) => d >= 2).map(([x]) => k(x)).sort();
      const got = g.dependants(k(target), depth, 1000);
      assert.deepEqual(got.direct, wantDirect, `round ${round} direct`);
      assert.deepEqual(got.indirect, wantIndirect, `round ${round} indirect`);
      assert.equal(got.truncated, false);
    }
  });
});

describe('targetsFromReference: relationship types from the analysed statements', () => {
  const target = (key: string, kinds?: ReferenceTarget['kinds']): ReferenceTarget => ({
    key,
    count: 2,
    statements: 1,
    usages: 1,
    lines: [1],
    specifiers: ['./x'],
    ...(kinds !== undefined ? { kinds } : {}),
  });
  const result = (language: ReferenceResult['language'], targets: ReferenceTarget[]): ReferenceResult => ({ source: '/ws/a.ts', language, targets, truncated: false, unresolved: 0, parseMs: 1 });

  it('export when EVERY statement is a re-export, import as soon as one is not', () => {
    const t = targetsFromReference(
      result('ts', [target('/ws/a', ['export-from']), target('/ws/b', ['export-from', 'export-from']), target('/ws/c', ['export-from', 'import']), target('/ws/d', ['import']), target('/ws/e', []), target('/ws/f')]),
    );
    assert.deepEqual(
      t.map((x) => x.relationshipType),
      ['export', 'export', 'import', 'import', 'import', 'import'],
    );
    assert.deepEqual(
      t.map((x) => x.count),
      [2, 2, 2, 2, 2, 2],
    );
  });

  it('HTML, Markdown and stylesheet links are references, whatever their statement kinds', () => {
    for (const language of ['html', 'markdown', 'css', 'scss', 'less'] as const) {
      assert.equal(must(targetsFromReference(result(language, [target('/ws/x', ['export-from'])]))[0]).relationshipType, 'reference', language);
    }
  });

  it('an unknown language (undefined) is treated as code', () => {
    assert.equal(must(targetsFromReference(result(undefined, [target('/ws/x')]))[0]).relationshipType, 'import');
  });

  it('feeding the result into a graph gives edges whose types match', () => {
    const g = new DepGraph();
    g.setFile('/ws/a.ts', targetsFromReference(result('ts', [target('/ws/b.ts', ['export-from']), target('/ws/c.ts', ['import'])])), 'ts');
    assert.deepEqual(
      g.relationships().map((r) => [r.targetFile, r.relationshipType, r.confidence]),
      [
        ['/ws/b.ts', 'export', 0.8],
        ['/ws/c.ts', 'import', 0.8],
      ],
    );
  });
});

describe('DepGraph: defects found by probing, now fixed (see docs/QA_REPORT.md)', () => {
  it('[QA-103] two edges to one target keep a relationship type that does not depend on their order', () => {
    const one = new DepGraph();
    one.setFile(k('a'), [{ key: k('t'), count: 1, relationshipType: 'export' }, { key: k('t'), count: 1, relationshipType: 'import' }], 'ts');
    const two = new DepGraph();
    two.setFile(k('a'), [{ key: k('t'), count: 1, relationshipType: 'import' }, { key: k('t'), count: 1, relationshipType: 'export' }], 'ts');
    assert.equal(must(one.importsOf(k('a'))[0]).relationshipType, must(two.importsOf(k('a'))[0]).relationshipType);
    assert.equal(must(one.importsOf(k('a'))[0]).relationshipType, 'import', 'DESIGN 7.1: export only when every statement is export-from');
  });

  it('[QA-103] the precedence is import > reference > inheritance > export > unknown, in every order of every pair, and counts still add up', () => {
    const order = ['import', 'reference', 'inheritance', 'export', 'unknown'] as const;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        for (const swap of [false, true]) {
          const a = must(order[i]);
          const b = must(order[j]);
          const entries = [{ key: k('t'), count: 2, relationshipType: a }, { key: k('t'), count: 3, relationshipType: b }];
          const g = new DepGraph();
          g.setFile(k('s'), swap ? entries.reverse() : entries, 'ts');
          const edge = must(g.importsOf(k('s'))[0]);
          assert.equal(edge.relationshipType, order[Math.min(i, j)], `${a} + ${b}${swap ? ' (swapped)' : ''}`);
          assert.equal(edge.count, 5);
          assert.equal(g.edgeCount, 1);
          assert.equal(must(g.importedBy(k('t'))[0]).relationshipType, edge.relationshipType, 'both directions agree');
        }
      }
    }
  });

  it('[QA-103] an edge with no explicit type counts as import; three duplicates resolve like two', () => {
    const g = new DepGraph();
    g.setFile(k('s'), [{ key: k('t'), count: 1, relationshipType: 'export' }, { key: k('t'), count: 1 }, { key: k('t'), count: 1, relationshipType: 'reference' }], 'ts');
    assert.equal(must(g.importsOf(k('s'))[0]).relationshipType, 'import');
    const h = new DepGraph();
    h.setFile(k('s'), [{ key: k('t'), count: 1, relationshipType: 'export' }, { key: k('t'), count: 1, relationshipType: 'unknown' }, { key: k('t'), count: 1, relationshipType: 'export' }], 'ts');
    assert.equal(must(h.importsOf(k('s'))[0]).relationshipType, 'export');
  });

  it('[QA-102] dependants() with an unbounded depth or node limit (Infinity) finds the dependants', () => {
    const g = graph([['b', 'a'], ['c', 'b']]);
    assert.deepEqual(g.dependants(k('a'), Number.POSITIVE_INFINITY, 200).direct, [k('b')]);
    const r = g.dependants(k('a'), 3, Number.POSITIVE_INFINITY);
    assert.deepEqual(r.direct, [k('b')]);
    assert.equal(r.truncated, false);
  });

  it('[QA-102] unbounded means unbounded: a long chain is followed to its end, cycles do not loop, self edges are ignored, and both limits at once work', () => {
    const edges: Array<[string, string]> = [];
    for (let i = 1; i <= 60; i += 1) edges.push([`n${i}`, `n${i - 1}`]);
    edges.push(['n0', 'n60']); // closes the cycle
    const g = graph(edges);
    const all = g.dependants(k('n0'), Infinity, Infinity);
    assert.equal(all.direct.length, 1);
    assert.equal(all.indirect.length, 59, 'everything on the cycle except the file itself');
    assert.equal(all.truncated, false);
    assert.ok(![...all.direct, ...all.indirect].includes(k('n0')));
    assert.equal(g.dependants(k('n0'), Infinity, 10).truncated, true, 'an unbounded depth still honours a finite node limit');
    assert.equal(g.dependants(k('n0'), 3, Infinity).indirect.length, 2, 'an unbounded node limit still honours a finite depth');
  });

  it('[QA-102] NaN, negative and non-numeric limits still mean none; -Infinity means none', () => {
    const g = graph([['b', 'a']]);
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY, '3' as unknown as number, null as unknown as number, undefined as unknown as number]) {
      assert.deepEqual(g.dependants(k('a'), bad, 200).direct, [], `depth ${String(bad)}`);
      assert.deepEqual(g.dependants(k('a'), 3, bad).direct, [], `nodes ${String(bad)}`);
    }
  });
});

describe('DepGraph.importersUnder (QA-111: whom a delete is about to cut loose)', () => {
  it('lists the importers of the path and of everything below it, keyed by the imported file, sorted', () => {
    const g = new DepGraph();
    g.setFile('/ws/app/b.ts', [{ key: '/ws/lib/util.ts', count: 1 }, { key: '/ws/lib/deep/x.ts', count: 1 }], 'ts');
    g.setFile('/ws/app/a.ts', [{ key: '/ws/lib/util.ts', count: 1 }], 'ts');
    g.setFile('/ws/app/c.ts', [{ key: '/ws/other/y.ts', count: 1 }], 'ts');
    g.setFile('/ws/lib/util.ts', [], 'ts');
    const m = g.importersUnder('/ws/lib');
    assert.deepEqual([...m.keys()].sort(), ['/ws/lib/deep/x.ts', '/ws/lib/util.ts']);
    assert.deepEqual(m.get('/ws/lib/util.ts'), ['/ws/app/a.ts', '/ws/app/b.ts']);
    assert.deepEqual(m.get('/ws/lib/deep/x.ts'), ['/ws/app/b.ts']);
  });

  it('a file path is its own prefix; a sibling that shares a prefix is not included; an unknown path and the empty prefix give nothing', () => {
    const g = new DepGraph();
    g.setFile('/ws/a.ts', [{ key: '/ws/lib/util.ts', count: 1 }, { key: '/ws/lib2/util.ts', count: 1 }], 'ts');
    assert.deepEqual([...g.importersUnder('/ws/lib/util.ts').keys()], ['/ws/lib/util.ts']);
    assert.deepEqual([...g.importersUnder('/ws/lib').keys()], ['/ws/lib/util.ts'], 'lib2 is not below lib');
    assert.equal(g.importersUnder('/ws/none').size, 0);
    assert.equal(g.importersUnder('').size, 0);
  });

  it('includes imported files that were never analysed themselves (only the importers know them)', () => {
    const g = new DepGraph();
    g.setFile('/ws/a.ts', [{ key: '/ws/data/config.json', count: 1 }], 'ts');
    assert.equal(g.has('/ws/data/config.json'), false);
    assert.deepEqual(g.importersUnder('/ws/data').get('/ws/data/config.json'), ['/ws/a.ts']);
  });

  it('is capped at maxFiles imported files (default 500), and a cap of 0 gives nothing', () => {
    const g = new DepGraph();
    const targets = Array.from({ length: 700 }, (_, i) => ({ key: `/ws/lib/t${i}.ts`, count: 1 }));
    g.setFile('/ws/a.ts', targets, 'ts');
    assert.equal(g.importersUnder('/ws/lib').size, 500);
    assert.equal(g.importersUnder('/ws/lib', 5).size, 5);
    assert.equal(g.importersUnder('/ws/lib', 0).size, 0);
    assert.equal(g.importersUnder('/ws/lib', 10_000).size, 700);
  });

  it('a file nobody imports is not listed (no empty importer lists), and the result is a copy', () => {
    const g = new DepGraph();
    g.setFile('/ws/lib/lonely.ts', [], 'ts');
    g.setFile('/ws/a.ts', [{ key: '/ws/lib/used.ts', count: 1 }], 'ts');
    const m = g.importersUnder('/ws/lib');
    assert.deepEqual([...m.keys()], ['/ws/lib/used.ts']);
    must(m.get('/ws/lib/used.ts')).push('/hacked');
    assert.deepEqual(g.importersUnder('/ws/lib').get('/ws/lib/used.ts'), ['/ws/a.ts']);
  });

  it('the delete-and-recreate round trip: read the importers, delete, and re-analysing exactly those importers restores importedBy and the dependants', () => {
    const g = graph([['a', 'util'], ['b', 'util'], ['c', 'util'], ['d', 'a']]);
    const importers = g.importersUnder(k('util'));
    const before = { importedBy: g.importedBy(k('util')), dependants: g.dependants(k('util'), 3, 200) };
    assert.deepEqual(importers.get(k('util')), [k('a'), k('b'), k('c')]);
    g.removeUnder(k('util'));
    assert.deepEqual(g.importedBy(k('util')), [], 'the delete cut the edges');
    // the file is created again: the host re-analyses the file and the importers it remembered
    g.setFile(k('util'), [], 'ts');
    for (const importer of importers.get(k('util')) ?? []) g.setFile(importer, [{ key: k('util'), count: 1 }], 'ts');
    assert.deepEqual(g.importedBy(k('util')).map((e) => e.key), before.importedBy.map((e) => e.key));
    assert.deepEqual(g.dependants(k('util'), 3, 200), before.dependants);
  });

  it('for a deleted folder it names the importers of every file that was below it', () => {
    const g = new DepGraph();
    g.setFile('/ws/x/a.ts', [{ key: '/ws/lib/one.ts', count: 1 }], 'ts');
    g.setFile('/ws/x/b.ts', [{ key: '/ws/lib/sub/two.ts', count: 1 }], 'ts');
    g.setFile('/ws/lib/one.ts', [{ key: '/ws/lib/sub/two.ts', count: 1 }], 'ts');
    const m = g.importersUnder('/ws/lib');
    assert.deepEqual(m.get('/ws/lib/one.ts'), ['/ws/x/a.ts']);
    assert.deepEqual(m.get('/ws/lib/sub/two.ts'), ['/ws/lib/one.ts', '/ws/x/b.ts'], 'an importer that is itself below the folder is listed too; the host decides what to do with it');
  });
});
