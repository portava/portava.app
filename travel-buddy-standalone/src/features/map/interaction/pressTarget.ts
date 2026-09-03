/**
 * pressTarget — what the finger was actually on.
 *
 * WHAT THIS IS
 * ============
 * `longPress.ts` decides which §25 actions a target affords. It does not decide
 * WHAT THE TARGET IS, and until this module existed nothing did: the map screen
 * held `longPress` state with no producer, so `MapLongPressMenu` was mounted and
 * unreachable. This is the missing half — a press, in geographic coordinates,
 * becomes the `LongPressTarget` the menu resolves against.
 *
 * Pure: no React, no map SDK, no I/O. The native map answers "where did they
 * press"; this answers "what is there".
 *
 * WHY GEOGRAPHIC, NOT SCREEN-SPACE
 * ================================
 * The obvious implementation projects every object to screen coordinates with
 * `render/collision.toScreen` and boxes-tests the press point. It would be
 * wrong here, and subtly:
 *
 *   `toScreen` needs the viewport CENTRE, and the centre the shell holds is
 *   deliberately coarse — `DiscoveryMapView.handleRegionChange` rounds it to
 *   ~1 km so small drags do not re-render or re-trigger the fetch hook. At z16
 *   a kilometre is several hundred points, so a screen-space test would be off
 *   by more than the entire viewport is wide at the zooms where precision
 *   actually matters.
 *
 * MapLibre's press event carries `lngLat` — the true point under the finger,
 * unprojected by the engine that drew the frame. So the comparison happens in
 * geographic space, where the only viewport input is ZOOM (which changes on
 * pinch, not on pan, and is tracked exactly). `metresPerPixel` converts the
 * touch target into a ground radius; nothing else about the camera is needed.
 *
 * §5's LEVELS DECIDE WHO WINS
 * ===========================
 * "Markers sit above zones" is not a tie-break invented here, it is §5's
 * hierarchy: activity zones are Level 2, crowd flow Level 3, markers Level 4
 * and above. A press inside a social zone that is also on a café pin is a press
 * on the café — the pin is what is drawn on top and what the finger is aiming
 * at. So point geometry is tested first and areas only answer for presses that
 * hit no marker at all.
 *
 * NOTHING HERE OPENS ANYTHING
 * ===========================
 * A press that hits nothing is not a failure and does not suppress the menu: it
 * is a COORDINATE target, which §25's most common entries ("Meet here", "Create
 * checkpoint") are written for. This function therefore always returns a
 * target, never null.
 *
 * ONE KIND OF PIN STILL ANSWERS AS A COORDINATE
 * =============================================
 * The map draws two families of place pin. §18 objects come through the
 * gateway and are in `objects` / `CollisionResult.kept`, so a press on one is
 * an OBJECT target and every §25 row that needs a subject works. Legacy
 * Discovery pins do not: app/map/index.tsx states it outright — "discovery
 * places, passport stamps and raw Compass results, none of which have a
 * MapObject here at all". A press on one of those is honest but thin: the menu
 * opens on the coordinate, so "Meet here", "Ask Compass" and "Create
 * checkpoint" work and "Save location", "Add to Trip" and "Report" are
 * disabled with a reason that does not pretend the user pressed wrong.
 *
 * Closing that is a projection question, not a hit-testing one — something has
 * to turn a `DiscoveryPlace` into a `MapObject` before this module can find it
 * — so it is left to whichever lane merges those two sources rather than
 * papered over with a second, private definition of what a place is.
 */

import {
  centroidOf,
  isRenderable,
  type MapObject,
  type PolygonGeometry,
} from '../../../types/mapObjects.ts';
import { DEFAULT_HIT_BOX, metresPerPixel } from '../render/collision.ts';
import {
  coordinateTarget,
  objectTarget,
  type LongPressTarget,
} from './longPress.ts';

// ── The touch target ──────────────────────────────────────────────────────────

