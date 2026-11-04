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

/** The running binary's answer. */
export function buildCanSignInWithApple(): boolean {
  return canSignInWithAppleFrom(Constants.expoConfig?.extra as BuildExtra);
}
