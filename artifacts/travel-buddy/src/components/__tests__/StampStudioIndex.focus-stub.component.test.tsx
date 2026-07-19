/**
 * StampStudioIndex — file-level focus-stub single-fetch guarantee.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * The file-level expo-router stub (src/__mocks__/expo-router.tsx) maps
 * useFocusEffect to React.useEffect(cb, []), which fires exactly once on
 * mount — just like the real hook fires on initial screen focus.
 *
 * Because StampStudioIndex's useFocusEffect callback has a firstFocusRef
 * guard that skips refreshCatalog() on the first invocation, the component
 * should call getAdminStampCatalog exactly once per mount (from the
 * useEffect load() call) — not twice.
 *
 * These tests confirm that guarantee using the shared file-level stub only,
 * with no local jest.mock('expo-router', ...) override.  Any regression
 * that removes the firstFocusRef guard, or changes useFocusEffect to fire
 * refreshCatalog unconditionally on mount, will cause the call count to
 * jump from 1 to 2 and fail here.
 *
 * ## No local expo-router mock
 *
 * The jest.config.js moduleNameMapper already points expo-router at
 * src/__mocks__/expo-router.tsx.  There is intentionally no jest.mock(
 * 'expo-router', ...) in this file so that the shared stub is exercised.
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import StampStudioIndex from '../../../app/admin/stamps/index.tsx';
import {
  getAdminStampCatalog,
  getStampWorkerHealth,
} from '../../services/adminStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────
// expo-router is intentionally NOT mocked here — the file-level stub from
// src/__mocks__/expo-router.tsx (registered via jest.config moduleNameMapper)
// is used instead.

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../services/adminStamps', () => ({
  ...jest.requireActual('../../services/adminStamps'),
  getAdminStampCatalog: jest.fn(),
  getStampWorkerHealth: jest.fn(),
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockGetCatalog = getAdminStampCatalog as jest.Mock;
const mockGetHealth  = getStampWorkerHealth as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function catalogOk(approved: number) {
  return {
    ok: true as const,
    data: {
      entries: [],
      total: 0,
      page: 1,
      statusCounts: {
        pending_artwork: 0,
        review_required: 0,
        approved,
        rejected: 0,
        archived: 0,
        retryable_failed: 0,
      },
    },
  };
}

// ── Suite: file-level focus-stub single-fetch guarantee ───────────────────────

describe('StampStudioIndex — file-level focus stub fires exactly once per mount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHealth.mockResolvedValue({ ok: false });
  });

  it('calls getAdminStampCatalog exactly once on initial mount — no double-fetch from focus stub', async () => {
    // The file-level stub maps useFocusEffect → useEffect(cb, []).
    // On mount both the component's useEffect (load) and the stub's
    // useEffect (useFocusEffect body) fire.  The firstFocusRef guard inside
    // the useFocusEffect callback must prevent a second getAdminStampCatalog
    // call, leaving the total at exactly 1.
    mockGetCatalog.mockResolvedValue(catalogOk(42));

    const { findByText, unmount } = await render(<StampStudioIndex />);

    // Wait for the async load() to settle — the approved tile shows "42".
    await findByText('42');

    // Exactly one call — the useFocusEffect path was suppressed by firstFocusRef.
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

  });

  it('increments the call count by exactly one on remount — not two', async () => {
    // Use distinct approved counts so findByText is unambiguous per mount.
    mockGetCatalog
      .mockResolvedValueOnce(catalogOk(42))   // first mount
      .mockResolvedValueOnce(catalogOk(99));  // second mount

    // ── First mount ───────────────────────────────────────────────────────────
    const { findByText: find1, unmount } = await render(<StampStudioIndex />);
    await find1('42');

    // Exactly 1 call after the first mount.
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    await unmount();

    // ── Second mount (new component instance — firstFocusRef resets) ──────────
    const { findByText: find2 } = await render(<StampStudioIndex />);
    await find2('99');

    // Exactly 1 additional call — total is 2, not 3 or more.
    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  });
});
