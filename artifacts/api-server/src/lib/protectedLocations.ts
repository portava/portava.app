/**
 * protectedLocations — Map spec §24, "Protected Location and Safety Rules".
 *
 * The spec, in full:
 *
 *   "Suppress sensitive locations before data reaches the client.
 *    Protected examples may include private residences, medical facilities,
 *    shelters, sensitive government locations and policy-defined protected
 *    zones. Safety and access warnings take precedence over activity ranking.
 *    The public map should never receive more location detail than the viewer
 *    is authorized to see."
 *
 * "BEFORE DATA REACHES THE CLIENT" IS THE WHOLE REQUIREMENT.
 * =========================================================
 * This cannot be a render-time filter. By the time the renderer decides not to
 * draw a pin, the coordinate has already been serialized into a JSON response,
 * sat in a client cache, and — for anyone watching the wire — been disclosed.
 * So this runs server-side, inside the projection, as the LAST gate before
 * serialization, after ranking and after aggregation. §19's pipeline reads:
 *
 *   Canonical Systems → Map Projection Service → Map Objects → Map Ranking
 *     → Privacy / Eligibility → Viewport Aggregation → Mobile Renderer
 *
 * and this module is the final clause of "Privacy / Eligibility" re-applied at
 * the boundary: whatever any upstream source decided, an object standing inside
 * a protected zone does not leave the server at full precision.
 *
 * WHY IT IS PURE.
 * The policy rows are PASSED IN. This module performs no I/O, reads no clock,
 * and holds no cache, so the route (or the lead) decides how protected_zones is
 * loaded and cached, and every rule below is unit-testable against a literal
 * array. Migration 2217 defines the table; nothing here talks to it.
 *
 * WHAT ALREADY EXISTED, AND WHAT DID NOT.
 * A search of the server found NO protected-place concept to extend. The
 * closest neighbours are all narrower and none of them is a location gate:
 *
 *   • services/passport/PassportPrivacyGuard.ts blurs hotel/home/private_stay
 *     STAMPS by nulling `neighborhood` and `place_id` — a per-row field blank on
 *     one surface, keyed off the stamp's own `source_type`. It has no geometry,
 *     no zone concept, and never sees a MapObject.
 *   • lib/privacyGate.ts has a `sensitiveSubject` flag, but that is a property
 *     of an AGGREGATE's subject matter, asserted by the caller — not a place.
 *   • lib/locationPurposes.ts registers WHY coordinates may be processed. It
 *     governs retention and lawful basis, not what may be drawn.
 *   • services/location/LocationSafetyService.ts is anti-spoof detection
 *     (impossible speed, coordinate jumps). Unrelated despite the name.
 *   • plan_geofences / geo_zones (migrations 0035, 0039, 2143) are TRIP
 *     geofences — enter/exit/dwell triggers scoped to a trip's members. They
 *     are a notification mechanism, not a suppression policy, and their RLS is
 *     trip-member-scoped, which is exactly wrong for a global policy table.
 *
 * So this is new, and it is deliberately generic in the same way privacyGate.ts
 * is: it takes zones and objects, so any surface that emits MapObjects can
 * route through the one gate rather than growing a second, looser one.
 *
 * FAIL-CLOSED, EVERY BRANCH.
 * An object whose geometry cannot be parsed is suppressed — we cannot prove it
 * is outside a zone. A zone whose geometry cannot be parsed suppresses instead
 * of being skipped: a malformed policy row must never silently become a no-op,
 * because a silently-skipped shelter row is a privacy incident while an
 * over-suppressing one is a visible, recoverable outage. That is the same trade
 * routes/mapProjection.ts already makes with `fetchBlockedSet`: "if it cannot be
 * read, nobody is returned."
 */
import {
  centroidOf,
  isServable,
  narrowestPrivacyClass,
  precisionRank,
  KIND_DEFAULT_PRIORITY,
  type MapGeometry,
  type MapObject,
  type MapObjectKind,
  type Position,
  type PrivacyClass,
} from "./mapObjects.js";

// ── Categories (spec §24's named examples + the escape hatch) ─────────────────

export const PROTECTED_CATEGORIES = [
  "private_residence",
  "medical_facility",
  "shelter",
  "sensitive_government",
  "policy_defined",
] as const;
export type ProtectedCategory = (typeof PROTECTED_CATEGORIES)[number];

export function isProtectedCategory(v: unknown): v is ProtectedCategory {
  return typeof v === "string" && (PROTECTED_CATEGORIES as readonly string[]).includes(v);
}

