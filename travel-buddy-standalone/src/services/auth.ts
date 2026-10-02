/**
 * Auth service — thin wrapper over supabase-js auth. UI calls these, never
 * supabase.auth directly, so the implementation can be swapped or mocked.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { getSentry } from '../lib/sentry.ts';

/**
 * Report a silent ensureProfile failure to Sentry. Observability only — never
 * changes control flow, never blocks the caller. PII: userId only, per the
 * same convention as crashReporter.ts.
 */
export function reportEnsureProfileFailure(stage: string, userId: string, e: unknown): void {
  const sentry = getSentry();
  sentry?.withScope(scope => {
    scope.setUser({ id: userId });
    scope.setTag('ensureProfile_stage', stage);
    sentry.captureException(e);
  });
}

/** Test seam — set to a fake token to bypass supabase.auth.getSession in ensureProfile. */
let _testSessionToken: string | null = null;
/**
 * Inject a fake session token for unit tests.
 * ONLY functional in __DEV__ builds and NODE_ENV=test — no-op in production
 * so the bypass can never be triggered by production code paths.
 */
export function _setTestSessionToken(t: string | null): void {
  if (__DEV__ || process.env.NODE_ENV === 'test') {
    _testSessionToken = t;
  }
}

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

/**
 * Ask the API whether new signups are currently allowed.
 *
 * The `disable_signups` / `invite_only_beta` feature flags are enforced by the
 * server (GET /api/auth/signup-status), but the app creates accounts through
 * supabase.auth.signUp, which never consults them — so without this check the
 * kill switches do nothing for the mobile client.
 *
 * FAIL-OPEN by design, matching the server handler: an unreachable API or an
 * unset API base URL must not lock legitimate users out of registration. The
 * switch is a rollout control, not a security boundary — account creation is
 * still bounded server-side.
 */
async function fetchSignupStatus(): Promise<{ signupsEnabled: boolean; inviteOnly: boolean }> {
  const allowed = { signupsEnabled: true, inviteOnly: false };
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!apiBase) return allowed;

  try {
    const res = await fetch(`${apiBase}/api/auth/signup-status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return allowed;
    const body = await res.json();
    return {
      signupsEnabled: body?.signupsEnabled !== false,
      inviteOnly: body?.inviteOnly === true,
    };
  } catch {
    return allowed;
  }
}

export async function signUp(email: string, password: string, meta?: { name?: string; handle?: string }): Promise<AuthResult> {
  if (!isSupabaseConfigured) return { userId: null, error: 'Supabase not configured' };
  if (__DEV__) console.log('[Auth] signUp');

  // Kill switch: check before creating the account, not after.
  const status = await fetchSignupStatus();
  if (!status.signupsEnabled) {
    return { userId: null, error: 'New sign-ups are temporarily closed. Please check back soon.' };
  }
  if (status.inviteOnly) {
    return { userId: null, error: 'Portava is invite-only right now. You need an invite to create an account.' };
  }

  let data: any, error: any;
  try {
    ({ data, error } = await supabase.auth.signUp({ email, password, options: { data: meta } }));
  } catch (e) {
    return { userId: null, error: networkMessage(e) };
  }
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  if (userId && data.session) {
    try {
      await ensureProfile(userId, email, meta);
    } catch (e) {
      // Non-fatal: profile row creation failed (e.g. network hiccup or API
      // not configured yet). The onboarding screen calls getMyProfile on
      // mount and SessionContext has a recovery path, so we don't block sign-up.
      if (__DEV__) console.warn('[Auth] ensureProfile failed during signUp (non-fatal):', e);
      reportEnsureProfileFailure('signUp', userId, e);
    }
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
  // When a test session token is injected, bypass the isSupabaseConfigured guard
  // (same pattern as _setTestAuthToken in profile.ts).
  if (!isSupabaseConfigured && !_testSessionToken) return;

  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!apiBase) {
    throw new Error('ensureProfile: EXPO_PUBLIC_API_BASE_URL is not configured');
  }

  let token: string | undefined;
  if (_testSessionToken && (__DEV__ || process.env.NODE_ENV === 'test')) {
    token = _testSessionToken;
  } else {
    token = (await freshApiToken()) ?? undefined;
  }
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
  if (__DEV__) console.log('[Auth] signIn');
  let data: any, error: any;
  try {
    ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
  } catch (e) {
    return { userId: null, error: networkMessage(e) };
  }
  if (error) return { userId: null, error: error.message };
  const userId = data.user?.id ?? null;
  if (userId) {
    try {
      await ensureProfile(userId, email, { name: data.user?.user_metadata?.name });
    } catch (e) {
      // Non-fatal: if ensureProfile fails the profile row already exists for
      // returning users, or SessionContext will recover it on sign-in.
      if (__DEV__) console.warn('[Auth] ensureProfile failed during signIn (non-fatal):', e);
      reportEnsureProfileFailure('signIn', userId, e);
    }
  }
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
    ({ error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // Deep-link the email button back into the app's update-password screen.
      // This URL must also be listed in the Supabase Auth dashboard under
      // Authentication → URL Configuration → Redirect URLs.
      redirectTo: 'travelbuddy://update-password',
    }));
  } catch (e) {
    return { error: networkMessage(e) };
  }
  if (error) return { error: error.message };
  return {};
}

/**
 * Change the authenticated user's password via Supabase Auth.
 * Requires an active session (the user must be signed in).
 */
export async function changePassword(newPassword: string): Promise<{ error?: string }> {
  if (!isSupabaseConfigured) return { error: 'Backend not configured.' };
  let error: any;
  try {
    ({ error } = await supabase.auth.updateUser({ password: newPassword }));
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
