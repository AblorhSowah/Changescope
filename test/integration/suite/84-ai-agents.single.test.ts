// AI foundation and agent adapters in real VS Code: local mode sends nothing, assisted mode needs a registered provider
// and consent, a failing provider falls back to local, requests carry no sensitive files, no absolute paths and no
// contents; the agent signal file and reportAgentActivity label changes as AI agent only when told.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { createSettled, envPath, getApi, keyOf, must, openDoc, removePath, scratchDir, setConfig, testing, typeAndWait, waitUntil, workspaceDir, warmScratchPool } from './helpers';
import { activeSession, dashboardState, externalChange, lastEventFor, mockProvider, resetAll, resetHistory, run, send, summarizeNow } from './helpers030';

suite('0.3.0 AI foundation and agent adapters (single-root workspace)', () => {
  let api: ChangescopeApi;
  const ws = workspaceDir();
  const created: string[] = [];
  const handles: Array<{ dispose(): void }> = [];
  const prompts: Array<{ message: string; detail: string }> = [];
  let answer: string | undefined = 'Allow';

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await warmScratchPool(api, ws);
    await resetAll(api);
    prompts.length = 0;
    answer = 'Allow';
    testing(api).overrideConsentPrompt((message, detail) => {
      prompts.push({ message, detail });
      return Promise.resolve(answer);
    });
    await run('changescope.ai.resetConsent');
  });

  teardown(async function () {
    this.timeout(60_000);
    for (const h of handles.splice(0)) h.dispose();
    await resetAll(api);
    await run('changescope.ai.resetConsent');
    for (const d of created.splice(0)) removePath(d);
  });

  const scratch = (label: string): string => {
    const d = scratchDir(ws, label);
    created.push(d);
    return d;
  };

  const assisted = async (id = 'acme.test'): Promise<void> => {
    await setConfig('ai.mode', 'assisted');
    await setConfig('ai.provider', id);
    await waitUntil(api, () => dashboardState(api).settings.aiMode === 'assisted', 'assisted mode to apply', 20_000);
  };

  /** A history with a normal file, sensitive files and an outside file, so a request has something to carry. */
  const seedHistory = async (): Promise<void> => {
    const dir = scratch('ai-seed');
    const made = await createSettled(api, dir, { 'ok.ts': 'export const ok = 1;\n', '.env': 'SECRET_VALUE_1\n', 'secrets/token.txt': 'SECRET_VALUE_1\n', 'cert.pem': 'SECRET_VALUE_1\n', 'server.key': 'SECRET_VALUE_1\n' });
    await resetHistory(api);
    for (const rel of ['ok.ts', '.env', 'secrets/token.txt', 'cert.pem', 'server.key']) {
      testing(api).advance(6000);
      await externalChange(api, must(made[rel]), rel === 'ok.ts' ? 'export const ok = 2;\n' : 'SECRET_VALUE_2\n');
    }
  };

  suite('summaries and the consent gate', () => {
    test('local mode (the default) builds the summary on this machine: a registered provider is never called and nobody is asked', async function () {
      this.timeout(90_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await setConfig('ai.provider', 'acme.test'); // a provider is chosen, but the mode is still local
      await seedHistory();
      const summary = await summarizeNow(api);
      assert.equal(summary.provider, 'local');
      assert.match(summary.text, /files? changed/);
      assert.equal(mock.calls.length, 0);
      assert.equal(prompts.length, 0);
      assert.equal(dashboardState(api).settings.aiMode, 'local');
      assert.equal(dashboardState(api).settings.aiProvider, null, 'no provider is "in use" in local mode');
    });

    test('assisted mode with no registered provider of that id: local summary, no prompt', async function () {
      this.timeout(90_000);
      await assisted('acme.missing');
      await seedHistory();
      const summary = await summarizeNow(api);
      assert.equal(summary.provider, 'local');
      assert.equal(prompts.length, 0, 'nothing to consent to');
      assert.equal(dashboardState(api).settings.aiProvider, null);
    });

    test('assisted mode with an empty provider setting: local summary', async function () {
      this.timeout(90_000);
      handles.push(api.registerAiProvider(mockProvider().provider));
      await setConfig('ai.mode', 'assisted');
      await seedHistory();
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal(prompts.length, 0);
    });

    test('assisted + provider: consent is asked ONCE per provider, the dialog names the provider and lists what is sent, and the answer is used', async function () {
      this.timeout(120_000);
      const mock = mockProvider('acme.test', 'Acme Test');
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      const first = await summarizeNow(api);
      assert.equal(first.provider, 'acme.test');
      assert.equal(first.text, 'Provider summary.');
      assert.equal(mock.calls.length, 1);
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0]?.message.includes('Acme Test') && prompts[0]?.message.includes('acme.test'));
      assert.match(prompts[0]?.detail ?? '', /File contents are never sent/);
      assert.match(prompts[0]?.detail ?? '', /Workspace-relative paths/);
      assert.match(prompts[0]?.detail ?? '', /this workspace only/);
      assert.equal(dashboardState(api).settings.aiProvider, 'acme.test');
      const second = await summarizeNow(api);
      assert.equal(second.provider, 'acme.test');
      assert.equal(prompts.length, 1, 'asked once');
      assert.equal(mock.calls.length, 2);
    });

    test('declining is remembered (local summary, never sent, not asked again) until the consent is reset', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      answer = "Don't Allow";
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal(prompts.length, 1);
      assert.equal(mock.calls.length, 0, 'never sent');
      await run('changescope.ai.resetConsent');
      answer = 'Allow';
      assert.equal((await summarizeNow(api)).provider, 'acme.test');
      assert.equal(prompts.length, 2, 'asked again after the reset');
      assert.equal(mock.calls.length, 1);
    });

    test('dismissing the dialog sends nothing and asks again next time', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      answer = undefined;
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal(prompts.length, 2);
      assert.equal(mock.calls.length, 0);
    });

    test('a provider that throws, rejects, answers nothing or answers a non-string falls back to the local summary', async function () {
      this.timeout(180_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      const answers: Array<[string, (() => Promise<string>)]> = [
        ['rejects', () => Promise.reject(new Error('the provider is down'))],
        ['throws', () => { throw new Error('sync failure'); }],
        ['empty', () => Promise.resolve('   ')],
        ['not a string', () => Promise.resolve(42 as unknown as string)],
      ];
      for (const [name, fn] of answers) {
        mock.setAnswer(fn);
        const summary = await summarizeNow(api);
        assert.equal(summary.provider, 'local', name);
        assert.match(summary.text, /files? changed/, name);
      }
      mock.setAnswer(() => Promise.resolve('Fine again.'));
      assert.equal((await summarizeNow(api)).provider, 'acme.test', 'and it recovers');
    });

    test('a provider that never answers is abandoned after 30 s (fake clock) and the local summary is used', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      mock.setAnswer(() => new Promise<string>(() => undefined));
      testing(api).advance(1);
      const before = dashboardState(api).summary?.at ?? -1;
      send(api, { type: 'summarize' });
      await waitUntil(api, () => mock.calls.length === 1 && testing(api).pendingTimers() >= 1, 'the provider to be asked and the timeout armed', 30_000);
      testing(api).advance(30_000);
      await waitUntil(api, () => (dashboardState(api).summary?.at ?? -1) > before, 'the fallback summary', 30_000);
      assert.equal(dashboardState(api).summary?.provider, 'local');
      await waitUntil(api, () => testing(api).pendingTimers() === 0, 'no timer left', 15_000);
    });

    test('disposing the provider handle unregisters it; registering an invalid provider is refused', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      const handle = api.registerAiProvider(mock.provider);
      await assisted();
      await seedHistory();
      assert.equal((await summarizeNow(api)).provider, 'acme.test');
      handle.dispose();
      assert.equal((await summarizeNow(api)).provider, 'local');
      assert.equal(await handle.getKey(), undefined, 'no key was stored for it');
      assert.throws(() => api.registerAiProvider({ id: 'no spaces allowed', label: 'x', summarize: () => Promise.resolve('') }), TypeError);
      assert.throws(() => api.registerAiProvider({ id: 'ok', label: '', summarize: () => Promise.resolve('') }), TypeError);
      assert.throws(() => api.registerAiProvider({ id: 'ok' } as never), TypeError);
    });
  });

  suite('what a request contains', () => {
    test('metadata only: no source flag set, no sensitive file, nothing but display paths, counts and labels', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await seedHistory();
      send(api, { type: 'sessionStart', title: 'Request session' });
      await summarizeNow(api);
      const req = must(mock.calls[0]);
      assert.equal(req.includesSource, false);
      assert.ok(['changes', 'session', 'impact'].includes(req.kind));
      assert.equal(req.kind, 'session', 'a session is running');
      const paths = req.metadata.files.map((f) => f.path);
      assert.ok(paths.some((p) => p.endsWith('ok.ts')), `ok.ts is there: ${paths.join(', ')}`);
      for (const secret of ['.env', 'token.txt', 'secrets', 'cert.pem', 'server.key']) assert.ok(!paths.some((p) => p.includes(secret)), `${secret} must not be sent`);
      assert.ok(req.metadata.files.length <= 100);
      for (const f of req.metadata.files) assert.deepEqual(Object.keys(f).sort(), ['changes', 'eventType', 'path', 'source']);
      const wire = JSON.stringify(req);
      assert.ok(!wire.includes('SECRET_VALUE'), 'no file content');
      assert.ok(!wire.includes(ws), 'no absolute workspace path');
      assert.ok(!wire.includes(envPath('FS_TEST_ROOT')), 'no absolute temp path');
      assert.deepEqual(Object.keys(req.metadata).sort(), ['bySource', 'files', 'session'].sort());
      assert.equal(req.metadata.session?.title, 'Request session');
      const counted = Object.values(req.metadata.bySource).reduce((a, b) => a + b, 0);
      assert.equal(counted, 1, 'sensitive files are not even counted');
      assert.equal(req.metadata.bySource.external, 1);
    });

    test('[QA-109] sensitive globs match whatever the case: Secrets/, .ENV and CERT.PEM are not sent either', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      const dir = scratch('ai-case');
      const made = await createSettled(api, dir, { 'ok.ts': 'export const ok = 1;\n', 'Secrets/token.txt': 'SECRET_VALUE_1\n', '.ENV': 'SECRET_VALUE_1\n', 'CERT.PEM': 'SECRET_VALUE_1\n', 'ID_RSA': 'SECRET_VALUE_1\n' });
      await resetHistory(api);
      for (const rel of ['ok.ts', 'Secrets/token.txt', '.ENV', 'CERT.PEM', 'ID_RSA']) {
        testing(api).advance(6000);
        await externalChange(api, must(made[rel]), rel === 'ok.ts' ? 'export const ok = 2;\n' : 'SECRET_VALUE_2\n');
      }
      await summarizeNow(api);
      const paths = must(mock.calls[0]).metadata.files.map((f) => f.path);
      assert.ok(paths.some((p) => p.endsWith('ok.ts')), paths.join(', '));
      for (const secret of ['Secrets', 'token.txt', '.ENV', 'CERT.PEM', 'ID_RSA']) assert.ok(!paths.some((p) => p.includes(secret)), `${secret} must not be sent: ${paths.join(', ')}`);
      assert.equal(Object.values(must(mock.calls[0]).metadata.bySource).reduce((a, b) => a + b, 0), 1, 'and they are not even counted');
    });

    test('[QA-101] a file outside the workspace is sent as a display path, not as an absolute path', async function () {
      this.timeout(120_000);
      const mock = mockProvider();
      handles.push(api.registerAiProvider(mock.provider));
      await assisted();
      await typeAndWait(api, await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts')));
      await summarizeNow(api);
      const req = must(mock.calls[0]);
      assert.ok(req.metadata.files.some((f) => f.path.endsWith('o1.ts')), 'the outside file is listed');
      assert.ok(!JSON.stringify(req).includes(envPath('FS_TEST_OUTSIDE')), `the request contains the absolute path: ${JSON.stringify(req.metadata.files.map((f) => f.path))}`);
      for (const f of req.metadata.files) assert.ok(!f.path.startsWith('/'), `absolute path in the request: ${f.path}`);
    });
  });

  suite('agent signal file (experimental)', () => {
    const lineFor = (file: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ agent: 'claude-code', file, ...extra })}\n`;
    const adapter = (): { state: string; detail: string } => must(dashboardState(api).agents.find((a) => a.id === 'signal-file'));

    const enable = async (): Promise<string> => {
      await setConfig('experimental.agentSignals', true);
      await waitUntil(api, () => adapter().state === 'listening', 'the signal file adapter to listen', 30_000);
      return must(testing(api).agentSignalPath());
    };

    test('adapters are listed with their states; the signal file is off by default and says how to turn it on; the API adapter always listens', () => {
      const agents = dashboardState(api).agents;
      assert.deepEqual(agents.map((a) => [a.id, a.state]).sort(), [['api', 'listening'], ['signal-file', 'off']]);
      assert.match(adapter().detail, /experimental\.agentSignals/);
    });

    test('turned on, it listens to a file in workspace storage (not in the workspace); a line for a file labels that file\'s next change "AI agent"', async function () {
      this.timeout(120_000);
      const path = await enable();
      assert.ok(path.endsWith('agent-events.jsonl'));
      assert.ok(!path.startsWith(ws), 'the signal file is not inside the workspace folder');
      const made = await createSettled(api, scratch('signal'), { 'w.ts': 'export const w = 1;\n' });
      await resetHistory(api);
      const file = must(made['w.ts']);
      appendFileSync(path, lineFor(file, { session: 'sess-1' }));
      const e = await externalChange(api, file, 'export const w = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(file))?.sourceType === 'ai-agent', 'the change to be attributed to the agent', 30_000);
      const labelled = must(lastEventFor(api, keyOf(file)));
      assert.equal(labelled.sourceId, 'claude-code');
      assert.equal(labelled.detectionMethod, 'agent-signal');
      assert.equal(labelled.confidence, 0.95);
      assert.equal(e.id, labelled.id, 'the same event was re-labelled, not duplicated');
      assert.equal(dashboardState(api).files.find((f) => f.id === keyOf(file))?.source, 'ai-agent');
      assert.equal(dashboardState(api).overview.bySource['ai-agent'], 1);
    });

    test('a line that arrives AFTER the change re-labels it (hints may come late), per-session counts follow', async function () {
      this.timeout(120_000);
      const path = await enable();
      const made = await createSettled(api, scratch('signal-late'), { 'w.ts': 'export const w = 1;\n' });
      await resetHistory(api);
      const file = must(made['w.ts']);
      send(api, { type: 'sessionStart', title: 'Agent session' });
      await externalChange(api, file, 'export const w = 2;\n');
      assert.equal(must(lastEventFor(api, keyOf(file))).sourceType, 'external');
      assert.deepEqual(must(activeSession(api)).sources, { external: 1 });
      appendFileSync(path, lineFor(file));
      await waitUntil(api, () => lastEventFor(api, keyOf(file))?.sourceType === 'ai-agent', 'the late line to re-label the change', 30_000);
      assert.deepEqual(must(activeSession(api)).sources, { 'ai-agent': 1 }, 'the session counts moved with the label');
    });

    test('malformed, oversized and partial lines are skipped without harm; a valid line after them still works; a partial line waits for its end', async function () {
      this.timeout(150_000);
      const path = await enable();
      const made = await createSettled(api, scratch('signal-junk'), { 'w.ts': 'export const w = 1;\n', 'x.ts': 'export const x = 1;\n' });
      await resetHistory(api);
      const w = must(made['w.ts']);
      const x = must(made['x.ts']);
      appendFileSync(path, 'not json at all\n{"agent":\n[]\n{"agent":"x"}\n{"file":"/abs/only/file.ts"}\n');
      appendFileSync(path, `${JSON.stringify({ agent: 'rel', file: 'relative/path.ts' })}\n`);
      appendFileSync(path, `${JSON.stringify({ agent: 'big', file: w, pad: 'p'.repeat(6000) })}\n`);
      // the first half of a valid line, no newline yet
      const full = lineFor(x);
      appendFileSync(path, full.slice(0, 25));
      await externalChange(api, w, 'export const w = 2;\n');
      await externalChange(api, x, 'export const x = 2;\n');
      testing(api).advance(500);
      assert.equal(must(lastEventFor(api, keyOf(w))).sourceType, 'external', 'the oversized line named w.ts but was skipped');
      assert.equal(must(lastEventFor(api, keyOf(x))).sourceType, 'external', 'half a line is not a report');
      appendFileSync(path, full.slice(25));
      await waitUntil(api, () => lastEventFor(api, keyOf(x))?.sourceType === 'ai-agent', 'the completed line to apply', 30_000);
      assert.equal(must(lastEventFor(api, keyOf(x))).sourceId, 'claude-code');
      assert.equal(must(lastEventFor(api, keyOf(w))).sourceType, 'external');
    });

    test('a signal file that is emptied while Changescope runs is read again from the start', async function () {
      this.timeout(150_000);
      const path = await enable();
      const made = await createSettled(api, scratch('signal-trunc'), { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
      await resetHistory(api);
      const a = must(made['a.ts']);
      const b = must(made['b.ts']);
      // a long first line, so that whatever is written after the emptying is SHORTER than what has been read: the
      // emptying is then detectable at any timing (a longer refill is the next test)
      appendFileSync(path, lineFor(a, { pad: 'p'.repeat(300) }));
      await externalChange(api, a, 'export const a = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(a))?.sourceType === 'ai-agent', 'the first line to be read', 30_000);
      writeFileSync(path, '');
      testing(api).advance(6000);
      appendFileSync(path, lineFor(b));
      await externalChange(api, b, 'export const b = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(b))?.sourceType === 'ai-agent', 'the line after the truncation to be read', 30_000);
    });

    test('[QA-110] a signal file that is emptied and refilled with a LONGER line than before is still read from the start', async function () {
      this.timeout(150_000);
      const path = await enable();
      const made = await createSettled(api, scratch('signal-refill'), { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
      await resetHistory(api);
      const a = must(made['a.ts']);
      const b = must(made['b.ts']);
      appendFileSync(path, lineFor(a));
      await externalChange(api, a, 'export const a = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(a))?.sourceType === 'ai-agent', 'the first line to be read', 30_000);
      const size = statSync(path).size;
      testing(api).advance(6000);
      // emptied and refilled in one go with a line longer than everything read so far: the stored offset is now inside the new line
      writeFileSync(path, lineFor(b, { session: 's'.repeat(Math.min(100, size + 20)), note: 'n'.repeat(size + 40) }));
      await externalChange(api, b, 'export const b = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(b))?.sourceType === 'ai-agent', 'the refilled file to be read from its start', 30_000);
    });

    test('Changescope empties the file once it passes 1 MB, and keeps reading afterwards', async function () {
      this.timeout(180_000);
      const path = await enable();
      const made = await createSettled(api, scratch('signal-big'), { 'a.ts': 'export const a = 1;\n' });
      await resetHistory(api);
      const a = must(made['a.ts']);
      const filler = `${JSON.stringify({ agent: 'filler', file: '/nowhere/filler.ts', pad: 'f'.repeat(1000) })}\n`;
      appendFileSync(path, filler.repeat(1100));
      assert.ok(statSync(path).size > 1024 * 1024);
      await waitUntil(api, () => statSync(path).size < 1024 * 1024, 'the oversized file to be emptied by Changescope', 60_000);
      testing(api).advance(6000);
      appendFileSync(path, lineFor(a));
      await externalChange(api, a, 'export const a = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(a))?.sourceType === 'ai-agent', 'a line after the emptying to be read', 30_000);
    });

    test('turning it off stops reading: a line written afterwards does not label anything; the hook command is copied for the user to place themselves', async function () {
      this.timeout(120_000);
      const path = await enable();
      await setConfig('experimental.agentSignals', false);
      await waitUntil(api, () => adapter().state === 'off', 'the adapter to stop', 30_000);
      const made = await createSettled(api, scratch('signal-off'), { 'a.ts': 'export const a = 1;\n' });
      await resetHistory(api);
      const a = must(made['a.ts']);
      appendFileSync(path, lineFor(a));
      await externalChange(api, a, 'export const a = 2;\n');
      testing(api).advance(500);
      assert.equal(must(lastEventFor(api, keyOf(a))).sourceType, 'external');
      await run('changescope.copyAgentHook');
      const clip = await vscode.env.clipboard.readText();
      assert.match(clip, /PostToolUse/);
      assert.ok(clip.includes('agent-events.jsonl'));
      assert.ok(clip.includes('.tool_input.file_path'));
      assert.ok(existsSync(path));
    });
  });

  suite('reportAgentActivity (public API)', () => {
    test('a report labels the next change of those files "AI agent" with the agent name; developer typing is never re-labelled', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('report-api'), { 'r.ts': 'export const r = 1;\n' });
      await resetHistory(api);
      const file = must(made['r.ts']);
      api.reportAgentActivity({ agent: '  my\tagent\u0000 ', files: [file], sessionId: 'sess-9' });
      await externalChange(api, file, 'export const r = 2;\n');
      await waitUntil(api, () => lastEventFor(api, keyOf(file))?.sourceType === 'ai-agent', 'the change to be attributed', 30_000);
      assert.equal(must(lastEventFor(api, keyOf(file))).sourceId, 'my agent', 'the name is cleaned');
      // typing: developer stays developer even when an agent reports the same file
      const dev = join(ws, 'a.ts');
      await typeAndWait(api, await openDoc(dev));
      api.reportAgentActivity({ agent: 'claude-code', files: [dev] });
      testing(api).advance(0);
      assert.equal(must(lastEventFor(api, keyOf(dev))).sourceType, 'developer');
      assert.equal(must(lastEventFor(api, keyOf(dev))).sourceId, undefined);
    });

    test('a report outside the 3 s window does not label anything', async function () {
      this.timeout(120_000);
      const made = await createSettled(api, scratch('report-late'), { 'r.ts': 'export const r = 1;\n' });
      await resetHistory(api);
      const file = must(made['r.ts']);
      api.reportAgentActivity({ agent: 'claude-code', files: [file] });
      testing(api).advance(3500);
      await externalChange(api, file, 'export const r = 2;\n');
      testing(api).advance(100);
      assert.equal(must(lastEventFor(api, keyOf(file))).sourceType, 'external');
    });

    test('invalid reports are ignored without throwing: empty agent, no files, relative paths, non-file URIs, wrong types', async function () {
      this.timeout(60_000);
      const eventsBefore = api.getActivityEvents().length;
      const bad: unknown[] = [
        undefined,
        null,
        'agent',
        42,
        {},
        { agent: '', files: ['/ws/a.ts'] },
        { agent: '   ', files: ['/ws/a.ts'] },
        { agent: 'x', files: [] },
        { agent: 'x', files: 'not an array' },
        { agent: 'x', files: ['relative/path.ts', './a.ts', '../a.ts', '', 'C:relative'] },
        { agent: 'x', files: [null, undefined, 5, {}, [], true] },
        { agent: 'x', files: [vscode.Uri.parse('http://example.com/a.ts'), vscode.Uri.parse('untitled:Untitled-1')] },
        { agent: 7, files: ['/ws/a.ts'] },
      ];
      for (const report of bad) assert.doesNotThrow(() => api.reportAgentActivity(report as never), JSON.stringify(report));
      assert.equal(api.getActivityEvents().length, eventsBefore, 'a report never creates an event by itself');
    });

    test('a report naming files outside the workspace is accepted for those files only; absolute paths of nothing in particular do no harm; at most 200 files are used', async function () {
      this.timeout(120_000);
      const outside = join(envPath('FS_TEST_OUTSIDE'), 'o2.ts');
      const flood = Array.from({ length: 400 }, (_, i) => `/nowhere/at/all/f${i}.ts`);
      assert.doesNotThrow(() => api.reportAgentActivity({ agent: 'claude-code', files: ['/etc/passwd', '/', vscode.Uri.file(outside), ...flood] }));
      // a file outside the workspace has no watcher, so the one change Changescope can see is an edit made through VS Code in
      // the background (a document that is not the focused editor): that is "Automated", which an agent report upgrades
      await vscode.window.showTextDocument(await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts')), { preview: false });
      const doc = await openDoc(outside);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), '// edited in the background\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitUntil(api, () => lastEventFor(api, keyOf(outside)) !== undefined, 'the background edit to be recorded', 30_000);
      await waitUntil(api, () => lastEventFor(api, keyOf(outside))?.sourceType === 'ai-agent', 'the outside file to be labelled', 30_000);
      assert.equal(must(lastEventFor(api, keyOf(outside))).detectionMethod, 'agent-signal');
      assert.equal(api.getActivityEvents().some((e) => e.filePath === '/etc/passwd'), false);
    });
  });
});
