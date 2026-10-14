/**
 * The server's feature flags as `FeatureFlagsContext` last read them, for code
 * that runs outside React (a service called after a send). The context writes
 * here every time it stores a fresh `GET /api/feature-flags` answer; nothing
 * else writes.
 *
 * Fail-closed exactly like the context: before the first answer, or for a key
 * the server did not list, a flag is OFF. Parent requirements (the context's
 * Live Places hierarchy) are NOT applied here — a flag with parents must be
 * read through `useFeatureFlags().isEnabled`.
 */
let latest: Readonly<Record<string, boolean>> = {};

/** Called by FeatureFlagsProvider with each stored answer. */
export function recordFeatureFlagSnapshot(flags: Record<string, boolean>): void {
  latest = { ...flags };
}

/** True only when the last stored answer listed `key` as enabled. */
export function featureFlagEnabledNow(key: string): boolean {
  return latest[key] === true;
}

/** Tests only. */
export function _resetFeatureFlagSnapshot(): void {
  latest = {};
}
