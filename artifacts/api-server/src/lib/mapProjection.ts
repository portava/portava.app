/**
 * mapProjection — the Map Intelligence Gateway's shaping layer (Map spec §19).
 *
 * THE RULE THIS FILE EXISTS FOR
 * ============================
 * Spec §19: "Never place raw database rows directly on the map. Use a dedicated
 * projection layer." and "The mobile client should not independently
 * reconstruct Portava intelligence rules."
 *
 * Today the client does exactly what §19 forbids: src/hooks/useMapEntities.ts
 * fires five independent fetches and merges the raw service payloads itself, so
 * every rule about freshness, confidence, priority and privacy would have to be
 * re-implemented on the device. This module is the server-side seam that ends
 * that: sources in, MapObjects out.
 *
 * WHAT THIS MODULE DOES NOT DO — and why that matters
 * ===================================================
 * It does NOT decide privacy and it does NOT query. Exactly like lib/mapSearch,
 * the route calls each entity type's EXISTING privacy-complete source
 * (listMapTravelers, findNearbyGems + applyGemPrivacyBatch, loadNearbyEvents,
 * readCircleLocations) and hands the already-safe rows here to be shaped.
 * Keeping the shaping pure means this layer can never widen what a source
 * exposed, and it makes ranking and aggregation unit-testable without a
 * database.
 *
 * The circle layer is the sharpest illustration of why the split matters: a
 * circle member's coordinate is coarsened by `coarsenPosition` INSIDE
 * lib/circleLocationsRead, before it is ever handed here — so the coarse
 * coordinate is what crosses the wire, and `projectCircleMember` has no raw
 * position it could accidentally serialize.
 *
 * COORDINATE CONTRACT (inherited from lib/mapSearch, restated because it is the
 * one invariant a projection layer is most likely to break)
 * ==========================================================================
 * `geometry` carries whatever precision the source already chose — coarsened
 * traveler pins, gem coords per sensitivity, event venues with
 * show_exact_location honoured. NOTHING here sharpens them. `privacyClass`
 * RECORDS which rung of the §23 ladder that geometry sits on so the renderer
 * can label approximation honestly.
 *
 * IDENTITY SUPPRESSION (spec §23, §37)
 * ====================================
 * §23: "Default public rendering should aggregate social presence. The map
 * should show '18 travelers active around this area' rather than a field of
 * identifiable stranger avatars." §37 lists a public real-time people tracker
 * as an explicit non-goal. So `projectTraveler` STRIPS display name and avatar
 * whenever the object's rung fails `mayRenderIdentity()` — the client cannot
 * render what it was never sent. This is deliberately stricter than the legacy
 * /api/map/travelers payload, which ships identity at city precision.
 *
 * CONFIDENCE AND FRESHNESS ARE NEVER INVENTED
 * ===========================================
 * A gem's verification level, an event's start time and a traveler's activity
 * bucket are not evidence about "what is true at this place right now", so this
 * module leaves `confidence` undefined for them rather than manufacturing a
 * band. The only source of a confidence band is the intel pipeline, attached by
 * `enrichWithLiveClaims` from already-computed snapshots. Spec §37: "Do not let
 * Compass invent live conditions" — the same applies here.
 */
import {
  MAP_OBJECT_KINDS,
  type ActivityLevel,
  type ConfidenceState,
  type FreshnessState,
  type MapObject,
  type MapObjectKind,
  type MapProvenanceLine,
  type Position,
  type PrivacyClass,
  type TrendState,
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  centroidOf,
  compareByRenderingPriority,
  deriveFreshness,
  isServable,
  mayRenderIdentity,
  point,
} from "./mapObjects.js";
import {
  classifyAgainstProtected,
  zoneCovers,
  type ProtectedZone,
} from "./protectedLocations.js";
import { haversineKm } from "./mapSearch.js";
import { KM_PER_DEGREE_LAT, type BBox } from "./mapAggregation.js";
import {
  LEGACY_CLAIM_TYPES,
  SOURCE_CLASSES,
  SOURCE_CLASS_LABELS,
  mayCountAsConsensus,
  mayRenderAsLive,
  type CrowdLevel,
  type SourceClass,
  type Trajectory,
} from "./intelContracts.js";
import type { LiveClaimEnvelope, SourceCountBucket } from "./liveClaimRead.js";

// ── Traveler (spec §23 aggregate social presence) ─────────────────────────────

/**
 * The coarsening rung lib/mapTravelers already applied, mapped onto §23's
 * ladder. 'city' means the pin was moved to a city centroid — that is
 * aggregate, not a location; 'area' is a ~2 km grid cell, which is
 * 'approximate'. Anything unrecognised fails closed to aggregate_only.
 */
export function travelerPrivacyClass(precision: string | null | undefined): PrivacyClass {
  if (precision === "area") return "approximate";
  if (precision === "city") return "aggregate_only";
  return "aggregate_only";
}

/**
 * A traveler is projected as a `social_zone` — spec §6's "Group icon =
 * Aggregate social opportunity" — never as an identified person on a public
 * map. Identity fields survive only at rungs `mayRenderIdentity` permits.
 */
export function projectTraveler(t: any): MapObject | null {
  if (t?.lat == null || t?.lng == null) return null;
  const privacyClass = travelerPrivacyClass(t.precision);
  const identified = mayRenderIdentity(privacyClass);

  return {
    id: `traveler:${t.id}`,
    kind: "social_zone",
    geometry: point(Number(t.lat), Number(t.lng)),
    // At aggregate rungs the title must not name anyone.
    title: identified ? (t.displayName ?? "Traveler") : "Traveler nearby",
    subtitle: joinParts([t.city, t.country], ", ") ?? undefined,
    freshness: travelerFreshness(t.freshness),
    privacyClass,
    renderingPriority: KIND_DEFAULT_PRIORITY.social_zone,
    interaction: {
      actions: identified ? ["view", "message", "follow", "report", "block"] : ["view"],
      opensSheet: true,
    },
    payload: identified
      ? {
          handle: t.handle ?? null,
          displayName: t.displayName ?? null,
          avatarUrl: t.avatarUrl ?? null,
          verified: t.verified === true,
          openToMeet: t.openToMeet === true,
          precision: t.precision ?? null,
        }
      : // Identity withheld at this rung. The client cannot leak what it never got.
        { openToMeet: t.openToMeet === true, precision: t.precision ?? null },
  };
}

/** lib/mapTravelers emits 'live' (<15 min) / 'recent' (<60 min); anything else is unknown. */
function travelerFreshness(f: unknown): FreshnessState {
  return f === "live" ? "live" : f === "recent" ? "recent" : "unknown";
}

// ── Hidden gem ────────────────────────────────────────────────────────────────

/**
 * `coordsPrecision` is set by HiddenGemPrivacyGuard. 'exact' means the guard
 * decided this viewer may see the venue; 'approximate' means it deliberately
 * blurred it. Unknown fails closed to approximate — never to exact.
 */
export function gemPrivacyClass(coordsPrecision: string | null | undefined): PrivacyClass {
  return coordsPrecision === "exact" ? "place_level" : "approximate";
}

