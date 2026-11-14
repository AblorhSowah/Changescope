// Load compensation for the wall-clock regression guards.
//
// `npm run test:unit` runs test files in parallel, one process each, on a machine that may also be doing other work. A guard
// such as "under 500 ms" is meant to catch an accidental quadratic loop, not a busy CPU, but it cannot tell the two apart
// by itself. `loadFactor()` times a small fixed CPU-bound workload and compares it with the time that workload takes on an
// otherwise idle machine; `scaled(ms)` multiplies a guard by that factor (never below 1, never above MAX_FACTOR).
// On an idle machine the factor is 1, so every guard keeps exactly its documented value there. A real regression of the
// kind the guards exist for (a quadratic loop, rows recreated on every update) is 20x to 200x slower, so a factor of a few
// still catches it.
import { performance } from 'node:perf_hooks';

/** Time of `calibrate()` in milliseconds on an idle Apple M3 (minimum of 300 runs), Node 24. Slower machines get a factor above 1. */
export const IDLE_CALIBRATION_MS = 8;
export const MAX_FACTOR = 30;

/** A fixed workload of allocation, string building, sorting and arithmetic: the mix the guarded code is made of. */
export function calibrate(): number {
  const items: Array<{ k: string; v: number }> = [];
  for (let i = 0; i < 50_000; i += 1) items.push({ k: `k${i % 97}`, v: (i * 7919) % 1013 });
  items.sort((a, b) => a.v - b.v || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  let acc = 0;
  for (const o of items) acc += o.v + o.k.length;
  return acc;
}

/** How many times slower than an idle machine this process is right now (1 = idle or faster). */
export function loadFactor(): number {
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    calibrate();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.min(MAX_FACTOR, Math.max(1, best / IDLE_CALIBRATION_MS));
}

/** A guard in milliseconds, relaxed by the current machine load. */
export function scaled(ms: number): number {
  return ms * loadFactor();
}

/** The guard value to use after timing something: the larger of the factor before and after, so a load spike during the run counts. */
export function guardAround<T>(fn: () => T): { result: T; ms: number; factor: number } {
  const before = loadFactor();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  return { result, ms, factor: Math.max(before, loadFactor()) };
}
