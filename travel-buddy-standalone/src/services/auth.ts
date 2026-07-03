/**
 * Auth service — thin wrapper over supabase-js auth. UI calls these, never
 * supabase.auth directly, so the implementation can be swapped or mocked.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export interface AuthResult {
  userId: string | null;
  error: string | null;
}

/** Classify a caught error into a user-readable message. */
function networkMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    msg.includes('Network request failed') ||
    msg.includes('Failed to fetch') ||
    msg.includes('ERR_NAME_NOT_RESOLVED') ||
    msg.includes('ENOTFOUND')
  ) {
    return 'Cannot reach the server. Check your internet connection and try again.';
  }
  return msg || 'Something went wrong. Please try again.';
}

export async function signUp(email: string, password: string, meta?: { name?: string; handle?: string }): Promise<AuthResult> {
  if (!isSupabaseConfigured) return { userId: null, error: 'Supabase not configured' };
  if (__DEV__) console.log('[Auth] signUp →', email);
  let data: any, error: any;
  try {
    ({ data, error } = await supabase.auth.signUp({ email, password, options: { data: meta } }));
  } catch (e) {
    return { userId: null, error: networkMessage(e) };
  }
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  if (userId && data.session) {
    await ensureProfile(userId, email, meta);
  }
  return { userId, error: null };
}

/**
 * Ensure a profile row exists for the signed-in user. Idempotent (on conflict do nothing).
 * Routes through the API server so the service-role key is used for the insert, bypassing
 * PostgREST RLS failures caused by the P-256 JWT key rotation.
 *
 * Throws if EXPO_PUBLIC_API_BASE_URL is not set or the session token is unavailable.
 * The direct Supabase upsert fallback has been intentionally removed — PostgREST cannot
 * verify P-256 JWTs so auth.uid() returns NULL under RLS and direct inserts fail for new users.
 */
export async function ensureProfile(userId: string, email: string, meta?: { name?: string; handle?: string }): Promise<void> {
  if (!isSupabaseConfigured) return;

  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!apiBase) {
    throw new Error('ensureProfile: EXPO_PUBLIC_API_BASE_URL is not configured');
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    throw new Error('ensureProfile: no session token available');
  }

  const res = await fetch(`${apiBase}/api/profile/ensure`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ email, name: meta?.name, handle: meta?.handle }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `ensureProfile: API returned ${res.status} — ${(body as any)?.message ?? 'unknown error'}`,
    );
  }
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!isSupabaseConfigured) return { userId: null, error: 'Supabase not configured' };
  if (__DEV__) console.log('[Auth] signIn →', email);
  let data: any, error: any;
  try {
    ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
  } catch (e) {
    return { userId: null, error: networkMessage(e) };
  }
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  if (userId) await ensureProfile(userId, email, { name: data.user?.user_metadata?.name });
  return { userId, error: null };
}

export async function signOut(): Promise<void> {
  if (!isSupabaseConfigured) return;
  await supabase.auth.signOut();
}

export async function getSessionUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

/** Subscribe to auth changes. Returns an unsubscribe function. */
export function onAuthChange(cb: (userId: string | null) => void): () => void {
  if (!isSupabaseConfigured) { cb(null); return () => {}; }
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session?.user?.id ?? null));
  return () => data.subscription.unsubscribe();
}

/** Send a password-reset email via Supabase Auth. */
export async function requestPasswordReset(email: string): Promise<{ error?: string }> {
  if (!isSupabaseConfigured) return { error: 'Backend not configured.' };
  let error: any;
  try {
    ({ error } = await supabase.auth.resetPasswordForEmail(email.trim()));
  } catch (e) {
    return { error: networkMessage(e) };
  }
  if (error) return { error: error.message };
  return {};
}

/** Ask the API server to look up the @handle associated with an email address. */
export async function lookupUsernameByEmail(email: string): Promise<{ handle?: string; error?: string }> {
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!apiBase) return { error: 'Backend not configured.' };
  try {
    if (__DEV__) console.log('[Auth] lookupUsername POST →', `${apiBase}/api/auth/lookup-username`);
    const res = await fetch(`${apiBase}/api/auth/lookup-username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error ?? 'Could not find an account with that email.' };
    return { handle: data.handle };
  } catch (e) {
    return { error: networkMessage(e) };
  }
}
