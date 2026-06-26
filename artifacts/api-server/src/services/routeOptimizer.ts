/**
 * Route Optimizer — pure TypeScript, no external routing provider.
 *
 * All distances and durations are APPROXIMATED using straight-line
 * (Haversine) distance. Every output is labeled `isApproximated: true`.
 *
 * Algorithm:
 *   1. Filter out stops with no coordinates (emit warning).
 *   2. If a start point is given, always keep it first.
 *   3. Nearest-neighbor greedy heuristic from the start.
 *   4. 2-opt improvement pass — swaps route sub-segments to reduce total
 *      distance, which naturally clusters nearby stops together.
 *   5. Style post-hoc adjustments:
 *      - nightlife:  defer NIGHTLIFE_CATEGORIES stops to the end; if
 *                    timeWindowStart is set, further defer stops whose
 *                    openingHoursNote indicates they open later.
 *      - scenic:     surface SCENIC_CATEGORIES stops toward the front.
 *      - foodie:     surface FOOD_CATEGORIES stops toward the front, push
 *                    bars/nightlife to the back.
 *      - low_walking: flag legs > 800 m for rideshare recommendation.
 *   6. Generate a natural-language `compassExplanation`.
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
  compassExplanation: string;
}

export interface OptimizeOptions {
  style: RouteStyle;
  startLocation?: { lat: number; lng: number; label?: string } | null;
  endLocation?: { lat: number; lng: number; label?: string } | null;
  timeWindowStart?: Date | null;
  /** Compass intent mode derived by CompassIntentModeEngine (e.g. 'night_mode', 'explore_now') */
  intentMode?: string | null;
}

const WALK_SPEED_MS           = 1.25;   // m/s ≈ 4.5 km/h
const RIDESHARE_THRESHOLD_M   = 800;
const TWO_OPT_CLUSTER_RADIUS  = 300;    // m — within this radius, stops are treated as "same neighborhood"

const NIGHTLIFE_CATEGORIES = new Set(['nightlife', 'bar', 'club', 'pub', 'cocktail', 'lounge']);
const SCENIC_CATEGORIES    = new Set(['landmark', 'activity', 'museum', 'park', 'sightseeing', 'culture', 'heritage', 'attraction']);
const FOOD_CATEGORIES      = new Set(['restaurant', 'cafe', 'food', 'dining', 'brunch', 'coffee', 'bakery', 'dessert']);

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a     =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function routeDistance(stops: CandidateStop[]): number {
  let total = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineMeters(stops[i]!.lat, stops[i]!.lng, stops[i + 1]!.lat, stops[i + 1]!.lng);
  }
  return total;
}

// ── Transport mode + duration ─────────────────────────────────────────────────

function legMode(distanceMeters: number, style: RouteStyle): TransportMode {
  if (style === 'low_walking' && distanceMeters > RIDESHARE_THRESHOLD_M) return 'rideshare';
  if (distanceMeters > 2_000) return 'rideshare';
  return 'walk';
}

function durationForMode(distanceMeters: number, mode: TransportMode): number {
  if (mode === 'walk') return Math.ceil(distanceMeters / WALK_SPEED_MS);
  if (mode === 'rideshare') return Math.ceil(distanceMeters / 8.33) + 180; // avg 30 km/h + 3 min wait
  return Math.ceil(distanceMeters / WALK_SPEED_MS);
}

// ── Nearest-neighbor greedy ───────────────────────────────────────────────────

