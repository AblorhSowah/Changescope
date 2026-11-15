import { DASH_LIMITS } from '../../core/dashboard/protocol';
import type { DashDep, DashFileRow, DashImpact, DashboardState } from '../../core/types';
import { button, h, placeChildren, setAttr, setText, syncList } from '../dom';
import type { Slot } from '../dom';
import { RELATIONSHIP_LABEL, formatCount, plural } from '../format';
import { CODE_VIEWS } from '../model';
import type { Frame, View } from '../model';
import { createFileButton, createFileList, createLevelBadge, createNotice, heading, updateFileButton } from '../parts';
import type { FileList, LevelBadge } from '../parts';

/** Files offered for inspection while nothing is selected. */
export const PICK_SHOWN = 8;

export const DEPENDENCY_NOTE = 'Edges come from a text scan of import statements, not from a language server, so some may be missing.';
export const IMPACT_NOTE = 'Impact levels are estimates from import edges. They are not confirmed defects.';

/** What the user should know about the dependency index right now, or null when there is nothing to say. */
export function indexNotice(s: DashboardState): { text: string; tone: 'info' | 'warning' } | null {
  const i = s.index;
  if (!s.settings.dependencyIndex || i.state === 'off') {
    return { text: 'The dependency index is turned off (changescope.dependencies.index), so dependencies and impact are not available.', tone: 'info' };
  }
  if (i.state === 'indexing') {
    return { text: i.total > 0 ? `Indexing dependencies: ${formatCount(i.indexed)} of ${formatCount(i.total)} files.` : 'Indexing dependencies.', tone: 'info' };
  }
  if (i.state === 'idle') {
    return { text: 'The dependency index has not been built yet. It is built the first time you inspect a file.', tone: 'info' };
  }
  if (i.truncated) {
    return { text: `The index stopped at its limit of ${formatCount(i.indexed)} files, so some dependants may be missing.`, tone: 'warning' };
  }
  return null;
}

interface DepSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly open: HTMLButtonElement;
  readonly dir: HTMLSpanElement;
  readonly rel: HTMLSpanElement;
  readonly test: HTMLSpanElement;
  readonly inspect: HTMLButtonElement;
}

interface DepSection {
  readonly el: HTMLElement;
  update(deps: readonly DashDep[], f: Frame, emptyText: string): void;
}

function createDepSection(doc: Document, kind: 'imports' | 'importedBy', title: string): DepSection {
  const el = h(doc, 'section', 'fd-section', { 'data-deps': kind });
  const head = h(doc, 'div', 'fd-section-head');
  const count = h(doc, 'span', 'fd-note');
  head.append(heading(doc, title, 'h3'), count);
  const list = h(doc, 'ul', 'fd-deps');
  const empty = h(doc, 'p', 'fd-empty');
  const slots = new Map<string, DepSlot>();
  el.append(head, list);
  return {
    el,
    update(deps, f, emptyText) {
      syncList(
        list,
        deps,
        slots,
        (d) => d.id,
        (d) => {
          const li = h(doc, 'li', 'fd-dep', { 'data-id': d.id });
          const open = createFileButton(doc, 'open');
          const dir = h(doc, 'span', 'fd-dir');
          const rel = h(doc, 'span', 'fd-tag');
          const test = h(doc, 'span', 'fd-tag fd-tag--test', {}, 'test');
          const inspect = button(doc, 'fd-act', { 'data-action': 'select', 'data-id': d.id }, 'Inspect');
          return { el: li, open, dir, rel, test, inspect };
        },
        (slot, d) => {
          setAttr(slot.el, 'data-relationship', d.relationship);
          updateFileButton(slot.open, d, f.exists(d.id));
          setText(slot.dir, d.dir);
          setText(slot.rel, d.count > 1 ? `${RELATIONSHIP_LABEL[d.relationship]} ×${formatCount(d.count)}` : RELATIONSHIP_LABEL[d.relationship]);
          setAttr(slot.inspect, 'aria-label', `Show dependencies and impact of ${d.name}`);
          placeChildren(slot.el, [slot.open, slot.dir, d.isTest && slot.test, slot.rel, slot.inspect]);
        },
      );
      const capped = deps.length >= DASH_LIMITS.DEPS;
      setText(count, capped ? `first ${formatCount(deps.length)}` : formatCount(deps.length));
      if (deps.length === 0) setText(empty, emptyText);
      placeChildren(el, [head, deps.length === 0 && empty, list]);
    },
  };
}

