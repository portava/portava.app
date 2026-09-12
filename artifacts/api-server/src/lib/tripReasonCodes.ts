/**
 * Trips spec Appendix B — the reason-code vocabulary, in one place.
 *
 * WHY ONE MODULE
 * ==============
 * Appendix B names eleven families: TRIP_AUTH_*, TRIP_VERSION_*,
 * TRIP_TEMPORAL_*, TRIP_SPATIAL_*, TRIP_PRIVACY_*, TRIP_PRESENCE_*,
 * TRIP_BOOKING_*, TRIP_DISRUPTION_*, TRIP_PROJECTION_*, TRIP_IDENTITY_*,
 * TRIP_OFFLINE_*. census-trips TR441-TR451 measured that the kernel emitted
 * four of them and every other refusal in the trip domain reached the client
 * as a bare `forbidden` / `not_found` / `db_error` — the BEHAVIOUR was right
 * and the REASON was not reported, so a client could not tell "you are not on
 * this trip" from "this trip is private" from "this member is in ghost mode".
 *
 * This is the one list. lib/tripKernel.ts's TripKernelReason is a SUBSET of
 * it and src/test/tripReasonCodes.test.ts proves that by reading the kernel
 * file as text, so a reason the kernel invents and this file does not know is
 * a failing test, not a silent second vocabulary.
 *
 * DECLARED IS NOT EMITTED
 * =======================
 * A family counts as BUILT only when some live refusal emits a code from it.
 * The test reports which codes below are declared and never emitted, and the
 * census grades each family on emission, not on declaration. Codes that
 * belong to a subsystem that does not exist yet (offline queue, disruption
 * switch) are declared here so the vocabulary is complete and the census can
 * say "declared, not emitted" precisely — they are not credit.
 *
 * INTERNAL-ONLY REASONS
 * =====================
 * Some reasons are true and must not be told. TRIP_AUTH_BLOCKED is the clear
 * case: `GET /trips/:tripId` answers a blocked viewer with 404 "Trip not
 * found" ON PURPOSE, because "you are blocked" reveals the block. The policy
 * function returns the honest reason so the ROUTE can decide, and
 * `sendTripRefusal` refuses to put an internal-only reason on the wire —
 * throwing rather than leaking, because a leak here is a privacy defect and a
 * thrown error is a 500 somebody notices.
 */
import type { Response } from "express";

import { sendError, type ApiErrorCode } from "./http.js";

export const TRIP_REASON_FAMILIES = [
  "TRIP_AUTH", "TRIP_VERSION", "TRIP_TEMPORAL", "TRIP_SPATIAL", "TRIP_PRIVACY",
  "TRIP_PRESENCE", "TRIP_BOOKING", "TRIP_DISRUPTION", "TRIP_PROJECTION",
  "TRIP_IDENTITY", "TRIP_OFFLINE",
] as const;
export type TripReasonFamily = (typeof TRIP_REASON_FAMILIES)[number];

/**
 * Appendix B, family by family. The kernel's own reasons are listed under
 * their family with the migration that introduced them, so the two sets are
 * visibly the same set.
 */
