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

/**
 * `trust_events.source_type` for the identity-verification award.
 *
 * Deliberately NOT exported: `src/test/verificationTrustIdempotency.test.ts`
 * asserts the literal instead, so a rename here has to be made in two places
 * and cannot silently carry the test along with it.
 */
const TRUST_SOURCE_TYPE = "identity_verification";

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
  //
  // ── THE DEDUP KEY IS NOT OPTIONAL ON THIS PATH ────────────────────────────
  // `TrustEventService.isDuplicate` opens with `if (!sourceId) return "new"`, so
  // an emitter that passes no source has no idempotency key: every call is a
  // first call, and the 24 h dedup window the census grades as C1 is bypassed by
  // omission rather than by failure. This emitter used to do exactly that.
  //
  // Provider webhooks are at-least-once BY DESIGN, and this route's own handler
  // returns 5xx on a persist failure specifically so the provider retries (audit
  // H5) — so the one path here built to be re-entered was the one path with no
  // key, and every redelivery of the same session charged another +10
  // respect_safety until the daily earning cap absorbed it. V-1 defines the hook
  // per TRANSITION to `verified`, not per delivery.
  //
  // The provider session id is the right key: it is the identity of the
  // verification attempt, it is stable across redeliveries of the same event,
  // and it is what `identity_verifications.provider_session_id` is keyed on, so
  // the ledger row and the verification row name the same thing. `sourceType`
  // must travel with it — the dedup read filters on BOTH, so a session id left
  // under the default "system" source would look keyed and still never match the
  // row it wrote.
  await recordTrustEvent(client, {
    userId,
    eventType: "identity_verified",
    sourceType: TRUST_SOURCE_TYPE,
    sourceId: result.providerSessionId,
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

  // Fetch the row by provider_session_id to get the user_id if not supplied.
  //
  // THE SECOND DOOR INTO THE H5 DROP. The webhook handler below already returns
  // 5xx when the PERSIST fails, so the provider retries instead of losing the
  // event. It could still lose the event here: supabase-js RESOLVES on a
  // database error, so an unreadable `identity_verifications` produced
  // `data: null` — indistinguishable from a genuinely unknown session — and the
  // `return` two lines down is a SILENT SUCCESS. persistResult resolved,
  // webhookHandler answered 200, the provider marked the event delivered and
  // stopped retrying, and the user's KYC result was gone for good with nothing
  // logged. Rethrow so the 5xx path handles it exactly as a persist failure.
  let targetUserId = userId;
  if (!targetUserId) {
    const { data, error } = await client
      .from("identity_verifications")
      .select("user_id")
      .eq("provider_session_id", result.providerSessionId)
      .maybeSingle();
    if (error) throw new Error(`lookup identity_verifications by session: ${error.message}`);
    targetUserId = (data as any)?.user_id;
  }
  // A READ that succeeded and found nothing. This one really is an unknown
  // session — an event for a provider session this deployment never created —
  // and dropping it is correct.
  if (!targetUserId) return;

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
      // Return existing active session.
      // supabase-js RESOLVES on a DB error, so an unbound `error` made an
      // unreadable identity_verifications look like "the unique index fired but
      // there is no active session" — an impossible state that fell through to
      // the generic handler below and reported the KYC session as a raw 23505
      // db_error, so the client never learns it already has a live session and
      // the user is stuck unable to start or resume verification.
      const { data: active, error: activeErr } = await sc
        .from("identity_verifications")
        .select("id, provider_session_id, expires_at, status")
        .eq("user_id", user.id)
        .in("status", ["created", "pending", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeErr) {
        req.log.error({ err: activeErr }, "verification: active-session lookup failed after 23505 — cannot return the existing session");
        sendError(res, "db_error", "Could not read your existing verification session");
        return;
      }

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
  } catch (err: any) {
    // ── "NOT CONFIGURED" IS NOT "IRRELEVANT" ─────────────────────────────────
    // This branch used to discard the error unbound and answer 200 under the
    // comment "provider not configured; treat as irrelevant". 200 is not
    // irrelevant to a provider: Stripe Identity and Persona both read a 2xx as
    // FINAL DELIVERY and stop retrying.
    //
    // And this is not an exotic branch. `getIdentityProvider()` throwing is the
    // NORMAL behaviour of a production deployment on the default
    // IDENTITY_PROVIDER=mock — it is the mechanism that satisfies the plan's
    // privacy invariant 4 ("the mock provider is refused in production").
    // So the invariant that keeps the mock out of production was, through this
    // branch, also the thing that made the public webhook endpoint accept every
    // real event, write nothing, log nothing, and report success. Invariant 5
    // says an unverified webhook must "never silently accept"; that is a
    // statement about the RESPONSE, and this was the silent acceptance.
    //
    // 5xx, for the same reason the persist failure below returns 5xx (audit
    // H5): the event is valid and unread, the fault is on this side, and the
    // provider should retry or dead-letter rather than have this server destroy
    // it. 400 is NOT used — that is reserved for a signature that actually
    // failed, and reporting a local misconfiguration as the caller's bad
    // signature sends the operator looking in the wrong system.
    //
    // The response body stays empty: the factory's message names env vars and
    // provider configuration, and this endpoint is reachable by anyone.
    req.log?.error?.(
      { err },
      "verification webhook: identity provider unavailable — refusing with 503 so the provider " +
        "retries; answering 200 here silently destroyed every delivered KYC result",
    );
    res.sendStatus(503);
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

  // Profile verification level.
  //
  // `error` is bound because supabase-js RESOLVES on a database error: an
  // unreadable `profiles` and a user who has genuinely never verified both
  // arrive as `data: null`, and `?? "none"` turned the first into the second.
  // That is a false statement about a person ("you are not verified") that they
  // cannot act on, and it is the reading direction that matters here — ID
  // verification GATES real things elsewhere in this system (Rent-a-Buddy's
  // MVP mode refuses a booking without it, routes/rentABuddyRollout.ts), so a
  // client that caches "none" from a hiccup shows a verified user a
  // verification wall. Say the read failed instead of answering for it.
  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("verification_level, verified_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    req.log.error({ err: profileErr, userId: user.id }, "verification status: profile level fetch failed");
    sendError(res, "db_error", "Could not read your verification level");
    return;
  }

  res.status(200).json({
    verificationRow:   row ?? null,
    verificationLevel: (profile as any)?.verification_level ?? "none",
    verifiedAt:        (profile as any)?.verified_at ?? null,
  });
}));

export default router;
