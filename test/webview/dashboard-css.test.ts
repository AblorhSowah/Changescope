// The stylesheet contract of DESIGN-0.3.0 section 11.2: theme variables only, source colours with the documented
// fallbacks, reduced motion, high contrast, focus rings, narrow widths. jsdom has no layout engine, so these are
// assertions about the CSS text and about which classes the real DOM uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { click, goTo, mountDash } from '../support/dashDom';
import { busyState, dashState, row } from '../support/dashState';
import { REPO_ROOT } from '../support/fixtures';

const raw = readFileSync(join(REPO_ROOT, 'media', 'dashboard.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
const lower = css.toLowerCase();

function block(selectorStart: string, from = 0): string {
  const i = css.indexOf(selectorStart, from);
  assert.ok(i >= 0, `no rule starting with ${selectorStart}`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error('unbalanced braces');
}

describe('media/dashboard.css: sources (DESIGN-0.3.0 11.2 table)', () => {
  const chain: Array<[string, string, string]> = [
    ['developer', '--vscode-fileShake-editedForeground', '#3fb950'],
    ['ai-agent', '--vscode-charts-blue', '#3794ff'],
    ['external', '--vscode-charts-yellow', '#cca700'],
    ['git', '--vscode-charts-purple', '#b180d7'],
    ['automated', '--vscode-terminal-ansiCyan', '#29b8db'],
    ['unknown', '--vscode-descriptionForeground', 'GrayText'],
  ];
  for (const [source, variable, fallback] of chain) {
    it(`${source}: var(${variable}, ${fallback})`, () => {
      assert.ok(css.includes(`--fd-src-${source}: var(${variable}, ${fallback});`), `colour chain of ${source}`);
    });
    it(`${source}: a rule sets the accent for [data-source="${source}"] from its colour variable`, () => {
      const re = new RegExp(`\\[data-source="${source}"\\][^{}]*\\{[^{}]*--fd-c: var\\(--fd-src-${source}\\)`);
      assert.match(css, re);
    });
  }

  it('the six sources have six different colour variables', () => {
    const vars = chain.map(([, v]) => v);
    assert.equal(new Set(vars).size, 6);
  });

  it('the icon takes its paint from currentColor / the accent (no presentation attributes), and the hole of the Automated icon needs evenodd', () => {
    assert.match(css, /\.fd-icon \{[^}]*(fill|color): (var\(--fd-c\)|currentColor)/);
    assert.match(css, /fill-rule: evenodd/);
    assert.match(css, /\.fd-icon \.fd-stroke \{/);
  });

  it('level colours exist for low, medium, high and critical', () => {
    for (const lvl of ['low', 'medium', 'high', 'critical']) assert.ok(css.includes(`--fd-lvl-${lvl}: var(--vscode-charts-`), lvl);
    for (const lvl of ['low', 'medium', 'high', 'critical']) assert.match(css, new RegExp(`\\[data-level="${lvl}"\\]`));
  });
});

describe('media/dashboard.css: theme variables, no remote resources', () => {
  it('font family and size come from the theme', () => {
    const body = /(?:^|\})\s*body \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(body, /font-family: var\(--vscode-font-family/);
    assert.match(body, /font-size: var\(--vscode-font-size/);
    assert.match(body, /color: var\(--vscode-foreground/);
  });

  it('no remote URL, no @import, no url() at all, no expression(), no behavior', () => {
    assert.doesNotMatch(lower, /url\(/);
    assert.doesNotMatch(lower, /@import/);
    assert.doesNotMatch(lower, /https?:\/\//);
    assert.doesNotMatch(lower, /expression\(/);
    assert.doesNotMatch(lower, /behavior:/);
  });

  it('every colour literal is a fallback inside a var() (so the theme always wins)', () => {
    // walk the text keeping the stack of open function names; a literal is fine only inside var(...)
    const stack: string[] = [];
    const bad: string[] = [];
    for (let i = 0; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === '(') {
        const name = /([\w-]+)$/.exec(css.slice(Math.max(0, i - 20), i))?.[1] ?? '';
        stack.push(name.toLowerCase());
        if (/^(rgba?|hsla?|hwb|lab|lch)$/.test(name.toLowerCase()) && !stack.slice(0, -1).includes('var')) bad.push(css.slice(i - name.length, i + 24));
      } else if (ch === ')') {
        stack.pop();
      } else if (ch === '#' && /^#[0-9a-fA-F]{3,8}\b/.test(css.slice(i, i + 9)) && !stack.includes('var')) {
        bad.push(css.slice(i, i + 9));
      }
    }
    assert.deepEqual(bad, [], `colour literals outside var(): ${bad.join(' | ')}`);
  });

  it('the only !important rules are the two reduced-motion switches', () => {
    const important = css.match(/[^;{}]*!important/g) ?? [];
    assert.ok(important.length >= 2);
    for (const decl of important) assert.match(decl, /animation: none|transition: none/, decl);
  });
});

describe('media/dashboard.css: motion', () => {
  it('@keyframes fd-shake drives translate and rotate from --fd-amp and --fd-rot', () => {
    const kf = block('@keyframes fd-shake');
    assert.ok((kf.match(/\d+%\s*\{/g) ?? []).length >= 4, 'at least four steps');
    assert.match(kf, /translate\(calc\(var\(--fd-amp\)/);
    assert.match(kf, /rotate\(calc\(var\(--fd-rot\)/);
  });

  it('.fd-row.is-shaking is the only rule that runs the animation, with the row duration', () => {
    assert.match(block('.fd-row.is-shaking {'), /animation: fd-shake var\(--fd-dur\) linear infinite/);
    const uses = css.match(/animation: fd-shake/g) ?? [];
    assert.equal(uses.length, 1);
  });

  it('prefers-reduced-motion: reduce forces animation: none !important and transition: none !important on everything in the app', () => {
    const media = block('@media (prefers-reduced-motion: reduce)');
    assert.match(media, /#app \*/);
    assert.match(media, /animation: none !important/);
    assert.match(media, /transition: none !important/);
  });

  it('#app[data-motion="off"] forces the same, for every descendant', () => {
    const rule = block('#app[data-motion="off"] *,');
    assert.match(rule, /animation: none !important/);
    assert.match(rule, /transition: none !important/);
  });

  it('the shake defaults are neutral (0px, 0deg) so a row without the variables does not move', () => {
    const rule = block('.fd-row {', css.indexOf('--fd-amp: 0px') - 200);
    assert.match(rule, /--fd-amp: 0px/);
    assert.match(rule, /--fd-rot: 0deg/);
  });

  it('the meter (the non-motion intensity cue) is width = --fd-level * 100%', () => {
    assert.match(block('.fd-meter > i {'), /width: calc\(var\(--fd-level\) \* 100%\)/);
  });
});

describe('media/dashboard.css: layout at sidebar widths', () => {
  it('stat cards: 3 per row, 2 per row below 260 px, 6 from 620 px, as container queries on #app', () => {
    assert.match(css, /#app \{[^}]*container-type: inline-size/);
    assert.match(block('.fd-cards {'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(block('@container (max-width: 259px)'), /\.fd-cards \{[^}]*repeat\(2,/);
    assert.match(block('@container (min-width: 620px)'), /repeat\(6,/);
  });

  it('nothing forces horizontal scrolling at 280 px: the app clips overflow and long names can wrap or truncate', () => {
    assert.match(block('#app {'), /overflow-x: hidden/);
    assert.match(css, /min-width: 0/);
    assert.match(css, /text-overflow: ellipsis|overflow-wrap: anywhere|word-break: break-all|overflow-wrap: break-word/);
  });

  it('uses no fixed pixel width wider than a sidebar for containers (no width: NNNpx over 300px)', () => {
    const widths = [...css.matchAll(/[{;] (?:min-)?width: (\d+)px/g)].map((m) => Number(m[1]));
    for (const w of widths) assert.ok(w <= 300, `width ${w}px`);
  });
});

describe('media/dashboard.css: accessibility', () => {
  it('every interactive element the page renders has a focus ring that uses the theme focus colour', () => {
    const focusRules = css.match(/[^{}]*:focus(?:-visible)?[^{}]*\{[^}]*\}/g) ?? [];
    const ringed = (c: string): boolean => focusRules.some((r) => r.includes(`.${c}:focus`) && /outline: 1px solid var\(--fd-focus\)/.test(r));
    const d = mountDash();
    d.send(busyState());
    let checked = 0;
    for (const tab of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
      goTo(d, tab);
      if (tab === 'sessions') click(d.q('ul[data-group="active"] button[data-edit="rename"]'));
      for (const el of d.qa('button, input, summary')) {
        const classes = Array.from(el.classList);
        assert.ok(classes.some(ringed), `<${el.tagName.toLowerCase()} class="${el.className}"> has no focus ring rule`);
        checked += 1;
      }
    }
    d.close();
    assert.ok(checked > 40, `${checked} interactive elements checked`);
    assert.match(css, /--fd-focus: var\(--vscode-focusBorder/);
  });

  it('high-contrast themes (dark and light) get outlines from --vscode-contrastBorder on cards, rows, impact cards, sessions and notices', () => {
    for (const body of ['body.vscode-high-contrast', 'body.vscode-high-contrast-light']) {
      for (const el of ['.fd-card', '.fd-row', '.fd-impact', '.fd-session', '.fd-notice']) assert.ok(css.includes(`${body} ${el}`), `${body} ${el}`);
    }
    assert.match(css, /outline: 1px solid var\(--vscode-contrastBorder, currentColor\)/);
    assert.match(css, /--fd-border: var\(--vscode-contrastBorder, currentColor\)/);
  });

  it('a visually hidden class exists for the live region (the text stays available to screen readers)', () => {
    const sr = block('.fd-sr {');
    assert.match(sr, /position: absolute/);
    assert.match(sr, /width: 1px/);
    assert.match(sr, /overflow: hidden/);
    assert.doesNotMatch(sr, /display: none|visibility: hidden/);
  });

  it('a [hidden] panel really is hidden (no display rule overrides the attribute)', () => {
    assert.match(css, /\[hidden\] \{[^}]*display: none/);
  });

  it('every class the page renders in any tab or mode is either styled or one of the known hook-only classes', () => {
    const used = new Set<string>();
    const collect = (d: ReturnType<typeof mountDash>): void => {
      for (const el of d.root.querySelectorAll('*')) for (const c of Array.from(el.classList)) used.add(c);
    };
    for (const mode of ['live', 'compact', 'impact'] as const) {
      const d = mountDash();
      d.send(busyState({ settings: { mode } }));
      for (const t of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) {
        goTo(d, t);
        collect(d);
      }
      d.send(busyState({ seq: 5, settings: { mode, paused: true }, enabled: false }));
      collect(d);
      d.send(dashState({ seq: 9, git: { state: 'unavailable', detail: 'x' }, files: [row('a.ts', 'src')] }));
      collect(d);
      d.close();
    }
    // classes that are DOM hooks for tests and for state, deliberately without a rule of their own
    const hooks = new Set(['fd-open', 'fd-open-diff', 'fd-repos', 'fd-agents', 'fd-session-start', 'fd-impact-affected', 'fd-live', 'fd-row-method', 'fd-source-label', 'fd-chip-label', 'fd-branch-name', 'fd-tag--status']);
    const iconModifiers = /^fd-icon--/;
    const unstyled = [...used].filter((c) => !css.includes(`.${c}`) && !hooks.has(c) && !iconModifiers.test(c));
    assert.deepEqual(unstyled, [], `classes in the DOM with no CSS rule: ${unstyled.join(' ')}`);
  });
});
