/**
 * arrivalPromptModel — §38's one-tap arrival prompt, the pure half.
 *
 * THE SCENARIO THIS MODULE SERVES
 * ===============================
 * Map spec §38, the developer north-star: "The user taps Go There, gets routed,
 * arrives, and later answers a one-tap prompt about the crowd. That observation
 * re-enters the Live Intelligence pipeline and may update the map for other
 * eligible viewers." The closed loop §22 draws (SENSE → … → ACT → VERIFY) has
 * its VERIFY step here: arriving at a Compass Pick is the moment to ask "what is
 * it actually like?", because the traveller is standing in the answer.
 *
 * This module decides ONLY "has the user just arrived at a pick we have not yet
 * asked them about?". It surfaces nothing and emits nothing — the screen owns
 * the sheet and the telemetry. Keeping the decision pure is what makes the
 * radius, the de-duplication and the nearest-pick tie-break testable without a
 * device, a GPS stream or a running map.
 *
 * WHY A COMPASS PICK, AND NOT ANY PLACE
 * =====================================
 * §38 names a Compass Pick specifically, and the reason is the loop: a pick is
 * something Portava RECOMMENDED, so a post-arrival observation is evidence about
 * a recommendation — the signal the outcome/attribution pipeline is built to
 * consume. A prompt at every place the user happens to pass would be noise, and
 * would not close any loop. So the caller passes the Compass-pick objects
 * (`payload.compassPick === true`, the §6 star treatment), and this only ever
 * fires on one of those.
 */
import type { MapObject } from '../../../types/mapObjects.ts';
import { centroidOf } from '../../../types/mapObjects.ts';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * How close counts as "arrived". 120 m — a short walk across a plaza or the
 * length of a block: near enough that the traveller is credibly AT the venue,
 * far enough that GPS jitter at the door does not keep the prompt from firing.
 * The one-tap prompt is low-cost, so the failure we price against is a prompt
 * that never fires (radius too tight), not one that fires slightly early.
 */
export const ARRIVAL_RADIUS_M = 120;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. Self-contained so this module stays pure. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether an object is a §14 Compass Pick (the §6 star), fail-closed on shape. */
export function isCompassPick(obj: MapObject | null | undefined): boolean {
  if (!obj) return false;
  const payload = obj.payload as { compassPick?: unknown } | undefined;
  return payload?.compassPick === true;
}

export interface ArrivalDetectOptions {
  /** Arrival radius in metres. Defaults to ARRIVAL_RADIUS_M. */
  radiusM?: number;
}

/**
 * The Compass Pick the user has just arrived at and has not yet been prompted
 * about, or `null` when there is nothing to prompt.
 *
 * Rules, all fail-closed:
 *  - No user position, or a non-finite one, yields `null` — we never guess a
 *    location, and an unknown position is not an arrival.
 *  - Only objects that ARE Compass Picks and have a usable centroid are
 *    considered. A pick the map cannot place is not somewhere you can arrive.
 *  - A pick already in `promptedIds` is skipped: §38 is a ONE-tap prompt, not a
 *    prompt that re-fires every time GPS re-enters the radius.
 *  - Among eligible picks, the NEAREST wins, with the object id as a total
 *    tie-break so two equidistant picks resolve deterministically (no flicker
 *    between renders).
 */
export function detectArrivalPick(
  userPos: LatLng | null | undefined,
  picks: readonly MapObject[] | null | undefined,
  promptedIds: ReadonlySet<string>,
  opts: ArrivalDetectOptions = {},
): MapObject | null {
  if (!userPos || !Number.isFinite(userPos.lat) || !Number.isFinite(userPos.lng)) return null;
  if (!picks || picks.length === 0) return null;
  const radiusM = opts.radiusM ?? ARRIVAL_RADIUS_M;

  let best: MapObject | null = null;
  let bestDist = Infinity;
  for (const obj of picks) {
    if (!isCompassPick(obj)) continue;
    if (promptedIds.has(obj.id)) continue;
    const c = centroidOf(obj.geometry);
    if (!c) continue;
    const d = distanceMeters(userPos, c);
    if (d > radiusM) continue;
    if (d < bestDist || (d === bestDist && best !== null && obj.id < best.id)) {
      bestDist = d;
      best = obj;
    }
  }
  return best;
}
