/**
 * mediaLocationVisibility — Media v2 Phase 1b (Security).
 *
 * The single choke point that coarsens a media asset's disclosed LOCATION to
 * no finer than its independent §33 LocationVisibility tier, and that closes
 * the Hidden-Gem de-anonymization hole: media pinned at (or tagged to) a place
 * that hosts a protected/approximate Hidden Gem can never disclose a location
 * the gem's own guard (HiddenGemPrivacyGuard.resolveGemCoords) would hide.
 *
 * WHY THIS EXISTS
 * ---------------
 * §33 makes MediaVisibility and LocationVisibility INDEPENDENT axes: exact GPS
 * is NOT normal public media metadata. Migration 2250 laid
 * media_assets.location_visibility (default 'hidden') but nothing coarsened
 * served media location by it, so ordinary media/posts could expose exact
 * coordinates regardless — and a protected gem could be de-anonymized by an
 * ordinary post tagged to the same canonical_place_id (or sitting on the same
 * coordinates). This module is the enforcement the column was waiting for.
 *
 * DESIGN — FAIL CLOSED ON EVERY BRANCH
 * ------------------------------------
 *   • An unknown / absent tier coarsens to the MOST private ('hidden' ⇒ no
 *     location at all). We never widen on missing data.
 *   • Exact coordinates are returned to NON-owners on NO tier. The finest
 *     public tier is 'place' (place-level, never the raw GPS); 'precise_private'
 *     is owner-only. Invariant: coordsAreExact ⇒ the viewer is the owner.
 *   • Gem protection: when a place hosts a restrictive gem, the media inherits
 *     the STRICTER of (its own tier, the gem's ceiling). If the gem status
 *     could not be DETERMINED (e.g. the lookup threw), we coarsen anyway.
 *
 * PURE. loadRestrictiveGems is the only function that touches the DB; every
 * decision function is pure and unit-testable against literal inputs — the same
 * shape lib/protectedLocations.ts uses for the map. The coarse-coordinate
 * grid-snap mirrors lib/mapTravelers.coarsenPosition (deterministic per seed,
 * raw coordinate unrecoverable).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// ── LocationVisibility tiers (§33, mirrors migration 2250 CHECK) ───────────────

export const LOCATION_VISIBILITY_TIERS = [
  "hidden",
  "country",
  "city",
  "neighborhood",
  "place",
  "precise_private",
] as const;
export type LocationVisibilityTier = (typeof LOCATION_VISIBILITY_TIERS)[number];

/** Coarsest → finest rank. `hidden` is the most private (0). */
const TIER_RANK: Record<LocationVisibilityTier, number> = {
  hidden: 0,
  country: 1,
  city: 2,
  neighborhood: 3,
  place: 4,
  precise_private: 5,
};

/**
 * Normalize any candidate tier value to a known tier. FAIL CLOSED: anything not
 * in the enum (null, undefined, "", a legacy/garbage value) becomes 'hidden'.
 */
export function normalizeTier(v: unknown): LocationVisibilityTier {
  return typeof v === "string" && (LOCATION_VISIBILITY_TIERS as readonly string[]).includes(v)
    ? (v as LocationVisibilityTier)
    : "hidden";
}

/** The stricter (coarser, lower-rank) of two tiers. */
export function stricterTier(
  a: LocationVisibilityTier,
  b: LocationVisibilityTier,
): LocationVisibilityTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

// ── Gem sensitivity → media location ceiling ──────────────────────────────────

/** The five HiddenGemPrivacyGuard sensitivity levels (see 0043_hidden_gems). */
export type GemSensitivity =
  | "public"
  | "approximate"
  | "reveal_after_save"
  | "reveal_after_acceptance"
  | "protected";

