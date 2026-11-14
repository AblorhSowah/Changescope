import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { click, goTo, key, mountDash, rowFor, textOf, type } from '../support/dashDom';
import type { DashHarness } from '../support/dashDom';
import { activeRow, busyState, change, dashSession, dashState, repo, row } from '../support/dashState';
import type { DashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import { parseDashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import { must } from '../support/fixtures';

let h: DashHarness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

function mount(o: Parameters<typeof mountDash>[0] = {}): DashHarness {
  h = mountDash(o);
  return h;
}

/** Messages sent after the initial `ready`. */
const sent = (d: DashHarness): DashboardWebviewMessage[] => d.host.messages.slice(1);

describe('dashboard: tabs, mouse and keyboard', () => {
  it('clicking a tab selects it, shows only its panel and persists the choice; it sends no message', () => {
    const d = mount();
    d.send(dashState());
    for (const tab of ['activity', 'code', 'git', 'sessions', 'settings', 'overview']) {
      goTo(d, tab);
      assert.equal(d.selectedTab(), tab);
      assert.equal(d.root.getAttribute('data-tab'), tab);
      assert.deepEqual(
        d.qa('section.fd-panel:not([hidden])').map((p) => p.getAttribute('data-panel')),
        [tab],
      );
      assert.equal(d.q(`button.fd-tab[data-tab="${tab}"]`).getAttribute('tabindex'), '0');
      assert.equal(d.qa('button.fd-tab[tabindex="0"]').length, 1);
      assert.equal(d.host.stateWrites.at(-1)?.tab, tab);
    }
    assert.deepEqual(sent(d), []);
  });

  it('Right/Left move to the next/previous tab, with wrap-around, moving focus and selection together', () => {
    const d = mount();
    d.send(dashState());
    const order = ['overview', 'activity', 'code', 'git', 'sessions', 'settings'];
    d.tab('overview').focus();
    for (let i = 1; i <= 7; i += 1) {
      const from = d.root.ownerDocument.activeElement as HTMLElement;
      const ev = key(from, 'ArrowRight');
      assert.equal(ev.defaultPrevented, true);
      const expected = order[i % 6] as string;
      assert.equal(d.selectedTab(), expected, `after ${i} x Right`);
      assert.equal(d.root.ownerDocument.activeElement, d.tab(expected), 'focus moved');
    }
    // now on "activity" (7 mod 6 = 1); Left twice wraps to the end
    key(d.root.ownerDocument.activeElement as HTMLElement, 'ArrowLeft');
    assert.equal(d.selectedTab(), 'overview');
    key(d.root.ownerDocument.activeElement as HTMLElement, 'ArrowLeft');
    assert.equal(d.selectedTab(), 'settings', 'Left from the first tab wraps to the last');
  });

  it('Home goes to the first tab, End to the last', () => {
    const d = mount();
    d.send(dashState());
    d.tab('git').focus();
    goTo(d, 'git');
    assert.equal(key(d.tab('git'), 'End').defaultPrevented, true);
    assert.equal(d.selectedTab(), 'settings');
    assert.equal(d.root.ownerDocument.activeElement, d.tab('settings'));
    assert.equal(key(d.tab('settings'), 'Home').defaultPrevented, true);
    assert.equal(d.selectedTab(), 'overview');
    key(d.tab('overview'), 'Home');
    assert.equal(d.selectedTab(), 'overview', 'Home on the first tab stays');
    key(d.tab('overview'), 'End');
    key(d.tab('settings'), 'End');
    assert.equal(d.selectedTab(), 'settings');
  });

  it('other keys on a tab do nothing and are not swallowed (Tab, Enter, Space, ArrowDown, letters)', () => {
    const d = mount();
    d.send(dashState());
    const before = d.selectedTab();
    for (const k of ['Tab', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'a', 'Escape', 'PageDown', 'Shift']) {
      assert.equal(key(d.tab('overview'), k).defaultPrevented, false, k);
    }
    assert.equal(d.selectedTab(), before);
  });

  it('keyboard navigation persists the tab like a click', () => {
    const d = mount();
    d.send(dashState());
    key(d.tab('overview'), 'ArrowRight');
    assert.equal(d.host.stateWrites.at(-1)?.tab, 'activity');
  });

  it('after any sequence of keys exactly one tab is selected and exactly one is in the tab order', () => {
    const d = mount();
    d.send(dashState());
    let seed = 3;
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'x'];
    for (let i = 0; i < 60; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      key(d.root.ownerDocument.activeElement instanceof d.dom.window.HTMLElement && d.root.contains(d.root.ownerDocument.activeElement) ? (d.root.ownerDocument.activeElement as HTMLElement) : d.tab('overview'), must(keys[seed % keys.length]));
      assert.equal(d.qa('button.fd-tab[aria-selected="true"]').length, 1);
      assert.equal(d.qa('button.fd-tab[tabindex="0"]').length, 1);
      assert.equal(d.qa('section.fd-panel:not([hidden])').length, 1);
    }
  });

  it('a stat card goes to its tab (and filter) locally: persisted, no message sent', () => {
    const d = mount();
    d.send(busyState());
    click(d.q('button.fd-card[data-card="ai"]'));
    assert.equal(d.selectedTab(), 'activity');
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'ai');
    assert.deepEqual(d.host.stateWrites.at(-1), { tab: 'activity', activityFilter: 'ai', codeView: 'dependencies' });
    goTo(d, 'overview');
    click(d.q('button.fd-card[data-card="external"]'));
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'external');
    goTo(d, 'overview');
    click(d.q('button.fd-card[data-card="developer"]'));
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'mine');
    goTo(d, 'overview');
    click(d.q('button.fd-card[data-card="unreviewed"]'));
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'all');
    goTo(d, 'overview');
    click(d.q('button.fd-card[data-card="sessions"]'));
    assert.equal(d.selectedTab(), 'sessions');
    assert.deepEqual(sent(d), []);
  });

  it('a click on text inside a card (not on the button itself) still counts', () => {
    const d = mount();
    d.send(busyState());
    click(d.q('.fd-card-value', d.q('button.fd-card[data-card="ai"]')));
    assert.equal(d.selectedTab(), 'activity');
  });
});

