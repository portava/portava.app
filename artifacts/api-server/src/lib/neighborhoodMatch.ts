/**
 * neighborhoodMatch.ts — Neighborhood Match v1 (OSM-based)
 *
 * Derives per-city neighborhood areas and category scores purely from
 * OpenStreetMap POI density (via the Overpass API), caches them in
 * `neighborhood_areas`, and ranks them against a member's preferences.
 *
 * HONESTY CONTRACT
 *   - Categories are limited to what OSM data actually supports:
 *     nightlife, food, culture, shopping — plus `quiet`, which is the
 *     inverse of total POI density (never an invented signal).
 *   - Every area carries poi_counts (evidence), sample_size and confidence.
 *   - Ranking output exposes per-category factor contributions.
 *   - Any external failure degrades to an empty result — callers surface
 *     `{ areas: [], reason: 'no_data' }` instead of fabricated areas.
 *
 * Overpass usage imitates src/routes/discovery.ts: GET with URL-encoded
 * `data=` query, 25 s timeout, User-Agent header, fail-soft (errors → []),
 * plus a small politeness throttle between consecutive live calls.
 */

// ── Categories ────────────────────────────────────────────────────────────────

/** POI-backed categories (directly countable from OSM tags). */
export const POI_CATEGORIES = ["nightlife", "food", "culture", "shopping"] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** All scoring categories — `quiet` is derived (inverse density), never counted. */
export const CATEGORIES = ["nightlife", "food", "culture", "shopping", "quiet"] as const;
export type NeighborhoodCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<NeighborhoodCategory, string> = {
  nightlife: "nightlife",
  food:      "food scene",
  culture:   "culture",
  shopping:  "shopping",
  quiet:     "quiet surroundings",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AreaSeed {
  name: string;
  lat: number;
  lng: number;
  source: "osm" | "grid";
}

export interface CityPoi {
  lat: number;
  lng: number;
  kind: PoiCategory;
}

/** Shape stored in / read from `neighborhood_areas` (snake_case = DB columns). */
export interface ComputedArea {
  city_name?: string;
  country?: string | null;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
  source: "osm" | "grid";
  category_scores: Record<string, number>;
  poi_counts: Record<string, number>;
  day_night: { day: string; night: string };
  sample_size: number;
  confidence: "low" | "medium" | "high";
  computed_at?: string;
}

export interface RankFactor {
  key: NeighborhoodCategory;
  /** e.g. "Strong nightlife (92/100)" */
  label: string;
  /** Points this category contributed to the final matchScore. */
  contribution: number;
}

export interface RankedArea {
  name: string;
  matchScore: number;
  factors: RankFactor[];
  categoryScores: Record<string, number>;
  dayNight: { day: string; night: string };
  sampleSize: number;
  confidence: "low" | "medium" | "high";
  source: "osm" | "grid";
  centerLat: number;
  centerLng: number;
  caveat?: string;
}

export interface AreaPreferences {
  /** Per-category weight 0..1; missing categories default to 0.5. */
  priorities?: Record<string, number> | null;
  sleepVsPlay?: "inside" | "close" | "away" | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OVERPASS_URL       = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS   = 25_000;
const SEARCH_RADIUS_M    = 12_000;   // ~12 km around the city centre
const DEFAULT_RADIUS_M   = 1_200;
const MIN_ASSIGN_M       = 1_800;    // POI→area assignment cap: max(radius_m, 1800)
const GRID_CELL_KM       = 2.2;      // 3×3 fallback grid cell size
const MAX_AREA_RESULTS   = 80;
const MAX_POI_RESULTS    = 4_000;
const REFRESH_TTL_MS     = 7 * 24 * 60 * 60 * 1_000; // 7 days
const THROTTLE_MS        = 1_100;    // politeness gap between live Overpass calls
const USER_AGENT         = "TravelBuddy/1.0 (travel-buddy-app; neighborhood-match)";

// ── Test fetch hook ───────────────────────────────────────────────────────────

type FetchLike = (input: any, init?: any) => Promise<any>;

let _testFetch: FetchLike | null = null;

/** Test hook: override the fetch used by both Overpass fetchers (null resets). */
export function _setTestFetch(fn: FetchLike | null): void {
  _testFetch = fn;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Great-circle distance in km (haversine — style of src/lib/canonicalLocations.ts). */
export function haversineKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ── Overpass plumbing ─────────────────────────────────────────────────────────

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

let _lastLiveCall = 0;

/**
 * Run one Overpass query. Fail-soft: any error, timeout or non-2xx status
 * returns [] — this function NEVER throws to its callers.
 */
async function queryOverpass(query: string): Promise<OsmElement[]> {
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
  try {
    let res: any;
    if (_testFetch) {
      res = await _testFetch(url, { headers: { "User-Agent": USER_AGENT } });
    } else {
      // Politeness throttle: keep consecutive live calls ≥ THROTTLE_MS apart.
      const wait = _lastLiveCall + THROTTLE_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      _lastLiveCall = Date.now();
      res = await globalThis.fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }
    if (!res?.ok) return [];
    const data = (await res.json()) as { elements?: OsmElement[] };
    return Array.isArray(data?.elements) ? data.elements : [];
  } catch {
    return [];
  }
}

function elementCoords(el: OsmElement): { lat: number; lng: number } | null {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// ── Grid fallback ─────────────────────────────────────────────────────────────

const GRID_NAMES: string[][] = [
  ["Southwest area", "South area",  "Southeast area"],
  ["West area",      "City center", "East area"],
  ["Northwest area", "North area",  "Northeast area"],
];

/** 3×3 grid of ~2.2 km cells centred on (lat,lng) — used when OSM has no named areas. */
function gridFallback(lat: number, lng: number): AreaSeed[] {
  const dLat = GRID_CELL_KM / 111.32;
  const dLng = GRID_CELL_KM / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const seeds: AreaSeed[] = [];
  for (let row = -1; row <= 1; row++) {        // row +1 = north
    for (let col = -1; col <= 1; col++) {      // col +1 = east
      seeds.push({
        name:   GRID_NAMES[row + 1][col + 1],
        lat:    lat + row * dLat,
        lng:    lng + col * dLng,
        source: "grid",
      });
    }
  }
  return seeds;
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

/**
 * Fetch named neighborhood-like places (suburb / neighbourhood / quarter)
 * within ~12 km of the city centre. Deduped by name. Falls back to a 3×3
 * synthetic grid (source 'grid') when OSM yields fewer than 3 named areas.
 * Fail-soft: an Overpass failure counts as 0 results → grid fallback.
 */
export async function fetchCityAreas(
  _city: string,
  lat: number,
  lng: number,
): Promise<AreaSeed[]> {
  const query =
    `[out:json][timeout:25];\n` +
    `(\n` +
    `  node["place"~"^(suburb|neighbourhood|quarter)$"](around:${SEARCH_RADIUS_M},${lat},${lng});\n` +
    `);\n` +
    `out body qt ${MAX_AREA_RESULTS};`;

  const elements = await queryOverpass(query);

  const seen = new Set<string>();
  const areas: AreaSeed[] = [];
  for (const el of elements) {
    const name = el.tags?.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const coords = elementCoords(el);
    if (!coords) continue;
    seen.add(key);
    areas.push({ name, lat: coords.lat, lng: coords.lng, source: "osm" });
  }

  if (areas.length < 3) return gridFallback(lat, lng);
  return areas;
}

/** Map raw OSM tags to a POI category, or null when untracked. */
function poiKind(tags: Record<string, string> | undefined): PoiCategory | null {
  if (!tags) return null;
  const amenity = tags.amenity;
  if (amenity === "bar" || amenity === "pub" || amenity === "nightclub") return "nightlife";
  if (amenity === "restaurant" || amenity === "cafe" || amenity === "fast_food") return "food";
  const tourism = tags.tourism;
  if (tourism === "museum" || tourism === "gallery" || tourism === "attraction") return "culture";
  if (tags.shop) return "shopping";
  return null;
}

/**
 * ONE bulk Overpass query for all tracked POI kinds within ~12 km.
 * Fail-soft: any failure returns [].
 */
export async function fetchCityPois(lat: number, lng: number): Promise<CityPoi[]> {
  const around = `(around:${SEARCH_RADIUS_M},${lat},${lng})`;
  const query =
    `[out:json][timeout:25];\n` +
    `(\n` +
    `  node["amenity"~"^(bar|pub|nightclub|restaurant|cafe|fast_food)$"]${around};\n` +
    `  node["tourism"~"^(museum|gallery|attraction)$"]${around};\n` +
    `  node["shop"]${around};\n` +
    `);\n` +
    `out body qt ${MAX_POI_RESULTS};`;

  const elements = await queryOverpass(query);

  const pois: CityPoi[] = [];
  for (const el of elements) {
    const kind = poiKind(el.tags);
    if (!kind) continue;
    const coords = elementCoords(el);
    if (!coords) continue;
    pois.push({ lat: coords.lat, lng: coords.lng, kind });
  }
  return pois;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function confidenceFor(sampleSize: number): "low" | "medium" | "high" {
  if (sampleSize >= 150) return "high";
  if (sampleSize >= 30)  return "medium";
  return "low";
}

/** Simple day/night character derived ONLY from the computed scores. */
function deriveDayNight(scores: Record<string, number>): { day: string; night: string } {
  if ((scores.nightlife ?? 0) >= 60) return { night: "lively", day: "moderate" };
  if (Math.max(scores.food ?? 0, scores.culture ?? 0) >= 60) {
    return { day: "lively", night: "quieter" };
  }
  return { day: "moderate", night: "moderate" };
}

/**
 * Assign each POI to its nearest area (within max(radius_m, 1800 m)), count
 * per category, and normalise counts across areas to 0–100 (densest area =
 * 100; all-zero category = 0 everywhere). `quiet` = 100 − normalised total
 * density. sample_size = POIs assigned to the area; confidence derives from it.
 */
export function computeAreas(areas: AreaSeed[], pois: CityPoi[]): ComputedArea[] {
  if (areas.length === 0) return [];

  const counts: Array<Record<PoiCategory, number>> = areas.map(() => ({
    nightlife: 0, food: 0, culture: 0, shopping: 0,
  }));
  const assigned: number[] = areas.map(() => 0);

  for (const poi of pois) {
    let bestIdx = -1;
    let bestM = Infinity;
    for (let i = 0; i < areas.length; i++) {
      const dM = haversineKm(poi.lat, poi.lng, areas[i].lat, areas[i].lng) * 1000;
      if (dM < bestM) { bestM = dM; bestIdx = i; }
    }
    if (bestIdx < 0) continue;
    if (bestM > Math.max(DEFAULT_RADIUS_M, MIN_ASSIGN_M)) continue;
    counts[bestIdx][poi.kind] += 1;
    assigned[bestIdx] += 1;
  }

  // Normalise each POI category across areas → 0–100.
  const scores: Array<Record<string, number>> = areas.map(() => ({}));
  for (const cat of POI_CATEGORIES) {
    const max = Math.max(...counts.map((c) => c[cat]));
    for (let i = 0; i < areas.length; i++) {
      scores[i][cat] = max > 0 ? Math.round((counts[i][cat] / max) * 100) : 0;
    }
  }

  // quiet = inverse of normalised TOTAL density.
  const totals = assigned.slice();
  const maxTotal = Math.max(...totals);
  for (let i = 0; i < areas.length; i++) {
    const density = maxTotal > 0 ? Math.round((totals[i] / maxTotal) * 100) : 0;
    scores[i].quiet = 100 - density;
  }

  return areas.map((seed, i): ComputedArea => ({
    name:            seed.name,
    center_lat:      seed.lat,
    center_lng:      seed.lng,
    radius_m:        DEFAULT_RADIUS_M,
    source:          seed.source,
    category_scores: scores[i],
    poi_counts:      { ...counts[i] },
    day_night:       deriveDayNight(scores[i]),
    sample_size:     assigned[i],
    confidence:      confidenceFor(assigned[i]),
  }));
}

// ── Refresh / cache ───────────────────────────────────────────────────────────

/**
 * Return cached `neighborhood_areas` rows for `city` when computed within the
 * last 7 days (unless force). Otherwise fetch areas + POIs from Overpass,
 * compute, upsert by (city_name, name) and return the fresh rows.
 *
 * Fail-soft: on any failure returns previously stored rows when they exist
 * (real, if stale, data) and [] otherwise. NEVER throws.
 */
export async function refreshCityNeighborhoods(
  sc: any,
  city: string,
  lat: number,
  lng: number,
  opts: { force?: boolean; country?: string | null } = {},
): Promise<ComputedArea[]> {
  let stored: ComputedArea[] = [];
  try {
    const { data } = await sc
      .from("neighborhood_areas")
      .select("*")
      .eq("city_name", city);
    stored = ((data as any[]) ?? []) as ComputedArea[];
  } catch {
    stored = [];
  }

  const nowMs = Date.now();
  const newest = stored.reduce((acc, r) => {
    const t = r.computed_at ? Date.parse(r.computed_at) : 0;
    return Number.isFinite(t) && t > acc ? t : acc;
  }, 0);
  const fresh = newest > 0 && nowMs - newest < REFRESH_TTL_MS;
  if (stored.length > 0 && fresh && !opts.force) return stored;

  try {
    const seeds = await fetchCityAreas(city, lat, lng);
    const pois  = await fetchCityPois(lat, lng);

    // No POIs at all = nothing to score honestly — do not fabricate.
    if (seeds.length === 0 || pois.length === 0) return stored;

    const computed = computeAreas(seeds, pois);
    if (computed.length === 0) return stored;

    const nowIso = new Date(nowMs).toISOString();
    const rows = computed.map((a) => ({
      city_name:       city,
      country:         opts.country ?? null,
      name:            a.name,
      center_lat:      a.center_lat,
      center_lng:      a.center_lng,
      radius_m:        a.radius_m,
      source:          a.source,
      category_scores: a.category_scores,
      poi_counts:      a.poi_counts,
      day_night:       a.day_night,
      sample_size:     a.sample_size,
      confidence:      a.confidence,
      computed_at:     nowIso,
    }));

    const { data: upserted, error } = await sc
      .from("neighborhood_areas")
      .upsert(rows, { onConflict: "city_name,name" })
      .select("*");

    if (error) return stored.length > 0 ? stored : (rows as any);
    return ((upserted as any[]) ?? rows) as ComputedArea[];
  } catch {
    return stored;
  }
}

// ── Ranking ───────────────────────────────────────────────────────────────────

function strengthWord(score: number): string {
  if (score >= 80) return "Strong";
  if (score >= 60) return "Good";
  if (score >= 40) return "Moderate";
  return "Limited";
}

/** sleepVsPlay → category weight multipliers. */
function sleepVsPlayMultipliers(mode: AreaPreferences["sleepVsPlay"]): Partial<Record<NeighborhoodCategory, number>> {
  switch (mode) {
    case "inside": return { nightlife: 1.5 };
    case "close":  return { nightlife: 1.1, quiet: 1.2 };
    case "away":   return { quiet: 1.6, nightlife: 0.5 };
    default:       return {};
  }
}

/**
 * Rank areas against a member's preferences.
 *   weight(cat) = (priorities[cat] ?? 0.5) × sleepVsPlay multiplier
 *   matchScore  = round(Σ w·score / Σ w)
 * Factors expose the top contributing categories; low-confidence areas carry
 * an explicit caveat. Sorted by matchScore desc.
 */
export function rankAreas(areas: ComputedArea[], prefs: AreaPreferences = {}): RankedArea[] {
  const priorities: Record<string, number> = prefs.priorities ?? {};
  const mult = sleepVsPlayMultipliers(prefs.sleepVsPlay ?? null);

  const weights: Record<NeighborhoodCategory, number> = {} as any;
  let weightSum = 0;
  for (const cat of CATEGORIES) {
    const base = typeof priorities[cat] === "number"
      ? Math.min(1, Math.max(0, priorities[cat]))
      : 0.5;
    const w = base * (mult[cat] ?? 1);
    weights[cat] = w;
    weightSum += w;
  }

  const ranked = areas.map((area): RankedArea => {
    const catScores = area.category_scores ?? {};
    let weighted = 0;
    const contributions: Array<{ cat: NeighborhoodCategory; score: number; contribution: number }> = [];

    for (const cat of CATEGORIES) {
      const score = typeof catScores[cat] === "number" ? catScores[cat] : 0;
      const contribution = weightSum > 0 ? (weights[cat] * score) / weightSum : 0;
      weighted += contribution;
      contributions.push({ cat, score, contribution });
    }

    const matchScore = Math.round(weighted);

    const factors: RankFactor[] = contributions
      .filter((c) => c.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .map((c) => ({
        key:          c.cat,
        label:        `${strengthWord(c.score)} ${CATEGORY_LABELS[c.cat]} (${c.score}/100)`,
        contribution: Math.round(c.contribution * 10) / 10,
      }));

    const out: RankedArea = {
      name:           area.name,
      matchScore,
      factors,
      categoryScores: { ...catScores },
      dayNight:       area.day_night ?? { day: "moderate", night: "moderate" },
      sampleSize:     area.sample_size ?? 0,
      confidence:     area.confidence ?? "low",
      source:         area.source,
      centerLat:      area.center_lat,
      centerLng:      area.center_lng,
    };
    if (out.confidence === "low") out.caveat = "Limited data for this area";
    return out;
  });

  return ranked.sort((a, b) => b.matchScore - a.matchScore);
}

// ── Center of gravity ─────────────────────────────────────────────────────────

export interface CenterOfGravity {
  lat: number;
  lng: number;
  shares: Array<{ areaName: string; pct: number }>;
}

/**
 * Mean point of `points` plus the share of points whose nearest area is each
 * `areas` entry (top 4 by share). Returns null when there are no points.
 */
export function centerOfGravity(
  points: Array<{ lat: number; lng: number }>,
  areas: ComputedArea[],
): CenterOfGravity | null {
  const valid = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );
  if (valid.length === 0) return null;

  const lat = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
  const lng = valid.reduce((s, p) => s + p.lng, 0) / valid.length;

  const tally = new Map<string, number>();
  if (areas.length > 0) {
    for (const p of valid) {
      let bestName: string | null = null;
      let bestKm = Infinity;
      for (const a of areas) {
        const d = haversineKm(p.lat, p.lng, a.center_lat, a.center_lng);
        if (d < bestKm) { bestKm = d; bestName = a.name; }
      }
      if (bestName) tally.set(bestName, (tally.get(bestName) ?? 0) + 1);
    }
  }

  const shares = [...tally.entries()]
    .map(([areaName, n]) => ({ areaName, pct: Math.round((n / valid.length) * 100) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  return { lat, lng, shares };
}
