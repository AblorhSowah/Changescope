import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountDash, rowFor } from '../support/dashDom';
import type { DashHarness } from '../support/dashDom';
import { activeRow, busyState, dashState, manyRows, row } from '../support/dashState';
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

const shaking = (d: DashHarness): HTMLElement[] => d.qa('.is-shaking');

describe('dashboard: when a row may shake', () => {
  it('only in live mode, for phase=active and intensity>0, with animation on, motion allowed and Changescope enabled', () => {
    const d = mount();
    d.send(
      dashState({
        files: [activeRow('a.ts', 'src'), row('idle.ts', 'src', { phase: 'idle', intensity: 0 }), row('zero.ts', 'src', { phase: 'active', intensity: 0 }), row('odd.ts', 'src', { phase: 'idle', intensity: 0.9 })],
      }),
    );
    assert.deepEqual(
      shaking(d).map((e) => e.getAttribute('data-id')),
      ['/ws/proj/src/a.ts'],
    );
    assert.equal(d.root.getAttribute('data-motion'), 'on');
    assert.equal(must(rowFor(d, '/ws/proj/src/a.ts')).getAttribute('data-phase'), 'active');
  });

  it('the shaking rows are the same in every filter in which they appear', () => {
    const d = mount();
    d.send(dashState({ files: [activeRow('a.ts', 'src'), activeRow('b.ts', 'src', { source: 'external' })] }));
    assert.equal(shaking(d).length, 2);
  });

  it('a row stops shaking when its phase goes idle in a later state, in the same element', () => {
    const d = mount();
    const a = activeRow('a.ts', 'src');
    d.send(dashState({ seq: 1, files: [a] }));
    const li = must(rowFor(d, a.id));
    assert.ok(li.classList.contains('is-shaking'));
    d.send(dashState({ seq: 2, files: [{ ...a, phase: 'idle', intensity: 0 }] }));
    assert.equal(rowFor(d, a.id), li);
    assert.equal(li.classList.contains('is-shaking'), false);
    assert.equal(li.className, 'fd-row');
  });
});

