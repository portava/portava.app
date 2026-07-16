/**
 * StampQueueScreen — pull-to-refresh and malformed-entry-filter tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. The initial load fetches catalog entries and displays them.
 * 2. Pull-to-refresh calls load() again and shows the updated data.
 * 3. The refreshing spinner clears once load() resolves (setRefreshing(false)
 *    was called — a missing call would leave the spinner spinning forever).
 * 4. The runtime guard in load() drops entries that are missing `id` or
 *    `status` (or have them as non-strings) and calls console.warn once per
 *    dropped entry, without affecting valid entries in the same response.
 *
 * ## Why these tests exist
 *
 * A stale-closure bug or a missing setRefreshing(false) call in onRefresh
 * would be invisible at runtime until an admin noticed the spinner was stuck
 * or the entry list was never updated.  These tests make both failure modes
 * explicit.
 *
 * The malformed-entry filter guard is similarly invisible at runtime — a
 * future refactor could invert the predicate or silently remove the warn call.
 * The filter suite pins both the drop behaviour and the warning contract.
 *
 * ## How pull-to-refresh is simulated
 *
 * The FlatList is found by testID ("catalog-queue-list") and its
 * refreshControl.props.onRefresh() is invoked directly inside act() — the
 * same pattern used by the StampStudioIndex pull-to-refresh suite.
 */

import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
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
    // waitFor matches the pattern used by all other tests in this file and
    // avoids the screen.findByText "render function has not been called" error
    // that appears under React 19 + RNTL 14 when the async-act scope races
    // with the query's internal polling setup.
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

// ── Malformed-entry filter suite ───────────────────────────────────────────────

/**
 * Builds an ok response whose `entries` field accepts unknown[] so tests can
 * inject null, objects without id/status, and entries whose id/status are the
 * wrong type — all shapes the runtime guard must drop.
 */
