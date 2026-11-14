import { isUnder } from '../pathUtils';
import type { DependencyRelationship, FileKey, ReferenceResult, RelationshipType } from '../types';

export interface DepEdge {
  key: FileKey;
  count: number;
  relationshipType: RelationshipType;
}

export interface DepTarget {
  key: FileKey;
  count: number;
  relationshipType?: RelationshipType;
}

interface Node {
  language: string;
  targets: Map<FileKey, { count: number; relationshipType: RelationshipType }>;
}

/** Languages whose links are references between documents and assets, not code imports. */
const REFERENCE_LANGUAGES: ReadonlySet<string> = new Set(['html', 'markdown', 'css', 'scss', 'less']);

/** 0.8 for a resolved code import or re-export, 0.6 for a document or stylesheet link, 0.5 otherwise. */
export function relationshipConfidence(type: RelationshipType): number {
  if (type === 'import' || type === 'export') return 0.8;
  if (type === 'reference') return 0.6;
  return 0.5;
}

/**
 * The edges one analysed file contributes: `export` when every statement that points at the target is a
 * re-export, `reference` for HTML, Markdown and stylesheet links, `import` otherwise.
 */
export function targetsFromReference(result: ReferenceResult): DepTarget[] {
  const language = result.language ?? '';
  return result.targets.map((t) => {
    let relationshipType: RelationshipType = 'import';
    if (REFERENCE_LANGUAGES.has(language)) relationshipType = 'reference';
    else if (t.kinds !== undefined && t.kinds.length > 0 && t.kinds.every((k) => k === 'export-from')) relationshipType = 'export';
    return { key: t.key, count: t.count, relationshipType };
  });
}

/**
 * When one source lists the same target more than once, the strongest claim wins whatever the order:
 * `import`, then `reference`, `inheritance`, `export`, and `unknown` last. `export` is the weakest real claim
 * on purpose: an edge is `export` only when every statement that produced it is a re-export.
 */
const RELATIONSHIP_RANK: Readonly<Record<RelationshipType, number>> = { import: 5, reference: 4, inheritance: 3, export: 2, unknown: 1 };

function stronger(a: RelationshipType, b: RelationshipType): RelationshipType {
  return RELATIONSHIP_RANK[b] > RELATIONSHIP_RANK[a] ? b : a;
}

