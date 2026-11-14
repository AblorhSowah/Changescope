// Seeded random walk over the dashboard: random valid states, random clicks and keys, random reduced-motion flips,
// stale and junk messages. After every step the DOM must satisfy the contract invariants and nothing may throw.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_TYPES, parseDashboardWebviewMessage } from '../../src/core/dashboard/protocol';
import type { ActivitySourceType, DashFileRow, DashboardState, DetectionMethod, ImpactLevel } from '../../src/core/types';
import { activityRows, click, key, mountDash, type } from '../support/dashDom';
import type { DashHarness } from '../support/dashDom';
import { NOW, change, dashSession, dashState, dep, hostMessage, impact, ref, repo, row, timelineItem } from '../support/dashState';
import { must } from '../support/fixtures';

function rngOf(seed: number): { n(max: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean } {
  let s = seed >>> 0;
  const n = (max: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % max;
  };
  return { n, pick: <T>(xs: readonly T[]): T => xs[n(xs.length)] as T, chance: (p: number) => n(1000) < p * 1000 };
}

const NAMES = ['app.ts', 'index.ts', 'a.py', 'README.md', '<img src=x onerror=alert(1)>.ts', 'données.ts', '日本語.ts', 'x'.repeat(200) + '.ts', 'a b.ts', "it's.ts", 'q"uote.ts', 'ملف.ts', 'emoji😀.ts', '.env', 'Makefile'];
const DIRS = ['', 'src', 'src/core', 'src/core/deep/er', 'test', '<b>dir</b>', 'a/b/c/d/e/f', '日本語/😀'];
const METHODS: DetectionMethod[] = ['focused-editor-edit', 'undo-redo', 'workbench-file-operation', 'workspace-edit', 'disk-write', 'reload-from-disk', 'disk-delete', 'git-state-change', 'agent-signal', 'restored'];
const LEVELS: Array<ImpactLevel | null> = [null, 'low', 'medium', 'high', 'critical'];

function randomState(r: ReturnType<typeof rngOf>, seq: number): DashboardState {
  const count = r.pick([0, 0, 1, 2, 5, 12, 30, 60]);
  const files: DashFileRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const source = r.pick(SOURCE_TYPES) as ActivitySourceType;
    const active = r.chance(0.3);
    const intensity = active ? r.pick([0, 0.05, 0.5, 1]) : r.pick([0, 0.4]);
    files.push(
      row(`${r.pick(NAMES)}`, r.pick(DIRS), {
        source,
        sourceId: source === 'ai-agent' && r.chance(0.8) ? r.pick(['claude-code', 'copilot', '<b>agent</b>']) : null,
        method: r.pick(METHODS),
        confidence: r.pick([0, 0.2, 0.5, 0.95, 1]),
        lastEventType: r.pick(['create', 'modify', 'delete'] as const),
        changes: r.pick([0, 1, 2, 7, 1234, 1_000_000]),
        ago: r.pick([-30, 0, 1, 4, 5, 59, 60, 3599, 3600, 86_399, 86_400, 9_999_999]),
        phase: active ? 'active' : 'idle',
        intensity,
        shake: { amp: r.pick([0, 0.5, 2.25, 4]), dur: r.pick([60, 110, 160]), rot: r.pick([0, 0.2, 1.2]) },
        sessionTitle: r.chance(0.3) ? 'Some session' : null,
        review: source === 'developer' ? null : r.pick(['reviewed', 'unreviewed', null] as const),
        exists: r.chance(0.85),
        impactLevel: r.pick(LEVELS),
        dependants: r.chance(0.5) ? r.n(40) : null,
      }),
    );
  }
  // sometimes repeat a row to exercise duplicate ids
  if (files.length > 2 && r.chance(0.1)) files.push(must(files[0]));
  const mode = r.pick(['live', 'compact', 'impact'] as const);
  const sessionsActive = r.chance(0.4) ? dashSession('s-act', r.pick(['Refactor', '<i>x</i>', 'x'.repeat(120)]), { branch: r.chance(0.5) ? 'main' : null, bySource: r.chance(0.5) ? { developer: 3, git: 1 } : {} }) : null;
  const previous = Array.from({ length: r.pick([0, 0, 1, 3]) }, (_, i) => dashSession(`s-prev-${i}`, `Old ${i}`, { status: 'completed', endedAt: NOW - i * 1000, activityCount: r.n(50), fileCount: r.n(9) }));
  const gitState = r.pick(['ready', 'ready', 'ready', 'loading', 'unavailable', 'disabled'] as const);
  const sel = files.length > 0 && r.chance(0.5) ? must(files[r.n(files.length)]) : null;
  const indexState = r.pick(['off', 'idle', 'indexing', 'ready'] as const);
  return dashState({
    seq,
    now: NOW + r.pick([0, 1000, 60_000, 86_400_000]),
    enabled: r.chance(0.85),
    settings: { mode, animate: r.chance(0.8), paused: r.chance(0.2), dependencyIndex: indexState !== 'off', gitEnabled: gitState !== 'disabled', aiMode: r.pick(['local', 'assisted'] as const), aiProvider: r.chance(0.3) ? 'acme.llm' : null, animationIntensity: r.pick([0.25, 1, 2]) },
    files,
    timeline: files.slice(0, r.pick([0, 3, 100])).map((f, i) => timelineItem(f.name, f.dir, { id: `t${i}-${r.n(1000)}`, source: f.source, sourceId: f.sourceId, eventType: f.lastEventType, count: r.n(30), ago: r.n(100_000) })),
    agents: r.chance(0.7) ? [{ id: 'api', label: 'Extension API', state: r.pick(['listening', 'off', 'unavailable'] as const), detail: r.pick(['', 'Reports from other extensions.']) }] : [],
    git: {
      state: gitState,
      detail: r.pick(['', 'the built-in Git extension is disabled in this window.']),
      repos: gitState === 'ready' && r.chance(0.7) ? [repo('proj', { ahead: r.n(4), behind: r.n(3), branch: r.chance(0.8) ? 'main' : null, commit: r.chance(0.8) ? 'abc1234' : null, staged: files.slice(0, 2).map((f) => change(f.name, f.dir)), unstaged: files.slice(2, 5).map((f) => change(f.name, f.dir, r.pick(['modified', 'deleted', 'renamed', 'conflicted', 'other'] as const))), untracked: files.slice(5, 7).map((f) => change(f.name, f.dir, 'untracked')), truncated: r.chance(0.2) })] : [],
    },
    sessions: { active: sessionsActive, previous },
    selection: sel
      ? { file: ref(sel.name, sel.dir), imports: files.slice(0, 3).map((f) => dep(f.name, f.dir, { count: r.n(5) })), importedBy: files.slice(3, 6).map((f) => dep(f.name, f.dir, { isTest: r.chance(0.3), relationship: r.pick(['import', 'export', 'reference', 'inheritance', 'unknown'] as const) })), impact: r.chance(0.6) ? impact(sel.name, sel.dir, { level: must(LEVELS[1 + r.n(4)]), complete: r.chance(0.7) }) : null }
      : { file: null, imports: [], importedBy: [], impact: null },
    impacts: files.slice(0, r.pick([0, 2, 6])).map((f) => impact(f.name, f.dir, { level: must(LEVELS[1 + r.n(4)]), reasons: r.chance(0.5) ? [] : ['A reason.', 'Another one.'] })),
    index: { state: indexState, indexed: r.n(2000), total: r.n(2000) + 1, truncated: r.chance(0.2) },
    summary: r.chance(0.4) ? { text: 'A summary.', provider: r.pick(['local', 'acme.llm']), at: NOW - r.n(100_000) } : null,
  });
}

