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
  canonicaliseTrailProposal, canonicalTrailSlug, capTrailLabels, DUPLICATE_TITLE_SIMILARITY, trailDestinationKey,
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
import { trailAffinityMap, trailMomentumFromRankEvents, type TrailMembershipRow } from "../../lib/discoveryTrailAffinity.js";
import { commitTrailProposal } from "./trailProposal.js"; // census-discovery §61: DC-03's serialised creation decision
import { verifyAttachSources, type AttachSourceRefusal } from "./trailAttachIntegrity.js"; // §61: DC-20's check that attached content exists
import { requireTripMember, TripAccessUnavailableError } from "../../lib/http.js"; // §64: a trip route's crew, as 2334's RLS and GET /route-plans/:id decide it
import { logger as rootLogger } from "../../lib/logger.js";
import { fetchBlockedSet, submitterIsVisible } from "../../lib/blocks.js";
import { decidePostReadable, isPostPublished } from "../../lib/postVisibility.js";
import { NON_ACTIVE_ACCOUNT_STATUSES } from "../../lib/mediaEligibility.js";

const logger = rootLogger.child({ mod: "trailService" });

export type TrailRefusal =
  | null
  | "no_service_client" | "trails_unavailable"
  | "unknown_trail"
  | "invalid_request"
  | "db_error"
  | "source_unreadable"; // attach (§61): a content source could not be read, so nothing was admitted

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
  const destination = typeof params?.destination === "string" ? params.destination.trim().toLowerCase() : "", destKey = destination ? trailDestinationKey(destination) : "";
  if (destination) q = destKey ? q.eq("destination_key", destKey) : q.eq("destination", destination); // §77 (DV-20): 3441's stored trail_normalised_destination(destination), the key creation compares; no key (東京) → the spelling
  const term = typeof params?.query === "string" ? params.query.trim() : "", termSlug = term ? canonicalTrailSlug(term) : null;
  // Search runs on the SLUG, not the title: the slug is the canonical handle (DV-20), so searching it cannot return two rows for one
  // theme — and §77: the TERM goes through the same canonicalTrailSlug, so "Đà Nẵng" searches `da-nang`, never `---n-ng`.
  if (term) { if (!termSlug) return { refusal: null, trails: [] }; q = q.ilike("slug", `%${termSlug}%`); } // no slug-able character: no Trail slug contains it

  const { data, error } = await q;
  if (error) return { refusal: destKey && ["42703", "PGRST204"].includes(String(error?.code)) ? "trails_unavailable" : refusalFor(error, "listTrails"), trails: [] }; // §77: no destination_key (3441 absent) is 503, never a string compare
  return { refusal: null, trails: (data ?? []) as TrailRow[] };
}

export interface TrailDetail {
  refusal: TrailRefusal; /** census-discovery §105 (DV-83, D-W11X2-60): the member-source reads that FAILED, present only then; the route names one generic source, never these. */ membersUnread?: string[];
  trail: TrailRow | null;
  health: TrailHealth | null;
  /** §12's user-facing word, over the members THIS viewer may be served (§64). Never a number — §12 forbids opaque quality scores. */
  status: string | null;
  /** The bounded ranking multiplier §11 permits, floored so it cannot erase. */
  healthScale: number;
  memberCount: number; // §64: the members THIS viewer may be served — never one withheld from them; `health` stays the whole Trail's
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
    .order("created_at", { ascending: false }).order("id", { ascending: false }) // §86.14: a total order, so the member window has an exact edge a cursor can continue from
    .limit(TRAIL_MEMBER_WINDOW);
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
  clusterPlaceId: string | null; /** §86 (DV-23, E-11): the member's media kind (a post's own, else its type) and a post's text, for §10's media and content-similarity clauses. Server-side only. */ mediaType?: string | null; text?: string | null;
}

/**
 * The members a Trail may SERVE, to one viewer. Four rules, each the one the
 * rest of the product already applies, none invented here:
 *
 *  REVOCATION   A member whose source was removed or hidden after it was
 *               attached is not served (`source_id` has no foreign key). Posts:
 *               lib/postVisibility.ts (`decidePostReadable`, `isPostPublished`)
 *               plus lib/mediaEligibility.ts's status / deleted / tombstoned /
 *               publish_at gates; a Trail is a public space, so trip-only and
 *               followers-only posts are served to their author alone.
 *  EVENTS AND   (§64) An event is served to everyone only when 2033's
 *  ROUTES       `events_public_read` admits it, the viewer is not banned and no
 *               age/trust/verified gate applies; else to its host only. A route
 *               plan: its owner, and its trip's accepted crew once active or
 *               completed (`requireTripMember`); no one else. `memberAccessFor`.
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
 * and attach now requires one of the two (§61) — so a place absent from
 * `discovery_places` is served as an authorless venue fact; an `itinerary` has
 * no table and attach refuses it. `unread` (attach) names each read that failed.
 */
