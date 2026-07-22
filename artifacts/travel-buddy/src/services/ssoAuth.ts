/**
 * ssoAuth.ts — Sign in with Apple and Sign in with Google.
 *
 * Apple: native flow via expo-apple-authentication → supabase.auth.signInWithIdToken.
 *   - iOS only. Apple only provides the user's full name on the FIRST authorization;
 *     capture and return it while available.
 *   - Hidden on Android (Apple web OAuth is not implemented here; see completion report).
 *
 * Google: Supabase OAuth (PKCE) + WebBrowser redirect → exchangeCodeForSession.
 *   - iOS and Android.
 *   - Uses expo-linking (already in project) for the redirect URI; expo-web-browser for the browser.
 *
 * Both functions return SSOResult.
 *   - success  → userId populated, error null
 *   - cancel   → cancelled true, userId null, error null (caller shows no error)
 *   - failure  → error is a user-readable string
 *
 * After a successful call the Supabase client holds an active session.
 * SessionContext picks it up via onAuthStateChange automatically.
 * The CALLER is responsible for calling ensureProfile and routing.
 */

import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

// Allows expo-web-browser to close the auth session on redirect (required on Android).
WebBrowser.maybeCompleteAuthSession();

// ─── Result type ──────────────────────────────────────────────────────────────

export interface SSOResult {
  /** Supabase user ID on success; null on failure or cancellation. */
  userId: string | null;
  /** User-readable error string, or null on success/cancellation. */
  error: string | null;
  /** True when the user dismissed the provider sheet without completing auth. */
  cancelled?: boolean;
  /**
   * Display name captured from provider metadata.
   * Apple: only present on the very first authorization.
   * Google: sourced from user_metadata.full_name / name.
   * Pass to ensureProfile as meta.name to set the initial profile name.
   */
  displayName?: string;
  /** Provider email (may be an Apple private-relay address). */
  email?: string;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Classify a raw error into a user-readable message, detecting the most common
 * categories: provider mismatch, network failure, unknown.
 */
function classifyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (!raw) return 'Something went wrong. Please try again.';

  const lower = raw.toLowerCase();

  // Provider mismatch / duplicate account
  if (
    lower.includes('already registered') ||
    lower.includes('already exists') ||
    lower.includes('email already') ||
    lower.includes('identity_not_found') ||
    lower.includes('provider_email_needs_verification')
  ) {
    return 'This email is already registered with a different sign-in method. ' +
      'Sign in with your original provider (email/password, Apple, or Google) instead.';
  }

  // Network / reachability
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('timeout')
  ) {
    return 'Cannot reach the server. Check your internet connection and try again.';
  }

  return raw;
}

// ─── Apple ────────────────────────────────────────────────────────────────────

/**
 * Sign in with Apple (iOS only).
 *
 * Uses expo-apple-authentication (lazy-required, native module).
 * Requires a development build or production build — does not work in Expo Go.
 */
