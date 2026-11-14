import type { FileKey, GitChangeStatus } from '../types';

/** Longest list of changes kept per repository section. */
export const GIT_LIST_LIMIT = 200;

/**
 * Maps the `Status` enum of the built-in Git extension (a `const enum`, so only its numbers exist at
 * run time) to the handful of states the dashboard shows. The order has been the same since the API
 * was published: 0 INDEX_MODIFIED, 1 INDEX_ADDED, 2 INDEX_DELETED, 3 INDEX_RENAMED, 4 INDEX_COPIED,
 * 5 MODIFIED, 6 DELETED, 7 UNTRACKED, 8 IGNORED, 9 INTENT_TO_ADD, 10 INTENT_TO_RENAME, 11 TYPE_CHANGED,
 * 12 ADDED_BY_US, 13 ADDED_BY_THEM, 14 DELETED_BY_US, 15 DELETED_BY_THEM, 16 BOTH_ADDED, 17 BOTH_DELETED,
 * 18 BOTH_MODIFIED. Anything else is `other`.
 */
export function mapGitStatus(status: number): GitChangeStatus {
  switch (status) {
    case 0:
    case 5:
    case 11:
      return 'modified';
    case 1:
    case 4:
    case 9:
      return 'added';
    case 2:
    case 6:
      return 'deleted';
    case 3:
    case 10:
      return 'renamed';
    case 7:
      return 'untracked';
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
    case 18:
      return 'conflicted';
    default:
      return 'other';
  }
}

export interface RepoChange {
  key: FileKey;
  status: GitChangeStatus;
}

export interface RepoSnapshot {
  root: FileKey;
  name: string;
  branch?: string;
  /** full commit id */
  commit?: string;
  ahead: number;
  behind: number;
  staged: RepoChange[];
  unstaged: RepoChange[];
  untracked: RepoChange[];
  /** true when a list was cut at `GIT_LIST_LIMIT` */
  truncated: boolean;
}

/** Plain data read from the Git extension, before any mapping. */
export interface RawRepo {
  root: FileKey;
  name: string;
  branch?: string | undefined;
  commit?: string | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  index: ReadonlyArray<{ key: FileKey; status: number }>;
  workingTree: ReadonlyArray<{ key: FileKey; status: number }>;
  merge: ReadonlyArray<{ key: FileKey; status: number }>;
  /** only where the API has a separate list of untracked files */
  untracked?: ReadonlyArray<{ key: FileKey; status: number }> | undefined;
}

function count(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Builds the snapshot of one repository: maps statuses, splits untracked files out, removes duplicates, caps the lists. */
export function buildRepoSnapshot(raw: RawRepo, limit: number = GIT_LIST_LIMIT): RepoSnapshot {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : GIT_LIST_LIMIT;
  let truncated = false;

  const collect = (lists: ReadonlyArray<ReadonlyArray<{ key: FileKey; status: number }>>, want: (s: GitChangeStatus) => boolean): RepoChange[] => {
    const seen = new Set<FileKey>();
    const out: RepoChange[] = [];
    for (const list of lists) {
      for (const c of list) {
        const status = mapGitStatus(c.status);
        if (!want(status) || c.key === '' || seen.has(c.key)) continue;
        seen.add(c.key);
        if (out.length >= cap) {
          truncated = true;
          continue;
        }
        out.push({ key: c.key, status });
      }
    }
    return out;
  };

  const staged = collect([raw.index], () => true);
  // conflicts are listed with the working tree changes: that is where they have to be resolved
  const unstaged = collect([raw.merge, raw.workingTree], (s) => s !== 'untracked');
  const untracked = collect([raw.untracked ?? [], raw.workingTree], (s) => s === 'untracked');

  const snapshot: RepoSnapshot = {
    root: raw.root,
    name: raw.name,
    ahead: count(raw.ahead),
    behind: count(raw.behind),
    staged,
    unstaged,
    untracked,
    truncated,
  };
  if (raw.branch !== undefined && raw.branch !== '') snapshot.branch = raw.branch;
  if (raw.commit !== undefined && raw.commit !== '') snapshot.commit = raw.commit;
  return snapshot;
}

/**
 * Did the branch or the commit change between two readings of one repository. The first reading
 * (`prev` undefined) is not a change: there is nothing to compare it with.
 */
export function headChanged(prev: Pick<RepoSnapshot, 'branch' | 'commit'> | undefined, next: Pick<RepoSnapshot, 'branch' | 'commit'>): boolean {
  if (prev === undefined) return false;
  return prev.branch !== next.branch || prev.commit !== next.commit;
}
