/**
 * media.watchChip.component.test.tsx
 *
 * Regression test for: tapping the Watch chip while Gems is the active mode
 * did nothing, because the overlay-variant AppHeader (position: absolute,
 * zIndex: 20, no pointerEvents override) sat above the mode-selector overlay
 * (zIndex: 10) and absorbed the touch before it reached the chips.
 *
 * Fix: AppHeader's overlayOuter View now sets pointerEvents="box-none" so the
 * container itself is transparent to touches while its own children (back
 * chevron, action buttons) remain interactive.
 *
 * Structure note: this file starts already in Gems mode (via a persisted
 * AsyncStorage value resolved during the initial render flush) so that the
 * single fireEvent.press in this file is the Watch-chip tap itself — the
 * renderer's one-press-commit-per-file budget (see
 * .agents/memory/rntl-react19-renderer-budget.md) then applies to the tap
 * under test, not to an unrelated setup press.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { screen, render, act, fireEvent } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// ── Safe-area ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── useBottomInset ────────────────────────────────────────────────────────────
// NOTE: intentional stub — bottom inset value not under test.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  useBottomInset: () => 34,
  useLayoverAwareBottomInset: () => 34,
}));

// ── mediaEvents ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — event emission not under test.
jest.mock('../../../src/lib/mediaEvents.ts', () => ({
  mediaEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));

// ── Feature flags — all three modes enabled ────────────────────────────────────
// NOTE: exhaustive stub intentional — real context requires Supabase + network;
// this test only needs every mode flag enabled.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: () => true,
    loading: false,
  }),
}));

// ── AsyncStorage — pre-seed with 'gems' so the screen mounts already in Gems
// mode once the store's restore effect resolves, without needing a press.
// NOTE: exhaustive stub intentional — only the four methods mediaStore.ts
// calls (getItem/setItem/removeItem/clear) need to exist for this test.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => 'gems'),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

// ── Heavy feed components — stub out to avoid their transitive deps ───────────
// NOTE: intentional stubs — only the mode shell (selector) is under test.
jest.mock('../../../src/components/media/WatchFeed.tsx', () => ({
  WatchFeed: () => null,
}));
jest.mock('../../../src/components/media/GridFeed.tsx', () => ({
  GridFeed: () => null,
}));
// NOTE: intentional stub — GemsFeed pulls in map/location deps; only shell tested.
jest.mock('../../../src/components/media/GemsFeed.tsx', () => ({
  GemsFeed: () => null,
}));
// NOTE: intentional stub — MediaQuickCreateSheet pulls in sheet deps; only shell tested.
jest.mock('../../../src/components/media/MediaQuickCreateSheet.tsx', () => ({
  MediaQuickCreateSheet: () => null,
}));

// lucide-react-native is covered by the global Proxy mock in jest.config moduleNameMapper.

// ── Import after mocks ────────────────────────────────────────────────────────

import MediaScreen from '../media.tsx';

// ─────────────────────────────────────────────────────────────────────────────

describe('MediaScreen — Watch chip reachable through overlay AppHeader', () => {
  it('tapping Watch while Gems is active switches the view to the Watch feed', async () => {
    await act(async () => { render(<MediaScreen />); });

    // Sanity: the persisted 'gems' value has been restored — Gems is active.
    expect(screen.getByTestId('mode-chip-gems').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('mode-chip-watch').props.accessibilityState.selected).toBe(false);

    // Tap Watch — before the fix, the overlay AppHeader absorbed this touch
    // and onSelect('watch') was never called.
    await act(async () => {
      fireEvent.press(screen.getByTestId('mode-chip-watch'));
    });

    expect(screen.getByTestId('mode-chip-watch').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('mode-chip-gems').props.accessibilityState.selected).toBe(false);
  });
});
