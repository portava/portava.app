/**
 * ContextThreadService — the Wall's bridge from a social object to Portava's
 * surrounding functions (spec §8/§9).
 *
 * OWNS: the DECISION of whether a compact Context Thread earns its place beneath
 * a feed object, and the SHAPE of that thread. DOES NOT OWN: any of the
 * contextual truth — every fact it emits is read from a canonical system through
 * that system's own gated read path, never invented here:
 *
 *   live_place       → lib/liveClaimRead.readLiveClaimEnvelopes (self-gating;
 *                       fail-closed; the live-label truth boundary is enforced
 *                       there, so a stale / prediction / below-floor claim never
 *                       reaches a thread).
 *   trip_relevance   → the viewer's OWN trips (owner_id = viewer) — never another
 *                       user's trip, so this leaks nothing.
 *   social_presence  → PUBLIC posts at the place by people the viewer follows —
 *                       a disclosure-safe signal (they publicly posted about being
 *                       there). Exact person location is NEVER inferred (spec §23).
 *   hidden_gem       → hidden_gems + lib/hiddenGemState derivation, behind the
 *                       gem's disclosure policy (protected / reveal-after-acceptance
 *                       gems are suppressed unless the viewer is authorized, §20).
 *   buddy            → rent_buddy_profiles availability at CITY granularity only —
 *                       never a precise Buddy coordinate (spec §19). Behind the
 *                       wall_rab_integration_enabled flag.
 *
 * THE DEFAULT IS "NO THREAD" (spec §9). Contextual intelligence earns space; it
 * does not receive space merely because data exists. `shouldAttachContextThread`
 * returns false by default and every one of its eight conditions must hold. The
 * service gathers candidate facts fail-soft, runs the §9 gate on each, and
 * attaches AT MOST ONE thread — the single most useful survivor — because the
 * Context Thread is a compact attachment, not a panel of annotations.
 *
 * Everything here is fail-soft: any canonical read that throws yields NO
 * candidate rather than an error, so a Context Thread hiccup can never collapse
 * the feed (spec §34). The whole surface is behind wall_context_threads_enabled
 * (fail-closed) — off, no object ever carries a thread.
 */
import type {
  ContextThread,
  ContextThreadKind,
  FreshnessState,
  WallAction,
  WallProjection,
} from "../../lib/wallProjection.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../../lib/liveClaimRead.js";
import { deriveGemProjection } from "../hiddenGems/HiddenGemContributionService.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";

// ── Policy (spec §9 thresholds) ──────────────────────────────────────────────

/**
 * The §9 policy. `maxAgeMs` is the freshness horizon: a contextual fact older
 * than this is suppressed (`freshness <= policy.maxAge`). `minConfidence` and
 * `minUtility` are the earn-your-space floors. Deliberately conservative — the
 * default outcome of the gate should often be false (spec §9).
 */
export interface ContextThreadPolicy {
  minConfidence: number;
  maxAgeMs: number;
  minUtility: number;
}

export const DEFAULT_CONTEXT_THREAD_POLICY: ContextThreadPolicy = {
  minConfidence: 0.55,
  maxAgeMs: 6 * 60 * 60 * 1000, // 6h — a "context" fact older than this is stale
  minUtility: 0.5,
};

// ── The §9 eligibility gate ──────────────────────────────────────────────────

/**
 * The input to the §9 gate. Every field is a resolved decision-signal about ONE
 * candidate thread. `freshnessAgeMs` is the AGE of the underlying fact in
 * milliseconds (0 for a structural fact like the viewer's own trip); the gate
 * compares it against policy.maxAgeMs (spec §9: `freshness <= policy.maxAge`).
 */
export interface ContextThreadGateInput {
  /** The viewer is authorized to see this contextual fact (spec §9/§23). */
  viewerAuthorized: boolean;
  /** The fact is contextually relevant to THIS object (not merely present). */
  contextRelevant: boolean;
  /** 0..1 confidence in the fact. */
  confidence: number;
  /** Age of the fact in ms (lower is fresher). */
  freshnessAgeMs: number;
  /** The fact would disclose a sensitive/protected subject (spec §20/§23). */
  sensitiveDisclosure: boolean;
  /** The fact already appears in the Live For You strip (spec §4/§15). */
  duplicatesLiveStrip: boolean;
  /** Too many threads already in the visible window (spec §15 visualOverload). */
  visualOverload: boolean;
  /** 0..1 expected usefulness of surfacing this thread. */
  expectedUtility: number;
}

