/**
 * FailedJobsScreen — "Mark cleaned" optimistic badge dismissal.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Tapping "Mark cleaned" and confirming calls clearCleanupError with the
 *    job id.
 * 2. On success, the cleanup_error warning badge disappears immediately —
 *    without any refetch (getAdminStampQueue is NOT called again).
 * 3. The job row itself stays in the list (unlike Re-queue, which removes it),
 *    so the operator can still re-queue the job.
 * 4. On API failure the badge stays and an error Alert is shown.
 *
 * ## Why these tests exist
 *
 * The screen optimistically patches local state (cleanup_error → null) after
 * a successful clearCleanupError call. If that state update were dropped, the
 * badge would linger until a manual pull-to-refresh, misleading ops into
 * thinking the orphan files still need removal. If the row were accidentally
 * filtered out (copy-paste from the Re-queue handler), the job would vanish
 * and could no longer be re-queued from the UI.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import FailedJobsScreen from '../failed';
import {
  getAdminStampQueue,
  requeueFailedJob,
  clearCleanupError,
} from '../../../../src/services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../../src/hooks/useRequireAdmin', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../../src/services/adminStamps', () => ({
  getAdminStampQueue: jest.fn(),
  requeueFailedJob: jest.fn(),
  clearCleanupError: jest.fn(),
}));

const mockGetQueue = getAdminStampQueue as jest.Mock;
const mockRequeue  = requeueFailedJob  as jest.Mock;
const mockClear    = clearCleanupError as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BADGE_TEXT = '2 orphaned files need manual removal';

const JOB_WITH_CLEANUP_ERROR = {
  id: 'job-orphan',
  catalog_id: 'cat-orphan',
  status: 'retryable_failed',
  attempts: 2,
  max_attempts: 5,
  last_error: 'storage_upload_failed: timeout',
  cleanup_error: 'remove() returned unexpected error: 503',
  cleanup_error_paths: ['stamps/abc/v1.webp', 'stamps/abc/v2.webp'],
  updated_at: new Date('2026-07-16T12:00:00Z').toISOString(),
  universal_stamp_catalog: { display_name: 'Rome Colosseum', stamp_type: 'landmark', country_code: 'IT' },
};

function queueOk(jobs: unknown[]) {
  return { ok: true as const, data: { jobs } };
}

/**
 * Invoke the first Alert button whose `text` matches `label`.
 *
 * Note: the handler is fired WITHOUT wrapping it in `act()`. Wrapping the
 * async onPress in an awaited act() creates overlapping act scopes with the
 * FlatList's internal timers, which corrupts React's act environment and
 * makes every later render in the file time out. Callers assert the outcome
 * with `waitFor`, which flushes the resulting state updates safely.
 */
function pressAlertButton(alertSpy: jest.SpyInstance, label: string) {
  const calls = alertSpy.mock.calls;
  if (calls.length === 0) throw new Error('Alert.alert was never called');
  const buttons: Array<{ text: string; onPress?: () => void | Promise<void> }> =
    calls[calls.length - 1][2];
  const btn = buttons.find((b) => b.text === label);
  if (!btn) throw new Error(`No Alert button labelled "${label}"`);
  btn.onPress?.();
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('FailedJobsScreen — Mark cleaned badge dismissal', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetQueue.mockReset();
    mockRequeue.mockReset();
    mockClear.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert');
    mockGetQueue.mockResolvedValue(queueOk([JOB_WITH_CLEANUP_ERROR]));
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('calls clearCleanupError with the job id when the admin confirms', async () => {
    mockClear.mockResolvedValueOnce({ ok: true });

    await render(<FailedJobsScreen />);
    await screen.findByText(BADGE_TEXT);

    fireEvent.press(screen.getByText('Mark cleaned'));
    pressAlertButton(alertSpy, 'Mark cleaned');

    await waitFor(() => expect(mockClear).toHaveBeenCalledTimes(1));
    expect(mockClear).toHaveBeenCalledWith(JOB_WITH_CLEANUP_ERROR.id);
    // Let the success state update flush before the test ends.
    await waitFor(() => expect(screen.queryByText('Mark cleaned')).toBeNull());
  });

  it('removes the warning badge immediately on success while keeping the job row', async () => {
    mockClear.mockResolvedValueOnce({ ok: true });

    await render(<FailedJobsScreen />);
    await screen.findByText(BADGE_TEXT);

    // Only the initial load should have hit the queue endpoint.
    const queueCallsBefore = mockGetQueue.mock.calls.length;

    fireEvent.press(screen.getByText('Mark cleaned'));
    pressAlertButton(alertSpy, 'Mark cleaned');

    // Badge (and the orphaned-path / error detail lines) must be gone at once.
    await waitFor(() => expect(screen.queryByText(BADGE_TEXT)).toBeNull());
    expect(screen.queryByText(/stamps\/abc\/v1\.webp/)).toBeNull();
    expect(screen.queryByText(JOB_WITH_CLEANUP_ERROR.cleanup_error)).toBeNull();
    expect(screen.queryByText('Mark cleaned')).toBeNull();

    // The row itself must remain — the job is still failed and re-queueable.
    expect(screen.getByText('Rome Colosseum')).toBeTruthy();
    expect(screen.getByText('Re-queue')).toBeTruthy();

    // No refetch happened — the badge removal was purely optimistic local state.
    expect(mockGetQueue.mock.calls.length).toBe(queueCallsBefore);
  });

  it('keeps the badge and shows an error Alert when clearCleanupError fails', async () => {
    mockClear.mockResolvedValueOnce({ ok: false, error: 'DB write failed' });

    await render(<FailedJobsScreen />);
    await screen.findByText(BADGE_TEXT);

    fireEvent.press(screen.getByText('Mark cleaned'));
    pressAlertButton(alertSpy, 'Mark cleaned');

    // Confirmation Alert + error Alert.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    const errorCall = alertSpy.mock.calls[1];
    expect(errorCall[0]).toBe('Error');
    expect(errorCall[1]).toBe('DB write failed');

    // Badge and row are still there.
    expect(screen.getByText(BADGE_TEXT)).toBeTruthy();
    expect(screen.getByText('Rome Colosseum')).toBeTruthy();
  });
});


describe('FailedJobsScreen — cleanup warning badge is announced to screen readers', () => {
  beforeEach(() => {
    mockGetQueue.mockReset();
    mockGetQueue.mockResolvedValue(queueOk([JOB_WITH_CLEANUP_ERROR]));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the cleanup badge via alert role and assertive live region', async () => {
    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByTestId('row-cleanup-badge'));

    const badge = screen.getByTestId('row-cleanup-badge');
    // Without these props, TalkBack/VoiceOver never announces a dynamically
    // appearing cleanup warning — a screen-reader admin would miss it.
    expect(badge.props.accessibilityRole).toBe('alert');
    expect(badge.props.accessibilityLiveRegion).toBe('assertive');
  });
});
