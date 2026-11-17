// NOTE: intentionally exhaustive — the rank API is a separate transport.
jest.mock('../wallApi.ts', () => ({ sendAction: jest.fn(), sendImpression: jest.fn() }));
// NOTE: intentionally exhaustive — this installer needs AppState events only.
jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
// NOTE: intentionally exhaustive — avoid a real native authentication session.
jest.mock('../../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: { auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
// NOTE: intentionally exhaustive — controlled owner revision and lifecycle events.
jest.mock('../../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: jest.fn() }));
// NOTE: intentionally exhaustive — network requests are inspected, never sent.
jest.mock('../../../../services/ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn().mockResolvedValue({}) }));
// NOTE: intentionally exhaustive — controlled account-boundary notifications.
jest.mock('../../../../services/discoveryViewerScope.ts', () => ({ onDiscoveryScopeChange: jest.fn(() => jest.fn()) }));
jest.mock('../../../../services/intelConsent.ts', () => ({ ...jest.requireActual('../../../../services/intelConsent.ts'), readIntelConsent: jest.fn(), onIntelConsentChange: jest.fn(() => jest.fn()) }));
import { AppState } from 'react-native';
import { supabase } from '../../../../lib/supabase.ts';
import { captureMessagingOwnerRequest } from '../../../../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../../../../services/ownedApiRequest.ts';
import { readIntelConsent, onIntelConsentChange } from '../../../../services/intelConsent.ts';
import { installWallAnalytics } from '../installWallAnalytics.ts';
import { recordRealWorldOutcome } from '../wallAnalytics.ts';
import type { WallProjection } from '../../types/wallProjection.ts';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const granted = { status: 'ok', state: { enabled: true, consentVersion: 'v1', consentedAt: '2026-11-13T00:00:00Z', withdrawnAt: null, currentDisclosureVersion: 'v1' } };
const projection = { canonicalObjectId: 'place-1', objectType: 'place' } as unknown as WallProjection;
let currentOwner = 'a';
const owner = (id: string) => ({ ownerId: id, sessionId: `session-${id}`, isCurrent: () => currentOwner === id, invalidate: () => {} });
let install: ReturnType<typeof installWallAnalytics>;
beforeEach(() => {
  jest.clearAllMocks(); currentOwner = 'a'; AppState.currentState = 'active';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://example.test';
  (captureMessagingOwnerRequest as jest.Mock).mockImplementation(() => currentOwner ? owner(currentOwner) : null);
  (readIntelConsent as jest.Mock).mockResolvedValue(granted);
});
afterEach(() => { install?.dispose(); });
it('withdrawal cancels permission and delayed older reads cannot restore it', async () => {
  let resolveOld!: (value: unknown) => void;
  (readIntelConsent as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  install = installWallAnalytics(); await flush();
  (readIntelConsent as jest.Mock).mockResolvedValue({ status: 'ok', state: { ...granted.state, localWithdrawalPending: true } });
  (onIntelConsentChange as jest.Mock).mock.calls[0][0]('a');
  resolveOld(granted); await flush(); recordRealWorldOutcome(projection, 'see_place'); await flush();
  expect(fetchOwnedApi).not.toHaveBeenCalled();
});
it('logout and account switch revoke synchronously, then require new account consent', async () => {
  install = installWallAnalytics(); await flush(); recordRealWorldOutcome(projection, 'see_place'); await flush();
  expect(fetchOwnedApi).toHaveBeenCalledTimes(1);
  currentOwner = 'b';
  (readIntelConsent as jest.Mock).mockResolvedValue({ status: 'unreadable', reason: 'network' });
  (supabase.auth.onAuthStateChange as jest.Mock).mock.calls[0][0]('SIGNED_IN', {});
  recordRealWorldOutcome(projection, 'see_place'); await flush(); expect(fetchOwnedApi).toHaveBeenCalledTimes(1);
  currentOwner = ''; (supabase.auth.onAuthStateChange as jest.Mock).mock.calls[0][0]('SIGNED_OUT', null);
  recordRealWorldOutcome(projection, 'see_place'); await flush(); expect(fetchOwnedApi).toHaveBeenCalledTimes(1);
});
it('background invalidates and foreground requires fresh consent; disposal removes subscriptions', async () => {
  install = installWallAnalytics(); await flush();
  AppState.currentState = 'background'; (AppState.addEventListener as jest.Mock).mock.calls[0][1]('background');
  recordRealWorldOutcome(projection, 'see_place'); await flush(); expect(fetchOwnedApi).not.toHaveBeenCalled();
  (readIntelConsent as jest.Mock).mockResolvedValue({ status: 'ok', state: { ...granted.state, enabled: false } });
  AppState.currentState = 'active'; (AppState.addEventListener as jest.Mock).mock.calls[0][1]('active'); await flush();
  recordRealWorldOutcome(projection, 'see_place'); await flush(); expect(fetchOwnedApi).not.toHaveBeenCalled();
  install.dispose(); expect((AppState.addEventListener as jest.Mock).mock.results[0].value.remove).toHaveBeenCalled();
});
