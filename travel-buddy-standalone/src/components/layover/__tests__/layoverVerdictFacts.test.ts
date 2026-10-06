/**
 * layoverVerdictFacts — the ONE table behind `CanILeaveCard` and the badge on
 * `LayoverConstraintsCard`, which is mounted directly beneath it.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *  * A GREEN BADGE UNDER A VERDICT THAT IS NOT GREEN. PR #588 shipped exactly
 *    that: "You can go out" beneath "Time is fine — entry unconfirmed", for a
 *    12-hour layover on a border nobody had checked. The exhaustive sweep below
 *    drives every verdict × every lifecycle state × every gate shape — the
 *    fixed server's, the old server's and nonsense — and asserts tone `open`
 *    is produced ONLY for the verdict `yes`.
 *  * TRUSTING THE STATE OVER THE VERDICT. The server that predates the fix
 *    still sends `LANDSIDE_AVAILABLE` for `entry_unverified` and `tight`. A
 *    badge keyed on the state — which is what `describeLayoverState` was —
 *    fails the "stale server" case.
 *  * A VERDICT OR A STATE THIS BUILD HAS NEVER SEEN DRAWN AS A YES, or dropped.
 *
 * The same table is driven from the SERVER's real payloads, for every verdict
 * the real engine produces, in
 * artifacts/api-server/src/test/layoverGateFailClosed.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN_VERDICT_COPY,
  VERDICT_COPY,
  describeCautions,
  describeLandsideBadge,
  describeVerdict,
  type LandsideBadgeGate,
  type LeaveVerdict,
} from '../layoverVerdictFacts.ts';

const VERDICTS: LeaveVerdict[] = ['yes', 'tight', 'no', 'entry_unverified', 'stay_airside'];
/** What the sweep drives as a verdict: every real one, one this build predates, and none at all. Typed once, outside the loops. */
const SWEPT_VERDICTS: Array<string | null> = [...VERDICTS, 'some_future_verdict', null];
const STATES: Array<string | null> = [
  null, 'NEEDS_INFO', 'AIRPORT_ONLY', 'LANDSIDE_AVAILABLE', 'PLAN_SELECTED',
  'RETURN_SOON', 'RETURN_NOW', 'RETURNING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'AIRPORT_REENTERED',
];
const GATES: Array<LandsideBadgeGate | null> = [
  null,
  {},
  // the server before the fix: `open` meant "nothing closed it"
  { open: true, closedBy: [], needsInfo: null },
  { open: false, closedBy: ['entry_refused'], needsInfo: null },
  { open: false, closedBy: ['baggage_unknown'], needsInfo: 'baggageMode' },
  // the fixed server
  { open: true, status: 'open', closedBy: [], cautions: [], needsInfo: null },
  { open: false, status: 'caution', closedBy: [], cautions: ['entry_unconfirmed'], needsInfo: null },
  { open: false, status: 'caution', closedBy: [], cautions: ['tight_window'], needsInfo: null },
  { open: false, status: 'closed', closedBy: ['constraints_unreadable'], cautions: [], needsInfo: null },
  { open: false, status: 'closed', closedBy: ['airport_change_unknown'], cautions: [], needsInfo: 'airportChangeRequired' },
  // contradictions no server should send, which must still never read as a yes
  { open: true, status: 'caution', closedBy: [], cautions: ['entry_unconfirmed'], needsInfo: null },
  { open: true, status: 'closed', closedBy: [], cautions: [], needsInfo: null },
  { open: true, status: 'open', closedBy: ['airport_change'], cautions: [], needsInfo: null },
];

