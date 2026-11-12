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
  /** §32 G199 — the device-local recents store, erased on an account change. */
  recents?: { clear: () => void; bindAccount?: (userId: string | null) => void };
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
const pendingRefreshes = new WeakMap<PolicyStore, {
  account: string; generation: number; signal?: AbortSignal; promise: Promise<PolicyRefreshOutcome>;
}>();

export async function refreshPolicies(
  accountId: string | null,
  store: PolicyStore,
  fetchPolicies: (signal?: AbortSignal) => Promise<PolicyFetchResult>,
  signal?: AbortSignal,
): Promise<PolicyRefreshOutcome> {
  // Policy is per-viewer, so there is nobody to fetch it for.
  if (accountId == null) return 'skipped';
  if (!store.needsRefresh(accountId)) return 'skipped';

  const generation = store.getAccountGeneration();
  const pending = pendingRefreshes.get(store);
  if (pending && pending.account === accountId && pending.generation === generation && !pending.signal?.aborted) {
    return pending.promise;
  }
  const promise = (async (): Promise<PolicyRefreshOutcome> => {
    const res = await fetchPolicies(signal);
    if (signal?.aborted || generation !== store.getAccountGeneration()) return 'skipped';
    if (!res.ok) return 'failed';
    return store.install(accountId, res.policyVersion, res.contexts) ? 'installed' : 'failed';
  })();
  pendingRefreshes.set(store, { account: accountId, generation, signal, promise });
  try {
    return await promise;
  } finally {
    if (pendingRefreshes.get(store)?.promise === promise) pendingRefreshes.delete(store);
  }
}

/**
 * Apply an auth-state report to the store, the cache and the device-local
 * recents.
 *
 * Returns whether the account actually CHANGED, because the callers care:
 * a token refresh reporting the same user must not throw away a warm
 * suggestion cache, while a real switch must throw away all of it.
 *
 * ── WHY `recents` JOINED THIS FUNCTION (§29, census G199) ───────────────────
 *
 * `cache.clear()` is here because `sharedSuggestionCache` is a process-global
 * map of suggestion lists keyed by the text that produced them, and two people
 * signing in on one device must not share it. The device-local recents store
 * is the STRONGER version of the same problem: it is the same kind of data,
 * written by the same explicit accepts, and it survives the process as well as
 * the session. Clearing one and not the other would mean the second viewer's
 * picker opened onto the first viewer's chosen cities.
 *
 * It is optional so that every existing caller and test keeps working
 * unchanged; the app's installer passes it.
 */
export function applyAccountChange(
  userId: string | null,
  store: PolicyStore,
  cache: { clear: () => void },
  recents?: { clear: () => void; bindAccount?: (userId: string | null) => void },
): boolean {
  const changed = store.activeAccount() !== userId;
  store.setActiveAccount(userId);
  if (changed) cache.clear();
  // census G199 (verifier F6): a recents port that knows WHOSE rows it holds
  // decides for itself — a cold start of the same person is not an erase. A
  // port without that (every older caller) keeps the old rule.
  if (recents?.bindAccount) recents.bindAccount(userId);
  else if (changed) recents?.clear();
  return changed;
}
