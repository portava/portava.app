/**
 * Global Input Intelligence §48 / G340 — the client's policy snapshot store.
 *
 * Holds ONE snapshot of the authority's policy table, tagged with the
 * `policyVersion` it came from, the account it was fetched for, and when. Every
 * read re-checks all three, because each of them can go wrong independently and
 * each failure has to land on the conservative policy rather than on a stale
 * permission.
 *
 * Pure module: no React, no network, no RN, injectable clock. That is what lets
 * the account-switch and expiry behaviour be PROVEN under node:test instead of
 * argued about — the failures this file exists to prevent are exactly the ones
 * that are invisible in a manual pass.
 *
 * ── WHY EACH GUARD IS HERE ───────────────────────────────────────────────────
 *
 * ACCOUNT. The snapshot is per-account because policy is per-viewer: the same
 * context can be `allowPersonalization: true` for one account and false for
 * another, and `privacyClass` decides whether that account's suggestions may
 * enter a process-global cache. A snapshot that outlived a logout would apply
 * the previous user's permissions to the next one. `forAccount` refuses a read
 * whose account does not match, rather than returning "close enough".
 *
 * A read for account `null` (signed out) never matches a stored snapshot. Being
 * signed out is not an account, so it gets the conservative policy — which is
 * also correct on its own terms: the suggest endpoint requires a token.
 *
 * VERSION. `policyVersion` travels on every suggest response and is the
 * authority's own statement of which policy table produced it. When it differs
 * from the snapshot's, the snapshot is by definition out of date; `noteServed
 * Version` records that and the snapshot is treated as stale on the next read.
 * This is the mechanism §48 promised and could not deliver while there was no
 * endpoint: a client could learn its copy was stale and had nowhere to go.
 *
 * EXPIRY. A snapshot older than `maxAgeMs` is not served. This is the guard
 * most easily argued away — "the old policy is probably still right" — and the
 * argument is backwards. A policy change that TIGHTENS a field (a context
 * reclassified `sensitive_location`, personalization withdrawn) is exactly the
 * change a long-lived process must not miss, and the longer the process has
 * been running the more likely it has missed one. Expiry costs a refetch;
 * missing a tightening costs the thing the tightening was for.
 */
import type { InputContext } from '../types/inputContext.ts';
import {
  conservativePolicyFor,
  sanitizeServedPolicy,
  type ServedContextPolicy,
} from '../contexts/policyFallback.ts';

/** A snapshot's age ceiling. Twelve hours: long enough that a normal session
 *  refetches roughly once, short enough that a tightening cannot be missed for
 *  the life of a backgrounded app. */
export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface PolicySnapshot {
  policyVersion: string;
  /** The account the snapshot was fetched for. `null` is never stored. */
  accountId: string;
  contexts: Map<InputContext, ServedContextPolicy>;
  fetchedAt: number;
}

/** Why a read did not return a served policy. Reported, never silently merged
 *  into "no policy", because the four have different remedies. */
export type PolicyMissReason =
  | 'never_fetched'
  | 'account_mismatch'
  | 'expired'
  | 'version_superseded'
  | 'context_absent';

export interface PolicyReadResult {
  policy: ServedContextPolicy;
  /** True only when this came from the authority and passed every guard. */
  authoritative: boolean;
  /** Set when `authoritative` is false. */
  reason?: PolicyMissReason;
}

export interface PolicyStoreOptions {
  maxAgeMs?: number;
}

