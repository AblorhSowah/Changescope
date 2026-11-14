import { VIEW_MODES, parseDashboardHostMessage, parseDashboardWebviewMessage } from '../core/dashboard/protocol';
import type { DashboardWebviewMessage } from '../core/dashboard/protocol';
import type { DashboardState, ViewMode } from '../core/types';
import { button, focusEl, h, isElement, placeChildren, setAttr, setHidden } from './dom';
import { MODE_LABEL, formatCount } from './format';
import { TABS, isCodeViewId, isFilterId, isTabId, parsePersisted } from './model';
import type { AppEnv, DashApp, DashHostApi, DashPersisted, Frame, TabId, View } from './model';
import { createNotice } from './parts';
import { createActivity } from './views/activity';
import { createCode } from './views/code';
import { createGit } from './views/git';
import { createOverview } from './views/overview';
import { createSessions } from './views/sessions';
import { createSettings } from './views/settings';

export type { AppEnv, CodeViewId, DashApp, DashHostApi, DashPersisted, FilterId, TabId } from './model';

/** Minimum time between two announcements in the live region. */
export const ANNOUNCE_MS = 1500;

export const DISABLED_TEXT = 'File Shake is turned off, so new changes are not recorded. Run "File Shake: Toggle On/Off" to turn it back on.';
export const PAUSED_TEXT = 'Tracking is paused. New changes are not recorded.';
export const LOADING_TEXT = 'Loading activity.';

