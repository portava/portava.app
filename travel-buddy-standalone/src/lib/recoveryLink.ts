/**
 * recoveryLink — is this deep link a Supabase password-recovery link, and what
 * does it carry?
 *
 * The root layout feeds recovery tokens to supabase-js by hand because
 * `detectSessionInUrl` is off on React Native. Until 2026-11-04 that handler
 * exchanged EVERY deep link carrying `?code=` for a session. Two links it was
 * never meant for carry one:
 *
 *   - the Google sign-in callback, `travelbuddy://auth/callback?code=…`. On
 *     Android the system browser delivers it as a deep link AND as the result
 *     `WebBrowser.openAuthSessionAsync` resolves with, so both the root handler
 *     and `signInWithGoogle` exchanged the same code; the PKCE verifier is
 *     consumed by the first exchange, the second is rejected, and whichever was
 *     second reported "Google sign-in failed" over a session that existed.
 *   - any other link with a `code` parameter (an invite code, a join code),
 *     which was handed to the auth server as if it were an authorization code.
 *
 * So the question is answered here, purely, and only for the route the reset
 * email points at: `requestPasswordReset` sends `travelbuddy://update-password`
 * (src/services/auth.ts), and Supabase appends `?code=…` (PKCE) or
 * `#access_token=…&refresh_token=…&type=recovery` (implicit). The same route
 * on the website (`https://rumazi.com/update-password`) and the Expo dev-client
 * form (`exp://host/--/update-password`) are accepted too; nothing else is.
 */

export const RECOVERY_ROUTE = 'update-password';

export type RecoveryLinkAction =
  | { kind: 'pkce'; code: string }
  | { kind: 'implicit'; accessToken: string; refreshToken: string };

/** The app route a deep link addresses: `travelbuddy://x/y`, `https://host/x/y` and `exp://host/--/x/y` all give `x/y`. */
export function routeOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const path = parsed.pathname.startsWith('/--/')
    ? parsed.pathname.slice('/--'.length)
    : isWeb
      ? parsed.pathname
      : `${parsed.hostname}${parsed.pathname}`;
  return path.replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** The recovery action a deep link carries, or null when it is not a recovery link. */
export function recoveryLinkAction(url: string): RecoveryLinkAction | null {
  if (routeOf(url) !== RECOVERY_ROUTE) return null;
  const parsed = new URL(url);

  const code = parsed.searchParams.get('code');
  if (code) return { kind: 'pkce', code };

  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  if (fragment.get('type') === 'recovery' && accessToken && refreshToken) {
    return { kind: 'implicit', accessToken, refreshToken };
  }
  return null;
}
