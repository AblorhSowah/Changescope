// Performance on the REAL adapters in a real VS Code. The extension's own cost per edit is measured as the difference
// between the wall time of N sequential TextEditor.edit calls with the extension enabled and with it disabled (a disabled
// extension returns from its handlers immediately), so VS Code's own cost and every other extension cancel out.
import assert from 'node:assert/strict';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import { getApi, keyOf, must, openDoc, resetConfig, resetState, rowOf, setConfig, settleRefs, testing, trackedOf, typeAndWait, waitUntil, waitUntilSeen, workspaceDir, ensureWatched } from './helpers';

/** Budget for the extension's overhead per keystroke, in ms of extension-host time. See docs/QA_REPORT.md section on performance. */
const BUDGET_MS_PER_EDIT = 2;
/** Same idea for a 400 KB document: the extension's own cost per edit (edits with it on minus edits with it off), in ms. */
const BIG_DOC_BUDGET_MS_PER_EDIT = 10;
const EDITS = 200;
const ROUNDS = 3;

suite('Performance of the real adapters (single-root workspace)', () => {
  let api: ChangescopeApi;
  const ws = workspaceDir();

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
    testing(api).overrideFocus(true);
  });

  teardown(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
  });

  async function timeEdits(editor: vscode.TextEditor, doc: vscode.TextDocument, n: number): Promise<number> {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, 'x'));
      testing(api).advance(5); // 200 edits per second of fake time: ticks (200 ms) and reference debounces (400 ms) really run
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }

  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

  test(`${EDITS} rapid edits: extension overhead per edit <= ${BUDGET_MS_PER_EDIT} ms, every edit recorded, model bounded`, async function () {
    this.timeout(240_000);
    const a = join(ws, 'a.ts');
    const doc = await openDoc(a);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const setEnabled = async (v: boolean): Promise<void> => {
      await setConfig('enable', v);
      await waitUntil(api, () => api.isEnabled() === v, v ? 'enabled' : 'disabled');
    };
    await setEnabled(false);
    await timeEdits(editor, doc, 40); // warm-up
    await setEnabled(true);
    await typeAndWait(api, doc); // creates the entry; the document is dirty from here on
    await timeEdits(editor, doc, 40); // warm-up

    // interleave the two modes so JIT warm-up and machine noise hit both equally
    const off: number[] = [];
    const on: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      await setEnabled(false);
      off.push(await timeEdits(editor, doc, EDITS));
      await setEnabled(true); // enabling starts from an empty tracker
      on.push(await timeEdits(editor, doc, EDITS));
      await waitUntil(api, () => (trackedOf(api, keyOf(a))?.editCount ?? 0) >= EDITS, `all ${EDITS} edits of round ${r} to be recorded`, 60_000);
      assert.equal(must(trackedOf(api, keyOf(a))).editCount, EDITS, 'every edit made while enabled was recorded, none lost or duplicated');
    }
    await settleRefs(api);

    const perEditOff = median(off) / EDITS;
    const perEditOn = median(on) / EDITS;
    const overhead = perEditOn - perEditOff;
    console.log(`PERF disabled ${perEditOff.toFixed(3)} ms/edit, enabled ${perEditOn.toFixed(3)} ms/edit, overhead ${overhead.toFixed(3)} ms/edit (rounds off=${off.map((x) => x.toFixed(0)).join('/')} on=${on.map((x) => x.toFixed(0)).join('/')} ms for ${EDITS} edits)`);

    assert.ok(api.getRows().length <= 40);
    assert.ok(overhead <= BUDGET_MS_PER_EDIT, `extension overhead ${overhead.toFixed(3)} ms per edit exceeds the budget of ${BUDGET_MS_PER_EDIT} ms`);
  });

  test('a model refresh with 40 tracked files and 30 references each costs <= 5 ms (it runs every 200 ms while anything is active)', async function () {
    this.timeout(120_000);
    const dir = join(ws, 'perf-refresh');
    await ensureWatched(api, dir);
    try {
      const keys: string[] = [];
      for (let batch = 0; batch < 2; batch++) {
        const contents: Record<string, string> = {};
        for (let i = 0; i < 20; i++) {
          const f = join(dir, `f${batch * 20 + i}.ts`);
          const text = `import './f${(batch * 20 + i + 1) % 40}';\nexport const v = 1;\n`;
          writeFileSync(f, text);
          contents[f] = text;
          keys.push(keyOf(f));
        }
        await waitUntilSeen(api, contents, (p) => trackedOf(api, keyOf(p)) !== undefined, `batch ${batch} to be tracked`, 60_000);
        testing(api).advance(1100); // new burst window
      }
      assert.ok(api.getTracked().length >= 38, `tracked ${api.getTracked().length}`);
      await settleRefs(api);
      const N = 300;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) testing(api).advance(0);
      const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
      console.log(`PERF model refresh with ${api.getTracked().length} tracked files: ${per.toFixed(3)} ms`);
      assert.ok(per <= 5, `${per.toFixed(3)} ms per refresh`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('typing in a 400 KB TypeScript file: edits stay fast and the reference analysis completes within a second', async function () {
    this.timeout(120_000);
    const dir = join(ws, 'perf-big');
    await ensureWatched(api, dir);
    try {
      const big = join(dir, 'big.ts');
      const lines = ["import { b1 } from '../b';", ...Array.from({ length: 8000 }, (_, i) => `export const v${i} = b1() + ${i}; // line ${i} of a long file`)];
      const text = lines.join('\n');
      writeFileSync(big, text);
      assert.ok(statSync(big).size > 350_000 && statSync(big).size < 512 * 1024);
      await waitUntilSeen(api, { [big]: text }, (p) => trackedOf(api, keyOf(p)) !== undefined, 'the big file to be seen by the watcher', 60_000);
      await resetState(api);
      testing(api).overrideFocus(true);
      const doc = await openDoc(big);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const BIG_EDITS = 40;
      const timeBigEdits = async (): Promise<number> => {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < BIG_EDITS; i++) await editor.edit((b) => b.insert(new vscode.Position(0, 0), ' '));
        return Number(process.hrtime.bigint() - t0) / 1e6;
      };
      const setEnabled = async (v: boolean): Promise<void> => {
        await setConfig('enable', v);
        await waitUntil(api, () => api.isEnabled() === v, v ? 'enabled' : 'disabled');
      };
      // The cost of an edit in a big document is mostly VS Code's own, and it varies a lot with the machine (software rendering under xvfb
      // on CI is several times slower than a laptop). So the extension is judged by the difference between edits made with it off and with
      // it on, interleaved over several rounds, as the 200-edit test does; a generous absolute ceiling still catches a hang.
      await setEnabled(false);
      await timeBigEdits(); // warm-up
      const off: number[] = [];
      const on: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        await setEnabled(false);
        off.push(await timeBigEdits());
        await setEnabled(true); // enabling starts from an empty tracker
        on.push(await timeBigEdits());
        await waitUntil(api, () => (trackedOf(api, keyOf(big))?.editCount ?? 0) >= BIG_EDITS, `${BIG_EDITS} edits of round ${r} to be recorded`, 60_000);
      }
      const t1 = process.hrtime.bigint();
      await settleRefs(api);
      const analysisMs = Number(process.hrtime.bigint() - t1) / 1e6;
      const perEditOff = median(off) / BIG_EDITS;
      const perEditOn = median(on) / BIG_EDITS;
      const overhead = perEditOn - perEditOff;
      console.log(`PERF 400 KB file: disabled ${perEditOff.toFixed(2)} ms/edit, enabled ${perEditOn.toFixed(2)} ms/edit, overhead ${overhead.toFixed(2)} ms/edit (rounds off=${off.map((x) => x.toFixed(0)).join('/')} on=${on.map((x) => x.toFixed(0)).join('/')} ms for ${BIG_EDITS} edits), reference analysis ${analysisMs.toFixed(1)} ms`);
      await waitUntil(api, () => rowOf(api, keyOf(join(ws, 'b.ts'))) !== undefined, 'b.ts to be referenced by the big file', 30_000);
      assert.ok(overhead <= BIG_DOC_BUDGET_MS_PER_EDIT, `extension overhead ${overhead.toFixed(2)} ms per edit in a big document exceeds the budget of ${BIG_DOC_BUDGET_MS_PER_EDIT} ms`);
      assert.ok(perEditOn < 250, `${perEditOn.toFixed(1)} ms per edit in a big document (absolute ceiling: a hang, whatever the machine)`);
      assert.ok(analysisMs < 1500, `analysis took ${analysisMs.toFixed(0)} ms`);
    } finally {
      await resetState(api);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
