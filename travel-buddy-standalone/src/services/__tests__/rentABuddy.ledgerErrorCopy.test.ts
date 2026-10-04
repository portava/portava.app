/**
 * Copy for the money record's own error codes (payments PAY-T12).
 *
 * The API answers by name when a price, a ledger write, a tip, add-ons or a
 * payout transition cannot be done: 503 `ledger_unavailable`, 503
 * `ledger_write_failed`, or — when the database looked and said no — a 4xx
 * `ledger_refused` with `retryable: false`. None of the three had copy, so each
 * read "Something went wrong on our side … Please try again."
 *
 *   E1  every `ledger_*` code has human copy, and a raw code is never shown;
 *   E2  the two outages say nothing was changed or charged, and invite a retry;
 *   E3  the refusal says a retry will not help — and never defers to a caller's
 *       fallback, which usually ends "try again";
 *   E4  the outages DO defer to a caller's sentence when it has one;
 *   E5  every screen that can receive one of these codes passes it through
 *       bookingErrorCopy (or classifyBookingRefusal), not to the user raw.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddy.ledgerErrorCopy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_ERROR_COPY,
  bookingErrorCopy,
  classifyBookingRefusal,
  isBookingUnavailable,
  isLedgerRefusal,
} from '../rentABuddyBookingErrors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '../../..');
const API_SRC = join(APP_ROOT, '../artifacts/api-server/src');

describe('every ledger_* code the API can answer has copy', () => {
  it('E1 the codes in the copy map are exactly the ones lib/rentBuddyLedgerPosting.ts names', () => {
    const lib = readFileSync(join(API_SRC, 'lib/rentBuddyLedgerPosting.ts'), 'utf8');
    const named = [...lib.matchAll(/export const LEDGER_[A-Z_]+ = "(ledger_[a-z_]+)";/g)].map((m) => m[1]!).sort();
    assert.deepEqual(named, ['ledger_refused', 'ledger_unavailable', 'ledger_write_failed'], 'the API names a ledger error this file does not know');
    assert.deepEqual(Object.keys(LEDGER_ERROR_COPY).sort(), named, 'a ledger_* code has no client copy');
  });

  it('E1 a raw code is never what a user reads', () => {
    for (const code of Object.keys(LEDGER_ERROR_COPY)) {
      for (const copy of [bookingErrorCopy(code), bookingErrorCopy(code, 'A fallback.'), classifyBookingRefusal(code).body]) {
        assert.equal(copy.includes(code), false, `${code} shown raw`);
        assert.equal(/ledger|rpc|503|4\d\d/i.test(copy), false, `${code}: machine words in "${copy}"`);
        assert.ok(copy.includes(' '), 'not a sentence');
      }
    }
  });

  it('E2 an outage says nothing was changed or charged, and that trying again is reasonable', () => {
    for (const code of ['ledger_unavailable', 'ledger_write_failed']) {
      const copy = bookingErrorCopy(code);
      assert.match(copy, /nothing was changed or charged/);
      assert.match(copy, /try again/i);
      assert.equal(isLedgerRefusal(code), false);
    }
  });

  it('E3 a refusal says trying again will NOT help, and never defers to a fallback', () => {
    const copy = bookingErrorCopy('ledger_refused');
    assert.match(copy, /trying again won't change that/);
    assert.match(copy, /Nothing was changed or charged/);
    assert.equal(/please try again/i.test(copy), false);
    assert.equal(bookingErrorCopy('ledger_refused', 'Nothing was changed. Please try again.'), copy,
      'a caller\'s "please try again" was shown for a request that can never succeed');
    assert.equal(isLedgerRefusal('ledger_refused'), true);
  });

  it('E4 an outage defers to the caller\'s own sentence when it has one', () => {
    const earnings = 'Your earnings could not be loaded — this is not a zero balance. Try again.';
    assert.equal(bookingErrorCopy('ledger_unavailable', earnings), earnings);
    assert.equal(bookingErrorCopy('ledger_write_failed', earnings), earnings);
  });

  it('they are failures, not "the feature is closed": the Book button is not disabled for good', () => {
    for (const code of Object.keys(LEDGER_ERROR_COPY)) {
      assert.equal(isBookingUnavailable(code), false, code);
      assert.equal(classifyBookingRefusal(code).kind, 'failure', code);
    }
  });

  it('the copy that was already there is untouched', () => {
    assert.match(bookingErrorCopy('verification_unavailable'), /isn't open yet/);
    assert.match(bookingErrorCopy('age_requirement'), /age requirement/);
    assert.equal(bookingErrorCopy('some_unknown_code', 'My fallback.'), 'My fallback.');
  });
});

describe('E5 the screens that can receive a ledger_* code show copy, not the code', () => {
  const RAB = join(APP_ROOT, 'app', '(rent-a-buddy)');
  const read = (rel: string) => readFileSync(join(RAB, rel), 'utf8');

  // screen → the service call that can answer ledger_*, and how its error is shown
  const SITES: Array<{ screen: string; call: RegExp; shown: RegExp }> = [
    { screen: 'checkout.tsx', call: /await createBooking\(/, shown: /classifyBookingRefusal\(res\.error\)/ },
    { screen: 'checkout.tsx', call: /getCommissionQuote\(buddyId, category\)/, shown: /bookingErrorCopy\(commission\.error,/ },
    { screen: 'offers.tsx', call: /await acceptOffer\(offer\.id\)/, shown: /bookingErrorCopy\(res\.error\)/ },
    { screen: 'buddy-dashboard/offer-create.tsx', call: /await submitOffer\(requestId,/, shown: /bookingErrorCopy\(result\.error\)/ },
    { screen: 'booking/[id].tsx', call: /await rebookBooking\(/, shown: /bookingErrorCopy\(res\.error/ },
    { screen: 'buddy-dashboard/earnings.tsx', call: /getEarningsSummary\(\)/, shown: /bookingErrorCopy\(error,/ },
    { screen: 'buddy-dashboard/earnings-ledger.tsx', call: /getEarningsSummary\(\)/, shown: /bookingErrorCopy\(error,/ },
    { screen: 'admin/payouts.tsx', call: /await holdPayout\(/, shown: /bookingErrorCopy\(r\.error,/ },
  ];
  for (const s of SITES) {
    it(`${s.screen}: ${s.call.source}`, () => {
      const src = read(s.screen);
      assert.match(src, s.call, 'the call this row is about is gone — update the row');
      assert.match(src, s.shown, 'the error of a money call is not passed through the copy function');
    });
  }
});
