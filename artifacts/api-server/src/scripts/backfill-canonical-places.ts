/**
 * backfill-canonical-places — populate the canonical `places` layer (migration
 * 0192) from the ingested `fsq_places` provider rows, via the dedup resolver.
 *
 * This is the ingestion wiring for external places: run it after flipping
 * `external_places_enabled` on (and after each new FSQ city ingest) to turn
 * provider rows into deduplicated canonical places + references. Idempotent —
 * the resolver is keyed on (provider, provider_place_id) and dedups by
 * proximity, so re-running never creates duplicates.
 *
 * fsq_places is the source with coordinates + a stable provider id; OSM
 * `discovery_places` has no stored coordinates, so it is intentionally NOT a
 * source here (can't be spatially deduped) — resolve OSM on the read path later
 * if wanted.
 *
 * Usage (refuses unless external_places_enabled is on):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node --import tsx/esm src/scripts/backfill-canonical-places.ts
 */
import { createClient } from "@supabase/supabase-js";
import { resolveExternalPlace } from "../lib/places/placeResolve.js";
import { FSQ_ATTRIBUTION } from "../lib/fsq/fsqPlaces.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const sc = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 500;
const stats = { created: 0, linked: 0, skipped: 0, errors: 0 };

function countryCodeOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

async function main() {
  const { data: flag } = await sc.from("feature_flags").select("enabled").eq("flag", "external_places_enabled").maybeSingle();
  if (!(flag as any)?.enabled) {
    console.error("external_places_enabled is OFF — flip it on before backfilling (migration 0192).");
    process.exit(1);
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sc
      .from("fsq_places")
      .select("fsq_id, name, latitude, longitude, category, fsq_primary_label, address, locality, country")
      .range(from, from + PAGE - 1);
    if (error) { console.error("read fsq_places failed:", error.message); process.exit(1); }
    const rows = data ?? [];
    for (const p of rows as any[]) {
      const r = await resolveExternalPlace(sc, {
        provider: "fsq",
        providerPlaceId: p.fsq_id,
        name: p.name,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        primaryCategory: p.category ?? null,
        rawCategory: p.fsq_primary_label ?? null,
        address: p.address ?? null,
        city: p.locality ?? null,
        countryCode: countryCodeOf(p.country),
        attribution: FSQ_ATTRIBUTION,
      });
      if (!r) { stats.skipped++; continue; }
      if (r.created) stats.created++; else stats.linked++;
    }
    if (rows.length < PAGE) break;
    console.log(`  …processed ${from + rows.length}`);
  }

  console.log("\nDone.", stats);
  console.log("Re-run safely after each FSQ city ingest to keep the canonical layer current.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
