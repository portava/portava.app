/**
 * HiddenGemContributionService
 *
 * The §16.3 structured-contribution write path and the read-time gem
 * intelligence projection (10-state + numeric confidence).
 *
 * A contribution is an OBSERVATION. recordGemContribution writes a row into
 * hidden_gem_contributions and NOTHING ELSE — it never touches the gem's
 * canonical status / verification_level / sensitivity. The derived state and
 * confidence are computed at READ time from these observations plus the gem's
 * existing signals (verifications, visits, crowd_level, counts), so they can
 * never drift from a stored copy. The pure math lives in lib/hiddenGemState.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordTrustEvent } from "../trust/TrustEventService.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  deriveHiddenGemState,
  deriveGemConfidence,
  isGemContributionType,
  POSITIVE_CONTRIBUTIONS,
  NEGATIVE_CONTRIBUTIONS,
  GEM_CONTRIBUTION_TYPES,
  type GemContributionType,
  type HiddenGemState,
} from "../../lib/hiddenGemState.js";

const logger = rootLogger.child({ service: "HiddenGemContributionService" });

const MS_PER_DAY = 86_400_000;

export interface RecordContributionResult {
  ok: boolean;
  contributionId: string | null;
  /** true when the caller had already observed this type for this gem. */
  alreadyObserved: boolean;
  error?: string;
}

/**
 * Record a structured §16.3 contribution as an observation.
 *
 * Guarantees:
 *  - the gem must exist and be active (or owned by the caller) to accept it;
 *  - the row is an observation only — canonical status/verification are NEVER
 *    changed here, so a single contribution cannot flip the gem's state;
 *  - re-observing the same type refreshes the timestamp (upsert), keeping
 *    distinct-contributor counts honest.
 */
export async function recordGemContribution(
  db: SupabaseClient,
  gemId: string,
  userId: string,
  contributionType: string,
  notes?: string | null,
): Promise<RecordContributionResult> {
  if (!isGemContributionType(contributionType)) {
    return { ok: false, contributionId: null, alreadyObserved: false, error: "invalid_contribution_type" };
  }

  const { data: gem, error: gemErr } = await db
    .from("hidden_gems")
    .select("id, status, submitted_by")
    .eq("id", gemId)
    .maybeSingle();

  if (gemErr) {
    logger.warn({ err: gemErr, gemId }, "recordGemContribution: gem lookup failed");
    return { ok: false, contributionId: null, alreadyObserved: false, error: "db_error" };
  }
  if (!gem) {
    return { ok: false, contributionId: null, alreadyObserved: false, error: "gem_not_found" };
  }
  if ((gem as any).status !== "active" && (gem as any).submitted_by !== userId) {
    return { ok: false, contributionId: null, alreadyObserved: false, error: "gem_not_active" };
  }

  // Was this (gem,user,type) already observed? Purely to report alreadyObserved
  // to the caller; the upsert below is authoritative either way.
  const { data: existing } = await db
    .from("hidden_gem_contributions")
    .select("id")
    .eq("gem_id", gemId)
    .eq("user_id", userId)
    .eq("contribution_type", contributionType)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const { data: upserted, error: upsertErr } = await db
    .from("hidden_gem_contributions")
    .upsert(
      {
        gem_id: gemId,
        user_id: userId,
        contribution_type: contributionType,
        notes: notes ?? null,
        updated_at: nowIso,
      },
      { onConflict: "gem_id,user_id,contribution_type" },
    )
    .select("id")
    .single();

  if (upsertErr) {
    logger.warn({ err: upsertErr, gemId, userId, contributionType }, "recordGemContribution: upsert failed");
    return { ok: false, contributionId: null, alreadyObserved: !!existing, error: "db_error" };
  }

  // Credit the contributor's community-value trust (fire-and-forget; flag-gated
  // internally). A wide dedup window prevents observation spam from farming trust.
  void recordTrustEvent(db, {
    userId,
    eventType: "gem_contribution",
    category: "community_value",
    delta: 1,
    severity: "minor",
    sourceType: "hidden_gem",
    sourceId: gemId,
    dedupWindowHours: 24,
    metadata: { contributionType },
  }).catch(() => { /* non-fatal — the observation is already recorded */ });

  return { ok: true, contributionId: (upserted as any)?.id ?? null, alreadyObserved: !!existing };
}

// ── Read-time projection ─────────────────────────────────────────────────────

export interface GemProjection {
  gemState: HiddenGemState;
  gemConfidence: {
    score: number;
    band: string;
  };
  /** Per-type independent-observation counts (each row is a distinct user). */
  contributionCounts: Partial<Record<GemContributionType, number>>;
}

interface GemAggregate {
  approvedConfirmations: number;
  distinctConfirmers: Set<string>;
  lastConfirmationMs: number | null;
  totalVisits: number;
  suspiciousVisits: number;
  contributionCounts: Partial<Record<GemContributionType, number>>;
  positiveContributions: number;
  negativeContributions: number;
}

function emptyAggregate(): GemAggregate {
  return {
    approvedConfirmations: 0,
    distinctConfirmers: new Set<string>(),
    lastConfirmationMs: null,
    totalVisits: 0,
    suspiciousVisits: 0,
    contributionCounts: {},
    positiveContributions: 0,
    negativeContributions: 0,
  };
}

/**
 * Gather per-gem observation aggregates for a batch of gem ids in a fixed
 * number of queries (no N+1). Confirmations = approved GPS/guide/admin
 * verifications AND positive structured contributions.
 */