export function projectGem(g: any, distanceKm: number | null = null): MapObject | null {
  if (g?.lat == null || g?.lng == null) return null;
  if (g.status && g.status !== "active") return null;

  return {
    id: `gem:${g.id}`,
    kind: "hidden_gem",
    geometry: point(Number(g.lat), Number(g.lng)),
    title: g.name ?? "Hidden gem",
    subtitle: joinParts([g.category, g.city], " · ") ?? undefined,
    // A gem's verification level is trust in the CONTRIBUTOR, not evidence about
    // current conditions — projecting it as a live confidence band would be a
    // category error. Left undefined; enrichWithLiveClaims may fill it.
    privacyClass: gemPrivacyClass(g.coordsPrecision),
    renderingPriority: KIND_DEFAULT_PRIORITY.hidden_gem,
    distanceKm,
    interaction: {
      actions: ["view", "save", "share", "navigate", "add_to_trip", "ask_compass", "report"],
      detailRoute: `/gems/${g.id}`,
      opensSheet: true,
      contributable: true,
    },
    payload: {
      category: g.category ?? null,
      city: g.city ?? null,
      // `image_url` is the column hidden_gems actually has, and the one
      // findNearbyGems selects. This read used to be `g.thumbnail_url`, which is
      // not a column on that table at ALL — so every gem the gateway served had
      // a null thumbnail and rendered with no image, while the client's fallback
      // projector (which reads the app DTO's `imageUrl`) showed one. Same shape,
      // different pixels, depending on a feature flag.
      thumbnailUrl: g.image_url ?? null,
      verificationLevel: g.verification_level ?? null,
      coordsPrecision: g.coordsPrecision ?? null,
      // THE LIVE-CLAIM SUBJECT, and it is NOT this gem's own id.
      //
      // intel_state_snapshots.subject_id is `uuid NOT NULL REFERENCES
      // public.places(id)` (migration 2130). A gem's id is a hidden_gems id —
      // an independent uuid space. Keying the live-claim read on `gem:<g.id>`
      // therefore looked correct, compiled, had tests, and COULD NEVER MATCH:
      // no gem on this map has ever carried an activity, trend, confidence,
      // freshness, sourceClass or provenance, and nothing failed.
      //
      // hidden_gems.canonical_place_id (migration 2044) is the bridge, and it
      // was already being selected at the call site
      // (HiddenGemDiscoveryService.ts:106) — it just was not used. Null when a
      // gem has not been reconciled to a canonical place, in which case it
      // correctly has no live subject rather than a mismatched one.
      canonicalPlaceId: g.canonical_place_id ?? null,
    },
  };
}

// ── Event ─────────────────────────────────────────────────────────────────────

export function projectEvent(ev: any, now: number = Date.now()): MapObject | null {
  // loadNearbyEvents NULLs the coordinates when show_exact_location is false and
  // the viewer is not the host. No coordinates => no pin, by design.
  if (ev?.location_lat == null || ev?.location_lng == null) return null;

  const startsAtMs = ev.starts_at ? new Date(ev.starts_at).getTime() : NaN;
  const active = Number.isFinite(startsAtMs) && startsAtMs <= now;

  return {
    id: `event:${ev.id}`,
    kind: "event",
    geometry: point(Number(ev.location_lat), Number(ev.location_lng)),
    title: ev.title ?? "Event",
    subtitle: joinParts([ev.location_name, ev.starts_at ? String(ev.starts_at).slice(0, 10) : null], " · ") ?? undefined,
    // An event's schedule is a fact about the event, not an observation of
    // current conditions — so no freshness/confidence is asserted here.
    expiresAt: ev.ends_at ? String(ev.ends_at) : undefined,
    privacyClass: "place_level",
    // §31: an event that has actually started outranks one merely scheduled.
    renderingPriority: active
      ? KIND_DEFAULT_PRIORITY.event
      : KIND_DEFAULT_PRIORITY.event - 5,
    interaction: {
      actions: ["view", "join", "share", "navigate", "add_to_trip", "meet_here", "report"],
      detailRoute: `/event/${ev.id}`,
      opensSheet: true,
      contributable: true,
    },
    payload: {
      locationName: ev.location_name ?? null,
      startsAt: ev.starts_at ?? null,
      coverUrl: ev.cover_url ?? null,
      visibility: ev.visibility ?? null,
      hasStarted: active,
    },
  };
}

// ── Circle member / friend (spec §23 "Locate My Friends", §6) ────────────────

/**
 * A consented circle member is ALWAYS `approximate` — never `place_level`.
 *
 * The rung is a statement about the coordinate in `geometry`, and every
 * coordinate that reaches here has already been through `coarsenPosition`
 * inside lib/circleLocationsRead: an ~11 km (city_only) or ~2.2 km grid cell
 * with a deterministic per-user offset inside it. That is not a place, so
 * calling it `place_level` would be a lie the renderer would then draw as a
 * precise pin. It is also not `aggregate_only`: this IS an individual, named,
 * consented person — §23 puts Trip Crew / Locate My Friends at "approximate",
 * which is exactly this rung, and §6 says the honest treatment is a ring
 * rather than a pin.
 *
 * `precise_temporary` is the rung a Safe-Return / temporary-precise share would
 * occupy. Nothing on this path can produce it, so nothing here may claim it.
 */
export const CIRCLE_PRIVACY_CLASS: PrivacyClass = "approximate";

/**
 * Project one already-authorized, already-coarsened circle member.
 *
 * The input MUST come from `readCircleLocations` — the single privacy-complete
 * source. This function decides nothing: it cannot tell a consented member from
 * a non-consented one, and it must never be handed a raw user_location_state
 * row. That is the same contract projectTraveler has with listMapTravelers.
 *
 * No freshness: `updatedAt` is when the member's position was last written, not
 * an observation of conditions at a place, and the circle payload has no
 * evidence band. Manufacturing "live" from a recent write would make a stale
 * pin read as a confirmed one (spec §37).
 */
export function projectCircleMember(m: CircleMemberLike): MapObject | null {
  if (m?.lat == null || m?.lng == null) return null;
  if (!m.userId) return null;

  return {
    id: `friend:${m.userId}`,
    kind: "crew_member",
    geometry: point(Number(m.lat), Number(m.lng)),
    // `name` is already gated by nameVisibilitySet inside the reader: null here
    // means "this member has not opted into showing a real name", so the
    // fallback must be generic rather than a handle we were not given.
    title: m.name ?? "Circle member",
    subtitle: joinParts([m.city, m.country], ", ") ?? undefined,
    privacyClass: CIRCLE_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.crew_member,
    interaction: {
      // No detailRoute: circle members are reached through thread resolution,
      // not a static route.
      actions: ["message", "follow", "report", "block"],
      opensSheet: true,
    },
    payload: {
      userId: m.userId,
      name: m.name ?? null,
      avatarUrl: m.avatarUrl ?? null,
      city: m.city ?? null,
      country: m.country ?? null,
      updatedAt: m.updatedAt ?? null,
    },
  };
}

/** Structural shape of `readCircleLocations`' entry — see lib/circleLocationsRead. */
export type CircleMemberLike = {
  userId: string;
  name?: string | null;
  avatarUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  country?: string | null;
  updatedAt?: string | null;
};

// ── Buddy (spec §18 buddy_zone, §23 approximate) ─────────────────────────────

/**
 * A buddy pin is ALWAYS `approximate`, never `place_level`.
 *
 * `meetupBaseLat/Lng` is an area-rounded MEETUP BASE the buddy chose — the
 * client renders it through MeetupAreaPreview as a ~100 m area for exactly that
 * reason — not an address and not a live position. The client projector
 * (features/map/projection/clientProjection.ts `projectBuddy`) already stamps
 * `approximate`; this rung must agree, or the same buddy would be labelled
 * differently depending on which transport happened to serve them.
 *
 * `precise_temporary` is not reachable here and must never be claimed: nothing
 * on this path carries a temporary precise share.
 */
export const BUDDY_PRIVACY_CLASS: PrivacyClass = "approximate";

/**
 * The public buddy DTO's shape, as far as this projector reads it. The real
 * input is `readBuddyMapPins`' already-safe row (lib/buddyMapRead) — the ONE
 * privacy-complete buddy read. This function decides nothing: it cannot tell a
 * suspended buddy from an active one, and it must never be handed a raw
 * rent_buddy_profiles row.
 */
export type BuddyPinLike = {
  id: string;
  userId?: string | null;
  displayName?: string | null;
  city?: string | null;
  tagline?: string | null;
  meetupBaseLat?: number | null;
  meetupBaseLng?: number | null;
};

