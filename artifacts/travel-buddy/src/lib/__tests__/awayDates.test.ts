/**
 * awayDates — guards the "Away Aug 1–5" chips on the buddy profile.
 *
 * Covers formatAwayRange (single day, same-month, cross-month, cross-year)
 * and upcomingAwayRanges (past excluded, ending-today included, sorted by
 * start date).
 *
 * TZ is forced to a negative-UTC zone BEFORE any Date use so a regression
 * to bare `new Date('YYYY-MM-DD')` (UTC-midnight parsing, which shifts a
 * day back) would demonstrably fail here.
 */
process.env.TZ = 'America/Los_Angeles'; // must precede any Date use

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAwayRange, upcomingAwayRanges } from '../awayDates.ts';

const range = (startDate: string, endDate: string, id = `${startDate}_${endDate}`) =>
  ({ id, startDate, endDate });

describe('formatAwayRange', () => {
  it('formats a single day as just that day', () => {
    assert.equal(formatAwayRange(range('2026-08-01', '2026-08-01')), 'Aug 1');
  });

  it('formats a same-month range with an en dash and bare end day', () => {
    assert.equal(formatAwayRange(range('2026-08-01', '2026-08-05')), 'Aug 1–5');
  });

  it('formats a cross-month range with both months', () => {
    assert.equal(formatAwayRange(range('2026-07-30', '2026-08-02')), 'Jul 30 – Aug 2');
  });

  it('formats a cross-year range with both months (same month, different year)', () => {
    // Dec 30 2026 → Jan 2 2027: months differ, full form.
    assert.equal(formatAwayRange(range('2026-12-30', '2027-01-02')), 'Dec 30 – Jan 2');
    // Same calendar month but different year must NOT collapse to "Aug 1–1".
    assert.equal(formatAwayRange(range('2026-08-01', '2027-08-01')), 'Aug 1 – Aug 1');
  });

  it('is timezone-safe: local-midnight parsing keeps the calendar date', () => {
    // In a negative-UTC zone, UTC parsing would render Jul 31 / Aug 4.
    assert.equal(formatAwayRange(range('2026-08-01', '2026-08-05')), 'Aug 1–5');
  });
});

describe('upcomingAwayRanges', () => {
  const today = '2026-07-16';

  it('excludes ranges that ended before today', () => {
    const out = upcomingAwayRanges(
      [range('2026-07-01', '2026-07-15'), range('2026-08-01', '2026-08-05')],
      today,
    );
    assert.deepEqual(out.map(r => r.startDate), ['2026-08-01']);
  });

  it('includes a range ending today', () => {
    const out = upcomingAwayRanges([range('2026-07-10', '2026-07-16')], today);
    assert.equal(out.length, 1);
  });

  it('includes a currently in-progress range', () => {
    const out = upcomingAwayRanges([range('2026-07-10', '2026-07-20')], today);
    assert.equal(out.length, 1);
  });

  it('sorts by start date ascending', () => {
    const out = upcomingAwayRanges(
      [
        range('2026-09-01', '2026-09-03'),
        range('2026-07-20', '2026-07-21'),
        range('2026-08-01', '2026-08-05'),
      ],
      today,
    );
    assert.deepEqual(out.map(r => r.startDate), ['2026-07-20', '2026-08-01', '2026-09-01']);
  });

  it('returns empty for all-past input and does not mutate the original array', () => {
    const input = [range('2026-01-01', '2026-01-05')];
    const out = upcomingAwayRanges(input, today);
    assert.deepEqual(out, []);
    assert.equal(input.length, 1);
  });
});
