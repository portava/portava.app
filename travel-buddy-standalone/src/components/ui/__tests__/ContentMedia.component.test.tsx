import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { ContentMedia } from '../ContentMedia.tsx';
const mockVideo = jest.fn();
const mockFullImage = jest.fn();
// NOTE: the existing SharedVideoPlayer suites prove native fullscreen playback;
// this suite proves MIME/reference dispatch and prevents videos becoming photos.
jest.mock('../SharedVideoPlayer.tsx', () => ({ SharedVideoPlayer: (props: unknown) => { mockVideo(props); return null; } }));
jest.mock('../DisplayMediaImage.tsx', () => {
  const actual = jest.requireActual('../DisplayMediaImage.tsx');
  return { ...actual, DisplayMediaImage: (props: unknown) => { mockFullImage(props); return require('react').createElement(actual.DisplayMediaImage, props); } };
});
beforeEach(() => { mockVideo.mockClear(); mockFullImage.mockClear(); });
it('opens the original photo instead of its thumbnail, then closes', async () => {
  await render(<ContentMedia uri="https://example.com/original.jpg" thumbnailUri="https://example.com/thumb.jpg" style={{ width: 110, height: 110 }} />);
  expect(mockFullImage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(mockFullImage.mock.lastCall[0]).toMatchObject({ uri: 'https://example.com/original.jpg', resizeMode: 'contain' });
  await fireEvent.press(screen.getByLabelText('Close full-screen photo')); expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
});
it.each([
  ['post-media/user/file.mov', null], ['post-media/user/opaque', 'video/mp4'], ['post-media/user/opaque', 'video'],
])('uses the guarded shared video player for %s', async (uri, mediaType) => {
  await render(<ContentMedia uri={uri} mediaType={mediaType} thumbnailUri="post-media/user/poster.jpg" style={{ height: 110 }} />);
  expect(mockVideo.mock.lastCall[0]).toMatchObject({ uri, poster: 'post-media/user/poster.jpg', autoplay: false });
  expect(screen.queryByLabelText('View photo full screen')).toBeNull();
});
it('a thumbnail without an original is a preview without a false fullscreen promise', async () => {
  await render(<ContentMedia thumbnailUri="https://example.com/thumb.jpg" style={{ width: 110, height: 110 }} />);
  expect(screen.queryByLabelText('View photo full screen')).toBeNull(); expect(mockVideo).not.toHaveBeenCalled();
});
it('photo galleries carry originals to the next item', async () => {
  const photos = ['https://example.com/one.jpg', 'https://example.com/two.jpg'];
  await render(<ContentMedia uri={photos[0]} photos={photos} style={{ height: 110 }} />);
  await fireEvent.press(screen.getByLabelText('View photo full screen')); await fireEvent.press(screen.getByLabelText('Next photo'));
  expect(mockFullImage.mock.lastCall[0].uri).toBe(photos[1]);
});
