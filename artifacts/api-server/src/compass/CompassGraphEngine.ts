/**
 * CompassGraphEngine — Phase 15 Travel Intelligence Graph.
 *
 * The proprietary intelligence layer:
 *
 *   1. Graph substrate — persistent typed nodes/edges connecting
 *      People–Places–Events–Trips–Time–Vibe–Behavior–Outcomes–Circles–
 *      Experiences, populated by batch builders from data the app ALREADY
 *      collects (user_stamps, trips, events, compass_outcome_events,
 *      rank_events, circles, memories). Cross-trip relationships persist: a
 *      person returning to the same city accumulates observed_count on the
 *      visited edge and gets an explicit `returned_to` edge once a second trip
 *      is seen. The admitted node kinds are GRAPH_NODE_KINDS below — the
 *      TypeScript mirror of the CHECK on compass_graph_nodes.node_type
 *      (20260730 + 2290). `trail` is not among them by ruling
 *      (docs/discovery/ROADMAP.md: Trails as a peer system is STALE).
 *
 *   2. Destination World Model — per-city time-sliced activity profiles
 *      (day-of-week × daypart, plus monthly/seasonal buckets) derived from
 *      graph observations. Cebu on a Friday night genuinely differs from
 *      Monday morning: each slice carries its own activity count and category
 *      mix, and ranking/context consume the slice for "now".
 *
 *   3. City-confidence index — per-city data-depth score (0–100) + tier
 *      (deep / moderate / thin). Deep cities answer confidently; thin cities
 *      say so honestly (the tier feeds the Phase 8 confidence labels and the
 *      prompt context). The strongest city is identified from real data.
 *
 * Privacy guards are applied AT READ TIME: every read API in this file
 * returns aggregates only — no person node keys (user ids), no handles, no
 * coordinates ever leave the graph. Person nodes store NO profile attributes.
 *
 * All entry points are fail-soft — graph unavailability never breaks the
 * pipeline or chat routes that consume it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import tzLookup from "tz-lookup";
import type { CompassItem } from "./types.js";
import type { RankingFactor } from "./CompassRecommendationEngine.js";
import { canonicalCityKey } from "../lib/canonicalLocations.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { mayPublishRhythm } from "../lib/compassRhythmGate.js";
import { logger as rootLogger } from "../lib/logger.js";

const logger = rootLogger.child({ service: "CompassGraphEngine" });

// ── Time slicing ──────────────────────────────────────────────────────────────

export const DAYPARTS = ["morning", "afternoon", "evening", "night"] as const;
export type Daypart = typeof DAYPARTS[number];

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Map an hour (0–23) to a daypart. */
export function daypartOf(hour: number): Daypart {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

// ── Per-city timezone resolution ─────────────────────────────────────────────
//
// Time slices must reflect each city's LOCAL clock: a 7pm Cebu event is a
// "fri:evening" observation even though it is 11am UTC. Static map as the
// fast path, plus an offline coordinate → timezone lookup (tz-lookup) for
// brand-new cities — no external services. Unknown cities with no
// coordinates fall back to UTC (honest default).

const CITY_TIMEZONES: Record<string, string> = {
  // Philippines (primary market)
  "cebu": "Asia/Manila", "cebu city": "Asia/Manila", "manila": "Asia/Manila",
  "baguio": "Asia/Manila", "davao": "Asia/Manila", "davao city": "Asia/Manila",
  "boracay": "Asia/Manila", "palawan": "Asia/Manila", "el nido": "Asia/Manila",
  "siargao": "Asia/Manila", "iloilo": "Asia/Manila", "bohol": "Asia/Manila",
  "tagaytay": "Asia/Manila", "makati": "Asia/Manila", "quezon city": "Asia/Manila",
  "dumaguete": "Asia/Manila", "bacolod": "Asia/Manila", "vigan": "Asia/Manila",
  "puerto princesa": "Asia/Manila", "la union": "Asia/Manila", "siquijor": "Asia/Manila",
  // Common regional travel hubs
  "bangkok": "Asia/Bangkok", "chiang mai": "Asia/Bangkok",
  "singapore": "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur",
  "bali": "Asia/Makassar", "jakarta": "Asia/Jakarta",
  "ho chi minh city": "Asia/Ho_Chi_Minh", "hanoi": "Asia/Ho_Chi_Minh", "da nang": "Asia/Ho_Chi_Minh",
  "hong kong": "Asia/Hong_Kong", "taipei": "Asia/Taipei",
  "tokyo": "Asia/Tokyo", "osaka": "Asia/Tokyo", "kyoto": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  // Other common destinations
  "sydney": "Australia/Sydney", "melbourne": "Australia/Melbourne",
  "london": "Europe/London", "paris": "Europe/Paris", "berlin": "Europe/Berlin",
  "new york": "America/New_York", "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", "dubai": "Asia/Dubai",
  // Cities observed in live activity data (stamps/events/trips/posts/profiles)
  "miami": "America/New_York", "fort lauderdale": "America/New_York",
  "new york city": "America/New_York", "denver": "America/Denver",
  "vancouver": "America/Vancouver", "mexico city": "America/Mexico_City",
  "rio de janeiro": "America/Sao_Paulo",
  "lisbon": "Europe/Lisbon", "barcelona": "Europe/Madrid", "madrid": "Europe/Madrid",
  "rome": "Europe/Rome", "dublin": "Europe/Dublin", "zurich": "Europe/Zurich",
  "interlaken": "Europe/Zurich", "copenhagen": "Europe/Copenhagen",
  "amsterdam": "Europe/Amsterdam", "istanbul": "Europe/Istanbul",
  "oia": "Europe/Athens", "santorini": "Europe/Athens", "athens": "Europe/Athens",
  "mumbai": "Asia/Kolkata", "delhi": "Asia/Kolkata",
  // Philippines / Indonesia hotspots seen in stamps and trips
  // (misspellings like "siargoa" collapse to their real city via
  // canonicalCityKey before lookup — no misspelling entries needed here)
  "general luna": "Asia/Manila",
  "coron": "Asia/Manila", "moalboal": "Asia/Manila", "oslob": "Asia/Manila",
  "ubud": "Asia/Makassar", "canggu": "Asia/Makassar", "denpasar": "Asia/Makassar",
  "phuket": "Asia/Bangkok", "krabi": "Asia/Bangkok",
};

// Every static entry is ALSO indexed under its canonical key ("mexico city"
// → "mexico", "quezon city" → "quezon") so canonical keys produced by the
// graph builders resolve to the same timezone as the raw names. Built once.
const CANONICAL_CITY_TIMEZONES: Record<string, string> = (() => {
  const out: Record<string, string> = { ...CITY_TIMEZONES };
  for (const [k, tz] of Object.entries(CITY_TIMEZONES)) {
    const canon = canonicalCityKey(k);
    if (canon && !(canon in out)) out[canon] = tz;
  }
  return out;
})();

/** Coordinates that can upgrade an unknown city to a real timezone. */
export interface CityCoords {
  lat: number | null | undefined;
  lng: number | null | undefined;
}

// Learned city → timezone entries resolved from coordinates via the bundled
// offline tz-boundary lookup (tz-lookup). Static map stays the fast path;
// this cache makes brand-new cities resolve automatically once ANY caller
// has seen their coordinates. Bounded to avoid unbounded growth from junk
// free-text city strings.
const LEARNED_CITY_TIMEZONES = new Map<string, string>();
const LEARNED_CITY_TZ_MAX = 5000;

function normTzKey(city: string | null | undefined): string {
  return String(city ?? "").trim().toLowerCase();
}

// ── Learned-timezone persistence (survives restarts) ─────────────────────────
//
// Learned entries are mirrored to the small `city_timezones` table
// (migration 0165) and reloaded on boot, so a restart doesn't reset
// brand-new cities to UTC until their coordinates are re-seen. Everything
// here is fail-soft and fire-and-forget: persistence being unavailable
// never blocks or breaks a hot path.

const CITY_TZ_TABLE = "city_timezones";
let tzPersistDb: SupabaseClient | null = null;

/**
 * Enable persistence and reload previously learned entries. Call once on
 * boot with the service client. Fail-soft: any error (missing table, DB
 * down) leaves the resolver fully functional, just non-durable.
 * Returns the number of entries loaded.
 */
export async function initCityTimezonePersistence(
  db: SupabaseClient | null,
): Promise<number> {
  tzPersistDb = db;
  if (!db) return 0;
  try {
    const { data, error } = await db
      .from(CITY_TZ_TABLE)
      .select("city_key, timezone")
      // Prefer the most-recently-updated rows when the table exceeds the
      // in-memory cap — junk that hasn't been touched in ages loses first.
      .order("updated_at", { ascending: false })
      .limit(LEARNED_CITY_TZ_MAX);
    if (error) throw error;
    let loaded = 0;
    for (const r of (data as any[]) ?? []) {
      const key = normTzKey(r?.city_key);
      const tz = typeof r?.timezone === "string" ? r.timezone.trim() : "";
      if (!key || !tz || CANONICAL_CITY_TIMEZONES[key]) continue; // static map stays authoritative
      if (!LEARNED_CITY_TIMEZONES.has(key) && LEARNED_CITY_TIMEZONES.size >= LEARNED_CITY_TZ_MAX) break;
      LEARNED_CITY_TIMEZONES.set(key, tz);
      loaded++;
    }
    return loaded;
  } catch {
    return 0; // fail-soft — resolver keeps working in-memory only
  }
}

// Rows must be BOTH outside the newest LEARNED_CITY_TZ_MAX and untouched for
// this long before the sweep deletes them — recent learning is never purged
// just because the table briefly overshoots the cap.
const CITY_TZ_SWEEP_MIN_AGE_MS = 180 * 24 * 60 * 60_000; // ~6 months

/**
 * Periodic sweep keeping the persisted `city_timezones` table aligned with
 * the in-memory bound: deletes rows that are (a) not among the
 * LEARNED_CITY_TZ_MAX most-recently-updated AND (b) not updated within the
 * minimum age window. Fail-soft: any error (missing table, DB down) is
 * swallowed and 0 is returned. Returns the number of rows deleted.
 */
export async function sweepCityTimezoneTable(
  db: SupabaseClient | null,
): Promise<number> {
  if (!db) return 0;
  try {
    const { count, error: countErr } = await db
      .from(CITY_TZ_TABLE)
      .select("city_key", { count: "exact", head: true });
    if (countErr) throw countErr;
    if (typeof count !== "number" || count <= LEARNED_CITY_TZ_MAX) return 0;

    // updated_at of the LEARNED_CITY_TZ_MAX-th newest row — anything strictly
    // older sits outside the cap.
    const { data, error: rankErr } = await db
      .from(CITY_TZ_TABLE)
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(LEARNED_CITY_TZ_MAX);
    if (rankErr) throw rankErr;
    const rows = (data as any[]) ?? [];
    const rankCutoff = typeof rows[rows.length - 1]?.updated_at === "string"
      ? (rows[rows.length - 1].updated_at as string)
      : null;
    if (!rankCutoff) return 0;

    const ageCutoff = new Date(Date.now() - CITY_TZ_SWEEP_MIN_AGE_MS).toISOString();
    // Both conditions must hold → delete below the EARLIER of the two cutoffs
    // (ISO-8601 strings compare lexicographically).
    const cutoff = rankCutoff < ageCutoff ? rankCutoff : ageCutoff;

    const { count: deleted, error: delErr } = await db
      .from(CITY_TZ_TABLE)
      .delete({ count: "exact" })
      .lt("updated_at", cutoff);
    if (delErr) throw delErr;
    return deleted ?? 0;
  } catch {
    return 0; // fail-soft — the sweep must never break its host scheduler
  }
}

/** Test-only: reset the persistence handle and learned cache. */
export function _resetCityTimezoneStateForTest(): void {
  tzPersistDb = null;
  LEARNED_CITY_TIMEZONES.clear();
}

/** Fire-and-forget upsert of one learned entry. Never throws. */
function persistLearnedTimezone(key: string, tz: string): void {
  const db = tzPersistDb;
  if (!db) return;
  try {
    void Promise.resolve(
      db.from(CITY_TZ_TABLE).upsert(
        { city_key: key, timezone: tz, updated_at: new Date().toISOString() },
        { onConflict: "city_key" },
      ),
    ).catch(() => { /* fail-soft */ });
  } catch { /* fail-soft */ }
}

/** Record a learned entry in memory and mirror it to the DB when changed. */
function learnCityTimezone(key: string, tz: string): void {
  if (LEARNED_CITY_TIMEZONES.get(key) === tz) return;
  LEARNED_CITY_TIMEZONES.set(key, tz);
  persistLearnedTimezone(key, tz);
}

/** Offline coordinate → IANA timezone (null on invalid coords). */
export function timezoneFromCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    return tzLookup(lat, lng);
  } catch {
    return null; // out-of-range coords → honest null (UTC fallback upstream)
  }
}

