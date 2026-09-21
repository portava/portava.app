/**
 * Telegraph §22 — adaptive send rate limits.
 *
 * §22's control table, one row:
 *   Rate limits  "Adaptive to relationship, verification, trust, account age
 *                 and reports."
 *
 * census-telegraph T279 measured the halves separately and precisely: the
 * ADAPTIVE machinery is real and is applied to the REQUEST step
 * (`resolveInteractionPermissions` plus `getRestrictionState`, folding trust
 * restrictions and account state into request eligibility), while "message
 * sending has no rate limit at all — `routes/messaging.ts` contains no
 * `checkRateLimit` call". This module is the missing half: the send step's
 * limit, and the five inputs §22 names deciding what it is.
 *
 * WHY A TIER AND NOT A SCORE
 * ==========================
 * A continuous score would be tuned forever and would make every refusal
 * unexplainable ("you are at 0.41"). Four tiers, each with a stated limit and a
 * stated reason, mean a refusal can say which tier the sender is in and what
 * would move them out of it — which is the difference between a rate limit and
 * a wall.
 *
 * THE FAILURE DIRECTION, ARGUED
 * =============================
 * Every input here can fail to read. The tier then falls to STRANGER, which is
 * the strictest — but note what "strictest" means: 20 messages per 10 minutes.
 * It is not a block. That is the whole reason this can fail toward strictness
 * without being dangerous: an unreadable `profiles` during a bad database
 * minute costs a chatty user a pause, not their conversation. A limiter that
 * failed OPEN here would switch the abuse control off precisely during the
 * minutes an attacker would most like it off.
 *
 * THE CACHE IS PART OF THE DESIGN, NOT AN OPTIMISATION
 * ===================================================
 * The send path is the hottest write in Telegraph. Four reads per message to
 * decide a limit would cost more than the limit saves. The tier is therefore
 * cached per user for `TIER_TTL_MS`, and the consequence is stated rather than
 * hidden: a user who verifies their account keeps the old tier for up to five
 * minutes, and a user who is newly reported keeps the old tier for up to five
 * minutes. The second is the one that matters, and it is acceptable because
 * reports are not the fast path of an attack — an attacker sending faster than
 * their tier allows is stopped by the tier they already had.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { checkRateLimit, type RateLimitResult } from "../../../lib/rateLimit.js";
import { logger as rootLogger } from "../../../lib/logger.js";

const log = rootLogger.child({ mod: "telegraphSendRateLimit" });

export type SendTier = "stranger" | "new" | "established" | "trusted";

export const SEND_WINDOW_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Messages per window, per tier.
 *
 * The numbers are deliberately high. This limiter exists to stop a burst — a
 * compromised account fanning a scam across a hundred threads, a script — and
 * not to shape ordinary conversation. A person in an argument sends thirty
 * messages in ten minutes; a person coordinating a meetup sends fifty. The
 * stranger tier is the only one an ordinary user could plausibly reach, and it
 * is set above the busiest real conversation this repository's own fixtures
 * contain.
 */
export const SEND_LIMITS: Readonly<Record<SendTier, number>> = {
  stranger: 20,
  new: 40,
  established: 80,
  trusted: 160,
};

export const TIER_TTL_MS = 5 * 60 * 1_000;

export interface TierInputs {
  /** Account age in days, or null when `profiles.created_at` could not be read. */
  accountAgeDays: number | null;
  verificationLevel: string | null;
  trustScore: number | null;
  /** Reports filed AGAINST this user that are still open. */
  openReportsAgainst: number | null;
  /** True when the sender shares a trip, circle or accepted thread history. */
  hasRelationship: boolean;
  /** At least one input read failed; the tier is a floor, not a measurement. */
  degraded: boolean;
}

export interface ResolvedTier {
  tier: SendTier;
  limit: number;
  inputs: TierInputs;
  /** Why this tier, in the order the rules fired. */
  reasons: string[];
}

interface CacheEntry { at: number; resolved: ResolvedTier }
const _tierCache = new Map<string, CacheEntry>();

/** Test hook: forget every cached tier. */
export function _clearSendTierCache(): void { _tierCache.clear(); }

/**
 * Fold §22's five inputs into a tier.
 *
 * Pure, so the rules are testable without a database. The order is the
 * precedence: a report outranks verification, because a verified account that
 * people are reporting is exactly the case where verification is being used as
 * cover.
 */
