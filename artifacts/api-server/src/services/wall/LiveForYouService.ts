/**
 * LiveForYouService — the small, bounded, personalized live strip (spec §4).
 *
 * OWNS: the small personalized live strip. DOES NOT OWN: the underlying live
 * claims (those belong to Live Intelligence; this service only reads the
 * canonical projection through lib/liveClaimRead.ts).
 *
 * Live For You is NOT the feed (spec §4). It answers "is anything happening right
 * now that is unusually relevant to me?" with normally 2–4 items. The hard rules
 * (spec §4) are enforced structurally here:
 *
 *   • No generic city-wide firehose — the strip reads ONLY the viewer-relevant
 *     candidate subjects the caller supplies (saved places, trip stops, places
 *     from the feed the viewer is close to). It never enumerates a city.
 *   • No stale live labels — every claim comes from readLiveClaimEnvelopes, which
 *     drops anything expired, below the live floor, or not privacy-eligible, and
 *     returns [] whenever Live intelligence is not servable at all. A stale claim
 *     therefore simply does not appear (fail-closed; spec §31/§34).
 *   • No exact private-location leakage — envelopes carry decision-exposure
 *     fields only (no coordinates, contributor ids, or exact cohort counts).
 *   • No paid placement masquerading as live — the read path's source-class
 *     truth boundary already forbids that (spec §19/§21).
 *   • Deduplicate against the feed — a subject already shown as a feed object /
 *     context thread is NOT repeated in the strip (spec §4 / §15 liveStrip dedup).
 *
 * The strip refreshes independently of feed pagination (spec §28) and may be
 * ignored entirely — normal scrolling never depends on it.
 */
import {
  readLiveClaimEnvelopes,
  type LiveClaimEnvelope,
} from "../../lib/liveClaimRead.js";
import { deriveGemProjection } from "../hiddenGems/HiddenGemContributionService.js";
import { logger } from "../../lib/logger.js";
import type {
  FreshnessState,
  LiveForYouItem,
  LiveObjectType,
  PublicPlaceRef,
  WallAction,
} from "../../lib/wallProjection.js";

/** Absolute ceiling on strip size (spec §4: "normally 2–4 items"). */
export const MAX_LIVE_FOR_YOU = 4;

/** How many candidate subjects we will probe at most — a hard bound that keeps
 *  this a personalized strip and not a scan (spec §4: no firehose). */
const MAX_SUBJECT_PROBES = 16;

/** How many feed places a producer will read across — a hard bound so the strip
 *  producers stay a personalized read, never a city scan (spec §4). */
const MAX_PRODUCER_PLACES = 12;
/** The same k-anonymity floor ContextThreadService applies to social presence:
 *  never surface a single followed person's movement (spec §23). */
const SOCIAL_PRESENCE_MIN = 2;
const SOCIAL_PRESENCE_DAYS = 30;
/** Gem sensitivity levels whose current state must NOT appear in the strip for an
 *  ordinary viewer (spec §20/§23) — only public/approximate gems may. */
const PROTECTED_GEM_SENSITIVITY: ReadonlySet<string> = new Set(["protected", "reveal_after_acceptance"]);
/** Coarse freshness windows for the resolved (non-intel) kinds. */
const GEM_FRESH_MS = 3 * 24 * 60 * 60 * 1000; // a confirmed gem stays "fresh" ~3d
const BUDDY_AVAILABILITY_MS = 30 * 60 * 1000; // `available_now` is a right-now flag

const GEM_STATE_PHRASE: Record<string, string> = {
  recently_confirmed: "Hidden Gem · recently confirmed",
  quiet_now: "Hidden Gem · quiet right now",
  getting_discovered: "Hidden Gem · getting discovered",
};

/**
 * A live fact for a strip kind that does NOT come from the intel crowd-claim
 * projection (hidden_gem / social_presence / buddy / event_state / trip_signal).
 * The producer has already read + gated it against its own canonical system, so
 * buildLiveForYou uses it directly instead of reading an intel envelope. Carries
 * only decision-exposure fields — never a coordinate, contributor id or exact
 * count (spec §4/§23). `validUntil` in the past is treated as stale and dropped.
 */
