/**
 * The §85 per-viewer candidate retrievals — census-discovery §85 (lane W10-R3),
 * DC-12 and DV-49.
 *
 * Each retrieval answers ONE question from ONE table chain and returns served
 * ids (`db/<uuid>` for a DB-backed place, the stored id otherwise) in its own
 * deterministic order. None of them decides eligibility: every id they return
 * goes through lib/discoveryCandidates/materialize.ts, which applies the same
 * author, standing, status, demo-source and city rules `queryDbPlaces` applies,
 * and then through every post-rank gate the route already runs.
 *
 * EVERY READ IS ORDERED AND BOUNDED, and every failure is REPORTED. supabase-js
 * resolves on a database error; a retrieval that destructured `data` and dropped
 * `error` would report a failed read as "this viewer follows nobody", which is
 * the defect lib/discoveryPde.ts's `degraded` list exists to end. Here a failed
 * read is `status: "read_failed"` with the read named, and contributes nothing.
 *
 * Nothing here writes.
 */
import type { GeneratedCandidateSource } from "./candidateSources.js";

/** Most ids one retrieval hands to materialisation. */
export const PER_SOURCE_LIMIT = 20;
/** The exploration pool's "new place" window. */
export const EXPLORATION_POOL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** Distinct travellers a graph-derived place needs before it is a candidate (D-W10-R3-5). */
export const GRAPH_MIN_CO_TRAVELLERS = 2;
/** Cap on any id list sent in one `.in()` — it is a URL on this client. */
export const IN_LIST_CAP = 200;
/** Followed Trails read per viewer (TrailService's own cap is the same order). */
export const MAX_FOLLOWED_TRAILS = 50;

export type RetrievalStatus = "ok" | "no_input" | "read_failed";

export interface RetrievalOutcome {
  source: GeneratedCandidateSource;
  status: RetrievalStatus;
  /** Served ids, in the retrieval's own order, deduplicated, at most PER_SOURCE_LIMIT. */
  ids: string[];
  /** The read that failed, when status is `read_failed`. */
  failedRead?: string;
}

export interface RetrievalContext {
  sc: any;
  userId: string;
  /** Sanitised city prefix for an `ilike`, or null when the request named none. */
  cityPrefix: string | null;
  followedIds: ReadonlySet<string>;
  /** placeAffinities keys (`db/<uuid>` = a DB place the viewer viewed in 30 days). */
  viewedPlaceIds: readonly string[];
  nowMs: number;
  /** Memo shared by the retrievals of one request, so two sources never read the same rows twice. */
  memo: Map<string, Promise<unknown>>;
}

const DB = "db/";
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored place reference → the id `GET /discovery` serves it under, or null when it names no place row. */
export function servedPlaceId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith(DB)) return UUID_RX.test(raw.slice(DB.length)) ? raw : null;
  if (UUID_RX.test(raw)) return `${DB}${raw}`;
  return raw;   // an OSM id (`node/…`, `way/…`): claimable from the pool, never materialised
}

/** The `ilike` prefix for a city, with PostgREST's structural and wildcard characters removed. */
export function cityPrefixOf(city: string | null | undefined): string | null {
  const base = (city ?? "").split(",")[0]?.replace(/[(),*%_\\]/g, "").trim() ?? "";
  return base.length > 0 ? base : null;
}

const uniq = (ids: Iterable<string>): string[] => [...new Set(ids)];
const ok = (source: GeneratedCandidateSource, ids: Iterable<string>): RetrievalOutcome =>
  ({ source, status: "ok", ids: uniq(ids).slice(0, PER_SOURCE_LIMIT) });
const noInput = (source: GeneratedCandidateSource): RetrievalOutcome => ({ source, status: "no_input", ids: [] });
const failed = (source: GeneratedCandidateSource, read: string): RetrievalOutcome => ({ source, status: "read_failed", ids: [], failedRead: read });

class ReadFailed extends Error { constructor(readonly read: string) { super(read); } }

async function rows(read: string, q: PromiseLike<{ data: unknown; error: unknown }>): Promise<any[]> {
  let r: { data: unknown; error: unknown };
  try { r = await q; } catch { throw new ReadFailed(read); }
  if (r.error) throw new ReadFailed(read);
  return Array.isArray(r.data) ? (r.data as any[]) : [];
}

function memo<V>(ctx: RetrievalContext, key: string, f: () => Promise<V>): Promise<V> {
  let p = ctx.memo.get(key) as Promise<V> | undefined;
  if (!p) { p = f(); ctx.memo.set(key, p); }
  return p;
}

async function guarded(source: GeneratedCandidateSource, f: () => Promise<RetrievalOutcome>): Promise<RetrievalOutcome> {
  try { return await f(); } catch (e) { return failed(source, e instanceof ReadFailed ? e.read : "threw"); }
}

