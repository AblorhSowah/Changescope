// Activity history in real VS Code: attribution with method and confidence, coalescing, review state, pause and resume,
// development sessions (start, stop, rename, export), renames, persistence through the workspace Memento, clearHistory.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { createSettled, envPath, externalWrite, getApi, keyOf, logFor, must, openDoc, removePath, runNode, scratchDir, setConfig, settleRefs, testing, typeAndWait, typeInto, waitUntil, workspaceDir } from './helpers';
import { activeSession, dashboardState, eventsFor, externalChange, lastEventFor, occurrences, resetAll, resetHistory, run, send } from './helpers030';

const DAY = 24 * 60 * 60 * 1000;

suite('0.3.0 activity history, sessions and persistence (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const created: string[] = [];

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
    for (const d of created.splice(0)) removePath(d);
  });

  const scratch = (label: string): string => {
    const d = scratchDir(ws, label);
    created.push(d);
    return d;
  };
  const sessionReportText = async (id: string): Promise<string> => {
    const before = new Set(vscode.workspace.textDocuments);
    await run('fileShake.exportSessionReport', id);
    await waitUntil(api, () => vscode.workspace.textDocuments.some((d) => !before.has(d) && d.languageId === 'markdown'), 'the report document to open', 20_000);
    return must(vscode.workspace.textDocuments.find((d) => !before.has(d) && d.languageId === 'markdown')).getText();
  };

  suite('attribution', () => {
    test('your typing is Developer: focused-editor-edit, confidence 0.9, no review state', async function () {
      this.timeout(60_000);
      const file = join(ws, 'a.ts');
      await typeAndWait(api, await openDoc(file));
      const e = must(lastEventFor(api, keyOf(file)));
      assert.equal(e.sourceType, 'developer');
      assert.equal(e.detectionMethod, 'focused-editor-edit');
      assert.equal(e.confidence, 0.9);
      assert.equal(e.eventType, 'modify');
      assert.equal(e.reviewStatus, undefined);
      assert.equal(e.count, 1);
      assert.match(e.workspaceId, /^[\w.-]+$/, 'an opaque id, never a path');
    });

    test('a write by another process is External: disk-write, confidence 0.7, unreviewed; the dashboard row says the same', async function () {
      this.timeout(90_000);
      const dir = scratch('ext');
      const made = await createSettled(api, dir, { 'x.ts': 'export const x = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const file = must(made['x.ts']);
      const e = await externalChange(api, file, 'export const x = 2;\n');
      assert.equal(e.sourceType, 'external');
      assert.equal(e.detectionMethod, 'disk-write');
      assert.equal(e.confidence, 0.7);
      assert.equal(e.reviewStatus, 'unreviewed');
      const row = must(dashboardState(api).files.find((f) => f.id === keyOf(file)));
      assert.equal(row.source, 'external');
      assert.equal(row.method, 'disk-write');
      assert.equal(row.review, 'unreviewed');
      assert.equal(dashboardState(api).overview.unreviewed, 1);
    });

    test('rapid changes of one file by one source are one event; a gap beyond 5 s (fake clock) starts a new one', async function () {
      this.timeout(90_000);
      const made = await createSettled(api, scratch('coalesce'), { 'x.ts': 'export const x = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const file = must(made['x.ts']);
      const key = keyOf(file);
      await externalChange(api, file, 'export const x = 2;\n');
      testing(api).advance(400);
      await externalChange(api, file, 'export const x = 3;\n');
      testing(api).advance(400);
      await externalChange(api, file, 'export const x = 4;\n');
      assert.equal(eventsFor(api, key).length, 1, JSON.stringify(eventsFor(api, key)));
      assert.equal(occurrences(api, key), 3);
      testing(api).advance(6000);
      await externalChange(api, file, 'export const x = 5;\n');
      assert.equal(eventsFor(api, key).length, 2);
      assert.equal(dashboardState(api).files.find((f) => f.id === key)?.changes, 4, 'the per-file count adds up the occurrences');
    });

    test('create and delete by another process: event types, disk-delete method, the file is marked as gone', async function () {
      this.timeout(90_000);
      const dir = scratch('lifecycle');
      const file = join(dir, 'new.ts');
      const key = keyOf(file);
      await externalWrite(file, 'export const n = 1;\n');
      await waitUntil(api, () => eventsFor(api, key).length > 0, 'the create event', 60_000);
      assert.equal(must(lastEventFor(api, key)).eventType, 'create');
      testing(api).advance(6000);
      await runNode(`require('fs').rmSync(${JSON.stringify(file)})`);
      await waitUntil(api, () => lastEventFor(api, key)?.eventType === 'delete', 'the delete event', 60_000);
      const e = must(lastEventFor(api, key));
      assert.equal(e.sourceType, 'external');
      assert.equal(e.detectionMethod, 'disk-delete');
      const row = must(dashboardState(api).files.find((f) => f.id === key));
      assert.equal(row.exists, false);
      assert.equal(row.lastEventType, 'delete');
    });

    test('review state: markReviewed clears one file, a later change makes it unreviewed again, markAllReviewed clears all', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('review'), { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const a = must(made['a.ts']);
      const b = must(made['b.ts']);
      await externalChange(api, a, 'export const a = 2;\n');
      testing(api).advance(1000);
      await externalChange(api, b, 'export const b = 2;\n');
      assert.equal(dashboardState(api).overview.unreviewed, 2);
      send(api, { type: 'markReviewed', id: keyOf(a) });
      assert.equal(dashboardState(api).overview.unreviewed, 1);
      assert.equal(dashboardState(api).files.find((f) => f.id === keyOf(a))?.review, 'reviewed');
      testing(api).advance(1000);
      await externalChange(api, a, 'export const a = 3;\n');
      assert.equal(dashboardState(api).files.find((f) => f.id === keyOf(a))?.review, 'unreviewed', 'a change after the review needs a new review');
      assert.equal(dashboardState(api).overview.unreviewed, 2);
      await run('fileShake.markAllReviewed');
      assert.equal(dashboardState(api).overview.unreviewed, 0);
    });
  });

  suite('pause and resume', () => {
    test('while paused nothing is recorded (reason "paused" is logged), existing rows stay, and after resume tracking works again', async function () {
      this.timeout(90_000);
      const file = join(ws, 'a.ts');
      const key = keyOf(file);
      const doc = await openDoc(file);
      await typeAndWait(api, doc);
      const rowsBefore = api.getRows().length;
      const eventsBefore = api.getActivityEvents().length;
      await run('fileShake.pause');
      assert.equal(dashboardState(api).settings.paused, true);
      const loggedBefore = logFor(api, (e) => e.reason === 'paused').length;
      await typeInto(doc, ' ');
      await waitUntil(api, () => logFor(api, (e) => e.reason === 'paused').length > loggedBefore, 'the paused edit to be logged', 30_000);
      assert.equal(api.getActivityEvents().length, eventsBefore, 'no event while paused');
      assert.equal(occurrences(api, key), 1);
      assert.equal(api.getRows().length, rowsBefore, 'rows already on screen stay');
      await run('fileShake.resume');
      assert.equal(dashboardState(api).settings.paused, false);
      await typeAndWait(api, doc);
      assert.equal(occurrences(api, key), 2, 'recording is back');
    });

    test('the dashboard message and the two commands drive the same flag', async () => {
      send(api, { type: 'setPaused', value: true });
      assert.equal(dashboardState(api).settings.paused, true);
      await run('fileShake.resume');
      assert.equal(dashboardState(api).settings.paused, false);
      await run('fileShake.pause');
      assert.equal(dashboardState(api).settings.paused, true);
      send(api, { type: 'setPaused', value: false });
      assert.equal(dashboardState(api).settings.paused, false);
    });

    test('a storm of pause / resume toggles with an edit between each: exactly the edits made while running are recorded', async function () {
      this.timeout(180_000);
      const file = join(ws, 'a.ts');
      const key = keyOf(file);
      const doc = await openDoc(file);
      const loggedBefore = logFor(api, (e) => e.reason === 'paused').length;
      let running = 0;
      for (let i = 0; i < 12; i += 1) {
        await run('fileShake.pause');
        await typeInto(doc, ' ');
        await waitUntil(api, () => logFor(api, (e) => e.reason === 'paused').length >= loggedBefore + i + 1, `paused edit ${i + 1} to be logged`, 30_000);
        await run('fileShake.resume');
        await typeAndWait(api, doc);
        running += 1;
        assert.equal(occurrences(api, key), running, `after round ${i + 1}`);
      }
      assert.ok(logFor(api, (e) => e.reason === 'paused').length >= loggedBefore + 12, 'every paused edit was logged (VS Code may add one for the dirty-state change of the first edit)');
      assert.equal(dashboardState(api).settings.paused, false);
    });
  });

  suite('sessions', () => {
    test('start, collect, rename, stop: one active session, files and per-source counts, then completed with an end time', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('session'), { 'e.ts': 'export const e = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const ext = must(made['e.ts']);
      send(api, { type: 'sessionStart', title: '  Refactor\tthe  dashboard \u0000 ' });
      const s0 = must(activeSession(api));
      assert.equal(s0.title, 'Refactor the dashboard', 'the title is cleaned');
      assert.equal(s0.status, 'active');
      assert.equal(s0.activityCount, 0);
      const dev = join(ws, 'a.ts');
      await typeAndWait(api, await openDoc(dev));
      await externalChange(api, ext, 'export const e = 2;\n');
      const s1 = must(activeSession(api));
      assert.equal(s1.activityCount, 2);
      assert.deepEqual(s1.sources, { developer: 1, external: 1 });
      assert.deepEqual([...s1.modifiedFiles].sort(), [keyOf(dev), keyOf(ext)].sort());
      assert.equal(must(lastEventFor(api, keyOf(dev))).sessionId, s0.id);
      assert.equal(dashboardState(api).sessions.active?.title, 'Refactor the dashboard');
      assert.equal(dashboardState(api).files.find((f) => f.id === keyOf(dev))?.sessionTitle, 'Refactor the dashboard');
      assert.equal(dashboardState(api).overview.activeSessions, 1);

      send(api, { type: 'sessionRename', id: s0.id, title: 'Dashboard work' });
      assert.equal(must(activeSession(api)).title, 'Dashboard work');
      send(api, { type: 'sessionRename', id: s0.id, title: ' \u0007 ' });
      assert.equal(must(activeSession(api)).title, 'Dashboard work', 'an empty cleaned title is refused');

      testing(api).advance(5000);
      send(api, { type: 'sessionStop' });
      assert.equal(activeSession(api), undefined);
      const done = must(api.getSessions().find((s) => s.id === s0.id));
      assert.equal(done.status, 'completed');
      assert.ok(must(done.endedAt) >= done.startedAt + 5000);
      // after the stop a change is not part of the session
      testing(api).advance(6000);
      await typeAndWait(api, await openDoc(dev));
      assert.equal(must(api.getSessions().find((s) => s.id === s0.id)).activityCount, 2);
      assert.equal(must(lastEventFor(api, keyOf(dev))).sessionId, undefined);
    });

    test('an empty title gets the default "Session YYYY-MM-DD HH:mm"; starting a second session completes the first', async () => {
      send(api, { type: 'sessionStart', title: '' });
      const first = must(activeSession(api));
      assert.match(first.title, /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      testing(api).advance(1000);
      send(api, { type: 'sessionStart', title: 'Second' });
      const sessions = api.getSessions();
      assert.equal(sessions.filter((s) => s.status === 'active').length, 1);
      assert.equal(must(activeSession(api)).title, 'Second');
      assert.equal(must(sessions.find((s) => s.id === first.id)).status, 'completed');
    });

    test('the exported report has the title, times, counts and workspace-relative paths, and no absolute path and no file content', async function () {
      this.timeout(120_000);
      const secretContent = 'SUPER_SECRET_CONTENT_12345';
      const dir = scratch('report');
      const made = await createSettled(api, dir, { 'report-target.ts': `export const s = '${secretContent}';\n` });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const file = must(made['report-target.ts']);
      send(api, { type: 'sessionStart', title: 'Report session' });
      await externalChange(api, file, `export const s = '${secretContent}2';\n`);
      const id = must(activeSession(api)).id;
      send(api, { type: 'sessionStop' });
      const text = await sessionReportText(id);
      assert.match(text, /^# File Shake session report: Report session/);
      assert.match(text, /- Status: completed/);
      assert.match(text, /report-target\.ts/);
      assert.match(text, /\| External \| 1 \|/);
      assert.ok(text.includes(`${dir.slice(ws.length + 1)}/report-target.ts`), 'the path is relative to the workspace folder');
      assert.ok(!text.includes(ws), 'no absolute workspace path');
      assert.ok(!text.includes(envPath('FS_TEST_ROOT')), 'no absolute temp path');
      assert.ok(!text.includes(secretContent), 'no file content');
      assert.ok(!/(^|[^\w])\/(Users|private|tmp|home)\//.test(text), 'no absolute path of any kind');
    });

    test('[QA-101] the report of a session that touched a file OUTSIDE the workspace has no absolute path either', async function () {
      this.timeout(120_000);
      send(api, { type: 'sessionStart', title: 'Outside session' });
      const outside = join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');
      await typeAndWait(api, await openDoc(outside));
      const id = must(activeSession(api)).id;
      send(api, { type: 'sessionStop' });
      const text = await sessionReportText(id);
      assert.ok(text.includes('o1.ts'), 'the file is listed');
      assert.ok(!text.includes(envPath('FS_TEST_OUTSIDE')), `the report contains the absolute path of ${outside}`);
    });

    test('a session started in the middle of an external flood stays consistent: its numbers add up to the events that carry its id', async function () {
      this.timeout(180_000);
      const dir = scratch('flood');
      const dirKey = keyOf(dir);
      const files = Array.from({ length: 80 }, (_, i) => join(dir, `f${i}.ts`));
      const flood = runNode(`const fs=require('fs');for(const f of ${JSON.stringify(files)}){fs.writeFileSync(f,'export {};\\n');}`);
      await waitUntil(api, () => api.getEventLog().some((e) => e.key.startsWith(dirKey)), 'the first flood event', 60_000);
      send(api, { type: 'sessionStart', title: 'During the flood' });
      await flood;
      await waitUntil(api, () => api.getEventLog().filter((e) => e.key.startsWith(dirKey)).length >= 20, 'the flood to arrive', 60_000);
      testing(api).advance(2000);
      await settleRefs(api); // late flood events schedule reference work that only an advance runs
      const s = must(activeSession(api));
      const mine = api.getActivityEvents().filter((e) => e.sessionId === s.id);
      const total = mine.reduce((n, e) => n + e.count, 0);
      assert.equal(s.activityCount, total, 'activityCount equals the occurrences of the events that carry the session id');
      assert.equal(Object.values(s.sources).reduce((n, v) => n + (v ?? 0), 0), total, 'per-source counts add up');
      const eventFiles = new Set(mine.map((e) => e.filePath));
      for (const f of s.modifiedFiles) assert.ok(eventFiles.has(f), `${f} is listed but has no event with the session id`);
      assert.equal(api.getSessions().filter((x) => x.status === 'active').length, 1);
      for (const e of api.getActivityEvents()) assert.ok(e.sessionId === undefined || e.sessionId === s.id);
      assert.ok(api.getActivityEvents().some((e) => e.filePath.startsWith(dirKey)), 'the flood left events in the history (so the invariants above are not vacuous)');
    });

    test('renaming a file that has history and sits in an open session moves its history and its session entry; no delete or create is invented', async function () {
      this.timeout(120_000);
      const dir = scratch('rename');
      const made = await createSettled(api, dir, { 'old.ts': 'export const o = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      const oldFile = must(made['old.ts']);
      const newFile = join(dir, 'renamed.ts');
      send(api, { type: 'sessionStart', title: 'Rename session' });
      await typeAndWait(api, await openDoc(oldFile));
      assert.deepEqual(must(activeSession(api)).modifiedFiles, [keyOf(oldFile)]);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(oldFile), vscode.Uri.file(newFile));
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitUntil(api, () => eventsFor(api, keyOf(newFile)).length > 0, 'the history to follow the rename', 60_000);
      // let the watcher's delete/create echoes of the rename arrive before looking for invented events
      await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(newFile) && e.origin === 'watcher').length >= 1, 'the watcher echo of the rename', 30_000);
      assert.equal(eventsFor(api, keyOf(oldFile)).length, 0, 'nothing is left under the old name');
      const s = must(activeSession(api));
      assert.deepEqual(s.modifiedFiles, [keyOf(newFile)], 'the session lists the new name only');
      const kinds = api.getActivityEvents().filter((e) => e.filePath === keyOf(newFile) || e.filePath === keyOf(oldFile)).map((e) => e.eventType);
      assert.deepEqual(kinds, ['modify'], `a rename must not add create/delete events: ${JSON.stringify(api.getActivityEvents().filter((e) => e.filePath.startsWith(keyOf(dir))))}`);
      assert.equal(dashboardState(api).files.some((f) => f.id === keyOf(oldFile)), false);
      assert.ok(dashboardState(api).files.some((f) => f.id === keyOf(newFile)));
      // typing in the renamed file continues the same history and does not list the file twice
      testing(api).advance(1000);
      await typeAndWait(api, await openDoc(newFile));
      assert.deepEqual(must(activeSession(api)).modifiedFiles, [keyOf(newFile)]);
      assert.equal(must(activeSession(api)).activityCount, 2);
    });

    test('renaming a FOLDER re-keys everything below it, in the history and in the session', async function () {
      this.timeout(120_000);
      const base = scratch('folder-rename');
      const made = await createSettled(api, base, { 'dir/a.ts': 'export const a = 1;\n', 'dir/deep/b.ts': 'export const b = 1;\n' });
      await resetHistory(api); // the creation of the fixture files is history too: start clean
      send(api, { type: 'sessionStart', title: 'Folder session' });
      await typeAndWait(api, await openDoc(must(made['dir/a.ts'])));
      testing(api).advance(1000);
      await typeAndWait(api, await openDoc(must(made['dir/deep/b.ts'])));
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(join(base, 'dir')), vscode.Uri.file(join(base, 'moved')));
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      const wantA = keyOf(join(base, 'moved', 'a.ts'));
      const wantB = keyOf(join(base, 'moved', 'deep', 'b.ts'));
      await waitUntil(api, () => eventsFor(api, wantA).length > 0 && eventsFor(api, wantB).length > 0, 'both files to move', 60_000);
      assert.ok(!api.getActivityEvents().some((e) => e.filePath.startsWith(keyOf(join(base, 'dir')))), 'no event is left below the old folder');
      assert.deepEqual([...must(activeSession(api)).modifiedFiles].sort(), [wantA, wantB].sort());
    });
  });

  suite('persistence and clearing', () => {
    test('the history is written to the workspace Memento (schema 1, plain data) and a reload gives back the same events; a running session comes back completed', async function () {
      this.timeout(120_000);
      send(api, { type: 'sessionStart', title: 'Persisted' });
      const a = join(ws, 'a.ts');
      await typeAndWait(api, await openDoc(a));
      testing(api).advance(6000);
      await typeAndWait(api, await openDoc(a));
      await testing(api).flushHistory();
      const stored = testing(api).storedHistory() as { schema: number; savedAt: number; events: Array<{ filePath: string; workspaceId: string }>; sessions: Array<{ title: string }> };
      assert.equal(stored.schema, 1);
      assert.equal(typeof stored.savedAt, 'number');
      assert.equal(stored.events.length, 2);
      assert.equal(stored.sessions[0]?.title, 'Persisted');
      for (const e of stored.events) assert.match(e.workspaceId, /^[\w.-]+$/);
      const before = JSON.parse(JSON.stringify(api.getActivityEvents())) as unknown;
      await testing(api).reloadHistory();
      assert.deepEqual(JSON.parse(JSON.stringify(api.getActivityEvents())), before);
      assert.equal(activeSession(api), undefined, 'a session that was running when the window closed comes back completed');
      const s = must(api.getSessions().find((x) => x.title === 'Persisted'));
      assert.equal(s.status, 'completed');
      assert.ok(must(s.endedAt) >= s.startedAt);
      assert.equal(s.activityCount, 2);
    });

    test('writes are debounced on the injected scheduler: a burst of changes is one write, after 1000 ms', async function () {
      this.timeout(120_000);
      await testing(api).flushHistory();
      const writes = testing(api).historyWrites();
      const doc = await openDoc(join(ws, 'a.ts'));
      for (let i = 0; i < 5; i += 1) {
        await typeAndWait(api, doc);
        testing(api).advance(10);
      }
      assert.equal(testing(api).historyWrites(), writes, 'nothing is written yet');
      assert.ok(testing(api).pendingTimers() >= 1, 'the write is waiting on the scheduler');
      testing(api).advance(1000);
      assert.equal(testing(api).historyWrites(), writes + 1, 'one write for the whole burst');
    });

    test('history.persist off: the stored copy is deleted, nothing is written while off, and turning it on writes the history again', async function () {
      this.timeout(120_000);
      await typeAndWait(api, await openDoc(join(ws, 'a.ts')));
      await testing(api).flushHistory();
      assert.ok(testing(api).storedHistory() !== undefined);
      await setConfig('history.persist', false);
      await waitUntil(api, () => testing(api).storedHistory() === undefined, 'the stored history to be deleted', 20_000);
      const writes = testing(api).historyWrites();
      testing(api).advance(6000);
      await typeAndWait(api, await openDoc(join(ws, 'a.ts')));
      await testing(api).flushHistory();
      testing(api).advance(5000);
      assert.equal(testing(api).historyWrites(), writes, 'no write while history is memory only');
      assert.equal(testing(api).storedHistory(), undefined);
      assert.ok(occurrences(api, keyOf(join(ws, 'a.ts'))) >= 2, 'the history itself is still kept in memory');
      await setConfig('history.persist', true);
      await waitUntil(api, () => (testing(api).pendingTimers() > 0) || testing(api).storedHistory() !== undefined, 'a write to be scheduled', 20_000);
      await testing(api).flushHistory();
      assert.ok(testing(api).storedHistory() !== undefined);
    });

    test('clearHistory asks first: declining keeps everything, accepting clears events, completed sessions and the stored copy, and the running session stays (emptied)', async function () {
      this.timeout(120_000);
      send(api, { type: 'sessionStart', title: 'Old' });
      send(api, { type: 'sessionStop' });
      send(api, { type: 'sessionStart', title: 'Live' });
      await typeAndWait(api, await openDoc(join(ws, 'a.ts')));
      await testing(api).flushHistory();
      const asked: string[] = [];
      testing(api).overrideConfirm((message, action) => {
        asked.push(`${message} | ${action}`);
        return Promise.resolve(false);
      });
      await run('fileShake.clearHistory');
      assert.equal(asked.length, 1);
      assert.match(asked[0] ?? '', /Clear/);
      assert.ok(api.getActivityEvents().length > 0, 'declined: nothing cleared');
      assert.equal(api.getSessions().length, 2);
      send(api, { type: 'clearHistory' });
      assert.equal(asked.length, 2, 'the dashboard button goes through the same confirmation');
      assert.ok(api.getActivityEvents().length > 0);
      testing(api).overrideConfirm(() => Promise.resolve(true));
      send(api, { type: 'clearHistory' });
      await waitUntil(api, () => api.getActivityEvents().length === 0, 'the history to be cleared', 20_000);
      await waitUntil(api, () => testing(api).storedHistory() === undefined, 'the stored copy to be deleted', 20_000);
      const live = must(activeSession(api));
      assert.equal(live.title, 'Live');
      assert.equal(live.activityCount, 0);
      assert.deepEqual(live.modifiedFiles, []);
      assert.equal(api.getSessions().length, 1, 'the completed session is gone');
      assert.equal(dashboardState(api).overview.modifiedFiles, 0);
    });

    test('history.maxEvents applies live and keeps the NEWEST events; history.retentionDays prunes old ones', async function () {
      this.timeout(300_000);
      const file = join(ws, 'a.ts');
      const doc = await openDoc(file);
      for (let i = 0; i < 104; i += 1) {
        await typeAndWait(api, doc);
        testing(api).advance(6000);
      }
      assert.equal(api.getActivityEvents().length, 104);
      const newest = must(api.getActivityEvents().at(-1)).id;
      await setConfig('history.maxEvents', 100);
      await waitUntil(api, () => api.getActivityEvents().length === 100, 'the history to shrink to 100 events', 20_000);
      assert.equal(must(api.getActivityEvents().at(-1)).id, newest, 'the newest event is kept');
      testing(api).advance(3 * DAY);
      await setConfig('history.retentionDays', 1);
      await waitUntil(api, () => api.getActivityEvents().length === 0, 'events older than a day to be pruned', 20_000);
    });
  });
});