async function batchFetchGemAggregates(
  db: SupabaseClient,
  gemIds: string[],
): Promise<Map<string, GemAggregate>> {
  const out = new Map<string, GemAggregate>();
  if (gemIds.length === 0) return out;
  for (const id of gemIds) out.set(id, emptyAggregate());

  const [verRes, visRes, conRes] = await Promise.all([
    db
      .from("hidden_gem_verifications")
      .select("gem_id, user_id, result, created_at")
      .in("gem_id", gemIds)
      .eq("result", "approved"),
    db
      .from("hidden_gem_visits")
      .select("gem_id, is_suspicious")
      .in("gem_id", gemIds),
    db
      .from("hidden_gem_contributions")
      .select("gem_id, user_id, contribution_type, updated_at")
      .in("gem_id", gemIds),
  ]);

  if (verRes.error) logger.warn({ err: verRes.error }, "gem aggregate: verifications read failed (non-fatal)");
  if (visRes.error) logger.warn({ err: visRes.error }, "gem aggregate: visits read failed (non-fatal)");
  if (conRes.error) logger.warn({ err: conRes.error }, "gem aggregate: contributions read failed (non-fatal)");

  for (const row of (verRes.data ?? []) as any[]) {
    const a = out.get(row.gem_id);
    if (!a) continue;
    a.approvedConfirmations += 1;
    if (row.user_id) a.distinctConfirmers.add(row.user_id as string);
    const t = row.created_at ? Date.parse(row.created_at) : NaN;
    if (Number.isFinite(t)) a.lastConfirmationMs = Math.max(a.lastConfirmationMs ?? 0, t);
  }

  for (const row of (visRes.data ?? []) as any[]) {
    const a = out.get(row.gem_id);
    if (!a) continue;
    a.totalVisits += 1;
    if (row.is_suspicious) a.suspiciousVisits += 1;
  }

  for (const row of (conRes.data ?? []) as any[]) {
    const a = out.get(row.gem_id);
    if (!a) continue;
    const type = row.contribution_type as GemContributionType;
    if (!(GEM_CONTRIBUTION_TYPES as readonly string[]).includes(type)) continue;
    a.contributionCounts[type] = (a.contributionCounts[type] ?? 0) + 1;
    if (POSITIVE_CONTRIBUTIONS.has(type)) {
      a.positiveContributions += 1;
      // Positive contributions also count as confirmations.
      if (row.user_id) a.distinctConfirmers.add(row.user_id as string);
      const t = row.updated_at ? Date.parse(row.updated_at) : NaN;
      if (Number.isFinite(t)) a.lastConfirmationMs = Math.max(a.lastConfirmationMs ?? 0, t);
    } else if (NEGATIVE_CONTRIBUTIONS.has(type)) {
      a.negativeContributions += 1;
    }
  }

  return out;
}

function projectGem(gem: any, agg: GemAggregate, nowMs: number): GemProjection {
  const positiveConfirmations = agg.approvedConfirmations + agg.positiveContributions;
  const daysSinceLastConfirmation =
    agg.lastConfirmationMs != null
      ? Math.max(0, (nowMs - agg.lastConfirmationMs) / MS_PER_DAY)
      : null;

  const hasCoords =
    (gem.latitude != null && gem.longitude != null) ||
    (gem.approx_latitude != null && gem.approx_longitude != null);

  const gemState = deriveHiddenGemState({
    status: gem.status,
    crowdLevel: gem.crowd_level,
    daysSinceLastConfirmation,
    confirmationCount: positiveConfirmations,
    saveCount: gem.save_count,
    visitCount: gem.visit_count,
    contributionCounts: agg.contributionCounts,
  });

  const confidence = deriveGemConfidence({
    verificationLevel: gem.verification_level,
    approvedConfirmations: positiveConfirmations,
    distinctConfirmers: agg.distinctConfirmers.size,
    daysSinceLastConfirmation,
    suspiciousVisitRatio: agg.totalVisits > 0 ? agg.suspiciousVisits / agg.totalVisits : 0,
    positiveContributions: agg.positiveContributions,
    negativeContributions: agg.negativeContributions,
    hasCanonicalPlace: !!gem.canonical_place_id,
    hasCoords,
    hasMedia: !!gem.image_url,
    // No paid-promotion path exists for gems yet; wired as false so that when
    // one arrives it can only ever penalise confidence, never raise it.
    paidPromoted: false,
    // save_count is passed but ignored by deriveGemConfidence — popularity is
    // not evidence (§16.2).
    saveCount: gem.save_count,
  });

  return {
    gemState,
    gemConfidence: { score: confidence.confidence, band: confidence.band },
    contributionCounts: agg.contributionCounts,
  };
}

/**
 * Derive the intelligence projection (state + confidence) for a batch of RAW
 * gem rows. Pass the rows BEFORE the privacy guard strips coords, or after —
 * this reads no coordinate values beyond presence, so it is privacy-neutral.
 * `nowMs` is injectable for determinism.
 */
export async function batchDeriveGemProjections(
  db: SupabaseClient,
  gems: any[],
  nowMs: number = Date.now(),
): Promise<Map<string, GemProjection>> {
  const out = new Map<string, GemProjection>();
  const ids = gems.map((g) => g?.id as string).filter(Boolean);
  if (ids.length === 0) return out;
  const aggs = await batchFetchGemAggregates(db, ids);
  for (const gem of gems) {
    const id = gem?.id as string;
    if (!id) continue;
    out.set(id, projectGem(gem, aggs.get(id) ?? emptyAggregate(), nowMs));
  }
  return out;
}

/** Derive the projection for a single RAW gem row. */
export async function deriveGemProjection(
  db: SupabaseClient,
  gem: any,
  nowMs: number = Date.now(),
): Promise<GemProjection> {
  const map = await batchDeriveGemProjections(db, [gem], nowMs);
  return (
    map.get(gem?.id) ?? {
      gemState: "still_hidden",
      gemConfidence: { score: 0, band: "unverified" },
      contributionCounts: {},
    }
  );
}
