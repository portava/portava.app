/**
 * TripSavedPlacesSection (src/components/TripPage.tsx) — contextual
 * "Remind me" entry point on each saved-place card.
 *
 * Task #3574: alongside the trip-level entry point, each saved place in a
 * trip's "Saved Places" strip gets its own "Remind me" icon button that
 * pushes into /reminders/new with a preset saved_place target — so the user
 * never has to re-pick the place on the create screen.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

const mockRemove = jest.fn();
// NOTE: intentional stub — the real hook depends on AsyncStorage internals
// that are not safe under jest; fixed single-place fixture drives this test.
jest.mock('../../hooks/useTripSavedPlaces', () => ({
  useTripSavedPlaces: () => ({
    places: [
      { id: 'place-1', name: 'Time Out Market', category: 'Food hall', address: 'Av. 24 de Julho, Lisbon' },
    ],
    loading: false,
    remove: mockRemove,
    clearAll: jest.fn(),
  }),
}));

import { TripSavedPlacesSection } from '../TripPage.tsx';

describe('TripSavedPlacesSection — "Remind me" entry point', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('pushes /reminders/new with a preset saved_place target when tapped', async () => {
    await render(<TripSavedPlacesSection tripId="trip-abc" />);

    const btn = screen.getByTestId('saved-place-remind-place-1');
    fireEvent.press(btn);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const target = mockPush.mock.calls[0][0] as string;
    expect(target).toContain('/reminders/new?');
    expect(target).toContain('targetType=saved_place');
    expect(target).toContain(`targetId=${encodeURIComponent('place-1')}`);
    expect(target).toContain(`targetLabel=${encodeURIComponent('Time Out Market')}`);
  });

  it('never calls remove() when the "Remind me" button is tapped (distinct from the remove action)', async () => {
    await render(<TripSavedPlacesSection tripId="trip-abc" />);

    fireEvent.press(screen.getByTestId('saved-place-remind-place-1'));

    expect(mockRemove).not.toHaveBeenCalled();
  });
});
