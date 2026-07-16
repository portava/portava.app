/**
 * StampStudioIndex — catalog-count auto-refresh integration tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. The 60-second catalog poll fires refreshCatalog, which re-fetches
 *    getAdminStampCatalog and updates the status tile counts in the UI.
 * 2. Returning focus to the screen (blur → refocus) triggers an immediate
 *    re-fetch so stale counts don't linger after an admin approves artwork.
 * 3. The initial focus does NOT trigger a redundant re-fetch on top of the
 *    existing load() call that runs via useEffect on mount.
 *
 * ## Why these tests exist
 *
 * The dashboard re-fetches catalog status counts every 60 s and on focus
 * return, but without automated coverage a stale-closure bug or missed
 * setState would be invisible until a human noticed the numbers were wrong.
 *
 * ## Timer strategy
 *
 * jest.useFakeTimers() intercepts setTimeout(fn, 0), which React's internal
 * scheduler relies on to flush effects — using it silently prevents useEffect
 * from running at all.  Instead we spy on setInterval/clearInterval directly
 * (real timers stay active) and capture only long-delay component intervals
 * (≥ 1 s), letting waitFor's 50 ms polling and React's 0 ms scheduler pass
 * through unmodified.  We then invoke the captured poll callback manually
 * inside act() to simulate the 60-second tick.
 *
 * ## useFocusEffect mock discipline
 *
 * In production, useFocusEffect invokes its callback only when the screen
 * gains focus, NOT on every re-render.  Our mock must mirror this: call cb()
 * exactly once per simulated focus event.  Because the component re-renders
 * on every setState (setLoading, setStatusCounts, …), a naive mock that
 * always calls cb() would fire extra refreshCatalog calls and make call-count
 * assertions impossible.  We guard with `focusHasRun` and only advance it
 * when a test explicitly simulates a re-focus.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import StampStudioIndex from '../../../app/admin/stamps/index';
import { useFocusEffect } from 'expo-router';
import {
  getAdminStampCatalog,
  getStampWorkerHealth,
} from '../../services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps', () => ({
  getAdminStampCatalog: jest.fn(),
  getStampWorkerHealth: jest.fn(),
}));

// Override the global lucide mock with every icon the screen imports.
jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null,
  Image: () => null,
  Clock: () => null,
  CheckCircle: () => null,
  AlertTriangle: () => null,
  XCircle: () => null,
  Activity: () => null,
  MapPin: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockUseFocusEffect = useFocusEffect as jest.Mock;
const mockGetCatalog = getAdminStampCatalog as jest.Mock;
const mockGetHealth = getStampWorkerHealth as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function catalogOk(approved: number) {
  return {
    ok: true as const,
    data: {
      entries: [],
      total: 0,
      page: 1,
      statusCounts: {
        pending_artwork: 2,
        review_required: 1,
        approved,
        rejected: 0,
        archived: 0,
        retryable_failed: 0,
      },
    },
  };
}

// ── Interval spy infrastructure ────────────────────────────────────────────────

type CapturedInterval = { id: ReturnType<typeof setInterval>; fn: () => void; delay: number };

function makeIntervalSpy() {
  const captured: CapturedInterval[] = [];
  let nextId = 9000; // high to avoid clashing with real timer IDs
  const originalSetInterval = global.setInterval.bind(global);
  const originalClearInterval = global.clearInterval.bind(global);

  // Intercept only long-delay intervals (component polls at 30 s / 45 s / 60 s).
  // Short-delay calls (waitFor at ~50 ms, React scheduler at 0 ms) pass through
  // so async assertions continue to work normally.
  jest.spyOn(global, 'setInterval').mockImplementation(
    (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      if ((delay ?? 0) >= 1_000) {
        const id = nextId++ as unknown as ReturnType<typeof setInterval>;
        captured.push({ id, fn: fn as () => void, delay: delay ?? 0 });
        return id;
      }
      return originalSetInterval(fn as TimerHandler, delay, ...args);
    },
  );

  jest.spyOn(global, 'clearInterval').mockImplementation(
    (id?: ReturnType<typeof setInterval>) => {
      const idx = captured.findIndex((e) => e.id === id);
      if (idx !== -1) {
        captured.splice(idx, 1);
      } else {
        originalClearInterval(id);
      }
    },
  );

  return {
    captured,
    catalogPoll: () => captured.find((e) => e.delay === 60_000),
    teardown: () => {
      jest.restoreAllMocks();
      captured.length = 0;
    },
  };
}

// ── useFocusEffect factory ─────────────────────────────────────────────────────

/**
 * Creates a useFocusEffect mock that behaves like the real hook:
 * - Invokes the callback exactly once on the initial focus.
 * - On subsequent renders (re-renders from setState) it ONLY updates the
 *   stored reference — it does NOT re-invoke the callback, mirroring the
 *   real hook which re-fires only on navigation focus events.
 * - Exposes `simulateRefocus()` so tests can manually trigger a focus-return.
 */
