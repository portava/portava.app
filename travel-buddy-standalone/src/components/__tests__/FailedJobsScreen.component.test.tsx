/**
 * FailedJobsScreen — pull-to-refresh component tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. The initial load fetches failed jobs and displays them.
 * 2. Pull-to-refresh calls load() again and shows the updated job list.
 * 3. The refreshing spinner clears once load() resolves (setRefreshing(false)
 *    was called — a missing call would leave the spinner spinning forever).
 *
 * ## Why these tests exist
 *
 * A stale-closure bug or a missing setRefreshing(false) call in onRefresh
 * would be invisible at runtime until an admin noticed the spinner was stuck
 * or the job list was never updated after a refresh.  These tests make both
 * failure modes explicit.
 *
 * ## How pull-to-refresh is simulated
 *
 * The FlatList is found by testID ("failed-jobs-list") and its
 * refreshControl.props.onRefresh() is invoked directly inside act() — the
 * same pattern used by the StampStudioIndex pull-to-refresh suite.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import FailedJobsScreen from '../../../app/admin/stamps/failed.tsx';
import { getAdminStampQueue, requeueFailedJob } from '../../services/adminStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin.ts', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps.ts', () => ({
  getAdminStampQueue: jest.fn(),
  requeueFailedJob: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null,
  RefreshCw: () => null,
  TriangleAlert: () => null,
  XCircle: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetQueue  = getAdminStampQueue as jest.Mock;
const mockRequeue   = requeueFailedJob  as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function queueOk(jobs: Array<{
  id: string;
  catalog_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  updated_at: string;
  universal_stamp_catalog?: { display_name: string; stamp_type: string; country_code: string } | null;
}>) {
  return { ok: true as const, data: { jobs } };
}

const JOB_A = {
  id: 'job-1',
  catalog_id: 'cat-1',
  status: 'retryable_failed',
  attempts: 3,
  max_attempts: 5,
  last_error: 'timeout: image generation exceeded 30s',
  updated_at: new Date('2026-07-16T10:00:00Z').toISOString(),
  universal_stamp_catalog: { display_name: 'Paris Eiffel', stamp_type: 'landmark', country_code: 'FR' },
};

const JOB_B = {
  id: 'job-2',
  catalog_id: 'cat-2',
  status: 'permanently_failed',
  attempts: 5,
  max_attempts: 5,
  last_error: 'candidate_shortfall: no valid images returned',
  updated_at: new Date('2026-07-16T11:00:00Z').toISOString(),
  universal_stamp_catalog: { display_name: 'Tokyo Tower', stamp_type: 'landmark', country_code: 'JP' },
};

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('FailedJobsScreen — pull-to-refresh', () => {
  beforeEach(() => {
    mockGetQueue
      .mockResolvedValueOnce(queueOk([JOB_A]))           // initial load
      .mockResolvedValue(queueOk([JOB_A, JOB_B]));       // subsequent calls
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the initial job from the first fetch', async () => {
    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
  });

  it('calls getAdminStampQueue again when the user pulls to refresh', async () => {
    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const callsBefore = mockGetQueue.mock.calls.length;

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    expect(mockGetQueue.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('shows the updated job list after pull-to-refresh completes', async () => {
    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    await waitFor(() => screen.getByText('Tokyo Tower'));
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();  // new job visible
    expect(screen.getByText('Paris Eiffel')).toBeTruthy(); // existing job still present
  });

  it('clears the refreshing spinner once load() resolves', async () => {
    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    // Wait for the new job to appear — load() has fully resolved by this point.
    await waitFor(() => screen.getByText('Tokyo Tower'));

    // Re-query to read the settled refreshing prop.
    const updated = screen.getByTestId('failed-jobs-list');
    expect(updated.props.refreshControl.props.refreshing).toBe(false);
  });

  it('clears the refreshing spinner even when the api returns no jobs', async () => {
    // Override second call to return an empty list (e.g. all jobs were cleared elsewhere).
    mockGetQueue
      .mockReset()
      .mockResolvedValueOnce(queueOk([JOB_A]))
      .mockResolvedValueOnce(queueOk([]));

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    // The spinner must clear regardless of whether the result set is empty.
    await waitFor(() => {
      const updated = screen.getByTestId('failed-jobs-list');
      expect(updated.props.refreshControl.props.refreshing).toBe(false);
    });
  });
});

// ── Re-queue flow ───────────────────────────────────────────────────────────────

/**
 * ## What's covered
 *
 * 1. Pressing "Re-queue" opens the confirmation Alert and passes the correct
 *    job id to requeueFailedJob.
 * 2. On a successful API response the job row is removed from the list.
 * 3. On a failed API response the job row stays and an error Alert is shown.
 *
 * ## How Alert interactions are tested
 *
 * React Native's Alert.alert is mocked via jest.spyOn.  The spy captures the
 * button array, and the helper `pressAlertButton` finds the button by label
 * and invokes its onPress handler synchronously inside act() — the same
 * technique used by other admin-screen component tests in this project.
 */

/** Invoke the first Alert button whose `text` matches `label`. */
async function pressAlertButton(alertSpy: jest.SpyInstance, label: string) {
  const calls = alertSpy.mock.calls;
  if (calls.length === 0) throw new Error('Alert.alert was never called');
  const buttons: Array<{ text: string; onPress?: () => void | Promise<void> }> =
    calls[calls.length - 1][2];
  const btn = buttons.find((b) => b.text === label);
  if (!btn) throw new Error(`No Alert button labelled "${label}"`);
  await act(async () => { await btn.onPress?.(); });
}

describe('FailedJobsScreen — re-queue flow', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    // Full reset — clears queued mockResolvedValueOnce values AND implementations
    // left over from the pull-to-refresh suite above, preventing state leakage.
    mockGetQueue.mockReset();
    mockRequeue.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert');
    // Default: initial load returns both jobs so there's always something to act on.
    mockGetQueue.mockResolvedValue(queueOk([JOB_A, JOB_B]));
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('calls requeueFailedJob with the correct job id when the admin confirms', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: true });

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    // Press the Re-queue button for JOB_A.
    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);

    // Confirm in the Alert dialog.
    await pressAlertButton(alertSpy, 'Re-queue');

    expect(mockRequeue).toHaveBeenCalledTimes(1);
    expect(mockRequeue).toHaveBeenCalledWith(JOB_A.id);
  });

  it('removes the job row from the list after a successful re-queue', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: true });

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    // Both jobs should be visible before the action.
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();

    // Re-queue JOB_A (first button = first job row).
    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // JOB_A must be gone; JOB_B must still be present.
    await waitFor(() => expect(screen.queryByText('Paris Eiffel')).toBeNull());
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();
  });

  it('keeps the job row in the list when the re-queue API call fails', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: false, error: 'DB write failed' });

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // Job must still be in the list after the failed API call.
    await waitFor(() => expect(screen.getByText('Paris Eiffel')).toBeTruthy());
  });

  it('shows an error Alert when the re-queue API call fails', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: false, error: 'DB write failed' });

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // Wait for the error Alert to be shown (second Alert call after the confirmation one).
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    const errorCall = alertSpy.mock.calls[1];
    expect(errorCall[0]).toBe('Error');
    expect(errorCall[1]).toBe('DB write failed');
  });
});
