/**
 * The flag-ON Media surfaces of census-media §34 rendered through react-dom
 * (jest-expo/web): the DOM a web build would paint, read in document order.
 * This is a DOM render, not a screenshot — pixels, native layout, the video
 * player and gestures need a device run (census-media §34.7).
 *
 *   F2 overlay (MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED) — Ask Compass precedes
 *     Stamp in the DOM, no Stamp/comment/save count is in the text, the place
 *     precedes the creator. OFF: today's rail, counts included.
 *   F2 tap-to-play (MEDIA_WATCH_TAP_TO_PLAY_ENABLED) — the "Tap to play" mark
 *     is in the DOM over a cell that is not playing.
 *   F1 (the World shell as the tab's mode) — the tab's mode switcher is drawn
 *     under the World header and above the lens bar.
 *
 * Runs via jest.web.config.js (pnpm run test:component).
 */
import React from 'react';
import { View } from 'react-native';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));
// NOTE: intentional stub — real insets not under test.
jest.mock('react-native-safe-area-context', () => {
  const { View: V } = require('react-native');
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, style }: any) => <V style={style}>{children}</V>,
  };
});
// NOTE: intentional stub — follow network/auth is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, loading: false, toggling: false, followsYou: false, followersCount: 0, followingCount: 0, toggle: jest.fn() }),
}));
// NOTE: exhaustive stub intentional — each render sets the flags it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: false }),
}));
// NOTE: intentional stub — the player is a device concern; records isActive.
const mockIsActive: Record<string, boolean> = {};
jest.mock('../../../components/media/WatchVideoCell.tsx', () => {
  const { View: V } = require('react-native');
  return {
    WatchVideoCell: ({ id, isActive }: { id: string; isActive: boolean }) => {
      mockIsActive[id] = isActive;
      return <V />;
    },
  };
});
// NOTE: intentional stub — the manager's lifecycle has its own suite.
jest.mock('../../../hooks/useWatchPlayback', () => ({
  useWatchPlayback: () => ({ registerRef: jest.fn(), unregisterRef: jest.fn(), setActiveId: jest.fn() }),
}));
// NOTE: intentional stub — the World fetches are not under test; an empty,
// successful world keeps every lens in its settled empty state.
jest.mock('../services/mediaProjection.ts', () => {
  const actual = jest.requireActual('../services/mediaProjection.ts');
  return {
    ...actual,
    fetchWorld: async () => ({ ok: true, data: actual.mapWorldProjection({ city: 'Da Nang', cityVisualState: [], forYouNow: [], changingNow: [] }) }),
    fetchMediaMap: async () => ({ ok: true, data: { clusters: [], totalPerspectives: 0, generatedAt: null } }),
    fetchTimeline: async () => ({ ok: true, data: actual.mapTimeline({}) }),
  };
});
// NOTE: intentionally exhaustive — the shell's experience sources pull the Supabase client.
jest.mock('../../../services/events.ts', () => ({
  listMyEvents: async () => ({ ok: true, data: { events: [] } }),
  listEvents: async () => ({ ok: true, data: { events: [] } }),
}));
// NOTE: intentionally exhaustive — see the events mock above.
jest.mock('../../../services/trips.ts', () => ({
  listMyTrips: async () => [],
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: async () => ({ ok: true, data: { enabled: false, objects: [] } }),
}));

import { WatchItemOverlay } from '../../../components/media/WatchItemOverlay.tsx';
import { WatchFeedList } from '../../../components/media/WatchFeedList.tsx';
import { MediaModeSelector } from '../../../components/media/MediaModeSelector.tsx';
import { MediaWorldShell } from '../screens/MediaWorldShell.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

const ITEM = {
  id: 'web-1', videoUrl: 'https://example.com/v.mp4', posterUrl: null, duration: null,
  creator: { id: 'c', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
  caption: 'Sunset from the pier', hashtags: [],
  place: { id: 'place-abc', name: 'An Thuong', city: 'Da Nang', country: 'Vietnam' },
  linkedEntity: null, audioLabel: null, likeCount: 10, commentCount: 23, saveCount: 31,
  likedByMe: false, savedByMe: false, stampItCount: 44,
} as MediaFeedItem;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function overlay() {
  return (
    <WatchItemOverlay
      item={ITEM}
      currentUserId="viewer-1"
      isSaved={false}
      onComment={() => {}}
      onSave={() => {}}
      onMore={() => {}}
      stampGroupRef={React.createRef<View>()}
      stampVisualIsStamped={false}
      stampVisualCount={57}
      stampButtonStyle={undefined}
      onStampPress={() => {}}
    />
  );
}

const labelsInOrder = () => Array.from(container.querySelectorAll('[aria-label]'), (n) => n.getAttribute('aria-label'));

describe('census-media §34 — flag-ON surfaces in the DOM', () => {
  it('F2 overlay OFF: today\'s rail — Stamp, then comment and save, every count in the text', async () => {
    mockFlags = {};
    await act(async () => { root.render(overlay()); });
    const labels = labelsInOrder();
    expect(labels).not.toContain('Ask Compass about this');
    expect(labels.indexOf('Stamp')).toBeLessThan(labels.indexOf('Comment'));
    for (const count of ['57', '23', '31', '44']) expect(container.textContent).toContain(count);
  });

  it('F2 overlay ON: Ask Compass precedes Stamp, no count is painted, the place precedes the creator', async () => {
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true };
    await act(async () => { root.render(overlay()); });
    const labels = labelsInOrder();
    expect(labels.indexOf('Ask Compass about this')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Ask Compass about this')).toBeLessThan(labels.indexOf('Stamp'));
    const text = container.textContent ?? '';
    for (const count of ['57', '23', '31', '44']) expect(text).not.toContain(count);
    expect(text.indexOf('An Thuong · Da Nang')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('An Thuong · Da Nang')).toBeLessThan(text.indexOf('Jane Doe'));
  });

  it('F2 tap-to-play ON: the "Tap to play" mark is painted over a cell that is not playing', async () => {
    mockFlags = { MEDIA_WATCH_TAP_TO_PLAY_ENABLED: true };
    await act(async () => {
      root.render(
        <WatchFeedList
          items={[ITEM]} activeIndex={0} currentUserId={undefined}
          onActiveIndexChange={() => {}} onEndReached={() => {}}
          onComment={() => {}} onSave={() => {}} onMore={() => {}} savedSet={{}}
        />,
      );
    });
    expect(container.textContent).toContain('Tap to play');
    expect(mockIsActive['web-1']).toBe(false);
  });

  it('F1: the tab\'s mode switcher sits under the World header and above the lens bar', async () => {
    mockFlags = {};
    const modes = [
      { key: 'world' as const, label: 'World' },
      { key: 'watch' as const, label: 'Watch' },
      { key: 'grid' as const, label: 'Grid' },
    ];
    await act(async () => {
      root.render(
        <MediaWorldShell
          cityName="Da Nang"
          headerAccessory={<MediaModeSelector modes={modes} selectedMode="world" onSelect={() => {}} />}
        />,
      );
    });
    const html = container.innerHTML;
    const header = html.indexOf('>MEDIA<');
    const worldChip = html.indexOf('data-testid="mode-chip-world"');
    const watchChip = html.indexOf('data-testid="mode-chip-watch"');
    const lensNow = labelsInOrder().indexOf('Now');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(worldChip).toBeGreaterThan(header);
    expect(watchChip).toBeGreaterThan(worldChip);
    expect(lensNow).toBeGreaterThan(labelsInOrder().indexOf('World'));
  });
});