/** Every id the host could legitimately be asked about, from one state. */
function knownIds(s: DashboardState): Set<string> {
  const ids = new Set<string>();
  for (const f of s.files) ids.add(f.id);
  for (const t of s.timeline) ids.add(t.fileId);
  for (const rp of s.git.repos) for (const c of [...rp.staged, ...rp.unstaged, ...rp.untracked]) ids.add(c.id);
  for (const d of [...s.selection.imports, ...s.selection.importedBy]) ids.add(d.id);
  if (s.selection.file) ids.add(s.selection.file.id);
  for (const i of [...s.impacts, ...(s.selection.impact ? [s.selection.impact] : [])]) {
    ids.add(i.file.id);
    for (const a of [...i.affected, ...i.tests, ...i.configs]) ids.add(a.id);
  }
  if (s.sessions.active) ids.add(s.sessions.active.id);
  for (const p of s.sessions.previous) ids.add(p.id);
  return ids;
}

function matches(f: DashFileRow, filter: string): boolean {
  switch (filter) {
    case 'live':
      return f.phase === 'active';
    case 'mine':
      return f.source === 'developer';
    case 'ai':
      return f.source === 'ai-agent';
    case 'external':
      return f.source !== 'developer' && f.source !== 'ai-agent';
    default:
      return true;
  }
}

