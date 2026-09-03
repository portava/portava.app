/**
 * MediaViewRequestService — Media v2 Phase 10 (§19) Request-a-View.
 *
 * A viewer requests a CURRENT perspective of a place ("show what's happening" /
 * "is the entrance still busy?"). This service is the human-network FRONT of the
 * EXISTING intel mission/coverage machinery: it CONSUMES intel_mission_candidates
 * (2167) + buildMissionCandidate (lib/missionGeneration) to create a NON-CASH
 * targeted coverage task, and it does NOT fork a parallel mission system, touch
 * the intel dispatch gating (intel_missions), or change any existing behaviour.
 *
 * A request is a PROMPT for a fresh observation, never a demand. Every one of the
 * four required controls fails CLOSED:
 *
 *   1. FLAG GATE      media_request_a_view_enabled off / unreadable ⇒ refuse.
 *   2. THROTTLE       per-viewer AND per-place fixed windows (lib/rateLimit);
 *      + DEDUPE       a near-duplicate OPEN request for the same (place, family)
 *                     is refused.
 *   3. SAFETY         a place hosting a restrictive Hidden Gem / protected
 *                     location is refused, and an UNDETERMINED gem lookup is
 *                     refused (never guess).
 *   4. OPT-IN ONLY    only opted-in + eligible + un-blocked contributors are
 *                     selected as recipients; block state that cannot be read
 *                     ⇒ ask nobody.
 *
 * Pre-launch empty (no eligible contributors, no coverage) is normal: the
 * request is still recorded with recipient_count 0 — a graceful, non-erroring
 * outcome.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { fetchBlockedSet } from "../../lib/blocks.js";
import { buildMissionCandidate } from "../../lib/missionGeneration.js";
import {
  loadRestrictiveGems,
  gemCeilingForItem,
} from "../../lib/mediaLocationVisibility.js";
import {
  selectEligibleRecipients,
  isDuplicateOpenRequest,
  requestSafetyDecision,
  VIEW_REQUEST_PER_VIEWER_LIMIT,
  VIEW_REQUEST_PER_PLACE_LIMIT,
  VIEW_REQUEST_WINDOW_MS,
  type ContributorOptIn,
  type OpenRequestRow,
} from "../../lib/mediaViewRequest.js";

export const REQUEST_A_VIEW_FLAG = "media_request_a_view_enabled";

const VIEWER_LIMITER = "media_view_request_viewer";
const PLACE_LIMITER = "media_view_request_place";

export interface CreateViewRequestInput {
  requesterId: string;
  subjectId: string;          // canonical places.id
  claimFamily: string;        // e.g. "crowd.level"
  question: string;           // e.g. "Is the entrance still busy?"
  city?: string | null;
  zoneId?: string | null;
  /** Optional coordinate of the target, used only for gem-proximity safety. */
  lat?: number | null;
  lng?: number | null;
  /** Coverage-gap score (0..1) that motivated the request; default mid. */
  coverageScore?: number | null;
}

export type ViewRequestRefusal =
  | "disabled"
  | "rate_limited"
  | "duplicate"
  | "protected_location"
  | "safety_undetermined";

export interface CreateViewRequestResult {
  ok: boolean;
  reason?: ViewRequestRefusal | "db_error";
  /** The media_view_requests ledger row id (on success). */
  requestId?: string;
  /** The intel_mission_candidates row this request created (on success). */
  missionCandidateId?: string;
  /** How many opted-in + eligible + un-blocked contributors were asked. */
  recipientCount?: number;
  /** The recipient ids (never contains a non-opted-in / blocked contributor). */
  recipients?: string[];
}

/**
 * Create a Request-a-View. Returns a structured refusal (never throws for a
 * gate) so the route can map it to an HTTP status.
 */
