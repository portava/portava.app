/**
 * WallFeed render cost (Wall spec §33 / TABLE 4).
 *
 * TABLE 4 asks for a 60 fps scroll and for video to be "lazy load; only near
 * viewport". Frame time itself needs a real device and is NOT claimed here.
 * What CAN be measured in a jest render is the INPUT to frame time: how many
 * feed items the list actually mounts, how many times each mounted body runs,
 * and how much heavyweight media machinery exists before anything is on screen.
 * Those are invisible until something counts them.
 *
 * The counter is a stub for SocialPostWallItem: WallObjectRenderer dispatches
 * every `social_post` projection to it, so one call per item BODY is exactly
 * what we want to count. The real WallObjectRenderer and the real FlatList are
 * deliberately NOT mocked — their behaviour is what is being pinned.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED HERE. "Re-rendering the screen does not
 * re-render the item bodies" cannot be tested in this environment: React Native's
 * VirtualizedList renders no cells at all on a jest `rerender` (no layout events
 * ever arrive), so such a test passes no matter what the component does — it
 * survives `extraData={Math.random()}`, an unstable `renderItem` and even
 * `data={items.map(i => ({...i}))}`. It was written, found to be vacuous under
 * exactly those three mutations, and removed rather than left as false
 * assurance. Re-render churn on scroll needs a device profile.
 *
 * Every assertion below IS mutation-proven: widening `initialNumToRender`,
 * double-rendering an item body, and eagerly activating the video player each
 * fail their respective test.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the wall item tree pulls wallAnalytics →
// wallApi, whose real module loads the supabase/apiToken chain at import and
// crashes the suite. Stub only the exports these components touch.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

/** One entry per rendered item BODY, in render order. */
const itemRenders = { ids: [] as string[] };
/** One entry per MOUNTED inline video player. */
const playerMounts = { ids: [] as string[] };
jest.mock('../objects/SocialPostWallItem.tsx', () => {
  const ReactLocal = require('react');
  const { View } = require('react-native');
  return {
    SocialPostWallItem: ({ projection }: { projection: { projectionId: string } }) => {
      itemRenders.ids.push(projection.projectionId);
      return ReactLocal.createElement(View, { testID: `cost-item-${projection.projectionId}` });
    },
  };
});

jest.mock('../../../../components/ui/SharedVideoPlayer.tsx', () => {
  const ReactLocal = require('react');
  const { View } = require('react-native');
  return {
    SharedVideoPlayer: ({ uri }: { uri: string }) => {
      playerMounts.ids.push(uri);
      return ReactLocal.createElement(View, { testID: `cost-player-${uri}` });
    },
  };
});

import { WallFeed } from '../WallFeed.tsx';
import type { WallProjection } from '../../types/wallProjection.ts';

const TOTAL = 60;

function projection(n: number): WallProjection {
  return {
    projectionId: `p-${n}`,
    objectType: 'social_post',
    canonicalObjectId: `post-${n}`,
    actor: { userId: `a-${n % 5}`, displayName: `Author ${n % 5}`, handle: null, avatarUrl: null },
    publishedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - n * 60_000).toISOString(),
    visibility: 'public',
    text: `Post ${n}`,
    actions: [],
  } as WallProjection;
}

/** Stable item identities — a fresh object every render would make the
 *  memoization tests measure the fixture instead of the component. */
const ITEMS = Array.from({ length: TOTAL }, (_, i) => projection(i));

function video(n: number): WallProjection {
  return {
    projectionId: `v-${n}`,
    objectType: 'video',
    inlinePlayback: true,
    canonicalObjectId: `vid-${n}`,
    actor: { userId: `a-${n}`, displayName: `Author ${n}`, handle: null, avatarUrl: null },
    publishedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - n * 60_000).toISOString(),
    visibility: 'public',
    media: [
      {
        mediaId: `m-${n}`,
        kind: 'video',
        url: `https://example.test/v-${n}.mp4`,
        thumbnailUrl: `https://example.test/v-${n}.jpg`,
        autoplayEligible: true,
      },
    ],
    actions: [],
  } as WallProjection;
}

const NOOP = () => {};

function feed(items: WallProjection[]) {
  return (
    <WallFeed
      items={items}
      mode="for_you"
      loading={false}
      refreshing={false}
      loadingMore={false}
      caughtUp={false}
      onEndReached={NOOP}
      onRefresh={NOOP}
    />
  );
}

const renderCount = () => itemRenders.ids.length;

/**
 * The mount bound: WallFeed's stated `initialNumToRender`, with a little slack.
 * A page is 20 items and pagination appends, so a list that mounted everything
 * would grow without bound as the viewer scrolls — that is the regression this
 * pins. It only has to sit well under TOTAL to prove the list is windowed.
 */
const MAX_MOUNTED_ITEMS = 12;

describe('WallFeed render cost (§33 / TABLE 4)', () => {
  beforeEach(() => {
    itemRenders.ids = [];
    playerMounts.ids = [];
  });

  it('mounts only a window of the feed, not every item', async () => {
    await render(feed(ITEMS));

    expect(screen.getByTestId('wall-feed')).toBeTruthy();
    // The counter must actually be wired — a zero would make the bound vacuous.
    expect(renderCount()).toBeGreaterThan(0);
    expect(renderCount()).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS);
    // The window starts at the top of the feed, in order, and the tail of a
    // 60-item list is never mounted.
    expect(itemRenders.ids[0]).toBe('p-0');
    expect(screen.queryByTestId(`cost-item-p-${TOTAL - 1}`)).toBeNull();
  });

  it('renders each mounted item body exactly once', async () => {
    await render(feed(ITEMS));

    expect(renderCount()).toBeGreaterThan(0);
    // A mount-time state update inside the item tree doubles the work of the
    // very first frame — the one the viewer waits for. Each body must run once.
    expect(itemRenders.ids).toEqual([...new Set(itemRenders.ids)]);
  });

  it('mounts no inline video player for a feed nobody has scrolled yet', async () => {
    // TABLE 4: "Video — lazy load; only near viewport". Viewability has not
    // fired, so no item is on screen, so no player may exist: a feed of videos
    // must cost exactly as much video work as a feed of text.
    const videos = Array.from({ length: 10 }, (_, i) => video(i));
    await render(feed(videos));

    expect(screen.getByTestId('wall-feed')).toBeTruthy();
    // The poster stands in for every mounted video item...
    expect(screen.queryAllByTestId('wall-item-video').length).toBeGreaterThan(0);
    // ...and not one real player was mounted behind it.
    expect(playerMounts.ids).toEqual([]);
  });
});
