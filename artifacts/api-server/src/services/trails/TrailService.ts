/**
 * TrailService — the database face of `02_Trails.md`'s canonical Trail.
 *
 * ⚠ NOT THE INTELLIGENCE-GATHERING TRAIL. `lib/trailLiveIntel.ts` and
 * `GET /v1/trails/:id/live-intel` read `route_plans` / `route_stops` — one
 * trip's route, IG §19. This service reads `trails`, `content_trails`,
 * `trail_edges`, `trail_follows`, `trail_reports` and `trail_health_snapshots`
 * (migration 2910) and never touches route_plans. The two are different
 * objects that share four letters.
 *
 * WHAT THIS IS ALLOWED TO BE — the ruling, quoted
 * ==============================================
 * `docs/discovery/ROADMAP.md:148`: "Anything assuming the six P1 components are
 * **peer scoring systems**: STALE — must be re-scoped before implementation."
 * `docs/architecture/02_Trails.md:5-12`: "ROADMAP step 7 keeps trails only as a
 * future MODIFIER to the ranker, never a parallel engine."
 *
 * THERE IS NO SCORING FUNCTION IN THIS FILE. `02` §8's spotlight modules each
 * sort on exactly ONE already-existing value:
 *
 *   just_arrived   `content_trails.created_at`            — a column
 *   trending_now   `lib/discoveryLocalMomentum.loadLocalMomentum` — the
 *                  SHIPPING momentum loader, over `rank_events`, unchanged
 *   evergreen      `content_trails.confidence`            — a column
 *   local_picks    `content_trails.confidence`, curated rows only
 *
 * None of them combines signals, weights features, or produces a number that
 * did not already exist. Combining signals is what `lib/portavaRank.ts` does
 * and it stays the only thing that does it; a module that needed a blend would
 * hand its items to the ranker rather than grow one here. That line is the
 * difference between a spotlight and the parallel engine the ruling forbids,
 * and it is drawn deliberately rather than by accident.
 *
 * DEGRADATION IS THE DEFAULT, NOT AN EDGE CASE
 * ============================================
 * Migration 2910 is NOT applied to production. Every read below therefore has
 * to answer the question "what does this do when the table does not exist?",
 * and the answer is one refusal — `trails_unavailable` — which the routes turn
 * into 503 `degraded_unavailable`. Not 500, because nothing failed; not an
 * empty list, because an empty list is a claim that there are no Trails and
 * that claim would be false.
 *
 * census-discovery rows: DV-20, DV-21, DV-22, DV-23, DV-24, DV-25, DC-02,
 * DC-03, DC-04, DC-05, DC-20, DC-21.
 */
import { loadLocalMomentum } from "../../lib/discoveryLocalMomentum.js";
import {
  canonicaliseTrailProposal, capTrailLabels,
  isTrailLifecycleState, isTrailLifecycleTransitionAllowed,
  TRAIL_EDGE_TYPES, TRAIL_SOURCE_TYPES, TRAIL_RELATIONSHIPS,
  type ExistingTrail, type TrailCreationRefusal, type TrailLabel,
  type LabelRefusal, type TrailLifecycleState, type TrailRelationship,
} from "../../lib/discoveryTrailObject.js";
import {
  computeTrailHealth, trailHealthScale, trailStatusLabel,
  diversifyTrailPage, fairExposureSlots,
  TRAIL_HEALTH_MODEL_VERSION,
  type TrailHealth,
} from "../../lib/discoveryTrailHealth.js";
import {
  trailAffinityMap, trailMomentumFromRankEvents,
  type TrailMembershipRow,
} from "../../lib/discoveryTrailAffinity.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ mod: "trailService" });

export type TrailRefusal =
  | null
  | "no_service_client"
  | "trails_unavailable"
  | "unknown_trail"
  | "invalid_request"
  | "db_error";

/** Columns read from `trails`. Kept as one constant so no read drifts from another. */
const TRAIL_COLUMNS =
  "id, slug, title, description, destination, place_scope, parent_trail_id, lifecycle_status, created_by, created_at, updated_at";
/** Columns read from `content_trails`. */
const MEMBER_COLUMNS =
  "id, trail_id, source_type, source_id, relationship, signal, source, confidence, contributor_id, content_state, created_at";

export interface TrailRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  destination: string | null;
  place_scope: string | null;
  parent_trail_id: string | null;
  lifecycle_status: TrailLifecycleState;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberRow extends TrailMembershipRow {
  id: string;
  signal: string | null;
  source: string;
  contributor_id: string | null;
  content_state: string;
  created_at: string;
}

/**
 * "The table is not there" is not a failure — it is the state of every
 * deployment until 2910 is applied. PostgREST reports it as PGRST205 (schema
 * cache miss) or as Postgres 42P01; both are recognised, because which one
 * arrives depends on whether the schema cache has been reloaded, and a caller
 * that only knew one of them would 500 half the time.
 */