/**
 * Project one already-authorized buddy.
 *
 * No freshness and no confidence. A buddy's `available_now` flag is a
 * self-declared marketplace setting, not an observation of conditions at a
 * place, and `updatedAt` is when the profile row was written. Manufacturing
 * "live" from either would make a listing read as a confirmed sighting
 * (spec §37) — so neither is asserted, exactly as the client projector does not
 * assert them.
 *
 * SUBTITLE, stated because it is the one place this diverges from the client
 * projector: the client reads `buddy.headline`, a field the buddy DTO has never
 * carried (`mapBuddyPublicProfile` emits `tagline`), so the client's subtitle
 * has always collapsed to the city alone. This uses `tagline`, the field that
 * actually exists and is already public in the marketplace payload. That is a
 * presentation difference, not a disclosure one: no field is exposed here that
 * the buddy's own public listing does not already show.
 */
export function projectBuddy(b: BuddyPinLike): MapObject | null {
  if (!b?.id) return null;
  const lat = b.meetupBaseLat ?? null;
  const lng = b.meetupBaseLng ?? null;
  // No meetup base, no pin. This projector will NOT fall back to a city
  // centroid the buddy never chose — that would invent a location.
  if (lat == null || lng == null) return null;

  return {
    id: `buddy:${b.id}`,
    kind: "buddy_zone",
    geometry: point(Number(lat), Number(lng)),
    title: b.displayName ?? "Buddy",
    subtitle: joinParts([b.city, b.tagline], " · ") ?? undefined,
    privacyClass: BUDDY_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.buddy_zone,
    interaction: {
      actions: ["view", "book", "message", "report"],
      detailRoute: `/(rent-a-buddy)/buddy/${b.id}`,
      opensSheet: true,
    },
    payload: b,
  };
}

// ── Trip (spec §18 trip_stop) ────────────────────────────────────────────────

/**
 * A trip pin sits on a destination the viewer themselves recorded — a city or
 * venue, not a live position — so `place_level` is the honest rung. It is the
 * viewer's OWN trip in every case: the source is scoped to trips they are an
 * accepted member of.
 */
export const TRIP_PRIVACY_CLASS: PrivacyClass = "place_level";

/** Structural shape of `toAuthorizedTripView` (lib/privacy/tripSerializers). */
export type TripViewLike = {
  id: string;
  title?: string | null;
  visibility?: string | null;
  destinationCity?: string | null;
  destinationCountry?: string | null;
  destinationLat?: number | null;
  destinationLng?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: string | null;
};

/**
 * Project one authorized trip view.
 *
 * The `visibility === 'private'` drop is NOT a new rule: it is the client's
 * `isMapVisibleTrip` moved server-side, which is the whole point of §19. A
 * private trip is one the owner asked not to be shown as a map pin, and the
 * server is the only place that decision can actually be enforced.
 *
 * No freshness or confidence: a trip's dates are a plan, not an observation.
 */
export function projectTrip(t: TripViewLike): MapObject | null {
  if (t?.destinationLat == null || t?.destinationLng == null) return null;
  if (!t.id) return null;
  if (t.visibility === "private") return null;

  return {
    id: `trip:${t.id}`,
    kind: "trip_stop",
    geometry: point(Number(t.destinationLat), Number(t.destinationLng)),
    title: t.title ?? t.destinationCity ?? "Trip",
    subtitle:
      joinParts([t.destinationCity, tripDateRange(t.startDate, t.endDate)], " · ") ?? undefined,
    privacyClass: TRIP_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.trip_stop,
    interaction: {
      actions: ["view", "share", "navigate"],
      detailRoute: `/trip/${t.id}`,
      opensSheet: true,
    },
    payload: {
      destinationCity: t.destinationCity ?? null,
      destinationCountry: t.destinationCountry ?? null,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
      status: t.status ?? null,
      visibility: t.visibility ?? null,
    },
  };
}

function tripDateRange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from && !to) return null;
  const a = from ? String(from).slice(0, 10) : "?";
  const b = to ? String(to).slice(0, 10) : "?";
  return `${a} → ${b}`;
}

// ── Live-claim enrichment (spec §7, §9, §21) ──────────────────────────────────

/**
 * The one place a projected object acquires a confidence band, an activity
 * level and a "why" panel. Everything here comes from an ALREADY-COMPUTED
 * snapshot read through lib/liveClaimRead — this function scores nothing.
 *
 * `readLiveClaims` is per-subject and sits behind four fail-closed gates
 * (intel_live_label_crowd → intel_claim_projection_crowd →
 * intel_capture_quick_signal → intel_limited_live, plus a kill switch), so it
 * returns [] for most viewports today. To keep a wide viewport from turning into
 * an unbounded fan-out of per-subject reads, enrichment is capped — and the cap
 * is REPORTED, never silent: the caller surfaces `skipped` so a truncated
 * enrichment can't be mistaken for "no live data here".
 */
export const LIVE_ENRICHMENT_MAX_SUBJECTS = 25;

export interface LiveEnrichmentResult {
  objects: MapObject[];
  /** How many objects were considered for enrichment. */
  considered: number;
  /** How many actually received a live claim. */
  enriched: number;
  /** How many were eligible but skipped because of the cap. */
  skipped: number;
}

/**
 * The subset of `readLiveClaims`' envelope this module consumes.
 *
 * `sourceCountBucket` IS NULLABLE, and that is load-bearing (spec §37: "Do not
 * let paid businesses buy factual confidence"). lib/liveClaimRead withholds the
 * cohort bucket entirely — `mayCountAsConsensus(sourceClass) ? bucket : null` —
 * for the three classes that are one party talking about themselves
 * (official_signed / sponsored / imported_owned). This interface previously
 * re-declared the field as non-nullable, and the route erased the mismatch with
 * an `as unknown as` cast, so `describeClaim` fell through its ?: chain and
 * rendered a SPONSORED claim as "A few recent traveler reports". Both halves are
 * gone: the field is nullable here, and the cast is gone at the call site, so
 * the compiler enforces the withholding instead of a comment describing it.
 *
 * `sourceClass` is carried for the same reason. Without it the object has no way
 * to say WHO is speaking, so a client could not label a sponsored claim even if
 * it wanted to — the only remaining choice would be "traveler report or say
 * nothing", which is exactly the §37 failure.
 */
export interface LiveClaimLike {
  id: string;
  claimType: string;
  value: unknown;
  confidence: number | null;
  band: ConfidenceState;
  /** NULL when the class may not be counted as independent community consensus. */
  sourceCountBucket: SourceCountBucket | null;
  /** Who is speaking. Never inferred here — it comes from the read path. */
  sourceClass: SourceClass;
  observedAt: string;
  validUntil: string;
  state: string;
}

/**
 * COMPILE-TIME PIN, in the spirit of routes/mapProjection's CROWD_FLOW_FLAG_PIN.
 *
 * The whole defect above was two shapes for one payload drifting apart in
 * silence. This assignment is the only thing that makes them one shape: if
 * `LiveClaimEnvelope` ever loses a field, or re-widens `sourceCountBucket`, this
 * line stops compiling HERE — at the consumer that would otherwise have to be
 * re-taught the divergence by a production bug.
 */
const _envelopeIsLiveClaimLike: (e: LiveClaimEnvelope) => LiveClaimLike = (e) => e;
void _envelopeIsLiveClaimLike;

/**
 * §9 / Table 7 — the CONTEXTUAL evidence lines, the ones that are not a claim.
 *
 * Table 7's "WHY PORTAVA SAYS THIS" panel mixes two kinds of line. Most are
 * per-claim ("Several recent traveler reports · crowd.level"), and `describeClaim`
 * above renders those. Two are not about any single claim — they are the
 * SURROUNDING evidence a reader weighs when deciding whether to believe the live
 * state at all:
 *
 *     • Active event nearby       — something is happening next door, so a busy
 *                                   reading is more plausible than noise.
 *     • Recent qualified media     — a photo/video that passed §35 evidence
 *                                   eligibility exists for this subject.
 *
 * They are declared here as an OPTIONAL bundle, `MapClaimEvidence`, threaded into
 * `applyLiveClaims`. Two rules follow from §37 and hold structurally:
 *
 *   1. They NEVER manufacture a claim. `applyLiveClaims` still returns the object
 *      untouched when there are no claims (see its guard), so an active event
 *      next to a place with no live state adds no line and no freshness — the
 *      panel explains a claim that exists, it does not invent one.
 *   2. They NEVER move confidence, freshness, activity or trend. They are text
 *      appended to `provenance.lines` only. A paid or adjacent signal cannot buy
 *      a band; only claims set the band, and only through the fold below.
 *
 * The copy is Table 7 VERBATIM ("Active event nearby" / "Recent qualified
 * media") — this is spec text, not prose invented here — and each formatter
 * returns `null` (no line) rather than an empty string when its input is absent
 * or empty, so an absent input is indistinguishable from "no such evidence".
 */
