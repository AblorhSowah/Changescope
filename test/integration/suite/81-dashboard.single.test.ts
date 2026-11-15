// The 0.3.0 dashboard in real VS Code: manifest contributions, the Activity Bar view loading dist/dashboard.js and posting
// `ready`, the state the host builds, messages from the webview (valid, malformed, naming ids that are not in the state),
// mode and animation settings reaching the Explorer view, the editor panel, timers.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { parseDashboardHostMessage } from '../../../src/core/dashboard/protocol';
import { stateSignature } from '../../../src/core/dashboard/model';
import { EXT_ID, envPath, getApi, keyOf, must, openDoc, resetConfig, rowOf, setConfig, testing, typeAndWait, waitUntil, workspaceDir } from './helpers';
import { dashboardState, resetAll, run, send } from './helpers030';

const NEW_COMMANDS = [
  'changescope.openDashboard',
  'changescope.openDashboardPanel',
  'changescope.setViewMode',
  'changescope.pause',
  'changescope.resume',
  'changescope.startSession',
  'changescope.stopSession',
  'changescope.renameSession',
  'changescope.exportSessionReport',
  'changescope.markAllReviewed',
  'changescope.clearHistory',
  'changescope.rebuildDependencyIndex',
  'changescope.copyAgentHook',
  'changescope.ai.setKey',
  'changescope.ai.clearKey',
  'changescope.ai.resetConsent',
];

