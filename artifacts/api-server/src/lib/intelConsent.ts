/**
 * Intelligence Contributions consent — the server-authoritative D4 gate.
 *
 * lib/locationPurposes.ts declares the `intel_claim` purpose with
 * lawfulBasis:"consent" + requiresSeparateControl:true. The owner ruling
 * (2026-08-27): contributions require explicit informed consent PLUS a persistent
 * separate control, enforced SERVER-SIDE; client UI alone is insufficient and
 * client state cannot override server state.
 *
 * The authoritative state lives in `intel_contribution_consent` (migration 2172),
 * one row per user, written ONLY by service_role. The client may ask to enable or
 * disable, but the consent VERSION and the consent/withdrawal TIMESTAMPS are
 * stamped here, server-side — a client cannot forge them.
 *
 * FAIL-CLOSED: absence of a row, a disabled row, a withdrawn row, or any read
 * error all read as "no valid consent". writeObservation() refuses capture unless
 * this returns true.
 */

/**
 * The disclosure version a grant is recorded under. Bump this string when the
 * disclosure copy changes materially; the recorded version is the evidence of
 * WHICH disclosure a user agreed to. (This gate treats any enabled, non-withdrawn
 * consent as valid; a future policy may additionally require the current version.)
 */
export const INTEL_CONSENT_DISCLOSURE_VERSION = "intel_contributions_v1";

/**
 * The text a grant WITHOUT a displayed version was agreed to. Every client
 * shipped before the grant carried `disclosureVersion` hard-coded the v1 copy,
 * so a bare `{ enabled: true }` is evidence of v1 and nothing newer. Without
 * this, the day the constant above moves, an old client still showing v1 words
 * would have its grant recorded against text nobody on it ever saw.
 */
export const LEGACY_CLIENT_DISCLOSURE_VERSION = "intel_contributions_v1";

/** May a grant whose client displayed `seen` be recorded under `stamped`? */
export function displayedDisclosureMatches(seen: string | undefined, stamped: string): boolean {
  return (seen ?? LEGACY_CLIENT_DISCLOSURE_VERSION) === stamped;
}

export interface IntelConsentState {
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  /** The version a NEW grant would be recorded under (for the client's disclosure). */
  currentDisclosureVersion: string;
}

/**
 * True iff the actor currently has valid Intelligence Contributions consent:
 * enabled AND not withdrawn. Fail-closed on every other outcome (no row, disabled,
 * withdrawn, missing client/actor, or a read error).
 */
export async function hasValidIntelConsent(sc: any, actorId: string | null | undefined): Promise<boolean> {
  if (!sc || !actorId) return false;
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("enabled, withdrawn_at")
      .eq("user_id", actorId)
      .maybeSingle();
    if (error || !data) return false;
    return data.enabled === true && (data.withdrawn_at === null || data.withdrawn_at === undefined);
  } catch {
    return false;
  }
}

export type IntelConsentStateResult =
  | { ok: true; state: IntelConsentState }
  | { ok: false; reason: "db_error" | "no_client_or_actor" };

/**
 * Read the full consent state for the SETTINGS surface.
 *
 * WHY THIS IS NOT FAIL-SOFT, WHILE `hasValidIntelConsent` ABOVE IS. They answer
 * different questions and a failed read means opposite things to each.
 *
 *   the GATE asks "may we capture?"  — an unreadable row must answer NO. It does,
 *                                      and must keep doing so: rendering "could
 *                                      not read" as "consented" is the one
 *                                      outcome that is never acceptable.
 *   the SCREEN asks "what did I agree to?" — an unreadable row used to answer
 *                                      { enabled:false, consentedAt:null,
 *                                        withdrawnAt:null }, i.e. "you have
 *                                        never consented", to a person who had.
 *
 * That second one is not harmless, and it is not merely cosmetic. supabase-js
 * resolves on a database error, so the old code could not tell the two apart —
 * and the screen it feeds has a toggle. A consenting user shown "off" who
 * switches it on reaches PUT /v1/intel/consent, whose upsert stamps a NEW
 * consent_version and a NEW consented_at and clears withdrawn_at. The
 * evidentiary record of WHICH disclosure they agreed to and WHEN — the whole
 * reason those columns are server-stamped and service-role-only — is silently
 * rewritten by a transient read failure.
 *
 * So the read now reports its failure and the route answers db_error. The user
 * sees "we could not load this", which is true, instead of a false history of
 * their own consent.
 */