function checkInvariants(d: DashHarness, s: DashboardState, step: string): void {
  // tabs and panels
  assert.equal(d.qa('button.fd-tab[aria-selected="true"]').length, 1, `${step}: one selected tab`);
  assert.equal(d.qa('button.fd-tab[tabindex="0"]').length, 1, `${step}: one tab in the tab order`);
  assert.equal(d.qa('section.fd-panel:not([hidden])').length, 1, `${step}: one visible panel`);
  assert.equal(d.q('section.fd-panel:not([hidden])').getAttribute('data-panel'), d.selectedTab(), `${step}: panel follows tab`);
  assert.equal(d.root.getAttribute('data-tab'), d.selectedTab());
  assert.equal(d.root.getAttribute('data-mode'), s.settings.mode);
  assert.equal(d.root.getAttribute('data-enabled'), String(s.enabled));
  assert.equal(d.root.getAttribute('data-paused'), String(s.settings.paused));

  // activity rows
  const filter = d.q('ul.fd-list', d.panel('activity')).getAttribute('data-filter') ?? 'all';
  const seen = new Set<string>();
  const wantIds: string[] = [];
  for (const f of s.files) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (matches(f, filter)) wantIds.push(f.id);
  }
  const rows = activityRows(d);
  assert.deepEqual(
    rows.map((r) => r.getAttribute('data-id')),
    wantIds,
    `${step}: rows are the filtered files, first duplicate wins, in host order`,
  );

  // motion rule
  const reduced = d.env.reduced;
  const motion = s.settings.animate && s.settings.mode !== 'compact' && !reduced;
  assert.equal(d.root.getAttribute('data-motion'), motion ? 'on' : 'off', `${step}: data-motion`);
  const byId = new Map<string, DashFileRow>();
  for (const f of s.files) if (!byId.has(f.id)) byId.set(f.id, f);
  for (const li of rows) {
    const f = must(byId.get(must(li.getAttribute('data-id'))));
    const mayShake = motion && s.settings.mode === 'live' && s.enabled && f.phase === 'active' && f.intensity > 0;
    assert.equal(li.classList.contains('is-shaking'), mayShake, `${step}: is-shaking on ${f.name}`);
    assert.equal(li.getAttribute('data-source'), f.source);
    assert.ok((li.getAttribute('aria-label') ?? '').length > 0, `${step}: row has an accessible name`);
    assert.ok(d.qa('.fd-source-label', li).length === 1 && d.qa('svg', li).length >= 1, `${step}: source shown as icon + label`);
    if (s.settings.mode === 'compact') assert.equal(d.qa('.fd-meter', li).length, 0, `${step}: compact has no meter`);
  }
  assert.equal(d.qa('.is-shaking').length, rows.filter((li) => li.classList.contains('is-shaking')).length, `${step}: nothing outside the list shakes`);

  // nothing in the text may be a formatting accident
  for (const bad of ['NaN', 'undefined', '[object Object]', 'Infinity', 'null']) {
    const text = d.root.textContent ?? '';
    // file names in the pool never contain these words
    assert.ok(!text.includes(bad), `${step}: the page text contains "${bad}"`);
  }

  // every id a button can send is an id of the state (or a session id), never anything else
  const ids = knownIds(s);
  for (const b of d.qa<HTMLButtonElement>('button[data-id]')) {
    const id = must(b.getAttribute('data-id'));
    assert.ok(ids.has(id), `${step}: button ${b.getAttribute('data-action') ?? b.getAttribute('data-edit')} names an id that is not in the state: ${id}`);
  }
  // every control has a name
  for (const b of d.qa<HTMLButtonElement>('button')) assert.ok((b.textContent ?? '').trim() !== '' || (b.getAttribute('aria-label') ?? '') !== '', `${step}: unnamed button ${b.className}`);
  // one live region, no loading notice after the first state
  assert.equal(d.qa('[aria-live="polite"]').length, 1);
  assert.equal(d.qa('.fd-notice[data-kind="loading"]').length, 0);
}