describe('dashboard: persisted state', () => {
  it('a valid persisted state is restored on mount', () => {
    const d = mount({ persisted: { tab: 'git', activityFilter: 'ai', codeView: 'impact' } });
    d.send(dashState());
    assert.equal(d.selectedTab(), 'git');
    assert.equal(d.root.getAttribute('data-tab'), 'git');
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'ai');
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]').getAttribute('data-code-view'), 'impact');
    assert.equal(d.q('section.fd-panel:not([hidden])').getAttribute('data-panel'), 'git');
  });

  it('junk persisted state falls back to the defaults, field by field, and never throws', () => {
    const junk: unknown[] = [undefined, null, 0, 5, 'x', true, [], [1, 2], {}, { tab: 'nope' }, { tab: 5 }, { tab: null, activityFilter: [] }, { tab: 'GIT' }, { activityFilter: 'everything' }, { codeView: 'both' }, { tab: {}, activityFilter: {}, codeView: {} }, () => 1];
    for (const state of junk) {
      const d = mountDash({ persisted: state });
      d.send(dashState());
      assert.equal(d.selectedTab(), 'overview', JSON.stringify(state));
      assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'all');
      assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]').getAttribute('data-code-view'), 'dependencies');
      d.close();
    }
  });

  it('a partly valid state keeps its valid fields and defaults the rest', () => {
    const d = mount({ persisted: { tab: 'sessions', activityFilter: 'bogus', codeView: 'impact', extra: 1 } });
    d.send(dashState());
    assert.equal(d.selectedTab(), 'sessions');
    assert.equal(d.q('button.fd-chip[aria-pressed="true"]').getAttribute('data-filter'), 'all');
    assert.equal(d.q('.fd-seg-btn[aria-pressed="true"]').getAttribute('data-code-view'), 'impact');
  });

  it('what is persisted is exactly {tab, activityFilter, codeView}: no data, no ids, no paths', () => {
    const d = mount();
    d.send(busyState());
    click(d.tab('activity'));
    click(d.q('button.fd-chip[data-filter="external"]'));
    goTo(d, 'code');
    click(d.q('.fd-seg-btn[data-code-view="impact"]'));
    const last = must(d.host.stateWrites.at(-1));
    assert.deepEqual(last, { tab: 'code', activityFilter: 'external', codeView: 'impact' });
    for (const w of d.host.stateWrites) assert.deepEqual(Object.keys(w).sort(), ['activityFilter', 'codeView', 'tab']);
  });

  it('state is not written until the user changes something', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    d.send(busyState({ seq: 2 }));
    assert.deepEqual(d.host.stateWrites, []);
  });
});