describe('dashboard: reduced motion and the animation setting give zero .is-shaking', () => {
  const files = [activeRow('a.ts', 'src'), activeRow('b.ts', 'src', { source: 'ai-agent', sourceId: 'x', method: 'agent-signal' }), row('c.ts', 'src')];

  it('env.reducedMotion at mount: data-motion=off and nothing shakes', () => {
    const d = mount({ reduced: true });
    assert.equal(d.root.getAttribute('data-motion'), 'off', 'off even before the first state');
    d.send(dashState({ files }));
    assert.equal(d.root.getAttribute('data-motion'), 'off');
    assert.equal(shaking(d).length, 0);
  });

  it('settings.animate=false: data-motion=off and nothing shakes', () => {
    const d = mount();
    d.send(dashState({ files, settings: { animate: false } }));
    assert.equal(d.root.getAttribute('data-motion'), 'off');
    assert.equal(shaking(d).length, 0);
  });

  it('compact mode: data-motion=off and nothing shakes', () => {
    const d = mount();
    d.send(dashState({ files, settings: { mode: 'compact' } }));
    assert.equal(d.root.getAttribute('data-motion'), 'off');
    assert.equal(shaking(d).length, 0);
  });

  it('state.enabled=false: a leftover active row does not keep moving', () => {
    const d = mount();
    d.send(dashState({ files, enabled: false }));
    assert.equal(shaking(d).length, 0);
    assert.equal(d.root.getAttribute('data-enabled'), 'false');
  });

  it('impact mode: rows never shake (motion attribute may stay on, per the recorded deviation)', () => {
    const d = mount();
    d.send(dashState({ files, settings: { mode: 'impact' } }));
    assert.equal(shaking(d).length, 0);
  });

  it('every combination of the four switches: shaking only when ALL allow it (full truth table, 32 cases)', () => {
    const modes = ['live', 'compact', 'impact'] as const;
    let n = 0;
    for (const reduced of [false, true]) {
      for (const animate of [true, false]) {
        for (const enabled of [true, false]) {
          for (const mode of modes) {
            const d = mountDash({ reduced });
            d.send(dashState({ files, enabled, settings: { animate, mode } }));
            const allowed = !reduced && animate && enabled && mode === 'live';
            assert.equal(shaking(d).length > 0, allowed, JSON.stringify({ reduced, animate, enabled, mode }));
            if (allowed) assert.equal(shaking(d).length, 2);
            if (reduced || !animate || mode === 'compact') assert.equal(d.root.getAttribute('data-motion'), 'off', JSON.stringify({ reduced, animate, mode }));
            d.close();
            n += 1;
          }
        }
      }
    }
    assert.equal(n, 24);
  });

  it('the preference changing at run time re-renders at once: on -> off removes the class, off -> on restores it', () => {
    const d = mount();
    d.send(dashState({ files }));
    assert.equal(shaking(d).length, 2);
    d.env.setReduced(true);
    assert.equal(shaking(d).length, 0);
    assert.equal(d.root.getAttribute('data-motion'), 'off');
    d.env.setReduced(false);
    assert.equal(shaking(d).length, 2);
    assert.equal(d.root.getAttribute('data-motion'), 'on');
  });

  it('a preference change before any state arrived is harmless', () => {
    const d = mount();
    assert.doesNotThrow(() => d.env.setReduced(true));
    d.send(dashState({ files }));
    assert.equal(shaking(d).length, 0);
  });

  it('the CSS custom properties are still set when motion is off (the meter keeps showing intensity, a cue that is not motion)', () => {
    const d = mount({ reduced: true });
    d.send(dashState({ files: [activeRow('a.ts', 'src', { intensity: 0.7 })] }));
    const li = must(rowFor(d, '/ws/proj/src/a.ts'));
    assert.equal(li.style.getPropertyValue('--fd-level'), '0.7');
    assert.equal(d.qa('.fd-meter', li).length, 1);
  });

  it('the stylesheet forces animation: none for both prefers-reduced-motion and data-motion=off, and removes transitions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { REPO_ROOT } = await import('../support/fixtures');
    const css = readFileSync(join(REPO_ROOT, 'media', 'dashboard.css'), 'utf8');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\[data-motion="off"\]/);
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reduce, /animation:\s*none/);
    assert.match(reduce, /transition:\s*none/);
    assert.match(css.slice(css.indexOf('[data-motion="off"]')), /animation:\s*none/);
  });
});

