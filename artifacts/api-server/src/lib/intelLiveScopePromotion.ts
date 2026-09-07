/**
 * Intel live-scope promotion — the ONE writer for `intel_live_promoted_scopes`
 * (IG-09 per-scope Live allowlist, migrations 2179 + 2430).
 *
 * WHY THIS EXISTS
 * ===============
 * lib/liveClaimRead.ts refuses to serve ANY live claim unless the claim's
 * (zone, claim_type) scope has a row in intel_live_promoted_scopes. 2179 created
 * that table and said "promote a scope by inserting a row" — and nothing ever
 * did: no route, scheduler, script, trigger or SQL function wrote it
 * (checkWriterlessReads recorded it as a human-curated allowlist). Production on
 * 2026-09-07: intel_limited_live, intel_live_label_crowd and
 * intel_claim_projection_crowd all TRUE, the table EMPTY, so every consumer of
 * readLiveClaims — placeLiving, the Wall Live-For-You strip / WallMoment, the
 * Map ExperienceState fold and worldMomentProducer, Compass live constraints,
 * Media, Trail, the intel read models — answered [] at this one gate.
 *
 * WHAT PROMOTION CONSUMES, AND WHO DECIDES
 * ========================================
 * Read from the spine, not guessed: 2179's header ("only after that SCOPE clears
 * the density gate + human review"), lib/intelLiveScope.ts ("Promotion is a
 * human-review decision (spec §24)"), lib/intelCalibrationScheduler.ts ("writes
 * nothing and promotes nothing — promotion stays a human decision"). The
 * evidence a promotion rests on is the §26 density-gate assessment
 * (lib/intelFunnelReport.assessDensityGate, derived from observations, claims,
 * snapshots and outcomes), and its `certifiable` verdict is false BY DESIGN while
 * crowdCalibrationAccuracy and expiryCorrectness are uninstrumented.
 *
 * So this module does NOT decide which scopes go live and does NOT run on a
 * timer looking for scopes to promote. It is the write path a human decision
 * travels through, so that the resulting row carries provenance (who, via what,
 * on what evidence), an explicit review horizon, and can be withdrawn. The
 * trigger — which scope, when, on what evidence — is the owner's, and is
 * deliberately not built here. `runLiveScopeExpiryPass` is the only autonomous
 * part: it turns "past the horizon" into an explicit withdrawn('expired') row,
 * and it is driven by the existing lib/intelPromotionScheduler tick.
 *
 * ONE WRITER, ONE READER
 * ======================
 * The read path (liveClaimRead.loadPromotedScopes) never writes this table, and
 * this module never reads snapshots or decides what is served. Every write goes
 * through the three service-owned SQL functions from 2430 — service_role only,
 * SECURITY DEFINER, idempotent — so the invariants (canonical scope_key, a
 * horizon on every service promotion, a reason on every withdrawal, 'service'
 * provenance) hold no matter which caller arrives.
 *
 * FAIL-CLOSED
 * ===========
 * Gated on `intel_live_scope_promotion_enabled` (CAPABILITY, seeded FALSE in
 * 2430, read via isFlagEnabled so an unreadable flag is OFF). With the flag off
 * every function here returns {skipped:true, reason:'disabled'} BEFORE any RPC
 * — zero writes, the allowlist untouched, and the read path's answer is
 * byte-identical to before this module existed. supabase-js RESOLVES on a
 * database error, so every RPC result is checked for `.error` explicitly; an
 * error is reported as reason:'error', never as a silent success.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

/** CAPABILITY flag (2430). Literal so scripts/check-flag-polarity.mjs resolves it. */
export const LIVE_SCOPE_PROMOTION_FLAG = "intel_live_scope_promotion_enabled";

/**
 * The canonical scope key — MUST equal 2179's CHECK
 * (`coalesce(zone_id,'') || '|' || claim_type`) and the lookup key
 * liveClaimRead builds per snapshot (`${zone_id ?? ""}|${claim_type}`). One
 * composition, three places; this is the TypeScript statement of it.
 */
export function liveScopeKey(zoneId: string | null | undefined, claimType: string): string {
  return `${zoneId ?? ""}|${claimType}`;
}

export type WriterSkipReason = "disabled" | "no_client" | "invalid_input" | "error";

