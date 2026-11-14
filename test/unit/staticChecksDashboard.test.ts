// The 0.2.0 static policy (staticChecks.test.ts) scans src/core, src/webview and src/vscode. The dashboard bundle
// (src/dashboard) is a second browser bundle with the same rules, so it gets the same scans here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { importsOf, listTsFiles, read, rel, runtimeClosure, strip } from '../support/staticScan';
import { REPO_ROOT } from '../support/fixtures';

const dashboard = listTsFiles('src/dashboard');

const offenders = (files: string[], test: (code: string, raw: string, file: string) => string[]): string[] =>
  files.flatMap((f) => {
    const raw = read(f);
    return test(strip(raw, { strings: true }), raw, f).map((m) => `${rel(f)}: ${m}`);
  });

describe('static policy: the dashboard bundle (src/dashboard)', () => {
  it('there are dashboard files to check, including the entry point and the six views', () => {
    const names = dashboard.map(rel);
    assert.ok(names.includes('src/dashboard/main.ts'));
    assert.ok(names.includes('src/dashboard/app.ts'));
    for (const v of ['overview', 'activity', 'code', 'git', 'sessions', 'settings']) assert.ok(names.includes(`src/dashboard/views/${v}.ts`), v);
    assert.ok(dashboard.length >= 12, `found ${dashboard.length}`);
  });

  it('its runtime import closure contains only types, constants, intensity and the dashboard protocol from core, and no external package', () => {
    const allowedCore = new Set(['types', 'constants', 'intensity', 'dashboard/protocol'].map((n) => `src/core/${n}.ts`));
    const { files, externals } = runtimeClosure(join(REPO_ROOT, 'src', 'dashboard', 'main.ts'));
    assert.deepEqual(externals, [], 'an external package (picomatch, jsonc-parser) would be bundled into the browser');
    const outside = files.map(rel).filter((r) => !r.startsWith('src/dashboard/') && !allowedCore.has(r));
    assert.deepEqual(outside, [], 'modules outside the allowed core set reach the browser bundle');
    assert.ok(files.map(rel).includes('src/core/dashboard/protocol.ts'), 'the protocol validator is shared, not copied');
  });

  it('never imports vscode or a node builtin', () => {
    const bad = dashboard.flatMap((f) => importsOf(read(f)).filter((i) => i.spec === 'vscode' || i.spec.startsWith('node:') || ['fs', 'path', 'os', 'crypto', 'child_process'].includes(i.spec)).map((i) => `${rel(f)} imports ${i.spec}`));
    assert.deepEqual(bad, []);
  });

  it('uses no HTML sinks: innerHTML, outerHTML, insertAdjacentHTML, document.write, createContextualFragment, DOMParser', () => {
    const bad = offenders(dashboard, (code) =>
      [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bcreateContextualFragment\b/, /\bDOMParser\b/, /\bsrcdoc\b/].filter((re) => re.test(code)).map((re) => `matches ${re}`),
    );
    assert.deepEqual(bad, []);
  });

  it('never writes a style attribute or cssText; only style.setProperty with --fd-* names', () => {
    const bad = offenders(dashboard, (_code, raw) => {
      const code = strip(raw, { strings: false });
      return [/setAttribute\(\s*['"]style['"]/i, /\.cssText\b/, /\.setAttribute\(\s*['"]on/i, /\.style\.[a-zA-Z]+\s*=[^=]/, /\.style\.(?:cssText|setAttribute)/].filter((re) => re.test(code)).map((re) => `matches ${re}`);
    });
    assert.deepEqual(bad, []);
    const names = dashboard.flatMap((f) => [...strip(read(f), { strings: false }).matchAll(/setProperty\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string));
    for (const n of names) assert.match(n, /^--fd-/, `style.setProperty('${n}')`);
    const viaHelper = dashboard.flatMap((f) => [...strip(read(f), { strings: false }).matchAll(/setVar\([^,]+,\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string));
    for (const n of viaHelper) assert.match(n, /^--fd-/, `setVar('${n}')`);
    assert.ok(viaHelper.length >= 4, 'the row sets its shake variables through setVar');
  });

  it('no eval / new Function / string timers / remote URLs / network / storage', () => {
    const bad = offenders(dashboard, (_code, raw) => {
      const code = strip(raw, { strings: false });
      return [/\beval\s*\(/, /new Function\s*\(/, /setTimeout\(\s*['"`]/, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /importScripts/, /\blocalStorage\b/, /\bsessionStorage\b/, /document\.cookie/, /\bindexedDB\b/, /navigator\.sendBeacon/].filter((re) => re.test(code)).map((re) => `matches ${re}`);
    });
    assert.deepEqual(bad, []);
  });

  it('reads no clock: relative times are measured against state.now (no Date.now, new Date(), performance.now)', () => {
    const bad = offenders(dashboard, (code) => [/\bDate\.now\b/, /\bnew Date\(\s*\)/, /\bperformance\.now\b/].filter((re) => re.test(code)).map((re) => `matches ${re}`));
    assert.deepEqual(bad, []);
  });

  it('every timer goes through the injected environment: no setInterval, and setTimeout only as env.setTimeout or in the default environment', () => {
    // model.ts only declares the AppEnv interface, whose method is called setTimeout
    const bad = offenders(
      dashboard.filter((f) => rel(f) !== 'src/dashboard/model.ts'),
      (code) => [/\bsetInterval\b/, /\brequestAnimationFrame\b/, /(?<![.\w])setTimeout\s*\(/].filter((re) => re.test(code)).map((re) => `matches ${re}`),
    );
    assert.deepEqual(bad, []);
    const direct = dashboard.filter((f) => /\b(?:win|window)\.setTimeout\b/.test(strip(read(f), { strings: true }))).map(rel);
    assert.deepEqual(direct, ['src/dashboard/app.ts'], 'only the default environment of app.ts may touch the real timer');
  });

  it('no `any`, no ts-ignore, no eslint-disable without a reason, no CSP relaxation', () => {
    const bad = offenders(dashboard, (code, raw) => {
      const hits: string[] = [];
      const re = /:\s*any\b|\bas\s+any\b|\bany\s*\[\]|<any\b|\bany\s*>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) hits.push(`any: ${JSON.stringify(code.slice(Math.max(0, m.index - 20), m.index + 20))}`);
      for (const r of [/@ts-ignore/, /@ts-nocheck/, /eslint-disable(?!-next-line [\w@/-]+ -- )/, /unsafe-inline/, /unsafe-eval/]) if (r.test(raw)) hits.push(`matches ${r}`);
      return hits;
    });
    assert.deepEqual(bad, []);
  });

  it('only main.ts talks to the host (acquireVsCodeApi, window message and error listeners); app.ts is host-agnostic', () => {
    const using = dashboard.filter((f) => /\bacquireVsCodeApi\b/.test(strip(read(f), { strings: true }))).map(rel);
    assert.deepEqual(using, ['src/dashboard/main.ts']);
    const main = read(join(REPO_ROOT, 'src', 'dashboard', 'main.ts'));
    assert.match(main, /addEventListener\(\s*['"]message['"]/);
    assert.match(main, /parsePersisted\(\s*vscode\.getState\(\)\s*\)/, 'persisted state is validated field by field');
  });

  it('messages to the host go through the validator before they leave (send() uses parseDashboardWebviewMessage)', () => {
    const app = read(join(REPO_ROOT, 'src', 'dashboard', 'app.ts'));
    assert.match(app, /parseDashboardWebviewMessage\(/);
    assert.match(app, /parseDashboardHostMessage\(/);
    const calls = [...strip(app, { strings: true }).matchAll(/host\.postMessage\(/g)];
    assert.equal(calls.length, 2, 'exactly two places post: the ready handshake and the validated send()');
  });
});
