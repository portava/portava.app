/**
 * Live-claim read path (IG-05) — the one place a surface asks "what is true here
 * right now?".
 *
 * WHAT THIS REPLACES. routes/placeLiving.ts had TWO dead crowd-level reads:
 *   :241-242  `(group.place as any).best_time` / `.crowd_level`
 *   :582      `const crowdLevel = null; // populated by precompute worker`
 * `group.place` is a row from `places`, and `places` has no crowd_level or
 * best_time_to_go column — those live on `hidden_gems`. The `as any` casts
 * suppressed the type error, so both expressions always evaluated to null while
 * looking like real reads, and the worker at :582 never existed.
 *
 * Deleting them and reading here instead is BEHAVIOUR-PRESERVING: with the flag
 * off, or before any claim exists, this returns exactly the null those
 * expressions already produced. It does not start showing data — it gives the
 * surface a real wiring point for when claims begin to flow.
 *
 * THREE GATES, ALL FAIL-CLOSED, IN THIS ORDER:
 *   1. the `intel_live_label_crowd` flag (absent or unreadable => off);
 *   2. `privacy_eligible` on the snapshot row — the projection sets this only
 *      after lib/privacyGate.ts passes, and this read refuses anything else even
 *      if it somehow got written;
 *   3. `expires_at` — an expired snapshot is not live, and a claim past its TTL
 *      degrades to "unknown" rather than to a stale value presented as current.
 *
 * The degradation order the spec requires is Live -> Likely current ->
 * Historical -> Official -> Unknown. This module only ever returns a LIVE label
 * or null. It never invents a weaker-but-still-confident answer, and it never
 * substitutes a historical pattern for an observation — that distinction is what
 * SOURCE_CLASSES and mayRenderAsLive() exist to protect.
 */
import { isFlagEnabled, isKillSwitchEngaged } from "./featureFlags.js";
import { confidenceBand, MIN_BAND_FOR_LIVE_STATE, CONFIDENCE_BAND_FLOOR, type ConfidenceBand } from "./intelContracts.js";
import { logger } from "./logger.js";

export interface LiveClaim {
  claimType: string;
  value: unknown;
  confidence: number | null;
  band: ConfidenceBand;
  sourceCount: number;
  observedAt: string;
  expiresAt: string;
}

/**
 * Read the currently-live claims for a place. Returns an empty array whenever
 * anything is off, missing, expired or not privacy-eligible — never a partial
 * or stale answer dressed as current.
 */
export async function readLiveClaims(
  sc: any,
  subjectId: string | null | undefined,
  opts: { claimTypes?: readonly string[]; now?: Date } = {},
): Promise<LiveClaim[]> {
  if (!sc || !subjectId) return [];
  if (!(await isFlagEnabled(sc, "intel_live_label_crowd"))) return [];

  // IG-09 Limited-Live gating, both fail-closed and ahead of any snapshot read:
  //   • the global emergency stop suppresses every Live label without deleting
  //     records — read as a kill switch, so a DB error ENGAGES it;
  //   • Live is exposed only for a promoted pilot scope (intel_limited_live).
  // Until a scope clears the §26 density gate (a human-review promotion), the
  // pilot flag stays off and this returns [] — the correct pre-density default.
  if (await isKillSwitchEngaged(sc, "disable_intel_live_labels")) return [];
  if (!(await isFlagEnabled(sc, "intel_limited_live"))) return [];

  const now = opts.now ?? new Date();
  try {
    let q = sc
      .from("intel_state_snapshots")
      .select("claim_type, value, confidence, source_count, observed_at, expires_at, privacy_eligible")
      .eq("subject_id", subjectId)
      .eq("privacy_eligible", true)
      .gt("expires_at", now.toISOString());
    if (opts.claimTypes && opts.claimTypes.length > 0) {
      q = q.in("claim_type", opts.claimTypes);
    }
    const { data, error } = await q;
    if (error || !data) {
      // Fail-closed: an unreadable projection means "unknown", not "assume last known".
      logger.warn({ err: error }, "liveClaimRead: snapshot read failed");
      return [];
    }

    const out: LiveClaim[] = [];
    for (const row of data as any[]) {
      const confidence = typeof row.confidence === "number" ? row.confidence : null;
      const band = confidenceBand(confidence);
      // Below the live floor a claim is not shown as live at all.
      if (CONFIDENCE_BAND_FLOOR[band] < CONFIDENCE_BAND_FLOOR[MIN_BAND_FOR_LIVE_STATE]) continue;
      out.push({
        claimType: String(row.claim_type),
        value: row.value,
        confidence,
        band,
        sourceCount: typeof row.source_count === "number" ? row.source_count : 0,
        observedAt: String(row.observed_at),
        expiresAt: String(row.expires_at),
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveClaimRead: snapshot read threw");
    return [];
  }
}

/**
 * The crowd level for a place, or null when it is not live.
 * Null is the honest answer and is what every caller rendered before this
 * existed — see the header.
 */
export async function readLiveCrowdLevel(
  sc: any,
  subjectId: string | null | undefined,
  opts: { now?: Date } = {},
): Promise<string | null> {
  const claims = await readLiveClaims(sc, subjectId, { claimTypes: ["crowd.level"], now: opts.now });
  const crowd = claims.find((c) => c.claimType === "crowd.level");
  if (!crowd) return null;
  const v = crowd.value as any;
  const level = typeof v === "string" ? v : v?.level;
  return typeof level === "string" && level.length > 0 ? level : null;
}