describe('dashboard: every control posts exactly its message', () => {
  it('the file name opens the file: rows, timeline, dependencies, impact lists and Git changes all send open or openDiff with the id', () => {
    const d = mount();
    d.send(busyState());
    const id = '/ws/proj/src/core/schema.ts';
    goTo(d, 'activity');
    click(d.q('button.fd-open', must(rowFor(d, id))));
    assert.deepEqual(d.host.last, { type: 'open', id });
    goTo(d, 'overview');
    const tl = must(d.qa('li.fd-tl', d.panel('overview')).find((li) => li.querySelector('button.fd-open')?.getAttribute('data-id') === id));
    click(d.q('button.fd-open', tl));
    assert.deepEqual(d.host.last, { type: 'open', id });
    goTo(d, 'code');
    click(d.q('section[data-deps="imports"] li.fd-dep button.fd-open', d.panel('code')));
    assert.deepEqual(d.host.last, { type: 'open', id: '/ws/proj/src/dashboard/model.ts' });
    click(d.q('section[data-deps="importedBy"] li.fd-dep button.fd-open', d.panel('code')));
    assert.deepEqual(d.host.last, { type: 'open', id: '/ws/proj/src/dashboard/main.ts' });
    goTo(d, 'git');
    click(d.q('li.fd-git-item[data-id="/ws/proj/src/dashboard/app.ts"] button.fd-file', d.panel('git')));
    assert.deepEqual(d.host.last, { type: 'openDiff', id: '/ws/proj/src/dashboard/app.ts' });
    click(d.q('li.fd-git-item[data-id="/ws/proj/docs/notes.md"] button.fd-file', d.panel('git')));
    assert.deepEqual(d.host.last, { type: 'open', id: '/ws/proj/docs/notes.md' });
  });

  it('Review, Diff and Inspect on a row send markReviewed, openDiff and select with that row id; Inspect also opens the Code tab', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'activity');
    const id = '/ws/proj/src/dashboard/app.ts';
    const li = must(rowFor(d, id));
    click(d.q('button[data-action="openDiff"]', li));
    assert.deepEqual(d.host.last, { type: 'openDiff', id });
    assert.equal(d.selectedTab(), 'activity', 'Diff stays where it is');
    click(d.q('button[data-action="select"]', li));
    assert.deepEqual(d.host.last, { type: 'select', id });
    assert.equal(d.selectedTab(), 'code');
    goTo(d, 'activity');
    const agent = must(rowFor(d, '/ws/proj/src/core/eventStore.ts'));
    click(d.q('button[data-action="markReviewed"]', agent));
    assert.deepEqual(d.host.last, { type: 'markReviewed', id: '/ws/proj/src/core/eventStore.ts' });
    assert.equal(d.selectedTab(), 'activity');
  });

  it('Mark all reviewed sends markAllReviewed and only appears while something is unreviewed', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'activity');
    click(d.q('button[data-action="markAllReviewed"]'));
    assert.deepEqual(d.host.last, { type: 'markAllReviewed' });
    d.send(dashState({ seq: 5, files: [row('a.ts', 'src')] }));
    assert.equal(d.qa('button[data-action="markAllReviewed"]').length, 0);
  });

  it('the mode buttons in Overview AND in Settings send setMode with that mode', () => {
    const d = mount();
    d.send(dashState());
    for (const tab of ['overview', 'settings']) {
      goTo(d, tab);
      for (const mode of ['compact', 'impact', 'live']) {
        click(d.q(`button.fd-mode[data-mode="${mode}"]`, d.panel(tab)));
        assert.deepEqual(d.host.last, { type: 'setMode', mode }, `${tab} ${mode}`);
      }
    }
    assert.equal(d.root.getAttribute('data-mode'), 'live', 'the UI waits for the host: clicking alone does not change the mode');
  });

  it('pause: the Overview button, the Settings switch and the Resume button of the notice all send the OPPOSITE of the current state', () => {
    const d = mount();
    d.send(dashState({ seq: 1, settings: { paused: false } }));
    goTo(d, 'overview');
    click(d.q('button.fd-pause', d.panel('overview')));
    assert.deepEqual(d.host.last, { type: 'setPaused', value: true });
    goTo(d, 'settings');
    click(d.q('button.fd-switch[data-action="setPaused"]', d.panel('settings')));
    assert.deepEqual(d.host.last, { type: 'setPaused', value: true });
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    click(d.q('button.fd-switch[data-action="setPaused"]', d.panel('settings')));
    assert.deepEqual(d.host.last, { type: 'setPaused', value: false });
    goTo(d, 'overview');
    click(d.q('button.fd-pause', d.panel('overview')));
    assert.deepEqual(d.host.last, { type: 'setPaused', value: false });
    click(d.q('.fd-notice[data-kind="paused"] button[data-action="setPaused"]'));
    assert.deepEqual(d.host.last, { type: 'setPaused', value: false });
  });

  it('the animation switch sends the opposite of the current value', () => {
    const d = mount();
    d.send(dashState({ seq: 1, settings: { animate: true } }));
    goTo(d, 'settings');
    click(d.q('button.fd-switch[data-action="setAnimate"]'));
    assert.deepEqual(d.host.last, { type: 'setAnimate', value: false });
    d.send(dashState({ seq: 2, settings: { animate: false } }));
    click(d.q('button.fd-switch[data-action="setAnimate"]'));
    assert.deepEqual(d.host.last, { type: 'setAnimate', value: true });
  });

  it('Summarize / Refresh, Clear history and Open all settings send their bare messages', () => {
    const d = mount();
    d.send(dashState());
    click(d.q('button[data-action="summarize"]'));
    assert.deepEqual(d.host.last, { type: 'summarize' });
    goTo(d, 'settings');
    click(d.q('button[data-action="clearHistory"]'));
    assert.deepEqual(d.host.last, { type: 'clearHistory' });
    click(d.q('button[data-action="openSettings"]'));
    assert.deepEqual(d.host.last, { type: 'openSettings' });
  });

  it('Clear history sends only clearHistory (no deletion is done locally: rows stay until the host says so)', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'settings');
    const rows = d.qa('li.fd-row').length;
    click(d.q('button[data-action="clearHistory"]'));
    assert.deepEqual(sent(d), [{ type: 'clearHistory' }]);
    assert.equal(d.qa('li.fd-row').length, rows);
  });

  it('Stop and Export send sessionStop and sessionExport with the session id', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-action="sessionStop"]'));
    assert.deepEqual(d.host.last, { type: 'sessionStop' });
    click(d.q('ul[data-group="active"] button[data-action="sessionExport"]'));
    assert.deepEqual(d.host.last, { type: 'sessionExport', id: 's-active' });
    click(d.q('ul[data-group="previous"] button[data-action="sessionExport"]'));
    assert.deepEqual(d.host.last, { type: 'sessionExport', id: 's-2' });
  });

  it('every message that leaves is valid for the host: it passes parseDashboardWebviewMessage unchanged', () => {
    const d = mount();
    d.send(busyState());
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      for (const b of d.qa<HTMLButtonElement>('button[data-action]', d.panel(tab))) if (!b.disabled && b.getAttribute('data-action') !== 'sessionRename') click(b);
      goTo(d, tab);
    }
    assert.ok(sent(d).length > 15, `${sent(d).length} messages`);
    for (const m of sent(d)) assert.deepEqual(parseDashboardWebviewMessage(m), m);
    const types = new Set(sent(d).map((m) => m.type));
    for (const t of ['open', 'openDiff', 'select', 'markReviewed', 'markAllReviewed', 'setMode', 'setAnimate', 'setPaused', 'sessionStop', 'sessionExport', 'clearHistory', 'openSettings', 'summarize']) assert.ok(types.has(t as DashboardWebviewMessage['type']), `no ${t} was sent by any control`);
  });

  it('nothing but the documented message shapes ever leaves: no path, uri, command or setting key fields', () => {
    const d = mount();
    d.send(busyState());
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      for (const b of d.qa<HTMLButtonElement>('button', d.panel(tab))) if (!b.disabled) click(b);
    }
    for (const m of sent(d)) {
      for (const field of Object.keys(m)) assert.ok(['type', 'id', 'mode', 'value', 'title', 'message'].includes(field), `${m.type} has field ${field}`);
    }
  });

  it('disabled buttons and clicks on plain text send nothing', () => {
    const d = mount();
    d.send(dashState({ files: [row('gone.ts', 'src', { lastEventType: 'delete', exists: false }), row('here.ts', 'src')] }));
    goTo(d, 'activity');
    click(d.q('button.fd-open', must(rowFor(d, '/ws/proj/src/gone.ts'))));
    click(d.q('.fd-dir', must(rowFor(d, '/ws/proj/src/here.ts'))));
    click(must(rowFor(d, '/ws/proj/src/here.ts')));
    click(d.q('.fd-source-label'));
    click(d.panel('activity'));
    click(d.root);
    assert.deepEqual(sent(d), []);
  });

  it('a button whose data-id is missing or whose action is unknown sends nothing (nothing can be forged by editing the DOM)', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'activity');
    const b = d.q<HTMLButtonElement>('button[data-action="openDiff"]');
    b.removeAttribute('data-id');
    click(b);
    b.setAttribute('data-id', '/ws/x');
    b.setAttribute('data-action', 'rm -rf');
    click(b);
    b.setAttribute('data-action', 'setMode');
    b.setAttribute('data-mode', 'turbo');
    click(b);
    b.setAttribute('data-action', 'setPaused');
    b.setAttribute('data-value', 'maybe');
    click(b);
    assert.deepEqual(sent(d), []);
  });
});

