/**
 * GET /api/telegraph/diagnostics — Telegraph §30A.17 internal support tooling.
 *
 * "Internal support tooling should expose delivery and projection diagnostics,
 * event IDs, conversation IDs, and authorized moderation context with
 * purpose-scoped access and audit logging rather than casual access to private
 * content."
 *
 * The census found the moderation half built and the delivery/projection half
 * absent — and it was worse than absent: the event bus already counted
 * everything it swallows (telegraphEmitterStats), and NOTHING read those
 * counters except a test. An operator answering "is realtime degraded?" had no
 * way to look.
 *
 * WHAT THIS EXPOSES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * Exposes: the §28 / §30A.17 SLO readings, the realtime emitter counters, and
 * the process's own uptime so a reader can tell a quiet hour from a restart.
 *
 * Does NOT expose, and this is the clause's real requirement: any message body,
 * any conversation id, any user id, any handle. The spec asks for tooling
 * "rather than casual access to private content", and the strongest way to
 * honour that is for the surface to have no private content to leak — every
 * number here is a count, a ratio or a duration. Diagnostics that could show a
 * conversation would be diagnostics somebody eventually browses.
 *
 * THREE GATES, ALL REQUIRED
 * -------------------------
 *   1. requireAdmin — the shared guard, fail-closed on a query error, a missing
 *      profile or a non-matching role. Not a local copy; thirty local copies is
 *      how one drifts weaker.
 *   2. PURPOSE-SCOPED. `X-Admin-Access-Reason` must be present and at least ten
 *      characters. Without it the request is refused. A purpose field that
 *      accepted "" or "debug" would be a field, not a scope.
 *   3. AUDIT. Every served request emits a structured audit line naming the
 *      admin, the purpose and what was read.
 *
 * THE CEILING, STATED: the audit is a LOG LINE, not a durable row. The existing
 * `admin_access_log` table constrains `record_type` to five values, none of
 * which is this, so writing there would mean either a migration no database has
 * or mislabelling a diagnostics read as a profile read. A log line that says
 * what happened is better than a row that says something untrue, and it is less
 * than the clause asks for. Both halves of that are recorded here rather than
 * one.
 *
 * MOVED 2026-10-05 (lane T2, census T435): migration 3761 adds
 * 'telegraph_diagnostics' to that CHECK, behind
 * telegraph_diagnostics_durable_audit_enabled (seeded FALSE). With it on, the
 * audit is a durable admin_access_log row written BEFORE anything is served,
 * and a row that cannot be written refuses the read. With it off — and on every
 * database that does not have 3761 — the log line above is still the audit.
 */

import { Router, type IRouter } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";

import { requireAdmin } from "../lib/requireAdmin.js";
import { accessReason } from "../lib/adminAudit.js";
import { logger as rootLogger } from "../lib/logger.js";
import { telegraphEmitterStats } from "../lib/telegraphEvents.js";
import { telegraphSloSnapshot } from "../domain/telegraph/services/telegraphObservability.js";
import { TELEGRAPH_PROJECTIONS } from "../domain/telegraph/projections/projectionRegistry.js";
import { BOOT_HRTIME } from "../lib/bootTime.js";
import { isFlagEnabled } from "../lib/featureFlags.js";

/**
 * census T435 — the durable half of gate 3, behind migration 3761. ON: the read
 * is served only after its admin_access_log row is written; a row that cannot
 * be written refuses the read. OFF (the seed): the log line below, as before.
 */
export const DIAGNOSTICS_DURABLE_AUDIT_FLAG = "telegraph_diagnostics_durable_audit_enabled";

const log = rootLogger.child({ route: "telegraphDiagnostics" });

const router: IRouter = Router();

/** Minimum length for a stated purpose. Short enough to be usable, long enough to be a sentence. */
const MIN_PURPOSE_LENGTH = 10;

router.get("/telegraph/diagnostics", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return; // requireAdmin has already sent 401/403

  const purpose = accessReason(req as any);
  if (!purpose || purpose.trim().length < MIN_PURPOSE_LENGTH) {
    res.status(400).json({
      error: "invalid_payload",
      message:
        `Purpose-scoped access: send an X-Admin-Access-Reason header of at least ` +
        `${MIN_PURPOSE_LENGTH} characters stating why these diagnostics are being read.`,
    });
    return;
  }

  // census T435: with 3761 applied and its flag on, the audit is a DURABLE row,
  // written before anything is served. An unaudited read of the support
  // tooling is what §30A.17 rules out, so a row that cannot be written refuses
  // the read rather than serving it with only a log line.
  if (await isFlagEnabled(ctx.sc, DIAGNOSTICS_DURABLE_AUDIT_FLAG)) {
    const { error: auditErr } = await ctx.sc.from("admin_access_log").insert({
      admin_id: ctx.userId,
      record_type: "telegraph_diagnostics",
      record_id: "snapshot",
      reason: purpose,
      action_taken: "view",
      timestamp: new Date().toISOString(),
    });
    if (auditErr) {
      log.error({ err: auditErr, adminId: ctx.userId }, "telegraph diagnostics: durable audit row NOT written — read refused");
      res.status(503).json({
        error: "degraded_unavailable",
        message: "This access could not be recorded in the audit trail, so the diagnostics were not served. Please try again.",
      });
      return;
    }
  }

  const emitter = telegraphEmitterStats();
  const slos = telegraphSloSnapshot(emitter as unknown as Record<string, number>);

  // The audit line. Never blocks the response and never carries content.
  log.info(
    {
      audit: "telegraph_diagnostics_read",
      adminId: ctx.userId,
      purpose,
      sloCount: slos.length,
    },
    "telegraph diagnostics served under a stated purpose",
  );

  const uptimeMs = Number(process.hrtime.bigint() - BOOT_HRTIME) / 1e6;

  res.status(200).json({
    // So a reader can tell "nothing is happening" from "this process started
    // ninety seconds ago", which are the two readings a fresh counter set is
    // ambiguous between.
    processUptimeMs: Math.round(uptimeMs),
    counterScope:
      "in-process, per-instance, reset on restart — not a telemetry sink, and not aggregated across instances",
    slos,
    realtimeEmitter: emitter,
    projections: TELEGRAPH_PROJECTIONS.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      builtBy: p.builtBy,
      censusRow: p.censusRow,
    })),
  });
}));

export default router;
