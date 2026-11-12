import React from 'react';
import { StyleSheet, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';
import { PortavaObjectMessage } from '../sharing/PortavaObjectMessage.tsx';
import { resolveShareProjections, type ResolvedShare } from '../sharing/shareApi.ts';
import { ThreadSharePlaybackContext } from '../sharing/threadSharePlayback.tsx';

let mockWidth = 320;
let mockFontScale = 1;
const mockImage = jest.fn();
const mockVideo = jest.fn();
// NOTE: Keep the actual native components while supplying a narrow phone viewport.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {get(target, property, receiver) {
    if (property === 'useWindowDimensions') return () => ({width: mockWidth, height: 700, scale: 3, fontScale: mockFontScale});
    return Reflect.get(target, property, receiver);
  }});
});
// NOTE: Only the HTTP answer is controlled; both cards and their revocation hook render normally.
jest.mock('../sharing/shareApi.ts', () => ({...jest.requireActual('../sharing/shareApi.ts'), resolveShareProjections: jest.fn()}));
// NOTE: Native image/video decoding is unavailable in Jest. Observe the authorized media reaching those sinks.
jest.mock('../../../components/ui/DisplayMediaImage.tsx', () => ({DisplayMediaImage: (props: unknown) => {mockImage(props); return null;}}));
jest.mock('../../../components/media/FeedAutoplayVideo.tsx', () => ({FeedAutoplayVideo: (props: unknown) => {mockVideo(props); return null;}}));

const postId = '11110000-0000-4000-8000-000000000001';
const threadId = 'dddddddd-0000-4000-8000-00000000000d';
const image = 'post-media/author/photo.jpg';
const video = 'post-media/author/clip.mp4';
const body = JSON.stringify({kind: 'PORTAVA_OBJECT', objectType: 'POST', objectId: postId, shareProjectionVersion: '1'});
const snapshot = JSON.stringify({postId, thumbnail: 'post-media/author/stale.jpg', snippet: 'Stale private text'});
const resolveMock = jest.mocked(resolveShareProjections);
function answer(type?: 'image' | 'video'): ResolvedShare {
  return {objectType: 'POST', objectId: postId, messageId: 'message', available: true, status: 'active',
    deepLink: `/post/${postId}`, actions: [], projection: {
      objectType: 'POST', objectId: postId, title: 'Hi', subtitle: '@author', imageUrl: null,
      deepLink: `/post/${postId}`, projectionVersion: 'v1',
      media: type ? [{type, uri: type === 'image' ? image : video, thumbnailUri: type === 'video' ? image : null}] : [],
    }};
}
function respond(value: ResolvedShare) {
  resolveMock.mockResolvedValue({ok: true, data: {threadId, projections: [value], unsupported: []}});
}
const playback = {playing: 'message', muted: true, paused: new Set<string>(), register: jest.fn(),
  expand: jest.fn(), setMuted: jest.fn(), togglePause: jest.fn()};
function Card({kind}: {kind: 'legacy' | 'typed'}) {
  return <ThreadSharePlaybackContext.Provider value={playback}>
    <View style={{width: mockWidth, paddingHorizontal: 16}}><View style={{alignSelf: 'flex-end', maxWidth: '82%'}}>
      {kind === 'legacy'
        ? <PostCardMessage body={snapshot} mine threadId={threadId} messageId="message" />
        : <PortavaObjectMessage body={body} mine threadId={threadId} messageId="message" />}
    </View></View>
  </ThreadSharePlaybackContext.Provider>;
}

beforeEach(() => {mockWidth = 320; mockFontScale = 1; resolveMock.mockReset(); mockImage.mockClear(); mockVideo.mockClear();});

describe.each(['legacy', 'typed'] as const)('%s shared post card', kind => {
  it('gives a short post a readable concrete width on a narrow phone and responds to resizing', async () => {
    respond(answer());
    const ui = await render(<Card kind={kind} />);
    const id = kind === 'legacy' ? 'post-card-live' : 'telegraph-portava-object-card';
    const card = await ui.findByTestId(id);
    const narrowWidth = StyleSheet.flatten(card.props.style).width;
    expect(typeof narrowWidth).toBe('number');
    expect(narrowWidth).toBeGreaterThan(220);
    expect(narrowWidth).toBeLessThanOrEqual((320 - 32) * 0.82);
    expect(ui.getByText('Hi')).toBeTruthy();
    expect(ui.getByText('POST')).toBeTruthy();
    mockFontScale = 2;
    await ui.rerender(<Card kind={kind} />);
    expect(ui.getByTestId(id)).toHaveStyle({width: narrowWidth});
    expect(ui.getByText('POST')).toBeTruthy();
    mockWidth = 768;
    await ui.rerender(<Card kind={kind} />);
    expect(ui.getByTestId(id)).toHaveStyle({width: 280});
  });

  it.each(['image', 'video'] as const)('renders the authorized %s inline instead of the sender snapshot', async type => {
    respond(answer(type));
    const ui = await render(<Card kind={kind} />);
    expect(await ui.findByLabelText('Open shared post')).toBeTruthy();
    expect(mockImage).toHaveBeenCalledWith(expect.objectContaining({uri: image}));
    if (type === 'video') expect(mockVideo).toHaveBeenCalledWith(expect.objectContaining({uri: video, muted: true}));
    else expect(mockVideo).not.toHaveBeenCalled();
    expect(ui.queryByText('Stale private text')).toBeNull();
    expect(mockImage.mock.calls.some(([props]) => props.uri.includes('stale'))).toBe(false);
  });

  it('mounts no image or decoder for a revoked source, even with a stored preview', async () => {
    respond({objectType: 'POST', objectId: postId, messageId: 'message', available: false, status: 'unavailable',
      reason: 'private', projection: null, actions: [], deepLink: `/post/${postId}`});
    const ui = await render(<Card kind={kind} />);
    expect(await ui.findByText('This content is now private')).toBeTruthy();
    expect(ui.queryByLabelText('Open shared post')).toBeNull();
    expect(mockImage).not.toHaveBeenCalled();
    expect(mockVideo).not.toHaveBeenCalled();
  });
});
