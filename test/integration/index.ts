// Loaded by VS Code (extensionTestsPath, bundled to out/integration/index.js). Runs mocha (tdd) over
// the suite files that belong to the launch variant.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Mocha from 'mocha';
import { selectSuiteFiles } from './harness';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
  const dir = join(__dirname, 'suite');
  const variant = process.env['FS_TEST_VARIANT'] ?? 'single';
  const files = selectSuiteFiles(readdirSync(dir), variant);
  if (files.length === 0) return Promise.reject(new Error(`no suite files found in ${dir} for variant ${variant}`));
  for (const f of files) mocha.addFile(join(dir, f));
  const grep = process.env['FS_TEST_GREP'];
  if (grep) mocha.grep(grep);
  // Real VS Code on a shared CI runner has rare timing flakes (a file-watcher event that arrives late or never). FS_TEST_RETRIES=1
  // (set in CI only) re-runs a failed test once, including its setup and teardown; every retry is printed as "[flaky] ..." and CI
  // turns those lines into a warning annotation, so a flaky test is listed instead of silently passing. Local runs retry nothing.
  const retries = Number(process.env['FS_TEST_RETRIES'] ?? 0);
  if (Number.isInteger(retries) && retries > 0) mocha.retries(retries);
  return new Promise<void>((resolve, reject) => {
    try {
      const runner = mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} integration test(s) failed (variant ${variant}).`));
        else resolve();
      });
      const attempts = new Map<string, number>();
      runner.on('retry', (test: Mocha.Test, err: Error) => {
        const title = test.fullTitle();
        const attempt = (attempts.get(title) ?? 0) + 1;
        attempts.set(title, attempt);
        const reason = (err.message.split('\n')[0] ?? '').slice(0, 300);
        console.log(`[flaky] variant ${variant}, attempt ${attempt} failed, retrying: ${title} :: ${reason}`);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