export async function servableMembers(
  sc: any, members: readonly MemberRow[], viewerId: string | null, nowMs: number = Date.now(), unread?: Set<string>,
): Promise<ServableMember[]> {
  const idsOf = (type: string) => [...new Set(members.filter((m) => m.source_type === type).map((m) => m.source_id))];
  const readRows = async (table: string, read: (ids: string[]) => PromiseLike<{ data: any; error: any }>, ids: string[]): Promise<Map<string, any> | null> => {
    if (ids.length === 0) return new Map();
    const { data, error } = await read(ids); // each caller spells its table and columns literally, so check:write-path-columns verifies them
    if (error || !Array.isArray(data)) {
      unread?.add(table); logger.warn({ table, code: error?.code, message: error?.message }, "trail member sources unread — withheld");
      return null;
    }
    return new Map((data as any[]).map((r) => [String(r.id), r]));
  };

  const [posts, events, routes, places] = await Promise.all([
    readRows("posts", (ids) => sc.from("posts").select("id, author_id, visibility, status, post_status, deleted_at, tombstoned_at, publish_at, trip_id, canonical_place_id, location_place_id, primary_media_type, media_type, content").in("id", ids), idsOf("post")),
    readRows("events", (ids) => sc.from("events").select("id, host_id, visibility, state, verified_only, trust_score_min, age_min, age_max").in("id", ids), idsOf("event")),
    readRows("route_plans", (ids) => sc.from("route_plans").select("id, owner_user_id, trip_id, status").in("id", ids), idsOf("route")),
    readRows("discovery_places", (ids) => sc.from("discovery_places").select("id, submitted_by").in("id", ids), idsOf("place")),
  ]);
  const access = await memberAccessFor(sc, events, routes, viewerId, unread); // §64: the ban and trip-crew reads, once per call, fail closed
  const resolved: ServableMember[] = [];
  for (const m of members) {
    let creatorId: string | null = null;
    let clusterPlaceId: string | null = null; let mediaType: string | null = null; let text: string | null = null; // §86 (DV-23)
    if (m.source_type === "post") {
      const p = posts?.get(m.source_id);
      if (!p) continue;                                   // unread (null map) or removed
      if (p.deleted_at || p.tombstoned_at) continue;
      if ((p.status ?? "active") !== "active" || !isPostPublished(p)) continue;
      if (p.publish_at && Date.parse(p.publish_at) > nowMs) continue;
      if (!decidePostReadable({ author_id: p.author_id, visibility: p.visibility, trip_id: p.trip_id }, viewerId ?? "", false, false).readable) continue;
      creatorId = typeof p.author_id === "string" ? p.author_id : null;
      clusterPlaceId = (p.canonical_place_id ?? p.location_place_id ?? null) as string | null; mediaType = String(p.primary_media_type ?? p.media_type ?? "text"); text = typeof p.content === "string" ? p.content : null;
    } else if (m.source_type === "event") {
      const e = events?.get(m.source_id);
      if (!e || !access.event(e)) continue;              // §64: 2033's public-read rule, else its host only
      creatorId = typeof e.host_id === "string" ? e.host_id : null; mediaType = "event";
    } else if (m.source_type === "route") {
      const r = routes?.get(m.source_id);
      if (!r || !access.route(r)) continue;              // §64: its owner, or its trip's accepted crew once active
      creatorId = typeof r.owner_user_id === "string" ? r.owner_user_id : null; mediaType = "route";
    } else if (m.source_type === "place") {
      if (!places) continue;
      const d = places.get(m.source_id);
      creatorId = d && typeof d.submitted_by === "string" ? d.submitted_by : null;
      clusterPlaceId = m.source_id; mediaType = "place";
    }
    resolved.push({ ...m, creatorId, clusterPlaceId, mediaType, text });
  }

  const creatorIds = [...new Set(resolved.map((m) => m.creatorId).filter((c): c is string => typeof c === "string"))];
  let inactive: Set<string> | null = new Set();
  if (creatorIds.length > 0) {
    const { data, error } = await sc.from("profiles").select("id, account_status")
      .in("id", creatorIds).in("account_status", [...NON_ACTIVE_ACCOUNT_STATUSES]);
    if (error) {
      logger.warn({ code: error?.code, message: error?.message }, "trail creator standing unread — creator-attributed members withheld");
      inactive = null; unread?.add("profiles");
    } else {
      inactive = new Set(((data ?? []) as any[]).map((r) => String(r.id)));
    }
  }
  const blocked = viewerId ? await fetchBlockedSet(sc, viewerId) : new Set<string>(); if (blocked === null) unread?.add("blocks");

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
export async function getTrail(sc: any, trailId: string, nowMs = Date.now(), opts: { viewerId?: string | null } = {}): Promise<TrailDetail> {
  const empty: TrailDetail = { refusal: null, trail: null, health: null, status: null, healthScale: 1, memberCount: 0 };
  if (!sc) return { ...empty, refusal: "no_service_client" };

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { ...empty, refusal: t.refusal };

  const m = await readMembers(sc, trailId);
  if (m.refusal) return { ...empty, refusal: m.refusal };
  const geo = await readMemberGeography(sc, m.members); // §86 (DC-05): the members' geographic cells, fail-soft
  const health = computeTrailHealth({
    members: m.members.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: await readOpenReportCount(sc, trailId), geoCellByItem: geo.cellBySource ?? undefined, impressionsBySource: await readMemberImpressions(sc, m.members, nowMs),
    nowMs,
  });
  const view = await servedTrailView(sc, m.members, opts.viewerId ?? null, nowMs); // §64: what GET …/:id SHOWS counts only what this viewer is served
  return {
    refusal: null,
    trail: t.trail,
    health,
    status: trailStatusLabel(t.trail.lifecycle_status, view),
    healthScale: trailHealthScale(health),
    memberCount: view.memberCount, ...(view.membersUnread ? { membersUnread: view.membersUnread } : {}), // §105: a count over a failed read is not the count
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
  sc: any, trailId: string, health: TrailHealth, nowMs = Number.isFinite(health?.computedAt) ? health.computedAt : Date.now(),  // §75 (DC-17, H-P21-3): default to the COMPUTATION clock the health carries, so `captured_at` is what the comment below says it is
): Promise<"written" | "skipped_recent" | "unavailable" | "failed"> {
  if (!sc || !health || health.memberCount === 0) return "skipped_recent";
  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data, error } = await sc.from("trail_health_snapshots").select("id")
    .eq("trail_id", trailId).gt("captured_at", since).limit(1);
  if (error) return isMissingRelation(error) ? "unavailable" : "failed";
  if ((data ?? []).length > 0) return "skipped_recent";

  const { error: writeError } = await insertTrailHealthSnapshotRow(sc, health, {  // §75 (DC-17, H-P21-3): + feature_version and source_window (3436), behind a column-absent latch — see the foot
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
  key: "just_arrived" | "trending_now" | "evergreen" | "local_picks" | "hidden_gems" | "personalized_picks"; // §86: hidden_gems only behind discovery_trail_exploration_enabled; §93: personalized_picks only behind 3500 + 3450
  /** §8: "Each spotlight has its own objective and time horizon." */
  objective: "recency" | "momentum" | "durable_quality" | "curation" | "response_under_exposure" | "trail_objective";
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
  explorationSlots: string[] | null; /** §86 (DV-23, D-W10T-15): per place, EVERY member this module held back (any clause, the creator cap, the page bound) and counted in `moreFromThisPlace`; `heldBackUnplaced`, those with no place — never serialised; GET …/places/:placeId/more and GET …/more return them. */ heldBackByPlace?: Record<string, TrailModule["items"]>; heldBackUnplaced?: TrailModule["items"];
}

export interface TrailModulesResult {
  refusal: TrailRefusal; /** census-discovery §105 (DV-83, D-W11X2-60): the member-source reads that FAILED, present only then; the route names one generic source, never these. */ membersUnread?: string[];
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
  momentumProvenance: DerivedStoreProvenance | null; /** §86: what serving this page owes the database (flag-on only; never serialised). */ serveEffects?: TrailServeEffects;
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
 * whose outcome is not `impression` — nor `dismiss`, which is the viewer saying
 * NO (§61, DV-25) — is also a positive response, §9 step 3's numerator.
 */
export function exposureCountsFrom(
  rows: readonly MomentumRow[], memberIds: ReadonlySet<string>,
): Record<string, TrailExposureCount> {
  const out: Record<string, TrailExposureCount> = {};
  for (const r of rows) {
    if (!memberIds.has(r.item_id)) continue;
    const bucket = (out[r.item_id] ??= { impressions: 0, positives: 0 });
    bucket.impressions += 1;
    if (r.outcome !== "impression" && r.outcome !== "dismiss") bucket.positives += 1;
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
async function trailModulesRead( // census-discovery §105: exported as getTrailModules at the foot, which names a failed member read
  sc: any, trailId: string, opts: { pageSize?: number; nowMs?: number; viewerId?: string | null; memberUnread?: Set<string> } = {},
): Promise<TrailModulesResult> {
  if (!sc) return { refusal: "no_service_client", modules: [], health: null, momentumProvenance: null };
  const nowMs = opts.nowMs ?? Date.now();
  const pageSize = Math.min(20, Math.max(1, opts.pageSize ?? 8));

  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal, modules: [], health: null, momentumProvenance: null };
  const m = await readMembers(sc, trailId);
  if (m.refusal) return { refusal: m.refusal, modules: [], health: null, momentumProvenance: null };

  const flags = await readTrailRankingFlags(sc); // §86: 3485, both FALSE-seeded; §11 health is a property of the WHOLE Trail, measured over every
  const geo = await readMemberGeography(sc, m.members); // member; what is SERVED is the viewer's view of it (`servableMembers`). §86: cells + venue links, fail-soft
  const health = computeTrailHealth({
    members: m.members.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: await readOpenReportCount(sc, trailId), geoCellByItem: geo.cellBySource ?? undefined, impressionsBySource: await readMemberImpressions(sc, m.members, nowMs),
    nowMs,
  });
  const served = linkVenueClusters(await servableMembers(sc, m.members, opts.viewerId ?? null, nowMs, opts.memberUnread), geo); // §86 (DV-23): a post's venue → the place member of that venue

  if (flags.exploration) return trailModulesExplored(sc, trailId, m.members, served, health, { nowMs, pageSize, flags, viewerId: opts.viewerId ?? null }); const demoted = flags.healthOrder ? healthDemotedRowIds(m.members, health, nowMs) : null; // §86 — ONE `rank_events` read serves both of this function's readings: §9's
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
    placeId: r.clusterPlaceId, mediaType: r.mediaType ?? null, text: r.text ?? null,
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
      ? [...rows.filter((r) => reserved.has(r.id)), ...healthOrderedIf(rows.filter((r) => !reserved.has(r.id)), demoted)]
      : healthOrderedIf(rows, demoted); // §86 (DC-05): behind the health-order flag, what §11 counts against the Trail is considered last
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
    const d = diversifyTrailModule(considered.map(saturationItem), { pageSize }); // §86 (DV-23): §10's five clauses
    const kept = new Set(d.page.map((i) => i.id));
    const items = healthOrderedIf(rows, demoted).filter((r) => kept.has(r.id)).map(toItem);
    return { key, objective, horizonMs, items, moreFromThisPlace: d.moreFromThisPlace, explorationSlots: null, ...heldBackItems(d, rows) };
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

  const picks = await trailPersonalizedPicks(sc, served, opts.viewerId ?? null, nowMs); return boundCreatorsAcrossPage(served, {  // §93 (DV-09): `02` §8 Personalized Picks on `01` §9's Trail objective — null (no module, nothing else read) unless 3500's Trail flag and 3450 are both on
    refusal: null,
    health,
    momentumProvenance,
    modules: [
      justArrived,
      build("trending_now", "momentum", 2 * DAY, byMomentum),
      build("evergreen", "durable_quality", null,
        byConfidence.filter((r) => r.content_state === "evergreen" || r.content_state === "featured")),
      build("local_picks", "curation", null, byConfidence.filter((r) => r.source === "curated")), ...(picks ? [build("personalized_picks", "trail_objective", null, picks)] : []),
    ],
  }); // §86 (DV-13): one creator across the whole Trail page
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
  const unaccepted = await readUnacceptedEdges(sc, trailId); if (unaccepted === null) return { refusal: "db_error", edges: [] }; // §86 (DV-24): only an ACCEPTED declaration is navigable
  const listed = new Set<string>();
  const rows = [
    ...((out.data ?? []) as any[]).map((e) => ({ other: e.to_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "out" as const })),
    ...((inc.data ?? []) as any[]).map((e) => ({ other: e.from_trail_id, edgeType: e.edge_type, strength: Number(e.strength), direction: "in" as const })),
    ...(t.trail.parent_trail_id
      ? [{ other: t.trail.parent_trail_id, edgeType: "child", strength: 1, direction: "in" as const }] : []),
    ...((kids.data ?? []) as any[]).map((k) => ({ other: k.id as string, edgeType: "child", strength: 1, direction: "out" as const })),
  ].filter((r) => {
    const key = `${r.other}|${r.edgeType}|${r.direction}`; if (unaccepted.has(key)) return false;
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
  refusal: TrailRefusal; /** census-discovery §105 (DV-83, D-W11X2-60): the member-source reads that FAILED, present only then; the route names one generic source, never these. */ membersUnread?: string[];
  /** Trail-level momentum in [0,1] from the SHIPPING momentum kernel, or null. */
  momentum: number | null; /** §61.17: set ONLY when the Trail-momentum read FAILED — `momentum: null` alone also means "no members", a measured empty (DC-17). */ momentumUnread?: true; /** §86 (DV-74): a trend integrity review in force suppresses this Trail's trend. */ trendSuppressed?: true;
  /** Member items with momentum, strongest first. Never a raw score to a client. */
  items: Array<{ id: string; sourceType: string; sourceId: string }>; /** §86 follow-up (DV-23): §10's clause 5 on the trending list — counts per place (serialised when non-empty) and every held-back member (never serialised; GET …/more returns them). */ moreFromThisPlace?: Record<string, number>; heldBackByPlace?: Record<string, TrailModule["items"]>; heldBackUnplaced?: TrailModule["items"];
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

async function trailTrendingRead( // census-discovery §105: exported as trailTrending at the foot, which names a failed member read
  sc: any, trailId: string, nowMs = Date.now(), opts: { viewerId?: string | null; ignoreTrendReview?: boolean; memberUnread?: Set<string> } = {}, // §86: the admin evidence reads the trend UNDER review
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

  const servable = await servableMembers(sc, m.members, opts.viewerId ?? null, nowMs, opts.memberUnread); // §64: every reading below is over what THIS viewer may be served
  // Nothing this viewer may be served ⇒ no reading was taken (DC-17), exactly
  // as for an EMPTY Trail, so a withheld member is not told apart from none (§64).
  if (servable.length === 0) return none(null);

  // Per-item ORDER: the discovery-surface rows the momentum loader reads, in
  // both served id spaces, through the shipping kernel. Trail MOMENTUM: the
  // same kernel over every surface the members are served on, folded onto the
  // Trail — one kernel, two scopes, no second velocity model (DV-25). Two reads
  // because the two scopes differ; neither is cached, so neither can hand the
  // other a corpus chosen for a different member set.
  let perItem: Record<string, number> = {};
  let momentumProvenance: DerivedStoreProvenance | null = null;
  const itemRead = await readMemberEvents(sc, servable, nowMs, "discovery");
  if (itemRead) {
    const reading = computeLocalMomentum(itemRead.rows, nowMs);
    perItem = { ...reading.values };
    momentumProvenance = reading.provenance;
  } else {
    logger.warn({ trailId }, "trail trending item read failed");
  }

  let trailMomentum: number | null = null;
  const trailRead = await readMemberEvents(sc, servable, nowMs, null);
  if (trailRead) {
    if (!itemRead) momentumProvenance = localMomentumProvenance(nowMs); trailMomentum = trailMomentumFromRankEvents(trailRead.rows, servable, nowMs)[trailId] ?? 0; // H-P8-1 (§58.4, §61): the read SUCCEEDED, so no entry is a measured 0; only a failed read leaves null — §75 (DC-17, H-P21-5): only the per-item read failed, so the boolean below IS measured — by the fold's own kernel call, whose record is this one (same kernel, same clock; pinned equal by a test), never null beside a measured answer.
  } else {
    logger.warn({ trailId }, "trail trending event read failed");
  }

  // The list is what this VIEWER may be served (`servableMembers`), one row per
  // content, and it passes through §10's creator and place caps like every
  // module does — a momentum-ordered list is exactly where one creator's
  // surge would otherwise fill all twenty places (DV-13). The boolean above is
  // measured over the same servable members (§64): a withheld member's
  // activity must not make a Trail "trending" to a viewer it is withheld from.
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
  const linked = linkVenueClusters(ranked, await readMemberGeography(sc, ranked)); // §86 follow-up (DV-23): a venue post and the place member of that venue are one cluster here too
  const d = diversifyTrailModule(linked.map(moduleSaturationItem), { pageSize: TRAIL_TRENDING_PAGE_SIZE }); // all five of §10's clauses, exactly as every module applies them
  const capped = new Set(d.page.map((i) => i.id));
  const items = ranked
    .filter((r) => capped.has(r.id))
    .map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id })); const held = { ...(Object.keys(d.moreFromThisPlace).length > 0 ? { moreFromThisPlace: d.moreFromThisPlace } : {}), ...heldBackItems(d, linked) };
  const review = opts.ignoreTrendReview ? "none" : await readTrendReviewVerdict(sc, "trail", trailId); if (review !== "none") return { refusal: null, momentum: review === "suppressed" ? 0 : null, items: [], momentumProvenance, ...(review === "suppressed" ? { trendSuppressed: true as const } : { momentumUnread: true as const }) }; // §86 (DV-74): suppressed → a measured "not trending"; unreadable → unknown, never a claim
  return { refusal: null, momentum: trailMomentum, items, momentumProvenance, ...held, ...(trailRead ? {} : { momentumUnread: true as const }) }; // §61.17: the route serves `trending: null` only for THIS
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
 * SERIALISED since 3415 (census-discovery §61): these checks read a catalogue
 * a racing proposal may not be in yet, so they are the PRE-check. The decision
 * is `trail_propose`'s, taken under a per-title-token advisory lock over the
 * catalogue as it stands, with the insert in the same transaction; of racing
 * near-duplicates exactly one is admitted (db/trailsProposalRace.db.test.ts).
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

  // DC-03 (§61): the DECISION is taken where the insert is. `trail_propose`
  // (3415) takes a per-title-token advisory lock, re-reads this comparison set,
  // re-runs the four checks and the parent's waiver in SQL, and inserts, so a
  // racing near-duplicate the read above could not see is refused there. The
  // checks above stay as the fast pre-check; on the non-racing path both agree
  // (db/trailsProposalRace.db.test.ts). Without 3415 this FAILS CLOSED (503).
  const committed = await commitTrailProposal(sc, {
    title: String(input.title).trim(),
    destination,
    description: typeof input?.description === "string" ? input.description.trim() : null,
    parentTrailId: parentId,
    proposerId,
  });
  if (committed.kind === "unavailable") return { ...none, refusal: "trails_unavailable" };
  if (committed.kind === "invalid_parent") return { ...none, refusal: "invalid_request" };
  if (committed.kind === "refused") {
    return { refusal: null, trail: null, canonicalisation: committed.refusals, suggestedParentTrailId: committed.suggestedParentTrailId };
  }
  if (committed.kind === "error") {
    // A UNIQUE slug collision is §5 check 1 arriving from the database rather
    // than from the comparison set. Reported as the same refusal, so a caller
    // cannot tell the two apart and cannot act on the difference.
    if (String(committed.error.code) === "23505") {
      return {
        refusal: null, trail: null, suggestedParentTrailId: null,
        canonicalisation: [{ check: "duplicate_title_similarity", conflictsWith: null, similarity: 1 }],
      };
    }
    return { ...none, refusal: refusalFor(committed.error, "proposeTrail.insert") };
  }
  // §5's canonicalization metadata is written by trail_propose: it knows the catalogue the decision was taken over.

  const created = committed.trail as unknown as TrailRow;

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
  refusal: TrailRefusal; attached: number;
  /** §4's cap refusals, per label; and (§61) labels whose content is unknown to the actor, or has no table. */
  capRefusals: LabelRefusal[];
  sourceRefusals?: AttachSourceRefusal[]; /** §86 (DC-20): labels held as PENDING suggestions for the content's owner — not members, no §4 budget spent. */ suggested?: number;
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
  // §61 (DC-20's integrity leg): the content must EXIST in the table its type
  // names and be content this actor could be served (servableMembers' rules);
  // `itinerary` has no table and is refused as unverifiable; a source that
  // cannot be read admits NOTHING. Unknown and unseen are one answer.
  const verified = await verifyAttachSources(sc, labels, actor.userId, servableMembers);
  if (verified.unreadable) return { refusal: "source_unreadable", attached: 0, capRefusals: [] };
  const ownership = await routeLabelsByOwnership(sc, t.trail, labels, verified, actor); if (ownership.refusal) return { refusal: ownership.refusal, attached: 0, capRefusals: [] }; // §86 (DC-20): who may attach, and a stranger's suggestion waits for the owner
  const sourceRefusals = [...verified.refusals, ...ownership.refusals]; const admitted = ownership.owned; const suggested = ownership.suggested > 0 ? { suggested: ownership.suggested } : {};
  if (admitted.length === 0) return { refusal: null, attached: 0, capRefusals: [], sourceRefusals, ...suggested };

  // §4's budgets are per CONTENT, not per Trail, so the held labels are read
  // across every Trail this content already belongs to.
  const sourceIds = [...new Set(admitted.map((l) => l.sourceId))];
  const held = await sc.from("content_trails").select("trail_id, relationship, signal, source_type, source_id")
    .in("source_id", sourceIds);
  if (held.error) return { refusal: refusalFor(held.error, "attach.held"), attached: 0, capRefusals: [] };
  const proposed: TrailLabel[] = admitted.map((l) => ({
    relationship: l.relationship as TrailRelationship, trailId,
    signal: l.relationship === "signal" ? (l.signal ?? null) : null,
  }));
  // §4's budgets are PER CONTENT, judged per (source_type, source_id) — the 2910/3380 trigger's key — never per request (§51.4).
  const contentKey = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`;
  const groups = new Map<string, TrailLabel[]>();
  admitted.forEach((l, i) => {
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
    return { refusal: null, attached: 0, capRefusals: capped.refusals, sourceRefusals, ...suggested };
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
    .map((label, i) => ({ label, source: admitted[i] }))
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
        refusal: null, attached: 0, sourceRefusals,
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

  return { refusal: null, attached: rows.length, capRefusals: capped.refusals, sourceRefusals, ...suggested };
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

// ── census-discovery §64: who an EVENT or a ROUTE member may be served to ────
//
// `servableMembers` served an event or a route plan to every viewer whenever
// its row existed (§61.4). A Trail is a public space, and until the owner says
// otherwise (§61.12 question 4) it may serve such content only as the product
// already would. None of the rules below is new; each is quoted from where it
// is enforced today.
//
// EVENTS. Anyone may read an event the database's own public policy admits:
//   `events_public_read` (2033_rls_hardening.sql:266, baseline :28027):
//     visibility = 'public' AND state IN ('open','full','waitlist','started',
//     'completed') AND NOT viewer_is_blocked(host_id)
// The block leg is `servableMembers`' own (the host is the member's creator).
// Two rules of the API are STRICTER than that policy, and both are applied:
//   - a viewer the host BANNED may not read it (routes/events.ts
//     checkEventEligibility, which GET /events/:id runs after canViewEvent;
//     the /events feed drops `bannedEvents`);
//   - an event that gates its viewers by age, trust or verification 404s to an
//     ineligible viewer (GET /events/:id), and a Trail does not resolve a
//     viewer's eligibility, so such an event is its host's only. That is the
//     fail-closed default posts already get when membership is not resolved.
// Everything else — friends-only, invite-only, the API's circle/trip values, a
// draft, cancelled or archived event — is served to its HOST only, the posts'
// author exception. Friends, invitees, RSVP holders and co-hosts may read such
// an event elsewhere (canViewEvent), and 2033's `events_participant_read`
// admits participants but not friends: the two surfaces disagree, and in a
// public space neither relationship is resolved, as a post's followers and
// trip members are not. A public event's `circle_id` / `trip_id` scope nothing
// in the product (every surface above reads `visibility` alone, and
// POST /events/:id/link-circle keeps an event public unless the host asks), so
// they scope nothing here either.
//
// ROUTES. A route plan has no public concept. It is readable by its owner, and
// — when it belongs to a trip — by that trip's ACCEPTED crew: migration 2334's
// `route_plans_member_select` (authz.is_trip_crew), GET /route-plans/:id and
// lib/trailLiveIntel.ts all delegate to lib/http.ts `requireTripMember`, which
// this reuses as it is. A draft or cancelled plan is its owner's alone
// (stricter than those three, which admit the crew to a draft). No product
// rule shares a route plan with a circle, so `circle_id` admits no one.
//
// FAIL CLOSED. The ban read and each trip's membership read are resolved once
// per call; one that cannot be read withholds every member it would have
// vouched for and is named in `unread` (attach answers 503). The host, the
// owner and an anonymous viewer need neither read.

/** `events_public_read`'s state allowlist (2033_rls_hardening.sql:266): the states in which anyone may read a public event. */
export const EVENT_PUBLIC_READ_STATES: ReadonlySet<string> = new Set(["open", "full", "waitlist", "started", "completed"]);
/** The route-plan statuses a trip's accepted crew is served; a draft or a cancelled plan is its owner's alone. */
export const ROUTE_CREW_STATUSES: ReadonlySet<string> = new Set(["active", "completed"]);

/** checkEventEligibility's viewer gates (verified, trust, age), which a Trail does not resolve per viewer. */
function eventGatesItsViewers(e: any): boolean {
  return e?.verified_only === true || e?.trust_score_min != null || e?.age_min != null || e?.age_max != null;
}

/** Public, in a public-read state, gating no viewer: servable to every viewer the host has not banned. */
function eventIsPubliclyReadable(e: any): boolean {
  return e?.visibility === "public" && EVENT_PUBLIC_READ_STATES.has(String(e?.state)) && !eventGatesItsViewers(e);
}

interface MemberAccess {
  event(row: any): boolean;
  route(row: any): boolean;
}

async function memberAccessFor(
  sc: any, events: Map<string, any> | null, routes: Map<string, any> | null,
  viewerId: string | null, unread?: Set<string>,
): Promise<MemberAccess> {
  // Bans: only for the events this viewer could otherwise be served, and never for their own.
  let banned: Set<string> | null = new Set();
  const banCandidates = viewerId
    ? [...(events?.values() ?? [])].filter((e) => e.host_id !== viewerId && eventIsPubliclyReadable(e)).map((e) => String(e.id))
    : [];
  if (banCandidates.length > 0) {
    const { data, error } = await sc.from("event_roles").select("event_id")
      .eq("user_id", viewerId).eq("role", "banned").in("event_id", banCandidates);
    if (error || !Array.isArray(data)) {
      unread?.add("event_roles");
      logger.warn({ code: error?.code, message: error?.message }, "trail event bans unread — public events withheld from this viewer");
      banned = null;
    } else {
      banned = new Set((data as any[]).map((r) => String(r.event_id)));
    }
  }

  // Trip crew: one requireTripMember per trip that could admit this viewer.
  const crewTrips = viewerId
    ? [...new Set([...(routes?.values() ?? [])]
      .filter((r) => r.owner_user_id !== viewerId && typeof r.trip_id === "string" && ROUTE_CREW_STATUSES.has(String(r.status)))
      .map((r) => r.trip_id as string))]
    : [];
  const crewOf = new Map<string, boolean>(); // absent ⇒ unread ⇒ not crew
  await Promise.all(crewTrips.map(async (tripId) => {
    try {
      crewOf.set(tripId, (await requireTripMember(sc, tripId, viewerId!)) !== null);
    } catch (err) {
      unread?.add(err instanceof TripAccessUnavailableError ? err.input : "trip_members");
      logger.warn({ tripId, err: (err as Error)?.message }, "trail route crew unread — the trip's routes withheld from this viewer");
    }
  }));

  return {
    event: (e) => (viewerId !== null && e.host_id === viewerId)
      || (eventIsPubliclyReadable(e) && (viewerId === null || (banned !== null && !banned.has(String(e.id))))),
    route: (r) => (viewerId !== null && r.owner_user_id === viewerId)
      || (viewerId !== null && typeof r.trip_id === "string" && ROUTE_CREW_STATUSES.has(String(r.status)) && crewOf.get(r.trip_id) === true),
  };
}

/**
 * The §12 word and the member count GET …/:id SHOWS, over the members this
 * viewer may be served (§64). Counted over every member, a friends-only event
 * or another traveller's route raised `memberCount` for everyone — the count
 * disclosed a member that was withheld — and one attached today could turn a
 * stranger's "Quiet right now" into "Fresh today". The whole-Trail `health`
 * (the ranking multiplier, the hourly snapshot) is unchanged and never served.
 * When every member is servable to the viewer, the two are the same numbers.
 */
async function servedTrailView(sc: any, members: readonly MemberRow[], viewerId: string | null, nowMs: number): Promise<TrailHealth & { membersUnread?: string[] }> {
  const unread = new Set<string>(); const served = await servableMembers(sc, members, viewerId, nowMs, unread); // §105 (DV-83): a failed member read is carried to the route
  return withMembersUnread(computeTrailHealth({
    members: served.map((r) => ({
      source_id: r.source_id, contributor_id: r.contributor_id,
      confidence: Number(r.confidence), content_state: r.content_state, created_at: r.created_at,
    })),
    reportCount: null, // the view feeds §12's word and the count only; `report_rate` stays the whole Trail's
    nowMs,
  }), unread);
}

// ── census-discovery §75 (DC-17, lane P33, H-P21-3): the snapshot keeps its window and feature version ─
//
// 3436 adds `feature_version` and `source_window` to `trail_health_snapshots`.
// A deployment without 3436 answers 42703 / PGRST204 for either column; the
// first such answer latches this process and the row is written with the five
// pre-3436 columns, exactly as before — a missing PROVENANCE column must never
// cost the snapshot it describes. Declared at the foot, with its imports (ES
// imports are hoisted), so no cited line above moves.

import { isMissingColumnError } from "../../lib/capability/schemaCapability.js";
import { localMomentumProvenance } from "../../lib/discoveryLocalMomentum.js";

/** `unknown` until a write proves 3436 absent here. Process-wide, like 2891's latch (lib/rankEventsProvenance). */
let trailSnapshotProvenanceColumns: "unknown" | "absent" = "unknown";

/** Test seam: the latch is process-wide, so a suite simulating a 3436-less database must reset it. */
export function _resetTrailSnapshotProvenanceLatch(): void {
  trailSnapshotProvenanceColumns = "unknown";
}

/** Has a write established that 3436's two columns are absent on this database? */
export function trailSnapshotProvenanceAbsent(): boolean {
  return trailSnapshotProvenanceColumns === "absent";
}

interface TrailHealthSnapshotRow {
  trail_id: string;
  metrics: TrailHealth["metrics"];
  model_version: string;
  member_count: number;
  captured_at: string;
}

async function insertTrailHealthSnapshotRow(sc: any, health: TrailHealth, row: TrailHealthSnapshotRow): Promise<{ error: any }> {
  if (trailSnapshotProvenanceColumns !== "absent") {
    const w = health.sourceWindow;
    const first = await sc.from("trail_health_snapshots").insert({
      trail_id: row.trail_id, metrics: row.metrics, model_version: row.model_version,
      member_count: row.member_count, captured_at: row.captured_at,
      feature_version: health.featureVersion,
      source_window: {
        kind: w.kind,
        start: w.startMs === null ? null : new Date(w.startMs).toISOString(),
        end: new Date(w.endMs).toISOString(),
      },
    });
    if (!first?.error || !isMissingColumnError(first.error)) return { error: first?.error ?? null };
    trailSnapshotProvenanceColumns = "absent";
    logger.warn(
      { code: first.error.code, migration: "3436_trail_health_snapshot_provenance.sql" },
      "trail health snapshot: feature_version / source_window unavailable — written without them until 3436 is applied here",
    );
  }
  const legacy = await sc.from("trail_health_snapshots").insert({
    trail_id: row.trail_id, metrics: row.metrics, model_version: row.model_version,
    member_count: row.member_count, captured_at: row.captured_at,
  });
  return { error: legacy?.error ?? null };
}

// ── census-discovery §86 (lane W10-T): Trails product rules, machinery and moderation ─
//
// Declared at the foot, with their imports (ES imports are hoisted), so no cited
// line above moves. Each rule names its decision in
// docs/architecture/discovery-decision-register.md, section W10-T.

import {
  readTrailRankingFlags, decideContentTransition, insideJustArrivedHorizon, rotateExplorationSlots, exposureVerdict,
  readTrailOwnExposures, readStateChangedAt, persistContentTransitions, recordTrailModuleExposures, stateSinceMs,
  TRAIL_RETEST_INTERVAL_MS, JUST_ARRIVED_HORIZON_MS,
  type TrailRankingFlags, type ContentTransition, type MeasuredExposure, type RotationCandidate,
} from "./trailExploration.js";
import {
  diversifyTrailModule, healthDemotedRowIds, healthOrdered, creatorPageBoundRemovals, trailGeoCell,
} from "../../lib/discoveryTrailHealth.js";
import { isTrailContentState, TRAIL_SIGNALS } from "../../lib/discoveryTrailObject.js";
import { normalizeLocationName, haversineKm } from "../../lib/canonicalLocations.js";
import type { AttachSourceVerdict } from "./trailAttachIntegrity.js"; import { trailPersonalizedPicks } from "../../lib/discoverySurfaceObjectiveRank.js";  // §93 (W11-X1, DV-09)

/** What serving one flag-on modules page owes the database, settled after the response (`settleTrailModulesServe`). */
export interface TrailServeEffects {
  transitions: ContentTransition[];
  served: Array<{ sourceType: string; sourceId: string }>;
  nowMs: number;
}

function healthOrderedIf<T extends { id: string }>(rows: readonly T[], demoted: ReadonlySet<string> | null): T[] {
  return demoted ? healthOrdered(rows, demoted) : [...rows];
}

/** `{ heldBackByPlace, heldBackUnplaced }`, each only when non-empty — so a module that held nothing back is byte-identical to before §86. */
function heldBackItems(
  d: { heldBackByPlace: Record<string, string[]>; heldBackUnplaced: string[] }, rows: readonly ServableMember[],
): { heldBackByPlace?: Record<string, TrailModule["items"]>; heldBackUnplaced?: TrailModule["items"] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const asItems = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((r): r is ServableMember => r !== undefined)
    .map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id, contentState: r.content_state }));
  const out: Record<string, TrailModule["items"]> = {};
  for (const [place, ids] of Object.entries(d.heldBackByPlace)) out[place] = asItems(ids);
  const unplaced = asItems(d.heldBackUnplaced);
  return { ...(Object.keys(out).length > 0 ? { heldBackByPlace: out } : {}), ...(unplaced.length > 0 ? { heldBackUnplaced: unplaced } : {}) };
}

/** One member as §10's diversity pass reads it: the creator where the source has one, its cluster place, media kind and text. */
function moduleSaturationItem(r: ServableMember) {
  return { id: r.id, placeId: r.clusterPlaceId, contributorId: r.creatorId ?? r.contributor_id, mediaType: r.mediaType ?? null, text: r.text ?? null };
}

// ── DC-05 / DV-23: where members are, and which place members are one venue ───

export interface MemberGeography {
  /** source_id → §11 geographic cell (D-W10T-7); `null` when a source read failed, so the metric is unmeasured rather than skewed. */
  cellBySource: Record<string, string> | null;
  /** A canonical `places` id → the `discovery_places` MEMBER of the same venue (D-W10T-4). */
  venueOf: Map<string, string>;
}

/** matchCanonical's venue rule (lib/canonicalLocations.ts: same normalised name, within VENUE_MATCH_KM = 1.5 km). */
export const TRAIL_VENUE_MATCH_KM = 1.5;

/**
 * One read per source table, fail-soft: coordinates come from a PLACE (a place
 * member's own row; a post's canonical place; an event's own venue), never from
 * a post author's GPS. A route has no single location and gets no cell.
 */
export async function readMemberGeography(sc: any, members: readonly MemberRow[]): Promise<MemberGeography> {
  const ids = (type: string) => [...new Set(members.filter((m) => m.source_type === type).map((m) => m.source_id))];
  const read = async (q: () => PromiseLike<{ data: any; error: any }>, n: number): Promise<any[] | null> => {
    if (n === 0) return [];
    try {
      const { data, error } = await q();
      return error || !Array.isArray(data) ? null : data;
    } catch { return null; }
  };
  const postIds = ids("post"), placeIds = ids("place"), eventIds = ids("event");
  const posts = await read(() => sc.from("posts").select("id, canonical_place_id").in("id", postIds), postIds.length);
  const canonicalOfPost = new Map<string, string>((posts ?? []).filter((p) => typeof p?.canonical_place_id === "string").map((p) => [String(p.id), String(p.canonical_place_id)]));
  const canonicalIds = [...new Set([...placeIds, ...canonicalOfPost.values()])];
  const [community, canonical, events] = await Promise.all([
    read(() => sc.from("discovery_places").select("id, name, lat, lng").in("id", placeIds), placeIds.length),
    read(() => sc.from("places").select("id, name, latitude, longitude").in("id", canonicalIds), canonicalIds.length),
    read(() => sc.from("events").select("id, location_lat, location_lng").in("id", eventIds), eventIds.length),
  ]);
  const at = new Map<string, { name: string; lat: unknown; lng: unknown }>();
  for (const c of canonical ?? []) at.set(String(c.id), { name: String(c.name ?? ""), lat: c.latitude, lng: c.longitude });
  for (const d of community ?? []) at.set(String(d.id), { name: String(d.name ?? ""), lat: d.lat, lng: d.lng });

  const venueOf = new Map<string, string>();
  for (const c of canonical ?? []) {
    const cid = String(c.id), cn = normalizeLocationName(String(c.name ?? ""));
    const cla = Number(c.latitude), clo = Number(c.longitude);
    if (!cn || c.latitude == null || c.longitude == null || !Number.isFinite(cla) || !Number.isFinite(clo)) continue;
    for (const d of community ?? []) {
      if (d.lat == null || d.lng == null || String(d.id) === cid) continue;
      if (normalizeLocationName(String(d.name ?? "")) !== cn) continue;
      if (haversineKm(cla, clo, Number(d.lat), Number(d.lng)) <= TRAIL_VENUE_MATCH_KM) { venueOf.set(cid, String(d.id)); break; }
    }
  }

  let cellBySource: Record<string, string> | null = {};
  if (posts === null || community === null || canonical === null || events === null) cellBySource = null;
  else {
    for (const m of members) {
      let cell: string | null = null;
      if (m.source_type === "place") { const g = at.get(m.source_id); cell = g ? trailGeoCell(g.lat, g.lng) : null; }
      else if (m.source_type === "post") { const cp = canonicalOfPost.get(m.source_id); const g = cp ? at.get(cp) : undefined; cell = g ? trailGeoCell(g.lat, g.lng) : null; }
      else if (m.source_type === "event") { const e = (events ?? []).find((x) => String(x.id) === m.source_id); cell = e ? trailGeoCell(e.location_lat, e.location_lng) : null; }
      if (cell) cellBySource[m.source_id] = cell;
    }
  }
  return { cellBySource, venueOf };
}

/** DV-23: a member clustered at a canonical venue is clustered at the place MEMBER of that venue. */
export function linkVenueClusters(served: ServableMember[], geo: MemberGeography): ServableMember[] {
  if (geo.venueOf.size === 0) return served;
  return served.map((r) => {
    const linked = r.clusterPlaceId ? geo.venueOf.get(r.clusterPlaceId) : undefined;
    return linked ? { ...r, clusterPlaceId: linked } : r;
  });
}

/** DC-05: impressions per member over the window, every surface, both id spaces; `null` when unread or cut. */
export async function readMemberImpressions(sc: any, members: readonly MemberRow[], nowMs: number): Promise<Record<string, number> | null> {
  if (members.length === 0) return {};
  const read = await readMemberEvents(sc, members, nowMs, null);
  if (!read || read.truncated) return null;
  const out: Record<string, number> = {};
  for (const r of read.rows) out[r.item_id] = (out[r.item_id] ?? 0) + 1;
  return out;
}

// ── DV-13: one creator across the whole Trail page ────────────────────────────

function boundCreatorsAcrossPage(served: readonly ServableMember[], r: TrailModulesResult): TrailModulesResult {
  const byId = new Map(served.map((s) => [s.id, s]));
  const creatorOf = (id: string) => { const s = byId.get(id); return s ? (s.creatorId ?? s.contributor_id ?? null) : null; };
  const removed = creatorPageBoundRemovals(r.modules, creatorOf);
  if (removed.size === 0) return r;
  // D-W10T-15: an item the page bound removes is HELD BACK, not erased — counted and listed under its place
  // (or listed as unplaced) in the module that removed it, exactly as the module's own caps hold items.
  return {
    ...r,
    modules: r.modules.map((m) => {
      const gone = m.items.filter((i) => removed.has(i.id));
      if (gone.length === 0) return m;
      const more = { ...m.moreFromThisPlace };
      const byPlace: Record<string, TrailModule["items"]> = { ...(m.heldBackByPlace ?? {}) };
      const unplaced: TrailModule["items"] = [...(m.heldBackUnplaced ?? [])];
      for (const it of gone) {
        const place = byId.get(it.id)?.clusterPlaceId ?? null;
        if (place) { more[place] = (more[place] ?? 0) + 1; byPlace[place] = [...(byPlace[place] ?? []), it]; } else unplaced.push(it);
      }
      return {
        ...m, items: m.items.filter((i) => !removed.has(i.id)), moreFromThisPlace: more,
        ...(Object.keys(byPlace).length > 0 ? { heldBackByPlace: byPlace } : {}), ...(unplaced.length > 0 ? { heldBackUnplaced: unplaced } : {}),
      };
    }),
  };
}

// ── DV-22 / DV-21 / DC-04: the modules behind discovery_trail_exploration_enabled ─

function buildTrailModule(
  key: TrailModule["key"], objective: TrailModule["objective"], horizonMs: number | null,
  rows: readonly ServableMember[], pageSize: number, reserved: ReadonlySet<string> | null, demoted: ReadonlySet<string> | null,
): TrailModule {
  const base = healthOrderedIf(rows, demoted);
  const ordered = reserved && reserved.size > 0 ? [...base.filter((r) => reserved.has(r.id)), ...base.filter((r) => !reserved.has(r.id))] : base;
  const seen = new Set<string>();
  const considered = ordered.filter((r) => {
    const k = `${r.source_type}:${r.source_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const d = diversifyTrailModule(considered.map(moduleSaturationItem), { pageSize });
  const kept = new Set(d.page.map((i) => i.id));
  const items = base.filter((r) => kept.has(r.id)).map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id, contentState: r.content_state }));
  return { key, objective, horizonMs, items, moreFromThisPlace: d.moreFromThisPlace, explorationSlots: null, ...heldBackItems(d, rows) };
}

/** Normalised response on measured rows for hidden_gems' order: judged items by rate, then the least-exposed. */
function responseOrder(measured: Record<string, TrailExposureCount> | null) {
  return (a: ServableMember, b: ServableMember): number => {
    const ea = measured?.[a.source_id] ?? null, eb = measured?.[b.source_id] ?? null;
    const va = exposureVerdict(ea), vb = exposureVerdict(eb);
    const judged = (v: string) => v === "expand" || v === "taper";
    if (judged(va) !== judged(vb)) return judged(va) ? -1 : 1;
    if (judged(va)) {
      const ra = ea!.positives / ea!.impressions, rb = eb!.positives / eb!.impressions;
      if (ra !== rb) return rb - ra;
    } else {
      const ia = ea?.impressions ?? 0, ib = eb?.impressions ?? 0;
      if (ia !== ib) return ia - ib;
    }
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  };
}

async function trailModulesExplored(
  sc: any, trailId: string, members: readonly MemberRow[], served: ServableMember[], health: TrailHealth,
  o: { nowMs: number; pageSize: number; flags: TrailRankingFlags; viewerId?: string | null },
): Promise<TrailModulesResult> {
  const { nowMs, pageSize } = o;
  const demoted = o.flags.healthOrder ? healthDemotedRowIds(members, health, nowMs) : null;
  // §9 step 3 on MEASURED rows: the Discovery surface, both id spaces, for every served member.
  const events: MemberEventRead | undefined = served.length > 0 ? await readMemberEvents(sc, served, nowMs, "discovery") : { rows: [], truncated: false };
  const measured = events && !events.truncated ? exposureCountsFrom(events.rows, new Set(served.map((r) => r.source_id))) : null;
  const measuredOf = (r: ServableMember): MeasuredExposure | null => (measured ? (measured[r.source_id] ?? { impressions: 0, positives: 0 }) : null);

  let momentum: Record<string, number> = {};
  let momentumProvenance: DerivedStoreProvenance | null = null;
  const placeMembers = served.filter((r) => r.source_type === "place");
  if (placeMembers.length > 0 && events) {
    const placeIds = new Set(placeMembers.map((r) => r.source_id));
    const reading = computeLocalMomentum(events.rows.filter((e) => placeIds.has(e.item_id)), nowMs);
    momentum = { ...reading.values };
    momentumProvenance = reading.provenance;
  }

  // §7: the move each member is owed now, decided BEFORE the page is built so
  // the page is served from the decided states; persisted after the response.
  const stamps = await readStateChangedAt(sc, served.map((r) => r.id));
  const stampOf = (r: ServableMember) => (stamps ? (stamps.has(r.id) ? stamps.get(r.id)! : null) : undefined);
  const transitions: ContentTransition[] = [];
  const view: ServableMember[] = [];
  const sinceById = new Map<string, number | null>();
  for (const r of served) {
    const createdAtMs = Date.parse(r.created_at);
    const to = decideContentTransition({ state: r.content_state, createdAtMs, stateChangedAtMs: stampOf(r), measured: measuredOf(r), nowMs });
    if (to && isTrailContentState(r.content_state)) transitions.push({ rowId: r.id, from: r.content_state, to });
    sinceById.set(r.id, to ? nowMs : stateSinceMs({ state: r.content_state, createdAtMs, stateChangedAtMs: stampOf(r) }));
    view.push(to ? { ...r, content_state: to } : r);
  }
  const since = (r: ServableMember) => sinceById.get(r.id) ?? null;

  const byNewest = [...view].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const arrived = byNewest.filter((r) => (r.content_state === "just_arrived" || r.content_state === "rediscovered")
    && insideJustArrivedHorizon({ state: r.content_state, createdAtMs: Date.parse(r.created_at), stateChangedAtMs: since(r), nowMs }));
  const retest = byNewest.filter((r) => r.content_state === "archived_from_active_rotation" && since(r) !== null && nowMs - since(r)! >= TRAIL_RETEST_INTERVAL_MS);

  // §9 steps 1, 2, 5: rotation through the backlog by denominator. Unmeasured → no reservation (as before: `null`, never `[]`).
  const own = await readTrailOwnExposures(sc, trailId, nowMs);
  let explorationSlots: string[] | null = null;
  if (own && measured) {
    const cands: RotationCandidate[] = [...arrived, ...retest].map((r) => ({
      id: r.id, state: r.content_state, queuedAtMs: since(r) ?? Date.parse(r.created_at),
      trailImpressions: own[`${r.source_type}:${r.source_id}`] ?? 0, measured: measuredOf(r),
      retestDue: r.content_state === "archived_from_active_rotation",
    }));
    explorationSlots = rotateExplorationSlots(cands, pageSize);
  }
  const reserved = new Set(explorationSlots ?? []);

  const byConfidence = [...view].sort((a, b) => Number(b.confidence) - Number(a.confidence));
  const byMomentum = [...view].sort((a, b) => (momentum[b.source_id] ?? 0) - (momentum[a.source_id] ?? 0))
    .filter((r) => (momentum[r.source_id] ?? 0) > 0 && r.content_state !== "archived_from_active_rotation"); // out of rotation means out of every module but a retest slot
  const justArrived = buildTrailModule("just_arrived", "recency", JUST_ARRIVED_HORIZON_MS,
    [...arrived, ...retest.filter((r) => reserved.has(r.id))], pageSize, reserved, demoted);
  justArrived.explorationSlots = explorationSlots;

  const picks = await trailPersonalizedPicks(sc, view, o.viewerId ?? null, nowMs); const result = boundCreatorsAcrossPage(served, {  // §93 (DV-09): as the default branch, over the decided states
    refusal: null, health, momentumProvenance,
    modules: [
      justArrived,
      buildTrailModule("trending_now", "momentum", 2 * DAY, byMomentum, pageSize, null, demoted),
      buildTrailModule("hidden_gems", "response_under_exposure", MOMENTUM_BASELINE_WINDOW_MS,
        [...view].filter((r) => r.content_state === "growing").sort(responseOrder(measured)), pageSize, null, demoted),
      buildTrailModule("evergreen", "durable_quality", null,
        byConfidence.filter((r) => r.content_state === "evergreen" || r.content_state === "featured"), pageSize, null, demoted),
      buildTrailModule("local_picks", "curation", null, byConfidence.filter((r) => r.source === "curated"), pageSize, null, demoted), ...(picks ? [buildTrailModule("personalized_picks", "trail_objective", null, picks, pageSize, null, demoted)] : []),
    ],
  });
  return { ...result, serveEffects: { transitions, served: result.modules.flatMap((m) => m.items), nowMs } };
}

/** After the response: persist the decided §7 moves (compare-and-set, 3381) and count the page's serves (3487). */
export async function settleTrailModulesServe(sc: any, trailId: string, r: TrailModulesResult): Promise<void> {
  const e = r?.serveEffects;
  if (!e) return;
  try {
    if (e.transitions.length > 0) await persistContentTransitions(sc, e.transitions);
    await recordTrailModuleExposures(sc, trailId, e.served, e.nowMs);
  } catch (err) {
    logger.warn({ trailId, err: (err as Error)?.message }, "trail module serve effects not settled");
  }
}

// ── DV-23: "preserve access through more from this place" ─────────────────────

export type HeldBackListKey = TrailModule["key"] | "trending" | "beyond_window";

/**
 * The newest members a Trail's lists are computed over (readMembers). §86.14
 * (D-W10T-17): every member older than this window stays reachable through the
 * "more" routes' cursor, a bounded page of TRAIL_MORE_PAGE_SIZE at a time.
 */
export const TRAIL_MEMBER_WINDOW = 500;
/** Members one cursor page of GET …/more reads (before the viewer's visibility filter). */
export const TRAIL_MORE_PAGE_SIZE = 200;

export interface MoreFromPlaceResult {
  refusal: TrailRefusal; /** census-discovery §105 (DV-83, D-W11X2-60): the member-source reads that FAILED, present only then; the route names one generic source, never these. */ membersUnread?: string[];
  placeId: string;
  /** Per module (and the trending list), exactly the members it counted in `moreFromThisPlace[placeId]`; on a cursor page, the window's older members at this place. */
  modules: Array<{ key: HeldBackListKey; items: TrailModule["items"] }>;
  /** Opaque cursor to the next bounded page of members older than the window, or null when there are none. */
  next: string | null;
}

interface MemberCursor { c: string; i: string }

export function encodeMemberCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id }), "utf8").toString("base64url");
}

