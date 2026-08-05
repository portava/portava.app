/**
 * E-0/E-1: useCryptoInit
 *
 * Runs on every app launch (inside SessionProvider so a valid auth session
 * exists). Responsibilities:
 *   1. One-shot AsyncStorage → SecureStore migration (E-0).
 *   2. Idempotent identity key generation + device registration (E-1).
 *
 * Both operations are fire-and-forget. Failures are logged and suppressed —
 * the app remains fully functional in plaintext mode if crypto init fails
 * (e.g. EAS native build not present, or no network on first launch).
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { runE0Migration } from '../lib/e0Migration.ts';
import { initCryptoIdentity } from '../lib/cryptoIdentity.ts';
import { freshToken } from '../services/apiToken.ts';
import { useSession } from '../context/SessionContext.tsx';

const API_BASE = (process.env['EXPO_PUBLIC_API_BASE_URL'] ?? '').replace(/\/$/, '');

/**
 * Perform an authenticated JSON request. The token is fetched fresh per call
 * (never snapshotted) so a token refresh mid-init can't leave stale headers.
 */
async function apiRequest(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<{ data: unknown; error: unknown }> {
  try {
    const token = await freshToken();
    if (!token) return { data: null, error: 'not_authenticated' };
    const resp = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    return resp.ok
      ? { data: json, error: null }
      : { data: null, error: json };
  } catch (e) {
    return { data: null, error: String(e) };
  }
}

export function useCryptoInit(): void {
  const { userId } = useSession();
  // Last userId a key-init attempt was started for — prevents duplicate runs
  // from re-renders while allowing a fresh run per signed-in user.
  const initedForUserRef = useRef<string | null>(null);

  // E-0: migrate session storage from AsyncStorage → SecureStore. Must run
  // even while signed out — it is what moves an upgrading user's Supabase
  // session into SecureStore so they *become* signed in.
  useEffect(() => {
    void runE0Migration().catch(() => {
      // Non-fatal — user may need to log in again.
    });
  }, []); // once per app launch

  // E-1: identity keys + device registration. Keyed on userId so a user who
  // signs in mid-session (not just at cold start) gets E2EE without a restart.
  useEffect(() => {
    if (!userId) return;
    if (initedForUserRef.current === userId) return;
    initedForUserRef.current = userId;

    void (async () => {
      try {
        // Key init requires Keychain/Keystore — not available on web.
        if (Platform.OS === 'web') return;

        await initCryptoIdentity({
          apiPost: (path: string, body?: object) => apiRequest('POST', path, body),
          apiPut: (path: string, body: object) => apiRequest('PUT', path, body),
        });
      } catch (_) {
        // Crypto init failure is non-fatal. Plaintext mode continues. Reset the
        // guard so a re-sign-in (or remount) can retry.
        initedForUserRef.current = null;
      }
    })();
  }, [userId]);
}
