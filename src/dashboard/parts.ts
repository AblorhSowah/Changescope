import { VIEW_MODES } from '../core/dashboard/protocol';
import type { ActivitySourceType, DashAgentAdapter, DashFileRef, ImpactLevel, ViewMode } from '../core/types';
import { button, h, placeChildren, setAttr, setDisabled, setText, syncList } from './dom';
import type { Slot } from './dom';
import { LEVEL_LABEL, MODE_LABEL, SOURCE_LABEL, displayPath } from './format';
import { sourceIcon } from './icons';

/** Small pieces shared by several tabs. Each is created once and updated in place. */

export function heading(doc: Document, text: string, tag: 'h2' | 'h3' = 'h2'): HTMLHeadingElement {
  return h(doc, tag, tag === 'h2' ? 'fd-h' : 'fd-h fd-h--sub', {}, text);
}

// ----- source chip: icon shape + text label ---------------------------------------------------

export interface SourceChip {
  readonly el: HTMLSpanElement;
  update(source: ActivitySourceType, title: string): void;
}

export function createSourceChip(doc: Document): SourceChip {
  const el = h(doc, 'span', 'fd-source');
  const label = h(doc, 'span', 'fd-source-label');
  el.appendChild(label);
  let current: ActivitySourceType | undefined;
  return {
    el,
    update(source, title) {
      if (source !== current) {
        current = source;
        // the shape is the source: a re-attributed row gets a new icon, not a recoloured one
        el.querySelector('svg')?.remove();
        el.insertBefore(sourceIcon(doc, source), label);
        el.setAttribute('data-source', source);
        label.textContent = SOURCE_LABEL[source];
      }
      setAttr(el, 'title', title === '' ? null : title);
    },
  };
}

// ----- impact level: bars + text label --------------------------------------------------------

export interface LevelBadge {
  readonly el: HTMLSpanElement;
  update(level: ImpactLevel): void;
}

export function createLevelBadge(doc: Document): LevelBadge {
  const el = h(doc, 'span', 'fd-level');
  const bars = h(doc, 'span', 'fd-level-bars', { 'aria-hidden': 'true' });
  for (let i = 0; i < 4; i++) bars.appendChild(h(doc, 'i'));
  const label = h(doc, 'span', 'fd-level-label');
  el.append(bars, label);
  return {
    el,
    update(level) {
      setAttr(el, 'data-level', level);
      setText(label, LEVEL_LABEL[level]);
      setAttr(el, 'title', `Estimated impact: ${LEVEL_LABEL[level].toLowerCase()}`);
    },
  };
}

// ----- notices --------------------------------------------------------------------------------

export interface Notice {
  readonly el: HTMLDivElement;
  readonly text: HTMLSpanElement;
}

/**
 * A visible status line. aria-live is off on purpose: every status change is announced once, throttled,
 * through the single live region of the app, so a progress count does not talk over the user.
 */
export function createNotice(doc: Document, kind: string, tone: 'info' | 'warning' = 'info'): Notice {
  const el = h(doc, 'div', 'fd-notice', { role: 'status', 'aria-live': 'off', 'data-kind': kind, 'data-tone': tone });
  const text = h(doc, 'span', 'fd-notice-text');
  el.appendChild(text);
  return { el, text };
}

// ----- file name buttons ----------------------------------------------------------------------

/** `open` shows the file, `openDiff` its uncommitted change. The class fd-open marks the first kind. */
export function createFileButton(doc: Document, action: 'open' | 'openDiff'): HTMLButtonElement {
  return button(doc, action === 'open' ? 'fd-file fd-open' : 'fd-file fd-open-diff', { 'data-action': action });
}

export function updateFileButton(btn: HTMLButtonElement, file: DashFileRef, exists: boolean): void {
  setAttr(btn, 'data-id', file.id);
  setText(btn, file.name);
  setDisabled(btn, !exists);
  const path = displayPath(file);
  const verb = btn.getAttribute('data-action') === 'openDiff' ? 'Show changes in' : 'Open';
  setAttr(btn, 'title', exists ? `${verb} ${path}` : `${path} was deleted`);
}

interface FileSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly open: HTMLButtonElement;
  readonly dir: HTMLSpanElement;
}