function defaultEnv(doc: Document): AppEnv {
  const win = doc.defaultView;
  const query = (): MediaQueryList | undefined =>
    win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  return {
    reducedMotion: () => query()?.matches === true,
    onReducedMotionChange: (cb) => {
      const mql = query();
      if (!mql) return () => undefined;
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    setTimeout: (fn, ms) => (win ? win.setTimeout(fn, ms) : 0),
    clearTimeout: (id) => win?.clearTimeout(id),
  };
}

function isViewMode(v: string | null): v is ViewMode {
  return v !== null && (VIEW_MODES as readonly string[]).includes(v);
}

function isDisabled(el: Element): boolean {
  return 'disabled' in el && el.disabled === true;
}

/** Status changes worth saying aloud. Progress counts are left out on purpose: they would never stop talking. */
function statusChanges(prev: DashboardState, next: DashboardState): string[] {
  const out: string[] = [];
  if (prev.enabled !== next.enabled) out.push(next.enabled ? 'File Shake is on.' : 'File Shake is off.');
  if (prev.settings.paused !== next.settings.paused) out.push(next.settings.paused ? 'Tracking paused.' : 'Tracking resumed.');
  if (prev.settings.mode !== next.settings.mode) out.push(`${MODE_LABEL[next.settings.mode]} mode.`);
  if (prev.git.state !== next.git.state && next.git.state === 'unavailable') out.push('Git is unavailable.');
  if (prev.index.state !== next.index.state) {
    if (next.index.state === 'indexing') out.push('Indexing dependencies.');
    else if (next.index.state === 'ready') out.push(`Dependency index ready: ${formatCount(next.index.indexed)} files.`);
  }
  const before = prev.sessions.active;
  const after = next.sessions.active;
  if (before?.id !== after?.id) out.push(after ? `Session started: ${after.title}.` : 'Session stopped.');
  if (next.summary !== null && prev.summary?.at !== next.summary.at) out.push('Summary updated.');
  return out;
}

/** Mounts the dashboard into `root`. Has no side effects at import time. */
export function mountDashboard(root: HTMLElement, host: DashHostApi, envOverride: Partial<AppEnv> = {}): DashApp {
  const doc = root.ownerDocument;
  const env: AppEnv = { ...defaultEnv(doc), ...envOverride };
  const ui: DashPersisted = parsePersisted(host.getState());

  let lastSeq = -1;
  let last: DashboardState | undefined;
  let disposed = false;

  // ----- skeleton --------------------------------------------------------------

  const nav = h(doc, 'nav', 'fd-tabs', { role: 'tablist', 'aria-label': 'File Shake dashboard' });
  const tabEls = new Map<TabId, HTMLButtonElement>();
  const panelEls = new Map<TabId, HTMLElement>();
  for (const t of TABS) {
    const tab = button(doc, 'fd-tab', { role: 'tab', id: `fd-tab-${t.id}`, 'data-tab': t.id, 'aria-controls': `fd-panel-${t.id}`, 'aria-selected': 'false', tabindex: '-1' }, t.label);
    nav.appendChild(tab);
    tabEls.set(t.id, tab);
    const panel = h(doc, 'section', 'fd-panel', { role: 'tabpanel', id: `fd-panel-${t.id}`, 'data-panel': t.id, 'aria-labelledby': `fd-tab-${t.id}`, tabindex: '0' });
    panel.hidden = true;
    panelEls.set(t.id, panel);
  }

  const notices = h(doc, 'div', 'fd-notices');
  const loading = createNotice(doc, 'loading');
  loading.text.textContent = LOADING_TEXT;
  const disabledNotice = createNotice(doc, 'disabled', 'warning');
  disabledNotice.text.textContent = DISABLED_TEXT;
  const pausedNotice = createNotice(doc, 'paused', 'warning');
  pausedNotice.text.textContent = PAUSED_TEXT;
  pausedNotice.el.appendChild(button(doc, 'fd-act', { 'data-action': 'setPaused', 'data-value': 'false' }, 'Resume'));
  notices.appendChild(loading.el);

  // the one live region: visually hidden, polite, fed by `announce`
  const live = h(doc, 'div', 'fd-live fd-sr', { 'aria-live': 'polite', 'aria-atomic': 'true' });

  const sessions = createSessions(doc);
  const views: Readonly<Record<TabId, View>> = {
    overview: createOverview(doc),
    activity: createActivity(doc),
    code: createCode(doc),
    git: createGit(doc),
    sessions,
    settings: createSettings(doc),
  };

  root.setAttribute('data-mode', 'live');
  root.setAttribute('data-motion', env.reducedMotion() ? 'off' : 'on');
  root.setAttribute('data-enabled', 'true');
  root.setAttribute('data-state', 'loading');
  root.append(nav, notices, ...panelEls.values(), live);

  // ----- small helpers ---------------------------------------------------------

  const persist = (): void => {
    host.setState({ tab: ui.tab, activityFilter: ui.activityFilter, codeView: ui.codeView });
  };

  /** Everything goes through the validator of the contract, so nothing outside DashboardWebviewMessage can leave. */
  const send = (m: DashboardWebviewMessage): void => {
    const clean = parseDashboardWebviewMessage(m);
    if (clean) host.postMessage(clean);
  };

  let announceTimer: number | undefined;
  let announceQueue: string[] = [];
  const announce = (text: string): void => {
    if (announceTimer !== undefined) {
      announceQueue.push(text);
      return;
    }
    live.textContent = text;
    const tick = (): void => {
      announceTimer = undefined;
      if (disposed || announceQueue.length === 0) return;
      live.textContent = announceQueue.join(' ');
      announceQueue = [];
      announceTimer = env.setTimeout(tick, ANNOUNCE_MS);
    };
    announceTimer = env.setTimeout(tick, ANNOUNCE_MS);
  };

  const syncTabs = (): void => {
    root.setAttribute('data-tab', ui.tab);
    for (const t of TABS) {
      const selected = t.id === ui.tab;
      const tab = tabEls.get(t.id);
      const panel = panelEls.get(t.id);
      if (tab) {
        setAttr(tab, 'aria-selected', String(selected));
        setAttr(tab, 'tabindex', selected ? '0' : '-1');
      }
      if (panel) setHidden(panel, !selected);
    }
  };

  const selectTab = (id: TabId, focus: boolean): void => {
    if (ui.tab !== id) {
      ui.tab = id;
      persist();
      syncTabs();
    }
    if (focus) focusEl(tabEls.get(id));
  };

  /**
   * Runs a DOM update and puts the keyboard focus back where the user had it. A row that moves loses the
   * focus in a browser, and a button that goes away (Mark reviewed, once clicked) takes it along.
   */
  const keepFocus = (update: () => void): void => {
    const active = doc.activeElement;
    if (active === null || active === root || !root.contains(active)) {
      update();
      return;
    }
    const trail: Element[] = [];
    for (let p = active.parentElement; p && p !== root; p = p.parentElement) trail.push(p);
    update();
    const alive = active.isConnected && !isDisabled(active) && active.closest('[hidden]') === null;
    if (alive) {
      if (doc.activeElement !== active) focusEl(active);
      return;
    }
    for (const p of trail) {
      if (!p.isConnected || p.closest('[hidden]') !== null) continue;
      const next = p.querySelector('button:not([disabled]), input:not([disabled]), summary');
      if (next) {
        focusEl(next);
        return;
      }
    }
    focusEl(tabEls.get(ui.tab));
  };

  // ----- rendering -------------------------------------------------------------

  const buildFrame = (state: DashboardState): Frame => {
    const reduced = env.reducedMotion();
    const mode = state.settings.mode;
    const motion = state.settings.animate && mode !== 'compact' && !reduced;
    const exists = new Map<string, boolean>();
    for (const row of state.files) exists.set(row.id, row.exists);
    const diffs = new Set<string>();
    if (state.git.state === 'ready') {
      for (const repo of state.git.repos) {
        for (const c of repo.staged) diffs.add(c.id);
        for (const c of repo.unstaged) diffs.add(c.id);
      }
    }
    return {
      state,
      now: state.now,
      mode,
      motion,
      // a turned-off File Shake records nothing, so a leftover active row must not keep moving
      shake: motion && mode === 'live' && state.enabled,
      reducedMotion: reduced,
      ui,
      exists: (id) => exists.get(id) !== false,
      hasDiff: (id) => diffs.has(id),
    };
  };

  const render = (f: Frame): void => {
    const s = f.state;
    setAttr(root, 'data-mode', f.mode);
    setAttr(root, 'data-motion', f.motion ? 'on' : 'off');
    setAttr(root, 'data-enabled', String(s.enabled));
    setAttr(root, 'data-paused', String(s.settings.paused));
    setAttr(root, 'data-state', 'ready');
    placeChildren(notices, [!s.enabled && disabledNotice.el, s.enabled && s.settings.paused && pausedNotice.el]);
    for (const t of TABS) {
      const panel = panelEls.get(t.id);
      const view = views[t.id];
      if (panel && view.el.parentElement !== panel) panel.appendChild(view.el);
      view.render(f);
    }
  };

  const rerender = (): void => {
    if (!last) return;
    const f = buildFrame(last);
    keepFocus(() => render(f));
  };

  // ----- events ----------------------------------------------------------------

  const messageFor = (btn: Element): DashboardWebviewMessage | null => {
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    switch (action) {
      case 'open':
      case 'openDiff':
      case 'select':
      case 'markReviewed':
      case 'sessionExport':
        return id === null ? null : { type: action, id };
      case 'setMode': {
        const mode = btn.getAttribute('data-mode');
        return isViewMode(mode) ? { type: 'setMode', mode } : null;
      }
      case 'setAnimate':
      case 'setPaused': {
        const value = btn.getAttribute('data-value');
        return value === 'true' || value === 'false' ? { type: action, value: value === 'true' } : null;
      }
      case 'markAllReviewed':
      case 'sessionStop':
      case 'clearHistory':
      case 'openSettings':
      case 'summarize':
        return { type: action };
      case 'sessionStart':
        return { type: 'sessionStart', title: sessions.takeStartTitle() };
      case 'sessionRename': {
        const title = id === null ? null : sessions.renameTitle(id);
        return id === null || title === null ? null : { type: 'sessionRename', id, title };
      }
      default:
        return null;
    }
  };

  const stopRename = (focusId: string | null): void => {
    sessions.endRename();
    rerender();
    if (focusId !== null) focusEl(sessions.renameToggle(focusId));
  };

  const act = (btn: Element): void => {
    const m = messageFor(btn);
    if (!m) return;
    send(m);
    if (m.type === 'sessionRename') stopRename(m.id);
    // inspecting a file is a question about its dependencies, and the Code tab is where the answer shows
    if (m.type === 'select' && ui.tab !== 'code') selectTab('code', true);
  };

  const onClick = (e: Event): void => {
    const t = e.target;
    if (!isElement(t)) return;
    const btn = t.closest('button');
    if (!btn || !root.contains(btn) || isDisabled(btn)) return;

    const tab = btn.getAttribute('data-tab');
    if (btn.classList.contains('fd-tab')) {
      if (isTabId(tab)) selectTab(tab, false);
      return;
    }
    const goto = btn.getAttribute('data-goto');
    if (isTabId(goto)) {
      const filter = btn.getAttribute('data-goto-filter');
      if (isFilterId(filter) && filter !== ui.activityFilter) {
        ui.activityFilter = filter;
        persist();
        rerender();
      }
      selectTab(goto, true);
      return;
    }
    const filter = btn.getAttribute('data-filter');
    if (btn.classList.contains('fd-chip') && isFilterId(filter)) {
      if (filter !== ui.activityFilter) {
        ui.activityFilter = filter;
        persist();
        rerender();
      }
      return;
    }
    const codeView = btn.getAttribute('data-code-view');
    if (isCodeViewId(codeView)) {
      if (codeView !== ui.codeView) {
        ui.codeView = codeView;
        persist();
        rerender();
      }
      return;
    }
    const edit = btn.getAttribute('data-edit');
    if (edit === 'rename') {
      const id = btn.getAttribute('data-id');
      if (id === null) return;
      sessions.beginRename(id);
      rerender();
      const input = sessions.renameInput();
      focusEl(input);
      input?.select();
      return;
    }
    if (edit === 'cancel') {
      stopRename(sessions.renaming);
      return;
    }
    act(btn);
  };

  const onKeyDown = (e: Event): void => {
    const t = e.target;
    if (!isElement(t) || !('key' in e) || typeof e.key !== 'string') return;

    if (t.classList.contains('fd-tab')) {
      const at = TABS.findIndex((x) => x.id === t.getAttribute('data-tab'));
      if (at < 0) return;
      let next: number;
      switch (e.key) {
        case 'ArrowRight':
          next = (at + 1) % TABS.length;
          break;
        case 'ArrowLeft':
          next = (at - 1 + TABS.length) % TABS.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = TABS.length - 1;
          break;
        default:
          return;
      }
      const target = TABS[next];
      if (!target) return;
      e.preventDefault();
      selectTab(target.id, true);
      return;
    }

    const field = t.getAttribute('data-field');
    if (field === 'sessionTitle' && e.key === 'Enter') {
      e.preventDefault();
      send({ type: 'sessionStart', title: sessions.takeStartTitle() });
      return;
    }
    if (field === 'sessionRename') {
      const id = t.getAttribute('data-id');
      if (e.key === 'Enter' && id !== null) {
        e.preventDefault();
        const title = sessions.renameTitle(id);
        if (title === null) return;
        send({ type: 'sessionRename', id, title });
        stopRename(id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stopRename(id);
      }
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);
  const stopMotionWatch = env.onReducedMotionChange(() => {
    if (!disposed) rerender();
  });

  syncTabs();
  host.postMessage({ type: 'ready' });

  return {
    handleMessage(raw: unknown): void {
      if (disposed) return;
      const msg = parseDashboardHostMessage(raw);
      if (!msg) return;
      const state = msg.state;
      if (state.seq < lastSeq) return;
      lastSeq = state.seq;
      const prev = last;
      last = state;
      // the Code tab opens on Impact whenever the mode becomes Impact (also when the page loads in that mode)
      if (state.settings.mode === 'impact' && prev?.settings.mode !== 'impact' && ui.codeView !== 'impact') {
        ui.codeView = 'impact';
        persist();
      }
      rerender();
      if (prev) for (const text of statusChanges(prev, state)) announce(text);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      stopMotionWatch();
      if (announceTimer !== undefined) env.clearTimeout(announceTimer);
      announceTimer = undefined;
      announceQueue = [];
    },
    get lastSeq(): number {
      return lastSeq;
    },
  };
}
