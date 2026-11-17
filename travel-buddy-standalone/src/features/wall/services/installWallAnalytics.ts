import { AppState } from 'react-native';
import { supabase, isSupabaseConfigured } from '../../../lib/supabase.ts';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../../../services/ownedApiRequest.ts';
import { onDiscoveryScopeChange } from '../../../services/discoveryViewerScope.ts';
import { readIntelConsent, hasValidConsent, onIntelConsentChange } from '../../../services/intelConsent.ts';
import { setWallAnalyticsSink, resetWallAnalyticsSink, setRealWorldOutcomeConsent, resetRealWorldOutcomeConsent } from './wallAnalytics.ts';
import { createWallAnalyticsTransport } from './wallAnalyticsTransport.ts';

/** Revalidate on events, never a timer. Unknown, suspended and changing owners
 * start fail-closed. An old read cannot grant permission to a newer session. */
export function installWallAnalytics(): { dispose(): void } {
  let disposed = false;
  let revision = 0;
  let granted: { owner: MessagingOwnerRequest; at: string } | null = null;
  const foreground = () => AppState.currentState === 'active' && (typeof document === 'undefined' || !document.hidden);
  const transport = createWallAnalyticsTransport({
    baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '', captureOwner: captureMessagingOwnerRequest, send: fetchOwnedApi,
    outcomeConsentAt: owner => foreground() && granted?.owner.isCurrent() && granted.owner.ownerId === owner.ownerId
      && granted.owner.sessionId === owner.sessionId ? granted.at : null,
  });
  setWallAnalyticsSink(transport);
  function invalidate() { revision++; granted = null; resetRealWorldOutcomeConsent(); transport.invalidate(); }
  function refresh() {
    invalidate();
    const started = revision;
    // Auth observers update their owner snapshots synchronously first.
    queueMicrotask(() => {
      if (disposed || revision !== started || !foreground()) return;
      const owner = captureMessagingOwnerRequest();
      if (!owner?.isCurrent()) return;
      void readIntelConsent(owner).then(read => {
        if (disposed || revision !== started || !owner.isCurrent() || !foreground()) return;
        if (read.status === 'ok' && hasValidConsent(read.state) && read.state.consentedAt && Number.isFinite(Date.parse(read.state.consentedAt))) {
          granted = { owner, at: read.state.consentedAt };
          setRealWorldOutcomeConsent(true, owner);
        }
      }).catch(() => {});
    });
  }
  const stopConsent = onIntelConsentChange(refresh);
  const stopOwner = onDiscoveryScopeChange(refresh);
  const appState = AppState.addEventListener('change', refresh);
  const auth = isSupabaseConfigured ? supabase.auth.onAuthStateChange(refresh).data.subscription : null;
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
  refresh();
  return { dispose() {
    disposed = true; invalidate(); transport.dispose(); stopConsent(); stopOwner(); appState.remove(); auth?.unsubscribe();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh);
    resetWallAnalyticsSink();
  } };
}
