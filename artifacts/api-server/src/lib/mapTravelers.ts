/**
 * mapTravelers — decides WHO appears on the Discovery live map, WHERE their
 * marker sits, and HOW PRECISELY.
 *
 * Privacy contract (mirrors discoverySearch + LocationPermissionService):
 *   - Only users whose location sharing is on: location_mode != 'off',
 *     not sharing_paused, effective discovery visibility != 'no_location'.
 *     Missing prefs row = product default (city_only mode → city precision).
 *   - profiles: account_status='active', is_private=false only.
 *   - profile_privacy_settings.allow_profile_discovery=false → excluded.
 *   - user_privacy_settings.allow_location_sharing=false → excluded.
 *   - user_privacy_settings.age_restriction_enabled=true → excluded
 *     (viewer age unknown here — fail-closed, same as discovery search).
 *   - Blocked relationships (either direction) → excluded; a null blockedSet
 *     (block state unknown) returns [] — never leak when uncertain.
 *   - EXACT COORDINATES NEVER LEAVE THIS MODULE. Output positions are either
 *     the canonical city centroid, or grid-snapped + deterministically
 *     jittered coarse coordinates (~11 km cells for city precision fallback,
 *     ~2.2 km cells otherwise). Jitter is a pure function of user id, so a
 *     marker cannot be averaged across polls to recover the true position.
 *   - Only coarse freshness buckets ('live' < 15 min, 'recent' < 60 min) are
 *     exposed — never raw timestamps. Older locations drop off the map.
 *
 * Perf: candidate lists are cached 20 s per rounded viewport so many clients
 * polling the same city do one DB round per window. Viewer-specific filtering
 * (self + blocks) happens per request, AFTER the shared cache.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { normalizeLocationName } from "./canonicalLocations";
import { nameVisibilitySet } from "./publicIdentity";

/**
 * Compile-time schema guard: property access below type-checks against the
 * generated DB types, so a column rename (e.g. lat/lng — NOT
 * latitude/longitude) breaks the build instead of silently returning
 * zero travelers.
 */
type LocStateRow = Pick<
  Database["public"]["Tables"]["user_location_state"]["Row"],
  "user_id" | "lat" | "lng" | "city" | "country" | "last_known_at"
>;

// ── Types ─────────────────────────────────────────────────────────────────────

export type MapFreshness = "live" | "recent";
export type MapPrecision = "city" | "area";

export interface MapTravelerPayload {
  id: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
  openToMeet: boolean;
  city: string | null;
  country: string | null;
  freshness: MapFreshness;
  precision: MapPrecision;
  lat: number;
  lng: number;
}

export interface LocationPrefsRow {
  location_mode?: string | null;
  sharing_paused?: boolean | null;
  discovery_visibility?: string | null;
}

// ── Tunables ──────────────────────────────────────────────────────────────────

const FRESH_LIVE_MS = 15 * 60 * 1000;
const FRESH_MAX_MS = 60 * 60 * 1000;
/** ~11 km cells — city-precision fallback when no canonical centroid exists. */
const CITY_GRID_DEG = 0.1;
/** ~2.2 km cells — the FINEST precision the map ever shows. */
const AREA_GRID_DEG = 0.02;
const MAX_RESULTS = 100;
const SCAN_LIMIT = 250;
const CAND_TTL_MS = 20_000;

/** Mirrors MODE_DEFAULT_PULSE_VISIBILITY in LocationPermissionService — the
 *  default precision each location mode implies when no explicit
 *  discovery_visibility override is set. */
const MODE_DEFAULT_VIS: Record<string, string> = {
  off: "no_location",
  city_only: "city_only",
  nearby: "neighborhood",
  live_during_activity: "neighborhood",
  trusted_circle_live: "venue_tagged",
};

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

/**
 * Effective discovery visibility for a prefs row (null row = defaults).
 * Returns null when the user must NOT appear on the map at all.
 */
export function effectiveDiscoveryVisibility(
  prefs: LocationPrefsRow | null | undefined,
): string | null {
  const mode = prefs?.location_mode ?? "city_only";
  if (prefs?.sharing_paused) return null;
  if (mode === "off") return null;
  const vis = prefs?.discovery_visibility ?? MODE_DEFAULT_VIS[mode] ?? "city_only";
  if (vis === "no_location") return null;
  return vis;
}

/** FNV-1a hash → [0, 1). Deterministic per seed — stable marker positions. */
export function hash01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Coarsen a raw position: snap to a grid cell sized by the user's visibility,
 * then place the marker at a deterministic per-user point INSIDE the cell
 * (15%–85% of cell width from the edge). The raw coordinate is unrecoverable;
 * the output never moves between polls unless the user changes cells.
 */
