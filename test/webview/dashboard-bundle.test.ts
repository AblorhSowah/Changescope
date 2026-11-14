// Executes the REAL shipped browser bundle (dist/dashboard.js, built by `node esbuild.mjs`) inside jsdom, in the page
// that buildWebviewHtml produces, with a stubbed acquireVsCodeApi. This covers src/dashboard/main.ts, which the
// app-level tests cannot reach, and proves the esbuild IIFE has no stray Node or vscode dependency.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildWebviewHtml } from '../../src/core/webviewHtml';
import { parseDashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import { REPO_ROOT, must } from '../support/fixtures';
import { busyState, dashState, row } from '../support/dashState';

const bundlePath = join(REPO_ROOT, 'dist', 'dashboard.js');
const haveBundle = existsSync(bundlePath);
const skipReason = 'dist/dashboard.js is missing: run `node esbuild.mjs` (npm run build) first';

/** Objects built inside the jsdom window live in another realm; compare their JSON form with strict deepEqual. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

interface Page {
  dom: JSDOM;
  posted: unknown[];
  stateWrites: unknown[];
  send(state: unknown): void;
  sendRaw(data: unknown): void;
  root(): HTMLElement;
}

let current: Page | undefined;
afterEach(() => {
  current?.dom.window.close();
  current = undefined;
});

function load(initialState?: unknown, opts: { matchMedia?: (q: string) => { matches: boolean } } = {}): Page {
  const html = buildWebviewHtml({
    cspSource: 'vscode-webview-resource:',
    nonce: 'n'.repeat(32),
    scriptUri: 'vscode-resource:/dist/dashboard.js',
    styleUri: 'vscode-resource:/media/dashboard.css',
    title: 'File Shake',
  });
  // Scripts from the document are not fetched (resources: undefined); the bundle is evaluated by hand below.
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const posted: unknown[] = [];
  const stateWrites: unknown[] = [];
  let state: unknown = initialState;
  Object.defineProperty(dom.window, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      postMessage: (m: unknown) => {
        posted.push(m);
      },
      getState: () => state,
      setState: (s: unknown) => {
        state = s;
        stateWrites.push(s);
      },
    }),
  });
  if (opts.matchMedia) {
    const mm = opts.matchMedia;
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({ matches: mm(q).matches, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
  }
  dom.window.eval(readFileSync(bundlePath, 'utf8'));
  const page: Page = {
    dom,
    posted,
    stateWrites,
    send: (s) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: JSON.parse(JSON.stringify({ type: 'state', state: s })) }));
    },
    sendRaw: (data) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    },
    root: () => must(dom.window.document.getElementById('app')) as HTMLElement,
  };
  current = page;
  return page;
}

describe('dist/dashboard.js executed in a page built by buildWebviewHtml', () => {
  it('the bundle exists, is a single self-contained script of sane size, with nothing Node-only in it', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const text = readFileSync(bundlePath, 'utf8');
    assert.ok(statSync(bundlePath).size < 150_000, `bundle is ${statSync(bundlePath).size} bytes`);
    for (const re of [/\brequire\(/, /\bimport\s*\(/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /importScripts/, /\beval\s*\(/, /new Function\(/, /\binnerHTML\b/, /https?:\/\/(?!www\.w3\.org)/]) {
      assert.ok(!re.test(text), `bundle must not contain ${re}`);
    }
    assert.ok(!/require\("vscode"\)|from "vscode"|from 'vscode'/.test(text));
    assert.ok(!/picomatch|jsonc-parser/.test(text), 'node-only libraries must not leak into the browser bundle');
    assert.ok(!/\bprocess\.(env|platform|cwd)\b|\b__dirname\b|\bBuffer\./.test(text), 'no Node globals');
  });

  it('boots, posts {type:"ready"} exactly once, and shows the loading state', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    assert.deepEqual(plain(p.posted), [{ type: 'ready' }]);
    assert.equal(p.root().getAttribute('data-state'), 'loading');
    assert.ok(['on', 'off'].includes(p.root().getAttribute('data-motion') ?? ''));
    assert.equal(p.root().querySelectorAll('button.fd-tab').length, 6);
  });

  it('renders a state received through a window message event, with the documented CSS variables and DOM contract', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(dashState({ files: [row('a.ts', 'src/core', { phase: 'active', intensity: 0.5, shake: { amp: 2.25, dur: 110, rot: 0.7 } })] }));
    assert.equal(p.root().getAttribute('data-state'), 'ready');
    const li = must(p.root().querySelector<HTMLElement>('li.fd-row'));
    assert.equal(li.getAttribute('data-id'), '/ws/proj/src/core/a.ts');
    assert.equal(li.getAttribute('data-source'), 'developer');
    assert.equal(li.style.getPropertyValue('--fd-amp'), '2.25px');
    assert.equal(li.style.getPropertyValue('--fd-dur'), '110ms');
    assert.equal(li.style.getPropertyValue('--fd-rot'), '0.7deg');
    assert.ok(li.classList.contains('is-shaking'));
    assert.equal(p.root().querySelectorAll('button.fd-card').length, 6);
  });

  it('a full busy state renders every tab without throwing, and posts nothing by itself', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(busyState());
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      must(p.root().querySelector(`button.fd-tab[data-tab="${tab}"]`)).dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
      assert.equal(p.root().getAttribute('data-tab'), tab);
    }
    assert.deepEqual(plain(p.posted), [{ type: 'ready' }]);
  });

  it('a click on a row posts {type:"open", id}; the Review button posts markReviewed', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(dashState({ files: [row('a.ts', 'src', { source: 'external', review: 'unreviewed' })] }));
    const open = must(p.root().querySelector('li.fd-row button.fd-open'));
    open.dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(plain(p.posted.slice(-1)), [{ type: 'open', id: '/ws/proj/src/a.ts' }]);
    must(p.root().querySelector('li.fd-row button[data-action="markReviewed"]')).dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(plain(p.posted.slice(-1)), [{ type: 'markReviewed', id: '/ws/proj/src/a.ts' }]);
  });

  it('switching tab persists {tab, activityFilter, codeView} through vscode.setState', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(dashState());
    must(p.root().querySelector('button.fd-tab[data-tab="git"]')).dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(plain(p.stateWrites.slice(-1)), [{ tab: 'git', activityFilter: 'all', codeView: 'dependencies' }]);
  });

  it('restores the tab from vscode.getState and ignores junk state', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    for (const junk of [undefined, null, 42, 'x', [], { tab: 'nope' }, { tab: 5, activityFilter: [], codeView: {} }, { other: true }]) {
      const p = load(junk);
      p.send(dashState());
      assert.equal(p.root().getAttribute('data-tab'), 'overview', JSON.stringify(junk));
      p.dom.window.close();
    }
    const p = load({ tab: 'sessions', activityFilter: 'ai', codeView: 'impact' });
    p.send(dashState());
    assert.equal(p.root().getAttribute('data-tab'), 'sessions');
  });

  it('ignores malformed window messages (other extensions, devtools, garbage)', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(dashState({ seq: 1, files: [row('a.ts', 'src')] }));
    const html = p.root().innerHTML;
    for (const data of [null, undefined, 'hello', 7, [], {}, { type: 'state' }, { type: 'state', state: { v: 9 } }, { type: 'snapshot', snapshot: {} }, { command: 'x' }]) {
      p.sendRaw(data);
    }
    assert.equal(p.root().innerHTML, html);
  });

  it('ignores a stale state (lower seq) end to end', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(dashState({ seq: 4, files: [row('keep.ts', 'src')] }));
    p.send(dashState({ seq: 2, files: [row('stale.ts', 'src')] }));
    const ids = [...p.root().querySelectorAll('li.fd-row')].map((l) => l.getAttribute('data-id'));
    assert.deepEqual(ids, ['/ws/proj/src/keep.ts']);
  });

  it('honours prefers-reduced-motion from matchMedia: data-motion=off and no shaking row', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load(undefined, { matchMedia: (q) => ({ matches: q.includes('prefers-reduced-motion') }) });
    assert.equal(p.root().getAttribute('data-motion'), 'off');
    p.send(dashState({ files: [row('a.ts', 'src', { phase: 'active', intensity: 0.9 })] }));
    assert.equal(p.root().querySelectorAll('.is-shaking').length, 0);
    assert.equal(p.root().getAttribute('data-motion'), 'off');
  });

  it('forwards uncaught page errors and unhandled rejections to the host as {type:"error"} with bounded text', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.dom.window.dispatchEvent(new p.dom.window.ErrorEvent('error', { message: 'boom '.repeat(300) }));
    const last = plain(p.posted.slice(-1)) as Array<{ type: string; message: string }>;
    assert.equal(last[0]?.type, 'error');
    assert.match(last[0]?.message ?? '', /^boom/);
    const accepted = parseDashboardWebviewMessage(last[0]);
    assert.equal(accepted?.type, 'error');
    assert.equal((accepted as { message: string }).message.length, 500, 'the host validator is what bounds the text');
  });

  it('a hostile file name is text in the shipped bundle too', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    const evil = '<img src=x onerror=alert(1)>.ts';
    p.send(dashState({ files: [row(evil, 'src', { source: 'external', review: 'unreviewed' })] }));
    assert.equal(p.root().querySelectorAll('img, script').length, 0);
    assert.equal(must(p.root().querySelector('li.fd-row button.fd-open')).textContent, evil);
  });

  it('the page built by buildWebviewHtml has a strict CSP and no inline script, style or handler', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    const doc = p.dom.window.document;
    const csp = must(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).getAttribute('content') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-n{32}'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(doc.querySelectorAll('script:not([src])').length, 0);
    assert.equal(doc.querySelectorAll('style').length, 0);
    for (const el of doc.querySelectorAll('*')) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), a);
  });
});
