/**
 * TripReservationsSection — extraction_failed error display.
 *
 * Tests ImportSheet directly (visible=true) to avoid spending the press
 * budget on opening the sheet.  Press 1 = extract → error shown.
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

describe('TripReservationsSection — extraction_failed error', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('shows inline extraction error when the API returns an error field', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const svc = require('../../services/tripIntel.ts');
    (svc.importReservations as jest.Mock).mockResolvedValue({
      reservations: [],
      error: 'Could not parse the confirmation text.',
    });

    const onDismiss = jest.fn();
    const onImported = jest.fn();

    // Render sheet already open — no need to press to open it
    const view = await render(
      <ImportSheet
        tripId="trip-err-test"
        visible={true}
        onDismiss={onDismiss}
        onImported={onImported}
      />,
    );

    // Sheet body is immediately visible
    await view.findByText(/Paste a confirmation email/);

    // Enter text — wrap in async act to ensure setText re-renders before the
    // subsequent press (handleImport reads text from its closure).
    await act(async () => {
      fireEvent.changeText(
        view.getByPlaceholderText('Paste confirmation text here…'),
        'garbage text that fails extraction',
      );
    });

    // Press 1 (act-wrapped): trigger extraction
    await act(async () => {
      fireEvent.press(view.getByTestId('extract-button'));
    });

    // The inline error must appear
    await waitFor(() => {
      expect(view.getByText(/Extraction failed/)).toBeTruthy();
    });
  });
});
