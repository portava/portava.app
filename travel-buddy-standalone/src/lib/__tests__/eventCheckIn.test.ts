/**
 * eventCheckIn.test.ts — the client mirror of the server's check-in window
 * (artifacts/api-server/src/routes/events.ts `eventCheckInRefusal`) and the
 * host attendance-control gates.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/eventCheckIn.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkInWindow, attendanceMarkingOpen, attendanceMark, readAttendanceTimes } from '../eventCheckIn.ts';

const START = Date.parse('2026-10-01T18:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

describe('checkInWindow', () => {
  it('is not yet open more than an hour before the start, and says when it opens', () => {
    const w = checkInWindow('open', iso(START), null, START - H - 1);
    assert.equal(w.status, 'not_yet');
    assert.equal(w.status === 'not_yet' && w.opensAt, START - H);
  });
  it('opens exactly one hour before the start', () => {
    assert.equal(checkInWindow('open', iso(START), null, START - H).status, 'open');
  });
  it('closes two hours after the end', () => {
    const end = START + 3 * H;
    assert.equal(checkInWindow('started', iso(START), iso(end), end + 2 * H).status, 'open');
    assert.equal(checkInWindow('started', iso(START), iso(end), end + 2 * H + 1).status, 'closed');
  });
  it('with no end time, closes eight hours after the start', () => {
    assert.equal(checkInWindow('open', iso(START), null, START + 8 * H).status, 'open');
    assert.equal(checkInWindow('open', iso(START), null, START + 8 * H + 1).status, 'closed');
  });
  it('is closed for draft, cancelled, archived and completed events, and with no start time', () => {
    for (const s of ['draft', 'cancelled', 'archived', 'completed']) {
      assert.equal(checkInWindow(s, iso(START), null, START).status, 'closed', s);
    }
    assert.equal(checkInWindow('open', null, null, START).status, 'closed');
  });
});

describe('attendanceMarkingOpen — keyed on the STORED state', () => {
  it('only started and completed', () => {
    assert.equal(attendanceMarkingOpen('started'), true);
    assert.equal(attendanceMarkingOpen('completed'), true);
    for (const s of ['open', 'full', 'waitlist', 'draft', 'cancelled', 'archived', null]) {
      assert.equal(attendanceMarkingOpen(s), false, String(s));
    }
  });
});

describe('attendanceMark', () => {
  const none = { checkedInAt: null, confirmedAt: null, noShowAt: null };
  it('unmarked, checked in, confirmed, no-show', () => {
    assert.equal(attendanceMark(none), 'unmarked');
    assert.equal(attendanceMark({ ...none, checkedInAt: iso(START) }), 'checked_in');
    assert.equal(attendanceMark({ ...none, checkedInAt: iso(START), confirmedAt: iso(START + H) }), 'confirmed');
    assert.equal(attendanceMark({ ...none, noShowAt: iso(START + H) }), 'no_show');
  });
  it('the later host mark wins when both are set', () => {
    assert.equal(attendanceMark({ ...none, confirmedAt: iso(START), noShowAt: iso(START + H) }), 'no_show');
    assert.equal(attendanceMark({ ...none, confirmedAt: iso(START + H), noShowAt: iso(START) }), 'confirmed');
  });
});

describe('readAttendanceTimes — GET /events/:id sends the raw row', () => {
  it('reads snake_case (the wire) and camelCase (the type)', () => {
    const t = '2026-10-01T18:05:00Z';
    assert.deepEqual(readAttendanceTimes({ checked_in_at: t, confirmed_at: null, no_show_at: null }),
      { checkedInAt: t, confirmedAt: null, noShowAt: null });
    assert.deepEqual(readAttendanceTimes({ checkedInAt: t }), { checkedInAt: t, confirmedAt: null, noShowAt: null });
  });
  it('null / missing / non-string is not a check-in', () => {
    assert.deepEqual(readAttendanceTimes(null), { checkedInAt: null, confirmedAt: null, noShowAt: null });
    assert.deepEqual(readAttendanceTimes({ checked_in_at: '' }), { checkedInAt: null, confirmedAt: null, noShowAt: null });
  });
});