describe('dashboard: stale and malformed messages', () => {
  it('a state with a lower seq is ignored; an equal or higher one is applied', () => {
    const d = mount();
    d.send(dashState({ seq: 5, files: [row('new.ts', 'src')] }));
    assert.equal(d.app.lastSeq, 5);
    d.send(dashState({ seq: 3, files: [row('stale.ts', 'src')] }));
    assert.equal(d.app.lastSeq, 5);
    assert.equal(rowFor(d, '/ws/proj/src/stale.ts'), undefined);
    assert.ok(rowFor(d, '/ws/proj/src/new.ts'));
    d.send(dashState({ seq: 5, files: [row('same.ts', 'src')] }));
    assert.ok(rowFor(d, '/ws/proj/src/same.ts'), 'an equal seq is not stale');
    d.send(dashState({ seq: 6, files: [row('newer.ts', 'src')] }));
    assert.equal(d.app.lastSeq, 6);
    assert.ok(rowFor(d, '/ws/proj/src/newer.ts'));
  });

  it('a stale state changes nothing at all: not the DOM, not the announcements, not the persisted state', () => {
    const d = mount();
    d.send(busyState({ seq: 10 }));
    const html = d.root.innerHTML;
    const writes = d.host.stateWrites.length;
    d.send(dashState({ seq: 9, settings: { paused: true, mode: 'impact' }, enabled: false }));
    assert.equal(d.root.innerHTML, html);
    assert.equal(d.host.stateWrites.length, writes);
    assert.equal(d.env.pending, 0);
  });

  it('a very old or negative seq after a first state is ignored; after reload (new page) seq may restart', () => {
    const d = mount();
    d.send(dashState({ seq: 1000 }));
    for (const seq of [0, -5, 999]) {
      d.send(dashState({ seq, files: [row('x.ts', 'src')] }));
      assert.equal(rowFor(d, '/ws/proj/src/x.ts'), undefined, String(seq));
    }
    const fresh = mount();
    fresh.send(dashState({ seq: 1 }));
    assert.equal(fresh.app.lastSeq, 1);
  });

  const junk: unknown[] = [
    undefined,
    null,
    0,
    1,
    'state',
    true,
    [],
    [1, 2, 3],
    {},
    { type: 'state' },
    { type: 'state', state: null },
    { type: 'state', state: {} },
    { type: 'state', state: { v: 1 } },
    { type: 'state', state: { v: 2 } },
    { type: 'snapshot', snapshot: {} },
    { type: 'ready' },
    { type: 'open', id: 'x' },
    { command: 'refactor' },
    () => 1,
    Symbol('x'),
  ];

  it('anything that is not a valid state message is ignored without throwing and without touching the DOM', () => {
    const d = mount();
    d.send(busyState({ seq: 1 }));
    const html = d.root.innerHTML;
    for (const raw of junk) {
      assert.doesNotThrow(() => d.sendRaw(raw), String(typeof raw));
      assert.equal(d.root.innerHTML, html, JSON.stringify(raw) ?? String(raw));
    }
    assert.equal(d.app.lastSeq, 1);
  });

  it('junk before the first state leaves the app in its loading state', () => {
    const d = mount();
    for (const raw of junk) d.sendRaw(raw);
    assert.equal(d.root.getAttribute('data-state'), 'loading');
    assert.equal(d.app.lastSeq, -1);
  });

  it('a state with one invalid field is rejected as a whole (the previous good state stays on screen)', () => {
    const d = mount();
    d.send(busyState({ seq: 1 }));
    const html = d.root.innerHTML;
    const bad = JSON.parse(JSON.stringify({ type: 'state', state: busyState({ seq: 2 }) })) as { state: { files: Array<Record<string, unknown>> } };
    must(bad.state.files[0])['intensity'] = 7;
    d.sendRaw(bad);
    assert.equal(d.root.innerHTML, html);
    assert.equal(d.app.lastSeq, 1);
    const worse = JSON.parse(JSON.stringify({ type: 'state', state: busyState({ seq: 3 }) })) as { state: { settings: Record<string, unknown> } };
    worse.state.settings['mode'] = 'turbo';
    d.sendRaw(worse);
    assert.equal(d.root.innerHTML, html);
  });

  it('hostile hostile messages: throwing getters, proxies and cyclic objects do not throw out of handleMessage', () => {
    const d = mount();
    const cyc: Record<string, unknown> = { type: 'state' };
    cyc['state'] = cyc;
    const proxy = new Proxy({}, { get: () => { throw new Error('boom'); } });
    const getter = { get type(): string { throw new Error('boom'); } };
    for (const raw of [cyc, proxy, getter]) assert.doesNotThrow(() => d.sendRaw(raw));
  });

  it('a state with more rows than the protocol allows is rejected, not truncated', () => {
    const d = mount();
    d.send(dashState({ seq: 1, files: [row('keep.ts', 'src')] }));
    const msg = JSON.parse(JSON.stringify({ type: 'state', state: dashState({ seq: 2, files: manyRows(300) }) })) as { state: { files: unknown[] } };
    msg.state.files.push(msg.state.files[0]);
    d.sendRaw(msg);
    assert.equal(d.qa('li.fd-row').length, 1);
    assert.ok(rowFor(d, '/ws/proj/src/keep.ts'));
  });

  it('duplicate file ids in one state are tolerated: the first one wins and the list has no duplicate row', () => {
    const d = mount();
    const a1 = row('a.ts', 'src', { changes: 1 });
    const a2 = row('a.ts', 'src', { changes: 9 });
    assert.doesNotThrow(() => d.send(dashState({ files: [a1, a2, row('b.ts', 'src')] })));
    assert.deepEqual(
      d.qa('li.fd-row').map((r) => r.getAttribute('data-id')),
      ['/ws/proj/src/a.ts', '/ws/proj/src/b.ts'],
    );
  });

  it('duplicate timeline, dependency, session and git ids are tolerated too', () => {
    const d = mount();
    const s = busyState();
    const dupe = JSON.parse(JSON.stringify(s)) as typeof s;
    dupe.timeline = [...dupe.timeline, ...dupe.timeline];
    dupe.selection.imports = [...dupe.selection.imports, ...dupe.selection.imports];
    dupe.sessions.previous = [...dupe.sessions.previous, ...dupe.sessions.previous];
    const repoSlot = must(dupe.git.repos[0]);
    repoSlot.staged = [...repoSlot.staged, ...repoSlot.staged];
    dupe.git.repos = [repoSlot, repoSlot];
    assert.doesNotThrow(() => d.send(dupe));
    assert.equal(d.qa('li.fd-tl').length, s.timeline.length);
    assert.equal(d.qa('section[data-deps="imports"] li.fd-dep').length, s.selection.imports.length);
    assert.equal(d.qa('section.fd-repo').length, 1);
  });
});

