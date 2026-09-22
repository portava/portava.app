/**
 * layoverReasonCodes — census-layover Appendix A, the CLIENT half.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * The server has had a closed reason-code vocabulary since
 * `LayoverSafetyEngine.ts#LAYOVER_REASON_CODES` and ships it on every
 * `/overview` and `/safety` read as `advice.reasonCodes`. Until this module the
 * client TYPED that field (`services/layover.ts:142`) and rendered NOTHING from
 * it: `CanILeaveCard` drew `advice.reasons` — the free-text English sentences —
 * and dropped the machine-readable half on the floor. Appendix A's rows are
 * about codes a traveller can be shown; a code nothing renders is not shown.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Three properties, each with a paired negative so a hard-wired answer fails:
 *
 *  1. EVERY declared code has copy. A vocabulary with a hole renders a raw
 *     `SELF_TRANSFER_FRICTION` at a traveller, which is the census's own
 *     complaint about free-text warnings in the other direction.
 *  2. AN UNKNOWN CODE SURVIVES. A newer server may emit a code this build has
 *     never heard of. It must reach the screen as itself — never dropped
 *     (silence about a stated risk) and never given invented copy (a sentence
 *     the server did not say).
 *  3. NO ENTRY CLAIMS A FIT. Appendix A codes qualify an answer; none of them
 *     may read as a certification that something is safe or fits. The word list
 *     below is the same shape of guard `LayoverMapCard` carries for bands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYOVER_REASON_CODES,
  describeReasonCode,
  describeReasonCodes,
} from '../layoverReasonCodes.ts';

test('the client vocabulary is the server vocabulary, code for code', () => {
  // Transcribed from artifacts/api-server/src/services/airport/
  // LayoverSafetyEngine.ts#LAYOVER_REASON_CODES. A spelling that drifts here
  // renders copy for a code the server never sends and drops one it does.
  assert.deepEqual([...LAYOVER_REASON_CODES], [
    'ENTRY_NOT_CONFIRMED',
    'BAGGAGE_STATUS_CRITICAL_UNKNOWN',
    'INSUFFICIENT_USABLE_TIME',
    'SECURITY_WAIT_HIGH',
    'RETURN_ROUTE_UNRELIABLE',
    'AIRPORT_CHANGE_REQUIRED',
    'SELF_TRANSFER_FRICTION',
    'DATA_STALE',
    'SOURCE_CONFLICT',
    'TRAFFIC_DEGRADED',
    'FLIGHT_MOVED_EARLIER',
    'FLIGHT_DELAY_CREATED_OPPORTUNITY',
    'RETURN_THRESHOLD_REACHED',
    'RECOMMENDATION_EXPIRED',
    'AIRPORT_MATURITY_LIMITED',
  ]);
});

test('every declared code has a title and a detail, and is marked known', () => {
  for (const code of LAYOVER_REASON_CODES) {
    const r = describeReasonCode(code);
    assert.equal(r.code, code);
    assert.equal(r.known, true, `${code} is declared but unknown to the renderer`);
    assert.ok(r.title.length > 0, `${code} has no title`);
    assert.ok(r.detail && r.detail.length > 0, `${code} has no detail`);
    // The title is written for a traveller, so it is not the token back again.
    assert.notEqual(r.title, code);
  }
});

test('an unknown code is carried through as itself, with no invented copy', () => {
  const r = describeReasonCode('SOME_FUTURE_CODE');
  assert.equal(r.known, false);
  assert.equal(r.code, 'SOME_FUTURE_CODE');
  // The token IS the title — the only honest thing to show for a sentence this
  // build was never taught.
  assert.equal(r.title, 'SOME_FUTURE_CODE');
  assert.equal(r.detail, null);
});

test('no entry certifies a fit or calls anything safe', () => {
  const FORBIDDEN = [/\bsafe\b/i, /\bfits\b/i, /\byou have time\b/i, /guaranteed/i];
  for (const code of LAYOVER_REASON_CODES) {
    const r = describeReasonCode(code);
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(r.title), `${code} title claims a fit: ${r.title}`);
      assert.ok(!pattern.test(r.detail ?? ''), `${code} detail claims a fit: ${r.detail}`);
    }
  }
});

test('describeReasonCodes keeps the server order and de-duplicates', () => {
  const rendered = describeReasonCodes([
    'RETURN_THRESHOLD_REACHED',
    'ENTRY_NOT_CONFIRMED',
    'RETURN_THRESHOLD_REACHED',
  ]);
  assert.deepEqual(rendered.map((r) => r.code), [
    'RETURN_THRESHOLD_REACHED',
    'ENTRY_NOT_CONFIRMED',
  ]);
});

test('describeReasonCodes answers an empty list for absence, and never throws', () => {
  assert.deepEqual(describeReasonCodes(null), []);
  assert.deepEqual(describeReasonCodes(undefined), []);
  assert.deepEqual(describeReasonCodes([]), []);
  // A blank token carries no information and is the one thing dropped.
  assert.deepEqual(describeReasonCodes(['', '   ']), []);
  // Junk on the wire must not take a render path down.
  assert.deepEqual(
    describeReasonCodes([42 as unknown as string, 'DATA_STALE']).map((r) => r.code),
    ['DATA_STALE'],
  );
});

test('the four codes production actually emits are all renderable', () => {
  // LayoverSafetyEngine.ts:85-88 names exactly these as emitted on a real
  // session today. If any of them lost its copy, every live layover would show
  // a raw token.
  for (const code of [
    'ENTRY_NOT_CONFIRMED',
    'INSUFFICIENT_USABLE_TIME',
    'RETURN_THRESHOLD_REACHED',
    'AIRPORT_MATURITY_LIMITED',
  ]) {
    assert.equal(describeReasonCode(code).known, true);
  }
});
