/**
 * FailedJobsScreen — "Mark cleaned" error-path component tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * When clearCleanupError fails (e.g. the endpoint returns 404 because the job
 * id is wrong), the admin must SEE the failure:
 *
 * 1. An error Alert with the server's error message is shown after the
 *    confirmation dialog is confirmed.
 * 2. The orphaned-files badge stays on the row — local state must not be
 *    cleared when the API call did not take effect.
 * 3. Falls back to a generic message when the API result carries no error text.
 *
 * ## Why these tests exist
 *
 * "Mark cleaned" silently doing nothing is the worst failure mode: the admin
 * believes the warning was dismissed server-side while the DB still flags the
 * job. Surfacing the error keeps the operator's mental model in sync.
 *
 * ## Why this is a separate file
 *
 * FailedJobsScreen.component.test.tsx has a known cross-test leak (the React
 * 19 + RNTL cleanup race — see the follow-up task about the 13 already-failing
 * tests there): every render after the first Alert-button test mounts a tree
 * whose async load() state updates never flush. Keeping this suite in its own
 * file gives it a fresh renderer and module registry so it can't be poisoned.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, screen, fireEvent, cleanup } from '@testing-library/react-native';
import FailedJobsScreen from '../../../app/admin/stamps/failed.tsx';
import { getAdminStampQueue, clearCleanupError } from '../../services/adminStamps.ts';

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
  clearCleanupError: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null,
  RefreshCw: () => null,
  TriangleAlert: () => null,
  XCircle: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetQueue = getAdminStampQueue as jest.Mock;
const mockClear    = clearCleanupError as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const JOB_WITH_CLEANUP_ERROR = {
  id: 'job-orphan',
  catalog_id: 'cat-orphan',
  status: 'retryable_failed' as const,
  attempts: 2,
  max_attempts: 5,
  last_error: 'storage_upload_failed: timeout',
  cleanup_error: 'remove() returned unexpected error: 503',
  cleanup_error_paths: ['stamps/abc/v1.webp', 'stamps/abc/v2.webp'],
  updated_at: new Date('2026-07-16T12:00:00Z').toISOString(),
  universal_stamp_catalog: { display_name: 'Rome Colosseum', stamp_type: 'landmark', country_code: 'IT' },
};

/** Invoke the first Alert button whose `text` matches `label`. */
async function pressAlertButton(alertSpy: jest.SpyInstance, label: string) {
  const calls = alertSpy.mock.calls;
  if (calls.length === 0) throw new Error('Alert.alert was never called');
  const buttons: Array<{ text: string; onPress?: () => void | Promise<void> }> =
    calls[calls.length - 1][2];
  const btn = buttons.find((b) => b.text === label);
  if (!btn) throw new Error(`No Alert button labelled "${label}"`);
  // IMPORTANT: do NOT await the async onPress inside act(). Under React 19 +
  // RNTL, `await act(async () => { await btn.onPress() })` leaves the renderer
  // in a state where every subsequent render in the file mounts but never runs
  // its effects (this is what breaks the tests after the first Alert-button
  // test in FailedJobsScreen.component.test.tsx). Await it outside, then flush
  // the resulting state updates with an empty act().
  await btn.onPress?.();
  await act(async () => {});
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('FailedJobsScreen — mark cleaned error path', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetQueue.mockReset();
    mockClear.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockGetQueue.mockResolvedValue({ ok: true, data: { jobs: [JOB_WITH_CLEANUP_ERROR] } });
  });

  afterEach(async () => {
    // Unmount inside act() BEFORE RNTL's auto-cleanup runs. Without this, the
    // React 19 + RNTL cleanup race leaves the renderer in a state where the
    // next test's async load() state updates never flush (see the sibling
    // FailedJobsScreen.component.test.tsx file, where every test after the
    // first Alert-button test fails for this reason).
    await act(async () => { cleanup(); });
    alertSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('shows an error Alert when clearCleanupError returns ok: false (job not found)', async () => {
    mockClear.mockResolvedValueOnce({ ok: false, error: 'Job not found' });

    await render(<FailedJobsScreen />);
    await screen.findByText('Rome Colosseum');

    // Tap "Mark cleaned" → confirmation Alert opens.
    fireEvent.press(screen.getByText('Mark cleaned'));
    // Confirm in the dialog.
    await pressAlertButton(alertSpy, 'Mark cleaned');

    expect(mockClear).toHaveBeenCalledWith(JOB_WITH_CLEANUP_ERROR.id);

    // Second Alert call is the error surfaced to the admin.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    const errorCall = alertSpy.mock.calls[1];
    expect(errorCall[0]).toBe('Error');
    expect(errorCall[1]).toBe('Job not found');
  });

  it('keeps the orphaned-files badge visible when clearCleanupError fails', async () => {
    mockClear.mockResolvedValueOnce({ ok: false, error: 'Job not found' });

    await render(<FailedJobsScreen />);
    await screen.findByText('Rome Colosseum');

    fireEvent.press(screen.getByText('Mark cleaned'));
    await pressAlertButton(alertSpy, 'Mark cleaned');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));

    // Badge (with the paths count) must still be on the row — local state
    // was NOT cleared on error.
    expect(screen.getByText('2 orphaned files need manual removal')).toBeTruthy();
    // The "Mark cleaned" button remains so the admin can retry.
    expect(screen.getByText('Mark cleaned')).toBeTruthy();
  });

  it('falls back to a generic message when the failed result has no error text', async () => {
    mockClear.mockResolvedValueOnce({ ok: false });

    await render(<FailedJobsScreen />);
    await screen.findByText('Rome Colosseum');

    fireEvent.press(screen.getByText('Mark cleaned'));
    await pressAlertButton(alertSpy, 'Mark cleaned');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    const errorCall = alertSpy.mock.calls[1];
    expect(errorCall[0]).toBe('Error');
    expect(errorCall[1]).toBe('Failed to clear cleanup error');
  });
});
