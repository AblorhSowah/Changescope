import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COLLISION_ACTIONS, COLLISION_QUIET_MS, collisionMessage, shouldNotify } from '../../src/core/activity/collision';

const T0 = 5_000_000;

describe('shouldNotify (DESIGN-0.3.0 section 8: at most once per file per 30 s)', () => {
  it('the quiet period is 30 seconds', () => {
    assert.equal(COLLISION_QUIET_MS, 30_000);
  });

  it('a file never announced is announced, when enabled', () => {
    assert.equal(shouldNotify(undefined, T0, true), true);
  });

  it('the setting off silences everything, including a never-announced file', () => {
    assert.equal(shouldNotify(undefined, T0, false), false);
    assert.equal(shouldNotify(T0 - 10 * COLLISION_QUIET_MS, T0, false), false);
  });

  it('boundary: 29 999 ms after the last announcement is silent, exactly 30 000 ms is announced', () => {
    assert.equal(shouldNotify(T0, T0 + COLLISION_QUIET_MS - 1, true), false);
    assert.equal(shouldNotify(T0, T0 + COLLISION_QUIET_MS, true), true);
    assert.equal(shouldNotify(T0, T0 + COLLISION_QUIET_MS + 1, true), true);
  });

  it('the same instant is silent (a second event at the same millisecond)', () => {
    assert.equal(shouldNotify(T0, T0, true), false);
  });

  it('a clock that moved backwards does not silence the file for ever', () => {
    assert.equal(shouldNotify(T0, T0 - 1, true), true);
    assert.equal(shouldNotify(T0 + 10 * COLLISION_QUIET_MS, T0, true), true);
  });

  it('is pure: the same inputs always give the same answer', () => {
    for (let i = 0; i < 50; i += 1) assert.equal(shouldNotify(T0, T0 + 100, true), false);
  });

  it('non-finite times: NaN now never announces twice in a row, undefined last always announces', () => {
    assert.equal(shouldNotify(undefined, Number.NaN, true), true);
    // NaN comparisons are false in both branches: silent. (A NaN clock is already broken elsewhere.)
    assert.equal(shouldNotify(T0, Number.NaN, true), false);
  });
});

describe('collision texts', () => {
  it('the message names the file and says what happened (DESIGN 8 wording)', () => {
    assert.equal(collisionMessage('app.ts'), 'app.ts was changed on disk while you have unsaved edits.');
  });

  it('a hostile name is only text: nothing is stripped or reinterpreted', () => {
    const name = '<img src=x onerror=alert(1)>.ts';
    assert.equal(collisionMessage(name), `${name} was changed on disk while you have unsaved edits.`);
  });

  it('the two actions are exactly "Compare with Saved" and "Dismiss"', () => {
    assert.deepEqual({ ...COLLISION_ACTIONS }, { COMPARE: 'Compare with Saved', DISMISS: 'Dismiss' });
  });
});
