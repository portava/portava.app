/**
 * census-layover L267 / L11 — the client half's words and checks. The server
 * owns every judgement; these only say its answers in words, and refuse an
 * entry that cannot be a flight before it is sent.
 *
 * Run: node --import tsx/esm --test src/features/trips/layover/__tests__/tripLayoverConnections.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOVER_STATE_WORDS, bookingWords, flightEntryProblem, gapWords, riskWords, stateWords, unknownWords,
} from '../tripLayoverConnections.ts';

const SPEC_STATES = ['DETECTED', 'NEEDS_INFO', 'EVALUATING', 'AIRPORT_ONLY', 'LANDSIDE_AVAILABLE', 'PLAN_SELECTED', 'EXECUTING',
  'RETURN_SOON', 'RETURN_NOW', 'RETURNING', 'AIRPORT_REENTERED', 'BOARDING', 'COMPLETED', 'DISRUPTED', 'CANCELLED', 'ABANDONED', 'EXPIRED'];

describe('the Trips layover card words', () => {
  it('every one of §4.1\'s seventeen LayoverState members has words; an unrecorded state says so', () => {
    assert.deepEqual(Object.keys(LAYOVER_STATE_WORDS).sort(), [...SPEC_STATES].sort());
    assert.equal(stateWords(null), 'Status not recorded');
    assert.equal(stateWords('DISRUPTED'), 'Flight changed — rechecking');
  });
  it('risk, with its number; missed says why when a flight is cancelled; unknown is never "on track"', () => {
    assert.equal(riskWords({ risk: 'at_risk', slackMinutes: -20, processMinutes: 165, reasons: [] }), "Tight connection — 20 min short of this airport's transfer buffer");
    assert.equal(riskWords({ risk: 'missed', slackMinutes: null, processMinutes: null, reasons: ['onward_cancelled'] }), 'Your onward flight is cancelled');
    assert.equal(riskWords({ risk: 'unknown', slackMinutes: null, processMinutes: null, reasons: [] }), 'Connection risk unknown — a time is missing');
  });
  it('gaps, bookings and unknowns in words', () => {
    assert.equal(gapWords(360), '6h 00m');
    assert.equal(gapWords(-30), '−0h 30m');
    assert.equal(gapWords(null), 'gap unknown');
    assert.match(bookingWords('separate_bookings'), /re-check bags/);
    assert.equal(unknownWords(['inbound_arrival_unknown', 'onward_departure_unknown']), 'when the arriving flight lands; when the next flight leaves');
  });
  it('a flight entry is checked for shape only; the times are each airport\'s own and are sent as typed', () => {
    const ok = { flight: 'BA 286', departureAirport: 'sfo', arrivalAirport: 'LHR', departureLocal: '2030-06-01 17:00', arrivalLocal: '2030-06-02T11:05' };
    assert.equal(flightEntryProblem(ok), null);
    assert.match(String(flightEntryProblem({ ...ok, flight: '286' })), /airline code/);
    assert.match(String(flightEntryProblem({ ...ok, arrivalAirport: 'SFO' })), /different airport/);
    assert.match(String(flightEntryProblem({ ...ok, departureLocal: '5pm' })), /local time/);
  });
});