describe('dashboard: starting and renaming a session inline', () => {
  it('Start session sends sessionStart with the cleaned title and empties the input', () => {
    const d = mount();
    d.send(dashState());
    goTo(d, 'sessions');
    const input = d.q<HTMLInputElement>('input#fd-session-title');
    type(input, '  Refactor\tthe  dashboard \u0000 ');
    click(d.q('button[data-action="sessionStart"]'));
    assert.deepEqual(d.host.last, { type: 'sessionStart', title: 'Refactor the dashboard' });
    assert.equal(input.value, '');
  });

  it('an empty title is sent as "" so the host names the session', () => {
    const d = mount();
    d.send(dashState());
    goTo(d, 'sessions');
    click(d.q('button[data-action="sessionStart"]'));
    assert.deepEqual(d.host.last, { type: 'sessionStart', title: '' });
    type(d.q<HTMLInputElement>('input#fd-session-title'), '   ');
    click(d.q('button[data-action="sessionStart"]'));
    assert.deepEqual(d.host.last, { type: 'sessionStart', title: '' });
  });

  it('Enter in the title input starts the session (and prevents the default); other keys do not', () => {
    const d = mount();
    d.send(dashState());
    goTo(d, 'sessions');
    const input = d.q<HTMLInputElement>('input#fd-session-title');
    type(input, 'From the keyboard');
    assert.equal(key(input, 'a').defaultPrevented, false);
    assert.equal(key(input, 'Escape').defaultPrevented, false);
    assert.deepEqual(sent(d), []);
    assert.equal(key(input, 'Enter').defaultPrevented, true);
    assert.deepEqual(sent(d), [{ type: 'sessionStart', title: 'From the keyboard' }]);
    assert.equal(input.value, '');
  });

  it('a title longer than 120 is capped (the input also has maxlength 120)', () => {
    const d = mount();
    d.send(dashState());
    goTo(d, 'sessions');
    const input = d.q<HTMLInputElement>('input#fd-session-title');
    assert.equal(input.getAttribute('maxlength'), '120');
    type(input, 'x'.repeat(400));
    click(d.q('button[data-action="sessionStart"]'));
    assert.equal((d.host.last as { title: string }).title.length, 120);
  });

  it('a hostile title is sent as text, untouched', () => {
    const d = mount();
    d.send(dashState());
    goTo(d, 'sessions');
    type(d.q<HTMLInputElement>('input#fd-session-title'), '<img src=x onerror=alert(1)>');
    click(d.q('button[data-action="sessionStart"]'));
    assert.deepEqual(d.host.last, { type: 'sessionStart', title: '<img src=x onerror=alert(1)>' });
  });

  it('Rename opens an input holding the current title, focused and selected; the row switches to Save and Cancel', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    const li = d.q('ul[data-group="active"] li.fd-session');
    click(d.q('button[data-edit="rename"]', li));
    const input = d.q<HTMLInputElement>('input[data-field="sessionRename"]', li);
    assert.equal(input.value, 'Refactor dashboard');
    assert.equal(input.getAttribute('data-id'), 's-active');
    assert.equal(d.root.ownerDocument.activeElement, input);
    assert.equal(li.getAttribute('data-editing'), 'true');
    assert.equal(d.qa('.fd-session-title', li).length, 0, 'the title text is replaced by the input while editing');
    assert.deepEqual(
      d.qa<HTMLButtonElement>('.fd-actions button', li).map((b) => textOf(b)),
      ['Save', 'Cancel'],
    );
    assert.deepEqual(sent(d), [], 'opening the editor sends nothing');
  });

  it('Save sends sessionRename with the cleaned title and closes the editor; focus returns to the Rename button', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    const input = d.q<HTMLInputElement>('input[data-field="sessionRename"]');
    type(input, '  New \u0007 title  ');
    click(d.q('button[data-action="sessionRename"]'));
    assert.deepEqual(d.host.last, { type: 'sessionRename', id: 's-active', title: 'New title' });
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 0);
    assert.equal(d.root.ownerDocument.activeElement, d.q('ul[data-group="active"] button[data-edit="rename"]'));
  });

  it('Enter in the rename input saves; Escape and Cancel send nothing and close the editor', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'Via Enter');
    assert.equal(key(d.q('input[data-field="sessionRename"]'), 'Enter').defaultPrevented, true);
    assert.deepEqual(sent(d), [{ type: 'sessionRename', id: 's-active', title: 'Via Enter' }]);
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 0);

    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'Abandoned');
    assert.equal(key(d.q('input[data-field="sessionRename"]'), 'Escape').defaultPrevented, true);
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 0);
    assert.equal(sent(d).length, 1, 'Escape sent nothing');

    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'Cancelled');
    click(d.q('button[data-edit="cancel"]'));
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 0);
    assert.equal(sent(d).length, 1, 'Cancel sent nothing');
  });

  it('an empty (or all-control-character) rename sends nothing, marks the input invalid and keeps the editor open', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    const input = d.q<HTMLInputElement>('input[data-field="sessionRename"]');
    for (const bad of ['', '   ', '\u0000\u0001']) {
      type(input, bad);
      click(d.q('button[data-action="sessionRename"]'));
      key(input, 'Enter');
    }
    assert.deepEqual(sent(d), []);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 1, 'still editing');
  });

  it('a previous session can be renamed too, with its own id', () => {
    const d = mount();
    d.send(busyState());
    goTo(d, 'sessions');
    click(d.q('ul[data-group="previous"] button[data-edit="rename"]'));
    type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'Better name');
    click(d.q('button[data-action="sessionRename"]'));
    assert.deepEqual(d.host.last, { type: 'sessionRename', id: 's-2', title: 'Better name' });
  });

  it('an editor stays open across incoming states, keeping what was typed, until saved or cancelled', () => {
    const d = mount();
    d.send(busyState({ seq: 1 }));
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    const input = d.q<HTMLInputElement>('input[data-field="sessionRename"]');
    type(input, 'Half typed');
    d.send(busyState({ seq: 2, sessions: { active: dashSession('s-active', 'Refactor dashboard', { activityCount: 99 }), previous: [] } }));
    assert.equal(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), input, 'same input element');
    assert.equal(input.value, 'Half typed');
  });

  it('when the session being renamed disappears (history cleared) the editor closes instead of renaming a ghost', () => {
    const d = mount();
    d.send(busyState({ seq: 1 }));
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    d.send(dashState({ seq: 2 }));
    assert.equal(d.qa('input[data-field="sessionRename"]').length, 0);
    assert.deepEqual(sent(d), []);
  });

  it('when the active session stops while being renamed, the editor moves with it and still sends the right id', () => {
    const d = mount();
    d.send(busyState({ seq: 1 }));
    goTo(d, 'sessions');
    click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
    type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'Renamed after stop');
    d.send(dashState({ seq: 2, sessions: { active: null, previous: [dashSession('s-active', 'Refactor dashboard', { status: 'completed', endedAt: 5 })] } }));
    const input = d.q<HTMLInputElement>('input[data-field="sessionRename"]');
    assert.equal(input.getAttribute('data-id'), 's-active');
    click(d.q('button[data-action="sessionRename"]'));
    assert.deepEqual(d.host.last, { type: 'sessionRename', id: 's-active', title: input.value });
  });
});