function isMissingRelation(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST205" || code === "PGRST200") return true;
  const msg = String(error.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("relation");
}

function refusalFor(error: any, where: string): TrailRefusal {
  if (isMissingRelation(error)) return "trails_unavailable";
  logger.warn({ where, code: error?.code, message: error?.message }, "trail read failed");
  return "db_error";
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface TrailListResult { refusal: TrailRefusal; trails: TrailRow[] }

/** `11` §3 action 1 — list/search Trails. */
export async function listTrails(
  sc: any,
  params: { destination?: string | null; query?: string | null; limit?: number },
): Promise<TrailListResult> {
  if (!sc) return { refusal: "no_service_client", trails: [] };
  const limit = Math.min(50, Math.max(1, params?.limit ?? 20));
  let q = sc.from("trails").select(TRAIL_COLUMNS)
    .neq("lifecycle_status", "archived")
    .order("created_at", { ascending: false })
    .limit(limit);
  const destination = typeof params?.destination === "string" ? params.destination.trim().toLowerCase() : "";
  if (destination) q = q.eq("destination", destination);
  const term = typeof params?.query === "string" ? params.query.trim() : "";
  // Search runs on the SLUG, not the title: the slug is the canonical handle
  // (DV-20), so searching it cannot return two rows for one theme.
  if (term) q = q.ilike("slug", `%${term.toLowerCase().replace(/[^a-z0-9-]/g, "-")}%`);

  const { data, error } = await q;
  if (error) return { refusal: refusalFor(error, "listTrails"), trails: [] };
  return { refusal: null, trails: (data ?? []) as TrailRow[] };
}

export interface TrailDetail {
  refusal: TrailRefusal;
  trail: TrailRow | null;
  health: TrailHealth | null;
  /** §12's user-facing word. Never a number — §12 forbids opaque quality scores. */
  status: string | null;
  /** The bounded ranking multiplier §11 permits, floored so it cannot erase. */
  healthScale: number;
  memberCount: number;
}

async function readTrail(sc: any, trailId: string): Promise<{ refusal: TrailRefusal; trail: TrailRow | null }> {
  const { data, error } = await sc.from("trails").select(TRAIL_COLUMNS).eq("id", trailId).maybeSingle();
  if (error) return { refusal: refusalFor(error, "readTrail"), trail: null };
  if (!data) return { refusal: "unknown_trail", trail: null };
  return { refusal: null, trail: data as TrailRow };
}

async function readMembers(sc: any, trailId: string): Promise<{ refusal: TrailRefusal; members: MemberRow[] }> {
  const { data, error } = await sc.from("content_trails").select(MEMBER_COLUMNS)
    .eq("trail_id", trailId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { refusal: refusalFor(error, "readMembers"), members: [] };
  return { refusal: null, members: (data ?? []) as MemberRow[] };
}

async function readOpenReportCount(sc: any, trailId: string): Promise<number> {
  const { data, error } = await sc.from("trail_reports").select("id").eq("trail_id", trailId).is("resolution", null);
  // A failed report read must not fail the Trail read. 0 is the honest floor:
  // it understates health risk rather than inventing one.
  if (error) return 0;
  return (data ?? []).length;
}

/** `11` §3 action 2 — get Trail, with §11 health and §12 status. */
export async function getTrail(sc: any, trailId: string, nowMs = Date.now()): Promise<TrailDetail> {
  const empty: TrailDetail = { refusal: null, trail: null, health: null, status: null, healthScale: 1, memberCount: 0 };
  if (!sc) return { ...empty, refusal: "no_service_client" };

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { ...empty, refusal: t.refusal };

  const m = await readMembers(sc, trailId);
  if (m.refusal) return { ...empty, refusal: m.refusal };

  const health = computeTrailHealth({
    members: m.members.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: await readOpenReportCount(sc, trailId),
    nowMs,
  });

  return {
    refusal: null,
    trail: t.trail,
    health,
    status: trailStatusLabel(t.trail.lifecycle_status, health),
    healthScale: trailHealthScale(health),
    memberCount: health.memberCount,
  };
}

/**
 * Persist one §11 health snapshot, at most one per Trail per hour.
 *
 * Fire-and-forget on a read path, which needs justifying rather than assuming:
 * the same shape `lib/discoveryServeLog.ts` already uses after a served
 * response. It is bounded (one row an hour per Trail), it carries the model
 * version that produced it (`10` §5), it never changes what was served, and a
 * failure is logged and swallowed — a diagnostic must not break a read.
 */
export async function recordTrailHealthSnapshot(
  sc: any, trailId: string, health: TrailHealth, nowMs = Date.now(),
): Promise<"written" | "skipped_recent" | "unavailable" | "failed"> {
  if (!sc || !health || health.memberCount === 0) return "skipped_recent";
  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data, error } = await sc.from("trail_health_snapshots").select("id")
    .eq("trail_id", trailId).gt("captured_at", since).limit(1);
  if (error) return isMissingRelation(error) ? "unavailable" : "failed";
  if ((data ?? []).length > 0) return "skipped_recent";

  const { error: writeError } = await sc.from("trail_health_snapshots").insert({
    trail_id: trailId,
    metrics: health.metrics,
    model_version: TRAIL_HEALTH_MODEL_VERSION,
    member_count: health.memberCount,
    // Written explicitly rather than left to the column default. `10` §5 asks a
    // derived feature to retain its COMPUTATION time, and the column default is
    // the database's clock at INSERT — a different instant from the `nowMs` the
    // metrics were computed against, and the gap is however long the read took.
    // Stamping the computation clock makes the hourly window below measure the
    // thing it names.
    captured_at: new Date(nowMs).toISOString(),
  });
  if (writeError) {
    if (isMissingRelation(writeError)) return "unavailable";
    logger.warn({ trailId, code: writeError.code, message: writeError.message }, "health snapshot write failed");
    return "failed";
  }
  return "written";
}

// ── §8 spotlight modules (DV-21, DV-22, DV-23, DV-13) ───────────────────────

export interface TrailModule {
  key: "just_arrived" | "trending_now" | "evergreen" | "local_picks";
  /** §8: "Each spotlight has its own objective and time horizon." */
  objective: "recency" | "momentum" | "durable_quality" | "curation";
  horizonMs: number | null;
  items: Array<{ id: string; sourceType: string; sourceId: string; contentState: string }>;
  /** §10's "more from this place" remainder for anything the diversity pass held back. */
  moreFromThisPlace: Record<string, number>;
  /** §9's reserved exploration slots on this module, when it has any. */
  explorationSlots: string[];
}

export interface TrailModulesResult {
  refusal: TrailRefusal;
  modules: TrailModule[];
  health: TrailHealth | null;
}

const DAY = 86_400_000;

/**
 * `11` §3 action 3 — get Trail modules. `02` §8's spotlight model.
 *
 * DV-21's criterion is "ranking is modular rather than chronological-only", and
 * the evidence is that the four modules have four DIFFERENT objectives, only
 * one of which is chronological. `trending_now` is ordered by the shipping
 * momentum loader over `rank_events` — the same numbers `GET /discovery` would
 * see — and `evergreen` / `local_picks` by a stored confidence. None of the
 * four is a score.
 *
 * Every module then passes through §10's diversity bound (DV-23 / DV-13) so one
 * creator or one place cannot own a spotlight, and `just_arrived` reserves §9's
 * bounded exploration slots (DV-22).
 */
export async function getTrailModules(
  sc: any, trailId: string, opts: { pageSize?: number; nowMs?: number } = {},
): Promise<TrailModulesResult> {
  if (!sc) return { refusal: "no_service_client", modules: [], health: null };
  const nowMs = opts.nowMs ?? Date.now();
  const pageSize = Math.min(20, Math.max(1, opts.pageSize ?? 8));

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, modules: [], health: null };
  const m = await readMembers(sc, trailId);
  if (m.refusal) return { refusal: m.refusal, modules: [], health: null };

  const health = computeTrailHealth({
    members: m.members.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: await readOpenReportCount(sc, trailId),
    nowMs,
  });

  // The ONE non-chronological ordering input, and it is borrowed rather than
  // built: the momentum loader `GET /discovery` already uses, over the same
  // `rank_events` rows, with its own cache key so it cannot evict Discovery's.
  const placeIds = m.members.filter((r) => r.source_type === "place").map((r) => r.source_id);
  let momentum: Record<string, number> = {};
  if (placeIds.length > 0) {
    try {
      momentum = await loadLocalMomentum(sc, placeIds, { cacheKey: `trail:${trailId}`, nowMs });
    } catch { momentum = {}; }
  }

  const toItem = (r: MemberRow) => ({
    id: r.id, sourceType: r.source_type, sourceId: r.source_id, contentState: r.content_state,
  });
  const saturationItem = (r: MemberRow) => ({
    id: r.id,
    placeId: r.source_type === "place" ? r.source_id : null,
    contributorId: r.contributor_id,
  });

  const build = (
    key: TrailModule["key"],
    objective: TrailModule["objective"],
    horizonMs: number | null,
    rows: MemberRow[],
  ): TrailModule => {
    const d = diversifyTrailPage(rows.map(saturationItem), { pageSize });
    const kept = new Set(d.page.map((i) => i.id));
    const items = rows.filter((r) => kept.has(r.id)).map(toItem);
    return { key, objective, horizonMs, items, moreFromThisPlace: d.moreFromThisPlace, explorationSlots: [] };
  };

  const byNewest = [...m.members].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const byConfidence = [...m.members].sort((a, b) => Number(b.confidence) - Number(a.confidence));
  const byMomentum = [...m.members].sort(
    (a, b) => (momentum[b.source_id] ?? 0) - (momentum[a.source_id] ?? 0),
  ).filter((r) => (momentum[r.source_id] ?? 0) > 0);

  const justArrived = build("just_arrived", "recency", 7 * DAY,
    byNewest.filter((r) => r.content_state === "just_arrived" || r.content_state === "rediscovered"));

  // §9 — the reserved opportunity, computed over the module's OWN candidates.
  // The denominators come from the momentum loader's impression counts only
  // where they exist; an unread item has denominator 0 and is `evaluating`,
  // never "performing badly".
  const exposure = fairExposureSlots(
    justArrived.items.map((i) => ({
      id: i.id, state: i.contentState, impressions: 0, positives: 0,
    })),
    { pageSize },
  );
  justArrived.explorationSlots = exposure.slots;

  return {
    refusal: null,
    health,
    modules: [
      justArrived,
      build("trending_now", "momentum", 2 * DAY, byMomentum),
      build("evergreen", "durable_quality", null,
        byConfidence.filter((r) => r.content_state === "evergreen" || r.content_state === "featured")),
      build("local_picks", "curation", null, byConfidence.filter((r) => r.source === "curated")),
    ],
  };
}

// ── `11` §3 action 9 / DV-24 — related Trails ───────────────────────────────

export interface RelatedTrailsResult {
  refusal: TrailRefusal;
  edges: Array<{ trail: TrailRow; edgeType: string; strength: number; direction: "out" | "in" }>;
}

/**
 * DV-24 — "Trail relationships are navigable". Navigable means BOTH directions:
 * a sub-Trail must be reachable from its parent and the parent from the
 * sub-Trail, or the graph is a list of one-way signs.
 */
export async function relatedTrails(sc: any, trailId: string): Promise<RelatedTrailsResult> {
  if (!sc) return { refusal: "no_service_client", edges: [] };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, edges: [] };

  const out = await sc.from("trail_edges").select("from_trail_id, to_trail_id, edge_type, strength").eq("from_trail_id", trailId);
  if (out.error) return { refusal: refusalFor(out.error, "relatedTrails.out"), edges: [] };
  const inc = await sc.from("trail_edges").select("from_trail_id, to_trail_id, edge_type, strength").eq("to_trail_id", trailId);
  if (inc.error) return { refusal: refusalFor(inc.error, "relatedTrails.in"), edges: [] };

  const rows = [
    ...((out.data ?? []) as any[]).map((e) => ({ other: e.to_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "out" as const })),
    ...((inc.data ?? []) as any[]).map((e) => ({ other: e.from_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "in" as const })),
  ];
  const ids = [...new Set(rows.map((r) => r.other))];
  if (ids.length === 0) return { refusal: null, edges: [] };

  const { data, error } = await sc.from("trails").select(TRAIL_COLUMNS).in("id", ids);
  if (error) return { refusal: refusalFor(error, "relatedTrails.trails"), edges: [] };
  const byId = new Map<string, TrailRow>((data ?? []).map((r: any) => [r.id as string, r as TrailRow]));

  return {
    refusal: null,
    edges: rows
      .map((r) => {
        const trail = byId.get(r.other);
        return trail ? { trail, edgeType: r.edgeType, strength: r.strength, direction: r.direction } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}

// ── `11` §4 — trending by Trail (DC-21, one of five actions) ────────────────

export interface TrailTrendingResult {
  refusal: TrailRefusal;
  /** Trail-level momentum in [0,1] from the SHIPPING momentum kernel, or null. */
  momentum: number | null;
  /** Member items with momentum, strongest first. Never a raw score to a client. */
  items: Array<{ id: string; sourceType: string; sourceId: string }>;
}

/**
 * `11` §4 action 2 — "trending by Trail". The other four actions of §4 are
 * another lane's (`03` Trending), and this closes ONE of the five; DC-21 is
 * reported accordingly rather than claimed whole.
 *
 * `11` §4: "Never return internal raw scores unless needed for admin
 * diagnostics." The `momentum` field is the TRAIL's aggregate, used by the
 * route to decide whether to say anything at all; per-item momentum is used for
 * ORDER and is never serialised. See routes/trails.ts.
 */
export async function trailTrending(sc: any, trailId: string, nowMs = Date.now()): Promise<TrailTrendingResult> {
  if (!sc) return { refusal: "no_service_client", momentum: null, items: [] };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, momentum: null, items: [] };
  const m = await readMembers(sc, trailId);
  if (m.refusal) return { refusal: m.refusal, momentum: null, items: [] };

  const itemIds = m.members.map((r) => r.source_id);
  if (itemIds.length === 0) return { refusal: null, momentum: null, items: [] };

  // The rows are `rank_events` rows, read through the momentum loader. Trail
  // momentum is those same rows folded onto the Trail — one kernel, two scopes,
  // no second velocity model (DV-25).
  let perItem: Record<string, number> = {};
  try {
    perItem = await loadLocalMomentum(sc, itemIds, { cacheKey: `trail:${trailId}`, nowMs });
  } catch { perItem = {}; }

  const { data, error } = await sc.from("rank_events")
    .select("item_id, outcome, served_at, outcome_at")
    .in("item_id", itemIds)
    .order("served_at", { ascending: false })
    .limit(1000);
  let trailMomentum: number | null = null;
  if (error) {
    if (isMissingRelation(error)) return { refusal: "trails_unavailable", momentum: null, items: [] };
    logger.warn({ trailId, code: error.code }, "trail trending event read failed");
  } else {
    const folded = trailMomentumFromRankEvents((data ?? []) as any[], m.members, nowMs);
    trailMomentum = folded[trailId] ?? null;
  }

  const items = [...m.members]
    .filter((r) => (perItem[r.source_id] ?? 0) > 0)
    .sort((a, b) => (perItem[b.source_id] ?? 0) - (perItem[a.source_id] ?? 0))
    .slice(0, 20)
    .map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id }));

  return { refusal: null, momentum: trailMomentum, items };
}

