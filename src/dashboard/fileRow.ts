import { round3 } from '../core/intensity';
import type { DashFileRow } from '../core/types';
import { button, h, placeChildren, setAttr, setClass, setText, setVar } from './dom';
import { METHOD_LABEL, SOURCE_HINT, agoShort, ageCompact, filePhrase, formatClock, percent, plural, rowSummary } from './format';
import type { Frame } from './model';
import { createFileButton, createLevelBadge, createSourceChip, updateFileButton } from './parts';

export interface FileRow {
  readonly el: HTMLLIElement;
  update(row: DashFileRow, f: Frame): void;
}

function sourceTitle(row: DashFileRow): string {
  const who = row.sourceId === null || row.sourceId === '' ? '' : ` Reported by ${row.sourceId}.`;
  return `${SOURCE_HINT[row.source]}${who} Detected by: ${METHOD_LABEL[row.method]}. Confidence ${percent(row.confidence)}.`;
}

function methodText(row: DashFileRow): string {
  const who = row.sourceId === null || row.sourceId === '' ? '' : ` (${row.sourceId})`;
  return `${METHOD_LABEL[row.method]}${who} · ${percent(row.confidence)}`;
}

/**
 * One activity row. The element is created once per file id and updated in place, so its animation
 * does not restart and a focused button inside it keeps the focus when a new state arrives.
 */
export function createFileRow(doc: Document, id: string): FileRow {
  const el = h(doc, 'li', 'fd-row', { 'data-id': id });

  // line 1: name, folder, source
  const head = h(doc, 'div', 'fd-row-head');
  const open = createFileButton(doc, 'open');
  const flag = h(doc, 'span', 'fd-flag', { 'aria-hidden': 'true', title: 'Not reviewed yet' });
  const dir = h(doc, 'span', 'fd-dir');
  const when = h(doc, 'span', 'fd-when');
  const source = createSourceChip(doc);

  // line 2: what happened, when, how it was detected, intensity meter
  const meta = h(doc, 'div', 'fd-row-meta');
  const event = h(doc, 'span', 'fd-row-event');
  const time = h(doc, 'span', 'fd-row-time');
  const method = h(doc, 'span', 'fd-row-method');
  const meter = h(doc, 'span', 'fd-meter', { 'aria-hidden': 'true' });
  meter.appendChild(h(doc, 'i'));
  meta.append(event, time, method, meter);

  // line 3: impact (impact mode), session, review state, actions
  const foot = h(doc, 'div', 'fd-row-foot');
  const impact = h(doc, 'span', 'fd-row-impact');
  const level = createLevelBadge(doc);
  const dependants = h(doc, 'span', 'fd-row-dependants');
  const session = h(doc, 'span', 'fd-row-session');
  const reviewed = h(doc, 'span', 'fd-reviewed', {}, 'Reviewed');
  const actions = h(doc, 'span', 'fd-actions');
  const review = button(doc, 'fd-act', { 'data-action': 'markReviewed', 'data-id': id }, 'Review');
  const diff = button(doc, 'fd-act', { 'data-action': 'openDiff', 'data-id': id }, 'Diff');
  const inspect = button(doc, 'fd-act', { 'data-action': 'select', 'data-id': id }, 'Inspect');

  return {
    el,
    update(row, f) {
      const compact = f.mode === 'compact';
      const shaking = f.shake && row.phase === 'active' && row.intensity > 0;
      setClass(el, shaking ? 'fd-row is-shaking' : 'fd-row');
      setAttr(el, 'data-source', row.source);
      setAttr(el, 'data-phase', row.phase);
      setAttr(el, 'data-review', row.review);
      setAttr(el, 'data-level', row.impactLevel);
      setAttr(el, 'data-exists', String(row.exists));
      setAttr(el, 'aria-label', rowSummary(row, f.now));
      setVar(el, '--fd-amp', `${row.shake.amp}px`);
      setVar(el, '--fd-dur', `${row.shake.dur}ms`);
      setVar(el, '--fd-rot', `${row.shake.rot}deg`);
      setVar(el, '--fd-level', String(round3(row.intensity)));

      updateFileButton(open, row, row.exists);
      setText(dir, row.dir);
      source.update(row.source, sourceTitle(row));
      const unreviewed = row.review === 'unreviewed';

      if (compact) {
        setText(when, ageCompact(f.now, row.lastAt));
        setAttr(when, 'title', formatClock(row.lastAt));
        placeChildren(head, [open, unreviewed && flag, dir, when, source.el]);
        placeChildren(el, [head]);
        return;
      }
      placeChildren(head, [open, unreviewed && flag, dir, source.el]);

      setText(event, filePhrase(row.lastEventType, row.changes));
      setText(time, agoShort(f.now, row.lastAt));
      setAttr(time, 'title', formatClock(row.lastAt));
      setText(method, methodText(row));

      const showImpact = f.mode === 'impact';
      if (showImpact) {
        if (row.impactLevel === null) {
          setText(dependants, 'Impact not analysed yet');
          placeChildren(impact, [dependants]);
        } else {
          level.update(row.impactLevel);
          setText(dependants, row.dependants === null ? '' : plural(row.dependants, 'dependant', 'dependants'));
          placeChildren(impact, [level.el, row.dependants !== null && dependants]);
        }
      }
      const inSession = row.sessionTitle !== null && row.sessionTitle !== '';
      if (inSession) {
        setText(session, `Session: ${row.sessionTitle ?? ''}`);
        setAttr(session, 'title', `Session: ${row.sessionTitle ?? ''}`);
      }

      const canDiff = f.hasDiff(row.id);
      const canInspect = row.exists && f.state.settings.dependencyIndex && f.state.index.state !== 'off';
      if (unreviewed) setAttr(review, 'aria-label', `Mark ${row.name} reviewed`);
      if (canDiff) setAttr(diff, 'aria-label', `Show uncommitted changes in ${row.name}`);
      if (canInspect) setAttr(inspect, 'aria-label', `Show dependencies and impact of ${row.name}`);
      const hasActions = unreviewed || canDiff || canInspect;
      placeChildren(actions, [unreviewed && review, canDiff && diff, canInspect && inspect]);
      placeChildren(foot, [showImpact && impact, inSession && session, row.review === 'reviewed' && reviewed, hasActions && actions]);
      placeChildren(el, [head, meta, foot.childElementCount > 0 && foot]);
    },
  };
}
