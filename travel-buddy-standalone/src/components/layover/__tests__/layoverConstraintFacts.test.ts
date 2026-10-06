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

const CITY: Array<{ insideAirport?: boolean | null }> = [{ insideAirport: false }];
const LOUNGE: Array<{ insideAirport?: boolean | null }> = [{ insideAirport: true }];
const TWO: Array<{ insideAirport?: boolean | null }> = [{ insideAirport: false }, { insideAirport: false }];
const OPEN_GATE: NonNullable<PlanFit['landside']> = { status: 'open', closedBy: [], cautions: [] };

test('the plan meter has ONE green answer, and a plan the gate holds back says why', () => {
  // GREEN: a landside plan, the clock fits, and the server SAYS the gate is open.
  const fits = describePlanFit(planFit({ fit: 'fits', fitsWindow: true, hasLandsideStop: true, landside: { ...OPEN_GATE } }), CITY, fmt);
  assert.equal(fits.tone, 'fits');
  assert.match(fits.text, /fits with room/);

  const blocked = describePlanFit(planFit({
    fit: 'blocked', clockFit: 'fits', hasLandsideStop: true,
    landside: { status: 'closed', closedBy: ['entry_refused', 'something_new'], cautions: [] },
  }), CITY, fmt);
  assert.equal(blocked.tone, 'blocked');
  assert.doesNotMatch(blocked.text, /fits/);
  assert.deepEqual(blocked.reasons.map((r) => r.code), ['entry_refused', 'something_new']);
  assert.match(blocked.reasons[0].sentence, /passport/);
  assert.equal(blocked.reasons[1].sentence, 'something_new', 'an untaught closure must survive as itself');

  const held = describePlanFit(planFit({
    fit: 'unconfirmed', clockFit: 'fits', hasLandsideStop: true,
    landside: { status: 'caution', closedBy: [], cautions: ['entry_unconfirmed', 'tight_window'] },
  }), CITY, fmt);
  assert.equal(held.tone, 'unconfirmed');
  assert.match(held.text, /not a yes yet/);
  assert.doesNotMatch(held.text, /fits with room/);
  assert.deepEqual(held.reasons.map((r) => r.code), ['entry_unconfirmed', 'tight_window']);

  const over = describePlanFit(planFit({ fit: 'over', overflowMin: 30 }), TWO, fmt);
  assert.equal(over.tone, 'over');
  assert.match(over.text, /Over by 30m — trim a stop/);

  const unknown = describePlanFit(planFit({ fit: 'unknown', unstatedTravelStops: 1, neededMinIsLowerBound: true }), CITY, fmt);
  assert.equal(unknown.tone, 'unknown');
  assert.match(unknown.text, /not a fit we can promise/);

  // A value this build has never been taught is NEVER rendered as a fit.
  const future = describePlanFit(planFit({ fit: 'some_future_fit' as unknown as PlanFit['fit'] }), CITY, fmt);
  assert.notEqual(future.tone, 'fits');
  assert.doesNotMatch(future.text, /fits with room/);
  // …and an older server's `blocked` with no `landside` still says it is blocked.
  assert.equal(describePlanFit(planFit({ fit: 'blocked' }), CITY, fmt).tone, 'blocked');
});