/**
 * How far from a marker's own coordinate a press still counts as ON it, in
 * points.
 *
 * Derived from `DEFAULT_HIT_BOX` rather than restated, so the radius a press is
 * matched with cannot drift from the box §31 used to decide the marker was
 * drawable in the first place. Half the box width is 22 pt — the circle
 * inscribed in the 44 pt platform touch target, which is the conservative read:
 * a press in a box CORNER falls through to the coordinate rather than claiming
 * a marker the user may not have been aiming at.
 *
 * The box's `offsetY` is deliberately NOT modelled. It exists because a
 * teardrop pin's body is drawn above its anchor, and collision has to reason
 * about the drawn body. A press is matched against the ANCHOR — the spot on the
 * ground the object actually is — which is what a person means when they press
 * "there".
 */
export const PRESS_RADIUS_PT = DEFAULT_HIT_BOX.width / 2;

/** Where the press landed, plus the only camera value the test needs. */
export interface PressPoint {
  lat: number;
  lng: number;
  /** Current camera zoom. Decides how many metres one point of touch covers. */
  zoom: number;
}

/**
 * The objects that were actually DRAWN, split the way the map draws them.
 *
 * Both lists are what survived the pipeline, not everything the gateway sent:
 * a marker §31 dropped for collision and a kind §17 hid at this zoom band are
 * not on screen, so they cannot be pressed. Offering an invisible object would
 * be worse than the coordinate — the user would act on something they cannot
 * see.
 */
export interface DrawnObjects {
  /** Point-shaped objects — §5 Level 4 and up. Tested first. */
  markers?: readonly MapObject[];
  /** Zone/flow objects — §5 Levels 2-3. Only answer a press no marker took. */
  areas?: readonly MapObject[];
}

// ── Geometry ──────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

/**
 * Ground distance in metres, equirectangular.
 *
 * Not Haversine on purpose: this is only ever asked about pairs a few tens of
 * metres apart, where the flat approximation agrees with the great circle to
 * far better than a touch target, and the comparison runs for every drawn
 * marker on every press.
 */
function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const EARTH_R_M = 6_371_000;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  return Math.sqrt(dLat * dLat + dLng * dLng) * EARTH_R_M;
}

function isFinitePosition(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Ray casting, on the polygon's OUTER RING only.
 *
 * Holes are not modelled because §6 forbids the shape that would need them:
 * "should not imply scientifically exact borders". A zone is a soft aggregate
 * area, and `circlePolygon` — the projector's own constructor for one — emits a
 * single ring. A donut-shaped crowd is not a thing this map draws.
 */
function containsPoint(geometry: PolygonGeometry, lat: number, lng: number): boolean {
  const ring = geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return false;
    const [aLng, aLat] = a;
    const [bLng, bLat] = b;
    if (!Number.isFinite(aLat) || !Number.isFinite(aLng)) return false;
    if (!Number.isFinite(bLat) || !Number.isFinite(bLng)) return false;
    // Half-open edge test: a vertex is counted by exactly one of its two edges,
    // so a press exactly level with one cannot be counted twice and read as
    // outside.
    const straddles = aLat > lat !== bLat > lat;
    if (!straddles) continue;
    const crossLng = ((bLng - aLng) * (lat - aLat)) / (bLat - aLat) + aLng;
    if (lng < crossLng) inside = !inside;
  }
  return inside;
}

/**
 * Twice the ring's signed area in square degrees, absolute — the shoelace sum.
 *
 * Only ever COMPARED against another ring's, never reported, so no projection
 * to metres is needed: both rings sit within a viewport, where the longitude
 * distortion that would make degrees² dishonest as an area is the same for
 * both. Its one job is "which of these two containing zones is the smaller".
 */
function ringArea(geometry: PolygonGeometry): number {
  const ring = geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
      return Number.POSITIVE_INFINITY;
    }
    sum += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return Math.abs(sum);
}