describe('dashboard: focus is kept across updates', () => {
  it('a focused row button keeps the focus when new states arrive, including when the row moves', () => {
    const d = mount();
    const a = row('a.ts', 'src', { ago: 5 });
    const b = row('b.ts', 'src', { ago: 50 });
    d.send(dashState({ seq: 1, files: [a, b] }));
    goTo(d, 'activity');
    const btn = d.q<HTMLButtonElement>('button.fd-open', must(rowFor(d, b.id)));
    btn.focus();
    assert.equal(d.root.ownerDocument.activeElement, btn);
    d.send(dashState({ seq: 2, files: [a, b] }));
    assert.equal(d.root.ownerDocument.activeElement, btn);
    d.send(dashState({ seq: 3, files: [b, a] }));
    assert.equal(d.root.ownerDocument.activeElement, btn, 'the row was moved above the other one');
    assert.equal(d.q<HTMLButtonElement>('button.fd-open', must(rowFor(d, b.id))), btn, 'and it is the same button element');
  });

  it('when the focused Review button goes away (the file was reviewed) the focus lands in the same row or on the tab, never on <body>', () => {
    const d = mount();
    const f = row('a.ts', 'src', { source: 'external', review: 'unreviewed' });
    d.send(dashState({ seq: 1, files: [f] }));
    goTo(d, 'activity');
    const review = d.q<HTMLButtonElement>('button[data-action="markReviewed"]', must(rowFor(d, f.id)));
    review.focus();
    d.send(dashState({ seq: 2, files: [{ ...f, review: 'reviewed' }] }));
    const active = d.root.ownerDocument.activeElement;
    assert.ok(active && active !== d.root.ownerDocument.body, 'focus was dropped on the body');
    assert.ok(d.root.contains(active));
  });

  it('when the focused row is filtered out or removed, the focus falls back inside the app', () => {
    const d = mount();
    const f = row('a.ts', 'src');
    d.send(dashState({ seq: 1, files: [f, row('b.ts', 'src')] }));
    goTo(d, 'activity');
    d.q<HTMLButtonElement>('button.fd-open', must(rowFor(d, f.id))).focus();
    d.send(dashState({ seq: 2, files: [row('b.ts', 'src')] }));
    const active = d.root.ownerDocument.activeElement;
    assert.ok(active && d.root.contains(active) && active !== d.root, 'focus stays inside the dashboard');
  });

  it('typing in the session input is not interrupted by incoming states (value and focus kept)', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    goTo(d, 'sessions');
    const input = d.q<HTMLInputElement>('input#fd-session-title');
    input.focus();
    type(input, 'partial');
    for (let i = 2; i < 8; i += 1) d.send(dashState({ seq: i, files: [row(`f${i}.ts`, 'src')] }));
    assert.equal(d.q<HTMLInputElement>('input#fd-session-title'), input);
    assert.equal(input.value, 'partial');
    assert.equal(d.root.ownerDocument.activeElement, input);
  });

  it('a state that starts a session replaces the start form, and the title typed before is not lost by the next start', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    goTo(d, 'sessions');
    type(d.q<HTMLInputElement>('input#fd-session-title'), 'My task');
    d.send(dashState({ seq: 2, sessions: { active: dashSession('s1', 'My task') } }));
    assert.equal(d.qa('input#fd-session-title').length, 0);
    assert.equal(textOf(d.q('.fd-session-title')), 'My task');
  });
});

