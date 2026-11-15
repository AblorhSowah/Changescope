// 0.3.0 additions to files that already have 0.2.0 tests: ReferenceTarget.kinds (DESIGN-0.3.0 7.1) and the two
// intensity helpers behind changescope.animationIntensity (section 12).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../support/analyze';
import { must } from '../support/fixtures';
import { DepGraph, targetsFromReference } from '../../src/core/intelligence/depGraph';
import { clampAnimationIntensity, scaleShake, shakeParams } from '../../src/core/intensity';

const find = (r: Awaited<ReturnType<typeof run>>['result'], key: string) => must(r.targets.find((t) => t.key === key), key);

describe('analyzeReferences fills ReferenceTarget.kinds', () => {
  const files = { '/ws/b.ts': 'export const b = 1;', '/ws/c.ts': 'export const c = 1;', '/ws/d.ts': 'export const d = 1;' };

  it('a plain import is kind "import"', async () => {
    const { result } = await run(files, '/ws/a.ts', "import { b } from './b';\nb();");
    assert.deepEqual(find(result, '/ws/b.ts').kinds, ['import']);
  });

  it('a pure re-export is kind "export-from" only', async () => {
    const { result } = await run(files, '/ws/a.ts', "export { b } from './b';\nexport * from './c';");
    assert.deepEqual(find(result, '/ws/b.ts').kinds, ['export-from']);
    assert.deepEqual(find(result, '/ws/c.ts').kinds, ['export-from']);
  });

  it('an import and a re-export of the same file list both kinds, once each, in the order seen', async () => {
    const { result } = await run(files, '/ws/a.ts', "import { b } from './b';\nexport { b } from './b';\nexport * from './b';");
    assert.deepEqual(find(result, '/ws/b.ts').kinds, ['import', 'export-from']);
  });

  it('feeding the analysis into the dependency graph: pure re-export edges are "export", mixed ones are "import"', async () => {
    const { result } = await run(files, '/ws/a.ts', "export { b } from './b';\nimport { c } from './c';\nexport { c } from './c';\nimport { d } from './d';");
    const g = new DepGraph();
    g.setFile('/ws/a.ts', targetsFromReference(result), 'ts');
    const types = Object.fromEntries(g.importsOf('/ws/a.ts').map((e) => [e.key, e.relationshipType]));
    assert.deepEqual(types, { '/ws/b.ts': 'export', '/ws/c.ts': 'import', '/ws/d.ts': 'import' });
  });

  it('every target of every analysis carries a kinds array (additive field, never missing)', async () => {
    const { result } = await run(files, '/ws/a.ts', "import './b';\nconst x = require('./c');\nimport('./d');");
    for (const t of result.targets) assert.ok(Array.isArray(t.kinds) && t.kinds.length >= 1, t.key);
  });

  it('the existing fields are unchanged by the addition: count, statements, usages, lines, specifiers', async () => {
    const { result } = await run(files, '/ws/a.ts', "import { b } from './b';\nb(); b();");
    const t = find(result, '/ws/b.ts');
    assert.equal(t.statements, 1);
    assert.equal(t.usages, 2);
    assert.equal(t.count, 3);
    assert.deepEqual(t.lines, [1]);
    assert.deepEqual(t.specifiers, ['./b']);
  });
});

describe('clampAnimationIntensity', () => {
  it('in range values pass through; out of range values clamp to [0.25, 2]', () => {
    for (const v of [0.25, 0.5, 1, 1.5, 2]) assert.equal(clampAnimationIntensity(v), v);
    assert.equal(clampAnimationIntensity(0), 0.25);
    assert.equal(clampAnimationIntensity(0.24), 0.25);
    assert.equal(clampAnimationIntensity(-5), 0.25);
    assert.equal(clampAnimationIntensity(2.01), 2);
    assert.equal(clampAnimationIntensity(1e9), 2);
  });

  it('non-finite values fall back to 1 (Infinity too: a documented choice, not "the maximum")', () => {
    for (const v of [Number.NaN, Infinity, -Infinity]) assert.equal(clampAnimationIntensity(v), 1, String(v));
  });
});

describe('scaleShake', () => {
  const base = shakeParams(0.6);

  it('a factor of 1 returns the very same object (no allocation per row, no rounding drift)', () => {
    assert.equal(scaleShake(base, 1), base);
    assert.equal(scaleShake(base, Number.NaN), base, 'NaN is 1');
    assert.equal(scaleShake(base, Infinity), base);
  });

  it('scales distance and rotation and never the duration', () => {
    const doubled = scaleShake(base, 2);
    assert.equal(doubled.dur, base.dur);
    assert.equal(doubled.amp, Math.round(base.amp * 2 * 100) / 100);
    assert.equal(doubled.rot, Math.round(base.rot * 2 * 100) / 100);
    const quarter = scaleShake(base, 0.25);
    assert.equal(quarter.dur, base.dur);
    assert.equal(quarter.amp, Math.round(base.amp * 0.25 * 100) / 100);
  });

  it('the factor is clamped first: 10 acts as 2, 0 and negatives act as 0.25', () => {
    assert.deepEqual(scaleShake(base, 10), scaleShake(base, 2));
    assert.deepEqual(scaleShake(base, 0), scaleShake(base, 0.25));
    assert.deepEqual(scaleShake(base, -3), scaleShake(base, 0.25));
  });

  it('does not mutate its input and keeps results at two decimals', () => {
    const copy = { ...base };
    const out = scaleShake(base, 1.37);
    assert.deepEqual(base, copy);
    for (const v of [out.amp, out.rot]) assert.equal(v, Math.round(v * 100) / 100);
  });

  it('monotone: a larger factor never shakes less, for every intensity', () => {
    for (let i = 0; i <= 20; i += 1) {
      const s = shakeParams(i / 20);
      let prev = 0;
      for (const f of [0.25, 0.5, 1, 1.5, 2]) {
        const out = scaleShake(s, f);
        assert.ok(out.amp >= prev, `intensity ${i / 20} factor ${f}`);
        prev = out.amp;
      }
    }
  });
});