// ── The pick ──────────────────────────────────────────────────────────────────

/**
 * `isRenderable` is the same gate the projection applies before an object is
 * drawn, and it is re-applied here rather than assumed: it is what keeps a
 * `privacyClass: 'none'` object — the "not visible to this viewer" rung — from
 * becoming a press target if one ever reaches the list. Such a target would
 * open a menu with all seven rows dark, which tells the user there is something
 * here they may not touch. The coordinate under it is the honest answer.
 */
function pressable(obj: MapObject | null | undefined): obj is MapObject {
  return !!obj && isRenderable(obj);
}

/** The nearest drawn marker within the touch radius, or null. */
function nearestMarker(
  markers: readonly MapObject[],
  press: PressPoint,
  radiusM: number,
): MapObject | null {
  let best: MapObject | null = null;
  let bestM = Number.POSITIVE_INFINITY;
  for (const obj of markers) {
    if (!pressable(obj)) continue;
    if (obj.geometry?.type !== 'Point') continue;
    const c = centroidOf(obj.geometry);
    if (!c) continue;
    const d = metresBetween(press, c);
    // Strictly nearer, so an exact tie leaves the FIRST one standing — and the
    // caller passes `CollisionResult.kept`, which is already in §31's priority
    // order. Two markers on the same spot therefore resolve to the one drawn
    // on top, without this module re-deriving the priority rules.
    if (d <= radiusM && d < bestM) {
      best = obj;
      bestM = d;
    }
  }
  return best;
}

/**
 * The smallest area containing the press, or null.
 *
 * Smallest rather than highest-priority: a zone drawn inside another zone is
 * the more specific answer to "what is here", and it is also the one whose
 * fill the finger is visibly on. Rendering priority orders what is drawn ON
 * TOP of what, which for two nested translucent fills is not what the user is
 * pointing at.
 *
 * LineStrings — §10 crowd flow — are not offered at all. A flow is a few points
 * wide and a press cannot reliably mean it, so pressing "near" one falls
 * through to the coordinate rather than guessing at an aggregate the user did
 * not aim for.
 */
function smallestContainingArea(
  areas: readonly MapObject[],
  press: PressPoint,
): MapObject | null {
  let best: MapObject | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const obj of areas) {
    if (!pressable(obj)) continue;
    if (obj.geometry?.type !== 'Polygon') continue;
    if (!containsPoint(obj.geometry, press.lat, press.lng)) continue;
    const a = ringArea(obj.geometry);
    if (a < bestArea) {
      best = obj;
      bestArea = a;
    }
  }
  return best;
}

/**
 * The object under a press, or null when the press was on bare map.
 *
 * Exported separately from `longPressTargetAt` because a caller sometimes wants
 * the object itself — telemetry naming the subject, say — and rebuilding the
 * search at the call site is how two answers to "what did they press" appear.
 */
export function pressedObject(
  drawn: DrawnObjects,
  press: PressPoint,
): MapObject | null {
  if (!press || !isFinitePosition(press.lat, press.lng)) return null;
  const zoom = Number.isFinite(press.zoom) ? press.zoom : 0;
  const radiusM = PRESS_RADIUS_PT * metresPerPixel(press.lat, zoom);

  return (
    nearestMarker(drawn.markers ?? [], press, radiusM) ??
    smallestContainingArea(drawn.areas ?? [], press)
  );
}

/**
 * A press becomes a §25 target. ALWAYS returns one — an object when the finger
 * was on something drawn, and the pressed coordinate otherwise, which is the
 * variant `LongPressTarget` models as first-class for exactly this case.
 */
export function longPressTargetAt(
  drawn: DrawnObjects,
  press: PressPoint,
): LongPressTarget {
  const obj = pressedObject(drawn, press);
  return obj ? objectTarget(obj) : coordinateTarget(press.lat, press.lng);
}
