import { useEffect } from 'react';
import { Platform, AppState } from 'react-native';
import { runE0Migration } from '../lib/e0Migration.ts';
import { initCryptoIdentity, onKeyPackageConsumed } from '../lib/cryptoIdentity.ts';
import { useSession } from '../context/SessionContext.tsx';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../services/ownedApiRequest.ts';
import { supabase } from '../lib/supabase.ts';
async function apiRequest(owner: MessagingOwnerRequest, method: 'GET' | 'POST' | 'PUT', path: string, body?: object): Promise<{ data?: unknown; error?: unknown }> {
  try {
    const response = await fetchOwnedApi(`/api${path}`, { owner, method, body });
    const data: unknown = await response.json();
    return response.ok ? { data } : { error: 'Crypto registration was refused.' };
  } catch { return { error: 'Crypto registration was interrupted.' }; }
}
export function useCryptoInit(): void {
  const { userId } = useSession();
  useEffect(() => { void runE0Migration().catch(() => {}); }, []);
  useEffect(() => {
    if (!userId || Platform.OS === 'web') return;
    let active = true;
    let captured: MessagingOwnerRequest | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | null = null;
    let completedSession: string | null = null;
    let rerun = false;
    let refillGeneration = 0;
    const start = () => {
      if (!active) return;
      if (running) { rerun = true; return; }
      const owner = captureMessagingOwnerRequest();
      if (!owner || owner.ownerId !== userId || owner.sessionId === completedSession) return;
      captured?.invalidate(); captured = owner;
      const generation = refillGeneration;
      running = initCryptoIdentity({ owner,
        apiGet: (path) => apiRequest(owner, 'GET', path),
        apiPost: (path, body) => apiRequest(owner, 'POST', path, body),
        apiPut: (path, body) => apiRequest(owner, 'PUT', path, body),
      }).then(() => { if (owner.isCurrent() && generation === refillGeneration) completedSession = owner.sessionId; })
        .catch(() => {}).finally(() => { running = null; if (rerun && active) { rerun = false; clearTimeout(timer); timer = setTimeout(start, 0); } });
    };
    const refill = onKeyPackageConsumed(() => { refillGeneration += 1; completedSession = null; clearTimeout(timer); timer = setTimeout(start, 0); });
    start();
    // Never await auth calls inside the SDK auth callback.
    const auth = supabase.auth.onAuthStateChange(() => { clearTimeout(timer); timer = setTimeout(start, 0); });
    const app = AppState.addEventListener('change', (state) => { if (state === 'active') start(); });
    return () => { refill(); active = false; captured?.invalidate(); clearTimeout(timer); auth.data.subscription.unsubscribe(); app.remove(); };
  }, [userId]);
}
