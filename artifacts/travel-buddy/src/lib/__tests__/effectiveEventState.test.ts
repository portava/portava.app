/**
 * Unit tests for effectiveEventState() in src/lib/eventRoleActions.ts.
 *
 * Run via:
 *   node --import tsx/esm --test src/lib/__tests__/effectiveEventState.test.ts
 *
 * Covers:
 *  - Terminal states pass through unchanged.
 *  - Active state with endsAt in past → completed.
 *  - Active state with startsAt in past, endsAt in future → started ("Happening now").
 *  - Active state with startsAt in past, no endsAt → started ("Happening now").
 *  - Active state with neither time passed → unchanged.
 *  - No time fields → unchanged.
 *  - Already-started state passes through / upgrades to completed correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveEventState } from '../eventRoleActions.ts';

const PAST   = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 h ago
const RECENT = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 h ago
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 h from now
const FAR    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 1 week from now

describe('effectiveEventState — terminal states pass through unchanged', () => {
  const terminals = ['completed', 'cancelled', 'archived', 'draft'] as const;
  for (const s of terminals) {
    it(`${s} is never re-mapped`, () => {
      assert.equal(effectiveEventState(s, PAST, PAST), s);
      assert.equal(effectiveEventState(s, PAST, FUTURE), s);
      assert.equal(effectiveEventState(s, null, null), s);
    });
  }
});

describe('effectiveEventState — completed when endsAt has passed', () => {
  it('open → completed when endsAt is in the past', () => {
    assert.equal(effectiveEventState('open', PAST, PAST), 'completed');
  });

  it('full → completed when endsAt is in the past', () => {
    assert.equal(effectiveEventState('full', PAST, PAST), 'completed');
  });

  it('waitlist → completed when endsAt is in the past', () => {
    assert.equal(effectiveEventState('waitlist', PAST, PAST), 'completed');
  });

  it('started → completed when endsAt is in the past', () => {
    assert.equal(effectiveEventState('started', PAST, PAST), 'completed');
  });

  it('prioritises endsAt over startsAt for completion check', () => {
    // endsAt in future: not completed, even if startsAt also in future
    assert.notEqual(effectiveEventState('open', FUTURE, FUTURE), 'completed');
    // endsAt in past: completed regardless of startsAt
    assert.equal(effectiveEventState('open', FUTURE, PAST), 'completed');
  });
});

describe('effectiveEventState — auto-promotes to started ("Happening now")', () => {
  it('open → started when startsAt is in the past and endsAt is in the future', () => {
    assert.equal(effectiveEventState('open', PAST, FUTURE), 'started');
  });

  it('full → started when startsAt is in the past and endsAt is in the future', () => {
    assert.equal(effectiveEventState('full', PAST, FUTURE), 'started');
  });

  it('waitlist → started when startsAt is in the past and endsAt is in the future', () => {
    assert.equal(effectiveEventState('waitlist', PAST, FUTURE), 'started');
  });

  it('open → started when startsAt is in the past and endsAt is null (no end time set)', () => {
    assert.equal(effectiveEventState('open', PAST, null), 'started');
  });

  it('full → started when startsAt is in the past and endsAt is undefined', () => {
    assert.equal(effectiveEventState('full', PAST, undefined), 'started');
  });

  it('startsAt exactly at now is treated as started', () => {
    const exactlyNow = Date.now();
    const iso = new Date(exactlyNow).toISOString();
    // Pass `now` explicitly to avoid any clock drift between the two Date.now() calls
    assert.equal(effectiveEventState('open', iso, FUTURE, exactlyNow), 'started');
  });

  it('multi-day event: startsAt yesterday, endsAt tomorrow → started', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tomorrow  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    assert.equal(effectiveEventState('open', yesterday, tomorrow), 'started');
  });
});

describe('effectiveEventState — unchanged when event has not started', () => {
  it('open → open when both times are in the future', () => {
    assert.equal(effectiveEventState('open', FUTURE, FAR), 'open');
  });

  it('full → full when startsAt is in the future', () => {
    assert.equal(effectiveEventState('full', FUTURE, FAR), 'full');
  });

  it('waitlist → waitlist when startsAt is in the future', () => {
    assert.equal(effectiveEventState('waitlist', FUTURE, FAR), 'waitlist');
  });

  it('open → open when no time fields are present', () => {
    assert.equal(effectiveEventState('open', null, null), 'open');
  });

  it('open → open when only endsAt is set and it is in the future', () => {
    assert.equal(effectiveEventState('open', null, FUTURE), 'open');
  });
});

describe('effectiveEventState — already-started state stays started until endsAt passes', () => {
  it('started → started when endsAt is in the future', () => {
    assert.equal(effectiveEventState('started', RECENT, FUTURE), 'started');
  });

  it('started → completed once endsAt passes', () => {
    assert.equal(effectiveEventState('started', PAST, PAST), 'completed');
  });
});
