/**
 * accountId — shared helper for resolving the currently signed-in account id
 * from contexts that have no React tree (e.g. checkpointArrivalTask.ts, a
 * module-root expo-task-manager background task).
 *
 * auth.ts's getSessionUserId() is dynamically imported so pure Node
 * node:test files never load '../lib/supabase.ts' (which statically imports
 * react-native and cannot run under node:test) — mirrors the getAuthToken()
 * lazy-import pattern in discoveryBookmarks.ts.
 *
 * Supabase's session persists via SecureStoreAdapter independent of React
 * (confirmed in src/lib/secureStore.ts / src/lib/supabase.ts), so this is
 * safely callable from a background task, not just component code.
 */

// undefined = use the real lazy-imported auth.ts (default)
// null      = force "no account" (signed out / unresolvable)
// '<id>'    = force this account id
let _testAccountId: string | null | undefined = undefined;

/**
 * Test seam — bypass the real auth/session lookup. Pass undefined to restore
 * the real lookup.
 */
export function _setTestAccountId(id: string | null | undefined): void {
  _testAccountId = id;
}

/**
 * Resolves the current account id, or null when no session is resolvable
 * (signed out, session not yet loaded, or the lookup itself errors).
 * Never throws — callers must treat null as "defer / don't guess", never as
 * a signal to fall back to an unscoped legacy key.
 */
export async function getCurrentAccountId(): Promise<string | null> {
  if (_testAccountId !== undefined) return _testAccountId;
  try {
    const { getSessionUserId } = await import('./auth.ts');
    return await getSessionUserId();
  } catch {
    return null;
  }
}