/**
 * The finest media LocationVisibility tier permitted NEAR / AT a gem of the
 * given sensitivity, for a non-owner viewer. This is the security bridge from
 * the gem guard's model to the media path:
 *
 *   protected / reveal_after_save / reveal_after_acceptance → 'city'
 *       The gem guard returns NO coordinates (or only after save/acceptance,
 *       which a media viewer cannot satisfy). Media may show at most the city —
 *       never the neighborhood, place name, or coordinates that would locate it.
 *   approximate → 'neighborhood'
 *       The gem guard discloses only a neighbourhood centroid; media matches.
 *   public → null (no constraint; a public gem's location is already public).
 */
export function gemSensitivityToCeiling(
  s: GemSensitivity | string | null | undefined,
): LocationVisibilityTier | null {
  switch (s) {
    case "protected":
    case "reveal_after_save":
    case "reveal_after_acceptance":
      return "city";
    case "approximate":
      return "neighborhood";
    case "public":
      return null;
    default:
      // Unknown sensitivity → treat as the strictest so an unrecognised value
      // can never widen disclosure. FAIL CLOSED.
      return "city";
  }
}

// ── Disclosure shapes ─────────────────────────────────────────────────────────

export interface MediaLocationInput {
  lat?: number | null;
  lng?: number | null;
  name?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  country?: string | null;
}

export type LocationPrecision =
  | "none"
  | "country"
  | "city"
  | "neighborhood"
  | "place"
  | "exact";

export interface MediaLocationDisclosure {
  /** The effective tier actually applied after coarsening / gem protection. */
  visibility: LocationVisibilityTier;
  precision: LocationPrecision;
  name: string | null;
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  /** True ONLY when the raw exact coordinate is disclosed — owner-only. */
  coordsAreExact: boolean;
}

export interface CoarsenOpts {
  /** Raw location_visibility tier from the asset. Unknown/absent ⇒ 'hidden'. */
  locationVisibility?: unknown;
  /** The viewer is the media owner (or otherwise authorized for exact coords). */
  isOwner?: boolean;
  /**
   * Stable id (e.g. media/post id) used to deterministically place a coarse
   * grid-snapped coordinate. Required for a non-owner coarse coordinate to be
   * emitted at all.
   */
  coarsenSeed?: string | null;
  /**
   * When true, a non-owner MAY receive a coarse, grid-snapped coordinate at
   * city/neighborhood/place tiers (never the raw exact one). Default false:
   * labels only, no coordinate. Seams that never emitted coordinates before
   * (e.g. the media feed) leave this false so no NEW location data appears.
   */
  emitCoarseCoords?: boolean;
}

// ── Grid-snap (coarse, unrecoverable, deterministic per seed) ──────────────────

/** ~11 km cells — city precision. Mirrors mapTravelers.CITY_GRID_DEG. */
const CITY_GRID_DEG = 0.1;
/** ~2.2 km cells — neighborhood/place precision. Mirrors AREA_GRID_DEG. */
const AREA_GRID_DEG = 0.02;

/** FNV-1a → [0,1). Deterministic per seed (same construction as mapTravelers.hash01). */
function hash01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Snap a coordinate to a grid cell sized by tier, then place it at a stable
 * per-seed point inside the cell. The raw coordinate is unrecoverable and the
 * output never moves unless the true position crosses a cell boundary.
 */
function snapCoord(
  seed: string,
  lat: number,
  lng: number,
  grid: number,
): { lat: number; lng: number } {
  const j1 = hash01(`${seed}:lat`);
  const j2 = hash01(`${seed}:lng`);
  const outLat = (Math.floor(lat / grid) + 0.15 + 0.7 * j1) * grid;
  const outLng = (Math.floor(lng / grid) + 0.15 + 0.7 * j2) * grid;
  return { lat: Number(outLat.toFixed(4)), lng: Number(outLng.toFixed(4)) };
}

// ── The coarsener ──────────────────────────────────────────────────────────────

/**
 * Coarsen a media location to no finer than its LocationVisibility tier.
 *
 * Owner (isOwner=true): sees everything they stored, at exact precision — a
 * media owner viewing their own asset cannot de-anonymize anything they placed.
 *
 * Non-owner: labels are disclosed per tier and the raw exact coordinate is
 * NEVER returned. FAIL CLOSED — an unknown/absent tier ⇒ 'hidden' ⇒ nothing.
 */