/**
 * Teach the resolver a city's timezone from its coordinates. No-op when the
 * city is already covered by the static map or previously learned. Purely
 * in-memory and offline — safe to call from any hot path.
 */
export function registerCityCoordinates(
  city: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): void {
  const key = normTzKey(city);
  if (!key || CANONICAL_CITY_TIMEZONES[key] || LEARNED_CITY_TIMEZONES.has(key)) return;
  if (LEARNED_CITY_TIMEZONES.size >= LEARNED_CITY_TZ_MAX) return;
  const tz = timezoneFromCoords(lat, lng);
  if (tz) learnCityTimezone(key, tz);
}

/**
 * Resolve a city's IANA timezone: static map → learned (coord-derived) cache
 * → direct coordinate lookup when coords are provided. Null when unknown —
 * callers fall back honestly to UTC. No network calls, ever.
 */
export function cityTimezone(
  city: string | null | undefined,
  coords?: CityCoords | null,
): string | null {
  const key = normTzKey(city);
  const canonical = key ? canonicalCityKey(key) : null;
  // 1. Curated static map (raw or canonical key) — authoritative.
  if (key) {
    const fromStatic =
      CANONICAL_CITY_TIMEZONES[key] ??
      (canonical && canonical !== key ? CANONICAL_CITY_TIMEZONES[canonical] : undefined);
    if (fromStatic) return fromStatic;
  }
  // 2. Valid coordinates override the learned city-name cache: the same
  //    free-text name ("Springfield") can exist in multiple timezones, so a
  //    previously learned entry must never shadow this call's real coords.
  const coordTz = timezoneFromCoords(coords?.lat, coords?.lng);
  if (coordTz) {
    if (key && (LEARNED_CITY_TIMEZONES.has(key) || LEARNED_CITY_TIMEZONES.size < LEARNED_CITY_TZ_MAX)) {
      learnCityTimezone(key, coordTz);
    }
    return coordTz;
  }
  // 3. Learned cache (raw then canonical key) — best effort when no coords.
  if (key) {
    const learned =
      LEARNED_CITY_TIMEZONES.get(key) ??
      (canonical && canonical !== key ? LEARNED_CITY_TIMEZONES.get(canonical) : undefined);
    if (learned) return learned;
  }
  return null;
}

const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

const DOW_SHORT_TO_KEY: Record<string, string> = {
  Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat",
};

/** Day-of-week key, hour, and month of a Date in a specific timezone. */
function localClockParts(at: Date, tz: string): { dow: string; hour: number; month: string } | null {
  try {
    let fmt = TZ_FORMATTERS.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", month: "2-digit",
      });
      TZ_FORMATTERS.set(tz, fmt);
    }
    const parts = fmt.formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const dow = DOW_SHORT_TO_KEY[get("weekday")];
    const hour = Number(get("hour"));
    const month = get("month");
    if (!dow || !Number.isFinite(hour)) return null;
    return { dow, hour, month };
  } catch {
    return null; // unknown/invalid tz → caller falls back to UTC
  }
}

/**
 * Slice key like "fri:evening" for a Date. When a city is provided and its
 * timezone is known, the slice reflects the city's LOCAL clock; otherwise UTC.
 */
export function timeSliceKey(at: Date, city?: string | null, coords?: CityCoords | null): string {
  const tz = cityTimezone(city, coords);
  if (tz) {
    const parts = localClockParts(at, tz);
    if (parts) return `${parts.dow}:${daypartOf(parts.hour)}`;
  }
  return `${DOW_KEYS[at.getUTCDay()]}:${daypartOf(at.getUTCHours())}`;
}