export interface EventAdjacencyEvidence {
  /** How many active events sit within the adjacency radius of the subject. */
  count: number;
}

export interface QualifiedMediaEvidence {
  /** How many §35-eligible media assets back this subject's recent observations. */
  count: number;
}

export interface MapClaimEvidence {
  eventNearby?: EventAdjacencyEvidence | null;
  qualifiedMedia?: QualifiedMediaEvidence | null;
}

/** Table 7 "Active event nearby", or null when no active event is adjacent. */
export function eventAdjacencyLine(
  e: EventAdjacencyEvidence | null | undefined,
): MapProvenanceLine | null {
  if (!e || !Number.isFinite(e.count) || e.count < 1) return null;
  return { text: "Active event nearby" };
}

/** Table 7 "Recent qualified media", or null when no qualified media exists. */
export function qualifiedMediaLine(
  m: QualifiedMediaEvidence | null | undefined,
): MapProvenanceLine | null {
  if (!m || !Number.isFinite(m.count) || m.count < 1) return null;
  return { text: "Recent qualified media" };
}

/**
 * §9 event-adjacency radius. An event whose venue is within ~300 m of a place
 * is close enough that "there is an event next door" genuinely bears on why the
 * place is busy; much beyond that and the two are just in the same district.
 */
export const EVENT_ADJACENCY_RADIUS_KM = 0.3;

/**
 * Count the events that are ACTIVE (started and not yet ended) and sit within
 * `radiusKm` of `subject`. Pure: the route hands it the event objects it has
 * ALREADY loaded and shaped for this same viewport, so this reconstructs no
 * intelligence of its own — it reads `payload.hasStarted` (set by projectEvent)
 * and `expiresAt` (the event's end), and measures great-circle distance.
 *
 * An event with no start signal is NOT counted: "active event nearby" is a
 * statement that something is happening now, and a merely-scheduled event next
 * week is not that. An event past its `expiresAt` is likewise not active.
 */
export function countAdjacentActiveEvents(
  subject: MapObject,
  events: readonly MapObject[],
  now: number = Date.now(),
  radiusKm: number = EVENT_ADJACENCY_RADIUS_KM,
): number {
  const here = centroidOf(subject.geometry);
  if (!here) return 0;
  let count = 0;
  for (const ev of events) {
    if (!ev || ev.kind !== "event") continue;
    if ((ev.payload as { hasStarted?: unknown } | undefined)?.hasStarted !== true) continue;
    if (ev.expiresAt) {
      const endsMs = Date.parse(ev.expiresAt);
      if (Number.isFinite(endsMs) && endsMs <= now) continue; // already ended
    }
    const there = centroidOf(ev.geometry);
    if (!there) continue;
    if (haversineKm(here.lat, here.lng, there.lat, there.lng) <= radiusKm) count += 1;
  }
  return count;
}

/**
 * Pure: fold one subject's live claims onto its object. Exported separately from
 * the I/O wrapper so the merge rules are testable without a database.
 *
 * Never upgrades: if the claims are empty the object is returned untouched, and
 * a claim can only ever ADD freshness/confidence/activity/trend, never overwrite
 * a value the source already asserted with a weaker one.
 *
 * `evidence` is the §9/Table 7 contextual bundle (event-adjacency, qualified
 * media). It only ever APPENDS provenance lines to a panel that already exists —
 * see the guard: no claims ⇒ no panel ⇒ no evidence line, so contextual evidence
 * can never manufacture a live claim or move a band (§37).
 */
export function applyLiveClaims(
  obj: MapObject,
  claims: readonly LiveClaimLike[],
  now: number = Date.now(),
  evidence?: MapClaimEvidence | null,
): MapObject {
  if (!claims || claims.length === 0) return obj;

  // readLiveClaims already orders best/current first.
  const primary = claims[0];

  // FRESHNESS IS GATED ON THE SOURCE CLASS, not on the timestamp alone.
  // deriveFreshness answers "how recently was this observed"; it cannot answer
  // "was this observed at all". A portava_prediction or a historical_pattern
  // carries a timestamp like any other claim, so a two-minute-old FORECAST read
  // as `live` — §37's "do not make predictions look like observations", by a
  // route the timestamp maths could never catch.
  //
  // mayRenderAsLive is intelContracts' own answer to exactly this question and
  // was simply not consulted here. A non-observation is capped at `recent`: it
  // is genuinely current information, it is just not a sighting.
  const observedFreshness = deriveFreshness(primary.observedAt, primary.validUntil, now);
  const freshness =
    mayRenderAsLive(primary.sourceClass) || observedFreshness !== "live"
      ? observedFreshness
      : "recent";

  const lines: MapProvenanceLine[] = claims.map((c) => ({
    text: describeClaim(c),
    ref: c.id,
  }));

  // §9 / Table 7: append the two CONTEXTUAL evidence lines when their inputs
  // exist. They carry no `ref` — they are not claims — and they follow the
  // per-claim lines so the panel reads claims-first, context-after. Absent
  // inputs add nothing (each formatter returns null), so this is a no-op on the
  // common path where the enrichment supplied no contextual evidence.
  if (evidence) {
    const eventLine = eventAdjacencyLine(evidence.eventNearby);
    if (eventLine) lines.push(eventLine);
    const mediaLine = qualifiedMediaLine(evidence.qualifiedMedia);
    if (mediaLine) lines.push(mediaLine);
  }

  // §7 keeps Activity and Trend as SEPARATE axes, and §8's Live Place sheet
  // shows both at once ("Crowd Busy / Trend ↑ Up"). They come from two different
  // claim types (crowd.level and crowd.trajectory), so reading only `primary`
  // could never populate both — whichever claim sorted first would silently
  // suppress the other axis. Scan the whole list instead; `claims` is already in
  // readLiveClaims' deterministic best/current-first order, so first-match is
  // stable, and each axis still comes only from a claim that actually asserts it.
  let activity: ActivityLevel | undefined;
  let trend: TrendState | undefined;
  for (const c of claims) {
    if (activity === undefined) activity = crowdValueToActivity(c);
    if (trend === undefined) trend = crowdValueToTrend(c);
    if (activity !== undefined && trend !== undefined) break;
  }

  return {
    ...obj,
    observedAt: primary.observedAt,
    expiresAt: primary.validUntil,
    freshness,
    confidence: primary.band,
    activity,
    trend,
    sourceClass: attributedSourceClass(claims),
    sourceRefs: claims.map((c) => c.id),
    provenance: {
      lines,
      confidence: primary.band,
      updatedAt: primary.observedAt,
    },
    // A place with qualifying live evidence is a §31 "high-confidence live
    // zone" and outranks a merely relevant place — but only while it qualifies.
    renderingPriority:
      freshness === "live" && (primary.band === "live" || primary.band === "strong")
        ? Math.max(obj.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone)
        : obj.renderingPriority,
  };
}

/** The classes the wire vocabulary declares. Membership is checked, not assumed. */
const RECOGNISED_SOURCE_CLASSES: ReadonlySet<string> = new Set(SOURCE_CLASSES);

