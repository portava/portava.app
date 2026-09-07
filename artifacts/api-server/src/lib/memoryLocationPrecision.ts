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
 * The DEFAULT migration 2338 gave `memories.location_precision`, mirrored here
 * so the code and the schema cannot drift apart silently (a test reads the
 * migration file and compares).
 *
 * THIS VALUE IS NOT A RECOMMENDATION. 2338 chose 'exact' because it reproduces
 * pre-2338 behaviour for the 80 production Memories (all public, all with
 * coordinates, all served at full precision today) — a migration is not the
 * place to decide that they should suddenly be served at city level. What the
 * default SHOULD be for newly created Memories, and whether existing rows
 * should be re-rated, is an OWNER DECISION that this module deliberately does
 * not take. Nothing below changes behaviour based on this constant; it exists
 * so the pending decision has one named place to land.
 */
export const MEMORY_LOCATION_PRECISION_SCHEMA_DEFAULT: MemoryLocationPrecision = "exact";

/** True when `v` is exactly one of the six rungs. PURE. */
export function isMemoryLocationPrecision(v: unknown): v is MemoryLocationPrecision {
  return typeof v === "string" && (MEMORY_LOCATION_PRECISIONS as readonly string[]).includes(v);
}

/**
 * Normalize a stored value to a known rung, for a reader that has the column.
 *
 * THREE INPUT STATES, TWO OF WHICH FAIL CLOSED
 * --------------------------------------------
 *   undefined     The column was NOT SELECTED — the reader runs with
 *                 `memory_location_precision_enabled` off, on a database that
 *                 may not have the column (production does not). There is no
 *                 policy to read. This is the status quo, 'exact', and it is the
 *                 ONLY input that resolves to 'exact' without the row saying so.
 *
 *   null / ""     The column WAS selected and is EMPTY. On a database with
 *                 2338 that cannot happen (NOT NULL DEFAULT 'exact' backfills
 *                 every pre-existing row), so a null here is an anomaly: a
 *                 future migration that relaxed NOT NULL, a projection that
 *                 left the field out, a hand-edited row. An anomaly must not
 *                 widen disclosure → 'hidden'.
 *
 *   other string  Present but not on the ladder — corruption → 'hidden'.
 *
 * Earlier this mapped null to 'exact' on the reasoning that "the row predates
 * 2338". That reasoning does not survive the migration itself: ADD COLUMN ...
 * NOT NULL DEFAULT 'exact' stamps every existing row, so no row that HAS the
 * column can be null through age. The only null-with-column case is a defect,
 * and the safe reading of a defect in a privacy control is the private one.
 *
 * Callers on the PUBLICATION path should not call this directly: use
 * `publicationPrecision`, which also refuses to trust an absent column when
 * the flag says the column should be there.
 */
export function normalizeMemoryPrecision(v: unknown): MemoryLocationPrecision {
  if (v === undefined) return "exact";
  if (isMemoryLocationPrecision(v)) return v;
  return "hidden";
}

/**
 * The rung a NON-OWNER read must be clamped to, given whether the precision
 * gate is on for this request.
 *
 *   gate OFF  → 'exact'. The column is not named anywhere in this request;
 *               behaviour is byte-for-byte pre-2338. (On production today, the
 *               only correct value: the column does not exist there.)
 *
 *   gate ON   → the row's rung; and when the row does NOT carry the key at all
 *               (a reader that forgot to select it, a projection missing the
 *               field) → 'hidden'. With the gate on, "I could not read the
 *               owner's policy" must not be served as "the owner chose exact".
 *
 * This is the read-side normalization that makes the null/missing case safe
 * WITHOUT deciding what the default should be: it never invents a rung, it
 * only refuses to widen when the rung is unavailable.
 */
export function publicationPrecision(
  row: { location_precision?: unknown } | null | undefined,
  precisionGateOn: boolean,
): MemoryLocationPrecision {
  if (!precisionGateOn) return "exact";
  const v = row?.location_precision;
  if (v === undefined) return "hidden";
  return normalizeMemoryPrecision(v);
}

/**
 * Write-side normalization for an owner-supplied rung.
 *
 * Returns the rung when it is exactly one of the six, and `undefined` — "do
 * not name the column; let the database DEFAULT apply" — for anything else,
 * including null and near-misses like "EXACT". A value that is not on the
 * ladder is never written, so the CHECK constraint is the second line, not the
 * first. It does not substitute a default of its own: what a new Memory's rung
 * should be when the owner said nothing is the schema DEFAULT today and the
 * owner's decision tomorrow (see MEMORY_LOCATION_PRECISION_SCHEMA_DEFAULT).
 */
export function normalizeMemoryPrecisionForWrite(v: unknown): MemoryLocationPrecision | undefined {
  return isMemoryLocationPrecision(v) ? v : undefined;
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
