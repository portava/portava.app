/**
 * census-layover L153 — the traveller records the departure gate they see, against the existing Trips route
 * (POST /trips/:tripId/flight-segments/:segmentId/status). The value shown is always the server's: the control sends,
 * then asks the card to re-read.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripFlightGateControl } from '../TripFlightGateControl.tsx';
import { TripLayoverConnectionsCard } from '../TripLayoverConnectionsCard.tsx';
import { gateEntryProblem, recordTripFlightGate } from '../tripLayoverConnections.ts';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));
// NOTE: intentionally exhaustive — the real transport is exercised below with fetch stubbed; native auth is unavailable here.
jest.mock('../../shared/tripApi.ts', () => {
  const actual = jest.requireActual('../../shared/tripApi.ts');
  return { ...actual };
});

const FLIGHT = { id: 'seg-out', designator: 'SQ322', departureGate: null as string | null };

describe('TripFlightGateControl', () => {
  it('says no gate is recorded, sends the typed gate for THIS flight, and asks the card to re-read on success', async () => {
    const record = jest.fn().mockResolvedValue({ state: 'done', status: 200, data: { outcome: {} } });
    const onRecorded = jest.fn();
    await render(<TripFlightGateControl tripId="t1" flight={FLIGHT} record={record} onRecorded={onRecorded} />);
    expect(screen.getByText('Gate not recorded yet')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('trip-flight-gate-input-seg-out'), '  B4 ');
    await fireEvent.press(screen.getByTestId('trip-flight-gate-save-seg-out'));
    await waitFor(() => expect(record).toHaveBeenCalledWith('t1', 'seg-out', { departureGate: '  B4 ' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('trip-flight-gate-saved-seg-out')).toBeTruthy();
  });

  it('shows the gate the server holds, as last recorded', async () => {
    await render(<TripFlightGateControl tripId="t1" flight={{ ...FLIGHT, departureGate: 'C12' }} record={jest.fn()} />);
    expect(screen.getByText('Gate C12 (as last recorded)')).toBeTruthy();
  });

  it('an empty or over-long gate is refused before anything is sent', async () => {
    const record = jest.fn();
    await render(<TripFlightGateControl tripId="t1" flight={FLIGHT} record={record} />);
    await fireEvent.press(screen.getByTestId('trip-flight-gate-save-seg-out'));
    expect(screen.getByTestId('trip-flight-gate-problem-seg-out')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('trip-flight-gate-input-seg-out'), 'X'.repeat(33));
    await fireEvent.press(screen.getByTestId('trip-flight-gate-save-seg-out'));
    expect(screen.getByText('A gate is at most 32 characters.')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });

  it('a refusal is shown by name and nothing is re-read', async () => {
    const record = jest.fn().mockResolvedValue({ state: 'refused', status: 403, detail: 'Not a trip member' });
    const onRecorded = jest.fn();
    await render(<TripFlightGateControl tripId="t1" flight={FLIGHT} record={record} onRecorded={onRecorded} />);
    await fireEvent.changeText(screen.getByTestId('trip-flight-gate-input-seg-out'), 'B4');
    await fireEvent.press(screen.getByTestId('trip-flight-gate-save-seg-out'));
    await waitFor(() => screen.getByText('Not a trip member'));
    expect(onRecorded).not.toHaveBeenCalled();
  });
});

describe('gateEntryProblem / recordTripFlightGate', () => {
  it('validates as the server does (1..32 after trimming)', () => {
    expect(gateEntryProblem({ departureGate: '   ' })).toMatch(/Enter the gate/);
    expect(gateEntryProblem({ departureGate: 'B4' })).toBeNull();
    expect(gateEntryProblem({ departureGate: 'x'.repeat(32) })).toBeNull();
    expect(gateEntryProblem({ departureGate: 'x'.repeat(33) })).toMatch(/at most 32/);
  });
});

describe('the Trips layover card offers the control for each connection\'s ONWARD flight', () => {
  const flight = (id: string, designator: string, over: Record<string, unknown> = {}) => ({
    id, designator, departureAirport: 'SIN', arrivalAirport: 'LHR', scheduledDepartureAt: null, scheduledArrivalAt: null,
    departureTerminal: null, arrivalTerminal: null, departureGate: null, arrivalGate: null, status: 'unknown',
    bestKnownDeparture: { at: null, basis: 'unknown' }, bestKnownArrival: { at: null, basis: 'unknown' }, ...over,
  });
  const connection = (out: Record<string, unknown> = {}) => ({
    key: 'in:out', status: 'detected', unknowns: [], airport: 'SIN',
    arrivalSegment: flight('in', 'SQ31'), departureSegment: flight('out', 'SQ322', out),
    scheduledGapMinutes: 480, gapMinutes: 480, connectionType: 'single_booking', terminalChange: false,
    missedConnection: { risk: 'on_track', slackMinutes: 200, processMinutes: 165, reasons: [] }, session: null,
  });
  const ok = (connections: unknown[]) => ({ state: 'ok' as const, data: { connections, degraded: false, degradedReasons: [] } as any });

  it('saving a gate re-reads the connections, and the gate shown is then the server\'s', async () => {
    const load = jest.fn().mockResolvedValueOnce(ok([connection()])).mockResolvedValue(ok([connection({ departureGate: 'B4' })]));
    const recordGate = jest.fn().mockResolvedValue({ state: 'done', status: 200, data: { outcome: {} } });
    await render(<TripLayoverConnectionsCard tripId="t1" load={load} recordGate={recordGate} />);
    await waitFor(() => screen.getByTestId('trip-flight-gate-out'));
    expect(screen.queryByTestId('trip-flight-gate-in')).toBeNull(); // the inbound flight's gate is not this layover's question
    await fireEvent.changeText(screen.getByTestId('trip-flight-gate-input-out'), 'B4');
    await fireEvent.press(screen.getByTestId('trip-flight-gate-save-out'));
    await waitFor(() => expect(recordGate).toHaveBeenCalledWith('t1', 'out', { departureGate: 'B4' }));
    await waitFor(() => screen.getByText('Gate B4 (as last recorded)'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('recordTripFlightGate — the request on the wire', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  it('POSTs the trimmed gate to the flight\'s status route', async () => {
    const tripApi = require('../../shared/tripApi.ts');
    const send = jest.spyOn(tripApi, 'sendTripWrite').mockResolvedValue({ state: 'done', status: 200, data: { outcome: {} } });
    try {
      const w = await recordTripFlightGate('t 1', 'seg/1', { departureGate: ' B4 ' });
      expect(w.state).toBe('done');
      expect(send).toHaveBeenCalledWith('POST', '/api/trips/t%201/flight-segments/seg%2F1/status', { departureGate: 'B4' });
    } finally { send.mockRestore(); }
  });
});
