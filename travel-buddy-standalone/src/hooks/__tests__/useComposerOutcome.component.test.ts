// NOTE: auth SDK and transport boundaries; real owner observer, strict builder,
// feature gate, durable outbox and token ownership checks execute.
jest.mock('../../lib/supabase.ts', () => { const listeners = new Set(); return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (l: unknown) => { listeners.add(l); return { data: { subscription: { unsubscribe: () => listeners.delete(l) } } }; } } } }; });
const mockFlag = { enabled: true };
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({ useFeatureFlags: () => ({ isEnabled: () => mockFlag.enabled }) }));
import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useComposerOutcome } from '../useComposerOutcome.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../services/apiToken.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
const originalFetch = globalThis.fetch, originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock = jest.fn();
let actor = 'owner-a', session = 'session-a';
function signIn(a = actor, s = session) { actor = a; session = s; setDiscoveryViewerFromSession(a); seedObservedOwnerSession(a, s); _setTestSupabase({ auth: { getSession: async () => ({ data: { session: { access_token: observedOwnerAccessToken(a, s), expires_at: Math.floor(Date.now() / 1000) + 3600 } } }) } } as any); }
async function settle() { await act(async () => { for (let i = 0; i < 50; i++)
    await Promise.resolve(); }); }
beforeEach(async () => { await AsyncStorage.clear(); mockFlag.enabled = true; actor = 'owner-a'; session = 'session-a'; signIn(); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: false, status: 503 }); globalThis.fetch = fetchMock; });
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); _resetTestSupabase(); globalThis.fetch = originalFetch; if (originalBase === undefined)
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
else
    process.env.EXPO_PUBLIC_API_BASE_URL = originalBase; });
it('persists bounded enum-only payloads and retries the same ID after a lost acknowledgement', async () => {
    const first = await renderHook(() => useComposerOutcome('post'));
    await act(async () => first.result.current('upload_failed', 'network'));
    await settle();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body.events[0]).sort()).toEqual(['event_id', 'failure_code', 'outcome', 'surface', 'version']);
    const id = body.events[0].event_id;
    await first.unmount();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ accepted: 1 }) });
    await renderHook(() => useComposerOutcome('post'));
    await settle();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).events[0].event_id).toBe(id);
    expect(await AsyncStorage.getItem('rumazi.composer-outcomes.v1:owner-a')).toBeNull();
});
it('does not send unknown fields or data through runtime misuse, and disabling collection clears queued events', async () => {
    const h = await renderHook(() => useComposerOutcome('comment_sheet'));
    await act(async () => { (h.result.current as any)('private comment text', 'filename.mov'); });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => h.result.current('left_with_unsent'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mockFlag.enabled = false;
    await h.rerender({});
    await settle();
    expect(await AsyncStorage.getItem('rumazi.composer-outcomes.v1:owner-a')).toBeNull();
    await act(async () => h.result.current('discarded_draft'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('an old callback cannot dispatch under a new account or replacement login', async () => {
    const h = await renderHook(() => useComposerOutcome('comment_inline'));
    await act(async () => { emitObservedAuthEvent('SIGNED_OUT', null); setDiscoveryViewerFromSession('owner-b'); emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-b', 'session-b')); });
    await act(async () => h.result.current('published'));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
});
