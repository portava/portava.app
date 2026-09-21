/**
 * Global Input Intelligence §48 / G340 — the policy-sync DECISIONS, separated
 * from the machinery that performs them.
 *
 * WHY THIS FILE EXISTS AS A SEPARATE FILE. `installInputPolicySync.ts` imports
 * the Supabase-backed auth module, which pulls in React Native — so anything
 * living there is unreachable from node:test. The decisions that matter here
 * are not the fetch; they are "should we refetch at all", "is this payload
 * installable", and "what happens when the answer is no". Those are exactly
 * the judgements that must be provable, so they live here, in a module with no
 * network, no React and no RN, and the RN seam calls into them.
 *
 * This is the same split `inputAssistance.ts` / `suggestResponse.ts` already
 * uses, and for the same stated reason: inline, these branches were unprovable.
 */
import type { PolicyStore } from './policyStore.ts';

export interface PolicyFetchOk {
  ok: true;
  policyVersion: string;
  contexts: Record<string, unknown>;
}
export interface PolicyFetchFail {
  ok: false;
  /** True when the endpoint is absent or the network failed, vs. a real error. */
  unavailable: boolean;
  error: string;
}
export type PolicyFetchResult = PolicyFetchOk | PolicyFetchFail;

/** What a refresh did. Named rather than boolean: a SKIP and a FAILURE have
 *  different remedies, and collapsing them hides a server that is never
 *  reachable behind a cache that is always fresh. */
export type PolicyRefreshOutcome = 'installed' | 'skipped' | 'failed';

export interface PolicySyncDeps {
  store?: PolicyStore;
  cache?: { clear: () => void };
  fetchPolicies?: (signal?: AbortSignal) => Promise<PolicyFetchResult>;
  subscribeAuth?: (cb: (userId: string | null) => void) => () => void;
  currentUserId?: () => Promise<string | null>;
}

/**
 * Refresh the policy table for `accountId`, if the store wants one.
 *
 * THE ONE PROPERTY THIS FUNCTION GUARANTEES: there is no path through it that
 * makes a field more capable than it was. A skip changes nothing; a failure
 * changes nothing; only a payload that survives `PolicyStore.install` — which
 * narrows every context on the way in — replaces what is held.
 */
export async function refreshPolicies(
  accountId: string | null,
  store: PolicyStore,
  fetchPolicies: (signal?: AbortSignal) => Promise<PolicyFetchResult>,
  signal?: AbortSignal,
): Promise<PolicyRefreshOutcome> {
  // Policy is per-viewer, so there is nobody to fetch it for.
  if (accountId == null) return 'skipped';
  if (!store.needsRefresh(accountId)) return 'skipped';

  const res = await fetchPolicies(signal);
  if (!res.ok) return 'failed';
  // `install` re-checks the account and narrows every context. A payload that
  // does not survive that is a failure, not a partial success — installing
  // "most of" a policy table would leave the rest silently conservative while
  // the client believed it was current.
  return store.install(accountId, res.policyVersion, res.contexts) ? 'installed' : 'failed';
}

/**
 * Apply an auth-state report to the store and cache.
 *
 * Returns whether the account actually CHANGED, because the two callers care:
 * a token refresh reporting the same user must not throw away a warm
 * suggestion cache, while a real switch must throw away both.
 */
export function applyAccountChange(
  userId: string | null,
  store: PolicyStore,
  cache: { clear: () => void },
): boolean {
  const changed = store.activeAccount() !== userId;
  store.setActiveAccount(userId);
  if (changed) cache.clear();
  return changed;
}