// ── followed creators ────────────────────────────────────────────────────────

export function retrieveFollowedCreators(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("followed_creators", async () => {
    const authors = [...ctx.followedIds].filter((x) => typeof x === "string" && x.length > 0).sort().slice(0, IN_LIST_CAP);
    if (authors.length === 0 || !ctx.cityPrefix) return noInput("followed_creators");
    const data = await rows("discovery_places.followed", ctx.sc
      .from("discovery_places")
      .select("id, submitted_by, created_at")
      .in("submitted_by", authors)
      .ilike("city", `${ctx.cityPrefix}%`)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PER_SOURCE_LIMIT * 2));
    return ok("followed_creators", data.map((r) => servedPlaceId(r.id)).filter((x): x is string => !!x));
  });
}

// ── Trails ───────────────────────────────────────────────────────────────────

function followedTrailIds(ctx: RetrievalContext): Promise<string[]> {
  return memo(ctx, "trail_follows", async () => {
    const data = await rows("trail_follows", ctx.sc
      .from("trail_follows")
      .select("trail_id")
      .eq("user_id", ctx.userId)
      .order("trail_id", { ascending: true })
      .limit(MAX_FOLLOWED_TRAILS));
    return uniq(data.map((r) => r.trail_id).filter((x): x is string => typeof x === "string"));
  });
}

async function servableTrailIds(ctx: RetrievalContext, ids: string[], read: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const data = await rows(read, ctx.sc
    .from("trails")
    .select("id, lifecycle_status")
    .in("id", ids.slice(0, IN_LIST_CAP))
    .neq("lifecycle_status", "archived")
    .eq("review_state", "approved") // lead ruling D-66: a Trail under review is never a ranking source
    .order("id", { ascending: true }));
  return data.map((r) => r.id as string).filter((x) => typeof x === "string");
}

async function trailPlaceMembers(ctx: RetrievalContext, trailIds: string[], read: string): Promise<string[]> {
  if (trailIds.length === 0) return [];
  const data = await rows(read, ctx.sc
    .from("content_trails")
    .select("trail_id, source_id, created_at")
    .in("trail_id", trailIds.slice(0, IN_LIST_CAP))
    .eq("source_type", "place")
    .order("created_at", { ascending: false })
    .order("source_id", { ascending: true })
    .limit(IN_LIST_CAP));
  return data.map((r) => servedPlaceId(r.source_id)).filter((x): x is string => !!x);
}

export function retrieveCurrentTrail(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("current_trail", async () => {
    const followed = await followedTrailIds(ctx);
    if (followed.length === 0) return noInput("current_trail");
    const live = await servableTrailIds(ctx, followed, "trails.current");
    return ok("current_trail", await trailPlaceMembers(ctx, live, "content_trails.current"));
  });
}

export function retrieveRelatedTrails(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("related_trails", async () => {
    const followed = await followedTrailIds(ctx);
    if (followed.length === 0) return noInput("related_trails");
    const f = followed.slice(0, IN_LIST_CAP);
    const [out, inc] = await Promise.all([
      rows("trail_edges.out", ctx.sc.from("trail_edges").select("from_trail_id, to_trail_id, strength")
        .in("from_trail_id", f).order("strength", { ascending: false }).order("to_trail_id", { ascending: true }).limit(IN_LIST_CAP)),
      rows("trail_edges.in", ctx.sc.from("trail_edges").select("from_trail_id, to_trail_id, strength")
        .in("to_trail_id", f).order("strength", { ascending: false }).order("from_trail_id", { ascending: true }).limit(IN_LIST_CAP)),
    ]);
    const own = new Set(followed);
    const related = uniq([
      ...out.map((r) => r.to_trail_id as string), ...inc.map((r) => r.from_trail_id as string),
    ].filter((x) => typeof x === "string" && !own.has(x)));
    if (related.length === 0) return ok("related_trails", []);
    const live = await servableTrailIds(ctx, related, "trails.related");
    return ok("related_trails", await trailPlaceMembers(ctx, live, "content_trails.related"));
  });
}

// ── trip destination (the viewer's own saved ideas) ──────────────────────────

export function retrieveTripDestination(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("trip_destination", async () => {
    const data = await rows("trip_saved_places", ctx.sc
      .from("trip_saved_places")
      .select("place_id, saved_at")
      .eq("user_id", ctx.userId)
      .order("saved_at", { ascending: false })
      .order("place_id", { ascending: true })
      .limit(IN_LIST_CAP));
    if (data.length === 0) return noInput("trip_destination");
    return ok("trip_destination", data.map((r) => servedPlaceId(r.place_id)).filter((x): x is string => !!x));
  });
}