/** Month ("01".."12") of a Date in a city's local timezone (UTC fallback). */
export function localMonthKey(at: Date, city?: string | null, coords?: CityCoords | null): string {
  const tz = cityTimezone(city, coords);
  if (tz) {
    const parts = localClockParts(at, tz);
    if (parts?.month) return parts.month;
  }
  return String(at.getUTCMonth() + 1).padStart(2, "0");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TimeSliceProfile {
  count: number;
  /** category → observation count within this slice. */
  categories: Record<string, number>;
  /**
   * Distinct contributors behind this slice — the k-anonymity input for IG-07's
   * rhythm gate. Absent until the graph build records a per-slice distinct-actor
   * count; treated as 0 (suppress) so a k=1 slice can never publish a rhythm line.
   */
  distinctActors?: number;
}

/**
 * census-compass CPH-15 — the SEASON dimension. One profile per local month
 * ("01".."12"), with the same category breakdown a time slice carries, so the
 * ranking boost can vary by season the way it varies by weekday × daypart.
 * Rows built before this shape carried a bare count per month; `monthProfile`
 * reads both.
 */
export interface MonthProfile {
  count: number;
  categories: Record<string, number>;
}

export interface CityWorldModel {
  city: string;
  timeSlices: Record<string, TimeSliceProfile>;
  monthly: Record<string, number | MonthProfile>;
  topCategories: string[];
  sampleSize: number;
  builtAt: string;
}

/** A month's profile whichever shape the row carries; a bare count has no categories. */
export function monthProfile(model: CityWorldModel, month: string): MonthProfile | null {
  const raw = model.monthly?.[month];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return raw > 0 ? { count: raw, categories: {} } : null;
  if (typeof raw === "object" && typeof (raw as MonthProfile).count === "number") {
    return { count: (raw as MonthProfile).count, categories: (raw as MonthProfile).categories ?? {} };
  }
  return null;
}

export type CityConfidenceTier = "deep" | "moderate" | "thin";

export interface CityConfidence {
  city: string;
  depthScore: number;                 // 0–100
  tier: CityConfidenceTier;
  signals: Record<string, number>;    // aggregate counts only — never user ids
  computedAt: string;
}

export interface GraphRebuildReport {
  nodesUpserted: number;
  edgesUpserted: number;
  /**
   * Rows in chunks whose upsert was REJECTED. A rebuild that reports
   * `nodesUpserted: 0, nodesFailed: 12000` and one that reports
   * `nodesUpserted: 0, nodesFailed: 0` mean opposite things — the first is a
   * broken write path, the second an empty source. Before these existed the
   * two were indistinguishable, because a failed chunk was simply not counted
   * and nothing was logged.
   */
  nodesFailed: number;
  edgesFailed: number;
  citiesModeled: number;
  citiesScored: number;
  strongestCity: string | null;
  /**
   * §28.8 — what the revocation sweep removed this run. Absent on a build that
   * did not run the sweep (buildGraphFromSources alone); present on every
   * rebuildIntelligenceGraph, including when it removed nothing, because
   * "swept, found nothing" and "never swept" are different states and the
   * scheduler log is where anyone would notice the difference.
   */
  experienceRevocations?: ExperienceReconcileReport;
}

// ── Node kinds ────────────────────────────────────────────────────────────────

/**
 * Every node_type the builders may emit — the mirror of the CHECK constraint
 * on compass_graph_nodes.node_type (20260730_compass_intelligence_graph.sql,
 * widened by 2290_intelligence_graph_node_kinds.sql). A builder that emits a
 * kind outside this list writes rows the database rejects, silently, inside
 * the fail-soft upsert; the test that pins this list to the migration is what
 * makes that failure visible at build time instead.
 */
export const GRAPH_NODE_KINDS = [
  "person", "place", "event", "trip", "city", "time_slice", "vibe", "behavior", "outcome",
  // 2290 — docs/architecture/05_Graph_Engine.md
  "circle", "experience",
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

// ── Internal accumulator ──────────────────────────────────────────────────────

interface NodeRec { node_type: string; node_key: string; city?: string | null; attrs?: Record<string, unknown> }
interface EdgeObs {
  src_type: string; src_key: string;
  dst_type: string; dst_key: string;
  edge_type: string;
  at?: string | null;
  attrs?: Record<string, unknown>;
}

class GraphBatch {
  nodes = new Map<string, NodeRec>();
  edges = new Map<string, { rec: EdgeObs; count: number; first: string | null; last: string | null }>();

  /**
   * Register a node. Order-independent: a builder that only knows a node by
   * reference (an event's circle_id, say) may register it before the builder
   * that reads the node's own row, so a later call fills a city the first one
   * lacked and merges attrs the first one did not carry. Nothing already
   * recorded is overwritten.
   */
  node(node_type: GraphNodeKind, node_key: string, city?: string | null, attrs?: Record<string, unknown>) {
    const k = `${node_type}|${node_key}`;
    const cur = this.nodes.get(k);
    if (!cur) {
      this.nodes.set(k, { node_type, node_key, city: city ?? null, attrs: attrs ?? {} });
      return;
    }
    if (cur.city == null && city) cur.city = city;
    if (attrs) cur.attrs = { ...attrs, ...(cur.attrs ?? {}) };
  }

  edge(obs: EdgeObs) {
    const k = `${obs.src_type}|${obs.src_key}|${obs.dst_type}|${obs.dst_key}|${obs.edge_type}`;
    const at = obs.at ?? null;
    const cur = this.edges.get(k);
    if (cur) {
      cur.count++;
      if (at && (!cur.first || at < cur.first)) cur.first = at;
      if (at && (!cur.last || at > cur.last)) cur.last = at;
    } else {
      this.edges.set(k, { rec: obs, count: 1, first: at, last: at });
    }
  }
}

/**
 * Canonical city key for graph nodes / world models. Variants and known
 * misspellings collapse to one key ("Cebu City"/"cebu" → "cebu",
 * "Siargoa" → "siargao") so a city's activity is never split across nodes;
 * junk fragments ("san") are rejected entirely.
 */
function normCity(raw: unknown): string | null {
  return canonicalCityKey(raw);
}

/** Plain trimmed string (no city canonicalization) — for categories etc. */
function normStr(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s.length > 0 ? s : null;
}

// ── §28.10 eligibility for a Memory, named once ───────────────────────────────

/**
 * May this `memories` row become public-world intelligence?
 *
 * ONE definition, used by BOTH halves of the contract — the builder that adds
 * an experience node and `reconcileExperienceNodes` that removes one. That is
 * the whole reason it is a function rather than two predicates: when the two
 * disagree, the graph either keeps a row it would no longer admit or deletes
 * one it just wrote, and neither failure announces itself.
 *
 * The answer is the conjunction of the two columns the spec makes load-bearing:
 * §5 lifecycle (`published` — a draft, archived, deleted or removed Memory is
 * not a published account of anything) and §10 audience (`public` — the only
 * rung of the six whose audience is the world).
 *
 * A row that is ABSENT — hard-deleted with its owner's account by
 * AccountDeletionService — is not passed here at all; `reconcileExperienceNodes`
 * treats absence as ineligible, which is the §28.8 case ("never keep deleted
 * Memories in … Compass projections").
 */
export function isPublicWorldMemory(row: { state?: unknown; visibility?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.state === "published" && row.visibility === "public";
}

// ── Batch builders (existing data → graph) ────────────────────────────────────

const BUILD_LIMIT = 5000;

/**
 * Rebuild the intelligence graph from existing app data. Each source is
 * fail-soft — a failing table contributes nothing but never aborts the build.
 * Returns the numbers of nodes/edges upserted.
 */
export async function buildGraphFromSources(
  db: SupabaseClient,
): Promise<{ nodesUpserted: number; edgesUpserted: number; nodesFailed: number; edgesFailed: number }> {
  const batch = new GraphBatch();

  // 1. Stamps → person —visited→ city (+ time-slice observation)
  try {
    const { data } = await db
      .from("user_stamps")
      .select("user_id, city, country, earned_at, is_revoked, lat, lng, stamp_definitions(evidences_presence)")
      .eq("is_revoked", false)
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      const city = normCity(r.city);
      if (!r.user_id || !city) continue;
      const at = r.earned_at ? String(r.earned_at) : null;
      batch.node("person", String(r.user_id));            // no profile attrs — privacy
      batch.node("city", city, city, { country: r.country ?? null });
      // The city NODE and its coordinates are facts about a PLACE and are kept
      // for every row. Everything below is a factual claim about a PERSON —
      // that they were in this city, and that they were active there at this
      // hour — so it may only be made for a stamp whose definition evidences
      // presence (`stamp_definitions.evidences_presence`, migration 2970).
      //
      // `POST /api/trips` awards `first_trip_created` and `trip_planner` AT
      // CREATION with the destination attached and nothing having occurred, so
      // without this a trip somebody planned and never took wrote them a
      // `visited` edge and an `active_in` time slice for a city they have never
      // been to. 2970 closed the Passport's Countries/Cities numbers against
      // exactly those rows and named this writer as a surface it did not fix.
      //
      // `!== true` and not falsiness: a row read through a path that did not
      // select the column arrives `undefined`, and a missing join is not
      // evidence of a visit.
      const def = Array.isArray(r.stamp_definitions) ? r.stamp_definitions[0] : r.stamp_definitions;
      registerCityCoordinates(city, r.lat, r.lng);
      if (def?.evidences_presence !== true) continue;
      batch.edge({ src_type: "person", src_key: String(r.user_id), dst_type: "city", dst_key: city, edge_type: "visited", at });
      if (at) {
        const slice = timeSliceKey(new Date(at), city, { lat: r.lat, lng: r.lng });
        batch.node("time_slice", `${city}|${slice}`, city, { slice });
        batch.edge({ src_type: "city", src_key: city, dst_type: "time_slice", dst_key: `${city}|${slice}`, edge_type: "active_during:exploring", at });
        monthEdge(batch, city, new Date(at), { lat: r.lat, lng: r.lng }, "exploring", at);
        // IG-07: a person→time_slice `active_in` edge, deduped by the edge
        // identity index per (person, slice), so counting these rows per slice
        // yields the DISTINCT-actor count the rhythm k-anon gate needs — the
        // `active_during` edge above collapses every user into one row and loses it.
        batch.edge({ src_type: "person", src_key: String(r.user_id), dst_type: "time_slice", dst_key: `${city}|${slice}`, edge_type: "active_in", at });
      }
    }
  } catch { /* fail-soft */ }

  // 2. Trips → person —took_trip→ city; ≥2 trips to a city → returned_to
  try {
    const { data } = await db
      .from("trips")
      .select("id, owner_id, destination_city, start_date, end_date, destination_lat, destination_lng")
      .limit(BUILD_LIMIT);
    const tripsPerUserCity = new Map<string, number>();
    for (const r of (data as any[]) ?? []) {
      const city = normCity(r.destination_city);
      if (!r.owner_id || !city) continue;
      const at = r.start_date ? String(r.start_date) : null;
      registerCityCoordinates(city, r.destination_lat, r.destination_lng);
      batch.node("person", String(r.owner_id));
      batch.node("city", city, city);
      batch.node("trip", String(r.id), city);
      batch.edge({ src_type: "person", src_key: String(r.owner_id), dst_type: "trip", dst_key: String(r.id), edge_type: "took_trip", at });
      batch.edge({ src_type: "trip", src_key: String(r.id), dst_type: "city", dst_key: city, edge_type: "destination", at });
      const k = `${r.owner_id}|${city}`;
      tripsPerUserCity.set(k, (tripsPerUserCity.get(k) ?? 0) + 1);
      if ((tripsPerUserCity.get(k) ?? 0) >= 2) {
        // Cross-trip relationship: the same person, multiple trips, same city.
        batch.edge({ src_type: "person", src_key: String(r.owner_id), dst_type: "city", dst_key: city, edge_type: "returned_to", at });
      }
    }
  } catch { /* fail-soft */ }

  // 3. Events → event —in_city→ city, event —has_vibe→ vibe, time-slice obs
  try {
    const { data } = await db
      .from("events")
      .select("id, city, category, starts_at, location_lat, location_lng, circle_id")
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      const city = normCity(r.city);
      if (!r.id || !city) continue;
      const at = r.starts_at ? String(r.starts_at) : null;
      const category = normStr(r.category) ?? "event";
      registerCityCoordinates(city, r.location_lat, r.location_lng);
      batch.node("event", String(r.id), city, { category });
      batch.node("city", city, city);
      batch.edge({ src_type: "event", src_key: String(r.id), dst_type: "city", dst_key: city, edge_type: "in_city", at });
      // An event hosted by a circle (events.circle_id) — the circle node itself
      // is built in §6 from public.circles; here only the edge is recorded.
      if (r.circle_id) {
        batch.node("circle", String(r.circle_id));
        batch.edge({ src_type: "event", src_key: String(r.id), dst_type: "circle", dst_key: String(r.circle_id), edge_type: "hosted_by", at });
      }
      batch.node("vibe", category.toLowerCase());
      batch.edge({ src_type: "event", src_key: String(r.id), dst_type: "vibe", dst_key: category.toLowerCase(), edge_type: "has_vibe", at });
      if (at) {
        const slice = timeSliceKey(new Date(at), city, { lat: r.location_lat, lng: r.location_lng });
        batch.node("time_slice", `${city}|${slice}`, city, { slice });
        batch.edge({ src_type: "city", src_key: city, dst_type: "time_slice", dst_key: `${city}|${slice}`, edge_type: `active_during:${category.toLowerCase()}`, at });
        monthEdge(batch, city, new Date(at), { lat: r.location_lat, lng: r.location_lng }, category.toLowerCase(), at);
      }
    }
  } catch { /* fail-soft */ }

  // 4. Outcome chain → person —outcome:{stage}→ item (behavior + outcomes)
  try {
    const { data } = await db
      .from("compass_outcome_events")
      .select("user_id, item_id, item_type, stage, occurred_at")
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      if (!r.user_id || !r.item_id || !r.stage) continue;
      const at = r.occurred_at ? String(r.occurred_at) : null;
      const itemType = String(r.item_type ?? "item");
      batch.node("person", String(r.user_id));
      batch.node("outcome", String(r.stage));
      batch.edge({
        src_type: "person", src_key: String(r.user_id),
        dst_type: itemType === "event" ? "event" : "place", dst_key: String(r.item_id),
        edge_type: `outcome:${r.stage}`, at, attrs: { item_type: itemType },
      });
    }
  } catch { /* fail-soft */ }

  // 5. Rank events funnel → person —behavior:{outcome}→ item
  try {
    const { data } = await db
      .from("rank_events")
      .select("user_id, item_id, item_kind, outcome, served_at")
      .neq("outcome", "impression")
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      if (!r.user_id || !r.item_id || !r.outcome) continue;
      const at = r.served_at ? String(r.served_at) : null;
      batch.node("person", String(r.user_id));
      batch.node("behavior", String(r.outcome));
      batch.edge({
        src_type: "person", src_key: String(r.user_id),
        dst_type: "place", dst_key: String(r.item_id),
        edge_type: `behavior:${r.outcome}`, at, attrs: { item_kind: r.item_kind ?? null },
      });
    }
  } catch { /* fail-soft */ }

  // 6. Circles (2290) → person —owns_circle→ circle —in_city→ city
  //
  // public.circles is the circle entity 05_Graph_Engine names: an owner, an
  // optional home city, a visibility. The node carries the visibility and the
  // canonical city ONLY — never the name or description, which are member-
  // authored content (the same rule person nodes follow). circle_memberships
  // is a person↔person pairing with no circle_id and is not read here: a
  // person-to-person edge is a social fact the read-time privacy guards were
  // never designed to aggregate over.
  try {
    const { data } = await db
      .from("circles")
      .select("id, owner_id, city, visibility, created_at")
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      if (!r.id || !r.owner_id) continue;
      const city = normCity(r.city);
      const at = r.created_at ? String(r.created_at) : null;
      batch.node("person", String(r.owner_id));
      batch.node("circle", String(r.id), city, { visibility: normStr(r.visibility) ?? "public" });
      batch.edge({ src_type: "person", src_key: String(r.owner_id), dst_type: "circle", dst_key: String(r.id), edge_type: "owns_circle", at });
      if (city) {
        batch.node("city", city, city);
        batch.edge({ src_type: "circle", src_key: String(r.id), dst_type: "city", dst_key: city, edge_type: "in_city", at });
      }
    }
  } catch { /* fail-soft */ }

  // 7. Experiences (2290) → person —experienced→ experience —at_place/at_event/
  //    during_trip/in_city→ … (+ time-slice observation)
  //
  // public.memories is the experience record 05_Graph_Engine names: a person's
  // own account of being somewhere, anchored to a place, a trip and/or an
  // event, with a location and a time. The node carries WHICH anchors exist,
  // never the title, caption or media.
  //
  // ── ELIGIBILITY: `public` ONLY, and this is NARROWER than it used to be ────
  //
  // The predicate here was `state = 'published' AND visibility <> 'only_me'`,
  // and the comment beside it argued that excluding `only_me` respected "the
  // owner's explicit choice". It did not. `memories.visibility` (0067) is a
  // SIX-rung ladder — public / friends_only / trip_crew / circle_only /
  // only_me / custom — so `<> 'only_me'` admitted FOUR private audiences:
  // friends_only, trip_crew, circle_only and custom. Each of those is also an
  // explicit owner choice, and each is a choice of a NAMED audience that is not
  // the world. `hidden_user_ids` was never consulted at all.
  //
  // What that fed is not a private surface. Everything written here lands in
  // compass_graph_nodes / compass_graph_edges, which buildCityWorldModels and
  // computeCityConfidenceIndex fold into per-city Destination World Models and
  // the city-confidence index — read by every user through the Compass feed,
  // the prompt context lines and discoveryModifiers. That is public-world
  // intelligence, and the rebuild runs DAILY from lib/intelligenceGraphScheduler
  // .ts, not on demand.
  //
  // Highlights/Memories spec §28.10: "Never route public-world intelligence
  // directly from private Memory without consent/eligibility/anonymization."
  // Anonymization held — the read APIs in this file return aggregates. Consent
  // and eligibility did not: nothing asked, and the gate admitted four private
  // audiences. Two legs of a three-leg rule is not the rule.
  //
  // `public` is the one rung on that ladder whose audience IS the world, so it
  // is the one rung that needs no separate consent record to be eligible. The
  // other five are excluded until there is a publication policy to consult
  // (spec §10; migration 2721 `highlight_projection_policies` is written and
  // unapplied, so there is nothing to consult today).
  //
  // This is strictly NARROWING. It removes observations from an aggregate; it
  // cannot add one. A city whose depth came from private memories gets a lower,
  // truer confidence score — census-compass grades that score's honesty, and a
  // score standing partly on data its owners never published was not honest.
  try {
    const { data } = await db
      .from("memories")
      .select("id, owner_id, place_id, trip_id, event_id, location_city, location_country, location_lat, location_lng, starts_at, created_at, state, visibility")
      .eq("state", "published")
      .eq("visibility", "public")
      .limit(BUILD_LIMIT);
    for (const r of (data as any[]) ?? []) {
      if (!r.id || !r.owner_id) continue;
      // Belt and braces over the filter: a client that ignores a predicate, or
      // a fake that implements `eq` loosely, must not be the only thing standing
      // between a friends_only Memory and the world model.
      if (!isPublicWorldMemory(r)) continue;
      const city = normCity(r.location_city);
      const at = r.starts_at ? String(r.starts_at) : r.created_at ? String(r.created_at) : null;
      const key = String(r.id);
      registerCityCoordinates(city, r.location_lat, r.location_lng);
      batch.node("person", String(r.owner_id));
      batch.node("experience", key, city, {
        has_place: Boolean(r.place_id), has_trip: Boolean(r.trip_id), has_event: Boolean(r.event_id),
        country: r.location_country ?? null,
      });
      batch.edge({ src_type: "person", src_key: String(r.owner_id), dst_type: "experience", dst_key: key, edge_type: "experienced", at });
      if (r.place_id) {
        batch.edge({ src_type: "experience", src_key: key, dst_type: "place", dst_key: String(r.place_id), edge_type: "at_place", at });
      }
      if (r.trip_id) {
        batch.edge({ src_type: "experience", src_key: key, dst_type: "trip", dst_key: String(r.trip_id), edge_type: "during_trip", at });
      }
      if (r.event_id) {
        batch.edge({ src_type: "experience", src_key: key, dst_type: "event", dst_key: String(r.event_id), edge_type: "at_event", at });
      }
      if (city) {
        batch.node("city", city, city, { country: r.location_country ?? null });
        batch.edge({ src_type: "experience", src_key: key, dst_type: "city", dst_key: city, edge_type: "in_city", at });
        if (at) {
          const slice = timeSliceKey(new Date(at), city, { lat: r.location_lat, lng: r.location_lng });
          batch.node("time_slice", `${city}|${slice}`, city, { slice });
          batch.edge({ src_type: "city", src_key: city, dst_type: "time_slice", dst_key: `${city}|${slice}`, edge_type: "active_during:experience", at });
          monthEdge(batch, city, new Date(at), { lat: r.location_lat, lng: r.location_lng }, "experience", at);
          batch.edge({ src_type: "person", src_key: String(r.owner_id), dst_type: "time_slice", dst_key: `${city}|${slice}`, edge_type: "active_in", at });
        }
      }
    }
  } catch { /* fail-soft */ }

  // ── Persist ────────────────────────────────────────────────────────────────
  let nodesUpserted = 0, edgesUpserted = 0;
  let nodesFailed = 0, edgesFailed = 0;
  const nowIso = new Date().toISOString();

  const nodeRows = [...batch.nodes.values()].map((n) => ({
    node_type: n.node_type,
    node_key:  n.node_key,
    city:      n.city ?? null,
    attrs:     n.attrs ?? {},
    updated_at: nowIso,
  }));
  for (let i = 0; i < nodeRows.length; i += 500) {
    const chunk = nodeRows.slice(i, i + 500);
    const { error } = await db
      .from("compass_graph_nodes")
      .upsert(chunk, { onConflict: "node_type,node_key" });
    // A rejected chunk used to be silently skipped: `nodesUpserted` simply did
    // not grow, so a write path broken for EVERY chunk reported the same "0"
    // as an empty graph, with no log line anywhere. Count and log it.
    if (error) {
      nodesFailed += chunk.length;
      logger.warn(
        { err: error, chunkStart: i, chunkSize: chunk.length },
        "compass graph: node chunk upsert rejected — those nodes are NOT persisted",
      );
    } else {
      nodesUpserted += chunk.length;
    }
  }

  const edgeRows = [...batch.edges.values()].map((e) => ({
    src_type:       e.rec.src_type,
    src_key:        e.rec.src_key,
    dst_type:       e.rec.dst_type,
    dst_key:        e.rec.dst_key,
    edge_type:      e.rec.edge_type,
    weight:         e.count,
    observed_count: e.count,
    first_seen:     e.first,
    last_seen:      e.last,
    attrs:          e.rec.attrs ?? {},
    updated_at:     nowIso,
  }));
  for (let i = 0; i < edgeRows.length; i += 500) {
    const chunk = edgeRows.slice(i, i + 500);
    const { error } = await db
      .from("compass_graph_edges")
      .upsert(chunk, { onConflict: "src_type,src_key,dst_type,dst_key,edge_type" });
    if (error) {
      edgesFailed += chunk.length;
      logger.warn(
        { err: error, chunkStart: i, chunkSize: chunk.length },
        "compass graph: edge chunk upsert rejected — those edges are NOT persisted",
      );
    } else {
      edgesUpserted += chunk.length;
    }
  }

  return { nodesUpserted, edgesUpserted, nodesFailed, edgesFailed };
}