export function coarsenMediaLocation(
  input: MediaLocationInput,
  opts: CoarsenOpts = {},
): MediaLocationDisclosure {
  const name = input.name ?? null;
  const neighborhood = input.neighborhood ?? null;
  const city = input.city ?? null;
  const country = input.country ?? null;
  const rawLat = typeof input.lat === "number" && Number.isFinite(input.lat) ? input.lat : null;
  const rawLng = typeof input.lng === "number" && Number.isFinite(input.lng) ? input.lng : null;

  const tier = normalizeTier(opts.locationVisibility);

  // Owner bypass — exact, unfiltered.
  if (opts.isOwner === true) {
    return {
      visibility: tier,
      precision: rawLat != null && rawLng != null ? "exact" : "none",
      name,
      neighborhood,
      city,
      country,
      lat: rawLat,
      lng: rawLng,
      coordsAreExact: rawLat != null && rawLng != null,
    };
  }

  const seed = opts.coarsenSeed ?? null;
  const emitCoarse = opts.emitCoarseCoords === true && seed != null && rawLat != null && rawLng != null;

  const coarseAt = (grid: number): { lat: number | null; lng: number | null } =>
    emitCoarse ? snapCoord(seed!, rawLat!, rawLng!, grid) : { lat: null, lng: null };

  switch (tier) {
    case "country":
      return {
        visibility: "country",
        precision: "country",
        name: null,
        neighborhood: null,
        city: null,
        country,
        lat: null,
        lng: null,
        coordsAreExact: false,
      };
    case "city": {
      const c = coarseAt(CITY_GRID_DEG);
      return {
        visibility: "city",
        precision: "city",
        name: null,
        neighborhood: null,
        city,
        country,
        lat: c.lat,
        lng: c.lng,
        coordsAreExact: false,
      };
    }
    case "neighborhood": {
      const c = coarseAt(AREA_GRID_DEG);
      return {
        visibility: "neighborhood",
        precision: "neighborhood",
        name: null,
        neighborhood,
        city,
        country,
        lat: c.lat,
        lng: c.lng,
        coordsAreExact: false,
      };
    }
    case "place":
    case "precise_private": {
      // 'place' is the finest PUBLIC tier: place name + labels, still no exact
      // coordinate. 'precise_private' is owner-only, so for a non-owner it is
      // downgraded to the same place-level (exact stays hidden).
      const c = coarseAt(AREA_GRID_DEG);
      return {
        visibility: "place",
        precision: "place",
        name,
        neighborhood,
        city,
        country,
        lat: c.lat,
        lng: c.lng,
        coordsAreExact: false,
      };
    }
    case "hidden":
    default:
      return {
        visibility: "hidden",
        precision: "none",
        name: null,
        neighborhood: null,
        city: null,
        country: null,
        lat: null,
        lng: null,
        coordsAreExact: false,
      };
  }
}

// ── Gem protection ────────────────────────────────────────────────────────────

export interface GemProtection {
  /** Strictest tier the hosting gem permits, or null when no gem constrains. */
  ceiling: LocationVisibilityTier | null;
  /**
   * Whether the gem status was actually determined. false ⇒ the lookup could
   * not run (e.g. it threw); the resolver then coarsens defensively.
   */
  determined: boolean;
}

/** The ceiling applied when gem protection could not be determined (fail-closed). */
export const UNDETERMINED_GEM_CEILING: LocationVisibilityTier = "city";

/**
 * Coarsen a media location AND enforce Hidden-Gem protection in one step.
 *
 * The media inherits the STRICTER of (its own LocationVisibility tier, the
 * hosting gem's ceiling). When gem protection is undetermined, or absent from
 * the options entirely, we treat it as undetermined and coarsen to at least
 * `UNDETERMINED_GEM_CEILING` — so a caller that forgets to run the cross-check
 * cannot leak. The media OWNER still sees their own exact location: they placed
 * it, so serving it back to them de-anonymizes nothing.
 */
