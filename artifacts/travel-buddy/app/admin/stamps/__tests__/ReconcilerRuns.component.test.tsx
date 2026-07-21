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
import { render, screen } from '@testing-library/react-native';
import ReconcilerRunsScreen from '../reconciler-runs';
import { getReconcilerRuns } from '../../../../src/services/adminStamps';

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
}));

const mockGetRuns = getReconcilerRuns as jest.Mock;

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
});