export const TRIP_REASON_CODES = [
  // ── TRIP_AUTH_* ────────────────────────────────────────────────────────────
  "TRIP_AUTH_UNAUTHENTICATED",        // no token; the capability needs one
  "TRIP_AUTH_BLOCKED",                // INTERNAL ONLY — see header
  "TRIP_AUTH_NOT_CREW",               // 2420
  "TRIP_AUTH_NOT_OWNER",              // 2420
  "TRIP_AUTH_NOT_INVITED",            // 2450
  "TRIP_AUTH_NOT_HOST",               // 2500
  "TRIP_AUTH_NOT_LINK_HOLDER",        // 2500
  "TRIP_AUTH_NOT_ADMIN",              // 2450
  "TRIP_AUTH_ROLE_NOT_PERMITTED",     // 2450
  "TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN",// 2420
  "TRIP_AUTH_NOT_CREATOR",            // acting on a row someone else created
  // ── TRIP_VERSION_* ─────────────────────────────────────────────────────────
  "TRIP_VERSION_CONFLICT",            // 2420
  "TRIP_VERSION_UNREADABLE",          // a projection could not read trips.version
  // ── TRIP_TEMPORAL_* ────────────────────────────────────────────────────────
  "TRIP_TEMPORAL_RANGE_INVERTED",     // 2420 / lib/tripKernel.ts
  "TRIP_TEMPORAL_CONFLICT",           // §7.2 two things cannot both be kept
  "TRIP_TEMPORAL_INFEASIBLE",         // §7.2 invariant violated on a hop
  "TRIP_TEMPORAL_UNKNOWN",            // §7.2 could not be evaluated
  // ── TRIP_SPATIAL_* ─────────────────────────────────────────────────────────
  "TRIP_SPATIAL_STAGE_LOCALITY",      // §7.4
  "TRIP_SPATIAL_PLACE_IDENTITY",      // §7.4
  "TRIP_SPATIAL_ROUTE_UNAVAILABLE",   // §7.4
  "TRIP_SPATIAL_NO_COORDINATES",      // a place with no location
  // ── TRIP_PRIVACY_* ─────────────────────────────────────────────────────────
  "TRIP_PRIVACY_NOT_VISIBLE",         // §6.3 private / invite-only, and not crew
  "TRIP_PRIVACY_BUDDIES_ONLY",        // §6.3 buddies visibility, no mutual follow
  "TRIP_PRIVACY_PREVIEW_ONLY",        // §6.3 public trip: stripped shape, not full
  // ── TRIP_PRESENCE_* ────────────────────────────────────────────────────────
  "TRIP_PRESENCE_NOT_SELF",           // 2768
  "TRIP_PRESENCE_NOT_FOUND",          // 2768
  "TRIP_PRESENCE_GHOST",              // §10.3 ghost mode: invisible
  "TRIP_PRESENCE_HIDDEN",             // §10.3 default visibility hidden, no grant
  "TRIP_PRESENCE_STALE",              // §10.2 last-known, not live truth
  // ── TRIP_BOOKING_* ─────────────────────────────────────────────────────────
  "TRIP_BOOKING_NOT_MEMBER",
  "TRIP_BOOKING_NOT_CREATOR_OR_OWNER",// delete is stricter than edit
  "TRIP_BOOKING_NOT_FOUND",
  "TRIP_BOOKING_HISTORY_APPEND_ONLY", // §15.4 a booking is cancelled, not erased
  // ── TRIP_DISRUPTION_* ──────────────────────────────────────────────────────
  "TRIP_DISRUPTION_SUPPRESSED",       // §17.2 commercial surface suppressed
  "TRIP_DISRUPTION_ACTIVE",
  // ── TRIP_PROJECTION_* ──────────────────────────────────────────────────────
  "TRIP_PROJECTION_UNAVAILABLE",      // lib/tripDiscoveryProjection.ts
  "TRIP_PROJECTION_STALE",            // §19.1 consumer rejects a stale projection
  "TRIP_PROJECTION_SCHEMA_MISMATCH",  // §19.1 projectionSchemaVersion not accepted
  "TRIP_PROJECTION_VERSION_AHEAD",    // §22.4 sourceTripVersion > aggregate version
  // ── TRIP_IDENTITY_* ────────────────────────────────────────────────────────
  "TRIP_IDENTITY_ALREADY_EXISTS",     // 2450
  "TRIP_IDENTITY_UNRESOLVED_PLACE",   // a place id that resolves to no row
  // ── TRIP_OFFLINE_* ─────────────────────────────────────────────────────────
  "TRIP_OFFLINE_REVALIDATION_REQUIRED",// §18.2 sensitive mutation after reconnect
  "TRIP_OFFLINE_QUEUE_REJECTED",
  "TRIP_OFFLINE_BUNDLE_STALE",
] as const;
export type TripReasonCode = (typeof TRIP_REASON_CODES)[number];