export function resolveMediaLocationWithGemProtection(
  input: MediaLocationInput,
  opts: CoarsenOpts & { gem?: GemProtection } = {},
): MediaLocationDisclosure {
  // Owner bypass — gem protection guards OTHER viewers, not the media owner.
  if (opts.isOwner === true) {
    return coarsenMediaLocation(input, { ...opts, isOwner: true });
  }

  const gem: GemProtection = opts.gem ?? { ceiling: null, determined: false };

  // Determine the gem ceiling. Undetermined ⇒ fail-closed ceiling.
  const gemCeiling: LocationVisibilityTier | null = gem.determined
    ? gem.ceiling
    : UNDETERMINED_GEM_CEILING;

  const ownTier = normalizeTier(opts.locationVisibility);
  const effectiveTier =
    gemCeiling == null ? ownTier : stricterTier(ownTier, gemCeiling);

  return coarsenMediaLocation(input, { ...opts, locationVisibility: effectiveTier, isOwner: false });
}

// ── Owner privacy mode → media location ceiling ───────────────────────────────

/**
 * The `posts.location_privacy_mode` enum (migration 20260720 / DB enum
 * `post_location_privacy_mode`). This is the OWNER's own choice about how
 * precisely their post may be located — an axis independent of both the §33
 * LocationVisibility tier and the Hidden-Gem ceiling.
 */
export const POST_LOCATION_PRIVACY_MODES = [
  "none",
  "hidden",
  "city_only",
  "delayed_until_exit",
  "delayed_until_time",
  "trusted_circle_only",
] as const;
export type PostLocationPrivacyMode = (typeof POST_LOCATION_PRIVACY_MODES)[number];

/**
 * The finest tier a post may be disclosed at given its OWNER's privacy mode,
 * for a non-owner viewer. `null` means the mode imposes no constraint.
 *
 * This mirrors `lib/postSchemas.mapPublicPost` — the redactor routes/posts.ts
 * has always applied — rather than inventing a second owner-privacy policy:
 *
 *   • mapPublicPost nulls `location_name` (the venue) and keeps city/country for
 *     hidden / city_only / trusted_circle_only, and for a delayed mode until the
 *     post is published. In tier terms that disclosure boundary IS 'city'.
 *   • 'none' (and an absent mode) redacts nothing → no constraint.
 *
 * `mediaPrivacyModeParity` in the test suite asserts the two stay in lockstep,
 * so this table cannot drift away from the redactor it mirrors.
 *
 * FAIL CLOSED: an unrecognised mode returns 'city', never null.
 */
export function locationPrivacyModeToCeiling(
  mode: PostLocationPrivacyMode | string | null | undefined,
  postStatus?: string | null,
): LocationVisibilityTier | null {
  if (mode == null || mode === "" || mode === "none") return null;
  switch (mode) {
    case "hidden":
    case "city_only":
    case "trusted_circle_only":
      return "city";
    case "delayed_until_exit":
    case "delayed_until_time":
      // Suppressed until the delayed-publish worker releases it (the same
      // `post_status === 'published'` condition mapPublicPost checks).
      return postStatus === "published" ? null : "city";
    default:
      return "city";
  }
}

// ── The full media place disclosure (tier + owner mode + gem ceiling) ─────────

export interface MediaPlaceDisclosureOpts extends CoarsenOpts {
  /** Hidden-Gem protection for this item. Absent ⇒ undetermined ⇒ fail-closed. */
  gem?: GemProtection;
  /** The owner's `posts.location_privacy_mode`. */
  locationPrivacyMode?: PostLocationPrivacyMode | string | null;
  /** `posts.post_status` — only read to resolve the delayed-publish modes. */
  postStatus?: string | null;
}

