/**
 * StampCatalogDetail — error-banner tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When the initial load returns { ok: false } the screen renders a
 *    user-visible error message (testID "catalog-detail-error") instead of
 *    silently showing a blank screen or the misleading "Entry not found" text.
 *
 * 2. When a subsequent pull-to-refresh returns { ok: true } the error banner
 *    is removed and the entry content is shown — proving the error state is
 *    cleared on success, not left stuck on screen.
 *
 * ## Why these tests exist
 *
 * Before the error-state fix, load() had no else branch for !res.ok.  On an
 * initial fetch failure detail stayed null and loading flipped to false, so
 * the screen rendered "Entry not found" — indistinguishable from a real 404.
 * On a refresh failure after a successful load the UI silently kept displaying
 * the stale data with no indication the refresh had failed.  These two tests
 * pin the corrected behaviour.
 *
 * ## Why act() wraps the initial render
 *
 * load() is async; state updates (setError, setLoading) fire outside the
 * synchronous render cycle.  Wrapping render() in act(async () => {...})
 * flushes all pending microtasks and state updates before the assertions run,
 * avoiding the "not configured to support act()" warnings and the
 * "render function has not been called" race seen under React 19 + RNTL 14
 * when waitFor starts polling before the initial async load has settled.
 *
 * ## How pull-to-refresh is simulated
 *
 * The ScrollView is found by testID ("catalog-detail-scroll") and its
 * refreshControl.props.onRefresh() is called inside act() — the same pattern
 * used by the StampQueueScreen pull-to-refresh suite.
 */

import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import StampCatalogDetail from '../../../app/admin/stamps/[catalogId]';
import { getAdminCatalogEntry, activateStampVersion } from '../../services/adminStamps';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ catalogId: 'cat-abc' })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps', () => ({
  getAdminCatalogEntry:    jest.fn(),
  activateStampVersion:    jest.fn(),
  rejectCatalogEntry:      jest.fn(),
  regenerateCatalogEntry:  jest.fn(),
  CURRENT_STYLE_VERSION:   'v1',
}));

jest.mock('lucide-react-native', () => ({
  ArrowLeft:     () => null,
  CheckCircle:   () => null,
  XCircle:       () => null,
  RefreshCw:     () => null,
  TriangleAlert: () => null,
}));

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const mockGetEntry  = getAdminCatalogEntry as jest.Mock;
const mockActivate  = activateStampVersion as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function detailOk() {
  return {
    ok: true as const,
    data: {
      entry: {
        id: 'cat-abc',
        display_name: 'Paris Eiffel',
        stamp_type: 'landmark',
        country: 'France',
        country_code: 'FR',
        city: 'Paris',
        canonical_location_key: 'fr::paris',
        status: 'pending_artwork',
        earn_count: 0,
      },
      versions:   [],
      queue:      null,
      audit:      [],
      earnSample: [],
    },
  };
}

function detailOkWithCandidate() {
  const base = detailOk();
  return {
    ...base,
    data: {
      ...base.data,
      versions: [
        {
          id: 'ver-1',
          status: 'candidate',
          public_url: 'https://example.com/candidate.png',
          provider: 'ai',
          prompt_template_version: 'v1',
        },
      ],
    },
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('StampCatalogDetail — API error banner', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an error message when getAdminCatalogEntry returns ok: false', async () => {
    mockGetEntry.mockResolvedValue({ ok: false });

    // Wrap in act() to flush the async load() call and its state updates
    // (setError, setLoading) before asserting — avoids the act() boundary
    // warnings and the "render function has not been called" race under
    // React 19 + RNTL 14.
    await act(async () => { render(<StampCatalogDetail />); });

    expect(screen.getByTestId('catalog-detail-error')).toBeTruthy();
    expect(screen.getByText('Failed to load entry. Please try again.')).toBeTruthy();
  });

  it('clears the error and shows entry content when a subsequent load succeeds', async () => {
    mockGetEntry
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue(detailOk());

    await act(async () => { render(<StampCatalogDetail />); });

    // Error banner is visible after initial failing load.
    expect(screen.getByTestId('catalog-detail-error')).toBeTruthy();

    // Simulate pull-to-refresh via the ScrollView's refreshControl.
    const scroll = screen.getByTestId('catalog-detail-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    // Entry content should now be visible and error banner gone.
    await waitFor(() => screen.getByText('Paris Eiffel'));
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
    expect(screen.queryByTestId('catalog-detail-error')).toBeNull();
  });

  it('clears the error banner when an action-triggered reload succeeds after a refresh error', async () => {
    // Initial load succeeds (with a candidate), refresh fails, then all
    // subsequent loads succeed again.
    mockGetEntry
      .mockResolvedValueOnce(detailOkWithCandidate()) // initial load
      .mockResolvedValueOnce({ ok: false })           // pull-to-refresh fails
      .mockResolvedValue(detailOkWithCandidate());    // reload after action

    mockActivate.mockResolvedValue({ ok: true });

    await act(async () => { render(<StampCatalogDetail />); });

    // Content is visible, no error banner.
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
    expect(screen.queryByTestId('catalog-detail-error')).toBeNull();

    // Pull-to-refresh fails → banner appears over the (stale) content.
    const scroll = screen.getByTestId('catalog-detail-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });
    expect(screen.getByTestId('catalog-detail-error')).toBeTruthy();

    // Trigger an action: activating a candidate calls load() again on success.
    await act(async () => { fireEvent.press(screen.getByText('Set as Active')); });

    // The successful action-triggered reload must clear the error banner.
    await waitFor(() => expect(screen.queryByTestId('catalog-detail-error')).toBeNull());
    expect(screen.getByText('Paris Eiffel')).toBeTruthy();
    expect(mockActivate).toHaveBeenCalledWith('cat-abc', 'ver-1', expect.any(String));
  });
});
