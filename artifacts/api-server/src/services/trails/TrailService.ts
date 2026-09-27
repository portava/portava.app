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
 *   trending_now   `lib/discoveryLocalMomentum.computeLocalMomentum` — the
 *                  SHIPPING momentum kernel, over `rank_events`, unchanged
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
import {
  computeLocalMomentum, MOMENTUM_BASELINE_WINDOW_MS, MOMENTUM_PAGE_SIZE, MOMENTUM_ROW_LIMIT,
  type MomentumRow,
} from "../../lib/discoveryLocalMomentum.js";
import type { DerivedStoreProvenance } from "../../lib/discoveryRankProvenance.js";
import {
  canonicaliseTrailProposal, canonicalTrailSlug, capTrailLabels, DUPLICATE_TITLE_SIMILARITY,
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
import { fetchBlockedSet, submitterIsVisible } from "../../lib/blocks.js";
import { decidePostReadable, isPostPublished } from "../../lib/postVisibility.js";
import { NON_ACTIVE_ACCOUNT_STATUSES } from "../../lib/mediaEligibility.js";

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
/** Trails read as one proposal's comparison set; a full read is logged as truncated. */
const MAX_PROPOSAL_PEERS = 1000;

/**
 * A value for a PostgREST logical filter (`or=(…)`), double-quoted with `"` and
 * `\` escaped — PostgREST's own quoting rule for reserved characters. Unquoted,
 * a comma or parenthesis in user text rewrites the filter it is spliced into.
 */
function postgrestQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

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

/**
 * One Trail by id.
 *
 * AN ARCHIVED TRAIL IS NOT VISIBLE (census-discovery §51). 2910's RLS policy
 * `trails_public_select` hides it from every signed-in client
 * (`USING (lifecycle_status <> 'archived')`) and `listTrails` already drops
 * it, but every read in this file runs on the SERVICE client, which bypasses
 * RLS — so GET …/:id, …/modules, …/trending, follow, attach, suggest and report
 * all served and wrote to a Trail the database says no client may see. The
 * predicate is restated here, where the policy cannot reach, for the same
 * reason `loadViewerTrailModifier` restates `trail_follows_own_select`: an
 * archived Trail is `unknown_trail` to every viewer-facing caller. Only the
 * lifecycle writer passes `includeArchived`, so §7's terminal state refuses a
 * move instead of pretending the Trail is not there.
 */
async function readTrail(
  sc: any, trailId: string, opts: { includeArchived?: boolean } = {},
): Promise<{ refusal: TrailRefusal; trail: TrailRow | null }> {
  const { data, error } = await sc.from("trails").select(TRAIL_COLUMNS).eq("id", trailId).maybeSingle();
  if (error) return { refusal: refusalFor(error, "readTrail"), trail: null };
  if (!data) return { refusal: "unknown_trail", trail: null };
  if (!opts.includeArchived && (data as TrailRow).lifecycle_status === "archived") {
    return { refusal: "unknown_trail", trail: null };
  }
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

/**
 * Open `trail_reports` rows for one Trail, or `null` when the read FAILED.
 *
 * supabase-js RESOLVES on a database error, so `{ data, error }` with the error
 * discarded makes a failed read byte-identical to "no rows" — and `0` here is
 * not a neutral floor, it is the claim "this Trail has no open reports", which
 * `computeTrailHealth` turns into `report_rate: 0` and `trailHealthScale` turns
 * into a HIGHER multiplier on served rank. An outage would have flattered
 * exactly the Trails it could not read. A failed diagnostic must still not fail
 * the Trail read, so the refusal is not raised — it is REPORTED, as `null`,
 * which `computeTrailHealth` records as unmeasured rather than as clean.
 */
async function readOpenReportCount(sc: any, trailId: string): Promise<number | null> {
  const { data, error } = await sc.from("trail_reports").select("id, reported_by, content_trail_id")
    .eq("trail_id", trailId).is("resolution", null);
  if (error) {
    logger.warn({ trailId, code: error?.code, message: error?.message }, "trail report count unread");
    return null;
  }
  return distinctReportCount((data ?? []) as any[]);
}

// ── What a viewer may be SERVED of a Trail (census-discovery §51) ───────────

/** A member the viewer may be served, with the two identities §10 needs. */
export interface ServableMember extends MemberRow {
  /**
   * The person the CONTENT belongs to — a post's author, an event's host, a
   * route's owner, a community place's submitter — or null where the source
   * type has no author column (a canonical `places` row, an itinerary). §10's
   * "diversify creators" and DV-13's "one creator" mean THIS person, not the
   * contributor who attached the row: an author whose posts were suggested by
   * ten different users is one creator, and was ten under a contributor cap.
   */
  creatorId: string | null;
  /**
   * §10's "cluster by place": a place member's own id; a post's canonical place
   * (or, failing that, its location place); otherwise null. Posts carried NO
   * place here before, so §10's own case — "many near-duplicate POSTS" about
   * one place — was never clustered at all.
   */
  clusterPlaceId: string | null;
}

/**
 * The members a Trail may SERVE, to one viewer. Three rules, each the one the
 * rest of the product already applies, none invented here:
 *
 *  REVOCATION   A member whose source was removed or hidden after it was
 *               attached is not served. `content_trails.source_id` has no
 *               foreign key (it is polymorphic), so a deleted, tombstoned,
 *               unpublished, not-yet-due or non-public post, and an event or
 *               route whose row is gone, stayed in every module for ever. The
 *               post rules are lib/postVisibility.ts's (`decidePostReadable`,
 *               `isPostPublished`) plus the status / deleted / tombstoned /
 *               publish_at gates lib/mediaEligibility.ts applies; a Trail is a
 *               public space, so trip-only and followers-only posts are served
 *               to their author and to no one else (the fail-closed default of
 *               `decidePostReadable` when membership is not resolved).
 *  BLOCKS       lib/blocks.ts's symmetric rule (`submitterIsVisible`): a member
 *               contributed OR created by someone the viewer blocked, or who
 *               blocked the viewer, is not served to them; an unreadable block
 *               list withholds every member that carries a person.
 *  STANDING     A creator whose account is not `active` is not distributed —
 *               the rule GET /discovery/community and the media feeds apply
 *               (NON_ACTIVE_ACCOUNT_STATUSES); unreadable standing withholds
 *               every member that has a creator.
 *
 * FAIL CLOSED on every read: a source table that cannot be read withholds the
 * members it would have vouched for, because serving an unverified member is
 * the leak these rules exist to prevent. A `place` id may name a
 * `discovery_places` row or a canonical `places` row — 2910 does not say which,
 * and attach does not check — so a place absent from `discovery_places` is
 * served as an authorless venue fact rather than treated as removed; an
 * `itinerary` has no table at all. Both are named in §51 as residuals.
 */
async function servableMembers(
  sc: any, members: readonly MemberRow[], viewerId: string | null, nowMs: number = Date.now(),
): Promise<ServableMember[]> {
  const idsOf = (type: string) => [...new Set(members.filter((m) => m.source_type === type).map((m) => m.source_id))];
  const readRows = async (table: string, cols: string, ids: string[]): Promise<Map<string, any> | null> => {
    if (ids.length === 0) return new Map();
    const { data, error } = await sc.from(table).select(cols).in("id", ids);
    if (error || !Array.isArray(data)) {
      logger.warn({ table, code: error?.code, message: error?.message }, "trail member sources unread — withheld");
      return null;
    }
    return new Map((data as any[]).map((r) => [String(r.id), r]));
  };

  const [posts, events, routes, places] = await Promise.all([
    readRows("posts", "id, author_id, visibility, status, post_status, deleted_at, tombstoned_at, publish_at, trip_id, canonical_place_id, location_place_id", idsOf("post")),
    readRows("events", "id, host_id", idsOf("event")),
    readRows("route_plans", "id, owner_user_id", idsOf("route")),
    readRows("discovery_places", "id, submitted_by", idsOf("place")),
  ]);

  const resolved: ServableMember[] = [];
  for (const m of members) {
    let creatorId: string | null = null;
    let clusterPlaceId: string | null = null;
    if (m.source_type === "post") {
      const p = posts?.get(m.source_id);
      if (!p) continue;                                   // unread (null map) or removed
      if (p.deleted_at || p.tombstoned_at) continue;
      if ((p.status ?? "active") !== "active" || !isPostPublished(p)) continue;
      if (p.publish_at && Date.parse(p.publish_at) > nowMs) continue;
      if (!decidePostReadable({ author_id: p.author_id, visibility: p.visibility, trip_id: p.trip_id }, viewerId ?? "", false, false).readable) continue;
      creatorId = typeof p.author_id === "string" ? p.author_id : null;
      clusterPlaceId = (p.canonical_place_id ?? p.location_place_id ?? null) as string | null;
    } else if (m.source_type === "event") {
      const e = events?.get(m.source_id);
      if (!e) continue;
      creatorId = typeof e.host_id === "string" ? e.host_id : null;
    } else if (m.source_type === "route") {
      const r = routes?.get(m.source_id);
      if (!r) continue;
      creatorId = typeof r.owner_user_id === "string" ? r.owner_user_id : null;
    } else if (m.source_type === "place") {
      if (!places) continue;
      const d = places.get(m.source_id);
      creatorId = d && typeof d.submitted_by === "string" ? d.submitted_by : null;
      clusterPlaceId = m.source_id;
    }
    resolved.push({ ...m, creatorId, clusterPlaceId });
  }

  const creatorIds = [...new Set(resolved.map((m) => m.creatorId).filter((c): c is string => typeof c === "string"))];
  let inactive: Set<string> | null = new Set();
  if (creatorIds.length > 0) {
    const { data, error } = await sc.from("profiles").select("id, account_status")
      .in("id", creatorIds).in("account_status", [...NON_ACTIVE_ACCOUNT_STATUSES]);
    if (error) {
      logger.warn({ code: error?.code, message: error?.message }, "trail creator standing unread — creator-attributed members withheld");
      inactive = null;
    } else {
      inactive = new Set(((data ?? []) as any[]).map((r) => String(r.id)));
    }
  }
  const blocked = viewerId ? await fetchBlockedSet(sc, viewerId) : new Set<string>();

  return resolved.filter((m) => {
    if (m.creatorId && (inactive === null || inactive.has(m.creatorId))) return false;
    return submitterIsVisible(m.contributor_id, blocked) && submitterIsVisible(m.creatorId, blocked);
  });
}

/**
 * Open reports as §11's `report_rate` numerator: ONE per reporter per target.
 *
 * `POST …/reports` is a retry-prone mutation (`11` §1 "idempotency for
 * retries"), and a row per request made the numerator a count of REQUESTS: one
 * signed-in user re-submitting the same report drove `report_rate` to 1 and
 * the Trail's health multiplier to its floor, on their own. The write now
 * refuses an identical open report (`reportTrail`), and this count is the
 * guarantee that does not depend on that check winning a race: the same
 * reporter reporting the same target — the Trail itself, or one membership row
 * — counts once whatever the reason. A report whose reporter's profile is gone
 * (`reported_by` NULL, ON DELETE SET NULL) cannot be attributed and counts on
 * its own.
 */
function distinctReportCount(rows: ReadonlyArray<{ id?: unknown; reported_by?: unknown; content_trail_id?: unknown }>): number {
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(typeof r?.reported_by === "string"
      ? `${r.reported_by}|${typeof r.content_trail_id === "string" ? r.content_trail_id : ""}`
      : `row|${String(r?.id)}`);
  }
  return seen.size;
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
  /**
   * §9's reserved exploration slots on this module, or `null` when the exposure
   * denominators could not be read.
   *
   * `[]` and `null` are different answers and the caller is told which: `[]` is
   * "§9 was evaluated over real denominators and nothing qualified", `null` is
   * "§9 could not be evaluated". A module that reported `[]` for both would let
   * a failed `rank_events` read look like a Trail with no new content.
   */
  explorationSlots: string[] | null;
}

export interface TrailModulesResult {
  refusal: TrailRefusal;
  modules: TrailModule[];
  health: TrailHealth | null;
  /**
   * DC-17 — the provenance of the ONE derived input that orders a module here.
   *
   * `trending_now` is ordered by `lib/discoveryLocalMomentum`, a store that
   * COMPUTES over an event window. `10` §5 requires a derived feature to retain
   * the window it was computed over, its feature version, its model version and
   * its computation time, and this field is the loader's own record carried
   * through rather than a second one minted here — a parallel stamp could claim
   * a window the numbers did not come from.
   *
   * `null` means NO momentum reading entered this result: either the Trail has
   * no `place` members to read momentum for, or the loader threw. A consumer
   * that saw a provenance for that case would be told the ordering rests on a
   * window that was never consulted.
   *
   * WHAT THIS FIELD STILL CANNOT SAY, stated rather than implied: the loader
   * degrades a FAILED `rank_events` read into an empty map carrying a full
   * provenance, so `provenance present + no momentum` covers both "the window
   * was read and nothing surged" and "the read failed". That collapse happens
   * in `lib/discoveryLocalMomentum.ts`, which this lane does not own; it is
   * recorded here so the next reader does not mistake this field for a
   * stronger guarantee than it is.
   */
  momentumProvenance: DerivedStoreProvenance | null;
}

const DAY = 86_400_000;

/**
 * The ceiling on `rank_events` rows ONE Trail read pages in, across all pages.
 *
 * Borrowed from the momentum loader rather than chosen here, so a Trail
 * reading and a Discovery reading of the same places bound the same window.
 * The read pages at MOMENTUM_PAGE_SIZE because PostgREST caps a response at
 * `db-max-rows` (1000) and says nothing about it: a single `.limit(1000)` read
 * could not tell a complete window from a truncated one. A read that REACHES
 * the ceiling is reported as truncated, and each consumer states what it does
 * with that (see `readMemberEvents`).
 */
export const MAX_TRAIL_EVENT_ROWS = MOMENTUM_ROW_LIMIT;
/** §9's exposure denominators are refused, not shortened, past this bound. */
export const MAX_TRAIL_EXPOSURE_EVENTS = MAX_TRAIL_EVENT_ROWS;

// ── The id spaces one member is exposed under (census-discovery §51) ─────────
//
// `content_trails.source_id` is a BARE uuid (2910). The Discovery writers do
// not all write bare ids: `GET /discovery` serves — and its serve log writes to
// `rank_events.item_id` — a DB-backed place as `db/<uuid>` (routes/discovery.ts,
// queryDbPlaces for `discovery_places` rows and queryCanonicalPlaces for
// `places` rows), while `GET /discovery/community` serves the same
// `discovery_places` row bare. Every Trails read of `rank_events` used to ask
// for the bare id only, so a Trail place's main-feed exposures and outcomes —
// the bulk of them — were invisible to §9's denominators, to `trending_now`,
// to GET …/trending and to DV-25's Trail momentum.
//
// The fold below is EXACT, not a heuristic: a `db/` row can only come back
// from a read whose id list named `db/<source_id>` of a PLACE member, so
// stripping the prefix names that member and nothing else. One row is one
// event whichever id it carries, so the two spaces are summed and nothing is
// counted twice. OSM serve ids (`node/…`) name no Trail member — a
// `content_trails.source_id` is a uuid — and are never asked for.

/** The served-id prefix `GET /discovery` gives a DB-backed place (`db/<uuid>`). */
export const DISCOVERY_DB_PLACE_PREFIX = "db/";

/** Every `rank_events.item_id` one Trail member can be exposed under. */
export function servedIdsForMember(sourceType: string, sourceId: string): string[] {
  return sourceType === "place" ? [sourceId, `${DISCOVERY_DB_PLACE_PREFIX}${sourceId}`] : [sourceId];
}

/** A `rank_events.item_id` → the `content_trails.source_id` it names. */
export function memberIdForServedId(itemId: string): string {
  return itemId.startsWith(DISCOVERY_DB_PLACE_PREFIX) ? itemId.slice(DISCOVERY_DB_PLACE_PREFIX.length) : itemId;
}

interface MemberEventRead {
  /** Non-analytics rows, `item_id` folded onto the member's `source_id`. */
  rows: MomentumRow[];
  /** The read stopped at MAX_TRAIL_EVENT_ROWS, not at the end of the window. */
  truncated: boolean;
}

/**
 * The ONE `rank_events` read behind every Trails number: §9's exposure
 * denominators, `trending_now`'s order, GET …/trending, and DV-25's Trail
 * momentum. `undefined` means the read FAILED — a different fact from an empty
 * window, and every caller keeps the two apart.
 *
 * `surface`: `"discovery"` for the per-item readings (the same rows the
 * momentum loader reads for `GET /discovery`), `null` for the Trail-level fold,
 * which counts a Trail's posts on every surface they are served on.
 *
 * `analytics` rows are excluded IN THE QUERY: they are ranker bookkeeping, one
 * per candidate, and excluded after the read they would fill the bounded pages
 * and push real activity out of the window. The order is `served_at DESC, id
 * DESC` — a stable total order, so paging neither repeats nor skips a row, and
 * truncation keeps the most RECENT rows, which is the half the 48-hour window
 * turns on. There is no cache: the loader's `trail:<id>` entry was shared by
 * two readers asking for DIFFERENT member sets, so whichever ran first chose
 * the corpus the other read for ten minutes.
 */
async function readMemberEvents(
  sc: any,
  members: ReadonlyArray<{ source_type: string; source_id: string }>,
  nowMs: number,
  surface: "discovery" | null,
): Promise<MemberEventRead | undefined> {
  const ids = [...new Set(members.flatMap((m) =>
    typeof m?.source_id === "string" && m.source_id.length > 0 ? servedIdsForMember(m.source_type, m.source_id) : []))];
  if (ids.length === 0) return { rows: [], truncated: false };
  const since = new Date(nowMs - MOMENTUM_BASELINE_WINDOW_MS).toISOString();
  const rows: MomentumRow[] = [];
  let fetched = 0;
  try {
    for (let offset = 0; offset < MAX_TRAIL_EVENT_ROWS; offset += MOMENTUM_PAGE_SIZE) {
      let q = sc.from("rank_events").select("item_id, outcome, served_at, outcome_at");
      if (surface) q = q.eq("surface", surface);
      const { data, error } = await q
        .neq("outcome", "analytics")
        .in("item_id", ids)
        .gte("served_at", since)
        .order("served_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, Math.min(offset + MOMENTUM_PAGE_SIZE, MAX_TRAIL_EVENT_ROWS) - 1);
      if (error || !Array.isArray(data)) return undefined;
      fetched += data.length;
      for (const r of data as any[]) {
        if (typeof r?.item_id !== "string" || r.item_id.length === 0) continue;
        rows.push({ item_id: memberIdForServedId(r.item_id), outcome: r.outcome, served_at: r.served_at, outcome_at: r.outcome_at ?? null });
      }
      if (data.length < MOMENTUM_PAGE_SIZE) return { rows, truncated: false };
      if (fetched >= MAX_TRAIL_EVENT_ROWS) break;
    }
    return { rows, truncated: true };
  } catch {
    return undefined;
  }
}

export interface TrailExposureCount { impressions: number; positives: number }

/**
 * `02` §9 "Use exposure denominators" — over rows `readMemberEvents` read.
 *
 * An item MISSING from the returned map has a measured denominator of zero; the
 * caller passes no rows at all when nothing was measured, and keeps that case
 * apart, because §9's whole judgement — "has this item already had its bounded
 * opportunity?" — is a statement about a denominator, and a fabricated zero
 * answers it "no" for every item forever. One impression per served row; a row
 * whose outcome is not `impression` is also a positive response, which is §9
 * step 3's numerator.
 */
function exposureCountsFrom(
  rows: readonly MomentumRow[], memberIds: ReadonlySet<string>,
): Record<string, TrailExposureCount> {
  const out: Record<string, TrailExposureCount> = {};
  for (const r of rows) {
    if (!memberIds.has(r.item_id)) continue;
    const bucket = (out[r.item_id] ??= { impressions: 0, positives: 0 });
    bucket.impressions += 1;
    if (r.outcome !== "impression") bucket.positives += 1;
  }
  return out;
}

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
  sc: any, trailId: string, opts: { pageSize?: number; nowMs?: number; viewerId?: string | null } = {},
): Promise<TrailModulesResult> {
  if (!sc) return { refusal: "no_service_client", modules: [], health: null, momentumProvenance: null };
  const nowMs = opts.nowMs ?? Date.now();
  const pageSize = Math.min(20, Math.max(1, opts.pageSize ?? 8));

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, modules: [], health: null, momentumProvenance: null };
  const m = await readMembers(sc, trailId);
  if (m.refusal) return { refusal: m.refusal, modules: [], health: null, momentumProvenance: null };

  // §11 health is a property of the WHOLE Trail and is measured over every
  // member; what is SERVED is the viewer's view of it (`servableMembers`).
  const health = computeTrailHealth({
    members: m.members.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: await readOpenReportCount(sc, trailId),
    nowMs,
  });
  const served = await servableMembers(sc, m.members, opts.viewerId ?? null, nowMs);

  // ONE `rank_events` read serves both of this function's readings: §9's
  // exposure denominators for the exploration candidates and `trending_now`'s
  // momentum for the place members. Both are read in BOTH served id spaces
  // (`readMemberEvents`), on the surface the momentum loader reads.
  const byNewest = [...served].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const explorationCandidates = byNewest.filter(
    (r) => r.content_state === "just_arrived" || r.content_state === "rediscovered",
  );
  const placeMembers = served.filter((r) => r.source_type === "place");
  const events: MemberEventRead | undefined = placeMembers.length + explorationCandidates.length > 0
    ? await readMemberEvents(sc, [...placeMembers, ...explorationCandidates], nowMs, "discovery")
    : { rows: [], truncated: false };

  // The ONE non-chronological ordering input, and its arithmetic is borrowed
  // rather than built: `computeLocalMomentum` is the kernel `GET /discovery`'s
  // momentum loader runs, over the same rows, windows and weights.
  //
  // DC-17: the kernel's `provenance` is RETAINED. It is the record of the window
  // `trending_now`'s order was computed over, stamped by the same function that
  // did the arithmetic. `null` means no reading entered this result — no place
  // members, or a read that FAILED — never a window that was not consulted.
  let momentum: Record<string, number> = {};
  let momentumProvenance: DerivedStoreProvenance | null = null;
  if (placeMembers.length > 0 && events) {
    const placeIds = new Set(placeMembers.map((r) => r.source_id));
    const reading = computeLocalMomentum(events.rows.filter((e) => placeIds.has(e.item_id)), nowMs);
    momentum = { ...reading.values };
    momentumProvenance = reading.provenance;
    if (events.truncated) {
      logger.warn({ trailId, rowLimit: MAX_TRAIL_EVENT_ROWS }, "trail momentum: row ceiling reached — window bounded to the most recent rows");
    }
  }

  const toItem = (r: MemberRow) => ({
    id: r.id, sourceType: r.source_type, sourceId: r.source_id, contentState: r.content_state,
  });
  // §10's two identities (see ServableMember): the CREATOR where the source has
  // one, else the contributor who attached it; and the place a post is ABOUT,
  // not only a place member's own id.
  const saturationItem = (r: ServableMember) => ({
    id: r.id,
    placeId: r.clusterPlaceId,
    contributorId: r.creatorId ?? r.contributor_id,
  });

  const build = (
    key: TrailModule["key"],
    objective: TrailModule["objective"],
    horizonMs: number | null,
    rows: ServableMember[],
    /**
     * §9's reserved ids, considered FIRST so the page bound cannot drop them.
     *
     * Only the ORDER OF CONSIDERATION changes; `items` is still filtered out of
     * `rows`, so the module is served in its own objective's order and a
     * reservation moves membership, never position. The caps in
     * `diversifyTrailPage` still run over the reordered list, so a reserved item
     * can still be refused by §10's contributor or place cap — an exploration
     * slot is an opportunity to be considered, not a licence to dominate
     * (DV-13).
     */
    reserved?: ReadonlySet<string>,
  ): TrailModule => {
    const ordered = reserved && reserved.size > 0
      ? [...rows.filter((r) => reserved.has(r.id)), ...rows.filter((r) => !reserved.has(r.id))]
      : rows;
    // ONE CONTENT, ONE SLOT. A place attached as primary AND as two Signals is
    // three membership rows for one thing; the place cap used to let two of
    // them onto the same page, which is §10's saturation in its purest form.
    // The first row in the module's own order stands for the content; the
    // others are the same item, not a remainder, so they are not counted in
    // "more from this place".
    const seen = new Set<string>();
    const considered = ordered.filter((r) => {
      const key = `${r.source_type}:${r.source_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const d = diversifyTrailPage(considered.map(saturationItem), { pageSize });
    const kept = new Set(d.page.map((i) => i.id));
    const items = rows.filter((r) => kept.has(r.id)).map(toItem);
    return { key, objective, horizonMs, items, moreFromThisPlace: d.moreFromThisPlace, explorationSlots: null };
  };

  const byConfidence = [...served].sort((a, b) => Number(b.confidence) - Number(a.confidence));
  const byMomentum = [...served].sort(
    (a, b) => (momentum[b.source_id] ?? 0) - (momentum[a.source_id] ?? 0),
  ).filter((r) => (momentum[r.source_id] ?? 0) > 0);

  // §9 — the reserved opportunity, computed over the module's OWN CANDIDATES
  // rather than over the page that survived the bound. Over the survivors it was
  // a tautology: every id it could reserve was already being served, so nothing
  // was reserved FOR anything. §9's point is that an item which would otherwise
  // not be seen gets a bounded chance to be.
  //
  // The denominators are REFUSED, not shortened, when the read failed or hit its
  // ceiling: a truncated count is wrong in the one direction that matters (an
  // item whose impressions were cut off looks new again). With no candidates
  // there is nothing to judge and the answer is a measured "nothing qualified".
  const exposureCounts: Record<string, TrailExposureCount> | undefined = explorationCandidates.length === 0
    ? {}
    : events && !events.truncated
      ? exposureCountsFrom(events.rows, new Set(explorationCandidates.map((r) => r.source_id)))
      : undefined;
  let explorationSlots: string[] | null = null;
  let reserved: Set<string> | undefined;
  if (exposureCounts) {
    const exposure = fairExposureSlots(
      explorationCandidates.map((r) => {
        // Present in a map that was READ ⇒ the measured count. Absent from a map
        // that was read ⇒ a measured zero, which is a real denominator. The
        // unread case never reaches here: it is the `undefined` branch above.
        const c = exposureCounts[r.source_id];
        return {
          id: r.id, state: r.content_state,
          impressions: c?.impressions ?? 0, positives: c?.positives ?? 0,
        };
      }),
      { pageSize },
    );
    explorationSlots = exposure.slots;
    reserved = new Set(exposure.slots);
  }

  const justArrived = build("just_arrived", "recency", 7 * DAY, explorationCandidates, reserved);
  justArrived.explorationSlots = explorationSlots;

  return {
    refusal: null,
    health,
    momentumProvenance,
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

  // §18's `trails.parent_trail_id` IS the parent/child relationship; the
  // `child` edge proposeTrail writes beside it is the same fact in graph form.
  // That edge insert is deliberately non-fatal (a Trail that was created is not
  // undone to report a missing edge), so a failed edge write used to leave a
  // sub-Trail whose pointer names its parent and which navigation could not
  // reach in either direction. The pointer is read here too, in both
  // directions, and a pair the edge table already carries is not listed twice.
  const kids = await sc.from("trails").select("id").eq("parent_trail_id", trailId);
  if (kids.error) return { refusal: refusalFor(kids.error, "relatedTrails.children"), edges: [] };

  const listed = new Set<string>();
  const rows = [
    ...((out.data ?? []) as any[]).map((e) => ({ other: e.to_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "out" as const })),
    ...((inc.data ?? []) as any[]).map((e) => ({ other: e.from_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "in" as const })),
    ...(t.trail.parent_trail_id
      ? [{ other: t.trail.parent_trail_id, edgeType: "child", strength: 1, direction: "in" as const }] : []),
    ...((kids.data ?? []) as any[]).map((k) => ({ other: k.id as string, edgeType: "child", strength: 1, direction: "out" as const })),
  ].filter((r) => {
    const key = `${r.other}|${r.edgeType}|${r.direction}`;
    if (listed.has(key)) return false;
    listed.add(key);
    return true;
  });
  const ids = [...new Set(rows.map((r) => r.other))];
  if (ids.length === 0) return { refusal: null, edges: [] };

  const { data, error } = await sc.from("trails").select(TRAIL_COLUMNS).in("id", ids);
  if (error) return { refusal: refusalFor(error, "relatedTrails.trails"), edges: [] };
  // An ARCHIVED neighbour is not navigable to: GET …/:id answers 404 for it
  // (readTrail), so listing it would hand the client a link that is dead on
  // arrival. Dropped here for the same reason readTrail hides it.
  const byId = new Map<string, TrailRow>(((data ?? []) as any[])
    .filter((r) => r.lifecycle_status !== "archived")
    .map((r) => [r.id as string, r as TrailRow]));

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
  /**
   * DC-17 — the per-item momentum reading's provenance, or `null` when no
   * reading was taken (no members, or the loader threw). Same meaning, and the
   * same stated limit, as `TrailModulesResult.momentumProvenance`.
   *
   * This one matters more than the modules one, because `trending` is published
   * as a BOOLEAN: "is this Trail trending" with no window attached is a claim
   * about an unspecified corpus, and two readings taken a day apart over "30
   * days" answer it about different corpora.
   */
  momentumProvenance: DerivedStoreProvenance | null;
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
/** Items GET …/trending lists — the bound it has always had (`.slice(0, 20)`). */
export const TRAIL_TRENDING_PAGE_SIZE = 20;

export async function trailTrending(
  sc: any, trailId: string, nowMs = Date.now(), opts: { viewerId?: string | null } = {},
): Promise<TrailTrendingResult> {
  // A FUNCTION, not a shared object. Every refusal path used to build its own
  // literal; spreading one constant instead would hand every one of them the
  // same `items` array, which is mutable on the published type.
  const none = (refusal: TrailRefusal): TrailTrendingResult =>
    ({ refusal, momentum: null, items: [], momentumProvenance: null });
  if (!sc) return none("no_service_client");
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return none(t.refusal);
  const m = await readMembers(sc, trailId);
  if (m.refusal) return none(m.refusal);

  const itemIds = m.members.map((r) => r.source_id);
  // No members ⇒ no reading was taken, so there is no window to report. A
  // provenance here would describe a computation that never ran (DC-17).
  if (itemIds.length === 0) return none(null);

  // Per-item ORDER: the discovery-surface rows the momentum loader reads, in
  // both served id spaces, through the shipping kernel. Trail MOMENTUM: the
  // same kernel over every surface the members are served on, folded onto the
  // Trail — one kernel, two scopes, no second velocity model (DV-25). Two reads
  // because the two scopes differ; neither is cached, so neither can hand the
  // other a corpus chosen for a different member set.
  let perItem: Record<string, number> = {};
  let momentumProvenance: DerivedStoreProvenance | null = null;
  const itemRead = await readMemberEvents(sc, m.members, nowMs, "discovery");
  if (itemRead) {
    const reading = computeLocalMomentum(itemRead.rows, nowMs);
    perItem = { ...reading.values };
    momentumProvenance = reading.provenance;
  } else {
    logger.warn({ trailId }, "trail trending item read failed");
  }

  let trailMomentum: number | null = null;
  const trailRead = await readMemberEvents(sc, m.members, nowMs, null);
  if (trailRead) {
    trailMomentum = trailMomentumFromRankEvents(trailRead.rows, m.members, nowMs)[trailId] ?? null;
  } else {
    logger.warn({ trailId }, "trail trending event read failed");
  }

  // The list is what this VIEWER may be served (`servableMembers`), one row per
  // content, and it passes through §10's creator and place caps like every
  // module does — a momentum-ordered list is exactly where one creator's
  // surge would otherwise fill all twenty places (DV-13). The boolean above is
  // the Trail's and is measured over every member.
  const servable = await servableMembers(sc, m.members, opts.viewerId ?? null, nowMs);
  const seen = new Set<string>();
  const ranked = servable
    .filter((r) => (perItem[r.source_id] ?? 0) > 0)
    .sort((a, b) => (perItem[b.source_id] ?? 0) - (perItem[a.source_id] ?? 0))
    .filter((r) => {
      const key = `${r.source_type}:${r.source_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const capped = new Set(diversifyTrailPage(ranked.map((r) => ({
    id: r.id, placeId: r.clusterPlaceId, contributorId: r.creatorId ?? r.contributor_id,
  })), { pageSize: TRAIL_TRENDING_PAGE_SIZE }).page.map((i) => i.id));
  const items = ranked
    .filter((r) => capped.has(r.id))
    .map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id }));

  return { refusal: null, momentum: trailMomentum, items, momentumProvenance };
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
/** rank_events rows folded onto the followed Trails for DV-25 momentum — the one read ceiling. */
export const MAX_TRAIL_MOMENTUM_EVENTS = MAX_TRAIL_EVENT_ROWS;

/**
 * Open `trail_reports` counts for several Trails in ONE read, or `undefined`
 * when the read FAILED.
 *
 * The same distinction `readOpenReportCount` makes, at the batch scale: a map
 * that came back EMPTY means every one of these Trails is unreported, and
 * `undefined` means none of them was measured. Returning `{}` for both would
 * make an outage look like a page of clean Trails and quietly raise all of
 * their affinity.
 */
async function readOpenReportCounts(
  sc: any, trailIds: readonly string[],
): Promise<Record<string, number> | undefined> {
  const out: Record<string, number> = {};
  const { data, error } = await sc.from("trail_reports").select("id, trail_id, reported_by, content_trail_id")
    .in("trail_id", trailIds).is("resolution", null);
  if (error) {
    logger.warn({ code: error?.code, message: error?.message }, "trail report counts unread");
    return undefined;
  }
  // Grouped per Trail, then counted one per reporter per target — the same
  // numerator `readOpenReportCount` uses, so the ranker's health input and the
  // Trail page's cannot disagree about one Trail.
  const byTrail = new Map<string, any[]>();
  for (const r of (data ?? []) as any[]) {
    if (typeof r?.trail_id !== "string") continue;
    const list = byTrail.get(r.trail_id);
    if (list) list.push(r); else byTrail.set(r.trail_id, [r]);
  }
  for (const [trailId, rows] of byTrail) out[trailId] = distinctReportCount(rows);
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
  // Every surface, both served id spaces, analytics excluded in the query —
  // the same read GET …/trending folds for its boolean (`readMemberEvents`).
  const read = await readMemberEvents(sc, members, nowMs, null);
  if (!read) return undefined;
  return trailMomentumFromRankEvents(read.rows, members, nowMs);
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
      // An absent ENTRY in a map that was read is a measured zero; an absent MAP
      // is unmeasured. Collapsing the two is the defect this distinction exists
      // to prevent, so the two branches are written out rather than defaulted.
      reportCount: reportCounts ? (reportCounts[trailId] ?? 0) : null,
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
 * destination plus every Trail that could be a CHECK 1 duplicate from any
 * destination (see the comparison-set note in the body).
 *
 * The comparison set is deliberately NOT "all Trails": §5's checks 2, 3 and 4
 * are destination-scoped, and CHECK 1's candidates are bounded by a token
 * pigeonhole rather than found by scanning. Reading every Trail to compare would
 * be an unbounded scan that gets slower exactly as the catalogue succeeds.
 *
 * NOT SERIALISED, stated rather than implied: two proposals racing each other
 * each run the checks against a catalogue that does not yet hold the other, so
 * two near-duplicates with DIFFERENT slugs can both be admitted. An identical
 * slug cannot (UNIQUE). Closing that needs the checks inside the database,
 * under a lock — census-discovery §51 names it as DC-03's residual.
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
  // THE COMPARISON SET, and why it is wider than the destination (§51).
  //
  // CHECK 1 (duplicate title similarity) is destination-INDEPENDENT by its own
  // definition in lib/discoveryTrailObject.ts — "two Trails called 'Bangkok
  // After Dark' are one Trail even if someone files the second under Phuket" —
  // but the set it ran over was read by destination, so it was not: "After Dark
  // Bangkok" filed under Phuket shares every token with "Bangkok After Dark",
  // slugs differently, and was admitted as a second canonical Trail. The UNIQUE
  // slug catches only an identical slug.
  //
  // The set is widened without a full scan by the pigeonhole bound: a Trail at
  // similarity ≥ DUPLICATE_TITLE_SIMILARITY shares at least
  // ceil(DUPLICATE_TITLE_SIMILARITY·|T|) of this title's |T| tokens, so it
  // contains at least one of ANY |T| − ceil(DUPLICATE_TITLE_SIMILARITY·|T|) + 1
  // of them. The longest are read, as `slug ILIKE %token%` — a superset, never
  // a miss. Tokens are [a-z0-9]+ by construction and cannot alter the filter;
  // the destination is user text and is double-quoted as PostgREST requires,
  // where it used to be interpolated bare (a comma in it rewrote the filter).
  const tokens = [...new Set((canonicalTrailSlug(input?.title) ?? "").split("-").filter(Boolean))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const needed = tokens.length - Math.ceil(DUPLICATE_TITLE_SIMILARITY * tokens.length) + 1;
  const peerFilter = [
    destination ? `destination.eq.${postgrestQuoted(destination)}` : null,
    "destination.is.null",
    ...tokens.slice(0, Math.max(0, needed)).map((tok) => `slug.ilike.*${tok}*`),
  ].filter((x): x is string => x !== null).join(",");
  const peers = await sc.from("trails").select("id, slug, title, destination")
    .or(peerFilter)
    .limit(MAX_PROPOSAL_PEERS);
  if (peers.error) return { ...none, refusal: refusalFor(peers.error, "proposeTrail.peers") };
  if (((peers.data ?? []) as any[]).length >= MAX_PROPOSAL_PEERS) {
    logger.warn({ destination, peerLimit: MAX_PROPOSAL_PEERS }, "trail proposal comparison set reached its bound — canonicalisation ran over a truncated catalogue");
  }

  const existing = ((peers.data ?? []) as any[]).map((r): ExistingTrail => ({
    id: r.id, slug: r.slug, title: r.title, destination: r.destination,
  }));
  const check = canonicaliseTrailProposal({ title: input?.title ?? "", destination }, existing);

  const parentId = typeof input?.parentTrailId === "string" && input.parentTrailId.length > 0
    ? input.parentTrailId : null;
  // The declared parent is read BY ID, not looked for in the comparison set:
  // §6's "geographic sub-Trail" (Bangkok → Thonglor) has a different
  // destination from its parent by definition, and a parent outside the set was
  // answered "does not exist". Read through `readTrail`, so an ARCHIVED parent
  // is refused like a missing one — a sub-Trail under a Trail no client may
  // open would be navigable to a 404.
  let parentExists = false;
  if (parentId !== null) {
    const parent = await readTrail(sc, parentId);
    if (parent.refusal && parent.refusal !== "unknown_trail") return { ...none, refusal: parent.refusal };
    parentExists = parent.trail !== null;
  }
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
  const held = await sc.from("content_trails").select("trail_id, relationship, signal, source_type, source_id")
    .in("source_id", sourceIds);
  if (held.error) return { refusal: refusalFor(held.error, "attach.held"), attached: 0, capRefusals: [] };

  const proposed: TrailLabel[] = labels.map((l) => ({
    relationship: l.relationship as TrailRelationship,
    trailId,
    signal: l.relationship === "signal" ? (l.signal ?? null) : null,
  }));

  // §4's budgets are PER CONTENT, so they are judged per content — the key the
  // 2910/3380 trigger counts on, (source_type, source_id). This used to hand
  // ONE `capTrailLabels` call every held label of every content in the batch
  // and every proposed label of the batch, as if they were one content's: two
  // different posts attached as `primary` in one request collided as a
  // "duplicate" (their labels differ only by the content, which the label key
  // does not carry), and one content's full budget refused another's label.
  const contentKey = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`;
  const groups = new Map<string, TrailLabel[]>();
  labels.forEach((l, i) => {
    const key = contentKey(l.sourceType, l.sourceId);
    const list = groups.get(key);
    if (list) list.push(proposed[i]!); else groups.set(key, [proposed[i]!]);
  });
  const accepted: TrailLabel[] = [];
  const refused: LabelRefusal[] = [];
  for (const [key, group] of groups) {
    const existingLabels: TrailLabel[] = ((held.data ?? []) as any[])
      .filter((r) => contentKey(r.source_type, r.source_id) === key)
      .map((r) => ({ relationship: r.relationship, trailId: r.trail_id, signal: r.signal ?? null }));
    const judged = capTrailLabels(existingLabels, group);
    accepted.push(...judged.accepted);
    refused.push(...judged.refusals);
  }
  const capped = { accepted, refusals: refused };
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
): Promise<{ refusal: TrailRefusal; reported: boolean; duplicate?: boolean }> {
  if (!sc) return { refusal: "no_service_client", reported: false };
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, reported: false };

  const contentTrailId = typeof input?.contentTrailId === "string" && input.contentTrailId.length > 0
    ? input.contentTrailId : null;
  // A membership report names a row OF THIS TRAIL. The foreign key only proves
  // the row exists somewhere, so without this read a report filed against Trail
  // A could name a membership of Trail B and be counted in A's `report_rate`.
  // Unknown and elsewhere are the same answer, as for detach.
  if (contentTrailId) {
    const row = await sc.from("content_trails").select("id")
      .eq("id", contentTrailId).eq("trail_id", trailId).maybeSingle();
    if (row.error) return { refusal: refusalFor(row.error, "reportTrail.content"), reported: false };
    if (!row.data) return { refusal: "unknown_trail", reported: false };
  }

  // `11` §1 "idempotency for retries": the same reporter re-submitting the same
  // open report is a retry, answered as reported and written once. Racing
  // duplicates can still both land — there is no unique index to arbitrate —
  // and that is harmless: `distinctReportCount` counts one per reporter per
  // target whatever the table holds.
  let open = sc.from("trail_reports").select("id")
    .eq("trail_id", trailId).eq("reported_by", reporterId).eq("reason", input?.reason).is("resolution", null);
  open = contentTrailId ? open.eq("content_trail_id", contentTrailId) : open.is("content_trail_id", null);
  const prior = await open.limit(1);
  if (prior.error) return { refusal: refusalFor(prior.error, "reportTrail.prior"), reported: false };
  if (((prior.data ?? []) as any[]).length > 0) return { refusal: null, reported: true, duplicate: true };

  const { error } = await sc.from("trail_reports").insert({
    trail_id: trailId,
    content_trail_id: contentTrailId,
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
  const t = await readTrail(sc, trailId, { includeArchived: true });
  if (t.refusal || !t.trail) return { refusal: t.refusal, moved: false, from: null };
  const from = t.trail.lifecycle_status;
  if (!isTrailLifecycleTransitionAllowed(from, to)) {
    return { refusal: "invalid_request", moved: false, from };
  }
  // COMPARE-AND-SET on the state the decision above was made on. Without it
  // this was read → compare → write: a Trail that moved between the read and
  // the write (another request archived it, or took it proposed → active →
  // stale) was overwritten on the strength of a state it no longer had, and the
  // caller was told `moved: true`. Zero rows matched means the premise is gone,
  // and that is reported, not papered over. Migration 3381 refuses an illegal
  // move at the database too (23514); that arrives here as the same refusal.
  const { data, error } = await sc.from("trails")
    .update({ lifecycle_status: to, updated_at: new Date().toISOString() })
    .eq("id", trailId)
    .eq("lifecycle_status", from)
    .select("id");
  if (error) {
    if (String(error.code) === "23514") return { refusal: "invalid_request", moved: false, from };
    return { refusal: refusalFor(error, "moveTrailLifecycle"), moved: false, from };
  }
  if (!Array.isArray(data) || data.length === 0) return { refusal: "invalid_request", moved: false, from };
  return { refusal: null, moved: true, from };
}

/** Exported for the route layer's validation, so the vocabulary has one home. */
export { TRAIL_EDGE_TYPES };
