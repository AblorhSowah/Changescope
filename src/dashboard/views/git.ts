import { DASH_LIMITS } from '../../core/dashboard/protocol';
import type { DashGitChange, DashGitRepo, DashboardState } from '../../core/types';
import { h, placeChildren, setAttr, setText, syncList } from '../dom';
import type { Slot } from '../dom';
import { GIT_STATUS_LABEL, GIT_STATUS_LETTER, formatCount } from '../format';
import { branchIcon } from '../icons';
import type { Frame, View } from '../model';
import { createFileButton, createNotice, heading, updateFileButton } from '../parts';

export const GIT_NOTE = 'Activity labelled Git is a change that happened at the same moment as a repository state change. It is a time correlation, not proof.';

type GroupId = 'staged' | 'unstaged' | 'untracked';

const GROUP_IDS: readonly GroupId[] = ['staged', 'unstaged', 'untracked'];
const GROUP_LABEL: Readonly<Record<GroupId, string>> = { staged: 'Staged', unstaged: 'Changes', untracked: 'Untracked' };

/** The reason is shown as the host gave it: it says whether the Git extension is missing, disabled or failed. */
export function gitNotice(s: DashboardState): { text: string; tone: 'info' | 'warning' } | null {
  const detail = s.git.detail.trim();
  switch (s.git.state) {
    case 'disabled':
      return { text: detail === '' ? 'Git integration is turned off (fileShake.git.enabled).' : `Git integration is turned off. ${detail}`, tone: 'info' };
    case 'unavailable':
      return { text: detail === '' ? 'Git is unavailable.' : `Git is unavailable: ${detail}`, tone: 'warning' };
    case 'loading':
      return { text: 'Loading Git status.', tone: 'info' };
    case 'ready':
      return null;
  }
}

interface ChangeSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly status: HTMLSpanElement;
  readonly dir: HTMLSpanElement;
  file: HTMLButtonElement | undefined;
  action: 'open' | 'openDiff' | undefined;
}

interface Group {
  readonly el: HTMLElement;
  readonly count: HTMLSpanElement;
  readonly list: HTMLUListElement;
  readonly slots: Map<string, ChangeSlot>;
}

interface RepoSlot extends Slot {
  readonly el: HTMLElement;
  readonly name: HTMLSpanElement;
  readonly branch: HTMLSpanElement;
  readonly branchText: HTMLSpanElement;
  readonly commit: HTMLSpanElement;
  readonly sync: HTMLSpanElement;
  readonly head: HTMLDivElement;
  readonly groups: Readonly<Record<GroupId, Group>>;
  readonly clean: HTMLParagraphElement;
  readonly truncated: HTMLParagraphElement;
}

