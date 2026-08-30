/**
 * Identity verification routes — Phase V-1.
 *
 * POST /api/verification/session   — create a verification session
 * POST /api/verification/webhook   — provider webhook (raw body — mounted in app.ts)
 * GET  /api/verification/status    — poll the caller's current verification state
 *
 * Provider adapter: getIdentityProvider() selects mock | stripe | persona via
 * IDENTITY_PROVIDER env var. The mock provider (default in dev/test) approves
 * automatically after ~8 s or on explicit testHint.
 *
 * Rate limit: 3 session creations per user per rolling 24 h.
 *
 * Privacy invariant: no raw document images, document numbers, DOBs, or
 * selfies are ever returned by these routes. Normalized booleans only.
 */

import { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { getServiceClient } from "../lib/supabase.js";
import { getIdentityProvider, toVerificationLevel } from "../services/identityVerification/index.js";
import type { VerificationResult } from "../services/identityVerification/types.js";
import { recordTrustEvent, TRUST_EVENT_TYPES } from "../services/trust/TrustEventService.js";

export const router = Router();

// ── Rate limit constants ──────────────────────────────────────────────────────
const VERIFICATION_SESSION_LIMIT = 3;
const VERIFICATION_SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 h

// ── Schema ────────────────────────────────────────────────────────────────────
const TEST_HINTS = ["approve", "fail_document", "fail_selfie", "fail_underage"] as const;

const CreateSessionSchema = z.object({
  level:    z.enum(["id", "id_selfie"]),
  testHint: z.enum(TEST_HINTS).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Idempotently set profiles.verification_level + verified_at when a session becomes verified. */
async function applyVerifiedProfile(
  client: ReturnType<typeof getServiceClient>,
  userId: string,
  result: VerificationResult,
): Promise<void> {
  if (!client) return;
  const level = toVerificationLevel(result);
  if (level === "none") return;

  // supabase-js RESOLVES (does not throw) on a write error, so the error must be
  // destructured and re-thrown. Silently discarding it here reported a clean 200
  // to the provider while the user's verification_level was never persisted
  // (e.g. a CHECK-constraint rejection of the level vocabulary — see audit H5).
  const { error } = await client
    .from("profiles")
    .update({
      verification_level: level,
      verified_at: result.verifiedAt ?? new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw new Error(`persist verification_level: ${error.message}`);

  // Trust Score hook. V-4 has shipped — IDENTITY_VERIFIED is a declared member
  // of TRUST_EVENT_TYPES (TrustEventService.ts), so the dynamic `as any` lookup
  // and its presence guard that used to sit here are gone: the property is
  // statically typed and always defined, and the old guard silently skipped the
  // trust award for as long as it was left in place after the event shipped.
  await recordTrustEvent(client, {
    userId,
    eventType: "identity_verified",
    ...TRUST_EVENT_TYPES.IDENTITY_VERIFIED,
  }).catch(() => {/* fire-and-forget — never block the webhook response */});
}

/** Upsert the identity_verifications row from a VerificationResult.
 *  Exported for testing: a persist error must propagate (throw), not be swallowed. */
export async function persistResult(
  client: ReturnType<typeof getServiceClient>,
  result: VerificationResult,
  userId?: string,
): Promise<void> {
  if (!client) return;

  // Fetch the row by provider_session_id to get the user_id if not supplied
  let targetUserId = userId;
  if (!targetUserId) {
    const { data } = await client
      .from("identity_verifications")
      .select("user_id")
      .eq("provider_session_id", result.providerSessionId)
      .maybeSingle();
    targetUserId = (data as any)?.user_id;
  }
  if (!targetUserId) return; // unknown session — ignore

  const patch: Record<string, unknown> = {
    status:         result.status,
    failure_reason: result.failureReason ?? null,
    is_over_18:     result.isOver18   ?? null,
    selfie_match:   result.selfieMatch ?? null,
    document_country: result.documentCountry ?? null,
    updated_at:     new Date().toISOString(),
  };
  if (result.status === "verified") {
    patch.verified_at               = result.verifiedAt ?? new Date().toISOString();
    patch.provider_verification_ref = result.providerVerificationRef ?? null;
  }

  const { error: updErr } = await client
    .from("identity_verifications")
    .update(patch)
    .eq("provider_session_id", result.providerSessionId);
  if (updErr) throw new Error(`persist identity_verifications: ${updErr.message}`);

  if (result.status === "verified") {
    const sc = getServiceClient();
    if (sc && targetUserId) {
      await applyVerifiedProfile(sc, targetUserId, result);
    }
  }
}

// ── POST /verification/session ────────────────────────────────────────────────
router.post("/verification/session", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;

  // Rate limit: 3 sessions / 24 h per user
  const rl = checkRateLimit("verification_session", user.id, VERIFICATION_SESSION_LIMIT, VERIFICATION_SESSION_WINDOW_MS);
  if (!rl.allowed) {
    const retryAfterSecs = Math.ceil(rl.retryAfterMs / 1000);
    const retryAt        = new Date(Date.now() + rl.retryAfterMs).toISOString();
    res.setHeader("Retry-After", String(retryAfterSecs));
    sendError(res, "rate_limited", `Too many verification attempts. Retry after ${retryAt}.`);
    return;
  }

  const parsed = CreateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  let { level, testHint } = parsed.data;

  // Strip testHint in production
  if (process.env.NODE_ENV === "production") {
    testHint = undefined;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  let provider;
  try {
    provider = getIdentityProvider();
  } catch (err: any) {
    // Full error server-side only; the raw message can name env vars/config.
    req.log.error({ err }, "verification: provider unavailable");
    sendError(res, "server_not_configured", "Identity verification is not configured");
    return;
  }

  const appBaseUrl = process.env.APP_RETURN_BASE_URL ?? "portava://app/verification/mock-complete";

  let session;
  try {
    session = await provider.createSession({
      userId:   user.id,
      level,
      returnUrl: appBaseUrl,
      testHint,
    });
  } catch (err: any) {
    req.log.error({ err }, "verification: createSession failed");
    sendError(res, "db_error", "Could not create verification session", { exposeDetail: true });
    return;
  }

  // Persist to DB — catch the unique-index conflict (one active session per user).
  const { data: existing, error: insertError } = await sc
    .from("identity_verifications")
    .insert({
      user_id:             user.id,
      provider:            session.provider,
      provider_session_id: session.providerSessionId,
      status:              "pending",
      expires_at:          session.expiresAt,
    })
    .select("id, provider_session_id, expires_at")
    .single();

  if (insertError) {
    // Postgres unique-index violation on uq_identity_verifications_active (code 23505)
    if ((insertError as any).code === "23505") {
      // Return existing active session
      const { data: active } = await sc
        .from("identity_verifications")
        .select("id, provider_session_id, expires_at, status")
        .eq("user_id", user.id)
        .in("status", ["created", "pending", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (active) {
        res.status(200).json({
          redirectUrl:       session.redirectUrl,   // Return the new session's URL so mock flow still works
          providerSessionId: (active as any).provider_session_id,
          expiresAt:         (active as any).expires_at,
          existingSession:   true,
        });
        return;
      }
    }
    req.log.error({ err: insertError }, "verification: insert failed");
    sendError(res, "db_error", insertError.message);
    return;
  }

  res.status(201).json({
    redirectUrl:       session.redirectUrl,
    providerSessionId: (existing as any).provider_session_id,
    expiresAt:         (existing as any).expires_at,
  });
}));

// ── POST /verification/webhook (raw body — parser injected in app.ts) ─────────
// This handler is exported separately so app.ts can mount it with
// express.raw() BEFORE the global JSON parser.

export const webhookRawParser = express.raw({ type: () => true, limit: "512kb" });

export const webhookHandler = async (req: any, res: any) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : "";

  let provider;
  try {
    provider = getIdentityProvider();
  } catch {
    res.sendStatus(200); // provider not configured; treat as irrelevant
    return;
  }

  let result: VerificationResult | null;
  try {
    result = await provider.handleWebhook({
      headers:  req.headers as Record<string, string | string[] | undefined>,
      rawBody,
    });
  } catch (err: any) {
    // Signature failure: the provider MUST throw — we return 400 per spec.
    // Log the full error server-side; the response stays generic so provider
    // internals / signature material never leak to whoever hit the webhook.
    req.log?.warn({ err }, "verification webhook: signature failure or parse error");
    res.status(400).json({ error: "invalid_signature", message: "Webhook signature verification failed" });
    return;
  }

  if (!result) {
    res.sendStatus(200); // irrelevant event
    return;
  }

  try {
    await persistResult(getServiceClient(), result);
  } catch (err) {
    // A persist failure means the KYC result was NOT recorded. Returning 200
    // here told the provider "handled" and stopped retries, silently stranding
    // the user at their old level. Return 5xx so the provider retries (or
    // dead-letters) instead of dropping the event (audit H5).
    req.log?.error({ err }, "verification webhook: persist failed — returning 5xx so the provider retries");
    res.sendStatus(500);
    return;
  }

  res.sendStatus(200);
};

// NOTE: /verification/webhook is mounted in app.ts BEFORE the global JSON parser
// to preserve the raw body for signature verification.
// It is NOT re-registered here to avoid double-handling.

// ── GET /verification/status ──────────────────────────────────────────────────
router.get("/verification/status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Latest verification row
  const { data: row, error: rowErr } = await sc
    .from("identity_verifications")
    .select("id, provider, provider_session_id, status, failure_reason, is_over_18, selfie_match, document_country, verified_at, expires_at, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rowErr) {
    req.log.error({ err: rowErr }, "verification status: fetch failed");
    sendError(res, "db_error", rowErr.message);
    return;
  }

  // Profile verification level
  const { data: profile } = await sc
    .from("profiles")
    .select("verification_level, verified_at")
    .eq("id", user.id)
    .maybeSingle();

  res.status(200).json({
    verificationRow:   row ?? null,
    verificationLevel: (profile as any)?.verification_level ?? "none",
    verifiedAt:        (profile as any)?.verified_at ?? null,
  });
}));

export default router;
