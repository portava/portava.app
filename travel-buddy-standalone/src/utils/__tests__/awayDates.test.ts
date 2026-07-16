import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAwayRange, upcomingAwayRanges } from '../awayDates.ts';
import type { BuddyBlockedRange } from '../../services/rentABuddy.ts';

const range = (startDate: string, endDate: string, id = `${startDate}_${endDate}`): BuddyBlockedRange => ({
  id,
  type: 'vacation',
  startDate,
  endDate,
});

test('formatAwayRange: single day shows one date', () => {
  assert.equal(formatAwayRange(range('2026-08-01', '2026-08-01')), 'Aug 1');
});

test('formatAwayRange: same-month range collapses the month', () => {
  assert.equal(formatAwayRange(range('2026-08-01', '2026-08-05')), 'Aug 1–5');
});

test('formatAwayRange: cross-month range shows both months', () => {
  assert.equal(formatAwayRange(range('2026-07-30', '2026-08-02')), 'Jul 30 – Aug 2');
});

test('formatAwayRange: cross-year range shows both endpoints', () => {
  assert.equal(formatAwayRange(range('2026-12-30', '2027-01-02')), 'Dec 30 – Jan 2');
});

test('upcomingAwayRanges: drops ranges that ended before today', () => {
  const out = upcomingAwayRanges(
    [range('2026-07-01', '2026-07-10'), range('2026-08-01', '2026-08-05')],
    '2026-07-16',
  );
  assert.deepEqual(out.map(r => r.startDate), ['2026-08-01']);
});

test('upcomingAwayRanges: keeps a range ending today and one already in progress', () => {
  const out = upcomingAwayRanges(
    [range('2026-07-10', '2026-07-16'), range('2026-07-14', '2026-07-20')],
    '2026-07-16',
  );
  assert.equal(out.length, 2);
});

test('upcomingAwayRanges: sorts by start date ascending', () => {
  const out = upcomingAwayRanges(
    [range('2026-09-01', '2026-09-03'), range('2026-08-01', '2026-08-05'), range('2026-08-20', '2026-08-22')],
    '2026-07-16',
  );
  assert.deepEqual(out.map(r => r.startDate), ['2026-08-01', '2026-08-20', '2026-09-01']);
});
