/**
 * waitlistState.test.ts
 *
 * Unit tests for getWaitlistUiState() — the pure mapper that drives the
 * waitlist action bar on the event detail screen.
 *
 * Key scenarios tested:
 *   - Closed events (completed/cancelled/archived) always return 'event_closed'
 *   - Accepted waitlist offer (going RSVP) → 'promoted'
 *   - Not on waitlist → 'not_on_waitlist'
 *   - On waitlist, no offer → 'on_waitlist'
 *   - Active offer window → 'offer_pending'
 *   - Expired offer window → 'offer_expired'
 *
 * Pure function; zero React Native / Supabase dependencies.
 * Run: node --import tsx/esm --test src/lib/__tests__/waitlistState.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getWaitlistUiState } from '../waitlistState.ts';
import type { WaitlistStateParams } from '../waitlistState.ts';

const FAR_FUTURE  = '2099-12-31T23:59:59Z';
const FAR_PAST    = '2000-01-01T00:00:00Z';
const FIXED_NOW   = new Date('2025-07-06T12:00:00Z');

function params(overrides: Partial<WaitlistStateParams> = {}): WaitlistStateParams {
  return {
    myWaitlistPosition:        null,
    myWaitlistOfferExpiresAt:  null,
    eventState:                'open',
    myRsvp:                    null,
    ...overrides,
  };
}

describe('getWaitlistUiState() — closed event states', () => {
  it('returns event_closed for a completed event', () => {
    assert.equal(
      getWaitlistUiState(params({ myWaitlistPosition: 1, eventState: 'completed' }), FIXED_NOW),
      'event_closed',
    );
  });

  it('returns event_closed for a cancelled event', () => {
    assert.equal(
      getWaitlistUiState(params({ eventState: 'cancelled' }), FIXED_NOW),
      'event_closed',
    );
  });

  it('returns event_closed for an archived event', () => {
    assert.equal(
      getWaitlistUiState(params({ eventState: 'archived' }), FIXED_NOW),
      'event_closed',
    );
  });

  it('returns event_closed even when the user has a position', () => {
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: FAR_FUTURE, eventState: 'completed' }),
        FIXED_NOW,
      ),
      'event_closed',
      'event state takes priority over waitlist position',
    );
  });
});

describe('getWaitlistUiState() — promoted (waitlist offer accepted)', () => {
  it('returns promoted when myRsvp is going', () => {
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: FAR_FUTURE, eventState: 'open', myRsvp: 'going' }),
        FIXED_NOW,
      ),
      'promoted',
    );
  });

  it('returns promoted even when position is null (post-accept cleanup)', () => {
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: null, eventState: 'open', myRsvp: 'going' }),
        FIXED_NOW,
      ),
      'promoted',
    );
  });
});

describe('getWaitlistUiState() — not on waitlist', () => {
  it('returns not_on_waitlist when position is null and event is full', () => {
    assert.equal(
      getWaitlistUiState(params({ myWaitlistPosition: null, eventState: 'full' }), FIXED_NOW),
      'not_on_waitlist',
    );
  });

  it('returns not_on_waitlist when position is null and event is in waitlist state', () => {
    assert.equal(
      getWaitlistUiState(params({ myWaitlistPosition: null, eventState: 'waitlist' }), FIXED_NOW),
      'not_on_waitlist',
    );
  });
});

describe('getWaitlistUiState() — on waitlist (waiting for promotion)', () => {
  it('returns on_waitlist when position is set but no offer has been made', () => {
    assert.equal(
      getWaitlistUiState(params({ myWaitlistPosition: 3, myWaitlistOfferExpiresAt: null, eventState: 'waitlist' }), FIXED_NOW),
      'on_waitlist',
    );
  });

  it('returns on_waitlist for position 1 with no offer (next in line but not yet promoted)', () => {
    assert.equal(
      getWaitlistUiState(params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: null, eventState: 'full' }), FIXED_NOW),
      'on_waitlist',
    );
  });
});

describe('getWaitlistUiState() — offer states (waitlist promotion)', () => {
  it('returns offer_pending when offer expiry is in the future', () => {
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: FAR_FUTURE, eventState: 'waitlist' }),
        FIXED_NOW,
      ),
      'offer_pending',
      'user should see Accept button when offer has not expired',
    );
  });

  it('returns offer_expired when offer expiry has already passed', () => {
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: FAR_PAST, eventState: 'waitlist' }),
        FIXED_NOW,
      ),
      'offer_expired',
      'expired offer must not show Accept button',
    );
  });

  it('returns offer_expired when expiry equals now (boundary: not strictly greater)', () => {
    const borderlineExpiry = FIXED_NOW.toISOString();
    assert.equal(
      getWaitlistUiState(
        params({ myWaitlistPosition: 1, myWaitlistOfferExpiresAt: borderlineExpiry, eventState: 'waitlist' }),
        FIXED_NOW,
      ),
      'offer_expired',
    );
  });
});
