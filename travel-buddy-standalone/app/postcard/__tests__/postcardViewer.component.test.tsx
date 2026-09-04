/**
 * app/postcard/[id] — the canonical Postcard viewer (Wall spec §10/§24).
 *
 * Proves the viewer renders from the postcard's own data (place, experience
 * date, caption, byline) through the shared post-detail fetch, and degrades to
 * a calm message — never a crash — when the postcard cannot be loaded.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Run useFocusEffect eagerly (no NavigationContainer in the test tree).
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  const react = jest.requireActual('react') as typeof import('react');
  return {
    ...actual,
    useLocalSearchParams: () => ({ id: 'pc-1' }),
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, []),
    router: { back: jest.fn(), push: jest.fn() },
  };
});

// The media/native children are not under test here and pull in the signing /
// native chains; the postcard's text content is what we assert. Each stub below
// is intentionally exhaustive for the single export the viewer imports.
// NOTE: intentional stub — AppHeader chrome is not under test.
jest.mock('../../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentional stub — CachedImage pulls the media-signing chain.
jest.mock('../../../src/components/CachedImage', () => ({ CachedImage: () => null }));
// NOTE: intentional stub — the native video player is not under test.
jest.mock('../../../src/components/ui/SharedVideoPlayer', () => ({ SharedVideoPlayer: () => null }));
// NOTE: intentional stub — the stamp overlay is not under test.
jest.mock('../../../src/components/StampOverlayBadge', () => ({ MediaStampOverlay: () => null }));
// NOTE: intentional stub — only AvatarImage is imported by the viewer.
jest.mock('../../../src/components/ui/DisplayMediaImage.tsx', () => ({ AvatarImage: () => null }));
// NOTE: intentional stub — getPostById is the seam under test; the module
// otherwise loads the supabase / apiToken chain at import.
jest.mock('../../../src/services/posts', () => ({ getPostById: jest.fn() }));

import { getPostById, type PostRow } from '../../../src/services/posts';
import type { PostcardMediaItem } from '../../../src/types/models.ts';
import PostcardViewer from '../[id].tsx';

const getPostByIdMock = getPostById as jest.Mock;

function media(over: Partial<PostcardMediaItem> = {}): PostcardMediaItem {
  return {
    id: 'm1',
    media_type: 'image',
    url: 'post-media/u/pc-1/1.jpg',
    feed_url: null,
    thumbnail_url: null,
    duration_seconds: null,
    width: 1200,
    height: 900,
    sort_order: 0,
    processing_status: 'ready',
    ...over,
  };
}

function postcard(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 'pc-1',
    authorId: 'author-1',
    tripId: null,
    content: 'Golden hour on the An Bang sand.',
    mediaUrls: [],
    media: [media()],
    visibility: 'public',
    status: 'active',
    createdAt: '2026-08-30T22:15:00.000Z',
    updatedAt: '2026-08-31T20:42:00.000Z',
    publishedAt: '2026-08-31T20:42:00.000Z',
    locationName: 'An Bang Beach',
    locationCity: 'Da Nang',
    locationCountry: 'Vietnam',
    author: { id: 'author-1', handle: 'maya', name: 'Maya', avatarUrl: null },
    likeCount: 0,
    stampCount: 0,
    commentCount: 0,
    shareCount: 0,
    likedByMe: false,
    savedByMe: false,
    saveCount: 0,
    canLike: true,
    canComment: true,
    canShare: true,
    filterId: 'original',
    filterIntensity: 100,
    tags: [],
    hashtagUsages: [],
    ...over,
  };
}

beforeEach(() => {
  getPostByIdMock.mockReset();
});

it('renders the postcard place, experience date, caption and byline from its data', async () => {
  getPostByIdMock.mockResolvedValue({ ok: true, data: postcard() });

  await render(<PostcardViewer />);

  await waitFor(() => expect(screen.getByTestId('postcard-story')).toBeTruthy());
  expect(getPostByIdMock).toHaveBeenCalledWith('pc-1');
  expect(screen.getByTestId('postcard-place')).toHaveTextContent('An Bang Beach');
  expect(screen.getByTestId('postcard-caption')).toHaveTextContent('Golden hour on the An Bang sand.');
  // Experience date is the printed stamp, from publishedAt.
  expect(screen.getByTestId('postcard-date')).toHaveTextContent('AUGUST 31, 2026');
  expect(screen.getByText(/Postcard · Maya/)).toBeTruthy();
});

it('shows a calm error (no crash) when the postcard is not found', async () => {
  getPostByIdMock.mockResolvedValue({ ok: false, data: null, errorKind: 'not_found' });

  await render(<PostcardViewer />);

  await waitFor(() => expect(screen.getByTestId('postcard-error')).toBeTruthy());
  expect(screen.getByTestId('postcard-error')).toHaveTextContent('Postcard not found.');
  expect(screen.queryByTestId('postcard-story')).toBeNull();
});

it('falls back to a place placeholder when there is no ready media', async () => {
  getPostByIdMock.mockResolvedValue({
    ok: true,
    data: postcard({ media: [media({ processing_status: 'failed' })] }),
  });

  await render(<PostcardViewer />);
  await waitFor(() => expect(screen.getByTestId('postcard-story')).toBeTruthy());
  // The failed item is dropped; the story still renders the place text.
  expect(screen.getByTestId('postcard-place')).toHaveTextContent('An Bang Beach');
});
