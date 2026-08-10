/**
 * accountScopedStorageFlag — local, synchronous kill switch for per-account
 * scoping of the four local-storage stores identified as cross-account
 * leakage risks (reminders, discoveryBookmarks, TelegraphSuggestionTray
 * cache, checkpointArrivalTask queue).
 *
 * Deliberately NOT wired to FeatureFlagsContext (server-driven, async,
 * React-context-bound): checkpointArrivalTask.ts is a module-root
 * expo-task-manager background task with no React tree and no guaranteed
 * network access at the moment it fires, so the flag must be readable
 * synchronously from anywhere, including outside any component tree.
 *
 * Ships OFF. Flip DEFAULT_ENABLED to true (or use the test seam) once the
 * migration has been validated against a real device.
 */

const DEFAULT_ENABLED = false;

let _testOverride: boolean | null = null;

/**
 * Test seam — force the flag on/off in unit tests. Pass null to restore the
 * default. Mirrors the codebase's existing _setTestNotifier / _setTestStorage
 * / _setTestToken seam convention.
 */
export function _setTestAccountScopedStorageFlag(value: boolean | null): void {
  _testOverride = value;
}

export function isAccountScopedStorageEnabled(): boolean {
  if (_testOverride !== null) return _testOverride;
  return DEFAULT_ENABLED;
}