export async function createViewRequest(
  sc: any,
  input: CreateViewRequestInput,
): Promise<CreateViewRequestResult> {
  // ── 1. Flag gate (fail-closed) ──────────────────────────────────────────────
  if (!(await isFlagEnabled(sc, REQUEST_A_VIEW_FLAG))) {
    return { ok: false, reason: "disabled" };
  }

  // ── 2a. Throttle: per-viewer, then per-place ───────────────────────────────
  const viewerGate = checkRateLimit(
    VIEWER_LIMITER,
    input.requesterId,
    VIEW_REQUEST_PER_VIEWER_LIMIT,
    VIEW_REQUEST_WINDOW_MS,
  );
  if (!viewerGate.allowed) return { ok: false, reason: "rate_limited" };

  const placeGate = checkRateLimit(
    PLACE_LIMITER,
    input.subjectId,
    VIEW_REQUEST_PER_PLACE_LIMIT,
    VIEW_REQUEST_WINDOW_MS,
  );
  if (!placeGate.allowed) return { ok: false, reason: "rate_limited" };

  // ── 2b. Safety: refuse a request that would pinpoint a protected place ──────
  // Fail-closed: an unreadable gem cross-check is UNDETERMINED ⇒ refuse.
  let gemCeiling: string | null = null;
  let gemDetermined = false;
  try {
    const gems = await loadRestrictiveGems(sc, {
      placeIds: [input.subjectId],
      cities: input.city ? [input.city] : [],
    });
    gemCeiling = gemCeilingForItem(gems, {
      placeId: input.subjectId,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
    });
    gemDetermined = true;
  } catch {
    gemDetermined = false; // fail-closed
  }
  const safety = requestSafetyDecision({ gemCeiling, gemDetermined });
  if (!safety.safe) {
    return {
      ok: false,
      reason: safety.reason === "protected_location" ? "protected_location" : "safety_undetermined",
    };
  }

  // ── 2c. Dedupe near-duplicate open requests ────────────────────────────────
  const openRows = await readOpenRequests(sc, input.subjectId, input.claimFamily);
  if (isDuplicateOpenRequest(openRows, { subjectId: input.subjectId, claimFamily: input.claimFamily })) {
    return { ok: false, reason: "duplicate" };
  }

  // ── 3. OPT-IN-ONLY recipient selection (fail-closed on block read) ─────────
  const candidates = await readOptedInContributors(sc, input.city ?? null);
  const blocked = await fetchBlockedSet(sc, input.requesterId); // null ⇒ ask nobody
  const recipients = selectEligibleRecipients({
    candidates,
    requesterId: input.requesterId,
    blocked,
  });

  // ── 4. Create the NON-CASH coverage task in the EXISTING mission store ─────
  const candidate = buildMissionCandidate({
    city: input.city ?? "",
    zoneId: input.zoneId ?? null,
    claimFamily: input.claimFamily,
    trigger: "request_a_view",
    coverageScore: clampScore(input.coverageScore),
    question: input.question,
    budgetUnits: 0, // non-cash, and no budget committed for a viewer prompt
  });

  const missionRow = {
    city: candidate.city,
    zone_id: candidate.zoneId,
    subject_id: input.subjectId,
    claim_family: candidate.claimFamily,
    trigger: candidate.trigger,
    coverage_score: candidate.coverageScore,
    question: candidate.question,
    budget_units: candidate.budgetUnits,
    budget_committed: candidate.budgetCommitted, // false
    cash_amount: candidate.cashAmount,           // 0
    status: candidate.status,                    // 'candidate'
  };
  const missionRes = await sc.from("intel_mission_candidates").insert(missionRow).select().single();
  if (missionRes.error) return { ok: false, reason: "db_error" };
  const missionCandidateId = (missionRes.data as any)?.id as string | undefined;

  // ── Record the request in the media-owned ledger (throttle/dedupe/audit) ───
  const ledgerRow = {
    requester_id: input.requesterId,
    subject_id: input.subjectId,
    claim_family: input.claimFamily,
    city: input.city ?? null,
    zone_id: input.zoneId ?? null,
    question: input.question,
    mission_candidate_id: missionCandidateId ?? null,
    status: "open",
    recipient_count: recipients.length,
  };
  const ledgerRes = await sc.from("media_view_requests").insert(ledgerRow).select().single();
  if (ledgerRes.error) return { ok: false, reason: "db_error" };

  return {
    ok: true,
    requestId: (ledgerRes.data as any)?.id as string | undefined,
    missionCandidateId,
    recipientCount: recipients.length,
    recipients,
  };
}

// ── DB read seams (small, so tests only mock what is used) ─────────────────────

async function readOpenRequests(sc: any, subjectId: string, claimFamily: string): Promise<OpenRequestRow[]> {
  try {
    const { data, error } = await sc
      .from("media_view_requests")
      .select("subject_id, claim_family, status")
      .eq("subject_id", subjectId)
      .eq("status", "open")
      .limit(200);
    if (error || !data) return [];
    return (data as any[]).map((r) => ({
      subjectId: r.subject_id,
      claimFamily: r.claim_family,
      status: r.status,
    }));
  } catch {
    return [];
  }
}

/**
 * Load opted-in contributors, scoped to the request's city when given.
 * We select rows already filtered to opted_in AND eligible at the DB, but the
 * pure selector re-checks both (defence in depth: the truth gate is the pure
 * function, not the query).
 */
async function readOptedInContributors(sc: any, city: string | null): Promise<ContributorOptIn[]> {
  try {
    let q = sc
      .from("media_view_request_optins")
      .select("contributor_id, opted_in, eligible, city")
      .eq("opted_in", true)
      .eq("eligible", true)
      .limit(1000);
    if (city) q = q.eq("city", city);
    const { data, error } = await q;
    if (error || !data) return [];
    return (data as any[]).map((r) => ({
      contributorId: r.contributor_id,
      optedIn: r.opted_in === true,
      eligible: r.eligible === true,
    }));
  } catch {
    return [];
  }
}

const clampScore = (s: number | null | undefined): number => {
  if (typeof s !== "number" || !Number.isFinite(s)) return 0.5;
  return s < 0 ? 0 : s > 1 ? 1 : s;
};

/**
 * Upsert the caller's OWN opt-in choice. `eligible` is deliberately NOT settable
 * here — a contributor can opt in, but eligibility is service-owned. When the
 * row is created by an opt-in, eligible stays at its column default (false)
 * until a trusted path sets it.
 */
export async function setContributorOptIn(
  sc: any,
  contributorId: string,
  optedIn: boolean,
  city: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const row = {
    contributor_id: contributorId,
    opted_in: optedIn === true,
    city: city ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sc
    .from("media_view_request_optins")
    .upsert(row, { onConflict: "contributor_id" });
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  return { ok: true };
}
