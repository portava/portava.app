/**
 * Intelligence Gathering — coverage PRODUCER scheduler (IG-08).
 *
 * The autonomous pass that assembles real coverage-gap inputs and persists them.
 * Each run:
 *   1. reads live claims + recent observations + saved_places demand,
 *   2. assembles one (zone, claim-family) cell per present zone × tracked family
 *      (lib/coverageAssembly), scores each (lib/coverageScore),
 *   3. writes the scored GAPS (score > 0) to intel_coverage_snapshots — the read
 *      side the ops GET serves,
 *   4. and, only when intel_missions is ALSO on, generates a mission candidate for
 *      each fresh demand-spike-missing-family gap (deduped against open candidates).
 *
 * Gated on `intel_coverage`, fail-closed, self-rescheduling — the house scheduler
 * shape (see intelPromotionScheduler). Off ⇒ an inert no-op that writes nothing.
 * SHADOW: no client-facing surface; snapshots are admin-only (routes/intelCoverage).
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { computeCoverageScore } from "./coverageScore.js";
import { MISSION_TRIGGER_THRESHOLDS } from "./missionGeneration.js";
import { generateMissions } from "../services/intel/CoverageService.js";
import {
  buildCoverageCells, subjectZoneMembership, demandByZone, bridgeSaves, cityByZone, zoneKey,
  type ClaimRow, type ObsRow, type SaveRow,
} from "./coverageAssembly.js";

const COVERAGE_FLAG = "intel_coverage";
const STARTUP_DELAY_MS = 4 * 60 * 1000; // after promotion (2m) + projection (3m) so claims are fresh
const INTERVAL_MS = 10 * 60 * 1000;

const DEMAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;      // coverage-priority demand
const MISSION_DEMAND_WINDOW_MS = 6 * 60 * 60 * 1000;   // §16 mission spike window
const OBS_WINDOW_MS = 24 * 60 * 60 * 1000;             // recent evidence for diversity
// Freshness horizon for a snapshot: a still-real gap is rewritten every pass, so a
// horizon a few passes wide keeps it served while a gap that stops being written
// ages out of the read (and is pruned) instead of lingering as a false open gap.
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const MAX_CLAIMS = 5000;
const MAX_OBS = 20000;
const MAX_OPEN_MISSIONS = 5000;
const IN_CHUNK = 300;

const OPEN_MISSION_STATUSES = ["candidate", "dispatched", "accepted"] as const;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface CoveragePassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  zones: number;
  cells: number;
  snapshots: number;
  missionsCreated: number;
}

const FAMILY_QUESTION: Record<string, string> = {
  "crowd.level": "How busy is it right now?",
  "crowd.trajectory": "Is it filling up or emptying out right now?",
  "queue.wait": "How long is the wait right now?",
  "transit.condition": "What are transit conditions like right now?",
  "access.walk_in": "Can you walk in right now, or is it reservation-only?",
  "inventory.status": "Is what you came for available right now?",
  "service.wait": "How long is service taking right now?",
  "access.reservation": "Are reservations available right now?",
  "music.current": "What's the music like right now?",
  "price.cover": "Is there a cover charge right now?",
  "access.dress": "What's the dress code right now?",
  "crowd.mix": "What's the crowd like right now?",
  "experience.next_move": "Where are people heading next from here?",
};
const questionFor = (family: string): string =>
  FAMILY_QUESTION[family] ?? `What is the current ${family.replace(/[._]/g, " ")} here?`;

/** Fetch rows for an `in(column, ids)` filter in bounded chunks. */
async function fetchIn<T>(
  db: any, table: string, columns: string, column: string, ids: string[],
  refine?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    let q = db.from(table).select(columns).in(column, slice);
    if (refine) q = refine(q);
    const { data, error } = await q;
    if (error) throw error;
    if (data) out.push(...(data as T[]));
  }
  return out;
}

