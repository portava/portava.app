/**
 * PhoneVerificationService
 *
 * Issues and confirms SMS verification challenges, and is the only writer of
 * `profiles.phone_verified_at`.
 *
 * WHY THIS EXISTS. Every rent_buddy_launch_controls row requires phone
 * verification and the booking path enforces it, but the product had no phone
 * verification of any kind: no OTP code, no SMS integration, no phone column on
 * `profiles`, and `auth.users.phone_confirmed_at` is never read. The only
 * phone signal in the schema was `rent_buddy_profiles.phone_verified` — on the
 * BUDDY table, written by nothing. The requirement was unsatisfiable, so this
 * builds the capability rather than faking the signal.
 *
 * SECURITY PROPERTIES, and why each is here:
 *
 *   - Codes are never stored. Only sha256(challengeId + ':' + code) is
 *     persisted, with the row's random uuid acting as the salt, so identical
 *     codes hash differently and a leaked table cannot be reversed in bulk.
 *   - Comparison is constant-time (timingSafeEqual), so response latency does
 *     not leak how much of a code was correct.
 *   - Attempts are capped per challenge (default 5). Without this a 6-digit
 *     code is a million guesses against one row — trivially brute-forced.
 *   - Issuing is rate-limited per user AND per destination number, so the
 *     endpoint cannot be used to bomb a third party with SMS at your expense.
 *   - Starting a new challenge invalidates the user's previous ones, so an
 *     abandoned code cannot be redeemed later.
 *   - The code never appears in logs or in any API response.
 *
 * FAILS CLOSED. When no SMS provider can actually deliver (the default state —
 * the adapters are stubs and mock is refused in production), start() refuses
 * rather than minting codes nobody can receive.
 */

import { createHash, randomUUID, randomInt, timingSafeEqual } from "node:crypto";
import { logger as rootLogger } from "../../lib/logger.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { getSmsProvider, smsProviderStatus } from "./smsProvider.js";

const logger = rootLogger.child({ service: "PhoneVerificationService" });

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Six digits balances usability against the attempt cap below. */
const CODE_DIGITS = 6;

/** Long enough for slow SMS routes, short enough that a stolen code goes stale. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1_000;

/** Guesses allowed against one challenge before it is dead. */
export const MAX_ATTEMPTS = 5;

/** Sends per user, and per destination number, per hour. */
export const SEND_LIMIT_PER_USER = 5;
export const SEND_LIMIT_PER_PHONE = 5;
const SEND_WINDOW_MS = 60 * 60 * 1_000;

/** Confirm attempts per user per hour — a second ceiling above the per-challenge cap. */
export const CONFIRM_LIMIT_PER_USER = 15;
const CONFIRM_WINDOW_MS = 60 * 60 * 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type StartFailure =
  | "provider_unavailable"
  | "invalid_phone"
  | "phone_in_use"
  | "rate_limited"
  | "send_failed";

export type ConfirmFailure =
  | "no_challenge"
  | "expired"
  | "too_many_attempts"
  | "incorrect_code"
  | "rate_limited"
  | "phone_in_use";

export interface StartResult {
  ok: boolean;
  failure?: StartFailure;
  /** When the issued challenge stops being redeemable. */
  expiresAt?: string;
  /** Present only when rate limited. */
  retryAfterMs?: number;
}

export interface ConfirmResult {
  ok: boolean;
  failure?: ConfirmFailure;
  /** Remaining guesses against the current challenge, when relevant. */
  attemptsRemaining?: number;
  phoneVerifiedAt?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Accepts E.164 only, matching the CHECK constraint in migration 2142.
 * Whitespace, dashes and parentheses are stripped first so a user pasting
 * "+1 (555) 010-0000" is not rejected for punctuation, but no country code is
 * inferred — an ambiguous local number must be rejected rather than guessed.
 */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s()\-.]/g, "");
  return /^\+[1-9][0-9]{6,14}$/.test(cleaned) ? cleaned : null;
}

