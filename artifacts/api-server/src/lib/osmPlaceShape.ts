/**
 * osmPlaceShape — the ONE definition of how an OSM element becomes a place.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * Two code paths turn the same OSM element into a place: the live Discovery
 * route (`routes/discovery.ts`) and the seeder (`scripts/seed-discovery-places.ts`).
 * They had **drifted apart**, and the ruling is that they must represent the
 * same place shape.
 *
 * The reason is about testing rather than tidiness. When the seeded and live
 * paths disagree about what a field means, **the same real place looks
 * different depending on which path produced it** — so a genuine defect and a
 * mere path difference become indistinguishable. That produces failures in both
 * directions at once: **false regressions** (a change looks broken because QA
 * compared across paths) and **false confidence** (a change looks fine because
 * QA happened to check the path it did not affect).
 *
 * Sharing the function rather than documenting the convention is deliberate.
 * A convention written down can drift again; a single exported function cannot,
 * because there is only one of it.
 *
 * ── WHAT IS SHARED HERE, AND WHAT IS DELIBERATELY NOT ────────────────────────
 *
 * `neighborhood` is unified here. Three OTHER divergences between the two paths
 * were found while doing it and are **filed rather than silently unified**,
 * because each would change what the live feed returns — a product change, not
 * a consistency fix. See `docs/discovery/seed-live-place-shape-divergences.md`.
 */

/**
 * Neighbourhood label for an OSM element, most specific key first.
 *
 * **This chain is the UNION of what the two paths used to do separately**, and
 * neither was a superset of the other:
 *
 * | key | live route (before) | seeder (before) |
 * |---|---|---|
 * | `addr:neighbourhood` | ✅ | ❌ |
 * | `neighbourhood` | ❌ | ✅ |
 * | `addr:suburb` | ❌ | ✅ |
 * | `suburb` | ❌ | ✅ |
 *
 * So a place tagged only `addr:neighbourhood` had a neighbourhood when served
 * live and none when seeded, and a place tagged only `suburb` had the reverse.
 * Same place, same OSM data, two different answers.
 *
 * **The order is the LIVE route's existing order, unchanged.** That is a
 * deliberate choice against a tidier-looking one. Grouping the two `addr:*`
 * keys ahead of the two bare keys would arguably be more principled — address
 * components of *this* venue before areas it merely sits in — but it would
 * flip the answer for any place carrying `neighbourhood` and `addr:suburb`
 * together, which is a change to what the live feed returns. **The ruling asks
 * for one shape, not a better one**, so the seeder moves onto the live order
 * and the live feed is untouched.
 *
 * **Known limitation, filed not hidden:** this returns null for cities that
 * encode locality some other way. Paris measured **0.0%** across 493 places
 * because it uses arrondissements. That is a normalisation gap, not missing
 * data — see `docs/discovery/paris-geography-adapter.md`.
 */
export function osmNeighborhood(tags: Record<string, string>): string | null {
  const raw =
    tags["addr:neighbourhood"] ??
    tags["neighbourhood"] ??
    tags["addr:suburb"] ??
    tags["suburb"] ??
    null;
  const v = raw?.trim();
  return v ? v : null;
}
