/**
 * MediaViewer — a video FILE is played even when the item says image (owner-reported 2026-10-24:
 * "video media still not playing").
 *
 * The viewer chose Video from the full post's flag alone whenever it had one, else from the opening
 * item's mediaType. A post whose only media is a `.mov`, opened with mediaType 'image' (its type was
 * read from an empty `media`), handed the `.mov` to an image component.
 *
 *   W1  the full post cannot be read, the item says image, the file shown is a BARE .mov: it is a video, but no
 *       player is handed a bare bucket ref (services/playbackUri.ts) — the poster layer draws the derived poster
 *   W2  CONTROL: the same with a .jpg ⇒ no Video
 *   W3  the full post's video flag decides when it is there, and a loadable (signed) URL mounts the Video
 *   W4  a full post whose video URL is still a bare ref mounts no Video either (its signature is refused here)
 *   W5  (M23, closest equivalent — see below) a full post whose video URL is a bare ref: the viewer REQUESTS the
 *       signature, mounts no Video while it is in flight, then plays the signed URL — never the ref
 *   W6  the same for the API relay URL `/api/media/file/post-media/…` the /media/:id payload carries for a private
 *       post: a player sends no bearer token, so the relay URL itself would be a 401
 *
 * W5/W6 were added for the 2026-10-24 "video on every surface" fix. The verifier's original definition of M23 was
 * not available to this builder; W5/W6 are the closest equivalent (the media viewer's private-video path).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'm-1' }),
}));

// NOTE: intentional exhaustive stub — the viewer only reads userId.
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// NOTE: intentional exhaustive stub — every flag off (the World shell's
// action rail is not drawn, as in the H8 renders).
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentional exhaustive stub — the post read resolves with the post
// each case sets in mockPost (counts and flags read or unread).
let mockPost: Record<string, unknown> | null = {};
jest.mock('../../../src/services/mediaFeed.ts', () => ({
  fetchMediaFeedItemById: async (id: string) => (mockPost === null ? { ok: false, data: null } : { ok: true, data: { id, ...mockPost } }),
}));

// NOTE: intentional exhaustive stub — records what the viewer seeds into the
// save store; the store's own handling of null is pinned in
// useMediaSave.unreadSeed.component.test.tsx.
const mockSeed = jest.fn();
jest.mock('../../../src/hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({ seed: (...a: unknown[]) => mockSeed(...a), toggleSave: () => {}, isSaved: () => false, savedSet: {} }),
}));

// NOTE: intentional exhaustive stub — share analytics not under test.
jest.mock('../../../src/services/mediaInteractions.ts', () => ({
  recordMediaShare: async () => {},
}));

// NOTE: intentional exhaustive stub — records the seed the rail's Stamp is
// given; StampButton's own drawing of an unread count is pinned in
// StampButton.unreadCount.component.test.tsx.
const mockStampProps = jest.fn();
jest.mock('../../../src/components/stamps/StampButton.tsx', () => ({
  StampButton: (props: unknown) => { mockStampProps(props); return null; },
}));
// NOTE: intentional exhaustive stub — the comment sheet is closed here.
jest.mock('../../../src/components/media/MediaCommentSheet.tsx', () => ({
  MediaCommentSheet: () => null,
}));
// NOTE: intentional exhaustive stub — the World shell's action rail is off.
jest.mock('../../../src/features/media/components/MediaActionRail.tsx', () => ({
  MediaActionRail: () => null,
}));
// NOTE: intentional exhaustive stub — the page's image is a marker, so the test can tell an image page from a video page.
jest.mock('../../../src/components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: (props: any) => <View testID="mv-image" accessibilityHint={props?.source?.uri} /> };
});
// NOTE: intentional exhaustive stub — the quick-action chips are content inside the left column.
jest.mock('../../../src/components/PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

// NOTE: intentional exhaustive stub — the Video is a View carrying its props, so the test can read what it was handed.
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((props: any, _ref: unknown) => <View testID="mv-video" accessibilityHint={props?.source?.uri} />);
  return { Video, ResizeMode: { COVER: 'cover' } };
});

// NOTE: intentional exhaustive stub — the scrim is decoration.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// NOTE: intentional stub — the network call is the only stand-in; useHydratedMedia and hydrateMediaUrls are real.
// The default answer refuses (the original comes back), which is what W1/W4 ran against before W5/W6 existed.
let mockSignCalls: string[][] = [];
let mockSignAnswer: (urls: string[]) => Promise<Map<string, string>> = async (urls) => new Map(urls.map((u) => [u, u]));
jest.mock('../../../src/lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../../src/lib/batchSignMedia.ts'),
  batchSignUrls: (urls: string[]) => { mockSignCalls.push([...urls]); return mockSignAnswer(urls); },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import MediaViewer from '../[id].tsx';
import { setViewerContext, clearViewerContext } from '../../../src/lib/viewerContext.ts';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const SIGNED = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=a';
const BASE = {
  videoUrl: null, posterUrl: null, caption: 'A caption.',
  creator: { id: 'creator-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null },
  place: { name: 'Palácio da Luz', city: 'Lisbon' },
  likeCount: 1, commentCount: 1, saveCount: 1, likedByMe: false, savedByMe: false, stampItCount: 0,
};

async function renderViewer(post: Record<string, unknown> | null, thumbnailUrl: string) {
  mockPost = post === null ? null : { ...BASE, ...post };
  setViewerContext([{ id: 'm-1', posterUrl: null, thumbnailUrl, mediaType: 'image' as const }], 'm-1');
  await render(<MediaViewer />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => { clearViewerContext(); mockSignCalls = []; mockSignAnswer = async (urls) => new Map(urls.map((u) => [u, u])); });

describe('MediaViewer — a video file plays', () => {
  it('W1 no full post, the item says image, the file is a bare .mov ⇒ a video with no player, showing its poster', async () => {
    await renderViewer(null, MOV);
    expect(screen.queryByTestId('mv-video')).toBeNull();
    expect(screen.getByTestId('mv-video-unloadable')).toBeTruthy();
    for (const img of screen.queryAllByTestId('mv-image')) expect(img.props.accessibilityHint).not.toBe(MOV); // the poster layer never draws the video file
    expect(screen.getAllByTestId('mv-image').some((i) => i.props.accessibilityHint === `${MOV}.poster.jpg`)).toBe(true);
  });

  it('W2 CONTROL: the same with a .jpg renders the image, no Video', async () => {
    await renderViewer(null, 'post-media/u/photo.jpg');
    expect(screen.queryByTestId('mv-video')).toBeNull();
    expect(screen.getAllByTestId('mv-image').length).toBeGreaterThan(0);
  });

  it("W3 the full post's video flag decides when the full post is there, and its signed URL mounts the Video", async () => {
    await renderViewer({ videoUrl: SIGNED }, 'post-media/u/photo.jpg');
    expect(screen.getByTestId('mv-video').props.accessibilityHint).toBe(SIGNED);
  });

  it('W4 a full post whose video URL is still a bare ref mounts no Video', async () => {
    await renderViewer({ videoUrl: MOV }, 'post-media/u/photo.jpg');
    expect(screen.queryByTestId('mv-video')).toBeNull();
    expect(screen.getByTestId('mv-video-unloadable')).toBeTruthy();
  });

  it.each([['W5 bare ref', MOV], ['W6 relay URL', `/api/media/file/${MOV}`]])('%s: the signature is requested, then only the signed URL is played', async (_n, ref) => {
    let release!: () => void;
    mockSignAnswer = (urls) => new Promise((r) => { release = () => r(new Map(urls.map((u) => [u, u === ref ? SIGNED : u]))); });
    await renderViewer({ videoUrl: ref }, 'post-media/u/photo.jpg');
    expect(mockSignCalls.some((c) => c.includes(ref))).toBe(true);
    expect(screen.queryByTestId('mv-video')).toBeNull();
    await act(async () => { release(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('mv-video').props.accessibilityHint).toBe(SIGNED);
  });
});