describe('dashboard: live region announcements', () => {
  it('the first state announces nothing; a change of tracking state is announced politely', () => {
    const d = mount();
    const live = d.q('.fd-live');
    d.send(dashState({ seq: 1, settings: { paused: false } }));
    assert.equal(textOf(live), '');
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    assert.equal(textOf(live), 'Tracking paused.');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.getAttribute('aria-atomic'), 'true');
  });

  it('announcements are throttled through the injected timer: a second change waits, and the queue is flushed together', () => {
    const d = mount();
    const live = d.q('.fd-live');
    d.send(dashState({ seq: 1 }));
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    assert.equal(textOf(live), 'Tracking paused.');
    assert.equal(d.env.pending, 1);
    d.send(dashState({ seq: 3, settings: { paused: true, mode: 'compact' } }));
    d.send(dashState({ seq: 4, settings: { paused: false, mode: 'compact' } }));
    assert.equal(textOf(live), 'Tracking paused.', 'nothing new is said inside the window');
    d.env.runTimers(1);
    assert.equal(textOf(live), 'Compact mode. Tracking resumed.');
    d.env.runTimers(5);
    assert.equal(d.env.pending, 0, 'the throttle stops by itself once the queue is empty');
    assert.ok(d.env.scheduled.every((t) => t.ms === 1500));
  });

  it('progress counts are not announced (they would never stop talking), but starting and finishing the index are', () => {
    const d = mount();
    const live = d.q('.fd-live');
    d.send(dashState({ seq: 1, index: { state: 'idle' } }));
    d.send(dashState({ seq: 2, index: { state: 'indexing', indexed: 10, total: 100 } }));
    assert.equal(textOf(live), 'Indexing dependencies.');
    d.env.runTimers();
    for (let i = 0; i < 20; i += 1) d.send(dashState({ seq: 3 + i, index: { state: 'indexing', indexed: 10 + i * 4, total: 100 } }));
    assert.equal(d.env.pending, 0, 'no announcement was queued for the counts');
    d.send(dashState({ seq: 30, index: { state: 'ready', indexed: 100, total: 100 } }));
    assert.equal(textOf(live), 'Dependency index ready: 100 files.');
  });

  it('session start and stop, Git becoming unavailable, File Shake on/off and a new summary are announced', () => {
    const d = mount();
    const live = d.q('.fd-live');
    const say = (o: Parameters<typeof dashState>[0], seq: number): string => {
      d.env.runTimers();
      d.send(dashState({ seq, ...o }));
      return textOf(live);
    };
    d.send(dashState({ seq: 1 }));
    assert.equal(say({ sessions: { active: dashSession('s1', 'Work') } }, 2), 'Session started: Work.');
    assert.equal(say({}, 3), 'Session stopped.');
    assert.equal(say({ git: { state: 'unavailable', detail: 'x' } }, 4), 'Git is unavailable.');
    assert.equal(say({ enabled: false }, 5), 'File Shake is off.');
    assert.equal(say({ enabled: true }, 6), 'File Shake is on.');
    assert.equal(say({ summary: { text: 't', provider: 'local', at: 5 } }, 7), 'Summary updated.');
  });
});