// ── Actions ──────────────────────────────────────────────────────────────────

export const PROTECTION_ACTIONS = ["allow", "coarsen", "suppress"] as const;
export type ProtectionAction = (typeof PROTECTION_ACTIONS)[number];

/** Higher = more restrictive. Combining actions may only ever move UP. */
export function actionRank(a: ProtectionAction): number {
  return PROTECTION_ACTIONS.indexOf(a);
}

export function mostRestrictiveAction(a: ProtectionAction, b: ProtectionAction): ProtectionAction {
  return actionRank(a) >= actionRank(b) ? a : b;
}

function isProtectionAction(v: unknown): v is ProtectionAction {
  return typeof v === "string" && (PROTECTION_ACTIONS as readonly string[]).includes(v);
}

/**
 * PER-CATEGORY ACTION — and why each one is what it is.
 * =====================================================
 * The question that decides SUPPRESS vs COARSEN is not "how sensitive does this
 * sound". It is:
 *
 *     Is the ZONE'S OWN EXISTENCE AND POSITION the disclosure,
 *     or only the object's precision WITHIN it?
 *
 * If the zone is itself the secret, coarsening is worthless — snapping an object
 * to the middle of a shelter still publishes the shelter. Only absence protects
 * it. If the zone is public knowledge (a hospital is on every map ever printed),
 * then what needs hiding is the association between a person or an activity and
 * that place, and coarsening is both sufficient and much better for the user.
 *
 * Getting this backwards is the failure that matters. Coarsening a shelter is a
 * safety incident dressed as compliance; suppressing every hospital deletes the
 * emergency room from a traveler's map in the exact moment they need it, which
 * §24's own "safety and access warnings take precedence" sentence forbids.
 *
 *   private_residence   → SUPPRESS. The canonical doxxing vector: a map object
 *                         standing at a private home publishes where a specific
 *                         person lives. There is no useful coarsening — the
 *                         building footprint IS the house, and the object's own
 *                         title ("Anna's place") re-leaks it anyway. Absence is
 *                         the only honest answer.
 *   medical_facility    → COARSEN. Hospitals and clinics are public
 *                         infrastructure and safety-relevant wayfinding; hiding
 *                         them harms travelers. The sensitive fact is not "there
 *                         is a clinic here", it is "this person / this crowd is
 *                         at the clinic". So the PLACE survives and every
 *                         signal that could carry a person or a live crowd
 *                         reading is stripped (see coarsenForZone). Note the
 *                         escalation below: presence-bearing objects inside a
 *                         coarsen zone are suppressed outright, because for them
 *                         the association is the disclosure.
 *   shelter             → SUPPRESS. Domestic-violence, homelessness and refugee
 *                         shelters are protected BY their address not being
 *                         known. Their presence on the map is the disclosure and
 *                         the harm is physical. Never coarsen, never emit.
 *   sensitive_government→ SUPPRESS. Safe houses, secure and restricted sites.
 *                         Several jurisdictions make publication itself
 *                         unlawful, and a coarse pin is still a pin. A civic
 *                         building that is not sensitive simply never gets a row
 *                         in protected_zones — registration is the policy
 *                         decision, and this module honours it literally.
 *   policy_defined      → SUPPRESS unless the ROW says otherwise. This is the
 *                         escape hatch for jurisdiction-specific rules the code
 *                         cannot anticipate, so it is the one category whose
 *                         zone-declared `action` is taken as written rather than
 *                         only allowed to tighten — the row IS the policy. A
 *                         policy_defined row that forgets to declare an action
 *                         has declared nothing, so it suppresses.
 */
export const CATEGORY_ACTION: Record<ProtectedCategory, ProtectionAction> = {
  private_residence: "suppress",
  medical_facility: "coarsen",
  shelter: "suppress",
  sensitive_government: "suppress",
  policy_defined: "suppress",
};

/**
 * The most precision a coarsened object may retain inside a zone of this
 * category. Applied through `narrowestPrivacyClass`, so it can only ever
 * tighten what the source already decided.
 *
 * Suppress-class categories are floored at `none` as defence in depth: `none`
 * is the rung `isServable()` refuses to serialize, so if a future caller ever
 * routes a suppress-class object down the coarsen path by mistake, the object
 * still cannot cross the wire.
 */
export const CATEGORY_PRIVACY_FLOOR: Record<ProtectedCategory, PrivacyClass> = {
  private_residence: "none",
  medical_facility: "approximate",
  shelter: "none",
  sensitive_government: "none",
  policy_defined: "approximate",
};

// ── Kind policy ──────────────────────────────────────────────────────────────

