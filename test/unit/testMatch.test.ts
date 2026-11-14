import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTestFile, relatedTests } from '../../src/core/intelligence/testMatch';

describe('isTestFile: names', () => {
  const yes = [
    '/ws/src/a.test.ts',
    '/ws/src/a.spec.ts',
    '/ws/src/a.test.js',
    '/ws/src/a.spec.jsx',
    '/ws/src/a.test.tsx',
    '/ws/src/A.Test.ts',
    '/ws/src/a.b.test.ts',
    '/ws/pkg/foo_test.go',
    '/ws/pkg/test_foo.py',
    '/ws/pkg/foo_test.py',
    '/ws/src/FooTest.php',
    '/ws/src/FooTest.java',
    '/ws/src/FooTest.kt',
    '/ws/src/a.test.mjs',
  ];
  const no = [
    '/ws/src/a.ts',
    '/ws/src/test.ts',
    '/ws/src/testing.ts',
    '/ws/src/contest.ts',
    '/ws/src/latest.js',
    '/ws/src/spec.ts',
    '/ws/src/a.testing.ts',
    '/ws/src/a-test.ts',
    '/ws/src/a_test.ts',
    '/ws/pkg/foo_test.rb',
    '/ws/pkg/test_foo.go',
    '/ws/pkg/foo.py',
    '/ws/pkg/mytest_foo.py',
    '/ws/src/Foo.php',
    '/ws/src/Test.php',
    '/ws/src/FooTests.php',
    '/ws/src/Footest.java',
    '/ws/src/FooTest.rb',
    '/ws/src/.test.ts',
    '/ws/src/.spec',
    '/ws/README.md',
    '/ws',
    '',
  ];

  for (const p of yes) it(`test file: ${p}`, () => assert.equal(isTestFile(p), true));
  for (const p of no) it(`not a test file: ${JSON.stringify(p)}`, () => assert.equal(isTestFile(p), false));

  it('the test marker is only a marker before the extension, case-insensitive for .test/.spec', () => {
    assert.equal(isTestFile('/ws/a.TEST.ts'), true);
    assert.equal(isTestFile('/ws/a.Spec.ts'), true);
    assert.equal(isTestFile('/ws/a.ts.test'), false, 'the extension is "test", the stem is "a.ts"');
  });

  it('a Go or Python marker needs the right extension and a real stem', () => {
    assert.equal(isTestFile('/ws/_test.go'), false);
    assert.equal(isTestFile('/ws/test_.py'), false);
    assert.equal(isTestFile('/ws/test_x.py'), true);
  });
});

describe('isTestFile: folders', () => {
  it('a path segment test, tests, __tests__ or spec makes it a test file, any extension', () => {
    for (const d of ['test', 'tests', '__tests__', 'spec']) {
      assert.equal(isTestFile(`/ws/${d}/helper.ts`), true, d);
      assert.equal(isTestFile(`/ws/src/${d}/deep/fixture.json`), true, d);
    }
  });

  it('only whole segments count', () => {
    for (const d of ['tester', 'latest', 'tests-old', 'my_tests', 'specs', 'Test', 'TESTS']) assert.equal(isTestFile(`/ws/${d}/a.ts`), false, d);
  });

  it('the file name itself is not a folder segment: a file called tests (no marker) is not a test', () => {
    assert.equal(isTestFile('/ws/src/tests'), false);
    assert.equal(isTestFile('/ws/src/spec'), false);
  });

  it('without roots, a project that lives under a folder called test is all tests (the documented limit)', () => {
    assert.equal(isTestFile('/home/me/test/project/src/a.ts'), true);
  });

  it('with roots, folder names are read relative to the workspace folder', () => {
    const roots = ['/home/me/test/project'];
    assert.equal(isTestFile('/home/me/test/project/src/a.ts', roots), false);
    assert.equal(isTestFile('/home/me/test/project/test/a.ts', roots), true);
    assert.equal(isTestFile('/home/me/test/project/src/a.test.ts', roots), true);
  });

  it('with several roots the closest (deepest) containing root is used; a file outside every root uses its full path', () => {
    const roots = ['/home/me/test', '/home/me/test/project'];
    assert.equal(isTestFile('/home/me/test/project/src/a.ts', roots), false);
    assert.equal(isTestFile('/elsewhere/test/a.ts', ['/home/me/test/project']), true);
  });
});

