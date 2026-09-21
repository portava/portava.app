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
import type { PolicyStore } from '../services/policyStore.ts';

/**
 * THIS MODULE MUST STAY A LEAF — no runtime imports, only `import type`.
 *
 * `artifacts/api-server` is `"type": "module"`; `travel-buddy-standalone` is
 * CJS. `inputAssistanceFieldInventory.test.ts` is an api-server test that
 * imports this module, so it crosses that boundary, and under the `tsx/esm`
 * loader that suite uses, Node's require(esm) path cannot link a runtime import
 * made from here: it reports "does not provide an export named …" for whatever
 * this file pulls in. Before G340 every import here was `import type`, all
 * erased, and the crossing worked. Adding one runtime import broke it —
 * standalone under `--import tsx` it passed, and only the full suite went red,
 * which is the worst way for a defect to present.
 *
 * So the conservative values LIVE HERE, as a plain literal, and
 * `policyFallback.ts` derives its policy form from them. One definition, and
 * the direction of the edge is what keeps this file loadable from the other
 * workspace.
 */

/** A `minChars` no typed text can reach. Not `Infinity`: this value is compared
 *  against `text.trim().length` and is JSON-round-tripped in tests, and
 *  `Infinity` does not survive `JSON.stringify` — it becomes `null`, turning an
 *  unreachable threshold into a reachable one. */
export const UNREACHABLE_MIN_CHARS = Number.MAX_SAFE_INTEGER;

/** §33's recommended debounce band is 100–150ms. Used only to replace a served
 *  value that is not a usable number. */
export const FALLBACK_DEBOUNCE_MS = 120;

/**
 * The one local policy this client still carries, in descriptor form.
 *
 * It grants NOTHING, and that is the design rather than an oversight: there are
 * no safe defaults for a policy whose job is to decide what may be searched,
 * cached, personalised and logged. `no_assistance` is the mode the gateway
 * short-circuits on; `minChars` is unreachable so no keystroke triggers a
 * request even if a caller ignores the mode; `private_message` is the strictest
 * privacy class, which makes the field uncacheable
 * (`suggestionCache.ts#CACHEABLE_PRIVACY_CLASSES` admits `public` and nothing
 * else) and gives it the metadata-only telemetry vocabulary; and `unavailable`
 * leaves it no offline surface either.
 */
export const CONSERVATIVE_DEFAULTS = Object.freeze({
  defaultMode: 'no_assistance' as InputAssistanceMode,
  privacyClass: 'private_message' as PrivacyClass,
  offlinePolicy: 'unavailable' as OfflineInputPolicy,
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
  zeroStateAssistance: false,
  minChars: UNREACHABLE_MIN_CHARS,
  maxSuggestions: 0,
  debounceMs: FALLBACK_DEBOUNCE_MS,
});

/**
 * The store these resolvers consult when a caller passes none.
 *
 * ── WHY THIS IS BOUND RATHER THAN IMPORTED (2026-09-21) ─────────────────────
 *
 * The obvious spelling is `import { sharedPolicyStore } from
 * '../services/policyStore.ts'` and a default parameter. That is what this file
 * had for one commit, and it broke a test in the OTHER workspace.
 *
 * `artifacts/api-server` is `"type": "module"`; `travel-buddy-standalone` has
 * no `type` and is therefore CJS. `inputAssistanceFieldInventory.test.ts` is an
 * api-server test that imports this module to check the §50 inventory merges
 * from the resolver, so it crosses that boundary. Before G340 this file had
 * ONLY `import type` declarations — all erased — so nothing was pulled across
 * at runtime. Adding a runtime import of `policyStore.ts`, which itself imports
 * `policyFallback.ts`, made the crossing two levels deep, and under the
 * `tsx/esm` loader the api-server suite uses, Node's require(esm) path failed
 * to link it: "does not provide an export named 'conservativePolicyFor'". It
 * passed standalone under `--import tsx` and failed in the suite, which is the
 * worst way for a defect to present.
 *
 * Inverting the edge fixes it without changing behaviour: this module imports
 * `policyStore.ts` for its TYPE only, and `policyStore.ts` binds the singleton
 * here when it loads. Anything that uses the store imports `policyStore.ts`
 * (the sync installer, the hook, the test seam), so the binding is in place
 * wherever policy is actually resolved.
 *
 * UNBOUND IS SAFE AND IS NOT A SILENT FAILURE MODE: with no store bound, every
 * context resolves to the conservative policy, which is the same answer as
 * "the authority has not been heard from". That is exactly what an api-server
 * test importing this module in isolation should see.
 */
let boundStore: PolicyStore | null = null;

/** Bind the process-wide store. Called by `policyStore.ts` at module load. */
export function _bindDefaultPolicyStore(store: PolicyStore): void {
  boundStore = store;
}

function defaultStore(): PolicyStore | null {
  return boundStore;
}

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
export function inputPolicyVersion(store: PolicyStore | null = defaultStore()): string {
  return store?.heldVersion() ?? 'unfetched';
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
  store: PolicyStore | null = defaultStore(),
): InputContextDescriptor {
  if (!store) return conservativeDescriptor(context);
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
  // Listed member by member rather than spread. `CONSERVATIVE_DEFAULTS` also
  // carries `maxSuggestions` and `debounceMs`, which belong to the POLICY and
  // not to the descriptor — and an object spread is exempt from TypeScript's
  // excess-property check, so the compiler accepted the wider object and the
  // mismatch only surfaced when a test compared this against what
  // `getContextDescriptor` actually returns.
  return {
    context,
    defaultMode: CONSERVATIVE_DEFAULTS.defaultMode,
    // Fresh arrays each call: the shared constant is frozen, and callers
    // legitimately treat a descriptor's lists as their own.
    entityTypes: [],
    allowedSuggestionTypes: [],
    privacyClass: CONSERVATIVE_DEFAULTS.privacyClass,
    offlinePolicy: CONSERVATIVE_DEFAULTS.offlinePolicy,
    allowPersonalization: CONSERVATIVE_DEFAULTS.allowPersonalization,
    allowLiveContext: CONSERVATIVE_DEFAULTS.allowLiveContext,
    allowMemoryContext: CONSERVATIVE_DEFAULTS.allowMemoryContext,
    allowAI: CONSERVATIVE_DEFAULTS.allowAI,
    zeroStateAssistance: CONSERVATIVE_DEFAULTS.zeroStateAssistance,
    minChars: CONSERVATIVE_DEFAULTS.minChars,
    authoritative: false,
  };
}
