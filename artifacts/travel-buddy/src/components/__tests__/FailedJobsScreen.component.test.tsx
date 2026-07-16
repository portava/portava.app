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
import { render, act, waitFor, screen } from '@testing-library/react-native';
import FailedJobsScreen from '../../../app/admin/stamps/failed';
import { getAdminStampQueue } from '../../services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps', () => ({
  getAdminStampQueue: jest.fn(),
  requeueFailedJob: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null,
  RefreshCw: () => null,
  XCircle: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetQueue = getAdminStampQueue as jest.Mock;

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