// ── Destination World Model ───────────────────────────────────────────────────

/**
 * Derive per-city time-sliced world models from the persisted graph
 * (city —active_during→ time_slice edges carry the category + timing of every
 * observation) and upsert them into compass_city_models.
 */
/**
 * CPH-15 — the season edge: city → month_slice, typed `active_during_month:
 * <category>`, keyed on the city's LOCAL month (`localMonthKey`), written
 * beside every time-slice edge so the two dimensions are folded from the same
 * observations. A separate node type rather than a wider time-slice key, so
 * the existing `time_slice` identity (and every row under it) is untouched.
 */
function monthEdge(
  batch: GraphBatch,
  city: string,
  at: Date,
  coords: CityCoords | null,
  category: string,
  atIso: string,
): void {
  // A month is a time slice at a coarser grain: the node stays `time_slice`
  // (the CHECK on node_type admits no new kind without a migration) with the
  // month in its key and attrs, and the edge type tells the two folds apart.
  const month = localMonthKey(at, city, coords);
  batch.node("time_slice", `${city}|m:${month}`, city, { month });
  batch.edge({ src_type: "city", src_key: city, dst_type: "time_slice", dst_key: `${city}|m:${month}`, edge_type: `active_during_month:${category}`, at: atIso });
}

export async function buildCityWorldModels(db: SupabaseClient): Promise<number> {
  const { data } = await db
    .from("compass_graph_edges")
    .select("src_key, dst_key, edge_type, observed_count, attrs, first_seen, last_seen")
    .like("edge_type", "active_during:%")
    .limit(20000);

  // IG-07: distinct actors per (city, slice) = the count of deduped
  // person→time_slice `active_in` edges (one row per person per slice). The
  // `active_during` edges above collapse all users into one row, so the
  // distinct-actor count the rhythm k-anon gate needs comes from here. Fail-soft:
  // on error the map stays empty ⇒ distinctActors absent ⇒ the gate suppresses.
  const distinctByKey = new Map<string, number>();
  try {
    const { data: actorEdges } = await db
      .from("compass_graph_edges")
      .select("dst_key")
      .eq("edge_type", "active_in")
      .eq("dst_type", "time_slice")
      .limit(50000);
    for (const a of (actorEdges as any[]) ?? []) {
      const k = String(a.dst_key ?? "");
      if (k) distinctByKey.set(k, (distinctByKey.get(k) ?? 0) + 1);
    }
  } catch { /* fail-soft */ }

  // CPH-15 — the season profiles, from the month edges (city-local months).
  const monthlyByCity = new Map<string, Record<string, MonthProfile>>();
  try {
    const { data: monthEdges } = await db
      .from("compass_graph_edges")
      .select("src_key, dst_key, edge_type, observed_count")
      .like("edge_type", "active_during_month:%")
      .limit(20000);
    for (const r of (monthEdges as any[]) ?? []) {
      const city = String(r.src_key ?? "");
      const dstKey = String(r.dst_key ?? "");           // "<city>|m:<MM>"
      const month = dstKey.includes("|m:") ? dstKey.split("|m:").pop()! : "";
      if (!city || !/^\d{2}$/.test(month)) continue;
      const count = Number(r.observed_count ?? 1) || 1;
      const category = (String(r.edge_type ?? "").split(":")[1] ?? "general").toLowerCase() || "general";
      const months = monthlyByCity.get(city) ?? {};
      const mp = months[month] ?? { count: 0, categories: {} };
      mp.count += count;
      mp.categories[category] = (mp.categories[category] ?? 0) + count;
      months[month] = mp;
      monthlyByCity.set(city, months);
    }
  } catch { /* fail-soft: no season profile this build */ }

  const perCity = new Map<string, { slices: Record<string, TimeSliceProfile>; monthly: Record<string, MonthProfile>; catTotals: Record<string, number>; sample: number }>();

  for (const r of (data as any[]) ?? []) {
    const city = String(r.src_key ?? "");
    const dstKey = String(r.dst_key ?? "");           // "<city>|<dow>:<daypart>"
    const slice = dstKey.includes("|") ? dstKey.split("|").pop()! : dstKey;
    if (!city || !slice.includes(":")) continue;
    const count = Number(r.observed_count ?? 1) || 1;
    const category = (String(r.edge_type ?? "").split(":")[1] ?? "general").toLowerCase() || "general";

    const entry = perCity.get(city) ?? { slices: {}, monthly: {}, catTotals: {}, sample: 0 };
    const sp = entry.slices[slice] ?? { count: 0, categories: {} };
    sp.count += count;
    // Distinct contributors behind this slice (k-anon denominator for the gate).
    sp.distinctActors = distinctByKey.get(dstKey) ?? sp.distinctActors ?? 0;
    sp.categories[category] = (sp.categories[category] ?? 0) + count;
    entry.slices[slice] = sp;
    entry.catTotals[category] = (entry.catTotals[category] ?? 0) + count;
    entry.sample += count;
    // The season profile comes from the month edges above (city-local month,
    // per category), not from slicing UTC timestamps out of first/last seen.
    entry.monthly = monthlyByCity.get(city) ?? entry.monthly;
    perCity.set(city, entry);
  }

  let modeled = 0;
  const builtAt = new Date().toISOString();
  for (const [city, e] of perCity) {
    const topCategories = Object.entries(e.catTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([k]) => k);
    const { error } = await db.from("compass_city_models").upsert(
      {
        city,
        time_slices:    e.slices,
        monthly:        e.monthly,
        top_categories: topCategories,
        sample_size:    e.sample,
        built_at:       builtAt,
      },
      { onConflict: "city" },
    );
    if (!error) modeled++;
  }
  return modeled;
}

