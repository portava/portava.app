/**
 * ReconcilerRunsScreen — run history list rendering.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Runs render newest-first (as returned by the API) with their count pills.
 * 2. A run with a fatal error shows the red "Fatal error" badge and the
 *    error message; successful runs do not show the badge.
 * 3. The empty state renders when there are no runs.
 * 4. A load failure surfaces the error message instead of a silent empty list.
 *
 * ## Why these tests exist
 *
 * The screen exists so admins can answer "did the reconciler run, and did it
 * succeed?" without curl-ing the API. If fatal-error runs were rendered like
 * successful ones, a broken reconciler would look healthy.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import ReconcilerRunsScreen from '../reconciler-runs';
import { getReconcilerRuns, triggerReconcilerRun } from '../../../../src/services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../../src/services/adminStamps', () => ({
  ...jest.requireActual('../../../../src/services/adminStamps'),
  getReconcilerRuns: jest.fn(),
  triggerReconcilerRun: jest.fn(),
}));

const mockGetRuns = getReconcilerRuns as jest.Mock;
const mockTrigger = triggerReconcilerRun as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const OK_RUN = {
  id: 'log-ok',
  runId: 'run-ok',
  ranAt: new Date('2026-07-20T10:00:00Z').toISOString(),
  resolved: 12,
  flagged: 3,
  skipped: 1,
  enqueued: 4,
  combos: 2,
  fatalError: null,
  ok: true,
};

const FATAL_RUN = {
  id: 'log-fatal',
  runId: 'run-fatal',
  ranAt: new Date('2026-07-19T09:00:00Z').toISOString(),
  resolved: 0,
  flagged: 0,
  skipped: 0,
  enqueued: 0,
  combos: 0,
  fatalError: 'db_error: connection refused',
  ok: false,
};

function runsOk(runs: unknown[]) {
  return { ok: true as const, data: { runs, total: runs.length } };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ReconcilerRunsScreen', () => {
  beforeEach(() => {
    mockGetRuns.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders runs with counts, flagging only fatal-error runs', async () => {
    mockGetRuns.mockResolvedValue(runsOk([OK_RUN, FATAL_RUN]));

    await render(<ReconcilerRunsScreen />);
    await screen.findByTestId('run-row-log-ok');

    // Both rows are present.
    expect(screen.getByTestId('run-row-log-fatal')).toBeTruthy();

    // Counts from the successful run.
    expect(screen.getByText('12')).toBeTruthy();

    // Exactly one fatal badge — the failed run's — plus its error message.
    expect(screen.getAllByTestId('run-fatal-badge')).toHaveLength(1);
    expect(screen.getByText('db_error: connection refused')).toBeTruthy();
  });

  it('shows the empty state when no runs are recorded', async () => {
    mockGetRuns.mockResolvedValue(runsOk([]));

    await render(<ReconcilerRunsScreen />);
    await screen.findByText('No reconciler runs recorded yet');
  });

  it('surfaces the API error message when loading fails', async () => {
    mockGetRuns.mockResolvedValue({ ok: false, error: 'Admin role required' });

    await render(<ReconcilerRunsScreen />);
    await screen.findByText('Admin role required');
  });

  it('Run now confirms, triggers the reconciler, and refreshes the list', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockGetRuns.mockResolvedValue(runsOk([OK_RUN]));
    mockTrigger.mockResolvedValue({
      ok: true,
      data: { ok: true, stats: { resolved: 1, flagged: 0, skipped: 0, enqueued: 0 } },
    });

    await render(<ReconcilerRunsScreen />);
    await screen.findByTestId('run-row-log-ok');

    fireEvent.press(screen.getByTestId('run-now-btn'));

    // Confirmation alert shown; nothing triggered yet.
    expect(alertSpy).toHaveBeenCalledWith(
      'Run reconciler now?',
      expect.any(String),
      expect.any(Array),
    );
    expect(mockTrigger).not.toHaveBeenCalled();

    // Press the confirm button of the alert (bare call, then waitFor — see
    // RNTL Alert act() guidance).
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.text === 'Run now')!.onPress!();

    await waitFor(() => expect(mockTrigger).toHaveBeenCalledTimes(1));
    // List refreshed after the run (initial load + post-run reload).
    await waitFor(() => expect(mockGetRuns).toHaveBeenCalledTimes(2));
    alertSpy.mockRestore();
  });

  it('surfaces a run failure in an alert and re-enables the button', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockGetRuns.mockResolvedValue(runsOk([]));
    mockTrigger.mockResolvedValue({ ok: false, error: 'db_error: boom' });

    await render(<ReconcilerRunsScreen />);
    await screen.findByText('No reconciler runs recorded yet');

    fireEvent.press(screen.getByTestId('run-now-btn'));
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.text === 'Run now')!.onPress!();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Error', 'db_error: boom'),
    );
    // Button re-enabled after the failed run.
    await waitFor(() =>
      expect(
        screen.getByTestId('run-now-btn').props.accessibilityState?.disabled,
      ).toBe(false),
    );
    alertSpy.mockRestore();
  });
});