describe('relatedTests', () => {
  const all = [
    '/ws/src/util.ts',
    '/ws/src/util.test.ts',
    '/ws/src/util.spec.ts',
    '/ws/test/util.test.ts',
    '/ws/tests/unit/util.ts',
    '/ws/src/other.test.ts',
    '/ws/src/util2.test.ts',
    '/ws/lib/deep/nested/util.test.js',
    '/ws/README.md',
  ];

  it('finds test files whose marker-free base name equals the stem, in any directory', () => {
    const found = relatedTests('/ws/src/util.ts', all);
    assert.deepEqual(new Set(found), new Set(['/ws/src/util.test.ts', '/ws/src/util.spec.ts', '/ws/test/util.test.ts', '/ws/tests/unit/util.ts', '/ws/lib/deep/nested/util.test.js']));
  });

  it('nearest directory first, then by path', () => {
    const found = relatedTests('/ws/src/util.ts', all);
    assert.equal(found[0], '/ws/src/util.spec.ts');
    assert.equal(found[1], '/ws/src/util.test.ts');
    assert.equal(found[found.length - 1], '/ws/lib/deep/nested/util.test.js', 'the farthest is last');
  });

  it('does not match a different stem (util2, other) or the file itself', () => {
    const found = relatedTests('/ws/src/util.ts', all);
    assert.ok(!found.includes('/ws/src/util2.test.ts'));
    assert.ok(!found.includes('/ws/src/other.test.ts'));
    assert.ok(!found.includes('/ws/src/util.ts'));
  });

  it('a test file has no related tests of its own', () => {
    assert.deepEqual(relatedTests('/ws/src/util.test.ts', all), []);
    assert.deepEqual(relatedTests('/ws/test/helper.ts', ['/ws/test/helper.ts', '/ws/test/other.ts']), []);
    // a helper in a test folder must not "belong" to the same-named helper of another test folder
    assert.deepEqual(relatedTests('/ws/test/util.ts', ['/ws/tests/util.ts', '/ws/src/util.test.ts']), []);
    assert.deepEqual(relatedTests('/ws/src/util.spec.ts', ['/ws/tests/util.ts']), []);
  });

  it('is capped at 10 by default and by max when given; max 0 or less gives nothing', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/ws/t${i}/util.test.ts`);
    assert.equal(relatedTests('/ws/util.ts', many).length, 10);
    assert.equal(relatedTests('/ws/util.ts', many, undefined, 3).length, 3);
    assert.deepEqual(relatedTests('/ws/util.ts', many, undefined, 0), []);
    assert.deepEqual(relatedTests('/ws/util.ts', many, undefined, -1), []);
  });

  it('language conventions: Go, Python (both forms), PHP, Java, Kotlin', () => {
    assert.deepEqual(relatedTests('/ws/pkg/foo.go', ['/ws/pkg/foo_test.go']), ['/ws/pkg/foo_test.go']);
    assert.deepEqual(relatedTests('/ws/pkg/foo.py', ['/ws/tests/test_foo.py', '/ws/tests/foo_test.py']).sort(), ['/ws/tests/foo_test.py', '/ws/tests/test_foo.py']);
    assert.deepEqual(relatedTests('/ws/src/Foo.php', ['/ws/tests/FooTest.php']), ['/ws/tests/FooTest.php']);
    assert.deepEqual(relatedTests('/ws/src/Foo.java', ['/ws/test/FooTest.java']), ['/ws/test/FooTest.java']);
    assert.deepEqual(relatedTests('/ws/src/Foo.kt', ['/ws/test/FooTest.kt']), ['/ws/test/FooTest.kt']);
  });

  it('a different language with the same stem is still related (a stem is a stem)', () => {
    assert.deepEqual(relatedTests('/ws/src/util.js', ['/ws/src/util.test.ts']), ['/ws/src/util.test.ts']);
  });

  it('a non-test file in a test folder with the same stem counts (fixtures and helpers of that file)', () => {
    assert.deepEqual(relatedTests('/ws/src/util.ts', ['/ws/tests/util.ts']), ['/ws/tests/util.ts']);
  });

  it('a file with no stem (dotfile) or no candidates gives nothing', () => {
    assert.deepEqual(relatedTests('/ws/.env', all), []);
    assert.deepEqual(relatedTests('/ws/src/zzz.ts', all), []);
    assert.deepEqual(relatedTests('/ws/src/util.ts', []), []);
  });

  it('accepts any iterable, including a Set and a generator', () => {
    assert.deepEqual(relatedTests('/ws/util.ts', new Set(['/ws/util.test.ts'])), ['/ws/util.test.ts']);
    function* gen(): Generator<string> {
      yield '/ws/util.test.ts';
    }
    assert.deepEqual(relatedTests('/ws/util.ts', gen()), ['/ws/util.test.ts']);
  });

  it('with roots, a test folder above the workspace does not make everything a test (so a source file still has related tests)', () => {
    const roots = ['/home/me/test/project'];
    assert.deepEqual(relatedTests('/home/me/test/project/src/util.ts', ['/home/me/test/project/src/util.test.ts', '/home/me/test/project/src/util.ts'], roots), ['/home/me/test/project/src/util.test.ts']);
  });
});
