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
  writeObservation, proposeClaim, approveClaim, confirmClaim, correctClaim,
  type CaptureResult, type CaptureInput,
} from "../services/intel/IntelCaptureService.js";
import { getIntelConsentState, setIntelConsent } from "../lib/intelConsent.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { issueSensingCredential } from "../lib/deviceContributionCredential.js";
import { authorizeSensingCredential } from "../lib/deviceContributionCredential.js";
import { recordNavigationStart } from "../lib/canonicalEvents.js";
import { resolveSensitiveSubject, resolveSensitiveCanonicalZone } from "../lib/protectedLocations.js";
import { resolveActiveCrewId } from "../lib/activeCrew.js";

const router = Router();

/** Map a service rejection reason onto a stable API error code. */
const REASON_CODE: Record<string, ApiErrorCode> = {
  disabled: "feature_disabled",
  // No valid Intelligence Contributions consent → 403, the D4 lawful-basis refusal.
  consent_required: "forbidden",
  credential_unauthorized: "forbidden",
  credential_required: "forbidden",
  credential_expired: "forbidden",
  credential_revoked: "forbidden",
  credential_replay: "conflict",
  credential_infrastructure_error: "db_error",
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

router.post("/v1/intel/sensing-credentials", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc || !(await isFlagEnabled(sc, "intel_sensing_credentials_enabled"))) {
    return sendError(res, "feature_disabled", "Sensing credentials are not enabled");
  }
  const consent = await getIntelConsentState(sc, auth.user.id);
  if (!consent.enabled) return sendError(res, "forbidden", "Intelligence Contributions consent is required");
  const deviceId = req.header("X-Sensing-Device");
  if (!deviceId || deviceId.length < 32) return sendError(res, "invalid_payload", "An eligible device is required");
  const eligibility = await sc.rpc("is_sensing_device_eligible", { p_actor_id: auth.user.id, p_device_id: deviceId });
  if (eligibility.error || eligibility.data !== true) return sendError(res, "forbidden", "Device is not eligible for sensing");
  const issued = await issueSensingCredential(sc, auth.user.id, { deviceId });
  if (!issued.ok) return sendError(res, "db_error", issued.detail ?? issued.reason);
  res.status(201).json(issued.credential);
}));

router.post("/v1/intel/sensing-devices", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc || !(await isFlagEnabled(sc, "intel_sensing_device_enrollment_enabled"))) {
    return sendError(res, "feature_disabled", "Device enrollment is not enabled");
  }
  const consent = await getIntelConsentState(sc, auth.user.id);
  if (!consent.enabled) return sendError(res, "forbidden", "Intelligence Contributions consent is required");
  const deviceId = req.header("X-Sensing-Device");
  if (!deviceId || deviceId.length < 32 || deviceId.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(deviceId)) {
    return sendError(res, "invalid_payload", "An opaque locally generated device id is required");
  }
  const { error } = await sc.from("intel_sensing_device_eligibility").upsert({
    actor_id: auth.user.id, device_id: deviceId, eligible: true, unlinked_at: null,
  });
  if (error) return sendError(res, "db_error", error.message);
  res.status(201).json({ enrolled: true, deviceId });
}));

router.delete("/v1/intel/sensing-devices", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "Service client not configured");
  const deviceId = req.header("X-Sensing-Device");
  if (!deviceId) return sendError(res, "invalid_payload", "device id is required");
  const { data, error } = await sc.rpc("unlink_intel_sensing_device", {
    p_actor_id: auth.user.id, p_device_id: deviceId,
  });
  if (error) return sendError(res, "db_error", error.message);
  if (data !== "unlinked") return sendError(res, "not_found", "device is not linked");
  res.json({ unlinked: true });
}));

router.post("/v1/intel/navigation-start", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const nowMs = Date.now();
  const sc = getServiceClient();
  if (!sc || !(await isFlagEnabled(sc, "intel_sensing_credentials_enabled"))) return sendError(res, "feature_disabled", "Sensing credentials are not enabled");
  const consent = await getIntelConsentState(sc, auth.user.id);
  if (!consent.enabled) return sendError(res, "forbidden", "Intelligence Contributions consent is required");
  const body = z.object({
    fromZoneId: z.string().min(1).max(120), toZoneId: z.string().min(1).max(120),
  }).safeParse(req.body ?? {});
  if (!body.success) return sendError(res, "invalid_payload", "coarse zone endpoints and correlation seed are required");
  if (await resolveSensitiveCanonicalZone(sc, body.data.fromZoneId) || await resolveSensitiveCanonicalZone(sc, body.data.toZoneId)) {
    return sendError(res, "forbidden", "sensitive endpoint");
  }
  const authz = await authorizeSensingCredential(sc, req.header("X-Sensing-Credential"), req.header("X-Sensing-Nonce"), {
    actorId: auth.user.id, deviceId: req.header("X-Sensing-Device") ?? undefined,
  });
  if (!authz.ok) return sendError(res, "forbidden", authz.reason);
  const crewId = await resolveActiveCrewId(sc, auth.user.id, new Date(nowMs));
  try {
    await recordNavigationStart(sc, {
      actorId: auth.user.id, ...body.data, groupKey: crewId,
      expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
    });
  } catch (error) {
    return sendError(res, "db_error", "navigation event could not be recorded");
  }
  res.status(201).json({ recorded: true });
}));

router.delete("/v1/intel/sensing-credentials", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "Service client not configured");
  const deviceId = req.header("X-Sensing-Device") ?? null;
  const { data, error } = await sc.rpc("revoke_intel_sensing_credentials", {
    p_actor_id: auth.user.id, p_device_id: deviceId,
  });
  if (error) return sendError(res, "db_error", error.message);
  res.json({ revoked: Number(data ?? 0) });
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
    sensingCredential: req.header("X-Sensing-Credential") ?? undefined,
    sensingNonce: req.header("X-Sensing-Nonce") ?? undefined,
    sensingDeviceId: req.header("X-Sensing-Device") ?? undefined,
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
  res.status(201).json({ claim: out.claim });
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
  };
  const result = await correctClaim(getServiceClient()!, auth.user.id, req.params.id, input);
  sendCaptureResult(res, result);
}));

export default router;