/**
 * The kernel's reasons that are NOT Appendix B families. lib/tripKernel.ts's
 * header records them as owner decisions — TRIP_PLAN_*, TRIP_LIFECYCLE_* and
 * so on are state-machine refusals the spec does not name a family for, and
 * filing them under TRIP_TEMPORAL_* or TRIP_AUTH_* would misstate what was
 * checked. Listed so the "every emitted reason is known here" test can hold
 * without pretending these are Appendix B.
 */
export const TRIP_KERNEL_EXTENSION_CODES = [
  "TRIP_COMMAND_MALFORMED", "TRIP_COMMAND_UNKNOWN_TYPE", "TRIP_KERNEL_UNAVAILABLE",
  "TRIP_NOT_FOUND", "TRIP_PLAN_NOT_FOUND", "TRIP_PLAN_INVALID_TRANSITION",
  "TRIP_PLAN_VERSION_CONFLICT", "TRIP_PLAN_ATTENDANCE_NOT_FOUND",
  "TRIP_LIFECYCLE_INVALID_TRANSITION",
  "TRIP_PARTICIPANT_ALREADY_EXISTS", "TRIP_PARTICIPANT_NOT_FOUND",
  "TRIP_PARTICIPANT_IS_OWNER", "TRIP_PARTICIPANT_CAPACITY_REACHED",
  "TRIP_STAGE_NOT_FOUND", "TRIP_STAGE_SEQUENCE_TAKEN",
  "TRIP_LEG_NOT_FOUND", "TRIP_COMMITMENT_NOT_FOUND",
  "TRIP_GOAL_NOT_FOUND", "TRIP_DECISION_TASK_NOT_FOUND", "TRIP_RISK_NOT_FOUND",
  "TRIP_ASSIGNEE_NOT_CREW",
  "TRIP_PROPOSAL_NOT_FOUND", "TRIP_PROPOSAL_NOT_PENDING", "TRIP_PROPOSAL_VOTE_NOT_MET",
  "TRIP_PROPOSAL_PAYLOAD_INVALID", "TRIP_PROPOSAL_RULE_UNKNOWN",
  // §22.1/§22.2 snapshot and replay (2773). Emitted by trip_snapshot_write and
  // trip_snapshot_verify_replay in SQL; found by the vocabulary test's SQL
  // scan on its first run, which is the second-vocabulary case it exists for.
  "TRIP_SNAPSHOT_NOT_FOUND", "TRIP_SNAPSHOT_NO_EVENTS",
] as const;

const KNOWN: ReadonlySet<string> = new Set<string>([...TRIP_REASON_CODES, ...TRIP_KERNEL_EXTENSION_CODES]);

export function isKnownTripReason(s: string): boolean {
  return KNOWN.has(s);
}

/** `TRIP_PRIVACY_NOT_VISIBLE` -> `TRIP_PRIVACY`; null for an extension code. */
export function tripReasonFamily(code: string): TripReasonFamily | null {
  for (const f of TRIP_REASON_FAMILIES) {
    if (code.startsWith(f + "_")) return f;
  }
  return null;
}

/**
 * Reasons that are TRUE and must NOT reach the client. See the header.
 * sendTripRefusal throws on these: a 500 that an operator sees beats a leak
 * that a user does.
 */
export const INTERNAL_ONLY_REASONS: ReadonlySet<TripReasonCode> = new Set<TripReasonCode>([
  "TRIP_AUTH_BLOCKED",
]);

/**
 * The refusal envelope: `sendError`'s `{ error, message }` plus `reason`.
 * Additive — every existing `sendError` call is byte-identical, and a client
 * that ignores `reason` sees exactly what it saw before.
 */
export function sendTripRefusal(
  res: Response,
  code: ApiErrorCode,
  reason: TripReasonCode,
  message?: string,
): void {
  if (INTERNAL_ONLY_REASONS.has(reason)) {
    throw new Error(`sendTripRefusal: ${reason} is internal-only and must not be sent to a client; map it to a non-revealing refusal at the route`);
  }
  sendError(res, code, message, { reason });
}
