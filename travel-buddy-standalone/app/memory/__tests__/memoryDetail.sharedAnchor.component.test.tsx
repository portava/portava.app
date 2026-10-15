/**
 * The Memory screen mounts "Remember this together" (census-highlights-memories
 * H53, §5; B58 cluster MEM-ANCHOR-2) — one line-neutral mount in app/memory/[id].tsx.
 *
 *   - flag ON, the owner: the people the server says can be invited are on the
 *     Memory screen itself;
 *   - flag ON, someone else's Memory: no invite control, and the invitable list
 *     is never asked for;
 *   - flag OFF: the screen renders as it did before, and asks the anchor routes
 *     nothing at all.
 *
 * The panel's own behaviour is
 * src/features/memories/shared/__tests__/sharedAnchors.component.test.tsx.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const MID = '44444444-4444-4444-8444-000000000001';
const OWNER = '55555555-5555-4555-8555-000000000001';
const BEA = '55555555-5555-4555-8555-000000000002';
let mockUserId = OWNER;
let mockFlags: Record<string, boolean> = {};

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount. The screen uses push/back/params/focus.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: '44444444-4444-4444-8444-000000000001' }),
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

// NOTE: intentionally exhaustive — StampButton pulls the stamps service graph.
jest.mock('../../../src/components/stamps/StampButton', () => ({ StampButton: () => null }));

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

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

// The ids are literals: babel-jest hoists a const a mock factory reads above them.
const MEMORY = {
  id: '44444444-4444-4444-8444-000000000001', ownerId: '55555555-5555-4555-8555-000000000001', title: 'Night market', caption: null, visibility: 'only_me',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  owner: { id: '55555555-5555-4555-8555-000000000001', name: 'Olive', handle: 'olive', avatarUrl: null },
  items: [], likeCount: 0, likedByMe: false, saveCount: 0, savedByMe: false,
  locationCity: null, locationCountry: null, canonicalLocationId: null, placeId: null, tags: [], anonymousParticipants: 0,
};

jest.mock('../../../src/services/memories', () => ({
  ...jest.requireActual('../../../src/services/memories'),
  getMemory: async () => ({ ok: true, memory: MEMORY }),
  deleteMemory: async () => ({ ok: true }),
  deleteMemoryItem: async () => ({ ok: true }),
  addMemoryItem: async () => ({ ok: true }),
}));

import MemoryDetailScreen from '../[id].tsx';

const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  mockFlags = { memory_shared_anchors_enabled: true };
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('https://api.test', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/me/memory-shared-anchors') {
      return { ok: true, status: 200, json: async () => ({ anchors: [] }) } as unknown as Response;
    }
    if (path === `/api/memories/${MID}/shared-anchor/invitable`) {
      return { ok: true, status: 200, json: async () => ({ people: [{ userId: BEA, handle: 'bea' }] }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const anchorCalls = () => calls.filter((c) => c.includes('shared-anchor'));

describe('the Memory screen mounts "Remember this together"', () => {
  it('the owner sees the people the server says can be invited, on the Memory screen', async () => {
    mockUserId = OWNER;
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId(`shared-anchor-invite-${BEA}`)).toBeTruthy();
    expect(screen.getByText('@bea')).toBeTruthy();
    expect(anchorCalls()).toEqual(['GET /api/me/memory-shared-anchors', `GET /api/memories/${MID}/shared-anchor/invitable`]);
  });

  it("someone else's Memory: no invite control, and the invitable list is never asked for", async () => {
    mockUserId = BEA;
    await render(<MemoryDetailScreen />);
    await screen.findAllByText('Night market');
    await waitFor(() => expect(anchorCalls()).toEqual(['GET /api/me/memory-shared-anchors']));
    expect(screen.queryByTestId('shared-anchor-invite-list')).toBeNull();
    expect(screen.queryByTestId('shared-anchor-panel')).toBeNull();
  });

  it('flag OFF: the screen renders, and the anchor routes are asked nothing', async () => {
    mockUserId = OWNER;
    mockFlags = {};
    await render(<MemoryDetailScreen />);
    await screen.findAllByText('Night market');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('shared-anchor-panel')).toBeNull();
    expect(anchorCalls()).toEqual([]);
  });
});
