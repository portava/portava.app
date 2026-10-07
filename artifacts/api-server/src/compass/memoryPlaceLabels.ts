/**
 * The place WORDS a non-owner may be given for a Memory — §10's location-precision
 * rung applied to its city and country — shared by the Compass Memory tools
 * (MemoryCompassTools.ts, census-compass §45) and the intelligence graph
 * (CompassGraphEngine.ts, §47).
 *
 * The city and country a NON-OWNER may be shown for a Memory on a surface that
 * carries place words and nothing finer. The same rule as `protectMemoryRow`
 * (routes/memories.ts) and as lane R's `memoryPlaceLabelsForNonOwner`
 * (lib/memoryLocationPrecision.ts on claude/residual-wave2-20261006, 2c73813c9),
 * which is not on main yet, so it is written out here from main's own parts.
 * When R's helper lands, import it and delete this copy; the callers do not change.
 *
 * It takes the stricter of the owner's §10 rung and the Hidden-Gem ceiling,
 * coarsened by `coarsenMemoryLocation`. `precisionClamp` is
 * `precisionClampApplies(gate)`. With a clamp, a row that does not carry
 * `location_precision` (the gate was unreadable, or the rung read failed), or
 * that carries null or a value off the ladder, is 'hidden'. That means no
 * city and no country. Gate definitely off: 'exact', the pre-2338 behaviour.
 * The gem ceiling is taken at its strictest (`UNDETERMINED_GEM_CEILING`,
 * 'city'), which keeps both words, so a gem lookup could not change the answer.
 */
import { publicationPrecision, resolveMemoryLocationCeiling, coarsenMemoryLocation } from "../lib/memoryLocationPrecision.js";
import { UNDETERMINED_GEM_CEILING } from "../lib/mediaLocationVisibility.js";

export function memoryPlaceLabelsForNonOwner(
  row: { id?: unknown; location_city?: unknown; location_country?: unknown; location_precision?: unknown },
  precisionClamp: boolean,
): { city: string | null; country: string | null } {
  const ceiling =
    resolveMemoryLocationCeiling(publicationPrecision(row, precisionClamp), UNDETERMINED_GEM_CEILING) ??
    UNDETERMINED_GEM_CEILING;
  const d = coarsenMemoryLocation(
    { id: row?.id, location_city: row?.location_city, location_country: row?.location_country },
    ceiling,
  );
  return { city: d.city, country: d.country };
}
