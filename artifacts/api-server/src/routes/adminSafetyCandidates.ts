/**
 * Safety candidates — Sensing §16: world-intelligence evidence / anomaly →
 * SAFETY CANDIDATE → the EXISTING safety review → the canonical assertion.
 * These are the first two stages, feeding the third; the last two are the
 * specialists' and are not touched.
 *
 * POST /api/admin/intel/safety-candidates/scan
 *   Body { subjectIds? } — the places to look at (≤ 50), or, absent, the
 *   bounded sweep of every place whose current crowd.level is served as
 *   `packed`. For each: the current claims through lib/liveClaimRead (the
 *   one gated path), the previous readings from the projection's own record,
 *   lib/safetyCandidate's three anomaly shapes, and each candidate not
 *   already before a reviewer is FILED as a `moderation_reports` row —
 *   subject_type `place`, category `safety_concern`, no reporter — into the
 *   queue GET /admin/moderation/reports already serves (routes/admin.ts).
 *   Answers a per-subject report: detected, filed, already open, refusal.
 *   It asserts nothing: no snapshot is written, no notice is projected.
 *
 * GET /api/admin/intel/safety-candidates
 *   The detector's own rows still open or reviewing, newest first, parsed.
 *
 * Gated by `intel_safety_candidates_enabled` (migration 2803, seeded
 * FALSE), read fail-closed, and by requireAdmin: an operator-triggered
 * stage, because wiring a scheduler is a line in src/index.ts this lane
 * does not edit (census-sensing §5.4). Nothing person-shaped is on the wire.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { liveLabelsServable, readLiveClaimEnvelopes } from "../lib/liveClaimRead.js";
import { readPreviousReadings } from "../lib/wallMomentRead.js";
import { SAFETY_CANDIDATE_CLAIM_TYPES, detectSafetyCandidates, type SafetyCandidateReason } from "../lib/safetyCandidate.js";
import { fileCandidateReport, listOpenCandidates, listSweepSubjects, openCandidateReasons } from "../lib/safetyCandidateStore.js";

const router = Router();

/** Literal name so check-flag-polarity resolves the reads. `*_enabled` ⇒ capability, fail-closed. */
export const SAFETY_CANDIDATES_FLAG = "intel_safety_candidates_enabled";
export const SCAN_MAX_SUBJECTS = 50;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

const scanSchema = z.object({
  subjectIds: z.array(z.string().uuid()).min(1).max(SCAN_MAX_SUBJECTS).optional(),
});

export interface ScanSubjectReport {
  subjectId: string;
  detected: SafetyCandidateReason[];
  filed: Array<{ reason: SafetyCandidateReason; reportId: string }>;
  alreadyOpen: SafetyCandidateReason[];
  /** Null when the subject was read; otherwise why it could not be, so "no candidate" is never ambiguous. */
  refusal: "versions_unavailable" | "queue_unreadable" | "queue_write_failed" | "error" | null;
}

router.post(
  "/admin/intel/safety-candidates/scan",
  asyncHandler(async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "intel_safety_candidates_enabled"))) {
      sendError(res, "feature_disabled", "Safety candidates are not enabled");
      return;
    }
    const parsed = scanSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const now = new Date();
    const nowMs = now.getTime();
    if (!(await liveLabelsServable(sc))) {
      res.status(200).json({ ok: false, refusal: "live_intelligence_unavailable", generatedAt: now.toISOString() });
      return;
    }
    let subjectIds = parsed.data.subjectIds ?? null;
    let sweep = false;
    if (!subjectIds) {
      const s = await listSweepSubjects(sc, nowMs);
      if (!s.ok) {
        res.status(200).json({ ok: false, refusal: "sweep_unreadable", generatedAt: now.toISOString() });
        return;
      }
      subjectIds = s.subjectIds;
      sweep = true;
    }

    const subjects: ScanSubjectReport[] = [];
    for (const subjectId of subjectIds) {
      const report: ScanSubjectReport = { subjectId, detected: [], filed: [], alreadyOpen: [], refusal: null };
      subjects.push(report);
      const current = await readLiveClaimEnvelopes(sc, subjectId, { claimTypes: SAFETY_CANDIDATE_CLAIM_TYPES, now });
      if (current.length === 0) continue;
      const previous = await readPreviousReadings(sc, subjectId, ["crowd.level"]);
      if (!previous.ok) {
        report.refusal = previous.reason === "no_client" ? "error" : previous.reason;
        continue;
      }
      const candidates = detectSafetyCandidates(subjectId, current, previous.readings, nowMs);
      report.detected = candidates.map((c) => c.reason);
      if (candidates.length === 0) continue;
      const open = await openCandidateReasons(sc, subjectId);
      if (!open.ok) {
        report.refusal = "queue_unreadable";
        continue;
      }
      for (const c of candidates) {
        if (open.reasons.has(c.reason)) {
          report.alreadyOpen.push(c.reason);
          continue;
        }
        const filed = await fileCandidateReport(sc, c);
        if (!filed.ok) {
          report.refusal = "queue_write_failed";
          break;
        }
        report.filed.push({ reason: c.reason, reportId: filed.reportId });
      }
    }

    res.status(200).json({
      ok: true,
      sweep,
      subjects,
      filed: subjects.reduce((n, s) => n + s.filed.length, 0),
      generatedAt: now.toISOString(),
    });
  }),
);

router.get(
  "/admin/intel/safety-candidates",
  asyncHandler(async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "intel_safety_candidates_enabled"))) {
      sendError(res, "feature_disabled", "Safety candidates are not enabled");
      return;
    }
    const limitRaw = Number(req.query.limit ?? LIST_DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
    const listed = await listOpenCandidates(sc, limit);
    if (!listed.ok) {
      sendError(res, "db_error", "Could not read the review queue");
      return;
    }
    res.status(200).json({ ok: true, candidates: listed.candidates, generatedAt: new Date().toISOString() });
  }),
);

export default router;
