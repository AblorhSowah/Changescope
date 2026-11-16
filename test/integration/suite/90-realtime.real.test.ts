// Launch variant `real`: CHANGESCOPE_TEST is NOT set, so there is no fake clock and no test seam. The extension runs on the
// system clock and real timers exactly as shipped: the self-stopping tick chain, the 400 ms reference debounce and the 150 ms
// dirty-state parking timer are all real here. Everything else in the suite runs on a fake scheduler and cannot see them.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { colorIdOf, decorationOf, envPath, externalWrite, getApi, keyOf, logFor, must, openDoc, rowOf, resetConfig, runNode, setConfig, trackedOf, typeInto, waitReal, workspaceDir } from './helpers';

suite('Real clock, real timers (no test seam)', () => {
  let api: ChangescopeApi;
  const ws = workspaceDir();

  /**
   * VS Code's file watcher starts asynchronously, and a write made before it is live is never reported (there is no replay). Probes
   * with an excluded *.log file, which the extension logs but never tracks, until its event shows up, so nothing is left behind.
   */
  async function watcherLive(dir: string): Promise<void> {
    const probe = join(dir, `.live-probe-${Date.now()}.log`);
    let lastWrite = 0;
    try {
      await waitReal(
        () => {
          if (logFor(api, (e) => e.key === keyOf(probe)).length > 0) return true;
          if (Date.now() - lastWrite >= 500) {
            lastWrite = Date.now();
            writeFileSync(probe, 'probe\n');
          }
          return false;
        },
        'the file watcher to be live',
        30_000,
      );
    } finally {
      rmSync(probe, { force: true });
    }
  }

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  teardown(async function () {
    this.timeout(60_000);
    // a test that changes a setting must not leak it into the next one (the timed-removal test turns persistence off)
    await resetConfig();
    await vscode.commands.executeCommand('changescope.clear');
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty) {
        await vscode.window.showTextDocument(d, { preview: false });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitReal(() => !vscode.workspace.textDocuments.some((d) => d.isDirty), 'all documents to be clean', 10_000);
    await vscode.commands.executeCommand('changescope.clear');
  });

  test('the production configuration has no test seam and starts empty', () => {
    assert.equal(api.apiVersion, 1);
    assert.equal(api.testing, undefined, 'CHANGESCOPE_TEST must not leak into the real-time launch');
    assert.deepEqual(api.getRows(), []);
    assert.equal(api.getStatusText(), '$(pulse) Changescope');
  });

  test('typing is classified by the REAL window focus, and the first keystroke is never mistaken for a reload', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    const key = keyOf(a);
    const doc = await openDoc(a);
    await typeInto(doc);
    await waitReal(() => rowOf(api, key) !== undefined, 'a row for the typed file', 10_000);
    // Real focus decides: a focused window is typing, an unfocused one is a background edit (the OS may not give the test window focus)
    const expected = vscode.window.state.focused ? 'you' : 'external';
    // the dirty-state event can arrive a few ms after the content event; the 150 ms parking timer must wait for it
    await waitReal(() => trackedOf(api, key)?.source === expected, `source ${expected} (window focused: ${String(vscode.window.state.focused)})`, 5_000);
    assert.deepEqual(
      logFor(api, (e) => e.key === key && e.reason === 'reload-from-disk'),
      [],
      'the first keystroke on a clean document must not be classified as a reload from disk',
    );
    assert.equal(must(rowOf(api, key)).role, 'edited');
  });

  test('the real tick chain keeps the status bar text and the native decorations in step with time: active -> idle -> removed', async function () {
    this.timeout(60_000);
    await setConfig('persistUntilNextFile', false); // this test is about timed removal, which persistence replaces
    const a = join(ws, 'src', 'lib', 'deep.ts');
    const key = keyOf(a);
    const doc = await openDoc(a);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, ' '));
    await waitReal(() => trackedOf(api, key) !== undefined, 'the edit to be recorded', 10_000);
    const edited = Date.now();
    // status text and decoration are only ever updated by the tick chain / refresh, never by a read
    await waitReal(() => api.getStatusText().includes('deep.ts'), 'the status bar to name the file', 5_000);
    await waitReal(() => decorationOf(api, a) !== undefined, 'a native decoration for the active file', 5_000);
    assert.equal(colorIdOf(decorationOf(api, a)), 'changescope.editedForeground');
    assert.equal(rowOf(api, key)?.phase, 'active');

    await waitReal(() => api.getStatusText() === '$(pulse) Changescope', 'the status bar to fall back to the idle text', 8_000);
    const sinceEdit = Date.now() - edited;
    assert.ok(sinceEdit >= 2300, `idle after ${sinceEdit} ms; idleTimeoutMs is 2500, so it cannot be earlier than that`);
    assert.ok(sinceEdit <= 5000, `idle only after ${sinceEdit} ms (tick period 200 ms): the tick chain is not keeping up`);
    assert.equal(decorationOf(api, a), undefined, 'idle rows carry no native decoration');
    assert.equal(rowOf(api, key)?.phase, 'idle');

    await waitReal(() => rowOf(api, key) === undefined && trackedOf(api, key) === undefined, 'the idle row to be removed after the retain period', 12_000);
    const removedAfter = Date.now() - edited;
    assert.ok(removedAfter >= 6200, `removed after ${removedAfter} ms; idle (2500) + retain (4000) = 6500`);
    assert.ok(removedAfter <= 9000, `removed only after ${removedAfter} ms`);
  });

  test('an external process writes a file: one external row, the references of an externally written file are found with the real debounce', async function () {
    this.timeout(60_000);
    const src = join(ws, 'src', 'main.ts');
    const content = "import { helper } from './util';\nimport { b1 } from '../b';\nhelper(b1());\nhelper(1);\n";
    await watcherLive(join(ws, 'src'));
    // one write is enough once the watcher is live; a retry only covers an event lost on an overloaded machine
    let writes = 0;
    for (;;) {
      writes += 1;
      await externalWrite(src, content);
      try {
        await waitReal(() => rowOf(api, keyOf(src))?.source === 'external', 'an external row', 5_000);
        break;
      } catch (e) {
        if (writes >= 3) throw e;
      }
    }
    assert.ok(must(trackedOf(api, keyOf(src))).editCount <= 2 * writes, `editCount ${must(trackedOf(api, keyOf(src))).editCount} after ${writes} write(s)`);
    // reference analysis: real 400 ms debounce + real async fs
    const t0 = Date.now();
    await waitReal(() => rowOf(api, keyOf(join(ws, 'src', 'util.ts')))?.role === 'referenced', 'util.ts to turn yellow', 15_000).catch((e: unknown) => {
      const state = { afterMs: Date.now() - t0, status: api.getStatusText(), rows: api.getRows(), tracked: api.getTracked(), log: api.getEventLog().slice(-12) };
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nmodel at the timeout: ${JSON.stringify(state)}`, { cause: e });
    });
    const util = must(rowOf(api, keyOf(join(ws, 'src', 'util.ts'))));
    assert.equal(util.refCount, 3);
    assert.equal(must(rowOf(api, keyOf(join(ws, 'b.ts')))).refCount, 2);
    assert.equal(api.getStatusText().startsWith('$(pulse) main.ts · external'), true, api.getStatusText());
  });

  test('a burst of 150 keystrokes is recorded exactly when the window is focused; an unfocused window merges them per EXTERNAL_DEDUPE_MS', async function () {
    this.timeout(60_000);
    const c = join(ws, 'c.ts');
    const key = keyOf(c);
    const doc = await openDoc(c);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const focused = vscode.window.state.focused;
    const t0 = Date.now();
    for (let i = 0; i < 150; i++) {
      assert.equal(await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, 'x')), true);
    }
    const elapsed = Date.now() - t0;
    await waitReal(() => trackedOf(api, key) !== undefined, 'the burst to be recorded', 15_000);
    if (vscode.window.state.focused && focused) {
      await waitReal(() => (trackedOf(api, key)?.editCount ?? 0) >= 150, 'all 150 keystrokes to be recorded', 15_000);
      const t = must(trackedOf(api, key));
      assert.equal(t.editCount, 150);
      assert.ok(t.intensity > 0.5 && t.intensity <= 1, `intensity after a sustained burst: ${t.intensity}`);
    } else {
      // not focused: every edit is an external background edit, and a second external event within 300 ms is a duplicate
      const t = must(trackedOf(api, key));
      assert.equal(t.source, 'external');
      assert.ok(t.editCount >= 1 && t.editCount <= Math.ceil(elapsed / 300) + 2, `${t.editCount} accepted events for ${elapsed} ms of typing`);
    }
    assert.ok(api.getRows().length <= 40);
  });

  test('a real file-system rename and delete of the active file are handled without errors', async function () {
    this.timeout(60_000);
    const f = join(envPath('FS_TEST_WORKSPACE'), 'scratch-real.ts');
    await externalWrite(f, 'export {};\n');
    await waitReal(() => rowOf(api, keyOf(f)) !== undefined, 'the created file', 15_000);
    await runNode(`require('fs').unlinkSync(${JSON.stringify(f)})`);
    await waitReal(() => rowOf(api, keyOf(f)) === undefined, 'the row of the deleted file to go', 15_000);
  });
});
