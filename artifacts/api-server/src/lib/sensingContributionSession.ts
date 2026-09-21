/**
 * sensingContributionSession — the ISSUED half of §4.2's
 * IntelligenceContributionSession, over the row shape migration 2480 defines
 * (UNAPPLIED — the owner runs all SQL). lib/sensingContributionPolicy is the
 * policy half; this is issuance, validation, and the privacy budget.
 *
 * ── THE SHAPE, AND WHAT IS NOT IN IT ─────────────────────────────────────────
 * A session is a short-lived bearer CREDENTIAL, stored only as an HMAC
 * (lib/sensingAnonStore.deriveSensingCredentialHash), with the policy it was
 * issued under and a budget of cohorts it may still contribute to. It carries
 * NO identity column (2480's postconditions refuse the same names 2315 does),
 * and a contribution carries no session column (2315 forbids `session_id`
 * outright). The two are linked ONLY in the request that presents the
 * credential and the commitment together; at rest, nothing joins them. That is
 * §3's "eligibility proves an authorized participating device; ingest receives
 * an opaque short-lived credential", with the join living nowhere.
 *
 * Under Option A (authenticated_only) migration 2481 adds a NULLABLE
 * `issued_to_profile_id` to the SESSION row — never to a contribution — so an
 * operator can revoke everything an abusive account obtained. Under Option B
 * that column is never added. This module never reads it.
 *
 * ── THE BUDGET IS THE ABUSE CONTROL, AND IT IS ATOMIC IN SQL ─────────────────
 * `sensing_session_consume(p_credential_hash, p_now)` (2480) decrements the
 * remaining-cohort budget in one UPDATE and returns a named reason. A device
 * that replays within a cohort hits 2340's replay key (no row, no budget
 * spent — the caller consumes budget only after a NON-duplicate write); a
 * device that sprays cohorts exhausts its budget and is refused until it
 * re-issues, which under Option B costs a fresh attestation and under Option A
 * costs the profile-keyed rate limit. The in-memory model below is the same
 * predicate, so the property is provable without a database.
 *
 * PURE except the two `*Rpc` bindings, which take an injected client and
 * report failure as failure.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveSensingCredentialHash, SENSING_MAX_TTL_SECONDS } from "./sensingAnonStore.js";
import {
  admitSensingContribution,
  SENSING_ANON_POLICY_V1,
  type IntelligenceContributionPolicy,
  type SensingAdmission,
  type SensingAdmissionInput,
} from "./sensingContributionPolicy.js";
import { SENSING_ISSUANCE_CLASSES, type SensingIssuanceClass } from "./sensingAuthPosture.js";

export const SENSING_SESSIONS_TABLE = "sensing_contribution_sessions";

/** A session may not outlive a contribution's TTL ceiling. */
export const SENSING_SESSION_MAX_LIFETIME_SECONDS = SENSING_MAX_TTL_SECONDS;
/** Default lifetime: one day. Re-issuance is cheap and bounds the blast radius of a leaked bearer. */
export const SENSING_SESSION_DEFAULT_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * v1 DEFAULT budgets — cohorts a session may contribute to over its lifetime.
 * A cohort is one zone × 30-minute bucket, so 48 is "two zones an hour for a
 * day"; 8 is "a handful, then re-attest". These are proposals for the owner's
 * abuse-budget decision, seeded conservative; they are not a policy the owner
 * has taken.
 */
export const SENSING_SESSION_DEFAULT_BUDGET: Readonly<Record<SensingIssuanceClass, number>> = Object.freeze({
  authenticated_profile: 48,
  attested_device: 48,
  unattested_device: 8,
});

/** The 2480 row, minus `id`. Note the absence of any identity column. */
export interface SensingContributionSessionRow {
  credential_hash: string;
  policy_version: number;
  purpose_scopes: string[];
  reduction_version: number;
  issuance_class: SensingIssuanceClass;
  budget_cohorts_remaining: number;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** A fresh opaque bearer. 32 random bytes, base64url: never derived from anything. */
export function generateSensingCredential(): string {
  return randomBytes(32).toString("base64url");
}

export interface IssueSessionInput {
  credential: string;
  issuanceClass: SensingIssuanceClass;
  nowMs: number;
  lifetimeSeconds?: number;
  budget?: number;
  policy?: IntelligenceContributionPolicy;
}

export type IssueSessionResult = { ok: true; row: SensingContributionSessionRow } | { ok: false; error: string };

/** Build the session row for a credential. PURE: the credential is hashed, never stored. */
export function buildSensingSessionRow(input: IssueSessionInput): IssueSessionResult {
  if (!input || !Number.isFinite(input.nowMs)) return { ok: false, error: "now_invalid" };
  if (!input.credential || typeof input.credential !== "string" || input.credential.length < 32) {
    return { ok: false, error: "credential_too_short" };
  }
  if (!SENSING_ISSUANCE_CLASSES.includes(input.issuanceClass)) return { ok: false, error: "issuance_class_invalid" };
  const lifetime = input.lifetimeSeconds ?? SENSING_SESSION_DEFAULT_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0) return { ok: false, error: "lifetime_invalid" };
  if (lifetime > SENSING_SESSION_MAX_LIFETIME_SECONDS) return { ok: false, error: "lifetime_exceeds_maximum" };
  const budget = input.budget ?? SENSING_SESSION_DEFAULT_BUDGET[input.issuanceClass];
  if (!Number.isInteger(budget) || budget <= 0) return { ok: false, error: "budget_invalid" };
  const policy = input.policy ?? SENSING_ANON_POLICY_V1;
  return {
    ok: true,
    row: {
      credential_hash: deriveSensingCredentialHash(input.credential),
      policy_version: policy.policyVersion,
      purpose_scopes: [...policy.purposeScopes],
      reduction_version: policy.clientCapability.reductionVersion,
      issuance_class: input.issuanceClass,
      budget_cohorts_remaining: budget,
      starts_at: new Date(input.nowMs).toISOString(),
      expires_at: new Date(input.nowMs + lifetime * 1000).toISOString(),
      revoked_at: null,
    },
  };
}