// ── The MODIFIER load (DV-18's trail_affinity producer) ─────────────────────

export interface TrailModifierResult {
  refusal: TrailRefusal;
  /** place id → affinity in [0,1]. The map a ranker would receive. */
  trailAffinity: Record<string, number>;
  followedTrailIds: string[];
}

/** A viewer with more followed Trails than this has the newest N read. */
export const MAX_FOLLOWED_TRAILS_PER_VIEWER = 50;
/**
 * Members read across the followed Trails, newest first.
 *
 * The affinity itself needs only the CANDIDATE places, and a filtered read
 * would be far smaller. It is deliberately not filtered: `02` §11 health is a
 * property of the WHOLE Trail — contributor concentration, duplicate density
 * and staleness are all counts over its full membership — so a health scale
 * computed from the handful of members that happen to be on this page would be
 * a different metric wearing §11's name. The bound is stated rather than
 * unlimited, and `memberCount` on each health record reports the denominator
 * the metrics were actually computed over.
 */
export const MAX_TRAIL_MEMBERS_SCANNED = 1000;
/** rank_events rows folded onto the followed Trails for DV-25 momentum. */
export const MAX_TRAIL_MOMENTUM_EVENTS = 1000;

/**
 * Open `trail_reports` counts for several Trails in ONE read.
 *
 * Non-fatal, and 0 is the honest floor for the same reason `readOpenReportCount`
 * gives: it understates health risk rather than inventing one, and a failed
 * diagnostic read must not change what a viewer is served.
 */