export type PromoteAction = "promoted" | "repromoted" | "renewed" | "already_active";
export type WithdrawAction = "withdrawn" | "already_withdrawn" | "not_found";

export interface PromoteLiveScopeInput {
  zoneId: string | null;
  claimType: string;
  /**
   * The review horizon. REQUIRED — a service promotion without one is refused
   * (invalid_input) before any RPC. Past this instant the scope is not promoted:
   * the read path ignores the row and the expiry pass marks it withdrawn('expired').
   */
  expiresAt: Date | string;
  /** The human who decided. Optional only because an operator RPC may not carry a uuid. */
  promotedBy?: string | null;
  note?: string | null;
  /**
   * What the promoter looked at — typically a lib/intelFunnelReport
   * DensityGateAssessment (metrics, gate, uninstrumented, upperBound,
   * certifiable). Stored verbatim as provenance; never read by the serve path.
   */
  evidence?: Record<string, unknown> | null;
  now?: Date;
}

export interface PromoteLiveScopeResult {
  skipped: boolean;
  reason: WriterSkipReason | null;
  scopeKey: string;
  action: PromoteAction | null;
  expiresAt: string | null;
}

export interface WithdrawLiveScopeInput {
  zoneId: string | null;
  claimType: string;
  /** REQUIRED — a withdrawal always says why (2430 CHECK). */
  reason: string;
  withdrawnBy?: string | null;
  now?: Date;
}

export interface WithdrawLiveScopeResult {
  skipped: boolean;
  reason: WriterSkipReason | null;
  scopeKey: string;
  action: WithdrawAction | null;
}

export interface LiveScopeExpiryResult {
  skipped: boolean;
  reason: WriterSkipReason | null;
  /** Rows moved from promoted to withdrawn('expired') this pass. */
  expired: number;
}

const PROMOTE_ACTIONS: ReadonlySet<string> = new Set(["promoted", "repromoted", "renewed", "already_active"]);
const WITHDRAW_ACTIONS: ReadonlySet<string> = new Set(["withdrawn", "already_withdrawn", "not_found"]);

/** House pattern (intelRetentionScheduler): explicit null = no client; undefined = service client. */
function resolveClient(opts: { client?: any }): any {
  return "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
}

function toIso(d: Date | string): string | null {
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Promote one (zone, claim_type) scope for Live. Idempotent per scope — see the
 * action table in 2430: promoted / repromoted / renewed / already_active.
 * NEVER promotes on its own initiative: a caller (the owner's trigger) names the
 * scope, the horizon and the evidence.
 */
export async function promoteLiveScope(
  input: PromoteLiveScopeInput,
  opts: { client?: any } = {},
): Promise<PromoteLiveScopeResult> {
  const scopeKey = liveScopeKey(input.zoneId, input.claimType);
  const base = { scopeKey, action: null, expiresAt: null } as const;
  const db = resolveClient(opts);
  if (!db) return { ...base, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, LIVE_SCOPE_PROMOTION_FLAG))) {
    return { ...base, skipped: true, reason: "disabled" };
  }

  const now = input.now ?? new Date();
  const expiresAt = toIso(input.expiresAt);
  if (typeof input.claimType !== "string" || input.claimType.length === 0) {
    return { ...base, skipped: true, reason: "invalid_input" };
  }
  if (!expiresAt || Date.parse(expiresAt) <= now.getTime()) {
    // A horizon in the past (or unparseable) is not a promotion. Refused here so
    // the SQL function's RAISE is a second line, not the first.
    return { ...base, skipped: true, reason: "invalid_input" };
  }

  try {
    const { data, error } = await db.rpc("system_promote_intel_live_scope", {
      p_zone_id: input.zoneId ?? null,
      p_claim_type: input.claimType,
      p_expires_at: expiresAt,
      p_promoted_by: input.promotedBy ?? null,
      p_note: input.note ?? null,
      p_evidence: input.evidence ?? null,
      p_now: now.toISOString(),
    });
    if (error) {
      logger.warn({ err: error, scopeKey }, "intel live-scope promotion failed");
      return { ...base, skipped: true, reason: "error" };
    }
    const receipt = (data ?? {}) as { action?: unknown; expires_at?: unknown };
    const action = typeof receipt.action === "string" && PROMOTE_ACTIONS.has(receipt.action)
      ? (receipt.action as PromoteAction)
      : null;
    if (!action) {
      // A receipt this build does not recognise is not a success.
      logger.warn({ receipt, scopeKey }, "intel live-scope promotion returned an unknown receipt");
      return { ...base, skipped: true, reason: "error" };
    }
    if (action !== "already_active") logger.info({ scopeKey, action, expiresAt }, "intel live scope promoted");
    return {
      skipped: false,
      reason: null,
      scopeKey,
      action,
      expiresAt: typeof receipt.expires_at === "string" ? receipt.expires_at : expiresAt,
    };
  } catch (err) {
    logger.warn({ err, scopeKey }, "intel live-scope promotion threw");
    return { ...base, skipped: true, reason: "error" };
  }
}

