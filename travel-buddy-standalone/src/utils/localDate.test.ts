import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey, localTodayKey } from './localDate.ts';

describe('localDate — LOCAL calendar day, not UTC', () => {
  it('keys a late-evening LOCAL instant to its local day (TZ-independent)', () => {
    // Constructed from LOCAL components, so this holds in EVERY timezone — which
    // is exactly the fix: toISOString().slice(0,10) would roll this to
    // 2026-08-30 at any positive UTC offset.
    const d = new Date(2026, 7, 29, 23, 30, 0);
    assert.equal(localDateKey(d), '2026-08-29');
  });

  it('keys an early-morning LOCAL instant to its local day', () => {
    const d = new Date(2026, 0, 1, 0, 15, 0); // 2026-01-01 00:15 local
    assert.equal(localDateKey(d), '2026-01-01');
  });

  it('localTodayKey === localDateKey(now)', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    assert.equal(localTodayKey(now), '2026-06-15');
    assert.equal(localTodayKey(now), localDateKey(now));
  });

  it('accepts an ISO string and epoch ms, and is empty on invalid input', () => {
    assert.equal(localDateKey('2026-03-04T12:00:00'), '2026-03-04');
    assert.equal(localDateKey(new Date(2026, 2, 4, 12).getTime()), '2026-03-04');
    assert.equal(localDateKey('not-a-date'), '');
  });
});
