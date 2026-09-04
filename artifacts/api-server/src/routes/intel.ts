/**
 * Intelligence Gathering — capture routes (IG-03, spec §19 Capture).
 *
 * POST /v1/intel/observations                     — Quick Signal / Moment capture
 * POST /v1/intel/observations/:id/claims:propose  — observation -> candidate claim
 * POST /v1/intel/observations/:id/claims:approve  — candidate -> active
 * POST /v1/intel/claims/:id/confirm               — independent agree/disagree/unsure
 * POST /v1/intel/claims/:id/correct               — supersede with a new observation
 *
 * GET  /v1/internal/intel/trail/movement          — admin-only IG-06 cohort read (never a publication)
 *
 * Every write requires an Idempotency-Key header. actor_id is taken from the
 * session, never the body. Responses carry schema_version, source label, observed
 * time and expiry — never location proof. Each write names its capture surface
 * (`captureSurface`, default quick_signal) and is gated by that surface's flag —
 * intel_capture_quick_signal or, for the IG-06 Trail follow-up, intel_trail_followup;
 * off means every call is a fail-closed no-op (the service returns `disabled`).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  PRESENCE_LEVELS, VISIBILITIES, SOURCE_CLASS_LABELS, isValidIdempotencyKey, PARTY_SIZE_BUCKETS,
} from "../lib/intelContracts.js";
import { QUICK_SIGNAL_CONTEXTS, mapQuickSignal, type QuickSignalContext } from "../lib/quickSignal.js";
import {
  writeObservation, proposeClaim, approveClaim, confirmClaim, correctClaim, CAPTURE_SURFACES,
  type CaptureResult, type CaptureInput,
} from "../services/intel/IntelCaptureService.js";
import { getIntelConsentState, setIntelConsent } from "../lib/intelConsent.js";
import { readTrailMovement } from "../lib/trailServe.js";

const router = Router();

/** Map a service rejection reason onto a stable API error code. */
const REASON_CODE: Record<string, ApiErrorCode> = {
  disabled: "feature_disabled",
  // No valid Intelligence Contributions consent → 403, the D4 lawful-basis refusal.
  consent_required: "forbidden",
  invalid_idempotency_key: "invalid_payload",
  invalid_observed_at: "invalid_payload",
  invalid_claim_type: "invalid_payload",
  invalid_value: "invalid_payload",
  unknown_subject: "not_found",
  db_error: "db_error",
};

const observationSchema = z.object({
  subjectId: z.string().uuid(),
  subjectKind: z.string().max(40).optional(),
  zoneId: z.string().max(120).nullable().optional(),
  observedAt: z.string().datetime(),
  capturedAt: z.string().datetime().nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  presenceLevel: z.enum(PRESENCE_LEVELS).optional(),
  // Which §6 collection surface this write comes from. Each surface has its own
  // flag and its own contracted claim list in IntelCaptureService; omitted ⇒
  // quick_signal (the pre-existing default, unchanged). The IG-06 Trail sheet
  // sends 'trail' — before this field existed (2026-09-04) every Trail write was
  // treated as a Quick Signal and refused, so the surface was unreachable.
  captureSurface: z.enum(CAPTURE_SURFACES).optional(),
  // Quick Signal / Trail form (§6): a context + a chosen option, mapped server-side.
  // For context 'movement' the option is the coarse destination area (§13).
  context: z.enum(QUICK_SIGNAL_CONTEXTS).optional(),
  option: z.string().max(120).optional(),
  // Direct form: an already-canonical claim.
  claimType: z.string().max(60).optional(),
  value: z.record(z.string(), z.unknown()).optional(),
  // V1 independent-group signal (§privacy). "Who are you here with?" — asked only
  // for label-eligible captures. partyId is the observer's active Trip Crew id, if
  // any; the server VALIDATES membership before honouring it. Both optional, so
  // older clients keep working (group_key resolves to null → fail-closed).
  partySize: z.enum(PARTY_SIZE_BUCKETS).optional(),
  partyId: z.string().uuid().optional(),
});

const confirmSchema = z.object({
  stance: z.enum(["agree", "disagree", "unsure"]),
  observedAt: z.string().datetime(),
  presenceLevel: z.enum(PRESENCE_LEVELS).optional(),
});

/** Shape the stored observation into the §19 response envelope (never raw location). */
function envelope(observation: any): Record<string, unknown> {
  return {
    id: observation.id,
    subjectId: observation.subject_id,
    zoneId: observation.zone_id,
    claimType: observation.claim_type,
    value: observation.value,
    sourceLabel: SOURCE_CLASS_LABELS[observation.source_class as keyof typeof SOURCE_CLASS_LABELS] ?? observation.source_class,
    observedAt: observation.observed_at,
    validUntil: observation.expires_at,
    schemaVersion: observation.schema_version,
    presenceLevel: observation.presence_level,
    visibility: observation.visibility,
  };
}