/**
 * §24: "Safety and access warnings take precedence over activity ranking."
 *
 * A safety notice is the one thing on the map that exists to keep someone out of
 * harm, so the protection filter must not outrank it. It passes through
 * untouched — geometry, priority (RENDERING_PRIORITY.safety) and all — and is
 * counted separately in the report so the exemption is observable rather than
 * invisible.
 *
 * THE RESIDUAL RISK, STATED. An exemption is a laundering channel: anything
 * labelled `safety_notice` bypasses this gate. Two things bound it, and both
 * are properties of the caller, not of this module: `safety_notice` objects are
 * minted by the server's own safety pipeline (never from user-submitted
 * content), and they carry no presence payload. If either stops being true, the
 * exemption must be narrowed here rather than patched at the route.
 */
export const PROTECTION_EXEMPT_KINDS: readonly MapObjectKind[] = ["safety_notice"];

/**
 * Objects that assert a PERSON is (or was) somewhere, visible to people who
 * have no relationship to that person. Inside ANY protected zone these are
 * suppressed rather than coarsened, because for them the disclosure is the
 * ASSOCIATION, not the coordinate: "someone is at the medical facility" is the
 * sensitive fact, and it survives every amount of coordinate blurring.
 *
 * `memory` is here even though it is drawn for its OWNER ALONE, and that is the
 * point worth stating: owner-onlyness is NOT the test this list applies. A
 * memory is a VENUE-level pin whose title is the venue's own name, so a
 * coarsened memory snapped to the zone anchor still reads "you have a history
 * with this clinic" — the association is the whole object, and blurring the
 * coordinate removes nothing.
 *
 * §36 PHASE 7's `personal_city` IS DELIBERATELY NOT HERE, and this was decided
 * rather than overlooked (an omitted kind in a per-kind table is how the
 * `prediction` hole reached the wire). It cannot make the assertion this list
 * escalates on: its geometry is a CITY CENTROID, its title is the city's label
 * and its payload carries a cityKey, a country and the viewer's own stamp
 * count. The association it publishes is with a CITY, never with a place inside
 * one, so there is no place-association for coarsening to fail to remove — and
 * "you have been to Da Nang" is not a fact any protected zone exists to
 * withhold. It is also the viewer's own history shown to the viewer, the same
 * ground on which it is absent from `COARSEN_UNSAFE_KINDS` below.
 *
 * It still takes the zone's OWN action, so inside a suppress-class zone it is
 * withheld like anything else. src/test/mapWorldIntelligenceLayer.test.ts
 * ("personal_city is deliberately NOT an ambient-presence kind either") holds
 * both halves by execution, and pins the city-centroid shape the decision rests
 * on: if `personal_city` ever acquires a venue, this ruling expires.
 */
export const AMBIENT_PRESENCE_KINDS: readonly MapObjectKind[] = [
  "social_zone",
  "buddy_zone",
  "memory",
];

/**
 * Kinds for which COARSENING IS NOT A WEAKER DISCLOSURE — it is the same one.
 *
 * `coarsenForZone` deletes TOP-LEVEL fields (`count`, `observedAt`, `freshness`,
 * `provenance`, `sourceRefs`) and snaps a Point to the zone anchor. Both of
 * these kinds restate exactly those facts one level down, inside `payload`,
 * which coarsening does not descend into:
 *
 *   • `crowd_flow` carries `payload.observed.{cohortSize, observedAt}`, and its
 *     geometry is a LineString between zone centroids, which coarsening
 *     deliberately leaves alone. A coarsened flow keeps everything coarsening
 *     exists to remove.
 *   • `prediction` carries `payload.{cohort, predictedFor}` for a plan cohort —
 *     "20 people are due to arrive at this clinic at 13:00" survives the
 *     deletion of the top-level `count` untouched — and for the event and
 *     itinerary sources it carries `payload.{eventId, stopId, locationName}`,
 *     back-references that re-sharpen the very coordinate the anchor snap just
 *     blurred. §37 makes this worse rather than better: the object is labelled
 *     a forecast, so it publishes a FUTURE association with the protected place
 *     to a viewer who is watching it happen.
 *
 * And there is no honest coarser version of either to fall back to: a flow's
 * geometry is already zone-level, and a prediction with its payload removed is
 * an unattributable pin that asserts nothing. So inside a coarsen-class zone
 * these are SUPPRESSED. This only ever tightens.
 *
 * THE §36 PHASE 7 AGGREGATE KINDS ARE HERE FOR THE SAME REASON. Each restates
 * inside its own `payload` exactly the facts `coarsenForZone` deletes at the top
 * level, and each already sits on geometry coarsening does not touch:
 *
 *   • `traveler_flow` carries `payload.{cohortBucket, observedAt}` on a
 *     LineString between city centroids.
 *   • `world_pulse` carries `payload.people.cohortBucket` and its density counts
 *     on an aggregation-cell polygon.
 *   • `city_model` carries `payload.rhythm`, a per-time-band activity reading,
 *     on a city centroid.
 *
 * `personal_city` is DELIBERATELY NOT here, on the same grounds as the
 * relationship-gated kinds below: it is the viewer's own history shown to the
 * viewer, it asserts nothing about who is at the protected place, and coarsening
 * exists to protect other people rather than the reader from themselves. It
 * still takes the zone's own action, so inside a SUPPRESS-class zone it is
 * withheld like anything else.
 *
 * ONE POLICY, NOT TWO. `classifyAgainstProtected` escalates on this table and
 * `mapProjection.withholdCoarsenableAggregates` filters on it, so a route that
 * calls the gate directly and a route that pre-filters cannot disagree. The
 * pre-filter is a reporting convenience (it lets the crowd-flow producer report
 * its own withheld count); the escalation below is what makes the gate correct
 * for a caller that forgets it — which is exactly how the prediction hole got
 * in.
 */
