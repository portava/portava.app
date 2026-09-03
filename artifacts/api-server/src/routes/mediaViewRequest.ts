/**
 * Media v2 Phase 10 (Human Network) — Request-a-View + contributor reputation +
 * coverage-gap awareness (§19, §25).
 *
 * POST /v1/media/view-requests                      — request a current perspective of a place
 * PUT  /v1/media/view-requests/opt-in               — the caller opts in/out as a view contributor
 * GET  /v1/media/places/:placeId/visual-coverage    — "last visual update Nm ago" + staleness
 * GET  /v1/media/contributors/:contributorId/reputation — intelligence-trust dimensions (§25)
 *
 * Every route authenticates through requireUser (the ban/suspend gate + the
 * service-role client). The write routes are the mutating ones; the two GETs are
 * contextual reads for a signed-in viewer. Identity always comes from the token,
 * never the body — a view-request's requester is auth.user.id, and opt-in only
 * ever toggles the caller's OWN row.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import {
  createViewRequest,
  setContributorOptIn,
  type ViewRequestRefusal,
} from "../services/media/MediaViewRequestService.js";
import { readVisualCoverage } from "../lib/mediaVisualFreshness.js";
import { readContributorReputation } from "../services/media/MediaContributorReputationService.js";
import { loadRestrictiveGems, gemCeilingForItem } from "../lib/mediaLocationVisibility.js";

const router = Router();

const createSchema = z.object({
  subjectId: z.string().uuid(),
  claimFamily: z.string().min(1).max(60),
  question: z.string().min(1).max(300),
  city: z.string().max(120).nullable().optional(),
  zoneId: z.string().max(120).nullable().optional(),
  lat: z.number().finite().nullable().optional(),
  lng: z.number().finite().nullable().optional(),
  coverageScore: z.number().min(0).max(1).nullable().optional(),
});

/** Map a service refusal to an HTTP error code + message. */
function sendRefusal(res: any, reason: ViewRequestRefusal | "db_error"): void {
  switch (reason) {
    case "disabled":
      return sendError(res, "feature_disabled", "Request-a-View is not enabled");
    case "rate_limited":
      return sendError(res, "rate_limited", "Too many view requests — please try again later");
    case "duplicate":
      return sendError(res, "conflict", "A view request for this place is already open");
    case "protected_location":
      return sendError(res, "forbidden", "This location is protected and cannot be requested");
    case "safety_undetermined":
      return sendError(res, "forbidden", "Could not verify this location is safe to request");
    default:
      return sendError(res, "db_error", "Could not create the view request");
  }
}

// ── POST /v1/media/view-requests ──────────────────────────────────────────────
router.post("/v1/media/view-requests", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid request");

  const out = await createViewRequest(auth.client, {
    requesterId: auth.user.id,
    subjectId: parsed.data.subjectId,
    claimFamily: parsed.data.claimFamily,
    question: parsed.data.question,
    city: parsed.data.city ?? null,
    zoneId: parsed.data.zoneId ?? null,
    lat: parsed.data.lat ?? null,
    lng: parsed.data.lng ?? null,
    coverageScore: parsed.data.coverageScore ?? null,
  });
  if (!out.ok) return sendRefusal(res, out.reason ?? "db_error");

  // recipients are opted-in + eligible + un-blocked ONLY; we return the COUNT,
  // never the recipient ids (a view request must not reveal who was asked).
  res.status(201).json({
    requestId: out.requestId,
    missionCandidateId: out.missionCandidateId,
    recipientCount: out.recipientCount ?? 0,
  });
}));

// ── PUT /v1/media/view-requests/opt-in ───────────────────────────────────────
const optInSchema = z.object({
  optedIn: z.boolean(),
  city: z.string().max(120).nullable().optional(),
});
router.put("/v1/media/view-requests/opt-in", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = optInSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid opt-in");

  // The caller may only set THEIR OWN opt-in. Eligibility is never self-set here.
  const out = await setContributorOptIn(auth.client, auth.user.id, parsed.data.optedIn, parsed.data.city ?? null);
  if (!out.ok) return sendError(res, "db_error", "Could not update opt-in");
  res.json({ ok: true, optedIn: parsed.data.optedIn });
}));

// ── GET /v1/media/places/:placeId/visual-coverage ────────────────────────────
const coverageQuerySchema = z.object({
  claimFamily: z.string().min(1).max(60).default("crowd.level"),
  city: z.string().max(120).optional(),
});
router.get("/v1/media/places/:placeId/visual-coverage", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const placeId = z.string().uuid().safeParse(req.params.placeId);
  if (!placeId.success) return sendError(res, "invalid_payload", "place id (uuid) required");
  const q = coverageQuerySchema.safeParse(req.query ?? {});
  if (!q.success) return sendError(res, "invalid_payload", q.error.issues[0]?.message ?? "invalid query");

  // Safety: do not confirm the freshness/activity of a protected/sensitive place.
  // Fail-closed: an undetermined gem cross-check is refused.
  try {
    const gems = await loadRestrictiveGems(auth.client, {
      placeIds: [placeId.data],
      cities: q.data.city ? [q.data.city] : [],
    });
    if (gemCeilingForItem(gems, { placeId: placeId.data }) !== null) {
      return sendError(res, "forbidden", "This location is protected");
    }
  } catch {
    return sendError(res, "forbidden", "Could not verify this location is safe to read");
  }

  const coverage = await readVisualCoverage(auth.client, {
    subjectId: placeId.data,
    claimFamily: q.data.claimFamily,
  });
  res.json({ coverage });
}));

// ── GET /v1/media/contributors/:contributorId/reputation ─────────────────────
router.get("/v1/media/contributors/:contributorId/reputation", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const contributorId = z.string().uuid().safeParse(req.params.contributorId);
  if (!contributorId.success) return sendError(res, "invalid_payload", "contributor id (uuid) required");
  const subjectId = typeof req.query.subjectId === "string" && req.query.subjectId.length > 0
    ? req.query.subjectId
    : null;

  const reputation = await readContributorReputation(auth.client, {
    contributorId: contributorId.data,
    subjectId,
  });
  res.json({ reputation });
}));

export default router;
