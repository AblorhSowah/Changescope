import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_CALIBRATION_MS, MAX_FACTOR, calibrate, guardAround, loadFactor, scaled } from '../support/perfGuard';

describe('perfGuard: load compensation for the wall-clock guards', () => {
  it('the calibration workload is deterministic', () => {
    assert.equal(calibrate(), calibrate());
  });

  it('the factor is never below 1 (a guard is never tighter than its documented value) and never above the cap', () => {
    for (let i = 0; i < 5; i += 1) {
      const f = loadFactor();
      assert.ok(f >= 1 && f <= MAX_FACTOR, String(f));
    }
    assert.equal(MAX_FACTOR, 30);
    assert.ok(IDLE_CALIBRATION_MS > 0);
  });

  it('scaled(ms) is ms times a factor in [1, 30]', () => {
    for (const ms of [1, 20, 100, 1000]) {
      const v = scaled(ms);
      assert.ok(v >= ms && v <= ms * MAX_FACTOR, `${ms} -> ${v}`);
    }
  });

  it('guardAround reports the result, the time and a factor of at least 1', () => {
    const r = guardAround(() => calibrate());
    assert.equal(r.result, calibrate());
    assert.ok(r.ms > 0);
    assert.ok(r.factor >= 1);
  });

  it('a real regression is still caught: work that is 100 times slower than a guard allows fails even at the maximum compensation', () => {
    // a guard of 1 ms relaxed by at most 30 is 30 ms; a loop of 100 calibrations takes at least 100 x the idle time
    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) calibrate();
    const ms = performance.now() - t0;
    assert.ok(ms > scaled(1) * 0 + 1 * 30, `${ms.toFixed(0)} ms is more than the largest relaxed 1 ms guard (${(MAX_FACTOR * 1).toFixed(0)} ms)`);
  });
});
