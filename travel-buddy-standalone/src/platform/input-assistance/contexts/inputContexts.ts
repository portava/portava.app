/**
 * Global Input Intelligence — context policy resolution (spec §5, §48).
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY IT ISN'T ──────────────────────────────
 *
 * Until 2026-09-21 this file held `INPUT_CONTEXT_REGISTRY`: a hand-maintained
 * table declaring, for all 29 contexts, the mode, entity classes, privacy
 * class, offline policy, capability flags and minChars. The server declared the
 * same 29 contexts in `lib/inputAssistance/policyRegistry.ts`. Two tables, one
 * question, and no mechanism that made them agree.
 *
 * They did not agree. Measured across the 29: `allowedSuggestionTypes` differed
 * on 26, `offlinePolicy` on 26, `minChars` on 20, `allowPersonalization` on 14,
 * `privacyClass` on 14. Two of those are privacy gates and two of the privacy
 * disagreements ran the wrong way — the client believed `caption` and `comment`
 * were personalization-enabled, and classified a Hidden Gem name and a comment
 * body as `public`. None of it was live, because the consuming code had not
 * been wired yet; all of it was one screen away from being live.
 *
 * §48's promise is ONE policy contract, versioned server-side, so a policy
 * change ships without a client release. A local copy of the answer is the
 * thing that breaks that promise, and no amount of drift-testing fixes it —
 * a test can only report that the two tables disagree, never make the shipped
 * app obey the newer one.
 *
 * So the table is gone. `GET /input-assistance/policies` (G340) is the
 * authority. This file now RESOLVES: it asks `sharedPolicyStore` for the
 * signed-in viewer's policy and, when there isn't one it can trust, returns the
 * single conservative fallback from `policyFallback.ts`. The two functions the
 * rest of the client calls — `getContextDescriptor` here and
 * `resolveFieldPolicy` in `fieldRegistry.ts` — keep their signatures, so no
 * screen changed.
 *
 * WHAT A CONSUMER MUST UNDERSTAND. Before the fetch lands, every context
 * resolves to `no_assistance` with an unreachable `minChars`. That is not a
 * degraded mode to be worked around: it is the correct answer to "what may this
 * field do before the authority has told us?". Fields render as plain inputs
 * and start assisting when the policy arrives.
 */
import type {
  AssistanceType,
  EntityType,
  InputContext,
  OfflineInputPolicy,
  PrivacyClass,
} from '../types/inputContext.ts';
import type { InputAssistanceMode } from '../types/fieldPolicy.ts';
import { sharedPolicyStore, type PolicyStore } from '../services/policyStore.ts';
import { conservativePolicyFor } from './policyFallback.ts';

/**
 * The version of the policy table this client is currently holding, or
 * `'unfetched'` when it holds none.
 *
 * A FUNCTION, not the constant it replaced. The old `INPUT_POLICY_VERSION =
 * 'input-2026-08'` was a string baked into the bundle: it reported the version
 * the client was BUILT against, and stamped that onto every outgoing request
 * and every locally-built suggestion. That made the one field designed to
 * detect skew incapable of reporting it — the client always claimed to be
 * current. This reports what it actually holds.
 */
export function inputPolicyVersion(store: PolicyStore = sharedPolicyStore): string {
  return store.heldVersion() ?? 'unfetched';
}

/**
 * The per-context shape the rest of the client reads. Unchanged in shape from
 * the descriptor the deleted table produced, so its consumers did not move;
 * what changed is where the values come from.
 */
export interface InputContextDescriptor {
  context: InputContext;
  defaultMode: InputAssistanceMode;
  entityTypes: EntityType[];
  allowedSuggestionTypes: AssistanceType[];
  privacyClass: PrivacyClass;
  offlinePolicy: OfflineInputPolicy;
  allowPersonalization: boolean;
  allowLiveContext: boolean;
  allowMemoryContext: boolean;
  allowAI: boolean;
  /** §14 — served by the authority since G340; it used to live only here. */
  zeroStateAssistance: boolean;
  minChars: number;
  /** True when this came from the authority and passed every freshness guard. */
  authoritative: boolean;
}

/**
 * Resolve a context's descriptor for the signed-in viewer.
 *
 * NEVER returns null and never throws — an unresolvable context yields the
 * conservative policy, which grants nothing. Callers that want to know whether
 * they got the real thing read `authoritative`.
 */
export function getContextDescriptor(
  context: InputContext,
  store: PolicyStore = sharedPolicyStore,
): InputContextDescriptor {
  const { policy, authoritative } = store.readActive(context);
  return {
    context,
    defaultMode: policy.mode,
    entityTypes: policy.entityTypes,
    allowedSuggestionTypes: policy.allowedSuggestionTypes,
    privacyClass: policy.privacyClass,
    offlinePolicy: policy.offlinePolicy,
    allowPersonalization: policy.allowPersonalization,
    allowLiveContext: policy.allowLiveContext,
    allowMemoryContext: policy.allowMemoryContext,
    allowAI: policy.allowAI,
    zeroStateAssistance: policy.zeroStateAssistance,
    minChars: policy.minChars,
    authoritative,
  };
}

/**
 * The conservative descriptor, named so callers and tests can assert against it
 * rather than restating its members — a restatement would be a third copy of
 * the policy, which is the defect this whole change removes.
 */
export function conservativeDescriptor(context: InputContext): InputContextDescriptor {
  const policy = conservativePolicyFor(context);
  return {
    context,
    defaultMode: policy.mode,
    entityTypes: policy.entityTypes,
    allowedSuggestionTypes: policy.allowedSuggestionTypes,
    privacyClass: policy.privacyClass,
    offlinePolicy: policy.offlinePolicy,
    allowPersonalization: policy.allowPersonalization,
    allowLiveContext: policy.allowLiveContext,
    allowMemoryContext: policy.allowMemoryContext,
    allowAI: policy.allowAI,
    zeroStateAssistance: policy.zeroStateAssistance,
    minChars: policy.minChars,
    authoritative: false,
  };
}