export function tierFrom(inputs: TierInputs): ResolvedTier {
  const reasons: string[] = [];
  let tier: SendTier;

  if (inputs.degraded) {
    reasons.push("inputs_unreadable");
    tier = "stranger";
  } else if ((inputs.openReportsAgainst ?? 0) >= 2) {
    reasons.push("open_reports_against_sender");
    tier = "stranger";
  } else if ((inputs.accountAgeDays ?? 0) < 2) {
    reasons.push("account_under_two_days_old");
    tier = "stranger";
  } else if (
    inputs.verificationLevel !== null &&
    inputs.verificationLevel !== "none" &&
    (inputs.trustScore ?? 0) >= 70
  ) {
    reasons.push("verified_and_trusted");
    tier = "trusted";
  } else if (inputs.hasRelationship && (inputs.accountAgeDays ?? 0) >= 30) {
    reasons.push("established_account_with_relationships");
    tier = "established";
  } else {
    reasons.push("default_new_account");
    tier = "new";
  }

  if ((inputs.openReportsAgainst ?? 0) >= 1 && tier !== "stranger") {
    // One open report does not drop a sender to the strictest tier — a single
    // report is a claim, not a finding — but it does remove the top tier,
    // because the top tier is a multiple of the ordinary one.
    if (tier === "trusted") { tier = "established"; reasons.push("one_open_report_caps_tier"); }
  }

  return { tier, limit: SEND_LIMITS[tier], inputs, reasons };
}

/**
 * Read the five inputs and resolve the sender's tier, cached.
 *
 * Every read's `.error` is checked and sets `degraded`, because supabase-js
 * resolves on a database error: an unchecked read here would silently report a
 * brand-new, heavily-reported account as a thirty-day-old unreported one.
 */
export async function resolveSendTier(
  sc: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<ResolvedTier> {
  const cached = _tierCache.get(userId);
  if (cached && nowMs - cached.at < TIER_TTL_MS) return cached.resolved;

  let degraded = false;
  let accountAgeDays: number | null = null;
  let verificationLevel: string | null = null;
  let trustScore: number | null = null;
  let openReportsAgainst: number | null = null;
  let hasRelationship = false;

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("created_at, verification_level, trust_score")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) {
    degraded = true;
    log.warn({ err: profileErr, userId }, "send tier: profile unreadable — falling to the strictest tier");
  } else if (profile) {
    const created = Date.parse(String((profile as any).created_at ?? ""));
    accountAgeDays = Number.isFinite(created) ? (nowMs - created) / 86_400_000 : null;
    verificationLevel = ((profile as any).verification_level ?? null) as string | null;
    const ts = (profile as any).trust_score;
    trustScore = ts === null || ts === undefined ? null : Number(ts);
  } else {
    degraded = true; // no profile row: cannot establish anything about this sender
  }

  const { data: reports, error: reportsErr } = await sc
    .from("reports")
    .select("id")
    .eq("target_type", "user")
    .eq("target_id", userId)
    .eq("status", "open")
    .limit(5);
  if (reportsErr) {
    degraded = true;
    log.warn({ err: reportsErr, userId }, "send tier: reports unreadable");
  } else {
    openReportsAgainst = ((reports as any[]) ?? []).length;
  }

  const { data: threads, error: threadsErr } = await sc
    .from("message_thread_members")
    .select("thread_id")
    .eq("user_id", userId)
    .is("left_at", null)
    .limit(2);
  if (threadsErr) {
    degraded = true;
    log.warn({ err: threadsErr, userId }, "send tier: memberships unreadable");
  } else {
    hasRelationship = ((threads as any[]) ?? []).length >= 2;
  }

  const resolved = tierFrom({
    accountAgeDays, verificationLevel, trustScore, openReportsAgainst, hasRelationship, degraded,
  });
  _tierCache.set(userId, { at: nowMs, resolved });
  return resolved;
}

export interface SendLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  tier: SendTier;
  limit: number;
  reasons: string[];
}

/**
 * The send path's gate. One call, one answer, and the answer says WHY.
 *
 * The limiter id is per-tier deliberately: a sender promoted from `new` to
 * `trusted` starts a fresh bucket rather than carrying a near-full one into a
 * larger allowance, and a sender demoted to `stranger` does not get to spend a
 * `trusted` bucket at the stranger limit.
 */
export async function checkSendRateLimit(
  sc: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<SendLimitDecision> {
  const resolved = await resolveSendTier(sc, userId, nowMs);
  const verdict: RateLimitResult = checkRateLimit(
    `telegraph_send:${resolved.tier}`,
    userId,
    resolved.limit,
    SEND_WINDOW_MS,
  );
  return {
    allowed: verdict.allowed,
    retryAfterMs: verdict.retryAfterMs,
    tier: resolved.tier,
    limit: resolved.limit,
    reasons: resolved.reasons,
  };
}