interface ImpactCard extends Slot {
  readonly el: HTMLDivElement;
  update(impact: DashImpact, f: Frame, detailed: boolean): void;
}

function createImpactCard(doc: Document): ImpactCard {
  const el = h(doc, 'div', 'fd-impact');
  const head = h(doc, 'div', 'fd-impact-head');
  const open = createFileButton(doc, 'open');
  const dir = h(doc, 'span', 'fd-dir');
  const level: LevelBadge = createLevelBadge(doc);
  head.append(open, dir, level.el);
  const counts = h(doc, 'p', 'fd-impact-counts');
  const reasons = h(doc, 'ul', 'fd-reasons');
  let reasonsKey: string | undefined;

  const testsHead = heading(doc, 'Tests to run', 'h3');
  const tests: FileList = createFileList(doc, 'fd-impact-tests');
  const configsHead = heading(doc, 'Configuration files', 'h3');
  const configs: FileList = createFileList(doc, 'fd-impact-configs');
  const details = h(doc, 'details', 'fd-details');
  const summary = h(doc, 'summary', 'fd-details-summary');
  const affected: FileList = createFileList(doc, 'fd-impact-affected');
  details.append(summary, affected.el);

  const foot = h(doc, 'div', 'fd-impact-foot');
  const testCount = h(doc, 'span', 'fd-note');
  const inspect = button(doc, 'fd-act', { 'data-action': 'select' }, 'Inspect');
  foot.append(testCount, inspect);

  return {
    el,
    update(impact, f, detailed) {
      setAttr(el, 'data-id', impact.file.id);
      setAttr(el, 'data-level', impact.level);
      setAttr(el, 'data-complete', String(impact.complete));
      updateFileButton(open, impact.file, f.exists(impact.file.id));
      setText(dir, impact.file.dir);
      level.update(impact.level);
      const partial = impact.complete ? '' : ' · partial estimate';
      setText(counts, `${formatCount(impact.direct)} direct · ${formatCount(impact.indirect)} indirect ${impact.direct + impact.indirect === 1 ? 'dependant' : 'dependants'}${partial}`);

      // reasons carry no state of their own, so they are rebuilt, but only when their text changed
      const key = JSON.stringify(impact.reasons);
      if (key !== reasonsKey) {
        reasonsKey = key;
        reasons.replaceChildren(...impact.reasons.map((r) => h(doc, 'li', '', {}, r)));
      }

      if (!detailed) {
        setText(testCount, impact.tests.length === 0 ? 'No related tests found' : plural(impact.tests.length, 'related test', 'related tests'));
        setAttr(inspect, 'data-id', impact.file.id);
        setAttr(inspect, 'aria-label', `Show dependencies and impact of ${impact.file.name}`);
        placeChildren(el, [head, counts, impact.reasons.length > 0 && reasons, foot]);
        return;
      }
      tests.update(impact.tests, f.exists);
      configs.update(impact.configs, f.exists);
      affected.update(impact.affected, f.exists);
      setText(testsHead, `Tests to run (${formatCount(impact.tests.length)})`);
      const total = impact.direct + impact.indirect;
      const shown = impact.affected.length;
      setText(summary, shown < total ? `Affected files (first ${formatCount(shown)} of ${formatCount(total)})` : `Affected files (${formatCount(shown)})`);
      placeChildren(el, [
        head,
        counts,
        impact.reasons.length > 0 && reasons,
        impact.tests.length > 0 && testsHead,
        impact.tests.length > 0 && tests.el,
        impact.configs.length > 0 && configsHead,
        impact.configs.length > 0 && configs.el,
        shown > 0 && details,
      ]);
    },
  };
}

interface PickSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly pick: HTMLButtonElement;
  readonly dir: HTMLSpanElement;
}