/**
 * The ONE class the object is attributed to, folded from the claims that fed it.
 *
 * §9's panel is per-claim and therefore lossless — each line is attributed
 * individually. `MapObject.sourceClass` is a single value, so folding several
 * claims into it is lossy, and the fold has to fail in a chosen direction.
 *
 * THE MIXED CASE IS THE WHOLE PROBLEM. §7 keeps Activity and Trend as separate
 * axes and they come from two different claim types, so one object routinely
 * carries claims from two different speakers — a sponsored `crowd.level` and a
 * traveler `crowd.trajectory`. Attributing that object to `claims[0]` alone
 * would let a paid claim ride under a traveler badge whenever the traveler
 * claim happened to sort first: §37's failure, reintroduced by a new route
 * within one release of being closed.
 *
 * So NON-INDEPENDENT WINS, wherever it sits in the list. The error is
 * deliberately one-directional: understating attribution ("that was a traveler
 * report") is the §37 failure, while overstating it ("some of this came from
 * the business") only ever claims LESS credibility than the evidence supports,
 * and §9's itemised panel still shows the reader every individual line. The
 * partition is intelContracts' own `mayCountAsConsensus` — the same predicate
 * lib/liveClaimRead uses to withhold the cohort bucket — so this invents no
 * credibility ladder of its own. With no non-independent claim present the
 * answer is `claims[0]`, the same claim that supplies `observedAt`,
 * `expiresAt`, `freshness` and `confidence`; the badge and the headline state
 * then describe one claim.
 *
 * UNRECOGNISED ⇒ NO FIELD. `LiveClaimLike` is structural, so a future or
 * foreign class can arrive at runtime. Publishing it verbatim would put a value
 * on the wire that is outside the contract both mirrors declare, and a client
 * doing `LABELS[cls] ?? somethingFriendly` would then fail open. Omitting the
 * field leaves the reader with `describeClaim`'s "Source not attributed", which
 * is the same ruling that function already makes: never toward traveler.
 */
export function attributedSourceClass(
  claims: readonly LiveClaimLike[],
): SourceClass | undefined {
  if (!claims || claims.length === 0) return undefined;
  for (const c of claims) {
    if (RECOGNISED_SOURCE_CLASSES.has(c.sourceClass) && !mayCountAsConsensus(c.sourceClass)) {
      return c.sourceClass;
    }
  }
  const primary = claims[0].sourceClass;
  return RECOGNISED_SOURCE_CLASSES.has(primary) ? primary : undefined;
}

/**
 * A human evidence line for the §9 Why? panel. Uses only the coarse cohort
 * bucket — the exact contributor count is the privacy parameter itself and
 * never crosses the wire (see liveClaimRead's envelope contract).
 *
 * WHEN THE BUCKET IS NULL (§37: paid confidence is not for sale). A null bucket
 * means the read path REFUSED to publish a cohort size because the class is one
 * party talking about itself. Three things could go in the line, and only one is
 * honest:
 *
 *   • "A few recent traveler reports" — a LIE. This is what the code did.
 *   • the claim type alone — vague, and worse than vague: an unattributed
 *     assertion reads as the map's own finding, which is the same borrowed
 *     credibility by a quieter route.
 *   • WHO said it — chosen. §9 exists to make a live claim replayable, so the
 *     answer to "why does Portava say this?" for a sponsored claim is
 *     "the business told us". Naming the class asserts no cohort and no
 *     consensus, and it is the one line that lets the reader discount it.
 *
 * The copy is SOURCE_CLASS_LABELS — the repo's single user-facing label per
 * class (intelContracts T-01: "Every class must have one") — rather than new
 * prose invented here, so the map and every other surface say the same word for
 * the same claim.
 */
function describeClaim(c: LiveClaimLike): string {
  if (c.sourceCountBucket === null) {
    const label = Object.prototype.hasOwnProperty.call(SOURCE_CLASS_LABELS, c.sourceClass)
      ? SOURCE_CLASS_LABELS[c.sourceClass]
      : // An unrecognised class is not a traveler and not trustworthy-by-default.
        "Source not attributed";
    return `${label} · ${c.claimType}`;
  }
  const cohort =
    c.sourceCountBucket === "many"
      ? "Many recent traveler reports"
      : c.sourceCountBucket === "several"
        ? "Several recent traveler reports"
        : "A few recent traveler reports";
  return `${cohort} · ${c.claimType}`;
}

// ── §7's Activity and Trend axes, fed from the REAL claim vocabularies ────────
//
// WHAT WENT WRONG HERE, so it cannot recur quietly. The activity mapper used to
// open with `if (c.claimType !== "crowd")` and then switch over
// `very_quiet|quiet|moderate|busy|very_busy|peak`. Both halves were wrong:
//
//   • "crowd" is a LEGACY flat type (intelContracts.LEGACY_CLAIM_TYPES, seeded
//     by migration 2122). What production writes is "crowd.level"
//     (lib/quickSignal, routes/mapObservations), so every real claim returned
//     undefined and §7's Activity axis had never once fired.
//   • the switch's value vocabulary was §7's DISPLAY vocabulary, not the claim
//     vocabulary. The claim values are intelContracts.CROWD_LEVELS —
//     dead|quiet|moderate|busy|packed|unsafe_density. Three of six overlapped by
//     coincidence, which is why a hand-written test fixture looked fine.
//
// The tables below are keyed by `Record<CrowdLevel, …>` / `Record<Trajectory, …>`
// ON PURPOSE: adding a value to CROWD_LEVELS or TRAJECTORIES in intelContracts
// now fails to COMPILE here until someone decides what it means on the map. A
// switch could not do that — it would just start returning undefined.

/**
 * CROWD_LEVELS → §7 Activity. `null` means "deliberately not projected onto this
 * axis", which is a different fact from "value we do not recognise" and is
 * recorded as a different value.
 *
 *   dead → very_quiet, quiet → quiet, moderate → moderate, busy → busy.
 *
 *   packed → very_busy, NOT peak. "Peak" claims the place is at ITS OWN apex —
 *   that is a statement about the trajectory (there is a literal `peaking`
 *   trajectory value, and §7 puts Trend in a separate column). A contributor who
 *   tapped "packed" said how full the room is, not that it has topped out.
 *   Publishing `peak` from a level claim is the exact defect the CROWD_DIRECTIONS
 *   note in intelContracts names: "publishes an inference the contributor never
 *   made". `peak` stays reachable — mapAggregation.activityForCohort emits it for
 *   a cohort ≥16× the k-floor, where the evidence for an apex actually exists.
 *
 *   unsafe_density → null. It is not a busyness reading at all; it is a SAFETY
 *   claim (SPECIALIST_ONLY_CROWD_LEVELS: "a safety claim, not a vibe: specialist
 *   review only"). §7's Activity scale tops out at "Peak", which on this map is
 *   an ATTRACTOR — §38's north-star routes the traveler toward the stronger
 *   area — so rendering a dangerous crush as "Peak" would advertise it as the
 *   place to go. There is no Activity value that means "dangerous", and inventing
 *   one is not this module's call. Withholding the axis is therefore the honest
 *   answer, and it is the same answer inputAssistance/liveSuggestions already
 *   gives for this value ("returns null so the formatter falls through rather
 *   than presenting a safety signal as vibe") — one claim, one rendering, on both
 *   surfaces. The claim is NOT silenced: it still appears as a §9 provenance line.
 *   A real safety surface for it is owed, and is a different axis from this one.
 */
const CROWD_LEVEL_TO_ACTIVITY: Record<CrowdLevel, ActivityLevel | null> = {
  dead: "very_quiet",
  quiet: "quiet",
  moderate: "moderate",
  busy: "busy",
  packed: "very_busy",
  unsafe_density: null,
};