function requireIdempotencyKey(req: any, res: any): string | null {
  const key = req.header("Idempotency-Key") ?? req.header("idempotency-key");
  if (!isValidIdempotencyKey(key)) {
    sendError(res, "invalid_payload", "An Idempotency-Key header is required on every intel write.");
    return null;
  }
  return key;
}

function sendCaptureResult(res: any, result: CaptureResult): void {
  if (result.ok) {
    res.status(result.deduped ? 200 : 201).json({ observation: envelope(result.observation), deduped: result.deduped });
    return;
  }
  sendError(res, REASON_CODE[result.reason] ?? "invalid_payload", result.detail ?? result.reason);
}

// ── Intelligence Contributions consent (D4) ──────────────────────────────────
// The client may READ its own state and ASK to enable/disable. The consent
// version and timestamps are stamped server-side (lib/intelConsent), so a client
// cannot forge them, and the authoritative row is service-role only.
router.get("/v1/intel/consent", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const state = await getIntelConsentState(getServiceClient()!, auth.user.id);
  res.json(state);
}));

router.put("/v1/intel/consent", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  // The ONLY client-supplied field is the boolean intent. Everything evidentiary
  // (version, consented_at, withdrawn_at) is set by the server.
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", "enabled (boolean) is required");
  const out = await setIntelConsent(getServiceClient()!, auth.user.id, parsed.data.enabled);
  if (!out.ok) return sendError(res, "db_error", "consent update failed");
  res.json(out.state);
}));

// ── Capture ─────────────────────────────────────────────────────────────────
router.post("/v1/intel/observations", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const parsed = observationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid observation");
  const b = parsed.data;

  let claimType: string | undefined;
  let value: Record<string, unknown> | undefined;
  if (b.context && b.option) {
    const mapped = mapQuickSignal(b.context as QuickSignalContext, b.option);
    if (!mapped) return sendError(res, "invalid_payload", `no claim maps from ${b.context}/${b.option}`);
    claimType = mapped.claimType;
    value = mapped.value;
  } else if (b.claimType && b.value) {
    claimType = b.claimType;
    value = b.value;
  } else {
    return sendError(res, "invalid_payload", "supply either {context, option} or {claimType, value}");
  }

  const input: CaptureInput = {
    subjectId: b.subjectId,
    subjectKind: b.subjectKind,
    zoneId: b.zoneId ?? null,
    claimType,
    value,
    observedAt: b.observedAt,
    capturedAt: b.capturedAt ?? null,
    visibility: b.visibility,
    idempotencyKey: key,
    presenceLevel: b.presenceLevel,
    // Threaded, not inferred: the service applies the surface's flag and claim
    // list (quick_signal by default), so an unknown or omitted surface can only
    // narrow what is accepted, never widen it.
    captureSurface: b.captureSurface,
    partySize: b.partySize,
    partyId: b.partyId ?? null,
  };
  const result = await writeObservation(getServiceClient()!, auth.user.id, input);
  sendCaptureResult(res, result);
}));

// ── Claim lifecycle ───────────────────────────────────────────────────────────
const handleProposeClaim = asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient()!;
  const { data: obs } = await sc.from("intel_observations").select("*").eq("id", req.params.id).eq("actor_id", auth.user.id).maybeSingle();
  if (!obs) return sendError(res, "not_found", "observation not found");
  const out = await proposeClaim(sc, obs);
  if (!out.ok) {
    if (out.reason === "disabled") return sendError(res, "feature_disabled", "propose disabled");
    if (out.reason === "not_moderated")
      return sendError(res, "invalid_payload", "this observation is not eligible to back a claim (moderation-invalidated content)");
    if (out.reason === "must_aggregate")
      return sendError(res, "invalid_payload", "movement claims are aggregate-only; a single-user next_move is never published");
    return sendError(res, "db_error", out.reason ?? "propose failed");
  }
  // Idempotent (2274): a replay returns the stored candidate, 200 not 201.
  res.status(out.deduped ? 200 : 201).json({ claim: out.claim, deduped: out.deduped });
});

// APPROVAL IS THE TRUST GATE OF THE LIFECYCLE (candidate → active → publishable).
// It is restricted to an authorised admin/moderator capability — never an ordinary
// authenticated user, and never the feature flag alone. (A system/service auto-
// promotion path, if one is built later, would call approveClaim with the service
// client directly, not through this user-facing route.)
const handleApproveClaim = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const claimId = z.string().uuid().safeParse((req.body ?? {}).claimId);
  if (!claimId.success) return sendError(res, "invalid_payload", "claimId (uuid) required");
  const out = await approveClaim(getServiceClient()!, claimId.data);
  if (!out.ok) return sendError(res, out.reason === "disabled" ? "feature_disabled" : "db_error", out.reason ?? "approve failed");
  res.json({ ok: true });
});

