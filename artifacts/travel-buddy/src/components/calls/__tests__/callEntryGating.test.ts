/**
 * Entry-point gating for call buttons (Phase 3) — pure logic tests.
 * node:test style — discovered by scripts/run-node-tests.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canShowThreadCallButtons,
  threadCallContextType,
  RAB_CALL_ELIGIBLE_STATUSES,
} from '../callEntryGating.ts';

const base = { otherUserId: 'u2', isWaitingForReply: false };

describe('threadCallContextType', () => {
  it('maps RAB booking threads to rent_a_buddy, everything else to telegraph_dm', () => {
    assert.equal(threadCallContextType('rent_buddy_booking'), 'rent_a_buddy');
    assert.equal(threadCallContextType('direct'), 'telegraph_dm');
    assert.equal(threadCallContextType(undefined), 'telegraph_dm');
  });
});

describe('canShowThreadCallButtons — plain DMs', () => {
  it('shows for a direct thread with a known other party', () => {
    assert.equal(canShowThreadCallButtons({ ...base, threadType: 'direct' }), true);
  });
  it('hides while a message request is pending or the other party is unknown', () => {
    assert.equal(canShowThreadCallButtons({ ...base, threadType: 'direct', isWaitingForReply: true }), false);
    assert.equal(canShowThreadCallButtons({ threadType: 'direct', otherUserId: undefined, isWaitingForReply: false }), false);
  });
  it('never shows on group threads', () => {
    assert.equal(canShowThreadCallButtons({ ...base, threadType: 'trip' }), false);
    assert.equal(canShowThreadCallButtons({ ...base, threadType: 'circle' }), false);
  });
});

describe('canShowThreadCallButtons — RAB booking threads', () => {
  it('shows for every call-eligible booking status', () => {
    for (const status of RAB_CALL_ELIGIBLE_STATUSES) {
      assert.equal(
        canShowThreadCallButtons({ ...base, threadType: 'rent_buddy_booking', rabBookingStatus: status }),
        true,
        status,
      );
    }
  });
  it('hides for pre-confirmation, cancelled, and completed bookings', () => {
    for (const status of ['pending', 'requested', 'cancelled', 'completed', 'no_show_pending']) {
      assert.equal(
        canShowThreadCallButtons({ ...base, threadType: 'rent_buddy_booking', rabBookingStatus: status }),
        false,
        status,
      );
    }
  });
  it('shows for completed bookings only when BOTH parties stayed connected', () => {
    const completed = { ...base, threadType: 'rent_buddy_booking', rabBookingStatus: 'completed' };
    assert.equal(
      canShowThreadCallButtons({ ...completed, rabStayConnectedTraveler: true, rabStayConnectedBuddy: true }),
      true,
    );
    assert.equal(
      canShowThreadCallButtons({ ...completed, rabStayConnectedTraveler: true, rabStayConnectedBuddy: false }),
      false,
    );
    assert.equal(
      canShowThreadCallButtons({ ...completed, rabStayConnectedTraveler: false, rabStayConnectedBuddy: true }),
      false,
    );
    assert.equal(canShowThreadCallButtons(completed), false);
  });
  it('stay-connected flags do not unlock non-completed ineligible statuses', () => {
    for (const status of ['cancelled', 'requested', 'expired']) {
      assert.equal(
        canShowThreadCallButtons({
          ...base, threadType: 'rent_buddy_booking', rabBookingStatus: status,
          rabStayConnectedTraveler: true, rabStayConnectedBuddy: true,
        }),
        false,
        status,
      );
    }
  });
  it('hides while the booking status is still loading', () => {
    assert.equal(
      canShowThreadCallButtons({ ...base, threadType: 'rent_buddy_booking', rabBookingStatus: null }),
      false,
    );
    assert.equal(
      canShowThreadCallButtons({ ...base, threadType: 'rent_buddy_booking' }),
      false,
    );
  });
  it('still hides when a request is pending or the other party is unknown', () => {
    assert.equal(
      canShowThreadCallButtons({ ...base, threadType: 'rent_buddy_booking', rabBookingStatus: 'in_progress', isWaitingForReply: true }),
      false,
    );
    assert.equal(
      canShowThreadCallButtons({ threadType: 'rent_buddy_booking', otherUserId: null, isWaitingForReply: false, rabBookingStatus: 'in_progress' }),
      false,
    );
  });
});