function makeUseFocusEffectMock() {
  let latestCb: (() => () => void) | null = null;
  let latestCleanup: (() => void) | null = null;
  let initialFired = false;

  mockUseFocusEffect.mockImplementation((cb: () => () => void) => {
    latestCb = cb;
    if (!initialFired) {
      initialFired = true;
      latestCleanup = cb();
    }
  });

  return {
    /** Simulate blur → re-focus: cleanup + re-invoke the latest callback. */
    async simulateRefocus() {
      latestCleanup?.();
      await act(async () => { latestCb?.(); });
    },
    /** Return the cleanup from the latest focus invocation. */
    blur() { latestCleanup?.(); },
  };
}

// ── Suite 1: 60-second catalog poll ───────────────────────────────────────────

describe('StampStudioIndex — 60-second catalog poll updates status tiles', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock(); // sets up mockUseFocusEffect

    // First call → initial load (approved: 42).
    // All subsequent calls → poll response (approved: 99).
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk(42))
      .mockResolvedValue(catalogOk(99));

    mockGetHealth.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('renders the initial approved count from the first fetch', async () => {
    render(<StampStudioIndex />);
    // waitFor polls until async load() resolves and the tile re-renders.
    await waitFor(() => screen.getByText('42'));
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('replaces the approved count after the 60-second poll fires', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('42')); // wait for initial load

    const poll = spy.catalogPoll();
    expect(poll).toBeDefined(); // guard: interval was registered

    // Invoke the captured 60-second callback and flush the resulting setState.
    await act(async () => { poll!.fn(); });

    await waitFor(() => screen.getByText('99'));
    expect(screen.getByText('99')).toBeTruthy();    // updated count visible
    expect(screen.queryByText('42')).toBeNull();    // old count gone
  });

  it('calls getAdminStampCatalog twice: once on load, once on the poll', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));

    const poll = spy.catalogPoll();
    expect(poll).toBeDefined();
    await act(async () => { poll!.fn(); });

    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  });

  it('re-polls correctly on a second interval tick', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));

    const poll = spy.catalogPoll();
    expect(poll).toBeDefined();

    await act(async () => { poll!.fn(); }); // tick 1
    await act(async () => { poll!.fn(); }); // tick 2

    expect(mockGetCatalog).toHaveBeenCalledTimes(3);
  });
});

// ── Suite 2: focus-return path ─────────────────────────────────────────────────

describe('StampStudioIndex — returning focus triggers an immediate catalog re-fetch', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;
  let focusControl: ReturnType<typeof makeUseFocusEffectMock>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    focusControl = makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(7));
    mockGetHealth.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('calls getAdminStampCatalog again immediately on focus return', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));

    const callsBefore = mockGetCatalog.mock.calls.length;
    await focusControl.simulateRefocus(); // blur → refocus → refreshCatalog fires

    expect(mockGetCatalog.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does NOT fire a redundant re-fetch on the initial focus', async () => {
    // load() via useEffect accounts for the first call.
    // The firstFocusRef guard must prevent a second call from useFocusEffect
    // on the same initial mount — no double-fetch.
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
  });

  it('sets up fresh intervals after re-focus so the poll continues', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));

    await focusControl.simulateRefocus(); // triggers refreshCatalog + new intervals

    const callsAfterRefocus = mockGetCatalog.mock.calls.length;

    // The freshly registered 60-second interval should be in the spy.
    const poll = spy.catalogPoll();
    expect(poll).toBeDefined();

    await act(async () => { poll!.fn(); });

    expect(mockGetCatalog.mock.calls.length).toBeGreaterThan(callsAfterRefocus);
  });

  it('re-registers the 45-second health interval after re-focus and invoking it calls getStampWorkerHealth', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));

    // Simulate leaving the screen and returning — the useFocusEffect cleanup runs
    // then the callback fires again, re-registering all three intervals.
    await focusControl.simulateRefocus();

    // The freshly registered 45-second interval must be present in the spy.
    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();

    const healthCallsAfterRefocus = mockGetHealth.mock.calls.length;

    // Manually tick the interval to confirm it calls getStampWorkerHealth.
    await act(async () => { healthPoll!.fn(); });

    expect(mockGetHealth.mock.calls.length).toBeGreaterThan(healthCallsAfterRefocus);
  });
});

