import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DISABLED_TEXT, LOADING_TEXT, PAUSED_TEXT } from '../../src/dashboard/app';
import { SOURCE_TYPES } from '../../src/core/dashboard/protocol';
import type { ActivitySourceType } from '../../src/core/types';
import { activityRows, click, goTo, mountDash, rowFor, textOf } from '../support/dashDom';
import type { DashHarness } from '../support/dashDom';
import { HOUR, MIN, NOW, S, activeRow, busyState, change, dashSession, dashState, impact, manyRows, ref, repo, row, timelineItem } from '../support/dashState';
import { must } from '../support/fixtures';

let h: DashHarness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const LABEL: Record<ActivitySourceType, string> = { developer: 'Developer', 'ai-agent': 'AI agent', external: 'External', git: 'Git', automated: 'Automated', unknown: 'Unknown' };

function mount(o: Parameters<typeof mountDash>[0] = {}): DashHarness {
  h = mountDash(o);
  return h;
}

describe('dashboard: mount and skeleton', () => {
  it('posts exactly one {type:"ready"} on mount and nothing else', () => {
    const d = mount();
    assert.deepEqual(d.host.messages, [{ type: 'ready' }]);
    assert.equal(d.app.lastSeq, -1, 'no state yet');
  });

  it('before the first state: data-state=loading, a loading notice, defaults on #app', () => {
    const d = mount();
    assert.equal(d.root.getAttribute('data-state'), 'loading');
    assert.equal(d.root.getAttribute('data-mode'), 'live');
    assert.equal(d.root.getAttribute('data-motion'), 'on');
    assert.equal(d.root.getAttribute('data-enabled'), 'true');
    assert.equal(d.root.getAttribute('data-tab'), 'overview');
    const notice = d.q('.fd-notice', d.root);
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(textOf(notice), LOADING_TEXT);
    assert.equal(d.qa('li.fd-row').length, 0);
  });

  it('after the first valid state: data-state=ready and the loading notice is gone', () => {
    const d = mount();
    d.send(dashState());
    assert.equal(d.root.getAttribute('data-state'), 'ready');
    assert.equal(d.qa('.fd-notice').some((n) => textOf(n) === LOADING_TEXT), false);
    assert.equal(d.app.lastSeq, 1);
  });

  it('the page has the six tabs in order, in a tablist with an accessible name', () => {
    const d = mount();
    const nav = d.q('nav.fd-tabs');
    assert.equal(nav.getAttribute('role'), 'tablist');
    assert.ok((nav.getAttribute('aria-label') ?? '').length > 0);
    assert.deepEqual(
      d.qa('button.fd-tab').map((t) => t.getAttribute('data-tab')),
      ['overview', 'activity', 'code', 'git', 'sessions', 'settings'],
    );
    assert.deepEqual(
      d.qa('button.fd-tab').map((t) => textOf(t)),
      ['Overview', 'Activity', 'Code', 'Git', 'Sessions', 'Settings'],
    );
  });

  it('ARIA tabs pattern: role=tab, aria-controls -> tabpanel, aria-labelledby back, ids unique, one selected, roving tabindex', () => {
    const d = mount();
    const ids = new Set<string>();
    for (const tab of d.qa<HTMLButtonElement>('button.fd-tab')) {
      assert.equal(tab.getAttribute('role'), 'tab');
      assert.equal(tab.type, 'button');
      const id = must(tab.getAttribute('id'));
      assert.ok(!ids.has(id), `duplicate id ${id}`);
      ids.add(id);
      const panel = d.root.ownerDocument.getElementById(must(tab.getAttribute('aria-controls')));
      assert.ok(panel, 'aria-controls points at an element');
      assert.equal(panel?.getAttribute('role'), 'tabpanel');
      assert.equal(panel?.getAttribute('data-panel'), tab.getAttribute('data-tab'));
      assert.equal(panel?.getAttribute('aria-labelledby'), id);
    }
    assert.equal(d.qa('button.fd-tab[aria-selected="true"]').length, 1);
    assert.equal(d.qa('button.fd-tab[tabindex="0"]').length, 1);
    assert.equal(d.qa('button.fd-tab[tabindex="-1"]').length, 5);
    assert.equal(d.q('button.fd-tab[aria-selected="true"]').getAttribute('tabindex'), '0', 'the selected tab is the one in the tab order');
    assert.equal(d.qa('section.fd-panel').length, 6);
    assert.equal(d.qa('section.fd-panel:not([hidden])').length, 1);
    assert.equal(d.q('section.fd-panel:not([hidden])').getAttribute('data-panel'), 'overview');
  });

  it('there is exactly one polite live region and every visible notice is role=status with aria-live off (no double announcements)', () => {
    const d = mount();
    d.send(dashState({ enabled: false, settings: { paused: true } }));
    assert.equal(d.qa('[aria-live="polite"]').length, 1);
    const notices = d.qa('.fd-notice');
    assert.ok(notices.length >= 1);
    for (const n of notices) {
      assert.equal(n.getAttribute('role'), 'status');
      assert.equal(n.getAttribute('aria-live'), 'off');
    }
  });

  it('every control is a real button or input (no div/span with a click role)', () => {
    const d = mount();
    d.send(busyState());
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      for (const el of d.qa('[data-action], [data-goto], [data-edit], .fd-seg-btn, .fd-tab, .fd-chip')) {
        assert.ok(['BUTTON', 'INPUT'].includes(el.tagName), `<${el.tagName.toLowerCase()} ${el.className}> is not a button`);
      }
      for (const el of d.qa('[role="button"]')) assert.fail(`role=button on ${el.tagName}`);
    }
  });

  it('every button has a visible label or an aria-label', () => {
    const d = mount();
    d.send(busyState());
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      for (const b of d.qa<HTMLButtonElement>('button', d.panel(tab))) {
        assert.ok(textOf(b) !== '' || (b.getAttribute('aria-label') ?? '') !== '', `unnamed button in ${tab}: ${b.outerHTML.slice(0, 80)}`);
      }
      for (const i of d.qa<HTMLInputElement>('input', d.panel(tab))) {
        const named = (i.getAttribute('aria-label') ?? '') !== '' || d.root.ownerDocument.querySelector(`label[for="${i.id}"]`) !== null;
        assert.ok(named, `unnamed input in ${tab}`);
      }
    }
  });
});