/** A cursor this server minted, or null (a malformed cursor is refused, never guessed). */
/**
 * A timestamptz exactly as PostgREST writes one (and as the fakes write one):
 * date, `T`, time, optional fraction, and an explicit zone. `Date.parse` alone
 * admits "1", "2026" and "2026-09-28 junk", which PostgreSQL refuses (22007) —
 * a malformed cursor must be a 400, never a 500 (§86.15).
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A cursor this server minted, or null (a malformed cursor is refused, never guessed).
 * A cursor dated after `nowMs` is refused too (§86.15, D-W10T-18): a window edge is a
 * member's created_at, which is never in the future, and a future cursor would
 * relabel members inside the window as `beyond_window`.
 */
export function decodeMemberCursor(cursor: string, nowMs: number = Date.now()): MemberCursor | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof v?.c !== "string" || !CURSOR_TIMESTAMP.test(v.c) || typeof v?.i !== "string" || !/^[0-9a-f-]{36}$/i.test(v.i)) return null;
    const at = Date.parse(v.c);
    if (!Number.isFinite(at) || at > nowMs) return null;
    return { c: v.c, i: v.i };
  } catch { return null; }
}

type HeldList = { key: HeldBackListKey; byPlace: Record<string, TrailModule["items"]>; unplaced: TrailModule["items"] };

