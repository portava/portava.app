/**
 * The Memory screen mounts the marked parts of each VIDEO — census-highlights-
 * memories H184 (B58 MEM-SEGMENTS; server: routes/memorySegments.ts, 3809).
 *
 *   - a video item gets MemoryVideoSegments under it (chips for whoever the
 *     server serves them to); a photo gets nothing;
 *   - the owner gets the in/out editor's entry; anyone else never does;
 *   - while the server has no segments (3809 unapplied) nothing is shown.
 *
 * The mock preamble is memoryDetail.social.component.test.tsx's, copied so the
 * two suites stay independent (that file's tail is where other lanes append).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, act } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = { id: '33333333-3333-4333-8333-000000000001' };
let mockUserId = 'me';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount. The screen uses push/back/params/focus.
jest.mock('expo-router', () => ({
  router: { back: (...a: unknown[]) => mockBack(...a), push: (...a: unknown[]) => mockPush(...a) },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => {
    const R = jest.requireActual('react') as typeof import('react');
    R.useEffect(() => { cb(); }, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — CachedImage resolves through expo-image.
jest.mock('../../../src/components/CachedImage', () => ({ CachedImage: () => null }));

// NOTE: intentionally exhaustive — the real StampButton pulls the animation
// provider graph. This stand-in presses whatever controller it was handed, so
// the suite proves WHICH write the Memory's like performs.
jest.mock('../../../src/components/stamps/StampButton', () => {
  const { Pressable: P, Text: T } = jest.requireActual('react-native');
  return {
    StampButton: ({ controlledStamp }: { controlledStamp?: { toggle: () => void; count: number } }) => (
      <P testID="stamp-like" onPress={() => controlledStamp?.toggle()}><T>{`likes:${controlledStamp ? controlledStamp.count : 'uncontrolled'}`}</T></P>
    ),
  };
});

// NOTE: intentionally exhaustive — the real SessionContext starts auth work.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: mockUserId, isAuthed: true }),
}));
// NOTE: intentionally exhaustive — useMediaPicker reaches the native picker.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(async () => []) }),
}));
// NOTE: intentionally exhaustive — the §32 telemetry hook posts on mount.
jest.mock('../../../src/features/passport/useMemoryViewedTelemetry.ts', () => ({
  useMemoryViewedTelemetry: () => {},
}));

const MID = '33333333-3333-4333-8333-000000000001';
const PLACE = '66666666-6666-4666-8666-666666666666';
let mockMemory: Record<string, unknown> = {};
let mockGetMemory: jest.Mock;
const mockLike = jest.fn(async () => ({ ok: true, likeCount: 4 }));
const mockStampEntity = jest.fn();
const mockDelete = jest.fn(async () => ({ ok: true, operationId: 'x' }));
const mockSave = jest.fn(async () => ({ ok: true, savedByMe: true }));
const mockRespond = jest.fn(async () => ({ ok: true, status: 'approved' }));
const mockGetTags = jest.fn();

jest.mock('../../../src/services/memories', () => ({
  ...jest.requireActual('../../../src/services/memories'),
  getMemory: (...a: unknown[]) => mockGetMemory(...a),
  deleteMemory: (...a: unknown[]) => mockDelete(...(a as [])),
  deleteMemoryItem: async () => ({ ok: true }),
  addMemoryItem: async () => ({ ok: true }),
  likeMemory: (...a: unknown[]) => mockLike(...(a as [])),
  unlikeMemory: async () => ({ ok: true, likeCount: 3 }),
}));
// (`services/memories` and `services/memories.ts` resolve to ONE module, so one mock covers both import spellings.)
jest.mock('../../../src/services/stamps.ts', () => ({
  ...jest.requireActual('../../../src/services/stamps.ts'),
  stampEntity: (...a: unknown[]) => mockStampEntity(...a),
}));
jest.mock('../../../src/services/memorySocial.ts', () => ({
  ...jest.requireActual('../../../src/services/memorySocial.ts'),
  saveMemory: (...a: unknown[]) => mockSave(...(a as [])),
  unsaveMemory: async () => ({ ok: true, savedByMe: false }),
  respondToMemoryTag: (...a: unknown[]) => mockRespond(...(a as [])),
  getMemoryTags: (...a: unknown[]) => mockGetTags(...a),
}));


// H184 (3809): the per-video segments read. One stand-in for the shared loader the component calls.
const mockLoadSegments = jest.fn();
jest.mock('../../../src/features/memories/segments/memorySegmentsApi.ts', () => ({
  ...jest.requireActual('../../../src/features/memories/segments/memorySegmentsApi.ts'),
  loadMemorySegments: (...a: unknown[]) => mockLoadSegments(...a),
}));

import MemoryDetailScreen from '../[id].tsx';

const VIDEO = '21111111-1111-4111-8111-111111111111';
const PHOTO = '21111111-1111-4111-8111-111111111113';
const VIDEO_URL = 'post-media/owner/1760000000000.mp4';
function memoryOf(over: Record<string, unknown> = {}) {
  return {
    id: MID, ownerId: 'owner', title: 'Three days in Hoi An', caption: null, visibility: 'public',
    createdAt: '2026-09-01T00:00:00.000Z', owner: { id: 'owner', name: 'Olive', handle: 'olive', avatarUrl: null },
    items: [
      { id: VIDEO, mediaUrl: VIDEO_URL, mediaType: 'video/mp4', caption: null, position: 0, createdAt: '2026-09-01T00:00:00.000Z' },
      { id: PHOTO, mediaUrl: 'post-media/owner/1760000000001.jpg', mediaType: 'image/jpeg', caption: null, position: 1, createdAt: '2026-09-01T00:00:00.000Z' },
    ],
    likeCount: 3, likedByMe: false, saveCount: 0, savedByMe: false,
    locationCity: 'Hoi An', locationCountry: 'Vietnam', canonicalLocationId: PLACE, placeId: null,
    tags: [], anonymousParticipants: 0,
    ...over,
  };
}
const segs = [{ id: 's1', itemId: VIDEO, startMs: 1000, endMs: 5000, label: 'Lanterns', mediaUrl: VIDEO_URL, mediaType: 'video/mp4' }];

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  mockPush.mockReset(); mockBack.mockReset(); mockGetTags.mockReset();
  mockUserId = 'me';
  mockParams = { id: MID };
  mockMemory = memoryOf();
  mockGetMemory = jest.fn(async () => ({ ok: true, memory: mockMemory }));
  mockLoadSegments.mockReset();
  mockLoadSegments.mockResolvedValue({ state: 'ok', available: true, segments: segs });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { alertSpy.mockRestore(); });

describe('census H184 (B58 MEM-SEGMENTS): the marked parts of a video, on the Memory screen', () => {
  it('a viewer sees the video\'s chips under the video, and nothing under the photo', async () => {
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId(`memory-segments-${VIDEO}`)).toBeTruthy();
    expect(screen.getByText('Lanterns')).toBeTruthy();
    expect(screen.queryByTestId(`memory-segments-${PHOTO}`)).toBeNull();
    expect(screen.queryByTestId(`memory-segment-add-${VIDEO}`)).toBeNull();
    expect(mockLoadSegments).toHaveBeenCalledWith(MID);
  });

  it('the owner also gets the way to mark a part', async () => {
    mockUserId = 'owner';
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId(`memory-segment-add-${VIDEO}`)).toBeTruthy();
    expect(screen.getByTestId(`memory-segment-remove-s1`)).toBeTruthy();
  });

  it('while the server has no segments (3809 unapplied) nothing is shown, to the owner either', async () => {
    mockUserId = 'owner';
    mockLoadSegments.mockResolvedValue({ state: 'ok', available: false, segments: [] });
    await render(<MemoryDetailScreen />);
    await screen.findByTestId('memory-owner-menu');
    await act(async () => {});
    expect(screen.queryByTestId(`memory-segments-${VIDEO}`)).toBeNull();
    expect(screen.queryByTestId(`memory-segment-add-${VIDEO}`)).toBeNull();
  });

  it('a Memory with only photos never asks for segments', async () => {
    mockMemory = memoryOf({ items: [{ id: PHOTO, mediaUrl: 'post-media/owner/1.jpg', mediaType: 'image/jpeg', caption: null, position: 0, createdAt: '2026-09-01T00:00:00.000Z' }] });
    await render(<MemoryDetailScreen />);
    await screen.findByTestId('memory-search-entry');
    await act(async () => {});
    expect(mockLoadSegments).not.toHaveBeenCalled();
  });
});
