/**
 * installInputPolicySync — the attachment that makes the client obey the
 * authority (§48, G340).
 *
 * `GET /input-assistance/policies` exists and `PolicyStore` can hold what it
 * returns, but a store nothing fills answers every question with the
 * conservative policy. This is the link that fills it, and — just as
 * importantly — the link that EMPTIES it when the viewer changes.
 *
 * A SEAM, NOT AN AUTO-INSTALL, exactly like `installInputTelemetry`: importing
 * this module starts nothing. `app/_layout.tsx` calls it once. A library that
 * quietly begins fetching because it was imported is the kind of thing nobody
 * can find later.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE THREE EVENTS THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. SIGN-IN / STARTUP. `onAuthChange` fires with a user id; the store is told
 *    who is active and a fetch begins. Until it lands, fields are unassisted.
 *
 * 2. SIGN-OUT, AND ACCOUNT SWITCH. `onAuthChange` fires with `null` (or a
 *    different id). `setActiveAccount` drops the policy snapshot, and this
 *    module ALSO clears `sharedSuggestionCache`.
 *
 *    That second clear is not incidental. `sharedSuggestionCache` is one
 *    process-global map holding whole suggestion lists keyed by the raw text
 *    that produced them, and before this module nothing in the app ever called
 *    its `clear()` — the method existed with no caller. On a device where two
 *    people sign in one after the other, the second viewer's first keystrokes
 *    could be answered out of the first viewer's cached rows, with no request
 *    that could re-check eligibility. The privacy-class allowlist keeps the
 *    cache to `public` contexts, which bounds the damage to lists that are the
 *    same for everyone — but "bounded" is not "absent", and the account that
 *    fetched them is no longer the account reading them.
 *
 * 3. A POLICY CHANGE UNDER A LIVE SESSION. Every suggest response carries the
 *    authority's `policyVersion`. `noteServedVersion` records it, and when it
 *    stops matching the held snapshot, the store reports every context as
 *    `version_superseded` — conservative — until a refetch lands. This is the
 *    mechanism §48 promised: the client detects that its copy is stale and,
 *    for the first time, has somewhere to go. It errs toward LESS assistance
 *    during the gap rather than continuing on a table the server has retired.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE WILL NOT DO
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * It never retries on a schedule, and it never treats a failed fetch as a
 * reason to relax. A fetch that fails leaves the store as it was; if the store
 * was empty it stays empty and every field stays unassisted. There is no path
 * here in which being unable to reach the authority makes the app do more.
 */
import { onAuthChange, getSessionUserId } from '../../../services/auth.ts';
import { sharedPolicyStore } from './policyStore.ts';
import { sharedSuggestionCache } from './suggestionCache.ts';
import { fetchInputPolicies } from './policyClient.ts';
import {
  applyAccountChange,
  refreshPolicies,
  type PolicyRefreshOutcome,
  type PolicySyncDeps,
} from './policySync.ts';

export type { PolicySyncDeps, PolicyRefreshOutcome } from './policySync.ts';

/**
 * Refresh the policy table for `accountId`, if the store wants one.
 *
 * A thin default-binding wrapper over `policySync.ts#refreshPolicies`, which
 * holds the decisions and IS unit-tested. Nothing is decided here.
 */
export async function refreshInputPolicies(
  accountId: string | null,
  deps: PolicySyncDeps = {},
): Promise<PolicyRefreshOutcome> {
  return refreshPolicies(
    accountId,
    deps.store ?? sharedPolicyStore,
    deps.fetchPolicies ?? fetchInputPolicies,
  );
}

/**
 * Attach the sync. Returns an unsubscribe function.
 *
 * Call it once, from the app root. Calling it twice attaches two listeners.
 */
export function installInputPolicySync(deps: PolicySyncDeps = {}): () => void {
  const store = deps.store ?? sharedPolicyStore;
  const cache = deps.cache ?? sharedSuggestionCache;
  const subscribe = deps.subscribeAuth ?? onAuthChange;
  const current = deps.currentUserId ?? getSessionUserId;
  const doFetch = deps.fetchPolicies ?? fetchInputPolicies;

  const onAccount = (userId: string | null): void => {
    applyAccountChange(userId, store, cache);
    if (userId != null) void refreshPolicies(userId, store, doFetch);
  };

  const unsubscribe = subscribe(onAccount);

  // `onAuthChange` may not fire for an ALREADY-established session, so ask
  // once at install time. A failure here lands on signed-out, which is the
  // safe state: every field stays unassisted until the authority answers.
  void (async () => {
    try {
      onAccount(await current());
    } catch {
      onAccount(null);
    }
  })();

  return unsubscribe;
}
