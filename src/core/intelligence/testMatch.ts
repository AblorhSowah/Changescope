import { relativeTo } from '../pathUtils';
import type { FileKey } from '../types';

const TEST_DIRS: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec']);
const UPPER_TEST_EXTENSIONS: ReadonlySet<string> = new Set(['.php', '.java', '.kt']);

/** Directory segments and base name of a path, relative to the longest of `roots` that contains it. */
function split(key: FileKey, roots: readonly FileKey[] | undefined): { dirs: string[]; base: string } {
  let path = key;
  if (roots !== undefined) {
    let best: string | undefined;
    for (const r of roots) {
      const rel = relativeTo(r, key);
      if (rel !== undefined && rel !== '' && (best === undefined || rel.length < best.length)) best = rel;
    }
    if (best !== undefined) path = best;
  }
  const segments = path.split('/').filter((s) => s !== '');
  const base = segments.pop() ?? '';
  return { dirs: segments, base };
}

/**
 * The base name with its test marker removed, or undefined when the name carries no marker.
 * `foo.test.ts`, `foo.spec.js`, `foo_test.go`, `test_foo.py`, `foo_test.py`, `FooTest.php|java|kt` all give `foo` / `Foo`.
 */
function unmarkedStem(base: string): string | undefined {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  const stem = base.slice(0, dot);

  const infix = /^(.+)\.(?:test|spec)$/i.exec(stem);
  if (infix && infix[1] !== undefined) return infix[1];
  if (ext === '.go' && stem.endsWith('_test') && stem.length > 5) return stem.slice(0, -5);
  if (ext === '.py') {
    if (stem.startsWith('test_') && stem.length > 5) return stem.slice(5);
    if (stem.endsWith('_test') && stem.length > 5) return stem.slice(0, -5);
  }
  if (UPPER_TEST_EXTENSIONS.has(ext) && stem.endsWith('Test') && stem.length > 4) return stem.slice(0, -4);
  return undefined;
}

function plainStem(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/**
 * Is this a test file, judged by its name and folders only. With `roots`, folder names are read relative
 * to the workspace folder, so a project that itself lives below a folder called `test` is not all tests.
 */
export function isTestFile(key: FileKey, roots?: readonly FileKey[]): boolean {
  const { dirs, base } = split(key, roots);
  if (base === '') return false;
  if (unmarkedStem(base) !== undefined) return true;
  return dirs.some((d) => TEST_DIRS.has(d));
}

function distance(a: readonly string[], b: readonly string[]): number {
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return a.length - common + (b.length - common);
}

/** The stem a test file is matched under: its name without the marker, or (in a test folder) its plain stem. */
function testStem(c: { dirs: string[]; base: string }): string | undefined {
  return unmarkedStem(c.base) ?? (c.dirs.some((d) => TEST_DIRS.has(d)) ? plainStem(c.base) : undefined);
}

/** Test files grouped by the stem they test, built once so each lookup is a map access instead of a scan of every file. */
export interface TestIndex {
  /** the workspace folders the stems were computed against */
  readonly roots: readonly FileKey[] | undefined;
  readonly byStem: ReadonlyMap<string, ReadonlyArray<{ key: FileKey; dirs: readonly string[] }>>;
}

export function buildTestIndex(allFiles: Iterable<FileKey>, roots?: readonly FileKey[]): TestIndex {
  const byStem = new Map<string, Array<{ key: FileKey; dirs: readonly string[] }>>();
  for (const key of allFiles) {
    const c = split(key, roots);
    const stem = testStem(c);
    if (stem === undefined) continue;
    const list = byStem.get(stem);
    if (list === undefined) byStem.set(stem, [{ key, dirs: c.dirs }]);
    else list.push({ key, dirs: c.dirs });
  }
  return { roots, byStem };
}

/**
 * Test files that belong to `key`, looked up in a prebuilt index: their base name with the test marker removed
 * equals the stem of `key`, in any directory. Nearest directory first, at most `max`. A test file has no related
 * tests of its own. The result is the same as `relatedTests` over the files the index was built from.
 */
export function relatedTestsIn(index: TestIndex, key: FileKey, max = 10): FileKey[] {
  if (isTestFile(key, index.roots)) return [];
  const own = split(key, index.roots);
  const stem = plainStem(own.base);
  if (stem === '') return [];
  const found: Array<{ key: FileKey; distance: number }> = [];
  for (const candidate of index.byStem.get(stem) ?? []) {
    if (candidate.key !== key) found.push({ key: candidate.key, distance: distance(own.dirs, candidate.dirs) });
  }
  found.sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return found.slice(0, Math.max(0, max)).map((f) => f.key);
}

/**
 * Test files that belong to `key`: their base name with the test marker removed equals the stem of `key`,
 * in any directory. Nearest directory first, at most `max`. A test file has no related tests of its own.
 * This scans `allFiles`; callers that ask repeatedly should build a `TestIndex` once and use `relatedTestsIn`.
 */
export function relatedTests(key: FileKey, allFiles: Iterable<FileKey>, roots?: readonly FileKey[], max = 10): FileKey[] {
  if (isTestFile(key, roots)) return [];
  return relatedTestsIn(buildTestIndex(allFiles, roots), key, max);
}
