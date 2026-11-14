import { DASH_LIMITS, SOURCE_TYPES, cleanTitle } from '../../core/dashboard/protocol';
import type { DashSession } from '../../core/types';
import { button, h, placeChildren, setAttr, setText, syncList } from '../dom';
import type { Slot } from '../dom';
import { SOURCE_LABEL, agoShort, formatClock, formatCount, formatDuration, plural } from '../format';
import { sourceIcon } from '../icons';
import type { Frame, View } from '../model';
import { heading } from '../parts';

export interface SessionsView extends View {
  /** Cleaned text of the start input. The input is emptied: the title now belongs to the message. */
  takeStartTitle(): string;
  /** Session being renamed, or null. */
  readonly renaming: string | null;
  beginRename(id: string): void;
  endRename(): void;
  /** Cleaned title typed for `id`. null (and the input is marked invalid) when it is empty or `id` is not being renamed. */
  renameTitle(id: string): string | null;
  renameInput(): HTMLInputElement | null;
  renameToggle(id: string): HTMLButtonElement | null;
}

const STATUS_LABEL: Readonly<Record<DashSession['status'], string>> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
};

interface SessionSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly head: HTMLDivElement;
  readonly title: HTMLSpanElement;
  readonly status: HTMLSpanElement;
  readonly input: HTMLInputElement;
  readonly meta: HTMLParagraphElement;
  readonly sources: HTMLDivElement;
  readonly actions: HTMLDivElement;
  readonly stop: HTMLButtonElement;
  readonly rename: HTMLButtonElement;
  readonly exportBtn: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  sourcesKey: string | undefined;
}

function metaText(s: DashSession, now: number): string {
  const work = `${plural(s.activityCount, 'change', 'changes')} in ${plural(s.fileCount, 'file', 'files')}`;
  const branch = s.branch === null || s.branch === '' ? '' : ` · ${s.branch}`;
  if (s.endedAt === null) return `Started ${agoShort(now, s.startedAt)} · ${work}${branch}`;
  return `${formatDuration(s.endedAt - s.startedAt)} · ended ${agoShort(now, s.endedAt)} · ${work}${branch}`;
}

