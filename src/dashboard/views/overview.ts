import type { DashTimelineItem, DashboardState } from '../../core/types';
import { button, h, placeChildren, setAttr, setText, syncList } from '../dom';
import type { Slot } from '../dom';
import { SOURCE_LABEL, agoLong, agoShort, ageCompact, eventPhrase, eventShort, formatClock, formatCount, plural, sourceText } from '../format';
import { sourceIcon } from '../icons';
import type { FilterId, Frame, TabId, View } from '../model';
import { createFileButton, createModeSwitch, createPauseButton, heading, updateFileButton } from '../parts';

/** Rows of the timeline shown on the Overview tab (the state may carry more). */
export const TIMELINE_SHOWN = 50;

type CardId = 'modified' | 'developer' | 'external' | 'ai' | 'unreviewed' | 'sessions';

interface CardSpec {
  id: CardId;
  tab: TabId;
  filter?: FilterId;
  /** [singular, plural] */
  label: readonly [string, string];
  value(s: DashboardState): number;
  describe(s: DashboardState, n: number): string;
}

/** "External" is everything that is neither you nor a reporting agent, so the cards add up to the total. */
export function externalCount(s: DashboardState): number {
  const b = s.overview.bySource;
  return b.external + b.git + b.automated + b.unknown;
}

function externalBreakdown(s: DashboardState): string {
  const b = s.overview.bySource;
  const parts = (['external', 'git', 'automated', 'unknown'] as const).filter((k) => b[k] > 0).map((k) => `${formatCount(b[k])} ${SOURCE_LABEL[k]}`);
  return parts.length > 1 ? ` (${parts.join(', ')})` : '';
}

const CARDS: readonly CardSpec[] = [
  {
    id: 'modified',
    tab: 'activity',
    filter: 'all',
    label: ['file', 'files'],
    value: (s) => s.overview.modifiedFiles,
    describe: (_s, n) => `${plural(n, 'file', 'files')} changed in the kept history`,
  },
  {
    id: 'developer',
    tab: 'activity',
    filter: 'mine',
    label: ['yours', 'yours'],
    value: (s) => s.overview.bySource.developer,
    describe: (_s, n) => `${plural(n, 'file', 'files')} changed by you`,
  },
  {
    id: 'external',
    tab: 'activity',
    filter: 'external',
    label: ['external', 'external'],
    value: externalCount,
    describe: (s, n) => `${plural(n, 'file', 'files')} changed by something other than you${externalBreakdown(s)}`,
  },
  {
    id: 'ai',
    tab: 'activity',
    filter: 'ai',
    label: ['AI agent', 'AI agent'],
    value: (s) => s.overview.bySource['ai-agent'],
    describe: (_s, n) => `${plural(n, 'file', 'files')} reported by an agent adapter`,
  },
  {
    id: 'unreviewed',
    tab: 'activity',
    filter: 'all',
    label: ['to review', 'to review'],
    value: (s) => s.overview.unreviewed,
    describe: (_s, n) => `${plural(n, 'file', 'files')} not reviewed yet`,
  },
  {
    id: 'sessions',
    tab: 'sessions',
    label: ['session', 'sessions'],
    value: (s) => s.overview.activeSessions,
    describe: (_s, n) => plural(n, 'active session', 'active sessions'),
  },
];

interface TimelineSlot extends Slot {
  readonly el: HTMLLIElement;
  readonly open: HTMLButtonElement;
  readonly meta: HTMLSpanElement;
  readonly time: HTMLSpanElement;
  source: DashTimelineItem['source'] | undefined;
}

/** Newest first, whatever order the host sent. Equal timestamps keep the host's order. */
function latest(items: readonly DashTimelineItem[]): DashTimelineItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.at - a.item.at || a.i - b.i)
    .slice(0, TIMELINE_SHOWN)
    .map((x) => x.item);
}