export const COARSEN_UNSAFE_KINDS: readonly MapObjectKind[] = [
  "crowd_flow",
  "prediction",
  "traveler_flow",
  "world_pulse",
  "city_model",
];

/**
 * Deliberately NOT escalated, and this is a considered choice rather than an
 * omission. `crew_member`, `meeting_point` and `trip_stop` are relationship
 * gated by the caller — routes/mapProjection.ts only ever collects them for a
 * viewer who is already authorized to see that person. Escalating them would
 * disable "find my crew" precisely when it matters most (someone is at a
 * hospital), which trades a real safety capability for a disclosure the viewer
 * was already entitled to.
 *
 * They still follow the zone's own action, so inside a SUPPRESS-class zone they
 * are withheld: this module is pure and cannot see the viewer's authorization,
 * and §24 puts protection last. THE SEAM, NAMED SO IT IS NOT REDISCOVERED: if
 * the product later needs authorized crew visibility inside suppress-class
 * zones, the route must pass a viewer-authorization argument into
 * `classifyAgainstProtected` — do not solve it by weakening the category table.
 */
export const RELATIONSHIP_GATED_KINDS: readonly MapObjectKind[] = [
  "crew_member",
  "meeting_point",
  "trip_stop",
];

// ── Zones ────────────────────────────────────────────────────────────────────

interface ProtectedZoneBase {
  /** Opaque policy row id. SERVER-SIDE ONLY — never serialized to a client. */
  id: string;
  /** A `ProtectedCategory`; any other string is treated as unknown ⇒ suppress. */
  category: ProtectedCategory | string;
  /**
   * Optional per-row override. For every category except `policy_defined` this
   * may only TIGHTEN the category default; `policy_defined` takes it as written
   * because there the row is the policy. `'allow'` on a known category is
   * therefore inert, and migration 2217 refuses to store it at all.
   */
  action?: ProtectionAction;
  /** Optional extra tightening of the coarsening floor. Never loosens it. */
  privacyFloor?: PrivacyClass;
  /** ISO country / subdivision code the policy derives from, when applicable. */
  jurisdiction?: string;
  /** Statute, ruling or policy document this row implements. */
  policyRef?: string;
  /** Human label for operators. SERVER-SIDE ONLY — never serialized. */
  label?: string;
}

export interface ProtectedZoneCircle extends ProtectedZoneBase {
  shape: "circle";
  center: { lat: number; lng: number };
  radiusMeters: number;
}

export interface ProtectedZonePolygon extends ProtectedZoneBase {
  shape: "polygon";
  /** Closed or open linear ring, GeoJSON order: [lng, lat]. */
  ring: Position[];
}

export type ProtectedZone = ProtectedZoneCircle | ProtectedZonePolygon;

// ── Decisions ────────────────────────────────────────────────────────────────

export type ProtectionReason =
  | "no_zone_match"
  | "safety_notice_exempt"
  | "inside_protected_zone"
  | "presence_in_protected_zone"
  /** A `COARSEN_UNSAFE_KINDS` object: coarsening would not weaken it. */
  | "uncoarsenable_in_protected_zone"
  | "unparseable_object_geometry"
  | "unparseable_zone_geometry"
  | "unknown_zone_category";