/**
 * The §9 eligibility gate. Returns false BY DEFAULT — a Context Thread is
 * attached only when every one of the eight conditions holds. This is a pure
 * function of its inputs and the policy, so the "does contextual intelligence
 * earn space here?" decision is fully testable without any I/O.
 */
export function shouldAttachContextThread(
  input: ContextThreadGateInput,
  policy: ContextThreadPolicy = DEFAULT_CONTEXT_THREAD_POLICY,
): boolean {
  return (
    input.viewerAuthorized &&
    input.contextRelevant &&
    input.confidence >= policy.minConfidence &&
    input.freshnessAgeMs <= policy.maxAgeMs &&
    !input.sensitiveDisclosure &&
    !input.duplicatesLiveStrip &&
    !input.visualOverload &&
    input.expectedUtility >= policy.minUtility
  );
}

// ── Candidates ────────────────────────────────────────────────────────────────

/** A proposed thread plus the §9 gate input that decides whether it renders. */
export interface ContextThreadCandidate {
  thread: ContextThread;
  gate: ContextThreadGateInput;
}

/**
 * Kind priority for tie-breaking when two candidates pass the gate with equal
 * expected utility. Live > social > trip > gem > buddy > map > memory > compass —
 * the most decision-relevant, time-sensitive facts win the single slot.
 */
const KIND_PRIORITY: Record<ContextThreadKind, number> = {
  live_place: 8,
  social_presence: 7,
  trip_relevance: 6,
  hidden_gem: 5,
  buddy: 4,
  map: 3,
  memory: 2,
  compass: 1,
};

/**
 * Select AT MOST ONE thread from the candidates: the highest-expected-utility
 * survivor of the §9 gate (tie-break on kind priority). Pure and fully testable.
 * `windowSaturated` folds the cross-item §15 context-thread cap into every
 * candidate's `visualOverload`, so a saturated window yields no thread.
 */
export function selectContextThread(
  candidates: ContextThreadCandidate[],
  policy: ContextThreadPolicy = DEFAULT_CONTEXT_THREAD_POLICY,
  opts: { windowSaturated?: boolean } = {},
): ContextThread | undefined {
  const survivors: ContextThreadCandidate[] = [];
  for (const c of candidates) {
    const gate: ContextThreadGateInput = {
      ...c.gate,
      visualOverload: c.gate.visualOverload || opts.windowSaturated === true,
    };
    if (shouldAttachContextThread(gate, policy)) survivors.push(c);
  }
  if (survivors.length === 0) return undefined;
  survivors.sort((a, b) => {
    if (b.gate.expectedUtility !== a.gate.expectedUtility) {
      return b.gate.expectedUtility - a.gate.expectedUtility;
    }
    return KIND_PRIORITY[b.thread.kind] - KIND_PRIORITY[a.thread.kind];
  });
  return survivors[0].thread;
}

// ── Viewer context ────────────────────────────────────────────────────────────

export interface ContextThreadViewerContext {
  viewerId: string;
  followedCreatorIds?: Set<string>;
  viewerTripIds?: Set<string>;
  currentCity?: string | null;
  /** Subjects already shown in the Live For You strip (dedup, spec §4/§15). */
  liveStripSubjectIds?: Set<string>;
  /** True when the per-window context-thread cap is already reached (§15). */
  windowSaturated?: boolean;
  /** wall_rab_integration_enabled — gates the buddy candidate reader. */
  rabEnabled?: boolean;
  now?: Date;
}

// ── freshness helpers ────────────────────────────────────────────────────────

function ageMs(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now.getTime() - t);
}

function freshnessFromEnvelope(env: LiveClaimEnvelope, now: Date): FreshnessState {
  const valid = Date.parse(env.validUntil);
  if (!Number.isNaN(valid) && valid <= now.getTime()) return "stale";
  return env.state === "live" ? "live" : "recent";
}

/** A crowd-level string from a live claim value, if present. */
function crowdLabel(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const lvl = (value as any).level;
    if (typeof lvl === "string") return lvl;
  }
  return null;
}

