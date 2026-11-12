/**
 * Wall: opening a Shared Moment, and the Share button.
 *
 *   • Opening a Shared Moment pushed the bare `/shared-moments`, a route the
 *     app does not have (only app/shared-moments/[id].tsx exists), so the card
 *     opened "This screen doesn't exist". It now opens that Moment.
 *   • Share recorded analytics and did nothing else. It now opens the OS share
 *     sheet with the object's link, built by the share layer's one path map.
 *
 * ONE PRESS in this file (renderer press budget, see
 * .agents/memory/rntl-react19-renderer-budget.md); the rest needs no renderer.
 */

import React from 'react';
import { Share } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — wallItemShared pulls wallAnalytics →
// wallApi, whose real module loads the supabase/apiToken chain at import.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

// NOTE: intentional stub — services/collections talks to the network; the
// Wall's save path is the only member this file's renderer can reach.
jest.mock('../../../../../services/collections.ts', () => ({
  saveItem: jest.fn(async () => true),
  unsaveItem: jest.fn(async () => true),
}));

jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { SocialActionRow, resolveActionRoute, wallShareUrl } from '../wallItemShared.tsx';
import { canonicalUrl } from '../../../../../constants/canonicalUrl.ts';
import type { WallAction, WallProjection } from '../../../types/wallProjection.ts';

const open: WallAction = { type: 'open_object', label: 'Open' };

function projection(over: Partial<WallProjection> = {}): WallProjection {
  return {
    projectionId: 'wall_social_post_p1',
    objectType: 'social_post',
    canonicalObjectId: 'post-1',
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [open],
    ...over,
  } as WallProjection;
}

it('opens THE shared moment, not the bare /shared-moments', () => {
  const moment = projection({ objectType: 'shared_moment', canonicalObjectId: 'm-9' } as Partial<WallProjection>);
  expect(resolveActionRoute(open, moment)).toBe('/shared-moments/m-9');
});

it('builds the link from the share layer: post page for posts, Moment page for moments', () => {
  expect(wallShareUrl(projection())).toBe(canonicalUrl('/posts/post-1'));
  for (const objectType of ['video', 'postcard', 'social_update', 'discovery']) {
    expect(wallShareUrl(projection({ objectType, canonicalObjectId: 'p-2' } as Partial<WallProjection>)))
      .toBe(canonicalUrl('/posts/p-2'));
  }
  expect(wallShareUrl(projection({ objectType: 'shared_moment', canonicalObjectId: 'm-9' } as Partial<WallProjection>)))
    .toBe(canonicalUrl('/shared-moments/m-9'));
  expect(wallShareUrl(projection({ objectType: 'contextual_opportunity' } as Partial<WallProjection>))).toBeNull();
});

it('Share opens the in-app destinations before native sharing', async () => {
  const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
  await render(<SocialActionRow projection={projection({ text: 'Sunset at the pier' } as Partial<WallProjection>)} />);
  await fireEvent.press(screen.getByLabelText('Share'));
  await waitFor(() => expect(screen.getByText('Send in a chat')).toBeTruthy());
  expect(screen.getByText('Copy Link')).toBeTruthy();
  expect(shareSpy).not.toHaveBeenCalled();
  shareSpy.mockRestore();
});

it('Shared Moment offers chat/link sharing without inventing a post reference', async () => {
  await render(<SocialActionRow projection={projection({ objectType: 'shared_moment', canonicalObjectId: 'm-9' } as Partial<WallProjection>)} />);
  await fireEvent.press(screen.getByLabelText('Share'));
  await waitFor(() => expect(screen.getByText('Send in a chat')).toBeTruthy());
  expect(screen.getByText('Copy Link')).toBeTruthy();
  expect(screen.queryByText('Share to profile')).toBeNull();
  expect(screen.queryByText('Add to Memories')).toBeNull();
});
