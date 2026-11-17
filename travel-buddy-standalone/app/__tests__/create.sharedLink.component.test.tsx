import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';
import Create from '../create.tsx';
const mockDestination = jest.fn();
// NOTE: capture route handoff; the panel's mounted tests verify its writer and viewer scope.
jest.mock('../../src/components/PostSaveDestinationPanel.tsx', () => ({ PostSaveDestinationPanel: (props: unknown) => { mockDestination(props); return null; } }));

let mockParams: { sharePostId?: string | string[] } = {};
const mockComposer = jest.fn();
// NOTE: This test verifies route-to-composer handoff; composer submit is covered by mounted PulseCreate tests.
jest.mock('../../src/components/PulseCreate', () => ({ UnifiedPostComposer: (props: unknown) => { mockComposer(props); return null; } }));
// NOTE: Query parameters and native navigation are the route's platform boundary.
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, router: { back: jest.fn(), canGoBack: () => true } }));
beforeEach(() => { mockComposer.mockClear(); mockDestination.mockClear(); mockParams = {}; jest.mocked(router.back).mockClear(); });

it('opens the native repost editor with an opaque source id', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  mockParams = { sharePostId: id };
  const ui = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 440, height: 956 },
    insets: { top: 62, bottom: 34, left: 0, right: 0 } }}><Create /></SafeAreaProvider>);
  expect(mockDestination).toHaveBeenCalledWith(expect.objectContaining({ postId: id, destination: 'profile', showTitle: false }));
  const title = ui.getByText('Share to my profile');
  let node = title.parent;
  let clearsStatusBar = false;
  while (node) {
    if ((StyleSheet.flatten(node.props.style)?.paddingTop ?? 0) >= 62) clearsStatusBar = true;
    node = node.parent;
  }
  expect(clearsStatusBar).toBe(true);
  await fireEvent.press(ui.getByRole('button', { name: 'Close' }));
  expect(router.back).toHaveBeenCalledTimes(1);
  expect(mockComposer).not.toHaveBeenCalled();
});

it.each([{ value: '../../private' }, { value: ['11111111-1111-4111-8111-111111111111'] }])('does not import an invalid shared source: $value', async ({ value }) => {
  mockParams = { sharePostId: value };
  await render(<Create />);
  expect(mockComposer).toHaveBeenCalledWith(expect.objectContaining({ initialText: '' }));
});
