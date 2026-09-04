/**
 * Intel claim promotion — the missing autonomous transition between capture and
 * projection.
 *
 * A Quick Signal writes an OBSERVATION; the projection aggregates only ACTIVE
 * claims. Nothing turned admissible observations into active claims without an
 * admin. This scheduler runs the service-owned promotion function
 * (system_promote_admissible_intel_claims, migration 2174), which creates exactly
 * one active anchor claim per (subject, zone, claim_type) that has an admissible,
 * fresh, consented observation and no live claim yet — deterministically and
 * idempotently. It does NOT widen who may approve (admin approveClaim is
 * untouched) and does NOT bypass any downstream gate: the privacy thresholds,
 * confidence bands, freshness, delay, kill switch and projection all still decide,
 * later, whether anything is ever served.
 *
 * Gated on intel_claim_projection_crowd — the same stage flag as the projection it
 * feeds: promoting while projection is off would only accumulate dormant claims.
 * Fail-closed and self-rescheduling, following intelProjectionScheduler. Runs a
 * touch ahead of the projection so a freshly promoted claim is ready for the next
 * aggregation pass.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { emitPromotionDomainEvents } from "./intelDomainEvents.js";

const STARTUP_DELAY_MS = 2 * 60 * 1000; // ahead of the projection's 3-minute startup
const INTERVAL_MS = 5 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface PromotionResult {
  promoted: number;
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  // §21 domain events emitted this pass (spec Table 29). Independent of the
  // promotion count: a catch-up emitter files intel.claim.promoted /
  // intel.observation.recorded for any system-promoted claim not yet on the
  // spine. Zero when nothing was outstanding.
  claimsPromoted?: number;
  observationsRecorded?: number;
}

export async function runIntelPromotionPass(opts: { client?: any; now?: Date } = {}): Promise<PromotionResult> {
  // Explicit null means "no client"; undefined means "use the service client" —
  // the house pattern (see intelRetentionScheduler for why `??` is wrong here).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { promoted: 0, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_claim_projection_crowd"))) {
    return { promoted: 0, skipped: true, reason: "disabled" };
  }

  const now = opts.now ?? new Date();
  try {
    const { data, error } = await db.rpc("system_promote_admissible_intel_claims");
    if (error) {
      logger.warn({ err: error }, "intel promotion pass failed");
      return { promoted: 0, skipped: true, reason: "error" };
    }
    // bigint may arrive as a string over PostgREST — coerce, do not typeof-guard.
    const promoted = Number(data) || 0;
    if (promoted > 0) logger.info({ promoted }, "intel promotion created active claims");

    // §21 domain events. Fully fail-closed — never throws, never alters the
    // promotion outcome — so a spine hiccup can't roll back a real promotion.
    const emitted = await emitPromotionDomainEvents(db, { now });
    return {
      promoted,
      skipped: false,
      reason: null,
      claimsPromoted: emitted.claimsPromoted,
      observationsRecorded: emitted.observationsRecorded,
    };
  } catch (err) {
    logger.warn({ err }, "intel promotion pass threw");
    return { promoted: 0, skipped: true, reason: "error" };
  }
}

export function startIntelPromotionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: "intel_claim_projection_crowd" },
    "IntelPromotionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelPromotionPass()
      .catch((err) => logger.warn({ err }, "intel promotion pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelPromotionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