async function readOpenReportCounts(
  sc: any, trailIds: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { data, error } = await sc.from("trail_reports").select("id, trail_id")
    .in("trail_id", trailIds).is("resolution", null);
  if (error) return out;
  for (const r of (data ?? []) as any[]) {
    if (typeof r?.trail_id === "string") out[r.trail_id] = (out[r.trail_id] ?? 0) + 1;
  }
  return out;
}

/**
 * DV-25 — `rank_events` on the Trails' member items, folded onto the Trails.
 *
 * Returns `undefined` when the read FAILED and a map (possibly empty) when it
 * succeeded. The two are different facts and `trailAffinityMap` treats them
 * differently on purpose: an absent map is UNSCALED (no momentum information),
 * an empty map is measured-and-flat (the floor). Collapsing them would make a
 * failed read look like a cold Trail, which is the quiet kind of wrong.
 */
async function readTrailMomentum(
  sc: any, members: readonly TrailMembershipRow[], nowMs: number,
): Promise<Record<string, number> | undefined> {
  const itemIds = [...new Set(members.map((m) => m.source_id))];
  if (itemIds.length === 0) return {};
  try {
    const { data, error } = await sc.from("rank_events")
      .select("item_id, outcome, served_at, outcome_at")
      .in("item_id", itemIds)
      .order("served_at", { ascending: false })
      .limit(MAX_TRAIL_MOMENTUM_EVENTS);
    if (error) return undefined;
    return trailMomentumFromRankEvents((data ?? []) as any[], members, nowMs);
  } catch {
    return undefined;
  }
}