/** Every list this viewer is served for a Trail, with what each held back: the modules, then GET …/trending's list; and the cursor past the window. */
async function heldBackLists(
  sc: any, trailId: string, opts: { viewerId?: string | null; nowMs?: number },
): Promise<{ refusal: TrailRefusal; lists: HeldList[]; next: string | null; membersUnread?: string[] }> {
  const r = await getTrailModules(sc, trailId, { viewerId: opts.viewerId ?? null, nowMs: opts.nowMs });
  if (r.refusal) return { refusal: r.refusal, lists: [], next: null };
  const t = await trailTrending(sc, trailId, opts.nowMs ?? Date.now(), { viewerId: opts.viewerId ?? null });
  const lists: HeldList[] = r.modules.map((m) => ({ key: m.key as HeldBackListKey, byPlace: m.heldBackByPlace ?? {}, unplaced: m.heldBackUnplaced ?? [] }));
  if (t.refusal) return { refusal: t.refusal, lists: [], next: null }; lists.push({ key: "trending", byPlace: t.heldBackByPlace ?? {}, unplaced: t.heldBackUnplaced ?? [] }); // §105 (DV-83): a refused trending read is refused, never a silently missing list (the push used to run only when it was not refused)
  const m = await readMembers(sc, trailId);
  if (m.refusal) return { refusal: m.refusal, lists: [], next: null };
  const edge = m.members.length >= TRAIL_MEMBER_WINDOW ? m.members[m.members.length - 1] : undefined;
  return { refusal: null, lists, next: edge ? encodeMemberCursor(edge) : null, ...(r.membersUnread || t.membersUnread ? { membersUnread: [...new Set([...(r.membersUnread ?? []), ...(t.membersUnread ?? [])])].sort() } : {}) };
}

