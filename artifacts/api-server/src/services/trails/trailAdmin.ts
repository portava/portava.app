/**
 * trailAdmin — `11` §8's Trail merge, Trail archive and trend integrity review,
 * `02` §15's other moderation moves, and §6's edge review (census-discovery
 * §86, lane W10-T: DV-74, DC-04, DV-24).
 *
 * Every write is ONE call to a 3486 function that makes the change AND appends
 * its `discovery_admin_audit_events` row in one transaction (`11` §10 "admin
 * actions are audited", the same door §52's ledger actions use). The admin is
 * the actor; a reason is required; an idempotency key makes a retry a replay,
 * and a key reused for a different request is a conflict. The only caller is
 * routes/adminTrails.ts, behind lib/requireAdmin.ts.
 *
 * Without 3486 each action answers `unavailable` (503): nothing is changed
 * unaudited, and no fallback writes the tables directly.
 */
import { createHash } from "node:crypto";
import { logger as rootLogger } from "../../lib/logger.js";
import { trailTrending, servableMembers } from "./TrailService.js";
import { verifyAttachSources } from "./trailAttachIntegrity.js";

const logger = rootLogger.child({ mod: "trailAdmin" });

export type TrailAdminOutcome =
  | { ok: true; replayed: boolean; value: Record<string, unknown> }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/** A caller that sent no key gets one derived from the request, so a retried identical request is a replay. */
export function adminIdempotencyKey(action: string, actorId: string, request: Record<string, unknown>, supplied?: string | null): string {
  if (typeof supplied === "string" && supplied.trim().length > 0) return `client:${supplied.trim()}`;
  const stable = JSON.stringify(Object.keys(request).sort().map((k) => [k, request[k]]));
  return `derived:${action}:${createHash("sha256").update(`${actorId}|${stable}`).digest("hex").slice(0, 40)}`;
}

function isMissingFunction(error: any): boolean {
  const code = String(error?.code ?? "");
  return code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205";
}

async function callAdmin(sc: any, fn: string, args: Record<string, unknown>): Promise<TrailAdminOutcome> {
  if (!sc) return { ok: false, reason: "unavailable" };
  let res: { data: any; error: any };
  try {
    res = await sc.rpc(fn, args);
  } catch (err) {
    logger.warn({ fn, err: (err as Error)?.message }, "trail admin call threw");
    return { ok: false, reason: "db_error" };
  }
  if (res.error) {
    if (isMissingFunction(res.error)) return { ok: false, reason: "unavailable" };
    logger.warn({ fn, code: res.error?.code, message: res.error?.message }, "trail admin call failed");
    return { ok: false, reason: "db_error" };
  }
  const out = (res.data ?? {}) as Record<string, any>;
  const outcome = String(out.outcome ?? "");
  if (outcome === "refused") return { ok: false, reason: String(out.reason ?? "refused"), detail: out };
  if (outcome === "conflict") return { ok: false, reason: "idempotency_key_reused", detail: out };
  if (outcome === "replayed") return { ok: true, replayed: true, value: out };
  if (!outcome) return { ok: false, reason: "db_error" };
  return { ok: true, replayed: false, value: out };
}

export interface AdminActor { userId: string; reason: string; idempotencyKey: string }

/** §15 "mark stale", needs_update, reactivation, and `11` §8 "Trail archive" (`to: "archived"`). */
export function moveTrailLifecycleAsAdmin(sc: any, trailId: string, to: string, a: AdminActor): Promise<TrailAdminOutcome> {
  return callAdmin(sc, "trail_admin_move_lifecycle", {
    p_trail_id: trailId, p_to: to, p_actor: a.userId, p_reason: a.reason, p_idempotency_key: a.idempotencyKey,
  });
}

/** `11` §8 "Trail merge" (E-5, D-W10T-10): `fromId` is merged INTO `intoId` and archived. */
export function mergeTrailsAsAdmin(sc: any, fromId: string, intoId: string, a: AdminActor): Promise<TrailAdminOutcome> {
  return callAdmin(sc, "trail_admin_merge", {
    p_from: fromId, p_into: intoId, p_actor: a.userId, p_reason: a.reason, p_idempotency_key: a.idempotencyKey,
  });
}

/** DV-24: accept (navigable) or reject a declared relationship, or declare one outright. */
export function reviewTrailEdgeAsAdmin(
  sc: any, fromId: string, toId: string, edgeType: string, verdict: "accepted" | "rejected", a: AdminActor,
): Promise<TrailAdminOutcome> {
  return callAdmin(sc, "trail_admin_review_edge", {
    p_from: fromId, p_to: toId, p_edge_type: edgeType, p_verdict: verdict,
    p_actor: a.userId, p_reason: a.reason, p_idempotency_key: a.idempotencyKey,
  });
}

