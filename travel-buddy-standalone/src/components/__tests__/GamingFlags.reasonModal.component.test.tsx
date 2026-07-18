/**
 * GamingFlags — cross-platform note modal test.
 *
 * The "Mark Reviewed" flow used iOS-only Alert.prompt (a silent no-op on
 * Android/web). It now uses ReasonPromptModal with an OPTIONAL note. This
 * test pins that the modal opens, submits with an empty note (note is
 * optional here), and passes a typed note through to the service.
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

/** Defer mock resolution to the next macrotask so continuations fire outside act(). */
const deferred = <T>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

const flag = {
  id: 'flag-1',
  user_id: 'user-1',
  created_at: '2026-07-01T00:00:00Z',
  metadata: { pattern: 'rapid_jump' },
};

describe('GamingFlags reason modal', () => {
  it('marks a flag reviewed via the modal with a note', async () => {
    mockFlags.mockImplementation(() => deferred({ flags: [flag], total: 1 }));
    mockReview.mockImplementation(() => deferred({}));

    await render(<GamingFlagsScreen />);
    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());
    expect(screen.queryByTestId('reason-modal')).toBeNull();

    // Bare press — sync setState; waitFor below confirms modal appears.
    fireEvent.press(screen.getByText('Mark Reviewed'));
    await waitFor(() => expect(screen.getByTestId('reason-modal')).toBeTruthy());

    // Bare changeText — sync setState; waitFor confirms note committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'legit streak');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('legit streak'),
    );

    // Bare press — async submit handler; waitFor below flushes the async chain.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    await waitFor(() => {
      expect(mockReview).toHaveBeenCalledWith('flag-1', 'legit streak');
      // Row removed after success
      expect(screen.queryByText('Mark Reviewed')).toBeNull();
    });
  });

  it('note is optional — submits with undefined when left blank', async () => {
    mockFlags.mockImplementation(() => deferred({ flags: [flag], total: 1 }));
    mockReview.mockImplementation(() => deferred({}));

    await render(<GamingFlagsScreen />);
    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());

    // Bare press — sync setState; waitFor confirms modal appears.
    fireEvent.press(screen.getByText('Mark Reviewed'));
    await waitFor(() => expect(screen.getByTestId('reason-confirm-btn')).toBeTruthy());

    // Bare press — async submit handler; waitFor flushes the async chain.
    fireEvent.press(screen.getByTestId('reason-confirm-btn'));
    await waitFor(() => expect(mockReview).toHaveBeenCalledWith('flag-1', undefined));
  });

  it('double-tapping the modal confirm marks the flag reviewed exactly once', async () => {
    mockReview.mockClear();
    mockFlags.mockImplementation(() => deferred({ flags: [flag], total: 1 }));
    mockReview.mockImplementation(() => deferred({}));

    await render(<GamingFlagsScreen />);
    await waitFor(() => expect(screen.getByText('Mark Reviewed')).toBeTruthy());

    // Bare press — sync setState; waitFor confirms modal appears.
    fireEvent.press(screen.getByText('Mark Reviewed'));
    await waitFor(() => expect(screen.getByTestId('reason-input')).toBeTruthy());

    // Bare changeText — sync setState; waitFor confirms note committed.
    fireEvent.changeText(screen.getByTestId('reason-input'), 'note');
    await waitFor(() =>
      expect(screen.getByTestId('reason-input').props.value).toBe('note'),
    );

    // Fast double-tap before the modal closes — both presses are bare so the
    // in-flight guard (submittingRef) sees the first press before any re-render.
    const btn = screen.getByTestId('reason-confirm-btn');
    fireEvent.press(btn);
    fireEvent.press(btn);

    await waitFor(() => expect(mockReview).toHaveBeenCalledTimes(1));
    expect(mockReview).toHaveBeenCalledWith('flag-1', 'note');
  });
});