describe('dashboard: rows show the source as an icon shape AND a text label, never colour alone', () => {
  it('every source gets a row with its label, a data-source attribute and an svg icon of its own shape', () => {
    const d = mount();
    const files = SOURCE_TYPES.map((s, i) => row(`${s}.ts`, 'src', { source: s, ago: 5 + i }));
    d.send(dashState({ files }));
    const shapes = new Map<string, string>();
    for (const source of SOURCE_TYPES) {
      const li = must(rowFor(d, `/ws/proj/src/${source}.ts`));
      assert.equal(li.getAttribute('data-source'), source);
      const chip = d.q('.fd-source', li);
      assert.equal(chip.getAttribute('data-source'), source);
      assert.equal(textOf(d.q('.fd-source-label', chip)), LABEL[source], 'the text label');
      const icon = d.q<SVGElement>('svg', chip);
      assert.equal(icon.getAttribute('aria-hidden'), 'true', 'the icon is decorative: the text carries the name');
      assert.ok(icon.classList.contains(`fd-icon--${source}`));
      assert.ok(icon.querySelectorAll('circle, rect, path').length >= 1);
      shapes.set(source, icon.innerHTML);
    }
    assert.equal(new Set(shapes.values()).size, 6, 'six different shapes');
  });

  it('the label and shape change when a file is re-attributed, in the same element', () => {
    const d = mount();
    d.send(dashState({ seq: 1, files: [row('a.ts', 'src', { source: 'external' })] }));
    const li = must(rowFor(d, '/ws/proj/src/a.ts'));
    const before = d.q('svg', li).innerHTML;
    d.send(dashState({ seq: 2, files: [row('a.ts', 'src', { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal', confidence: 0.95 })] }));
    assert.equal(rowFor(d, '/ws/proj/src/a.ts'), li, 'same row element');
    assert.equal(textOf(d.q('.fd-source-label', li)), 'AI agent');
    assert.notEqual(d.q('svg', li).innerHTML, before);
    assert.equal(d.qa('svg', li).filter((s) => s.parentElement?.classList.contains('fd-source')).length, 1, 'the old icon was replaced, not added to');
    assert.equal(li.getAttribute('data-source'), 'ai-agent');
  });

  it('the source tooltip states the method, the confidence and (for a Git row) that it is only a time correlation', () => {
    const d = mount();
    d.send(dashState({ files: [row('g.ts', 'src', { source: 'git', method: 'git-state-change', confidence: 0.8 }), row('x.ts', 'src', { source: 'external' })] }));
    const git = must(d.q('.fd-source', must(rowFor(d, '/ws/proj/src/g.ts'))).getAttribute('title'));
    assert.match(git, /Git state change/);
    assert.match(git, /80%/);
    assert.match(git, /not proof/i);
    const ext = must(d.q('.fd-source', must(rowFor(d, '/ws/proj/src/x.ts'))).getAttribute('title'));
    assert.match(ext, /does not say which program/i, 'an External row does not claim a writer');
  });

  it('an AI agent row names the reporting adapter in its method line and tooltip', () => {
    const d = mount();
    d.send(dashState({ files: [row('a.ts', 'src', { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal', confidence: 0.95 })] }));
    const li = must(rowFor(d, '/ws/proj/src/a.ts'));
    assert.match(textOf(d.q('.fd-row-method', li)), /agent signal \(claude-code\) · 95%/);
    assert.match(must(d.q('.fd-source', li).getAttribute('title')), /Reported by claude-code/);
  });
});

describe('dashboard: the Activity row', () => {
  it('has the documented attributes and parts', () => {
    const d = mount();
    d.send(dashState({ files: [row('app.ts', 'src/dashboard', { changes: 3, sessionTitle: 'Refactor', review: null })] }));
    goTo(d, 'activity');
    const li = must(rowFor(d, '/ws/proj/src/dashboard/app.ts'));
    assert.equal(li.tagName, 'LI');
    assert.equal(li.parentElement?.tagName, 'UL');
    assert.ok(li.parentElement?.classList.contains('fd-list'));
    assert.equal(li.getAttribute('data-phase'), 'idle');
    assert.equal(li.getAttribute('data-exists'), 'true');
    const open = d.q<HTMLButtonElement>('button.fd-open', li);
    assert.equal(textOf(open), 'app.ts');
    assert.equal(open.getAttribute('data-action'), 'open');
    assert.equal(open.getAttribute('data-id'), '/ws/proj/src/dashboard/app.ts');
    assert.equal(textOf(d.q('.fd-dir', li)), 'src/dashboard');
    assert.equal(textOf(d.q('.fd-row-event', li)), 'modified 3 times');
    assert.match(textOf(d.q('.fd-row-session', li)), /Session: Refactor/);
    assert.ok(d.q('.fd-meter > i', li));
  });

  it('the accessible name is the documented sentence: name, source, what happened, how long ago, review state', () => {
    const d = mount();
    d.send(dashState({ files: [row('app.ts', 'src', { changes: 3, ago: 120, source: 'external', review: 'unreviewed' }), row('b.ts', 'src', { changes: 1, ago: 1 })] }));
    assert.equal(must(rowFor(d, '/ws/proj/src/app.ts')).getAttribute('aria-label'), 'app.ts, External, modified 3 times, 2 minutes ago, unreviewed');
    assert.equal(must(rowFor(d, '/ws/proj/src/b.ts')).getAttribute('aria-label'), 'b.ts, Developer, modified once, just now');
  });

  it('what happened reads naturally for create, delete and a single change', () => {
    const d = mount();
    d.send(
      dashState({
        files: [
          row('c.ts', 'src', { lastEventType: 'create', changes: 1 }),
          row('m.ts', 'src', { lastEventType: 'modify', changes: 1 }),
          row('d.ts', 'src', { lastEventType: 'delete', changes: 1, exists: false }),
          row('e.ts', 'src', { lastEventType: 'delete', changes: 6, exists: false }),
          row('k.ts', 'src', { lastEventType: 'create', changes: 3 }),
        ],
      }),
    );
    const event = (n: string): string => textOf(d.q('.fd-row-event', must(rowFor(d, `/ws/proj/src/${n}`))));
    assert.equal(event('c.ts'), 'created');
    assert.equal(event('m.ts'), 'modified once');
    assert.equal(event('d.ts'), 'deleted');
    assert.equal(event('e.ts'), 'deleted, 6 changes');
    assert.equal(event('k.ts'), 'created, 3 changes');
  });

  it('a deleted file: data-exists=false, its name button is disabled and the title says it was deleted', () => {
    const d = mount();
    d.send(dashState({ files: [row('gone.ts', 'src', { lastEventType: 'delete', exists: false })] }));
    const li = must(rowFor(d, '/ws/proj/src/gone.ts'));
    assert.equal(li.getAttribute('data-exists'), 'false');
    const open = d.q<HTMLButtonElement>('button.fd-open', li);
    assert.equal(open.disabled, true);
    assert.match(must(open.getAttribute('title')), /deleted/);
    assert.equal(d.qa('[data-action="select"]', li).length, 0, 'a deleted file cannot be inspected');
  });

  it('review state: unreviewed shows a flag and a Review button; reviewed shows "Reviewed"; developer rows show neither', () => {
    const d = mount();
    d.send(
      dashState({
        files: [row('u.ts', 'src', { source: 'external', review: 'unreviewed' }), row('r.ts', 'src', { source: 'external', review: 'reviewed' }), row('d.ts', 'src', { source: 'developer', review: null })],
      }),
    );
    const u = must(rowFor(d, '/ws/proj/src/u.ts'));
    assert.equal(u.getAttribute('data-review'), 'unreviewed');
    assert.ok(d.q('.fd-flag', u));
    const review = d.q<HTMLButtonElement>('button[data-action="markReviewed"]', u);
    assert.equal(textOf(review), 'Review');
    assert.equal(review.getAttribute('aria-label'), 'Mark u.ts reviewed');
    assert.equal(review.getAttribute('data-id'), '/ws/proj/src/u.ts');
    const r = must(rowFor(d, '/ws/proj/src/r.ts'));
    assert.equal(r.getAttribute('data-review'), 'reviewed');
    assert.equal(textOf(d.q('.fd-reviewed', r)), 'Reviewed');
    assert.equal(d.qa('button[data-action="markReviewed"]', r).length, 0);
    const dev = must(rowFor(d, '/ws/proj/src/d.ts'));
    assert.equal(dev.hasAttribute('data-review'), false);
    assert.equal(d.qa('.fd-flag, .fd-reviewed, button[data-action="markReviewed"]', dev).length, 0);
  });

  it('Diff appears only for files with an uncommitted change in the Git lists; Inspect only while the index is on', () => {
    const d = mount();
    const files = [row('a.ts', 'src'), row('b.ts', 'src')];
    d.send(dashState({ files, git: { state: 'ready', repos: [repo('r', { unstaged: [change('a.ts', 'src')] })] }, settings: { dependencyIndex: true }, index: { state: 'ready', indexed: 5, total: 5 } }));
    const a = must(rowFor(d, '/ws/proj/src/a.ts'));
    const b = must(rowFor(d, '/ws/proj/src/b.ts'));
    assert.equal(d.qa('button[data-action="openDiff"]', a).length, 1);
    assert.equal(d.qa('button[data-action="openDiff"]', b).length, 0);
    assert.equal(d.qa('button[data-action="select"]', a).length, 1);
    d.send(dashState({ seq: 2, files, git: { state: 'ready', repos: [repo('r', { unstaged: [change('a.ts', 'src')] })] }, settings: { dependencyIndex: false }, index: { state: 'off' } }));
    assert.equal(d.qa('button[data-action="select"]', must(rowFor(d, '/ws/proj/src/a.ts'))).length, 0, 'no Inspect when the index is off');
    d.send(dashState({ seq: 3, files, git: { state: 'unavailable', detail: 'no git', repos: [] } }));
    assert.equal(d.qa('button[data-action="openDiff"]', must(rowFor(d, '/ws/proj/src/a.ts'))).length, 0, 'no Diff when Git is unavailable');
  });

  it('CSS custom properties for the shake come from the row, through the CSSOM, and the meter follows the intensity', () => {
    const d = mount();
    d.send(dashState({ files: [row('a.ts', 'src', { phase: 'active', intensity: 0.4567, shake: { amp: 2.25, dur: 110, rot: 0.7 } })] }));
    const li = must(rowFor(d, '/ws/proj/src/a.ts'));
    assert.equal(li.style.getPropertyValue('--fd-amp'), '2.25px');
    assert.equal(li.style.getPropertyValue('--fd-dur'), '110ms');
    assert.equal(li.style.getPropertyValue('--fd-rot'), '0.7deg');
    assert.equal(li.style.getPropertyValue('--fd-level'), '0.457');
    d.send(dashState({ seq: 2, files: [row('a.ts', 'src', { phase: 'active', intensity: 0.9, shake: { amp: 3.6, dur: 70, rot: 1.1 } })] }));
    assert.equal(li.style.getPropertyValue('--fd-amp'), '3.6px');
    assert.equal(li.style.getPropertyValue('--fd-dur'), '70ms');
    assert.equal(li.style.getPropertyValue('--fd-level'), '0.9');
  });

  it('the rows keep the host order (active first, then newest), and a file that is gone leaves the list', () => {
    const d = mount();
    const files = [activeRow('z.ts', 'src'), row('a.ts', 'src', { ago: 5 }), row('m.ts', 'src', { ago: 50 })];
    d.send(dashState({ files }));
    assert.deepEqual(
      activityRows(d).map((r) => r.getAttribute('data-id')),
      files.map((f) => f.id),
    );
    d.send(dashState({ seq: 2, files: [files[1] as (typeof files)[number]] }));
    assert.equal(activityRows(d).length, 1);
  });

  it('a state with 300 rows renders 300 rows (the contract maximum)', () => {
    const d = mount();
    d.send(dashState({ files: manyRows(300) }));
    assert.equal(activityRows(d).length, 300);
  });
});

describe('dashboard: relative times come from state.now, never from the real clock', () => {
  const at = NOW - 10 * MIN;
  const cases: Array<[number, string, string]> = [
    [0, 'just now', 'just now'],
    [4_999, 'just now', 'just now'],
    [5_000, '5s ago', '5 seconds ago'],
    [59_999, '59s ago', '59 seconds ago'],
    [60_000, '1m ago', '1 minute ago'],
    [119_000, '1m ago', '1 minute ago'],
    [120_000, '2m ago', '2 minutes ago'],
    [59 * MIN, '59m ago', '59 minutes ago'],
    [HOUR, '1h ago', '1 hour ago'],
    [23 * HOUR + 59 * MIN, '23h ago', '23 hours ago'],
    [24 * HOUR, '1d ago', '1 day ago'],
    [3 * 24 * HOUR, '3d ago', '3 days ago'],
  ];
  for (const [delta, short, long] of cases) {
    it(`${delta} ms after the change reads "${short}"`, () => {
      const d = mount();
      d.send(dashState({ now: at + delta, files: [row('a.ts', 'src', { ago: (NOW - at) / S })] }));
      const li = must(rowFor(d, '/ws/proj/src/a.ts'));
      assert.equal(textOf(d.q('.fd-row-time', li)), short);
      assert.ok(must(li.getAttribute('aria-label')).includes(long), li.getAttribute('aria-label') ?? '');
    });
  }

  it('a change dated in the future of the host clock reads "just now" (never negative)', () => {
    const d = mount();
    d.send(dashState({ now: NOW, files: [row('a.ts', 'src', { ago: -3600 })] }));
    assert.equal(textOf(d.q('.fd-row-time', must(rowFor(d, '/ws/proj/src/a.ts')))), 'just now');
  });

  it('the same row is re-timed in place when a newer state arrives with a later now', () => {
    const d = mount();
    const f = row('a.ts', 'src', { ago: 10 });
    d.send(dashState({ seq: 1, now: NOW, files: [f] }));
    const li = must(rowFor(d, '/ws/proj/src/a.ts'));
    assert.equal(textOf(d.q('.fd-row-time', li)), '10s ago');
    d.send(dashState({ seq: 2, now: NOW + 5 * MIN, files: [f] }));
    assert.equal(rowFor(d, '/ws/proj/src/a.ts'), li);
    assert.equal(textOf(d.q('.fd-row-time', li)), '5m ago');
  });

  it('the time tooltip is a local clock time and never an ISO string with a Z', () => {
    const d = mount();
    d.send(dashState({ files: [row('a.ts', 'src')] }));
    const t = must(d.q('.fd-row-time', must(rowFor(d, '/ws/proj/src/a.ts'))).getAttribute('title'));
    assert.match(t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('dashboard: filters', () => {
  const files = [
    activeRow('live-dev.ts', 'src', { source: 'developer' }),
    row('idle-dev.ts', 'src', { source: 'developer' }),
    row('ext.ts', 'src', { source: 'external' }),
    row('git.ts', 'src', { source: 'git', method: 'git-state-change' }),
    row('auto.ts', 'src', { source: 'automated', method: 'workspace-edit' }),
    row('unk.ts', 'src', { source: 'unknown', method: 'restored' }),
    row('agent.ts', 'src', { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal' }),
    activeRow('live-ai.ts', 'src', { source: 'ai-agent', sourceId: 'claude-code', method: 'agent-signal' }),
  ];
  const shown = (d: DashHarness): string[] => activityRows(d).map((r) => must(r.getAttribute('data-id')).split('/').pop() ?? '');

  it('five chips, All selected by default, each with a count that matches the rule', () => {
    const d = mount();
    d.send(dashState({ files }));
    goTo(d, 'activity');
    const chips = d.qa<HTMLButtonElement>('button.fd-chip', d.panel('activity'));
    assert.deepEqual(
      chips.map((c) => c.getAttribute('data-filter')),
      ['live', 'mine', 'external', 'ai', 'all'],
    );
    assert.deepEqual(
      chips.map((c) => c.getAttribute('aria-pressed')),
      ['false', 'false', 'false', 'false', 'true'],
    );
    const counts = Object.fromEntries(chips.map((c) => [c.getAttribute('data-filter'), textOf(d.q('.fd-chip-count', c))]));
    assert.deepEqual(counts, { live: '2', mine: '2', external: '4', ai: '2', all: '8' });
  });

  it('each filter shows exactly its rows: Live = active, Mine = developer, External = everything that is neither you nor an agent, AI = ai-agent', () => {
    const d = mount();
    d.send(dashState({ files }));
    goTo(d, 'activity');
    const expect: Record<string, string[]> = {
      live: ['live-dev.ts', 'live-ai.ts'],
      mine: ['live-dev.ts', 'idle-dev.ts'],
      external: ['ext.ts', 'git.ts', 'auto.ts', 'unk.ts'],
      ai: ['agent.ts', 'live-ai.ts'],
      all: files.map((f) => f.name),
    };
    for (const [filter, names] of Object.entries(expect)) {
      click(d.q(`button.fd-chip[data-filter="${filter}"]`));
      assert.deepEqual([...shown(d)].sort(), [...names].sort(), filter);
      assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), filter);
      assert.equal(d.q('ul.fd-list').getAttribute('data-filter'), filter);
    }
  });

  it('the filter choice is persisted, survives new states, and a hidden row keeps its element', () => {
    const d = mount();
    d.send(dashState({ seq: 1, files }));
    goTo(d, 'activity');
    const ai = must(rowFor(d, '/ws/proj/src/agent.ts'));
    click(d.q('button.fd-chip[data-filter="mine"]'));
    assert.equal(rowFor(d, '/ws/proj/src/agent.ts'), undefined, 'hidden by the filter');
    assert.deepEqual(d.host.stateWrites.at(-1), { tab: 'activity', activityFilter: 'mine', codeView: 'dependencies' });
    d.send(dashState({ seq: 2, files }));
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'mine');
    click(d.q('button.fd-chip[data-filter="all"]'));
    assert.equal(rowFor(d, '/ws/proj/src/agent.ts'), ai, 'the row element is reused after the filter is lifted');
  });

  it('clicking the chip that is already selected changes nothing and persists nothing new', () => {
    const d = mount();
    d.send(dashState({ files }));
    goTo(d, 'activity');
    const writes = d.host.stateWrites.length;
    click(d.q('button.fd-chip[data-filter="all"]'));
    assert.equal(d.host.stateWrites.length, writes);
  });

  it('an empty filter says what is true for that filter (and the AI one lists the adapters)', () => {
    const d = mount();
    d.send(dashState({ files: [row('only.ts', 'src', { source: 'developer' })], agents: [{ id: 'api', label: 'Extension API', state: 'listening', detail: 'Reports from other extensions.' }, { id: 'signal-file', label: 'Agent signal file', state: 'off', detail: 'Turn it on in settings.' }] }));
    goTo(d, 'activity');
    click(d.q('button.fd-chip[data-filter="live"]'));
    assert.match(textOf(d.q('.fd-empty', d.panel('activity'))), /Nothing is changing right now\./);
    click(d.q('button.fd-chip[data-filter="external"]'));
    assert.match(textOf(d.q('.fd-empty', d.panel('activity'))), /No external changes in the history\./);
    click(d.q('button.fd-chip[data-filter="ai"]'));
    assert.equal(textOf(d.q('.fd-empty', d.panel('activity'))), 'No agent adapter is reporting. Changes made by agents appear under External.');
    const adapters = d.qa('.fd-adapter', d.panel('activity'));
    assert.deepEqual(
      adapters.map((a) => textOf(d.q('.fd-adapter-label', a))),
      ['Extension API', 'Agent signal file'],
    );
    assert.deepEqual(
      adapters.map((a) => textOf(d.q('.fd-adapter-state', a))),
      ['Listening', 'Off'],
    );
    assert.match(textOf(d.panel('activity')), /labelled AI agent only when an adapter reports it/);
  });

  it('with no state of the kind and the tracker off or paused, the empty text says why', () => {
    const d = mount();
    d.send(dashState({ enabled: false }));
    goTo(d, 'activity');
    assert.match(textOf(d.q('.fd-empty', d.panel('activity'))), /Changescope is turned off/);
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    assert.match(textOf(d.q('.fd-empty', d.panel('activity'))), /Tracking is paused/);
    d.send(dashState({ seq: 3 }));
    assert.match(textOf(d.q('.fd-empty', d.panel('activity'))), /No activity yet\./);
  });
});

describe('dashboard: compact mode', () => {
  it('one line per row: no meter, no second or third line, no shaking; #app says data-mode=compact and data-motion=off', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'compact' }, files: [activeRow('a.ts', 'src'), row('b.ts', 'src', { source: 'external', review: 'unreviewed', sessionTitle: 'S' })] }));
    assert.equal(d.root.getAttribute('data-mode'), 'compact');
    assert.equal(d.root.getAttribute('data-motion'), 'off');
    const rows = activityRows(d);
    assert.equal(rows.length, 2);
    for (const li of rows) {
      assert.equal(d.qa('.fd-meter', li).length, 0, 'no meter');
      assert.equal(d.qa('.fd-row-meta, .fd-row-foot, .fd-row-session, .fd-actions, .fd-row-method', li).length, 0);
      assert.equal(li.classList.contains('is-shaking'), false);
      assert.ok(d.q('.fd-row-head', li));
      assert.ok(d.q('.fd-when', li), 'a short time stays on the one line');
      assert.equal(textOf(d.q('.fd-source-label', li)).length > 0, true, 'the source label is still there');
    }
    assert.equal(d.qa('.is-shaking').length, 0);
  });

  it('the compact time is short ("now", "10s", "2m", "3h", "2d")', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'compact' }, files: [row('a.ts', 'src', { ago: 1 }), row('b.ts', 'src', { ago: 10 }), row('c.ts', 'src', { ago: 120 }), row('d.ts', 'src', { ago: 3 * 3600 }), row('e.ts', 'src', { ago: 2 * 86400 })] }));
    const t = (n: string): string => textOf(d.q('.fd-when', must(rowFor(d, `/ws/proj/src/${n}`))));
    assert.deepEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(t), ['now', '10s', '2m', '3h', '2d']);
  });

  it('switching Live -> Compact -> Live keeps every row element (no data dropped) and restores the meters', () => {
    const d = mount();
    const files = [activeRow('a.ts', 'src'), row('b.ts', 'src')];
    d.send(dashState({ seq: 1, files }));
    const a = must(rowFor(d, '/ws/proj/src/a.ts'));
    d.send(dashState({ seq: 2, files, settings: { mode: 'compact' } }));
    assert.equal(rowFor(d, '/ws/proj/src/a.ts'), a);
    assert.equal(d.qa('.fd-meter', a).length, 0);
    d.send(dashState({ seq: 3, files, settings: { mode: 'live' } }));
    assert.equal(rowFor(d, '/ws/proj/src/a.ts'), a);
    assert.equal(d.qa('.fd-meter', a).length, 1);
    assert.equal(d.qa('.fd-row-meta', a).length, 1);
    assert.ok(a.classList.contains('is-shaking'));
  });

  it('the Overview and Settings panels still render in compact mode (nothing is dropped)', () => {
    const d = mount();
    d.send(busyState({ settings: { mode: 'compact' } }));
    assert.ok(d.qa('.fd-card', d.panel('overview')).length === 6);
    assert.ok(d.qa('.fd-tl', d.panel('overview')).length > 0);
    assert.match(textOf(d.panel('settings')), /Compact mode never animates/);
  });
});

describe('dashboard: impact mode', () => {
  const files = [row('hi.ts', 'src', { impactLevel: 'high', dependants: 12 }), row('one.ts', 'src', { impactLevel: 'medium', dependants: 1 }), row('none.ts', 'src', { impactLevel: 'low', dependants: 0 }), row('wait.ts', 'src', { impactLevel: null, dependants: null })];

  it('each row shows the level badge (text, not only colour) and the dependant count', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'impact' }, files, index: { state: 'ready', indexed: 4, total: 4 } }));
    assert.equal(d.root.getAttribute('data-mode'), 'impact');
    const level = (n: string): HTMLElement => d.q('.fd-level', must(rowFor(d, `/ws/proj/src/${n}`)));
    assert.equal(level('hi.ts').getAttribute('data-level'), 'high');
    assert.equal(textOf(d.q('.fd-level-label', level('hi.ts'))), 'High');
    assert.equal(textOf(d.q('.fd-level-label', level('one.ts'))), 'Medium');
    assert.equal(textOf(d.q('.fd-level-label', level('none.ts'))), 'Low');
    assert.equal(textOf(d.q('.fd-row-dependants', must(rowFor(d, '/ws/proj/src/hi.ts')))), '12 dependants');
    assert.equal(textOf(d.q('.fd-row-dependants', must(rowFor(d, '/ws/proj/src/one.ts')))), '1 dependant');
    assert.equal(textOf(d.q('.fd-row-dependants', must(rowFor(d, '/ws/proj/src/none.ts')))), '0 dependants');
    assert.equal(d.qa('.fd-level', must(rowFor(d, '/ws/proj/src/wait.ts'))).length, 0);
    assert.equal(textOf(d.q('.fd-row-dependants', must(rowFor(d, '/ws/proj/src/wait.ts')))), 'Impact not analysed yet');
  });

  it('outside impact mode the rows show no badge', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'live' }, files }));
    assert.equal(d.qa('.fd-level, .fd-row-dependants', d.panel('activity')).length, 0);
  });

  it('the Code tab opens on Impact when the mode becomes Impact, and the choice is persisted', () => {
    const d = mount();
    d.send(dashState({ seq: 1, settings: { mode: 'live' } }));
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]', d.panel('code')).getAttribute('data-code-view'), 'dependencies');
    d.send(dashState({ seq: 2, settings: { mode: 'impact' } }));
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]', d.panel('code')).getAttribute('data-code-view'), 'impact');
    assert.equal(d.host.stateWrites.at(-1)?.codeView, 'impact');
  });

  it('the Code tab is on Impact also when the page loads already in Impact mode', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'impact' } }));
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]', d.panel('code')).getAttribute('data-code-view'), 'impact');
  });

  it('the user can switch the Code tab back to Dependencies while in Impact mode, and a new state does not flip it again', () => {
    const d = mount();
    d.send(dashState({ seq: 1, settings: { mode: 'impact' } }));
    click(d.q('.fd-seg-btn[data-code-view="dependencies"]', d.panel('code')));
    d.send(dashState({ seq: 2, settings: { mode: 'impact' } }));
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]', d.panel('code')).getAttribute('data-code-view'), 'dependencies');
  });

  it('rows never shake in impact mode, even active ones', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'impact' }, files: [activeRow('a.ts', 'src')] }));
    assert.equal(d.qa('.is-shaking').length, 0);
    assert.equal(d.qa('.fd-meter', d.panel('activity')).length, 1, 'the meter (a non-motion cue) stays');
  });
});