/** Load one city's world model (null when absent or db unavailable). */
export async function getCityWorldModel(
  db: SupabaseClient | null,
  city: string | null,
): Promise<CityWorldModel | null> {
  const key = canonicalCityKey(city);
  if (!db || !key) return null;
  try {
    const { data } = await db
      .from("compass_city_models")
      .select("city, time_slices, monthly, top_categories, sample_size, built_at")
      .eq("city", key)
      .maybeSingle();
    if (!data) return null;
    return {
      city:          String((data as any).city),
      timeSlices:    ((data as any).time_slices as Record<string, TimeSliceProfile>) ?? {},
      monthly:       ((data as any).monthly as Record<string, number>) ?? {},
      topCategories: ((data as any).top_categories as string[]) ?? [],
      sampleSize:    Number((data as any).sample_size ?? 0),
      builtAt:       String((data as any).built_at ?? ""),
    };
  } catch {
    return null;
  }
}

// ── World-model ranking boost ─────────────────────────────────────────────────

/** Max bounded boost the world model may add to a final score (like memoryBoost). */
export const WORLD_MODEL_BOOST_MAX = 5;
/**
 * CPH-15 — the SEASON addend's ceiling, a documented tunable beside
 * WORLD_MODEL_BOOST_MAX: smaller, because a month is a coarser signal than a
 * weekday × daypart slice.
 */
