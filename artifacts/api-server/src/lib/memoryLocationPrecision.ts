/**
 * memoryLocationPrecision — Highlights/Memories Development Architecture
 * Spec v1, §4 `LocationPrecision`, §10 "Publishing location must never exceed
 * the owner's selected precision", and §23's policy function
 * `canSeeExactLocation(userId, memoryId)`.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Before this module, a Memory's `location_lat` / `location_lng` reached every
 * permitted viewer at full stored precision. The only clamp on the path was
 * `gemProtectMemoryRow` in routes/memories.ts — the Hidden-Gem ceiling, which
 * answers "is this coordinate sitting on a protected gem". That is a good
 * guard and it stays; it is simply not the same question. It is a property of
 * the PLACE. §10's question is a property of the OWNER'S CHOICE: how precisely
 * may THIS Memory of mine be published, to anyone who is not me. A Memory at an
 * unremarkable address that the owner wants shown only at city level has no gem
 * to protect it and, until now, no way to say so.
 *
 * WHY A SECOND LADDER, AND NOT lib/mediaLocationVisibility's
 * ---------------------------------------------------------
 * mediaLocationVisibility already carries a six-rung ladder and this module
 * deliberately does NOT redefine its coarsening maths — `coarsenMemoryLocation`
 * below delegates to `coarsenMediaLocation`, including the deterministic
 * grid-snap, so a coarse Memory coordinate and a coarse media coordinate are
 * produced by exactly one implementation.
 *
 * What differs is the VOCABULARY, and it differs for a reason. The media ladder
 * is `hidden / country / city / neighborhood / place / precise_private`: its top
 * rung is an owner-private state. The spec's ladder is
 * `EXACT / VENUE / NEIGHBORHOOD / CITY / COUNTRY / HIDDEN`: its top rung is a
 * publication rung, and `VENUE` is not a synonym for the media ladder's `place`
 * in the owner's mental model even though the two coarsen identically today.
 * Collapsing them would mean one stored string had two meanings depending on
 * which table it sat in. So the vocabularies are kept apart and CONVERTED at
 * exactly one point (`precisionToMediaTier`), which is also the point where the
 * two are COMPOSED — by taking the stricter, never the looser, of the owner's
 * rung and the gem ceiling. Neither ladder can be used to widen the other.
 *
 * PURE. No DB access. Every function is decidable from its arguments, which is
 * what makes the §23 policy predicate testable in isolation.
 */
import {
  coarsenMediaLocation,
  stricterTier,
  type LocationVisibilityTier,
  type MediaLocationDisclosure,
} from "./mediaLocationVisibility.js";

// ── §4 LocationPrecision ──────────────────────────────────────────────────────

/** Finest → coarsest, in the spec's own order. */
export const MEMORY_LOCATION_PRECISIONS = [
  "exact",
  "venue",
  "neighborhood",
  "city",
  "country",
  "hidden",
] as const;
export type MemoryLocationPrecision = (typeof MEMORY_LOCATION_PRECISIONS)[number];

/**
 * Rank, coarsest (0) → finest (5), so "stricter" is "numerically smaller" and
 * matches the rank direction in mediaLocationVisibility.
 */
const PRECISION_RANK: Record<MemoryLocationPrecision, number> = {
  hidden: 0,
  country: 1,
  city: 2,
  neighborhood: 3,
  venue: 4,
  exact: 5,
};

/**
 * Normalize a candidate value to a known rung.
 *
 * FAIL CLOSED IS NOT THE RIGHT DEFAULT HERE, AND THAT IS DELIBERATE.
 * `normalizeTier` in mediaLocationVisibility maps anything unknown to 'hidden',
 * because there the absent value means "migration 2250 laid the column with
 * default 'hidden' and nobody has set it". Here the absent value means
 * something different and precisely knowable: the row predates migration 2338,
 * or this database has not run it, or the reader did not select the column
 * because the flag is off. In every one of those cases the row's ACTUAL
 * published precision today is exact — coarsening it to 'hidden' on a null
 * would blank the location of all 80 production Memories the moment anything
 * mis-wired the flag, which is a bigger and much less obvious failure than the
 * one it would prevent.
 *
 * So: null/undefined/absent → 'exact' (status quo, no behaviour change), and an
 * unrecognised NON-EMPTY string → 'hidden' (fail closed — a value that is
 * present but not in the ladder is corruption, and corruption must not widen
 * disclosure). Callers that want the strict reading of a missing value should
 * not call this; they should not be reading precision at all.
 */
