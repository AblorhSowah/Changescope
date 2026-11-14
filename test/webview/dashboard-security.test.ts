import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDashboard } from '../../src/dashboard/app';
import { allElements, click, goTo, mountDash, rowFor, textOf } from '../support/dashDom';
import type { DashHarness } from '../support/dashDom';
import { FakeDashEnv, FakeDashHost } from '../support/dashDom';
import { activeRow, change, dashSession, dashState, dep, hostMessage, impact, ref, repo, row, timelineItem } from '../support/dashState';
import { must } from '../support/fixtures';

let h: DashHarness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const HOSTILE = [
  '<img src=x onerror=alert(1)>.ts',
  '"><script>alert(1)</script>',
  "' onmouseover='alert(1)",
  '</li></ul><li class="fd-row" data-id="evil">injected',
  '<svg/onload=alert(1)>',
  '&lt;b&gt;already escaped&lt;/b&gt;',
  '`${alert(1)}`',
  '‮evil.ts',
  '日本語/😀/ملف.ts',
  'a\\b\'c"d',
  '<style>*{display:none}</style>',
  'javascript:alert(1)',
  '[data-id="x"], *',
  ']"] , body',
  'שלום עולם.ts',
  '👨‍👩‍👧‍👦 family.ts',
  'a\u0000b.ts',
  'x'.repeat(2000),
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<form action="http://evil"><input name=x></form>',
  '--fd-amp: 9999px; background: url(http://evil)',
  'expression(alert(1))',
];

const ALLOWED_TAGS = new Set(['DIV', 'SPAN', 'UL', 'LI', 'BUTTON', 'INPUT', 'NAV', 'SECTION', 'H2', 'H3', 'P', 'LABEL', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'I', 'SVG', 'CIRCLE', 'RECT', 'PATH']);
const FORBIDDEN_ATTRS = new Set(['src', 'href', 'srcdoc', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'background', 'ping', 'srcset']);

/** Nothing the app renders may be interpreted: no unexpected element, no handler, no navigation, no free style. */
function assertInert(root: HTMLElement): void {
  for (const el of allElements(root)) {
    if (el === root) continue;
    assert.ok(ALLOWED_TAGS.has(el.tagName.toUpperCase()), `unexpected element <${el.tagName.toLowerCase()}> was created`);
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr), `inline event handler attribute ${attr}`);
      assert.ok(!FORBIDDEN_ATTRS.has(attr.toLowerCase()), `navigational attribute ${attr}`);
      if (attr === 'style') {
        // the CSSOM (style.setProperty) serialises into the attribute; only the four shake variables may appear
        const decls = (el.getAttribute('style') ?? '').split(';').map((d) => d.trim()).filter((d) => d !== '');
        for (const d of decls) assert.match(d, /^--fd-(amp|dur|rot|level): -?[\d.]+(px|ms|deg)?$/, `style attribute content: ${d}`);
      }
    }
  }
  assert.equal(root.querySelectorAll('img, script, iframe, style, link, object, embed, audio, video, a, form, textarea, select, canvas, base, meta').length, 0);
}

function hostileState(evil: string, seq = 1): ReturnType<typeof dashState> {
  const f = row(evil, evil, { source: 'ai-agent', sourceId: evil, method: 'agent-signal', sessionTitle: evil, review: 'unreviewed', impactLevel: 'high', dependants: 3 });
  const live = activeRow(`${evil}-live`, evil, { sessionTitle: evil });
  return dashState({
    seq,
    files: [f, live, row('plain.ts', 'src')],
    timeline: [timelineItem(evil, evil, { id: 'x1', sourceId: evil, sessionTitle: evil }), timelineItem('plain.ts', 'src', { id: 'x2' })],
    agents: [{ id: evil, label: evil, state: 'listening', detail: evil }],
    git: { state: 'ready', detail: evil, repos: [{ ...repo(evil, { branch: evil, commit: evil, staged: [change(evil, evil)], unstaged: [change(evil, evil, 'deleted')], untracked: [change(evil, evil, 'untracked')] }), id: evil }] },
    sessions: { active: dashSession('s1', evil, { branch: evil }), previous: [dashSession('s2', evil, { status: 'completed', endedAt: 5, branch: evil })] },
    selection: { file: ref(evil, evil), imports: [dep(evil, evil)], importedBy: [dep(evil, evil, { isTest: true })], impact: impact(evil, evil, { reasons: [evil], tests: [ref(evil, evil)], configs: [ref(evil, evil)], affected: [ref(evil, evil)] }) },
    impacts: [impact(`${evil}-2`, evil, { reasons: [evil, evil] })],
    index: { state: 'ready', indexed: 3, total: 3 },
    summary: { text: evil, provider: evil, at: 1 },
    settings: { aiMode: 'assisted', aiProvider: evil },
  });
}