export type SessionRefusal =
  | "unknown"
  | "credential_mismatch"
  | "revoked"
  | "not_started"
  | "expired"
  | "budget_exhausted";

export type SessionValidation = { ok: true } | { ok: false; reason: SessionRefusal };

/**
 * Is this session usable for a contribution presented with this credential,
 * as of `nowMs`? Order: existence, credential, revocation, window, budget —
 * the same order the SQL function uses, so the two cannot disagree.
 */
export function validateSensingSession(
  row: SensingContributionSessionRow | null | undefined,
  credential: string,
  nowMs: number,
): SessionValidation {
  if (!row) return { ok: false, reason: "unknown" };
  if (!credential || deriveSensingCredentialHash(credential) !== row.credential_hash) {
    return { ok: false, reason: "credential_mismatch" };
  }
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  const starts = Date.parse(row.starts_at);
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(starts) || !Number.isFinite(expires)) return { ok: false, reason: "expired" }; // fail-closed
  if (nowMs < starts) return { ok: false, reason: "not_started" };
  if (nowMs >= expires) return { ok: false, reason: "expired" };
  if (!Number.isInteger(row.budget_cohorts_remaining) || row.budget_cohorts_remaining <= 0) {
    return { ok: false, reason: "budget_exhausted" };
  }
  return { ok: true };
}

/** In-memory model of `sensing_session_consume`: the same predicate, then one decrement. */
export function consumeSensingSessionBudget(
  row: SensingContributionSessionRow,
  credential: string,
  nowMs: number,
): { ok: true; row: SensingContributionSessionRow } | { ok: false; reason: SessionRefusal } {
  const v = validateSensingSession(row, credential, nowMs);
  if (!v.ok) return v;
  return { ok: true, row: { ...row, budget_cohorts_remaining: row.budget_cohorts_remaining - 1 } };
}

/**
 * The full ingest-side check for one contribution: the session must be valid
 * and the contribution admitted under the session's OWN scopes (not the
 * caller's claim about them). Pure; consumes no budget — budget is consumed
 * only after a non-duplicate write, by the caller, atomically in SQL.
 */
export function admitWithSensingSession(
  row: SensingContributionSessionRow | null | undefined,
  credential: string,
  input: SensingAdmissionInput,
  nowMs: number,
  policy: IntelligenceContributionPolicy = SENSING_ANON_POLICY_V1,
): SensingAdmission | { admitted: false; reason: `session_${SessionRefusal}` } {
  const v = validateSensingSession(row, credential, nowMs);
  if (!v.ok) return { admitted: false, reason: `session_${v.reason}` };
  const requested = input.purposeScopes ?? row!.purpose_scopes;
  for (const s of requested) {
    if (!row!.purpose_scopes.includes(s)) return { admitted: false, reason: "scope_not_granted", scope: s };
  }
  return admitSensingContribution(
    { ...input, purposeScopes: requested, reductionVersion: input.reductionVersion ?? row!.reduction_version },
    nowMs,
    policy,
  );
}

// ── RPC bindings (2480's functions; the client is injected) ──────────────────

export type SessionRpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `sensing_session_consume` → the SQL function's named reason ('ok' or a SessionRefusal). */
export async function consumeSensingSessionRpc(
  db: SupabaseClient,
  credential: string,
  nowIso: string,
): Promise<SessionRpcResult<"ok" | SessionRefusal>> {
  try {
    const { data, error } = await db.rpc("sensing_session_consume", {
      p_credential_hash: deriveSensingCredentialHash(credential),
      p_now: nowIso,
    });
    if (error) return { ok: false, error: error.message ?? "consume_failed" };
    return { ok: true, value: String(data) as "ok" | SessionRefusal };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "consume_threw" };
  }
}

/** `revoke_sensing_session` → number of sessions revoked (0 or 1). */
export async function revokeSensingSessionRpc(
  db: SupabaseClient,
  credential: string,
  nowIso: string,
): Promise<SessionRpcResult<number>> {
  try {
    const { data, error } = await db.rpc("revoke_sensing_session", {
      p_credential_hash: deriveSensingCredentialHash(credential),
      p_now: nowIso,
    });
    if (error) return { ok: false, error: error.message ?? "revoke_failed" };
    return { ok: true, value: Number(data) || 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revoke_threw" };
  }
}
