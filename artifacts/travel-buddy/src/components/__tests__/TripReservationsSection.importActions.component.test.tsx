/**
 * TripReservationsSection — confirm and dismiss actions on extracted rows.
 *
 * Tests ImportSheet directly (visible=true) to avoid spending the press
 * budget on opening the sheet.  Press 1 = extract → review step.
 * Press 2 = Confirm row 1.  Press 3 = Dismiss row 2.
 *
 * Presses 2+ no longer produce visual commits in the React-19 renderer after
 * the press-commit budget is spent, but dispatch IS synchronous so mock
 * call-count assertions remain reliable.
 * See `.agents/memory/rntl-react19-renderer-budget.md`.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';

// ── expo-router mock ──────────────────────────────────────────────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn() },
    useFocusEffect: jest.fn((cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    }),
  };
});

// ── tripIntel service mock ────────────────────────────────────────────────────
// NOTE: spreading requireActual so the mock never drifts behind new exports.
jest.mock('../../services/tripIntel.ts', () => ({
  ...jest.requireActual('../../services/tripIntel.ts'),
  listReservations:    jest.fn(),
  importReservations:  jest.fn(),
  confirmReservation:  jest.fn(),
  dismissReservation:  jest.fn(),
}));

// ── Modal proxy mock ──────────────────────────────────────────────────────────
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { ImportSheet } from '../trip/TripReservationsSection.tsx';

const TRIP_ID = 'trip-actions-test';

function makeRow(id: string, title: string) {
  return {
    id,
    type: 'flight',
    title,
    startsAt: '2026-10-01T06:00:00Z',
    endsAt: '2026-10-01T09:00:00Z',
    locationName: null,
    confirmationRef: null,
    cancellationDeadlineAt: null,
    status: 'pending_confirm',
    extractionConfidence: 0.85,
  };
}

describe('TripReservationsSection — confirm and dismiss actions', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('calls confirmReservation and dismissReservation when respective buttons are tapped', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const svc = require('../../services/tripIntel.ts');
    (svc.importReservations as jest.Mock).mockResolvedValue({
      reservations: [
        makeRow('row-to-confirm', 'Flight to Confirm'),
        makeRow('row-to-dismiss', 'Hotel to Dismiss'),
      ],
    });
    (svc.confirmReservation as jest.Mock).mockResolvedValue(true);
    (svc.dismissReservation as jest.Mock).mockResolvedValue(true);

    const onImported = jest.fn();

    // Render sheet already open — eliminates press 1 (open)
    const view = await render(
      <ImportSheet
        tripId={TRIP_ID}
        visible={true}
        onDismiss={jest.fn()}
        onImported={onImported}
      />,
    );

    // Paste step is visible
    await view.findByText(/Paste a confirmation email/);

    // Wrap in async act so setText re-renders before the press reads the
    // text closure (handleImport would bail early on stale text = '').
    await act(async () => {
      fireEvent.changeText(
        view.getByPlaceholderText('Paste confirmation text here…'),
        'Full booking confirmation',
      );
    });

    // Press 1 (act-wrapped): extract → transitions to review step
    await act(async () => {
      fireEvent.press(view.getByTestId('extract-button'));
    });

    // Review step should now be visible (visual commit from press 1)
    await view.findByText('Review extracted reservations');
    // Row titles are editable TextInputs — verify via display value, not text node
    await view.findByDisplayValue('Flight to Confirm');
    await view.findByDisplayValue('Hotel to Dismiss');

    // Press 2: Confirm first row — dispatch is synchronous, mock is called
    // even if visual state (row marked "Added") may not render post-budget.
    const confirmBtns = view.getAllByText('Confirm');
    await act(async () => { fireEvent.press(confirmBtns[0]); });

    await waitFor(() => {
      expect(svc.confirmReservation).toHaveBeenCalledWith(TRIP_ID, 'row-to-confirm', false);
    });

    // Press 3: Dismiss second row — same pattern
    const dismissBtns = view.getAllByText('Dismiss');
    await act(async () => { fireEvent.press(dismissBtns[dismissBtns.length - 1]); });

    await waitFor(() => {
      expect(svc.dismissReservation).toHaveBeenCalledWith(TRIP_ID, 'row-to-dismiss');
    });
  });
});