/**
 * TRAJECTORIES → §7 Trend.
 *
 *   emerging, building → getting_busier. Both are upward. Neither asserts a
 *   RATE, so neither may become "increasing quickly": that word is a claim about
 *   speed, and a single categorical tap is a claim about state. `building` also
 *   already renders as "Getting busier" in liveSuggestions, so the two surfaces
 *   agree. `increasing_quickly` therefore has no single-claim producer — by
 *   design: a rate needs a delta between two observations, which is aggregation's
 *   job (mapAggregation.aggregateTrend), not this projection's.
 *
 *   peaking → stable. At the apex the crowd is neither growing nor shrinking, and
 *   §7's Trend vocabulary has no "at peak" term — the apex belongs to the
 *   Activity axis. Reading it as "cooling" would assert a decline nobody claimed.
 *
 *   stable → stable.
 *
 *   declining → cooling. The mildest downward term for the mildest downward
 *   trajectory ("Winding down").
 *
 *   fragmenting, ending → getting_quieter. Further along than declining — the
 *   crowd is breaking up / the thing is over — but still a statement about the
 *   PHASE, not about how fast anyone is leaving.
 *
 *   relocating → rapidly_dispersing. The only trajectory that asserts wholesale
 *   departure: the crowd is going, together, now. "Getting quieter" would badly
 *   understate a room emptying, and reserving §7's strongest term for the one
 *   value that actually means it keeps that term meaningful.
 */
const TRAJECTORY_TO_TREND: Record<Trajectory, TrendState | null> = {
  emerging: "getting_busier",
  building: "getting_busier",
  peaking: "stable",
  stable: "stable",
  fragmenting: "getting_quieter",
  relocating: "rapidly_dispersing",
  declining: "cooling",
  ending: "getting_quieter",
};

/**
 * Claim types that carry a crowd LEVEL: the canonical dotted type production
 * writes, plus the flat legacy type migration 2122 seeded and which
 * intelContracts says is "kept for readers that still use them". Accepting both
 * is what MediaProjectionService and inputAssistance/liveSuggestions already do;
 * a legacy row is still a real observation and must not become invisible only
 * because it predates the rename. The VALUE vocabulary check below is the same
 * either way, so a legacy row buys no laxity.
 */
const CROWD_LEVEL_CLAIM_TYPES: ReadonlySet<string> = new Set<string>([
  "crowd.level",
  ...LEGACY_CLAIM_TYPES.filter((t) => t === "crowd"),
]);

/** Only the dotted type carries a trajectory; the flat legacy `crowd` never did. */
const CROWD_TRAJECTORY_CLAIM_TYPES: ReadonlySet<string> = new Set<string>(["crowd.trajectory"]);

/**
 * The scalar inside a claim value. Production writes an object (`{level}` /
 * `{trajectory}`); legacy flat rows and some callers carry a bare string.
 */
function claimScalar(value: unknown, key: string): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/** Own-property lookup only — an inherited key ("toString") is not a claim value. */
function lookupMapped<V>(table: Record<string, V>, key: string | null): V | undefined {
  if (key === null) return undefined;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Map a crowd-level claim onto §7's Activity vocabulary. Returns undefined for
 * anything unrecognised — an unmapped value must not become "moderate" — and for
 * a value deliberately withheld from this axis (see CROWD_LEVEL_TO_ACTIVITY).
 */
export function crowdValueToActivity(c: LiveClaimLike): ActivityLevel | undefined {
  if (!CROWD_LEVEL_CLAIM_TYPES.has(c.claimType)) return undefined;
  return lookupMapped(CROWD_LEVEL_TO_ACTIVITY, claimScalar(c.value, "level")) ?? undefined;
}

/**
 * Map a crowd-trajectory claim onto §7's Trend vocabulary — the producer that
 * did not exist. mapAggregation.aggregateTrend reads `o.trend` off contributors
 * and nothing anywhere wrote it, so §6's pulsing outline, §8's "Trend ↑ Up" row
 * and §38's "one area cooling" had no seed at all. Same fail-closed contract as
 * the activity mapper: unrecognised ⇒ undefined, never a default "stable".
 */
export function crowdValueToTrend(c: LiveClaimLike): TrendState | undefined {
  if (!CROWD_TRAJECTORY_CLAIM_TYPES.has(c.claimType)) return undefined;
  return lookupMapped(TRAJECTORY_TO_TREND, claimScalar(c.value, "trajectory")) ?? undefined;
}

/** The subject id a live claim would be keyed by, or null if this kind has none. */
export function liveSubjectIdFor(obj: MapObject): string | null {
  const [kind, rest] = obj.id.split(":", 2);
  if (!rest) return null;

  // A GEM'S SUBJECT IS ITS CANONICAL PLACE, NOT ITS OWN ID.
  //
  // The live-claim store keys on places(id); a gem id is a hidden_gems id.
  // Returning `rest` here meant every gem enrichment queried an id space the
  // snapshot table does not use, so the join silently returned nothing for the
  // life of this function. A gem with no canonical place has NO live subject —
  // null, not a mismatched id, because a wrong subject would eventually match
  // somebody else's place.
  if (kind === "gem") {
    const canonical = (obj.payload as { canonicalPlaceId?: unknown } | undefined)?.canonicalPlaceId;
    return typeof canonical === "string" && canonical.length > 0 ? canonical : null;
  }

  // Only place-like objects carry live claims today.
  return kind === "place" ? rest : null;
}

/**
 * I/O wrapper. `read` is injected so the route supplies the real
 * `readLiveClaims` and tests supply a fake — this module stays DB-free.
 *
 * `opts.evidence` is the §9/Table 7 contextual-evidence resolver: given a
 * subject object it returns the event-adjacency / qualified-media bundle that
 * `applyLiveClaims` appends to the provenance panel. It is PURE and injected for
 * the same reason `read` is — the route derives event-adjacency from the events
 * it already loaded, and tests supply a fake — and it is only ever consulted for
 * a subject that actually has claims, so it can never manufacture a panel.
 */
export async function enrichWithLiveClaims(
  objects: MapObject[],
  read: (subjectId: string) => Promise<readonly LiveClaimLike[]>,
  opts: {
    max?: number;
    now?: number;
    evidence?: (obj: MapObject) => MapClaimEvidence | null | undefined;
  } = {},
): Promise<LiveEnrichmentResult> {
  const max = opts.max ?? LIVE_ENRICHMENT_MAX_SUBJECTS;
  const now = opts.now ?? Date.now();

  const eligible: number[] = [];
  objects.forEach((o, i) => {
    if (liveSubjectIdFor(o) !== null) eligible.push(i);
  });

  const take = eligible.slice(0, Math.max(0, max));
  const out = objects.slice();
  let enriched = 0;

  await Promise.all(
    take.map(async (i) => {
      const subjectId = liveSubjectIdFor(out[i]);
      if (!subjectId) return;
      let claims: readonly LiveClaimLike[] = [];
      try {
        claims = await read(subjectId);
      } catch {
        // Fail-closed: an unreadable claim is no claim, never a stale one.
        return;
      }
      if (claims.length === 0) return;
      // Contextual evidence is derived only for a subject that HAS claims — the
      // panel it appends to must already exist. A throwing resolver must not
      // cost the subject its live claims, so it fails soft to "no evidence".
      let evidence: MapClaimEvidence | null | undefined;
      if (opts.evidence) {
        try {
          evidence = opts.evidence(out[i]);
        } catch {
          evidence = null;
        }
      }
      out[i] = applyLiveClaims(out[i], claims, now, evidence);
      enriched += 1;
    }),
  );

  return {
    objects: out,
    considered: eligible.length,
    enriched,
    skipped: Math.max(0, eligible.length - take.length),
  };
}

// ── Viewport parsing (spec §17, §31) ──────────────────────────────────────────

/**
 * Viewport bounds. Re-exported from lib/mapAggregation so the whole map stack
 * has ONE bbox type: two spellings of the same rectangle is exactly the drift
 * that produces a west/east transposition nobody notices until a viewport is
 * silently mirrored.
 */
export type { BBox } from "./mapAggregation.js";

/**
 * Parse `bbox=w,s,e,n`. Returns null for anything malformed, out of range, or
 * inverted — a bad viewport must be an error, never a silently-widened one.
 *
 * Antimeridian-crossing viewports (w > e) are rejected rather than
 * misinterpreted: the radius-based sources underneath cannot express one, and
 * silently splitting it would return a different area than the caller asked for.
 */
export function parseBbox(raw: unknown): BBox | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  if (south >= north || west >= east) return null;
  return { west, south, east, north };
}

