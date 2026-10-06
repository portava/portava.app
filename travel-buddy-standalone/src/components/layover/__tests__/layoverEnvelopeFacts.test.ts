/**
 * layoverEnvelopeFacts — what the map may CALL the envelope, and whether it may
 * draw it; and what a crew card says a crew deadline is not.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * THE WORD "SAFE" UNDER A GATE THAT IS NOT OPEN. PR #624's verification found
 *    a refused border with 493 usable minutes drawn a ring labelled SAFE
 *    ENVELOPE. The sweep below drives every gate shape — the fixed server's, an
 *    older server's (no gate at all) and nonsense — and asserts the label says
 *    "safe" only for the literal status `open`.
 *  * AN ENVELOPE DRAWN UNDER A CLOSED GATE, including one a server sent anyway.
 *  * A CREW CARD THAT COULD READ AS A GROUP CLEARANCE: the per-member sentence
 *    is unconditional, and it names the deadline as not a clearance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CREW_EACH_CHECKS_OWN,
  ENVELOPE_LABEL_CAUTION,
  MEETING_POINT_PLACE_NEEDED,
  MEETING_POINT_PLACE_OPTIONS,
  ENVELOPE_LABEL_CLEAR,
  STOP_NOT_ON_OFFER,
  crewOwnGateNote,
  describeEnvelope,
  type EnvelopeGate,
} from '../layoverEnvelopeFacts.ts';

const OPEN: EnvelopeGate = { status: 'open', cautions: [], withheld: null };
const CAUTION: EnvelopeGate = { status: 'caution', cautions: ['entry_unconfirmed'], withheld: null };
const CLOSED: EnvelopeGate = { status: 'closed', cautions: [], withheld: 'landside_closed' };

test('an OPEN gate is the one case the envelope is called safe', () => {
  const d = describeEnvelope(true, OPEN);
  assert.deepEqual(
    { tone: d.tone, draw: d.draw, label: d.label, note: d.note, reasons: d.reasons, withheldText: d.withheldText },
    { tone: 'clear', draw: true, label: 'SAFE ENVELOPE', note: null, reasons: [], withheldText: null },
  );
  assert.equal(ENVELOPE_LABEL_CLEAR, 'SAFE ENVELOPE');
});

test('a CAUTIONARY gate draws the envelope WITHOUT the word "safe", and says why it is not a clearance', () => {
  const d = describeEnvelope(true, CAUTION);
  assert.equal(d.tone, 'caution');
  assert.equal(d.draw, true, 'the clock still has a reach, and the verdict card above still says so');
  assert.equal(d.label, ENVELOPE_LABEL_CAUTION);
  assert.doesNotMatch(String(d.label), /safe/i);
  assert.match(String(d.label), /NOT A CLEARANCE/);
  assert.match(String(d.note), /not a yes to leaving the airport/);
  assert.doesNotMatch(String(d.note), /safe/i);
  assert.deepEqual(d.reasons.map((r) => r.code), ['entry_unconfirmed']);
  assert.match(d.reasons[0].sentence, /passport/);
  // A tight window is a caution too, and an untaught caution survives as itself.
  const tight = describeEnvelope(true, { status: 'caution', cautions: ['tight_window', 'something_new'] });
  assert.deepEqual(tight.reasons.map((r) => r.code), ['tight_window', 'something_new']);
});

test('a CLOSED gate draws nothing — even if an envelope arrived anyway', () => {
  // The 493-usable-minute refused border: the server withholds the geometry…
  const withheld = describeEnvelope(false, CLOSED);
  assert.equal(withheld.tone, 'withheld');
  assert.equal(withheld.draw, false);
  assert.equal(withheld.label, null);
  assert.match(String(withheld.withheldText), /Leaving the airport is not on/);
  assert.doesNotMatch(String(withheld.withheldText), /safe/i);
  // …and a server that sent it beside a closed gate is not believed.
  for (const gate of [CLOSED, { status: 'closed' }, { withheld: 'landside_closed' }, { status: 'open', withheld: 'landside_closed' }]) {
    const d = describeEnvelope(true, gate);
    assert.equal(d.draw, false, JSON.stringify(gate));
    assert.equal(d.tone, 'withheld', JSON.stringify(gate));
  }
  assert.match(STOP_NOT_ON_OFFER, /not on offer/);
});

test('OLD SERVER: an envelope with NO gate beside it is drawn, and is not called safe', () => {
  for (const gate of [undefined, null, {}]) {
    const d = describeEnvelope(true, gate);
    assert.equal(d.tone, 'caution', JSON.stringify(gate));
    assert.equal(d.draw, true);
    assert.doesNotMatch(String(d.label), /safe/i);
    assert.deepEqual(d.reasons.map((r) => r.code), ['gate_not_reported']);
  }
});

test('no envelope and no closure is the ABSENCE it always was — a different sentence from a closed gate', () => {
  for (const gate of [undefined, null, OPEN, CAUTION, { status: 'open', cautions: [], withheld: 'no_airport_coordinate' }]) {
    const d = describeEnvelope(false, gate);
    assert.equal(d.tone, 'absent', JSON.stringify(gate));
    assert.equal(d.draw, false);
    assert.match(String(d.withheldText), /No safe envelope has been certified/);
  }
  assert.notEqual(describeEnvelope(false, OPEN).withheldText, describeEnvelope(false, CLOSED).withheldText);
});

test('EXHAUSTIVE: the label says "safe" ONLY for the literal status `open`, and a closed gate never draws', () => {
  const STATUSES: Array<string | undefined> = ['open', 'caution', 'closed', 'OPEN', 'some_future_status', '', undefined];
  const WITHHELD: Array<string | null | undefined> = [null, undefined, 'landside_closed', 'no_airport_coordinate'];
  let cases = 0;
  let safe = 0;
  for (const status of STATUSES) {
    for (const withheld of WITHHELD) {
      for (const hasEnvelope of [true, false]) {
        cases += 1;
        const d = describeEnvelope(hasEnvelope, { status, withheld, cautions: [] });
        const where: string = `status=${String(status)} withheld=${String(withheld)} hasEnvelope=${String(hasEnvelope)}`;
        if (/safe/i.test(String(d.label ?? ''))) {
          safe += 1;
          assert.equal(status, 'open', `${where}: called safe`);
          assert.notEqual(withheld, 'landside_closed', `${where}: called safe beside a closure`);
          assert.equal(hasEnvelope, true, where);
        }
        if (status === 'closed' || withheld === 'landside_closed') assert.equal(d.draw, false, `${where}: drawn under a closed gate`);
        if (d.draw) assert.ok(hasEnvelope, `${where}: drew an envelope that never arrived`);
        if (!d.draw) assert.ok(d.withheldText && d.withheldText.length > 0, `${where}: nothing drawn and nothing said`);
      }
    }
  }
  assert.ok(cases >= 50, `only ${cases} combinations were driven`);
  assert.ok(safe > 0, 'NON-VACUITY: nothing in the sweep was ever called safe');
});

test('the crew sentence is unconditional: a deadline is not a clearance, and each member checks their own entry before leaving', () => {
  assert.match(CREW_EACH_CHECKS_OWN, /deadline, not a clearance/);
  assert.match(CREW_EACH_CHECKS_OWN, /Before leaving the airport, each of you must check your own entry/);
  assert.match(CREW_EACH_CHECKS_OWN, /everyone checks their own/);
  // Nothing in it says the group can go…
  assert.doesNotMatch(CREW_EACH_CHECKS_OWN, /you can (all )?(go|leave|head)|cleared to|safe to/i);
  // …and nothing in it says a crew IS a trip out of the airport, or that being in one needs a clearance.
  assert.doesNotMatch(CREW_EACH_CHECKS_OWN, /cannot (start|join)|not allowed to (start|join)/i);
});

test('a member is told what THEIR OWN gate says about the landside part — never that the crew is closed to them', () => {
  const closed = String(crewOwnGateNote('closed'));
  assert.match(closed, /Your own layover does not allow leaving the airport/);
  assert.match(closed, /You can still meet this crew inside the airport/, 'a closed landside gate was said as a closed crew');
  assert.match(closed, /anything in the city is not open to you/);
  assert.doesNotMatch(closed, /cannot (start|join|be in)|leave (this|the) crew/i);

  const caution = String(crewOwnGateNote('caution'));
  assert.match(caution, /not confirmed/);
  assert.match(caution, /not a yes for you/);
  assert.doesNotMatch(caution, /does not allow/, 'a caution was said as a refusal');
  assert.notEqual(caution, closed);

  // Open, unknown, unstated: nothing is claimed about a gate that is open or that nobody stated.
  for (const other of ['open', 'unknown', 'not_applicable', 'CLOSED', '', null, undefined]) {
    assert.equal(crewOwnGateNote(other), null, String(other));
  }
});

test('the meeting-point place has exactly two answers, airside first, and neither is a default', () => {
  assert.deepEqual(MEETING_POINT_PLACE_OPTIONS.map((o) => o.insideAirport), [true, false]);
  assert.match(MEETING_POINT_PLACE_OPTIONS[0].label, /Inside the airport/);
  assert.match(MEETING_POINT_PLACE_OPTIONS[1].label, /city/);
  assert.match(MEETING_POINT_PLACE_NEEDED, /inside the airport or in the city/);
});
