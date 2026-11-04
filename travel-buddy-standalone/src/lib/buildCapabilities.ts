/**
 * buildCapabilities — what THIS binary was built able to do, as app.config.ts
 * recorded it in `extra` at build time.
 *
 * A local build signed with a free Apple ID (PORTAVA_PERSONAL_TEAM=1,
 * docs/eas-runbook.md "Local build with a Personal Team") carries no Sign in
 * with Apple entitlement, so the native Apple sheet can only fail there.
 * app.config.ts sets `extra.signInWithApple: false` for that build; every other
 * build leaves the key absent, which reads as capable (store builds unchanged).
 * The rule itself is pure and lives in src/lib/signInProviders.ts, so node:test
 * can cover it without loading expo-constants.
 */
import Constants from 'expo-constants';
import { canSignInWithAppleFrom, type BuildExtra } from './signInProviders.ts';
import { isPersonalTeamBuildFrom, testBuildDiagnostics } from './buildDiagnostics.ts';

/** The running binary's answer. */
export function buildCanSignInWithApple(): boolean {
  return canSignInWithAppleFrom(Constants.expoConfig?.extra as BuildExtra);
}

/** True only in a Personal Team build (`extra.personalTeam: true`); store builds read false. */
export function isPersonalTeamBuild(): boolean {
  return isPersonalTeamBuildFrom(Constants.expoConfig?.extra as BuildExtra);
}

/**
 * The one-line "which backend is this" the sign-in screen shows on a test
 * build, or null (store builds). The env reads are literal so Expo inlines them.
 */
export function testBuildDiagnosticsLine(): string | null {
  return testBuildDiagnostics({
    personalTeam: isPersonalTeamBuild(),
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    version: Constants.expoConfig?.version ?? undefined,
  });
}