function generateCode(): string {
  // randomInt is CSPRNG-backed; Math.random would be predictable.
  let out = "";
  for (let i = 0; i < CODE_DIGITS; i++) out += String(randomInt(0, 10));
  return out;
}

function hashCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

/** Constant-time hex comparison. Length mismatch short-circuits (not secret). */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Is this number already the verified number of a DIFFERENT account? */
async function phoneTakenByAnother(db: any, phone: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("id")
      .eq("phone_e164", phone)
      .not("phone_verified_at", "is", null)
      .limit(2);
    if (error) return false; // the unique index is the real guarantee
    return ((data as any[]) ?? []).some((r) => r.id !== userId);
  } catch {
    return false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startPhoneVerification(
  db: any,
  userId: string,
  rawPhone: unknown,
): Promise<StartResult> {
  // Refuse before generating anything if nothing can deliver it.
  const status = smsProviderStatus();
  if (!status.operational) {
    logger.error({ provider: status.provider, reason: status.reason },
      "phone verification requested while no SMS provider is operational");
    return { ok: false, failure: "provider_unavailable" };
  }

  const phone = normalisePhone(rawPhone);
  if (!phone) return { ok: false, failure: "invalid_phone" };

  // Two independent buckets: one stops a user burning their own quota, the
  // other stops many accounts being pointed at one victim's handset.
  const perUser = checkRateLimit("phone_verify_send_user", userId, SEND_LIMIT_PER_USER, SEND_WINDOW_MS);
  if (!perUser.allowed) return { ok: false, failure: "rate_limited", retryAfterMs: perUser.retryAfterMs };

  const perPhone = checkRateLimit("phone_verify_send_phone", phone, SEND_LIMIT_PER_PHONE, SEND_WINDOW_MS);
  if (!perPhone.allowed) return { ok: false, failure: "rate_limited", retryAfterMs: perPhone.retryAfterMs };

  if (await phoneTakenByAnother(db, phone, userId)) {
    return { ok: false, failure: "phone_in_use" };
  }

  // ONE clock reading for the whole call. Taking Date.now() here and a separate
  // no-arg new Date() below would be two independent reads of a moving clock,
  // which can produce a challenge whose consumed_at precedes its own created_at.
  const nowMs = Date.now();

  // Retire any outstanding challenge so an abandoned code cannot be redeemed.
  try {
    await db
      .from("phone_verification_challenges")
      .update({ consumed_at: new Date(nowMs).toISOString() })
      .eq("user_id", userId)
      .is("consumed_at", null);
  } catch (err) {
    logger.warn({ err, userId }, "retiring previous challenges failed (non-fatal)");
  }

  // The id is generated here, not by the database, because it salts the hash.
  const id = randomUUID();
  const code = generateCode();
  const expiresAt = new Date(nowMs + CHALLENGE_TTL_MS).toISOString();

  const { error: insErr } = await db
    .from("phone_verification_challenges")
    .insert({
      id,
      user_id: userId,
      phone_e164: phone,
      code_hash: hashCode(id, code),
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      expires_at: expiresAt,
    });
  if (insErr) {
    logger.error({ err: insErr, userId }, "failed to persist phone challenge");
    return { ok: false, failure: "send_failed" };
  }

  try {
    const provider = getSmsProvider();
    await provider.send({
      to: phone,
      body: `Your Portava verification code is ${code}. It expires in ${Math.round(CHALLENGE_TTL_MS / 60000)} minutes.`,
    });
  } catch (err) {
    // Burn the challenge — a code that was never delivered must not stay live.
    try {
      await db
        .from("phone_verification_challenges")
        .update({ consumed_at: new Date(nowMs).toISOString() })
        .eq("id", id);
    } catch { /* non-fatal */ }
    logger.error({ err, userId }, "SMS send failed");
    return { ok: false, failure: "send_failed" };
  }

  // Note the absence of the code here. It must never reach the logs.
  logger.info({ userId, expiresAt }, "phone verification challenge issued");
  return { ok: true, expiresAt };
}

// ── Confirm ───────────────────────────────────────────────────────────────────

export async function confirmPhoneVerification(
  db: any,
  userId: string,
  submittedCode: unknown,
): Promise<ConfirmResult> {
  const perUser = checkRateLimit("phone_verify_confirm", userId, CONFIRM_LIMIT_PER_USER, CONFIRM_WINDOW_MS);
  if (!perUser.allowed) return { ok: false, failure: "rate_limited" };

  // One clock reading, as above: expiry is judged and verification is stamped
  // against the same instant.
  const nowMs = Date.now();

  const code = typeof submittedCode === "string" ? submittedCode.trim() : "";
  if (!code) return { ok: false, failure: "incorrect_code" };

  const { data: rows, error } = await db
    .from("phone_verification_challenges")
    .select("id, phone_e164, code_hash, attempts, max_attempts, expires_at")
    .eq("user_id", userId)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    logger.error({ err: error, userId }, "challenge lookup failed");
    return { ok: false, failure: "no_challenge" };
  }

  const challenge = ((rows as any[]) ?? [])[0];
  if (!challenge) return { ok: false, failure: "no_challenge" };

  if (new Date(challenge.expires_at).getTime() <= nowMs) {
    return { ok: false, failure: "expired" };
  }

  const attempts = Number(challenge.attempts ?? 0);
  const maxAttempts = Number(challenge.max_attempts ?? MAX_ATTEMPTS);
  if (attempts >= maxAttempts) {
    return { ok: false, failure: "too_many_attempts", attemptsRemaining: 0 };
  }

  if (!hashesEqual(hashCode(challenge.id, code), String(challenge.code_hash))) {
    const nextAttempts = attempts + 1;
    try {
      await db
        .from("phone_verification_challenges")
        .update({ attempts: nextAttempts })
        .eq("id", challenge.id);
    } catch (err) {
      logger.warn({ err, userId }, "attempt increment failed (non-fatal)");
    }
    return {
      ok: false,
      failure: nextAttempts >= maxAttempts ? "too_many_attempts" : "incorrect_code",
      attemptsRemaining: Math.max(0, maxAttempts - nextAttempts),
    };
  }

  // Re-check ownership at redemption: another account could have verified this
  // number between issue and confirm.
  if (await phoneTakenByAnother(db, String(challenge.phone_e164), userId)) {
    return { ok: false, failure: "phone_in_use" };
  }

  const verifiedAt = new Date(nowMs).toISOString();
  const { error: profErr } = await db
    .from("profiles")
    .update({ phone_e164: challenge.phone_e164, phone_verified_at: verifiedAt })
    .eq("id", userId);
  if (profErr) {
    // 23505 = the partial unique index caught a race the read above missed.
    if (String((profErr as any).code) === "23505") {
      return { ok: false, failure: "phone_in_use" };
    }
    logger.error({ err: profErr, userId }, "failed to persist verified phone");
    return { ok: false, failure: "no_challenge" };
  }

  try {
    await db
      .from("phone_verification_challenges")
      .update({ consumed_at: verifiedAt })
      .eq("id", challenge.id);
  } catch (err) {
    logger.warn({ err, userId }, "consuming challenge failed (non-fatal — phone is already verified)");
  }

  logger.info({ userId }, "phone verified");
  return { ok: true, phoneVerifiedAt: verifiedAt };
}

/** Is this user's phone verified? The authoritative traveller-side signal. */
export async function isPhoneVerified(db: any, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("phone_verified_at")
      .eq("id", userId)
      .maybeSingle();
    if (error) return false;
    return Boolean((data as any)?.phone_verified_at);
  } catch {
    return false;
  }
}