export function createOverview(doc: Document): View {
  const el = h(doc, 'div', 'fd-view');

  const cards = h(doc, 'div', 'fd-cards');
  const cardEls = CARDS.map((spec) => {
    const attrs: Record<string, string> = { 'data-card': spec.id, 'data-goto': spec.tab };
    if (spec.filter !== undefined) attrs['data-goto-filter'] = spec.filter;
    const card = button(doc, 'fd-card', attrs);
    const value = h(doc, 'span', 'fd-card-value', {}, '0');
    const label = h(doc, 'span', 'fd-card-label', {}, spec.label[1]);
    card.append(value, label);
    cards.appendChild(card);
    return { spec, card, value, label };
  });

  const bar = h(doc, 'div', 'fd-bar');
  const modeLabel = h(doc, 'span', 'fd-bar-label', {}, 'Mode');
  const modes = createModeSwitch(doc);
  const pause = createPauseButton(doc);
  bar.append(modeLabel, modes.el, pause.el);

  const summary = h(doc, 'section', 'fd-section fd-summary');
  const summaryHead = h(doc, 'div', 'fd-section-head');
  const summarize = button(doc, 'fd-act', { 'data-action': 'summarize' }, 'Summarize');
  summaryHead.append(heading(doc, 'Summary'), summarize);
  const summaryText = h(doc, 'p', 'fd-summary-text');
  const summaryMeta = h(doc, 'p', 'fd-note');
  summary.append(summaryHead, summaryText, summaryMeta);

  const timeline = h(doc, 'section', 'fd-section');
  const timelineHead = h(doc, 'div', 'fd-section-head');
  const timelineCount = h(doc, 'span', 'fd-note');
  timelineHead.append(heading(doc, 'Timeline'), timelineCount);
  const list = h(doc, 'ul', 'fd-timeline');
  const empty = h(doc, 'p', 'fd-empty');
  const slots = new Map<string, TimelineSlot>();

  el.append(cards, bar, summary, timeline);

  const createItem = (item: DashTimelineItem): TimelineSlot => {
    const li = h(doc, 'li', 'fd-tl', { 'data-id': item.id });
    const open = createFileButton(doc, 'open');
    const meta = h(doc, 'span', 'fd-tl-meta');
    const time = h(doc, 'span', 'fd-tl-time');
    li.append(open, meta, time);
    return { el: li, open, meta, time, source: undefined };
  };

  const updateItem = (slot: TimelineSlot, item: DashTimelineItem, f: Frame): void => {
    if (slot.source !== item.source) {
      slot.source = item.source;
      slot.el.querySelector('svg')?.remove();
      slot.el.insertBefore(sourceIcon(doc, item.source), slot.open);
      slot.el.setAttribute('data-source', item.source);
    }
    setAttr(slot.el, 'data-event', item.eventType);
    const label = [item.name, SOURCE_LABEL[item.source], eventPhrase(item.eventType, item.count), agoLong(f.now, item.at)].join(', ');
    setAttr(slot.el, 'aria-label', label);
    const session = item.sessionTitle === null || item.sessionTitle === '' ? '' : `. Session: ${item.sessionTitle}`;
    setAttr(slot.el, 'title', `${sourceText(item.source, item.sourceId)}, ${eventPhrase(item.eventType, item.count)}, ${formatClock(item.at)}${session}`);
    updateFileButton(slot.open, { id: item.fileId, name: item.name, dir: item.dir }, f.exists(item.fileId));
    setText(slot.meta, `${SOURCE_LABEL[item.source]} · ${eventShort(item.eventType, item.count)}`);
    setText(slot.time, ageCompact(f.now, item.at));
  };

  return {
    el,
    render(f) {
      const s = f.state;
      for (const c of cardEls) {
        const n = c.spec.value(s);
        setText(c.value, formatCount(n));
        setText(c.label, c.spec.label[n === 1 ? 0 : 1]);
        const where = c.spec.tab === 'sessions' ? 'Sessions' : 'Activity';
        setAttr(c.card, 'aria-label', `${c.spec.describe(s, n)}. Show in ${where}.`);
        setAttr(c.card, 'title', c.spec.describe(s, n));
      }
      modes.update(f.mode);
      pause.update(s.settings.paused);

      if (s.summary === null) {
        setText(summaryText, 'No summary yet.');
        setText(summarize, 'Summarize');
        placeChildren(summary, [summaryHead, summaryText]);
      } else {
        setText(summaryText, s.summary.text);
        const by = s.summary.provider === 'local' ? 'Built on this machine from file names and counts' : `From provider ${s.summary.provider}`;
        setText(summaryMeta, `${by}, ${agoShort(f.now, s.summary.at)}.`);
        setText(summarize, 'Refresh');
        placeChildren(summary, [summaryHead, summaryText, summaryMeta]);
      }

      const items = latest(s.timeline);
      syncList(list, items, slots, (i) => i.id, createItem, (slot, item) => updateItem(slot, item, f));
      if (items.length === 0) {
        setText(
          empty,
          !s.enabled
            ? 'No activity recorded. File Shake is turned off.'
            : s.settings.paused
              ? 'No activity recorded. Tracking is paused.'
              : 'No activity yet. Edit a file, or let a tool change one, and it appears here.',
        );
        setText(timelineCount, '');
        placeChildren(timeline, [timelineHead, empty]);
      } else {
        const total = s.overview.events;
        setText(timelineCount, total > items.length ? `latest ${formatCount(items.length)} of ${formatCount(total)}` : '');
        placeChildren(timeline, [timelineHead, list]);
      }
    },
  };
}
