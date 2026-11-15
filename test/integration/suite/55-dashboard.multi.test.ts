// 0.3.0 in a multi-root workspace (alpha + beta): display folders lead with the root name, reports and AI requests use them,
// and the dependency index follows an import from one root into the other.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { envPath, getApi, keyOf, must, openDoc, setConfig, testing, typeAndWait, waitUntil } from './helpers';
import { activeSession, dashboardState, mockProvider, resetAll, run, send, summarizeNow } from './helpers030';

suite('0.3.0 multi-root workspace (alpha + beta)', () => {
  let api: ChangescopeApi;
  const alpha = (): string => envPath('FS_TEST_ALPHA');
  const beta = (): string => envPath('FS_TEST_BETA');
  const handles: Array<{ dispose(): void }> = [];

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
    for (const h of handles.splice(0)) h.dispose();
    await resetAll(api);
  });

  test('two workspace folders: the dashboard names files by folder, and equal file names in different roots stay two rows', async function () {
    this.timeout(90_000);
    assert.equal(vscode.workspace.workspaceFolders?.length, 2);
    const files = [join(alpha(), 'shared.ts'), join(beta(), 'shared.ts'), join(alpha(), 'sub', 'deep.ts')];
    for (const f of files) {
      await typeAndWait(api, await openDoc(f));
      testing(api).advance(6000);
    }
    const s = dashboardState(api);
    const rows = Object.fromEntries(s.files.map((r) => [r.id, r]));
    assert.equal(rows[keyOf(files[0] as string)]?.dir, 'alpha');
    assert.equal(rows[keyOf(files[1] as string)]?.dir, 'beta');
    assert.equal(rows[keyOf(files[2] as string)]?.dir, 'alpha/sub');
    assert.equal(s.files.filter((r) => r.name === 'shared.ts').length, 2, 'same name, two rows');
    assert.equal(new Set(s.files.map((r) => r.id)).size, s.files.length);
    for (const r of s.files) assert.equal(r.source, 'developer');
    assert.equal(s.overview.modifiedFiles, 3);
  });

  test('a session report lists files as alpha/... and beta/..., with no absolute path', async function () {
    this.timeout(120_000);
    send(api, { type: 'sessionStart', title: 'Both roots' });
    await typeAndWait(api, await openDoc(join(alpha(), 'shared.ts')));
    testing(api).advance(6000);
    await typeAndWait(api, await openDoc(join(beta(), 'lib.ts')));
    const id = must(activeSession(api)).id;
    send(api, { type: 'sessionStop' });
    const before = new Set(vscode.workspace.textDocuments);
    await run('changescope.exportSessionReport', id);
    await waitUntil(api, () => vscode.workspace.textDocuments.some((d) => !before.has(d) && d.languageId === 'markdown'), 'the report', 20_000);
    const text = must(vscode.workspace.textDocuments.find((d) => !before.has(d) && d.languageId === 'markdown')).getText();
    assert.match(text, /\| alpha\/shared\.ts \|/);
    assert.match(text, /\| beta\/lib\.ts \|/);
    assert.ok(!text.includes(envPath('FS_TEST_ROOT')), 'no absolute path');
  });

  test('the dependency index follows an import across roots: beta/lib.ts is imported by alpha/shared.ts', async function () {
    this.timeout(120_000);
    await typeAndWait(api, await openDoc(join(beta(), 'lib.ts')));
    await testing(api).buildDependencyIndex();
    assert.equal(dashboardState(api).index.state, 'ready');
    send(api, { type: 'select', id: keyOf(join(beta(), 'lib.ts')) });
    const s = dashboardState(api);
    assert.deepEqual(s.selection.importedBy.map((d) => [d.id, d.dir]), [[keyOf(join(alpha(), 'shared.ts')), 'alpha']]);
    assert.equal(s.selection.impact?.direct, 1);
    assert.equal(s.selection.impact?.level, 'low');
  });

  test('an assisted request carries paths relative to their folder (alpha/..., beta/...), never absolute ones', async function () {
    this.timeout(120_000);
    const mock = mockProvider();
    handles.push(api.registerAiProvider(mock.provider));
    testing(api).overrideConsentPrompt(() => Promise.resolve('Allow'));
    await setConfig('ai.mode', 'assisted');
    await setConfig('ai.provider', 'acme.test');
    await waitUntil(api, () => dashboardState(api).settings.aiMode === 'assisted', 'assisted', 20_000);
    await typeAndWait(api, await openDoc(join(alpha(), 'only-alpha.ts')));
    testing(api).advance(6000);
    await typeAndWait(api, await openDoc(join(beta(), 'shared.ts')));
    await summarizeNow(api);
    const paths = must(mock.calls[0]).metadata.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['alpha/only-alpha.ts', 'beta/shared.ts']);
    assert.ok(!JSON.stringify(mock.calls[0]).includes(envPath('FS_TEST_ROOT')));
  });
});
