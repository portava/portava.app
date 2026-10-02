/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): lib/eventListMarks — what an events list could not
 * read, as the screens read it.
 *
 *   LM1  `event_rsvps` named → every event's going count is marked; `event_waitlist` → every waitlist count
 *   LM2  a body that names neither read is returned unchanged (the same object)
 *   LM3  the card text: a marked count is "(last known)"; an unread waitlist of 0 is said, a whole one is omitted
 *   LM4  `truncated: true` and only that is "not whole"
 *   LM5  a failed ApiResult passes through unmarked; an ok one has its events marked
 *   LM0  CONTROL: the healthy card text is the text the cards built before
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/eventListMarks.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markEventListCounts, markEventListResult, eventListNotWhole, attendanceText, goingText,
} from '../eventListMarks.ts';

const ev = (id: string) => ({ id, goingCount: 5, maxAttendees: 10, waitlistCount: 0 });

describe('census-discovery §117 (SW17): eventListMarks', () => {
  test('LM1 a named read marks every event', () => {
    const g = markEventListCounts({ events: [ev('a'), ev('b')], failedSources: ['event_rsvps'] });
    assert.deepEqual(g.events.map((e: any) => [e.goingCountUnread, e.waitlistCountUnread]), [[true, undefined], [true, undefined]]);
    const w = markEventListCounts({ events: [ev('a')], failedSources: ['event_waitlist'] });
    assert.deepEqual(w.events.map((e: any) => [e.goingCountUnread, e.waitlistCountUnread]), [[undefined, true]]);
  });
  test('LM2 a body that names neither read is the same object', () => {
    const b = { events: [ev('a')], page: 1 };
    assert.equal(markEventListCounts(b), b);
    const other = { events: [ev('a')], failedSources: ['profiles'] };
    assert.equal(markEventListCounts(other), other);
  });
  test('LM3 a marked count is said as last known', () => {
    assert.equal(attendanceText({ ...ev('a'), goingCountUnread: true }), '5 going/10 (last known)');
    assert.equal(attendanceText({ ...ev('a'), waitlistCountUnread: true }, { waitlist: true }), '5 going/10 · 0 waiting (last known)');
    assert.equal(goingText(3, true), '3 going (last known)');
  });
  test('LM4 only truncated: true is not whole', () => {
    assert.equal(eventListNotWhole({ truncated: true }), true);
    assert.equal(eventListNotWhole({ truncated: false }), false);
    assert.equal(eventListNotWhole({}), false);
    assert.equal(eventListNotWhole(null), false);
  });
  test('LM5 a failed result passes through; an ok one is marked', () => {
    const bad = { ok: false as const, message: 'x' };
    assert.equal(markEventListResult(bad), bad);
    const ok = markEventListResult({ ok: true as const, data: { events: [ev('a')], failedSources: ['event_rsvps'] } });
    assert.equal((ok.data.events[0] as any).goingCountUnread, true);
  });
  test('LM0 CONTROL: the healthy text is the cards\' own', () => {
    assert.equal(attendanceText(ev('a')), '5 going/10');
    assert.equal(attendanceText({ ...ev('a'), maxAttendees: null }), '5 going');
    assert.equal(attendanceText(ev('a'), { waitlist: true }), '5 going/10');
    assert.equal(attendanceText({ ...ev('a'), waitlistCount: 2 }, { waitlist: true }), '5 going/10 · 2 waiting');
    assert.equal(goingText(undefined), '0 going');
  });
});