export interface ProtectionDecision {
  action: ProtectionAction;
  /**
   * The zone that drove the decision. SERVER-SIDE ONLY. This is here so the
   * route can make a decision and, if it must, audit one — it is deliberately
   * absent from `ProtectionReport`, and putting it into a client response would
   * republish the exact location this module just hid.
   */
  zone?: ProtectedZone;
  reason?: ProtectionReason;
  /** Coarsening floor for the winning zone; only meaningful when action is 'coarsen'. */
  privacyFloor?: PrivacyClass;
}

// ── Geometry (hand-rolled: no turf, no new dependency) ───────────────────────

const EARTH_RADIUS_M = 6_371_000;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (normalizeLng(lng2 - lng1)) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Every position an object occupies, plus its centroid.
 *
 * Testing the centroid ALONE would let a polygon whose centroid sits outside a
 * shelter but whose edge covers it slip through, so any vertex inside a zone
 * counts as inside. Returns null when nothing usable can be read — which the
 * caller turns into a suppression, never into an allow.
 */
export function geometryPositions(geometry: MapGeometry | null | undefined): Position[] | null {
  if (!geometry || typeof geometry !== "object") return null;

  let raw: unknown[] = [];
  if (geometry.type === "Point") {
    raw = [geometry.coordinates];
  } else if (geometry.type === "Polygon") {
    const rings = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    for (const ring of rings) if (Array.isArray(ring)) raw.push(...ring);
  } else if (geometry.type === "LineString") {
    raw = Array.isArray(geometry.coordinates) ? [...geometry.coordinates] : [];
  } else {
    return null;
  }

  const out: Position[] = [];
  for (const pos of raw) {
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const [lng, lat] = pos as [unknown, unknown];
    if (!finite(lng) || !finite(lat)) continue;
    if (lat < -90 || lat > 90) continue;
    out.push([normalizeLng(lng), lat]);
  }
  if (out.length === 0) return null;

  const c = centroidOf(geometry);
  if (c) out.push([normalizeLng(c.lng), c.lat]);
  return out;
}

/**
 * Tri-state on purpose. `"unknown"` means the zone row is unusable, which is a
 * different thing from "the object is outside it" and must not collapse into
 * one — collapsing them is how a malformed policy row silently stops protecting
 * anything.
 */
export type ZoneCoverage = true | false | "unknown";

export function zoneCovers(
  zone: ProtectedZone | null | undefined,
  positions: readonly Position[],
): ZoneCoverage {
  if (!zone || typeof zone !== "object") return "unknown";
  if (!Array.isArray(positions) || positions.length === 0) return "unknown";

  if (zone.shape === "circle") {
    const c = (zone as ProtectedZoneCircle).center;
    const r = (zone as ProtectedZoneCircle).radiusMeters;
    if (!c || !finite(c.lat) || !finite(c.lng)) return "unknown";
    if (c.lat < -90 || c.lat > 90) return "unknown";
    // A zero or negative radius protects nothing — that is a broken row, not a
    // permissive one.
    if (!finite(r) || r <= 0) return "unknown";
    const lat = c.lat;
    const lng = normalizeLng(c.lng);
    for (const [plng, plat] of positions) {
      if (haversineMeters(lat, lng, plat, plng) <= r) return true;
    }
    return false;
  }

  if (zone.shape === "polygon") {
    const ring = normalizeRing((zone as ProtectedZonePolygon).ring);
    if (!ring) return "unknown";
    for (const [plng, plat] of positions) {
      if (pointInRing(ring, plng, plat)) return true;
    }
    return false;
  }

  return "unknown";
}

/**
 * Validate + normalize a linear ring. Returns null (⇒ "unknown" ⇒ fail closed)
 * for a degenerate ring, and ALSO for a ring spanning more than 180° of
 * longitude: even-odd ray casting is wrong across the antimeridian, and a wrong
 * answer here is worse than an honest refusal.
 */
function normalizeRing(ring: unknown): Position[] | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const out: Position[] = [];
  for (const pos of ring) {
    if (!Array.isArray(pos) || pos.length < 2) return null;
    const [lng, lat] = pos as [unknown, unknown];
    if (!finite(lng) || !finite(lat)) return null;
    if (lat < -90 || lat > 90) return null;
    out.push([normalizeLng(lng), lat]);
  }
  if (out.length < 3) return null;
  let min = out[0][0];
  let max = out[0][0];
  for (const [lng] of out) {
    if (lng < min) min = lng;
    if (lng > max) max = lng;
  }
  if (max - min > 180) return null;
  return out;
}

