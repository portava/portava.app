/**
 * §32 G198 — the COMPACT local city index.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `city_picker`, `trip_destination`, `neighborhood_picker`, `passport_homebase`
 * and `global_search` all carry the offline policy `cached_local` — the
 * authority licenses a local surface for them. What existed was the 60-entry,
 * 60-second in-memory SWR cache, which is empty on a cold start, so an app
 * opened offline had nothing for any of them. The census recorded the irony in
 * the same breath: "`lib/cityCentroids.ts` exists but is a map-camera helper,
 * not consumed by this layer". Consuming it IS the fix.
 *
 * ── HOW THIS SET WAS BOUNDED, EXACTLY ────────────────────────────────────────
 *
 * It is `CITY_CENTROIDS` — the city names this app ALREADY ships so a map
 * camera has somewhere to point before entity data loads — plus `CITY_ALIASES`,
 * the alternate-spelling map that already sits beside it, folded in as aliases.
 * Nothing is added and no name is re-spelled. Roughly 270 cities.
 *
 * WHY THAT BOUND AND NOT A GAZETTEER. A world city list is 100k+ rows and
 * several megabytes; shipping one to answer an offline picker would cost every
 * user the download and still be wrong the day after it was generated. The
 * bound chosen instead is "the cities this product already names" — which is
 * not arbitrary: those keys are the cities Portava has content, events and
 * stamps for, so they are the cities a user of THIS app is most likely to type.
 *
 * WHAT IT OMITS, stated so nobody has to infer it:
 *   - every city not already in `CITY_CENTROIDS` — which is most of the world;
 *   - countries and regions. `REGION_CENTROIDS` ("Europe", "Southeast Asia")
 *     and the `COUNTRY_CENTROIDS` in that same file are deliberately NOT read
 *     here: a continent is not a city, and an offline city picker that offered
 *     "Asia" as a destination would be inventing a kind of answer the server
 *     never gives in that field;
 *   - coordinates. The centroids are the SOURCE of the name list and are not
 *     carried onto a suggestion: a local row asserts a name, never a position
 *     (§24/§29), and the field being filled wants text.
 *   - any entity identity — see `types.ts`.
 *
 * DERIVED AT MODULE LOAD, NOT DUPLICATED. The alternative was to paste 270 city
 * names into this file, which would have created a second list free to drift
 * from the first. A derivation cannot drift.
 */
import { CITY_CENTROIDS, CITY_ALIASES } from '../../../lib/cityCentroids.ts';
import type { LocalDictionaryEntry } from './types.ts';

function buildCityIndex(): readonly LocalDictionaryEntry[] {
  // alias → canonical key, inverted to canonical key → aliases.
  const aliasesFor = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    // `CITY_ALIASES` contains several deliberate self-references (its own
    // header calls them "already canonical; kept for clarity"). An alias equal
    // to its label matches nothing extra and would render as a duplicate
    // spelling in a debug dump, so it is dropped here rather than carried.
    if (alias.toLowerCase() === canonical.toLowerCase()) continue;
    const list = aliasesFor.get(canonical) ?? [];
    list.push(alias);
    aliasesFor.set(canonical, list);
  }

  const out: LocalDictionaryEntry[] = [];
  for (const label of Object.keys(CITY_CENTROIDS)) {
    const aliases = aliasesFor.get(label);
    out.push(aliases && aliases.length > 0 ? { label, aliases, code: label } : { label, code: label });
  }
  return out;
}

/**
 * The compact index, most-listed-first in `CITY_CENTROIDS`' own order (which is
 * regional, not ranked — this layer does not re-rank, §42).
 */
export const CITY_INDEX: readonly LocalDictionaryEntry[] = buildCityIndex();