export function createSessions(doc: Document): SessionsView {
  const el = h(doc, 'div', 'fd-view');

  // ----- start: a real text input, because a webview cannot prompt
  const start = h(doc, 'section', 'fd-section fd-session-start');
  const startLabel = h(doc, 'label', 'fd-label', { for: 'fd-session-title' }, 'New session');
  const startField = h(doc, 'div', 'fd-field');
  const startInput = h(doc, 'input', 'fd-input', {
    id: 'fd-session-title',
    type: 'text',
    'data-field': 'sessionTitle',
    maxlength: String(DASH_LIMITS.TITLE),
    placeholder: 'Title (optional)',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const startBtn = button(doc, 'fd-btn fd-btn--primary', { 'data-action': 'sessionStart' }, 'Start session');
  startField.append(startInput, startBtn);
  const startNote = h(doc, 'p', 'fd-note', {}, 'A session groups the changes made while you work on one task. Without a title it is named after the date and time.');
  start.append(startLabel, startField, startNote);

  // ----- the active session
  const current = h(doc, 'section', 'fd-section');
  const currentList = h(doc, 'ul', 'fd-sessions', { 'data-group': 'active' });
  current.append(heading(doc, 'Current session'), currentList);

  // ----- previous sessions
  const previous = h(doc, 'section', 'fd-section');
  const previousHead = h(doc, 'div', 'fd-section-head');
  const previousCount = h(doc, 'span', 'fd-note');
  previousHead.append(heading(doc, 'Previous sessions'), previousCount);
  const previousList = h(doc, 'ul', 'fd-sessions', { 'data-group': 'previous' });
  const previousEmpty = h(doc, 'p', 'fd-empty', {}, 'No previous sessions.');
  previous.append(previousHead, previousList);

  const currentSlots = new Map<string, SessionSlot>();
  const previousSlots = new Map<string, SessionSlot>();
  let renaming: string | null = null;

  const slotOf = (id: string): SessionSlot | undefined => currentSlots.get(id) ?? previousSlots.get(id);

  const createSlot = (s: DashSession): SessionSlot => {
    const li = h(doc, 'li', 'fd-session', { 'data-id': s.id });
    const head = h(doc, 'div', 'fd-session-head');
    const title = h(doc, 'span', 'fd-session-title');
    const status = h(doc, 'span', 'fd-tag fd-tag--status');
    const input = h(doc, 'input', 'fd-input', {
      type: 'text',
      'data-field': 'sessionRename',
      'data-id': s.id,
      maxlength: String(DASH_LIMITS.TITLE),
      'aria-label': 'Session title',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    // a session that stops while it is being renamed moves to the other list and gets a new slot
    if (renaming === s.id) input.value = s.title;
    const meta = h(doc, 'p', 'fd-session-meta');
    const sources = h(doc, 'div', 'fd-session-sources');
    const actions = h(doc, 'div', 'fd-actions');
    const stop = button(doc, 'fd-btn', { 'data-action': 'sessionStop' }, 'Stop');
    const rename = button(doc, 'fd-act', { 'data-edit': 'rename', 'data-id': s.id }, 'Rename');
    const exportBtn = button(doc, 'fd-act', { 'data-action': 'sessionExport', 'data-id': s.id }, 'Export report');
    const save = button(doc, 'fd-btn fd-btn--primary', { 'data-action': 'sessionRename', 'data-id': s.id }, 'Save');
    const cancel = button(doc, 'fd-btn', { 'data-edit': 'cancel' }, 'Cancel');
    return { el: li, head, title, status, input, meta, sources, actions, stop, rename, exportBtn, save, cancel, sourcesKey: undefined };
  };

  const updateSlot = (slot: SessionSlot, s: DashSession, f: Frame): void => {
    const editing = renaming === s.id;
    setAttr(slot.el, 'data-status', s.status);
    setAttr(slot.el, 'data-editing', editing ? 'true' : null);
    setText(slot.title, s.title);
    setText(slot.status, STATUS_LABEL[s.status]);
    const ended = s.endedAt === null ? '' : ` to ${formatClock(s.endedAt)}`;
    setAttr(slot.title, 'title', `${formatClock(s.startedAt)}${ended}`);
    placeChildren(slot.head, editing ? [slot.input] : [slot.title, s.status !== 'completed' && slot.status]);

    setText(slot.meta, metaText(s, f.now));

    const counts = SOURCE_TYPES.filter((t) => (s.bySource[t] ?? 0) > 0);
    const key = counts.map((t) => `${t}:${s.bySource[t] ?? 0}`).join(',');
    if (key !== slot.sourcesKey) {
      slot.sourcesKey = key;
      slot.sources.replaceChildren(
        ...counts.map((t) => {
          const chip = h(doc, 'span', 'fd-count', { 'data-source': t });
          chip.append(sourceIcon(doc, t), h(doc, 'span', '', {}, `${formatCount(s.bySource[t] ?? 0)} ${SOURCE_LABEL[t]}`));
          return chip;
        }),
      );
    }

    setAttr(slot.rename, 'aria-label', `Rename session ${s.title}`);
    setAttr(slot.exportBtn, 'aria-label', `Export a report of session ${s.title}`);
    setAttr(slot.stop, 'aria-label', `Stop session ${s.title}`);
    placeChildren(slot.actions, editing ? [slot.save, slot.cancel] : [s.endedAt === null && slot.stop, slot.rename, slot.exportBtn]);
    placeChildren(slot.el, [slot.head, slot.meta, counts.length > 0 && slot.sources, slot.actions]);
  };

  return {
    el,
    get renaming(): string | null {
      return renaming;
    },
    takeStartTitle(): string {
      const title = cleanTitle(startInput.value);
      startInput.value = '';
      return title;
    },
    beginRename(id: string): void {
      const slot = slotOf(id);
      if (!slot) return;
      renaming = id;
      slot.input.value = slot.title.textContent ?? '';
      slot.input.removeAttribute('aria-invalid');
    },
    endRename(): void {
      renaming = null;
    },
    renameTitle(id: string): string | null {
      const slot = slotOf(id);
      if (!slot || renaming !== id) return null;
      const title = cleanTitle(slot.input.value);
      if (title === '') {
        slot.input.setAttribute('aria-invalid', 'true');
        return null;
      }
      return title;
    },
    renameInput(): HTMLInputElement | null {
      return renaming === null ? null : (slotOf(renaming)?.input ?? null);
    },
    renameToggle(id: string): HTMLButtonElement | null {
      return slotOf(id)?.rename ?? null;
    },
    render(f) {
      const s = f.state;
      const active = s.sessions.active;
      // a session that is gone (cleared history) cannot stay in rename mode
      if (renaming !== null && active?.id !== renaming && !s.sessions.previous.some((p) => p.id === renaming)) renaming = null;

      syncList(currentList, active ? [active] : [], currentSlots, (x) => x.id, createSlot, (slot, x) => updateSlot(slot, x, f));
      syncList(previousList, s.sessions.previous, previousSlots, (x) => x.id, createSlot, (slot, x) => updateSlot(slot, x, f));
      setText(previousCount, s.sessions.previous.length > 0 ? formatCount(s.sessions.previous.length) : '');
      placeChildren(previous, [previousHead, s.sessions.previous.length === 0 && previousEmpty, previousList]);
      placeChildren(el, [active ? current : start, previous]);
    },
  };
}