export interface ResolvedLiveFact {
  /** Provenance id the "why" surface points at (the source row / snapshot). */
  id: string;
  label: string;
  /** 'live' only when the source qualifies; otherwise 'emerging'. */
  state: "live" | "emerging";
  confidence?: number | null;
  observedAt: string;
  /** Freshness horizon — past ⇒ the fact is stale and never shown. */
  validUntil: string;
  conflictState?: "none" | "minor" | "material";
}

export interface LiveForYouCandidate {
  /** Canonical subject (place/zone) id the live claim is about. */
  subjectId: string;
  liveObjectType: LiveObjectType;
  subject?: PublicPlaceRef;
  /**
   * A pre-resolved live fact for the non-intel kinds. When present the strip uses
   * it directly (no intel read); when absent (place_state / event_state sourced
   * from the projection) buildLiveForYou reads the canonical Live Intelligence
   * envelope for `subjectId` as before.
   */
  resolved?: ResolvedLiveFact;
}

export interface BuildLiveForYouOptions {
  /** Requested max (clamped to 1..MAX_LIVE_FOR_YOU). Default MAX_LIVE_FOR_YOU. */
  limit?: number;
  /** Subject ids already represented in the feed / context threads — skipped. */
  dedupeSubjectIds?: Set<string>;
  /** Restrict to specific claim types (e.g. ["crowd.level"]). */
  claimTypes?: readonly string[];
  now?: Date;
}

/** Map the read path's live state to the Wall freshness state. */
function freshnessFor(env: LiveClaimEnvelope, now: Date): FreshnessState {
  const valid = Date.parse(env.validUntil);
  if (!Number.isNaN(valid) && valid <= now.getTime()) return "stale";
  return env.state === "live" ? "live" : "recent";
}

/** A short, privacy-safe label. Combines the subject name with a string claim
 *  value when one is present ("An Thuong · busy"); never emits coordinates. */
function labelFor(cand: LiveForYouCandidate, env: LiveClaimEnvelope): string {
  const name = cand.subject?.name ?? "Nearby";
  const v = env.value as unknown;
  const valueStr =
    typeof v === "string"
      ? v
      : v && typeof v === "object" && typeof (v as any).level === "string"
        ? (v as any).level
        : null;
  return valueStr ? `${name} · ${valueStr}` : name;
}

/** The single tap action for a live item, by kind (spec §4/§8). */
function actionFor(cand: LiveForYouCandidate): WallAction | undefined {
  switch (cand.liveObjectType) {
    case "place_state":
    case "event_state":
      return { type: "see_place", label: "See place", targetType: "place", targetId: cand.subjectId };
    case "hidden_gem":
      return { type: "explore", label: "Explore", targetType: "place", targetId: cand.subjectId };
    case "social_presence":
      return { type: "see_who", label: "See who", targetType: "place", targetId: cand.subjectId };
    case "buddy":
      return { type: "book_buddy", label: "See Buddy", targetType: "place", targetId: cand.subjectId };
    case "trip_signal":
      return { type: "open_map", label: "See on map", targetType: "place", targetId: cand.subjectId };
    default:
      return undefined;
  }
}

/**
 * Build the Live For You strip for a viewer from a bounded set of relevant
 * candidate subjects. Returns 0..limit items (limit ≤ 4). Never throws; any read
 * failure yields fewer/zero items rather than an error, so the feed renders
 * regardless (spec §34 / TABLE 5: Live Intelligence unavailable ⇒ degrade the
 * strip, social feed stays normal).
 */