export interface MediaPlaceDisclosure extends MediaLocationDisclosure {
  /**
   * Whether the opaque canonical place id may be disclosed.
   *
   * A canonical place id is a PLACE-LEVEL identifier: handing it to a client
   * that can resolve it through the Map/place gateway discloses the venue just
   * as precisely as printing its name. It therefore rides the same tier as the
   * venue label — true only for the owner, or when the effective tier is the
   * finest public tier ('place'). At city/neighborhood/country/hidden it is
   * withheld, which is what makes a gem's 'city' ceiling actually bind.
   */
  mayDisclosePlaceId: boolean;
}

/**
 * THE media location choke point for surfaces that also emit a canonical place
 * id. Folds all THREE independent constraints together and takes the strictest:
 *
 *   1. the item's own §33 LocationVisibility tier,
 *   2. the OWNER's `location_privacy_mode` (their explicit choice),
 *   3. the hosting Hidden Gem's ceiling (undetermined ⇒ fail-closed).
 *
 * The media OWNER bypasses all three for their own item — serving their own
 * location back to them de-anonymizes nothing.
 */
export function resolveMediaPlaceDisclosure(
  input: MediaLocationInput,
  opts: MediaPlaceDisclosureOpts = {},
): MediaPlaceDisclosure {
  if (opts.isOwner === true) {
    const owned = coarsenMediaLocation(input, { ...opts, isOwner: true });
    return { ...owned, mayDisclosePlaceId: true };
  }

  const ownTier = normalizeTier(opts.locationVisibility);
  const modeCeiling = locationPrivacyModeToCeiling(opts.locationPrivacyMode, opts.postStatus);
  const withMode = modeCeiling == null ? ownTier : stricterTier(ownTier, modeCeiling);

  const d = resolveMediaLocationWithGemProtection(input, {
    ...opts,
    isOwner: false,
    locationVisibility: withMode,
  });
  return { ...d, mayDisclosePlaceId: d.visibility === "place" };
}

// ── Gem cross-check (DB + pure) ────────────────────────────────────────────────

/** Restrictive gem row shape needed to compute a ceiling for a place/coordinate. */
export interface RestrictiveGem {
  canonical_place_id: string | null;
  sensitivity_level: GemSensitivity | string;
  latitude: number | null;
  longitude: number | null;
  approx_latitude: number | null;
  approx_longitude: number | null;
}

/** Sensitivity levels that constrain nearby media. 'public' never does. */
export const RESTRICTIVE_GEM_SENSITIVITIES: readonly string[] = [
  "protected",
  "approximate",
  "reveal_after_save",
  "reveal_after_acceptance",
];

/** Gem statuses that still count as live enough to protect a location. */
const LIVE_GEM_STATUSES: readonly string[] = ["active", "pending", "hidden"];

