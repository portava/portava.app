/**
 * Video on every surface (owner-reported 2026-10-24: uploaded videos play only on the post detail screen).
 *
 * #795 made every <Video> decide through services/playbackUri.ts, but only SharedVideoPlayer (the detail screen)
 * ever ASKED for a signature. The Watch cell, the grid tile and the media viewer were handed either a bare
 * `post-media/…` ref (refused by the rule, so "Video unavailable" or nothing, for ever) or the API relay URL
 * `/api/media/file/post-media/…` (accepted by the rule as a same-origin path, then a 401 in the player, because the
 * relay requires `Authorization: Bearer` and a player sends none). These cases drive the REAL useHydratedMedia →
 * hydrateMediaUrls chain; only the network call (batchSignUrls) is a stand-in, so each case proves the surface
 * requested the signature for the right reference and handed the player nothing but the signed URL.
 *
 *   RM-F1  Watch cell, bare ref: no <Video> and a spinner while the signature is in flight; then the signed URL
 *   RM-F2  Watch cell, relay URL: the same — the relay URL never reaches <Video>
 *   RM-F3  Watch cell, the server refuses the signature: "Video unavailable", no <Video>
 *   RM-F4  CONTROL: an already-loadable https URL plays without a signature request
 *   RM-G1  grid tile in view, relay URL: signed, and only the signed URL reaches <Video>
 *   RM-G2  grid tile out of view: no signature request and no <Video> for a private ref
 *   (the composer's half, RM-C, is HighlightComposer.videoPreviewSigned.component.test.tsx; the structural half
 *   is playbackUri.relay.test.ts P5/P6)
 *
 * The verifier's original definitions of RM-C / RM-F were not available to this builder (they lived in a local
 * scratchpad); these are the closest equivalents: race mutants on the Feed (Watch, grid) surfaces.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const RELAY = `/api/media/file/${MOV}`;
const SIGNED = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=t';

const mockVideoSources: string[] = [];
let mockSignCalls: string[][] = [];
let mockSignAnswer: (urls: string[]) => Promise<Map<string, string>> = async (urls) => new Map(urls.map((u) => [u, u]));

// NOTE: intentional stub — the network call is the only stand-in; hydrateMediaUrls and useHydratedMedia are real.
jest.mock('../../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../../lib/batchSignMedia.ts'),
  batchSignUrls: (urls: string[]) => { mockSignCalls.push([...urls]); return mockSignAnswer(urls); },
}));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => false }) }));
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: 'viewer-1' }) }));
jest.mock('../../../hooks/useSmartVideoFit.ts', () => ({ ...jest.requireActual('../../../hooks/useSmartVideoFit.ts'), useSmartVideoFit: () => ({ resizeMode: 'cover', needsLetterbox: false, onReadyForDisplay: () => {} }) }));
jest.mock('../../../hooks/useInViewAutoplay.ts', () => ({ ...jest.requireActual('../../../hooks/useInViewAutoplay.ts'), useInViewAutoplay: () => {} }));
jest.mock('../../ui/VideoBlurBackdrop.tsx', () => ({ ...jest.requireActual('../../ui/VideoBlurBackdrop.tsx'), VideoBlurBackdrop: () => null }));
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({ ...jest.requireActual('../../ui/DisplayMediaImage.tsx'), DisplayMediaImage: () => null }));
jest.mock('../../CachedImage.tsx', () => ({ ...jest.requireActual('../../CachedImage.tsx'), CachedImage: () => null }));
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((props: any, ref: any) => {
    mockVideoSources.push(props?.source?.uri);
    React.useImperativeHandle(ref, () => ({ playAsync: async () => {}, pauseAsync: async () => {}, setPositionAsync: async () => {} }), []);
    return <View testID="surface-video" accessibilityHint={props?.source?.uri} />;
  });
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

import { WatchVideoCell } from '../WatchVideoCell.tsx';
import { GridTile } from '../GridTile.tsx';
import type { MediaGridItem } from '../../../types/media.ts';

function deferred() {
  let resolve!: (m: Map<string, string>) => void;
  const promise = new Promise<Map<string, string>>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  mockVideoSources.length = 0;
  mockSignCalls = [];
  mockSignAnswer = async (urls) => new Map(urls.map((u) => [u, u]));
});

function cell(videoUrl: string) {
  return <WatchVideoCell id="post-1" videoUrl={videoUrl} posterUrl={`${MOV}.poster.jpg`} isActive isMuted onProgress={() => {}} />;
}

describe('Watch cell — a private video is signed, then played', () => {
  it.each([['RM-F1 bare ref', MOV], ['RM-F2 relay URL', RELAY]])('%s: no <Video> while signing, then only the signed URL', async (_name, ref) => {
    const pending = deferred();
    mockSignAnswer = () => pending.promise;
    await render(cell(ref));
    await flush();
    expect(mockSignCalls).toEqual([[ref]]);
    expect(screen.queryByTestId('surface-video')).toBeNull();
    expect(screen.getByTestId('watch-video-resolving')).toBeTruthy();
    expect(screen.queryByText('Video unavailable')).toBeNull();
    await act(async () => { pending.resolve(new Map([[ref, SIGNED]])); });
    await flush();
    expect(screen.getByTestId('surface-video').props.accessibilityHint).toBe(SIGNED);
    expect(mockVideoSources.every((u) => u === SIGNED)).toBe(true);
  });

  it('RM-F3 the server refuses the signature: "Video unavailable", no <Video>', async () => {
    await render(cell(RELAY));
    await flush();
    expect(screen.queryByTestId('surface-video')).toBeNull();
    expect(screen.getByText('Video unavailable')).toBeTruthy();
    expect(mockVideoSources).toEqual([]);
  });

  it('RM-F4 CONTROL: an https URL plays as it is, with no signature request for it', async () => {
    await render(cell('https://cdn.example/clip.mp4'));
    await flush();
    expect(screen.getByTestId('surface-video').props.accessibilityHint).toBe('https://cdn.example/clip.mp4');
    expect(mockSignCalls).toEqual([]);
  });
});

function tile(videoUrl: string | null, isVisible: boolean) {
  const item: MediaGridItem = {
    id: 'v-1', mediaType: 'video', thumbnailUrl: null, posterUrl: null, width: 1080, height: 1920, durationMs: 1000,
    contentType: null, creatorId: 'c-1', locationLabel: null, placeId: null, viewCount: 0, qualifiedViewCount: 0,
    processingStatus: null, videoUrl,
  };
  return <GridTile item={item} index={0} cellWidth={120} cellHeight={160} onPress={() => {}} isVisible={isVisible} />;
}

describe('Grid tile — a private video is signed once in view', () => {
  it('RM-G1 in view, relay URL: signed, and only the signed URL reaches <Video>', async () => {
    mockSignAnswer = async (urls) => new Map(urls.map((u) => [u, u === RELAY ? SIGNED : u]));
    await render(tile(RELAY, true));
    await flush();
    expect(mockSignCalls).toEqual([[RELAY]]);
    expect(screen.getByTestId('surface-video').props.accessibilityHint).toBe(SIGNED);
    expect(mockVideoSources.every((u) => u === SIGNED)).toBe(true);
  });

  it('RM-G2 out of view: no signature request and no <Video> for a private ref', async () => {
    await render(tile(MOV, false));
    await flush();
    expect(mockSignCalls).toEqual([]);
    expect(screen.queryByTestId('surface-video')).toBeNull();
  });
});
