/**
 * The Memory screens mount the G141 caption assist (census-input-intelligence
 * G141; B58 IN-G141), end to end through the real service modules with only
 * `fetch` faked:
 *
 *   - flag OFF (main's state): no "Suggest with AI", and the screens send no
 *     /input-assistance request at all — exactly what they sent before;
 *   - flag ON, /memory/new: one tap sends the caption as `memory.caption` with
 *     the opt-in and NO Memory id (a new Memory has none) and no draft field;
 *   - flag ON, /memory/edit: the tap carries THIS Memory's id, so the server can
 *     apply its owner's controls;
 *   - a proposal lands in the editable caption only when tapped, and nothing is
 *     saved until the person presses Save — then the PATCH carries the edited
 *     caption.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';
import { _resetMemoryOperationIds } from '../../../src/services/memories.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../../src/platform/input-assistance/services/policyStore.ts';

const MID = '55555555-5555-4555-8555-555555555555';
let mockRouteId: string | undefined = MID;

// NOTE: intentional stub — the screens use only `router`, `useLocalSearchParams`
// and `Redirect`; expo-router's native navigation runtime is not available here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => (mockRouteId ? { id: mockRouteId } : {}),
  Redirect: () => null,
}));

// NOTE: intentional stub — only the insets hook is used; the real module needs
// native safe-area measurement.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

// NOTE: intentional stub — the real hook opens the native image library.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: async () => [] }),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location and
// other native modules that crash under jest; no place is picked here.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

const mockFlags: Record<string, boolean> = {};
// NOTE: intentionally exhaustive — the caption assist reads only `isEnabled`;
// the real provider fetches /api/feature-flags.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

_seedPolicy(_SEED_CONTEXTS, { caption: { debounceMs: 0, privacyClass: 'public', allowAI: true, allowedSuggestionTypes: ['entity', 'ai_suggestion', 'validation'] } });

type Call = { url: string; method: string; body: any };
function installFetch() {
  const calls: Call[] = [];
  const memory = {
    id: MID, ownerId: 'me', title: 'Dinner', caption: 'great dinner tonight', visibility: 'only_me', allowedUserIds: [],
    hiddenUserIds: [], tripId: null, eventId: null, placeId: null, locationCity: null, locationCountry: null,
    locationLat: null, locationLng: null, canonicalLocationId: null, startsAt: null, endsAt: null, state: 'published',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: null,
  };
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    let body: any = init.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* raw */ }
    calls.push({ url, method, body });
    if (url === 'https://api.test/api/input-assistance/suggest') {
      const text = 'What a great dinner tonight!';
      return {
        ok: true, status: 200, json: async () => ({
          requestId: 'r1', policyVersion: 'test-policy-v1', schemaVersion: 1, context: 'caption',
          suggestions: [{ id: 'caption:aiwrite:0', type: 'ai_suggestion', context: 'caption', label: text, replacementText: text,
            action: { type: 'replace_text', text }, confidence: 0.4, source: 'ai', reason: 'AI-suggested draft', policyVersion: 'test-policy-v1' }],
        }),
      };
    }
    if (url === 'https://api.test/api/memory-types') return { ok: true, status: 200, json: async () => ({ enabled: false, types: [], defaultType: null }) };
    if (url === `https://api.test/api/memories/${MID}` && method === 'GET') return { ok: true, status: 200, json: async () => ({ memory }) };
    if (url === `https://api.test/api/memories/${MID}` && method === 'PATCH') return { ok: true, status: 200, json: async () => ({ memory: { ...memory, ...body } }) };
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  }) as unknown as typeof fetch;
  return calls;
}
const suggests = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/api/input-assistance/suggest'));

describe('G141 — the caption assist on the Memory screens', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _resetMemoryOperationIds();
    for (const k of Object.keys(mockFlags)) delete mockFlags[k];
    mockRouteId = MID;
  });
  afterEach(() => { global.fetch = realFetch; process.env.EXPO_PUBLIC_API_BASE_URL = realBase; });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const Edit = () => { const S = require('../edit.tsx').default as React.ComponentType; return <S />; };
  const New = () => { const S = require('../new.tsx').default as React.ComponentType; return <S />; };
  /* eslint-enable @typescript-eslint/no-var-requires */

  it('flag OFF: neither screen offers it, and neither sends an /input-assistance request', async () => {
    const calls = installFetch();
    await render(<Edit />);
    expect(await screen.findByDisplayValue('great dinner tonight')).toBeTruthy();
    expect(screen.queryByTestId('memory-edit-caption-ai-button')).toBeNull();
    mockRouteId = undefined;
    await render(<New />);
    await fireEvent.changeText(screen.getByPlaceholderText('What made this moment special?'), 'great dinner tonight');
    expect(screen.queryByTestId('memory-create-caption-ai-button')).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(suggests(calls)).toHaveLength(0);
  });

  it('flag ON, /memory/new: one tap sends memory.caption with the opt-in, no Memory id and no draft', async () => {
    mockFlags.compass_ai_writing_enabled = true;
    mockRouteId = undefined;
    const calls = installFetch();
    await render(<New />);
    await fireEvent.changeText(screen.getByPlaceholderText('What made this moment special?'), 'great dinner tonight');
    await fireEvent.press(await screen.findByTestId('memory-create-caption-ai-button'));
    await waitFor(() => expect(suggests(calls)).toHaveLength(1));
    const body = suggests(calls)[0]!.body;
    expect(body).toMatchObject({ context: 'caption', fieldId: 'memory.caption', text: 'great dinner tonight', aiAssist: true });
    expect(body.sessionContext).toBeUndefined();
    expect(body.draft).toBeUndefined();
    expect(body.city).toBeUndefined();
    expect(body.client).toMatchObject({ suggestionTypes: ['ai_suggestion'], actionTypes: ['replace_text'] });
  });

  it('flag ON, /memory/edit: the tap carries this Memory id; the proposal is applied only on tap and saved only on Save', async () => {
    mockFlags.compass_ai_writing_enabled = true;
    const calls = installFetch();
    await render(<Edit />);
    expect(await screen.findByDisplayValue('great dinner tonight')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('memory-edit-caption-ai-button'));
    await waitFor(() => expect(suggests(calls)).toHaveLength(1));
    expect(suggests(calls)[0]!.body).toMatchObject({ fieldId: 'memory.caption', sessionContext: { memoryId: MID }, aiAssist: true });
    const proposal = await screen.findByText('What a great dinner tonight!');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    await fireEvent.press(proposal);
    expect(await screen.findByDisplayValue('What a great dinner tonight!')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0); // inserted, not saved
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PATCH')!.body.caption).toBe('What a great dinner tonight!');
  });
});
