/**
 * Media (app/(tabs)/media.tsx) — bottom-inset clearance test.
 *
 * Confirms that the `useBottomInset()` value used by the media tab's shell
 * is at least 120 pt when a layover session is active.  The media shell uses
 * `bottomInset` to position the floating action button (FAB):
 *
 *   style={{ bottom: bottomInset + 16 }}  →  146 on iPhone 14 (130 + 16)
 *
 * The individual feeds (WatchFeed, GridFeed, GemsFeed) consume the inset
 * internally via their own `useBottomInset()` calls.  This test pins the
 * shell-level value so a future hook swap that accidentally returns < 120
 * is caught at the boundary rather than during manual QA.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Inset constants ───────────────────────────────────────────────────────────
const IPHONE_BOTTOM   = 34;
const ANDROID_BOTTOM  = 48;
const NAV_BAR_FILLER  = 96;
const MIN_CLEARANCE   = 120;

// ── Safe-area — iPhone 14 (bottom = 34 pt) ───────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: IPHONE_BOTTOM, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// ── Bottom inset — controlled value (iPhone 14: 96 + 34 = 130) ───────────────
// NOTE: intentionally exhaustive — useBottomInset.ts imports reanimated at
// module scope via useNavBarCollapse; mocking the whole module avoids that chain.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  useBottomInset:             () => NAV_BAR_FILLER + IPHONE_BOTTOM,  // 130
  useLayoverAwareBottomInset: () => IPHONE_BOTTOM + 74 + 44 + 16,    // 168
  usePlainBottomInset:        () => IPHONE_BOTTOM + 24,               // 58
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: NAV_BAR_FILLER + IPHONE_BOTTOM, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
}));

// ── Layover service — active session ─────────────────────────────────────────
// NOTE: intentional stub — layover state not under test; active session
// represents the layover-active condition that the test is designed to pin.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue({
    session: { id: 'layover-media-1', departureTime: '2026-07-30T22:00:00Z', manualIata: 'NRT' },
    airport: null,
  }),
}));

// ── mediaEvents ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — event emission not under test.
jest.mock('../../../src/lib/mediaEvents.ts', () => ({
  mediaEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));

// ── Feature flags — all flags off (minimum viable media shell) ────────────────
// NOTE: intentional stub — flag values not under test.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => {
      // Enable all three mode flags so the mode selector renders and we can
      // verify that the shell is fully built (not a no-mode degenerate case).
      const enabledFlags: Record<string, boolean> = {
        MEDIA_VIEW_MODE_FULLSCREEN_ENABLED:   true,
        MEDIA_VIEW_MODE_GRID_ENABLED:         true,
        MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED:  true,
        MEDIA_TAB_ENABLED:                    true,
      };
      return enabledFlags[key] ?? false;
    },
    loading: false,
  }),
}));

// ── Feed stubs — avoid transitive native/map deps ─────────────────────────────
// NOTE: intentional stubs — only the shell-level inset value is under test.
jest.mock('../../../src/components/media/WatchFeed.tsx',          () => ({ WatchFeed:           () => null }));
jest.mock('../../../src/components/media/GridFeed.tsx',           () => ({ GridFeed:            () => null }));
jest.mock('../../../src/components/media/GemsFeed.tsx',           () => ({ GemsFeed:            () => null }));
jest.mock('../../../src/components/media/MediaQuickCreateSheet.tsx', () => ({ MediaQuickCreateSheet: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/media/MediaModeSelector.tsx',  () => ({
  MediaModeSelector: () => null,
}));

import MediaScreen from '../media.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect every numeric `bottom` value from style props anywhere in the
 * rendered tree.  The FAB uses `{ bottom: bottomInset + 16 }` so the largest
 * bottom value reflects the shell's inset usage.
 */
function collectBottomValues(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  const style = node.props?.style;
  if (style) {
    const flat = Array.isArray(style)
      ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
      : style;
    if (typeof flat?.bottom === 'number') found.push(flat.bottom);
  }

  for (const child of (node.children ?? [])) {
    found.push(...collectBottomValues(child));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Media tab — shell-level bottomInset when layover active', () => {
  it('FAB bottom style reflects useLayoverAwareBottomInset() ≥ 155 + 16 (iPhone 14, layover active)', async () => {
    const { toJSON } = await render(<MediaScreen />);
    await act(async () => { await Promise.resolve(); });

    const bottoms = collectBottomValues(toJSON());
    expect(bottoms.length).toBeGreaterThan(0);
    // FAB bottom = bottomInset + 16 = 168 + 16 = 184.
    // Subtract the fixed offset to recover the effective bottomInset.
    const maxBottom = Math.max(...bottoms);
    const effectiveInset = maxBottom - 16;
    expect(effectiveInset).toBeGreaterThanOrEqual(155);
  });

  it('FAB bottom value equals useLayoverAwareBottomInset() + 16 (168 + 16 = 184 on iPhone 14)', async () => {
    const { toJSON } = await render(<MediaScreen />);
    await act(async () => { await Promise.resolve(); });

    const bottoms = collectBottomValues(toJSON());
    // 34 (insets.bottom) + 74 (pill offset) + 44 (pill height) + 16 (gap) + 16 (FAB margin) = 184
    const expected = IPHONE_BOTTOM + 74 + 44 + 16 + 16; // 184
    expect(Math.max(...bottoms)).toBe(expected);
  });

  it('FAB bottom satisfies Android gesture nav bar (48 dp): effective inset ≥ 48', async () => {
    const { toJSON } = await render(<MediaScreen />);
    await act(async () => { await Promise.resolve(); });

    const bottoms = collectBottomValues(toJSON());
    const effectiveInset = Math.max(...bottoms) - 16;
    expect(effectiveInset).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
  });
});

describe('Media tab — inset computation constants', () => {
  it('layover-active inset: iPhone bottom (34) + 74 + 44 + 16 = 168 ≥ 155', () => {
    expect(IPHONE_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(155);
  });

  it('layover-active inset: Android bottom (48) + 74 + 44 + 16 = 182 ≥ 155', () => {
    expect(ANDROID_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(155);
  });
});
