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
import { Alert, Pressable } from 'react-native';
import { render, act, waitFor, screen, fireEvent, cleanup } from '@testing-library/react-native';
import FailedJobsScreen from '../../../app/admin/stamps/failed.tsx';
import { getAdminStampQueue, requeueFailedJob } from '../../services/adminStamps.ts';

// IS_REACT_ACT_ENVIRONMENT is set globally by src/jest.setup.ts — see
// src/components/__tests__/TESTING.md. No per-file assignment is needed.

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
  cleanup_error?: string | null;
  cleanup_error_paths?: string[] | null;
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
  cleanup_error: null,
  cleanup_error_paths: null,
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
  cleanup_error: null,
  cleanup_error_paths: null,
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
    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
  });

  it('calls getAdminStampQueue again when the user pulls to refresh', async () => {
    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    const callsBefore = mockGetQueue.mock.calls.length;

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    expect(mockGetQueue.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('shows the updated job list after pull-to-refresh completes', async () => {
    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    await waitFor(() => screen.getByText('Tokyo Tower'));
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();  // new job visible
    expect(screen.getByText('Paris Eiffel')).toBeTruthy(); // existing job still present
  });

  it('clears the refreshing spinner once load() resolves', async () => {
    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

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

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

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

/**
 * Invoke the first Alert button whose `text` matches `label`.
 *
 * ## Why btn.onPress is called WITHOUT any act() wrapper
 *
 * RNTL's `act(callback)` always wraps as `async () => await callback()`.
 * Because an async function always returns a Promise (a thenable), RNTL's
 * `withGlobalActEnvironment` always takes the async path and defers
 * `setIsReactActEnvironment(previousActEnvironment)` to a floating thenable
 * that resolves asynchronously.  Any microtasks that fire before that thenable
 * resolves run with IS_REACT_ACT_ENVIRONMENT still true; but microtasks that
 * fire AFTER the thenable resolves (e.g. during RNTL's flushMicroTasks in the
 * next afterEach) see IS_REACT_ACT_ENVIRONMENT restored to whatever it was
 * before act() was called — which may be `undefined` if an earlier act() had
 * already restored it.  This produces "not configured to support act()"
 * warnings and, worse, "overlapping act()" errors during RNTL's cleanup that
 * corrupt actScopeDepth for all subsequent tests.
 *
 * The fix mirrors how `fireEvent` works internally: call the handler directly,
 * outside any act() scope.  With IS_REACT_ACT_ENVIRONMENT = true set globally
 * at module level (above), React routes all state updates to the act queue and
 * suppresses "not configured" warnings.  The subsequent waitFor() in each test
 * drains the act queue safely within its own act() scope.  No floating
 * thenables, no restore races, no overlapping act() errors.
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

describe('FailedJobsScreen — re-queue flow', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    // Tear down any leftover renders first so leaked async effects from the
    // previous test don't call into the freshly-reset mock state.
    cleanup();
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

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    // Press the Re-queue button for JOB_A.
    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);

    // Confirm in the Alert dialog.
    await pressAlertButton(alertSpy, 'Re-queue');

    expect(mockRequeue).toHaveBeenCalledTimes(1);
    expect(mockRequeue).toHaveBeenCalledWith(JOB_A.id);

    // Wait for the component's async continuation (setBusyId(null) + setJobs)
    // to commit before the test ends.  Without this, those state updates fire
    // outside act() during RNTL's afterEach flushMicroTasks, producing
    // "overlapping act()" errors that corrupt subsequent test contexts.
    await waitFor(() => expect(screen.queryByText('Paris Eiffel')).toBeNull());
  });

  it('removes the job row from the list after a successful re-queue', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: true });

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

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

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // Job must still be in the list after the failed API call.
    await waitFor(() => expect(screen.getByText('Paris Eiffel')).toBeTruthy());
    // Also wait for setBusyId(null) to commit — the Re-queue buttons return to
    // their enabled state once busyId is cleared.  Without this, the uncommitted
    // fiber update fires outside act() during afterEach and corrupts test 4.
    await waitFor(() => expect(screen.getAllByText('Re-queue')).toHaveLength(2));
  });

  it('shows an error Alert when the re-queue API call fails', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: false, error: 'DB write failed' });

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // Wait for the error Alert to be shown (second Alert call after the confirmation one).
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    const errorCall = alertSpy.mock.calls[1];
    expect(errorCall[0]).toBe('Error');
    expect(errorCall[1]).toBe('DB write failed');
    // Wait for setBusyId(null) to commit — Re-queue buttons return to enabled.
    // Without this, the uncommitted fiber update fires outside act() during
    // afterEach and corrupts test 5.
    await waitFor(() => expect(screen.getAllByText('Re-queue')).toHaveLength(2));
  });

  it('decreases the header count badge from 2 to 1 after a successful re-queue', async () => {
    mockRequeue.mockResolvedValueOnce({ ok: true });

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    // Both jobs are loaded — the count badge should show 2.
    expect(screen.getByText('2')).toBeTruthy();

    // Re-queue JOB_A (first Re-queue button = first job row).
    const buttons = screen.getAllByText('Re-queue');
    fireEvent.press(buttons[0]);
    await pressAlertButton(alertSpy, 'Re-queue');

    // JOB_A is removed from state; count badge must now read 1.
    await waitFor(() => expect(screen.queryByText('Paris Eiffel')).toBeNull());
    expect(screen.getByText('1')).toBeTruthy();
    // Sanity-check: "2" must no longer appear as the badge value.
    expect(screen.queryByText('2')).toBeNull();
  });

  /**
   * In-flight disabled state
   *
   * The screen sets `busyId` to the job id before awaiting `requeueFailedJob`,
   * then clears it afterwards.  The Pressable receives `disabled={busyId === item.id}`.
   * A deferred promise keeps the API call suspended so we can assert the disabled
   * state before the call resolves.
   *
   * Two assertions cover the spec:
   *  1. While in flight — the Pressable for JOB_A has `disabled={true}` and its
   *     "Re-queue" label is replaced by an ActivityIndicator (only JOB_B's label
   *     remains visible).
   *  2. After resolution — the row is removed from the list (successful re-queue),
   *     so the button is gone entirely and JOB_B's Pressable is not disabled.
   */
  it('disables the Re-queue button for the in-flight job while requeueFailedJob is pending', async () => {
    // Deferred promise — keeps the API call suspended until we explicitly resolve it.
    let resolveRequeue!: (value: { ok: true }) => void;
    const requeuePromise = new Promise<{ ok: true }>((resolve) => {
      resolveRequeue = resolve;
    });
    mockRequeue.mockReturnValueOnce(requeuePromise);

    await render(<FailedJobsScreen />);
    await screen.findByText('Paris Eiffel');

    // Both jobs are visible and both Re-queue buttons are enabled before any action.
    expect(screen.getAllByText('Re-queue')).toHaveLength(2);

    // Open the confirmation Alert for JOB_A (first button).
    fireEvent.press(screen.getAllByText('Re-queue')[0]);

    // Retrieve the Alert confirmation button and start its onPress without any
    // act() wrapper — same pattern as pressAlertButton() — so IS_REACT_ACT_ENVIRONMENT
    // is not saved/restored by a floating thenable during RNTL cleanup.
    const alertCalls = alertSpy.mock.calls;
    const alertButtons: Array<{ text: string; onPress?: () => void | Promise<void> }> =
      alertCalls[alertCalls.length - 1][2];
    const confirmBtn = alertButtons.find((b) => b.text === 'Re-queue')!;

    // Direct call: setBusyId(job.id) fires synchronously, goes to the act queue
    // (IS_REACT_ACT_ENVIRONMENT = true globally), and is committed by the next waitFor.
    confirmBtn.onPress?.();

    // ── In-flight assertion ────────────────────────────────────────────────────
    // JOB_A's Pressable now has disabled={true}.  The label is replaced by an
    // ActivityIndicator, so only JOB_B's "Re-queue" text remains in the tree.
    // The text count is the observable proxy for the disabled state — if
    // busyId were not set, both labels would still be visible.
    await waitFor(() => {
      expect(screen.getAllByText('Re-queue')).toHaveLength(1);
    });

    // ── Post-resolution assertion ──────────────────────────────────────────────
    // Resolve the deferred promise without an act() wrapper — the onPress
    // continuation (setBusyId(null) + setJobs(filter)) fires as a microtask that
    // the subsequent waitFor drains safely within its own act() scope.
    resolveRequeue({ ok: true });

    // JOB_A's row (and its now-resolved button) must be gone.
    await waitFor(() => expect(screen.queryByText('Paris Eiffel')).toBeNull());

    // JOB_B's Re-queue button must still be present (busyId was cleared to null).
    expect(screen.getAllByText('Re-queue')).toHaveLength(1);
  });
});

// ── Orphaned-files badge ────────────────────────────────────────────────────────

/**
 * ## What's covered
 *
 * 1. A job with cleanup_error set renders the "Orphaned storage files" badge.
 * 2. A job with cleanup_error: null does not render the badge.
 * 3. After a successful requeue the job row is removed, so the badge disappears.
 *
 * ## Why these tests exist
 *
 * The badge is the only signal to admins that storage files need manual removal.
 * If the badge rendered when it shouldn't (or didn't render when it should), ops
 * would either waste time investigating clean jobs or miss genuine orphan files.
 * The requeue path clears cleanup_error on the server; the UI removes the row
 * from the list — both together guarantee the badge is gone post-requeue.
 */

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

const JOB_WITHOUT_CLEANUP_ERROR = {
  id: 'job-clean',
  catalog_id: 'cat-clean',
  status: 'retryable_failed' as const,
  attempts: 1,
  max_attempts: 5,
  last_error: 'timeout: image generation exceeded 30s',
  cleanup_error: null,
  cleanup_error_paths: null,
  updated_at: new Date('2026-07-16T13:00:00Z').toISOString(),
  universal_stamp_catalog: { display_name: 'Berlin Wall', stamp_type: 'landmark', country_code: 'DE' },
};

describe('FailedJobsScreen — orphaned-files badge', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    // Tear down any leftover renders before resetting mocks so that leaked
    // async effects from the previous test don't call into the new mock state.
    cleanup();
    mockGetQueue.mockReset();
    mockRequeue.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('renders the orphan count badge when cleanup_error is set with paths', async () => {
    mockGetQueue.mockResolvedValue(queueOk([JOB_WITH_CLEANUP_ERROR]));

    await render(<FailedJobsScreen />);
    await screen.findByText('Rome Colosseum');

    // Component shows "N orphaned file(s) need manual removal" when paths are present.
    expect(screen.getByText('2 orphaned files need manual removal')).toBeTruthy();
  });

  it('renders the generic orphaned-files badge when cleanup_error is set but paths list is empty', async () => {
    const jobWithErrorButNoPaths = {
      ...JOB_WITH_CLEANUP_ERROR,
      id: 'job-orphan-no-paths',
      cleanup_error_paths: [] as string[],
    };
    mockGetQueue.mockResolvedValue(queueOk([jobWithErrorButNoPaths]));

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Rome Colosseum'));

    expect(screen.getByText('Orphaned storage files need manual removal')).toBeTruthy();
  });

  it('does not render any cleanup badge when cleanup_error is null', async () => {
    mockGetQueue.mockResolvedValue(queueOk([JOB_WITHOUT_CLEANUP_ERROR]));

    await render(<FailedJobsScreen />);
    await screen.findByText('Berlin Wall');

    expect(screen.queryByText(/orphaned/i)).toBeNull();
  });

  it('badge disappears after a successful requeue removes the job row', async () => {
    mockGetQueue.mockResolvedValue(queueOk([JOB_WITH_CLEANUP_ERROR]));
    mockRequeue.mockResolvedValueOnce({ ok: true });

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('2 orphaned files need manual removal'));

    // Trigger the requeue flow.
    fireEvent.press(screen.getByText('Re-queue'));
    await pressAlertButton(alertSpy, 'Re-queue');

    // The row (and therefore the badge) must be gone after a successful requeue.
    await waitFor(() =>
      expect(screen.queryByText('2 orphaned files need manual removal')).toBeNull(),
    );
    expect(screen.queryByText('Rome Colosseum')).toBeNull();
  });

  it('badge disappears after a pull-to-refresh where the server now returns cleanup_error: null', async () => {
    // Ops manually clear cleanup_error in the DB after removing the orphaned
    // files by hand.  The next pull-to-refresh must reflect the cleared state —
    // the job row stays (it's still failed) but the badge must be gone.
    const clearedJob = { ...JOB_WITH_CLEANUP_ERROR, cleanup_error: null, cleanup_error_paths: null };
    mockGetQueue
      .mockResolvedValueOnce(queueOk([JOB_WITH_CLEANUP_ERROR]))
      .mockResolvedValue(queueOk([clearedJob]));

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('2 orphaned files need manual removal'));

    // Admin pulls to refresh after ops cleared cleanup_error.
    const list = screen.getByTestId('failed-jobs-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    // Badge must be gone — the job row remains but cleanup_error is now null.
    await waitFor(() => expect(screen.queryByText('2 orphaned files need manual removal')).toBeNull());
    // The job itself is still present (it's still a failed job, just not orphaned).
    expect(screen.getByText('Rome Colosseum')).toBeTruthy();
  });

  it('shows the correct count for a job with 5+ cleanup_error_paths', async () => {
    const MANY_PATHS = [
      'stamps/abc/v1.webp',
      'stamps/abc/v2.webp',
      'stamps/abc/v3.webp',
      'stamps/abc/v4.webp',
      'stamps/abc/v5.webp',
    ];
    const jobWithManyPaths = {
      ...JOB_WITH_CLEANUP_ERROR,
      id: 'job-orphan-many',
      cleanup_error_paths: MANY_PATHS,
    };
    mockGetQueue.mockResolvedValue(queueOk([jobWithManyPaths]));

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Rome Colosseum'));

    // All 5 orphaned files must be reflected in the count label — not just the first.
    expect(screen.getByText('5 orphaned files need manual removal')).toBeTruthy();
  });

  it('uses singular "file" for a single cleanup_error_path', async () => {
    const jobWithOnePath = {
      ...JOB_WITH_CLEANUP_ERROR,
      id: 'job-orphan-one',
      cleanup_error_paths: ['stamps/abc/v1.webp'],
    };
    mockGetQueue.mockResolvedValue(queueOk([jobWithOnePath]));

    render(<FailedJobsScreen />);
    await waitFor(() => screen.getByText('Rome Colosseum'));

    expect(screen.getByText('1 orphaned file need manual removal')).toBeTruthy();
  });
});


describe('FailedJobsScreen — cleanup warning badge is announced to screen readers', () => {
  beforeEach(() => {
    cleanup();
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