describe('dashboard: Overview tab', () => {
  it('six stat cards in order, each button.fd-card with .fd-card-value and .fd-card-label', () => {
    const d = mount();
    d.send(
      dashState({
        files: [row('a.ts', 'src', { source: 'developer' }), row('b.ts', 'src', { source: 'developer' }), row('c.ts', 'src', { source: 'external' }), row('d.ts', 'src', { source: 'git' }), row('e.ts', 'src', { source: 'ai-agent' }), row('f.ts', 'src', { source: 'unknown' })],
        sessions: { active: dashSession('s1', 'Work') },
      }),
    );
    const cards = d.qa<HTMLButtonElement>('button.fd-card', d.panel('overview'));
    assert.deepEqual(
      cards.map((c) => c.getAttribute('data-card')),
      ['modified', 'developer', 'external', 'ai', 'unreviewed', 'sessions'],
    );
    const values = cards.map((c) => textOf(d.q('.fd-card-value', c)));
    assert.deepEqual(values, ['6', '2', '3', '1', '4', '1']);
    for (const c of cards) {
      assert.equal(c.tagName, 'BUTTON');
      assert.ok(textOf(d.q('.fd-card-label', c)).length > 0);
      assert.ok(must(c.getAttribute('aria-label')).length > 10, 'each card has a sentence as its accessible name');
    }
    assert.deepEqual(
      cards.map((c) => textOf(d.q('.fd-card-label', c))),
      ['files', 'yours', 'external', 'AI agent', 'to review', 'session'],
    );
  });

  it('Yours + External + AI agent adds up to the file count, whatever the mix', () => {
    const d = mount();
    for (let seed = 1; seed <= 12; seed += 1) {
      const files = SOURCE_TYPES.flatMap((s, i) => Array.from({ length: (seed * (i + 3)) % 5 }, (_, j) => row(`${s}${j}.ts`, 'src', { source: s })));
      d.send(dashState({ seq: seed, files }));
      const v = (id: string): number => Number(textOf(d.q('.fd-card-value', d.q(`button.fd-card[data-card="${id}"]`))));
      assert.equal(v('developer') + v('external') + v('ai'), v('modified'), `seed ${seed}`);
    }
  });

  it('the External card says what it counts when more than one kind is included', () => {
    const d = mount();
    d.send(dashState({ files: [row('a.ts', 'src', { source: 'external' }), row('b.ts', 'src', { source: 'git' }), row('c.ts', 'src', { source: 'automated' })] }));
    const label = must(d.q('button.fd-card[data-card="external"]').getAttribute('aria-label'));
    assert.match(label, /1 External, 1 Git, 1 Automated/);
  });

  it('large counts are grouped with commas and singular/plural labels follow the number', () => {
    const d = mount();
    d.send(dashState({ files: [row('a.ts', 'src')], overview: { modifiedFiles: 12345, bySource: { developer: 1, 'ai-agent': 0, external: 0, git: 0, automated: 0, unknown: 0 }, unreviewed: 1, activeSessions: 1, events: 99999 } }));
    assert.equal(textOf(d.q('.fd-card-value', d.q('button.fd-card[data-card="modified"]'))), '12,345');
    assert.equal(textOf(d.q('.fd-card-label', d.q('button.fd-card[data-card="modified"]'))), 'files');
    assert.equal(textOf(d.q('.fd-card-label', d.q('button.fd-card[data-card="unreviewed"]'))), 'to review');
    d.send(dashState({ seq: 2, files: [row('a.ts', 'src')], overview: { modifiedFiles: 1 } }));
    assert.equal(textOf(d.q('.fd-card-label', d.q('button.fd-card[data-card="modified"]'))), 'file');
  });

  it('the timeline: newest first even if the host sent it unsorted, at most 50 rows, with a "latest 50 of N" note', () => {
    const d = mount();
    const items = Array.from({ length: 100 }, (_, i) => timelineItem(`f${i}.ts`, 'src', { id: `t${i}`, ago: ((i * 37) % 100) + 1 }));
    d.send(dashState({ timeline: items, overview: { events: 100 } }));
    const lis = d.qa('ul.fd-timeline > li', d.panel('overview'));
    assert.equal(lis.length, 50);
    const ids = lis.map((l) => must(l.getAttribute('data-id')));
    const byId = new Map(items.map((i) => [i.id, i.at]));
    const ats = ids.map((id) => must(byId.get(id)));
    assert.deepEqual(
      [...ats].sort((a, b) => b - a),
      ats,
      'newest first',
    );
    assert.equal(Math.max(...items.map((i) => i.at)), ats[0]);
    assert.match(textOf(d.panel('overview')), /latest 50 of 100/);
  });

  it('a timeline item shows the source (icon and label), what happened and a short age', () => {
    const d = mount();
    d.send(dashState({ timeline: [timelineItem('app.ts', 'src', { source: 'external', eventType: 'create', count: 1, ago: 300 }), timelineItem('b.ts', 'src', { source: 'ai-agent', sourceId: 'claude-code', count: 4, ago: 20 })] }));
    const [first, second] = d.qa('ul.fd-timeline > li', d.panel('overview'));
    assert.equal(must(second).getAttribute('data-source'), 'external');
    assert.equal(must(first).getAttribute('data-source'), 'ai-agent');
    assert.ok(d.q('svg', must(first)));
    assert.match(textOf(must(first)), /AI agent · modified ×4/);
    assert.match(textOf(must(second)), /External · created/);
    assert.match(must(first).getAttribute('aria-label') ?? '', /AI agent, modified 4 times/);
    assert.equal(textOf(d.q('.fd-tl-time', must(second))), '5m');
  });

  it('the summary: none -> "No summary yet."; local -> says it was built here; a provider is named', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    assert.equal(textOf(d.q('.fd-summary-text', d.panel('overview'))), 'No summary yet.');
    assert.equal(textOf(d.q('button[data-action="summarize"]', d.panel('overview'))), 'Summarize');
    d.send(dashState({ seq: 2, summary: { text: '3 files changed: 2 by you.', provider: 'local', at: NOW - 90 * S } }));
    assert.equal(textOf(d.q('.fd-summary-text', d.panel('overview'))), '3 files changed: 2 by you.');
    assert.match(textOf(d.q('.fd-summary .fd-note', d.panel('overview'))), /Built on this machine from file names and counts, 1m ago\./);
    assert.equal(textOf(d.q('button[data-action="summarize"]', d.panel('overview'))), 'Refresh');
    d.send(dashState({ seq: 3, summary: { text: 'x', provider: 'acme.llm', at: NOW } }));
    assert.match(textOf(d.q('.fd-summary .fd-note', d.panel('overview'))), /From provider acme\.llm, just now\./);
  });

  it('the mode switch and pause button reflect the state', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'compact', paused: true } }));
    const modes = d.qa<HTMLButtonElement>('button.fd-mode', d.panel('overview'));
    assert.deepEqual(
      modes.map((m) => [m.getAttribute('data-mode'), m.getAttribute('aria-pressed')]),
      [
        ['live', 'false'],
        ['compact', 'true'],
        ['impact', 'false'],
      ],
    );
    assert.equal(textOf(d.q('button.fd-pause', d.panel('overview'))), 'Resume');
    d.send(dashState({ seq: 2, settings: { mode: 'live', paused: false } }));
    assert.equal(textOf(d.q('button.fd-pause', d.panel('overview'))), 'Pause');
  });
});