// ── Suite 3: pull-to-refresh ───────────────────────────────────────────────────

/**
 * Pull-to-refresh fires onRefresh → setRefreshing(true) → load() →
 * setRefreshing(false).  A stale-closure bug or a missing setRefreshing(false)
 * call would be invisible without a test: the spinner would hang and the count
 * would never update.
 *
 * We simulate the gesture with fireEvent(scrollView, 'refresh'), which invokes
 * the onRefresh prop exactly as the native RefreshControl does.
 */
describe('StampStudioIndex — pull-to-refresh picks up newly approved artwork', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    // First call → initial load (approved: 5).
    // All subsequent calls → pull-to-refresh response (approved: 77).
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk(5))
      .mockResolvedValue(catalogOk(77));

    mockGetHealth.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('calls load() again when the user pulls to refresh', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('5'));

    const callsBefore = mockGetCatalog.mock.calls.length;
    const scrollView = screen.getByTestId('stamp-studio-scroll');
    await act(async () => { scrollView.props.refreshControl.props.onRefresh(); });

    // load() calls getAdminStampCatalog — count must have increased.
    expect(mockGetCatalog.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('shows the updated approved count after pull-to-refresh completes', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('5'));

    const scrollView = screen.getByTestId('stamp-studio-scroll');
    await act(async () => { scrollView.props.refreshControl.props.onRefresh(); });

    await waitFor(() => screen.getByText('77'));
    expect(screen.getByText('77')).toBeTruthy(); // updated count visible
    expect(screen.queryByText('5')).toBeNull();   // stale count gone
  });

  it('clears the refreshing spinner once load() resolves', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('5'));

    const scrollView = screen.getByTestId('stamp-studio-scroll');
    await act(async () => { scrollView.props.refreshControl.props.onRefresh(); });

    // Wait until the updated count is present — load() has resolved and
    // setRefreshing(false) must have been called by then.
    await waitFor(() => screen.getByText('77'));

    // Re-query so we see the updated refreshing prop after state settles.
    const updated = screen.getByTestId('stamp-studio-scroll');
    expect(updated.props.refreshControl.props.refreshing).toBe(false);
  });

  it('getStampWorkerHealth is called again and updated health warnings appear after pull-to-refresh', async () => {
    // Override the beforeEach mock: first health call returns no data so the
    // health strip is absent on initial load; subsequent calls return a
    // stuck_jobs warning so it becomes visible after the gesture.
    mockGetHealth.mockReset();
    mockGetHealth
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true as const,
        data: {
          warnings: [
            { key: 'stuck_jobs' as const, message: 'stuck', details: { stuck_count: 2 } },
          ],
          health: {
            worker_enabled: true,
            worker_running: true,
            worker_id: 'w1',
            last_success_at: null,
            queue_depth: {},
            stuck_jobs: [],
          },
        },
      });

    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('5'));

    // No health warnings rendered yet — initial load got ok: false.
    expect(screen.queryByText(/stuck in 'generating'/)).toBeNull();

    const healthCallsBefore = mockGetHealth.mock.calls.length;

    const scrollView = screen.getByTestId('stamp-studio-scroll');
    await act(async () => { scrollView.props.refreshControl.props.onRefresh(); });

    // Wait for the catalog count update so load() has fully resolved.
    await waitFor(() => screen.getByText('77'));

    // getStampWorkerHealth must have been called again during the refresh.
    expect(mockGetHealth.mock.calls.length).toBeGreaterThan(healthCallsBefore);

    // The warning text produced by warningSummary for stuck_jobs is now visible.
    await waitFor(() =>
      screen.getByText(/2 jobs stuck in 'generating' past lock expiry/),
    );
    expect(
      screen.getByText(/2 jobs stuck in 'generating' past lock expiry/),
    ).toBeTruthy();
  });

  it('renders the backlog_growing warning with correct queued counts after pull-to-refresh', async () => {
    // Override the beforeEach mock: first health call returns no data so no
    // health strip is shown on initial load; subsequent calls return a
    // backlog_growing warning so it becomes visible after the gesture.
    mockGetHealth.mockReset();
    mockGetHealth
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true as const,
        data: {
          warnings: [
            {
              key: 'backlog_growing' as const,
              message: 'backlog growing',
              details: { queued: 15, previous_queued: 8 },
            },
          ],
          health: {
            worker_enabled: true,
            worker_running: true,
            worker_id: 'w1',
            last_success_at: null,
            queue_depth: {},
            stuck_jobs: [],
          },
        },
      });

    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('5'));

    // No health warnings on initial load — health returned ok: false.
    expect(screen.queryByText(/Queued backlog grew/)).toBeNull();

    const scrollView = screen.getByTestId('stamp-studio-scroll');
    await act(async () => { scrollView.props.refreshControl.props.onRefresh(); });

    // Wait for the catalog count update so load() has fully resolved.
    await waitFor(() => screen.getByText('77'));

    // The warning text produced by warningSummary for backlog_growing is visible.
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from 8 to 15 while the worker is enabled/),
    );
    expect(
      screen.getByText(/Queued backlog grew from 8 to 15 while the worker is enabled/),
    ).toBeTruthy();
  });
});

