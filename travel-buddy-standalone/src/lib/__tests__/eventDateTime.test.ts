/**
 * Unit tests for src/lib/eventDateTime.ts — the Events date/time helpers.
 *
 * Run via:
 *   node --import tsx/esm --test src/lib/__tests__/eventDateTime.test.ts
 *
 * Covers: start/end time composition, timezone round-trips, same-day and
 * overnight events, optional-end handling, equal start/end rejection,
 * default end generation (never invalid), and listing range boundaries
 * (same-day events stay visible after their start time passes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeLocalDate, composeIso, splitIso, defaultEndFor, validateEventTimes,
  todayRange, tomorrowRange, upcomingRange,
} from '../eventDateTime.ts';

describe('composeLocalDate / composeIso', () => {
  it('composes a local wall time into a Date with the exact hour/minute', () => {
    const d = composeLocalDate('2026-07-28', '19:30');
    assert.ok(d);
    assert.equal(d!.getFullYear(), 2026);
    assert.equal(d!.getMonth(), 6);
    assert.equal(d!.getDate(), 28);
    assert.equal(d!.getHours(), 19);
    assert.equal(d!.getMinutes(), 30);
  });

  it('returns null when either part is missing (no silent midnight default)', () => {
    assert.equal(composeLocalDate('2026-07-28', ''), null);
    assert.equal(composeLocalDate('', '19:30'), null);
    assert.equal(composeIso('2026-07-28', ''), undefined);
  });

  it('rejects malformed input', () => {
    assert.equal(composeLocalDate('28/07/2026', '19:30'), null);
    assert.equal(composeLocalDate('2026-07-28', '7pm'), null);
  });

  it('round-trips through ISO/UTC without shifting the wall time (timezone conversion)', () => {
    const iso = composeIso('2026-07-28', '19:30')!;
    // ISO is a UTC instant…
    assert.ok(iso.endsWith('Z'));
    // …and splitting it back in the same local zone restores the wall time.
    const parts = splitIso(iso);
    assert.equal(parts.dateStr, '2026-07-28');
    assert.equal(parts.timeStr, '19:30');
  });
});

describe('validateEventTimes', () => {
  const start = { dateStr: '2026-07-28', timeStr: '18:00' };

  it('requires an explicit start date and start time', () => {
    assert.equal(validateEventTimes({ dateStr: '', timeStr: '' }, { dateStr: '', timeStr: '' })!.field, 'start');
    assert.equal(validateEventTimes({ dateStr: '2026-07-28', timeStr: '' }, { dateStr: '', timeStr: '' })!.message, 'Pick a start time');
  });

  it('allows a start-only event (optional end)', () => {
    assert.equal(validateEventTimes(start, { dateStr: '', timeStr: '' }), null);
  });

  it('accepts a same-day event with different times', () => {
    assert.equal(validateEventTimes(start, { dateStr: '2026-07-28', timeStr: '21:00' }), null);
  });

  it('accepts an overnight event crossing midnight', () => {
    assert.equal(
      validateEventTimes({ dateStr: '2026-07-28', timeStr: '22:00' }, { dateStr: '2026-07-29', timeStr: '02:00' }),
      null,
    );
  });

  it('rejects equal start/end (the 12:00 AM default bug)', () => {
    const err = validateEventTimes(
      { dateStr: '2026-07-28', timeStr: '00:00' },
      { dateStr: '2026-07-28', timeStr: '00:00' },
    );
    assert.equal(err!.field, 'end');
    assert.match(err!.message, /after the start/);
  });

  it('rejects end before start', () => {
    assert.equal(
      validateEventTimes(start, { dateStr: '2026-07-28', timeStr: '17:00' })!.field,
      'end',
    );
  });

  it('rejects an incomplete end pair, naming the missing part', () => {
    assert.match(validateEventTimes(start, { dateStr: '2026-07-28', timeStr: '' })!.message, /end time/i);
    assert.match(validateEventTimes(start, { dateStr: '', timeStr: '21:00' })!.message, /end date/i);
  });
});

describe('defaultEndFor', () => {
  it('defaults to start + 2h on the same day', () => {
    assert.deepEqual(defaultEndFor('2026-07-28', '18:00'), { dateStr: '2026-07-28', timeStr: '20:00' });
  });

  it('rolls the date forward when +2h crosses midnight (never an invalid pair)', () => {
    const def = defaultEndFor('2026-07-28', '23:30');
    assert.deepEqual(def, { dateStr: '2026-07-29', timeStr: '01:30' });
    assert.equal(validateEventTimes({ dateStr: '2026-07-28', timeStr: '23:30' }, def), null);
  });
});

describe('listing ranges', () => {
  it('todayRange spans the full local day, so later-today events stay included', () => {
    const now = new Date(2026, 6, 15, 14, 0); // 2 PM local
    const r = todayRange(now);
    const eveningEvent = new Date(2026, 6, 15, 20, 0).toISOString();
    assert.ok(r.dateFrom <= eveningEvent && eveningEvent <= r.dateTo);
    // Yesterday excluded
    assert.ok(new Date(2026, 6, 14, 20, 0).toISOString() < r.dateFrom);
  });

  it('upcomingRange starts at local midnight and has no upper bound', () => {
    const now = new Date(2026, 6, 15, 23, 30);
    const r = upcomingRange(now);
    assert.equal(new Date(r.dateFrom).getTime(), new Date(2026, 6, 15, 0, 0, 0, 0).getTime());
    assert.equal((r as any).dateTo, undefined);
    // An event later this same day remains visible even though it's before "now"
    const earlierToday = new Date(2026, 6, 15, 9, 0).toISOString();
    assert.ok(earlierToday >= r.dateFrom);
    // A far-future event is not excluded
    assert.ok(new Date(2026, 11, 1).toISOString() >= r.dateFrom);
  });

  it('tomorrowRange covers exactly the next local day', () => {
    const now = new Date(2026, 6, 15, 10, 0);
    const r = tomorrowRange(now);
    assert.ok(new Date(2026, 6, 16, 0, 30).toISOString() >= r.dateFrom);
    assert.ok(new Date(2026, 6, 16, 23, 0).toISOString() <= r.dateTo);
    assert.ok(new Date(2026, 6, 17, 1, 0).toISOString() > r.dateTo);
  });
});
