/**
 * Intelligence Gathering — capture routes (IG-03, spec §19 Capture).
 *
 * POST /v1/intel/observations                     — Quick Signal / Moment capture
 * POST /v1/intel/observations/:id/claims:propose  — observation -> candidate claim
 * POST /v1/intel/observations/:id/claims:approve  — candidate -> active
 * POST /v1/intel/claims/:id/confirm               — independent agree/disagree/unsure
 * POST /v1/intel/claims/:id/correct               — supersede with a new observation
 *
 * Every write requires an Idempotency-Key header. actor_id is taken from the
 * session, never the body. Responses carry schema_version, source label, observed
 * time and expiry — never location proof. Gated by intel_capture_quick_signal;
 * off means every call is a fail-closed no-op (the service returns `disabled`).
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  PRESENCE_LEVELS, VISIBILITIES, SOURCE_CLASS_LABELS, isValidIdempotencyKey, PARTY_SIZE_BUCKETS,
} from "../lib/intelContracts.js";
import { QUICK_SIGNAL_CONTEXTS, mapQuickSignal, type QuickSignalContext } from "../lib/quickSignal.js";
import {
  writeObservation, proposeClaim, approveClaim, confirmClaim, correctClaim,
  type CaptureResult, type CaptureInput,
} from "../services/intel/IntelCaptureService.js";

const router = Router();

/** Map a service rejection reason onto a stable API error code. */
const REASON_CODE: Record<string, ApiErrorCode> = {
  disabled: "feature_disabled",
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
  // Quick Signal form (§6): a context + a chosen option, mapped server-side.
  context: z.enum(QUICK_SIGNAL_CONTEXTS).optional(),
  option: z.string().max(60).optional(),
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
    if (!mapped) return sendError(res, "invalid_payload", `no Phase-1 claim maps from ${b.context}/${b.option}`);
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
    partySize: b.partySize,
    partyId: b.partyId ?? null,
  };
  const result = await writeObservation(getServiceClient()!, auth.user.id, input);
  sendCaptureResult(res, result);
}));

// ── Claim lifecycle ───────────────────────────────────────────────────────────
router.post("/v1/intel/observations/:id/claims:propose", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient()!;
  const { data: obs } = await sc.from("intel_observations").select("*").eq("id", req.params.id).eq("actor_id", auth.user.id).maybeSingle();
  if (!obs) return sendError(res, "not_found", "observation not found");
  const out = await proposeClaim(sc, obs);
  if (!out.ok) {
    if (out.reason === "disabled") return sendError(res, "feature_disabled", "propose disabled");
    if (out.reason === "must_aggregate")
      return sendError(res, "invalid_payload", "movement claims are aggregate-only; a single-user next_move is never published");
    return sendError(res, "db_error", out.reason ?? "propose failed");
  }
  res.status(201).json({ claim: out.claim });
}));

router.post("/v1/intel/observations/:id/claims:approve", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const claimId = z.string().uuid().safeParse((req.body ?? {}).claimId);
  if (!claimId.success) return sendError(res, "invalid_payload", "claimId (uuid) required");
  const out = await approveClaim(getServiceClient()!, claimId.data);
  if (!out.ok) return sendError(res, out.reason === "disabled" ? "feature_disabled" : "db_error", out.reason ?? "approve failed");
  res.json({ ok: true });
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
  };
  const result = await correctClaim(getServiceClient()!, auth.user.id, req.params.id, input);
  sendCaptureResult(res, result);
}));

export default router;
