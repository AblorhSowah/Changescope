import type { DashFileRow, DashboardState } from '../../core/types';
import { button, h, placeChildren, setAttr, setText } from '../dom';
import { createFileRow } from '../fileRow';
import type { FileRow } from '../fileRow';
import { formatCount, plural } from '../format';
import { FILTERS } from '../model';
import type { FilterId, View } from '../model';
import { createAdapterList, createNotice, heading } from '../parts';
import { indexNotice } from './code';

/** `external` is every source that is neither you nor a reporting agent (External, Git, Automated, Unknown). */
export function matchesFilter(row: DashFileRow, filter: FilterId): boolean {
  switch (filter) {
    case 'live':
      return row.phase === 'active';
    case 'mine':
      return row.source === 'developer';
    case 'ai':
      return row.source === 'ai-agent';
    case 'external':
      return row.source !== 'developer' && row.source !== 'ai-agent';
    case 'all':
      return true;
  }
}

export const AI_EMPTY_TEXT = 'No agent adapter is reporting. Changes made by agents appear under External.';

function emptyText(filter: FilterId, s: DashboardState): string {
  const why = !s.enabled ? ' Changescope is turned off.' : s.settings.paused ? ' Tracking is paused.' : '';
  switch (filter) {
    case 'live':
      return `Nothing is changing right now.${why}`;
    case 'mine':
      return `No changes of yours in the history.${why}`;
    case 'external':
      return `No external changes in the history.${why}`;
    case 'ai':
      return AI_EMPTY_TEXT;
    case 'all':
      return why === '' ? 'No activity yet. Edit a file, or let a tool change one, and it appears here.' : `No activity recorded.${why}`;
  }
}

export function createActivity(doc: Document): View {
  const el = h(doc, 'div', 'fd-view');

  const chips = h(doc, 'div', 'fd-chips', { role: 'group', 'aria-label': 'Filter activity' });
  const chipEls = FILTERS.map((spec) => {
    const chip = button(doc, 'fd-chip', { 'data-filter': spec.id, 'aria-pressed': 'false' });
    const label = h(doc, 'span', 'fd-chip-label', {}, spec.label);
    const count = h(doc, 'span', 'fd-chip-count', {}, '0');
    chip.append(label, count);
    chips.appendChild(chip);
    return { spec, chip, count };
  });

  const toolbar = h(doc, 'div', 'fd-toolbar');
  const shown = h(doc, 'span', 'fd-note');
  const markAll = button(doc, 'fd-act', { 'data-action': 'markAllReviewed' }, 'Mark all reviewed');

  // impact mode depends on the dependency index, so its state is shown where the impact badges are
  const notice = createNotice(doc, 'index');
  const empty = h(doc, 'p', 'fd-empty');
  const list = h(doc, 'ul', 'fd-list');
  const rows = new Map<string, FileRow>();

  const adapters = h(doc, 'section', 'fd-section fd-agents');
  const adapterList = createAdapterList(doc);
  const adapterNote = h(doc, 'p', 'fd-note', {}, 'A change is labelled AI agent only when an adapter reports it. VS Code does not tell extensions which program wrote a file.');
  adapters.append(heading(doc, 'Agent adapters', 'h3'), adapterList.el, adapterNote);

  el.append(chips, toolbar, list);

  return {
    el,
    render(f) {
      const s = f.state;
      const filter = f.ui.activityFilter;
      const files = s.files;

      for (const c of chipEls) {
        let n = 0;
        for (const row of files) if (matchesFilter(row, c.spec.id)) n++;
        setAttr(c.chip, 'aria-pressed', String(c.spec.id === filter));
        setText(c.count, formatCount(n));
        setAttr(c.chip, 'aria-label', `${c.spec.label}: ${plural(n, 'file', 'files')}`);
      }

      const wanted: HTMLElement[] = [];
      const known = new Set<string>();
      for (const row of files) {
        if (known.has(row.id)) continue;
        known.add(row.id);
        if (!matchesFilter(row, filter)) continue;
        let r = rows.get(row.id);
        if (!r) {
          r = createFileRow(doc, row.id);
          rows.set(row.id, r);
        }
        r.update(row, f);
        wanted.push(r.el);
      }
      // rows hidden by the filter keep their element (and are refreshed when shown again); gone files do not
      for (const id of [...rows.keys()]) if (!known.has(id)) rows.delete(id);
      placeChildren(list, wanted);
      setAttr(list, 'data-filter', filter);

      const hidden = s.overview.modifiedFiles - files.length;
      const parts = [plural(wanted.length, 'file', 'files')];
      if (s.overview.unreviewed > 0) parts.push(`${formatCount(s.overview.unreviewed)} to review`);
      if (hidden > 0) parts.push(`${formatCount(hidden)} older not shown`);
      setText(shown, parts.join(' · '));
      placeChildren(toolbar, [shown, s.overview.unreviewed > 0 && markAll]);

      const isEmpty = wanted.length === 0;
      if (isEmpty) setText(empty, emptyText(filter, s));
      const showAdapters = filter === 'ai';
      if (showAdapters) adapterList.update(s.agents);
      const info = f.mode === 'impact' && !isEmpty ? indexNotice(s) : null;
      if (info) {
        setText(notice.text, info.text);
        setAttr(notice.el, 'data-tone', info.tone);
      }
      placeChildren(el, [chips, toolbar, info !== null && notice.el, isEmpty && empty, list, showAdapters && adapters]);
    },
  };
}