export async function getIntelConsentState(sc: any, actorId: string): Promise<IntelConsentStateResult> {
  const base: IntelConsentState = {
    enabled: false,
    consentVersion: null,
    consentedAt: null,
    withdrawnAt: null,
    currentDisclosureVersion: INTEL_CONSENT_DISCLOSURE_VERSION,
  };
  if (!sc || !actorId) return { ok: false, reason: "no_client_or_actor" };
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("enabled, consent_version, consented_at, withdrawn_at")
      .eq("user_id", actorId)
      .maybeSingle();
    if (error) return { ok: false, reason: "db_error" };
    // NO ROW is a real, readable answer: this person has never granted consent.
    // That is the only case the default-off state may be returned for.
    if (!data) return { ok: true, state: base };
    return {
      ok: true,
      state: {
        enabled: data.enabled === true,
        consentVersion: data.consent_version ?? null,
        consentedAt: data.consented_at ?? null,
        withdrawnAt: data.withdrawn_at ?? null,
        currentDisclosureVersion: INTEL_CONSENT_DISCLOSURE_VERSION,
      },
    };
  } catch {
    return { ok: false, reason: "db_error" };
  }
}

/**
 * Grant or withdraw consent, authoritatively. The caller supplies only `enabled`;
 * the version and timestamps are set here. A grant stamps the current disclosure
 * version + consented_at and clears withdrawn_at. A withdrawal sets withdrawn_at
 * and flips enabled off WITHOUT erasing the prior consent_version/consented_at
 * (that is the audit trail of what was once agreed).
 */
