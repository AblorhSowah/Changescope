// Dependency index, impact, related tests, collision warnings, sensitive files and Git, in real VS Code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { createSettled, externalWrite, getApi, keyOf, must, openDoc, removePath, resetConfig, runNode, rowOf, scratchDir, setConfig, settleRefs, testing, typeAndWait, typeInto, waitUntil, workspaceDir, writeFile } from './helpers';
import { dashboardState, eventsFor, externalChange, lastEventFor, resetAll, resetHistory, run, send } from './helpers030';

let touches = 0;

suite('0.3.0 dependency index, impact, collisions, sensitive files, Git (single-root workspace)', () => {
  let api: ChangescopeApi;
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

  const project = {
    'lib/util.ts': 'export const u = 1;\n',
    'app/a.ts': "import { u } from '../lib/util';\nu();\n",
    'app/b.ts': "import { u } from '../lib/util';\nu();\n",
    'app/c.ts': "import { u } from '../lib/util';\nu();\n",
    'app/d.ts': "import { a } from './a';\na();\n",
    'lib/util.test.ts': "import { u } from './util';\nu();\n",
    'secrets/keys.ts': "import { u } from '../lib/util';\nu();\n",
    'package.json': '{ "name": "scratch" }\n',
  };

  /** The project is written under the scratch folder, settled, and the history is emptied again. */
  const makeProject = async (label: string): Promise<{ dir: string; at: (rel: string) => string; key: (rel: string) => string }> => {
    const dir = scratch(label);
    const made = await createSettled(api, dir, project);
    // excluded paths are never tracked, so this one is written without waiting for the watcher to report it
    made['node_modules/dep/index.ts'] = writeFile(dir, 'node_modules/dep/index.ts', "import { u } from '../../lib/util';\nu();\n");
    await resetHistory(api);
    return { dir, at: (rel) => must(made[rel]), key: (rel) => keyOf(must(made[rel])) };
  };

  /** Puts `rel` into the history (so the dashboard may name it) and selects it. */
  const select = async (p: { at: (r: string) => string; key: (r: string) => string }, rel: string): Promise<void> => {
    if (!dashboardState(api).files.some((f) => f.id === p.key(rel))) {
      testing(api).advance(6000);
      await externalChange(api, p.at(rel), `${project[rel as keyof typeof project] ?? ''}// touched ${(touches += 1)}\n`);
    }
    send(api, { type: 'select', id: p.key(rel) });
    assert.equal(dashboardState(api).selection.file?.id, p.key(rel), `selected ${rel}`);
  };

  suite('dependency index', () => {
    test('the index does not start by itself: selecting a file and ordinary activity leave it idle, with no timers', async function () {
      this.timeout(120_000);
      const p = await makeProject('idx-idle');
      const before = dashboardState(api).index;
      assert.equal(before.state, 'idle');
      await select(p, 'app/a.ts');
      assert.equal(dashboardState(api).index.state, 'idle', 'select does not build it in test mode');
      assert.equal(dashboardState(api).selection.importedBy.length, 0, 'nothing is known yet, and nothing is invented');
      assert.equal(dashboardState(api).selection.impact, null);
      testing(api).advance(60_000);
      assert.equal(testing(api).pendingTimers(), 0);
      assert.equal(dashboardState(api).index.indexed, 0);
    });

    test('once built: reverse edges, relationship and test flag, impact with reasons, related tests, config files; excluded and sensitive files are not read', async function () {
      this.timeout(180_000);
      const p = await makeProject('idx-build');
      await testing(api).buildDependencyIndex();
      const status = dashboardState(api).index;
      assert.equal(status.state, 'ready');
      assert.ok(status.indexed >= 8, `indexed ${status.indexed}`);
      assert.equal(status.truncated, false);

      await select(p, 'lib/util.ts');
      const s = dashboardState(api);
      const importers = s.selection.importedBy.map((d) => d.id).sort();
      assert.deepEqual(importers, [p.key('app/a.ts'), p.key('app/b.ts'), p.key('app/c.ts'), p.key('lib/util.test.ts')].sort(), 'the four importers; not the sensitive secrets/ file, not node_modules');
      for (const d of s.selection.importedBy) {
        assert.equal(d.relationship, 'import');
        assert.equal(d.isTest, d.id === p.key('lib/util.test.ts'));
        assert.ok(!d.dir.startsWith('/'), 'display folder');
      }
      assert.deepEqual(s.selection.imports, [], 'util imports nothing');
      const impact = must(s.selection.impact);
      assert.equal(impact.direct, 4);
      assert.equal(impact.indirect, 1, 'd.ts imports a.ts which imports util');
      assert.equal(impact.level, 'medium');
      assert.ok(impact.reasons.includes('4 files import this file directly.'), impact.reasons.join(' | '));
      assert.ok(impact.reasons.includes('1 more file depends on it through other files (up to 3 levels).'), impact.reasons.join(' | '));
      assert.ok(impact.tests.some((t) => t.id === p.key('lib/util.test.ts')), 'the test that imports it is listed');
      assert.equal(impact.complete, true);
      assert.ok(!JSON.stringify(s).includes('SECRET'), 'no content');
      assert.ok(!s.selection.importedBy.some((d) => d.id.includes('/secrets/') || d.id.includes('/node_modules/')));

      await select(p, 'app/a.ts');
      assert.deepEqual(dashboardState(api).selection.imports.map((d) => [d.id, d.count]), [[p.key('lib/util.ts'), 2]], 'one statement and one use');
      assert.deepEqual(dashboardState(api).selection.importedBy.map((d) => d.id), [p.key('app/d.ts')]);

      await select(p, 'package.json');
      const cfg = must(dashboardState(api).selection.impact);
      assert.equal(cfg.level, 'critical');
      assert.equal(cfg.reasons[0], 'This is a project configuration file; changes can affect the whole workspace.');
      assert.deepEqual(cfg.configs.map((c) => c.id), [p.key('package.json')]);

      await select(p, 'app/c.ts');
      const leaf = must(dashboardState(api).selection.impact);
      assert.equal(leaf.level, 'low');
      assert.deepEqual(leaf.reasons, ['No dependants were found.']);
    });

    test('it is kept current one file at a time: an edit that drops an import, a deleted file and a new importer change the answer after the 500 ms debounce', async function () {
      this.timeout(180_000);
      const p = await makeProject('idx-incremental');
      await testing(api).buildDependencyIndex();
      const importersOfUtil = async (): Promise<string[]> => {
        await select(p, 'lib/util.ts');
        return dashboardState(api).selection.importedBy.map((d) => basename(d.id)).sort();
      };
      assert.deepEqual(await importersOfUtil(), ['a.ts', 'b.ts', 'c.ts', 'util.test.ts']);

      testing(api).advance(6000);
      await externalChange(api, p.at('app/b.ts'), '// the import is gone\n');
      testing(api).advance(600);
      await testing(api).dependencyIndexIdle();
      assert.deepEqual(await importersOfUtil(), ['a.ts', 'c.ts', 'util.test.ts'], 'b.ts was re-analysed');

      testing(api).advance(6000);
      await runNode(`require('fs').rmSync(${JSON.stringify(p.at('app/c.ts'))})`);
      await waitUntil(api, () => lastEventFor(api, p.key('app/c.ts'))?.eventType === 'delete', 'the delete event', 60_000);
      testing(api).advance(600);
      await testing(api).dependencyIndexIdle();
      assert.deepEqual(await importersOfUtil(), ['a.ts', 'util.test.ts'], 'c.ts was removed from the index');

      const added = join(p.dir, 'app', 'e.ts');
      await externalWrite(added, "import { u } from '../lib/util';\nu();\n");
      await waitUntil(api, () => eventsFor(api, keyOf(added)).length > 0, 'the create event', 60_000);
      testing(api).advance(600);
      await testing(api).dependencyIndexIdle();
      assert.deepEqual(await importersOfUtil(), ['a.ts', 'e.ts', 'util.test.ts'], 'a new importer appears without a full rescan');
      assert.equal(dashboardState(api).index.state, 'ready');
    });

    test('[QA-111] a file that is deleted and created again (a tool replacing it) keeps its importers in the index', async function () {
      this.timeout(180_000);
      const p = await makeProject('idx-recreate');
      await testing(api).buildDependencyIndex();
      await select(p, 'lib/util.ts');
      const names = (): string[] => dashboardState(api).selection.importedBy.map((d) => basename(d.id)).sort();
      assert.deepEqual(names(), ['a.ts', 'b.ts', 'c.ts', 'util.test.ts']);
      const util = p.at('lib/util.ts');
      testing(api).advance(6000);
      await runNode(`require('fs').rmSync(${JSON.stringify(util)})`);
      await waitUntil(api, () => lastEventFor(api, p.key('lib/util.ts'))?.eventType === 'delete', 'the delete event', 60_000);
      testing(api).advance(600);
      await testing(api).dependencyIndexIdle();
      testing(api).advance(6000);
      await externalWrite(util, 'export const u = 1;\n');
      await waitUntil(api, () => lastEventFor(api, p.key('lib/util.ts'))?.eventType === 'create', 'the create event', 60_000);
      testing(api).advance(600);
      await testing(api).dependencyIndexIdle();
      send(api, { type: 'select', id: p.key('lib/util.ts') });
      assert.deepEqual(names(), ['a.ts', 'b.ts', 'c.ts', 'util.test.ts'], 'the importers did not change, so the answer must not either');
    });

    test('dependencies.index = off: the state says so, and nothing is built', async function () {
      this.timeout(60_000);
      await setConfig('dependencies.index', 'off');
      await waitUntil(api, () => dashboardState(api).index.state === 'off', 'the index to be off', 20_000);
      assert.equal(dashboardState(api).settings.dependencyIndex, false);
      await testing(api).buildDependencyIndex();
      assert.equal(dashboardState(api).index.state, 'off');
      await resetConfig();
    });
  });

  suite('collision warnings', () => {
    const arm = (): { calls: Array<{ message: string; actions: readonly string[] }>; answer: { value: string | undefined } } => {
      const calls: Array<{ message: string; actions: readonly string[] }> = [];
      const answer: { value: string | undefined } = { value: 'Dismiss' };
      testing(api).overrideCollisionNotify((message, actions) => {
        calls.push({ message, actions });
        return Promise.resolve(answer.value);
      });
      return { calls, answer };
    };

    test('an external change to a file with unsaved edits warns once, names the file, offers Compare with Saved and Dismiss, and never touches the buffer', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('collide'), { 'c.ts': 'export const c = 1;\n' });
      const file = must(made['c.ts']);
      const { calls } = arm();
      const shownBefore = testing(api).collisionStats().shown; // the counter is cumulative over the whole launch
      const doc = await openDoc(file);
      await typeInto(doc, '// my unsaved edit\n');
      assert.equal(doc.isDirty, true);
      await externalWrite(file, 'export const c = 2; // changed by another program\n');
      await waitUntil(api, () => calls.length >= 1, 'the warning', 60_000);
      assert.equal(testing(api).collisionStats().shown, shownBefore + 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.message, 'c.ts was changed on disk while you have unsaved edits.');
      assert.deepEqual(calls[0]?.actions, ['Compare with Saved', 'Dismiss']);
      assert.equal(testing(api).collisionStats().last, 'c.ts was changed on disk while you have unsaved edits.');
      assert.equal(doc.isDirty, true, 'still dirty');
      assert.ok(doc.getText().includes('my unsaved edit'), 'the buffer was not reloaded or overwritten');
    });

    test('at most once per file per 30 s (fake clock), and again after that', async function () {
      this.timeout(180_000);
      const made = await createSettled(api, scratch('collide-rate'), { 'c.ts': 'export const c = 1;\n' });
      const file = must(made['c.ts']);
      const { calls } = arm();
      await typeInto(await openDoc(file), '// edit\n');
      await externalChange(api, file, 'export const c = 2;\n');
      await waitUntil(api, () => calls.length === 1, 'the first warning', 60_000);
      testing(api).advance(6000);
      await externalChange(api, file, 'export const c = 3;\n');
      testing(api).advance(20_000);
      await externalChange(api, file, 'export const c = 4;\n');
      assert.equal(calls.length, 1, 'quiet for 30 s');
      testing(api).advance(10_000);
      await externalChange(api, file, 'export const c = 5;\n');
      await waitUntil(api, () => calls.length === 2, 'the second warning after the quiet period', 60_000);
    });

    test('no warning when the document is clean, when the change is a delete, or when collisions.notify is off', async function () {
      this.timeout(180_000);
      const made = await createSettled(api, scratch('collide-none'), { 'clean.ts': 'export const a = 1;\n', 'del.ts': 'export const b = 1;\n', 'off.ts': 'export const c = 1;\n' });
      const { calls } = arm();
      const shownBefore = testing(api).collisionStats().shown;
      await openDoc(must(made['clean.ts']));
      await externalChange(api, must(made['clean.ts']), 'export const a = 2;\n');
      testing(api).advance(40_000);
      const del = must(made['del.ts']);
      await typeInto(await openDoc(del), '// dirty\n');
      await runNode(`require('fs').rmSync(${JSON.stringify(del)})`);
      await waitUntil(api, () => lastEventFor(api, keyOf(del))?.eventType === 'delete', 'the delete event', 60_000);
      testing(api).advance(40_000);
      await setConfig('collisions.notify', false);
      const off = must(made['off.ts']);
      await typeInto(await openDoc(off), '// dirty\n');
      await externalChange(api, off, 'export const c = 2;\n');
      testing(api).advance(40_000);
      assert.deepEqual(calls, [], 'no warning in any of the three cases');
      assert.equal(testing(api).collisionStats().shown, shownBefore);
    });

    test('choosing "Compare with Saved" shows the comparison; nothing is saved or reloaded by Changescope', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('collide-compare'), { 'c.ts': 'export const c = 1;\n' });
      const file = must(made['c.ts']);
      const { calls, answer } = arm();
      answer.value = 'Compare with Saved';
      const doc = await openDoc(file);
      await typeInto(doc, '// edit\n');
      await externalWrite(file, 'export const c = 9;\n');
      await waitUntil(api, () => calls.length === 1, 'the warning', 60_000);
      await waitUntil(api, () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextDiff), 'a diff editor to open', 30_000);
      assert.equal(doc.isDirty, true);
      assert.ok(doc.getText().includes('// edit'));
    });
  });

  suite('sensitive files', () => {
    test('their activity is listed by name, but they are never read for dependencies', async function () {
      this.timeout(120_000);
      const dir = scratch('sensitive');
      const made = await createSettled(api, dir, { '.env': 'TOKEN=SECRET_TOKEN_VALUE\n', 'secrets/token.txt': 'SECRET_TOKEN_VALUE\n', 'cert.pem': 'SECRET_TOKEN_VALUE\n', 'ok.ts': 'export const ok = 1;\n' });
      await resetHistory(api);
      for (const rel of ['.env', 'secrets/token.txt', 'cert.pem', 'ok.ts']) {
        testing(api).advance(6000);
        await externalChange(api, must(made[rel]), `${rel === 'ok.ts' ? 'export const ok = 2;' : 'SECRET_TOKEN_VALUE_2'}\n`);
      }
      const s = dashboardState(api);
      const names = s.timeline.map((t) => t.name);
      for (const n of ['.env', 'token.txt', 'cert.pem', 'ok.ts']) assert.ok(names.includes(n), `${n} is in the timeline by name`);
      assert.ok(!JSON.stringify(s).includes('SECRET_TOKEN_VALUE'), 'no file content anywhere in the state');
    });
  });

  suite('sensitive files in the Explorer view (ReferenceService) and case-insensitive matching (QA-109)', () => {
    const files = { 'lib/util.ts': 'export const u = 1;\n', 'app/normal.ts': "import { u } from '../lib/util';\nu();\n", 'secrets/keys.ts': "import { u } from '../lib/util';\nu();\n" };

    test('a source file that matches sensitiveGlobs is listed by name but its imports are never read: no yellow references; an ordinary file importing the same target does get them', async function () {
      this.timeout(180_000);
      const made = await createSettled(api, scratch('sens-refs'), files);
      const util = keyOf(must(made['lib/util.ts']));
      await typeAndWait(api, await openDoc(must(made['app/normal.ts'])));
      await settleRefs(api);
      await waitUntil(api, () => rowOf(api, util)?.role === 'referenced', 'the ordinary file to make util.ts yellow', 60_000);
      assert.equal(must(rowOf(api, util)).role, 'referenced');
      await vscode.commands.executeCommand('changescope.clear');
      testing(api).advance(60_000);
      assert.equal(rowOf(api, util), undefined, 'precondition: the rows are gone');

      const keys = must(made['secrets/keys.ts']);
      await typeAndWait(api, await openDoc(keys));
      await settleRefs(api);
      assert.equal(must(rowOf(api, keyOf(keys))).role, 'edited', 'the sensitive file is listed by name');
      assert.equal(rowOf(api, util), undefined, 'but its imports were not read, so util.ts is not shown as referenced');
      assert.equal(api.getRows().filter((r) => r.role === 'referenced').length, 0);
    });

    test('the match ignores case: Secrets/ and SECRETS/ folders, .ENV and CERT.PEM files are as sensitive as their lower-case forms', async function () {
      this.timeout(180_000);
      const dir = scratch('sens-case');
      const made = await createSettled(api, dir, { 'lib/util.ts': 'export const u = 1;\n', 'SECRETS/Upper.ts': "import { u } from '../lib/util';\nu();\n", '.ENV': 'A=1\n' });
      const util = keyOf(must(made['lib/util.ts']));
      await typeAndWait(api, await openDoc(must(made['SECRETS/Upper.ts'])));
      await settleRefs(api);
      assert.equal(must(rowOf(api, keyOf(must(made['SECRETS/Upper.ts'])))).role, 'edited');
      assert.equal(rowOf(api, util), undefined, 'SECRETS/Upper.ts was not read: util.ts is not referenced');
    });

    test('the dependency index matches sensitiveGlobs in any case too: an importer in SECRETS/ is not read, so it is not listed as an importer (QA-109)', async function () {
      this.timeout(180_000);
      // a different project from the other tests on purpose: on a case-insensitive file system (macOS, Windows) SECRETS/ and secrets/ are one folder
      const dir = scratch('sens-index-case');
      const files = { 'lib/util.ts': 'export const u = 1;\n', 'app/normal.ts': "import { u } from '../lib/util';\nu();\n", 'SECRETS/Upper.ts': "import { u } from '../lib/util';\nu();\n", 'Keys/CERT.PEM': 'SECRET\n' };
      const made = await createSettled(api, dir, files);
      await testing(api).buildDependencyIndex();
      assert.equal(dashboardState(api).index.state, 'ready');
      const util = keyOf(must(made['lib/util.ts']));
      testing(api).advance(6000);
      await externalChange(api, must(made['lib/util.ts']), 'export const u = 1;\n// touched\n');
      send(api, { type: 'select', id: util });
      const s = dashboardState(api);
      assert.equal(s.selection.file?.id, util);
      assert.deepEqual(
        s.selection.importedBy.map((d) => d.id),
        [keyOf(must(made['app/normal.ts']))],
        'only the ordinary importer: SECRETS/Upper.ts matches **/secrets/** in any case',
      );
    });

    test('changing sensitiveGlobs re-analyses: with the list emptied the same file DOES make util.ts yellow, and restoring the default hides it again', async function () {
      this.timeout(180_000);
      const made = await createSettled(api, scratch('sens-toggle'), files);
      const util = keyOf(must(made['lib/util.ts']));
      const keys = must(made['secrets/keys.ts']);
      await setConfig('sensitiveGlobs', []);
      await typeAndWait(api, await openDoc(keys));
      await settleRefs(api);
      await waitUntil(api, () => rowOf(api, util)?.role === 'referenced', 'util.ts to be referenced once nothing is sensitive', 60_000);
      await resetConfig();
      await waitUntil(api, () => rowOf(api, util) === undefined || rowOf(api, util)?.role !== 'referenced', 'the references to disappear again under the default globs', 60_000);
    });
  });

  suite('Git', () => {
    const gitConfig = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('git');

    test('with the built-in Git extension disabled (the test host sets git.enabled false) Changescope says so and keeps working; sessions have no Git context', async function () {
      this.timeout(60_000);
      const g = dashboardState(api).git;
      assert.equal(g.state, 'unavailable');
      assert.match(g.detail, /git|Git/);
      assert.deepEqual(g.repos, []);
      send(api, { type: 'sessionStart', title: 'No git here' });
      const s = must(api.getSessions().find((x) => x.status === 'active'));
      assert.equal(s.gitStart, undefined);
      assert.equal(dashboardState(api).sessions.active?.branch, null);
    });

    test('changescope.git.enabled = false turns the section off with that reason; turning it on again goes back to looking', async function () {
      this.timeout(60_000);
      await setConfig('git.enabled', false);
      await waitUntil(api, () => dashboardState(api).git.state === 'disabled', 'git to be disabled', 20_000);
      assert.match(dashboardState(api).git.detail, /changescope\.git\.enabled/);
      assert.equal(dashboardState(api).settings.gitEnabled, false);
      await setConfig('git.enabled', true);
      await waitUntil(api, () => dashboardState(api).git.state !== 'disabled', 'git to be looked for again', 20_000);
      assert.equal(dashboardState(api).settings.gitEnabled, true);
    });

    test('with Git available: branch, short commit, staged / changes / untracked lists, the 200 cap, and a branch switch relabels the files it rewrote as "Git" (skipped with the reason when the Git extension cannot be used here)', async function () {
      this.timeout(300_000);
      if (vscode.extensions.getExtension('vscode.git') === undefined) {
        // the integration launcher starts VS Code with --disable-extensions, which also removes the built-in Git extension;
        // the installed-vsix launch (FS_INSTALLED_VSIX) does not, and runs this test
        console.log('[83-intelligence] SKIPPED Git lists: the built-in Git extension (vscode.git) is not loaded in this launch.');
        return this.skip();
      }
      const dir = scratch('gitrepo');
      const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-C', dir, ...args], { encoding: 'utf8' });
      try {
        git('init');
        writeFileSync(join(dir, 'a.txt'), 'one\n');
        writeFileSync(join(dir, 'f.txt'), 'main\n');
        git('add', '.');
        git('commit', '-m', 'first');
      } catch {
        return this.skip();
      }
      git('checkout', '-b', 'feature');
      writeFileSync(join(dir, 'f.txt'), 'feature\n');
      git('commit', '-am', 'feature change');
      git('checkout', '-');
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const commit = git('rev-parse', 'HEAD').trim();
      await gitConfig().update('enabled', true, vscode.ConfigurationTarget.Global);
      try {
        await waitUntil(api, () => dashboardState(api).git.state !== 'disabled' && dashboardState(api).git.state !== 'loading', 'the Git service to settle', 60_000);
        let hasCommand = false;
        const checkCommand = async (): Promise<void> => {
          hasCommand = (await vscode.commands.getCommands(true)).includes('git.openRepository');
        };
        try {
          await waitUntil(api, () => {
            void checkCommand();
            return hasCommand;
          }, 'the Git extension to register its commands', 20_000);
        } catch {
          console.log(`[83-intelligence] SKIPPED Git lists: the Git extension registered no commands in this launch (Changescope reports: ${dashboardState(api).git.state}, "${dashboardState(api).git.detail}").`);
          return this.skip();
        }
        await vscode.commands.executeCommand('git.openRepository', dir);
        try {
          await waitUntil(api, () => dashboardState(api).git.repos.some((r) => r.id === keyOf(dir)), 'the repository to appear in the dashboard', 30_000);
        } catch {
          console.log(`[83-intelligence] SKIPPED Git lists: the repository did not appear (Changescope reports: ${dashboardState(api).git.state}, "${dashboardState(api).git.detail}").`);
          return this.skip();
        }
        const repo = must(dashboardState(api).git.repos.find((r) => r.id === keyOf(dir)));
        assert.equal(repo.branch, branch);
        assert.equal(repo.commit, commit.slice(0, 7), 'a short commit id');
        assert.equal(repo.ahead, 0);
        assert.equal(repo.behind, 0);

        // lists
        writeFileSync(join(dir, 'a.txt'), 'two\n'); // unstaged modification
        writeFileSync(join(dir, 'staged.txt'), 'new\n');
        git('add', 'staged.txt'); // staged addition
        writeFileSync(join(dir, 'untracked.txt'), 'u\n');
        await waitUntil(api, () => {
          const r = dashboardState(api).git.repos.find((x) => x.id === keyOf(dir));
          return r !== undefined && r.staged.length === 1 && r.unstaged.length === 1 && r.untracked.length === 1;
        }, 'the three lists to fill', 60_000);
        const lists = must(dashboardState(api).git.repos.find((x) => x.id === keyOf(dir)));
        assert.deepEqual(lists.staged.map((c) => [c.name, c.status]), [['staged.txt', 'added']]);
        assert.deepEqual(lists.unstaged.map((c) => [c.name, c.status]), [['a.txt', 'modified']]);
        assert.deepEqual(lists.untracked.map((c) => [c.name, c.status]), [['untracked.txt', 'untracked']]);
        for (const c of [...lists.staged, ...lists.unstaged, ...lists.untracked]) assert.ok(!c.dir.startsWith('/'));

        // a huge number of changes is cut at 200 per list and says so
        const many = Array.from({ length: 330 }, (_, i) => join(dir, 'bulk', `u${i}.txt`));
        mkdirSync(join(dir, 'bulk'));
        for (const f of many) writeFileSync(f, 'x\n');
        await waitUntil(api, () => {
          const r = dashboardState(api).git.repos.find((x) => x.id === keyOf(dir));
          return r !== undefined && r.untracked.length === 200;
        }, 'the untracked list to be capped at 200', 90_000);
        const capped = must(dashboardState(api).git.repos.find((x) => x.id === keyOf(dir)));
        assert.equal(capped.untracked.length, 200);
        assert.equal(capped.truncated, true);
        assert.ok(JSON.stringify(dashboardState(api)).length < 400_000, 'the state stays small');
        rmSync(join(dir, 'bulk'), { recursive: true, force: true });
        git('checkout', '--', 'a.txt');
        git('reset', '-q');
        rmSync(join(dir, 'staged.txt'), { force: true });
        rmSync(join(dir, 'untracked.txt'), { force: true });
        await waitUntil(api, () => {
          const r = dashboardState(api).git.repos.find((x) => x.id === keyOf(dir));
          return r !== undefined && r.staged.length + r.unstaged.length + r.untracked.length === 0;
        }, 'the repository to be clean again', 90_000);

        // switching branch rewrites f.txt: the change coincides with a head change, so it is attributed to Git
        await resetHistory(api);
        git('checkout', 'feature');
        await waitUntil(api, () => lastEventFor(api, keyOf(join(dir, 'f.txt')))?.sourceType === 'git', 'f.txt to be attributed to a Git state change', 60_000);
        const e = must(lastEventFor(api, keyOf(join(dir, 'f.txt'))));
        assert.equal(e.detectionMethod, 'git-state-change');
        assert.equal(e.confidence, 0.8);
        assert.equal(dashboardState(api).files.find((f) => f.id === e.filePath)?.source, 'git');
        assert.match(must(dashboardState(api).git.repos.find((x) => x.id === keyOf(dir))).branch ?? '', /feature/);
      } finally {
        await gitConfig().update('enabled', false, vscode.ConfigurationTarget.Global);
        await run('changescope.resume');
      }
    });
  });
});
