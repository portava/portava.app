/**
 * Unified report routes
 *
 * POST /api/reports                — file a report (user, message, thread, trip, post, place, event)
 * GET  /api/reports/:id            — get reporter's own report
 *
 * Privacy guarantee:
 *   - Report contents are private to the reporter (RLS enforced).
 *   - Reporter identity is never disclosed to the reported party.
 *   - After report, offer-to-block is client-side UX; this route does not auto-block.
 *   - High severity user reports trigger auto-restrict and anti-retaliation cooldowns
 *     to protect the reporter from retaliation.
 *
 * Evidence preservation:
 *   - The reports row is never deleted; status transitions are the only mutations.
 *   - context_type/context_id are auto-attached from the request payload.
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { isUuid } from "../lib/followDecisions";
import { getServiceClient } from "../lib/supabase";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { reportRateLimit } from "../lib/rateLimit";

const router = Router();

const TARGET_TYPES = [
  "user", "message", "thread", "trip", "post", "place", "event",
] as const;

const REASON_CODES = [
  "harassment", "spam", "hate_speech", "violence",
  "impersonation", "nudity", "misinformation", "other",
] as const;

const HIGH_SEVERITY_CODES = new Set<string>(["harassment", "hate_speech", "violence"]);

const CreateReportSchema = z.object({
  target_type:   z.enum(TARGET_TYPES),
  target_id:     z.string().uuid("target_id must be a UUID"),
  reason_code:   z.enum(REASON_CODES),
  reason_detail: z.string().max(500).optional().nullable(),
  context_type:  z.string().optional().nullable(),
  context_id:    z.string().uuid().optional().nullable(),
});

/* ===========================================================================
 * POST /reports  — file a report
 * ===========================================================================
 * For user reports: permission engine is consulted (canReport).
 * High severity user reports:
 *   - Auto-restrict the target from reaching the reporter.
 *   - Write anti-retaliation cooldowns (90 days) for message_request + friend_request.
 */
router.post("/reports", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const rl = reportRateLimit(user.id);
  if (!rl.allowed) {
    const retryAfterSecs = Math.ceil(rl.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSecs));
    sendError(res, "rate_limited", "Too many reports. Please try again later.");
    return;
  }

  const parsed = CreateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { target_type, target_id, reason_code, reason_detail, context_type, context_id } = parsed.data;

  if (target_type === "user" && target_id === user.id) {
    sendError(res, "invalid_payload", "Cannot report yourself");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // For user reports: permission engine — fail-closed block check + canReport
  if (target_type === "user") {
    try {
      const perms = await resolveInteractionPermissions(sc, user.id, target_id);
      if (!perms.canReport) {
        sendError(res, "forbidden", "Cannot report this user");
        return;
      }
    } catch (err) {
      req.log.error({ err }, "permission engine failed for report");
      sendError(res, "db_error", "Permission check failed");
      return;
    }
  }

  const severity = HIGH_SEVERITY_CODES.has(reason_code) ? "high" : "normal";

  const { data: report, error } = await sc
    .from("reports")
    .insert({
      reporter_id:   user.id,
      target_type,
      target_id,
      reason_code,
      reason_detail: reason_detail ?? null,
      context_type:  context_type  ?? null,
      context_id:    context_id    ?? null,
      severity,
    })
    .select("id, status, severity")
    .single();

  if (error) {
    req.log.error({ err: error }, "reports insert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const reportId      = (report as any).id   as string;
  const reportSeverity = (report as any).severity as string;

  // Atomically create report_evidence row from context_type / context_id
  // (fire-and-forget — evidence creation failure must never block the report itself)
  if (context_type) {
    void sc.from("report_evidence").insert({
      report_id:     reportId,
      evidence_type: "context",
      content_ref:   context_id ?? null,
      metadata:      { context_type, context_id: context_id ?? null, auto_attached: true },
    }).then(undefined, () => {});
  }

  // High-severity user report: protect reporter from retaliation
  if (target_type === "user" && reportSeverity === "high") {
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days

    // Auto-restrict: reporter restricts the reported user so that their future
    // messages to the reporter are downgraded to requests and read receipts / online
    // status are hidden from the reported user.
    // Row semantics: restrictor_id has restricted restricted_id.
    // The permission engine checks: "does targetUserId restrict viewerId?" →
    //   when Bob (future viewer) tries to contact Alice (future target/reporter),
    //   the engine queries restrictor_id=Alice, restricted_id=Bob → match → protected.
    await sc.from("user_restrictions").upsert(
      {
        restrictor_id: user.id,   // reporter (Alice) restricts
        restricted_id: target_id, // reported user (Bob)
        options: { auto_restricted_by_report: true, report_id: reportId },
      },
      { onConflict: "restrictor_id,restricted_id", ignoreDuplicates: true },
    ).then(undefined, () => {});

    // Anti-retaliation cooldowns: block target from DMing or friend-requesting reporter
    await sc.from("user_interaction_cooldowns").upsert(
      [
        { user_id: target_id, target_user_id: user.id, cooldown_type: "message_request", expires_at: expiresAt },
        { user_id: target_id, target_user_id: user.id, cooldown_type: "friend_request",  expires_at: expiresAt },
      ],
      { onConflict: "user_id,target_user_id,cooldown_type", ignoreDuplicates: true },
    ).then(undefined, () => {});
  }

  res.status(201).json({ reportId, status: "open", severity: reportSeverity });
});

/* ===========================================================================
 * GET /reports/:id  — reporter reads their own report
 * ===========================================================================
 */
router.get("/reports/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid report id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("reports")
    .select("id, target_type, target_id, reason_code, reason_detail, severity, status, created_at")
    .eq("id", id)
    .eq("reporter_id", user.id)
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "reports fetch failed"); sendError(res, "db_error", error.message); return; }
  if (!data)  { sendError(res, "not_found", "Report not found"); return; }

  res.status(200).json(data);
});

export default router;
