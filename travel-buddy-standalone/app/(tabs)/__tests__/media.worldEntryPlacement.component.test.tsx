/**
 * media.worldEntryPlacement.component.test.tsx — where the World shell entry is drawn.
 *
 * With MEDIA_WORLD_SHELL_ENABLED on (and World not yet a mode), the entry was a floating pill at insets.top + 8 in every
 * mode. In Watch and Gems the overlay AppHeader (zIndex 20, tinted) covers that band, so the pill was drawn under the
 * header's tint (the 2026-10-22 layout hunt). It is now an action IN that header in Watch / Gems, and stays the
 * labelled pill in Grid, where no header covers it.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { screen, render, act, within, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';

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


const WORLD = { name: 'Open the World media shell' };

/** The nearest ancestor (or self) whose flattened style matches every key of `want`. */
function ancestorWith(node: any, want: Record<string, unknown>): any {
  for (let n = node; n; n = n.parent) {
    const st = StyleSheet.flatten(n.props?.style) ?? {};
    if (Object.entries(want).every(([k, v]) => st[k] === v)) return n;
  }
  return null;
}

describe('Media tab — the World entry is never under the overlay header', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Watch: the entry is an icon action inside the overlay header, and opens /media-world', async () => {
    await open({ ...MODES_ON, ...SHELL }, 'watch');
    const btn = screen.getByRole('button', WORLD);
    expect(within(btn).queryByText('World')).toBeNull(); // the header slot carries the icon, not the floating pill
    expect(ancestorWith(btn, { width: 36, height: 36 })).not.toBeNull(); // AppHeader's action slot
    expect(ancestorWith(btn, { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20 })).not.toBeNull(); // its overlay bar
    await fireEvent.press(btn);
    expect(router.push).toHaveBeenCalledWith('/media-world');
    expect(screen.getAllByRole('button', WORLD)).toHaveLength(1); // no second, covered pill
  });

  it('Gems: the same header action', async () => {
    await open({ ...MODES_ON, ...SHELL }, 'gems');
    const btn = screen.getByRole('button', WORLD);
    expect(ancestorWith(btn, { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20 })).not.toBeNull();
    expect(screen.getAllByRole('button', WORLD)).toHaveLength(1);
  });

  it('Grid (no overlay header): the labelled pill, top-left under the safe area', async () => {
    await open({ ...MODES_ON, ...SHELL }, 'grid');
    const btn = screen.getByRole('button', WORLD);
    expect(within(btn).getByText('World')).toBeTruthy();
    expect(ancestorWith(btn, { position: 'absolute', left: 16, top: 8 })).not.toBeNull(); // insets.top 0 + 8
  });
});
