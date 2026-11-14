import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatLocalMinute, toIsoUtc } from '../../src/core/timeFormat';

describe('toIsoUtc: arithmetic UTC formatting', () => {
  it('known instants', () => {
    assert.equal(toIsoUtc(0), '1970-01-01T00:00:00.000Z');
    assert.equal(toIsoUtc(1), '1970-01-01T00:00:00.001Z');
    assert.equal(toIsoUtc(86_399_999), '1970-01-01T23:59:59.999Z');
    assert.equal(toIsoUtc(Date.UTC(2000, 1, 29, 12, 34, 56, 789)), '2000-02-29T12:34:56.789Z');
    assert.equal(toIsoUtc(Date.UTC(2100, 1, 28, 0, 0, 0, 0) + 86_400_000), '2100-03-01T00:00:00.000Z', '2100 is not a leap year');
    assert.equal(toIsoUtc(Date.UTC(2024, 11, 31, 23, 59, 59, 999)), '2024-12-31T23:59:59.999Z');
  });

  it('agrees with Date#toISOString over a dense and a random sample, negatives included', () => {
    let seed = 99;
    const next = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    const values: number[] = [];
    for (let day = -800_000; day <= 800_000; day += 977) values.push(day * 86_400_000 + (day % 7) * 3_600_000 + (day % 1000));
    for (let i = 0; i < 4000; i += 1) values.push((next() / 2147483647 - 0.5) * 2 * 8.64e15 * 0.99);
    for (const ms of values) {
      const whole = Math.floor(ms);
      assert.equal(toIsoUtc(ms), new Date(whole).toISOString(), String(ms));
    }
  });

  it('leap days and month ends', () => {
    for (const [y, m, d] of [
      [1900, 1, 28],
      [1900, 2, 1],
      [2000, 1, 29],
      [2004, 1, 29],
      [2023, 11, 31],
      [1969, 11, 31],
      [1600, 1, 29],
    ] as const) {
      const ms = Date.UTC(y, m, d, 23, 59, 59, 999);
      assert.equal(toIsoUtc(ms), new Date(ms).toISOString());
      assert.equal(toIsoUtc(ms + 1), new Date(ms + 1).toISOString());
    }
  });

  it('a fractional millisecond is floored like a whole one', () => {
    assert.equal(toIsoUtc(1000.9), '1970-01-01T00:00:01.000Z');
    assert.equal(toIsoUtc(-0.5), new Date(-1).toISOString());
  });

  it('unusable values give an empty string and never throw', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1, -8.64e15 - 1]) assert.equal(toIsoUtc(bad), '', String(bad));
  });

  it('the extremes of the Date range', () => {
    assert.equal(toIsoUtc(8.64e15), new Date(8.64e15).toISOString());
    assert.equal(toIsoUtc(-8.64e15), new Date(-8.64e15).toISOString());
  });
});

describe('formatLocalMinute', () => {
  it('has the shape "YYYY-MM-DD HH:mm" and agrees with the local calendar fields of Date', () => {
    for (const ms of [0, 86_400_000 * 365.25 * 30, Date.UTC(2026, 10, 12, 21, 14, 59), Date.UTC(2026, 11, 31, 23, 59, 0), Date.UTC(2024, 1, 29, 0, 0, 0)]) {
      const d = new Date(ms);
      const p = (n: number, w = 2): string => String(n).padStart(w, '0');
      assert.equal(formatLocalMinute(ms), `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
    }
  });

  it('midnight is 00:xx, never 24:xx', () => {
    const midnight = new Date(2026, 5, 1, 0, 5, 0).getTime();
    assert.equal(formatLocalMinute(midnight), '2026-06-01 00:05');
  });

  it('unusable values give an empty string', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) assert.equal(formatLocalMinute(bad), '');
  });
});

describe('formatDuration', () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it('seconds, minutes, hours, days with their boundaries', () => {
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(999), '0 s');
    assert.equal(formatDuration(45 * S), '45 s');
    assert.equal(formatDuration(59 * S + 999), '59 s');
    assert.equal(formatDuration(60 * S), '1 min');
    assert.equal(formatDuration(12 * M + 59 * S), '12 min');
    assert.equal(formatDuration(59 * M + 59 * S), '59 min');
    assert.equal(formatDuration(H), '1 h');
    assert.equal(formatDuration(H + 5 * M), '1 h 5 min');
    assert.equal(formatDuration(23 * H + 59 * M), '23 h 59 min');
    assert.equal(formatDuration(D), '1 d');
    assert.equal(formatDuration(2 * D + 3 * H), '2 d 3 h');
    assert.equal(formatDuration(2 * D + 3 * H + 59 * M), '2 d 3 h', 'minutes are dropped from a day count');
    assert.equal(formatDuration(400 * D), '400 d');
  });

  it('negative and non-finite values count as 0', () => {
    for (const bad of [-1, -1e9, Number.NaN, Number.NEGATIVE_INFINITY]) assert.equal(formatDuration(bad), '0 s', String(bad));
  });

  it('Infinity does not hang or throw', () => {
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0 s', 'documented as 0: not finite');
  });
});
