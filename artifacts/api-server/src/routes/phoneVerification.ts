/**
 * Phone verification routes.
 *
 * Three endpoints, all authenticated as the acting user — there is deliberately
 * no admin path to mark a phone verified. An admin-set phone would be evidence
 * of nothing, and the whole reason this exists is that the booking gate was
 * demanding a signal the product could not honestly produce.
 *
 * The verification code is never returned by any response here. The only way to
 * learn it is to receive the SMS, which is the entire point.
 *
 * Failure codes are mapped narrowly: the client is told enough to act (retry,
 * fix the number, wait) and nothing that helps enumerate accounts. In
 * particular `phone_in_use` deliberately does not say which account holds the
 * number.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  startPhoneVerification,
  confirmPhoneVerification,
  CHALLENGE_TTL_MS,
  MAX_ATTEMPTS,
} from "../services/phoneVerification/PhoneVerificationService.js";

const router = Router();

// ── Start ─────────────────────────────────────────────────────────────────────
// POST /api/me/phone/verify/start   { phone: "+15550100000" }
router.post("/me/phone/verify/start", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const result = await startPhoneVerification(sc, user.id, req.body?.phone);

  if (!result.ok) {
    switch (result.failure) {
      case "provider_unavailable":
        // 503, not 400: nothing the caller did is wrong, and the capability is
        // expected to come back. Deliberately does not name the provider.
        return res.status(503).json({
          error: "verification_unavailable",
          message: "Phone verification is temporarily unavailable. Please try again later.",
        });
      case "invalid_phone":
        return res.status(400).json({
          error: "invalid_phone",
          message: "Enter your number in international format, e.g. +15550100000.",
        });
      case "phone_in_use":
        return res.status(409).json({
          error: "phone_in_use",
          message: "That number is already verified on another account.",
        });
      case "rate_limited":
        return res.status(429).json({
          error: "rate_limited",
          message: "Too many verification requests. Please wait before trying again.",
          retryAfterMs: result.retryAfterMs ?? null,
        });
      default:
        return res.status(502).json({
          error: "send_failed",
          message: "We could not send the code. Check the number and try again.",
        });
    }
  }

  return res.json({
    ok: true,
    expiresAt: result.expiresAt,
    expiresInSeconds: Math.round(CHALLENGE_TTL_MS / 1000),
    maxAttempts: MAX_ATTEMPTS,
  });
}));

// ── Confirm ───────────────────────────────────────────────────────────────────
// POST /api/me/phone/verify/confirm   { code: "123456" }
router.post("/me/phone/verify/confirm", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const result = await confirmPhoneVerification(sc, user.id, req.body?.code);

  if (!result.ok) {
    switch (result.failure) {
      case "no_challenge":
        return res.status(400).json({
          error: "no_challenge",
          message: "Request a new code to continue.",
        });
      case "expired":
        return res.status(410).json({
          error: "code_expired",
          message: "That code has expired. Request a new one.",
        });
      case "too_many_attempts":
        return res.status(429).json({
          error: "too_many_attempts",
          message: "Too many incorrect attempts. Request a new code.",
          attemptsRemaining: 0,
        });
      case "rate_limited":
        return res.status(429).json({
          error: "rate_limited",
          message: "Too many attempts. Please wait before trying again.",
        });
      case "phone_in_use":
        return res.status(409).json({
          error: "phone_in_use",
          message: "That number is already verified on another account.",
        });
      default:
        return res.status(400).json({
          error: "incorrect_code",
          message: "That code is not correct.",
          attemptsRemaining: result.attemptsRemaining ?? null,
        });
    }
  }

  return res.json({ ok: true, phoneVerified: true, phoneVerifiedAt: result.phoneVerifiedAt });
}));

// ── Status ────────────────────────────────────────────────────────────────────
// GET /api/me/phone/status
//
// Returns the verified state and a masked number. The full number is never
// echoed back: the caller already knows it if they own it, and masking keeps it
// out of logs, screenshots and any client that over-shares its state.
router.get("/me/phone/status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const { data, error } = await sc
    .from("profiles")
    .select("phone_e164, phone_verified_at")
    .eq("id", user.id)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }

  const phone = (data as any)?.phone_e164 as string | null;
  const verifiedAt = (data as any)?.phone_verified_at as string | null;

  return res.json({
    phoneVerified: Boolean(verifiedAt),
    phoneVerifiedAt: verifiedAt ?? null,
    maskedPhone: phone ? `${phone.slice(0, 3)}${"•".repeat(Math.max(0, phone.length - 5))}${phone.slice(-2)}` : null,
  });
}));

export default router;