describe('dashboard: Code tab', () => {
  it('imports and imported-by lists with relationship labels, counts and the test tag', () => {
    const d = mount();
    d.send(busyState());
    const imports = d.qa('section[data-deps="imports"] li.fd-dep', d.panel('code'));
    assert.equal(imports.length, 2);
    assert.match(textOf(must(imports[0])), /model\.ts.*src\/dashboard.*import ×3/);
    assert.match(textOf(must(imports[1])), /re-export/);
    const by = d.qa('section[data-deps="importedBy"] li.fd-dep', d.panel('code'));
    assert.equal(by.length, 2);
    assert.equal(d.qa('.fd-tag--test', must(by[1])).length, 1);
    assert.equal(d.qa('.fd-tag--test', must(by[0])).length, 0);
    assert.equal(textOf(d.q('.fd-selected-file .fd-open', d.panel('code'))), 'app.ts');
    assert.match(textOf(d.panel('code')), /text scan of import statements, not from a language server/);
  });

  it('the selected file with no imports or importers says so', () => {
    const d = mount();
    d.send(dashState({ selection: { file: ref('lonely.ts', 'src') }, index: { state: 'ready', indexed: 10, total: 10 } }));
    assert.match(textOf(d.panel('code')), /No imports were found in this file\./);
    assert.match(textOf(d.panel('code')), /No file imports this one\./);
  });

  it('Impact view: the selected file card has level, counts, reasons, tests and configs; other impacts are cards too', () => {
    const d = mount({ persisted: { tab: 'code', activityFilter: 'all', codeView: 'impact' } });
    d.send(
      dashState({
        files: [row('a.ts', 'src')],
        selection: { file: ref('core.ts', 'src'), impact: impact('core.ts', 'src', { level: 'critical', direct: 31, indirect: 4, reasons: ['31 files import this file directly.', 'This is a project configuration file; changes can affect the whole workspace.'], tests: [ref('core.test.ts', 'test')], configs: [ref('package.json')], affected: [ref('x.ts', 'src')] }) },
        impacts: [impact('other.ts', 'src', { level: 'low', direct: 0, reasons: ['No dependants were found.'], affected: [], complete: false })],
        index: { state: 'ready', indexed: 10, total: 10 },
      }),
    );
    const cards = d.qa('.fd-impact', d.panel('code'));
    assert.equal(cards.length, 2);
    const own = must(cards.find((c) => c.classList.contains('fd-impact--selected')));
    assert.equal(own.getAttribute('data-level'), 'critical');
    assert.equal(textOf(d.q('.fd-level-label', own)), 'Critical');
    assert.match(textOf(d.q('.fd-impact-counts', own)), /31 direct · 4 indirect dependants/);
    assert.deepEqual(
      d.qa('.fd-reasons li', own).map((l) => textOf(l)),
      ['31 files import this file directly.', 'This is a project configuration file; changes can affect the whole workspace.'],
    );
    assert.match(textOf(own), /Tests to run \(1\)/);
    assert.match(textOf(own), /core\.test\.ts/);
    assert.match(textOf(own), /Configuration files/);
    assert.match(textOf(own), /Affected files \(first 1 of 35\)/, 'the list is shorter than the count and says so');
    const other = must(cards.find((c) => !c.classList.contains('fd-impact--selected')));
    assert.equal(other.getAttribute('data-level'), 'low');
    assert.match(textOf(d.q('.fd-impact-counts', other)), /partial estimate/);
    assert.equal(other.getAttribute('data-complete'), 'false');
    assert.match(textOf(d.panel('code')), /estimates from import edges\. They are not confirmed defects\./);
  });

  it('with no selection it offers the changed files that still exist (at most 8) and says so', () => {
    const d = mount();
    d.send(dashState({ files: [...manyRows(12), row('gone.ts', 'src', { exists: false, lastEventType: 'delete' })], index: { state: 'ready', indexed: 3, total: 3 } }));
    assert.match(textOf(d.q('.fd-empty', d.panel('code'))), /No file selected\. Pick a changed file/);
    const picks = d.qa('ul.fd-pick li', d.panel('code'));
    assert.equal(picks.length, 8);
    assert.ok(!picks.some((p) => textOf(p).includes('gone.ts')));
  });

  it('the index notice says what is true: off, not built, indexing with "340 of 1,200 files", truncated, and nothing when ready', () => {
    const d = mount();
    const say = (o: Parameters<typeof dashState>[0]): string => {
      d.send(dashState({ seq: ++seq, ...o }));
      return textOf(d.q('.fd-notice', d.panel('code')));
    };
    let seq = 0;
    assert.match(say({ settings: { dependencyIndex: false }, index: { state: 'off' } }), /dependency index is turned off \(changescope\.dependencies\.index\)/);
    assert.match(say({ index: { state: 'idle' } }), /has not been built yet\. It is built the first time you inspect a file\./);
    assert.equal(say({ index: { state: 'indexing', indexed: 340, total: 1200 } }), 'Indexing dependencies: 340 of 1,200 files.');
    assert.equal(say({ index: { state: 'indexing', indexed: 0, total: 0 } }), 'Indexing dependencies.');
    assert.match(say({ index: { state: 'ready', indexed: 5000, total: 5000, truncated: true } }), /stopped at its limit of 5,000 files, so some dependants may be missing/);
    d.send(dashState({ seq: ++seq, index: { state: 'ready', indexed: 1204, total: 1204 } }));
    assert.equal(d.qa('.fd-notice', d.panel('code')).length, 0, 'no notice when there is nothing to say');
    assert.match(textOf(d.panel('code')), /Dependency index: 1,204 files\./);
  });

  it('when the index is off, no files are offered to inspect', () => {
    const d = mount();
    d.send(dashState({ files: manyRows(3), settings: { dependencyIndex: false }, index: { state: 'off' } }));
    assert.equal(d.qa('ul.fd-pick li', d.panel('code')).length, 0);
    assert.equal(d.qa('[data-action="select"]').length, 0, 'no Inspect button anywhere');
  });
});