// ── Suite 4: 45-second health poll ────────────────────────────────────────────

/**
 * The component registers a separate 45-second interval that calls
 * refreshHealth (→ getStampWorkerHealth) independently of the 60-second
 * catalog poll.  These tests confirm that:
 *   1. The 45 s interval is registered (delay === 45_000).
 *   2. Manually invoking its callback triggers getStampWorkerHealth.
 *   3. The warning strip updates in the UI to reflect the new health data.
 *
 * A refactor that accidentally removes or disconnects the health interval
 * would be caught here before it reaches production.
 */
describe('StampStudioIndex — 45-second health poll updates the warning strip', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    // Initial catalog load returns a stable count so tile assertions are easy.
    mockGetCatalog.mockResolvedValue(catalogOk(10));

    // First health call (from load()) returns no warnings so the strip is
    // absent on mount.  Subsequent calls (from the 45 s interval) return a
    // stuck_jobs warning so we can assert it appears after the tick.
    mockGetHealth
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true as const,
        data: {
          warnings: [
            { key: 'stuck_jobs' as const, message: 'stuck', details: { stuck_count: 3 } },
          ],
          health: {
            worker_enabled: true,
            worker_running: true,
            worker_id: 'w1',
            last_success_at: null,
            queue_depth: {},
            stuck_jobs: [],
          },
        },
      });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('registers a 45-second interval for the health poll', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();
  });

  it('invoking the 45-second interval callback calls getStampWorkerHealth', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const healthCallsBefore = mockGetHealth.mock.calls.length;

    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();

    await act(async () => { healthPoll!.fn(); });

    expect(mockGetHealth.mock.calls.length).toBeGreaterThan(healthCallsBefore);
  });

  it('warning strip appears in the UI after the 45-second health poll fires', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    // No warning strip on initial render — first health call returned ok: false.
    expect(screen.queryByText(/stuck in 'generating'/)).toBeNull();

    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();

    await act(async () => { healthPoll!.fn(); });

    // After the poll tick the stuck_jobs warning must now be visible.
    await waitFor(() =>
      screen.getByText(/3 jobs stuck in 'generating' past lock expiry/),
    );
    expect(
      screen.getByText(/3 jobs stuck in 'generating' past lock expiry/),
    ).toBeTruthy();
  });

  it('does NOT call getAdminStampCatalog when the health poll fires', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const catalogCallsBefore = mockGetCatalog.mock.calls.length;

    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();

    await act(async () => { healthPoll!.fn(); });

    // The health-only poll must not trigger a catalog fetch.
    expect(mockGetCatalog.mock.calls.length).toBe(catalogCallsBefore);
  });

  it('backlog_growing warning appears in the UI after the 45-second health poll fires', async () => {
    // Override the beforeEach mock so subsequent health calls return a
    // backlog_growing warning instead of stuck_jobs.
    mockGetHealth.mockReset();
    mockGetHealth
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true as const,
        data: {
          warnings: [
            {
              key: 'backlog_growing' as const,
              message: 'backlog growing',
              details: { queued: 20, previous_queued: 11 },
            },
          ],
          health: {
            worker_enabled: true,
            worker_running: true,
            worker_id: 'w1',
            last_success_at: null,
            queue_depth: {},
            stuck_jobs: [],
          },
        },
      });

    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    // No warning strip on initial render — first health call returned ok: false.
    expect(screen.queryByText(/Queued backlog grew/)).toBeNull();

    const healthPoll = spy.captured.find((e) => e.delay === 45_000);
    expect(healthPoll).toBeDefined();

    await act(async () => { healthPoll!.fn(); });

    // After the poll tick the backlog_growing warning must now be visible with
    // the correct queued / previous_queued values read from details.
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from 11 to 20 while the worker is enabled/),
    );
    expect(
      screen.getByText(/Queued backlog grew from 11 to 20 while the worker is enabled/),
    ).toBeTruthy();
  });
});

