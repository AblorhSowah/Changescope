import type { DashboardState } from '../../core/types';
import { button, h, setAttr, setText } from '../dom';
import { formatCount, plural } from '../format';
import type { Frame, View } from '../model';
import { createModeSwitch, heading } from '../parts';

interface Switch {
  readonly el: HTMLButtonElement;
  update(checked: boolean): void;
}

/** A real button with role=switch. `data-value` is what the click sends: the opposite of the current state. */
function createSwitch(doc: Document, action: 'setAnimate' | 'setPaused', label: string): Switch {
  const el = button(doc, 'fd-switch', { role: 'switch', 'aria-checked': 'false', 'data-action': action, 'data-value': 'true' });
  const track = h(doc, 'span', 'fd-switch-track', { 'aria-hidden': 'true' });
  track.appendChild(h(doc, 'i'));
  const text = h(doc, 'span', 'fd-switch-label', {}, label);
  // the word, not only the knob position or its colour, says whether it is on
  const state = h(doc, 'span', 'fd-switch-state', { 'aria-hidden': 'true' }, 'Off');
  el.append(track, text, state);
  return {
    el,
    update(checked) {
      setAttr(el, 'aria-checked', String(checked));
      setAttr(el, 'data-value', String(!checked));
      setText(state, checked ? 'On' : 'Off');
    },
  };
}

interface Fact {
  readonly el: HTMLDivElement;
  readonly value: HTMLElement;
}

function createFact(doc: Document, id: string, label: string): Fact {
  const el = h(doc, 'div', 'fd-fact', { 'data-setting': id });
  const value = h(doc, 'dd');
  el.append(h(doc, 'dt', '', {}, label), value);
  return { el, value };
}

function onOff(v: boolean): string {
  return v ? 'On' : 'Off';
}

function animationNote(f: Frame): string {
  const strength = `Shake intensity ×${f.state.settings.animationIntensity}.`;
  if (f.reducedMotion) return 'Your system asks for reduced motion, so nothing moves even when this is on.';
  if (f.mode === 'compact') return 'Compact mode never animates.';
  if (f.mode === 'impact') return `File names shake only in Live mode. ${strength}`;
  return `File names shake while their file is changing. ${strength}`;
}

function gitFact(s: DashboardState): string {
  if (!s.settings.gitEnabled) return 'Off';
  if (s.git.state === 'unavailable') return 'On, but Git is unavailable';
  return 'On';
}

function indexFact(s: DashboardState): string {
  if (!s.settings.dependencyIndex || s.index.state === 'off') return 'Off';
  if (s.index.state === 'indexing') return 'On, indexing';
  if (s.index.state === 'idle') return 'On, built on first use';
  return `On, ${plural(s.index.indexed, 'file', 'files')} indexed`;
}

export function aiText(s: DashboardState): string {
  if (s.settings.aiMode === 'local') return 'Local: summaries are built on this machine from file names and counts. Nothing is sent anywhere.';
  if (s.settings.aiProvider === null || s.settings.aiProvider === '') {
    return 'Assisted mode is selected, but no provider is in use, so summaries are built on this machine and nothing is sent.';
  }
  return `Assisted: summaries are requested from the provider "${s.settings.aiProvider}". File names, counts, source labels and the branch name are sent, never file contents. You are asked for consent before the first request.`;
}

export function createSettings(doc: Document): View {
  const el = h(doc, 'div', 'fd-view');

  // ----- view
  const view = h(doc, 'section', 'fd-section');
  const modeRow = h(doc, 'div', 'fd-setting', { 'data-setting': 'mode' });
  const modes = createModeSwitch(doc);
  const modeNote = h(doc, 'p', 'fd-note');
  modeRow.append(h(doc, 'span', 'fd-label', {}, 'Mode'), modes.el, modeNote);
  const animateRow = h(doc, 'div', 'fd-setting', { 'data-setting': 'animate' });
  const animate = createSwitch(doc, 'setAnimate', 'Animation');
  const animateNote = h(doc, 'p', 'fd-note');
  animateRow.append(animate.el, animateNote);
  view.append(heading(doc, 'View'), modeRow, animateRow);

  // ----- tracking
  const tracking = h(doc, 'section', 'fd-section');
  const pauseRow = h(doc, 'div', 'fd-setting', { 'data-setting': 'paused' });
  const pause = createSwitch(doc, 'setPaused', 'Pause tracking');
  const pauseNote = h(doc, 'p', 'fd-note');
  pauseRow.append(pause.el, pauseNote);
  const facts = h(doc, 'dl', 'fd-facts');
  const git = createFact(doc, 'git', 'Git integration');
  const index = createFact(doc, 'dependencyIndex', 'Dependency index');
  const collisions = createFact(doc, 'collisions', 'Unsaved-edit warnings');
  facts.append(git.el, index.el, collisions.el);
  tracking.append(heading(doc, 'Tracking'), pauseRow, facts);

  // ----- history
  const history = h(doc, 'section', 'fd-section', { 'data-setting': 'history' });
  const historyText = h(doc, 'p', 'fd-text');
  const clear = button(doc, 'fd-btn', { 'data-action': 'clearHistory' }, 'Clear history');
  const clearNote = h(doc, 'p', 'fd-note', {}, 'Removes recorded activity and completed sessions for this workspace. You are asked to confirm first.');
  history.append(heading(doc, 'History'), historyText, clear, clearNote);

  // ----- AI
  const ai = h(doc, 'section', 'fd-section', { 'data-setting': 'ai' });
  const aiPara = h(doc, 'p', 'fd-text');
  ai.append(heading(doc, 'Summaries'), aiPara);

  const all = button(doc, 'fd-btn', { 'data-action': 'openSettings' }, 'Open all settings');

  el.append(view, tracking, history, ai, all);

  const MODE_NOTE = {
    live: 'Live: file names shake while their file is changing.',
    compact: 'Compact: one line per file, no animation.',
    impact: 'Impact: each file shows the estimated reach of its change.',
  } as const;

  return {
    el,
    render(f) {
      const s = f.state;
      modes.update(f.mode);
      setText(modeNote, MODE_NOTE[f.mode]);
      animate.update(s.settings.animate);
      setText(animateNote, animationNote(f));
      pause.update(s.settings.paused);
      setText(pauseNote, s.settings.paused ? 'Paused: new changes are not recorded. History is kept.' : 'Changes are being recorded.');
      setText(git.value, gitFact(s));
      setText(index.value, indexFact(s));
      setText(collisions.value, onOff(s.settings.collisions));
      setAttr(el, 'data-ai-mode', s.settings.aiMode);
      setText(
        historyText,
        `${plural(s.overview.events, 'event', 'events')} stored. Up to ${formatCount(s.settings.historyLimit)} are kept, for ${plural(s.settings.retentionDays, 'day', 'days')}.`,
      );
      setText(aiPara, aiText(s));
    },
  };
}
