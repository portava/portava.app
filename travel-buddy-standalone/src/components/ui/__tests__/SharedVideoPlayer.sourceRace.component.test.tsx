/**
 * SharedVideoPlayer — the source race (owner-reported 2026-10-24: "video media still not playing" after 3924).
 *
 * Production, 2026-10-24 10:11Z: the server signed `…/1792727980484.mov` when the owner opened the post, and the
 * phone never requested the signed URL. The player had mounted <Video> with the BARE `post-media/…` ref while the
 * signature was in flight; AVPlayer failed on it, `hasError` latched "Video unavailable", and the signed URL that
 * arrived a moment later was never handed to a player.
 *
 *   R1  an unresolved bare ref: NO <Video> is mounted; the poster and a loading state show
 *   R2  after the resolve: the <Video> gets the signed URL — and no <Video> ever received the bare ref
 *   R3  an error on one source, then a new source (a refreshed signature): it recovers and plays the new one
 *   R4  a null resolve: "Video unavailable"
 *   R5  production's exact row shape for 1792727980484.mov, end to end through the race
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { SharedVideoPlayer } from '../SharedVideoPlayer.tsx';

let mockResolved: Record<string, string | null> = {};
const mockSources: string[] = [];
let mockStatus: ((s: any) => void) | null = null;

// NOTE: intentional stub — the hydration answer is the variable under test; everything else is the real module.
jest.mock('../../../services/mediaUrl.ts', () => ({
  ...jest.requireActual('../../../services/mediaUrl.ts'),
  useHydratedMedia: () => ({ resolved: { ...mockResolved }, loading: false }),
}));

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef(({ onPlaybackStatusUpdate, source }: any, ref: React.Ref<any>) => {
    mockSources.push(String(source?.uri ?? ''));
    mockStatus = onPlaybackStatusUpdate ?? null;
    React.useImperativeHandle(ref, () => ({ playAsync: jest.fn(), pauseAsync: jest.fn(), setStatusAsync: jest.fn() }), []);
    return <View testID="mock-video" accessibilityHint={String(source?.uri ?? '')} />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const POSTER = `${MOV}.poster.jpg`;
const SIGNED_A = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=a';
const SIGNED_B = SIGNED_A.replace('token=a', 'token=b');

beforeEach(() => { mockResolved = {}; mockSources.length = 0; mockStatus = null; });

describe('SharedVideoPlayer — no player until the source is loadable', () => {
  it('R1 an unresolved bare ref mounts no <Video>; the poster and a loading state show', async () => {
    await render(<SharedVideoPlayer uri={MOV} poster={POSTER} />);
    expect(screen.queryByTestId('mock-video')).toBeNull();
    expect(screen.getByTestId('video-resolving')).toBeTruthy();
    expect(screen.getByTestId('poster-image')).toBeTruthy();
    expect(screen.queryByText('Video unavailable')).toBeNull();
  });

  it('R2 after the resolve the <Video> gets the signed URL, and never saw the bare ref', async () => {
    const view = await render(<SharedVideoPlayer uri={MOV} poster={POSTER} />);
    mockResolved = { [MOV]: SIGNED_A };
    await act(async () => { view.rerender(<SharedVideoPlayer uri={MOV} poster={POSTER} />); });
    expect(screen.getByTestId('mock-video').props.accessibilityHint).toBe(SIGNED_A);
    expect(mockSources.every((s) => s === SIGNED_A)).toBe(true);
    expect(mockSources).not.toContain(MOV);
  });

  it('R3 an error on one source, then a refreshed signature: it recovers and mounts the new source', async () => {
    mockResolved = { [MOV]: SIGNED_A };
    const view = await render(<SharedVideoPlayer uri={MOV} />);
    await act(async () => { mockStatus?.({ isLoaded: false, error: 'AVFoundationErrorDomain -11828' }); });
    expect(screen.getByText('Video unavailable')).toBeTruthy();
    mockResolved = { [MOV]: SIGNED_B };
    await act(async () => { view.rerender(<SharedVideoPlayer uri={MOV} />); });
    expect(screen.queryByText('Video unavailable')).toBeNull();
    expect(screen.getByTestId('mock-video').props.accessibilityHint).toBe(SIGNED_B);
  });

  it('R4 a null resolve keeps "Video unavailable"', async () => {
    mockResolved = { [MOV]: null };
    await render(<SharedVideoPlayer uri={MOV} poster={POSTER} />);
    expect(screen.getByText('Video unavailable')).toBeTruthy();
    expect(screen.queryByTestId('mock-video')).toBeNull();
  });

  it("R5 production's row for 1792727980484.mov (post_media.public_url, thumbnail_url) plays once signed", async () => {
    const row = { media_type: 'video', url: MOV, thumbnail_url: POSTER };
    const view = await render(<SharedVideoPlayer uri={row.url} poster={row.thumbnail_url} />);
    expect(mockSources).toEqual([]);
    mockResolved = { [row.url]: SIGNED_A, [row.thumbnail_url]: `${SIGNED_A}.poster` };
    await act(async () => { view.rerender(<SharedVideoPlayer uri={row.url} poster={row.thumbnail_url} />); });
    expect([...new Set(mockSources)]).toEqual([SIGNED_A]); // every render of every <Video> carried the signed URL
    expect(screen.queryByText('Video unavailable')).toBeNull();
  });
});