export async function signInWithApple(): Promise<SSOResult> {
  if (!isSupabaseConfigured) {
    return { userId: null, error: 'Backend not configured.' };
  }
  if (Platform.OS !== 'ios') {
    // Apple Sign-In is native-iOS only in this implementation.
    // Android Apple web-OAuth is deliberately omitted (see completion report).
    return { userId: null, error: 'Apple sign-in is only supported on iOS.' };
  }

  // Lazy-require: the native module is unavailable on web and throws if imported
  // statically there.
  let AppleAuth: typeof import('expo-apple-authentication');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    AppleAuth = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  } catch {
    return { userId: null, error: 'Apple sign-in is not available on this device.' };
  }

  let credential: Awaited<ReturnType<typeof AppleAuth.signInAsync>>;
  try {
    credential = await AppleAuth.signInAsync({
      requestedScopes: [
        AppleAuth.AppleAuthenticationScope.FULL_NAME,
        AppleAuth.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (e: any) {
    // Apple throws a specific error code when the user cancels.
    const code: string = e?.code ?? '';
    if (
      code === 'ERR_REQUEST_CANCELED' ||
      code === 'ERR_CANCELED' ||
      // AppleAuthenticationError.CANCELED = 1001 on some versions
      code === '1001'
    ) {
      return { userId: null, error: null, cancelled: true };
    }
    return { userId: null, error: classifyError(e) };
  }

  if (!credential.identityToken) {
    return {
      userId: null,
      error: 'Apple did not return a sign-in token. Please try again.',
    };
  }

  // Apple provides the user's name ONLY on the first authorization.
  // Capture it now; it will be null / empty on subsequent sign-ins.
  const given  = credential.fullName?.givenName?.trim()  ?? '';
  const family = credential.fullName?.familyName?.trim() ?? '';
  const displayName = [given, family].filter(Boolean).join(' ') || undefined;
  const email = credential.email ?? undefined;

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
  });

  if (error) return { userId: null, error: classifyError(error) };
  if (!data.user) {
    return {
      userId: null,
      error: 'No session returned from Apple sign-in. Please try again.',
    };
  }

  return {
    userId: data.user.id,
    error: null,
    displayName,
    // Prefer the Apple-provided email; fall back to what Supabase stored
    // (covers Apple private relay addresses on subsequent sign-ins).
    email: email ?? data.user.email ?? undefined,
  };
}

// ─── Google ───────────────────────────────────────────────────────────────────

/**
 * Sign in with Google (iOS + Android) via Supabase OAuth + browser redirect.
 *
 * Flow:
 *  1. Ask Supabase for a Google OAuth URL (PKCE, skipBrowserRedirect=true).
 *  2. Open the URL in the system browser via WebBrowser.openAuthSessionAsync.
 *  3. Supabase redirects back to travelbuddy://auth/callback?code=…
 *  4. We exchange the code for a session via supabase.auth.exchangeCodeForSession.
 *
 * The PKCE code verifier is managed by the Supabase client (stored via
 * SecureStoreAdapter). exchangeCodeForSession retrieves it automatically.
 *
 * Requires a development or production build — does not work in Expo Go.
 */
export async function signInWithGoogle(): Promise<SSOResult> {
  if (!isSupabaseConfigured) {
    return { userId: null, error: 'Backend not configured.' };
  }

  // The redirect URI Supabase will send the user back to.
  // Linking.createURL uses the app's configured scheme from app.json (travelbuddy).
  // On native: travelbuddy://auth/callback
  const redirectTo = Linking.createURL('auth/callback');

  // Step 1: get the OAuth URL from Supabase
  let oauthUrl: string;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,   // We open the browser ourselves
        queryParams: {
          access_type: 'offline',
          prompt: 'select_account',  // Always show account picker
        },
      },
    });
    if (error || !data.url) {
      return {
        userId: null,
        error: error ? classifyError(error) : 'Could not start Google sign-in. Please try again.',
      };
    }
    oauthUrl = data.url;
  } catch (e) {
    return { userId: null, error: classifyError(e) };
  }

  // Step 2: open the browser
  let result: Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>;
  try {
    result = await WebBrowser.openAuthSessionAsync(oauthUrl, redirectTo);
  } catch (e) {
    return { userId: null, error: classifyError(e) };
  }

  // Step 3: handle the result
  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { userId: null, error: null, cancelled: true };
  }
  if (result.type !== 'success' || !result.url) {
    return {
      userId: null,
      error: 'Google sign-in did not complete. Please try again.',
    };
  }

  return _parseOAuthRedirect(result.url);
}

/**
 * Parse the redirect URL returned by the Supabase OAuth flow and exchange for a
 * live session.
 *
 * Handles both PKCE (?code=…) and implicit (#access_token=…&refresh_token=…)
 * response modes.
 */
async function _parseOAuthRedirect(redirectUrl: string): Promise<SSOResult> {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return { userId: null, error: 'Invalid redirect URL returned by Google sign-in.' };
  }

  // ── PKCE mode: ?code=… ──────────────────────────────────────────────────────
  const code = parsed.searchParams.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return { userId: null, error: classifyError(error) };
    if (!data.user) {
      return { userId: null, error: 'No session returned from Google sign-in. Please try again.' };
    }
    return {
      userId: data.user.id,
      error: null,
      email: data.user.email ?? undefined,
      displayName:
        (data.user.user_metadata?.full_name as string | undefined) ??
        (data.user.user_metadata?.name  as string | undefined) ??
        undefined,
    };
  }

  // ── Implicit mode: #access_token=…&refresh_token=… ─────────────────────────
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const access_token  = hash.get('access_token');
  const refresh_token = hash.get('refresh_token');
  if (access_token && refresh_token) {
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) return { userId: null, error: classifyError(error) };
    if (!data.user) {
      return { userId: null, error: 'No session returned from Google sign-in. Please try again.' };
    }
    return {
      userId: data.user.id,
      error: null,
      email: data.user.email ?? undefined,
      displayName:
        (data.user.user_metadata?.full_name as string | undefined) ??
        (data.user.user_metadata?.name  as string | undefined) ??
        undefined,
    };
  }

  // ── Explicit OAuth error ────────────────────────────────────────────────────
  const oauthError =
    parsed.searchParams.get('error_description') ??
    parsed.searchParams.get('error') ??
    hash.get('error_description') ??
    hash.get('error');
  if (oauthError) {
    return { userId: null, error: classifyError(new Error(oauthError)) };
  }

  return {
    userId: null,
    error: 'Google sign-in returned an unrecognised response. Please try again.',
  };
}
