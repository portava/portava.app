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

import type { BaggageMode, ConstraintQuestion, PlanFit } from '../../../services/layover.ts';
import {
  BAGGAGE_MODE_COPY,
  BAGGAGE_MODE_ORDER,
  TRI_STATE_OPTIONS,
  conservativeCheckedBags,
  creationNote,
  creationNoteForParam,
  creationNoteParam,
  describeClosures,
  describePlanFit,
  legacyBaggageLine,
  questionPatch,
  questionWhy,
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

// The lifecycle BADGE used to be tested here, through `describeLayoverState` —
// a table keyed on the state alone, in which LANDSIDE_AVAILABLE was green
// whatever the verdict said. That function is gone; the badge is
// `describeLandsideBadge`, a function of the verdict, and its cases (every one
// this test had, and the ones it could not express) are in
// `layoverVerdictFacts.test.ts`.

test('the three closures an UNKNOWN input adds each have a sentence — none is shown as a raw code', () => {
  const got = describeClosures(['constraints_unreadable', 'airport_change_unknown', 'recheck_unknown']);
  assert.match(got[0].sentence, /could not read/i);
  assert.match(got[1].sentence, /this airport or a different one/i);
  assert.match(got[2].sentence, /one ticket or booked separately/i);
  for (const c of got) assert.notEqual(c.sentence, c.code, c.code);
});

test('"Not sure" is sent as null — a declaration, and never a quiet "no"', () => {
  assert.deepEqual(TRI_STATE_OPTIONS.map((o) => o.value), [false, true, null]);
  assert.equal(TRI_STATE_OPTIONS.find((o) => o.value === null)?.label, 'Not sure');
});

test('a question is answered on the QUESTION\'s field, not always the bag mode', () => {
  const bags: ConstraintQuestion = { field: 'baggageMode', prompt: 'p', options: [{ value: 'CHECKED_THROUGH', label: 'Yes' }] };
  const airport: ConstraintQuestion = { field: 'airportChangeRequired', prompt: 'p', options: [{ value: false, label: 'This airport' }, { value: true, label: 'A different airport' }] };
  const tickets: ConstraintQuestion = { field: 'recheckRequired', prompt: 'p', options: [{ value: false, label: 'One ticket' }, { value: true, label: 'Separate' }] };
  assert.deepEqual(questionPatch(bags, 'CHECKED_THROUGH'), { baggageMode: 'CHECKED_THROUGH' });
  assert.deepEqual(questionPatch(airport, true), { airportChangeRequired: true });
  assert.deepEqual(questionPatch(airport, false), { airportChangeRequired: false });
  assert.deepEqual(questionPatch(tickets, true), { recheckRequired: true });
  // What the card used to send for EVERY question — a bag mode — is refused
  // for the other two, and a value outside the vocabulary is refused for all.
  assert.equal(questionPatch(airport, 'CHECKED_THROUGH'), null);
  assert.equal(questionPatch(bags, true), null);
  assert.equal(questionPatch(bags, 'TELEPORTED'), null);
  assert.equal(questionPatch({ field: 'somethingNew' } as unknown as ConstraintQuestion, true), null);
  // Each question says why it is being asked, in its own words.
  assert.match(questionWhy('airportChangeRequired'), /different airport/);
  assert.match(questionWhy('recheckRequired'), /check in again/);
  assert.notEqual(questionWhy('airportChangeRequired'), questionWhy('baggageMode'));
});

test('what the START could not keep is said — and nothing is said when it was all kept', () => {
  const notStored = { stored: 'not_stored', reason: 'write_failed', message: 'x', retryable: true } as const;
  assert.match(creationNote(notStored) ?? '', /were not saved/);
  assert.match(creationNote(notStored) ?? '', /collect and re-check/, 'the note must say what IS being assumed meanwhile');
  assert.equal(creationNoteParam(notStored), 'not_stored');
  assert.equal(creationNoteForParam('not_stored'), creationNote(notStored));

  const partial = { stored: 'session_booleans_only', version: null, unsaved: ['airportChangeRequired'], sessionSynced: true } as const;
  assert.match(creationNote({ ...partial, unsaved: [...partial.unsaved] }) ?? '', /change airports/);
  assert.equal(creationNoteParam({ ...partial, unsaved: [...partial.unsaved] }), 'unsaved');
  assert.ok(creationNoteForParam('unsaved'));

  const kept = { stored: 'versioned', version: 1, unsaved: [], sessionSynced: true } as const;
  assert.equal(creationNote({ ...kept, unsaved: [] }), null);
  assert.equal(creationNoteParam({ ...kept, unsaved: [] }), null);
  for (const nothing of [null, undefined]) {
    assert.equal(creationNote(nothing), null);
    assert.equal(creationNoteParam(nothing), null);
    assert.equal(creationNoteForParam(nothing), null);
  }
  assert.equal(creationNoteForParam('something_else'), null, 'an unknown param said something');
});

const fmt = (m: number) => `${m}m`;
function planFit(over: Partial<PlanFit>): PlanFit {
  return {
    totalPlannedMin: 50, returnTravelMin: 20, neededMin: 70, usableMinutes: 400, fitsWindow: false, fit: 'unknown',
    unstatedTravelStops: 0, unstatedDurationStops: 0, neededMinIsLowerBound: false, overflowMin: 0, backByTime: '2030-06-15T08:00:00.000Z',
    ...over,
  };
}

test('the plan meter has ONE green answer, and a plan the gate holds back says why', () => {
  const fits = describePlanFit(planFit({ fit: 'fits', fitsWindow: true }), 1, fmt);
  assert.equal(fits.tone, 'fits');
  assert.match(fits.text, /fits with room/);

  const blocked = describePlanFit(planFit({
    fit: 'blocked', clockFit: 'fits', hasLandsideStop: true,
    landside: { status: 'closed', closedBy: ['entry_refused', 'something_new'], cautions: [] },
  }), 1, fmt);
  assert.equal(blocked.tone, 'blocked');
  assert.doesNotMatch(blocked.text, /fits/);
  assert.deepEqual(blocked.reasons.map((r) => r.code), ['entry_refused', 'something_new']);
  assert.match(blocked.reasons[0].sentence, /passport/);
  assert.equal(blocked.reasons[1].sentence, 'something_new', 'an untaught closure must survive as itself');

  const held = describePlanFit(planFit({
    fit: 'unconfirmed', clockFit: 'fits', hasLandsideStop: true,
    landside: { status: 'caution', closedBy: [], cautions: ['entry_unconfirmed', 'tight_window'] },
  }), 1, fmt);
  assert.equal(held.tone, 'unconfirmed');
  assert.match(held.text, /not a yes yet/);
  assert.doesNotMatch(held.text, /fits with room/);
  assert.deepEqual(held.reasons.map((r) => r.code), ['entry_unconfirmed', 'tight_window']);

  const over = describePlanFit(planFit({ fit: 'over', overflowMin: 30 }), 2, fmt);
  assert.equal(over.tone, 'over');
  assert.match(over.text, /Over by 30m — trim a stop/);

  const unknown = describePlanFit(planFit({ fit: 'unknown', unstatedTravelStops: 1, neededMinIsLowerBound: true }), 1, fmt);
  assert.equal(unknown.tone, 'unknown');
  assert.match(unknown.text, /not a fit we can promise/);

  // A value this build has never been taught is NEVER rendered as a fit.
  const future = describePlanFit(planFit({ fit: 'some_future_fit' as unknown as PlanFit['fit'] }), 1, fmt);
  assert.notEqual(future.tone, 'fits');
  assert.doesNotMatch(future.text, /fits with room/);
  // …and an older server's `blocked` with no `landside` still says it is blocked.
  assert.equal(describePlanFit(planFit({ fit: 'blocked' }), 1, fmt).tone, 'blocked');
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