/**
 * One bounded page of the members OLDER than a cursor (§86.14, D-W10T-17), keyset
 * on (created_at, id) — the order readMembers reads in — so a page neither
 * repeats nor skips a member. Only what this viewer may be served
 * (`servableMembers`), one row per content, clustered as every list clusters.
 */
async function olderMembersPage(
  sc: any, trailId: string, cursor: MemberCursor, viewerId: string | null, nowMs: number,
): Promise<{ refusal: TrailRefusal; list: HeldList | null; next: string | null; membersUnread?: string[] }> {
  const t = await readTrail(sc, trailId);
  if (t.refusal || !t.trail) return { refusal: t.refusal ?? "unknown_trail", list: null, next: null };
  const tie = await sc.from("content_trails").select(MEMBER_COLUMNS)
    .eq("trail_id", trailId).eq("created_at", cursor.c).lt("id", cursor.i)
    .order("id", { ascending: false }).limit(TRAIL_MORE_PAGE_SIZE);
  if (tie.error) return { refusal: refusalFor(tie.error, "olderMembersPage.tie"), list: null, next: null };
  const older = await sc.from("content_trails").select(MEMBER_COLUMNS)
    .eq("trail_id", trailId).lt("created_at", cursor.c)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(TRAIL_MORE_PAGE_SIZE);
  if (older.error) return { refusal: refusalFor(older.error, "olderMembersPage.older"), list: null, next: null };
  const rows = [...((tie.data ?? []) as MemberRow[]), ...((older.data ?? []) as MemberRow[])].slice(0, TRAIL_MORE_PAGE_SIZE);
  const edge = rows.length >= TRAIL_MORE_PAGE_SIZE ? rows[rows.length - 1] : undefined;
  const unread = new Set<string>(); const served = linkVenueClusters(await servableMembers(sc, rows, viewerId, nowMs, unread), await readMemberGeography(sc, rows));
  const seen = new Set<string>();
  const byPlace: Record<string, TrailModule["items"]> = {};
  const unplaced: TrailModule["items"] = [];
  for (const r of served) {
    const k = `${r.source_type}:${r.source_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const it = { id: r.id, sourceType: r.source_type, sourceId: r.source_id, contentState: r.content_state };
    if (r.clusterPlaceId) (byPlace[r.clusterPlaceId] ??= []).push(it); else unplaced.push(it);
  }
  return withMembersUnread({ refusal: null, list: { key: "beyond_window", byPlace, unplaced }, next: edge ? encodeMemberCursor(edge) : null }, unread);
}

export async function moreFromThisPlace(
  sc: any, trailId: string, placeId: string, opts: { viewerId?: string | null; nowMs?: number; cursor?: string | null } = {},
): Promise<MoreFromPlaceResult> {
  if (opts.cursor) {
    const c = decodeMemberCursor(opts.cursor, opts.nowMs ?? Date.now());
    if (!c) return { refusal: "invalid_request", placeId, modules: [], next: null };
    const p = await olderMembersPage(sc, trailId, c, opts.viewerId ?? null, opts.nowMs ?? Date.now());
    if (p.refusal || !p.list) return { refusal: p.refusal, placeId, modules: [], next: null };
    const items = p.list.byPlace[placeId] ?? [];
    return { refusal: null, placeId, modules: items.length > 0 ? [{ key: "beyond_window", items }] : [], next: p.next, ...(p.membersUnread ? { membersUnread: p.membersUnread } : {}) };
  }
  const h = await heldBackLists(sc, trailId, opts);
  if (h.refusal) return { refusal: h.refusal, placeId, modules: [], next: null };
  return {
    refusal: null, placeId,
    modules: h.lists.map((l) => ({ key: l.key, items: l.byPlace[placeId] ?? [] })).filter((m) => m.items.length > 0),
    next: h.next, ...(h.membersUnread ? { membersUnread: h.membersUnread } : {}),
  };
}

export interface MoreFromTrailResult {
  refusal: TrailRefusal; /** census-discovery §105 (DV-83, D-W11X2-60): the member-source reads that FAILED, present only then; the route names one generic source, never these. */ membersUnread?: string[];
  /** Per list, EVERY member it held back: by place, and those with no place (D-W10T-15); on a cursor page, the window's older members. */
  lists: HeldList[];
  /** Opaque cursor to the next bounded page of members older than the window, or null when there are none (D-W10T-17). */
  next: string | null;
}

/** D-W10T-15/-17: nothing a Trail page holds back, and no member past the window, is unreachable. */
export async function moreFromThisTrail(
  sc: any, trailId: string, opts: { viewerId?: string | null; nowMs?: number; cursor?: string | null } = {},
): Promise<MoreFromTrailResult> {
  if (opts.cursor) {
    const c = decodeMemberCursor(opts.cursor, opts.nowMs ?? Date.now());
    if (!c) return { refusal: "invalid_request", lists: [], next: null };
    const p = await olderMembersPage(sc, trailId, c, opts.viewerId ?? null, opts.nowMs ?? Date.now());
    if (p.refusal || !p.list) return { refusal: p.refusal, lists: [], next: null };
    return { refusal: null, lists: Object.keys(p.list.byPlace).length > 0 || p.list.unplaced.length > 0 ? [p.list] : [], next: p.next, ...(p.membersUnread ? { membersUnread: p.membersUnread } : {}) };
  }
  const h = await heldBackLists(sc, trailId, opts);
  if (h.refusal) return { refusal: h.refusal, lists: [], next: null };
  return { refusal: null, lists: h.lists.filter((l) => Object.keys(l.byPlace).length > 0 || l.unplaced.length > 0), next: h.next, ...(h.membersUnread ? { membersUnread: h.membersUnread } : {}) };
}

// ── DV-74: a trend integrity review in force ──────────────────────────────────

/** The newest review's effect for one subject: `suppressed`, `none`, or `unread` (fail closed: never a claim). */
export async function readTrendReviewVerdict(sc: any, subjectKind: "trail" | "place", subjectId: string): Promise<"suppressed" | "none" | "unread"> {
  try {
    const { data, error } = await sc.from("trend_integrity_reviews").select("verdict, created_at")
      .eq("subject_kind", subjectKind).eq("subject_id", subjectId)
      .order("created_at", { ascending: false }).limit(1);
    if (error) return isMissingRelation(error) ? "none" : "unread"; // 3486 absent ⇒ no review can have been recorded
    const latest = Array.isArray(data) ? data[0] : null;
    return latest?.verdict === "suppressed" ? "suppressed" : "none";
  } catch {
    return "unread";
  }
}

// ── DV-24: declared relationships ─────────────────────────────────────────────

/** 3486's pending/rejected edges touching this Trail, keyed as `relatedTrails` keys a row; `null` = unreadable. */
async function readUnacceptedEdges(sc: any, trailId: string): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (const [col, direction] of [["from_trail_id", "out"], ["to_trail_id", "in"]] as const) {
    const { data, error } = await sc.from("trail_edges").select("from_trail_id, to_trail_id, edge_type, review_state")
      .eq(col, trailId).in("review_state", ["pending", "rejected"]);
    if (error) {
      if (isMissingRelation(error) || ["42703", "PGRST204"].includes(String(error.code))) return out; // pre-3486: every edge is a proposal's own `child`
      return null;
    }
    for (const e of (data ?? []) as any[]) out.add(`${direction === "out" ? e.to_trail_id : e.from_trail_id}|${e.edge_type}|${direction}`);
  }
  return out;
}

/** §6's kinds a person may declare after creation; `child` is declared by the proposal that names its parent. */
export const DECLARABLE_TRAIL_EDGE_TYPES = ["parent", "related", "seasonal_variant", "geographic_sub", "experience_branch"] as const;

export interface DeclareRelationResult { refusal: TrailRefusal | "not_trail_owner"; reviewState: "accepted" | "pending" | null; duplicate?: true }

/**
 * DV-24 (D-W10T-8, §51.10 Q1): the creator of EITHER Trail may declare one of
 * the five kinds. Declared by the creator of BOTH, it is navigable at once
 * (`accepted`) — the same standing as the proposer's own `child` edge. Declared
 * by the creator of one, it is `pending` and navigable only once moderation
 * accepts it (`trail_admin_review_edge`, audited): nobody can attach their
 * Trail to someone else's without review. Anyone else is refused.
 */
export async function declareTrailRelation(
  sc: any, fromId: string, toId: string, edgeType: string, actorId: string,
): Promise<DeclareRelationResult> {
  if (!sc) return { refusal: "no_service_client", reviewState: null };
  if (fromId === toId || !(DECLARABLE_TRAIL_EDGE_TYPES as readonly string[]).includes(edgeType)) return { refusal: "invalid_request", reviewState: null };
  const [from, to] = [await readTrail(sc, fromId), await readTrail(sc, toId)];
  if (from.refusal || !from.trail) return { refusal: from.refusal ?? "unknown_trail", reviewState: null };
  if (to.refusal || !to.trail) return { refusal: to.refusal === "unknown_trail" || !to.refusal ? "invalid_request" : to.refusal, reviewState: null };
  const ownsFrom = from.trail.created_by === actorId, ownsTo = to.trail.created_by === actorId;
  if (!ownsFrom && !ownsTo) return { refusal: "not_trail_owner", reviewState: null };
  const reviewState = ownsFrom && ownsTo ? "accepted" : "pending";
  const { error } = await sc.from("trail_edges").insert({
    from_trail_id: fromId, to_trail_id: toId, edge_type: edgeType, strength: 0.5, review_state: reviewState, declared_by: actorId,
  });
  if (error) {
    if (String(error.code) === "23505") return { refusal: null, reviewState: null, duplicate: true };
    if (["42703", "PGRST204"].includes(String(error.code))) return { refusal: "trails_unavailable", reviewState: null }; // 3486 absent: no review column to hold "pending"
    return { refusal: refusalFor(error, "declareTrailRelation"), reviewState: null };
  }
  return { refusal: null, reviewState };
}

// ── DC-20 (D-W10T-9): who may attach, and a stranger's suggestion waits ──────

interface OwnershipRouting {
  refusal: TrailRefusal;
  owned: Array<{ sourceType: string; sourceId: string; relationship: string; signal?: string | null }>;
  refusals: AttachSourceRefusal[];
  suggested: number;
}

/**
 * `11` §10 "every mutation is authorized", ruled (§51.10 Q5):
 *   ATTACH (the author's-statement confidence) — only the content's OWNER: the
 *     post's author, the event's host, the route's owner, the community place's
 *     submitter; for authorless content (a canonical place), the Trail's creator.
 *     Anyone else is refused `not_content_owner` and may suggest instead.
 *   SUGGEST — by the owner, a membership at the suggestion confidence (their own
 *     §4 budget); by anyone else, a PENDING row in 3488 that spends no budget and
 *     is served by nothing until the owner accepts it.
 */
async function routeLabelsByOwnership(
  sc: any, trail: TrailRow,
  labels: ReadonlyArray<{ sourceType: string; sourceId: string; relationship: string; signal?: string | null }>,
  verified: AttachSourceVerdict, actor: { userId: string | null; mode: "attach" | "suggest" },
): Promise<OwnershipRouting> {
  const out: OwnershipRouting = { refusal: null, owned: [], refusals: [], suggested: 0 };
  const pending: Array<{ label: (typeof labels)[number]; owner: string | null }> = [];
  labels.forEach((l, i) => {
    if (verified.reasons[i] !== null) return;
    const owner = verified.ownerIds?.[i] ?? trail.created_by ?? null;
    if (actor.userId !== null && owner === actor.userId) out.owned.push(l);
    else if (actor.mode === "attach") out.refusals.push({ sourceType: l.sourceType, sourceId: l.sourceId, relationship: l.relationship, signal: l.signal ?? null, reason: "not_content_owner" });
    else pending.push({ label: l, owner });
  });
  for (const { label, owner } of pending) {
    const signal = label.relationship === "signal" ? (label.signal ?? null) : null;
    if (label.relationship === "signal" && !(TRAIL_SIGNALS as readonly string[]).includes(signal ?? "")) {
      out.refusals.push({ sourceType: label.sourceType, sourceId: label.sourceId, relationship: label.relationship, signal, reason: "invalid_label" });
      continue;
    }
    const { error } = await sc.from("trail_content_suggestions").insert({
      trail_id: trail.id, source_type: label.sourceType, source_id: label.sourceId, relationship: label.relationship, signal,
      suggested_by: actor.userId, owner_id: owner, state: "pending",
    });
    if (!error || String(error.code) === "23505") { out.suggested += 1; continue; } // 23505: the same open suggestion already waits — a retry
    if (isMissingRelation(error)) return { ...out, refusal: "trails_unavailable" }; // 3488 absent: never fall back to spending the owner's budget
    if (String(error.code) === "23514") { out.refusals.push({ sourceType: label.sourceType, sourceId: label.sourceId, relationship: label.relationship, signal, reason: "invalid_label" }); continue; }
    return { ...out, refusal: refusalFor(error, "suggest.pending") };
  }
  return out;
}

export interface PendingSuggestion {
  id: string; trailId: string; sourceType: string; sourceId: string; relationship: string; signal: string | null; createdAt: string;
}

/** The owner's open suggestions. The suggester is not disclosed (`02` §15: moderation facts stay on the server). */
export async function listPendingSuggestions(sc: any, ownerId: string): Promise<{ refusal: TrailRefusal; suggestions: PendingSuggestion[] }> {
  if (!sc) return { refusal: "no_service_client", suggestions: [] };
  const { data, error } = await sc.from("trail_content_suggestions")
    .select("id, trail_id, source_type, source_id, relationship, signal, created_at")
    .eq("owner_id", ownerId).eq("state", "pending").order("created_at", { ascending: false }).limit(50);
  if (error) return { refusal: refusalFor(error, "listPendingSuggestions"), suggestions: [] };
  return {
    refusal: null,
    suggestions: ((data ?? []) as any[]).map((r) => ({
      id: r.id, trailId: r.trail_id, sourceType: r.source_type, sourceId: r.source_id, relationship: r.relationship, signal: r.signal ?? null, createdAt: r.created_at,
    })),
  };
}

export interface DecideSuggestionResult { refusal: TrailRefusal; state: "accepted" | "declined" | null; attach?: AttachResult }

/**
 * The owner accepts (the label is attached through `attachContentToTrail` AS THE
 * OWNER, so existence, visibility, §4's cap and the promotion all run exactly as
 * for their own suggestion) or declines. Unknown and not-yours are one answer.
 */
export async function decideSuggestion(
  sc: any, suggestionId: string, ownerId: string, decision: "accept" | "decline",
): Promise<DecideSuggestionResult> {
  if (!sc) return { refusal: "no_service_client", state: null };
  const { data, error } = await sc.from("trail_content_suggestions")
    .select("id, trail_id, source_type, source_id, relationship, signal, owner_id, state").eq("id", suggestionId).maybeSingle();
  if (error) return { refusal: refusalFor(error, "decideSuggestion.read"), state: null };
  if (!data || data.owner_id !== ownerId) return { refusal: "unknown_trail", state: null };
  if (data.state !== "pending") {
    return data.state === (decision === "accept" ? "accepted" : "declined")
      ? { refusal: null, state: data.state } : { refusal: "invalid_request", state: null };
  }
  let attach: AttachResult | undefined;
  if (decision === "accept") {
    attach = await attachContentToTrail(sc, data.trail_id, [{
      sourceType: data.source_type, sourceId: data.source_id, relationship: data.relationship, signal: data.signal ?? null,
    }], { userId: ownerId, mode: "suggest" });
    if (attach.refusal) return { refusal: attach.refusal, state: null, attach };
    if (attach.attached === 0) return { refusal: null, state: null, attach }; // refused (cap, gone, no longer theirs): stays pending
  }
  const upd = await sc.from("trail_content_suggestions")
    .update({ state: decision === "accept" ? "accepted" : "declined", decided_at: new Date().toISOString() })
    .eq("id", suggestionId).eq("state", "pending").select("id");
  if (upd.error) return { refusal: refusalFor(upd.error, "decideSuggestion.update"), state: null, attach };
  return { refusal: null, state: decision === "accept" ? "accepted" : "declined", ...(attach ? { attach } : {}) };
}

// ── census-discovery §105 (DV-83 round 9, lane W11-X2, D-W11X2-60): a failed member-source read is named ──
// `servableMembers` withholds every member of a table whose read failed (fail closed, §64) and
// names the read in its `unread` set, but before §105 no READ path passed one: GET …/modules,
// …/trending, …/:id and the two "more" routes served a timed-out read as a complete Trail. The
// two readers below are the exported names, so every caller (the routes, `heldBackLists`, the
// admin evidence) is told. A privacy withhold is not a failed read and adds nothing to the set.
export async function getTrailModules(
  sc: any, trailId: string, opts: { pageSize?: number; nowMs?: number; viewerId?: string | null } = {},
): Promise<TrailModulesResult> {
  const memberUnread = new Set<string>();
  const r = await trailModulesRead(sc, trailId, { ...opts, memberUnread });
  return r.refusal ? r : withMembersUnread(r, memberUnread);
}

/** A failed member read makes the Trail's trend UNKNOWN (`momentumUnread`), never a measured "not trending"; a review's suppression stays decisive. */
export async function trailTrending(
  sc: any, trailId: string, nowMs = Date.now(), opts: { viewerId?: string | null; ignoreTrendReview?: boolean } = {},
): Promise<TrailTrendingResult> {
  const memberUnread = new Set<string>();
  const r = await trailTrendingRead(sc, trailId, nowMs, { ...opts, memberUnread });
  if (r.refusal || memberUnread.size === 0) return r;
  return { ...withMembersUnread(r, memberUnread), ...(r.trendSuppressed ? {} : { momentumUnread: true as const }) };
}

function withMembersUnread<T extends object>(r: T, unread: ReadonlySet<string>): T & { membersUnread?: string[] } {
  return unread.size > 0 ? { ...r, membersUnread: [...unread].sort() } : r;
}
