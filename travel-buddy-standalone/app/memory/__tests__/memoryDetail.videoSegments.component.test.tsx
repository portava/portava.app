import React from 'react';
import { AppState } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import MemoryDetailScreen from '../[id]';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const source = { assetId: '44444444-4444-4444-8444-444444444444', assetVersion: 3, durationMs: 10000, mediaRef: `post-media/${ownerId}/original.mp4` };
let mockUserId = ownerId;
let mockItems: Array<Record<string, unknown>>;
let mockSegments: Array<Record<string, unknown>>;
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();
const mockPlay = jest.fn().mockResolvedValue(undefined);
const mockSeek = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => { return {
  ...jest.requireActual('../../../src/__mocks__/expo-router'),
  useLocalSearchParams: () => ({ id: '22222222-2222-4222-8222-222222222222' }),
  useFocusEffect: (callback: () => (() => void) | void) => require('react').useEffect(callback, [callback]),
}; });
jest.mock('../../../src/context/SessionContext', () => { return { useSession: () => ({ userId: mockUserId }) }; });
jest.mock('../../../src/lib/supabase', () => { return { supabase: { auth: {
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: jest.fn() } } }),
} } }; });
jest.mock('../../../src/services/memoryVideoSegments', () => { return {
  ...jest.requireActual('../../../src/services/memoryVideoSegments'),
  listMemoryVideoSegments: (...args: unknown[]) => mockList(...args),
  createMemoryVideoSegment: (...args: unknown[]) => mockCreate(...args),
  deleteMemoryVideoSegment: (...args: unknown[]) => mockDelete(...args),
  resolveMemoryVideoOriginal: async () => ({ ok: true, uri: 'https://storage.test/storage/v1/object/sign/post-media/original.mp4?token=private' }),
}; });
jest.mock('../../../src/services/memories', () => { return {
  getMemory: async () => ({ ok: true, memory: {
    id: '22222222-2222-4222-8222-222222222222', ownerId: '11111111-1111-4111-8111-111111111111',
    title: 'At the harbour', createdAt: '2026-10-16T10:00:00Z', visibility: 'only_me', state: 'published', items: mockItems,
  } }),
  deleteMemoryItem: jest.fn(), deleteMemory: jest.fn(), addMemoryItem: jest.fn(),
}; });
jest.mock('../../../src/components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: (props: object) => <View testID="existing-image" {...props} /> };
});
jest.mock('../../../src/features/memories/social/MemorySocialBar', () => { return { MemorySocialBar: () => null }; });
jest.mock('../../../src/features/memories/social/MemoryBrowseLinks', () => { return { MemoryBrowseLinks: () => null }; });
jest.mock('../../../src/features/memories/social/MemoryParticipantsSection', () => { return { MemoryParticipantsSection: () => null, MemoryTagConsentFallback: () => null }; });
jest.mock('../../../src/features/memories/actions/MemoryActionBar', () => { return { MemoryActionBar: () => null, isAutoAction: () => false }; });
jest.mock('../../../src/features/passport/useMemoryViewedTelemetry', () => { return { useMemoryViewedTelemetry: () => undefined }; });
jest.mock('../../../src/hooks/useMediaPicker', () => { return { useMediaPicker: () => ({ pickMedia: jest.fn() }) }; });
jest.mock('../../../src/hooks/useNavBarCollapse', () => { return { useNavBarScrollHandler: () => undefined }; });
jest.mock('../../../src/hooks/useBottomInset', () => { return { PlainBottomFiller: () => null }; });
jest.mock('react-native-safe-area-context', () => { return {
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}; });
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { ResizeMode: { CONTAIN: 'contain' }, Video: React.forwardRef((props: object, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      loadAsync: async () => undefined, unloadAsync: async () => undefined, pauseAsync: async () => undefined,
      playAsync: mockPlay, setPositionAsync: mockSeek,
    }));
    return <View testID="original-video" {...props} />;
  }) };
});

beforeEach(() => {
  jest.clearAllMocks(); mockUserId = ownerId; mockSegments = [];
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  mockItems = [
    { id: itemId, mediaType: 'video/mp4', mediaUrl: `post-media/${ownerId}/original.mp4`, caption: 'My video' },
    { id: source.assetId, mediaType: 'image/jpeg', mediaUrl: `post-media/${ownerId}/photo.jpg`, caption: 'My photo' },
  ];
  mockList.mockImplementation(async () => ({ ok: true, source, segments: [...mockSegments] }));
  mockCreate.mockImplementation(async (_scope, _source, input) => {
    const segment = { ...input, ...source, ownerId, memoryId, itemId, id: input.operationId, source: 'owner_asserted', createdAt: '2026-10-16T10:00:00Z' };
    mockSegments = [segment]; return { ok: true, created: true, segment };
  });
  mockDelete.mockImplementation(async () => { mockSegments = []; return { ok: true }; });
});
async function ready() { await waitFor(() => expect(screen.queryByLabelText('Loading video segments')).toBeNull()); }

it('reaches list/add/play/remove from the existing owner Memory, with one original player and unchanged photos', async () => {
  await render(<MemoryDetailScreen />);
  await screen.findByTestId('memory-video-segments'); await ready();
  expect(screen.getAllByTestId('existing-image')).toHaveLength(1);
  expect(screen.getAllByTestId('original-video')).toHaveLength(1);
  await fireEvent.changeText(screen.getByLabelText('Segment start in seconds'), '1');
  await fireEvent.changeText(screen.getByLabelText('Segment end in seconds'), '4');
  await fireEvent.changeText(screen.getByLabelText('Segment label'), 'Harbour');
  await fireEvent.press(screen.getByLabelText('Save video segment')); await ready();
  expect(mockCreate).toHaveBeenCalledWith({ ownerId, memoryId, itemId }, source,
    expect.objectContaining({ startMs: 1000, endMs: 4000, label: 'Harbour' }), expect.any(AbortSignal));
  await fireEvent.press(screen.getByLabelText('Play segment Harbour 1–4')); await ready();
  expect(mockSeek).toHaveBeenCalledWith(1000, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 });
  expect(mockPlay).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('Remove segment Harbour 1–4')); await ready();
  expect(screen.queryByText('Harbour')).toBeNull();
  expect(mockDelete).toHaveBeenCalled();
  expect(screen.getAllByTestId('original-video')).toHaveLength(1);
});

it('does not mount owner segments or change the existing non-owner media path', async () => {
  mockUserId = source.assetId;
  await render(<MemoryDetailScreen />);
  await screen.findByText('My video');
  expect(screen.queryByTestId('memory-video-segments')).toBeNull();
  expect(screen.getAllByTestId('existing-image')).toHaveLength(2);
  expect(mockList).not.toHaveBeenCalled();
});

it('supports the existing plain video media type without treating images as video', async () => {
  mockItems[0].mediaType = 'video';
  await render(<MemoryDetailScreen />);
  await screen.findByTestId('memory-video-segments'); await ready();
  expect(screen.getAllByTestId('existing-image')).toHaveLength(1);
  expect(mockList.mock.calls[0][0]).toEqual({ ownerId, memoryId, itemId });
});