describe('dashboard: Git tab', () => {
  it('a ready repository: name, branch, short commit, ahead and behind, three groups with counts', () => {
    const d = mount();
    d.send(busyState());
    const r = d.q('section.fd-repo', d.panel('git'));
    assert.equal(textOf(d.q('.fd-repo-name', r)), 'proj');
    assert.equal(textOf(d.q('.fd-branch-name', r)), 'main');
    assert.equal(textOf(d.q('.fd-commit', r)), 'a3f9c21');
    assert.equal(textOf(d.q('.fd-sync', r)), '↑2 ↓1');
    assert.equal(d.q('.fd-sync', r).getAttribute('aria-label'), '2 ahead, 1 behind');
    const groups = d.qa('section.fd-git-group', r);
    assert.deepEqual(
      groups.map((g) => g.getAttribute('data-group')),
      ['staged', 'unstaged', 'untracked'],
    );
    assert.deepEqual(
      groups.map((g) => textOf(d.q('h3', g))),
      ['Staged', 'Changes', 'Untracked'],
    );
    assert.deepEqual(
      groups.map((g) => textOf(d.q('.fd-note', g))),
      ['1', '2', '1'],
    );
  });

  it('every change shows a status letter AND an accessible status word; modified/added/deleted/renamed/untracked/conflicted/other', () => {
    const d = mount();
    const statuses = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'other'] as const;
    d.send(dashState({ git: { state: 'ready', repos: [repo('r', { unstaged: statuses.map((s) => change(`${s}.ts`, 'src', s)) })] } }));
    const letters: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: 'C', other: '?' };
    for (const s of statuses) {
      const li = must(d.qa('li.fd-git-item', d.panel('git')).find((x) => x.getAttribute('data-id') === `/ws/proj/src/${s}.ts`));
      assert.equal(textOf(d.q('.fd-git-status', li)), letters[s]);
      assert.ok((d.q('.fd-git-status', li).getAttribute('title') ?? '').length > 0);
      assert.match(must(d.q('button.fd-file', li).getAttribute('aria-label')), new RegExp(`^${s}\\.ts, `));
    }
  });

  it('untracked files open the file (there is nothing to diff); changed files open the diff; a deleted file can still show its diff', () => {
    const d = mount();
    d.send(busyState());
    const byId = (id: string): HTMLElement => must(d.qa('li.fd-git-item', d.panel('git')).find((x) => x.getAttribute('data-id') === id));
    assert.equal(d.q('button.fd-file', byId('/ws/proj/docs/notes.md')).getAttribute('data-action'), 'open');
    assert.equal(d.q('button.fd-file', byId('/ws/proj/src/dashboard/app.ts')).getAttribute('data-action'), 'openDiff');
    const deleted = d.q<HTMLButtonElement>('button.fd-file', byId('/ws/proj/src/core/old-helper.ts'));
    assert.equal(deleted.getAttribute('data-action'), 'openDiff');
    assert.equal(deleted.disabled, false, 'the diff of a deleted file is exactly what you want to see');
  });

  it('a clean repository says "No uncommitted changes."; a truncated one says each list is capped', () => {
    const d = mount();
    d.send(dashState({ git: { state: 'ready', repos: [repo('clean')] } }));
    assert.match(textOf(d.panel('git')), /No uncommitted changes\./);
    d.send(dashState({ seq: 2, git: { state: 'ready', repos: [repo('big', { truncated: true, unstaged: [change('a.ts', 'src')] })] } }));
    assert.match(textOf(d.panel('git')), /Each list shows at most 200 files\./);
  });

  it('a detached HEAD says there is no branch; no commit is not shown', () => {
    const d = mount();
    d.send(dashState({ git: { state: 'ready', repos: [repo('r', { branch: null, commit: null })] } }));
    assert.equal(textOf(d.q('.fd-branch-name', d.panel('git'))), 'no branch');
    assert.equal(d.qa('.fd-commit', d.panel('git')).length, 0);
  });

  it('two repositories are two sections, each updated in place', () => {
    const d = mount();
    d.send(dashState({ seq: 1, git: { state: 'ready', repos: [repo('one'), repo('two', { branch: 'dev' })] } }));
    const secs = d.qa('section.fd-repo', d.panel('git'));
    assert.equal(secs.length, 2);
    d.send(dashState({ seq: 2, git: { state: 'ready', repos: [repo('one'), repo('two', { branch: 'feature' })] } }));
    assert.deepEqual(d.qa('section.fd-repo', d.panel('git')), secs);
    assert.equal(textOf(d.q('.fd-branch-name', must(secs[1]))), 'feature');
  });

  it('says what is true when Git is not available: disabled, unavailable (with the reason), loading, and ready with no repository', () => {
    const d = mount();
    const git = (o: Parameters<typeof dashState>[0], seq: number): string => {
      d.send(dashState({ seq, ...o }));
      return textOf(d.panel('git'));
    };
    assert.match(git({ git: { state: 'disabled', detail: '' }, settings: { gitEnabled: false } }, 1), /Git integration is turned off \(changescope\.git\.enabled\)\./);
    assert.match(git({ git: { state: 'unavailable', detail: 'the built-in Git extension is disabled in this window.' } }, 2), /Git is unavailable: the built-in Git extension is disabled in this window\./);
    assert.match(git({ git: { state: 'unavailable', detail: '' } }, 3), /Git is unavailable\./);
    assert.match(git({ git: { state: 'loading', detail: '' } }, 4), /Loading Git status\./);
    assert.match(git({ git: { state: 'ready', repos: [] } }, 5), /No Git repository was found in this workspace\./);
    assert.equal(d.qa('section.fd-repo').length, 0);
  });

  it('the Git label is explained as a time correlation, not proof', () => {
    const d = mount();
    d.send(busyState());
    assert.match(textOf(d.panel('git')), /time correlation, not proof/);
  });
});