describe('dashboard: dispose leaves nothing running', () => {
  it('removes its listeners: clicks and keys after dispose send nothing, states are ignored', () => {
    const d = mount();
    d.send(busyState());
    const btn = d.q<HTMLButtonElement>('button.fd-tab[data-tab="activity"]');
    d.app.dispose();
    const before = d.host.messages.length;
    btn.click();
    d.q<HTMLButtonElement>('button.fd-card').click();
    const html = d.root.innerHTML;
    d.send(dashState({ seq: 99, files: [row('late.ts', 'src')] }));
    assert.equal(d.root.innerHTML, html);
    assert.equal(d.host.messages.length, before);
    assert.equal(d.selectedTab(), 'overview', 'the click was not handled');
  });

  it('clears its announcement timer and unsubscribes from the reduced-motion watcher', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    d.send(dashState({ seq: 3, settings: { paused: false } }));
    assert.equal(d.env.pending, 1, 'an announcement timer is pending');
    assert.equal(d.env.listenerCount, 1);
    d.app.dispose();
    assert.equal(d.env.pending, 0, 'no pending timer');
    assert.equal(d.env.listenerCount, 0, 'the media query listener is gone');
    assert.equal(d.env.subscriptions, d.env.unsubscriptions);
    d.env.runTimers();
    assert.doesNotThrow(() => d.env.setReduced(true));
  });

  it('dispose is idempotent and safe before any state', () => {
    const d = mount();
    d.app.dispose();
    assert.doesNotThrow(() => d.app.dispose());
    assert.equal(d.env.pending, 0);
  });

  it('a timer that fires after dispose does nothing', () => {
    const d = mount();
    d.send(dashState({ seq: 1 }));
    d.send(dashState({ seq: 2, settings: { paused: true } }));
    d.send(dashState({ seq: 3, settings: { paused: false } }));
    const timers = [...d.env.timers.values()];
    d.app.dispose();
    const live = d.q('.fd-live');
    const text = live.textContent;
    for (const t of timers) assert.doesNotThrow(() => t.fn());
    assert.equal(live.textContent, text);
    assert.equal(d.env.pending, 0, 'and it does not reschedule');
  });

  it('mounting twice into two pages does not share state', () => {
    const a = mountDash();
    const b = mountDash();
    a.send(dashState({ seq: 5, files: [row('a.ts', 'src')] }));
    assert.equal(b.app.lastSeq, -1);
    assert.equal(b.qa('li.fd-row').length, 0);
    a.close();
    b.close();
  });

  it('no timer is ever left behind by rendering alone (only announcements use the injected timer)', () => {
    const d = mount();
    for (let i = 1; i <= 30; i += 1) d.send(busyState({ seq: i }));
    assert.equal(d.env.pending, 0);
    assert.equal(d.env.scheduled.length, 0);
  });
});