export async function runIntelCoveragePass(opts: { client?: any; now?: Date } = {}): Promise<CoveragePassResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see intelPromotionScheduler / intelRetentionScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: CoveragePassResult = { skipped: true, reason: null, zones: 0, cells: 0, snapshots: 0, missionsCreated: 0 };
  if (!db) return { ...empty, reason: "no_client" };
  if (!(await isFlagEnabled(db, COVERAGE_FLAG))) return { ...empty, reason: "disabled" };

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const obsWindowIso = new Date(nowMs - OBS_WINDOW_MS).toISOString();
  const demandWindowIso = new Date(nowMs - DEMAND_WINDOW_MS).toISOString();
  const missionWindowMs = nowMs - MISSION_DEMAND_WINDOW_MS;
  const expiresIso = new Date(nowMs + SNAPSHOT_TTL_MS).toISOString();

  try {
    // Prune snapshots past their horizon so the table cannot grow without bound
    // and a filled/undemanded gap ages out of the read. Non-fatal.
    const { error: pruneErr } = await db.from("intel_coverage_snapshots").delete().lt("expires_at", nowIso);
    if (pruneErr) logger.warn({ err: pruneErr }, "coverage pass: snapshot prune failed (non-fatal)");
    // 1. live-eligible claims (expiry filtered in assembly) + recent observations
    const { data: claimData, error: claimErr } = await db
      .from("intel_claims")
      .select("subject_id, zone_id, claim_type, status, confidence, observed_at, expires_at")
      .in("status", ["active", "conflicting"])
      .limit(MAX_CLAIMS);
    if (claimErr) { logger.warn({ err: claimErr }, "coverage pass: claim read failed"); return { ...empty, reason: "error" }; }
    const claims = (claimData ?? []) as ClaimRow[];

    const { data: obsData, error: obsErr } = await db
      .from("intel_observations")
      .select("subject_id, zone_id, claim_type, actor_id, group_key, observed_at")
      .gte("observed_at", obsWindowIso)
      .limit(MAX_OBS);
    if (obsErr) { logger.warn({ err: obsErr }, "coverage pass: observation read failed"); return { ...empty, reason: "error" }; }
    const observations = (obsData ?? []) as ObsRow[];

    // Distinct subjects (places) and zones present in the intel corpus.
    const subjectIds = new Set<string>();
    for (const c of claims) if (c.subject_id) subjectIds.add(c.subject_id);
    for (const o of observations) if (o.subject_id) subjectIds.add(o.subject_id);
    const zones: (string | null)[] = [];
    { const zk = new Set<string>();
      for (const c of claims) if (!zk.has(zoneKey(c.zone_id))) { zk.add(zoneKey(c.zone_id)); zones.push(c.zone_id); }
      for (const o of observations) if (!zk.has(zoneKey(o.zone_id))) { zk.add(zoneKey(o.zone_id)); zones.push(o.zone_id); } }
    if (subjectIds.size === 0) {
      return { skipped: false, reason: null, zones: 0, cells: 0, snapshots: 0, missionsCreated: 0 };
    }
    const subjects = [...subjectIds];

    // 2. demand (saves) + place cities. saved_places keys the DISCOVERY id space
    //    (discovery_places.id) while intel subjects key the CANONICAL space
    //    (places.id); bridge via discovery_places.canonical_location_id so a save
    //    is attributed to the canonical subject the intel corpus uses. Without this
    //    the .in() join matches nothing and demand is silently always 0.
    const discoveryRows = await fetchIn<{ id: string; canonical_location_id: string | null }>(
      db, "discovery_places", "id, canonical_location_id", "canonical_location_id", subjects,
    );
    const discoveryToCanonical = new Map<string, string>();
    const discoveryIds: string[] = [];
    for (const d of discoveryRows) {
      if (d.canonical_location_id) { discoveryToCanonical.set(d.id, d.canonical_location_id); discoveryIds.push(d.id); }
    }
    const rawSaves = discoveryIds.length
      ? await fetchIn<SaveRow>(db, "saved_places", "place_id, saved_at", "place_id", discoveryIds,
          (q) => q.gte("saved_at", demandWindowIso))
      : [];
    const saves = bridgeSaves(rawSaves, discoveryToCanonical); // now keyed by canonical subject id

    const placeRows = await fetchIn<{ id: string; city: string | null }>(
      db, "places", "id, city", "id", subjects,
    );
    const placeCity = new Map<string, string | null>(placeRows.map((p) => [p.id, p.city]));

    const membership = subjectZoneMembership(observations, claims);
    const demand = demandByZone(saves, membership);
    const demand6h = demandByZone(saves.filter((s) => Date.parse(s.saved_at) >= missionWindowMs), membership);
    const city = cityByZone(membership, placeCity);

    // 3. assemble + score cells; persist only real gaps (score > 0)
    const cells = buildCoverageCells({ zones, claims, observations, demand, city, nowMs });
    const scored = cells.map((cell) => ({ cell, breakdown: computeCoverageScore(cell) }));
    const gaps = scored.filter((s) => s.breakdown.score > 0);

    if (gaps.length > 0) {
      const rows = gaps.map(({ cell, breakdown }) => ({
        city: cell.city,
        zone_id: cell.zoneId,
        claim_family: cell.claimFamily,
        demand_events: cell.demandEvents,
        claim_missing: cell.claimMissing,
        freshest_age_ratio: cell.freshestAgeRatio ?? null,
        current_confidence: cell.currentConfidence,
        required_confidence: cell.requiredConfidence ?? null,
        top_contributor_share: cell.topContributorShare,
        score: breakdown.score,
        demand_weight: breakdown.demandWeight,
        freshness_gap: breakdown.freshnessGap,
        claim_importance: breakdown.claimImportance,
        confidence_gap: breakdown.confidenceGap,
        source_diversity_gap: breakdown.sourceDiversityGap,
        computed_at: nowIso,
        expires_at: expiresIso,
      }));
      const { error: insErr } = await db.from("intel_coverage_snapshots").insert(rows);
      if (insErr) { logger.warn({ err: insErr }, "coverage pass: snapshot write failed"); return { ...empty, reason: "error" }; }
    }

    // 4. mission generation — only the demand-spike-missing-family gaps, deduped
    //    against open candidates. generateMissions re-checks intel_missions (off ⇒
    //    no missions even while coverage snapshots are being written).
    const { data: openData, error: openErr } = await db
      .from("intel_mission_candidates")
      .select("zone_id, claim_family, status")
      .in("status", OPEN_MISSION_STATUSES as unknown as string[])
      .limit(MAX_OPEN_MISSIONS);

    // Fail-closed on the dedup read: if we cannot read open candidates (error, or
    // more than we capped), an empty openKey would let generateMissions insert
    // DUPLICATES for gaps that already have an open candidate. Skip mission
    // generation this pass rather than risk duplicates (snapshots still wrote).
    const openReadOk = !openErr && (openData ?? []).length < MAX_OPEN_MISSIONS;
    const openKey = new Set((openData ?? []).map((r: any) => `${zoneKey(r.zone_id)}|${r.claim_family}`));
    if (openErr) logger.warn({ err: openErr }, "coverage pass: open-mission read failed; skipping mission generation");
    else if (!openReadOk) logger.warn({ cap: MAX_OPEN_MISSIONS }, "coverage pass: open-mission cap hit; skipping mission generation to avoid duplicates");

    const needing = !openReadOk ? [] : gaps.filter(({ cell }) =>
      cell.claimMissing &&
      (demand6h.get(zoneKey(cell.zoneId)) ?? 0) >= MISSION_TRIGGER_THRESHOLDS.minDemandEvents6h &&
      !openKey.has(`${zoneKey(cell.zoneId)}|${cell.claimFamily}`),
    );

    let missionsCreated = 0;
    if (needing.length > 0) {
      const specs = needing.map(({ cell, breakdown }) => ({
        ctx: {
          qualifiedDemandEvents6h: demand6h.get(zoneKey(cell.zoneId)) ?? 0,
          requiredLiveFamilyMissing: cell.claimMissing,
          pendingDecisionsAffectedByContradiction: 0,
          criticalClaimStale: false,
          criticalClaimInActivePlan: false,
          campaignHasExplicitBudget: false,
          campaignHasAcceptanceContract: false,
        },
        mission: {
          city: cell.city,
          zoneId: cell.zoneId,
          claimFamily: cell.claimFamily,
          trigger: "demand_spike_missing_family" as const,
          coverageScore: breakdown.score,
          question: questionFor(cell.claimFamily),
          budgetUnits: 0,
        },
      }));
      const out = await generateMissions(db, specs);
      if (out.ok) missionsCreated = out.created.length;
    }

    if (gaps.length > 0 || missionsCreated > 0) {
      logger.info({ zones: zones.length, cells: cells.length, snapshots: gaps.length, missionsCreated }, "coverage pass complete");
    }
    return { skipped: false, reason: null, zones: zones.length, cells: cells.length, snapshots: gaps.length, missionsCreated };
  } catch (err) {
    logger.warn({ err }, "coverage pass threw");
    return { ...empty, reason: "error" };
  }
}

export function startIntelCoverageScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: COVERAGE_FLAG },
    "IntelCoverageScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelCoveragePass()
      .catch((err) => logger.warn({ err }, "coverage pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelCoverageScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