export async function buildLiveForYou(
  sc: any,
  candidates: LiveForYouCandidate[],
  opts: BuildLiveForYouOptions = {},
): Promise<LiveForYouItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_LIVE_FOR_YOU, MAX_LIVE_FOR_YOU));
  const now = opts.now ?? new Date();
  const dedupe = opts.dedupeSubjectIds ?? new Set<string>();

  // De-duplicate candidate subjects, drop any already shown in the feed, and cap
  // the probe count so this is a personalized strip, never a city scan. When two
  // candidates describe the SAME subject (e.g. a place that is both a feed place
  // and a Hidden Gem), a candidate carrying a pre-RESOLVED fact wins over a bare
  // place_state one: a known fact beats a speculative intel read for that slot.
  const probeBySubject = new Map<string, LiveForYouCandidate>();
  for (const c of candidates) {
    if (!c.subjectId || dedupe.has(c.subjectId)) continue;
    const existing = probeBySubject.get(c.subjectId);
    if (!existing) {
      if (probeBySubject.size >= MAX_SUBJECT_PROBES) continue;
      probeBySubject.set(c.subjectId, c);
    } else if (c.resolved && !existing.resolved) {
      probeBySubject.set(c.subjectId, c); // prefer the resolved fact, keep position
    }
  }
  const probe = [...probeBySubject.values()];
  if (probe.length === 0) return [];

  // Read intel envelopes ONLY for the intel-sourced (unresolved) subjects, in
  // parallel; resolved candidates carry their own fact and need no read.
  const envelopesPerSubject = await Promise.all(
    probe.map((c) =>
      c.resolved
        ? Promise.resolve([] as LiveClaimEnvelope[])
        : readLiveClaimEnvelopes(sc, c.subjectId, { claimTypes: opts.claimTypes, now }).catch(
            () => [] as LiveClaimEnvelope[],
          ),
    ),
  );

  // Assemble in candidate order (deterministic), taking the best/current fact per
  // subject, until we hit the strip bound.
  const out: LiveForYouItem[] = [];
  for (let i = 0; i < probe.length && out.length < limit; i++) {
    const cand = probe[i];
    if (cand.resolved) {
      const r = cand.resolved;
      // A resolved fact whose horizon has passed is stale and never shown (§4:
      // no stale live labels) — the same rule the intel read enforces.
      const validMs = Date.parse(r.validUntil);
      if (!Number.isNaN(validMs) && validMs <= now.getTime()) continue;
      out.push({
        id: r.id,
        liveObjectType: cand.liveObjectType,
        subjectId: cand.subjectId,
        subject: cand.subject,
        label: r.label,
        freshness: r.state === "live" ? "live" : "recent",
        confidence: r.confidence ?? null,
        state: r.state,
        conflictState: r.conflictState ?? "none",
        observedAt: r.observedAt,
        validUntil: r.validUntil,
        action: actionFor(cand),
      });
      continue;
    }
    const env = envelopesPerSubject[i][0]; // read path returns best/current first
    if (!env) continue;
    const freshness = freshnessFor(env, now);
    if (freshness === "stale") continue; // belt-and-braces; read path already drops expired
    out.push({
      id: env.id,
      liveObjectType: cand.liveObjectType,
      subjectId: cand.subjectId,
      subject: cand.subject,
      label: labelFor(cand, env),
      freshness,
      confidence: env.confidence,
      state: env.state === "live" ? "live" : "emerging",
      // §10: carried so the strip can say "Reports differ" where it would have
      // said Live/Emerging. The read path already capped state under 'material'.
      conflictState: env.conflictState,
      observedAt: env.observedAt,
      validUntil: env.validUntil,
      action: actionFor(cand),
    });
  }
  return out;
}

// ── Strip producers for the non-intel kinds (spec §4 / TABLE 0) ──────────────
//
// place_state (and event_state) come from the intel projection through
// buildLiveForYou's envelope read. The remaining kinds come from their own
// canonical systems; each producer reads + gates a fact and returns a candidate
// carrying a RESOLVED fact, so LiveForYouService.actionFor's per-kind mapping
// binds and the strip is genuinely multi-kind. Every producer is fail-soft:
// any read failure yields fewer/zero candidates, never an error (spec §34).

/** Distinct feed places, bounded, in first-seen order. */
function boundedPlaces(placeRefs: PublicPlaceRef[]): PublicPlaceRef[] {
  const seen = new Set<string>();
  const out: PublicPlaceRef[] = [];
  for (const p of placeRefs) {
    if (!p?.placeId || seen.has(p.placeId)) continue;
    seen.add(p.placeId);
    out.push(p);
    if (out.length >= MAX_PRODUCER_PLACES) break;
  }
  return out;
}

