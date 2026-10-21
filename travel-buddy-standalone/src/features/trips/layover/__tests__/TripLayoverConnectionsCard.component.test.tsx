/**
 * census-layover L267 (+ L11's flight entry): the Trips card shows the trip's
 * layovers — detected from its flights by the server — with their risk and the
 * traveller's layover status, and passes the two flights into session creation.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripLayoverConnectionsCard } from '../TripLayoverConnectionsCard.tsx';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));

const flight = (id: string, designator: string, over: Record<string, unknown> = {}) => ({
  id, designator, departureAirport: 'SFO', arrivalAirport: 'LHR', scheduledDepartureAt: null, scheduledArrivalAt: null,
  departureTerminal: null, arrivalTerminal: '5', departureGate: null, arrivalGate: null, status: 'unknown',
  bestKnownDeparture: { at: null, basis: 'unknown' }, bestKnownArrival: { at: null, basis: 'unknown' }, ...over,
});
const connection = (over: Record<string, unknown> = {}) => ({
  key: 'in:out', status: 'detected', unknowns: [], airport: 'LHR',
  arrivalSegment: flight('in', 'BA286'), departureSegment: flight('out', 'BA1442', { departureTerminal: '3' }),
  scheduledGapMinutes: 360, gapMinutes: 360, connectionType: 'single_booking', terminalChange: true,
  missedConnection: { risk: 'on_track', slackMinutes: 195, processMinutes: 165, reasons: [] },
  session: null, ...over,
});
const ok = (connections: unknown[]) => ({ state: 'ok' as const, data: { connections, degraded: false, degradedReasons: [] } as any });

it('with either flag off the card draws nothing', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'off' });
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} />);
  await waitFor(() => expect(load).toHaveBeenCalled());
  expect(screen.queryByTestId('trip-layovers-card')).toBeNull();
  expect(screen.queryByTestId('trip-layovers-unavailable')).toBeNull();
});

it('a detected connection shows the airport, the gap, the flights, the booking, the terminal change and the risk; Start hands both flights over and opens the layover', async () => {
  const load = jest.fn().mockResolvedValueOnce(ok([connection()])).mockResolvedValue(ok([connection({ session: { sessionId: 's1', status: 'active', state: 'DETECTED' } })]));
  const start = jest.fn().mockResolvedValue({ state: 'done', status: 201, data: { session: { id: 's1' }, existed: false } });
  const open = jest.fn();
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} start={start} open={open} />);
  await waitFor(() => screen.getByText('LHR · 6h 00m'));
  expect(screen.getByText('BA286 → BA1442 · One booking')).toBeTruthy();
  expect(screen.getByTestId('trip-layover-terminal-in:out')).toBeTruthy();
  expect(screen.getByText('Connection on track')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('trip-layover-start-in:out'));
  await waitFor(() => expect(start).toHaveBeenCalledWith('t1', expect.objectContaining({ arrivalSegment: expect.objectContaining({ id: 'in' }), departureSegment: expect.objectContaining({ id: 'out' }) })));
  await waitFor(() => expect(open).toHaveBeenCalledWith('s1'));
  await waitFor(() => screen.getByText('Layover: Detected'));
});

it('a connection with my layover shows its §4.1 state in words, and Open', async () => {
  const load = jest.fn().mockResolvedValue(ok([connection({ session: { sessionId: 's9', status: 'active', state: 'DISRUPTED' }, missedConnection: { risk: 'missed', slackMinutes: null, processMinutes: 165, reasons: ['inbound_lands_after_onward_cutoff'] } })]));
  const open = jest.fn();
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} open={open} />);
  await waitFor(() => screen.getByText('Layover: Flight changed — rechecking'));
  expect(screen.getByText('On the latest times, this connection is missed')).toBeTruthy();
  expect(screen.queryByTestId('trip-layover-start-in:out')).toBeNull();
  await fireEvent.press(screen.getByTestId('trip-layover-open-in:out'));
  expect(open).toHaveBeenCalledWith('s9');
});

it('a tight connection says how many minutes short, not just "tight"', async () => {
  const load = jest.fn().mockResolvedValue(ok([connection({ missedConnection: { risk: 'at_risk', slackMinutes: -15, processMinutes: 165, reasons: ['shorter_than_process_buffer'] } })]));
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} />);
  await waitFor(() => screen.getByText("Tight connection — 15 min short of this airport's transfer buffer"));
});

it('an undetermined connection names the missing time and offers no Start', async () => {
  const load = jest.fn().mockResolvedValue(ok([connection({ status: 'undetermined', gapMinutes: null, unknowns: ['onward_departure_unknown'] })]));
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} />);
  await waitFor(() => screen.getByText('LHR · gap unknown'));
  expect(screen.getByText('Not enough to go on: when the next flight leaves.')).toBeTruthy();
  expect(screen.queryByTestId('trip-layover-start-in:out')).toBeNull();
});

it('a refused start is shown by name and nothing is opened', async () => {
  const load = jest.fn().mockResolvedValue(ok([connection()]));
  const start = jest.fn().mockResolvedValue({ state: 'refused', status: 400, reason: 'already_departed', detail: 'The onward flight of this connection has already left.' });
  const open = jest.fn();
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} start={start} open={open} />);
  await waitFor(() => screen.getByTestId('trip-layover-start-in:out'));
  await fireEvent.press(screen.getByTestId('trip-layover-start-in:out'));
  await waitFor(() => screen.getByText('The onward flight of this connection has already left.'));
  expect(open).not.toHaveBeenCalled();
});

it('a failed read says so, with a retry; it is never drawn as "no layovers"', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' }).mockResolvedValue(ok([]));
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} />);
  await waitFor(() => screen.getByTestId('trip-layovers-unavailable'));
  expect(screen.queryByTestId('trip-layovers-none')).toBeNull();
  await fireEvent.press(screen.getByTestId('trip-layovers-retry'));
  await waitFor(() => screen.getByTestId('trip-layovers-none'));
});

it('Add a flight: a bad entry is caught before sending; a good one is sent once per intent, and a retry reuses the key', async () => {
  const load = jest.fn().mockResolvedValue(ok([]));
  const addFlight = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' })
    .mockResolvedValueOnce({ state: 'done', status: 201, data: { segment: { id: 'x' } } });
  await render(<TripLayoverConnectionsCard tripId="t1" load={load} addFlight={addFlight} />);
  await waitFor(() => screen.getByTestId('trip-flight-add'));
  await fireEvent.press(screen.getByTestId('trip-flight-add'));
  await fireEvent.changeText(screen.getByTestId('trip-flight-flight'), '286');
  await fireEvent.press(screen.getByTestId('trip-flight-save'));
  await waitFor(() => screen.getByTestId('trip-flight-problem'));
  expect(addFlight).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByTestId('trip-flight-flight'), 'BA286');
  await fireEvent.changeText(screen.getByTestId('trip-flight-departureAirport'), 'SFO');
  await fireEvent.changeText(screen.getByTestId('trip-flight-arrivalAirport'), 'LHR');
  await fireEvent.changeText(screen.getByTestId('trip-flight-departureLocal'), '2030-06-01 17:00');
  await fireEvent.changeText(screen.getByTestId('trip-flight-arrivalLocal'), '2030-06-02 11:05');
  await fireEvent.press(screen.getByTestId('trip-flight-save'));
  await waitFor(() => screen.getByTestId('trip-flight-not-added'));
  await fireEvent.press(screen.getByTestId('trip-flight-save'));
  await waitFor(() => expect(addFlight).toHaveBeenCalledTimes(2));
  const [first, second] = addFlight.mock.calls;
  expect(first[1]).toEqual(expect.objectContaining({ flight: 'BA286', departureAirport: 'SFO', arrivalAirport: 'LHR', departureLocal: '2030-06-01 17:00' }));
  expect(second[2]).toBe(first[2]);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
