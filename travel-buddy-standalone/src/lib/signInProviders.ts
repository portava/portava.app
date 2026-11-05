/**
 * signInProviders — which social sign-in buttons the sign-in screen shows.
 *
 * A button is shown only when the platform, the build and the backend all can:
 *   - Apple: iOS only (no Apple web OAuth here), the build must carry the
 *     entitlement (src/lib/buildCapabilities.ts), and Supabase must have the
 *     provider enabled (src/services/authProviders.ts).
 *   - Google: iOS and Android; Supabase must have the provider enabled.
 * An unknown backend answer (null: unreachable, fail-open) hides nothing.
 * Email and password are always offered; the backend answer's `email` flag is
 * informational only, because the form is also the account-recovery surface.
 */
import type { AuthProviderAvailability } from '../services/authProviders.ts';

/** app.config.ts's `extra` as the running binary carries it (src/lib/buildCapabilities.ts reads it). */
export type BuildExtra = Record<string, unknown> | null | undefined;

/**
 * Can this build perform Sign in with Apple? app.config.ts sets
 * `extra.signInWithApple: false` for a Personal Team build (no entitlement);
 * every other build leaves the key absent. Only an explicit false disables,
 * so a store build is unchanged.
 */
export function canSignInWithAppleFrom(extra: BuildExtra): boolean {
  return extra?.signInWithApple !== false;
}

export interface SignInProviderVisibility {
  apple: boolean;
  google: boolean;
}

export interface SignInProviderInput {
  platform: string;
  buildCanSignInWithApple: boolean;
  backend: AuthProviderAvailability | null;
}

export function visibleSignInProviders({ platform, buildCanSignInWithApple, backend }: SignInProviderInput): SignInProviderVisibility {
  return {
    apple: platform === 'ios' && buildCanSignInWithApple && backend?.apple !== false,
    google: backend?.google !== false,
  };
}