describe('dashboard: hostile names render as text only, in every tab and every mode', () => {
  for (const evil of HOSTILE) {
    it(`${JSON.stringify(evil).slice(0, 60)}`, () => {
      for (const mode of ['live', 'compact', 'impact'] as const) {
        const d = mountDash();
        const s = hostileState(evil);
        s.settings.mode = mode;
        d.send(s);
        for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
          goTo(d, tab);
          assertInert(d.root);
        }
        // the name round-trips as text, and no row was injected through markup
        goTo(d, 'activity');
        const rows = d.qa('li.fd-row');
        assert.equal(rows.length, 3, `${mode}: no extra rows`);
        const first = must(rows.find((r) => r.getAttribute('data-id') === s.files[0]?.id));
        assert.equal(d.q('button.fd-open', first).textContent, evil, 'the name is the text of the button');
        assert.equal(d.q('.fd-dir', first).textContent, evil);
        assert.equal(d.q('button.fd-open', first).getAttribute('data-id'), s.files[0]?.id);
        assert.equal(d.root.querySelectorAll('[data-id="evil"]').length, 0, 'no element carries an id from injected markup');
        d.close();
      }
    });
  }

  it('hostile text never reaches an interpreted attribute: aria-label and title are data, and no on* attribute ever exists', () => {
    const d = mountDash();
    for (const evil of HOSTILE) d.send(hostileState(evil, HOSTILE.indexOf(evil) + 1));
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      for (const el of allElements(d.root)) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), `${a} on <${el.tagName}>`);
    }
    d.close();
  });

  it('every hostile string appears verbatim as the text of the right element (names, dirs, titles, reasons, summary, branch)', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const d = mountDash();
    d.send(hostileState(evil));
    const text = (selector: string, tab: string): string[] => {
      goTo(d, tab);
      return d.qa(selector, d.panel(tab)).map((e) => e.textContent ?? '');
    };
    assert.ok(text('.fd-open', 'activity').includes(evil));
    assert.ok(text('.fd-tl .fd-open', 'overview').includes(evil));
    assert.ok(text('.fd-summary-text', 'overview').includes(evil));
    assert.ok(text('.fd-branch-name', 'git').includes(evil));
    assert.ok(text('.fd-repo-name', 'git').includes(evil));
    assert.ok(text('.fd-session-title', 'sessions').includes(evil));
    goTo(d, 'code');
    click(d.q('.fd-seg-btn[data-code-view="impact"]', d.panel('code')));
    assert.ok(text('.fd-reasons li', 'code').includes(evil));
    goTo(d, 'activity');
    click(d.q('button.fd-chip[data-filter="ai"]'));
    assert.ok(text('.fd-adapter-label', 'activity').includes(evil));
    d.close();
  });

  it('a hostile name in aria-label keeps the label a single attribute value (round trip through getAttribute)', () => {
    const evil = '" onclick="alert(1)" x="';
    const d = mountDash();
    d.send(dashState({ files: [row(evil, 'src', { source: 'external', review: 'unreviewed' })] }));
    const li = must(rowFor(d, `/ws/proj/src/${evil}`));
    assert.ok(must(li.getAttribute('aria-label')).startsWith(`${evil}, External`));
    assert.equal(li.getAttribute('onclick'), null);
    assert.equal(d.q('button[data-action="markReviewed"]', li).getAttribute('aria-label'), `Mark ${evil} reviewed`);
    d.close();
  });

  it('a hostile session title typed by the user is cleaned and still only text when it comes back', () => {
    const d = mountDash();
    d.send(dashState({ sessions: { active: dashSession('s1', '<img src=x onerror=alert(1)>') } }));
    goTo(d, 'sessions');
    assert.equal(textOf(d.q('.fd-session-title')), '<img src=x onerror=alert(1)>');
    assertInert(d.root);
    d.close();
  });
});