// ── Registration ──────────────────────────────────────────────────────────────
//
// THE BUG THIS SHAPE FIXES (2026-08-29)
//
// These were registered as "/claims:propose" and "/claims:approve". Under
// express 5 / path-to-regexp 8, ":propose" is a PARAMETER, not literal text, so
// the first registration matched BOTH URLs and the approve route was
// unreachable. Proven against the installed express 5.2.1:
//
//   POST /v1/intel/observations/abc/claims:propose -> propose handler, params {id:"abc", propose:":propose"}
//   POST /v1/intel/observations/abc/claims:approve -> propose handler, params {id:"abc", propose:":approve"}
//
// So requireAdmin below never ran. The live caller is the AUTHOR — the
// "Approve & make it live" button in app/intel/moment.tsx — so pressing it hit
// the propose handler, inserted a SECOND status='candidate' row, and returned
// 201. The client read {ok:true}, the screen showed approved, the claim was
// never promoted, and every press left another duplicate.
//
// Slash segments are the canonical form. The legacy colon URL is kept and
// dispatched explicitly so clients already shipped against it keep working —
// and, more to the point, so approve reaches its admin gate for them too rather
// than silently proposing.
router.post("/v1/intel/observations/:id/claims/propose", handleProposeClaim);
router.post("/v1/intel/observations/:id/claims/approve", handleApproveClaim);

router.post("/v1/intel/observations/:id/claims:action", asyncHandler(async (req: Request, res: Response) => {
  const action = String((req.params as Record<string, string>).action ?? "");
  if (action === ":approve") return handleApproveClaim(req, res, (() => {}) as never);
  if (action === ":propose") return handleProposeClaim(req, res, (() => {}) as never);
  return sendError(res, "not_found", "unknown claim action");
}));

router.post("/v1/intel/claims/:id/confirm", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid confirmation");
  const out = await confirmClaim(getServiceClient()!, req.params.id, auth.user.id, parsed.data.stance, parsed.data.observedAt, parsed.data.presenceLevel);
  if (!out.ok) return sendError(res, out.reason === "disabled" ? "feature_disabled" : "invalid_payload", out.reason ?? "confirm failed");
  res.json({ ok: true, deduped: out.deduped ?? false });
}));

router.post("/v1/intel/claims/:id/correct", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const key = requireIdempotencyKey(req, res);
  if (!key) return;
  const parsed = observationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid correction");
  const b = parsed.data;
  if (!(b.claimType && b.value)) return sendError(res, "invalid_payload", "a correction supplies {claimType, value}");
  const input: CaptureInput = {
    subjectId: b.subjectId, subjectKind: b.subjectKind, zoneId: b.zoneId ?? null,
    claimType: b.claimType, value: b.value, observedAt: b.observedAt, capturedAt: b.capturedAt ?? null,
    visibility: b.visibility, idempotencyKey: key, presenceLevel: b.presenceLevel,
    captureSurface: b.captureSurface,
  };
  const result = await correctClaim(getServiceClient()!, auth.user.id, req.params.id, input);
  sendCaptureResult(res, result);
}));

// ── IG-06 Trail follow-up — internal cohort read ──────────────────────────────
// The serve side of the trail surface: origin → destination-area cohorts derived
// from captured experience.next_move observations (lib/trailServe, which is the
// production caller of lib/trailFollowup's aggregate + AT-10 block filter).
//
// INTERNAL ONLY (§29 Included: "Internal coverage dashboard for pilot zones").
// This is NOT movement publication — §29 EXCLUDES "Public Crowd Movement
// output"; that stays behind intel_movement_prediction (seeded OFF) and the §13
// mayPublishMovement gate, which no route calls. requireAdmin, never a client.
router.get("/v1/internal/intel/trail/movement", asyncHandler(async (req: Request, res: Response) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const q = z.object({ subjectId: z.string().uuid().optional() }).safeParse(req.query ?? {});
  if (!q.success) return sendError(res, "invalid_payload", "subjectId must be a uuid when supplied");
  const read = await readTrailMovement(getServiceClient()!, ctx.userId, { originId: q.data.subjectId ?? null });
  if (read.refusal === "flag_off") return sendError(res, "feature_disabled", "intel_trail_followup is off");
  if (read.refusal !== null) return sendError(res, "db_error", read.refusal);
  res.json(read);
}));

export default router;