// ── Suite 5: blur clears all three intervals ───────────────────────────────────

/**
 * When the user navigates away, useFocusEffect's cleanup must call
 * clearInterval for all three IDs — health (45 s), catalog (60 s), and
 * clock tick (30 s).  If any one is missed, ghost setState calls keep
 * firing on a blurred (or unmounted) screen and cause memory pressure.
 *
 * Strategy: after mount, `spy.captured` holds exactly three entries.
 * Invoking `focusControl.blur()` triggers the useFocusEffect cleanup,
 * which calls clearInterval for each ID.  Our clearInterval spy removes
 * each entry from `captured` as it is cleared, so after blur the array
 * must be empty.
 */
describe('StampStudioIndex — all three polling intervals stop when leaving the screen', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;
  let focusControl: ReturnType<typeof makeUseFocusEffectMock>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    focusControl = makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(10));
    mockGetHealth.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('registers exactly three long-delay intervals on mount', async () => {
    render(<StampStudioIndex />);
    // Wait for initial load to complete so all three intervals are registered.
    await waitFor(() => screen.getByText('10'));

    // The component registers: health (45 s), catalog (60 s), clock tick (30 s).
    expect(spy.captured.length).toBe(3);
  });

  it('clears all three interval IDs when the screen loses focus', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    // Guard: all three must be present before we blur.
    expect(spy.captured.length).toBe(3);

    // Simulate the user navigating away — triggers useFocusEffect cleanup.
    focusControl.blur();

    // After blur, clearInterval must have been called for every captured ID,
    // leaving the captured array empty.
    expect(spy.captured.length).toBe(0);
  });

  it('clears the 30-second clock-tick interval on blur', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const tickBefore = spy.captured.find((e) => e.delay === 30_000);
    expect(tickBefore).toBeDefined();

    focusControl.blur();

    const tickAfter = spy.captured.find((e) => e.delay === 30_000);
    expect(tickAfter).toBeUndefined();
  });

  it('clears the 45-second health-poll interval on blur', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const healthBefore = spy.captured.find((e) => e.delay === 45_000);
    expect(healthBefore).toBeDefined();

    focusControl.blur();

    const healthAfter = spy.captured.find((e) => e.delay === 45_000);
    expect(healthAfter).toBeUndefined();
  });

  it('clears the 60-second catalog-poll interval on blur', async () => {
    render(<StampStudioIndex />);
    await waitFor(() => screen.getByText('10'));

    const catalogBefore = spy.captured.find((e) => e.delay === 60_000);
    expect(catalogBefore).toBeDefined();

    focusControl.blur();

    const catalogAfter = spy.captured.find((e) => e.delay === 60_000);
    expect(catalogAfter).toBeUndefined();
  });
});

// ── Suite 6: backlog_growing with missing queued details ───────────────────────

/**
 * warningSummary falls back to '?' when w.details?.queued or
 * w.details?.previous_queued is absent.  These tests confirm that a
 * backlog_growing warning with an empty details object (or with the fields
 * missing) renders placeholder text — not a crash and not the literal string
 * "undefined".
 */
