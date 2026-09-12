/**
 * The two things every trips feature service needs before it can call the
 * API — is Supabase configured here, and a fresh bearer token — without
 * importing `lib/supabase.ts` at module load. That module reaches
 * `expo-secure-store` through `react-native`, which node:test cannot load
 * (scripts/run-node-tests.mjs's KNOWN_BROKEN records the shape), so a
 * service that imported it statically could never have a node test. The
 * token helper is loaded lazily on the first real call; tests inject one.
 */
type TokenSource = () => Promise<string | null>;

let _testToken: TokenSource | null = null;

/** Test seam: a token source to use instead of apiToken.ts; null restores. */
export function _setTestToken(fn: TokenSource | null): void {
  _testToken = fn;
}

/** Same computation as lib/supabase.ts's isSupabaseConfigured, read at call time. */
export function isConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

export const apiBase = (): string => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export async function bearerToken(): Promise<string | null> {
  if (_testToken) return _testToken();
  const { freshToken } = await import('../../../services/apiToken.ts');
  return freshToken();
}