test('every verdict has a label, a badge and a tone — and exactly one of them is the green one', () => {
  assert.deepEqual(Object.keys(VERDICT_COPY).sort(), [...VERDICTS].sort());
  const affirm = VERDICTS.filter((v) => VERDICT_COPY[v].tone === 'affirm');
  assert.deepEqual(affirm, ['yes'], 'more than one verdict is drawn as an affirmative');
  for (const v of VERDICTS) {
    assert.ok(VERDICT_COPY[v].label.length > 0, v);
    assert.ok(VERDICT_COPY[v].badge.length > 0, v);
    assert.equal(describeVerdict(v), VERDICT_COPY[v], v);
  }
  // The labels `CanILeaveCard` has always shown, pinned: this file took the
  // table over from the card and must not have reworded it on the way.
  assert.equal(VERDICT_COPY.yes.label, 'Yes — you have time');
  assert.equal(VERDICT_COPY.tight.label, 'Tight — stay close');
  assert.equal(VERDICT_COPY.no.label, 'No — stay airside');
  assert.equal(VERDICT_COPY.entry_unverified.label, 'Time is fine — entry unconfirmed');
  assert.equal(VERDICT_COPY.stay_airside.label, 'Staying in — good call');
});

test('a verdict this build has never been taught is cautionary — never green, never blank', () => {
  for (const v of ['some_future_verdict', '', null, undefined, 42, 'YES', 'constructor', 'toString', '__proto__']) {
    const got = describeVerdict(v);
    assert.equal(got, UNKNOWN_VERDICT_COPY, String(v));
    assert.equal(got.tone, 'caution', String(v));
    assert.ok(got.label.length > 0, String(v));
  }
});

test('EXHAUSTIVE: the badge is green ONLY for the verdict `yes`, whatever state or gate arrives with it', () => {
  let cases = 0;
  let green = 0;
  for (const verdict of SWEPT_VERDICTS) {
    for (const layoverState of STATES) {
      for (const gate of GATES) {
        cases += 1;
        const badge = describeLandsideBadge({ layoverState, verdict, gate });
        const where: string = `verdict=${String(verdict)} state=${String(layoverState)} gate=${JSON.stringify(gate)}`;
        if (badge?.tone === 'open') {
          green += 1;
          assert.equal(verdict, 'yes', `${where}: a green badge beneath a verdict that is not yes`);
          assert.equal(gate?.open, true, `${where}: a green badge on a gate that is not open`);
          assert.ok(gate?.status !== 'caution' && gate?.status !== 'closed', where);
          assert.equal((gate?.closedBy ?? []).length, 0, where);
          assert.equal((gate?.cautions ?? []).length, 0, where);
          assert.ok(layoverState === 'LANDSIDE_AVAILABLE' || layoverState === 'PLAN_SELECTED', `${where}: green without an affirmative state from the server`);
        }
        if (badge) {
          assert.ok(badge.label.length > 0, where);
          if (verdict !== 'yes') assert.doesNotMatch(badge.label, /can go out|plan set/i, where);
        }
      }
    }
  }
  assert.ok(cases > 500, `only ${cases} combinations were driven`);
  assert.ok(green > 0, 'NON-VACUITY: nothing in the sweep was ever green — a badge that is never green passes every line above');
});

test('the STALE server: LANDSIDE_AVAILABLE beside a cautionary verdict is drawn in the verdict\'s own words', () => {
  const stale = { open: true, closedBy: [], needsInfo: null };
  for (const state of ['LANDSIDE_AVAILABLE', 'PLAN_SELECTED']) {
    assert.deepEqual(
      describeLandsideBadge({ layoverState: state, verdict: 'entry_unverified', gate: stale }),
      { label: 'Entry unconfirmed', tone: 'caution' }, state,
    );
    assert.deepEqual(
      describeLandsideBadge({ layoverState: state, verdict: 'tight', gate: stale }),
      { label: 'Tight — stay close', tone: 'caution' }, state,
    );
    // …and a refusal beside an affirmative state is a refusal.
    assert.equal(describeLandsideBadge({ layoverState: state, verdict: 'no', gate: stale })?.tone, 'closed', state);
  }
});

