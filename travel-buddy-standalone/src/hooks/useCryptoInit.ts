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

import { useEffect } from 'react';
import { Platform } from 'react-native';
import { runE0Migration } from '../lib/e0Migration.ts';
import { initCryptoIdentity } from '../lib/cryptoIdentity.ts';
import { freshToken } from '../services/apiToken.ts';

const API_BASE = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await freshToken();
  if (!token) return null;
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

export function useCryptoInit(): void {
  useEffect(() => {
    void (async () => {
      try {
        // E-0: migrate session storage from AsyncStorage → SecureStore.
        await runE0Migration();

        // E-1: key init requires Keychain/Keystore — not available on web.
        if (Platform.OS === 'web') return;

        const headers = await authHeaders();
        if (!headers) return; // user not signed in yet; will re-run on next launch

        await initCryptoIdentity({
          apiPost: async (path: string, body: unknown) => {
            try {
              const resp = await fetch(`${API_BASE}/api${path}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
              });
              const json = await resp.json().catch(() => ({}));
              return resp.ok
                ? { data: json, error: null }
                : { data: null, error: json };
            } catch (e) {
              return { data: null, error: String(e) };
            }
          },
          apiPut: async (path: string, body: unknown) => {
            try {
              const resp = await fetch(`${API_BASE}/api${path}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify(body),
              });
              const json = await resp.json().catch(() => ({}));
              return resp.ok
                ? { data: json, error: null }
                : { data: null, error: json };
            } catch (e) {
              return { data: null, error: String(e) };
            }
          },
        });
      } catch (_) {
        // Crypto init failure is non-fatal. Plaintext mode continues.
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // once per app launch
}
