// 0.3.0 with no folder open: nothing may throw, features that need a workspace say so, and sessions, pause and history still work.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { parseDashboardHostMessage } from '../../../src/core/dashboard/protocol';
import { envPath, getApi, keyOf, must, openDoc, setConfig, testing, typeAndWait, waitUntil } from './helpers';
import { activeSession, dashboardState, resetAll, run, send } from './helpers030';

suite('0.3.0 no folder open', () => {
  let api: ChangescopeApi;
  const o1 = (): string => join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');

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

  test('there really is no workspace, and the dashboard state is valid and empty', () => {
    assert.ok(!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0);
    const s = dashboardState(api);
    assert.ok(parseDashboardHostMessage(JSON.parse(JSON.stringify({ type: 'state', state: s }))));
    assert.deepEqual(s.files, []);
    assert.equal(s.enabled, true);
  });

  test('the dashboard view loads and posts ready without a workspace', async function () {
    this.timeout(120_000);
    await run('changescope.openDashboard');
    await waitUntil(api, () => testing(api).dashboardStats().ready >= 1, 'the dashboard to post ready', 60_000);
    assert.ok(testing(api).dashboardStats().sent >= 1);
  });

  test('a loose file you type in is Developer; the history carries an opaque workspace id, never a path', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(o1()));
    const e = must(api.getActivityEvents().find((x) => x.filePath === keyOf(o1())));
    assert.equal(e.sourceType, 'developer');
    assert.match(e.workspaceId, /^[\w.-]+$/);
    assert.ok(!e.workspaceId.includes('/'));
    const row = must(dashboardState(api).files.find((f) => f.id === keyOf(o1())));
    assert.equal(row.source, 'developer');
  });

  test('the agent signal file needs workspace storage: the adapter says unavailable, and no path is offered', async function () {
    this.timeout(60_000);
    assert.equal(testing(api).agentSignalPath(), undefined);
    await setConfig('experimental.agentSignals', true);
    await waitUntil(api, () => dashboardState(api).agents.find((a) => a.id === 'signal-file')?.state === 'unavailable', 'the adapter to report unavailable', 30_000);
    assert.match(must(dashboardState(api).agents.find((a) => a.id === 'signal-file')).detail, /workspace storage/);
    await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand('changescope.copyAgentHook')), 'the hook command explains instead of failing');
  });

  test('the dependency index with nothing to index: building resolves and the state stays consistent', async function () {
    this.timeout(60_000);
    await testing(api).buildDependencyIndex();
    const idx = dashboardState(api).index;
    assert.ok(['ready', 'idle'].includes(idx.state), idx.state);
    assert.equal(idx.indexed, 0);
    assert.equal(testing(api).pendingTimers() === 0 || idx.state !== 'indexing', true);
  });

  test('sessions, pause and the stored history work without a folder', async function () {
    this.timeout(90_000);
    send(api, { type: 'sessionStart', title: 'No folder' });
    await typeAndWait(api, await openDoc(o1()));
    assert.equal(must(activeSession(api)).activityCount, 1);
    await run('changescope.pause');
    assert.equal(dashboardState(api).settings.paused, true);
    await run('changescope.resume');
    await testing(api).flushHistory();
    assert.ok(testing(api).storedHistory() !== undefined, 'the Memento keeps the history');
    await testing(api).reloadHistory();
    assert.equal(api.getActivityEvents().length, 1);
    assert.equal(activeSession(api), undefined, 'a running session comes back completed');
  });

  test('[QA-101] with no folder open the exported report has no absolute path', async function () {
    this.timeout(90_000);
    send(api, { type: 'sessionStart', title: 'No folder report' });
    await typeAndWait(api, await openDoc(o1()));
    const id = must(activeSession(api)).id;
    send(api, { type: 'sessionStop' });
    const before = new Set(vscode.workspace.textDocuments);
    await run('changescope.exportSessionReport', id);
    await waitUntil(api, () => vscode.workspace.textDocuments.some((d) => !before.has(d) && d.languageId === 'markdown'), 'the report', 20_000);
    const text = must(vscode.workspace.textDocuments.find((d) => !before.has(d) && d.languageId === 'markdown')).getText();
    assert.ok(text.includes('o1.ts'));
    assert.ok(!text.includes(envPath('FS_TEST_OUTSIDE')), 'the report contains an absolute path');
  });

  test('zero pending timers when idle', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(o1()));
    testing(api).advance(120_000);
    await waitUntil(api, () => testing(api).pendingTimers() === 0, 'no timers', 15_000);
  });
});
