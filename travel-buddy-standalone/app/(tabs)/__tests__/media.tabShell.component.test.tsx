/**
 * media.tabShell.component.test.tsx
 *
 * Tests the MediaScreen (media.tsx) mode-selector shell behaviour:
 *
 *   Part A — Flag-gated mode chips
 *     1. With all three mode flags on, Watch / Grid / Gems chips all appear.
 *     2. Disabling MEDIA_VIEW_MODE_GRID_ENABLED hides the Grid chip.
 *     3. Disabling MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED hides the Gems chip.
 *     4. When only one mode is enabled, the mode selector is not rendered.
 *
 *   Part B — FAB button label
 *     5. In Watch mode (default) the FAB shows "Create a post".
 *     6. After selecting Gems, the FAB shows "Add a Gem".
 *
 * Chip presence/absence is queried by testID (mode-chip-watch / mode-chip-grid /
 * mode-chip-gems) rather than by text, because the overlay AppHeader also renders
 * the current mode name as its title — making getByText ambiguous.
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

// ── Feature flags — controlled by each test ───────────────────────────────────
// NOTE: exhaustive stub intentional — real context requires Supabase + network;
// we control flag values per-test via mockFlags.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => mockFlags[key] ?? false,
    loading: false,
  }),
}));

// ── Heavy feed components — stub out to avoid their transitive deps ───────────
// NOTE: intentional stubs — only the mode shell (selector + FAB) is under test.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderWithFlags(flags: Record<string, boolean>) {
  mockFlags = flags;
  await act(async () => { render(<MediaScreen />); });
}

const ALL_FLAGS_ON: Record<string, boolean> = {
  MEDIA_VIEW_MODE_FULLSCREEN_ENABLED: true,
  MEDIA_VIEW_MODE_GRID_ENABLED: true,
  MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true,
  MEDIA_HIDDEN_GEMS_NEARBY_ENABLED: true,
  MEDIA_HIDDEN_GEMS_CREATE_ENABLED: true,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('MediaScreen — mode-selector chips', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('all three chips (Watch, Grid, Gems) appear when all mode flags are on', async () => {
    await renderWithFlags(ALL_FLAGS_ON);
    // Query chips by testID — avoids ambiguity with the overlay header title.
    expect(screen.getByTestId('mode-chip-watch')).toBeTruthy();
    expect(screen.getByTestId('mode-chip-grid')).toBeTruthy();
    expect(screen.getByTestId('mode-chip-gems')).toBeTruthy();
  });

  it('Grid chip is absent when MEDIA_VIEW_MODE_GRID_ENABLED is off', async () => {
    await renderWithFlags({ ...ALL_FLAGS_ON, MEDIA_VIEW_MODE_GRID_ENABLED: false });
    expect(screen.getByTestId('mode-chip-watch')).toBeTruthy();
    expect(screen.queryByTestId('mode-chip-grid')).toBeNull();
    expect(screen.getByTestId('mode-chip-gems')).toBeTruthy();
  });

  it('Gems chip is absent when MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED is off', async () => {
    await renderWithFlags({ ...ALL_FLAGS_ON, MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: false });
    expect(screen.getByTestId('mode-chip-watch')).toBeTruthy();
    expect(screen.getByTestId('mode-chip-grid')).toBeTruthy();
    expect(screen.queryByTestId('mode-chip-gems')).toBeNull();
  });

  it('mode selector is not rendered when only one mode is enabled', async () => {
    await renderWithFlags({
      MEDIA_VIEW_MODE_FULLSCREEN_ENABLED: true,
      MEDIA_VIEW_MODE_GRID_ENABLED: false,
      MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: false,
    });
    // Selector only renders when enabledModes.length > 1 — confirm no chips.
    expect(screen.queryByTestId('mode-chip-watch')).toBeNull();
    expect(screen.queryByTestId('mode-chip-grid')).toBeNull();
    expect(screen.queryByTestId('mode-chip-gems')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MediaScreen — FAB button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('FAB label is "Create a post" in Watch mode (default)', async () => {
    await renderWithFlags(ALL_FLAGS_ON);
    expect(screen.getByRole('button', { name: 'Create a post' })).toBeTruthy();
  });

  it('FAB label switches to "Add a Gem" after selecting Gems mode', async () => {
    await renderWithFlags(ALL_FLAGS_ON);

    // Tap the Gems chip to switch mode — use testID to avoid text ambiguity.
    fireEvent.press(screen.getByTestId('mode-chip-gems'));
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Add a Gem' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create a post' })).toBeNull();
  });

});
