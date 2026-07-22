/**
 * E-0 first-launch migration: AsyncStorage → SecureStore.
 *
 * Runs once at app startup (before any Supabase call) for users upgrading from
 * a build that stored the Supabase session in AsyncStorage.
 *
 * After this migration, the SecureStoreAdapter in supabase.ts takes over and all
 * subsequent session reads/writes go directly to SecureStore. This file only
 * handles the one-time copy of the existing session so users do not have to log
 * in again after upgrading.
 *
 * SAFE to call multiple times — writes SECURE_KEYS.E0_MIGRATION_DONE on success
 * and returns immediately on subsequent calls.
 *
 * NEVER log session tokens or SecureStore values.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SecureStoreAdapter, getSecure, setSecure, SECURE_KEYS, isNative } from './secureStore.ts';

/**
 * Derive the Supabase auth storage key from the project URL.
 * Supabase JS v2 stores sessions under: sb-<project-ref>-auth-token
 */
function supabaseSessionKey(): string | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    const projectRef = hostname.split('.')[0];
    if (!projectRef) return null;
    return `sb-${projectRef}-auth-token`;
  } catch {
    return null;
  }
}

/**
 * Run the E-0 one-shot migration.
 *
 * Call this from the root _layout.tsx before any Supabase auth operation, e.g.:
 *
 *   useEffect(() => { runE0Migration().catch(() => {}); }, []);
 *
 * Errors are silently swallowed — a failed migration means the user logs in
 * once more, which is acceptable.
 */
export async function runE0Migration(): Promise<void> {
  if (!isNative()) return; // SecureStore not available on web — skip

  // Idempotent: already done?
  const done = await getSecure(SECURE_KEYS.E0_MIGRATION_DONE);
  if (done === 'true') return;

  // Migrate Supabase session from AsyncStorage → SecureStore
  const sessionKey = supabaseSessionKey();
  if (sessionKey) {
    try {
      const existing = await AsyncStorage.getItem(sessionKey);
      if (existing) {
        // Write to SecureStore via the adapter (same interface Supabase SDK uses)
        await SecureStoreAdapter.setItem(sessionKey, existing);
        // Remove the plaintext copy from AsyncStorage
        await AsyncStorage.removeItem(sessionKey);
      }
    } catch {
      // Non-fatal — user may need to log in again; that is acceptable
    }
  }

  // Mark migration complete regardless of whether there was a session to move.
  // This prevents re-running on every cold start.
  await setSecure(SECURE_KEYS.E0_MIGRATION_DONE, 'true');
}
