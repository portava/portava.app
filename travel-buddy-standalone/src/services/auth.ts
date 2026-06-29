/**
 * Auth service — thin wrapper over supabase-js auth. UI calls these, never
 * supabase.auth directly, so the implementation can be swapped or mocked.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export interface AuthResult {
  userId: string | null;
  error: string | null;
}

export async function signUp(email: string, password: string, meta?: { name?: string; handle?: string }): Promise<AuthResult> {
  if (!isSupabaseConfigured) return { userId: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: meta } });
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  // Create the profile from the client (the auth trigger approach hit permission issues).
  // This runs under the new user's session, which RLS allows (profiles_insert: id = auth.uid()).
  if (userId && data.session) {
    await ensureProfile(userId, email, meta);
  }
  return { userId, error: null };
}

/**
 * Ensure a profile row exists for the signed-in user. Idempotent (on conflict do nothing
 * via upsert). Replaces the DB signup trigger — runs client-side under the user's session.
 */
export async function ensureProfile(userId: string, email: string, meta?: { name?: string; handle?: string }): Promise<void> {
  if (!isSupabaseConfigured) return;
  const base = (meta?.handle || email.split('@')[0] || 'traveler').replace(/[^a-zA-Z0-9_]/g, '');
  const handle = `${base}_${userId.slice(0, 4)}`;
  const name = meta?.name || email.split('@')[0] || 'Traveler';
  // upsert: create if missing, no-op if already there.
  await supabase.from('profiles').upsert(
    { id: userId, handle, name },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  // Ensure a location-privacy row exists, defaulting to PRIVATE (never auto-share).
  await supabase.from('user_location_privacy').upsert(
    { user_id: userId, sharing: 'private', ghost_mode: false },
    { onConflict: 'user_id', ignoreDuplicates: true },
  );
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!isSupabaseConfigured) return { userId: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  // Backfill: ensure a profile exists (covers accounts made before client-side profile creation).
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
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
  if (error) return { error: error.message };
  return {};
}

/** Ask the API server to look up the @handle associated with an email address. */
export async function lookupUsernameByEmail(email: string): Promise<{ handle?: string; error?: string }> {
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!apiBase) return { error: 'Backend not configured.' };
  try {
    const res = await fetch(`${apiBase}/api/auth/lookup-username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error ?? 'Could not find an account with that email.' };
    return { handle: data.handle };
  } catch {
    return { error: 'Network error — please try again.' };
  }
}
