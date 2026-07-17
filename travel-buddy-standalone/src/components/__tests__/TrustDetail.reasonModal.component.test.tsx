/**
 * TrustDetail — cross-platform reason modal test.
 *
 * Alert.prompt is iOS-only (silent no-op on Android/web). The trust-detail
 * screen now collects reasons via ReasonPromptModal. This test pins that
 * confirming a pending trust event opens the modal, requires a reason, and
 * passes the typed reason to the service.
 */
import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
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
    mockFetch.mockResolvedValue(detail);
    mockConfirm.mockResolvedValue({});

    await act(async () => { render(<TrustDetailScreen />); });

    await waitFor(() => expect(screen.getByText('Confirm')).toBeTruthy());

    // No modal yet
    expect(screen.queryByTestId('reason-modal')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByText('Confirm')); });
    expect(screen.getByTestId('reason-modal')).toBeTruthy();

    // Confirm is disabled without a reason — service must not be called.
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });
    expect(mockConfirm).not.toHaveBeenCalled();

    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), '  verified with host  '); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith('ev-1', 'verified with host'));
    // Modal closed after submit
    expect(screen.queryByTestId('reason-modal')).toBeNull();
  });
});
