/**
 * Pure logic extracted from the Feature Flags admin screen and useRequireAdmin hook.
 *
 * All functions here are side-effect-free and can be tested with plain node:test
 * without React Native, Expo Router, or any async I/O.
 *
 * Covered by:
 *   src/screens/admin/__tests__/featureFlags.machine.test.ts
 */

// ── Kill switches ─────────────────────────────────────────────────────────────

/**
 * Flag names that are treated as kill switches — disabling core system
 * behaviour in response to an incident. When any of these is enabled the
 * Feature Flags screen shows a prominent red banner.
 */
export const KILL_SWITCH_FLAGS: readonly string[] = [
  'disable_posting',
  'disable_messaging',
  'disable_signups',
  'disable_rent_buddy_booking',
  'invite_only_beta',
];

/**
 * Returns the flag names that are both in KILL_SWITCH_FLAGS and currently
 * enabled. Empty array means the system is fully operational.
 */
export function getActiveKillSwitches(flags: FeatureFlag[]): string[] {
  return flags
    .filter((f) => KILL_SWITCH_FLAGS.includes(f.flag) && f.enabled)
    .map((f) => f.flag);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FeatureFlag {
  flag: string;
  enabled: boolean;
  description: string | null;
  updated_at: string | null;
  last_change?: {
    changed_at: string;
    old_enabled: boolean;
    new_enabled: boolean;
    changed_by_name: string | null;
  };
}

// ── Admin gate ────────────────────────────────────────────────────────────────

/**
 * The navigation outcome that useRequireAdmin should trigger based on the
 * current session state. Pure — no side effects, no hooks.
 *
 *   pending        — auth or role fetch still in flight; do nothing yet
 *   redirect_signin — user is not authenticated → push to sign-in
 *   redirect_home   — authenticated but not admin → push to home
 *   allow           — authenticated admin → render the screen
 */
export type AdminGateOutcome =
  | 'pending'
  | 'redirect_signin'
  | 'redirect_home'
  | 'allow';

export function resolveAdminGate(params: {
  adminLoading: boolean;
  isAuthed: boolean;
  role: string | null;
}): AdminGateOutcome {
  if (params.adminLoading) return 'pending';
  if (!params.isAuthed) return 'redirect_signin';
  if (params.role !== 'admin') return 'redirect_home';
  return 'allow';
}

// ── Optimistic toggle ─────────────────────────────────────────────────────────

/**
 * Returns a new flags list with the target flag's `enabled` field set to
 * `enabled` before the server round-trip completes (optimistic update).
 * Does not mutate the input array or any flag object.
 */
export function applyOptimisticToggle(
  flags: FeatureFlag[],
  targetFlag: string,
  enabled: boolean,
): FeatureFlag[] {
  return flags.map((f) =>
    f.flag === targetFlag ? { ...f, enabled } : f,
  );
}

// ── Toggle result ─────────────────────────────────────────────────────────────

export interface ToggleApiResult {
  ok: boolean;
  data?: { flag: FeatureFlag };
  error?: string;
}

/**
 * Applies the PATCH /api/admin/feature-flags/:flag response to the current
 * (already optimistically updated) flags list.
 *
 * On success with server data: replaces the flag row with the confirmed server row.
 * On success without data:     leaves the optimistic state in place.
 * On failure:                  reverts the flag to the opposite of `requested`
 *                              and returns the error message.
 */
export function applyToggleResult(
  flags: FeatureFlag[],
  targetFlag: string,
  requested: boolean,
  result: ToggleApiResult,
): { flags: FeatureFlag[]; error: string | null } {
  if (!result.ok) {
    return {
      flags: flags.map((f) =>
        f.flag === targetFlag ? { ...f, enabled: !requested } : f,
      ),
      error: result.error ?? 'Toggle failed',
    };
  }
  if (result.data?.flag) {
    return {
      flags: flags.map((f) =>
        f.flag === targetFlag ? result.data!.flag : f,
      ),
      error: null,
    };
  }
  return { flags, error: null };
}

// ── Load result ───────────────────────────────────────────────────────────────

export interface LoadApiResult {
  ok: boolean;
  data?: { flags: FeatureFlag[] };
  error?: string;
}

/**
 * Applies the GET /api/admin/feature-flags response.
 * Returns the flags list on success, or null + an error string on failure.
 */
export function applyLoadResult(result: LoadApiResult): {
  flags: FeatureFlag[] | null;
  error: string | null;
} {
  if (result.ok && result.data) {
    return { flags: result.data.flags, error: null };
  }
  return { flags: null, error: result.error ?? 'Failed to load flags' };
}

// ── Flag history ───────────────────────────────────────────────────────────────

/**
 * A single audit entry returned by
 * GET /api/admin/feature-flags/:flag/history.
 */
export interface FlagHistoryEntry {
  id: string;
  flag: string;
  old_enabled: boolean;
  new_enabled: boolean;
  changed_at: string;
  changed_by_user_id: string | null;
  changed_by_name: string | null;
}

export interface HistoryLoadApiResult {
  ok: boolean;
  data?: { flag: string; history: FlagHistoryEntry[] };
  error?: string;
}

/**
 * Applies the GET /api/admin/feature-flags/:flag/history response.
 *
 * On success: returns the history array (may be empty) and null error.
 * On failure: returns an empty entries array and a non-empty error string.
 */
export function applyHistoryLoadResult(result: HistoryLoadApiResult): {
  entries: FlagHistoryEntry[];
  error: string | null;
} {
  if (result.ok && result.data) {
    return { entries: result.data.history, error: null };
  }
  return { entries: [], error: result.error ?? 'Failed to load history' };
}
