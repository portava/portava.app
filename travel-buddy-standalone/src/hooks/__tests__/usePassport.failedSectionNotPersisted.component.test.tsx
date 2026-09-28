/**
 * A failed Memories read must not be WRITTEN DOWN as "you have no Memories".
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11 ("never swallow
 * projection/schema failures into plausible-looking empty history without
 * structured error state").
 *
 * THE DEFECT THIS GUARDS, and why it is the worst instance of its class in
 * this client. `usePassport` fetches five sections in parallel and did:
 *
 *     setMemories(memRes.ok ? memRes.data : []);
 *     ...
 *     savePassportSnapshot({ ..., memories: memRes.ok ? memRes.data : [] });
 *
 * The first line turns a failed read into an empty life on screen. The second
 * line PERSISTS it: the snapshot is an AsyncStorage stale-while-revalidate
 * cache with a one-hour TTL, and it is applied on the next open before any
 * network call. So one failed request erased the owner's own Memories from
 * their own Passport, and kept them erased across app launches for an hour —
 * from a lookup that never happened.
 *
 * The snapshot is only written when the PROFILE read succeeded, which is what
 * made this survivable long enough to ship: the section reads fail
 * independently of the profile read, and nothing downstream could tell an
 * empty section from an unread one.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const mockGetMyProfile = jest.fn();
const mockGetMyPassportPostcards = jest.fn();
const mockGetMyPassportStamps = jest.fn();
const mockGetMyPassportMemories = jest.fn();
const mockGetMyPassportSuggestions = jest.fn();
const mockSaveSnapshot = jest.fn();

jest.mock('../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — SessionContext reaches supabase auth on
// import and this suite needs only the owner id the snapshot key is built from.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'owner-1' }),
}));

jest.mock('../../services/profile.ts', () => ({
  ...jest.requireActual('../../services/profile.ts'),
  getMyProfile: (...a: unknown[]) => mockGetMyProfile(...a),
  getMyPassportPostcards: (...a: unknown[]) => mockGetMyPassportPostcards(...a),
}));

jest.mock('../../services/passportStamps.ts', () => ({
  ...jest.requireActual('../../services/passportStamps.ts'),
  getMyPassportStamps: (...a: unknown[]) => mockGetMyPassportStamps(...a),
  getMyPassportMemories: (...a: unknown[]) => mockGetMyPassportMemories(...a),
  getMyPassportSuggestions: (...a: unknown[]) => mockGetMyPassportSuggestions(...a),
}));

jest.mock('../useSnapshotCache.ts', () => ({
  ...jest.requireActual('../useSnapshotCache.ts'),
  useSnapshotCache: () => ({
    snapshot: null,
    isStale: false,
    save: (data: unknown) => mockSaveSnapshot(data),
    clear: jest.fn(),
  }),
}));

import { usePassport } from '../usePassport.ts';

const PROFILE = { id: 'owner-1', handle: 'owner', name: 'Owner' };

const MEMORY = {
  id: 'mem-1',
  title: 'The night in Osaka',
  description: null,
  city: 'Osaka',
  country: 'Japan',
  photoUrl: null,
  createdAt: '2024-05-01T00:00:00.000Z',
  earnedAt: '2024-05-01T00:00:00.000Z',
};

function Probe({ onState }: { onState: (s: ReturnType<typeof usePassport>) => void }) {
  const state = usePassport();
  onState(state);
  return <Text>{String(state.memories.length)}</Text>;
}

async function mountPassport(): Promise<ReturnType<typeof usePassport>> {
  let last!: ReturnType<typeof usePassport>;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(<Probe onState={(s) => { last = s; }} />);
  });
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  act(() => { tree?.unmount(); });
  return last;
}

describe('usePassport — an unread section is never written down as an empty one', () => {
  beforeEach(() => {
    mockSaveSnapshot.mockReset();
    mockGetMyProfile.mockReset().mockResolvedValue({ ok: true, data: PROFILE });
    mockGetMyPassportPostcards.mockReset().mockResolvedValue({ ok: true, data: [] });
    mockGetMyPassportStamps.mockReset().mockResolvedValue({ ok: true, data: [], total: 0 });
    mockGetMyPassportMemories.mockReset().mockResolvedValue({ ok: true, data: [MEMORY] });
    mockGetMyPassportSuggestions.mockReset().mockResolvedValue({ ok: true, data: [] });
  });

  it('does not persist a snapshot when the Memories read failed', async () => {
    mockGetMyPassportMemories.mockResolvedValue({
      ok: false, message: 'We could not load your memories. Please try again.',
    });

    const state = await mountPassport();

    // Before the fix: save() was called with `memories: []`, and that empty
    // list was served as the owner's own history on the next open for an hour.
    const persistedEmptyMemories = mockSaveSnapshot.mock.calls.some(
      ([data]) => Array.isArray((data as { memories?: unknown }).memories)
        && (data as { memories: unknown[] }).memories.length === 0,
    );
    expect(persistedEmptyMemories).toBe(false);

    // And the hook says, in a state the UI can read, that it does not know.
    expect(state.memoriesUnreadable).toBe(true);
  });

  it('still persists the snapshot when every section read succeeded', async () => {
    const state = await mountPassport();

    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveSnapshot.mock.calls[0][0]).toEqual(
      expect.objectContaining({ memories: [expect.objectContaining({ id: 'mem-1' })] }),
    );
    expect(state.memoriesUnreadable).toBe(false);
  });

  it('persists a genuinely empty Memories list, because that one is true', async () => {
    mockGetMyPassportMemories.mockResolvedValue({ ok: true, data: [] });

    const state = await mountPassport();

    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveSnapshot.mock.calls[0][0]).toEqual(
      expect.objectContaining({ memories: [] }),
    );
    expect(state.memoriesUnreadable).toBe(false);
  });
});
