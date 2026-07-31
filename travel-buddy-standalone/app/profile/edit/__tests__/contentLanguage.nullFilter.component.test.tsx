/**
 * useContentTranslation — null preferred_language disables translation offers.
 *
 * ## What's covered
 *
 * 1. When preferredLanguage is null ("Use device language"), canTranslate is
 *    false even when the content has a known source language — so no "See
 *    translation" toggle is offered in the feed.
 * 2. When preferredLanguage is set and differs from the source language,
 *    canTranslate is true (positive / regression guard).
 * 3. When preferredLanguage matches the source language, canTranslate is false
 *    (same-language short-circuit).
 *
 * ## Why this test exists
 *
 * The feed translation pipeline reads preferredLanguage from
 * LanguagePreferenceContext. If null were mishandled (e.g. treated as a
 * wildcard), every post in the feed would show a spurious "See translation"
 * toggle after the user chose "Use device language". These cases pin the
 * Boolean(originalLanguage && preferredLanguage && ...) guard.
 *
 * Separate from contentLanguage.useDevice.component.test.tsx — that file
 * uses fireEvent.press on a FlatList which leaves VirtualizedList internal
 * state that zeroes items in subsequent renders. renderHook needs a
 * fresh renderer (fresh file) to avoid that contamination.
 *
 * Run with: pnpm test:component
 */

import { act, renderHook } from '@testing-library/react-native';

// ── LanguagePreferenceContext — controlled per test ───────────────────────────

jest.mock('../../../../src/context/LanguagePreferenceContext', () => ({
  ...jest.requireActual('../../../../src/context/LanguagePreferenceContext'),
  useLanguagePreference: jest.fn(),
}));

// ── contentTranslation service — not under test ───────────────────────────────

// fetchContentTranslation is called by the auto-fetch effect when canTranslate
// is true. The mock must return a Promise or the .then() inside the effect
// throws and corrupts React's test renderer state for subsequent tests.
jest.mock('../../../../src/services/contentTranslation', () => ({
  ...jest.requireActual('../../../../src/services/contentTranslation'),
  fetchContentTranslation: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { useLanguagePreference } from '../../../../src/context/LanguagePreferenceContext.tsx';
import { useContentTranslation } from '../../../../src/hooks/useContentTranslation.ts';

const mockUseLanguagePreference = useLanguagePreference as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useContentTranslation — null preferred_language disables translation offers', () => {
  it('returns canTranslate=false when preferredLanguage is null, even with a known source language', async () => {
    mockUseLanguagePreference.mockReturnValue({
      preferredLanguage: null,
      loading: false,
      updateLanguage: jest.fn(),
    });

    // renderHook returns a Promise in this environment — must be awaited.
    const { result } = await renderHook(() =>
      useContentTranslation({
        entityType: 'post',
        entityId: 'post-abc',
        originalLanguage: 'es',
      }),
    );

    // canTranslate = Boolean(originalLanguage && preferredLanguage && ...)
    // → Boolean('es' && null && ...) → false
    expect(result.current.canTranslate).toBe(false);
    expect(result.current.translated).toBe(false);
  });

  it('returns canTranslate=true when preferredLanguage is set and differs from source language', async () => {
    mockUseLanguagePreference.mockReturnValue({
      preferredLanguage: 'en',
      loading: false,
      updateLanguage: jest.fn(),
    });

    const { result } = await renderHook(() =>
      useContentTranslation({
        entityType: 'post',
        entityId: 'post-abc',
        originalLanguage: 'es',
      }),
    );

    expect(result.current.canTranslate).toBe(true);
  });

  it('returns canTranslate=false when preferredLanguage matches the source language', async () => {
    mockUseLanguagePreference.mockReturnValue({
      preferredLanguage: 'es',
      loading: false,
      updateLanguage: jest.fn(),
    });

    const { result } = await renderHook(() =>
      useContentTranslation({
        entityType: 'post',
        entityId: 'post-abc',
        originalLanguage: 'es',
      }),
    );

    // Same language — Boolean('es' && 'es' && 'es' !== 'es') → false.
    expect(result.current.canTranslate).toBe(false);
  });
});