describe('dashboard: random walk keeps every invariant (8 seeds x 160 steps)', () => {
  for (let seed = 1; seed <= 8; seed += 1) {
    it(`seed ${seed}`, () => {
      const r = rngOf(seed * 7919);
      const d = mountDash({ reduced: r.chance(0.2) });
      let seq = 0;
      let current: DashboardState = randomState(r, ++seq);
      d.send(current);
      checkInvariants(d, current, 'first state');
      for (let step = 1; step <= 160; step += 1) {
        const label = `seed ${seed} step ${step}`;
        const action = r.n(12);
        const before = d.host.messages.length;
        const wasInside = d.root.contains(d.document.activeElement) && d.document.activeElement !== d.root;
        if (action <= 3) {
          current = randomState(r, ++seq);
          d.send(current);
        } else if (action === 4) {
          const buttons = d.qa<HTMLButtonElement>('button:not([disabled])');
          if (buttons.length > 0) {
            const b = r.pick(buttons);
            // typing into a rename field is done by tests above; here every button is simply clicked
            if (b.getAttribute('data-action') === 'sessionRename') type(d.q<HTMLInputElement>('input[data-field="sessionRename"]'), 'fuzz');
            click(b);
          }
        } else if (action === 5) {
          click(d.tab(r.pick(['overview', 'activity', 'code', 'git', 'sessions', 'settings'])));
        } else if (action === 6) {
          const tabs = d.qa<HTMLButtonElement>('button.fd-tab');
          key(r.pick(tabs), r.pick(['ArrowRight', 'ArrowLeft', 'Home', 'End', 'x']));
        } else if (action === 7) {
          d.env.setReduced(r.chance(0.5));
        } else if (action === 8) {
          // a stale message
          d.send(randomState(r, Math.max(-5, seq - 1 - r.n(5))));
        } else if (action === 9) {
          d.sendRaw(r.pick([null, 5, 'x', {}, { type: 'state' }, { type: 'state', state: { v: 1 } }, hostMessage({ ...current, seq: seq + 1, now: Number.NaN })]));
        } else if (action === 10) {
          const chips = d.qa<HTMLButtonElement>('button.fd-chip');
          if (chips.length > 0) click(r.pick(chips));
        } else {
          for (const input of d.qa<HTMLInputElement>('input')) type(input, r.pick(['', '  ', 'title', '\u0000x', 'y'.repeat(300)]));
        }
        checkInvariants(d, current, label);
        // everything sent is valid for the host and names only ids of the current state
        for (const m of d.host.messages.slice(before)) {
          assert.deepEqual(parseDashboardWebviewMessage(m), m, `${label}: invalid message ${JSON.stringify(m)}`);
          if ('id' in m) assert.ok(knownIds(current).has(m.id), `${label}: ${m.type} names an unknown id ${m.id}`);
        }
        if (wasInside && d.root.querySelector('button:not([disabled])') !== null) {
          assert.ok(d.root.contains(d.document.activeElement), `${label}: focus left the dashboard`);
        }
      }
      assert.equal(d.env.pending <= 1, true, 'at most the single announcement timer is pending');
      d.close();
    });
  }
});
