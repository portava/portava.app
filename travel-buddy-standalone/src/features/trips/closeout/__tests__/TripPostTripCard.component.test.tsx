/**
 * TRIP-F22: TripPostTripCard — memory candidates and the passport preview.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripPostTripCard } from '../TripPostTripCard.tsx';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));

const draft = { tripId: 't1', title: 'Hoi An', placeId: null, startsAt: null, endsAt: null, locationCity: 'Hoi An', locationCountry: 'Vietnam' };
const memory = (candidates: unknown[], unread: string[] = []) => ({ state: 'ok' as const, data: { tripId: 't1', candidates, realizedCount: 0, media: null, unrecordedDonePlanIds: [], unread, reading: '' } as any });
const passport = { state: 'ok' as const, data: { tripId: 't1', completed: true, countries: ['Vietnam'], cities: ['Hoi An'], stamps: [], unread: [], reading: '' } };

it('shows the passport preview and the candidates; "keep" sends the draft and reports only what came back', async () => {
  const keep = jest.fn().mockResolvedValueOnce({ ok: false, message: 'HTTP 500' }).mockResolvedValue({ ok: true, memoryId: 'm9' });
  await render(<TripPostTripCard tripId="t1"
    loadMemory={jest.fn().mockResolvedValue(memory([
      { id: 'plan:p1', kind: 'place_visited', title: 'Hoi An', occurredAt: null, evidence: { source: 'outcome', ids: ['o1'] }, memoryDraft: draft, realized: null },
      { id: 'plan:p2', kind: 'activity_completed', title: 'Cooking', occurredAt: null, evidence: { source: 'plan_status', ids: ['p2'] }, memoryDraft: null, realized: { memoryId: 'm1', mediaCount: 2 } },
    ], ['trip_outcomes']))}
    loadPassport={jest.fn().mockResolvedValue(passport)}
    keep={keep} />);
  await waitFor(() => screen.getByTestId('trip-posttrip-passport'));
  expect(screen.getByText('Adds 1 country and 1 city · 0 stamps')).toBeTruthy();
  expect(screen.getByTestId('trip-posttrip-open-plan:p2')).toBeTruthy();
  expect(screen.getByTestId('trip-posttrip-unread')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('trip-posttrip-keep-plan:p1'));
  await waitFor(() => screen.getByText('Not saved — HTTP 500'));
  await fireEvent.press(screen.getByTestId('trip-posttrip-keep-plan:p1'));
  await waitFor(() => screen.getByTestId('trip-posttrip-kept-plan:p1'));
  expect(keep).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Hoi An', state: 'draft', operationId: 'trip-memory:t1:plan:p1' }));
});

it('a failed candidates read is not "no candidates"', async () => {
  await render(<TripPostTripCard tripId="t1"
    loadMemory={jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 503' })}
    loadPassport={jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 503' })} />);
  await waitFor(() => screen.getByTestId('trip-posttrip-memory-unavailable'));
  expect(screen.queryByTestId('trip-posttrip-empty')).toBeNull();
  expect(screen.getByTestId('trip-posttrip-passport-unavailable')).toBeTruthy();
});

it('an empty projection says there is nothing yet', async () => {
  await render(<TripPostTripCard tripId="t1" loadMemory={jest.fn().mockResolvedValue(memory([]))} loadPassport={jest.fn().mockResolvedValue(passport)} />);
  await waitFor(() => screen.getByTestId('trip-posttrip-empty'));
});
