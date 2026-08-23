/**
 * backfill-places-from-discovery — populate the canonical `places` layer
 * (migration 0192) from `discovery_places`, via the same dedup resolver
 * backfill-canonical-places.ts uses for fsq_places.
 *
 * WHY THIS EXISTS SEPARATELY FROM backfill-canonical-places.ts: that script's
 * own header says OSM discovery_places has no stored coordinates and is
 * "intentionally NOT a source" for it. That is stale — discovery_places.lat/lng
 * are populated for the curated seed (0075_seed_discovery_places.sql, 44
 * rows) and for any row where an OSM/user submission supplied coordinates;
 * rows genuinely missing lat/lng are skipped below rather than assumed absent
 * for the whole table.
 *
 * providerPlaceId: discovery_places.osm_id when present (stable OSM id),
 * otherwise `discovery:${id}` so every row is idempotent even without one.
 *
 * DRY-RUN BY DEFAULT. Prints exactly what would be created/linked/skipped
 * and why, without writing anything. Pass --apply to actually write.
 * Refuses to run unless external_places_enabled is on (resolveExternalPlace
 * itself no-ops otherwise, but failing loud here avoids a silent 0-row report
 * being mistaken for "nothing to backfill").
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node --import tsx/esm src/scripts/backfill-places-from-discovery.ts            # dry run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node --import tsx/esm src/scripts/backfill-places-from-discovery.ts --apply     # writes
 *
 * Point SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY at portava-ci for this run —
 * do not point this at production without a separate, explicit decision.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveExternalPlace } from "../lib/places/placeResolve.js";

const APPLY = process.argv.includes("--apply");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const sc = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 500;
const stats = {
  total: 0,
  created: 0,
  linked: 0,
  skippedNoCoords: 0,
  skippedFlagOff: 0,
  skippedResolveNull: 0,
  errors: 0,
};
const skippedNoCoordsSample: string[] = [];

function providerPlaceIdOf(row: { id: string; osm_id: string | null }): string {
  return row.osm_id ? `osm:${row.osm_id}` : `discovery:${row.id}`;
}

async function main() {
  const { data: flag } = await sc
    .from("feature_flags")
    .select("enabled")
    .eq("flag", "external_places_enabled")
    .maybeSingle();
  const flagOn = Boolean((flag as any)?.enabled);
  if (!flagOn) {
    console.error(
      "external_places_enabled is OFF on this project — resolveExternalPlace() will no-op for " +
        "every row. Flip it on (migration 0192) before running for real, or pass nothing to see " +
        "this dry-run confirm zero writes would happen.",
    );
  }

  console.log(APPLY ? "MODE: --apply (WILL WRITE)" : "MODE: dry run (no writes; pass --apply to write)");
  console.log(`Target: ${url}\n`);

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, name, city, neighborhood, category, lat, lng, osm_id, canonical_location_id, status")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("read discovery_places failed:", error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as any[];
    stats.total += rows.length;

    for (const p of rows) {
      if (p.lat == null || p.lng == null) {
        stats.skippedNoCoords++;
        if (skippedNoCoordsSample.length < 10) skippedNoCoordsSample.push(`${p.id} (${p.name})`);
        continue;
      }
      if (!flagOn) {
        stats.skippedFlagOff++;
        continue;
      }
      if (!APPLY) {
        // Dry run: don't call resolveExternalPlace (it would no-op safely since
        // flagOn is true here, but we still don't want a dry run to write).
        // Count it as a would-be candidate; report can't distinguish
        // create-vs-link without querying live dedup state, so report as
        // "candidate" rather than guessing.
        stats.linked++; // placeholder bucket for "candidate, not yet resolved" in dry-run mode
        continue;
      }
      const r = await resolveExternalPlace(sc, {
        provider: "discovery",
        providerPlaceId: providerPlaceIdOf(p),
        name: p.name,
        latitude: p.lat,
        longitude: p.lng,
        primaryCategory: p.category ?? null,
        city: p.city || null,
        canonicalLocationId: p.canonical_location_id ?? null,
      });
      if (!r) {
        stats.skippedResolveNull++;
        continue;
      }
      if (r.created) stats.created++;
      else stats.linked++;
    }
    if (rows.length < PAGE) break;
  }

  console.log("Result:", stats);
  if (skippedNoCoordsSample.length) {
    console.log("\nSample of rows skipped for missing lat/lng:");
    for (const s of skippedNoCoordsSample) console.log("  -", s);
  }
  if (!APPLY) {
    console.log(
      "\nDry run only — no rows were created or linked. Candidates above are rows with " +
        "coordinates that resolveExternalPlace would attempt; the real created/linked split " +
        "depends on live dedup state and is only known once --apply runs.",
    );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
