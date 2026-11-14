// jsdom harness for src/dashboard/app.ts (mountDashboard). Deterministic: a fake AppEnv with a manual timer queue,
// a fake host API that records every message and persisted state, no real clock, no sleeps.
import { JSDOM } from 'jsdom';
import { mountDashboard } from '../../src/dashboard/app';
import type { AppEnv, DashApp, DashHostApi, DashPersisted } from '../../src/dashboard/app';
import type { DashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import type { DashboardState } from '../../src/core/types';
import { hostMessage } from './dashState';

export class FakeDashEnv {
  reduced = false;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  readonly scheduled: Array<{ id: number; ms: number }> = [];
  readonly cleared: number[] = [];
  subscriptions = 0;
  unsubscriptions = 0;

  readonly env: AppEnv = {
    reducedMotion: () => this.reduced,
    onReducedMotionChange: (cb) => {
      this.subscriptions += 1;
      this.listeners.add(cb);
      return () => {
        this.unsubscriptions += 1;
        this.listeners.delete(cb);
      };
    },
    setTimeout: (fn, ms) => {
      const id = this.nextId++;
      this.timers.set(id, { fn, ms });
      this.scheduled.push({ id, ms });
      return id;
    },
    clearTimeout: (id) => {
      this.cleared.push(id);
      this.timers.delete(id);
    },
  };

  /** Flip the reduced-motion preference and notify subscribers (like a matchMedia change event). */
  setReduced(v: boolean): void {
    this.reduced = v;
    for (const l of [...this.listeners]) l();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Run (and remove) every pending timer once, including timers they schedule, at most `max` rounds. */
  runTimers(max = 20): void {
    for (let round = 0; round < max && this.timers.size > 0; round += 1) {
      const pending = [...this.timers.entries()];
      for (const [id, t] of pending) {
        if (!this.timers.has(id)) continue;
        this.timers.delete(id);
        t.fn();
      }
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

export class FakeDashHost {
  readonly messages: DashboardWebviewMessage[] = [];
  readonly stateWrites: DashPersisted[] = [];
  state: DashPersisted | undefined;

  constructor(initial?: DashPersisted) {
    this.state = initial;
  }

  readonly api: DashHostApi = {
    postMessage: (m) => {
      // what leaves the webview must survive structured clone: store the JSON form
      this.messages.push(JSON.parse(JSON.stringify(m)) as DashboardWebviewMessage);
    },
    getState: () => this.state,
    setState: (s) => {
      this.state = { ...s };
      this.stateWrites.push({ ...s });
    },
  };

  of<T extends DashboardWebviewMessage['type']>(type: T): Array<Extract<DashboardWebviewMessage, { type: T }>> {
    return this.messages.filter((m): m is Extract<DashboardWebviewMessage, { type: T }> => m.type === type);
  }

  get last(): DashboardWebviewMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
}

export interface DashHarness {
  dom: JSDOM;
  document: Document;
  root: HTMLElement;
  env: FakeDashEnv;
  host: FakeDashHost;
  app: DashApp;
  /** Deliver a state the way the extension host would (JSON-like plain data). */
  send(state: DashboardState): void;
  /** Deliver anything at all. */
  sendRaw(raw: unknown): void;
  panel(tab: string): HTMLElement;
  tab(tab: string): HTMLButtonElement;
  /** The tab currently selected (aria-selected=true). */
  selectedTab(): string | null;
  q<T extends Element = HTMLElement>(selector: string, within?: ParentNode): T;
  qa<T extends Element = HTMLElement>(selector: string, within?: ParentNode): T[];
  close(): void;
}

export interface MountOptions {
  reduced?: boolean;
  persisted?: unknown;
  html?: string;
}

export function mountDash(opts: MountOptions = {}): DashHarness {
  const dom = new JSDOM(opts.html ?? '<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const root = document.getElementById('app');
  if (!root) throw new Error('test document has no #app');
  const env = new FakeDashEnv();
  env.reduced = opts.reduced === true;
  const host = new FakeDashHost(opts.persisted as DashPersisted | undefined);
  const app = mountDashboard(root, host.api, env.env);

  const must = <T>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new Error(`not found: ${what}`);
    return v;
  };

  return {
    dom,
    document,
    root,
    env,
    host,
    app,
    send: (state) => app.handleMessage(hostMessage(state)),
    sendRaw: (raw) => app.handleMessage(raw),
    panel: (tab) => must(root.querySelector<HTMLElement>(`section.fd-panel[data-panel="${tab}"]`), `panel ${tab}`),
    tab: (tab) => must(root.querySelector<HTMLButtonElement>(`button.fd-tab[data-tab="${tab}"]`), `tab ${tab}`),
    selectedTab: () => root.querySelector('button.fd-tab[aria-selected="true"]')?.getAttribute('data-tab') ?? null,
    q: <T extends Element = HTMLElement>(selector: string, within?: ParentNode): T => must((within ?? root).querySelector<T>(selector), selector),
    qa: <T extends Element = HTMLElement>(selector: string, within?: ParentNode): T[] => [...(within ?? root).querySelectorAll<T>(selector)],
    close: () => {
      try {
        app.dispose();
      } finally {
        dom.window.close();
      }
    },
  };
}

// ----- event helpers ---------------------------------------------------------------------------

export function click(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) throw new Error('detached element');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function key(el: Element, k: string): KeyboardEvent {
  const win = el.ownerDocument.defaultView;
  if (!win) throw new Error('detached element');
  const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

export function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  const win = input.ownerDocument.defaultView;
  if (win) input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

/** Every element in the subtree, root included. */
export function allElements(root: Element): Element[] {
  return [root, ...root.querySelectorAll('*')];
}

/** The text a user reads in an element (textContent, whitespace collapsed). */
export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Rows of the Activity list, by data-id. */
export function activityRows(h: DashHarness): HTMLElement[] {
  return h.qa('li.fd-row', h.panel('activity'));
}

export function rowFor(h: DashHarness, id: string): HTMLElement | undefined {
  return activityRows(h).find((r) => r.getAttribute('data-id') === id);
}

/** Selects a tab by clicking it, the way a user does. */
export function goTo(h: DashHarness, tab: string): void {
  click(h.tab(tab));
}

/** Buttons that send a message of this type, within an element (default: the whole app). */
export function actionButtons(h: DashHarness, action: string, within?: ParentNode): HTMLButtonElement[] {
  return h.qa<HTMLButtonElement>(`button[data-action="${action}"]`, within);
}