/** The bbox centre, and the radius that covers its corner. */
export function bboxToCenterRadius(b: BBox): { lat: number; lng: number; radiusKm: number } {
  const lat = (b.south + b.north) / 2;
  const lng = (b.west + b.east) / 2;
  // Half-diagonal in km: latitude is ~111 km/deg; longitude shrinks with cos(lat).
  const latKm = ((b.north - b.south) / 2) * KM_PER_DEGREE_LAT;
  const lngKm =
    ((b.east - b.west) / 2) * KM_PER_DEGREE_LAT * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const radiusKm = Math.sqrt(latKm * latKm + lngKm * lngKm);
  // Clamp to the range the underlying sources accept.
  return { lat, lng, radiusKm: Math.min(200, Math.max(1, radiusKm)) };
}

/** Parse `kinds=place,event,...` against the contract's closed set. */
export function parseKinds(raw: unknown): MapObjectKind[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const known = new Set<string>(MAP_OBJECT_KINDS);
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s)) as MapObjectKind[];
  return out.length > 0 ? out : null;
}

// ── Ranking (spec §31) ────────────────────────────────────────────────────────

/**
 * Attach distance from the viewport centre and order by the §31 ladder.
 * Distance is a TIE-BREAK, not the sort key: spec §5 requires safety and active
 * navigation to outrank popularity, so priority always wins over proximity.
 */
export function rankObjects(
  objects: MapObject[],
  center: { lat: number; lng: number },
): MapObject[] {
  const withDistance = objects.map((o) => {
    const c = centerOf(o);
    return {
      ...o,
      distanceKm: c ? Number(haversineKm(center.lat, center.lng, c.lat, c.lng).toFixed(2)) : null,
    };
  });
  return withDistance.sort(compareByRenderingPriority);
}

function centerOf(o: MapObject): { lat: number; lng: number } | null {
  const g = o.geometry;
  if (!g) return null;
  if (g.type === "Point") {
    const [lng, lat] = g.coordinates;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sLat = 0, sLng = 0, n = 0;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const [lng, lat] = p;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    sLat += lat; sLng += lng; n += 1;
  }
  return n === 0 ? null : { lat: sLat / n, lng: sLng / n };
}

/** The final gate before serialization — drops anything §39/§23 says must not render. */
export function servableOnly(objects: (MapObject | null | undefined)[]): MapObject[] {
  return objects.filter((o): o is MapObject => isServable(o));
}

/** Restrict to the requested kinds; an empty/absent list means "all". */
export function filterKinds(
  objects: MapObject[],
  kinds: readonly MapObjectKind[] | null | undefined,
): MapObject[] {
  if (!kinds || kinds.length === 0) return objects;
  const want = new Set(kinds);
  return objects.filter((o) => want.has(o.kind));
}

// ── Pagination (mirrors lib/mapSearch's opaque offset cursor) ─────────────────

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(String(cursor), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function paginate(
  objects: MapObject[],
  cursor: string | null | undefined,
  limit: number,
): { page: MapObject[]; nextCursor: string | null } {
  const off = decodeCursor(cursor);
  const lim = Math.min(200, Math.max(1, limit));
  const page = objects.slice(off, off + lim);
  const next = off + lim;
  return { page, nextCursor: next < objects.length ? String(next) : null };
}

// ── §10 Crowd Flow: the zone model the producer refuses to invent ─────────────

/**
 * lib/crowdFlowProducer takes its zone identity from the CALLER
 * (`resolveZoneId`, `resolveZoneForPoint`, `zoneCentroids`) and, without them,
 * produces nothing rather than falling back to a coordinate. This section is
 * that model, built from `geo_zones` — the repository's only curated,
 * server-owned table of named areas with real geometry (migration 0034;
 * migration 2159 revoked every client write grant, so a row here is
 * server-curated by construction and a user cannot plant one).
 *
 * WHAT A ZONE ID IS HERE, STATED ONCE
 * ===================================
 * `geo_zones.id`. Every endpoint of every hop resolves into that ONE id space,
 * by one of three doors, so two families can meet on the same edge:
 *
 *   route stop coordinate  → the zone that CONTAINS it   (accepted_plan)
 *   origin place id        → the zone containing the PLACE (next_stop_contribution)
 *   destination area label → the zone whose NAME it is    (next_stop_contribution)
 *
 * A coordinate is used only to ASK which zone contains it; what comes back is
 * an id, and `FlowZone` has no field that could carry the point onward. An
 * endpoint that resolves to no zone is dropped by the producer — there is no
 * "approximate it to the point" branch anywhere in this file.
 *
 * THREE RULES THAT ARE TIGHTENINGS, NOT GATES
 * ===========================================
 * None of §10's four gates lives here (MIN_SIGNAL_FAMILIES, the k floor,
 * maxGroupShare and the freshness bound are all in lib/mapAggregation and
 * lib/privacyGate, unchanged). These three only ever shrink what resolves:
 *
 *   1. COARSE TYPES ONLY. `zone_type` must be one of FLOW_ZONE_TYPES. A `venue`
 *      zone is a building; publishing "people are moving from THAT building" is
 *      the place-level precision §10 forbids for origins.
 *   2. AN EXTENT FLOOR. A zone smaller than MIN_FLOW_ZONE_EXTENT_METERS across
 *      is refused however it is labelled, so a mis-typed 20 m "neighborhood"
 *      cannot make a flow endpoint as sharp as a coordinate.
 *   3. AMBIGUOUS NAMES RESOLVE TO NOTHING. Two zones sharing a name (a
 *      "Downtown" in two cities) would merge two geographies into one edge and
 *      publish one of their centroids for both. A name held by more than one
 *      zone therefore resolves to null rather than to a guess.
 *
 * WHEN A POINT FALLS IN SEVERAL ZONES the SMALLEST wins — a neighbourhood
 * inside a city resolves to the neighbourhood. Taking the largest would be the
 * "safer-looking" choice and is in fact the useless one: every intra-city hop
 * would collapse to a self-transition and the layer would publish nothing
 * forever. Rule 2 is what makes the smallest-wins choice safe, because it
 * bounds how sharp the smallest can be.
 */
export const FLOW_ZONE_TYPES: readonly string[] = ["city", "neighborhood"];

/** Narrowest a flow zone may be, across its widest axis. See rule 2 above. */
export const MIN_FLOW_ZONE_EXTENT_METERS = 250;

export type FlowZoneShape =
  | { kind: "circle"; center: { lat: number; lng: number }; radiusMeters: number }
  | { kind: "polygon"; ring: Position[] };

/**
 * One resolvable area. Note what is NOT here: no address, no member list, and —
 * for a polygon — no way to recover any point that was tested against it. The
 * only coordinate a `FlowZone` carries is its own published centroid.
 */
export interface FlowZone {
  id: string;
  /** Normalized name, for `destination_area` matching. */
  nameKey: string;
  /** The point a flow endpoint is drawn at. Never a person, never a place. */
  centroid: { lat: number; lng: number };
  /** Widest axis, in metres. Used for the floor and for smallest-wins. */
  extentMeters: number;
  shape: FlowZoneShape;
}

/** Case- and whitespace-insensitive area name key. Null when unusable. */
export function normalizeAreaName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().replace(/\s+/g, " ").toLowerCase();
  return k === "" ? null : k;
}

function ringOf(polygonGeojson: unknown): Position[] | null {
  const raw = Array.isArray(polygonGeojson)
    ? polygonGeojson
    : polygonGeojson && typeof polygonGeojson === "object"
      ? (polygonGeojson as any).coordinates
      : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  // Either a GeoJSON Polygon (array of rings) or a bare ring.
  const ring = Array.isArray(raw[0]) && Array.isArray((raw as any)[0][0]) ? (raw as any)[0] : raw;
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const out: Position[] = [];
  for (const pos of ring) {
    if (!Array.isArray(pos) || pos.length < 2) return null;
    const [lng, lat] = pos as [unknown, unknown];
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    out.push([lng, lat]);
  }
  return out;
}