/**
 * `02` §5 "Portava-curated catalog" → Local Picks (DV-21, D-W10T-3): curate one
 * member. The content must exist and be PUBLIC — verified exactly as attach
 * verifies it, as an ANONYMOUS viewer (`verifyAttachSources` with no actor), so
 * moderation cannot curate what the product would not serve to everyone.
 */
export async function curateTrailContentAsAdmin(
  sc: any, trailId: string, label: { sourceType: string; sourceId: string; relationship: string; signal?: string | null }, a: AdminActor,
): Promise<TrailAdminOutcome> {
  if (!sc) return { ok: false, reason: "unavailable" };
  const verified = await verifyAttachSources(sc, [label], null, servableMembers);
  if (verified.unreadable) return { ok: false, reason: "source_unreadable" };
  if (verified.reasons[0] !== null) return { ok: false, reason: verified.reasons[0] === "unverifiable_source_type" ? "unverifiable_source_type" : "unknown_content" };
  return callAdmin(sc, "trail_admin_curate", {
    p_trail_id: trailId, p_source_type: label.sourceType, p_source_id: label.sourceId, p_relationship: label.relationship,
    p_signal: label.relationship === "signal" ? (label.signal ?? null) : null,
    p_actor: a.userId, p_reason: a.reason, p_idempotency_key: a.idempotencyKey,
  });
}

/** `11` §8 "trend integrity review": record a verdict, with the evidence the admin saw. */
export function recordTrendIntegrityReview(
  sc: any, subjectKind: "trail" | "place", subjectId: string, verdict: string, evidence: Record<string, unknown>, a: AdminActor,
): Promise<TrailAdminOutcome> {
  return callAdmin(sc, "trend_integrity_review_record", {
    p_subject_kind: subjectKind, p_subject_id: subjectId, p_verdict: verdict, p_evidence: evidence,
    p_actor: a.userId, p_reason: a.reason, p_idempotency_key: a.idempotencyKey,
  });
}

/**
 * The evidence a trend integrity review is taken on, for ONE Trail: its
 * momentum and per-item order as GET …/trending computes them (anonymous
 * viewer, so only what every viewer may be served), the review history, and
 * the verdict in force. `11` §4 permits raw numbers "for admin diagnostics";
 * this is the only place they leave the server, and only to an admin.
 */
export async function trailTrendEvidence(sc: any, trailId: string, nowMs = Date.now()): Promise<TrailAdminOutcome> {
  if (!sc) return { ok: false, reason: "unavailable" };
  const reading = await trailTrending(sc, trailId, nowMs, { viewerId: null, ignoreTrendReview: true });
  if (reading.refusal === "unknown_trail") return { ok: false, reason: "unknown_trail" };
  if (reading.refusal) return { ok: false, reason: reading.refusal === "trails_unavailable" ? "unavailable" : "db_error" };
  const { data, error } = await sc.from("trend_integrity_reviews")
    .select("id, verdict, reason, reviewed_by, evidence, created_at")
    .eq("subject_kind", "trail").eq("subject_id", trailId).order("created_at", { ascending: false }).limit(20);
  if (error && !["42P01", "PGRST205"].includes(String(error.code))) return { ok: false, reason: "db_error" };
  return {
    ok: true, replayed: false,
    value: {
      trailId,
      momentum: reading.momentum,
      momentumUnread: reading.momentumUnread === true,
      items: reading.items,
      readingProvenance: reading.momentumProvenance,
      reviews: (data ?? []) as unknown[],
    },
  };
}

/** The audit trail of one subject, newest first (`11` §8 alongside §52's ledger audit). */
export async function readTrailAdminAudit(sc: any, subjectId: string): Promise<TrailAdminOutcome> {
  if (!sc) return { ok: false, reason: "unavailable" };
  const { data, error } = await sc.from("discovery_admin_audit_events")
    .select("id, action, subject_kind, subject_id, related_id, actor_user_id, reason, detail, created_at")
    .eq("subject_id", subjectId).order("created_at", { ascending: false }).limit(200);
  if (error) return { ok: false, reason: ["42P01", "PGRST205"].includes(String(error.code)) ? "unavailable" : "db_error" };
  return { ok: true, replayed: false, value: { subjectId, events: data ?? [] } };
}