describe('dashboard: Sessions tab', () => {
  it('with no active session: a start form with a labelled title input and a Start button; "No previous sessions."', () => {
    const d = mount();
    d.send(dashState());
    const input = d.q<HTMLInputElement>('input#fd-session-title', d.panel('sessions'));
    assert.equal(input.getAttribute('data-field'), 'sessionTitle');
    assert.equal(input.maxLength, 120);
    assert.equal(textOf(must(d.root.ownerDocument.querySelector('label[for="fd-session-title"]'))), 'New session');
    assert.equal(textOf(d.q('button[data-action="sessionStart"]', d.panel('sessions'))), 'Start session');
    assert.equal(d.qa('button[data-action="sessionStop"]').length, 0);
    assert.equal(textOf(d.q('.fd-empty', d.panel('sessions'))), 'No previous sessions.');
  });

  it('with an active session: the start form is replaced by the session card with Stop, Rename, Export; previous sessions are listed', () => {
    const d = mount();
    d.send(busyState());
    assert.equal(d.qa('input#fd-session-title').length, 0);
    const active = d.q('ul[data-group="active"] li.fd-session', d.panel('sessions'));
    assert.equal(active.getAttribute('data-status'), 'active');
    assert.equal(textOf(d.q('.fd-session-title', active)), 'Refactor dashboard');
    assert.equal(textOf(d.q('.fd-tag--status', active)), 'Active');
    assert.match(textOf(d.q('.fd-session-meta', active)), /Started 20m ago · 25 changes in 8 files · main/);
    assert.ok(d.q('button[data-action="sessionStop"]', active));
    assert.ok(d.q('button[data-edit="rename"]', active));
    assert.ok(d.q('button[data-action="sessionExport"]', active));
    const prev = d.qa('ul[data-group="previous"] li.fd-session', d.panel('sessions'));
    assert.equal(prev.length, 1);
    assert.equal(d.qa('button[data-action="sessionStop"]', must(prev[0])).length, 0, 'a completed session cannot be stopped');
    assert.match(textOf(d.q('.fd-session-meta', must(prev[0]))), /1h · ended 3h ago · 40 changes in 6 files/);
  });

  it('per-source counts in a session show an icon and the label', () => {
    const d = mount();
    d.send(dashState({ sessions: { active: dashSession('s1', 'W', { bySource: { developer: 5, 'ai-agent': 2, git: 1 } }) } }));
    const chips = d.qa('.fd-count', d.panel('sessions'));
    assert.deepEqual(
      chips.map((c) => textOf(c)),
      ['5 Developer', '2 AI agent', '1 Git'],
    );
    for (const c of chips) assert.ok(d.q('svg', c));
  });
});

