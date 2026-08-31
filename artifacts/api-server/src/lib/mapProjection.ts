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
  type PrivacyClass,
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  compareByRenderingPriority,
  deriveFreshness,
  isServable,
  mayRenderIdentity,
  point,
} from "./mapObjects.js";
import { haversineKm } from "./mapSearch.js";
import { KM_PER_DEGREE_LAT, type BBox } from "./mapAggregation.js";

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
      thumbnailUrl: g.thumbnail_url ?? null,
      verificationLevel: g.verification_level ?? null,
      coordsPrecision: g.coordsPrecision ?? null,
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

/** The subset of `readLiveClaims`' envelope this module consumes. */
export interface LiveClaimLike {
  id: string;
  claimType: string;
  value: unknown;
  confidence: number | null;
  band: ConfidenceState;
  sourceCountBucket: "few" | "several" | "many";
  observedAt: string;
  validUntil: string;
  state: string;
}

/**
 * Pure: fold one subject's live claims onto its object. Exported separately from
 * the I/O wrapper so the merge rules are testable without a database.
 *
 * Never upgrades: if the claims are empty the object is returned untouched, and
 * a claim can only ever ADD freshness/confidence/activity, never overwrite a
 * value the source already asserted with a weaker one.
 */
export function applyLiveClaims(
  obj: MapObject,
  claims: readonly LiveClaimLike[],
  now: number = Date.now(),
): MapObject {
  if (!claims || claims.length === 0) return obj;

  // readLiveClaims already orders best/current first.
  const primary = claims[0];
  const freshness = deriveFreshness(primary.observedAt, primary.validUntil, now);

  const lines: MapProvenanceLine[] = claims.map((c) => ({
    text: describeClaim(c),
    ref: c.id,
  }));

  return {
    ...obj,
    observedAt: primary.observedAt,
    expiresAt: primary.validUntil,
    freshness,
    confidence: primary.band,
    activity: crowdValueToActivity(primary),
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

/**
 * A human evidence line for the §9 Why? panel. Uses only the coarse cohort
 * bucket — the exact contributor count is the privacy parameter itself and
 * never crosses the wire (see liveClaimRead's envelope contract).
 */
function describeClaim(c: LiveClaimLike): string {
  const cohort =
    c.sourceCountBucket === "many"
      ? "Many recent traveler reports"
      : c.sourceCountBucket === "several"
        ? "Several recent traveler reports"
        : "A few recent traveler reports";
  return `${cohort} · ${c.claimType}`;
}

/**
 * Map a crowd claim's value onto §7's activity vocabulary. Returns undefined for
 * anything unrecognised — an unmapped value must not become "moderate".
 */
export function crowdValueToActivity(c: LiveClaimLike): ActivityLevel | undefined {
  if (c.claimType !== "crowd") return undefined;
  const v = typeof c.value === "string" ? c.value : (c.value as any)?.level;
  switch (v) {
    case "very_quiet":
    case "quiet":
    case "moderate":
    case "busy":
    case "very_busy":
    case "peak":
      return v;
    default:
      return undefined;
  }
}

/** The subject id a live claim would be keyed by, or null if this kind has none. */
export function liveSubjectIdFor(obj: MapObject): string | null {
  const [kind, rest] = obj.id.split(":", 2);
  if (!rest) return null;
  // Only place-like objects carry live claims today.
  return kind === "gem" || kind === "place" ? rest : null;
}

/**
 * I/O wrapper. `read` is injected so the route supplies the real
 * `readLiveClaims` and tests supply a fake — this module stays DB-free.
 */
export async function enrichWithLiveClaims(
  objects: MapObject[],
  read: (subjectId: string) => Promise<readonly LiveClaimLike[]>,
  opts: { max?: number; now?: number } = {},
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
      out[i] = applyLiveClaims(out[i], claims, now);
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

// ── shared ────────────────────────────────────────────────────────────────────

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}