describe('dashboard: the page cannot be made to run code or leak through the DOM', () => {
  it('never assigns innerHTML / outerHTML, never calls insertAdjacentHTML / document.write, never sets a style attribute, never evals (runtime spy over a full session of use)', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
    const win = dom.window as unknown as Window & typeof globalThis;
    const sinks: string[] = [];
    const proto = win.Element.prototype;
    for (const prop of ['innerHTML', 'outerHTML'] as const) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(proto, prop, {
          ...desc,
          set(this: Element, v: string) {
            sinks.push(`${prop}=${String(v).slice(0, 40)}`);
            orig.call(this, v);
          },
        });
      }
    }
    const origInsert = proto.insertAdjacentHTML;
    proto.insertAdjacentHTML = function (this: Element, ...args: Parameters<Element['insertAdjacentHTML']>) {
      sinks.push('insertAdjacentHTML');
      return origInsert.apply(this, args);
    };
    const origSetAttr = proto.setAttribute;
    proto.setAttribute = function (this: Element, name: string, value: string) {
      if (name.toLowerCase() === 'style') sinks.push(`setAttribute(style,${value.slice(0, 30)})`);
      if (/^on/i.test(name)) sinks.push(`setAttribute(${name})`);
      return origSetAttr.call(this, name, value);
    };
    const origWrite = win.document.write.bind(win.document);
    win.document.write = (...args: string[]) => {
      sinks.push('document.write');
      origWrite(...args);
    };
    (win as unknown as { eval: unknown }).eval = () => {
      sinks.push('eval');
    };
    const env = new FakeDashEnv();
    const host = new FakeDashHost();
    const root = must(win.document.getElementById('app'));
    const app = mountDashboard(root, host.api, env.env);
    for (let i = 1; i <= HOSTILE.length; i += 1) app.handleMessage(hostMessage(hostileState(must(HOSTILE[i - 1]), i)));
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) click(must(root.querySelector(`button.fd-tab[data-tab="${tab}"]`)));
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) if (!b.disabled) click(b);
    env.runTimers();
    app.dispose();
    dom.window.close();
    assert.deepEqual(sinks, []);
  });

  it('the only attribute that ever carries data from the host is data-id (and its siblings); ids are never used to build selectors or markup', () => {
    // an id that would break out of a CSS attribute selector must not break the app's lookups
    const evil = '"] , body [data-x="';
    const d = mountDash();
    d.send(dashState({ seq: 1, files: [row(evil, 'src', { source: 'external', review: 'unreviewed' })], git: { state: 'ready', repos: [repo('r', { unstaged: [change(evil, 'src')] })] } }));
    goTo(d, 'activity');
    const btn = d.q<HTMLButtonElement>('button[data-action="markReviewed"]');
    assert.doesNotThrow(() => click(btn));
    assert.deepEqual(d.host.last, { type: 'markReviewed', id: `/ws/proj/src/${evil}` });
    assert.doesNotThrow(() => d.send(dashState({ seq: 2, files: [], git: { state: 'ready', repos: [] } })));
    d.close();
  });

  it('a message cannot carry HTML into the page through a field that is not rendered as text (nothing is rendered as markup)', () => {
    const d = mountDash();
    const s = hostileState('<b>bold</b>');
    d.send(s);
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      assert.equal(d.panel(tab).querySelectorAll('b, strong, em, i:not(.fd-meter > i):not(.fd-level-bars > i):not(.fd-switch-track > i)').length, 0, tab);
    }
    d.close();
  });
});