describe('dashboard: Settings tab', () => {
  it('animation and pause are real switches (role=switch, aria-checked) with the word On/Off visible', () => {
    const d = mount();
    d.send(dashState({ settings: { animate: true, paused: false } }));
    const switches = d.qa<HTMLButtonElement>('button.fd-switch', d.panel('settings'));
    assert.deepEqual(
      switches.map((s) => s.getAttribute('data-action')),
      ['setAnimate', 'setPaused'],
    );
    for (const s of switches) {
      assert.equal(s.getAttribute('role'), 'switch');
      assert.ok(['true', 'false'].includes(must(s.getAttribute('aria-checked'))));
      assert.match(textOf(d.q('.fd-switch-state', s)), /^(On|Off)$/);
    }
    assert.equal(must(switches[0]).getAttribute('aria-checked'), 'true');
    assert.equal(textOf(d.q('.fd-switch-state', must(switches[0]))), 'On');
    assert.equal(must(switches[1]).getAttribute('aria-checked'), 'false');
    d.send(dashState({ seq: 2, settings: { animate: false, paused: true } }));
    assert.equal(must(d.qa('button.fd-switch', d.panel('settings'))[0]).getAttribute('aria-checked'), 'false');
    assert.equal(must(d.qa('button.fd-switch', d.panel('settings'))[1]).getAttribute('aria-checked'), 'true');
  });

  it('facts: git, dependency index, unsaved-edit warnings, history', () => {
    const d = mount();
    d.send(dashState({ settings: { collisions: false, historyLimit: 2500, retentionDays: 1 }, overview: { events: 1 }, index: { state: 'ready', indexed: 1204, total: 1204 }, git: { state: 'unavailable', detail: 'x' } }));
    const fact = (id: string): string => textOf(d.q('dd', d.q(`.fd-fact[data-setting="${id}"]`, d.panel('settings'))));
    assert.equal(fact('git'), 'On, but Git is unavailable');
    assert.equal(fact('dependencyIndex'), 'On, 1,204 files indexed');
    assert.equal(fact('collisions'), 'Off');
    assert.equal(textOf(d.q('[data-setting="history"] .fd-text', d.panel('settings'))), '1 event stored. Up to 2,500 are kept, for 1 day.');
  });

  it('the AI paragraph states the truth for local mode, assisted without a provider, and assisted with one (and what is sent)', () => {
    const d = mount();
    const ai = (o: Parameters<typeof dashState>[0], seq: number): string => {
      d.send(dashState({ seq, ...o }));
      return textOf(d.q('[data-setting="ai"] .fd-text', d.panel('settings')));
    };
    assert.match(ai({}, 1), /^Local: summaries are built on this machine from file names and counts\. Nothing is sent anywhere\./);
    assert.match(ai({ settings: { aiMode: 'assisted', aiProvider: null } }, 2), /Assisted mode is selected, but no provider is in use, so summaries are built on this machine and nothing is sent\./);
    const assisted = ai({ settings: { aiMode: 'assisted', aiProvider: 'acme.llm' } }, 3);
    assert.match(assisted, /requested from the provider "acme\.llm"/);
    assert.match(assisted, /never file contents/);
    assert.match(assisted, /asked for consent before the first request/);
  });

  it('"Open all settings" and "Clear history" are buttons with their actions, and Clear says it asks first', () => {
    const d = mount();
    d.send(dashState());
    assert.equal(textOf(d.q('button[data-action="openSettings"]', d.panel('settings'))), 'Open all settings');
    assert.equal(textOf(d.q('button[data-action="clearHistory"]', d.panel('settings'))), 'Clear history');
    assert.match(textOf(d.panel('settings')), /You are asked to confirm first/);
  });
});

