/**
 * eventRoleActions.test.ts
 *
 * Unit tests for getHostActionSet() and getAttendeeActionSet() — the pure
 * helpers that drive HostDashboardPanel actions and attendee action bars.
 *
 * Critical invariants tested:
 *   - Banned users are fully locked out: no RSVP, leave, or waitlist actions.
 *   - Host ban capability: available during active states, not after closure.
 *   - Role escalation: only host (not co_host/moderator) can cancel or mark complete.
 *   - Attendee actions gate correctly on event lifecycle state.
 *
 * Pure functions; zero React Native / Supabase dependencies.
 * Run: node --import tsx/esm --test src/lib/__tests__/eventRoleActions.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getHostActionSet, getAttendeeActionSet } from '../eventRoleActions.ts';
import type { EventRole, EventLifecycleState } from '../eventRoleActions.ts';

// ── Banned attendee — must be fully locked out ────────────────────────────────

describe('getAttendeeActionSet() — banned user is fully locked out', () => {
  const bannedStates: EventLifecycleState[] = ['open', 'full', 'waitlist', 'started', 'completed', 'cancelled'];

  for (const state of bannedStates) {
    it(`banned user has no attendee actions in state: ${state}`, () => {
      const actions = getAttendeeActionSet('banned', state);
      assert.equal(actions.canRsvp,         false, `banned must not RSVP in ${state}`);
      assert.equal(actions.canLeave,        false, `banned must not leave in ${state}`);
      assert.equal(actions.canJoinWaitlist, false, `banned must not join waitlist in ${state}`);
    });
  }
});

// ── Host ban capability — available during active states only ─────────────────

describe('getHostActionSet() — ban capability by event state', () => {
  it('host can ban a user from an open event', () => {
    assert.equal(getHostActionSet('host', 'open').canBanUser, true);
  });

  it('host can ban a user from a full event', () => {
    assert.equal(getHostActionSet('host', 'full').canBanUser, true);
  });

  it('host can ban during a started event', () => {
    assert.equal(getHostActionSet('host', 'started').canBanUser, true);
  });

  it('host cannot ban after event is completed', () => {
    assert.equal(getHostActionSet('host', 'completed').canBanUser, false, 'completed events are closed for management');
  });

  it('host cannot ban after event is cancelled', () => {
    assert.equal(getHostActionSet('host', 'cancelled').canBanUser, false);
  });

  it('host cannot ban from an archived event', () => {
    assert.equal(getHostActionSet('host', 'archived').canBanUser, false);
  });

  it('co_host can ban attendees from an open event', () => {
    assert.equal(getHostActionSet('co_host', 'open').canBanUser, true);
  });

  it('moderator can ban attendees from an open event', () => {
    assert.equal(getHostActionSet('moderator', 'open').canBanUser, true);
  });

  it('null role has no ban capability', () => {
    assert.equal(getHostActionSet(null, 'open').canBanUser, false);
  });
});

// ── Role privilege escalation — only host can do destructive ops ──────────────

describe('getHostActionSet() — host-only privileges', () => {
  it('only host can mark event complete', () => {
    assert.equal(getHostActionSet('host',      'started').canMarkComplete, true);
    assert.equal(getHostActionSet('co_host',   'started').canMarkComplete, false);
    assert.equal(getHostActionSet('moderator', 'started').canMarkComplete, false);
  });

  it('only host can cancel the event', () => {
    assert.equal(getHostActionSet('host',      'open').canCancel, true);
    assert.equal(getHostActionSet('co_host',   'open').canCancel, false);
    assert.equal(getHostActionSet('moderator', 'open').canCancel, false);
  });

  it('only host can promote someone to co_host', () => {
    assert.equal(getHostActionSet('host',      'open').canPromoteToCoHost, true);
    assert.equal(getHostActionSet('co_host',   'open').canPromoteToCoHost, false);
    assert.equal(getHostActionSet('moderator', 'open').canPromoteToCoHost, false);
  });
});

// ── Attendee action gates on lifecycle state ──────────────────────────────────

describe('getAttendeeActionSet() — lifecycle gates for regular attendees', () => {
  it('can RSVP on an open event', () => {
    assert.equal(getAttendeeActionSet(null, 'open').canRsvp, true);
  });

  it('can RSVP on a started event (late arrivals allowed while event is live)', () => {
    assert.equal(
      getAttendeeActionSet(null, 'started').canRsvp,
      true,
      'started must allow RSVP — matches original [\'open\',\'started\'] behavior',
    );
  });

  it('can RSVP on a waitlist event (joins waitlist instead of directly)', () => {
    assert.equal(getAttendeeActionSet(null, 'waitlist').canRsvp, true);
  });

  it('cannot RSVP on a full event (must join waitlist instead)', () => {
    assert.equal(getAttendeeActionSet(null, 'full').canRsvp, false);
  });

  it('cannot RSVP on a completed event', () => {
    assert.equal(getAttendeeActionSet(null, 'completed').canRsvp, false);
  });

  it('cannot RSVP on a cancelled event', () => {
    assert.equal(getAttendeeActionSet(null, 'cancelled').canRsvp, false);
  });

  it('can join waitlist when event is full', () => {
    assert.equal(getAttendeeActionSet(null, 'full').canJoinWaitlist, true);
  });

  it('can join waitlist when event is in waitlist state', () => {
    assert.equal(getAttendeeActionSet(null, 'waitlist').canJoinWaitlist, true);
  });

  it('cannot join waitlist on an open event (no need)', () => {
    assert.equal(getAttendeeActionSet(null, 'open').canJoinWaitlist, false);
  });

  it('can leave an ongoing event', () => {
    assert.equal(getAttendeeActionSet(null, 'started').canLeave, true);
  });

  it('cannot leave a completed event', () => {
    assert.equal(getAttendeeActionSet(null, 'completed').canLeave, false);
  });
});
