/**
 * The Memory screen mounts the owner's narrative card (census-highlights-
 * memories H14 / H172 / H265, B58 cluster MEM-NARR-2) — and only for the owner.
 *
 *   - the owner sees the summary the server built from the Memory's own facts;
 *   - anyone else sees no narrative control at all, and the screen asks the
 *     narrative routes nothing on their behalf (the server would answer 404).
 *
 * The card's own behaviour is
 * src/features/memories/narrative/__tests__/memoryNarrative.component.test.tsx.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

const MID = '33333333-3333-4333-8333-000000000002';
let mockUserId = 'owner';
let mockFlags: Record<string, boolean> = {};

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount. The screen uses push/back/params/focus.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: '33333333-3333-4333-8333-000000000002' }),
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

// The id is a literal: babel-jest hoists a const a mock factory reads above `MID`.
const MEMORY = {
  id: '33333333-3333-4333-8333-000000000002', ownerId: 'owner', title: 'Sunset walk', caption: 'Best bánh mì of the trip', visibility: 'only_me',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  owner: { id: 'owner', name: 'Olive', handle: 'olive', avatarUrl: null },
  items: [], likeCount: 0, likedByMe: false, saveCount: 0, savedByMe: false,
  locationCity: 'Da Nang', locationCountry: 'Vietnam', canonicalLocationId: null, placeId: null, tags: [], anonymousParticipants: 0,
};

jest.mock('../../../src/services/memories', () => ({
  ...jest.requireActual('../../../src/services/memories'),
  getMemory: async () => ({ ok: true, memory: MEMORY }),
  deleteMemory: async () => ({ ok: true }),
  deleteMemoryItem: async () => ({ ok: true }),
  addMemoryItem: async () => ({ ok: true }),
}));

import MemoryDetailScreen from '../[id].tsx';

const SUMMARY = '“Sunset walk”, in Da Nang, Vietnam. You wrote: “Best bánh mì of the trip”';
const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  mockFlags = { memory_narrative_ai_enabled: true };
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('https://api.test', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === `/api/memories/${MID}/narrative`) {
      return { ok: true, status: 200, json: async () => ({
        narrative: { memory_id: MID, renderer: 'deterministic@1', summary: SUMMARY, original_text: { title: MEMORY.title, caption: MEMORY.caption }, original_language: 'und' },
        ai: { available: false, reason: 'consent_required' },
      }) } as unknown as Response;
    }
    if (path === '/api/me/memory-narrative-ai-consent') {
      return { ok: true, status: 200, json: async () => ({
        available: true, enabled: false, consentVersion: null, consentedAt: null, withdrawnAt: null,
        currentDisclosureVersion: 'memory_narrative_ai_v1', disclosureText: 'Optional AI summaries.',
      }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const narrativeCalls = () => calls.filter((c) => c.includes('/narrative') || c.includes('memory-narrative-ai-consent'));

describe('the Memory screen mounts the narrative card for the owner only', () => {
  it('the owner sees the summary built from the Memory\'s own facts, and the opt-in beside it', async () => {
    mockUserId = 'owner';
    await render(<MemoryDetailScreen />);
    expect((await screen.findByTestId('memory-narrative-summary')).props.children).toBe(SUMMARY);
    expect(await screen.findByTestId('memory-narrative-ai-consent-toggle')).toBeTruthy();
    expect(screen.queryByTestId('memory-narrative-ai-draft')).toBeNull();
    expect(narrativeCalls()).toEqual([`GET /api/memories/${MID}/narrative`, 'GET /api/me/memory-narrative-ai-consent']);
  });

  it('a non-owner sees no narrative control, and nothing is asked of the narrative routes', async () => {
    mockUserId = 'someone-else';
    await render(<MemoryDetailScreen />);
    expect(await screen.findByTestId('memory-search-entry')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(() => expect(screen.queryByTestId('memory-owner-menu')).toBeNull());
    expect(screen.queryByTestId('memory-narrative-card')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-ai-consent-toggle')).toBeNull();
    expect(screen.queryByTestId('memory-narrative-error')).toBeNull();
    expect(narrativeCalls()).toEqual([]);
  });
});

it('probe: the renderer still commits after the cases above', async () => {
  await render(<Text testID="probe">probe</Text>);
  expect(screen.getByTestId('probe')).toBeTruthy();
});
