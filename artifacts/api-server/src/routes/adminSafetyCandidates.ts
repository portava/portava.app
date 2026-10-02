/**
 * Safety candidates — Sensing §16: world-intelligence evidence / anomaly →
 * SAFETY CANDIDATE → the EXISTING safety review → the canonical assertion.
 * The first two stages detect and file; the third — the authorized decision —
 * is now here too, because it is the same operators acting on the same
 * subjects behind the same guard. The fourth, what the Map then serves, is the
 * producers' and is not touched.
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
 * Both of the above are gated by `intel_safety_candidates_enabled` (migration
 * 2803, seeded FALSE), read fail-closed, and by requireAdmin: an operator-
 * triggered stage, because wiring a scheduler is a line in src/index.ts this
 * lane does not edit (census-sensing §5.4). Nothing person-shaped is on the
 * wire.
 *
 * POST /api/admin/intel/safety-review
 *   Body { claimId, action, reason? } — the authorized decision itself,
 *   delegated to services/intel/SafetyReviewService.reviewSafetyClaim, which
 *   re-checks the capability, refuses any transition safety does not permit,
 *   asks safetyPolicy before publishing, compare-and-sets the claim, and
 *   records the decision in `intel_claim_reviews` (migration 2311).
 *
 *   THE REVIEWER IS THE AUTHENTICATED PRINCIPAL. `reviewerId` is taken from
 *   requireAdmin's resolved context and is not readable from the body — a
 *   caller that could name the reviewer could forge the whole audit trail,
 *   which is the one thing this table exists to prevent.
 *
 *   NOT BEHIND 2803's FLAG, deliberately. That flag's own migration scopes it
 *   to the candidate stage's two routes, and its description enumerates them;
 *   gating a different stage on it would make the flag's stated meaning false
 *   and would tie the ability to RETRACT a live hazard to whether detection is
 *   switched on. The gate here is the capability, enforced twice: by
 *   requireAdmin at the door with SAFETY_REVIEWER_ROLES, and again inside the
 *   service, which is the authority on who may review.
 *
 *   NOT IntelCaptureService.approveClaim, which stays untouched: it consults no
 *   safety policy and its provenance is the literal 'admin' rather than an
 *   identity. See SafetyReviewService's header.
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
import {
  PERMITTED_TRANSITIONS,
  SAFETY_REVIEWER_ROLES,
  reviewSafetyClaim,
  type SafetyReviewAction,
  type SafetyReviewRefusal,
} from "../services/intel/SafetyReviewService.js";

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

// ── The review itself ─────────────────────────────────────────────────────────

/**
 * The actions the route accepts, DERIVED from the service's transition table
 * rather than restated. Restating them is how a route and a domain drift: the
 * table is the authority on what safety permits, so an action it does not name
 * cannot be spelled here by accident, and one it gains does not need a second
 * edit to become reachable.
 */
export const SAFETY_REVIEW_ACTIONS = Object.keys(PERMITTED_TRANSITIONS) as SafetyReviewAction[];

/** Free-text moderation reason. Bounded, and never projected — see 2311. */
export const REVIEW_REASON_MAX = 2000;

const reviewSchema = z.object({
  claimId: z.string().uuid(),
  action: z.enum(SAFETY_REVIEW_ACTIONS as [SafetyReviewAction, ...SafetyReviewAction[]]),
  reason: z.string().trim().min(1).max(REVIEW_REASON_MAX).optional(),
});

/**
 * One API code per refusal, so the wire never collapses two different answers.
 *
 * The service's whole failure contract is that "not authorized", "no such
 * claim", "the policy refused it" and "the database could not be read" are
 * different facts. Mapping several of them onto one status would rebuild
 * exactly the ambiguity it was written to remove — an operator could not tell a
 * hazard that may not be published from a hazard nobody could look up.
 */
const REFUSAL_STATUS: Record<SafetyReviewRefusal, "forbidden" | "not_found" | "invalid_payload" | "invalid_state_transition" | "review_not_eligible" | "conflict" | "db_error"> = {
  not_authorized:           "forbidden",
  claim_not_found:          "not_found",
  not_a_safety_claim:       "invalid_payload",
  transition_not_permitted: "invalid_state_transition",
  policy_refused:           "review_not_eligible",
  conflict:                 "conflict",
  db_error:                 "db_error",
};

router.post(
  "/admin/intel/safety-review",
  asyncHandler(async (req, res) => {
    // The door. SAFETY_REVIEWER_ROLES is the service's own capability list, so
    // the gate here cannot drift wider or narrower than the one below it.
    const admin = await requireAdmin(req, res, { roles: SAFETY_REVIEWER_ROLES });
    if (!admin) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }

    const out = await reviewSafetyClaim(sc, {
      claimId: parsed.data.claimId,
      // Resolved identity, never the body's. See the header.
      reviewerId: admin.userId,
      reviewerRole: admin.role,
      action: parsed.data.action,
      reason: parsed.data.reason ?? null,
    });

    if (!out.ok) {
      const code = REFUSAL_STATUS[out.reason];
      sendError(res, code, out.detail ?? out.reason);
      return;
    }

    // `reviewId: null` means the transition happened and the audit write did
    // not. It is reported rather than smoothed over, so an operator can see the
    // trail is incomplete instead of assuming it is not.
    res.status(200).json({
      ok: true,
      claimId: out.claimId,
      priorStatus: out.priorStatus,
      newStatus: out.newStatus,
      reviewId: out.reviewId,
      generatedAt: new Date().toISOString(),
    });
  }),
);

export default router;