export async function setIntelConsent(
  sc: any,
  actorId: string,
  enabled: boolean,
  /**
   * The disclosure version the client DISPLAYED when the person agreed. When
   * given, a grant is refused unless it equals the version this server would
   * stamp — so the recorded version can never name text the person did not
   * see (the window between a server bumping INTEL_CONSENT_DISCLOSURE_VERSION
   * and an old client still rendering the previous copy). When absent, the
   * client is one that hard-coded the v1 copy (LEGACY_CLIENT_DISCLOSURE_VERSION).
   * The client still never supplies the version that is RECORDED; that is
   * always the constant.
   */
  seenDisclosureVersion?: string,
): Promise<{ ok: boolean; state?: IntelConsentState; reason?: string }> {
  if (!sc || !actorId) return { ok: false, reason: "no_client_or_actor" };
  if (enabled && !displayedDisclosureMatches(seenDisclosureVersion, INTEL_CONSENT_DISCLOSURE_VERSION)) {
    return { ok: false, reason: "disclosure_version_mismatch" };
  }
  const now = new Date().toISOString();
  const row = enabled
    ? {
        user_id: actorId,
        enabled: true,
        consent_version: INTEL_CONSENT_DISCLOSURE_VERSION,
        consented_at: now,
        withdrawn_at: null,
        updated_at: now,
      }
    : {
        // Withdrawal: only these columns change; consent_version/consented_at are
        // preserved by the ON CONFLICT update (they are not in the patch).
        user_id: actorId,
        enabled: false,
        withdrawn_at: now,
        updated_at: now,
      };
  try {
    const { error } = await sc
      .from("intel_contribution_consent")
      .upsert(row, { onConflict: "user_id" });
    if (error) return { ok: false, reason: "db_error" };
    // The write landed. If the read-back fails we must NOT hand the client a
    // default-off state — that would show a user who just granted consent that
    // they have none. Report the write's success without a state.
    const readBack = await getIntelConsentState(sc, actorId);
    return readBack.ok ? { ok: true, state: readBack.state } : { ok: true };
  } catch {
    return { ok: false, reason: "db_error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COHORT CONSENT — the token↔consent bridge, and why it is not a table join
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above answers "does THIS account consent", and the account id is
// the caller's own. The readers below answer a different question: given the
// contributor ids stored on a set of CONTRIBUTIONS, which of them consent?
//
// Until migration 3002 that was a join: `intel_observations.actor_id` WAS
// `profiles.id`, so `.in("user_id", actorIds)` on intel_contribution_consent
// answered it. 3002 replaces the stored value with a rotating contributor token
// — sha256(epoch pepper || account id), assigned by a BEFORE INSERT trigger —
// and puts the pepper in a table with RLS on, zero policies and ZERO GRANTS,
// service_role included. After it, that join matches NOTHING.
//
// AND IT DOES NOT ERROR WHEN IT MATCHES NOTHING. That is the whole hazard. The
// aggregator set `evidenceComplete = false` only on a consent-read ERROR, so a
// post-3002 database would have handed it an empty consented set, a zero-actor
// cohort, and a published suppression — "no live intelligence here" asserted as
// a measured fact over a venue that a consenting cohort had just described.
// This module exists so that state is unreachable.
//
// ── THE THREE SHAPES, AND WHY ALL THREE MUST BE TOLD APART ─────────────────
//
//   "account"      no 3002. The stored actor_id IS the account id, so the
//                  direct consent read is correct and authoritative. THIS IS
//                  PRODUCTION TODAY: 3002 is in the tree and unapplied, and
//                  intel_capture_quick_signal is TRUE, so this branch is live
//                  code, not a fossil.
//   "bridge"       3002 AND 3310 applied. public.intel_consented_contributor_tokens
//                  answers for both shapes at once (it UNIONs an account-id arm
//                  with a per-epoch token arm), so it is authoritative.
//   "unreadable"   anything else — and CRUCIALLY the state where 3002 is applied
//                  but 3310 is not. There the store is tokenised and nothing
//                  outside the database can map a token to an account, so "who
//                  consented" is genuinely UNKNOWN. Callers must WITHHOLD.
//
// The probe order makes the dangerous state impossible to mistake for the safe
// one: the bridge is asked first, and only if it is ABSENT is 3002's own
// `intel_contributor_token` probed as a marker. Absent bridge + absent marker =
// pre-3002 = "account". Absent bridge + present (or unreadable) marker =
// tokenised without a bridge = "unreadable". A transient failure of either
// probe is also "unreadable"; it is never silently downgraded to "account",
// because "account" is the shape that answers empty instead of failing.
//
// The marker probe passes p_actor_id = NULL, which 3002's function short-
// circuits (`IF p_actor_id IS NULL THEN RETURN NULL`) BEFORE it computes an
// epoch — so the probe cannot mint a pepper for an epoch in which nobody
// contributed.
//
// ── A CLIENT WITH NO .rpc ──────────────────────────────────────────────────
// Treated exactly as "both functions are absent", i.e. "account". That is the
// shape of every pre-3002 test fake in this repository and of production today,
// and it is the same reading IntelCaptureService.findReplayedObservation gives
// a client without .rpc. It is safe because "account" is only ever reached when
// nothing could be found that says the store is tokenised.

/** The 3310 bridge: contributor ids in, the consented subset out. */
export const CONSENTED_CONTRIBUTORS_RPC = "intel_consented_contributor_tokens";
/** The 3310 sibling: an account the caller already holds, its live tokens out. */
export const CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC = "intel_contributor_tokens_for_actor";
/**
 * 3002's own function, used here ONLY as a marker for "this store is tokenised".
 * Never called for its value by this module.
 */
export const CONTRIBUTOR_TOKEN_MARKER_RPC = "intel_contributor_token";

export type ContributorIdentityShape = "account" | "bridge" | "unreadable";

/**
 * How long a resolved shape is trusted. Short on purpose: applying 3002 flips
 * the correct answer, and a stale "account" verdict is the one that publishes
 * suppressions as facts. 60s bounds that window; the probe it saves is two
 * PostgREST 404s, not a query.
 */
export const CONTRIBUTOR_SHAPE_TTL_MS = 60_000;

/**
 * Per-client, so two clients in one process cannot inherit each other's verdict
 * — a real hazard in a test file where one fake has the bridge and the next does
 * not, and a real one in production the day a second client is introduced.
 */
const shapeMemo = new WeakMap<object, { shape: ContributorIdentityShape; at: number; generation: number }>();

/**
 * Bumped by the test seam. A WeakMap cannot be cleared, so invalidation is a
 * generation counter compared on read rather than a delete.
 */
let memoGeneration = 0;

/** Test seam. Invalidates every memoized shape verdict. */
export function resetContributorIdentityShapeMemo(): void {
  memoGeneration += 1;
}

type RpcOutcome =
  | { kind: "ok"; data: unknown }
  /** The function does not exist in this database (or the client cannot call one). */
  | { kind: "absent"; detail: string }
  /** It exists, or its absence could not be established. Never read as "absent". */
  | { kind: "error"; detail: string };

/**
 * True when a Supabase/PostgREST error means "this database does not have that
 * FUNCTION". PGRST202 is PostgREST's schema-cache miss for an RPC; 42883 is
 * Postgres' own undefined_function. Both are recognised because which one
 * arrives depends on whether the schema cache has been reloaded — the same
 * reasoning services/trails/TrailService.ts records for its table equivalent.
 * A permission denial (42501) is NOT absence: the function is there and the
 * answer is unknown, which is a different, withholding, outcome.
 */
function isMissingFunctionError(err: unknown): boolean {
  const code = String((err as any)?.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  if (code === "42501" || code === "PGRST301" || code === "PGRST302") return false;
  const message = String((err as any)?.message ?? "");
  return /could not find the function|function .* does not exist/i.test(message);
}

async function callRpc(sc: any, fn: string, args: Record<string, unknown>): Promise<RpcOutcome> {
  if (!sc || typeof sc.rpc !== "function") {
    return { kind: "absent", detail: `${fn}: client exposes no .rpc` };
  }
  try {
    const { data, error } = await sc.rpc(fn, args);
    if (error) {
      return isMissingFunctionError(error)
        ? { kind: "absent", detail: `${fn}: ${String((error as any).message ?? "absent")}` }
        : { kind: "error", detail: `${fn}: ${String((error as any).message ?? "rpc failed")}` };
    }
    return { kind: "ok", data };
  } catch (err) {
    // A throw is NOT an absence. A network fault, an aborted request or a driver
    // bug all land here, and reading any of them as "this database has no 3002"
    // would take the account branch on a tokenised store — the fabrication.
    return { kind: "error", detail: `${fn}: ${String((err as any)?.message ?? err)}` };
  }
}

/**
 * Which contributor-identity shape this database has. Memoized per client for
 * CONTRIBUTOR_SHAPE_TTL_MS; an "unreadable" verdict is never memoized, so a
 * transient fault cannot pin every later read into withholding.
 */
export async function resolveContributorIdentityShape(sc: any): Promise<ContributorIdentityShape> {
  const key = sc && typeof sc === "object" ? (sc as object) : null;
  if (key) {
    const hit = shapeMemo.get(key);
    if (hit && hit.generation === memoGeneration && Date.now() - hit.at < CONTRIBUTOR_SHAPE_TTL_MS) {
      return hit.shape;
    }
  }

  let shape: ContributorIdentityShape;
  // The bridge is asked FIRST and with an empty array, which 3310 answers with
  // an empty array without touching a row — a probe that is also the cheapest
  // possible real call.
  const bridge = await callRpc(sc, CONSENTED_CONTRIBUTORS_RPC, { p_tokens: [] });
  if (bridge.kind === "ok") {
    shape = "bridge";
  } else if (bridge.kind === "error") {
    shape = "unreadable";
  } else {
    const marker = await callRpc(sc, CONTRIBUTOR_TOKEN_MARKER_RPC, { p_actor_id: null });
    shape = marker.kind === "absent" ? "account" : "unreadable";
  }

  if (key && shape !== "unreadable") {
    shapeMemo.set(key, { shape, at: Date.now(), generation: memoGeneration });
  }
  return shape;
}

/** Parse a uuid[] RPC result. PostgREST hands back a bare array of strings. */
function uuidArray(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const entry of data) {
    if (typeof entry === "string" && entry !== "") out.push(entry);
    // Defensive: a driver that wraps a scalar set in row objects.
    else if (entry && typeof entry === "object") {
      for (const v of Object.values(entry as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") out.push(v);
      }
    }
  }
  return out;
}

export type ConsentedContributorsAnswer =
  | {
      ok: true;
      /** The subset of the supplied ids that currently consent. */
      consented: Set<string>;
      /** How it was established. Diagnostic; never a reason to publish. */
      via: "bridge_rpc" | "account_column" | "no_contributors";
    }
  | {
      ok: false;
      /**
       * WHY it could not be established. Every value here means WITHHOLD, and
       * none of them means "nobody consented" — a caller that collapses the two
       * re-creates the defect this module was written for.
       */
      reason: "bridge_unavailable" | "bridge_failed" | "consent_read_failed";
      detail: string;
    };

/**
 * For a set of stored contributor ids, which currently consent.
 *
 * NEVER RETURNS AN EMPTY SET TO MEAN "COULD NOT TELL". An empty `consented` on
 * an `ok: true` answer is a MEASURED empty: the database was asked and said
 * nobody. Anything else is `ok: false`, and callers must withhold on it.
 *
 * NO CALLER LEARNS WHOSE A TOKEN IS. The bridge returns a subset of the ids it
 * was given; the account behind a token exists only inside the SECURITY DEFINER
 * function, which is the only thing in the system that can read the pepper.
 */
export async function readConsentedContributors(
  sc: any,
  contributorIds: readonly (string | null | undefined)[],
): Promise<ConsentedContributorsAnswer> {
  const ids = [...new Set(contributorIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  // Nothing to ask about is a complete answer, not a degraded one: the caller's
  // cohort carried no contributor id at all.
  if (ids.length === 0) return { ok: true, consented: new Set<string>(), via: "no_contributors" };

  const shape = await resolveContributorIdentityShape(sc);
  if (shape === "unreadable") {
    return {
      ok: false,
      reason: "bridge_unavailable",
      detail:
        `${CONSENTED_CONTRIBUTORS_RPC} is absent or unreachable while ${CONTRIBUTOR_TOKEN_MARKER_RPC} could not be ruled out: ` +
        "the stored contributor ids may be rotating tokens, which nothing outside the database can map to an account, " +
        "so who consented is UNKNOWN — not empty",
    };
  }

  if (shape === "bridge") {
    const res = await callRpc(sc, CONSENTED_CONTRIBUTORS_RPC, { p_tokens: ids });
    if (res.kind !== "ok") {
      return { ok: false, reason: "bridge_failed", detail: res.detail };
    }
    return { ok: true, consented: new Set(uuidArray(res.data)), via: "bridge_rpc" };
  }

  // shape === "account": pre-3002, the stored contributor id IS the account id.
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("user_id")
      .in("user_id", ids)
      .eq("enabled", true)
      .is("withdrawn_at", null);
    if (error) {
      return { ok: false, reason: "consent_read_failed", detail: String((error as any).message ?? "consent read failed") };
    }
    const rows = (data as any[]) ?? [];
    return { ok: true, consented: new Set(rows.map((r) => String(r.user_id))), via: "account_column" };
  } catch (err) {
    return { ok: false, reason: "consent_read_failed", detail: String((err as any)?.message ?? err) };
  }
}

export type ContributorIdentitiesAnswer =
  | {
      ok: true;
      /**
       * Every value `actor_id` may hold for this account: the account id itself
       * (pre-3002 rows, and the tables 3002 left outside its scope) plus one
       * token per live epoch. Ordered account-id-first and de-duplicated.
       */
      identities: string[];
      via: "token_rpc" | "account_id";
    }
  | { ok: false; reason: "bridge_unavailable" | "bridge_failed"; detail: string };

/**
 * The contributor ids under which THIS ACCOUNT's own contributions may be
 * stored. For the two call sites that ask "is this row mine" rather than "does
 * this contributor consent".
 *
 * Runs in the safe direction only — the caller must already hold the account id,
 * and its authorization is what established that. It is never given a token and
 * never resolves one.
 *
 * A token is EPOCH-SCOPED, so an account active across a week boundary has more
 * than one live token and a lookup that used only the current epoch would
 * silently disown last week's contributions. 3310's function returns them all.
 */
export async function readOwnContributorIdentities(
  sc: any,
  actorId: string,
): Promise<ContributorIdentitiesAnswer> {
  if (!actorId) return { ok: false, reason: "bridge_failed", detail: "no actor id" };

  const shape = await resolveContributorIdentityShape(sc);
  if (shape === "unreadable") {
    return {
      ok: false,
      reason: "bridge_unavailable",
      detail:
        `${CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC} is absent or unreachable while ${CONTRIBUTOR_TOKEN_MARKER_RPC} could not be ruled out: ` +
        "this account's stored contributor identity cannot be derived, so ownership is UNKNOWN — not false",
    };
  }
  if (shape === "account") {
    // Pre-3002: the account id is the only value actor_id can hold.
    return { ok: true, identities: [actorId], via: "account_id" };
  }

  const res = await callRpc(sc, CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC, { p_actor_id: actorId });
  if (res.kind !== "ok") {
    return { ok: false, reason: "bridge_failed", detail: res.detail };
  }
  // The account id stays in the list: 3002 relabels the contribution tables, but
  // a row written before the trigger existed in some other environment, or a row
  // in a table 3002 left alone, still carries it. Including it can only widen
  // this account's view of ITS OWN rows.
  return { ok: true, identities: [...new Set([actorId, ...uuidArray(res.data)])], via: "token_rpc" };
}

/**
 * How many consenting accounts one payee resolution will enumerate.
 *
 * See `readContributorPayees` for why this exists and why exceeding it is a
 * REFUSAL rather than a truncation.
 */
export const MAX_PAYEE_ACCOUNTS = 10_000;

export type ContributorPayeeAnswer =
  | {
      ok: true;
      /**
       * stored contributor id -> the ACCOUNT to pay. Only ids whose account
       * currently consents appear; an id that is absent is either unknown or
       * non-consenting, and both mean "do not book".
       */
      accountFor: Map<string, string>;
      via: "account_id" | "token_rpc";
      /** Consenting accounts considered. Diagnostic. */
      consentingAccounts: number;
    }
  | {
      ok: false;
      /** Every value means WITHHOLD THE PASS. None means "nobody consented". */
      reason:
        | "bridge_unavailable"
        | "bridge_failed"
        | "consent_read_failed"
        | "too_many_consenting_accounts";
      detail: string;
    };

/**
 * For a set of STORED contributor ids, which ACCOUNT each one should be paid to.
 *
 * ── WHY THIS IS NOT `readConsentedContributors` ─────────────────────────────
 * That function answers "does this contributor consent", in the id space it was
 * given, and deliberately tells the caller nothing about whose a token is. It
 * is the right primitive for a reader deciding whether evidence may be counted.
 *
 * A REWARD PASS NEEDS MORE, and the difference is not a nuance. You cannot pay
 * a token: `intel_reward_ledger.actor_id` is a profiles id by ruling (3003),
 * because a payout is owed to a person and the token's pepper is deleted once
 * retention has swept its rows. So the reward path must map a stored token back
 * to an account, which is precisely the direction 3002 exists to destroy.
 *
 * ── SO IT RUNS THE MAP BACKWARDS, AND NEVER ASKS THE DATABASE ──────────────
 * There is no token -> account function and there must not be one. Instead:
 *
 *   1. enumerate the accounts that currently consent — which the application is
 *      entitled to know, because `intel_contribution_consent` is keyed by
 *      account and always has been;
 *   2. derive each of those accounts' OWN contributor identities through
 *      `readOwnContributorIdentities`, which only ever runs account -> tokens;
 *   3. invert that in memory.
 *
 * The database gains nothing. An account that does not consent is never
 * enumerated, so its tokens are never derived, so no token it owns can be
 * resolved by this path at all — the map is strictly narrower than "who is
 * everyone", by construction rather than by filtering afterwards.
 *
 * ── THE BOUND IS A REFUSAL, NOT A PAGE ─────────────────────────────────────
 * Step 2 is one round trip per consenting account. Above `MAX_PAYEE_ACCOUNTS`
 * this answers `too_many_consenting_accounts` and the caller must book nothing.
 *
 * Paying a SUBSET would be worse than stopping, and the reason is that the
 * subset would be the same subset every pass: the enumeration is deterministic,
 * so a silent truncation would permanently starve whoever fell past the cut
 * while the ledger looked healthy. A visible stop is a bug report; a silent
 * partial payment is an unpaid contributor nobody is looking for. When this
 * fires, the fix is a batched derivation, not a bigger number.
 */
export async function readContributorPayees(
  sc: any,
  storedContributorIds: readonly (string | null | undefined)[],
): Promise<ContributorPayeeAnswer> {
  const ids = [...new Set(storedContributorIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (ids.length === 0) {
    return { ok: true, accountFor: new Map(), via: "account_id", consentingAccounts: 0 };
  }

  const shape = await resolveContributorIdentityShape(sc);
  if (shape === "unreadable") {
    return {
      ok: false,
      reason: "bridge_unavailable",
      detail:
        `${CONTRIBUTOR_TOKENS_FOR_ACTOR_RPC} is absent or unreachable while ${CONTRIBUTOR_TOKEN_MARKER_RPC} could not be ruled out: ` +
        "the stored contributor ids may be rotating tokens, so who to pay is UNKNOWN — not nobody",
    };
  }

  // ── Pre-3002: the stored id IS the account, so the map is the identity and
  // the consent read can be narrowed to exactly the ids in hand.
  if (shape === "account") {
    try {
      const { data, error } = await sc
        .from("intel_contribution_consent")
        .select("user_id")
        .in("user_id", ids)
        .eq("enabled", true)
        .is("withdrawn_at", null);
      if (error) {
        return {
          ok: false,
          reason: "consent_read_failed",
          detail: String((error as any).message ?? "consent read failed"),
        };
      }
      const accountFor = new Map<string, string>();
      for (const row of ((data as any[]) ?? [])) {
        const u = row?.user_id;
        if (typeof u === "string" && u !== "") accountFor.set(u, u);
      }
      return { ok: true, accountFor, via: "account_id", consentingAccounts: accountFor.size };
    } catch (e) {
      return {
        ok: false,
        reason: "consent_read_failed",
        detail: e instanceof Error ? e.message : "consent read threw",
      };
    }
  }

  // ── Post-3002: enumerate consenting ACCOUNTS, then derive their tokens.
  let accounts: string[];
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("user_id")
      .eq("enabled", true)
      .is("withdrawn_at", null)
      .limit(MAX_PAYEE_ACCOUNTS + 1);
    if (error) {
      return {
        ok: false,
        reason: "consent_read_failed",
        detail: String((error as any).message ?? "consent read failed"),
      };
    }
    accounts = [
      ...new Set(
        ((data as any[]) ?? [])
          .map((r) => r?.user_id)
          .filter((u): u is string => typeof u === "string" && u !== ""),
      ),
    ];
  } catch (e) {
    return {
      ok: false,
      reason: "consent_read_failed",
      detail: e instanceof Error ? e.message : "consent read threw",
    };
  }

  if (accounts.length > MAX_PAYEE_ACCOUNTS) {
    return {
      ok: false,
      reason: "too_many_consenting_accounts",
      detail:
        `${accounts.length} consenting accounts exceeds MAX_PAYEE_ACCOUNTS=${MAX_PAYEE_ACCOUNTS}. ` +
        "Booking a subset would starve the same accounts every pass, so nothing is booked. Batch the derivation.",
    };
  }

  const wanted = new Set(ids);
  const accountFor = new Map<string, string>();
  for (const account of accounts) {
    const own = await readOwnContributorIdentities(sc, account);
    if (!own.ok) {
      // ONE account's identities failing is the whole answer failing. Skipping
      // it would silently drop that person's earnings while the pass reported
      // success, which is the failure mode this module exists to refuse.
      return { ok: false, reason: own.reason, detail: `${account}: ${own.detail}` };
    }
    for (const identity of own.identities) {
      if (wanted.has(identity)) accountFor.set(identity, account);
    }
  }
  return { ok: true, accountFor, via: "token_rpc", consentingAccounts: accounts.length };
}
