/**
 * `verification_required` — a refusal the traveller can satisfy, and had no way to.
 *
 * WHAT WAS WRONG (census-trust TV-2a, BUILT-BUT-WRONG)
 * ===================================================
 * TV-2a asks for two entry points into identity verification: the Passport
 * profile, and the Rent-a-Buddy gate. The census found the first and not the
 * second, in so many words:
 *
 *   "Rent-a-Buddy gate ✗ — no screen under `app/(rent-a-buddy)/` routes to
 *    verification. The server-side gate exists (`routes/rentABuddyRollout.ts`
 *    refuses an MVP-mode booking without ID verification) but a user it refuses
 *    is given no route to satisfy it."
 *
 * It was worse than "no route". `verification_required` was in NEITHER map in
 * `rentABuddyBookingErrors.ts`, so `bookingErrorCopy` fell all the way through
 * to `GENERIC_BOOKING_ERROR`, and a traveller who had filled in the whole
 * checkout form was shown:
 *
 *   "Something went wrong on our side and we couldn't complete that.
 *    Please try again."
 *
 * Every clause of which is false. Nothing went wrong, it was not on our side,
 * and trying again does the same thing forever — the gate is a fact about the
 * account, not a transient failure. The one sentence the person needed, that
 * their ID is not verified and there is a screen for that, was the sentence
 * the mapping could not produce.
 *
 * WHAT IS PINNED
 * ==============
 * A THIRD class of refusal, distinct from the two that existed:
 *
 *   feature-closed  — `isBookingUnavailable`, no action exists, wait.
 *   actionable      — this one: the person can clear it, and we say where.
 *   genuine failure — everything else, still an Alert with a retry.
 *
 * V4 is the case that keeps the classes apart. The cheap version of this fix is
 * to drop `verification_required` into `BOOKING_UNAVAILABLE_CODES`, which would
 * produce honest-ish copy and ALSO disable the Book button under the heading
 * "Not available yet" — telling a person who can fix this in five minutes that
 * the feature is closed. The two classes render differently on purpose.
 *
 * V5 checks the route against the app's own registry rather than against a
 * string in this file. A path that no screen answers is the same dead end the
 * census recorded, spelled more confidently.
 *
 * Run: node --import tsx --test src/services/__tests__/rentABuddy.verificationRoute.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bookingErrorCopy,
  isBookingUnavailable,
  bookingRefusalAction,
  classifyBookingRefusal,
} from '../rentABuddyBookingErrors.ts';
import { PORTAVA_ROUTES } from '../../navigation/portavaRoutes.ts';

/** The exact sentence the generic fallback produces, quoted so V1 cannot drift. */
const GENERIC = "Something went wrong on our side and we couldn't complete that. Please try again.";

describe('TV-2a — the Rent-a-Buddy verification gate names itself', () => {
  it('V1 — `verification_required` does not fall through to the generic "our side" apology', () => {
    const copy = bookingErrorCopy('verification_required');
    assert.notEqual(
      copy, GENERIC,
      'the ID-verification gate was reported as a server-side failure the user should retry',
    );
    assert.ok(
      /verif/i.test(copy),
      `copy must name what is actually required; got ${JSON.stringify(copy)}`,
    );
    assert.ok(
      !copy.includes('verification_required'),
      'copy must not embed the raw error code',
    );
  });

  it('V2 — it carries an action naming the screen that satisfies it', () => {
    const action = bookingRefusalAction('verification_required');
    assert.ok(action, 'no action: the refusal is still a dead end');
    assert.equal(action.route, '/profile/verification');
    assert.ok(
      action.label.trim().length > 0 && !action.label.includes('_'),
      `the button label must be human text, not a code; got ${JSON.stringify(action.label)}`,
    );
  });

  it('V3 CONTROL — a refusal with nothing the user can do carries NO action', () => {
    // Without this, "returns an action" is satisfied by pointing every refusal
    // at the verification screen, which would send a person whose CITY has not
    // launched off to photograph their passport.
    for (const code of [
      'verification_unavailable', 'feature_disabled', 'waitlist_only',
      'globally_paused', 'city_not_launched', 'db_error', 'HTTP 500', '', null, undefined,
    ]) {
      assert.equal(
        bookingRefusalAction(code), null,
        `${JSON.stringify(code)} must not offer the verification action`,
      );
    }
  });

  it('V4 — it stays OUT of the feature-closed class, which renders differently', () => {
    // `isBookingUnavailable` disables the Book button under "Not available yet".
    // That is the wrong sentence for a gate the person can clear themselves.
    assert.equal(
      isBookingUnavailable('verification_required'), false,
      'the actionable gate was folded into the "feature is closed" class',
    );
  });

  it('V5 — the route it names is one the app actually registers', () => {
    const action = bookingRefusalAction('verification_required');
    assert.ok(action);
    const target = action.route.replace(/^\//, '');
    assert.ok(
      PORTAVA_ROUTES.some((r) => r.path === target),
      `\`${action.route}\` is in no route in portavaRoutes.ts — the dead end, respelled`,
    );
  });
});

describe('classifyBookingRefusal — the three-way decision, out of the screen', () => {
  // The checkout screen made this decision inline, as two `if`s and a
  // fallthrough. The ORDER is the whole behaviour and nothing could see it: a
  // reviewer moving the actionable check below `isBookingUnavailable` would
  // have broken nothing any test could name. These four cases are that order.

  it('V6 — `verification_required` classifies as ACTIONABLE, not as a failure', () => {
    const r = classifyBookingRefusal('verification_required');
    assert.equal(r.kind, 'actionable', 'the gate fell through to the Alert-and-retry arm again');
    assert.equal(r.kind === 'actionable' && r.action.route, '/profile/verification');
    assert.ok(r.body.length > 0 && !r.body.includes('verification_required'));
  });

  it('V7 — a feature-closed code classifies as UNAVAILABLE and carries no action', () => {
    for (const code of ['verification_unavailable', 'city_not_launched', 'waitlist_only']) {
      const r = classifyBookingRefusal(code);
      assert.equal(r.kind, 'unavailable', code);
      assert.ok(!('action' in r), `${code}: a closed feature must not offer an action`);
    }
  });

  it('V8 — a genuine error still classifies as FAILURE, and keeps the caller fallback', () => {
    // The arm that must NOT be swallowed by the two above. A real error is the
    // one case where "please try again" is honest advice.
    const r = classifyBookingRefusal('db_error', 'Could not accept booking.');
    assert.equal(r.kind, 'failure');
    assert.equal(r.body, 'Could not accept booking.');
  });

  it('V9 — no refusal code at all is a FAILURE with generic copy, never an action', () => {
    for (const code of [null, undefined, '']) {
      const r = classifyBookingRefusal(code);
      assert.equal(r.kind, 'failure', String(code));
      assert.equal(r.body, GENERIC, String(code));
    }
  });
});
