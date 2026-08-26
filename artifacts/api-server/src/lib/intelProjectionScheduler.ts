/**
 * Intel projection scheduler (IG-04) — the missing DRIVER that runs the claim →
 * live-state projection automatically.
 *
 * The projection (lib/intelProjection.projectAndStore) and its input assembly
 * (lib/intelProjectionAggregator) were both built, but nothing invoked them in
 * production: projectAndStore had callers only in tests. Without this, a real
 * observation → claim never became a snapshot, so liveClaims could never expose
 * live intelligence on its own. This closes that gap the same way
 * intelRetentionScheduler closed the "documented expiry nothing enforced" gap —
 * a flag-gated, self-rescheduling loop that never overlaps its own runs.
 *
 * WHAT IT DOES EACH PASS. Reads every active/conflicting claim, groups by
 * (subject, zone), assembles a ProjectionInput per claim from its real evidence,
 * and upserts snapshots. The privacy gate (inside projectClaim) still decides
 * privacy_eligible, and liveClaimRead still applies its own gates on the way out
 * — this driver never widens what may be shown, it only makes the write happen.
 *
 * Flag-gated (intel_claim_projection_crowd) and fail-closed; safe to start in
 * index.ts before the flag is on.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { projectAndStore } from "./intelProjection.js";
import { assembleClaimInput, type ClaimRow } from "./intelProjectionAggregator.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "./intelContracts.js";

const STARTUP_DELAY_MS = 3 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000; // spec §24: aggregate live state every five minutes
const MAX_CLAIMS_PER_PASS = 5000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface ProjectionPassResult {
  subjects: number;
  written: number;
  suppressed: number;
  skipped: number;
  skippedRun: boolean;
  reason: "disabled" | "no_client" | "error" | null;
}

/**
 * Run one projection pass. Fail-closed: no client, flag off, or an error each
 * produce a distinct `reason` so a persistently failing driver is never mistaken
 * for one nobody switched on. Idempotent — snapshots upsert on
 * (subject_id, zone_id, claim_type), so re-running only refreshes.
 */
export async function runIntelProjectionPass(opts: { client?: any; now?: Date } = {}): Promise<ProjectionPassResult> {
  const base: ProjectionPassResult = { subjects: 0, written: 0, suppressed: 0, skipped: 0, skippedRun: true, reason: null };
  // Explicit null => "no client"; undefined => use the service client (house pattern).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...base, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_claim_projection_crowd"))) return { ...base, reason: "disabled" };

  const now = opts.now ?? new Date();
  try {
    const { data, error } = await db
      .from("intel_claims")
      .select("id, subject_id, zone_id, claim_type, value, status, observed_at")
      .in("status", LIVE_ELIGIBLE_CLAIM_STATUSES as unknown as string[])
      .limit(MAX_CLAIMS_PER_PASS);
    if (error) {
      logger.warn({ err: error }, "intelProjection pass: claim read failed");
      return { ...base, reason: "error" };
    }

    // Group by (subject_id, zone_id): projectAndStore applies one zone per call,
    // and the snapshot key is (subject_id, zone_id, claim_type).
    const groups = new Map<string, { subjectId: string; zoneId: string | null; claims: ClaimRow[] }>();
    for (const c of ((data as ClaimRow[]) ?? [])) {
      if (!c.subject_id || !c.claim_type) continue;
      const key = JSON.stringify([c.subject_id, c.zone_id ?? ""]);
      let g = groups.get(key);
      if (!g) { g = { subjectId: c.subject_id, zoneId: c.zone_id ?? null, claims: [] }; groups.set(key, g); }
      g.claims.push(c);
    }

    const tally = { written: 0, suppressed: 0, skipped: 0 };
    for (const g of groups.values()) {
      try {
        const inputs = await Promise.all(g.claims.map((c) => assembleClaimInput(db, c, now)));
        const t = await projectAndStore(db, g.subjectId, inputs, { zoneId: g.zoneId, now });
        tally.written += t.written; tally.suppressed += t.suppressed; tally.skipped += t.skipped;
      } catch (err) {
        tally.skipped += g.claims.length;
        logger.warn({ err, subject: g.subjectId }, "intelProjection pass: subject projection threw");
      }
    }

    if (tally.written > 0 || tally.suppressed > 0) {
      logger.info({ subjects: groups.size, ...tally }, "intelProjection pass complete");
    }
    return { subjects: groups.size, ...tally, skippedRun: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "intelProjection pass threw");
    return { ...base, reason: "error" };
  }
}

export function startIntelProjectionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: "intel_claim_projection_crowd" },
    "IntelProjectionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelProjectionPass()
      .catch((err) => logger.warn({ err }, "intelProjection pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelProjectionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
