/**
 * Rent a Buddy — who may do what to a booking, in which status (lane tm-rab).
 *
 * The flow catalogue (PLAT-F45) found that a booking could never be started or
 * completed from the app: startBooking / completeBooking / travelerConfirmComplete
 * had no callers. The screens now offer those controls, and WHICH controls a
 * viewer is offered is decided here, mirroring the server's own guards so the
 * app never shows a button the server will 409:
 *
 *   start               buddy only, from scheduled / confirmed         (rentABuddy.ts /start)
 *   complete            either party, from in_progress                 (/complete)
 *   confirm completion  traveller only, from completed_pending_traveler_confirmation (/traveler-confirm)
 *   emergency phrase    traveller only, while in_progress              (/safety/emergency-phrase is traveller-only)
 *   suggest / respond   before the session starts (pending, requested, confirmed, scheduled)
 *
 * Also pins the status labels for every status the server writes (the old
 * screen's label map had 8 of 14, so `completed_pending_traveler_confirmation`
 * rendered as a blank badge), and the plain-language rendering of a suggested
 * change.
 *
 * Run: pnpm --dir travel-buddy-standalone test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingParty,
  bookingStatusLabel,
  lifecycleActions,
  describeChangeRequest,
} from '../rentABuddyLifecycle.ts';

describe('bookingParty', () => {
  it('the traveller is the traveller; any other party viewer is the buddy', () => {
    assert.equal(bookingParty({ travelerId: 'u1' }, 'u1'), 'traveler');
    assert.equal(bookingParty({ travelerId: 'u1' }, 'u2'), 'buddy');
  });
  it('no signed-in viewer is no party', () => {
    assert.equal(bookingParty({ travelerId: 'u1' }, null), null);
  });
});

describe('lifecycleActions mirrors the server guards', () => {
  it('buddy may start a scheduled or confirmed booking; traveller may not', () => {
    for (const s of ['scheduled', 'confirmed']) {
      assert.equal(lifecycleActions(s, 'buddy').start, true, s);
      assert.equal(lifecycleActions(s, 'traveler').start, false, s);
    }
    for (const s of ['requested', 'pending', 'in_progress', 'completed', 'cancelled']) {
      assert.equal(lifecycleActions(s, 'buddy').start, false, s);
    }
  });

  it('either party may complete an in-progress booking, and only then', () => {
    assert.equal(lifecycleActions('in_progress', 'buddy').complete, true);
    assert.equal(lifecycleActions('in_progress', 'traveler').complete, true);
    for (const s of ['scheduled', 'completed_pending_traveler_confirmation', 'completed']) {
      assert.equal(lifecycleActions(s, 'buddy').complete, false, s);
    }
  });

  it('only the traveller confirms, and only from completed_pending_traveler_confirmation', () => {
    assert.equal(lifecycleActions('completed_pending_traveler_confirmation', 'traveler').confirmCompletion, true);
    assert.equal(lifecycleActions('completed_pending_traveler_confirmation', 'buddy').confirmCompletion, false);
    assert.equal(lifecycleActions('completed', 'traveler').confirmCompletion, false);
  });

  it('the emergency phrase is traveller-only and only during the session', () => {
    assert.equal(lifecycleActions('in_progress', 'traveler').emergencyPhrase, true);
    assert.equal(lifecycleActions('in_progress', 'buddy').emergencyPhrase, false);
    assert.equal(lifecycleActions('scheduled', 'traveler').emergencyPhrase, false);
  });

  it('check-in is offered from acceptance through the session', () => {
    for (const s of ['scheduled', 'confirmed', 'in_progress']) {
      assert.equal(lifecycleActions(s, 'traveler').checkIn, true, s);
      assert.equal(lifecycleActions(s, 'buddy').checkIn, true, s);
    }
    assert.equal(lifecycleActions('requested', 'traveler').checkIn, false);
    assert.equal(lifecycleActions('completed', 'traveler').checkIn, false);
  });

  it('changes can be suggested and answered only before the session starts', () => {
    for (const s of ['pending', 'requested', 'confirmed', 'scheduled']) {
      assert.equal(lifecycleActions(s, 'buddy').suggestChange, true, s);
      assert.equal(lifecycleActions(s, 'traveler').respondToChange, true, s);
    }
    for (const s of ['in_progress', 'completed', 'cancelled']) {
      assert.equal(lifecycleActions(s, 'buddy').suggestChange, false, s);
      assert.equal(lifecycleActions(s, 'traveler').respondToChange, false, s);
    }
  });

  it('a null party gets no actions at all', () => {
    const a = lifecycleActions('in_progress', null);
    assert.deepEqual(Object.values(a).filter(Boolean), []);
  });
});

describe('bookingStatusLabel', () => {
  it('labels every status the server writes', () => {
    for (const s of [
      'pending', 'requested', 'confirmed', 'scheduled', 'in_progress',
      'completed_pending_traveler_confirmation', 'completed', 'cancelled',
      'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'disputed',
      'expired', 'no_show_pending',
    ]) {
      const l = bookingStatusLabel(s);
      assert.ok(l.length > 0, s);
      assert.doesNotMatch(l, /_/, `${s} must not render as a raw enum`);
    }
  });
  it('an unknown status is still readable', () => {
    assert.equal(bookingStatusLabel('some_new_state'), 'Some new state');
  });
});

describe('describeChangeRequest', () => {
  it('a time change reads as from → to', () => {
    assert.equal(
      describeChangeRequest({ changeField: 'start_time', currentValue: { start_time: '10:00' }, proposedValue: { start_time: '14:00' } }),
      'Start time: 10:00 → 14:00',
    );
  });
  it('a date change reads as from → to', () => {
    assert.equal(
      describeChangeRequest({ changeField: 'date', currentValue: { date: '2026-10-10' }, proposedValue: { date: '2026-10-11' } }),
      'Date: 2026-10-10 → 2026-10-11',
    );
  });
  it('a duration change reads in hours', () => {
    assert.equal(
      describeChangeRequest({ changeField: 'duration_h', currentValue: { duration_h: 2 }, proposedValue: { duration_h: 3 } }),
      'Duration: 2h → 3h',
    );
  });
  it('a missing current value says so instead of printing undefined', () => {
    assert.equal(
      describeChangeRequest({ changeField: 'date', currentValue: {}, proposedValue: { date: '2026-10-11' } }),
      'Date: (not set) → 2026-10-11',
    );
  });
});