export class PolicyStore {
  private snapshot: PolicySnapshot | null = null;
  /**
   * Who the app is signed in as RIGHT NOW, as last reported by the auth
   * listener. Held here so the PURE resolvers (`getContextDescriptor`,
   * `buildDefaultPolicy`) can ask "policy for the current viewer" without
   * importing the Supabase-backed auth module, which would make them
   * unreachable from node:test — the exact trade that left the previous
   * registry untested against a real account switch.
   */
  private activeAccountId: string | null = null;
  /** The newest `policyVersion` any suggest response has reported. */
  private servedVersion: string | null = null;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: PolicyStoreOptions = {}, now: () => number = Date.now) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = now;
  }

  /**
   * Install a freshly fetched table. Every context is sanitized on the way in,
   * so nothing unrecognised is ever stored — a later read cannot be the place a
   * bad value first gets noticed.
   *
   * A snapshot for a `null` account is refused outright rather than stored
   * under a placeholder key.
   */
  install(accountId: string | null, policyVersion: unknown, rawContexts: unknown): boolean {
    if (accountId == null || accountId === '') return false;
    if (typeof policyVersion !== 'string' || policyVersion === '') return false;
    if (rawContexts === null || typeof rawContexts !== 'object') return false;

    const contexts = new Map<InputContext, ServedContextPolicy>();
    for (const [key, value] of Object.entries(rawContexts as Record<string, unknown>)) {
      // The key is the context name. It is NOT validated against a local list
      // of contexts: a server that knows a context this build does not is the
      // normal §48 skew, and storing it costs nothing because every consumer
      // looks up by a context IT names. What matters is that the VALUE is
      // narrowed, which `sanitizeServedPolicy` does.
      contexts.set(key as InputContext, sanitizeServedPolicy(key as InputContext, value));
    }
    if (contexts.size === 0) return false;

    this.snapshot = { policyVersion, accountId, contexts, fetchedAt: this.now() };
    // The table we just installed IS the served version as far as this client
    // knows; anything older it had recorded is no longer evidence of staleness.
    this.servedVersion = policyVersion;
    return true;
  }

  /**
   * Record the `policyVersion` a suggest response carried. When it differs from
   * the held snapshot's, the snapshot is stale from the next read onward.
   */
  noteServedVersion(policyVersion: string | null | undefined): void {
    if (typeof policyVersion !== 'string' || policyVersion === '') return;
    this.servedVersion = policyVersion;
  }

  /** True when a refetch is warranted: nothing held, expired, or superseded. */
  needsRefresh(accountId: string | null): boolean {
    const s = this.snapshot;
    if (!s) return true;
    if (accountId == null || s.accountId !== accountId) return true;
    if (this.now() - s.fetchedAt >= this.maxAgeMs) return true;
    if (this.servedVersion !== null && this.servedVersion !== s.policyVersion) return true;
    return false;
  }

  /**
   * Resolve one context for one account.
   *
   * Returns the conservative policy — never null, never a partial — whenever
   * any guard fails, so no caller can forget to handle a miss. The `reason` is
   * for diagnosis; the POLICY is already safe.
   */
  read(context: InputContext, accountId: string | null): PolicyReadResult {
    const miss = (reason: PolicyMissReason): PolicyReadResult => ({
      policy: conservativePolicyFor(context),
      authoritative: false,
      reason,
    });

    const s = this.snapshot;
    if (!s) return miss('never_fetched');
    if (accountId == null || s.accountId !== accountId) return miss('account_mismatch');
    if (this.now() - s.fetchedAt >= this.maxAgeMs) return miss('expired');
    if (this.servedVersion !== null && this.servedVersion !== s.policyVersion) {
      return miss('version_superseded');
    }
    const p = s.contexts.get(context);
    if (!p) return miss('context_absent');
    // Copy the arrays out: consumers treat a policy's lists as their own.
    return {
      policy: { ...p, allowedSuggestionTypes: [...p.allowedSuggestionTypes], entityTypes: [...p.entityTypes] },
      authoritative: true,
    };
  }

  /**
   * Report who is signed in. Called from the auth listener.
   *
   * A CHANGE of account drops the snapshot immediately rather than waiting for
   * the next read to notice the mismatch. Both behaviours are safe — `read`
   * refuses a mismatched snapshot anyway — but dropping it here means the
   * previous account's table does not sit in memory for the lifetime of the
   * next session, which matters because that table is the record of what the
   * previous viewer was permitted.
   *
   * Signing out (`null`) clears for the same reason.
   */
  setActiveAccount(accountId: string | null): void {
    if (this.activeAccountId === accountId) return;
    this.activeAccountId = accountId;
    this.clear();
  }

  /** Who the store currently considers signed in. */
  activeAccount(): string | null {
    return this.activeAccountId;
  }

  /** Resolve for the signed-in viewer. The shape every UI consumer uses. */
  readActive(context: InputContext): PolicyReadResult {
    return this.read(context, this.activeAccountId);
  }

  /** The held snapshot's version, for diagnostics and for the suggest request. */
  heldVersion(): string | null {
    return this.snapshot?.policyVersion ?? null;
  }

  /** The account the held snapshot belongs to. */
  heldAccount(): string | null {
    return this.snapshot?.accountId ?? null;
  }

  /**
   * Drop everything. Called on sign-out and on account switch.
   *
   * `servedVersion` is cleared too. It is a fact about the PREVIOUS session's
   * responses, and carrying it across a logout would make the next account's
   * first fetch look superseded the moment it landed.
   */
  clear(): void {
    this.snapshot = null;
    this.servedVersion = null;
  }
}

