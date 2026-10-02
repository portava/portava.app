/**
 * media.worldDefault.component.test.tsx — the owner's surface decision F1 as a
 * flag (census-media §34): MEDIA_TAB_WORLD_DEFAULT_ENABLED, seeded OFF (3340),
 * effective only with MEDIA_WORLD_SHELL_ENABLED (2300).
 *
 *   OFF (either flag) — exactly today: Watch · Grid · Gems, the tab opens on
 *     Watch (or the persisted mode), and the World pill shows when the shell
 *     flag alone is on.
 *   ON (both)         — World is listed first and the tab opens on it, on every
 *     launch, even over a persisted Watch; Watch is one tap away; the pill is
 *     gone because World is a mode.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { screen, render, act, within } from '@testing-library/react-native';

// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// NOTE: intentional stub — insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — bottom inset value not under test.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  useBottomInset: () => 34,
  useLayoverAwareBottomInset: () => 34,
}));

// NOTE: intentional stub — event emission not under test.
jest.mock('../../../src/lib/mediaEvents.ts', () => ({
  mediaEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));

// NOTE: exhaustive stub intentional — the real context fetches over the
// network; each test sets the flag values it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => mockFlags[key] ?? false,
    loading: false,
  }),
}));

// NOTE: intentional stubs — only the tab shell's choice of surface is under test.
jest.mock('../../../src/components/media/WatchFeed.tsx', () => {
  const { View: V } = require('react-native');
  return { WatchFeed: () => <V testID="watch-feed" /> };
});
jest.mock('../../../src/components/media/GridFeed.tsx', () => {
  const { View: V } = require('react-native');
  return { GridFeed: () => <V testID="grid-feed" /> };
});
// NOTE: intentional stub — GemsFeed pulls in map/location deps.
jest.mock('../../../src/components/media/GemsFeed.tsx', () => ({
  GemsFeed: () => null,
}));
// NOTE: intentional stub — the sheet's own deps are not under test.
jest.mock('../../../src/components/media/MediaQuickCreateSheet.tsx', () => ({
  MediaQuickCreateSheet: () => null,
}));
// NOTE: intentional stub — the World shell has its own suite
// (MediaWorldShell.component.test.tsx); here only "is it the surface the tab
// mounts, and does it carry the tab's mode switcher" is asked.
jest.mock('../../../src/features/media/screens/MediaWorldTabSurface.tsx', () => {
  const { View: V } = require('react-native');
  return {
    MediaWorldTabSurface: ({ modeSwitcher }: { modeSwitcher?: React.ReactNode }) => (
      <V testID="world-surface">{modeSwitcher}</V>
    ),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import MediaScreen from '../media.tsx';

const STORAGE_KEY = '@travel_buddy/media_selected_mode';
const MODES_ON = {
  MEDIA_VIEW_MODE_FULLSCREEN_ENABLED: true,
  MEDIA_VIEW_MODE_GRID_ENABLED: true,
  MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true,
};
const SHELL = { MEDIA_WORLD_SHELL_ENABLED: true };
const WORLD_DEFAULT = { MEDIA_TAB_WORLD_DEFAULT_ENABLED: true };

async function open(flags: Record<string, boolean>, persisted?: string) {
  mockFlags = flags;
  await AsyncStorage.clear();
  if (persisted) await AsyncStorage.setItem(STORAGE_KEY, persisted);
  await act(async () => { render(<MediaScreen />); });
  await act(async () => {}); // let the persisted-mode restore settle
}

const chipOrder = () =>
  screen.queryAllByTestId(/^mode-chip-/).map((n) => String(n.props.testID).replace('mode-chip-', ''));

describe('Media tab — F1 flag OFF is exactly today', () => {
  beforeEach(() => jest.clearAllMocks());

  it('both flags off: Watch · Grid · Gems, opens on Watch, no World surface, no pill', async () => {
    await open({ ...MODES_ON });
    expect(chipOrder()).toEqual(['watch', 'grid', 'gems']);
    expect(screen.getByTestId('watch-feed')).toBeTruthy();
    expect(screen.queryByTestId('world-surface')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open the World media shell' })).toBeNull();
  });

  it('shell on, F1 off: today\'s shell-flag behaviour — the World pill, the tab still opens on Watch', async () => {
    await open({ ...MODES_ON, ...SHELL });
    expect(chipOrder()).toEqual(['watch', 'grid', 'gems']);
    expect(screen.getByTestId('watch-feed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the World media shell' })).toBeTruthy();
  });

  it('F1 on, shell off: nothing changes — World needs the shell flag', async () => {
    await open({ ...MODES_ON, ...WORLD_DEFAULT });
    expect(chipOrder()).toEqual(['watch', 'grid', 'gems']);
    expect(screen.getByTestId('watch-feed')).toBeTruthy();
    expect(screen.queryByTestId('world-surface')).toBeNull();
  });

  it('F1 off: a persisted mode is restored, as today', async () => {
    await open({ ...MODES_ON }, 'grid');
    expect(screen.getByTestId('grid-feed')).toBeTruthy();
    expect(screen.queryByTestId('watch-feed')).toBeNull();
  });
});

describe('Media tab — F1 flag ON (with the shell)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('opens on the World surface, lists World first, and mounts no Watch feed', async () => {
    await open({ ...MODES_ON, ...SHELL, ...WORLD_DEFAULT });
    expect(screen.getByTestId('world-surface')).toBeTruthy();
    expect(screen.queryByTestId('watch-feed')).toBeNull();
    expect(chipOrder()).toEqual(['world', 'watch', 'grid', 'gems']);
    // the switcher is INSIDE the World surface (under its header), not overlaid on it
    const world = screen.getByTestId('world-surface');
    expect(within(world).getByTestId('mode-chip-world').props.accessibilityState.selected).toBe(true);
    expect(within(world).getByTestId('mode-chip-watch').props.accessibilityState.selected).toBe(false);
    // World is a mode now, so the pill that pushed /media-world is gone
    expect(screen.queryByRole('button', { name: 'Open the World media shell' })).toBeNull();
  });

  it('opens on World even when Watch was the persisted mode (MD427: no full-screen video on open)', async () => {
    await open({ ...MODES_ON, ...SHELL, ...WORLD_DEFAULT }, 'watch');
    expect(screen.getByTestId('world-surface')).toBeTruthy();
    expect(screen.queryByTestId('watch-feed')).toBeNull();
  });

  // "Watch stays one tap away" is a press, and this renderer commits one press
  // per file (.agents/memory/rntl-react19-renderer-budget.md), so it has its own
  // file: media.worldDefaultSwitch.component.test.tsx.

  it('with Watch removed by its own flag, the tab still opens on World', async () => {
    await open({ MEDIA_VIEW_MODE_GRID_ENABLED: true, ...SHELL, ...WORLD_DEFAULT });
    expect(screen.getByTestId('world-surface')).toBeTruthy();
    expect(chipOrder()).toEqual(['world', 'grid']);
  });
});