export const SEASON_BOOST_MAX = 2;

/** Slices with fewer observations than this contribute NO boost (honesty). */
export const MIN_SLICE_SAMPLE = 3;

export interface WorldModelAnnotation {
  boost: number;                       // 0..WORLD_MODEL_BOOST_MAX + SEASON_BOOST_MAX
  factor: RankingFactor | null;
  /** CPH-15 — the season addend, reported separately so "varies by season" is observable. */
  seasonBoost: number;                 // 0..SEASON_BOOST_MAX
  seasonFactor: RankingFactor | null;
}

/**
 * CPH-15 — bounded season addend: the SAME item scores differently in
 * different months when the city's month profile says its category is what
 * people do there then. Pure; 0 when the month is under-sampled or unmatched.
 */
export function seasonBoostForItem(item: CompassItem, model: CityWorldModel | null, at: Date): { boost: number; factor: RankingFactor | null } {
  try {
    if (!model) return { boost: 0, factor: null };
    const month = localMonthKey(at, model.city);
    const profile = monthProfile(model, month);
    if (!profile || profile.count < MIN_SLICE_SAMPLE) return { boost: 0, factor: null };
    let matched = 0;
    let matchedCat: string | null = null;
    for (const tok of itemCategoryTokens(item)) {
      const c = profile.categories[tok];
      if (c && c > 0) { matched += c; if (!matchedCat) matchedCat = tok; }
    }
    if (matched === 0) return { boost: 0, factor: null };
    const share = Math.min(1, matched / profile.count);
    const boost = Math.round(share * SEASON_BOOST_MAX * 100) / 100;
    if (boost <= 0) return { boost: 0, factor: null };
    return {
      boost,
      factor: { key: "city_season", label: `${model.city} leans into ${matchedCat} at this time of year`, weight: share, detail: `month ${month}` },
    };
  } catch {
    return { boost: 0, factor: null };
  }
}

function itemCategoryTokens(item: CompassItem): string[] {
  const toks = new Set<string>();
  const cat = (item as any).category;
  if (typeof cat === "string" && cat.trim()) toks.add(cat.trim().toLowerCase());
  for (const t of item.interestTags ?? []) toks.add(String(t).toLowerCase());
  toks.add(String(item.type).toLowerCase());
  return [...toks];
}

/**
 * Bounded, time-aware boost from the Destination World Model. Pure — never
 * throws. Returns 0 when the model is missing, the current time slice is
 * under-sampled, or the item's categories don't match the slice's activity.
 * The SAME item scores differently at different times of week — that is the
 * point: destination behavior varies by time.
 */
export function worldModelBoostForItem(
  item: CompassItem,
  model: CityWorldModel | null,
  at: Date,
): WorldModelAnnotation {
  const season = seasonBoostForItem(item, model, at);
  const none: WorldModelAnnotation = { boost: season.boost, factor: null, seasonBoost: season.boost, seasonFactor: season.factor };
  try {
    if (!model) return { boost: 0, factor: null, seasonBoost: 0, seasonFactor: null };
    const slice = model.timeSlices[timeSliceKey(at, model.city)];
    if (!slice || slice.count < MIN_SLICE_SAMPLE) return none;

    const tokens = itemCategoryTokens(item);
    let matched = 0;
    let matchedCat: string | null = null;
    for (const tok of tokens) {
      const c = slice.categories[tok];
      if (c && c > 0) {
        matched += c;
        if (!matchedCat) matchedCat = tok;
      }
    }
    if (matched === 0) return none;

    const share = Math.min(1, matched / slice.count);
    const rhythm = Math.round(share * WORLD_MODEL_BOOST_MAX * 100) / 100;
    if (rhythm <= 0) return none;

    const sliceKey = timeSliceKey(at, model.city);
    return {
      boost: Math.round((rhythm + season.boost) * 100) / 100,
      factor: {
        key:    "city_rhythm",
        label:  `${model.city} is usually into ${matchedCat} around this time`,
        weight: share,
        detail: sliceKey.replace(":", " "),
      },
      seasonBoost: season.boost,
      seasonFactor: season.factor,
    };
  } catch {
    return { boost: 0, factor: null, seasonBoost: 0, seasonFactor: null };
  }
}

// ── City-confidence index ─────────────────────────────────────────────────────

export const CONFIDENCE_TIER_THRESHOLDS = { deep: 60, moderate: 30 } as const;

export function tierForScore(score: number): CityConfidenceTier {
  if (score >= CONFIDENCE_TIER_THRESHOLDS.deep) return "deep";
  if (score >= CONFIDENCE_TIER_THRESHOLDS.moderate) return "moderate";
  return "thin";
}

/** Pure scoring: aggregate depth signals → 0–100 depth score. */
export function scoreCityDepth(signals: {
  visitors: number;        // distinct people with visited edges
  returners: number;       // distinct people with returned_to edges (cross-trip)
  events: number;          // events in the city
  outcomes: number;        // realized outcome edges touching the city's items
  sliceCoverage: number;   // 0–1: share of the 28 dow×daypart slices with data
  sampleSize: number;      // total world-model observations
}): number {
  const log10 = (n: number) => Math.log10(Math.max(1, n) + 1);
  // Each component saturates; weights sum to 100.
  const s =
    Math.min(1, log10(signals.visitors)   / 2) * 25 +   // ~100 visitors → full
    Math.min(1, log10(signals.returners)  / 1.5) * 15 + // cross-trip depth
    Math.min(1, log10(signals.events)     / 2) * 20 +
    Math.min(1, log10(signals.outcomes)   / 2) * 15 +
    Math.min(1, signals.sliceCoverage) * 15 +
    Math.min(1, log10(signals.sampleSize) / 2.5) * 10;
  return Math.round(Math.min(100, Math.max(0, s)) * 100) / 100;
}

/**
 * Compute + persist the city-confidence index for every modeled city.
 * Signals are aggregate counts only — no user identifiers are stored.
 */
export async function computeCityConfidenceIndex(
  db: SupabaseClient,
): Promise<{ scored: number; strongestCity: string | null }> {
  const [{ data: models }, { data: visitEdges }, { data: cityEvents }] = await Promise.all([
    db.from("compass_city_models").select("city, time_slices, sample_size").limit(1000),
    db.from("compass_graph_edges")
      .select("src_key, dst_key, edge_type, observed_count")
      .in("edge_type", ["visited", "returned_to", "in_city"])
      .limit(20000),
    db.from("compass_graph_nodes")
      .select("node_type, node_key, city")
      .eq("node_type", "event")
      .limit(20000),
  ]);

  const visitorsByCity = new Map<string, number>();
  const returnersByCity = new Map<string, number>();
  for (const r of (visitEdges as any[]) ?? []) {
    const city = String(r.dst_key ?? "");
    if (!city) continue;
    if (r.edge_type === "visited") visitorsByCity.set(city, (visitorsByCity.get(city) ?? 0) + 1);
    if (r.edge_type === "returned_to") returnersByCity.set(city, (returnersByCity.get(city) ?? 0) + 1);
  }
  const eventsByCity = new Map<string, number>();
  for (const r of (cityEvents as any[]) ?? []) {
    const city = normCity(r.city);
    if (city) eventsByCity.set(city, (eventsByCity.get(city) ?? 0) + 1);
  }

  // Outcome depth per city: outcome edges whose target item lives in the city.
  const outcomesByCity = new Map<string, number>();
  try {
    const { data: outcomeEdges } = await db
      .from("compass_graph_edges")
      .select("dst_key, edge_type")
      .like("edge_type", "outcome:%")
      .limit(20000);
    const eventCityByKey = new Map<string, string>();
    for (const r of (cityEvents as any[]) ?? []) {
      const c = normCity(r.city);
      if (c) eventCityByKey.set(String(r.node_key), c);
    }
    for (const r of (outcomeEdges as any[]) ?? []) {
      const city = eventCityByKey.get(String(r.dst_key ?? ""));
      if (city) outcomesByCity.set(city, (outcomesByCity.get(city) ?? 0) + 1);
    }
  } catch { /* fail-soft */ }

  let scored = 0;
  let strongestCity: string | null = null;
  let strongestScore = -1;
  const computedAt = new Date().toISOString();

  for (const m of (models as any[]) ?? []) {
    const city = String(m.city);
    const slices = (m.time_slices as Record<string, TimeSliceProfile>) ?? {};
    const covered = Object.values(slices).filter((s) => (s?.count ?? 0) >= MIN_SLICE_SAMPLE).length;
    const signals = {
      visitors:      visitorsByCity.get(city) ?? 0,
      returners:     returnersByCity.get(city) ?? 0,
      events:        eventsByCity.get(city) ?? 0,
      outcomes:      outcomesByCity.get(city) ?? 0,
      sliceCoverage: Math.round((covered / 28) * 100) / 100,
      sampleSize:    Number(m.sample_size ?? 0),
    };
    const depthScore = scoreCityDepth(signals);
    const { error } = await db.from("compass_city_confidence").upsert(
      { city, depth_score: depthScore, tier: tierForScore(depthScore), signals, computed_at: computedAt },
      { onConflict: "city" },
    );
    if (!error) {
      scored++;
      if (depthScore > strongestScore) { strongestScore = depthScore; strongestCity = city; }
    }
  }

  return { scored, strongestCity };
}