/** `Infinity` means no limit; anything else that is not a usable number means none (0). */
function limitOf(n: number, unbounded: number): number {
  if (n === Number.POSITIVE_INFINITY) return unbounded;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function byKey(a: { key: FileKey }, b: { key: FileKey }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Who imports whom, in both directions. Updated one file at a time: `setFile` replaces the outgoing
 * edges of that file only, so an edit never costs a rescan of the workspace.
 */
export class DepGraph {
  private readonly forward = new Map<FileKey, Node>();
  private readonly reverse = new Map<FileKey, Set<FileKey>>();
  private edges = 0;

  /** Replaces the outgoing edges of `source`. A file with no targets is still a known (analysed) file. */
  setFile(source: FileKey, targets: ReadonlyArray<DepTarget>, language: string): void {
    this.dropOutgoing(source);
    const node: Node = { language, targets: new Map() };
    for (const t of targets) {
      if (t.key === source || t.key === '') continue;
      const count = Number.isFinite(t.count) && t.count > 0 ? t.count : 1;
      const existing = node.targets.get(t.key);
      if (existing !== undefined) {
        existing.count += count;
        existing.relationshipType = stronger(existing.relationshipType, t.relationshipType ?? 'import');
        continue;
      }
      node.targets.set(t.key, { count, relationshipType: t.relationshipType ?? 'import' });
      let sources = this.reverse.get(t.key);
      if (sources === undefined) {
        sources = new Set();
        this.reverse.set(t.key, sources);
      }
      sources.add(source);
      this.edges += 1;
    }
    this.forward.set(source, node);
  }

  /** Forgets a file that no longer exists: its own edges and every edge that pointed at it. */
  removeFile(key: FileKey): void {
    this.dropOutgoing(key);
    this.forward.delete(key);
    const sources = this.reverse.get(key);
    if (sources === undefined) return;
    for (const s of sources) {
      const node = this.forward.get(s);
      if (node?.targets.delete(key)) this.edges -= 1;
    }
    this.reverse.delete(key);
  }

  /** Forgets `prefix` and everything below it. Returns how many files were known among them. */
  removeUnder(prefix: FileKey): number {
    if (prefix === '') return 0;
    const keys = new Set<FileKey>();
    for (const k of this.forward.keys()) if (isUnder(prefix, k)) keys.add(k);
    let known = 0;
    for (const k of keys) {
      known += 1;
      this.removeFile(k);
    }
    for (const k of [...this.reverse.keys()]) if (isUnder(prefix, k)) this.removeFile(k);
    return known;
  }

  /**
   * The importers of every file at or below `prefix`, keyed by the imported file. Read this before `removeFile` or
   * `removeUnder` to remember whom a delete is about to cut loose. At most `maxFiles` imported files are listed.
   */
  importersUnder(prefix: FileKey, maxFiles = 500): Map<FileKey, FileKey[]> {
    const out = new Map<FileKey, FileKey[]>();
    if (prefix === '') return out;
    for (const [target, sources] of this.reverse) {
      if (out.size >= maxFiles) break;
      if (isUnder(prefix, target) && sources.size > 0) out.set(target, [...sources].sort());
    }
    return out;
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
    this.edges = 0;
  }

  /** True when the file was analysed (it may have no edges). */
  has(key: FileKey): boolean {
    return this.forward.has(key);
  }

  get fileCount(): number {
    return this.forward.size;
  }

  get edgeCount(): number {
    return this.edges;
  }

  /** The analysed files, in no particular order. */
  files(): IterableIterator<FileKey> {
    return this.forward.keys();
  }

  /** What `key` imports: most referenced first, then by path. */
  importsOf(key: FileKey): DepEdge[] {
    const node = this.forward.get(key);
    if (node === undefined) return [];
    const out: DepEdge[] = [];
    for (const [target, e] of node.targets) out.push({ key: target, count: e.count, relationshipType: e.relationshipType });
    return out.sort((a, b) => b.count - a.count || byKey(a, b));
  }

  /** The files that import `key`: most references first, then by path. */
  importedBy(key: FileKey): DepEdge[] {
    const sources = this.reverse.get(key);
    if (sources === undefined) return [];
    const out: DepEdge[] = [];
    for (const s of sources) {
      const e = this.forward.get(s)?.targets.get(key);
      if (e !== undefined) out.push({ key: s, count: e.count, relationshipType: e.relationshipType });
    }
    return out.sort((a, b) => b.count - a.count || byKey(a, b));
  }

  /**
   * The files affected when `key` changes: breadth first over the reverse edges, `direct` at distance 1 and
   * `indirect` at distances 2 to `maxDepth`. Safe on cycles; the file itself is never listed. `truncated` is
   * true when the search stopped at `maxNodes` files.
   */
  dependants(key: FileKey, maxDepth: number, maxNodes: number): { direct: FileKey[]; indirect: FileKey[]; truncated: boolean } {
    // the search ends when the frontier is empty, so an unbounded depth cannot loop (cycles are skipped by `seen`)
    const depthLimit = limitOf(maxDepth, Number.MAX_SAFE_INTEGER);
    const nodeLimit = limitOf(maxNodes, Number.MAX_SAFE_INTEGER);
    const direct: FileKey[] = [];
    const indirect: FileKey[] = [];
    let truncated = false;
    if (depthLimit < 1) return { direct, indirect, truncated };

    const seen = new Set<FileKey>([key]);
    let frontier: FileKey[] = [key];
    search: for (let depth = 1; depth <= depthLimit && frontier.length > 0; depth += 1) {
      const next: FileKey[] = [];
      for (const current of frontier) {
        const sources = this.reverse.get(current);
        if (sources === undefined) continue;
        for (const s of [...sources].sort()) {
          if (seen.has(s)) continue;
          if (direct.length + indirect.length >= nodeLimit) {
            truncated = true;
            break search;
          }
          seen.add(s);
          next.push(s);
          (depth === 1 ? direct : indirect).push(s);
        }
      }
      frontier = next;
    }
    direct.sort();
    indirect.sort();
    return { direct, indirect, truncated };
  }

  /** Every edge as a relationship record, sorted by source then target. */
  relationships(): DependencyRelationship[] {
    const out: DependencyRelationship[] = [];
    for (const [source, node] of this.forward) {
      for (const [target, e] of node.targets) {
        out.push({
          sourceFile: source,
          targetFile: target,
          relationshipType: e.relationshipType,
          language: node.language,
          confidence: relationshipConfidence(e.relationshipType),
        });
      }
    }
    return out.sort((a, b) =>
      a.sourceFile !== b.sourceFile ? (a.sourceFile < b.sourceFile ? -1 : 1) : a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0,
    );
  }

  private dropOutgoing(source: FileKey): void {
    const node = this.forward.get(source);
    if (node === undefined) return;
    for (const target of node.targets.keys()) {
      const sources = this.reverse.get(target);
      if (sources === undefined) continue;
      sources.delete(source);
      if (sources.size === 0) this.reverse.delete(target);
      this.edges -= 1;
    }
    node.targets.clear();
  }
}