describe('StampStudioIndex — backlog_growing with missing queued details shows placeholders', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(10));
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('renders "? to ?" placeholders when details is an empty object', async () => {
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          {
            key: 'backlog_growing' as const,
            message: 'backlog growing',
            details: {},
          },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from \? to \?/),
    );

    const warningText = screen.getByText(/Queued backlog grew from \? to \?/);
    expect(warningText).toBeTruthy();
    // Must not contain the literal string "undefined".
    expect(warningText.props.children).not.toMatch(/undefined/);
  });

  it('renders "? to ?" placeholders when details is undefined', async () => {
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          {
            key: 'backlog_growing' as const,
            message: 'backlog growing',
            details: undefined,
          },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from \? to \?/),
    );

    const warningText = screen.getByText(/Queued backlog grew from \? to \?/);
    expect(warningText).toBeTruthy();
    expect(warningText.props.children).not.toMatch(/undefined/);
  });

  it('renders the real counts when only previous_queued is missing', async () => {
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          {
            key: 'backlog_growing' as const,
            message: 'backlog growing',
            details: { queued: 20 },
          },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);
    // queued is present (20) but previous_queued is absent → shows "? to 20"
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from \? to 20/),
    );

    const warningText = screen.getByText(/Queued backlog grew from \? to 20/);
    expect(warningText).toBeTruthy();
    expect(warningText.props.children).not.toMatch(/undefined/);
  });

  it('renders the real counts when only queued is missing', async () => {
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          {
            key: 'backlog_growing' as const,
            message: 'backlog growing',
            details: { previous_queued: 5 },
          },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);
    // previous_queued is present (5) but queued is absent → shows "5 to ?"
    await waitFor(() =>
      screen.getByText(/Queued backlog grew from 5 to \?/),
    );

    const warningText = screen.getByText(/Queued backlog grew from 5 to \?/);
    expect(warningText).toBeTruthy();
    expect(warningText.props.children).not.toMatch(/undefined/);
  });
});

// ── Suite 7: warning banner title labels ──────────────────────────────────────

/**
 * The warning banner renders a title label alongside the summary text:
 *   - 'Stuck generation jobs'  for the stuck_jobs warning
 *   - 'Backlog growing'        for the backlog_growing warning
 *
 * A swapped ternary branch (wrong key check) would display the wrong label
 * with no automated signal.  These tests assert BOTH the title label AND the
 * summary body text are present and correct for each warning type, so a swap
 * is caught immediately.
 */
describe('StampStudioIndex — warning banner title labels are correct for both warning types', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('renders "Stuck generation jobs" title and correct body for stuck_jobs warning', async () => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(10));
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          { key: 'stuck_jobs' as const, message: 'stuck', details: { stuck_count: 4 } },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);

    // Wait for load() to complete so the warning banner is rendered.
    await waitFor(() => screen.getByText('Stuck generation jobs'));

    // Title label must be the stuck_jobs label — not the backlog_growing label.
    expect(screen.getByText('Stuck generation jobs')).toBeTruthy();
    expect(screen.queryByText('Backlog growing')).toBeNull();

    // Body text must match warningSummary for stuck_jobs.
    expect(
      screen.getByText(/4 jobs stuck in 'generating' past lock expiry/),
    ).toBeTruthy();
  });

  it('renders "Backlog growing" title and correct body for backlog_growing warning', async () => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(10));
    mockGetHealth.mockResolvedValue({
      ok: true as const,
      data: {
        warnings: [
          {
            key: 'backlog_growing' as const,
            message: 'backlog growing',
            details: { queued: 20, previous_queued: 5 },
          },
        ],
        health: {
          worker_enabled: true,
          worker_running: true,
          worker_id: 'w1',
          last_success_at: null,
          queue_depth: {},
          stuck_jobs: [],
        },
      },
    });

    render(<StampStudioIndex />);

    // Wait for load() to complete so the warning banner is rendered.
    await waitFor(() => screen.getByText('Backlog growing'));

    // Title label must be the backlog_growing label — not the stuck_jobs label.
    expect(screen.getByText('Backlog growing')).toBeTruthy();
    expect(screen.queryByText('Stuck generation jobs')).toBeNull();

    // Body text must match warningSummary for backlog_growing.
    expect(
      screen.getByText(/Queued backlog grew from 5 to 20 while the worker is enabled/),
    ).toBeTruthy();
  });
});

// ── Suite 8: Geocode Cache link ────────────────────────────────────────────────

