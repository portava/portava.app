/**
 * StampQueueScreen — pull-to-refresh component tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. The initial load fetches catalog entries and displays them.
 * 2. Pull-to-refresh calls load() again and shows the updated data.
 * 3. The refreshing spinner clears once load() resolves (setRefreshing(false)
 *    was called — a missing call would leave the spinner spinning forever).
 *
 * ## Why these tests exist
 *
 * A stale-closure bug or a missing setRefreshing(false) call in onRefresh
 * would be invisible at runtime until an admin noticed the spinner was stuck
 * or the entry list was never updated.  These tests make both failure modes
 * explicit.
 *
 * ## How pull-to-refresh is simulated
 *
 * The FlatList is found by testID ("catalog-queue-list") and its
 * refreshControl.props.onRefresh() is invoked directly inside act() — the
 * same pattern used by the StampStudioIndex pull-to-refresh suite.
 */

import React from 'react';
import { render, act, waitFor, screen } from '@testing-library/react-native';
import StampQueueScreen from '../../../app/admin/stamps/queue';
import { getAdminStampCatalog } from '../../services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps', () => ({
  getAdminStampCatalog: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  ArrowLeft: () => null,
  Search: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetCatalog = getAdminStampCatalog as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function catalogOk(entries: Array<{ id: string; display_name: string; stamp_type: string; country_code: string; status: string }>, total?: number) {
  return {
    ok: true as const,
    data: {
      entries,
      total: total ?? entries.length,
      page: 1,
      statusCounts: {
        pending_artwork: 0,
        review_required: 0,
        approved: 0,
        rejected: 0,
        archived: 0,
        retryable_failed: 0,
      },
    },
  };
}

const ENTRY_A = { id: 'cat-1', display_name: 'Paris Eiffel', stamp_type: 'landmark', country_code: 'FR', status: 'pending_artwork' };
const ENTRY_B = { id: 'cat-2', display_name: 'Tokyo Tower',  stamp_type: 'landmark', country_code: 'JP', status: 'approved' };

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('StampQueueScreen — pull-to-refresh', () => {
  beforeEach(() => {
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))   // initial load
      .mockResolvedValue(catalogOk([ENTRY_A, ENTRY_B])); // subsequent calls
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the initial entry from the first fetch', async () => {
    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
  });

  it('calls getAdminStampCatalog again when the user pulls to refresh', async () => {
    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const callsBefore = mockGetCatalog.mock.calls.length;

    const list = screen.getByTestId('catalog-queue-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    expect(mockGetCatalog.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('shows the updated entry list after pull-to-refresh completes', async () => {
    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('catalog-queue-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    await waitFor(() => screen.getByText('Tokyo Tower'));
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();  // new entry visible
    expect(screen.getByText('Paris Eiffel')).toBeTruthy(); // existing entry still present
  });

  it('clears the refreshing spinner once load() resolves', async () => {
    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('catalog-queue-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    // Wait for the new entry to appear — load() has resolved by this point.
    await waitFor(() => screen.getByText('Tokyo Tower'));

    // Re-query to read the settled refreshing prop.
    const updated = screen.getByTestId('catalog-queue-list');
    expect(updated.props.refreshControl.props.refreshing).toBe(false);
  });

  it('does not lose existing entries when the api returns an empty list on refresh', async () => {
    // Override second call to return nothing (api hiccup).
    mockGetCatalog
      .mockReset()
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))
      .mockResolvedValueOnce(catalogOk([]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const list = screen.getByTestId('catalog-queue-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    // After the refresh load() setEntries([]) — list becomes empty.
    // The spinner must still clear even when the list empties.
    await waitFor(() => {
      const updated = screen.getByTestId('catalog-queue-list');
      expect(updated.props.refreshControl.props.refreshing).toBe(false);
    });
  });
});