describe('dashboard: busy states do not produce messages by themselves', () => {
  it('rendering any number of states posts nothing (only user actions post)', () => {
    const d = mount();
    for (let i = 1; i <= 20; i += 1) d.send(busyState({ seq: i }));
    assert.deepEqual(sent(d), []);
  });

  it('a repo with a changed file and the Inspect click sequence works end to end: select -> Code tab -> state with selection -> imports shown', () => {
    const d = mount();
    d.send(dashState({ seq: 1, files: [row('a.ts', 'src')], index: { state: 'ready', indexed: 3, total: 3 }, git: { state: 'ready', repos: [repo('r', { unstaged: [change('a.ts', 'src')] })] } }));
    goTo(d, 'activity');
    click(d.q('button[data-action="select"]'));
    assert.deepEqual(d.host.last, { type: 'select', id: '/ws/proj/src/a.ts' });
    assert.equal(d.selectedTab(), 'code');
    d.send(busyState({ seq: 2 }));
    assert.ok(d.qa('li.fd-dep').length > 0);
  });
});

describe('dashboard: unrelated rows are not disturbed by an update to one of them', () => {
  it('only the changed row\'s DOM is written; the others get no mutation at all', () => {
    const d = mount();
    const files = [activeRow('a.ts', 'src'), row('b.ts', 'src'), row('c.ts', 'src')];
    d.send(dashState({ seq: 1, files }));
    goTo(d, 'activity');
    const MO = (d.dom.window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
    const watched = [must(rowFor(d, files[1]?.id ?? '')), must(rowFor(d, files[2]?.id ?? ''))];
    const obs = new MO(() => undefined);
    for (const el of watched) obs.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
    d.send(dashState({ seq: 2, files: [{ ...(files[0] as (typeof files)[number]), changes: 15, intensity: 0.8 }, files[1] as (typeof files)[number], files[2] as (typeof files)[number]] }));
    assert.equal(obs.takeRecords().length, 0, 'b.ts and c.ts were not touched');
    obs.disconnect();
  });

  it('an identical state (same data, later seq) writes nothing to the DOM at all', () => {
    const d = mount();
    const s = busyState({ seq: 1 });
    d.send(s);
    const MO = (d.dom.window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
    const obs = new MO(() => undefined);
    obs.observe(d.root, { subtree: true, attributes: true, childList: true, characterData: true });
    d.send({ ...s, seq: 2 });
    const records = obs.takeRecords();
    assert.equal(records.length, 0, `${records.length} DOM writes for an unchanged state: ${records.slice(0, 3).map((r) => `${r.type}:${(r.target as Element).className ?? ''}:${r.attributeName ?? ''}`).join(' | ')}`);
    obs.disconnect();
  });
});
