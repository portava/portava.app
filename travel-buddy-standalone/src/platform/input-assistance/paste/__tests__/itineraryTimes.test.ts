/**
 * census G160 — reading an itinerary line's time and day WITHOUT GUESSING.
 * Run: node --import tsx/esm --test src/platform/input-assistance/paste/__tests__/itineraryTimes.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  readClock, readDay, tripDays, wallTimeToInstant, todayIn, usableZone,
  dayWords, clockWords, meridiemWords, offsetWords, MAX_DAY_OPTIONS,
} from '../itineraryTimes.ts';

const TRIP = { start: '2026-10-20', end: '2026-10-27' }; // Tue → Tue: one Friday, two Tuesdays

describe('readClock — a bare 1–12 is morning OR evening, never one of them', () => {
  it('reads the unambiguous forms exactly', () => {
    const cases: Array<[string, number, number]> = [
      ['7pm', 19, 0], ['7PM', 19, 0], ['7:30 p.m.', 19, 30], ['7:30a.m.', 7, 30], ['12am', 0, 0], ['12pm', 12, 0],
      ['19:00', 19, 0], ['0:30', 0, 30], ['00:15', 0, 15], ['07:30', 7, 30], ['21h', 21, 0], ['9h', 9, 0], ['23:59', 23, 59],
    ];
    for (const [hint, hour, minute] of cases) {
      assert.deepEqual(readClock(hint), { kind: 'exact', time: { hour, minute } }, hint);
    }
  });

  it('a bare hour or h:mm from 1 to 12 returns BOTH readings', () => {
    assert.deepEqual(readClock('7'), { kind: 'meridiem', am: { hour: 7, minute: 0 }, pm: { hour: 19, minute: 0 } });
    assert.deepEqual(readClock('10:30'), { kind: 'meridiem', am: { hour: 10, minute: 30 }, pm: { hour: 22, minute: 30 } });
    assert.deepEqual(readClock('12'), { kind: 'meridiem', am: { hour: 0, minute: 0 }, pm: { hour: 12, minute: 0 } });
    assert.deepEqual(readClock('11'), { kind: 'meridiem', am: { hour: 11, minute: 0 }, pm: { hour: 23, minute: 0 } });
  });

  it('anything else is unreadable — never clamped into a time', () => {
    for (const hint of ['25:00', '24', '7:75', '13pm', '0am', 'seven', '7 o’clock', '', '   ']) {
      assert.deepEqual(readClock(hint), { kind: 'unreadable' }, hint);
    }
    assert.deepEqual(readClock(null), { kind: 'unreadable' });
    assert.deepEqual(readClock(undefined), { kind: 'unreadable' });
  });
});

describe('readDay — a heading becomes ONE date or a choice', () => {
  it('a weekday that falls once inside the trip is that date; twice is a choice between those two', () => {
    assert.deepEqual(readDay('Friday', TRIP, null), { kind: 'date', date: '2026-10-23' });
    assert.deepEqual(readDay('Fri night', TRIP, null), { kind: 'date', date: '2026-10-23' });
    assert.deepEqual(readDay('Tuesday', TRIP, null), { kind: 'choose', why: 'weekday_many', options: ['2026-10-20', '2026-10-27'] });
    assert.deepEqual(readDay('Friday', { start: '2026-10-20', end: '2026-10-22' }, null),
      { kind: 'choose', why: 'weekday_none', options: ['2026-10-20', '2026-10-21', '2026-10-22'] });
  });

  it('Day N counts from the trip\'s first day and must fall inside it', () => {
    assert.deepEqual(readDay('Day 1', TRIP, null), { kind: 'date', date: '2026-10-20' });
    assert.deepEqual(readDay('day 2 Hoi An', TRIP, null), { kind: 'date', date: '2026-10-21' });
    assert.equal(readDay('Day 9', TRIP, null).kind, 'choose');
    assert.equal((readDay('Day 9', TRIP, null) as { why: string }).why, 'day_outside');
    assert.equal((readDay('Day 0', TRIP, null) as { why: string }).why, 'day_outside');
  });

  it('today / tonight / tomorrow are read against today IN THE STOP\'S ZONE, and need it', () => {
    assert.deepEqual(readDay('Tonight', TRIP, '2026-10-22'), { kind: 'date', date: '2026-10-22' });
    assert.deepEqual(readDay('today', TRIP, '2026-10-22'), { kind: 'date', date: '2026-10-22' });
    assert.deepEqual(readDay('Tomorrow', TRIP, '2026-10-31'), { kind: 'date', date: '2026-11-01' });
    assert.equal((readDay('today', TRIP, null) as { why: string }).why, 'unrecognised');
  });

  it('an ISO date is itself; a non-date is not', () => {
    assert.deepEqual(readDay('2026-10-25', TRIP, null), { kind: 'date', date: '2026-10-25' });
    assert.equal((readDay('2026-02-30', TRIP, null) as { why: string }).why, 'unrecognised');
  });

  it('no heading, a place heading and "weekend" are choices; a weekday with no trip dates has none to offer', () => {
    assert.deepEqual(readDay(null, TRIP, null), { kind: 'choose', why: 'no_label', options: tripDays(TRIP) });
    assert.deepEqual(readDay('Hoi An', TRIP, null), { kind: 'choose', why: 'unrecognised', options: tripDays(TRIP) });
    assert.deepEqual(readDay('Weekend', TRIP, null), { kind: 'choose', why: 'weekend', options: ['2026-10-24', '2026-10-25'] });
    assert.deepEqual(readDay('Friday', { start: null, end: null }, null), { kind: 'choose', why: 'no_trip_dates', options: [] });
    assert.deepEqual(readDay('Day 2', { start: null, end: null }, null), { kind: 'choose', why: 'no_trip_dates', options: [] });
    assert.deepEqual(readDay('Friday', null, null), { kind: 'choose', why: 'no_trip_dates', options: [] });
  });

  it('the trip\'s days run first to last; an unreadable or inverted window has none; offers are capped', () => {
    assert.deepEqual(tripDays({ start: '2026-10-30', end: '2026-11-02' }), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    assert.deepEqual(tripDays({ start: '2026-10-30T00:00:00Z', end: '2026-10-31' }), ['2026-10-30', '2026-10-31']);
    assert.deepEqual(tripDays({ start: '2026-11-02', end: '2026-10-30' }), []);
    assert.deepEqual(tripDays({ start: 'soon', end: '2026-10-30' }), []);
    const long = readDay(null, { start: '2026-01-01', end: '2026-12-31' }, null);
    assert.equal(long.kind === 'choose' && long.options.length, MAX_DAY_OPTIONS);
  });
});

describe('wallTimeToInstant — a wall time in a named zone, with its offset; DST is never papered over', () => {
  it('an ordinary wall time is one instant, written with the zone\'s offset', () => {
    assert.deepEqual(wallTimeToInstant('2026-10-23', { hour: 19, minute: 0 }, 'Asia/Ho_Chi_Minh'), { kind: 'exact', iso: '2026-10-23T19:00:00+07:00' });
    assert.deepEqual(wallTimeToInstant('2026-07-01', { hour: 12, minute: 0 }, 'America/St_Johns'), { kind: 'exact', iso: '2026-07-01T12:00:00-02:30' });
    assert.deepEqual(wallTimeToInstant('2026-01-05', { hour: 0, minute: 5 }, 'UTC'), { kind: 'exact', iso: '2026-01-05T00:05:00+00:00' });
    // the instant really is that wall time there
    const r = wallTimeToInstant('2026-10-23', { hour: 19, minute: 0 }, 'Asia/Ho_Chi_Minh');
    assert.equal(r.kind === 'exact' && new Date(r.iso).toISOString(), '2026-10-23T12:00:00.000Z');
  });

  it('spring forward: a wall time the clocks skip does not exist — it is NOT moved to the next valid minute', () => {
    assert.deepEqual(wallTimeToInstant('2026-03-29', { hour: 1, minute: 30 }, 'Europe/Lisbon'), { kind: 'skipped' });
    assert.deepEqual(wallTimeToInstant('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York'), { kind: 'skipped' });
  });

  it('fall back: a wall time that happens twice returns both instants, earlier first', () => {
    assert.deepEqual(wallTimeToInstant('2026-10-25', { hour: 1, minute: 30 }, 'Europe/Lisbon'),
      { kind: 'twice', earlier: '2026-10-25T01:30:00+01:00', later: '2026-10-25T01:30:00+00:00' });
    assert.deepEqual(wallTimeToInstant('2026-11-01', { hour: 1, minute: 30 }, 'America/New_York'),
      { kind: 'twice', earlier: '2026-11-01T01:30:00-04:00', later: '2026-11-01T01:30:00-05:00' });
  });

  it('an unknown zone is said, never replaced by another; a bad date is said', () => {
    assert.deepEqual(wallTimeToInstant('2026-10-23', { hour: 19, minute: 0 }, 'Mars/Olympus_Mons'), { kind: 'bad_zone' });
    assert.deepEqual(wallTimeToInstant('2026-10-23', { hour: 19, minute: 0 }, 'not a zone'), { kind: 'bad_zone' });
    assert.deepEqual(wallTimeToInstant('2026-10-23', { hour: 19, minute: 0 }, null), { kind: 'bad_zone' });
    assert.deepEqual(wallTimeToInstant('2026-02-30', { hour: 19, minute: 0 }, 'UTC'), { kind: 'bad_date' });
    assert.deepEqual(wallTimeToInstant('2026-02-03', { hour: 24, minute: 0 }, 'UTC'), { kind: 'bad_date' });
    assert.equal(usableZone(' Asia/Tokyo '), 'Asia/Tokyo');
    assert.equal(usableZone('Mars/Olympus_Mons'), null);
  });

  it('today is the date in the named zone, not the phone\'s', () => {
    const at = new Date('2026-10-23T20:00:00Z');
    assert.equal(todayIn('Asia/Tokyo', at), '2026-10-24');
    assert.equal(todayIn('America/Los_Angeles', at), '2026-10-23');
    assert.equal(todayIn('Mars/Olympus_Mons', at), null);
  });
});

describe('the review screen\'s words', () => {
  it('dates, clocks, the morning/evening choice and offsets', () => {
    assert.equal(dayWords('2026-10-23'), 'Fri 23 Oct');
    assert.equal(clockWords({ hour: 9, minute: 5 }), '09:05');
    assert.equal(meridiemWords({ hour: 19, minute: 0 }), '7:00 pm');
    assert.equal(meridiemWords({ hour: 0, minute: 30 }), '12:30 am');
    assert.equal(meridiemWords({ hour: 12, minute: 0 }), '12:00 pm');
    assert.equal(offsetWords('2026-10-25T01:30:00+01:00'), 'GMT+1');
    assert.equal(offsetWords('2026-07-01T12:00:00-02:30'), 'GMT-2:30');
    assert.equal(offsetWords('2026-10-25T01:30:00+00:00'), 'GMT');
  });
});