function nearestNeighbor(pool: CandidateStop[], startLat: number, startLng: number): CandidateStop[] {
  const remaining = [...pool];
  const ordered: CandidateStop[] = [];
  let curLat = startLat;
  let curLng = startLng;

  while (remaining.length > 0) {
    let bestIdx  = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(curLat, curLng, remaining[i]!.lat, remaining[i]!.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const chosen = remaining.splice(bestIdx, 1)[0]!;
    ordered.push(chosen);
    curLat = chosen.lat;
    curLng = chosen.lng;
  }

  return ordered;
}

// ── 2-opt improvement (neighborhood clustering) ───────────────────────────────
//
// For short routes (≤20 stops), a full 2-opt pass is O(n²) and fast.
// Stops that belong to the same "neighborhood" (< TWO_OPT_CLUSTER_RADIUS apart)
// naturally end up adjacent after 2-opt because swapping them reduces total
// distance.

function twoOpt(
  stops: CandidateStop[],
  fixedStart: boolean,
  fixedEnd: boolean,
): CandidateStop[] {
  const n      = stops.length;
  let improved = true;
  let best     = [...stops];

  const startIdx = fixedStart ? 1 : 0;
  const endIdx   = fixedEnd  ? n - 2 : n - 1;

  while (improved) {
    improved = false;
    for (let i = startIdx; i < endIdx; i++) {
      for (let j = i + 1; j <= endIdx; j++) {
        // Current cost: dist(i, i+1) + dist(j, j+1)
        // Reversed cost: dist(i, j) + dist(i+1, j+1)
        const before =
          haversineMeters(best[i - 1]?.lat ?? best[i]!.lat, best[i - 1]?.lng ?? best[i]!.lng,
                          best[i]!.lat, best[i]!.lng) +
          haversineMeters(best[j]!.lat, best[j]!.lng,
                          best[j + 1]?.lat ?? best[j]!.lat, best[j + 1]?.lng ?? best[j]!.lng);
        const after  =
          haversineMeters(best[i - 1]?.lat ?? best[i]!.lat, best[i - 1]?.lng ?? best[i]!.lng,
                          best[j]!.lat, best[j]!.lng) +
          haversineMeters(best[i]!.lat, best[i]!.lng,
                          best[j + 1]?.lat ?? best[j]!.lat, best[j + 1]?.lng ?? best[j]!.lng);

        if (after < before - 1) {
          // Reverse the sub-route between i and j (inclusive)
          const segment = best.slice(i, j + 1).reverse();
          best = [...best.slice(0, i), ...segment, ...best.slice(j + 1)];
          improved = true;
        }
      }
    }
  }

  return best;
}

// ── Style adjustments ─────────────────────────────────────────────────────────

function applyStyleAdjustments(
  stops: CandidateStop[],
  style: RouteStyle,
  timeWindowStart: Date | null,
  warnings: string[],
  hasFixedStart: boolean,
  hasFixedEnd: boolean,
): CandidateStop[] {
  // Peel off fixed anchors so they are never reordered by style logic.
  const headAnchor: CandidateStop[] = hasFixedStart && stops.length > 0
    ? [stops[0]!]
    : [];
  const tailAnchor: CandidateStop[] = hasFixedEnd && stops.length > (hasFixedStart ? 1 : 0)
    ? [stops[stops.length - 1]!]
    : [];
  const innerStart = hasFixedStart ? 1 : 0;
  const innerEnd   = hasFixedEnd   ? stops.length - 1 : stops.length;
  const inner      = stops.slice(innerStart, innerEnd);

  let reordered: CandidateStop[] = inner;

  if (style === 'scenic') {
    const scenicItems = inner.filter((s) => SCENIC_CATEGORIES.has(s.category?.toLowerCase() ?? ''));
    const otherItems  = inner.filter((s) => !SCENIC_CATEGORIES.has(s.category?.toLowerCase() ?? ''));
    reordered = [...scenicItems, ...otherItems];
  }

  if (style === 'nightlife') {
    // Daytime stops first, then nightlife-category stops last.
    // If timeWindowStart is provided, additionally defer stops whose
    // openingHoursNote suggests they open after timeWindowStart.
    const dayStops: CandidateStop[]   = [];
    const nightStops: CandidateStop[] = [];

    for (const s of inner) {
      const isNight = NIGHTLIFE_CATEGORIES.has(s.category?.toLowerCase() ?? '');
      // Respect openingHoursNote: e.g. "opens 9pm" → night
      const noteImpliesLate = /\b(10|11|midnight|9\s*pm|10\s*pm|late\s*night)\b/i.test(
        s.openingHoursNote ?? '',
      );
      if (isNight || noteImpliesLate) nightStops.push(s);
      else dayStops.push(s);
    }

    if (timeWindowStart) {
      const windowHour = timeWindowStart.getHours();
      if (windowHour >= 18) {
        warnings.push(
          `Night-out mode: daytime activities scheduled first (window starts ${timeWindowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
        );
      }
    }

    reordered = [...dayStops, ...nightStops];
  }

  if (style === 'foodie') {
    // Meals and cafés first. Bars/nightlife last (dessert-to-bar progression).
    const foodFirst: CandidateStop[] = [];
    const barLast: CandidateStop[]   = [];
    const other: CandidateStop[]     = [];

    for (const s of inner) {
      const cat = s.category?.toLowerCase() ?? '';
      if (FOOD_CATEGORIES.has(cat)) foodFirst.push(s);
      else if (NIGHTLIFE_CATEGORIES.has(cat)) barLast.push(s);
      else other.push(s);
    }

    reordered = [...foodFirst, ...other, ...barLast];
  }

  if (style === 'low_walking') {
    warnings.push('Low-walking mode: legs over 800 m are flagged for rideshare');
  }

  // Rebuild in place
  stops.length = 0;
  stops.push(...headAnchor, ...reordered, ...tailAnchor);

  return stops;
}

// ── Compass explanation ───────────────────────────────────────────────────────

function buildCompassExplanation(
  stops: CandidateStop[],
  style: RouteStyle,
  totalDistanceMeters: number,
  warnings: string[],
  opts: OptimizeOptions,
): string {
  const n = stops.length;
  const styleLabels: Record<RouteStyle, string> = {
    nightlife:    'night-out',
    scenic:       'scenic landmark',
    foodie:       'food-first',
    low_walking:  'low-walking',
    custom:       'optimized',
  };

  const categories = stops
    .map((s) => s.category?.toLowerCase())
    .filter((c): c is string => !!c && c !== 'manual');
  const uniqueCats = [...new Set(categories)].slice(0, 3);

  const distKm = (totalDistanceMeters / 1000).toFixed(1);

  const parts: string[] = [
    `This ${styleLabels[style]} route visits ${n} stop${n !== 1 ? 's' : ''} over ~${distKm} km.`,
  ];

  if (style === 'nightlife') {
    parts.push('Daytime spots come first; bars and clubs are placed at the end of the night.');
  } else if (style === 'scenic') {
    const landmarks = stops.filter((s) => SCENIC_CATEGORIES.has(s.category?.toLowerCase() ?? ''));
    if (landmarks.length > 0) {
      parts.push(`Landmark stops (${landmarks.map((l) => l.title).slice(0, 2).join(', ')}${landmarks.length > 2 ? '…' : ''}) were moved to the front for better photos in natural light.`);
    }
  } else if (style === 'foodie') {
    parts.push('Restaurants and cafés are prioritised earlier; bars are reserved for the end of the crawl.');
  } else if (style === 'low_walking') {
    parts.push('Long legs (over 800 m) are flagged for rideshare so you stay fresh.');
  } else {
    parts.push('Stops were ordered using a nearest-neighbour algorithm then improved with 2-opt to reduce backtracking.');
  }

  if (uniqueCats.length > 0) {
    parts.push(`Categories on this route: ${uniqueCats.join(', ')}.`);
  }

  if (opts.startLocation?.label) {
    parts.push(`Starting from ${opts.startLocation.label}.`);
  }
  if (opts.endLocation?.label) {
    parts.push(`Ending at ${opts.endLocation.label}.`);
  }

  if (opts.timeWindowStart) {
    parts.push(`Timed for a start around ${opts.timeWindowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
  }

  if (opts.intentMode) {
    const intentLabels: Record<string, string> = {
      night_mode:   'night-out explore',
      explore_now:  'explore-now',
      plan_ahead:   'plan-ahead',
      social_mode:  'social',
      arrival_mode: 'arrival',
    };
    const label = intentLabels[opts.intentMode] ?? opts.intentMode;
    parts.push(`Compass mode: ${label}.`);
  }

  if (warnings.length > 0) {
    parts.push(`Note: ${warnings[0]}`);
  }

  parts.push('All distances are straight-line approximations — no live routing provider is used.');

  return parts.join(' ');
}

// ── Main export ───────────────────────────────────────────────────────────────

export function optimizeRoute(
  candidates: CandidateStop[],
  opts: OptimizeOptions,
): OptimizeResult {
  const warnings: string[] = [];

  // 1. Filter valid coordinates
  const withCoords = candidates.filter((c) => {
    const ok = typeof c.lat === 'number' && typeof c.lng === 'number'
      && isFinite(c.lat) && isFinite(c.lng);
    if (!ok) warnings.push(`Stop "${c.title}" has no coordinates and was skipped`);
    return ok;
  });

  if (withCoords.length === 0) {
    return {
      stops: [], legs: [], totalDistanceMeters: 0, totalDurationSeconds: 0,
      isApproximated: true, warnings,
      compassExplanation: 'No valid stops provided.',
    };
  }

  // 2. Determine start anchor
  const hasStart = opts.startLocation != null;
  const hasEnd   = opts.endLocation   != null;

  const startLat = opts.startLocation?.lat ?? withCoords[0]!.lat;
  const startLng = opts.startLocation?.lng ?? withCoords[0]!.lng;

  // 3. Nearest-neighbor greedy pass (on the pool excluding explicit start/end)
  const nnOrdered = nearestNeighbor(withCoords, startLat, startLng);

  // 4. Assemble full ordered list (prepend start, append end pseudo-stops)
  const startPseudo: CandidateStop | null = hasStart
    ? { title: opts.startLocation!.label ?? 'Start', lat: startLat, lng: startLng, sourceType: 'manual' }
    : null;
  const endPseudo: CandidateStop | null = hasEnd
    ? { title: opts.endLocation!.label ?? 'End', lat: opts.endLocation!.lat, lng: opts.endLocation!.lng, sourceType: 'manual' }
    : null;

  let assembled: CandidateStop[] = [
    ...(startPseudo ? [startPseudo] : []),
    ...nnOrdered,
    ...(endPseudo ? [endPseudo] : []),
  ];

  // 5. 2-opt improvement (clusters nearby stops together)
  assembled = twoOpt(assembled, hasStart, hasEnd);

  // 6. Style-specific adjustments
  applyStyleAdjustments(assembled, opts.style, opts.timeWindowStart ?? null, warnings, hasStart, hasEnd);

  // 7. Compute legs
  const legs: OptimizedLeg[] = [];
  let totalDistanceMeters  = 0;
  let totalDurationSeconds = 0;

  for (let i = 0; i < assembled.length - 1; i++) {
    const from = assembled[i]!;
    const to   = assembled[i + 1]!;
    const dist = Math.round(haversineMeters(from.lat, from.lng, to.lat, to.lng));
    const mode = legMode(dist, opts.style);
    const dur  = durationForMode(dist, mode);
    const rideshareRecommended = opts.style === 'low_walking' && dist > RIDESHARE_THRESHOLD_M;

    // Check cluster proximity for 2-opt comment
    const isCluster = dist < TWO_OPT_CLUSTER_RADIUS;
    void isCluster;

    legs.push({
      fromIndex: i,
      toIndex:   i + 1,
      distanceMeters:  dist,
      durationSeconds: dur,
      mode,
      isApproximated: true,
      rideshareRecommended,
      safetyNotes: rideshareRecommended ? 'Leg is over 800 m — rideshare recommended' : undefined,
    });

    totalDistanceMeters  += dist;
    totalDurationSeconds += dur;
  }

  const optimizedStops: OptimizedStop[] = assembled.map((s, i) => ({ index: i, stop: s }));

  const compassExplanation = buildCompassExplanation(
    assembled, opts.style, totalDistanceMeters, warnings, opts,
  );

  return {
    stops: optimizedStops,
    legs,
    totalDistanceMeters,
    totalDurationSeconds,
    isApproximated: true,
    warnings,
    compassExplanation,
  };
}