/** Load one city's confidence record (null-safe, fail-soft). */
export async function getCityConfidence(
  db: SupabaseClient | null,
  city: string | null,
): Promise<CityConfidence | null> {
  const key = canonicalCityKey(city);
  if (!db || !key) return null;
  try {
    const { data } = await db
      .from("compass_city_confidence")
      .select("city, depth_score, tier, signals, computed_at")
      .eq("city", key)
      .maybeSingle();
    if (!data) return null;
    return {
      city:       String((data as any).city),
      depthScore: Number((data as any).depth_score ?? 0),
      tier:       ((data as any).tier as CityConfidenceTier) ?? "thin",
      signals:    ((data as any).signals as Record<string, number>) ?? {},
      computedAt: String((data as any).computed_at ?? ""),
    };
  } catch {
    return null;
  }
}

// ── Phase 8 bridge + prompt context ───────────────────────────────────────────

/**
 * Honest data note for the Phase 8 confidence system, keyed by city depth.
 * Deep cities answer confidently; thin/unknown cities say so.
 */
export function cityConfidenceNote(conf: CityConfidence | null, city: string): string {
  if (!conf || conf.tier === "thin") {
    return `Limited local data for ${city} — be upfront that suggestions there are less certain.`;
  }
  if (conf.tier === "moderate") {
    return `Moderate local data depth for ${city} — reasonable grounding, flag gaps honestly.`;
  }
  return `Deep local data for ${city} — recommendations are grounded in substantial community history.`;
}

/**
 * Build privacy-safe prompt lines from the Destination World Model + the
 * city-confidence index for the user's city "now". Aggregates only — never
 * includes user ids, handles, or coordinates. Fail-soft: [] on any problem.
 */
export async function buildDestinationContextLines(
  db: SupabaseClient | null,
  city: string | null,
  at: Date = new Date(),
): Promise<string[]> {
  if (!db || !city) return [];
  try {
    const [model, conf] = await Promise.all([
      getCityWorldModel(db, city),
      getCityConfidence(db, city),
    ]);
    const lines: string[] = [];

    if (model) {
      const sliceKey = timeSliceKey(at, city);
      const slice = model.timeSlices[sliceKey];
      // IG-07: a time-sliced rhythm line publishes only when the gate flag is on
      // AND ≥ COMPASS_RHYTHM_K DISTINCT contributors are behind the slice —
      // otherwise it is a k=1 leak. Flag off (the default) suppresses it and we
      // fall through to the city-wide, non-time-sliced summary below.
      // Literal flag name so check-flag-polarity can resolve this read statically.
      const rhythmGateOn = await isFlagEnabled(db, "intel_compass_rhythm_actor_gate");
      if (slice && slice.count >= MIN_SLICE_SAMPLE && mayPublishRhythm(slice.distinctActors ?? 0, rhythmGateOn)) {
        const top = Object.entries(slice.categories)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([k]) => k);
        lines.push(
          `Destination rhythm — ${city} (${sliceKey.replace(":", " ")}): typically active around ${top.join(", ")} at this time (community history, ${slice.count} observations from ${slice.distinctActors ?? 0} contributors).`,
        );
      } else {
        lines.push(
          `Destination rhythm — ${city}: not enough history for this exact time slot; overall the city skews toward ${model.topCategories.slice(0, 3).join(", ") || "general exploring"}.`,
        );
      }
      const month = localMonthKey(at, city);
      const season = monthProfile(model, month);
      if (season && season.count > 0) {
        const top = Object.entries(season.categories).sort(([, a], [, b]) => b - a).slice(0, 3).map(([k]) => k);
        lines.push(
          top.length > 0
            ? `Seasonality: in month ${month} ${city} leans toward ${top.join(", ")} (community history, ${season.count} signals).`
            : `Seasonality: ${city} has recorded activity this month in past data (${season.count} signals).`,
        );
      }
    }

    lines.push(`City data confidence: ${conf ? `${conf.tier} (${conf.depthScore}/100)` : "unknown"}. ${cityConfidenceNote(conf, city)}`);
    return lines;
  } catch {
    return [];
  }
}

// ── One-time cleanup: non-canonical city rows ────────────────────────────────

export interface GraphCleanupReport {
  nodesDeleted: number;
  edgesDeleted: number;
  modelsDeleted: number;
  confidenceDeleted: number;
  /** Stale keys that were removed (variant or junk city keys). */
  removedCityKeys: string[];
}

const CLEANUP_FETCH_LIMIT = 20000;
const DELETE_CHUNK = 200;

/** True when a stored city key is NOT its own canonical form (or is junk). */
function isStaleCityKey(key: string): boolean {
  return canonicalCityKey(key) !== key;
}

/** City part of a time_slice node key ("cebu|fri:evening" → "cebu"). */
function timeSliceCity(key: string): string {
  const i = key.indexOf("|");
  return i >= 0 ? key.slice(0, i) : key;
}

async function deleteByIds(db: SupabaseClient, table: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const { error } = await db.from(table).delete().in("id", chunk);
    if (!error) deleted += chunk.length;
  }
  return deleted;
}

/**
 * Remove rows written before city-key canonicalization landed: city/time_slice
 * nodes keyed under variant spellings ("siargoa", "cebu city") or junk
 * fragments ("san"), the edges touching them, and world-model / confidence
 * rows for those keys. Canonical rows are left alone — run
 * rebuildIntelligenceGraph afterwards to repopulate anything the variants
 * contributed under their canonical keys.
 */
export async function cleanupNonCanonicalCityRows(
  db: SupabaseClient,
): Promise<GraphCleanupReport> {
  const removedCityKeys = new Set<string>();

  // 1. Stale city + time_slice nodes.
  const [{ data: cityNodes }, { data: sliceNodes }] = await Promise.all([
    db.from("compass_graph_nodes").select("id, node_key")
      .eq("node_type", "city").limit(CLEANUP_FETCH_LIMIT),
    db.from("compass_graph_nodes").select("id, node_key")
      .eq("node_type", "time_slice").limit(CLEANUP_FETCH_LIMIT),
  ]);

  const staleCityKeys = new Set<string>();
  const staleNodeIds: string[] = [];
  for (const r of (cityNodes as any[]) ?? []) {
    const key = String(r.node_key ?? "");
    if (key && isStaleCityKey(key)) {
      staleCityKeys.add(key);
      removedCityKeys.add(key);
      staleNodeIds.push(String(r.id));
    }
  }
  const staleSliceKeys = new Set<string>();
  for (const r of (sliceNodes as any[]) ?? []) {
    const key = String(r.node_key ?? "");
    if (key && isStaleCityKey(timeSliceCity(key))) {
      staleSliceKeys.add(key);
      removedCityKeys.add(timeSliceCity(key));
      staleNodeIds.push(String(r.id));
    }
  }
  const nodesDeleted = await deleteByIds(db, "compass_graph_nodes", staleNodeIds);

  // 2. Edges touching a stale city or time_slice key on either endpoint.
  const { data: edges } = await db
    .from("compass_graph_edges")
    .select("id, src_type, src_key, dst_type, dst_key")
    .limit(CLEANUP_FETCH_LIMIT * 5);
  const staleEndpoint = (t: string, k: string) =>
    (t === "city" && isStaleCityKey(k)) ||
    (t === "time_slice" && isStaleCityKey(timeSliceCity(k)));
  const staleEdgeIds: string[] = [];
  for (const r of (edges as any[]) ?? []) {
    if (
      staleEndpoint(String(r.src_type ?? ""), String(r.src_key ?? "")) ||
      staleEndpoint(String(r.dst_type ?? ""), String(r.dst_key ?? ""))
    ) {
      staleEdgeIds.push(String(r.id));
    }
  }
  const edgesDeleted = await deleteByIds(db, "compass_graph_edges", staleEdgeIds);

  // 3. World models + confidence rows keyed by a stale city.
  let modelsDeleted = 0;
  let confidenceDeleted = 0;
  for (const table of ["compass_city_models", "compass_city_confidence"] as const) {
    const { data } = await db.from(table).select("city").limit(CLEANUP_FETCH_LIMIT);
    const stale = [...new Set(
      ((data as any[]) ?? [])
        .map((r) => String(r.city ?? ""))
        .filter((c) => c && isStaleCityKey(c)),
    )];
    for (const c of stale) removedCityKeys.add(c);
    let deleted = 0;
    for (let i = 0; i < stale.length; i += DELETE_CHUNK) {
      const chunk = stale.slice(i, i + DELETE_CHUNK);
      const { error } = await db.from(table).delete().in("city", chunk);
      if (!error) deleted += chunk.length;
    }
    if (table === "compass_city_models") modelsDeleted = deleted;
    else confidenceDeleted = deleted;
  }

  return {
    nodesDeleted,
    edgesDeleted,
    modelsDeleted,
    confidenceDeleted,
    removedCityKeys: [...removedCityKeys].sort(),
  };
}

