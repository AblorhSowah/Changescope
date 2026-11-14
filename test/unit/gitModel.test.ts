import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_LIST_LIMIT, buildRepoSnapshot, headChanged, mapGitStatus } from '../../src/core/git/gitModel';
import type { RawRepo } from '../../src/core/git/gitModel';
import type { GitChangeStatus } from '../../src/core/types';
import { must } from '../support/fixtures';

/** The `Status` const enum of the built-in Git extension API (git.d.ts), as numbers. */
const GIT_STATUS: Record<string, number> = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
};

describe('mapGitStatus: every number of the vscode.git Status enum', () => {
  const expected: Record<string, GitChangeStatus> = {
    INDEX_MODIFIED: 'modified',
    INDEX_ADDED: 'added',
    INDEX_DELETED: 'deleted',
    INDEX_RENAMED: 'renamed',
    INDEX_COPIED: 'added',
    MODIFIED: 'modified',
    DELETED: 'deleted',
    UNTRACKED: 'untracked',
    IGNORED: 'other',
    INTENT_TO_ADD: 'added',
    INTENT_TO_RENAME: 'renamed',
    TYPE_CHANGED: 'modified',
    ADDED_BY_US: 'conflicted',
    ADDED_BY_THEM: 'conflicted',
    DELETED_BY_US: 'conflicted',
    DELETED_BY_THEM: 'conflicted',
    BOTH_ADDED: 'conflicted',
    BOTH_DELETED: 'conflicted',
    BOTH_MODIFIED: 'conflicted',
  };

  for (const [name, num] of Object.entries(GIT_STATUS)) {
    it(`${name} (${num}) -> ${expected[name]}`, () => assert.equal(mapGitStatus(num), expected[name]));
  }

  it('anything outside the enum is "other": 19, 20, 1000, negative, fractional, NaN, Infinity', () => {
    for (const n of [19, 20, 1000, -1, -100, 5.5, 0.5, Number.NaN, Infinity, -Infinity, 2 ** 53]) assert.equal(mapGitStatus(n), 'other', String(n));
  });

  it('is total over a wide integer range and only returns the seven documented values', () => {
    const allowed = new Set(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'other']);
    for (let n = -50; n < 200; n += 1) assert.ok(allowed.has(mapGitStatus(n)), String(n));
  });
});

describe('headChanged', () => {
  it('the first reading is not a change', () => {
    assert.equal(headChanged(undefined, { branch: 'main', commit: 'a' }), false);
  });

  it('a different branch or commit is a change; identical is not', () => {
    assert.equal(headChanged({ branch: 'main', commit: 'a' }, { branch: 'main', commit: 'a' }), false);
    assert.equal(headChanged({ branch: 'main', commit: 'a' }, { branch: 'main', commit: 'b' }), true);
    assert.equal(headChanged({ branch: 'main', commit: 'a' }, { branch: 'dev', commit: 'a' }), true);
    assert.equal(headChanged({ branch: 'main', commit: 'a' }, { branch: 'dev', commit: 'b' }), true);
  });

  it('gaining or losing a branch or commit (detached HEAD, first commit) is a change', () => {
    assert.equal(headChanged({ branch: 'main', commit: 'a' }, { commit: 'a' }), true);
    assert.equal(headChanged({ commit: 'a' }, { branch: 'main', commit: 'a' }), true);
    assert.equal(headChanged({ branch: 'main' }, { branch: 'main', commit: 'a' }), true);
    assert.equal(headChanged({}, {}), false);
  });

  it('ahead/behind and file lists are not part of a head change (a plain edit or stage must not raise a git hint)', () => {
    const a = buildRepoSnapshot({ root: '/ws', name: 'ws', branch: 'main', commit: 'a', ahead: 0, behind: 0, index: [], workingTree: [], merge: [] });
    const b = buildRepoSnapshot({ root: '/ws', name: 'ws', branch: 'main', commit: 'a', ahead: 3, behind: 1, index: [{ key: '/ws/a.ts', status: 0 }], workingTree: [{ key: '/ws/b.ts', status: 5 }], merge: [] });
    assert.equal(headChanged(a, b), false);
  });
});

