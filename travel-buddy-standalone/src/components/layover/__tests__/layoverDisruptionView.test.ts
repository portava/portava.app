/**
 * census-layover L148 (round 2) — which disruption state the layover screen
 * shows, and from whose memory. The pure rule under LayoverDisruptionCard.
 *
 *   1. the overview member is read defensively: absent ≠ unknown ≠ default;
 *   2. the SERVER's memory wins over this phone's copy whenever it is known;
 *   3. the phone's copy is a fallback for an unknown (or unsent) server memory only;
 *   4. a press in this mount keeps its richer answer until a LATER ledger row in
 *      a DIFFERENT state arrives — never because of a stale or catching-up read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseDisruptionView, ledgerRecordedAt, overviewDisruptionOf, serverUnknownSentence } from '../layoverDisruptionView.ts';
import type { DisruptionAnswer } from '../../../services/layoverDisruption.ts';

const NO_HELP = {
  rebooking: { available: false, reason: 'no_airline_integration' },
  airlineContact: { available: false, reason: 'no_airline_directory' },
  airportHelp: { available: false, reason: 'no_airport_help_directory' },
};

function member(state: string, recordedAt: string | null, source: 'ledger' | 'default' = 'ledger') {
  return { status: 'known', state, source, reportedBy: source === 'ledger' ? 'traveller' : null, recordedAt, baselineDepartureTime: null, recovery: { recoveryNeeded: state === 'CANCELLED', ...NO_HELP } };
}

function answer(state: string, previousState = 'CONNECTION'): DisruptionAnswer {
  return {
    source: 'traveller', previousState, previousStateSource: 'ledger', state,
    event: { kind: 'cancellation', delayMinutes: null }, baselineDepartureTime: null, stateRecorded: true,
    recompute: null, recovery: null, safeReturn: null, certification: null,
  };
}

const T1 = '2026-10-18T10:00:00.000Z';
const T2 = '2026-10-18T10:05:00.000Z';
const T3 = '2026-10-18T10:09:00.000Z';

test('1a. the member: absent is null (an older server), anything unreadable is UNKNOWN, never "nothing reported"', () => {
  assert.equal(overviewDisruptionOf(undefined), null);
  assert.equal(overviewDisruptionOf(null), null);
  for (const bad of ['CANCELLED', 42, [], { status: 'known' }, { status: 'known', state: 'CANCELLED', source: 'feed' }, { status: 'maybe' }]) {
    assert.deepEqual(overviewDisruptionOf(bad), { status: 'unknown', reason: 'malformed', message: null }, JSON.stringify(bad));
  }
  assert.deepEqual(overviewDisruptionOf({ status: 'unknown', reason: 'ledger_unreadable', message: 'Could not read.' }), { status: 'unknown', reason: 'ledger_unreadable', message: 'Could not read.' });
});

test('1b. a known member keeps the server\'s state verbatim (an unknown code too) and only a literal `true` is help', () => {
  const m = overviewDisruptionOf({ ...member('HOLDING_PATTERN', T1), recovery: { recoveryNeeded: true, rebooking: { available: 'yes' } } });
  assert.equal(m?.status, 'known');
  if (m?.status !== 'known') return;
  assert.equal(m.state, 'HOLDING_PATTERN');
  assert.equal(m.recordedAt, T1);
  assert.equal(m.recovery?.rebooking.available, false);
  assert.equal(ledgerRecordedAt(m), T1);
  assert.equal(ledgerRecordedAt(overviewDisruptionOf(member('CONNECTION', null, 'default'))), null);
});

test('2. the SERVER\'s memory wins over this phone\'s copy, even when they disagree', () => {
  const v = chooseDisruptionView(overviewDisruptionOf(member('REBOOKING', T2)), answer('CANCELLED'), 'phone', null);
  assert.equal(v.from, 'server');
  assert.equal(v.from === 'server' && v.member.state, 'REBOOKING');
});

test('2b. the server says NOTHING was reported: nothing is shown — not this phone\'s copy', () => {
  const v = chooseDisruptionView(overviewDisruptionOf(member('CONNECTION', null, 'default')), answer('CANCELLED'), 'phone', null);
  assert.deepEqual(v, { from: 'none', serverUnknown: false });
});

test('3. the phone\'s copy is shown ONLY when the server\'s memory is unknown (said so) or was not sent', () => {
  const unknown = chooseDisruptionView(overviewDisruptionOf({ status: 'unknown', reason: 'ledger_unreadable' }), answer('CANCELLED'), 'phone', null);
  assert.equal(unknown.from, 'phone');
  assert.equal(unknown.serverUnknown, true);
  const unsent = chooseDisruptionView(null, answer('CANCELLED'), 'phone', null);
  assert.equal(unsent.from, 'phone');
  assert.equal(unsent.serverUnknown, false);
  const nothing = chooseDisruptionView(overviewDisruptionOf({ status: 'unknown', reason: 'ledger_unreadable' }), null, null, null);
  assert.deepEqual(nothing, { from: 'none', serverUnknown: true });
});

test('4a. a press keeps its answer while the overview still shows the row it showed at the press, or catches up to the same state', () => {
  const stale = chooseDisruptionView(overviewDisruptionOf(member('DELAYED', T1)), answer('CANCELLED', 'DELAYED'), 'press', T1);
  assert.equal(stale.from, 'press');
  const caughtUp = chooseDisruptionView(overviewDisruptionOf(member('CANCELLED', T2)), answer('CANCELLED', 'DELAYED'), 'press', T1);
  assert.equal(caughtUp.from, 'press');
  const defaultRead = chooseDisruptionView(overviewDisruptionOf(member('CONNECTION', null, 'default')), answer('CANCELLED'), 'press', null);
  assert.equal(defaultRead.from, 'press');
});

test('4b. a LATER row in a DIFFERENT state (another device reported after this press) takes over', () => {
  const v = chooseDisruptionView(overviewDisruptionOf(member('REBOOKING', T3)), answer('CANCELLED', 'DELAYED'), 'press', T1);
  assert.equal(v.from, 'server');
  // …and the first row after a press made with nothing recorded counts as later.
  const fromNothing = chooseDisruptionView(overviewDisruptionOf(member('REBOOKING', T3)), answer('CANCELLED'), 'press', null);
  assert.equal(fromNothing.from, 'server');
});

test('4c. an OLDER row in a different state (a read already in flight at the press) never overwrites the press', () => {
  const v = chooseDisruptionView(overviewDisruptionOf(member('DELAYED', T1)), answer('CANCELLED', 'DELAYED'), 'press', T2);
  assert.equal(v.from, 'press');
  const unreadable = chooseDisruptionView(overviewDisruptionOf(member('DELAYED', 'not-a-time')), answer('CANCELLED', 'DELAYED'), 'press', T2);
  assert.equal(unreadable.from, 'press');
});

test('5. the unknown sentence is the server\'s when it sent one, and never says nothing was reported', () => {
  assert.equal(serverUnknownSentence(overviewDisruptionOf({ status: 'unknown', reason: 'ledger_unreadable', message: 'Server words.' })), 'Server words.');
  const own = serverUnknownSentence(overviewDisruptionOf({ status: 'unknown', reason: 'malformed' }));
  assert.match(own, /could not read this flight.s disruption history/);
  assert.doesNotMatch(own, /no (delay|disruption)|nothing (was|has been) reported|on time/i);
});