/** Even-odd ray casting. Boundary points count as inside (fail closed). */
function pointInRing(ring: readonly Position[], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (Math.abs(xi - lng) < 1e-12 && Math.abs(yi - lat) < 1e-12) return true;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** The point a coarsened object is snapped to. Null when the row is unusable. */
export function zoneAnchor(zone: ProtectedZone): { lat: number; lng: number } | null {
  if (zone.shape === "circle") {
    const c = zone.center;
    if (!c || !finite(c.lat) || !finite(c.lng)) return null;
    return { lat: c.lat, lng: normalizeLng(c.lng) };
  }
  const ring = normalizeRing(zone.ring);
  if (!ring) return null;
  return centroidOf({ type: "Polygon", coordinates: [ring] });
}

// ── Policy resolution ────────────────────────────────────────────────────────

export interface ResolvedZonePolicy {
  action: ProtectionAction;
  privacyFloor: PrivacyClass;
  unknownCategory: boolean;
}

/**
 * An unrecognised category is the loudest fail-closed case in the module: a
 * category this build has never heard of is a policy someone wrote that this
 * code cannot honour, so it gets the strongest action rather than the weakest.
 */
export function resolveZonePolicy(zone: ProtectedZone | null | undefined): ResolvedZonePolicy {
  const cat = zone?.category;
  if (!isProtectedCategory(cat)) {
    return { action: "suppress", privacyFloor: "none", unknownCategory: true };
  }

  const base = CATEGORY_ACTION[cat];
  let action: ProtectionAction;
  if (cat === "policy_defined") {
    // The escape hatch: the row IS the policy, so its action is taken as
    // written. A row with no action has declared nothing ⇒ suppress.
    action = isProtectionAction(zone?.action) ? (zone!.action as ProtectionAction) : base;
  } else {
    action = isProtectionAction(zone?.action)
      ? mostRestrictiveAction(base, zone!.action as ProtectionAction)
      : base;
  }

  let privacyFloor = CATEGORY_PRIVACY_FLOOR[cat];
  const declared = zone?.privacyFloor;
  if (declared !== undefined) {
    privacyFloor = narrowestPrivacyClass(privacyFloor, declared);
  }

  return { action, privacyFloor, unknownCategory: false };
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * What must happen to this object, given this policy set.
 *
 * Never returns `allow` when it could not prove the object is outside every
 * zone. The one thing that short-circuits to `allow` is a `safety_notice`, and
 * that happens FIRST — §24 puts safety warnings above everything, including
 * this filter.
 */
export function classifyAgainstProtected(
  obj: MapObject | null | undefined,
  zones: readonly ProtectedZone[] | null | undefined,
): ProtectionDecision {
  if (!obj || typeof obj !== "object") {
    return { action: "suppress", reason: "unparseable_object_geometry" };
  }

  if (PROTECTION_EXEMPT_KINDS.includes(obj.kind)) {
    return { action: "allow", reason: "safety_notice_exempt" };
  }

  const positions = geometryPositions(obj.geometry);
  if (!positions) {
    return { action: "suppress", reason: "unparseable_object_geometry" };
  }

  if (!Array.isArray(zones) || zones.length === 0) {
    return { action: "allow", reason: "no_zone_match" };
  }

  let best: ProtectionDecision = { action: "allow", reason: "no_zone_match" };

  for (const zone of zones) {
    const policy = resolveZonePolicy(zone);
    const coverage = zoneCovers(zone, positions);

    if (coverage === false) continue;

    let candidate: ProtectionDecision;
    if (coverage === "unknown") {
      // The row is unusable. We cannot show the object is outside it, and we
      // cannot trust what it declares, so it gets the strongest action.
      candidate = {
        action: "suppress",
        zone,
        reason: "unparseable_zone_geometry",
      };
    } else {
      let action = policy.action;
      let reason: ProtectionReason = policy.unknownCategory
        ? "unknown_zone_category"
        : "inside_protected_zone";

      // Escalation: for an ambient presence object the disclosure is the
      // association with the place, which no amount of coordinate blurring
      // removes. Escalation only ever tightens.
      if (action === "coarsen" && AMBIENT_PRESENCE_KINDS.includes(obj.kind)) {
        action = "suppress";
        reason = "presence_in_protected_zone";
      }

      // Escalation, second reason: for a COARSEN_UNSAFE kind the coarsened
      // object keeps the disclosure in `payload`, which coarsenForZone does not
      // descend into, and there is no honest coarser version to fall back to.
      // Escalation only ever tightens.
      if (action === "coarsen" && COARSEN_UNSAFE_KINDS.includes(obj.kind)) {
        action = "suppress";
        reason = "uncoarsenable_in_protected_zone";
      }

      candidate = { action, zone, reason, privacyFloor: policy.privacyFloor };
    }

    if (actionRank(candidate.action) > actionRank(best.action)) best = candidate;
    if (best.action === "suppress") break; // nothing can be more restrictive
  }

  return best;
}

// ── Coarsening ───────────────────────────────────────────────────────────────

/**
 * Reduce precision. NEVER increases it — `narrowestPrivacyClass` does the
 * arithmetic and a `precisionRank` re-check backstops it, so a future edit to
 * the floor table cannot accidentally sharpen an object.
 *
 * Four things happen, and the last three matter as much as the first:
 *
 *  1. GEOMETRY. A Point is snapped to the zone's anchor, so the residual
 *     precision the client receives is the zone's extent rather than the
 *     object's. This is only safe because coarsen-class zones are not
 *     themselves secret (a hospital is on every map); a zone whose existence is
 *     the secret is on the SUPPRESS path and never reaches here. Polygons and
 *     linestrings are left alone — they are already area-shaped, and rewriting
 *     them to a point would change the object's render shape.
 *  2. LIVE SIGNALS. `activity`, `trend`, `count`, `freshness`, `sourceClass`
 *     and the observation timestamps are dropped. "How busy is the clinic right
 *     now" is the disclosure, not the coordinate; a live crowd reading on a
 *     medical facility publishes that people are there now.
 *
 *     `sourceClass` belongs in THIS bullet rather than the back-reference one
 *     below, and the distinction is the reason it must go. It points at nobody
 *     — it is an epistemic label, not a handle — but it is a standalone
 *     assertion about presence: `verified_firsthand` says "a presence-verified
 *     person observed this place", which survives the removal of every
 *     timestamp and every reference and still publishes the one fact §24
 *     exists to withhold. Stripping the axes and leaving the attribution would
 *     be a coarse pin that still says someone was here.
 *
 *     (`confidence` deliberately stays: with activity, trend, freshness,
 *     provenance and the timestamps all gone there is no remaining claim for it
 *     to be confident ABOUT, so it asserts nothing on its own. `sourceClass`
 *     does assert something on its own. That is the whole test for this list.)
 *  3. BACK-REFERENCES. `provenance` and `sourceRefs` are dropped because they
 *     point back at the observations — a coarse pin plus a source handle is not
 *     coarse. `distanceKm` goes too: distance-from-viewer plus a coarse point
 *     narrows the position back down again.
 *
 * RESIDUAL, STATED HONESTLY: `title` and `subtitle` are caller-authored strings
 * and this module does not rewrite prose. A title containing a street address
 * would survive coarsening. That belongs to whoever mints the object.
 */
export function coarsenForZone(
  obj: MapObject,
  floor: PrivacyClass,
  zone?: ProtectedZone,
): MapObject {
  const next = narrowestPrivacyClass(obj.privacyClass, floor);
  const privacyClass =
    precisionRank(next) <= precisionRank(obj.privacyClass) ? next : obj.privacyClass;

  const out: MapObject = { ...obj, privacyClass };

  if (obj.geometry?.type === "Point" && zone) {
    const anchor = zoneAnchor(zone);
    if (anchor) out.geometry = { type: "Point", coordinates: [anchor.lng, anchor.lat] };
  }

  delete out.activity;
  delete out.trend;
  delete out.sourceClass;
  delete out.count;
  delete out.provenance;
  delete out.sourceRefs;
  delete out.observedAt;
  delete out.expiresAt;

  // renderingPriority is RESET, not deleted — it is required on a MapObject.
  //
  // applyLiveClaims promotes a place with qualifying live evidence to
  // RENDERING_PRIORITY.high_confidence_live_zone. Coarsening strips the axes,
  // the count, the provenance and the timestamps precisely because they betray
  // that someone is there right now — and then left the object ranking as a
  // high-confidence live zone, which says the same thing through §31 instead of
  // through a field. A protected location that outranks its neighbours IS the
  // disclosure, whatever its payload says.
  //
  // So it falls back to the kind's default: the object still renders, in the
  // position an uncorroborated object of its kind would occupy.
  out.renderingPriority = KIND_DEFAULT_PRIORITY[out.kind];
  delete out.freshness;
  out.distanceKm = null;

  // 4. THE PAYLOAD MIRROR. Everything above deletes a TOP-LEVEL field, and for
  //    a long time that was the whole of coarsening — which is how a prediction
  //    reached the wire with `count` deleted and `payload.cohort` intact, saying
  //    the identical thing one level down. Producers legitimately restate a
  //    top-level fact inside `payload` (that is what a payload is for), so the
  //    strip has to follow them down.
  //
  //    Only keys that MIRROR a field this function already deleted are removed,
  //    which is why the list is closed and short rather than "delete payload":
  //    a coarsened object still has to render, and its payload carries the
  //    render data. `COARSEN_UNSAFE_KINDS` is the primary answer for the kinds
  //    where even this is not enough; this is the backstop for every other kind
  //    and for any future producer that adds a cohort count to a payload.
  const payload = out.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    let stripped: Record<string, unknown> | null = null;
    for (const key of COARSENED_PAYLOAD_KEYS) {
      if (!(key in payload)) continue;
      if (stripped === null) stripped = { ...(payload as Record<string, unknown>) };
      delete stripped[key];
    }
    if (stripped !== null) out.payload = stripped;
  }

  return out;
}

/**
 * Payload keys that restate a field `coarsenForZone` deletes at the top level.
 * Each entry names the top-level deletion it mirrors, so the list stays
 * auditable and cannot quietly grow into "delete everything interesting".
 */
export const COARSENED_PAYLOAD_KEYS: readonly string[] = [
  // mirrors `count` — how many people
  "cohort",
  "cohortSize",
  "count",
  "distinctActors",
  // mirrors `observedAt` / `expiresAt` / `freshness` — when
  "observedAt",
  "predictedFor",
  // mirrors ALL of the above at once: crowd_flow's observation block
  "observed",
  // mirrors `provenance` / `sourceRefs` — back-references that re-sharpen
  "provenance",
  "sourceRefs",
];

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * COUNTS ONLY. This is not laziness — it is the point.
 *
 * A report that named the zone, the category, or the object that was hidden
 * would republish the very thing the suppression just removed. "1 shelter
 * suppressed" inside a viewport the client chose is a location disclosure with
 * extra steps: the viewport bounds it, the category identifies it. So there is
 * no zone id, no category histogram, no per-object breakdown, and no reason
 * codes here — `ProtectionDecision` carries those for server-side use only.
 *
 * The bare count IS a deliberate, minimal disclosure ("something here was
 * withheld"), and it is the lesser evil: a silently shrunk result is
 * indistinguishable from an empty city, which is how a protection bug survives
 * for months. The same argument mapAggregation.ts makes about its own counters.
 *
 * `evaluated === allowed + coarsened + suppressed + safetyExempt` always holds.
 */
export interface ProtectionReport {
  evaluated: number;
  allowed: number;
  coarsened: number;
  suppressed: number;
  /** Objects that passed through under the §24 safety-warning precedence. */
  safetyExempt: number;
}

export interface ProtectionOutcome {
  objects: MapObject[];
  report: ProtectionReport;
}

/**
 * The last gate before serialization.
 *
 * Input is never mutated: coarsened objects are fresh copies, allowed objects
 * are passed by reference unchanged, suppressed objects simply do not appear.
 * Relative order is preserved, so a ranking applied upstream survives.
 */
export function applyProtection(
  objects: readonly MapObject[] | null | undefined,
  zones: readonly ProtectedZone[] | null | undefined,
): ProtectionOutcome {
  const report: ProtectionReport = {
    evaluated: 0,
    allowed: 0,
    coarsened: 0,
    suppressed: 0,
    safetyExempt: 0,
  };

  if (!Array.isArray(objects) || objects.length === 0) {
    return { objects: [], report };
  }

  const out: MapObject[] = [];

  for (const obj of objects) {
    report.evaluated += 1;
    const decision = classifyAgainstProtected(obj, zones);

    if (decision.action === "suppress") {
      report.suppressed += 1;
      continue;
    }

    if (decision.action === "coarsen") {
      const coarse = coarsenForZone(obj, decision.privacyFloor ?? "approximate", decision.zone);
      // Defence in depth: if coarsening pushed the object below the servable
      // line (privacy rung 'none'), it is withheld rather than emitted. The
      // wire boundary and this gate must never disagree.
      if (!isServable(coarse)) {
        report.suppressed += 1;
        continue;
      }
      report.coarsened += 1;
      out.push(coarse);
      continue;
    }

    if (decision.reason === "safety_notice_exempt") {
      report.safetyExempt += 1;
    } else {
      report.allowed += 1;
    }
    out.push(obj as MapObject);
  }

  return { objects: out, report };
}