/**
 * The viewer's Trail modifier: which Trails they follow, and what per-place
 * affinity that implies. Bounded in lib/discoveryTrailAffinity.ts; this
 * function supplies the rows and the two scalings `02` requires on them.
 *
 * THIS IS THE PRODUCER `lib/discoveryReasonCodes.ts` USED TO SAY DOES NOT EXIST.
 * It is called by `lib/discoveryModifiers.loadDiscoveryModifiers` behind
 * `discovery_ranking_modifiers_enabled`, and its output reaches
 * `portavaRank.scoreCandidate` as `ViewerContext.trailAffinity`, where the cap
 * is applied. Nothing here orders anything: the ONE number per place is handed
 * to the existing ranker, which is the whole of what the re-scope permits.
 *
 * THE ACCESS CONTROL THAT LIVES IN THIS FUNCTION AND NOWHERE ELSE
 * ==============================================================
 * `trail_follows` carries RLS policy `trail_follows_own_select`
 * (`user_id = auth.uid()`) precisely because who follows a Trail is social
 * context DSV2's privacy section forbids disclosing. This read runs on the
 * SERVICE client, which bypasses RLS. The `.eq("user_id", viewerId)` below is
 * therefore not a convenience filter — it is the only thing standing where the
 * policy cannot, and removing it would hand every viewer every other viewer's
 * follows as ranking input. Pinned by "the read is scoped to the VIEWER" in
 * test/discoveryTrailRoutes.test.ts.
 */