/**
 * ## What's covered
 *
 * 1. The "Geocode Cache" Pressable renders inside the Actions section for admin
 *    users — confirmed by finding its text label after the initial load settles.
 * 2. Pressing the Geocode Cache link calls router.push with '/admin/geocode-cache'.
 * 3. Non-admin users (regular or unauthenticated) trigger a router.replace
 *    redirect via useRequireAdmin — the screen body never renders for them.
 *
 * ## Why these tests exist
 *
 * The link was added without automated coverage.  A future refactor that removes
 * the Pressable, changes its navigation target, or accidentally exposes it to
 * non-admins would be invisible until a human tested it manually.  These tests
 * pin both the render contract and the navigation target so any regression is
 * caught immediately.
 *
 * ## Non-admin redirect strategy
 *
 * useRequireAdmin is mocked for every suite in this file (jest.fn() returns
 * undefined by default so the component renders normally).  To simulate a
 * non-admin session we replace the mock implementation with one that
 * synchronously calls router.replace, mirroring what the real hook does when
 * resolveAdminGate returns 'redirect_home' for an authenticated non-admin.
 * Because the redirect happens inside a useEffect in the real hook, we
 * implement it the same way here — we spy on router.replace and assert it was
 * called with the home path.
 */

import { useRequireAdmin } from '../../hooks/useRequireAdmin';
import { router } from 'expo-router';

const mockUseRequireAdmin = useRequireAdmin as jest.Mock;
const mockRouter = router as { push: jest.Mock; back: jest.Mock; replace: jest.Mock };

describe('StampStudioIndex — Geocode Cache link renders for admins and navigates correctly', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(0));
    mockGetHealth.mockResolvedValue({ ok: false });

    // Default: behave as an admin (useRequireAdmin is a no-op mock).
    mockUseRequireAdmin.mockReturnValue(false);
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('renders the "Geocode Cache" label in the Actions section for admin users', async () => {
    render(<StampStudioIndex />);

    await waitFor(() => screen.getByText('Geocode Cache'));

    expect(screen.getByText('Geocode Cache')).toBeTruthy();
  });

  it('pressing the Geocode Cache link calls router.push with /admin/geocode-cache', async () => {
    render(<StampStudioIndex />);

    await waitFor(() => screen.getByText('Geocode Cache'));

    await act(async () => {
      fireEvent.press(screen.getByText('Geocode Cache'));
    });

    expect(mockRouter.push).toHaveBeenCalledWith('/admin/geocode-cache');
  });

  it('does not navigate to /admin/geocode-cache until the link is pressed', async () => {
    render(<StampStudioIndex />);

    await waitFor(() => screen.getByText('Geocode Cache'));

    // The link is rendered but not yet pressed — router.push must not have
    // been called with the geocode-cache path at this point.
    const geocodePushCalls = (mockRouter.push.mock.calls as string[][]).filter(
      (args) => args[0] === '/admin/geocode-cache',
    );
    expect(geocodePushCalls).toHaveLength(0);
  });
});

describe('StampStudioIndex — non-admin users are redirected away by useRequireAdmin', () => {
  let spy: ReturnType<typeof makeIntervalSpy>;

  beforeEach(() => {
    spy = makeIntervalSpy();
    makeUseFocusEffectMock();

    mockGetCatalog.mockResolvedValue(catalogOk(0));
    mockGetHealth.mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    spy.teardown();
    jest.clearAllMocks();
  });

  it('calls router.replace("/") when useRequireAdmin detects a non-admin user', async () => {
    // Simulate the real hook's redirect_home path: call router.replace('/') on mount.
    mockUseRequireAdmin.mockImplementation(() => {
      // Mirror what the real useRequireAdmin does in a useEffect when
      // resolveAdminGate returns 'redirect_home' for an authenticated non-admin.
      React.useEffect(() => {
        mockRouter.replace('/');
      }, []);
      return false;
    });

    render(<StampStudioIndex />);

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
  });

  it('calls router.replace("/(auth)/sign-in") when useRequireAdmin detects an unauthenticated user', async () => {
    // Simulate the real hook's redirect_signin path.
    mockUseRequireAdmin.mockImplementation(() => {
      React.useEffect(() => {
        mockRouter.replace('/(auth)/sign-in');
      }, []);
      return true; // adminLoading = true (redirect fires after auth resolves)
    });

    render(<StampStudioIndex />);

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/(auth)/sign-in');
    });
  });
});