function catalogOkRaw(entries: unknown[], total?: number) {
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

const VALID_ENTRY = {
  id: 'cat-v1',
  display_name: 'Valid Entry',
  stamp_type: 'landmark',
  country_code: 'FR',
  status: 'approved',
};

describe('StampQueueScreen — malformed entry filter', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('renders only valid entries when the API response includes malformed ones', async () => {
    mockGetCatalog.mockResolvedValue(
      catalogOkRaw([
        VALID_ENTRY,
        null,                                                               // null
        { display_name: 'No ID',     stamp_type: 'x', country_code: 'US', status: 'approved' }, // missing id
        { id: 'cat-x', display_name: 'No Status', stamp_type: 'x', country_code: 'US' },        // missing status
        { id: 42,      display_name: 'Numeric ID', stamp_type: 'x', country_code: 'US', status: 'approved' }, // id not string
      ]),
    );

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Valid Entry'));

    expect(screen.getByText('Valid Entry')).toBeTruthy();
    expect(screen.queryByText('No ID')).toBeNull();
    expect(screen.queryByText('No Status')).toBeNull();
    expect(screen.queryByText('Numeric ID')).toBeNull();
  });

  it('calls console.warn exactly once for each dropped malformed entry', async () => {
    mockGetCatalog.mockResolvedValue(
      catalogOkRaw([
        VALID_ENTRY,
        null,                                                                     // drop 1
        { display_name: 'No ID', stamp_type: 'x', country_code: 'US', status: 'approved' }, // drop 2
        { id: 'cat-x', display_name: 'No Status', stamp_type: 'x', country_code: 'US' },    // drop 3
      ]),
    );

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Valid Entry'));

    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mock.calls.forEach((args) => {
      expect(args[0]).toBe('[StampQueue] dropped malformed catalog entry:');
    });
  });

  it('does not warn at all when every entry in the response is well-formed', async () => {
    const VALID_B = {
      id: 'cat-v2',
      display_name: 'Second Valid',
      stamp_type: 'landmark',
      country_code: 'JP',
      status: 'pending_artwork',
    };

    mockGetCatalog.mockResolvedValue(catalogOkRaw([VALID_ENTRY, VALID_B]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Valid Entry'));
    await waitFor(() => screen.getByText('Second Valid'));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still renders valid entries alongside dropped ones in the same response', async () => {
    const VALID_B = {
      id: 'cat-v2',
      display_name: 'Also Valid',
      stamp_type: 'landmark',
      country_code: 'JP',
      status: 'review_required',
    };

    mockGetCatalog.mockResolvedValue(
      catalogOkRaw([
        VALID_ENTRY,
        { id: 999, display_name: 'Bad ID Type', stamp_type: 'x', country_code: 'US', status: 'approved' }, // dropped
        VALID_B,
      ]),
    );

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Valid Entry'));

    expect(screen.getByText('Valid Entry')).toBeTruthy();
    expect(screen.getByText('Also Valid')).toBeTruthy();
    expect(screen.queryByText('Bad ID Type')).toBeNull();
    // Exactly one warning for the one bad entry.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Search-filter suite ────────────────────────────────────────────────────────

/**
 * Verifies that typing into the search field re-calls getAdminStampCatalog
 * with the typed search value and that the UI reflects the filtered result.
 *
 * ## Why these tests exist
 *
 * The search term is threaded from the TextInput through setSearch → the
 * `load` useCallback (which captures `search` in its deps) → useEffect.
 * A stale closure, a missing dep, or a dropped onChangeText wire could mean
 * the filter silently does nothing. These tests make the re-call and the
 * resulting UI update explicit.
 */

describe('StampQueueScreen — search filter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('re-calls getAdminStampCatalog with the typed search value', async () => {
    // Initial load returns ENTRY_A; the search-filtered load returns ENTRY_B.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))
      .mockResolvedValue(catalogOk([ENTRY_B]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const input = screen.getByPlaceholderText('Search by name…');
    await act(async () => {
      fireEvent.changeText(input, 'Tokyo');
    });

    // The second call (and any subsequent) must include search: 'Tokyo'.
    await waitFor(() => {
      const calls = mockGetCatalog.mock.calls;
      const searchCall = calls.find((args) => args[0]?.search === 'Tokyo');
      expect(searchCall).toBeDefined();
    });
  });

  it('shows only the matching entry after typing a search term', async () => {
    // Initial load returns only ENTRY_A so Tokyo Tower is absent until the
    // debounced search fires — ensuring waitFor doesn't resolve prematurely.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))
      .mockResolvedValue(catalogOk([ENTRY_B]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const input = screen.getByPlaceholderText('Search by name…');
    await act(async () => {
      fireEvent.changeText(input, 'Tokyo');
    });

    await waitFor(() => screen.getByText('Tokyo Tower'));
    expect(screen.getByText('Tokyo Tower')).toBeTruthy();
    expect(screen.queryByText('Paris Eiffel')).toBeNull();
  });

  it('shows the empty state when the search returns no matches', async () => {
    // Initial load returns ENTRY_A; filtered load returns nothing.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))
      .mockResolvedValue(catalogOk([]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const input = screen.getByPlaceholderText('Search by name…');
    await act(async () => {
      fireEvent.changeText(input, 'zzznomatch');
    });

    await waitFor(() => screen.getByText('No entries found'));
    expect(screen.getByText('No entries found')).toBeTruthy();
  });

  it('passes search: undefined (not an empty string) when the field is cleared', async () => {
    // First load (initial), second load (after typing), third load (after clearing).
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))
      .mockResolvedValueOnce(catalogOk([ENTRY_B]))
      .mockResolvedValue(catalogOk([ENTRY_A, ENTRY_B]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const input = screen.getByPlaceholderText('Search by name…');

    // Type a search term.
    await act(async () => { fireEvent.changeText(input, 'Tokyo'); });
    await waitFor(() => screen.getByText('Tokyo Tower'));

    // Clear the field.
    await act(async () => { fireEvent.changeText(input, ''); });
    await waitFor(() => screen.getByText('Paris Eiffel'));

    // The call made after clearing must NOT pass search (or pass undefined).
    const calls = mockGetCatalog.mock.calls;
    const clearCall = calls[calls.length - 1][0];
    expect(clearCall.search).toBeUndefined();
  });
});

// ── Combined status + search filter suite ─────────────────────────────────────

/**
 * Verifies that selecting a status chip while a search term is typed (or vice
 * versa) causes getAdminStampCatalog to receive BOTH filters in the same call.
 *
 * ## Why these tests exist
 *
 * `load` is a useCallback that closes over both `status` and `search`.  A
 * stale-closure bug or a missing dependency in the deps array ([status, search])
 * would silently drop one of the two values when both are set simultaneously —
 * the filtered results would include wrong-status entries or ignore the search
 * term with no error in the console.
 */

describe('StampQueueScreen — combined status + search filters', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('passes both status and search to the API when a chip is active and the user types', async () => {
    // Initial load (status='', search='') → returns ENTRY_A.
    // After chip press (status='approved', search='') → returns ENTRY_B.
    // After search typed (status='approved', search='Tokyo') → returns ENTRY_B.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))       // initial
      .mockResolvedValueOnce(catalogOk([ENTRY_B]))       // after chip press
      .mockResolvedValue(catalogOk([ENTRY_B]));          // after search typed

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    // Press the "approved" status chip.
    const approvedChip = screen.getByText('approved');
    await act(async () => { fireEvent.press(approvedChip); });

    // Type a search term.
    const input = screen.getByPlaceholderText('Search by name…');
    await act(async () => { fireEvent.changeText(input, 'Tokyo'); });

    // At least one call must include both status: 'approved' and search: 'Tokyo'.
    await waitFor(() => {
      const calls = mockGetCatalog.mock.calls;
      const combinedCall = calls.find(
        (args) => args[0]?.status === 'approved' && args[0]?.search === 'Tokyo',
      );
      expect(combinedCall).toBeDefined();
    });
  });

  it('passes status but not search after the search field is cleared while a chip is active', async () => {
    // Initial → after chip press → after search typed → after search cleared.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk([ENTRY_A]))       // initial
      .mockResolvedValueOnce(catalogOk([ENTRY_B]))       // chip pressed
      .mockResolvedValueOnce(catalogOk([ENTRY_B]))       // search typed
      .mockResolvedValue(catalogOk([ENTRY_B]));          // search cleared

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByText('Paris Eiffel'));

    // Press the "approved" chip.
    const approvedChip = screen.getByText('approved');
    await act(async () => { fireEvent.press(approvedChip); });

    // Type a search term.
    const input = screen.getByPlaceholderText('Search by name…');
    await act(async () => { fireEvent.changeText(input, 'Tokyo'); });

    // Wait for the combined-filter call to settle.
    await waitFor(() => {
      const calls = mockGetCatalog.mock.calls;
      expect(calls.some((a) => a[0]?.status === 'approved' && a[0]?.search === 'Tokyo')).toBe(true);
    });

    // Clear the search field.
    await act(async () => { fireEvent.changeText(input, ''); });

    // The last call must carry status: 'approved' but no search.
    await waitFor(() => {
      const calls = mockGetCatalog.mock.calls;
      const last = calls[calls.length - 1][0];
      expect(last.status).toBe('approved');
      expect(last.search).toBeUndefined();
    });
  });
});

// ── API error suite ────────────────────────────────────────────────────────────

/**
 * Verifies that when getAdminStampCatalog returns { ok: false }, the screen
 * shows a user-visible error message rather than silently rendering a blank
 * list that an admin might mistake for an empty catalog.
 *
 * ## Why this test exists
 *
 * Before this fix, the load() callback had no else branch for !res.ok —
 * the screen would fall through to setLoading(false) and render an empty
 * FlatList. An admin refreshing after a network error would see "No entries
 * found" with no indication anything went wrong.
 */

describe('StampQueueScreen — API error', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an error message when getAdminStampCatalog returns ok: false', async () => {
    mockGetCatalog.mockResolvedValue({ ok: false });

    render(<StampQueueScreen />);

    await waitFor(() => screen.getByTestId('catalog-queue-error'));
    expect(screen.getByTestId('catalog-queue-error')).toBeTruthy();
    expect(screen.getByText('Failed to load catalog. Please try again.')).toBeTruthy();
  });

  it('does not render the empty-list message when the API fails', async () => {
    mockGetCatalog.mockResolvedValue({ ok: false });

    render(<StampQueueScreen />);

    await waitFor(() => screen.getByTestId('catalog-queue-error'));

    // "No entries found" is the ListEmptyComponent text — it must not appear
    // on an error because it implies a successful empty fetch, not a failure.
    expect(screen.queryByText('No entries found')).toBeNull();
  });

  it('clears the error and shows entries when a subsequent load succeeds', async () => {
    mockGetCatalog
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue(catalogOk([ENTRY_A]));

    render(<StampQueueScreen />);
    await waitFor(() => screen.getByTestId('catalog-queue-error'));

    const list = screen.getByTestId('catalog-queue-list');
    await act(async () => { list.props.refreshControl.props.onRefresh(); });

    await waitFor(() => screen.getByText('Paris Eiffel'));
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
    expect(screen.queryByTestId('catalog-queue-error')).toBeNull();
  });
});

// ── Search debounce suite ──────────────────────────────────────────────────────

/**
 * Verifies that rapid keystrokes do not flood the API with one request per
 * character. The debounce in queue.tsx means only one call should fire after
 * the user stops typing.
 *
 * ## Why this test exists
 *
 * Without debouncing, typing "Tokyo" (5 characters) would trigger 5 sequential
 * getAdminStampCatalog calls. On a slow connection the responses can arrive out
 * of order and clobber each other. This test pins the debounce contract so a
 * future refactor cannot accidentally remove it.
 *
 * ## Timer strategy
 *
 * We use jest fake timers so we can control exactly when the debounce window
 * expires without waiting 350 ms of wall-clock time in CI. This suite is
 * placed last so fake-timer teardown cannot affect the other suites above.
 */

describe('StampQueueScreen — search debounce', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('fires only one getAdminStampCatalog call when multiple characters are typed in quick succession', async () => {
    mockGetCatalog.mockResolvedValue(catalogOk([ENTRY_A]));

    render(<StampQueueScreen />);

    // Wait for the initial load to settle before typing.
    await waitFor(() => screen.getByText('Paris Eiffel'));

    const callsAfterMount = mockGetCatalog.mock.calls.length;
    const input = screen.getByPlaceholderText('Search by name…');

    // Fire five changeText events inside a single async act() call.
    // async act() flushes synchronous effects (scheduling the debounce timer)
    // but does NOT advance macrotask timers, so the 350 ms setTimeout has not
    // yet fired when act() resolves.
    await act(async () => {
      fireEvent.changeText(input, 'T');
      fireEvent.changeText(input, 'To');
      fireEvent.changeText(input, 'Tok');
      fireEvent.changeText(input, 'Toky');
      fireEvent.changeText(input, 'Tokyo');
    });

    // Debounce window has not elapsed — no new API call yet.
    expect(mockGetCatalog.mock.calls.length).toBe(callsAfterMount);

    // Wait for the single deferred call that fires after the debounce window.
    await waitFor(() => {
      expect(mockGetCatalog.mock.calls.length).toBe(callsAfterMount + 1);
    });

    // That single call must carry the final search term — not an intermediate one.
    const lastArgs = mockGetCatalog.mock.calls[mockGetCatalog.mock.calls.length - 1][0];
    expect(lastArgs.search).toBe('Tokyo');
  });
});
