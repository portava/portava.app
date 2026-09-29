/**
 * The Memory screen's social controls — testing mode WP-06.
 *
 *   HM-F09  the like writes `memory_likes` (likeMemory), not an entity stamp;
 *           a refused delete is SAID, not hidden behind router.back().
 *   HM-F12  the tagged person approves or removes their own tag; the owner can
 *           remove a participant but never approve for them; a tagged person
 *           who may not read the Memory can still answer their tag.
 *   HM-F13  save toggles `memory_saves`; share opens the gated share sheet.
 *   HM-F11  the owner reaches their timeline and their history at this place.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

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

import MemoryDetailScreen from '../[id].tsx';

function memoryOf(over: Record<string, unknown> = {}) {
  return {
    id: MID, ownerId: 'owner', title: 'Three days in Hoi An', caption: null, visibility: 'public',
    createdAt: '2026-09-01T00:00:00.000Z', owner: { id: 'owner', name: 'Olive', handle: 'olive', avatarUrl: null },
    items: [], likeCount: 3, likedByMe: false, saveCount: 0, savedByMe: false,
    locationCity: 'Hoi An', locationCountry: 'Vietnam', canonicalLocationId: PLACE, placeId: null,
    tags: [], anonymousParticipants: 0,
    ...over,
  };
}

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  mockPush.mockReset(); mockBack.mockReset(); mockLike.mockClear(); mockStampEntity.mockReset();
  mockDelete.mockClear(); mockSave.mockClear(); mockRespond.mockClear(); mockGetTags.mockReset();
  mockUserId = 'me';
  mockParams = { id: MID };
  mockMemory = memoryOf();
  mockGetMemory = jest.fn(async () => ({ ok: true, memory: mockMemory }));
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { alertSpy.mockRestore(); });

describe('HM-F09 like', () => {
  it('the stamp on a Memory is controlled by the memory like, and writes memory_likes', async () => {
    await render(<MemoryDetailScreen />);
    expect(await screen.findByText('likes:3')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('stamp-like')); });
    await waitFor(() => expect(mockLike).toHaveBeenCalledWith(MID));
    expect(mockStampEntity).not.toHaveBeenCalled();
    expect(await screen.findByText('likes:4')).toBeTruthy();
  });

  it('a refused delete is reported and the screen stays', async () => {
    mockUserId = 'owner';
    mockDelete.mockResolvedValueOnce({ ok: false, kind: 'db_error', operationId: 'x' } as never);
    await render(<MemoryDetailScreen />);
    await screen.findByText('likes:3');
    // Owner menu → Delete → confirm Delete.
    await act(async () => { fireEvent.press(screen.getByTestId('memory-owner-menu')); });
    const options = alertSpy.mock.calls.find((c) => c[0] === 'Memory options')?.[2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => { options.find((o) => o.text === 'Delete')!.onPress!(); });
    const confirm = alertSpy.mock.calls.find((c) => c[0] === 'Delete memory?')?.[2] as Array<{ text: string; onPress?: () => Promise<void> }>;
    await act(async () => { await confirm.find((o) => o.text === 'Delete')!.onPress!(); });
    expect(mockDelete).toHaveBeenCalledWith(MID);
    expect(mockBack).not.toHaveBeenCalled();
    expect(alertSpy.mock.calls.some((c) => c[0] === 'Could not delete')).toBe(true);
  });
});

describe('HM-F13 save and share', () => {
  it('a non-owner can save; the save calls POST /save through the service', async () => {
    await render(<MemoryDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('memory-save-toggle')); });
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(MID));
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('the owner is not offered "save" on their own Memory, but can share', async () => {
    mockUserId = 'owner';
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId('memory-share-open')).toBeTruthy();
    expect(screen.queryByTestId('memory-save-toggle')).toBeNull();
  });
});

describe('HM-F12 participants', () => {
  it('the tagged person approves their own pending tag', async () => {
    mockMemory = memoryOf({ tags: [{ userId: 'me', status: 'pending', rung: 'NAMED', name: 'Me', handle: 'me' }] });
    await render(<MemoryDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('memory-tag-approve')); });
    await waitFor(() => expect(mockRespond).toHaveBeenCalledWith(MID, 'me', 'approve'));
    // The Memory is reloaded so the new status is the server's, not a guess.
    await waitFor(() => expect(mockGetMemory.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('the owner may remove a participant and is never offered an approve', async () => {
    mockUserId = 'owner';
    mockMemory = memoryOf({ tags: [{ userId: 'bea', status: 'pending', rung: 'NAMED', name: 'Bea', handle: 'bea' }] });
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId('memory-participant-bea')).toBeTruthy();
    expect(screen.queryByTestId('memory-tag-approve')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId('memory-participant-remove-bea')); });
    const confirm = alertSpy.mock.calls.find((c) => String(c[0]).startsWith('Remove Bea'))?.[2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => { confirm.find((o) => o.text === 'Remove')!.onPress!(); });
    await waitFor(() => expect(mockRespond).toHaveBeenCalledWith(MID, 'bea', 'remove'));
  });

  it('a tagged person who cannot read the Memory can still answer their tag', async () => {
    mockGetMemory = jest.fn(async () => ({ ok: false, message: 'Memory not found' }));
    mockGetTags.mockResolvedValue({ ok: true, tags: [{ userId: 'me', status: 'pending', rung: 'NAMED', name: 'Me', handle: 'me' }], anonymousParticipants: 0 });
    await render(<MemoryDetailScreen />);
    expect(await screen.findByText('Memory not found')).toBeTruthy();
    await act(async () => { fireEvent.press(await screen.findByTestId('memory-tag-approve')); });
    await waitFor(() => expect(mockRespond).toHaveBeenCalledWith(MID, 'me', 'approve'));
    expect(await screen.findByTestId('memory-tag-consent-done')).toBeTruthy();
  });

  it('someone who is not tagged sees no consent controls on an unreadable Memory', async () => {
    mockGetMemory = jest.fn(async () => ({ ok: false, message: 'Memory not found' }));
    mockGetTags.mockResolvedValue({ ok: false, kind: 'not_found', message: 'Memory not found' });
    await render(<MemoryDetailScreen />);
    expect(await screen.findByText('Memory not found')).toBeTruthy();
    await waitFor(() => expect(mockGetTags).toHaveBeenCalled());
    expect(screen.queryByTestId('memory-tag-consent')).toBeNull();
  });
});

describe('HM-F11 browse', () => {
  it('the owner reaches their timeline and their history at this place', async () => {
    mockUserId = 'owner';
    await render(<MemoryDetailScreen />);
    const timeline = await screen.findByTestId('memory-open-timeline');
    await act(async () => { fireEvent.press(timeline); });
    expect(mockPush).toHaveBeenCalledWith('/memory/timeline');
    await act(async () => { fireEvent.press(screen.getByTestId('memory-open-place-history')); });
    expect(mockPush.mock.calls[1][0]).toMatchObject({ pathname: '/memory/place-history', params: { placeId: PLACE } });
  });

  it('a non-owner is offered neither owner-private view', async () => {
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId('memory-open-saved')).toBeTruthy();
    expect(screen.queryByTestId('memory-open-timeline')).toBeNull();
    expect(screen.queryByTestId('memory-open-place-history')).toBeNull();
  });
});

