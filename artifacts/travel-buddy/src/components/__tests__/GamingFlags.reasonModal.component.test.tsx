/**
 * GamingFlags — cross-platform note modal test.
 *
 * The "Mark Reviewed" flow used iOS-only Alert.prompt (a silent no-op on
 * Android/web). It now uses ReasonPromptModal with an OPTIONAL note. This
 * test pins that the modal opens, submits with an empty note (note is
 * optional here), and passes a typed note through to the service.
 */
import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import GamingFlagsScreen from '../../../app/admin/gaming-flags.tsx';
import { fetchGamingFlags, markGamingFlagReviewed } from '../../services/trustAdmin.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useRequireAdmin', () => ({ ...jest.requireActual('../../hooks/useRequireAdmin'), useRequireAdmin: jest.fn() }));
jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));
jest.mock('../../services/trustAdmin', () => ({
  ...jest.requireActual('../../services/trustAdmin'),
  fetchGamingFlags:       jest.fn(),
  markGamingFlagReviewed: jest.fn(),
}));

const mockFlags  = fetchGamingFlags as jest.Mock;
const mockReview = markGamingFlagReviewed as jest.Mock;

const flag = {
  id: 'flag-1',
  user_id: 'user-1',
  created_at: '2026-07-01T00:00:00Z',
  metadata: { pattern: 'rapid_jump' },
};

describe('GamingFlags reason modal', () => {
  it('marks a flag reviewed via the modal with a note', async () => {
    mockFlags.mockResolvedValue({ flags: [flag], total: 1 });
    mockReview.mockResolvedValue({});

    await act(async () => { render(<GamingFlagsScreen />); });

    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());
    expect(screen.queryByTestId('reason-modal')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByText('Mark Reviewed')); });
    expect(screen.getByTestId('reason-modal')).toBeTruthy();

    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'legit streak'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() => expect(mockReview).toHaveBeenCalledWith('flag-1', 'legit streak'));
    // Row removed after success
    expect(screen.queryByText('Mark Reviewed')).toBeNull();
  });

  it('note is optional — submits with undefined when left blank', async () => {
    mockFlags.mockResolvedValue({ flags: [flag], total: 1 });
    mockReview.mockResolvedValue({});

    await act(async () => { render(<GamingFlagsScreen />); });
    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByText('Mark Reviewed')); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() => expect(mockReview).toHaveBeenCalledWith('flag-1', undefined));
  });

  it('double-tapping the modal confirm marks the flag reviewed exactly once', async () => {
    mockReview.mockClear();
    mockFlags.mockResolvedValue({ flags: [flag], total: 1 });
    mockReview.mockResolvedValue({});

    await act(async () => { render(<GamingFlagsScreen />); });
    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByText('Mark Reviewed')); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'note'); });

    // Fast double-tap before the modal closes.
    await act(async () => {
      const btn = screen.getByTestId('reason-confirm-btn');
      fireEvent.press(btn);
      fireEvent.press(btn);
    });

    await waitFor(() => expect(mockReview).toHaveBeenCalledTimes(1));
    expect(mockReview).toHaveBeenCalledWith('flag-1', 'note');
  });
});
