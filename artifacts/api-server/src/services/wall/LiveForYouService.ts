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
import { fetchBlockedSet } from "../../lib/blocks.js";
// The ONE privacy-complete events reader (visibility + friendship + eligibility
// + block set + show_exact_location redaction). routes/mapProjection.ts and
// routes/mapProjectionTemporal.ts already consume it the same way; the Wall
// strip must NOT grow a second events gate of its own (spec §22: "The Wall must
// not implement a second place-state system").
import { loadNearbyEvents } from "../../routes/mapSearch.js";
// The canonical event-timing derivation (ongoing / upcoming / ended) and the
// canonical assumed duration, shared with the Map's §10 inferred-cause producer
// so the two surfaces cannot disagree about when an event is on.
import {
  eventPhaseAt,
  causeTitle,
  EVENT_CAUSE_DEFAULT_DURATION_MINUTES,
  EVENT_CAUSE_UPCOMING_MINUTES,
  type EventContextLike,
} from "../../lib/mapProducers/eventContextProducer.js";
// The canonical trip-plan-item expiry (ends_at, else starts_at + grace), shared
// with the Map's meeting-point producer for the same reason.
import { meetingPointExpiryMs } from "../../lib/mapProducers/meetingPointProducer.js";
import { haversineMeters } from "../../lib/protectedLocations.js";
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
// place_state comes from the intel projection through buildLiveForYou's envelope
// read. Every OTHER kind comes from its own canonical system; each producer
// reads + gates a fact and returns a candidate carrying a RESOLVED fact, so
// LiveForYouService.actionFor's per-kind mapping binds and the strip is
// genuinely multi-kind. Every producer is fail-soft: any read failure yields
// fewer/zero candidates, never an error (spec §34).
//
// THE §37 TRUTH BOUNDARY AND `state: "live"`
// ==========================================
// Only the intel projection can put "Live now" on the strip. A SCHEDULE — an
// event's start/end, a trip plan item's start/end — is a record of what someone
// INTENDS, not an observation of conditions at the place. lib/mapProducers/
// meetingPointProducer records the same ruling for the Map ("A plan is not an
// observation of conditions at the place: no observedAt, no freshness, no
// confidence"). So the schedule-derived kinds below are ALWAYS `state:
// "emerging"` (the client renders "Emerging", never "Live now") and always
// carry `confidence: null` — a schedule has no confidence score to badge, and
// inventing one would be a fabricated number in a decision surface.
//
// For the same reason neither producer ever emits a crowd/capacity phrase.
// TABLE 0's illustrative "Beach Festival · Peak now" is a CROWD claim: crowd
// state belongs to Live Intelligence (§22 — the Wall does not implement a second
// place-state system), and `events.going_count` is a cached counter that
// routes/events.ts already recomputes because it drifts, so it is not a fact
// this strip may assert.

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

// ── event_state (spec §4 / TABLE 0: "Event state · time-valid and relevant") ──

/** How many feed places the event producer probes. Deliberately far smaller
 *  than MAX_PRODUCER_PLACES: each probe is a spatial read whose per-row privacy
 *  pass costs several more reads, and the strip only ever shows four items.
 *  This bound and EVENT_PROBE_LIMIT together cap the first page's event cost
 *  (spec TABLE 4: < 500 ms backend). */
export const MAX_EVENT_PROBE_PLACES = 2;
/** Bounding radius handed to loadNearbyEvents. Small on purpose — the strip
 *  wants events AT the place the viewer is already looking at, not a city
 *  listing (spec §4: no generic city-wide firehose). */
export const EVENT_PROBE_RADIUS_KM = 1;
/** Rows one probe may consider. The strip keeps at most one per place. */
export const EVENT_PROBE_LIMIT = 8;
/** How close an event must actually be to count as "at" this place. */
export const EVENT_AT_PLACE_METERS = 400;

type EventPhase = "ongoing" | "upcoming";

function finiteCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The public venue coordinate of each of these canonical places, read from the
 * `places` table — used ONLY to bound a spatial probe, never emitted.
 *
 * WHY THIS READ EXISTS AT ALL. routes/wall.ts builds its PublicPlaceRefs from
 * `id, name, city, country_code` and deliberately omits the coordinate: "the
 * feed never needs a venue coordinate, and omitting it removes any risk of a
 * coarse/protected place leaking one" (spec §23). That ruling stands — the
 * strip item's `subject` is still that coordinate-free ref. But "is an event on
 * AT this place" is a spatial question, and answering it with a city name would
 * be the city-wide firehose §4 forbids. So the coordinate is resolved here,
 * used to bound the probe, and dropped: it never enters a LiveForYouItem, a
 * label, or an action.
 *
 * Merged and non-active places are skipped — the same predicate the Map's
 * canonical place read applies, so the Wall cannot anchor on a place the Map
 * would not serve.
 */
async function loadPlaceAnchors(
  sc: any,
  placeIds: string[],
): Promise<Map<string, { lat: number; lng: number }>> {
  const out = new Map<string, { lat: number; lng: number }>();
  if (placeIds.length === 0) return out;
  const { data, error } = await sc
    .from("places")
    .select("id, latitude, longitude, status, merged_into_place_id")
    .in("id", placeIds)
    .eq("status", "active")
    .is("merged_into_place_id", null);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as any[]) {
    const id = row?.id ? String(row.id) : "";
    const lat = row?.latitude;
    const lng = row?.longitude;
    if (!id || !finiteCoord(lat) || !finiteCoord(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.set(id, { lat, lng });
  }
  return out;
}

/** The instant an event stops being on: `ends_at` when it is after the start,
 *  else the canonical assumed duration the Map's §10 producer uses. */
function eventEndMs(ev: EventContextLike, startMs: number): number {
  const end = Date.parse(String(ev.ends_at ?? ""));
  if (!Number.isNaN(end) && end > startMs) return end;
  return startMs + EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000;
}

/**
 * event_state strip items (spec §4 / TABLE 0). An event that is ON NOW, or
 * starts within the canonical upcoming window, AT one of the feed's places.
 *
 * WHERE THE TRUTH COMES FROM
 * ==========================
 * `loadNearbyEvents` — the same privacy-complete reader the Map gateway uses. It
 * applies event visibility, the friends-only friendship check, per-event
 * eligibility (age / trust / verified-only) and the viewer's block set, and it
 * NULLS the coordinates of an event whose host hid its exact location. Nothing
 * here re-decides any of that; an event this viewer could not already see never
 * reaches the strip. Timing is `eventPhaseAt`, the Map's own derivation, so the
 * two surfaces cannot disagree about whether an event is on.
 *
 * An event with no usable coordinate (including one redacted by the reader) is
 * SKIPPED, never approximated — the same rule eventContextProducer records: no
 * coordinate, no adjacency. An `ended` event is not a live state and is dropped.
 *
 * Blocks fail CLOSED: an unreadable block set is not an empty one, so a failed
 * `fetchBlockedSet` yields no event items at all rather than unfiltered ones.
 */
export async function buildEventStateLiveCandidates(
  sc: any,
  viewerId: string,
  placeRefs: PublicPlaceRef[],
  opts: { now?: Date } = {},
): Promise<LiveForYouCandidate[]> {
  if (!sc || !viewerId) return [];
  const probe = boundedPlaces(placeRefs).slice(0, MAX_EVENT_PROBE_PLACES);
  if (probe.length === 0) return [];
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  try {
    const blockedSet = await fetchBlockedSet(sc, viewerId);
    if (blockedSet === null) return []; // fail-closed (§23)
    const anchors = await loadPlaceAnchors(sc, probe.map((p) => p.placeId));
    // A place with no public venue coordinate cannot be probed spatially, and is
    // never approximated (the rule eventContextProducer records for events).
    const places = probe.filter((p) => anchors.has(p.placeId));
    if (places.length === 0) return [];
    // Narrow the candidate rows to what could be on or about to start, so the
    // reader's per-row privacy pass runs over a handful of rows instead of 60.
    // The bounds are a SUPERSET of what eventPhaseAt accepts, never a mirror of
    // it: eventPhaseAt takes `ongoing` while the end is ahead, `upcoming` up to
    // EVENT_CAUSE_UPCOMING_MINUTES out, and assumes
    // EVENT_CAUSE_DEFAULT_DURATION_MINUTES whenever the recorded end is missing
    // OR not after the start. The window is stated in exactly those two constants
    // and is deliberately wider than the derivation at the edges (see
    // NearbyEventsWindow), so narrowing can only ever cost a wasted row — never a
    // candidate the per-row pass would have kept.
    const window = {
      nowIso: now.toISOString(),
      startsBeforeIso: new Date(nowMs + EVENT_CAUSE_UPCOMING_MINUTES * 60_000).toISOString(),
      openEndedStartsAfterIso: new Date(
        nowMs - EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000,
      ).toISOString(),
    };
    const perPlace = await Promise.all(
      places.map((p) => {
        const anchor = anchors.get(p.placeId)!;
        return loadNearbyEvents(
          sc,
          viewerId,
          anchor.lat,
          anchor.lng,
          EVENT_PROBE_RADIUS_KM,
          blockedSet,
          { window, limit: EVENT_PROBE_LIMIT },
        ).catch(() => null);
      }),
    );
    const out: LiveForYouCandidate[] = [];
    for (let i = 0; i < places.length; i++) {
      const place = places[i];
      const anchor = anchors.get(place.placeId)!;
      const events = perPlace[i];
      // null ⇒ the read FAILED. An unreadable neighbourhood is not an empty one:
      // say nothing about this place rather than claim there is nothing on.
      if (!Array.isArray(events)) continue;

      let best: { ev: EventContextLike; phase: EventPhase; minutes: number } | null = null;
      for (const raw of events as EventContextLike[]) {
        if (!raw || typeof raw.id !== "string" || raw.id === "") continue;
        const lat = raw.location_lat;
        const lng = raw.location_lng;
        if (!finiteCoord(lat) || !finiteCoord(lng)) continue; // redacted / unplaced
        const away = haversineMeters(anchor.lat, anchor.lng, lat, lng);
        if (!(away <= EVENT_AT_PLACE_METERS)) continue;
        const timing = eventPhaseAt(raw, nowMs);
        if (!timing || timing.phase === "ended") continue;
        const phase = timing.phase as EventPhase;
        // Deterministic: ongoing beats upcoming; then the closest in time; then
        // the event id — so the same world always yields the same strip item.
        if (
          !best ||
          (best.phase !== "ongoing" && phase === "ongoing") ||
          (best.phase === phase && timing.minutes < best.minutes) ||
          (best.phase === phase && timing.minutes === best.minutes && raw.id < best.ev.id)
        ) {
          best = { ev: raw, phase, minutes: timing.minutes };
        }
      }
      if (!best) continue;

      const startMs = Date.parse(String(best.ev.starts_at ?? ""));
      if (Number.isNaN(startMs)) continue; // eventPhaseAt guarantees this, belt-and-braces
      const title = causeTitle(best.ev.title);
      const label =
        best.phase === "ongoing"
          ? `${title} · happening now`
          : `${title} · starts in ${best.minutes} min`;
      out.push({
        subjectId: place.placeId,
        liveObjectType: "event_state",
        subject: place,
        resolved: {
          id: `event-${best.ev.id}`,
          label,
          // Schedule, not observation — never "live" (see the §37 note above).
          state: "emerging",
          confidence: null,
          // A schedule has no observation instant; record the read instant, the
          // same thing the buddy producer does for an availability flag.
          observedAt: now.toISOString(),
          // Once it starts, "starts in N min" is wrong; once it ends, "happening
          // now" is wrong. Either way the item ages out on the event's OWN clock.
          validUntil: new Date(
            best.phase === "ongoing" ? eventEndMs(best.ev, startMs) : startMs,
          ).toISOString(),
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveForYou: event producer failed — no event strip items");
    return [];
  }
}

// ── trip_signal (spec §4 / TABLE 0: "Crew gathering near saved stop") ─────────

/** Trips probed at once. A viewer with more than this many live trips still
 *  gets a bounded read (spec §4: personalized strip, never a scan). */
export const MAX_TRIP_SIGNAL_TRIPS = 20;
/** Plan items read at once across those trips. */
const MAX_TRIP_PLAN_ITEMS = 100;
/** How far a milestone may be from the saved stop and still be "near" it. */
export const TRIP_SIGNAL_NEAR_METERS = 2000;
/** How far ahead a milestone counts as a live signal. */
export const TRIP_SIGNAL_UPCOMING_MINUTES = 120;
/**
 * The trip_plan_items.visibility values a trip MEMBER may be shown. 0010 defines
 * the column as `NOT NULL DEFAULT 'members'` and routes/trips.ts' write schema
 * never sets anything else, so this is the whole current domain — an unknown
 * future value is withheld rather than guessed (fail-closed, §23).
 */
export const TRIP_SIGNAL_PLAN_VISIBILITY: ReadonlySet<string> = new Set(["members"]);

interface TripPlanItemRow {
  id: string;
  trip_id: string;
  title?: string | null;
  category?: string | null;
  status?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  lat?: number | null;
  lng?: number | null;
  location_is_private?: boolean | null;
  removed_at?: string | null;
  visibility?: string | null;
}

/**
 * trip_signal strip items (spec §4 / TABLE 0). A milestone on a trip the VIEWER
 * belongs to that is happening now (or starts within TRIP_SIGNAL_UPCOMING_MINUTES)
 * near a stop that trip has saved — and that stop is a place already in the
 * viewer's feed, so the item is anchored on something they are looking at.
 *
 * TRIP-SCOPED AUTHORIZATION
 * =========================
 * `viewerTripIds` is the caller's accepted-membership set (routes/wall.ts reads
 * trip_members with `status == null || status === 'accepted'`). Both reads below
 * are keyed on those trip ids, so this producer can only ever surface a trip the
 * viewer is already a member of. It never reads another user's trip, and it
 * never names a PERSON: "crew gathering" is the trip's own plan, not anybody's
 * position (§23 — exact person location is never inferred, and crew/strangers
 * are coarse areas only). No coordinate is ever emitted.
 *
 * WHAT IS DROPPED, AND WHY
 * ========================
 *   • `location_is_private` items — routes/trips.ts nulls their coordinate for
 *     every reader and lib/mapProducers/meetingPointProducer drops them outright.
 *     This producer would otherwise use the service client's raw coordinate to
 *     assert "near <place>", which discloses the area the owner marked private.
 *   • removed / cancelled items, and items whose visibility is not member-visible.
 *   • meetup-sourced items whose meetup has been cancelled — cancelling a meetup
 *     leaves its plan item standing (the defect meetingPointProducer records), so
 *     the source is cross-checked. If that check cannot be READ, every
 *     meetup-sourced item is withheld: fail-closed, never a phantom gathering.
 */
export async function buildTripSignalLiveCandidates(
  sc: any,
  viewerId: string,
  viewerTripIds: Set<string> | undefined,
  placeRefs: PublicPlaceRef[],
  opts: { now?: Date } = {},
): Promise<LiveForYouCandidate[]> {
  const places = boundedPlaces(placeRefs);
  if (!sc || !viewerId || places.length === 0) return [];
  const tripIds = [...(viewerTripIds ?? [])].filter((t) => !!t).slice(0, MAX_TRIP_SIGNAL_TRIPS);
  if (tripIds.length === 0) return [];
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const byPlace = new Map(places.map((p) => [p.placeId, p]));

  try {
    // 1) Which of the feed's places are SAVED STOPS on those trips.
    //    trip_saved_places.place_id is client-supplied text (routes/trips-expansion
    //    POST /trips/:id/saved-places), so this is an exact-id match: a stop saved
    //    under a canonical place id joins, one saved under a provider id simply
    //    does not — fewer signals, never a wrong one.
    const { data: savedRows, error: savedErr } = await sc
      .from("trip_saved_places")
      .select("trip_id, place_id, lat, lng")
      .in("trip_id", tripIds)
      .in("place_id", [...byPlace.keys()])
      .limit(200);
    if (savedErr || !Array.isArray(savedRows)) return [];
    const savedPlaceIds = [
      ...new Set(
        (savedRows as any[])
          .map((r) => (r?.place_id ? String(r.place_id) : ""))
          .filter((id) => id !== "" && byPlace.has(id)),
      ),
    ];
    if (savedPlaceIds.length === 0) return [];
    // The stop's canonical public coordinate (see loadPlaceAnchors: used only to
    // decide "near", never emitted). The saved row's own client-supplied
    // coordinate is the fallback when the canonical place has none.
    const anchors = await loadPlaceAnchors(sc, savedPlaceIds);
    /** trip id -> the feed places that trip has saved (with the anchor coordinate). */
    const stopsByTrip = new Map<string, { place: PublicPlaceRef; lat: number | null; lng: number | null }[]>();
    for (const row of savedRows as any[]) {
      const tripId = row.trip_id ? String(row.trip_id) : "";
      const placeId = row.place_id ? String(row.place_id) : "";
      const place = byPlace.get(placeId);
      if (!tripId || !place) continue;
      const anchor = anchors.get(placeId);
      const lat = anchor ? anchor.lat : finiteCoord(row.lat) ? Number(row.lat) : null;
      const lng = anchor ? anchor.lng : finiteCoord(row.lng) ? Number(row.lng) : null;
      const list = stopsByTrip.get(tripId) ?? stopsByTrip.set(tripId, []).get(tripId)!;
      if (!list.some((s) => s.place.placeId === place.placeId)) list.push({ place, lat, lng });
    }
    if (stopsByTrip.size === 0) return [];

    // 2) Time-current milestones on exactly those trips.
    const windowStart = new Date(
      nowMs - EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000,
    ).toISOString();
    const windowEnd = new Date(nowMs + TRIP_SIGNAL_UPCOMING_MINUTES * 60_000).toISOString();
    const { data: itemRows, error: itemErr } = await sc
      .from("trip_plan_items")
      .select(
        "id, trip_id, title, category, status, source_type, source_id, starts_at, ends_at, " +
          "lat, lng, location_is_private, removed_at, visibility",
      )
      .in("trip_id", [...stopsByTrip.keys()])
      .is("removed_at", null)
      .neq("status", "cancelled")
      .not("starts_at", "is", null)
      .gte("starts_at", windowStart)
      .lte("starts_at", windowEnd)
      .limit(MAX_TRIP_PLAN_ITEMS);
    if (itemErr || !Array.isArray(itemRows)) return [];

    const eligible: { row: TripPlanItemRow; phase: EventPhase; minutes: number; expiresMs: number }[] = [];
    for (const row of itemRows as TripPlanItemRow[]) {
      if (!row || typeof row.id !== "string" || row.id === "") continue;
      if (row.removed_at != null) continue;
      if (row.status === "cancelled") continue;
      if (row.location_is_private === true) continue;
      if (!TRIP_SIGNAL_PLAN_VISIBILITY.has(String(row.visibility ?? "members"))) continue;
      const startMs = Date.parse(String(row.starts_at ?? ""));
      if (Number.isNaN(startMs)) continue;
      const expiresMs = meetingPointExpiryMs(row);
      if (expiresMs === null || expiresMs <= nowMs) continue;
      const phase: EventPhase = startMs <= nowMs ? "ongoing" : "upcoming";
      const minutes =
        phase === "ongoing"
          ? Math.round((nowMs - startMs) / 60_000)
          : Math.max(1, Math.round((startMs - nowMs) / 60_000));
      if (phase === "upcoming" && startMs - nowMs > TRIP_SIGNAL_UPCOMING_MINUTES * 60_000) continue;
      eligible.push({ row, phase, minutes, expiresMs });
    }
    if (eligible.length === 0) return [];

    // 3) A cancelled meetup leaves its plan item standing — cross-check, and
    //    withhold every meetup-sourced item if the check cannot be read.
    const meetupIds = [
      ...new Set(
        eligible
          .filter((e) => e.row.source_type === "meetup" && !!e.row.source_id)
          .map((e) => String(e.row.source_id)),
      ),
    ];
    let liveMeetupIds: Set<string> | null = null;
    if (meetupIds.length > 0) {
      const { data: meetupRows, error: meetupErr } = await sc
        .from("meetups")
        .select("id, status")
        .in("id", meetupIds);
      if (meetupErr || !Array.isArray(meetupRows)) {
        liveMeetupIds = null;
      } else {
        liveMeetupIds = new Set(
          (meetupRows as any[])
            .filter((m) => String(m.status ?? "") !== "cancelled")
            .map((m) => String(m.id)),
        );
      }
    }

    // 4) Anchor each surviving milestone on the saved stop(s) of its own trip.
    const best = new Map<string, { e: (typeof eligible)[number]; near: boolean }>();
    for (const e of eligible) {
      if (e.row.source_type === "meetup" && e.row.source_id) {
        if (liveMeetupIds === null) continue; // unreadable ⇒ withheld
        if (!liveMeetupIds.has(String(e.row.source_id))) continue; // cancelled meetup
      }
      const stops = stopsByTrip.get(String(e.row.trip_id));
      if (!stops) continue;
      for (const stop of stops) {
        let near = false;
        if (finiteCoord(e.row.lat) && finiteCoord(e.row.lng) && stop.lat !== null && stop.lng !== null) {
          const away = haversineMeters(stop.lat, stop.lng, e.row.lat as number, e.row.lng as number);
          // A milestone with a KNOWN coordinate that is far from this stop is not
          // "near" it — drop the pairing rather than soften the claim.
          if (!(away <= TRIP_SIGNAL_NEAR_METERS)) continue;
          near = true;
        }
        const key = stop.place.placeId;
        const cur = best.get(key);
        if (
          !cur ||
          (cur.e.phase !== "ongoing" && e.phase === "ongoing") ||
          (cur.e.phase === e.phase && e.minutes < cur.e.minutes) ||
          (cur.e.phase === e.phase && e.minutes === cur.e.minutes && e.row.id < cur.e.row.id)
        ) {
          best.set(key, { e, near });
        }
      }
    }

    const out: LiveForYouCandidate[] = [];
    for (const [placeId, { e, near }] of best) {
      const place = byPlace.get(placeId)!;
      const when = e.phase === "ongoing" ? "now" : `in ${e.minutes} min`;
      const title = causeTitle(e.row.title);
      // "near" is only claimed when both coordinates were known and checked;
      // otherwise the item says only what is certain — it is on this trip.
      const where = near ? "nearby" : "on your trip";
      const label =
        e.row.category === "meeting_point"
          ? `Crew gathering ${when} ${where} · ${title}`
          : `${title} ${when} · ${where}`;
      out.push({
        subjectId: placeId,
        liveObjectType: "trip_signal",
        subject: place,
        resolved: {
          id: `trip-${e.row.id}`,
          label,
          // A plan is not an observation (see the §37 note above).
          state: "emerging",
          confidence: null,
          observedAt: now.toISOString(),
          validUntil: new Date(e.expiresMs).toISOString(),
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "liveForYou: trip signal producer failed — no trip strip items");
    return [];
  }
}
