/**
 * TrustDetail — cross-platform reason modal test.
 *
 * Alert.prompt is iOS-only (silent no-op on Android/web). The trust-detail
 * screen now collects reasons via ReasonPromptModal. This test pins that
 * confirming a pending trust event opens the modal, requires a reason, and
 * passes the typed reason to the service.
 *
 * ## Act strategy
 *
 * All fireEvent calls are bare (no act() wrapper).  Wrapping fireEvent in
 * await act(async () => {}) causes React 19 to schedule concurrent follow-up
 * work after each commit, which overlaps with the next act() scope and
 * produces "overlapping act() calls" warnings.  Bare fireEvent + waitFor
 * avoids this: React batches the state update freely, and waitFor's own
 * internal act() flushes exactly what is needed before the assertion.
 */
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import TrustDetailScreen from '../../../app/admin/trust-detail.tsx';
import { fetchUserTrustDetail, confirmTrustEvent } from '../../services/trustAdmin.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ userId: 'user-1' })),
}));
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useRequireAdmin', () => ({ ...jest.requireActual('../../hooks/useRequireAdmin'), useRequireAdmin: jest.fn() }));
jest.mock('../../services/trustAdmin', () => ({
  ...jest.requireActual('../../services/trustAdmin'),
  fetchUserTrustDetail:  jest.fn(),
  confirmTrustEvent:     jest.fn(),
  dismissTrustEvent:     jest.fn(),
  applyTrustRestriction: jest.fn(),
  liftTrustRestriction:  jest.fn(),
  liftTrustCap:          jest.fn(),
}));

const mockFetch   = fetchUserTrustDetail as jest.Mock;
const mockConfirm = confirmTrustEvent as jest.Mock;

/** Defer mock resolution to the next macrotask so continuations fire outside act(). */
const deferred = <T>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

const detail = {
  profile: { public_level: 'reliable_traveler', overall_score: 70, categories: {} },
  caps: [],
  restrictions: [],
  openReviews: [],
  events: [{
    id: 'ev-1',
    event_type: 'no_show',
    status: 'pending_review',
    category: 'plan_attendance',
    delta: -5,
    severity: 'medium',
    created_at: '2026-07-01T00:00:00Z',
  }],
};

describe('TrustDetail reason modal', () => {
  it('confirms a pending event via the modal and passes the reason', async () => {
    mockFetch.mockImplementation(() => deferred(detail));
    mockConfirm.mockImplementation(() => deferred({}));

    await render(<TrustDetailScreen />);

    // The screen now shows the access gate modal first. Submit a reason so
    // the data load fires and the trust-event list renders.
    // changeText is bare; waitFor confirms value committed before pressing.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'audit access check');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('audit access check'),
    );
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));

    await waitFor(() => expect(screen.getByText('Confirm')).toBeTruthy());

    // No modal yet
    expect(screen.queryByTestId('reason-modal')).toBeNull();

    // Bare press — sync setState; waitFor below confirms modal appears.
    fireEvent.press(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByTestId('reason-modal')).toBeTruthy());

    // Confirm is disabled without a reason — service must not be called.
    // Bare press — the handler is a sync no-op; assert immediately.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    expect(mockConfirm).not.toHaveBeenCalled();

    // Bare changeText — sync setState; waitFor confirms note committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), '  verified with host  ');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('  verified with host  '),
    );

    // Bare press — async submit handler; waitFor below flushes the async chain.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith('ev-1', 'verified with host');
      // Modal closed after submit
      expect(screen.queryByTestId('reason-modal')).toBeNull();
    });
  });

  it('double-tapping the modal confirm submits the event confirmation exactly once', async () => {
    mockConfirm.mockClear();
    mockFetch.mockImplementation(() => deferred(detail));
    mockConfirm.mockImplementation(() => deferred({}));

    await render(<TrustDetailScreen />);

    // Submit the access gate so the data load fires.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'audit access check');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('audit access check'),
    );
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));

    await waitFor(() => expect(screen.getByText('Confirm')).toBeTruthy());

    // Bare press — sync setState; waitFor confirms modal appears.
    fireEvent.press(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByTestId('reason-input')).toBeTruthy());

    // Bare changeText — sync setState; waitFor confirms note committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'verified');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('verified'),
    );

    // Fast double-tap before the modal closes — both presses are bare so the
    // in-flight guard sees the first press before any re-render.
    const btn = screen.getByTestId('reason-confirm-btn');
    fireEvent.press(btn);
    fireEvent.press(btn);

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockConfirm).toHaveBeenCalledWith('ev-1', 'verified');
  });
});
