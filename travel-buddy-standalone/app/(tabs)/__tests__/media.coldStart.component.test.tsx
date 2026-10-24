/**
 * media.coldStart.component.test.tsx — census-media MD286 / MD419 / MD427 (2026-10-24).
 *
 * While the feature flags are still loading, the store's default is 'watch' (the tab cannot yet know that
 * World is the default), so the full-screen Watch feed used to MOUNT — and autoplay — for the length of the flag
 * fetch on every cold start, before World replaced it. With the flags loading, no Watch feed is mounted; once they
 * land, World opens (both flags on), or Watch does (World off) — exactly as before.
 *
 *   C1  flags loading ⇒ no Watch feed
 *   C2  flags loaded, World on ⇒ the World surface, and still no Watch feed
 *   C3  CONTROL: flags loaded, World off ⇒ the Watch feed, as before
 */
import React from 'react';
import { screen, render, act } from '@testing-library/react-native';

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
// NOTE: exhaustive stub intentional — the flags and their loading state are the variable under test.
let mockFlags: Record<string, boolean> = {};
let mockLoading = true;
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: mockLoading }),
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
jest.mock('../../../src/components/media/GemsFeed.tsx', () => ({ GemsFeed: () => null }));
// NOTE: intentional stub — the sheet's own deps are not under test.
jest.mock('../../../src/components/media/MediaQuickCreateSheet.tsx', () => ({ MediaQuickCreateSheet: () => null }));
// NOTE: intentional stub — the World shell has its own suite.
jest.mock('../../../src/features/media/screens/MediaWorldTabSurface.tsx', () => {
  const { View: V } = require('react-native');
  return { MediaWorldTabSurface: () => <V testID="world-surface" /> };
});

import MediaScreen from '../media.tsx';

const WORLD_ON = { MEDIA_WORLD_SHELL_ENABLED: true, MEDIA_TAB_WORLD_DEFAULT_ENABLED: true, MEDIA_VIEW_MODE_FULLSCREEN_ENABLED: true, MEDIA_VIEW_MODE_GRID_ENABLED: true };
const WORLD_OFF = { MEDIA_VIEW_MODE_FULLSCREEN_ENABLED: true, MEDIA_VIEW_MODE_GRID_ENABLED: true };

describe('Media tab cold start — nothing autoplays before the flags load', () => {
  it('C1 flags loading: no Watch feed is mounted', async () => {
    mockFlags = WORLD_ON; mockLoading = true;
    await render(<MediaScreen />);
    expect(screen.queryByTestId('watch-feed')).toBeNull();
  });

  it('C2 flags loaded with World on: the World surface, and never the Watch feed', async () => {
    mockFlags = WORLD_ON; mockLoading = true;
    const view = await render(<MediaScreen />);
    expect(screen.queryByTestId('watch-feed')).toBeNull();
    mockLoading = false;
    await act(async () => { view.rerender(<MediaScreen />); await new Promise((r) => setTimeout(r, 0)); });
    expect(await screen.findByTestId('world-surface')).toBeTruthy();
    expect(screen.queryByTestId('watch-feed')).toBeNull();
  });

  it('C3 CONTROL: flags loaded with World off: the Watch feed, as before', async () => {
    mockFlags = WORLD_OFF; mockLoading = false;
    await render(<MediaScreen />);
    expect(await screen.findByTestId('watch-feed')).toBeTruthy();
  });
});