export function createGit(doc: Document): View {
  const el = h(doc, 'div', 'fd-view');
  const notice = createNotice(doc, 'git');
  const empty = h(doc, 'p', 'fd-empty', {}, 'No Git repository was found in this workspace.');
  const repos = h(doc, 'div', 'fd-repos');
  const note = h(doc, 'p', 'fd-note', {}, GIT_NOTE);
  const repoSlots = new Map<string, RepoSlot>();

  const createGroup = (id: GroupId): Group => {
    const section = h(doc, 'section', 'fd-git-group', { 'data-group': id });
    const head = h(doc, 'div', 'fd-section-head');
    const count = h(doc, 'span', 'fd-note');
    head.append(heading(doc, GROUP_LABEL[id], 'h3'), count);
    const list = h(doc, 'ul', 'fd-git-list', { 'data-group': id });
    section.append(head, list);
    return { el: section, count, list, slots: new Map() };
  };

  const createRepo = (repo: DashGitRepo): RepoSlot => {
    const section = h(doc, 'section', 'fd-repo', { 'data-id': repo.id });
    const head = h(doc, 'div', 'fd-repo-head');
    const name = h(doc, 'span', 'fd-repo-name');
    const branch = h(doc, 'span', 'fd-branch');
    const branchText = h(doc, 'span', 'fd-branch-name');
    branch.append(branchIcon(doc), branchText);
    const commit = h(doc, 'span', 'fd-commit');
    const sync = h(doc, 'span', 'fd-sync');
    head.append(name, branch);
    const groups = { staged: createGroup('staged'), unstaged: createGroup('unstaged'), untracked: createGroup('untracked') };
    const clean = h(doc, 'p', 'fd-empty', {}, 'No uncommitted changes.');
    const truncated = h(doc, 'p', 'fd-note', {}, `Each list shows at most ${formatCount(DASH_LIMITS.GIT_CHANGES)} files.`);
    section.append(head);
    return { el: section, name, branch, branchText, commit, sync, head, groups, clean, truncated };
  };

  const updateChange = (slot: ChangeSlot, change: DashGitChange, group: GroupId, f: Frame): void => {
    setAttr(slot.el, 'data-status', change.status);
    setText(slot.status, GIT_STATUS_LETTER[change.status]);
    setAttr(slot.status, 'title', GIT_STATUS_LABEL[change.status]);
    // an untracked file has nothing to compare with, so its name opens the file itself
    const action = group === 'untracked' || change.status === 'untracked' ? 'open' : 'openDiff';
    if (!slot.file || slot.action !== action) {
      slot.file?.remove();
      slot.file = createFileButton(doc, action);
      slot.action = action;
      slot.el.insertBefore(slot.file, slot.dir);
    }
    updateFileButton(slot.file, change, action === 'openDiff' || f.exists(change.id));
    setAttr(slot.file, 'aria-label', `${change.name}, ${GIT_STATUS_LABEL[change.status]}`);
    setText(slot.dir, change.dir);
  };

  const updateRepo = (slot: RepoSlot, repo: DashGitRepo, f: Frame): void => {
    setText(slot.name, repo.name);
    setText(slot.branchText, repo.branch ?? 'no branch');
    setAttr(slot.branch, 'title', repo.branch === null ? 'Detached HEAD or no commit yet' : `Branch ${repo.branch}`);
    setText(slot.commit, repo.commit ?? '');
    const sync: string[] = [];
    if (repo.ahead > 0) sync.push(`↑${formatCount(repo.ahead)}`);
    if (repo.behind > 0) sync.push(`↓${formatCount(repo.behind)}`);
    setText(slot.sync, sync.join(' '));
    setAttr(slot.sync, 'aria-label', `${formatCount(repo.ahead)} ahead, ${formatCount(repo.behind)} behind`);
    setAttr(slot.sync, 'title', `${formatCount(repo.ahead)} ahead, ${formatCount(repo.behind)} behind the upstream branch`);
    placeChildren(slot.head, [slot.name, slot.branch, repo.commit !== null && repo.commit !== '' && slot.commit, sync.length > 0 && slot.sync]);

    const shown: HTMLElement[] = [];
    for (const id of GROUP_IDS) {
      const group = slot.groups[id];
      const changes = repo[id];
      syncList(
        group.list,
        changes,
        group.slots,
        (c) => c.id,
        (c) => {
          const li = h(doc, 'li', 'fd-git-item', { 'data-id': c.id });
          const status = h(doc, 'span', 'fd-git-status');
          const dir = h(doc, 'span', 'fd-dir');
          li.append(status, dir);
          return { el: li, status, dir, file: undefined, action: undefined };
        },
        (s, c) => updateChange(s, c, id, f),
      );
      setText(group.count, formatCount(changes.length));
      if (changes.length > 0) shown.push(group.el);
    }
    placeChildren(slot.el, [slot.head, ...shown, shown.length === 0 && slot.clean, repo.truncated && slot.truncated]);
  };

  return {
    el,
    render(f) {
      const s = f.state;
      const info = gitNotice(s);
      if (info) {
        setText(notice.text, info.text);
        setAttr(notice.el, 'data-tone', info.tone);
      }
      const ready = s.git.state === 'ready';
      syncList(repos, ready ? s.git.repos : [], repoSlots, (r) => r.id, createRepo, (slot, r) => updateRepo(slot, r, f));
      const any = ready && s.git.repos.length > 0;
      placeChildren(el, [info !== null && notice.el, ready && !any && empty, any && repos, any && note]);
    },
  };
}