// ── saved-similar ────────────────────────────────────────────────────────────

function savedPlaceUuids(ctx: RetrievalContext): Promise<string[]> {
  return memo(ctx, "saved_places", async () => {
    const data = await rows("saved_places", ctx.sc
      .from("saved_places")
      .select("place_id, saved_at")
      .eq("user_id", ctx.userId)
      .order("saved_at", { ascending: false })
      .order("place_id", { ascending: true })
      .limit(IN_LIST_CAP));
    return uniq(data.map((r) => r.place_id).filter((x): x is string => typeof x === "string" && UUID_RX.test(x)));
  });
}

export function retrieveSavedSimilar(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("saved_similar", async () => {
    const saved = await savedPlaceUuids(ctx);
    if (saved.length === 0 || !ctx.cityPrefix) return noInput("saved_similar");
    const seeds = await rows("discovery_places.saved", ctx.sc
      .from("discovery_places")
      .select("id, primary_category")
      .in("id", saved)
      .order("id", { ascending: true }));
    const cats = uniq(seeds.map((r) => r.primary_category).filter((x): x is string => typeof x === "string" && x.length > 0)).sort();
    if (cats.length === 0) return ok("saved_similar", []);
    const data = await rows("discovery_places.similar", ctx.sc
      .from("discovery_places")
      .select("id, primary_category, saved_count")
      .in("primary_category", cats)
      .ilike("city", `${ctx.cityPrefix}%`)
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .order("id", { ascending: true })
      .limit(PER_SOURCE_LIMIT * 3));
    const own = new Set(saved);
    return ok("saved_similar", data.filter((r) => !own.has(r.id)).map((r) => servedPlaceId(r.id)).filter((x): x is string => !!x));
  });
}

// ── trending local / emerging discoveries (place_momentum's latest run) ──────

function latestMomentumRun(ctx: RetrievalContext): Promise<string | null> {
  return memo(ctx, "place_momentum.head", async () => {
    const data = await rows("place_momentum.head", ctx.sc
      .from("place_momentum")
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1));
    const at = data[0]?.computed_at;
    return typeof at === "string" && at.length > 0 ? at : null;
  });
}

/** Trend states that ARE claims, per source. `unknown` never qualifies (`03` §9). */
export const TREND_STATES_FOR_SOURCE = {
  trending_local:       ["trending"],
  emerging_discoveries: ["emerging", "rediscovered"],
} as const;

export async function momentumPlaceIds(
  ctx: RetrievalContext, states: readonly string[], limit: number, read: string,
): Promise<Array<{ id: string; state: string }>> {
  const run = await latestMomentumRun(ctx);
  if (!run) return [];
  const data = await rows(read, ctx.sc
    .from("place_momentum")
    .select("place_id, trend_state, recent_rate, computed_at")
    .eq("computed_at", run)
    .in("trend_state", [...states])
    .order("recent_rate", { ascending: false })
    .order("place_id", { ascending: true })
    .limit(limit));
  const out: Array<{ id: string; state: string }> = [];
  for (const r of data) {
    const id = servedPlaceId(r.place_id);
    if (id) out.push({ id, state: String(r.trend_state) });
  }
  return out;
}

export function retrieveTrendingLocal(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("trending_local", async () =>
    ok("trending_local", (await momentumPlaceIds(ctx, TREND_STATES_FOR_SOURCE.trending_local, IN_LIST_CAP, "place_momentum.trending")).map((x) => x.id)));
}

export function retrieveEmergingDiscoveries(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("emerging_discoveries", async () =>
    ok("emerging_discoveries", (await momentumPlaceIds(ctx, TREND_STATES_FOR_SOURCE.emerging_discoveries, IN_LIST_CAP, "place_momentum.emerging")).map((x) => x.id)));
}

// ── exploration pool (new places in the city) ────────────────────────────────

export function retrieveExplorationPool(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("exploration_pool", async () => {
    if (!ctx.cityPrefix) return noInput("exploration_pool");
    const since = new Date(ctx.nowMs - EXPLORATION_POOL_WINDOW_MS).toISOString();
    const data = await rows("discovery_places.new", ctx.sc
      .from("discovery_places")
      .select("id, created_at")
      .ilike("city", `${ctx.cityPrefix}%`)
      .eq("status", "active")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PER_SOURCE_LIMIT * 2));
    return ok("exploration_pool", data.map((r) => servedPlaceId(r.id)).filter((x): x is string => !!x));
  });
}

// ── the graph (DV-49) and circle context ─────────────────────────────────────
//
// `experience —at_place→ place` and `person —experienced→ experience` are
// written by CompassGraphEngine's rebuild from PUBLISHED, PUBLIC Memories only
// (`isPublicWorldMemory`), so every edge read here is already public. A place
// is returned only when at least GRAPH_MIN_CO_TRAVELLERS distinct travellers
// reach it, so no single traveller's path is replayed as a candidate list.