export function normalizeMemoryPrecision(v: unknown): MemoryLocationPrecision {
  if (v == null || v === "") return "exact";
  if (typeof v === "string" && (MEMORY_LOCATION_PRECISIONS as readonly string[]).includes(v)) {
    return v as MemoryLocationPrecision;
  }
  return "hidden";
}

/** The stricter (coarser) of two rungs. */
export function stricterPrecision(
  a: MemoryLocationPrecision,
  b: MemoryLocationPrecision,
): MemoryLocationPrecision {
  return PRECISION_RANK[a] <= PRECISION_RANK[b] ? a : b;
}

/**
 * Convert a spec rung to the media ladder tier that coarsens identically.
 * `exact` has no media equivalent for a non-owner (the media ladder's finest
 * non-owner tier is 'place'), so it returns null meaning "no constraint from
 * the owner's policy" — the gem ceiling, if any, still applies on its own.
 */
export function precisionToMediaTier(
  p: MemoryLocationPrecision,
): LocationVisibilityTier | null {
  switch (p) {
    case "exact":        return null;
    case "venue":        return "place";
    case "neighborhood": return "neighborhood";
    case "city":         return "city";
    case "country":      return "country";
    case "hidden":       return "hidden";
  }
}

// ── §23 policy predicate ──────────────────────────────────────────────────────

/**
 * `canSeeExactLocation(userId, memoryId)` from §23, expressed over the row the
 * caller has already loaded rather than re-reading it.
 *
 * The owner always can. Nobody else can unless the owner's rung is 'exact'.
 * Note what this does NOT claim: a true answer means the OWNER'S POLICY permits
 * the exact coordinate, not that the viewer will receive it — the Hidden-Gem
 * ceiling is a separate, independently sufficient reason to coarsen, and
 * `resolveMemoryLocationCeiling` is where the two meet.
 */
export function canSeeExactLocation(
  viewerId: string | null,
  memory: { owner_id?: string | null; location_precision?: unknown } | null | undefined,
): boolean {
  if (!memory) return false;
  if (viewerId != null && viewerId === memory.owner_id) return true;
  return normalizeMemoryPrecision(memory.location_precision) === "exact";
}

// ── Composition with the Hidden-Gem ceiling ───────────────────────────────────

/**
 * The single effective ceiling for a non-owner read: the STRICTER of the
 * owner's §10 rung and whatever ceiling the Hidden-Gem guard already imposed.
 *
 * `gemCeiling` is the value routes/memories.ts already computes via
 * `gemCeilingForItem` / `UNDETERMINED_GEM_CEILING`; null there means "no gem
 * constraint". A null from BOTH inputs (owner rung 'exact', no gem) returns
 * null, meaning "serve the row unchanged" — which is exactly the pre-2338
 * behaviour and is why an off flag is a no-op.
 */
export function resolveMemoryLocationCeiling(
  precision: MemoryLocationPrecision,
  gemCeiling: LocationVisibilityTier | null,
): LocationVisibilityTier | null {
  const own = precisionToMediaTier(precision);
  if (own == null) return gemCeiling;
  if (gemCeiling == null) return own;
  return stricterTier(own, gemCeiling);
}

/**
 * Apply an effective ceiling to a Memory's raw (snake_case) location columns.
 *
 * Returns the coarsened city/country/lat/lng. Delegates every coarsening
 * decision, including the deterministic grid-snap, to `coarsenMediaLocation`;
 * this function's only job is to hand it the right tier and seed.
 */
export function coarsenMemoryLocation(
  row: { id?: unknown; location_city?: unknown; location_country?: unknown; location_lat?: unknown; location_lng?: unknown },
  ceiling: LocationVisibilityTier,
): MediaLocationDisclosure {
  const lat = row?.location_lat != null ? Number(row.location_lat) : null;
  const lng = row?.location_lng != null ? Number(row.location_lng) : null;
  return coarsenMediaLocation(
    {
      name: null,
      city: (row?.location_city as string | null) ?? null,
      country: (row?.location_country as string | null) ?? null,
      lat,
      lng,
    },
    {
      locationVisibility: ceiling,
      isOwner: false,
      coarsenSeed: String(row?.id ?? ""),
      emitCoarseCoords: true,
    },
  );
}