suite('0.3.0 dashboard (single-root workspace)', () => {
  let api: ChangescopeApi;
  const ws = workspaceDir();

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await resetAll(api);
  });

  teardown(async function () {
    this.timeout(60_000);
    await resetAll(api);
  });

  test('the manifest reached VS Code: Activity Bar container, dashboard view, 20 commands, 28 settings with the documented 0.3.0 defaults', async () => {
    const ext = must(vscode.extensions.getExtension(EXT_ID), 'extension');
    const c = (ext.packageJSON as { contributes: { viewsContainers: { activitybar: Array<{ id: string }> }; views: Record<string, Array<{ id: string; type: string }>>; configuration: { properties: Record<string, unknown> } } }).contributes;
    assert.deepEqual(c.viewsContainers.activitybar.map((v) => v.id), ['changescope']);
    assert.deepEqual(c.views['changescope']?.map((v) => `${v.type}:${v.id}`), ['webview:changescope.dashboard']);
    assert.deepEqual(c.views['explorer']?.map((v) => `${v.type}:${v.id}`), ['webview:changescope.view'], 'the Explorer view is unchanged');
    assert.equal(Object.keys(c.configuration.properties).length, 28);
    const all = await vscode.commands.getCommands(true);
    for (const id of NEW_COMMANDS) assert.ok(all.includes(id), `${id} is not registered`);
    assert.ok(all.includes('changescope.dashboard.focus'), 'the auto-generated focus command of the dashboard view');
    const cfg = vscode.workspace.getConfiguration('changescope');
    assert.equal(cfg.get('viewMode'), 'live');
    assert.equal(cfg.get('animationIntensity'), 1);
    assert.equal(cfg.get('history.persist'), true);
    assert.equal(cfg.get('history.maxEvents'), 1000);
    assert.equal(cfg.get('history.retentionDays'), 14);
    assert.equal(cfg.get('git.enabled'), true);
    assert.equal(cfg.get('dependencies.index'), 'onDemand');
    assert.equal(cfg.get('dependencies.maxFiles'), 5000);
    assert.equal(cfg.get('collisions.notify'), true);
    assert.equal(cfg.get('ai.mode'), 'local');
    assert.equal(cfg.get('ai.provider'), '');
    assert.equal(cfg.get('experimental.agentSignals'), false);
    assert.equal((cfg.get<string[]>('sensitiveGlobs') ?? []).length, 10);
  });

  test('the public API of 0.3.0 is there and apiVersion is still 1', () => {
    assert.equal(api.apiVersion, 1);
    for (const m of ['registerAiProvider', 'reportAgentActivity', 'getActivityEvents', 'getSessions', 'getDashboardState'] as const) assert.equal(typeof api[m], 'function', m);
    for (const m of ['buildDependencyIndex', 'dependencyIndexIdle', 'dashboardStats', 'dashboardMessage', 'flushHistory', 'historyWrites', 'storedHistory', 'reloadHistory', 'overrideCollisionNotify', 'collisionStats', 'overrideConsentPrompt', 'overrideConfirm', 'agentSignalPath'] as const) {
      assert.equal(typeof testing(api)[m], 'function', m);
    }
  });

  test('changescope.openDashboard loads the Activity Bar view, the webview runs dist/dashboard.js and posts ready, and a state is sent', async function () {
    this.timeout(120_000);
    await run('changescope.openDashboard');
    await waitUntil(api, () => testing(api).dashboardStats().resolved >= 1, 'the dashboard view to be resolved', 60_000);
    await waitUntil(api, () => testing(api).dashboardStats().ready >= 1, 'the dashboard webview to post {type:"ready"}', 60_000);
    await waitUntil(api, () => testing(api).dashboardStats().sent >= 1, 'the first state to be sent', 30_000);
    const stats = testing(api).dashboardStats();
    assert.equal(stats.visible, true);
    assert.ok(stats.lastSeq >= 1, `lastSeq ${stats.lastSeq}`);
    assert.equal(stats.panelOpen, false);
  });

  test('a visible dashboard is sent a new state when something happens (debounced on the injected scheduler), and an idle one is not', async function () {
    this.timeout(120_000);
    await run('changescope.openDashboard');
    await waitUntil(api, () => testing(api).dashboardStats().ready >= 1, 'ready', 60_000);
    testing(api).advance(1000);
    const base = testing(api).dashboardStats().sent;
    testing(api).advance(60_000);
    assert.equal(testing(api).dashboardStats().sent, base, 'nothing changed, nothing is posted');
    await typeAndWait(api, await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts')));
    testing(api).advance(400);
    await waitUntil(api, () => testing(api).dashboardStats().sent > base, 'a state to be posted after the edit', 30_000);
  });

  test('the state the host builds is valid for the protocol, empty at the start, and reflects an edit with its attribution', async function () {
    this.timeout(60_000);
    const empty = dashboardState(api);
    assert.equal(empty.v, 1);
    assert.equal(empty.enabled, true);
    assert.deepEqual(empty.files, []);
    assert.equal(empty.overview.modifiedFiles, 0);
    assert.equal(empty.settings.mode, 'live');
    assert.equal(empty.settings.paused, false);
    assert.ok(parseDashboardHostMessage(JSON.parse(JSON.stringify({ type: 'state', state: empty }))), 'valid for the webview');

    const file = join(workspaceDir(), 'a.ts');
    await typeAndWait(api, await openDoc(file));
    const s = dashboardState(api);
    const row = must(s.files.find((f) => f.id === keyOf(file)));
    assert.equal(row.source, 'developer');
    assert.equal(row.method, 'focused-editor-edit');
    assert.equal(row.confidence, 0.9);
    assert.equal(row.phase, 'active');
    assert.ok(row.intensity > 0);
    assert.equal(row.review, null, 'your own typing needs no review');
    assert.equal(s.overview.bySource.developer, 1);
    assert.ok(parseDashboardHostMessage(JSON.parse(JSON.stringify({ type: 'state', state: s }))), 'still valid');
    assert.equal(JSON.stringify(s).includes(ws), true, 'ids are absolute keys (the only place a path travels)');
    for (const f of s.files) assert.ok(!f.dir.startsWith('/'), `display folder of a workspace file is relative: ${f.dir}`);
  });

  test('valid messages from the webview are acted on: setMode, setAnimate, setPaused', async function () {
    this.timeout(60_000);
    const cfg = vscode.workspace.getConfiguration('changescope');
    send(api, { type: 'setMode', mode: 'compact' });
    await waitUntil(api, () => vscode.workspace.getConfiguration('changescope').get('viewMode') === 'compact', 'viewMode compact', 20_000);
    assert.equal(dashboardState(api).settings.mode, 'compact');
    send(api, { type: 'setAnimate', value: false });
    await waitUntil(api, () => vscode.workspace.getConfiguration('changescope').get('enableAnimation') === false, 'animation off', 20_000);
    assert.equal(dashboardState(api).settings.animate, false);
    send(api, { type: 'setPaused', value: true });
    assert.equal(dashboardState(api).settings.paused, true);
    send(api, { type: 'setPaused', value: false });
    assert.equal(dashboardState(api).settings.paused, false);
    assert.equal(cfg.get('enable'), true, 'unrelated settings are untouched');
  });

  test('malformed messages are ignored: nothing throws and the state does not change', () => {
    const before = stateSignature(dashboardState(api));
    const junk: unknown[] = [
      undefined,
      null,
      7,
      'open',
      [],
      {},
      { type: 'nope' },
      { type: 'open' },
      { type: 'open', id: 5 },
      { type: 'setMode', mode: 'turbo' },
      { type: 'setPaused', value: 'yes' },
      { type: 'sessionStart', title: 7 },
      { type: 'sessionRename', id: 's', title: '   ' },
      { type: 'error' },
      { type: 'select', id: { toString: () => 'x' } },
      JSON.parse('{"__proto__":{"type":"clearHistory"},"type":"zzz"}'),
    ];
    for (const raw of junk) assert.doesNotThrow(() => send(api, raw), JSON.stringify(raw));
    assert.equal(stateSignature(dashboardState(api)), before);
    assert.equal(api.getSessions().length, 0, 'no junk message started a session');
  });

  test('messages that name an id which is not in the state do nothing: open, openDiff, select, markReviewed, sessionRename, sessionExport', async function () {
    this.timeout(60_000);
    const editorsBefore = vscode.window.visibleTextEditors.length;
    const docsBefore = vscode.workspace.textDocuments.length;
    send(api, { type: 'sessionStart', title: 'Real session' });
    const ghosts = ['/etc/passwd', '/no/such/file.ts', join(workspaceDir(), 'not-in-state.ts'), '../../etc/hosts', 'file:///etc/passwd', 'x'.repeat(5000)];
    for (const id of ghosts) {
      send(api, { type: 'open', id });
      send(api, { type: 'openDiff', id });
      send(api, { type: 'select', id });
      send(api, { type: 'markReviewed', id });
      send(api, { type: 'sessionRename', id, title: 'Hijacked' });
      send(api, { type: 'sessionExport', id });
    }
    // the ids of a session that never existed
    send(api, { type: 'sessionRename', id: 'no-such-session', title: 'Hijacked' });
    send(api, { type: 'sessionExport', id: 'no-such-session' });
    const s = dashboardState(api);
    assert.equal(s.selection.file, null, 'select of an unknown id selects nothing');
    assert.equal(s.sessions.active?.title, 'Real session', 'no rename of an unknown session');
    assert.equal(vscode.window.visibleTextEditors.length, editorsBefore, 'nothing was opened');
    assert.equal(vscode.workspace.textDocuments.length, docsBefore, 'no report or file document appeared');
  });

  test('the editor panel opens once, a second call brings the same panel forward, and closing it leaves no timer behind', async function () {
    this.timeout(120_000);
    await run('changescope.openDashboardPanel');
    await waitUntil(api, () => testing(api).dashboardStats().panelOpen, 'the panel to open', 30_000);
    await run('changescope.openDashboardPanel');
    const panelTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview);
    await waitUntil(api, () => panelTabs().length >= 1, `the panel tab to appear (tabs: ${JSON.stringify(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => `${t.label}|${t.input instanceof vscode.TabInputWebview ? 'webview' : 'other'}`))})`, 30_000);
    assert.equal(panelTabs().length, 1, 'one panel at a time');
    await waitUntil(api, () => testing(api).dashboardStats().ready >= 1, 'the panel to post ready', 60_000);
    for (const t of panelTabs()) await vscode.window.tabGroups.close(t);
    await waitUntil(api, () => !testing(api).dashboardStats().panelOpen, 'the panel to be released', 30_000);
    testing(api).advance(60_000);
    await waitUntil(api, () => testing(api).pendingTimers() === 0, 'no timer after the panel closed', 15_000);
  });

  test('compact mode reaches the Explorer view (rows stop shaking) and animationIntensity scales distance and rotation but never speed', async function () {
    this.timeout(90_000);
    const file = join(workspaceDir(), 'b.ts');
    await typeAndWait(api, await openDoc(file));
    const key = keyOf(file);
    assert.equal(api.getSnapshot().animate, true);
    const shakeOf = (): { amp: number; dur: number; rot: number } => must(api.getSnapshot().rows.find((r) => r.id === key)).shake;
    assert.ok(rowOf(api, key));
    const normal = shakeOf();
    await setConfig('viewMode', 'compact');
    await waitUntil(api, () => api.getSnapshot().animate === false, 'the Explorer snapshot to stop animating in compact mode', 20_000);
    await setConfig('viewMode', 'live');
    await waitUntil(api, () => api.getSnapshot().animate === true, 'the Explorer snapshot to animate again', 20_000);
    await setConfig('animationIntensity', 2);
    await waitUntil(api, () => shakeOf().amp !== normal.amp, 'the shake to be scaled in the snapshot', 20_000);
    const doubled = shakeOf();
    assert.ok(doubled.amp > normal.amp && doubled.rot > normal.rot, `${JSON.stringify(normal)} -> ${JSON.stringify(doubled)}`);
    assert.equal(doubled.dur, normal.dur, 'speed is not scaled');
    assert.ok(Math.abs(doubled.amp - 2 * normal.amp) < 0.02, 'a factor of 2 doubles the distance (to the rounding of 2 decimals)');
    await setConfig('animationIntensity', 0.25);
    await waitUntil(api, () => shakeOf().amp < normal.amp, 'a smaller shake', 20_000);
    await resetConfig();
  });

  test('zero pending timers when idle: with the dashboard visible, after activity has settled, and nothing is left by the messages above', async function () {
    this.timeout(120_000);
    await run('changescope.openDashboard');
    await waitUntil(api, () => testing(api).dashboardStats().ready >= 1, 'ready', 60_000);
    send(api, { type: 'sessionStart', title: 'timers' });
    send(api, { type: 'sessionStop' });
    send(api, { type: 'markAllReviewed' });
    await typeAndWait(api, await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o2.ts')));
    testing(api).advance(120_000);
    await waitUntil(api, () => testing(api).pendingTimers() === 0, 'every timer to be gone (tick chain, storage, dashboard throttle)', 30_000);
    assert.equal(testing(api).pendingTimers(), 0);
  });
});