// ── Full rebuild orchestrator ─────────────────────────────────────────────────

/** Rebuild graph → world models → confidence index, in order. */
// ── §28.8 revocation for experience nodes ────────────────────────────────────

/** What one reconciliation pass removed. Zeroes are a real answer, not a skip. */
export interface ExperienceReconcileReport {
  /** `experience` nodes examined against `memories`. */
  examined: number;
  /** Nodes whose Memory is gone or no longer eligible, and were deleted. */
  nodesDeleted: number;
  /** Edges touching a deleted experience node, on either endpoint. */
  edgesDeleted: number;
  /**
   * Node keys this pass REFUSED TO JUDGE, because the `memories` read that
   * would have decided them failed. They are neither kept-by-decision nor
   * deleted; the next tick decides them. Non-zero means the sweep was PARTIAL
   * — the batches that answered were acted on, the ones that did not were left
   * exactly as they were. Without this number a sweep that judged three nodes
   * of three thousand reports the same `nodesDeleted: 0` as one that judged
   * all three thousand and found nothing to remove.
   */
  undecided: number;
  /** True when a read failed, so this pass could not judge every node. */
  unresolved: boolean;
}

/**
 * Memory ids whose graph node must go, out of the ids this pass asked about.
 *
 * DELETE ONLY ON A POSITIVE ANSWER. `liveIds` holds the ids a SUCCESSFUL read
 * returned and `isPublicWorldMemory` accepted, so an asked-about id missing
 * from it means "gone, or no longer eligible" — exactly the condition to
 * revoke on, PROVIDED the read succeeded and the id was actually asked for.
 * A failed read returns the same empty set as a fully-revoked one, and
 * deleting on that would empty the graph during an outage. So the caller
 * passes the ids it asked about and `ok`; on `ok === false` nothing is dead,
 * which is what makes carrying on to the next batch after a failed one safe.
 */
function deadExperienceKeys(
  asked: readonly string[],
  liveIds: ReadonlySet<string>,
  ok: boolean,
): string[] {
  if (!ok) return [];
  return asked.filter((k) => !liveIds.has(k));
}

/**
 * Remove `experience` nodes — and every edge touching them — whose source
 * Memory is no longer eligible to be public-world intelligence.
 *
 * WHY THIS HAS TO EXIST. `buildGraphFromSources` persists with `upsert` and
 * nothing else. Upsert adds and updates; it never removes. So a Memory that
 * was `public` on Monday and is deleted, archived, or narrowed to `only_me` on
 * Tuesday keeps its experience node and its person/place/trip/event/city edges
 * for as long as the tables exist, and keeps contributing to the city's world
 * model and confidence score. The daily rebuild does not fix that — it reruns
 * the same additive build.
 *
 * Highlights/Memories spec §28.8: "Never keep deleted Memories in embeddings,
 * public caches, Highlights, Passport, or Compass projections." §21 says the
 * same for a privacy narrowing: "Make private: revoke public derivatives."
 * compass_graph_nodes IS a Compass projection and the world model IS a public
 * derivative, so the rule lands here.
 *
 * ONE ELIGIBILITY PREDICATE, NOT TWO. The dooming decision runs through
 * `isPublicWorldMemory` — the same function `buildGraphFromSources` gates its
 * write on. A sweep with its own looser predicate (`visibility <> 'only_me'`,
 * say) is the defect it is supposed to close, wearing the fix's name: it keeps
 * exactly the named-audience rows the builder now refuses to write, so a
 * Memory narrowed from `public` to `friends_only` survives the sweep forever.
 *
 * POSITIVE, NOT INFERRED BY ABSENCE — deliberately. The obvious implementation
 * is "delete every experience node the build did not just write", and it is
 * wrong here: `buildGraphFromSources` reads at most BUILD_LIMIT (5000) rows, so
 * on a tree with more eligible Memories than that, absence from this run's
 * batch means "not read", not "not eligible", and the sweep would delete live
 * rows. This asks `memories` about the ids it actually holds instead, in
 * batches, so the answer does not depend on how much the builder read.
 *
 * FAILS CLOSED, PER BATCH. A `memories` read that errors or throws decides
 * NOTHING: `deadExperienceKeys` refuses to name a key on `ok === false`, so
 * not one node in that batch can be deleted, and its keys are counted into
 * `undecided` instead. The batches that DID answer are still acted on — a
 * single transient read must not hold a privacy revocation for another day,
 * and it cannot widen one either, because a batch that failed contributes no
 * dead keys. `unresolved` says at least one batch was skipped; `undecided`
 * says how many nodes that left unjudged.
 */
export async function reconcileExperienceNodes(db: SupabaseClient): Promise<ExperienceReconcileReport> {
  const report: ExperienceReconcileReport = { examined: 0, nodesDeleted: 0, edgesDeleted: 0, undecided: 0, unresolved: false };

  let nodes: any[];
  try {
    const { data, error } = await db
      .from("compass_graph_nodes")
      .select("id, node_key")
      .eq("node_type", "experience")
      .limit(CLEANUP_FETCH_LIMIT);
    // An unreadable node table is not an empty one. Bind the error rather than
    // letting `data: null` read as "no experience nodes" — then `unresolved`
    // separates the two reports, which are otherwise identical zeroes.
    if (error) { report.unresolved = true; return report; }
    nodes = (data as any[]) ?? [];
  } catch {
    report.unresolved = true;
    return report;
  }

  const idByMemory = new Map<string, string[]>();
  for (const n of nodes) {
    const key = String(n.node_key ?? "");
    if (!key) continue;
    const list = idByMemory.get(key);
    if (list) list.push(String(n.id));
    else idByMemory.set(key, [String(n.id)]);
  }
  const memoryIds = [...idByMemory.keys()];
  report.examined = memoryIds.length;
  if (memoryIds.length === 0) return report;

  /** Memory ids that MAY stay. Absent from this set ⇒ gone or ineligible. */
  const eligible = new Set<string>();
  /** Keys a positive, successful read named as gone or no longer eligible. */
  const doomed = new Set<string>();
  let undecided = 0;
  for (let i = 0; i < memoryIds.length; i += DELETE_CHUNK) {
    const chunk = memoryIds.slice(i, i + DELETE_CHUNK);
    let ok = false;
    try {
      const { data, error } = await db
        .from("memories")
        .select("id, state, visibility")
        .in("id", chunk);
      if (error) {
        report.unresolved = true;
      } else {
        ok = true;
        for (const r of (data as any[]) ?? []) {
          if (isPublicWorldMemory(r)) eligible.add(String(r.id));
        }
      }
    } catch {
      report.unresolved = true;
    }
    for (const k of deadExperienceKeys(chunk, eligible, ok)) doomed.add(k);
    if (!ok) undecided += chunk.length;
  }
  report.undecided = undecided;

  const doomedNodeIds: string[] = [];
  for (const key of doomed) doomedNodeIds.push(...(idByMemory.get(key) ?? []));
  if (doomedNodeIds.length === 0) return report;

  // Edges FIRST. A node row deleted before its edges leaves edges pointing at
  // nothing, and those edges are what buildCityWorldModels actually counts —
  // an `in_city` edge from a revoked experience keeps inflating the city's
  // sample size whether or not its node still exists. If the process dies
  // between the two deletes, this order leaves a node nothing derives from;
  // the other order leaves the leak.
  try {
    const { data: edges } = await db
      .from("compass_graph_edges")
      .select("id, src_type, src_key, dst_type, dst_key")
      .limit(CLEANUP_FETCH_LIMIT * 5);
    const doomedEdgeIds: string[] = [];
    for (const e of (edges as any[]) ?? []) {
      const touches =
        (String(e.src_type ?? "") === "experience" && doomed.has(String(e.src_key ?? ""))) ||
        (String(e.dst_type ?? "") === "experience" && doomed.has(String(e.dst_key ?? "")));
      if (touches) doomedEdgeIds.push(String(e.id));
    }
    report.edgesDeleted = await deleteByIds(db, "compass_graph_edges", doomedEdgeIds);
  } catch { /* fail-soft: the node sweep below still runs */ }

  report.nodesDeleted = await deleteByIds(db, "compass_graph_nodes", doomedNodeIds);
  return report;
}

export async function rebuildIntelligenceGraph(db: SupabaseClient): Promise<GraphRebuildReport> {
  const { nodesUpserted, edgesUpserted, nodesFailed, edgesFailed } = await buildGraphFromSources(db);
  // §28.8 / §21 — BEFORE the aggregates are folded, not after. buildCityWorldModels
  // and computeCityConfidenceIndex both read compass_graph_edges, so a revoked
  // experience swept afterwards would still have been counted into this run's
  // world model and confidence score, and would sit there until tomorrow.
  const experienceRevocations = await reconcileExperienceNodes(db);
  const citiesModeled = await buildCityWorldModels(db);
  const { scored, strongestCity } = await computeCityConfidenceIndex(db);
  return {
    nodesUpserted, edgesUpserted, nodesFailed, edgesFailed,
    citiesModeled, citiesScored: scored, strongestCity,
    experienceRevocations,
  };
}