export interface FileList {
  readonly el: HTMLUListElement;
  update(files: readonly DashFileRef[], exists: (id: string) => boolean): void;
}

/** A plain list of files: name (opens it) and folder. */
export function createFileList(doc: Document, cls: string): FileList {
  const el = h(doc, 'ul', `fd-files ${cls}`);
  const slots = new Map<string, FileSlot>();
  return {
    el,
    update(files, exists) {
      syncList(
        el,
        files,
        slots,
        (f) => f.id,
        (f) => {
          const li = h(doc, 'li', 'fd-file-item', { 'data-id': f.id });
          const open = createFileButton(doc, 'open');
          const dir = h(doc, 'span', 'fd-dir');
          li.append(open, dir);
          return { el: li, open, dir };
        },
        (slot, f) => {
          updateFileButton(slot.open, f, exists(f.id));
          setText(slot.dir, f.dir);
        },
      );
    },
  };
}

// ----- mode switch and pause ------------------------------------------------------------------

export interface ModeSwitch {
  readonly el: HTMLDivElement;
  update(mode: ViewMode): void;
}

const MODE_HINT: Readonly<Record<ViewMode, string>> = {
  live: 'Live: files shake while they change',
  compact: 'Compact: one line per file, no animation',
  impact: 'Impact: shows the estimated reach of each change',
};

export function createModeSwitch(doc: Document): ModeSwitch {
  const el = h(doc, 'div', 'fd-modes', { role: 'group', 'aria-label': 'View mode' });
  const buttons = VIEW_MODES.map((mode) => {
    const b = button(doc, 'fd-mode', { 'data-action': 'setMode', 'data-mode': mode, 'aria-pressed': 'false', title: MODE_HINT[mode] }, MODE_LABEL[mode]);
    el.appendChild(b);
    return { mode, b };
  });
  return {
    el,
    update(mode) {
      for (const { mode: m, b } of buttons) setAttr(b, 'aria-pressed', String(m === mode));
    },
  };
}

export interface PauseButton {
  readonly el: HTMLButtonElement;
  update(paused: boolean): void;
}

/** `data-value` is the value the click sends: the opposite of the current state. */
export function createPauseButton(doc: Document): PauseButton {
  const el = button(doc, 'fd-btn fd-pause', { 'data-action': 'setPaused', 'data-value': 'true' }, 'Pause');
  return {
    el,
    update(paused) {
      setAttr(el, 'data-value', String(!paused));
      setText(el, paused ? 'Resume' : 'Pause');
      setAttr(el, 'title', paused ? 'Start recording changes again' : 'Stop recording changes. History is kept.');
    },
  };
}

// ----- agent adapters -------------------------------------------------------------------------

const ADAPTER_STATE: Readonly<Record<DashAgentAdapter['state'], string>> = {
  listening: 'Listening',
  off: 'Off',
  unavailable: 'Unavailable',
};

interface AdapterSlot extends Slot {
  readonly label: HTMLSpanElement;
  readonly state: HTMLSpanElement;
  readonly detail: HTMLSpanElement;
}

export interface AdapterList {
  readonly el: HTMLUListElement;
  update(agents: readonly DashAgentAdapter[]): void;
}

export function createAdapterList(doc: Document): AdapterList {
  const el = h(doc, 'ul', 'fd-adapters');
  const slots = new Map<string, AdapterSlot>();
  return {
    el,
    update(agents) {
      syncList(
        el,
        agents,
        slots,
        (a) => a.id,
        (a) => {
          const li = h(doc, 'li', 'fd-adapter', { 'data-id': a.id });
          const label = h(doc, 'span', 'fd-adapter-label');
          const state = h(doc, 'span', 'fd-adapter-state');
          const detail = h(doc, 'span', 'fd-adapter-detail');
          li.append(label, state);
          return { el: li, label, state, detail };
        },
        (slot, a) => {
          setAttr(slot.el, 'data-state', a.state);
          setText(slot.label, a.label);
          setText(slot.state, ADAPTER_STATE[a.state]);
          setText(slot.detail, a.detail);
          placeChildren(slot.el, [slot.label, slot.state, a.detail !== '' && slot.detail]);
        },
      );
    },
  };
}