/** Widest axis of a ring's bounding box, in metres. */
function ringExtentMeters(ring: readonly Position[]): number {
  let minLat = ring[0][1], maxLat = ring[0][1], minLng = ring[0][0], maxLng = ring[0][0];
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return haversineKm(minLat, minLng, maxLat, maxLng) * 1000;
}

/**
 * `geo_zones` rows → resolvable zones. Anything that fails a rule above is
 * DROPPED, not repaired: a zone we cannot describe honestly must not be able to
 * anchor a published flow.
 */
export function parseFlowZones(rows: readonly any[] | null | undefined): FlowZone[] {
  if (!Array.isArray(rows)) return [];
  const out: FlowZone[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    if (!FLOW_ZONE_TYPES.includes(String(row.zone_type))) continue;
    const nameKey = normalizeAreaName(row.name);
    if (!nameKey) continue;

    const ring = ringOf(row.polygon_geojson);
    if (ring) {
      const centroid = centroidOf({ type: "Polygon", coordinates: [ring] });
      if (!centroid) continue;
      const extentMeters = ringExtentMeters(ring);
      if (!(extentMeters >= MIN_FLOW_ZONE_EXTENT_METERS)) continue;
      out.push({ id: row.id, nameKey, centroid, extentMeters, shape: { kind: "polygon", ring } });
      continue;
    }

    const lat = Number(row.center_lat);
    const lng = Number(row.center_lng);
    const radiusMeters = Number(row.radius_meters);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMeters)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    // Diameter, so the floor means the same thing for both shapes.
    const extentMeters = radiusMeters * 2;
    if (!(extentMeters >= MIN_FLOW_ZONE_EXTENT_METERS)) continue;
    out.push({
      id: row.id,
      nameKey,
      centroid: { lat, lng },
      extentMeters,
      shape: { kind: "circle", center: { lat, lng }, radiusMeters },
    });
  }
  return out;
}

/**
 * Containment, delegated to lib/protectedLocations.zoneCovers — the ONE
 * point-in-zone implementation this repository has. Reusing it is not tidiness:
 * it means a flow zone and a §24 protection zone can never disagree about
 * whether a point is inside a shape, which is exactly the kind of divergence
 * that would let a flow anchor somewhere the protection gate thought it had
 * covered. Only the geometry fields are read; `category` is required by that
 * module's type, is inert for `zoneCovers`, and carries no protection meaning
 * here. A zone whose geometry it calls unusable covers nothing — the endpoint
 * is then unresolvable and the hop is dropped.
 */
export function flowZoneContains(zone: FlowZone, lat: number, lng: number): boolean {
  const shaped: ProtectedZone =
    zone.shape.kind === "circle"
      ? {
          id: zone.id,
          category: "flow_zone_geometry_only",
          shape: "circle",
          center: zone.shape.center,
          radiusMeters: zone.shape.radiusMeters,
        }
      : { id: zone.id, category: "flow_zone_geometry_only", shape: "polygon", ring: zone.shape.ring };
  return zoneCovers(shaped, [[lng, lat]]) === true;
}

/** Smallest containing zone, or null. Ties broken by id so the answer is stable. */
function zoneForPoint(zones: readonly FlowZone[], lat: number, lng: number): string | null {
  let best: FlowZone | null = null;
  for (const z of zones) {
    if (!flowZoneContains(z, lat, lng)) continue;
    if (
      !best ||
      z.extentMeters < best.extentMeters ||
      (z.extentMeters === best.extentMeters && z.id < best.id)
    ) {
      best = z;
    }
  }
  return best ? best.id : null;
}

/**
 * places → the zone each one sits in.
 *
 * This is how a `next_stop_contribution` gets an ORIGIN. The producer reads
 * `intel_observations.subject_id` (a PLACE, chosen by the contributor when they
 * answered the prompt) and hands it here as `origin_place`; what it gets back is
 * a zone id. A place's coordinate is public geography, not a person's position,
 * and it does not survive this call: the returned map holds ids only.
 */
export function indexPlaceZones(
  rows: readonly any[] | null | undefined,
  zones: readonly FlowZone[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(rows) || zones.length === 0) return out;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const zoneId = zoneForPoint(zones, lat, lng);
    if (zoneId) out.set(row.id, zoneId);
  }
  return out;
}

export interface FlowZoneModel {
  zones: readonly FlowZone[];
  /** What `deriveZoneTransitions` needs: zone id → the centroid it draws. */
  centroids: Map<string, { lat: number; lng: number }>;
  resolveZoneForPoint: (p: { lat: number; lng: number }) => string | null;
  resolveZoneId: (kind: "origin_place" | "destination_area", key: string) => string | null;
  /** Names dropped for being held by more than one zone. COUNT only. */
  ambiguousNames: number;
  /** Places that resolved into a zone. */
  indexedPlaces: number;
}

/**
 * Assemble the resolvers the producer requires. Pure: rows have already been
 * read and parsed, nothing here queries.
 *
 * Every door fails closed. An unknown name, an unindexed place, a point in no
 * zone and an empty model all return null, and null means the producer drops
 * the hop.
 */
export function buildFlowZoneModel(
  zones: readonly FlowZone[],
  placeZones: ReadonlyMap<string, string> = new Map(),
): FlowZoneModel {
  const centroids = new Map<string, { lat: number; lng: number }>();
  for (const z of zones) centroids.set(z.id, z.centroid);

  // Ambiguity is resolved by REFUSAL, not by preference. See rule 3.
  const byName = new Map<string, string | null>();
  for (const z of zones) {
    byName.set(z.nameKey, byName.has(z.nameKey) ? null : z.id);
  }
  let ambiguousNames = 0;
  for (const v of byName.values()) if (v === null) ambiguousNames += 1;

  return {
    zones,
    centroids,
    resolveZoneForPoint: (p) => {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
      return zoneForPoint(zones, p.lat, p.lng);
    },
    resolveZoneId: (kind, key) => {
      if (typeof key !== "string" || key === "") return null;
      if (kind === "origin_place") return placeZones.get(key) ?? null;
      const nameKey = normalizeAreaName(key);
      if (!nameKey) return null;
      return byName.get(nameKey) ?? null;
    },
    ambiguousNames,
    indexedPlaces: placeZones.size,
  };
}

/**
 * §24 for crowd flow: inside a protected zone a flow is WITHHELD, never
 * coarsened.
 *
 * `applyProtection` still runs over these objects afterwards and is still the
 * gate; this only removes the one outcome that would be wrong for this kind.
 * `coarsenForZone` strips an object's `count`, `observedAt` and `freshness`
 * because "how busy is the clinic right now" is the disclosure — but a
 * `crowd_flow` restates exactly those three inside `payload.observed`
 * (cohortSize, observedAt), which coarsening does not touch, and its geometry
 * is a LineString, which coarsening deliberately leaves alone. A coarsened flow
 * would therefore keep everything coarsening exists to remove. There is also no
 * honest coarser version of it to fall back to: the geometry is already zone
 * centroids. So the answer for this kind is to withhold, which is a tightening
 * of the existing decision and changes no policy, category or constant.
 *
 * Returns the surviving objects and a COUNT — never which zone, never which
 * flow, for the reason `ProtectionReport` gives.
 */
export function withholdCoarsenableFlows(
  objects: readonly MapObject[],
  zones: readonly ProtectedZone[] | null | undefined,
): { objects: MapObject[]; withheld: number } {
  if (!Array.isArray(objects) || objects.length === 0) return { objects: [], withheld: 0 };
  if (!Array.isArray(zones) || zones.length === 0) return { objects: [...objects], withheld: 0 };
  const kept: MapObject[] = [];
  let withheld = 0;
  for (const obj of objects) {
    if (obj.kind !== "crowd_flow") {
      kept.push(obj);
      continue;
    }
    if (classifyAgainstProtected(obj, zones).action === "allow") {
      kept.push(obj);
      continue;
    }
    withheld += 1;
  }
  return { objects: kept, withheld };
}

// ── shared ────────────────────────────────────────────────────────────────────

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}