export async function loadViewerTrailModifier(
  sc: any, viewerId: string, placeIds: readonly string[],
  opts: { nowMs?: number } = {},
): Promise<TrailModifierResult> {
  const none: TrailModifierResult = { refusal: null, trailAffinity: {}, followedTrailIds: [] };
  if (!sc) return { ...none, refusal: "no_service_client" };
  if (typeof viewerId !== "string" || viewerId.length === 0) return none;
  const ids = new Set((placeIds ?? []).filter((p) => typeof p === "string" && p.length > 0));
  if (ids.size === 0) return none;
  const nowMs = opts?.nowMs ?? Date.now();

  const follows = await sc.from("trail_follows").select("trail_id")
    .eq("user_id", viewerId)
    .limit(MAX_FOLLOWED_TRAILS_PER_VIEWER);
  if (follows.error) return { ...none, refusal: refusalFor(follows.error, "loadViewerTrailModifier.follows") };
  const followedTrailIds = ((follows.data ?? []) as any[]).map((r) => r.trail_id).filter(Boolean);
  if (followedTrailIds.length === 0) return none;

  const members = await sc.from("content_trails")
    .select("trail_id, source_type, source_id, relationship, confidence, contributor_id, content_state, created_at")
    .in("trail_id", followedTrailIds)
    .order("created_at", { ascending: false })
    .limit(MAX_TRAIL_MEMBERS_SCANNED);
  if (members.error) return { ...none, refusal: refusalFor(members.error, "loadViewerTrailModifier.members") };

  const raw = (members.data ?? []) as any[];
  const rows: TrailMembershipRow[] = raw.map((r) => ({
    trail_id: r.trail_id, source_type: r.source_type, source_id: r.source_id,
    relationship: r.relationship as TrailRelationship, confidence: Number(r.confidence),
  }));

  // `02` §11 — "Trail health should influence ranking". One health record per
  // followed Trail, over that Trail's own membership, turned into the bounded
  // multiplier §11 permits. The floor lives in trailHealthScale and is
  // re-applied inside trailAffinityMap, so no caller can erase a place here.
  const reportCounts = await readOpenReportCounts(sc, followedTrailIds);
  const healthScaleByTrail: Record<string, number> = {};
  for (const trailId of followedTrailIds) {
    const own = raw.filter((r) => r.trail_id === trailId);
    if (own.length === 0) continue;
    healthScaleByTrail[trailId] = trailHealthScale(computeTrailHealth({
      members: own.map((r) => ({
        source_id: r.source_id, contributor_id: r.contributor_id ?? null,
        confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
      })),
      reportCount: reportCounts[trailId] ?? 0,
      nowMs,
    }));
  }

  // DV-25 — behaviour → Trail momentum, through the SHIPPING kernel. Computed
  // over every member item (a Trail surges because of its posts as much as its
  // places) and applied to the candidate places below.
  const trailMomentum = await readTrailMomentum(sc, rows, nowMs);

  const affinityRows = rows.filter((r) => ids.has(r.source_id));
  return {
    refusal: null,
    trailAffinity: trailAffinityMap(followedTrailIds, affinityRows, {
      trailMomentum, trailHealthScale: healthScaleByTrail,
    }),
    followedTrailIds,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface ProposeTrailResult {
  refusal: TrailRefusal;
  trail: TrailRow | null;
  /** §5's four checks, when any refused. */
  canonicalisation: TrailCreationRefusal[];
  suggestedParentTrailId: string | null;
}

/**
 * `11` §3 action 7 — propose Trail. `02` §5's four canonicalization checks run
 * BEFORE the insert, against the Trails that already exist for the proposal's
 * destination plus any Trail whose slug already collides.
 *
 * The comparison set is deliberately NOT "all Trails": §5's checks 2, 3 and 4
 * are destination-scoped, and check 1 is caught by the UNIQUE slug constraint
 * even when the comparison set misses it. Reading every Trail to compare would
 * be an unbounded scan that gets slower exactly as the catalogue succeeds.
 */
export async function proposeTrail(
  sc: any,
  input: {
    title: string; destination: string | null; description?: string | null;
    /**
     * `02` §6 — declare this Trail a SUB-Trail of an existing one.
     *
     * A sub-Trail necessarily overlaps its parent: "Bangkok After Dark" →
     * "Rooftops" is §6's own example, and it shares the destination, the theme
     * words and the token set. So when a parent is declared, the overlap
     * refusals RAISED BY THAT PARENT are waived — they were the evidence that
     * this is a sub-Trail, and the proposer has now said so. Refusals raised by
     * any OTHER Trail still stand, and `duplicate_title_similarity` against the
     * parent stands too: a child that is a re-spelling of its parent is the
     * parent.
     */
    parentTrailId?: string | null;
  },
  proposerId: string | null,
): Promise<ProposeTrailResult> {
  const none: ProposeTrailResult = { refusal: null, trail: null, canonicalisation: [], suggestedParentTrailId: null };
  if (!sc) return { ...none, refusal: "no_service_client" };

  const destination = typeof input?.destination === "string" ? input.destination.trim().toLowerCase() : null;
  const peers = await sc.from("trails").select("id, slug, title, destination")
    .or(destination ? `destination.eq.${destination},destination.is.null` : "destination.is.null")
    .limit(500);
  if (peers.error) return { ...none, refusal: refusalFor(peers.error, "proposeTrail.peers") };

  const existing = ((peers.data ?? []) as any[]).map((r): ExistingTrail => ({
    id: r.id, slug: r.slug, title: r.title, destination: r.destination,
  }));
  const check = canonicaliseTrailProposal({ title: input?.title ?? "", destination }, existing);

  const parentId = typeof input?.parentTrailId === "string" && input.parentTrailId.length > 0
    ? input.parentTrailId : null;
  const parentExists = parentId !== null && existing.some((e) => e.id === parentId);
  const WAIVED_BY_PARENT = new Set(["existing_parent_child", "destination_overlap", "semantic_overlap"]);
  const refusals = parentExists
    ? check.refusals.filter((r) => !(WAIVED_BY_PARENT.has(r.check) && r.conflictsWith === parentId))
    : check.refusals;

  if (parentId !== null && !parentExists) {
    return {
      refusal: "invalid_request", trail: null, canonicalisation: [], suggestedParentTrailId: null,
    };
  }
  if (refusals.length > 0 || !check.slug) {
    return { refusal: null, trail: null, canonicalisation: refusals, suggestedParentTrailId: check.suggestedParentTrailId };
  }

  const { data, error } = await sc.from("trails").insert({
    slug: check.slug,
    title: String(input.title).trim(),
    description: typeof input?.description === "string" ? input.description.trim() : null,
    destination,
    parent_trail_id: parentId,
    created_by: proposerId,
    // §5's "canonicalization metadata" — WHICH checks ran and against how many
    // peers. A Trail that is later argued to be a duplicate can then be judged
    // on what was known when it was admitted, not on today's catalogue.
    canonicalization: {
      checks: ["duplicate_title_similarity", "destination_overlap", "semantic_overlap", "existing_parent_child"],
      comparedAgainst: existing.length,
      origin: proposerId ? "user" : "system",
      waivedByDeclaredParent: parentExists ? parentId : null,
    },
    lifecycle_status: "proposed",
  }).select(TRAIL_COLUMNS).maybeSingle();

  if (error) {
    // A UNIQUE slug collision is §5 check 1 arriving from the database rather
    // than from the comparison set. Reported as the same refusal, so a caller
    // cannot tell the two apart and cannot act on the difference.
    if (String(error.code) === "23505") {
      return {
        refusal: null, trail: null, suggestedParentTrailId: null,
        canonicalisation: [{ check: "duplicate_title_similarity", conflictsWith: null, similarity: 1 }],
      };
    }
    return { ...none, refusal: refusalFor(error, "proposeTrail.insert") };
  }

  const created = (data ?? null) as TrailRow | null;

  // §6, DV-24 — the NAVIGABLE relationship. `trails.parent_trail_id` is a
  // pointer; `trail_edges` is the graph, and `relatedTrails` walks it in both
  // directions from ONE row. Written here because this is the only place a
  // parent is ever declared, so `trail_edges` has a writer reachable from
  // POST /v1/discovery/trails rather than being a table nothing can fill —
  // which is what `check:writerless-reads` exists to refuse.
  if (created && parentId) {
    const { error: edgeError } = await sc.from("trail_edges").insert({
      from_trail_id: parentId,
      to_trail_id: created.id,
      edge_type: "child",
      strength: 1,
    });
    if (edgeError && String(edgeError.code) !== "23505") {
      // The Trail exists and its pointer is set; only the graph row is missing.
      // Logged rather than failing the creation, because undoing a committed
      // Trail to report an edge failure would lose the canonical object the
      // caller just earned.
      logger.warn(
        { trailId: created.id, parentId, code: edgeError.code, message: edgeError.message },
        "trail parent edge not written",
      );
    }
  }
  return { refusal: null, trail: created, canonicalisation: [], suggestedParentTrailId: null };
}

export interface AttachResult {
  refusal: TrailRefusal;
  attached: number;
  /** §4's cap refusals, per label. */
  capRefusals: LabelRefusal[];
}

/**
 * `11` §3 actions 5 and 6 — suggest Trail association / attach content.
 *
 * `02` §4's cap is checked HERE against the content's existing labels across
 * ALL Trails, and again by migration 2910's trigger. Both, deliberately: the
 * application check can explain which budget is full and the database check
 * cannot be bypassed by a future second write path.
 *
 * `confidence` is how the two actions differ. An ATTACH by the content's own
 * author is a statement; a SUGGESTION by a third party is a proposal, and it
 * enters at a lower confidence so §11's quality-to-noise metric and the
 * affinity weight both see the difference.
 */
export async function attachContentToTrail(
  sc: any,
  trailId: string,
  labels: ReadonlyArray<{ sourceType: string; sourceId: string; relationship: string; signal?: string | null }>,
  actor: { userId: string | null; mode: "attach" | "suggest" },
): Promise<AttachResult> {
  if (!sc) return { refusal: "no_service_client", attached: 0, capRefusals: [] };
  if (!Array.isArray(labels) || labels.length === 0) {
    return { refusal: "invalid_request", attached: 0, capRefusals: [] };
  }
  for (const l of labels) {
    if (!(TRAIL_SOURCE_TYPES as readonly string[]).includes(l?.sourceType)) {
      return { refusal: "invalid_request", attached: 0, capRefusals: [] };
    }
    if (!(TRAIL_RELATIONSHIPS as readonly string[]).includes(l?.relationship)) {
      return { refusal: "invalid_request", attached: 0, capRefusals: [] };
    }
  }

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, attached: 0, capRefusals: [] };

  // §4's budgets are per CONTENT, not per Trail, so the held labels are read
  // across every Trail this content already belongs to.
  const sourceIds = [...new Set(labels.map((l) => l.sourceId))];
  const held = await sc.from("content_trails").select("trail_id, relationship, signal, source_id")
    .in("source_id", sourceIds);
  if (held.error) return { refusal: refusalFor(held.error, "attach.held"), attached: 0, capRefusals: [] };

  const existingLabels: TrailLabel[] = ((held.data ?? []) as any[]).map((r) => ({
    relationship: r.relationship, trailId: r.trail_id, signal: r.signal ?? null,
  }));
  const proposed: TrailLabel[] = labels.map((l) => ({
    relationship: l.relationship as TrailRelationship,
    trailId,
    signal: l.relationship === "signal" ? (l.signal ?? null) : null,
  }));
  const capped = capTrailLabels(existingLabels, proposed);
  if (capped.accepted.length === 0) {
    return { refusal: null, attached: 0, capRefusals: capped.refusals };
  }

  const confidence = actor.mode === "attach" ? 0.8 : 0.4;

  // PAIRED BY IDENTITY, NOT BY POSITION. `capped.accepted` is a FILTERED subset
  // of `proposed`, so its index n is not the request's label n as soon as one
  // label is refused — and pairing positionally wrote the surviving label
  // against the REFUSED label's content: a row that satisfies every constraint,
  // passes every check, and is about the wrong place. Caught by
  // "a partially refused batch writes each surviving label against its OWN
  // content" in test/discoveryTrailRoutes.test.ts; do not reintroduce an index.
  const acceptedSet = new Set(capped.accepted);
  const rows = proposed
    .map((label, i) => ({ label, source: labels[i] }))
    .filter(({ label }) => acceptedSet.has(label))
    .map(({ label, source }) => ({
      trail_id: trailId,
      source_type: source.sourceType,
      source_id: source.sourceId,
      relationship: label.relationship,
      signal: label.signal,
      source: actor.userId ? "user" : "system",
      confidence,
      contributor_id: actor.userId,
      content_state: "just_arrived",
    }));

  const { error } = await sc.from("content_trails").insert(rows);
  if (error) {
    if (isMissingRelation(error)) return { refusal: "trails_unavailable", attached: 0, capRefusals: capped.refusals };
    // 23505 (the label unique index) and 23514 (the §4 trigger) are both "the
    // database refused this label", and both are reported as cap refusals
    // rather than as server errors: the caller did something the rules forbid.
    if (String(error.code) === "23505" || String(error.code) === "23514") {
      return {
        refusal: null, attached: 0,
        capRefusals: [...capped.refusals, ...capped.accepted.map((label) => ({ label, reason: "duplicate" as const }))],
      };
    }
    return { refusal: refusalFor(error, "attach.insert"), attached: 0, capRefusals: capped.refusals };
  }
  // §5 "community growth" → §7 `proposed → active`.
  //
  // Without this, no code path anywhere could move a Trail out of `proposed`:
  // the column would admit five values and four of them would be unreachable,
  // which is a vocabulary pretending to be a lifecycle. The first piece of
  // content is the promotion §5 already names, and it is the only one that
  // needs no admin — §15's other four moves are moderation actions and stay
  // with moderation.
  //
  // `moveTrailLifecycle` decides, not this function: `active → active` is a
  // no-op and is refused, and `archived` is terminal, so attaching content to
  // an archived Trail can never revive it. A failure here is logged and
  // swallowed — the content IS attached, and undoing that to report a lifecycle
  // write would lose the thing the caller asked for.
  if (t.trail.lifecycle_status === "proposed") {
    const moved = await moveTrailLifecycle(sc, trailId, "active");
    if (moved.refusal) {
      logger.warn({ trailId, refusal: moved.refusal }, "trail not promoted to active after first content");
    }
  }

  return { refusal: null, attached: rows.length, capRefusals: capped.refusals };
}

/** `11` §3 action 6 (detach half). Only the contributor of the row may detach it. */
export async function detachContentFromTrail(
  sc: any, trailId: string, contentTrailId: string, userId: string,
): Promise<{ refusal: TrailRefusal; detached: boolean }> {
  if (!sc) return { refusal: "no_service_client", detached: false };
  const { data, error } = await sc.from("content_trails").select("id, contributor_id")
    .eq("id", contentTrailId).eq("trail_id", trailId).maybeSingle();
  if (error) return { refusal: refusalFor(error, "detach.read"), detached: false };
  // Unknown and not-yours are the SAME answer: a stranger must not be able to
  // probe which membership rows exist by the shape of the refusal.
  if (!data || data.contributor_id !== userId) return { refusal: "unknown_trail", detached: false };

  const del = await sc.from("content_trails").delete().eq("id", contentTrailId);
  if (del.error) return { refusal: refusalFor(del.error, "detach.delete"), detached: false };
  return { refusal: null, detached: true };
}

/** `11` §3 action 4 — follow / unfollow Trail. */
export async function setTrailFollow(
  sc: any, trailId: string, userId: string, following: boolean,
): Promise<{ refusal: TrailRefusal; following: boolean }> {
  if (!sc) return { refusal: "no_service_client", following: false };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, following: false };

  if (!following) {
    const { error } = await sc.from("trail_follows").delete().eq("trail_id", trailId).eq("user_id", userId);
    if (error) return { refusal: refusalFor(error, "unfollow"), following: false };
    return { refusal: null, following: false };
  }
  const { error } = await sc.from("trail_follows").insert({ trail_id: trailId, user_id: userId });
  // 23505 is the follow already existing — idempotent, not an error.
  if (error && String(error.code) !== "23505") {
    return { refusal: refusalFor(error, "follow"), following: false };
  }
  return { refusal: null, following: true };
}

