/**
 * Booking-refusal copy — the "not yet available" state.
 *
 * Rent a Buddy is deliberately CLOSED for launch: identity verification and
 * payments are stubbed and the server-side gate answers 503
 * `verification_unavailable`. apiFetch surfaces the error CODE and drops the
 * server's `message`, so without this mapping the checkout screen alerted the
 * literal string "verification_unavailable" at a user who had just filled in
 * the entire form.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddy.bookingUnavailable.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_UNAVAILABLE_CODES,
  isBookingUnavailable,
  bookingErrorCopy,
} from '../rentABuddyBookingErrors.ts';

const UNAVAILABLE = [
  'verification_unavailable',
  'feature_disabled',
  'waitlist_only',
  'globally_paused',
  'city_not_launched',
];

describe('BOOKING_UNAVAILABLE_CODES / isBookingUnavailable', () => {
  it('contains exactly the five feature-closed codes', () => {
    assert.deepEqual([...BOOKING_UNAVAILABLE_CODES].sort(), [...UNAVAILABLE].sort());
  });

  it('classifies every feature-closed code as unavailable', () => {
    for (const code of UNAVAILABLE) {
      assert.equal(isBookingUnavailable(code), true, code);
    }
  });

  it('does NOT classify genuine failures as unavailable', () => {
    // These must keep the Alert path — they are real errors, not a closed feature.
    for (const code of ['db_error', 'forbidden', 'validation_error', 'HTTP 500', 'network_error']) {
      assert.equal(isBookingUnavailable(code), false, code);
    }
  });

  it('tolerates null/undefined/empty without throwing', () => {
    assert.equal(isBookingUnavailable(null), false);
    assert.equal(isBookingUnavailable(undefined), false);
    assert.equal(isBookingUnavailable(''), false);
  });
});

describe('bookingErrorCopy', () => {
  it('never returns a raw code for any feature-closed refusal', () => {
    for (const code of UNAVAILABLE) {
      const copy = bookingErrorCopy(code);
      assert.notEqual(copy, code, `${code}: copy must not be the raw code`);
      assert.ok(!copy.includes(code), `${code}: copy must not embed the raw code`);
      assert.ok(/\s/.test(copy), `${code}: copy must read as a sentence`);
    }
  });

  it('says plainly WHY bookings are closed for verification_unavailable', () => {
    const copy = bookingErrorCopy('verification_unavailable');
    assert.match(copy, /identity verification/i, 'must name the actual reason');
    assert.match(copy, /isn't open yet|not open yet/i, 'must say the feature is not open yet');
    assert.match(copy, /confirm who you're meeting/i, 'must be honest about why we hold bookings');
    // Not framed as the user's failure.
    assert.doesNotMatch(copy, /failed|error|invalid/i);
  });

  it('never echoes an unknown error CODE back to the user', () => {
    // The whole bug: a snake_case enum reaching a human.
    for (const code of ['db_error', 'some_new_server_code', 'forbidden', 'HTTP 503']) {
      const copy = bookingErrorCopy(code);
      assert.notEqual(copy, code, `${code} must not be shown raw`);
      assert.ok(/\s/.test(copy) && copy.length > 20, `${code} must fall back to human copy`);
    }
  });

  it('passes through a human-readable message unchanged', () => {
    // apiFetch's catch branch yields real exception text — that IS human copy.
    const msg = 'Network request failed';
    assert.equal(bookingErrorCopy(msg), msg);
  });

  it('prefers the caller\'s fallback over the generic sentence', () => {
    const tailored = 'Please call local emergency services if you are in danger.';
    // Unknown code, empty, null — all resolve to the caller's own sentence.
    assert.equal(bookingErrorCopy('db_error', tailored), tailored);
    assert.equal(bookingErrorCopy('HTTP 500', tailored), tailored);
    assert.equal(bookingErrorCopy(null, tailored), tailored);
    assert.equal(bookingErrorCopy(undefined, tailored), tailored);
    assert.equal(bookingErrorCopy('', tailored), tailored);
  });

  it('a fallback never overrides real feature-closed copy', () => {
    // The site's generic sentence must not mask the specific, honest reason.
    const copy = bookingErrorCopy('verification_unavailable', 'Please try again.');
    assert.match(copy, /identity verification/i);
    assert.notEqual(copy, 'Please try again.');
  });

  it('a fallback never causes a raw code to be shown', () => {
    for (const code of ['db_error', 'forbidden', 'some_new_code']) {
      const copy = bookingErrorCopy(code, 'Could not accept booking.');
      assert.notEqual(copy, code);
      assert.ok(!copy.includes(code));
    }
  });

  it('returns generic copy for null/undefined/empty', () => {
    const generic = bookingErrorCopy(null);
    assert.ok(/\s/.test(generic));
    assert.equal(bookingErrorCopy(undefined), generic);
    assert.equal(bookingErrorCopy(''), generic);
    assert.equal(bookingErrorCopy('   '), generic);
  });
});
