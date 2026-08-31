/**
 * Compass Memory screen (app/compass-memory.tsx) — Memory + Experience
 * Intelligence management (§17).
 *
 * Covers:
 *   - view: projected memories render with their feedback controls
 *   - empty: graceful "no memories yet" copy, never an error
 *   - error: soft message + working retry
 *   - feedback: a kind is POSTed with the projection id and the row leaves
 *   - export: pulls the export and hands it to the OS share sheet
 *   - reset: confirmed via a destructive Alert, then clears the list
 *
 * The service is fully mocked, so no network / auth is involved.
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert, Share } from 'react-native';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react-native';

afterEach(cleanup);

const mockFetchProjectedMemories = jest.fn();
const mockPostMemoryFeedback = jest.fn();
const mockFetchMemoryExport = jest.fn();
const mockPostMemoryReset = jest.fn();

jest.mock('../../src/services/compass', () => ({
  ...jest.requireActual('../../src/services/compass'),
  fetchProjectedMemories: (...a: unknown[]) => mockFetchProjectedMemories(...a),
  postMemoryFeedback: (...a: unknown[]) => mockPostMemoryFeedback(...a),
  fetchMemoryExport: (...a: unknown[]) => mockFetchMemoryExport(...a),
  postMemoryReset: (...a: unknown[]) => mockPostMemoryReset(...a),
}));

// NOTE: intentional stub — the bottom-inset filler reads safe-area insets, which
// have no provider under jest; zeroed insets are all this screen needs.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import CompassMemoryScreen from '../compass-memory.tsx';

const MEMORIES = [
  { id: 'p1', memory_type: 'place', subject_type: 'place', subject_id: 'x', content: 'You favour quiet cafes', confidence: 0.8, last_supported_at: null, valid_from: null },
  { id: 'p2', memory_type: 'social', subject_type: 'user', subject_id: 'u2', content: 'You know Marta in Lisbon', confidence: 0.6, last_supported_at: null, valid_from: null },
];

describe('CompassMemoryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProjectedMemories.mockResolvedValue({ ok: true, data: MEMORIES });
    mockPostMemoryFeedback.mockResolvedValue({ ok: true });
    mockFetchMemoryExport.mockResolvedValue({ ok: true, data: MEMORIES });
    mockPostMemoryReset.mockResolvedValue({ ok: true, data: { reset: true, projectionsCleared: 2, eventsCleared: 5, feedbackKept: 1 } });
  });

  it('renders projected memories with their feedback controls', async () => {
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());

    expect(screen.getByText('You favour quiet cafes')).toBeTruthy();
    expect(screen.getByText('You know Marta in Lisbon')).toBeTruthy();
    // All five feedback affordances present on a card
    for (const kind of ['hide', 'not_interested', 'already_known', 'incorrect', 'forget']) {
      expect(screen.getByTestId(`memory-p1-${kind}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('memory-empty')).toBeNull();
    expect(screen.queryByTestId('memory-error')).toBeNull();
  });

  it('shows a graceful empty state, not an error, when nothing is derived', async () => {
    mockFetchProjectedMemories.mockResolvedValue({ ok: true, data: [] });
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-empty')).toBeTruthy());
    expect(screen.getByText(/No memories yet/i)).toBeTruthy();
    expect(screen.queryByTestId('memory-error')).toBeNull();
  });

  it('shows a retry-able error and reloads when tapped', async () => {
    mockFetchProjectedMemories.mockResolvedValueOnce({ ok: false, error: 'network_error' });
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-error')).toBeTruthy());

    mockFetchProjectedMemories.mockResolvedValueOnce({ ok: true, data: MEMORIES });
    fireEvent.press(screen.getByTestId('memory-retry'));
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());
    expect(mockFetchProjectedMemories).toHaveBeenCalledTimes(2);
  });

  it('posts feedback with the projection id and drops the row', async () => {
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('memory-p1-hide'));
    await waitFor(() => expect(screen.queryByTestId('memory-p1')).toBeNull());
    expect(mockPostMemoryFeedback).toHaveBeenCalledWith({ kind: 'hide', projectionId: 'p1' });
    // Other memory untouched
    expect(screen.getByTestId('memory-p2')).toBeTruthy();
  });

  it('restores the row and warns if feedback fails to record', async () => {
    mockPostMemoryFeedback.mockResolvedValueOnce({ ok: false, error: 'network_error' });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('memory-p1-forget'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // Row comes back since nothing was recorded
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());
    alertSpy.mockRestore();
  });

  it('exports derived data through the share sheet', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('memory-export'));
    await waitFor(() => expect(mockFetchMemoryExport).toHaveBeenCalled());
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const arg = shareSpy.mock.calls[0][0] as { message: string };
    expect(arg.message).toContain('You favour quiet cafes');
    shareSpy.mockRestore();
  });

  it('resets personalization only after the destructive confirm', async () => {
    let confirmButtons: Array<{ text?: string; style?: string; onPress?: () => void }> = [];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      confirmButtons = (buttons ?? []) as typeof confirmButtons;
    });
    render(<CompassMemoryScreen />);
    await waitFor(() => expect(screen.getByTestId('memory-p1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('memory-reset'));
    expect(alertSpy).toHaveBeenCalled();
    // Nothing cleared until the user confirms
    expect(mockPostMemoryReset).not.toHaveBeenCalled();

    const confirm = confirmButtons.find((b) => b.style === 'destructive');
    expect(confirm).toBeTruthy();
    confirm!.onPress?.();

    await waitFor(() => expect(mockPostMemoryReset).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('memory-p1')).toBeNull());
    expect(screen.getByTestId('memory-notice')).toBeTruthy();
    alertSpy.mockRestore();
  });
});
