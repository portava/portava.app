/**
 * layoverConstraintFacts — the wording behind the constraints card.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * `conservativeCheckedBags` reading UNKNOWN as "no bags" — the optimistic
 *    reading census-layover L35 is about. The table below is the server's own
 *    (`baggageChargesBags`, artifacts/api-server/src/services/airport/
 *    LayoverConstraints.ts), transcribed, so a client that drifted from it
 *    sends an older server the wrong boolean and fails here first.
 *  * A closure or a lifecycle state this build does not know being dropped or
 *    guessed into a known one, instead of surviving as its own token.
 *  * The storage posture or the unsaved fields being swallowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BaggageMode } from '../../../services/layover.ts';
import {
  BAGGAGE_MODE_COPY,
  BAGGAGE_MODE_ORDER,
  conservativeCheckedBags,
  describeClosures,
  describeLayoverState,
  legacyBaggageLine,
  selectedBaggageMode,
  storageNote,
  unsavedNote,
} from '../layoverConstraintFacts.ts';

test('the boolean an older server reads is the CAUTIOUS one for every mode', () => {
  const serverTable: Record<BaggageMode, boolean> = {
    CARRY_ON_ONLY: false,
    CHECKED_THROUGH: false,
    COLLECT_RECHECK: true,
    UNKNOWN: true,
  };
  for (const mode of Object.keys(serverTable) as BaggageMode[]) {
    assert.equal(conservativeCheckedBags(mode), serverTable[mode], mode);
  }
});

test('every mode is offered exactly once and has copy', () => {
  assert.deepEqual([...BAGGAGE_MODE_ORDER].sort(), ['CARRY_ON_ONLY', 'CHECKED_THROUGH', 'COLLECT_RECHECK', 'UNKNOWN']);
  for (const mode of BAGGAGE_MODE_ORDER) {
    assert.ok(BAGGAGE_MODE_COPY[mode].label.length > 0, mode);
    assert.ok(BAGGAGE_MODE_COPY[mode].blurb.length > 0, mode);
  }
  // "Not sure" must not read as a safe default.
  assert.match(BAGGAGE_MODE_COPY.UNKNOWN.blurb, /collect and re-check/);
});

test('closures keep the server order and an untaught one survives as its own code', () => {
  const got = describeClosures(['baggage_unknown', 'airport_change', 'something_new']);
  assert.deepEqual(got.map((c) => c.code), ['baggage_unknown', 'airport_change', 'something_new']);
  assert.match(got[0].sentence, /checked bag/);
  assert.match(got[1].sentence, /different airport/);
  assert.equal(got[2].sentence, 'something_new');
  assert.deepEqual(describeClosures([]), []);
});

test('the lifecycle state: known ones are labelled, an unknown one is shown as itself, a withheld one is null', () => {
  assert.deepEqual(describeLayoverState('NEEDS_INFO'), { label: 'One answer needed', tone: 'ask' });
  assert.equal(describeLayoverState('AIRPORT_ONLY')?.tone, 'closed');
  assert.equal(describeLayoverState('LANDSIDE_AVAILABLE')?.tone, 'open');
  assert.equal(describeLayoverState('RETURN_NOW')?.tone, 'return');
  assert.deepEqual(describeLayoverState('AIRPORT_REENTERED'), { label: 'AIRPORT_REENTERED', tone: 'unknown' });
  assert.equal(describeLayoverState(null), null);
});

test('with no four-way answer stored, the card says what is being COUNTED', () => {
  assert.match(legacyBaggageLine(true), /is being counted/);
  assert.match(legacyBaggageLine(false), /No bag time/);
  assert.notEqual(legacyBaggageLine(true), legacyBaggageLine(false));
  assert.equal(selectedBaggageMode({ constraints: null }), null, 'a mode was selected that the traveller never chose');
  assert.equal(
    selectedBaggageMode({ constraints: { version: 2, baggageMode: 'CHECKED_THROUGH', recheckRequired: null, airportChangeRequired: null } }),
    'CHECKED_THROUGH',
  );
});

test('the storage posture is said when it limits what is kept, and only then', () => {
  assert.equal(storageNote({ storage: 'versioned' }), null);
  assert.match(storageNote({ storage: 'session_booleans_only' }) ?? '', /cautious/);
});

test('fields that could not be kept are named; nothing is said when all were', () => {
  assert.equal(unsavedNote([]), null);
  assert.match(unsavedNote(['recheckRequired']) ?? '', /check in again/);
  const both = unsavedNote(['recheckRequired', 'airportChangeRequired']) ?? '';
  assert.match(both, /check in again/);
  assert.match(both, /change airports/);
});