const CROWD_PHRASE: Record<string, string> = {
  quiet: "Quiet right now",
  low: "Quiet right now",
  moderate: "Moderately busy right now",
  medium: "Moderately busy right now",
  busy: "Busy right now",
  high: "Busy right now",
  very_busy: "Very busy right now",
  very_high: "Very busy right now",
};

// ── Canonical readers (each fail-soft: any error ⇒ null, never throws) ────────

/**
 * live_place — the current, gated live state of the object's place. Reuses the
 * canonical Live Intelligence read path, which is itself fully gated and
 * fail-closed, so a stale / below-floor / prediction claim never reaches here.
 */
async function readLivePlaceCandidate(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
): Promise<ContextThreadCandidate | null> {
  const place = projection.place;
  if (!place?.placeId) return null;
  const now = viewer.now ?? new Date();
  try {
    const envelopes = await readLiveClaimEnvelopes(sc, place.placeId, { now });
    const env = envelopes[0]; // best/current first
    if (!env) return null;
    const freshness = freshnessFromEnvelope(env, now);
    if (freshness === "stale") return null;
    const crowd = crowdLabel(env.value);
    const phrase = crowd ? CROWD_PHRASE[crowd] ?? `${crowd} right now` : "Live now";
    const confidence = typeof env.confidence === "number" ? env.confidence : 0;
    const duplicatesLiveStrip = viewer.liveStripSubjectIds?.has(place.placeId) ?? false;
    const action: WallAction = {
      type: "see_place",
      label: "See place",
      targetType: "place",
      targetId: place.placeId,
    };
    // A live, confident fact is highly useful; a merely-recent one less so.
    const expectedUtility = freshness === "live" ? 0.85 : 0.6;
    return {
      thread: {
        kind: "live_place",
        label: phrase,
        freshness,
        confidence,
        reason: "Live now",
        action,
      },
      gate: {
        viewerAuthorized: true, // the read path already applied privacy gates
        contextRelevant: true,
        confidence,
        freshnessAgeMs: ageMs(env.observedAt, now),
        sensitiveDisclosure: false,
        duplicatesLiveStrip,
        visualOverload: false,
        expectedUtility,
      },
    };
  } catch (err) {
    logger.warn({ err }, "contextThread: live_place read failed");
    return null;
  }
}

/**
 * trip_relevance — the viewer is heading to this place's city. Reads only the
 * viewer's OWN trips (owner_id = viewer), so nothing about anyone else leaks.
 */
async function readTripRelevanceCandidate(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
): Promise<ContextThreadCandidate | null> {
  const place = projection.place;
  if (!place?.city || !sc) return null;
  const now = viewer.now ?? new Date();
  try {
    const { data, error } = await sc
      .from("trips")
      .select("id, destination_city, destination_country, start_date, status")
      .eq("owner_id", viewer.viewerId)
      .in("status", ["planning", "upcoming", "active"])
      .limit(50);
    if (error || !Array.isArray(data)) return null;
    const wantCity = place.city.trim().toLowerCase();
    let best: { id: string; startMs: number | null; city: string } | null = null;
    for (const row of data as any[]) {
      const city = String(row.destination_city ?? "").trim().toLowerCase();
      if (!city || city !== wantCity) continue;
      const startMs = row.start_date ? Date.parse(String(row.start_date)) : NaN;
      const start = Number.isNaN(startMs) ? null : startMs;
      // Prefer the SOONEST upcoming trip (smallest non-negative days-until).
      if (!best) {
        best = { id: String(row.id), startMs: start, city: String(row.destination_city ?? place.city) };
      } else if (start != null && (best.startMs == null || start < best.startMs)) {
        best = { id: String(row.id), startMs: start, city: String(row.destination_city ?? place.city) };
      }
    }
    if (!best) return null;

    const cityName = best.city;
    let label: string;
    let expectedUtility: number;
    if (best.startMs != null) {
      const days = Math.round((best.startMs - now.getTime()) / (24 * 60 * 60 * 1000));
      if (days > 0) {
        label = `You're going to ${cityName} in ${days} day${days === 1 ? "" : "s"}`;
        // Sooner trips are more actionable; taper utility with distance in time.
        expectedUtility = days <= 14 ? 0.8 : days <= 45 ? 0.65 : 0.55;
      } else {
        // Trip is active / already started.
        label = `You're in ${cityName} on this trip`;
        expectedUtility = 0.75;
      }
    } else {
      label = `You have a trip to ${cityName}`;
      expectedUtility = 0.6;
    }
    const action: WallAction = {
      type: "add_to_trip",
      label: "Save to Trip",
      targetType: "trip",
      targetId: best.id,
      params: { placeId: place.placeId },
    };
    return {
      thread: {
        kind: "trip_relevance",
        label,
        // A structural fact about the viewer's own plan — always "fresh".
        freshness: "recent",
        confidence: 0.95,
        reason: "From your trips",
        action,
      },
      gate: {
        viewerAuthorized: true, // the viewer's own trip
        contextRelevant: true,
        confidence: 0.95,
        freshnessAgeMs: 0,
        sensitiveDisclosure: false,
        duplicatesLiveStrip: false,
        visualOverload: false,
        expectedUtility,
      },
    };
  } catch (err) {
    logger.warn({ err }, "contextThread: trip_relevance read failed");
    return null;
  }
}

