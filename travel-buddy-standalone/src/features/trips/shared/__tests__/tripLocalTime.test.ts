/**
 * census-trips TR13 / TR15 / TR123: a wall time typed in a NAMED zone becomes
 * an instant that carries its offset — and the skipped and repeated times are
 * said, never guessed.
 * Run: node --import tsx/esm --test src/features/trips/shared/__tests__/tripLocalTime.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  readDateText, readClockText, usableZone, instantInZone, offsetWords, dateWords,
  readTypedTime, typedTimeOf, typedTimeProblem, EMPTY_TYPED_TIME,
} from '../tripLocalTime.ts';
import * as itineraryTimes from '../../../../platform/input-assistance/paste/itineraryTimes.ts';

describe('reading what was typed', () => {
  it('a date is year-month-day and a real calendar date', () => {
    assert.equal(readDateText(' 2026-10-23 '), '2026-10-23');
    for (const bad of ['2026-02-30', '23/10/2026', '2026-10-23T19:00', '']) assert.equal(readDateText(bad), null, bad);
  });

  it('a time is 24-hour HH:MM — a bare "7" is morning or evening, so it is not a time', () => {
    assert.deepEqual(readClockText('19:00'), { hour: 19, minute: 0 });
    assert.deepEqual(readClockText('00:05'), { hour: 0, minute: 5 });
    for (const bad of ['7', '7pm', '7:30', '24:00', '19:60', '']) assert.equal(readClockText(bad), null, bad);
  });

  it('the zone rules and the offset words are itineraryTimes.ts\'s — one conversion, not two', () => {
    assert.equal(usableZone, itineraryTimes.usableZone);
    assert.equal(offsetWords, itineraryTimes.offsetWords);
    assert.equal(usableZone(' Asia/Ho_Chi_Minh '), 'Asia/Ho_Chi_Minh');
    for (const bad of ['Mars/Olympus_Mons', 'UTC+3', '']) assert.equal(usableZone(bad), null, bad);
  });
});

describe('a typed wall time in a zone, as an instant with its offset', () => {
  const v = (date: string, time: string, pick: 'earlier' | 'later' | null = null) => ({ date, time, pick });
  it('the ordinary case is one instant, offset included', () => {
    assert.deepEqual(readTypedTime(v('2026-10-23', '19:00'), 'Asia/Ho_Chi_Minh'), { kind: 'ok', iso: '2026-10-23T19:00:00+07:00' });
    assert.deepEqual(readTypedTime(v('2026-07-01', '09:30'), 'America/New_York'), { kind: 'ok', iso: '2026-07-01T09:30:00-04:00' });
  });

  it('a time the clocks skip (spring forward) is skipped — not moved to the next valid minute', () => {
    assert.deepEqual(readTypedTime(v('2026-03-29', '01:30'), 'Europe/Lisbon'), { kind: 'skipped' });
    assert.deepEqual(readTypedTime(v('2026-03-08', '02:30'), 'America/New_York'), { kind: 'skipped' });
  });

  it('a time that happens twice (fall back) gives both instants until one is picked', () => {
    assert.deepEqual(readTypedTime(v('2026-10-25', '01:30'), 'Europe/Lisbon'), { kind: 'twice', earlier: '2026-10-25T01:30:00+01:00', later: '2026-10-25T01:30:00+00:00' });
    assert.deepEqual(readTypedTime(v('2026-11-01', '01:30', 'later'), 'America/New_York'), { kind: 'ok', iso: '2026-11-01T01:30:00-05:00' });
    assert.deepEqual(readTypedTime(v('2026-10-25', '01:30', 'earlier'), 'Europe/Lisbon'), { kind: 'ok', iso: '2026-10-25T01:30:00+01:00' });
  });

  it('an unusable zone is said — never replaced by the phone\'s', () => {
    assert.deepEqual(readTypedTime(v('2026-10-23', '19:00'), 'Not/AZone'), { kind: 'no_zone' });
    assert.deepEqual(readTypedTime(v('2026-10-23', '19:00'), null), { kind: 'no_zone' });
  });
});

describe('an instant the server served, in the stage\'s zone', () => {
  it('reads as that zone\'s wall clock', () => {
    assert.deepEqual(instantInZone('2026-10-23T12:00:00+00:00', 'Asia/Ho_Chi_Minh'), { date: '2026-10-23', time: '19:00' });
    assert.equal(instantInZone('2026-10-23T12:00:00+00:00', 'Not/AZone'), null);
    assert.equal(instantInZone(null, 'UTC'), null);
  });

  it('a served instant inside a repeated hour keeps itself when read back into a field', () => {
    const later = typedTimeOf('2026-10-25T01:30:00+00:00', 'Europe/Lisbon');
    assert.deepEqual(later, { date: '2026-10-25', time: '01:30', pick: 'later' });
    assert.deepEqual(readTypedTime(later, 'Europe/Lisbon'), { kind: 'ok', iso: '2026-10-25T01:30:00+00:00' });
    const earlier = typedTimeOf('2026-10-25T00:30:00+00:00', 'Europe/Lisbon');
    assert.equal(earlier.pick, 'earlier');
    assert.deepEqual(typedTimeOf(null, 'UTC'), EMPTY_TYPED_TIME);
  });
});

describe('a field being typed', () => {
  const v = (date: string, time: string, pick: 'earlier' | 'later' | null = null) => ({ date, time, pick });
  it('says which of its states it is in; only empty and ok can be sent', () => {
    assert.deepEqual(readTypedTime(v('', ''), 'UTC'), { kind: 'empty' });
    assert.deepEqual(readTypedTime(v('2026-10-23', ''), 'UTC'), { kind: 'incomplete' });
    assert.deepEqual(readTypedTime(v('23 Oct', '19:00'), 'UTC'), { kind: 'bad_date' });
    assert.deepEqual(readTypedTime(v('2026-10-23', '7pm'), 'UTC'), { kind: 'bad_time' });
    assert.deepEqual(readTypedTime(v('2026-10-23', '19:00'), null), { kind: 'no_zone' });
    assert.deepEqual(readTypedTime(v('2026-03-29', '01:30'), 'Europe/Lisbon'), { kind: 'skipped' });
    assert.equal(readTypedTime(v('2026-10-25', '01:30'), 'Europe/Lisbon').kind, 'twice');
    assert.deepEqual(readTypedTime(v('2026-10-25', '01:30', 'earlier'), 'Europe/Lisbon'), { kind: 'ok', iso: '2026-10-25T01:30:00+01:00' });
    assert.deepEqual(readTypedTime(v('2026-10-23', '19:00'), 'Asia/Ho_Chi_Minh'), { kind: 'ok', iso: '2026-10-23T19:00:00+07:00' });
  });

  it('every state that cannot be sent has words; the two that can have none', () => {
    assert.equal(typedTimeProblem({ kind: 'empty' }, 'UTC'), null);
    assert.equal(typedTimeProblem({ kind: 'ok', iso: 'x' }, 'UTC'), null);
    assert.match(typedTimeProblem({ kind: 'skipped' }, 'Europe/Lisbon')!, /doesn't happen that day in Europe\/Lisbon — the clocks go forward/);
    assert.match(typedTimeProblem({ kind: 'twice', earlier: 'a', later: 'b' }, 'Europe/Lisbon')!, /happens twice .* Choose which one/);
    assert.match(typedTimeProblem({ kind: 'no_zone' }, null)!, /No time zone is known/);
  });

  it('words for the person', () => {
    assert.equal(offsetWords('2026-10-23T19:00:00+07:00'), 'GMT+7');
    assert.equal(offsetWords('2026-10-23T19:00:00+05:30'), 'GMT+5:30');
    assert.equal(dateWords('2026-10-23'), 'Fri 23 Oct 2026');
    assert.equal(dateWords('2026-02-30'), '2026-02-30');
  });
});
