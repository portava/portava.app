/**
 * Trail review before a Trail is visible — lead ruling D-66 (2026-10-06),
 * census-discovery §122:
 *
 *   "A newly started Trail is visible only to its creator. Until an admin
 *    approves it, it is not ranked, surfaced, linked or shared. A rejected
 *    Trail stays private to its creator and shows the reason. The
 *    3-per-person-per-day allowance (migration 3975) stays in force. Trail
 *    creation stays behind its feature flag, seeded false."
 *
 * The VISIBILITY rule lives with the readers (TrailService.trailIsPublic /
 * trailVisibleTo, applied by readTrail and every list), and in the database for
 * clients (3977's restrictive policies). This module holds the three things the
 * review itself needs:
 *   - the creator's own Trails with their review state and reason;
 *   - the admin queue of pending Trails;
 *   - the decision, through 3977's trail_review_decide (row-locked, pending
 *     only, a rejection needs a reason, approval also activates a `proposed`
 *     lifecycle).
 *
 * Every read binds its error: a queue or a list that could not be read is a
 * refusal, never an empty queue.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { trailIsPublic, type TrailRow } from "./TrailService.js";

export const TRAIL_CREATION_FLAG = "trail_creation_enabled";

/** Read with the review columns; kept here so the queue and the creator list cannot drift. */
const REVIEW_COLUMNS =
  "id, slug, title, description, destination, place_scope, parent_trail_id, lifecycle_status, created_by, created_at, updated_at, review_state, review_reason";

export type ReviewReadRefusal = "unavailable" | "db_error" | "no_service_client";

function readRefusal(error: any): ReviewReadRefusal {
  const code = String(error?.code ?? "");
  // 2910 or 3977 not applied: the review cannot be read — never "nothing pending".
  if (["42P01", "PGRST205", "42703", "PGRST204"].includes(code)) return "unavailable";
  return "db_error";
}

/** Is starting a Trail switched on? An unreadable flag is OFF (isFlagEnabled fails closed). */
export async function trailCreationEnabled(sc: any): Promise<boolean> {
  if (!sc) return false;
  return isFlagEnabled(sc, TRAIL_CREATION_FLAG);
}

/** The creator's own Trails, newest first, with each one's review state and (if rejected) reason. */
export async function listOwnTrails(
  sc: any, userId: string, limit = 50,
): Promise<{ refusal: ReviewReadRefusal | null; trails: TrailRow[] }> {
  if (!sc) return { refusal: "no_service_client", trails: [] };
  const { data, error } = await sc.from("trails").select(REVIEW_COLUMNS)
    .eq("created_by", userId).neq("lifecycle_status", "archived")
    .order("created_at", { ascending: false }).limit(Math.min(50, Math.max(1, limit)));
  if (error) return { refusal: readRefusal(error), trails: [] };
  return { refusal: null, trails: (data ?? []) as TrailRow[] };
}

/** The admin queue: pending Trails, oldest first. */
export async function listPendingTrailReviews(
  sc: any, limit = 50,
): Promise<{ refusal: ReviewReadRefusal | null; trails: TrailRow[] }> {
  if (!sc) return { refusal: "no_service_client", trails: [] };
  const { data, error } = await sc.from("trails").select(REVIEW_COLUMNS)
    .eq("review_state", "pending").neq("lifecycle_status", "archived")
    .order("created_at", { ascending: true }).limit(Math.min(100, Math.max(1, limit)));
  if (error) return { refusal: readRefusal(error), trails: [] };
  return { refusal: null, trails: (data ?? []) as TrailRow[] };
}

export type TrailReviewDecision = "approve" | "reject";

export type TrailReviewOutcome =
  | { ok: true; trail: { id: string; reviewState: string; reviewReason: string | null; lifecycle: string } }
  | { ok: false; reason: "unknown_trail" | "not_pending" | "invalid" | "unavailable" | "db_error" | "no_service_client"; detail?: string };

/** The one decision writer. The caller is an admin (routes/adminTrails.ts runs requireAdmin first). */
export async function decideTrailReview(
  sc: any, trailId: string, adminId: string, decision: TrailReviewDecision, reason: string | null,
): Promise<TrailReviewOutcome> {
  if (!sc) return { ok: false, reason: "no_service_client" };
  if (decision === "reject" && !(typeof reason === "string" && reason.trim().length > 0)) {
    return { ok: false, reason: "invalid", detail: "a rejection needs a reason" };
  }
  const { data, error } = await sc.rpc("trail_review_decide", {
    p_trail_id: trailId, p_admin_id: adminId, p_decision: decision, p_reason: reason,
  });
  if (error) {
    const code = String(error?.code ?? "");
    if (["42883", "PGRST202", "42703", "42P01"].includes(code)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "db_error", detail: String(error?.message ?? "") };
  }
  const o = (data ?? {}) as Record<string, any>;
  if (o.outcome === "decided" && o.trail && typeof o.trail === "object") {
    return {
      ok: true,
      trail: {
        id: String(o.trail.id), reviewState: String(o.trail.review_state),
        reviewReason: typeof o.trail.review_reason === "string" ? o.trail.review_reason : null,
        lifecycle: String(o.trail.lifecycle_status),
      },
    };
  }
  if (o.outcome === "unknown_trail") return { ok: false, reason: "unknown_trail" };
  if (o.outcome === "not_pending") return { ok: false, reason: "not_pending", detail: String(o.review_state ?? "") };
  if (o.outcome === "invalid") return { ok: false, reason: "invalid", detail: String(o.detail ?? "") };
  // An answer this module does not know is not a decision.
  return { ok: false, reason: "db_error", detail: "unrecognised trail_review_decide answer" };
}

/**
 * The 409 a proposal refusal returns names the Trails it conflicts with. A
 * pending or rejected Trail of SOMEONE ELSE must not be named (D-66: visible to
 * its creator only): such ids are replaced by null, so the proposer learns that
 * a conflict exists but not which Trail. An unreadable lookup nulls them all.
 */
export async function maskUnseenTrailIds(
  sc: any, ids: ReadonlyArray<string | null>, viewerId: string,
): Promise<Map<string, string | null>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  const out = new Map<string, string | null>(want.map((id) => [id, null]));
  if (want.length === 0 || !sc) return out;
  const { data, error } = await sc.from("trails").select("id, review_state, created_by").in("id", want);
  if (error || !Array.isArray(data)) return out;
  for (const r of data as Array<{ id: string; review_state?: unknown; created_by?: unknown }>) {
    if (trailIsPublic(r) || r.created_by === viewerId) out.set(String(r.id), String(r.id));
  }
  return out;
}