/**
 * The process-wide store. One per app, like `sharedSuggestionCache` — and
 * cleared by the same sign-out path, in `installInputPolicySync.ts`.
 */
export const sharedPolicyStore = new PolicyStore();

// ── TEST SEAM ────────────────────────────────────────────────────────────────
//
// Follows the codebase's existing underscore convention for test-only entry
// points (`fieldRegistry.ts#_resetRegistry`, `apiToken.ts#_setTestSupabase`).
//
// WHY A SEAM AND NOT A FIXTURE TABLE. A test that needs `city_picker` to be
// assisted could declare a 29-context fixture — and that fixture would be a
// THIRD copy of the policy, which is the defect G340 removed. So this seeds ONE
// template across every context a test names: the meaning is "the authority
// permits this", not "the authority says exactly these 29 things". What each
// context's real values are is the SERVER's business, asserted on that side by
// `inputPolicyContractParity.test.ts` and `inputPolicyEndpoint.test.ts`.
//
// The client's own contract is narrower and is what these tests check: given
// the authority says X, the client does X — and given no authority, it does
// nothing.

/** A deliberately permissive template. Tests override what they care about. */
export const _PERMISSIVE_TEST_POLICY = {
  mode: 'search',
  // The FULL AssistanceType vocabulary: this template means "the authority
  // permits everything", and a partial list would quietly mean "permits these
  // five", which is itself a policy and would make some tests vacuous.
  allowedSuggestionTypes: [
    'entity',
    'completion',
    'recent',
    'personalized',
    'structured_value',
    'action',
    'correction',
    'validation',
    'disambiguation',
    'ai_suggestion',
  ],
  entityTypes: ['city', 'country', 'place', 'user'],
  allowPersonalization: true,
  allowLiveContext: true,
  allowMemoryContext: true,
  allowAI: true,
  minChars: 2,
  maxSuggestions: 8,
  debounceMs: 120,
  offlinePolicy: 'cached_local',
  privacyClass: 'public',
  zeroStateAssistance: true,
} as const;

/** The account id seeded tests run as. Any stable non-empty string works. */
export const _TEST_ACCOUNT = 'test-account-0000';

/**
 * Seed `store` so the named contexts resolve authoritatively. TESTS ONLY.
 *
 * `overrides` maps a context to the members that matter for the test; anything
 * unset comes from `_PERMISSIVE_TEST_POLICY`. Values still pass through
 * `sanitizeServedPolicy` on install, so a seed cannot grant something a real
 * served policy could not.
 */
export function _seedPolicyForTests(
  contexts: readonly string[],
  overrides: Record<string, Record<string, unknown>> = {},
  store: PolicyStore = sharedPolicyStore,
  policyVersion = 'test-policy-v1',
): void {
  const table: Record<string, unknown> = {};
  for (const c of contexts) {
    table[c] = { context: c, ..._PERMISSIVE_TEST_POLICY, ...(overrides[c] ?? {}) };
  }
  store.setActiveAccount(_TEST_ACCOUNT);
  store.install(_TEST_ACCOUNT, policyVersion, table);
}