test('the FIXED server: each answer it gives is the badge it should be', () => {
  const open = { open: true, status: 'open', closedBy: [], cautions: [], needsInfo: null };
  assert.deepEqual(describeLandsideBadge({ layoverState: 'LANDSIDE_AVAILABLE', verdict: 'yes', gate: open }), { label: 'You can go out', tone: 'open' });
  assert.deepEqual(describeLandsideBadge({ layoverState: 'PLAN_SELECTED', verdict: 'yes', gate: open }), { label: 'Plan set', tone: 'open' });
  // The cautionary gate arrives with NO state (`landside_unconfirmed`) — the
  // badge is still said, from the verdict.
  const caution = { open: false, status: 'caution', closedBy: [], cautions: ['entry_unconfirmed'], needsInfo: null };
  assert.deepEqual(describeLandsideBadge({ layoverState: null, verdict: 'entry_unverified', gate: caution }), { label: 'Entry unconfirmed', tone: 'caution' });
  const closed = { open: false, status: 'closed', closedBy: ['constraints_unreadable'], cautions: [], needsInfo: null };
  assert.deepEqual(describeLandsideBadge({ layoverState: 'AIRPORT_ONLY', verdict: 'no', gate: closed }), { label: 'Airport only', tone: 'closed' });
  const ask = { open: false, status: 'closed', closedBy: ['airport_change_unknown'], cautions: [], needsInfo: 'airportChangeRequired' };
  assert.deepEqual(describeLandsideBadge({ layoverState: 'NEEDS_INFO', verdict: 'no', gate: ask }), { label: 'One answer needed', tone: 'ask' });
  assert.deepEqual(describeLandsideBadge({ layoverState: 'AIRPORT_ONLY', verdict: 'stay_airside', gate: { ...closed, closedBy: ['traveller_staying_airside'] } }), { label: 'Airport only', tone: 'closed' });
});

test('journey states are the server\'s, a state this build predates survives as itself, a withheld one is left unsaid', () => {
  const open = { open: true, status: 'open', closedBy: [], cautions: [], needsInfo: null };
  assert.deepEqual(describeLandsideBadge({ layoverState: 'RETURN_NOW', verdict: 'no', gate: { open: false, closedBy: ['insufficient_time'] } }), { label: 'Head back now', tone: 'return' });
  assert.equal(describeLandsideBadge({ layoverState: 'RETURNING', verdict: 'yes', gate: open })?.tone, 'return');
  assert.equal(describeLandsideBadge({ layoverState: 'COMPLETED', verdict: 'yes', gate: open })?.tone, 'done');
  assert.deepEqual(describeLandsideBadge({ layoverState: 'AIRPORT_REENTERED', verdict: 'yes', gate: open }), { label: 'AIRPORT_REENTERED', tone: 'unknown' });
  // verdict yes, gate open, and the state WITHHELD (the plan could not be
  // read): nothing certified to add, so nothing is said — and not a green.
  assert.equal(describeLandsideBadge({ layoverState: null, verdict: 'yes', gate: open }), null);
  // verdict yes with NO gate at all is not a yes this badge will repeat.
  assert.equal(describeLandsideBadge({ layoverState: 'LANDSIDE_AVAILABLE', verdict: 'yes', gate: null })?.tone, 'caution');
});

test('cautions keep the server order and an untaught one survives as its own code', () => {
  const got = describeCautions(['tight_window', 'entry_unconfirmed', 'something_new']);
  assert.deepEqual(got.map((c) => c.code), ['tight_window', 'entry_unconfirmed', 'something_new']);
  assert.match(got[0].sentence, /tight/);
  assert.match(got[1].sentence, /passport/);
  assert.equal(got[2].sentence, 'something_new');
  assert.deepEqual(describeCautions([]), []);
  assert.deepEqual(describeCautions(undefined), []);
  assert.deepEqual(describeCautions(null), []);
});

test('a token that happens to name an Object.prototype member is a token, not a lookup hit', () => {
  // `table[key] ?? key` finds `constructor` and `toString` on the prototype and
  // would have rendered a FUNCTION where a sentence or a badge belongs.
  assert.deepEqual(describeCautions(['constructor', 'toString']), [
    { code: 'constructor', sentence: 'constructor' }, { code: 'toString', sentence: 'toString' },
  ]);
  const open = { open: true, status: 'open', closedBy: [], cautions: [], needsInfo: null };
  assert.deepEqual(describeLandsideBadge({ layoverState: 'constructor', verdict: 'yes', gate: open }), { label: 'constructor', tone: 'unknown' });
});
