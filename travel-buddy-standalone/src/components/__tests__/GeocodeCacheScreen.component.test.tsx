/**
 * GeocodeCacheScreen — PUT correction flow component tests.
 *
 * ## What's covered
 *
 * 1. The "Correct" pencil button opens the correction overlay.
 * 2. PUT without repair_catalog returns xx_entries_pending = 0  → no banner.
 * 3. PUT without repair_catalog returns xx_entries_pending > 0  → warning banner appears.
 * 4. PUT failure → error alert shown, no banner.
 *
 * ## Test ordering rationale
 *
 * Each test gets a fresh component render (RTLT re-mounts between `it` blocks).
 * Cross-test contamination from `handleCorrect`'s async continuation is avoided
 * by ensuring every save-path test waits for the overlay to close before ending:
 *
 *   await waitFor(() => {
 *     expect(screen.queryByTestId('correct-modal')).toBeNull();
 *     …other assertions…
 *   });
 *
 * Waiting for the overlay to close (correcting = null) guarantees that React
 * has committed the entire batched update from `handleCorrect`'s continuation
 * (setCorrectingBusy, setRows, setWarnings, setCorrecting — all batched in one
 * microtask).  The `afterEach` drain then has nothing left to flush.
 *
 * The "no banner" test (test 2) runs before "banner appears" (test 3) so that
 * even if its `waitFor` resolves slightly early, the banner-appears test starts
 * from a clean fiber.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor, screen, fireEvent, act } from '@testing-library/react-native';
import AdminGeocodeCacheScreen from '../../../app/admin/geocode-cache.tsx';
import {
  getGeocodeCacheRows,
  deleteGeocodeCacheRow,
  putGeocodeCacheRow,
} from '../../services/adminGeocode.ts';

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

jest.mock('../../services/adminGeocode', () => ({
  getGeocodeCacheRows:   jest.fn(),
  deleteGeocodeCacheRow: jest.fn(),
  putGeocodeCacheRow:    jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  AlertTriangle: () => null,
  ArrowLeft:     () => null,
  Pencil:        () => null,
  Search:        () => null,
  Trash2:        () => null,
  Wrench:        () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetRows = getGeocodeCacheRows   as jest.Mock;
const mockDelete  = deleteGeocodeCacheRow as jest.Mock;
const mockPut     = putGeocodeCacheRow    as jest.Mock;

// ── Response builders ──────────────────────────────────────────────────────────

function rowsOk() {
  return {
    ok: true as const,
    data: {
      rows: [{
        city_key:     'paris__fr',
        country:      'Unknown',
        country_code: 'XX',
        resolved_at:  null,
        updated_at:   '2026-07-01T10:00:00Z',
      }],
    },
  };
}

function putOk(xxEntriesPending?: number) {
  return {
    ok: true as const,
    data: {
      updated:            true as const,
      city_key:           'paris__fr',
      country_code:       'FR',
      country:            'France',
      xx_entries_pending: xxEntriesPending,
    },
  };
}

function putFail(error = 'Network error') {
  return { ok: false as const, error };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('GeocodeCacheScreen — PUT correction warning banner', () => {
  beforeEach(() => {
    mockGetRows.mockReset();
    mockDelete.mockReset();
    mockPut.mockReset();

    mockGetRows.mockResolvedValue(rowsOk());
    mockDelete.mockResolvedValue({ ok: true, data: { deleted: true, city_key: 'paris__fr' } });
    mockPut.mockResolvedValue(putOk(0));
  });

  afterEach(async () => {
    // Drain any React concurrent work that `handleCorrect`'s async continuation
    // may have scheduled outside of act().  This runs before RTLT's automatic
    // cleanup so the fiber tree is fully settled before unmount.
    await act(async () => {});
    jest.clearAllMocks();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function waitForRow() {
    await screen.findByTestId('geocode-row-paris__fr');
  }

  async function openModal() {
    await act(async () => {
      fireEvent.press(screen.getByTestId('correct-btn-paris__fr'));
    });
    await waitFor(() => screen.getByTestId('correct-country-code-input'));
  }

  async function submitForm(cc = 'FR', country = 'France') {
    // Commit the onChangeText → setCorrecting updater calls before pressing
    // Save.  handleCorrect reads `correcting` from the render closure, so the
    // state must be committed (re-render complete) before onPress fires.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('correct-country-code-input'), cc);
      fireEvent.changeText(screen.getByTestId('correct-country-input'), country);
    });
    fireEvent.press(screen.getByTestId('correct-save-btn'));
  }

  // ── 1. Overlay opens ───────────────────────────────────────────────────────

  it('pressing the Correct button opens the correction overlay', async () => {
    await render(<AdminGeocodeCacheScreen />);
    await waitForRow();
    await openModal();

    expect(screen.getByTestId('correct-country-code-input')).toBeTruthy();
    expect(screen.getByTestId('correct-country-input')).toBeTruthy();
  });

  // ── 2. pending = 0 → no banner ─────────────────────────────────────────────
  //
  // Run before test 3 (banner appears) so that if any deferred work escapes
  // this test's waitFor it settles on a zeroed warning set — not a non-zero one
  // that could mislead the banner assertion in test 3.
  //
  // The waitFor waits for `correct-modal` to disappear (overlay closed) before
  // checking the absence of a banner.  This ensures handleCorrect's entire
  // batched continuation (setRows + setWarnings([]) + setCorrecting(null)) has
  // been committed before the assertion runs — otherwise the trivially-absent
  // banner would let the test pass before the async work is drained.

  it('PUT without repair_catalog returns xx_entries_pending = 0 → no banner', async () => {
    mockPut.mockResolvedValue(putOk(0));

    await render(<AdminGeocodeCacheScreen />);
    await waitForRow();
    await openModal();
    await submitForm();

    // Wait for the overlay to close AND confirm no banner — this forces React
    // to commit the full handleCorrect continuation before the assertion passes.
    await waitFor(() => {
      expect(screen.queryByTestId('correct-modal')).toBeNull();
      expect(screen.queryByTestId('xx-warning-paris__fr')).toBeNull();
    });

    expect(mockPut).toHaveBeenCalledWith('paris__fr', {
      country_code: 'FR',
      country:      'France',
    });
  });

  // ── 3. pending > 0 → banner appears ───────────────────────────────────────
  //
  // Proves the end-to-end wiring: PUT without repair_catalog returns a non-zero
  // xx_entries_pending → the warning banner surfaces and shows the exact count.

  it('PUT without repair_catalog returns xx_entries_pending > 0 → warning banner appears', async () => {
    mockPut.mockResolvedValue(putOk(3));

    await render(<AdminGeocodeCacheScreen />);
    await waitForRow();
    await openModal();
    await submitForm();

    // Waiting for the banner confirms the setWarnings update committed.
    // React batches all handleCorrect continuation updates in one microtask, so
    // when the banner is visible, setCorrecting(null) is also committed.
    await waitFor(() =>
      expect(screen.getByTestId('xx-warning-paris__fr')).toBeTruthy(),
    );

    const bannerText = screen.getByTestId('xx-warning-text-paris__fr');
    expect(bannerText.props.children[0]).toBe(3);
  });

  // ── 4. PUT failure → alert, no banner ──────────────────────────────────────

  it('PUT failure shows an error alert and no warning banner', async () => {
    mockPut.mockResolvedValue(putFail('Forbidden'));

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      await render(<AdminGeocodeCacheScreen />);
      await waitForRow();
      await openModal();
      await submitForm();

      // Alert.alert is called in handleCorrect's continuation; waitFor flushes
      // the microtask and commits setCorrectingBusy(false) in the same pass.
      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith('Correction failed', 'Forbidden'),
      );
      expect(screen.queryByTestId('xx-warning-paris__fr')).toBeNull();
    } finally {
      alertSpy.mockRestore();
    }
  });
});