/** ~300 m — a protected/reveal gem within this of the disclosed point matches. */
const EXACT_MATCH_RADIUS_M = 300;
/** ~1500 m — an approximate gem's centroid within this of the point matches. */
const APPROX_MATCH_RADIUS_M = 1500;

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * PURE. Compute the strictest gem ceiling that applies to a media item, cross-
 * referencing BOTH the gem↔place linkage (canonical_place_id) AND coordinate
 * proximity (so a post that sits on a protected gem's coordinates is caught even
 * when it never resolved to the gem's canonical place).
 *
 * Returns the coarsest (strictest) ceiling among all matching gems, or null when
 * no restrictive gem matches.
 */
export function gemCeilingForItem(
  gems: readonly RestrictiveGem[],
  item: { placeId?: string | null; lat?: number | null; lng?: number | null },
): LocationVisibilityTier | null {
  const placeId = item.placeId ?? null;
  const lat = typeof item.lat === "number" && Number.isFinite(item.lat) ? item.lat : null;
  const lng = typeof item.lng === "number" && Number.isFinite(item.lng) ? item.lng : null;

  let result: LocationVisibilityTier | null = null;
  const tighten = (c: LocationVisibilityTier | null) => {
    if (c == null) return;
    result = result == null ? c : stricterTier(result, c);
  };

  for (const g of gems) {
    const ceiling = gemSensitivityToCeiling(g.sensitivity_level);
    if (ceiling == null) continue; // public gem — no constraint

    // 1) Same canonical place → always applies.
    if (placeId != null && g.canonical_place_id != null && g.canonical_place_id === placeId) {
      tighten(ceiling);
      continue;
    }

    // 2) Coordinate proximity → applies when the point we would disclose sits
    //    on top of the gem. Uses the gem's exact coords for protected/reveal
    //    and its approx centroid for approximate.
    if (lat == null || lng == null) continue;
    const isApprox = g.sensitivity_level === "approximate";
    const gLat = isApprox ? g.approx_latitude : g.latitude;
    const gLng = isApprox ? g.approx_longitude : g.longitude;
    if (gLat == null || gLng == null) continue;
    const radius = isApprox ? APPROX_MATCH_RADIUS_M : EXACT_MATCH_RADIUS_M;
    if (haversineMeters(lat, lng, gLat, gLng) <= radius) {
      tighten(ceiling);
    }
  }

  return result;
}

const RESTRICTIVE_GEM_COLUMNS =
  "canonical_place_id, sensitivity_level, latitude, longitude, approx_latitude, approx_longitude";

/**
 * Load restrictive (non-public) live gems that could constrain any of the given
 * places or cities. Callers pass the union of canonical_place_ids and cities
 * across the media being served; the returned rows are then matched per-item
 * with the pure `gemCeilingForItem`.
 *
 * Two SEPARATE `.in()` queries (place-arm, city-arm) rather than one composed
 * `.or()` string: `location_city` is user-controllable text, and hand-building a
 * PostgREST `.or()` filter from it would be a filter-injection vector. The
 * supabase-js `.in()` builder encodes its values safely. Results are de-duped by
 * a synthetic key so a gem matched by both arms appears once.
 *
 * THROWS on a query error — the caller MUST catch and treat the whole batch as
 * undetermined (fail-closed), never as "no gems".
 */
export async function loadRestrictiveGems(
  db: SupabaseClient,
  args: { placeIds?: (string | null | undefined)[]; cities?: (string | null | undefined)[] },
): Promise<RestrictiveGem[]> {
  const placeIds = Array.from(
    new Set((args.placeIds ?? []).filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  const cities = Array.from(
    new Set((args.cities ?? []).filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  if (placeIds.length === 0 && cities.length === 0) return [];

  const base = () =>
    db
      .from("hidden_gems")
      .select(RESTRICTIVE_GEM_COLUMNS)
      .in("status", LIVE_GEM_STATUSES as string[])
      .in("sensitivity_level", RESTRICTIVE_GEM_SENSITIVITIES as string[]);

  const queries: Promise<{ data: any; error: any }>[] = [];
  if (placeIds.length > 0) queries.push(Promise.resolve(base().in("canonical_place_id", placeIds)));
  if (cities.length > 0) queries.push(Promise.resolve(base().in("city", cities)));

  const results = await Promise.all(queries);
  const merged = new Map<string, RestrictiveGem>();
  for (const { data, error } of results) {
    if (error) throw new Error(`loadRestrictiveGems failed: ${error.message ?? "unknown"}`);
    for (const g of (data as RestrictiveGem[] | null) ?? []) {
      const key = `${g.canonical_place_id ?? ""}|${g.sensitivity_level}|${g.latitude ?? ""}|${g.longitude ?? ""}|${g.approx_latitude ?? ""}|${g.approx_longitude ?? ""}`;
      if (!merged.has(key)) merged.set(key, g);
    }
  }
  return Array.from(merged.values());
}

/**
 * Convenience: turn a per-item ceiling lookup into a `GemProtection` for the
 * resolver. `determined` is the batch-level flag — true when the gem query
 * succeeded (even if it returned nothing), false when it threw.
 */
export function toGemProtection(
  ceiling: LocationVisibilityTier | null,
  determined: boolean,
): GemProtection {
  return { ceiling, determined };
}