export function createCode(doc: Document): View {
  const el = h(doc, 'div', 'fd-view');

  const seg = h(doc, 'div', 'fd-seg', { role: 'group', 'aria-label': 'Code view' });
  const segEls = CODE_VIEWS.map((spec) => {
    const b = button(doc, 'fd-seg-btn', { 'data-code-view': spec.id, 'aria-pressed': 'false' }, spec.label);
    seg.appendChild(b);
    return { spec, b };
  });

  const notice = createNotice(doc, 'index');
  const indexNote = h(doc, 'p', 'fd-note');

  // ----- the selected file, or a short list to pick from
  const selected = h(doc, 'section', 'fd-section fd-selected');
  const selectedHead = heading(doc, 'Selected file');
  const selectedFile = h(doc, 'div', 'fd-selected-file');
  const selectedOpen = createFileButton(doc, 'open');
  const selectedDir = h(doc, 'span', 'fd-dir');
  selectedFile.append(selectedOpen, selectedDir);
  const noSelection = h(doc, 'p', 'fd-empty');
  const pickList = h(doc, 'ul', 'fd-pick');
  const pickSlots = new Map<string, PickSlot>();
  selected.append(selectedHead, noSelection);

  // ----- dependencies
  const imports = createDepSection(doc, 'imports', 'Imports');
  const importedBy = createDepSection(doc, 'importedBy', 'Imported by');
  const depNote = h(doc, 'p', 'fd-note', {}, DEPENDENCY_NOTE);

  // ----- impact
  const selectedImpact = createImpactCard(doc);
  selectedImpact.el.classList.add('fd-impact--selected');
  const noImpact = h(doc, 'p', 'fd-empty');
  const others = h(doc, 'section', 'fd-section');
  const othersList = h(doc, 'div', 'fd-impacts');
  const otherSlots = new Map<string, ImpactCard>();
  others.append(heading(doc, 'Changed files', 'h3'), othersList);
  const impactNote = h(doc, 'p', 'fd-note', {}, IMPACT_NOTE);

  el.append(seg, selected);

  const updatePick = (files: readonly DashFileRow[]): void => {
    syncList(
      pickList,
      files,
      pickSlots,
      (r) => r.id,
      (r) => {
        const li = h(doc, 'li', 'fd-file-item', { 'data-id': r.id });
        const pick = button(doc, 'fd-file', { 'data-action': 'select', 'data-id': r.id });
        const dir = h(doc, 'span', 'fd-dir');
        li.append(pick, dir);
        return { el: li, pick, dir };
      },
      (slot, r) => {
        setText(slot.pick, r.name);
        setAttr(slot.pick, 'aria-label', `Inspect ${r.name}`);
        setText(slot.dir, r.dir);
      },
    );
  };

  return {
    el,
    render(f) {
      const s = f.state;
      const view = f.ui.codeView;
      setAttr(el, 'data-code-view', view);
      for (const { spec, b } of segEls) setAttr(b, 'aria-pressed', String(spec.id === view));

      const info = indexNotice(s);
      if (info) {
        setText(notice.text, info.text);
        setAttr(notice.el, 'data-tone', info.tone);
      } else {
        setText(indexNote, `Dependency index: ${plural(s.index.indexed, 'file', 'files')}.`);
      }
      const indexOff = !s.settings.dependencyIndex || s.index.state === 'off';

      const file = s.selection.file;
      if (file) {
        updateFileButton(selectedOpen, file, f.exists(file.id));
        setText(selectedDir, file.dir);
        placeChildren(selected, [selectedHead, selectedFile]);
      } else {
        const candidates = indexOff ? [] : s.files.filter((r) => r.exists).slice(0, PICK_SHOWN);
        updatePick(candidates);
        setText(
          noSelection,
          indexOff
            ? 'No file selected.'
            : candidates.length > 0
              ? 'No file selected. Pick a changed file, or use Inspect on a row in Activity.'
              : 'No file selected. Changed files appear here once there is activity.',
        );
        placeChildren(selected, [selectedHead, noSelection, candidates.length > 0 && pickList]);
      }

      const body: Array<HTMLElement | false> = [];
      if (view === 'dependencies') {
        if (file) {
          imports.update(s.selection.imports, f, 'No imports were found in this file.');
          importedBy.update(s.selection.importedBy, f, s.index.state === 'ready' ? 'No file imports this one.' : 'No importing files found so far.');
          body.push(imports.el, importedBy.el);
        }
        body.push(depNote);
      } else {
        const own = s.selection.impact;
        if (own) {
          selectedImpact.update(own, f, true);
          body.push(selectedImpact.el);
        } else if (file) {
          setText(noImpact, s.index.state === 'indexing' ? 'The impact of this file is being estimated.' : 'No impact estimate for this file yet.');
          body.push(noImpact);
        }
        const rest = s.impacts.filter((i) => i.file.id !== own?.file.id);
        syncList(othersList, rest, otherSlots, (i) => i.file.id, () => createImpactCard(doc), (card, i) => card.update(i, f, false));
        if (rest.length > 0) body.push(others);
        else if (!own && !file) {
          setText(noImpact, 'No impact estimates yet. They appear when you inspect a file or switch to Impact mode.');
          body.push(noImpact);
        }
        body.push(impactNote);
      }
      placeChildren(el, [seg, info ? notice.el : indexNote, selected, ...body]);
    },
  };
}
