/**
 * policyRefreshOnUse — ask the authority again when a field is USED while the
 * policy table is missing or stale (census-discovery §80 round 3, register
 * D-W10-S1-4 "The missing policy").
 *
 * WHY THIS EXISTS. `installInputPolicySync` fetches the policy table on auth
 * events only. A fetch that failed at startup therefore stayed failed for the
 * whole session, and a table that expired (12 h) or was superseded (a newer
 * `policyVersion` on a suggest response) was never replaced while the viewer
 * stayed signed in. Every field meanwhile resolved to the conservative policy.
 *
 * WHAT IT KEEPS FROM THAT MODULE'S CONTRACT. It still never retries on a
 * SCHEDULE: a retry happens only because somebody is typing into a field, and
 * at most once per `POLICY_RETRY_MIN_GAP_MS`, with one request in flight at a
 * time. It still never relaxes anything on a failure: the refresh goes through
 * `policySync.ts#refreshPolicies`, so only a payload that survives
 * `PolicyStore.install` (which narrows every context) replaces what is held.
 *
 * The fetcher is BOUND, not imported. `installInputPolicySync` — the one place
 * the app attaches the policy sync — binds its store and fetcher here, so a
 * refresh on use goes through exactly the path the auth events use, and this
 * module never pulls the Supabase-backed policy client into a hook that
 * screens and component tests load without a network stack. Until something
 * binds a fetcher (a test, or an app that never installed the sync) a refresh
 * on use is `'skipped'`.
 */
import { sharedPolicyStore, type PolicyStore } from './policyStore.ts';
import { refreshPolicies, type PolicyFetchResult, type PolicyRefreshOutcome } from './policySync.ts';

/** The shortest gap between two refresh attempts made because of use. */
export const POLICY_RETRY_MIN_GAP_MS = 30_000;

export interface PolicyRefreshOnUseDeps {
  store?: PolicyStore;
  fetchPolicies?: (signal?: AbortSignal) => Promise<PolicyFetchResult>;
  now?: () => number;
}

let lastAttemptAt = Number.NEGATIVE_INFINITY;
let inFlight: Promise<PolicyRefreshOutcome> | null = null;
let bound: { store: PolicyStore; fetchPolicies: (signal?: AbortSignal) => Promise<PolicyFetchResult> } | null = null;

/** Called by `installInputPolicySync` with the store and fetcher it uses. */
export function bindPolicyRefreshOnUse(
  store: PolicyStore,
  fetchPolicies: (signal?: AbortSignal) => Promise<PolicyFetchResult>,
): void {
  bound = { store, fetchPolicies };
}

/**
 * Refresh the table for the signed-in viewer if the store wants one and the
 * throttle allows it. Resolves `'skipped'` when nothing was attempted.
 */
export function refreshPolicyOnUse(deps: PolicyRefreshOnUseDeps = {}): Promise<PolicyRefreshOutcome> {
  const store = deps.store ?? bound?.store ?? sharedPolicyStore;
  const fetchPolicies = deps.fetchPolicies ?? bound?.fetchPolicies;
  if (!fetchPolicies) return Promise.resolve('skipped');
  const account = store.activeAccount();
  // Signed out: policy is per viewer, so there is nobody to fetch it for.
  if (account == null || !store.needsRefresh(account)) return Promise.resolve('skipped');
  if (inFlight) return inFlight;
  const now = (deps.now ?? Date.now)();
  if (now - lastAttemptAt < POLICY_RETRY_MIN_GAP_MS) return Promise.resolve('skipped');
  lastAttemptAt = now;
  const attempt = refreshPolicies(account, store, fetchPolicies)
    .catch((): PolicyRefreshOutcome => 'failed')
    .finally(() => { inFlight = null; });
  inFlight = attempt;
  return attempt;
}

/** Forget the binding, the throttle and any in-flight attempt. TESTS ONLY. */
export function _resetPolicyRefreshOnUseForTests(): void {
  bound = null;
  lastAttemptAt = Number.NEGATIVE_INFINITY;
  inFlight = null;
}