describe('buildRepoSnapshot', () => {
  const raw = (o: Partial<RawRepo> = {}): RawRepo => ({ root: '/ws', name: 'ws', branch: 'main', commit: 'abc123', ahead: 2, behind: 1, index: [], workingTree: [], merge: [], ...o });
  const c = (key: string, status: number): { key: string; status: number } => ({ key, status });

  it('copies root, name, branch, commit and counts', () => {
    const s = buildRepoSnapshot(raw());
    assert.deepEqual(s, { root: '/ws', name: 'ws', branch: 'main', commit: 'abc123', ahead: 2, behind: 1, staged: [], unstaged: [], untracked: [], truncated: false });
  });

  it('index changes are staged with mapped statuses', () => {
    const s = buildRepoSnapshot(raw({ index: [c('/ws/a.ts', GIT_STATUS['INDEX_ADDED'] as number), c('/ws/b.ts', GIT_STATUS['INDEX_MODIFIED'] as number), c('/ws/c.ts', GIT_STATUS['INDEX_DELETED'] as number)] }));
    assert.deepEqual(s.staged, [
      { key: '/ws/a.ts', status: 'added' },
      { key: '/ws/b.ts', status: 'modified' },
      { key: '/ws/c.ts', status: 'deleted' },
    ]);
  });

  it('working tree changes are unstaged; UNTRACKED entries of the working tree go to untracked, not unstaged', () => {
    const s = buildRepoSnapshot(raw({ workingTree: [c('/ws/m.ts', 5), c('/ws/u.ts', 7), c('/ws/d.ts', 6)] }));
    assert.deepEqual(s.unstaged, [
      { key: '/ws/m.ts', status: 'modified' },
      { key: '/ws/d.ts', status: 'deleted' },
    ]);
    assert.deepEqual(s.untracked, [{ key: '/ws/u.ts', status: 'untracked' }]);
  });

  it('merge conflicts are listed with the working tree changes, conflicts first', () => {
    const s = buildRepoSnapshot(raw({ merge: [c('/ws/x.ts', GIT_STATUS['BOTH_MODIFIED'] as number)], workingTree: [c('/ws/m.ts', 5)] }));
    assert.deepEqual(s.unstaged, [
      { key: '/ws/x.ts', status: 'conflicted' },
      { key: '/ws/m.ts', status: 'modified' },
    ]);
  });

  it('a separate untracked list (where the API has one) and the working tree are merged without duplicates', () => {
    const s = buildRepoSnapshot(raw({ untracked: [c('/ws/u1.ts', 7), c('/ws/u2.ts', 7)], workingTree: [c('/ws/u2.ts', 7), c('/ws/u3.ts', 7)] }));
    assert.deepEqual(
      s.untracked.map((x) => x.key),
      ['/ws/u1.ts', '/ws/u2.ts', '/ws/u3.ts'],
    );
  });

  it('a file in two lists (staged and also modified in the working tree) appears in both sections, once in each', () => {
    const s = buildRepoSnapshot(raw({ index: [c('/ws/a.ts', 0)], workingTree: [c('/ws/a.ts', 5), c('/ws/a.ts', 5)] }));
    assert.equal(s.staged.length, 1);
    assert.equal(s.unstaged.length, 1);
  });

  it('empty keys are dropped', () => {
    const s = buildRepoSnapshot(raw({ index: [c('', 0), c('/ws/a.ts', 0)] }));
    assert.deepEqual(
      s.staged.map((x) => x.key),
      ['/ws/a.ts'],
    );
  });

  it('each list is capped at 200 and truncated is set; at exactly 200 it is not', () => {
    assert.equal(GIT_LIST_LIMIT, 200);
    const exact = buildRepoSnapshot(raw({ index: Array.from({ length: 200 }, (_, i) => c(`/ws/f${i}.ts`, 0)) }));
    assert.equal(exact.staged.length, 200);
    assert.equal(exact.truncated, false);
    const over = buildRepoSnapshot(raw({ index: Array.from({ length: 201 }, (_, i) => c(`/ws/f${i}.ts`, 0)) }));
    assert.equal(over.staged.length, 200);
    assert.equal(over.truncated, true);
    assert.equal(must(over.staged[199]).key, '/ws/f199.ts', 'the first 200 are kept');
  });

  it('every list is capped separately', () => {
    const s = buildRepoSnapshot(
      raw({
        index: Array.from({ length: 250 }, (_, i) => c(`/ws/s${i}.ts`, 0)),
        workingTree: [...Array.from({ length: 250 }, (_, i) => c(`/ws/m${i}.ts`, 5)), ...Array.from({ length: 250 }, (_, i) => c(`/ws/u${i}.ts`, 7))],
      }),
    );
    assert.equal(s.staged.length, 200);
    assert.equal(s.unstaged.length, 200);
    assert.equal(s.untracked.length, 200);
    assert.equal(s.truncated, true);
  });

  it('a custom limit; 0 empties every list and flags truncation; NaN falls back to 200', () => {
    const index = Array.from({ length: 5 }, (_, i) => c(`/ws/f${i}.ts`, 0));
    assert.equal(buildRepoSnapshot(raw({ index }), 3).staged.length, 3);
    const zero = buildRepoSnapshot(raw({ index }), 0);
    assert.equal(zero.staged.length, 0);
    assert.equal(zero.truncated, true);
    assert.equal(buildRepoSnapshot(raw({ index }), Number.NaN).staged.length, 5);
    assert.equal(buildRepoSnapshot(raw({ index }), -4).staged.length, 0);
  });

  it('ahead and behind: non-finite, negative and fractional values are cleaned', () => {
    const s = buildRepoSnapshot(raw({ ahead: Number.NaN, behind: -3 }));
    assert.equal(s.ahead, 0);
    assert.equal(s.behind, 0);
    assert.equal(buildRepoSnapshot(raw({ ahead: 2.9 })).ahead, 2);
    assert.equal(buildRepoSnapshot(raw({ ahead: undefined, behind: undefined })).ahead, 0);
    assert.equal(buildRepoSnapshot(raw({ ahead: Infinity })).ahead, 0);
  });

  it('a missing or empty branch or commit is left out (detached HEAD, no commit yet)', () => {
    const none = buildRepoSnapshot(raw({ branch: undefined, commit: undefined }));
    assert.equal('branch' in none, false);
    assert.equal('commit' in none, false);
    const blank = buildRepoSnapshot(raw({ branch: '', commit: '' }));
    assert.equal('branch' in blank, false);
    assert.equal('commit' in blank, false);
  });

  it('a hostile branch name is kept as plain data', () => {
    const s = buildRepoSnapshot(raw({ branch: '<img src=x onerror=alert(1)>' }));
    assert.equal(s.branch, '<img src=x onerror=alert(1)>');
  });

  it('does not mutate its input', () => {
    const input = raw({ index: [c('/ws/a.ts', 0)], workingTree: [c('/ws/u.ts', 7)] });
    const copy = JSON.stringify(input);
    buildRepoSnapshot(input);
    assert.equal(JSON.stringify(input), copy);
  });
});