/**
 * hidden_gem strip items (spec §20 / TABLE 0). A place among the feed's places
 * that is a qualified, public/approximate Hidden Gem in a fresh state. Protected
 * / reveal-after-acceptance gems are never surfaced; state + confidence come from
 * the canonical hiddenGemState derivation (deriveGemProjection), not re-derived
 * here, and exposure is never optimized for virality.
 */
export async function buildGemLiveCandidates(
  sc: any,
  placeRefs: PublicPlaceRef[],
  opts: { now?: Date } = {},
): Promise<LiveForYouCandidate[]> {
  const places = boundedPlaces(placeRefs);
  if (!sc || places.length === 0) return [];
  const now = opts.now ?? new Date();
  const byPlace = new Map(places.map((p) => [p.placeId, p]));
  try {
    const { data, error } = await sc
      .from("hidden_gems")
      .select(
        "id, canonical_place_id, sensitivity_level, verification_level, status, crowd_level, " +
          "save_count, visit_count, updated_at, latitude, longitude, approx_latitude, approx_longitude, image_url",
      )
      .in("canonical_place_id", [...byPlace.keys()])
      .eq("status", "active");
    if (error || !Array.isArray(data)) return [];
    const out: LiveForYouCandidate[] = [];
    for (const row of data as any[]) {
      const placeId = row.canonical_place_id ? String(row.canonical_place_id) : null;
      const subject = placeId ? byPlace.get(placeId) : undefined;
      if (!placeId || !subject) continue;
      if (PROTECTED_GEM_SENSITIVITY.has(String(row.sensitivity_level ?? "public"))) continue; // §20
      const projection = await deriveGemProjection(sc, row, now.getTime());
      const phrase = GEM_STATE_PHRASE[projection.gemState];
      // §20: current gem state appears ONLY when fresh + qualified — the strip
      // shows only the confirmed/discovering states, never "still_hidden" etc.
      if (!phrase) continue;
      const updatedMs = Date.parse(String(row.updated_at ?? ""));
      const observedAt = Number.isNaN(updatedMs) ? now.toISOString() : new Date(updatedMs).toISOString();
      out.push({
        subjectId: placeId,
        liveObjectType: "hidden_gem",
        subject,
        resolved: {
          id: `gem-${row.id}`,
          label: subject.name ? `${subject.name} · ${phrase}` : phrase,
          state: "emerging", // a gem is never a live crowd claim
          confidence: projection.gemConfidence.score,
          observedAt,
          validUntil: new Date((Number.isNaN(updatedMs) ? now.getTime() : updatedMs) + GEM_FRESH_MS).toISOString(),
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveForYou: gem producer failed — no gem strip items");
    return [];
  }
}

/**
 * social_presence strip items (spec §23 / TABLE 0). "N people you follow were
 * here recently" from PUBLIC, published posts those followed people themselves
 * posted at the place — a disclosure-safe fact. Applies the SAME k-anonymity
 * floor as ContextThreadService (never a single person's movement), and counts
 * only published posts so a pending delayed-geotag post never reveals presence.
 */
export async function buildSocialPresenceLiveCandidates(
  sc: any,
  viewerId: string,
  followedCreatorIds: Set<string>,
  placeRefs: PublicPlaceRef[],
  opts: { now?: Date } = {},
): Promise<LiveForYouCandidate[]> {
  const places = boundedPlaces(placeRefs);
  if (!sc || places.length === 0 || !followedCreatorIds || followedCreatorIds.size === 0) return [];
  const now = opts.now ?? new Date();
  const byPlace = new Map(places.map((p) => [p.placeId, p]));
  try {
    const cutoff = new Date(now.getTime() - SOCIAL_PRESENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sc
      .from("posts")
      .select("author_id, canonical_place_id, created_at")
      .in("canonical_place_id", [...byPlace.keys()])
      .eq("visibility", "public")
      .eq("status", "active")
      .eq("post_status", "published")
      .in("author_id", [...followedCreatorIds].slice(0, 500))
      .gte("created_at", cutoff)
      .limit(500);
    if (error || !Array.isArray(data)) return [];
    // distinct followed authors per place + newest post per place.
    const distinctByPlace = new Map<string, Set<string>>();
    const newestByPlace = new Map<string, number>();
    for (const row of data as any[]) {
      const placeId = row.canonical_place_id ? String(row.canonical_place_id) : null;
      const author = row.author_id ? String(row.author_id) : "";
      if (!placeId || !author || author === viewerId || !byPlace.has(placeId)) continue;
      (distinctByPlace.get(placeId) ?? distinctByPlace.set(placeId, new Set()).get(placeId)!).add(author);
      const t = Date.parse(String(row.created_at ?? ""));
      if (!Number.isNaN(t)) newestByPlace.set(placeId, Math.max(newestByPlace.get(placeId) ?? 0, t));
    }
    const out: LiveForYouCandidate[] = [];
    for (const [placeId, authors] of distinctByPlace) {
      const count = authors.size;
      if (count < SOCIAL_PRESENCE_MIN) continue; // k-anonymity floor
      const subject = byPlace.get(placeId)!;
      const newest = newestByPlace.get(placeId) ?? now.getTime();
      out.push({
        subjectId: placeId,
        liveObjectType: "social_presence",
        subject,
        resolved: {
          id: `sp-${placeId}`,
          label: `${count} ${count === 1 ? "person" : "people"} you follow ${count === 1 ? "was" : "were"} here recently`,
          state: "emerging",
          confidence: 0.8,
          observedAt: new Date(newest).toISOString(),
          validUntil: new Date(newest + SOCIAL_PRESENCE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveForYou: social presence producer failed — no presence strip items");
    return [];
  }
}

/**
 * buddy strip items (spec §19 / TABLE 0). A Rent-a-Buddy available now in the
 * place's AREA (city granularity only — never a precise Buddy coordinate).
 * Behind the RAB flag (the caller passes `rabEnabled`); reads only the honest
 * `available_now` flag, so paid promotion cannot manufacture a strip item.
 */
export async function buildBuddyLiveCandidates(
  sc: any,
  placeRefs: PublicPlaceRef[],
  opts: { rabEnabled: boolean; now?: Date },
): Promise<LiveForYouCandidate[]> {
  if (!opts.rabEnabled) return [];
  const places = boundedPlaces(placeRefs);
  if (!sc || places.length === 0) return [];
  const now = opts.now ?? new Date();
  // City → the feed place(s) in that city (buddy availability is city-scoped).
  const cities = new Map<string, PublicPlaceRef>();
  for (const p of places) if (p.city && !cities.has(p.city)) cities.set(p.city, p);
  if (cities.size === 0) return [];
  try {
    const { data, error } = await sc
      .from("rent_buddy_profiles")
      .select("id, city, categories")
      .eq("status", "active")
      .eq("admin_status", "active")
      .eq("available_now", true)
      .in("city", [...cities.keys()])
      .limit(50);
    if (error || !Array.isArray(data)) return [];
    const nightlifeByCity = new Map<string, boolean>();
    const seenCity = new Set<string>();
    for (const row of data as any[]) {
      const city = row.city ? String(row.city) : "";
      if (!city || !cities.has(city)) continue;
      seenCity.add(city);
      const cats: string[] = Array.isArray(row.categories) ? row.categories : [];
      if (cats.includes("nightlife")) nightlifeByCity.set(city, true);
    }
    const out: LiveForYouCandidate[] = [];
    for (const city of seenCity) {
      const subject = cities.get(city)!;
      out.push({
        subjectId: subject.placeId,
        liveObjectType: "buddy",
        subject,
        resolved: {
          id: `buddy-${subject.placeId}`,
          label: nightlifeByCity.get(city) ? "Nightlife Buddy around" : "Buddy around",
          state: "emerging",
          confidence: 0.7,
          observedAt: now.toISOString(),
          validUntil: new Date(now.getTime() + BUDDY_AVAILABILITY_MS).toISOString(),
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveForYou: buddy producer failed — no buddy strip items");
    return [];
  }
}