/** Days a "were here recently" social-presence window looks back. */
const SOCIAL_PRESENCE_DAYS = 30;
/** Minimum distinct followed people before "people you follow were here" shows
 *  (a small k-anonymity floor so a single person's movement is never surfaced). */
const SOCIAL_PRESENCE_MIN = 2;

/**
 * social_presence — "N people you follow were here recently". Built ONLY from
 * PUBLIC posts those people themselves published at the place (a disclosure-safe
 * fact — they chose to post it publicly). Exact person location is never
 * inferred from a private signal (spec §23), and blocked users never appear
 * because the follow set already excludes them.
 */
async function readSocialPresenceCandidate(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
): Promise<ContextThreadCandidate | null> {
  const place = projection.place;
  const followed = viewer.followedCreatorIds;
  if (!place?.placeId || !sc || !followed || followed.size === 0) return null;
  const now = viewer.now ?? new Date();
  try {
    const cutoff = new Date(now.getTime() - SOCIAL_PRESENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sc
      .from("posts")
      .select("author_id, created_at")
      .eq("canonical_place_id", place.placeId)
      .eq("visibility", "public")
      .eq("status", "active")
      .in("author_id", [...followed].slice(0, 500))
      .gte("created_at", cutoff)
      .limit(200);
    if (error || !Array.isArray(data)) return null;
    const distinct = new Set<string>();
    let newestMs = 0;
    for (const row of data as any[]) {
      const a = String(row.author_id ?? "");
      // Exclude the viewer's own posts from "people you follow".
      if (!a || a === viewer.viewerId) continue;
      distinct.add(a);
      const t = Date.parse(String(row.created_at ?? ""));
      if (!Number.isNaN(t) && t > newestMs) newestMs = t;
    }
    const count = distinct.size;
    if (count < SOCIAL_PRESENCE_MIN) return null;
    const action: WallAction = {
      type: "see_who",
      label: "See who",
      targetType: "place",
      targetId: place.placeId,
    };
    // More corroborating friends ⇒ more useful, saturating quickly.
    const expectedUtility = Math.min(0.85, 0.5 + 0.12 * count);
    return {
      thread: {
        kind: "social_presence",
        label: `${count} ${count === 1 ? "person" : "people"} you follow ${
          count === 1 ? "was" : "were"
        } here recently`,
        freshness: "recent",
        confidence: 0.8,
        reason: "From people you follow",
        action,
      },
      gate: {
        viewerAuthorized: true, // the viewer follows them; content was public
        contextRelevant: true,
        confidence: 0.8,
        freshnessAgeMs: newestMs > 0 ? Math.max(0, now.getTime() - newestMs) : Number.POSITIVE_INFINITY,
        sensitiveDisclosure: false,
        duplicatesLiveStrip: false,
        visualOverload: false,
        expectedUtility,
      },
    };
  } catch (err) {
    logger.warn({ err }, "contextThread: social_presence read failed");
    return null;
  }
}

/** Gem sensitivity levels whose CONTEXT must not be disclosed to an
 *  unauthorized viewer (spec §20/§23). Public/approximate gems may show a coarse
 *  thread; protected / reveal-after-acceptance gems may not. */
const PROTECTED_GEM_SENSITIVITY: ReadonlySet<string> = new Set([
  "protected",
  "reveal_after_acceptance",
]);

const GEM_STATE_PHRASE: Record<string, string> = {
  recently_confirmed: "Hidden Gem · recently confirmed",
  still_hidden: "Hidden Gem · still under the radar",
  quiet_now: "Hidden Gem · quiet right now",
  getting_discovered: "Hidden Gem · getting discovered",
  seasonal: "Hidden Gem · seasonal",
  hard_to_find: "Hidden Gem · hard to find",
};

/**
 * hidden_gem — the object's place is a Hidden Gem. Derives the semantic state +
 * confidence from the canonical hiddenGemState layer, and applies the gem's
 * DISCLOSURE POLICY: a protected / reveal-after-acceptance gem produces a
 * candidate whose gate flag `sensitiveDisclosure` is set, so the §9 gate
 * suppresses it for an unauthorized viewer. Gem exposure is never optimized for
 * virality (spec §20): utility is capped and popularity is not a confidence
 * input (enforced inside hiddenGemState).
 */
async function readHiddenGemCandidate(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
): Promise<ContextThreadCandidate | null> {
  const place = projection.place;
  if (!place?.placeId || !sc) return null;
  const now = viewer.now ?? new Date();
  try {
    const { data, error } = await sc
      .from("hidden_gems")
      // hidden_gems has NO confirmation_count and NO days_since_last_confirmation
      // column, and never did. Naming them here failed the WHOLE read with
      // PGRST100, so `if (error || !data) return null` fired on every call and
      // this branch has never produced a candidate in production. The columns
      // below are each verified present in the live schema.
      //
      // The two derivations below still default those signals (`?? null`, `?? 0`).
      // To make them real, derive from `hidden_gem_verifications` (the
      // confirmations table) rather than adding denormalised counters here.
      .select(
        "id, sensitivity_level, verification_level, status, crowd_level, " +
          "save_count, visit_count, updated_at, canonical_place_id, " +
          "latitude, longitude, approx_latitude, approx_longitude, image_url",
      )
      .eq("canonical_place_id", place.placeId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as any;

    // Confirmations are an AGGREGATE, not a column: deriveGemProjection folds
    // hidden_gem_verifications and hidden_gem_contributions into the confirmation
    // count and the days-since-last-confirmation this state machine wants. The
    // two invented columns above were a denormalised shortcut to data that lives
    // in those two tables, and it never existed.
    //
    // Delegating also stops this being a second, weaker copy of the derivation.
    // The hand-rolled call it replaces passed four signals; the shared producer
    // passes eleven — distinct confirmers, suspicious-visit ratio, positive and
    // negative contributions, coords, media and paid-promotion all reach
    // deriveGemConfidence now, and hasCanonicalPlace is read from the row rather
    // than hardcoded true.
    //
    // Cost: three extra reads for one gem on this path. Worth stating plainly —
    // but the path it replaces performed one read that always failed, so this is
    // three queries where there were previously zero useful ones.
    const projection = await deriveGemProjection(sc, row, now.getTime());
    const state = projection.gemState;
    const confidence = projection.gemConfidence.score;

    const sensitivity = String(row.sensitivity_level ?? "public");
    const sensitiveDisclosure = PROTECTED_GEM_SENSITIVITY.has(sensitivity);

    const label = GEM_STATE_PHRASE[state] ?? "Hidden Gem";
    const action: WallAction = {
      type: "explore",
      label: "Explore",
      targetType: "place",
      targetId: place.placeId,
    };
    return {
      thread: {
        kind: "hidden_gem",
        label,
        freshness: state === "recently_confirmed" ? "recent" : "aging",
        confidence,
        reason: "Hidden Gem",
        action,
      },
      gate: {
        viewerAuthorized: !sensitiveDisclosure,
        contextRelevant: true,
        confidence,
        // Freshness of the gem's evidence (last update) — an ancient gem row is
        // aging context, not current.
        freshnessAgeMs: ageMs(row.updated_at ?? null, now),
        sensitiveDisclosure,
        duplicatesLiveStrip: false,
        visualOverload: false,
        // Capped — never optimize gem exposure for virality (spec §20).
        expectedUtility: state === "recently_confirmed" ? 0.6 : 0.5,
      },
    };
  } catch (err) {
    logger.warn({ err }, "contextThread: hidden_gem read failed");
    return null;
  }
}

/**
 * buddy — a Rent-a-Buddy is available in this place's AREA (city granularity
 * only, spec §19: never a precise Buddy coordinate). Behind
 * wall_rab_integration_enabled. Paid promotion cannot manufacture this thread —
 * it reads only the honest `available_now` availability flag.
 */
async function readBuddyCandidate(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
): Promise<ContextThreadCandidate | null> {
  if (!viewer.rabEnabled) return null;
  const place = projection.place;
  if (!place?.city || !sc) return null;
  try {
    const { data, error } = await sc
      .from("rent_buddy_profiles")
      .select("id, categories")
      .eq("status", "active")
      .eq("admin_status", "active")
      .eq("available_now", true)
      .eq("city", place.city)
      .limit(10);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    let nightlife = false;
    for (const row of data as any[]) {
      const cats: string[] = Array.isArray(row.categories) ? row.categories : [];
      if (cats.includes("nightlife")) nightlife = true;
    }
    const label = nightlife
      ? "Nightlife Buddy available in this area"
      : "Buddy available in this area";
    const action: WallAction = {
      type: "book_buddy",
      label: "See Buddy",
      targetType: "place",
      targetId: place.placeId,
      // City-level only — NEVER a precise coordinate (spec §19).
      params: { area: place.city },
    };
    return {
      thread: {
        kind: "buddy",
        label,
        freshness: "live", // available_now is a current flag
        confidence: 0.7,
        reason: "Rent a Buddy",
        action,
      },
      gate: {
        viewerAuthorized: true,
        contextRelevant: true,
        confidence: 0.7,
        freshnessAgeMs: 0,
        sensitiveDisclosure: false,
        duplicatesLiveStrip: false,
        visualOverload: false,
        // The lowest-priority contextual option; only shows when nothing more
        // decision-relevant is present, and never a flood.
        expectedUtility: 0.5,
      },
    };
  } catch (err) {
    logger.warn({ err }, "contextThread: buddy read failed");
    return null;
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Gather + select the single most useful Context Thread for one projection, or
 * undefined — WITHOUT the feature-flag check (the caller is responsible for
 * gating). Gathers candidate facts from the canonical systems fail-soft (in
 * parallel), then the pure §9 gate picks at most one. Never throws.
 *
 * Used by attachContextThreads (WallProjectionService), which reads the flag
 * ONCE per request rather than once per item.
 */
export async function gatherContextThread(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
  policy: ContextThreadPolicy = DEFAULT_CONTEXT_THREAD_POLICY,
): Promise<ContextThread | undefined> {
  if (!sc) return undefined;
  // An object with no place cannot carry any of the place-anchored threads and
  // the surface has no non-place threads yet, so short-circuit before any read.
  if (!projection.place?.placeId) return undefined;

  const settled = await Promise.allSettled([
    readLivePlaceCandidate(sc, projection, viewer),
    readTripRelevanceCandidate(sc, projection, viewer),
    readSocialPresenceCandidate(sc, projection, viewer),
    readHiddenGemCandidate(sc, projection, viewer),
    readBuddyCandidate(sc, projection, viewer),
  ]);
  const candidates: ContextThreadCandidate[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) candidates.push(r.value);
  }
  return selectContextThread(candidates, policy, { windowSaturated: viewer.windowSaturated });
}

/**
 * Build the single most useful Context Thread for one projection, or undefined.
 *
 * Behind wall_context_threads_enabled (fail-closed). Thin wrapper over
 * gatherContextThread that adds the per-call flag gate — convenient for callers
 * (and tests) that build a thread for a single object. Never throws.
 */
export async function buildContextThread(
  sc: any,
  projection: WallProjection,
  viewer: ContextThreadViewerContext,
  policy: ContextThreadPolicy = DEFAULT_CONTEXT_THREAD_POLICY,
): Promise<ContextThread | undefined> {
  if (!sc) return undefined;
  try {
    if (!(await isFlagEnabled(sc, "wall_context_threads_enabled"))) return undefined;
  } catch {
    return undefined; // fail-closed
  }
  return gatherContextThread(sc, projection, viewer, policy);
}

// Test seam — the pure decision helpers, exercised directly by the gate tests.
export const _internal = {
  freshnessFromEnvelope,
  crowdLabel,
  ageMs,
  readLivePlaceCandidate,
  readTripRelevanceCandidate,
  readSocialPresenceCandidate,
  readHiddenGemCandidate,
  readBuddyCandidate,
  PROTECTED_GEM_SENSITIVITY,
};