/** `11` §3 action 8 — report Trail/content mismatch (§15 intake). */
export async function reportTrail(
  sc: any,
  trailId: string,
  input: { reason: string; contentTrailId?: string | null },
  reporterId: string,
): Promise<{ refusal: TrailRefusal; reported: boolean }> {
  if (!sc) return { refusal: "no_service_client", reported: false };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, reported: false };

  const { error } = await sc.from("trail_reports").insert({
    trail_id: trailId,
    content_trail_id: input?.contentTrailId ?? null,
    reported_by: reporterId,
    reason: input?.reason,
    // `resolution` is deliberately NOT written: §15 makes resolving an admin
    // action, and a reporter who could set it would be closing their own report.
  });
  if (error) {
    if (String(error.code) === "23514") return { refusal: "invalid_request", reported: false };
    return { refusal: refusalFor(error, "reportTrail"), reported: false };
  }
  return { refusal: null, reported: true };
}

/**
 * `02` §7 lifecycle move, refused unless the transition relation allows it
 * (DC-04). Not exposed on any public route — §15 makes lifecycle an admin and
 * moderation action — but it is the one place the relation is enforced against
 * the database, so it lives with the other writes rather than in a route.
 */
export async function moveTrailLifecycle(
  sc: any, trailId: string, to: string,
): Promise<{ refusal: TrailRefusal; moved: boolean; from: TrailLifecycleState | null }> {
  if (!sc) return { refusal: "no_service_client", moved: false, from: null };
  if (!isTrailLifecycleState(to)) return { refusal: "invalid_request", moved: false, from: null };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, moved: false, from: null };
  const from = t.trail.lifecycle_status;
  if (!isTrailLifecycleTransitionAllowed(from, to)) {
    return { refusal: "invalid_request", moved: false, from };
  }
  const { error } = await sc.from("trails")
    .update({ lifecycle_status: to, updated_at: new Date().toISOString() })
    .eq("id", trailId);
  if (error) return { refusal: refusalFor(error, "moveTrailLifecycle"), moved: false, from };
  return { refusal: null, moved: true, from };
}

/** Exported for the route layer's validation, so the vocabulary has one home. */
export { TRAIL_EDGE_TYPES };