test('OLD SERVER: `fit: "fits"` with no `landside` field is NOT drawn green for a plan that leaves the airport', () => {
  // The payload a server that predates the gate sends — transcribed from the
  // verifier's probe of PR #624, whose output was "fits with room": the clock's
  // answer, `fitsWindow: true`, and no `landside`, `hasLandsideStop` or `clockFit`.
  const oldServer = planFit({ fit: 'fits', fitsWindow: true });
  assert.equal('landside' in oldServer, false, 'fixture: this must be the old shape');
  assert.equal('hasLandsideStop' in oldServer, false, 'fixture: this must be the old shape');

  const got = describePlanFit(oldServer, CITY, fmt);
  assert.equal(got.tone, 'unconfirmed', 'an unreported gate was drawn as a fit');
  assert.doesNotMatch(got.text, /fits with room/);
  assert.match(got.text, /not a yes yet/);
  assert.deepEqual(got.reasons.map((r) => r.code), ['gate_not_reported']);
  assert.match(got.reasons[0].sentence, /could not confirm/);

  // …with several stops, one of them in the city.
  assert.equal(describePlanFit(oldServer, [{ insideAirport: true }, { insideAirport: false }], fmt).tone, 'unconfirmed');
  // A stop that does not SAY it is inside the airport is a landside stop.
  assert.equal(describePlanFit(oldServer, [{}], fmt).tone, 'unconfirmed');
  assert.equal(describePlanFit(oldServer, [{ insideAirport: null }], fmt).tone, 'unconfirmed');

  // CONTROL: the same old payload for a plan that never leaves the airport IS green —
  // the landside gate has nothing to say about a lounge.
  const lounge = describePlanFit(oldServer, LOUNGE, fmt);
  assert.equal(lounge.tone, 'fits');
  assert.match(lounge.text, /fits with room/);
});

test('the gate the server reports decides, whatever `fit` says beside it', () => {
  // A server that says "fits" beside a CLOSED gate is contradicting itself; the gate wins.
  const contradicted = describePlanFit(planFit({
    fit: 'fits', fitsWindow: true, hasLandsideStop: true,
    landside: { status: 'closed', closedBy: ['entry_refused'], cautions: [] },
  }), CITY, fmt);
  assert.equal(contradicted.tone, 'blocked');
  assert.deepEqual(contradicted.reasons.map((r) => r.code), ['entry_refused']);

  // "fits" beside a CAUTIONARY gate is unconfirmed, with the server's cautions.
  const cautioned = describePlanFit(planFit({
    fit: 'fits', fitsWindow: true, hasLandsideStop: true,
    landside: { status: 'caution', closedBy: [], cautions: ['entry_unconfirmed'] },
  }), CITY, fmt);
  assert.equal(cautioned.tone, 'unconfirmed');
  assert.deepEqual(cautioned.reasons.map((r) => r.code), ['entry_unconfirmed']);

  // A status this build was never taught is not `open`.
  const untaught = describePlanFit(planFit({
    fit: 'fits', hasLandsideStop: true,
    landside: { status: 'some_future_status' as unknown as 'open', closedBy: [], cautions: [] },
  }), CITY, fmt);
  assert.equal(untaught.tone, 'unconfirmed');

  // The server says "no landside stop" and the stops this screen holds disagree: landside wins.
  const stale = describePlanFit(planFit({ fit: 'fits', hasLandsideStop: false }), CITY, fmt);
  assert.equal(stale.tone, 'unconfirmed');
  // …and the reverse: the server says there IS one, the list here is all airside.
  assert.equal(describePlanFit(planFit({ fit: 'fits', hasLandsideStop: true }), LOUNGE, fmt).tone, 'unconfirmed');

  // EXHAUSTIVE: green needs an open gate or an airside-only plan. Nothing else gets it.
  let green = 0;
  for (const status of ['open', 'caution', 'closed', 'weird', undefined]) {
    for (const hasLandsideStop of [true, false, undefined]) {
      for (const stops of [CITY, LOUNGE, TWO, []]) {
        const landside = status === undefined ? undefined : { status: status as unknown as 'open', closedBy: [], cautions: [] };
        const d = describePlanFit(planFit({ fit: 'fits', fitsWindow: true, hasLandsideStop, landside }), stops, fmt);
        const where: string = `status=${String(status)} hasLandsideStop=${String(hasLandsideStop)} stops=${JSON.stringify(stops)}`;
        if (d.tone === 'fits') {
          green += 1;
          const leaves = hasLandsideStop === true || stops.some((s) => s.insideAirport !== true);
          assert.ok(status === 'open' || !leaves, `${where}: green without an open gate on a plan that leaves the airport`);
        }
      }
    }
  }
  assert.ok(green > 0, 'NON-VACUITY: nothing in the sweep was green');
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
