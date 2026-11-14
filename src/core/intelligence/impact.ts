import { basename, dirname } from '../pathUtils';
import type { ChangeImpact, FileKey, ImpactLevel } from '../types';
import type { DepGraph } from './depGraph';
import { buildTestIndex, isTestFile, relatedTestsIn } from './testMatch';
import type { TestIndex } from './testMatch';

export const IMPACT = { MAX_DEPTH: 3, MAX_NODES: 200, MEDIUM: 3, HIGH: 10, CRITICAL: 25 } as const;

/** Combined (direct + indirect) dependant counts that raise the level on their own. */
const COMBINED = { MEDIUM: 8, HIGH: 30 } as const;

const CONFIG_NAMES: ReadonlySet<string> = new Set(['package.json', 'jsconfig.json', 'composer.json', 'go.mod', 'pyproject.toml', 'Dockerfile']);

/** A file whose change can affect the whole project rather than only the files that import it. */
export function isConfigFile(key: FileKey): boolean {
  const base = basename(key);
  if (base === '') return false;
  if (CONFIG_NAMES.has(base)) return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/^requirements.*\.txt$/.test(base)) return true;
  if (/^docker-compose.*\.yml$/.test(base)) return true;
  if (base.startsWith('.env')) return true;
  if (/\.config\.(?:js|ts|mjs|cjs)$/.test(base)) return true;
  const dir = dirname(key);
  return dir === '.github/workflows' || dir.endsWith('/.github/workflows');
}

function files(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

export interface ImpactInput {
  file: FileKey;
  graph: DepGraph;
  allFiles: ReadonlySet<FileKey>;
  /** false while the dependency index is still being built, or when it was cut off at its size limit */
  indexComplete: boolean;
  now: number;
  /** workspace folders; test folders are then recognised relative to them */
  roots?: readonly FileKey[];
  /**
   * Test files of `allFiles` by stem, built with the same `roots`. Pass one that is kept for as long as the set of
   * files does not change: without it every call scans all of `allFiles` (linear in the workspace size).
   */
  testIndex?: TestIndex;
}

/**
 * Estimates what a change to one file can affect, from import edges only. The result is an estimate with
 * its reasons spelled out. It never says that anything is broken.
 */
export function analyseImpact(i: ImpactInput): ChangeImpact {
  const { direct, indirect, truncated } = i.graph.dependants(i.file, IMPACT.MAX_DEPTH, IMPACT.MAX_NODES);
  const config = isConfigFile(i.file);
  const total = direct.length + indirect.length;

  let impactLevel: ImpactLevel = 'low';
  if (config || direct.length >= IMPACT.CRITICAL) impactLevel = 'critical';
  else if (direct.length >= IMPACT.HIGH || total >= COMBINED.HIGH) impactLevel = 'high';
  else if (direct.length >= IMPACT.MEDIUM || total >= COMBINED.MEDIUM) impactLevel = 'medium';

  const affectedFiles = [...direct, ...indirect];
  const tests = new Set<FileKey>();
  for (const f of affectedFiles) if (isTestFile(f, i.roots)) tests.add(f);
  for (const t of relatedTestsIn(i.testIndex ?? buildTestIndex(i.allFiles, i.roots), i.file)) tests.add(t);
  const affectedTests = [...tests].sort();

  const reasons: string[] = [];
  if (config) reasons.push('This is a project configuration file; changes can affect the whole workspace.');
  if (direct.length > 0) {
    reasons.push(direct.length === 1 ? '1 file imports this file directly.' : `${direct.length} files import this file directly.`);
  }
  if (indirect.length > 0) {
    reasons.push(
      indirect.length === 1
        ? `1 more file depends on it through other files (up to ${IMPACT.MAX_DEPTH} levels).`
        : `${indirect.length} more files depend on it through other files (up to ${IMPACT.MAX_DEPTH} levels).`,
    );
  }
  if (total === 0) reasons.push('No dependants were found.');
  if (affectedTests.length > 0) {
    reasons.push(affectedTests.length === 1 ? '1 test file is related to this change.' : `${affectedTests.length} test files are related to this change.`);
  }
  if (truncated) reasons.push(`The search stopped at ${files(IMPACT.MAX_NODES)}, so more files may be affected.`);
  if (!i.indexComplete) reasons.push('The dependency index is still being built, so this estimate may be low.');

  return {
    filePath: i.file,
    directDependants: direct,
    indirectDependants: indirect,
    affectedFiles,
    affectedTests,
    configFiles: config ? [i.file] : [],
    impactLevel,
    reasons,
    complete: i.indexComplete && !truncated,
    analysedAt: i.now,
  };
}