describe('dashboard: limited and empty states say what is true', () => {
  it('empty: "No activity yet." on Overview (timeline), Activity, and the sessions list', () => {
    const d = mount();
    d.send(dashState());
    assert.match(textOf(d.panel('overview')), /No activity yet\. Edit a file/);
    assert.match(textOf(d.panel('activity')), /No activity yet\. Edit a file/);
    assert.equal(activityRows(d).length, 0);
    assert.equal(d.qa('.fd-tl').length, 0);
  });

  it('paused: a visible notice with a Resume button on every tab, data-paused=true, and the rows stay', () => {
    const d = mount();
    d.send(dashState({ settings: { paused: true }, files: [row('a.ts', 'src')] }));
    assert.equal(d.root.getAttribute('data-paused'), 'true');
    const notice = d.q('.fd-notice[data-kind="paused"]');
    assert.equal(textOf(notice.querySelector('.fd-notice-text')), PAUSED_TEXT);
    const resume = d.q<HTMLButtonElement>('button[data-action="setPaused"]', notice);
    assert.equal(textOf(resume), 'Resume');
    assert.equal(resume.getAttribute('data-value'), 'false');
    assert.equal(activityRows(d).length, 1);
    d.send(dashState({ seq: 2, settings: { paused: false }, files: [row('a.ts', 'src')] }));
    assert.equal(d.qa('.fd-notice[data-kind="paused"]').length, 0);
    assert.equal(d.root.getAttribute('data-paused'), 'false');
  });

  it('disabled: says Changescope is turned off and how to turn it on; data-enabled=false; no paused notice on top of it', () => {
    const d = mount();
    d.send(dashState({ enabled: false, settings: { paused: true }, files: [row('a.ts', 'src')] }));
    assert.equal(d.root.getAttribute('data-enabled'), 'false');
    assert.equal(textOf(d.q('.fd-notice[data-kind="disabled"] .fd-notice-text')), DISABLED_TEXT);
    assert.match(DISABLED_TEXT, /Changescope: Toggle On\/Off/);
    assert.equal(d.qa('.fd-notice[data-kind="paused"]').length, 0, 'one reason at a time: off beats paused');
    d.send(dashState({ seq: 2, enabled: true }));
    assert.equal(d.qa('.fd-notice[data-kind="disabled"]').length, 0);
  });

  it('no adapter reports: the AI empty text, and an empty adapter list (not a crash)', () => {
    const d = mount();
    d.send(dashState({ agents: [] }));
    goTo(d, 'activity');
    click(d.q('button.fd-chip[data-filter="ai"]'));
    assert.equal(textOf(d.q('.fd-empty', d.panel('activity'))), 'No agent adapter is reporting. Changes made by agents appear under External.');
    assert.equal(d.qa('.fd-adapter').length, 0);
  });

  it('index building: the Activity list in Impact mode explains why badges are missing', () => {
    const d = mount();
    d.send(dashState({ settings: { mode: 'impact' }, files: [row('a.ts', 'src')], index: { state: 'indexing', indexed: 340, total: 1200 } }));
    assert.equal(textOf(d.q('.fd-notice', d.panel('activity'))), 'Indexing dependencies: 340 of 1,200 files.');
  });

  it('git unavailable shows the reason on the Git tab only; the other tabs are unaffected', () => {
    const d = mount();
    d.send(dashState({ git: { state: 'unavailable', detail: 'the built-in Git extension is disabled in this window.' }, files: [row('a.ts', 'src')] }));
    assert.match(textOf(d.panel('git')), /disabled in this window/);
    assert.ok(!textOf(d.panel('activity')).includes('disabled in this window'));
    assert.equal(activityRows(d).length, 1);
  });
});