export function coarsenPosition(
  userId: string,
  lat: number,
  lng: number,
  visibility: string,
): { lat: number; lng: number; precision: MapPrecision } {
  const cityLevel = visibility === "city_only";
  const grid = cityLevel ? CITY_GRID_DEG : AREA_GRID_DEG;
  const j1 = hash01(`${userId}:lat`);
  const j2 = hash01(`${userId}:lng`);
  const outLat = (Math.floor(lat / grid) + 0.15 + 0.7 * j1) * grid;
  const outLng = (Math.floor(lng / grid) + 0.15 + 0.7 * j2) * grid;
  return {
    lat: Number(outLat.toFixed(5)),
    lng: Number(outLng.toFixed(5)),
    precision: cityLevel ? "city" : "area",
  };
}

/** Freshness bucket from a location timestamp; null = too stale for the map. */
export function freshnessBucket(updatedAtIso: string | null, now = Date.now()): MapFreshness | null {
  if (!updatedAtIso) return null;
  const age = now - new Date(updatedAtIso).getTime();
  if (!isFinite(age) || age < 0) return null;
  if (age <= FRESH_LIVE_MS) return "live";
  if (age <= FRESH_MAX_MS) return "recent";
  return null;
}

// ── Candidate cache (viewer-independent) ─────────────────────────────────────

const candCache = new Map<string, { at: number; rows: MapTravelerPayload[] }>();

function cacheKey(lat: number, lng: number, radiusKm: number): string {
  return `${Math.round(lat * 20)}:${Math.round(lng * 20)}:${radiusKm}`;
}

/** Test hook — clears the shared candidate cache. */
export function _clearMapTravelersCache(): void {
  candCache.clear();
}

// ── Candidate loading ─────────────────────────────────────────────────────────