/**
 * Withdraw a promoted scope. The row is KEPT (the allowlist is also the audit
 * trail); the read path stops serving it the moment withdrawn_at is set.
 * Idempotent: a second withdrawal is 'already_withdrawn' with no write.
 */
export async function withdrawLiveScope(
  input: WithdrawLiveScopeInput,
  opts: { client?: any } = {},
): Promise<WithdrawLiveScopeResult> {
  const scopeKey = liveScopeKey(input.zoneId, input.claimType);
  const base = { scopeKey, action: null } as const;
  const db = resolveClient(opts);
  if (!db) return { ...base, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, LIVE_SCOPE_PROMOTION_FLAG))) {
    return { ...base, skipped: true, reason: "disabled" };
  }
  if (typeof input.claimType !== "string" || input.claimType.length === 0) {
    return { ...base, skipped: true, reason: "invalid_input" };
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    return { ...base, skipped: true, reason: "invalid_input" };
  }
  const now = input.now ?? new Date();
  try {
    const { data, error } = await db.rpc("system_withdraw_intel_live_scope", {
      p_zone_id: input.zoneId ?? null,
      p_claim_type: input.claimType,
      p_reason: input.reason,
      p_withdrawn_by: input.withdrawnBy ?? null,
      p_now: now.toISOString(),
    });
    if (error) {
      logger.warn({ err: error, scopeKey }, "intel live-scope withdrawal failed");
      return { ...base, skipped: true, reason: "error" };
    }
    const receipt = (data ?? {}) as { action?: unknown };
    const action = typeof receipt.action === "string" && WITHDRAW_ACTIONS.has(receipt.action)
      ? (receipt.action as WithdrawAction)
      : null;
    if (!action) {
      logger.warn({ receipt, scopeKey }, "intel live-scope withdrawal returned an unknown receipt");
      return { ...base, skipped: true, reason: "error" };
    }
    if (action === "withdrawn") logger.info({ scopeKey, reason: input.reason }, "intel live scope withdrawn");
    return { skipped: false, reason: null, scopeKey, action };
  } catch (err) {
    logger.warn({ err, scopeKey }, "intel live-scope withdrawal threw");
    return { ...base, skipped: true, reason: "error" };
  }
}

/**
 * The expiry sweep: every promoted scope whose horizon has passed becomes
 * withdrawn('expired'). Idempotent (a row is expired once). Driven by the
 * intelPromotionScheduler tick; the read path already ignores an expired row,
 * so this is about the table telling the truth, not about closing a leak.
 */
export async function runLiveScopeExpiryPass(opts: { client?: any; now?: Date } = {}): Promise<LiveScopeExpiryResult> {
  const db = resolveClient(opts);
  if (!db) return { skipped: true, reason: "no_client", expired: 0 };
  if (!(await isFlagEnabled(db, LIVE_SCOPE_PROMOTION_FLAG))) {
    return { skipped: true, reason: "disabled", expired: 0 };
  }
  const now = opts.now ?? new Date();
  try {
    const { data, error } = await db.rpc("system_expire_intel_live_scopes", { p_now: now.toISOString() });
    if (error) {
      logger.warn({ err: error }, "intel live-scope expiry pass failed");
      return { skipped: true, reason: "error", expired: 0 };
    }
    // integer may arrive as a string over PostgREST — coerce, do not typeof-guard.
    const expired = Number(data) || 0;
    if (expired > 0) logger.info({ expired }, "intel live scopes expired");
    return { skipped: false, reason: null, expired };
  } catch (err) {
    logger.warn({ err }, "intel live-scope expiry pass threw");
    return { skipped: true, reason: "error", expired: 0 };
  }
}
