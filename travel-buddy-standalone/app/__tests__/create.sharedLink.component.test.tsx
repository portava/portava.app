import React from 'react';
import { render } from '@testing-library/react-native';
import Create from '../create.tsx';
import { canonicalUrl } from '../../src/constants/canonicalUrl.ts';

let mockParams: { sharePostId?: string | string[] } = {};
const mockComposer = jest.fn();
// NOTE: This test verifies route-to-composer handoff; composer submit is covered by mounted PulseCreate tests.
jest.mock('../../src/components/PulseCreate', () => ({ UnifiedPostComposer: (props: unknown) => { mockComposer(props); return null; } }));
// NOTE: Query parameters and native navigation are the route's platform boundary.
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, router: { back: jest.fn(), canGoBack: () => true } }));
beforeEach(() => { mockComposer.mockClear(); mockParams = {}; });

it('prefills only the canonical post link and skips camera launch', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  mockParams = { sharePostId: id };
  await render(<Create />);
  expect(mockComposer).toHaveBeenCalledWith(expect.objectContaining({ initialText: canonicalUrl(`/posts/${id}`), openCameraOnMount: false, tripId: null }));
});

it.each([{ value: '../../private' }, { value: ['11111111-1111-4111-8111-111111111111'] }])('does not import an invalid shared source: $value', async ({ value }) => {
  mockParams = { sharePostId: value };
  await render(<Create />);
  expect(mockComposer).toHaveBeenCalledWith(expect.objectContaining({ initialText: '' }));
});
