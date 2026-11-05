import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { FullscreenPhoto } from '../FullscreenPhoto.tsx';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
const mockImages = jest.fn();
jest.mock('../DisplayMediaImage.tsx', () => {
  const React = require('react');
  const actual = jest.requireActual('../DisplayMediaImage.tsx');
  return { ...actual, DisplayMediaImage: (props: unknown) => { mockImages(props); return React.createElement(actual.DisplayMediaImage, props); } };
});
beforeEach(() => { mockImages.mockClear(); setDiscoveryViewerFromSession(null); });
afterEach(async () => { await act(async () => { setDiscoveryViewerFromSession(null); }); });
const FIRST = 'https://example.com/original.jpg';
const SECOND = 'https://example.com/second.jpg';
const subject = (uri = FIRST) => <FullscreenPhoto uri={uri} photos={[FIRST, SECOND]} style={{ width: 300, height: 200 }}><Text>Thumbnail</Text></FullscreenPhoto>;

it('loads the original only on opening, contains the whole image, and closes', async () => {
  await render(subject());
  expect(mockImages).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(mockImages.mock.lastCall[0]).toMatchObject({ uri: FIRST, resizeMode: 'contain' });
  expect(screen.getByText('1 of 2')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Close full-screen photo'));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  expect(screen.getByText('Thumbnail')).toBeTruthy();
});
it('zooms within bounds, resets, and clears zoom on next/previous photo', async () => {
  await render(subject());
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  for (let i = 0; i < 9; i++) await fireEvent.press(screen.getByLabelText('Zoom in'));
  expect(screen.getByText('400%')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Reset photo zoom'));
  expect(screen.getByText('100%')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Zoom out'));
  expect(screen.getByText('100%')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Zoom in'));
  await fireEvent.press(screen.getByLabelText('Next photo'));
  expect(mockImages.mock.lastCall[0].uri).toBe(SECOND);
  expect(screen.getByText('100%')).toBeTruthy();
  expect(screen.getByLabelText('Next photo').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByLabelText('Previous photo'));
  expect(mockImages.mock.lastCall[0].uri).toBe(FIRST);
});
it('opens the selected original within a gallery', async () => {
  await render(subject(SECOND));
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(screen.getByText('2 of 2')).toBeTruthy();
  expect(mockImages.mock.lastCall[0].uri).toBe(SECOND);
});
it('removes the open image when the account changes', async () => {
  await render(subject());
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  await act(async () => { setDiscoveryViewerFromSession('another-user'); });
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
});
it('removes the open image when the source changes', async () => {
  const ui = await render(subject());
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  await ui.rerender(subject(SECOND));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
});
