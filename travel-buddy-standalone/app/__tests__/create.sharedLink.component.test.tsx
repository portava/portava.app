import React from 'react';
import { render } from '@testing-library/react-native';
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
beforeEach(() => { mockComposer.mockClear(); mockParams = {}; });

it('opens the native repost editor with an opaque source id', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  mockParams = { sharePostId: id };
  await render(<Create />);
  expect(mockDestination).toHaveBeenCalledWith(expect.objectContaining({ postId: id, destination: 'profile' }));
  expect(mockComposer).not.toHaveBeenCalled();
});

it.each([{ value: '../../private' }, { value: ['11111111-1111-4111-8111-111111111111'] }])('does not import an invalid shared source: $value', async ({ value }) => {
  mockParams = { sharePostId: value };
  await render(<Create />);
  expect(mockComposer).toHaveBeenCalledWith(expect.objectContaining({ initialText: '' }));
});
