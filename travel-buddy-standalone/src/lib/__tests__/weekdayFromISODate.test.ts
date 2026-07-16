/**
 * weekdayKeyFromISODate — guards the availability round-trip weekday mapping.
 *
 * The buddy availability grid is keyed Mon..Sun; rows come back from the API
 * as ISO dates. Deriving the weekday via `new Date('YYYY-MM-DD')` (UTC
 * midnight) shifted every row back one weekday in negative-UTC timezones,
 * so the reloaded grid didn't match what was saved. This suite pins the
 * derivation to the calendar date regardless of runtime timezone.
 *
 * TZ is forced to a negative-UTC zone BEFORE any Date use so the buggy
 * UTC-parse approach would demonstrably fail here.
 */
process.env.TZ = 'America/Los_Angeles'; // UTC-7/-8 — must precede any Date use

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { weekdayKeyFromISODate, WEEKDAY_KEYS } from '../weekdayFromISODate.ts';

// Known calendar facts (independent of timezone):
const KNOWN: Array<[string, string]> = [
  ['2026-07-13', 'Mon'],
  ['2026-07-14', 'Tue'],
  ['2026-07-15', 'Wed'],
  ['2026-07-16', 'Thu'],
  ['2026-07-17', 'Fri'],
  ['2026-07-18', 'Sat'],
  ['2026-07-19', 'Sun'],
  ['2026-01-01', 'Thu'],
  ['2026-12-31', 'Thu'],
  ['2024-02-29', 'Thu'], // leap day
];

describe('weekdayKeyFromISODate', () => {
  it('runs under a negative-UTC timezone (guards the regression scenario)', () => {
    // getTimezoneOffset() is positive west of UTC. If this fails, the TZ
    // override stopped working and the negative-UTC guarantee below is void.
    assert.ok(new Date(2026, 0, 15).getTimezoneOffset() > 0,
      'expected a negative-UTC timezone (America/Los_Angeles)');
  });

  it('maps known ISO dates to the correct Mon..Sun key', () => {
    for (const [iso, expected] of KNOWN) {
      assert.equal(weekdayKeyFromISODate(iso), expected, iso);
    }
  });

  it('matches the UTC calendar weekday for every date in a full year (no tz shift)', () => {
    // The correct answer for a bare calendar date is its UTC weekday.
    // The old buggy derivation (new Date(iso).getDay() in local time) is one
    // day behind this in any negative-UTC zone.
    for (let ts = Date.UTC(2026, 0, 1); ts <= Date.UTC(2026, 11, 31); ts += 86_400_000) {
      const d = new Date(ts);
      const iso = d.toISOString().slice(0, 10);
      const expected = WEEKDAY_KEYS[(d.getUTCDay() + 6) % 7];
      assert.equal(weekdayKeyFromISODate(iso), expected, iso);
    }
  });

  it('demonstrates the old UTC-parse approach is wrong in this timezone', () => {
    // Sanity check that this suite can actually catch the regression:
    // parsing '2026-07-13' (a Monday) as UTC midnight and reading local
    // getDay() yields Sunday in America/Los_Angeles.
    const buggy = WEEKDAY_KEYS[(new Date('2026-07-13').getDay() + 6) % 7];
    assert.equal(buggy, 'Sun');
    assert.equal(weekdayKeyFromISODate('2026-07-13'), 'Mon');
  });

  it('accepts full ISO timestamps, using only the date part', () => {
    assert.equal(weekdayKeyFromISODate('2026-07-13T23:30:00Z'), 'Mon');
    assert.equal(weekdayKeyFromISODate('2026-07-19T00:00:00+09:00'), 'Sun');
  });

  it('returns undefined for unparseable input', () => {
    assert.equal(weekdayKeyFromISODate(''), undefined);
    assert.equal(weekdayKeyFromISODate('not-a-date'), undefined);
    assert.equal(weekdayKeyFromISODate('2026/07/13'), undefined);
    assert.equal(weekdayKeyFromISODate(undefined as any), undefined);
  });
});