async function loadCandidates(
  db: SupabaseClient,
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<MapTravelerPayload[]> {
  const cutoff = new Date(Date.now() - FRESH_MAX_MS).toISOString();
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));

  // last_known_at is written together with lat/lng on every position fix
  // (see routes/location.ts) — it is the honest "how fresh is this position"
  // signal. Rows without it are excluded (fail-closed).
  // NOTE: the bbox is a naive min/max range — viewports straddling the
  // antimeridian (±180°) will miss travelers on the far side. Accepted:
  // queries are city-scale (≤100km) and no launch market sits on the line.
  const { data: locsRaw, error: locErr } = await db
    .from("user_location_state")
    .select("user_id, lat, lng, city, country, last_known_at")
    .gte("last_known_at", cutoff)
    .not("lat", "is", null)
    .not("lng", "is", null)
    .gte("lat", lat - dLat)
    .lte("lat", lat + dLat)
    .gte("lng", lng - dLng)
    .lte("lng", lng + dLng)
    .limit(SCAN_LIMIT);
  if (locErr || !locsRaw || locsRaw.length === 0) return [];
  const locs = locsRaw as LocStateRow[];

  const ids = locs.map((l) => l.user_id);

  const [prefsQ, profsQ, noDiscQ, upsQ] = await Promise.all([
    db.from("user_location_preferences")
      .select("user_id, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", ids),
    db.from("profiles")
      .select("id, handle, name, display_name, avatar_url, show_profile_picture_publicly, verified, open_to_meet, is_private, account_status")
      .in("id", ids),
    db.from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", ids)
      .eq("allow_profile_discovery", false),
    db.from("user_privacy_settings")
      .select("user_id, age_restriction_enabled, allow_location_sharing")
      .in("user_id", ids),
  ]);

  // Fail-closed: if ANY privacy-relevant query fails, show nobody.
  if (prefsQ.error || profsQ.error || noDiscQ.error || upsQ.error) return [];

  const prefsById = new Map<string, LocationPrefsRow>(
    (prefsQ.data ?? []).map((p: any) => [p.user_id as string, p as LocationPrefsRow]),
  );
  const profById = new Map<string, any>(
    (profsQ.data ?? []).map((p: any) => [p.id as string, p]),
  );
  const noDiscSet = new Set<string>((noDiscQ.data ?? []).map((r: any) => r.user_id as string));
  const upsExcluded = new Set<string>(
    (upsQ.data ?? [])
      .filter((r: any) => r.age_restriction_enabled === true || r.allow_location_sharing === false)
      .map((r: any) => r.user_id as string),
  );

  // First pass: eligibility + which city centroids we need.
  const eligible: Array<{ loc: LocStateRow; prof: any; vis: string; freshness: MapFreshness }> = [];
  const cityNames = new Set<string>();
  const now = Date.now();
  for (const loc of locs) {
    const id = loc.user_id;
    const prof = profById.get(id);
    if (!prof) continue; // unknown profile → exclude (fail-closed)
    if (prof.account_status !== "active") continue;
    if (prof.is_private === true) continue;
    if (noDiscSet.has(id) || upsExcluded.has(id)) continue;
    const vis = effectiveDiscoveryVisibility(prefsById.get(id));
    if (!vis) continue;
    const freshness = freshnessBucket(loc.last_known_at ?? null, now);
    if (!freshness) continue;
    eligible.push({ loc, prof, vis, freshness });
    if (vis === "city_only" && loc.city) {
      const norm = normalizeLocationName(String(loc.city));
      if (norm) cityNames.add(norm);
    }
  }
  if (eligible.length === 0) return [];

  // City centroids from the canonical location registry (one source of truth).
  // Failure here is non-fatal — the grid fallback is at least as coarse.
  const centroidByNorm = new Map<string, { lat: number; lng: number }>();
  if (cityNames.size > 0) {
    const { data: cents } = await db
      .from("canonical_locations")
      .select("normalized_name, lat, lng")
      .in("normalized_name", Array.from(cityNames))
      .in("kind", ["city", "town", "district", "neighborhood"])
      .not("lat", "is", null)
      .not("lng", "is", null);
    for (const c of (cents ?? []) as any[]) {
      if (!centroidByNorm.has(c.normalized_name as string)) {
        centroidByNorm.set(c.normalized_name as string, { lat: c.lat as number, lng: c.lng as number });
      }
    }
  }

  // Universal display-name rule: map pins show @handle unless opted in.
  const allowedPinNames = await nameVisibilitySet(db, eligible.map((e) => e.loc.user_id));

  const rows: MapTravelerPayload[] = eligible.map(({ loc, prof, vis, freshness }) => {
    const id = loc.user_id;
    let pos: { lat: number; lng: number; precision: MapPrecision } | null = null;
    if (vis === "city_only" && loc.city) {
      const norm = normalizeLocationName(String(loc.city));
      const cent = norm ? centroidByNorm.get(norm) : undefined;
      if (cent) pos = { lat: cent.lat, lng: cent.lng, precision: "city" };
    }
    if (!pos) pos = coarsenPosition(id, loc.lat as number, loc.lng as number, vis);
    return {
      id,
      handle: (prof.handle as string | null) ?? null,
      displayName: allowedPinNames.has(id)
        ? ((prof.display_name as string | null) ??
          (prof.name as string | null) ??
          (prof.handle as string | null) ??
          "Traveler")
        : (prof.handle ? `@${prof.handle as string}` : "Traveler"),
      // Candidates are already private-excluded and viewer-independent (no
      // follow/friend context), so this is a flag-only gate: a public profile's
      // owner can still opt out via show_profile_picture_publicly (default true).
      avatarUrl: (prof.show_profile_picture_publicly !== false)
        ? ((prof.avatar_url as string | null) ?? null)
        : null,
      verified: prof.verified === true,
      openToMeet: prof.open_to_meet === true,
      city: (loc.city as string | null) ?? null,
      country: (loc.country as string | null) ?? null,
      freshness,
      precision: pos.precision,
      lat: pos.lat,
      lng: pos.lng,
    };
  });

  // Live users first, then stable name order — the cap keeps the most relevant.
  rows.sort((a, b) =>
    a.freshness === b.freshness
      ? a.displayName.localeCompare(b.displayName)
      : a.freshness === "live" ? -1 : 1,
  );
  return rows;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listMapTravelers(
  db: SupabaseClient,
  opts: {
    viewerId: string;
    lat: number;
    lng: number;
    radiusKm: number;
    /** null = block state unknown → fail-closed empty result. */
    blockedSet: Set<string> | null;
  },
): Promise<MapTravelerPayload[]> {
  if (opts.blockedSet === null) return [];

  const key = cacheKey(opts.lat, opts.lng, opts.radiusKm);
  const hit = candCache.get(key);
  let rows: MapTravelerPayload[];
  if (hit && Date.now() - hit.at < CAND_TTL_MS) {
    rows = hit.rows;
  } else {
    rows = await loadCandidates(db, opts.lat, opts.lng, opts.radiusKm);
    candCache.set(key, { at: Date.now(), rows });
    if (candCache.size > 80) {
      const oldest = [...candCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) candCache.delete(oldest[0]);
    }
  }

  const blocked = opts.blockedSet;
  return rows
    .filter((r) => r.id !== opts.viewerId && !blocked.has(r.id))
    .slice(0, MAX_RESULTS);
}
