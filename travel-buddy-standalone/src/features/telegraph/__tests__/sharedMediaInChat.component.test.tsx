import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { canonicalUrl } from '../../../constants/canonicalUrl.ts';
import { canonicalMediaLink } from '../sharing/canonicalMediaLink.ts';
import { SharedMessageMedia } from '../sharing/SharedMessageMedia.tsx';
import { LinkedMessageMedia } from '../sharing/LinkedMessageMedia.tsx';
import { ThreadSharePlaybackContext } from '../sharing/threadSharePlayback.tsx';
import type { TelegraphShareProjection } from '../sharing/shareApi.ts';

const mockTakeover = jest.fn();
// NOTE: Observe the selected post and source when the reader expands the media.
jest.mock('../../../components/PostTakeover.tsx', () => ({PostTakeover: (props: unknown) => { mockTakeover(props); return null; }}));
// NOTE: Media hydration has independent tests; this fixture observes which source the card passes.
jest.mock('../../../components/ui/DisplayMediaImage.tsx', () => ({DisplayMediaImage: ({uri}: {uri: string}) => require('react').createElement(require('react-native').Text, null, uri)}));
// NOTE: Native decoding is replaced by a visible recording of source and mute props.
jest.mock('../../../components/media/FeedAutoplayVideo.tsx', () => ({FeedAutoplayVideo: ({uri, muted}: any) => require('react').createElement(require('react-native').Text, null, `playing ${uri} ${muted}`)}));
// NOTE: The receiver observes whether an encrypted reference is resolved before a tap.
jest.mock('../sharing/PortavaObjectMessage.tsx', () => ({PortavaObjectMessage: ({body}: {body: string}) => require('react').createElement(require('react-native').Text, null, JSON.parse(body).objectId)}));
const id = '12340000-0000-4000-8000-000000000001';
const uri = 'post-media/owner/clip.mp4';
const poster = 'post-media/owner/clip.poster.jpg';
const projection: TelegraphShareProjection = {objectType:'POST', objectId:id, title:'A morning in Hue', subtitle:'@luna', deepLink:`/post/${id}`, imageUrl:poster, projectionVersion:null, media:[{type:'video', uri, thumbnailUri:poster}]};

it('recognizes app post/media permalinks and preserves the note without following arbitrary hosts', () => {
  expect(canonicalMediaLink(`Look here\n${canonicalUrl(`/posts/${id}`)}`)).toEqual({objectType:'POST', objectId:id, caption:'Look here'});
  expect(canonicalMediaLink(canonicalUrl(`/media-viewer/${id}`))?.objectType).toBe('MEDIA');
  for (const url of [`https://attacker.example/posts/${id}`, `https://name@rumazi.com/posts/${id}`, `${canonicalUrl(`/posts/${id}`)} plus more`, canonicalUrl('/posts/not-an-id')]) expect(canonicalMediaLink(url)).toBeNull();
});
it('plays only the selected current video, respects a pause and mute setting, and opens the original post from its media', async () => {
  const controls = {playing: 'm', register: jest.fn(), expand: jest.fn(), muted: false, setMuted: jest.fn(), paused: new Set<string>(), togglePause: jest.fn()};
  const ui = await render(<ThreadSharePlaybackContext.Provider value={controls}><SharedMessageMedia projection={projection} messageId="m" /></ThreadSharePlaybackContext.Provider>);
  expect(ui.getByText(`playing ${uri} false`)).toBeTruthy();
  await fireEvent.press(ui.getByLabelText('Pause shared video'));
  expect(controls.togglePause).toHaveBeenCalledWith('m');
  await ui.rerender(<ThreadSharePlaybackContext.Provider value={{...controls, paused: new Set(['m'])}}><SharedMessageMedia projection={projection} messageId="m" /></ThreadSharePlaybackContext.Provider>);
  expect(ui.queryByText(`playing ${uri} false`)).toBeNull();
  await fireEvent.press(ui.getByLabelText('Mute shared video'));
  expect(controls.setMuted).toHaveBeenCalledWith(true);
  await fireEvent.press(ui.getByLabelText('Open shared post'));
  expect(mockTakeover).toHaveBeenCalledWith(expect.objectContaining({postId:id, initialMediaUri:uri}));
  expect(controls.expand).toHaveBeenCalledWith('m');
});
it('never mounts a network sink for untrusted preview/original hosts', async () => {
  const ui = await render(<SharedMessageMedia projection={{...projection,imageUrl:'https://attacker.example/poster',media:[{type:'video',uri:'https://attacker.example/v.mp4',thumbnailUri:'https://attacker.example/p.jpg'}]}} messageId="m" />);
  expect(ui.queryByLabelText('Open shared post')).toBeNull();
});
it('requires an explicit tap before resolving decrypted media links', async () => {
  const ui = await render(<LinkedMessageMedia encrypted refInfo={{objectType:'POST',objectId:id,caption:'Here'}} threadId="room" messageId="m" mine={false} />);
  expect(ui.getByText('Here')).toBeTruthy(); expect(ui.queryByText(id)).toBeNull();
  await fireEvent.press(ui.getByText('Load shared post'));
  expect(ui.getByText(id)).toBeTruthy();
});