async function placesExperiencedBy(ctx: RetrievalContext, persons: string[], prefix: string): Promise<Map<string, Set<string>>> {
  const byPlace = new Map<string, Set<string>>();
  if (persons.length === 0) return byPlace;
  const exp = await rows(`${prefix}.experienced`, ctx.sc
    .from("compass_graph_edges")
    .select("src_key, dst_key, last_seen")
    .eq("edge_type", "experienced")
    .in("src_key", persons.slice(0, IN_LIST_CAP))
    .order("last_seen", { ascending: false })
    .order("dst_key", { ascending: true })
    .limit(IN_LIST_CAP * 5));
  const personByExp = new Map<string, string>();
  for (const r of exp) if (typeof r.dst_key === "string" && typeof r.src_key === "string") personByExp.set(r.dst_key, r.src_key);
  const exps = [...personByExp.keys()].slice(0, IN_LIST_CAP);
  if (exps.length === 0) return byPlace;
  const at = await rows(`${prefix}.at_place`, ctx.sc
    .from("compass_graph_edges")
    .select("src_key, dst_key, last_seen")
    .eq("edge_type", "at_place")
    .in("src_key", exps)
    .order("last_seen", { ascending: false })
    .order("dst_key", { ascending: true })
    .limit(IN_LIST_CAP * 5));
  for (const r of at) {
    const person = personByExp.get(String(r.src_key));
    const place = typeof r.dst_key === "string" ? r.dst_key : null;
    if (!person || !place) continue;
    const s = byPlace.get(place) ?? new Set<string>();
    s.add(person);
    byPlace.set(place, s);
  }
  return byPlace;
}

function rankGraphPlaces(byPlace: Map<string, Set<string>>, exclude: ReadonlySet<string>): string[] {
  return [...byPlace.entries()]
    .filter(([place, who]) => who.size >= GRAPH_MIN_CO_TRAVELLERS && !exclude.has(place))
    .sort((a, b) => (b[1].size - a[1].size) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([place]) => servedPlaceId(place))
    .filter((x): x is string => !!x);
}

export function retrieveGraphRelated(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("graph_related", async () => {
    const viewed = ctx.viewedPlaceIds.filter((k) => k.startsWith(DB)).map((k) => k.slice(DB.length));
    const saved = await savedPlaceUuids(ctx);
    const seeds = uniq([...viewed, ...saved].filter((x) => UUID_RX.test(x))).sort().slice(0, IN_LIST_CAP);
    if (seeds.length === 0) return noInput("graph_related");
    const atSeed = await rows("compass_graph_edges.seed_at_place", ctx.sc
      .from("compass_graph_edges")
      .select("src_key, dst_key, last_seen")
      .eq("edge_type", "at_place")
      .in("dst_key", seeds)
      .order("last_seen", { ascending: false })
      .order("src_key", { ascending: true })
      .limit(IN_LIST_CAP * 5));
    const seedExps = uniq(atSeed.map((r) => r.src_key).filter((x): x is string => typeof x === "string")).slice(0, IN_LIST_CAP);
    if (seedExps.length === 0) return ok("graph_related", []);
    const who = await rows("compass_graph_edges.seed_experienced", ctx.sc
      .from("compass_graph_edges")
      .select("src_key, dst_key, last_seen")
      .eq("edge_type", "experienced")
      .in("dst_key", seedExps)
      .order("last_seen", { ascending: false })
      .order("src_key", { ascending: true })
      .limit(IN_LIST_CAP * 5));
    const persons = uniq(who.map((r) => r.src_key).filter((x): x is string => typeof x === "string" && x !== ctx.userId)).sort();
    const byPlace = await placesExperiencedBy(ctx, persons, "compass_graph_edges.graph");
    return ok("graph_related", rankGraphPlaces(byPlace, new Set(seeds)));
  });
}

export function retrieveCircleContext(ctx: RetrievalContext): Promise<RetrievalOutcome> {
  return guarded("social_circle", async () => {
    const mates = await rows("circle_memberships", ctx.sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", ctx.userId)
      .order("other_id", { ascending: true })
      .limit(IN_LIST_CAP));
    const persons = uniq(mates.map((r) => r.other_id).filter((x): x is string => typeof x === "string" && x !== ctx.userId));
    if (persons.length === 0) return noInput("social_circle");
    const byPlace = await placesExperiencedBy(ctx, persons, "compass_graph_edges.circle");
    return ok("social_circle", rankGraphPlaces(byPlace, new Set()));
  });
}
