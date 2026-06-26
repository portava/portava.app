/**
 * Route Optimizer — pure TypeScript, no external routing provider.
 *
 * All distances and durations are APPROXIMATED using straight-line
 * (Haversine) distance.  Every output is labeled `isApproximated: true`.
 *
 * Algorithm:
 *   1. Filter out stops that have no coordinates (emit warning).
 *   2. If a start point is given, always keep it first.
 *   3. Apply a nearest-neighbor greedy heuristic from the start.
 *   4. If route_style requires it, apply post-hoc adjustments:
 *      - nightlife: prefer later opening-hours stops later in the route
 *      - low_walking: flag legs > 800 m for rideshare recommendation
 *      - scenic: prefer landmark/activity stops earlier
 *   5. Compute leg distances + durations.
 */

export interface CandidateStop {
  id?: string;
  title: string;
  lat: number;
  lng: number;
  sourceType?: string;
  openingHoursNote?: string | null;
  category?: string | null;
}

export type RouteStyle = 'nightlife' | 'scenic' | 'foodie' | 'low_walking' | 'custom';
export type TransportMode = 'walk' | 'rideshare' | 'transit' | 'bike' | 'drive';

export interface OptimizedStop {
  index: number;
  stop: CandidateStop;
  warning?: string;
}

export interface OptimizedLeg {
  fromIndex: number;
  toIndex: number;
  distanceMeters: number;
  durationSeconds: number;
  mode: TransportMode;
  isApproximated: true;
  rideshareRecommended: boolean;
  safetyNotes?: string;
}

export interface OptimizeResult {
  stops: OptimizedStop[];
  legs: OptimizedLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  isApproximated: true;
  warnings: string[];
}

export interface OptimizeOptions {
  style: RouteStyle;
  startLocation?: { lat: number; lng: number; label?: string } | null;
  endLocation?: { lat: number; lng: number; label?: string } | null;
  timeWindowStart?: Date | null;
}

const WALK_SPEED_MS = 1.25;
const RIDESHARE_THRESHOLD_M = 800;
const NIGHTLIFE_CATEGORIES = new Set(['nightlife', 'bar', 'club', 'pub', 'cocktail']);
const SCENIC_CATEGORIES = new Set(['landmark', 'activity', 'museum', 'park', 'sightseeing']);

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function legMode(distanceMeters: number, style: RouteStyle): TransportMode {
  if (style === 'low_walking' && distanceMeters > RIDESHARE_THRESHOLD_M) return 'rideshare';
  if (distanceMeters > 2_000) return 'rideshare';
  return 'walk';
}

function durationForMode(distanceMeters: number, mode: TransportMode): number {
  if (mode === 'walk') return Math.ceil(distanceMeters / WALK_SPEED_MS);
  if (mode === 'rideshare') return Math.ceil(distanceMeters / 8.33) + 180;
  return Math.ceil(distanceMeters / WALK_SPEED_MS);
}

export function optimizeRoute(
  candidates: CandidateStop[],
  opts: OptimizeOptions,
): OptimizeResult {
  const warnings: string[] = [];

  const withCoords = candidates.filter((c) => {
    const ok = typeof c.lat === 'number' && typeof c.lng === 'number'
      && isFinite(c.lat) && isFinite(c.lng);
    if (!ok) warnings.push(`Stop "${c.title}" has no coordinates and was skipped`);
    return ok;
  });

  if (withCoords.length === 0) {
    return { stops: [], legs: [], totalDistanceMeters: 0, totalDurationSeconds: 0, isApproximated: true, warnings };
  }

  let pool = [...withCoords];

  const ordered: CandidateStop[] = [];

  let startLat = opts.startLocation?.lat ?? pool[0]!.lat;
  let startLng = opts.startLocation?.lng ?? pool[0]!.lng;

  if (opts.startLocation) {
    const startPseudo: CandidateStop = {
      title: opts.startLocation.label ?? 'Start',
      lat: opts.startLocation.lat,
      lng: opts.startLocation.lng,
      sourceType: 'manual',
    };
    ordered.push(startPseudo);
  }

  let curLat = startLat;
  let curLng = startLng;

  while (pool.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const d = haversineMeters(curLat, curLng, pool[i]!.lat, pool[i]!.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    const chosen = pool.splice(bestIdx, 1)[0]!;
    ordered.push(chosen);
    curLat = chosen.lat;
    curLng = chosen.lng;
  }

  if (opts.endLocation) {
    ordered.push({
      title: opts.endLocation.label ?? 'End',
      lat: opts.endLocation.lat,
      lng: opts.endLocation.lng,
      sourceType: 'manual',
    });
  }

  applyStyleAdjustments(ordered, opts.style, warnings);

  const optimizedStops: OptimizedStop[] = ordered.map((s, i) => ({ index: i, stop: s }));

  const legs: OptimizedLeg[] = [];
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;

  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]!;
    const to = ordered[i + 1]!;
    const dist = Math.round(haversineMeters(from.lat, from.lng, to.lat, to.lng));
    const mode = legMode(dist, opts.style);
    const dur = durationForMode(dist, mode);
    const rideshareRecommended = opts.style === 'low_walking' && dist > RIDESHARE_THRESHOLD_M;

    legs.push({
      fromIndex: i,
      toIndex: i + 1,
      distanceMeters: dist,
      durationSeconds: dur,
      mode,
      isApproximated: true,
      rideshareRecommended,
      safetyNotes: rideshareRecommended ? 'Leg is over 800 m — rideshare recommended' : undefined,
    });

    totalDistanceMeters += dist;
    totalDurationSeconds += dur;
  }

  return { stops: optimizedStops, legs, totalDistanceMeters, totalDurationSeconds, isApproximated: true, warnings };
}

function applyStyleAdjustments(
  stops: CandidateStop[],
  style: RouteStyle,
  warnings: string[],
): void {
  if (style === 'scenic') {
    const [head, ...rest] = stops;
    const landmark = rest.findIndex((s) => SCENIC_CATEGORIES.has(s.category ?? ''));
    if (landmark !== -1 && landmark > 0) {
      const [lm] = rest.splice(landmark, 1);
      rest.unshift(lm!);
    }
    stops.length = 0;
    if (head) stops.push(head);
    stops.push(...rest);
  }

  if (style === 'nightlife') {
    const [head, ...rest] = stops;
    rest.sort((a, b) => {
      const aIsNight = NIGHTLIFE_CATEGORIES.has(a.category ?? '') ? 1 : 0;
      const bIsNight = NIGHTLIFE_CATEGORIES.has(b.category ?? '') ? 1 : 0;
      return aIsNight - bIsNight;
    });
    stops.length = 0;
    if (head) stops.push(head);
    stops.push(...rest);
  }

  if (style === 'low_walking') {
    warnings.push('Low-walking mode: legs over 800 m are flagged for rideshare');
  }
}
