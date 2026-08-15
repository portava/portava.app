/**
 * seed-discovery-places.ts
 *
 * Pulls real places from Overpass (OSM) and seeds discovery_places.
 *
 * Usage (from repo root):
 *   node artifacts/api-server/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/seed-discovery-places.ts
 *
 *   # After migration 0060 adds lat/lng columns:
 *   node artifacts/api-server/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/seed-discovery-places.ts --backfill-coords
 *
 * Dedup:  OSM id stored as tag = 'osm:<type>/<id>'.  Re-running skips existing.
 * Coords: inserted as NULL until migration 0060 (lat/lng columns) is applied.
 *         Run --backfill-coords after applying 0060 to fill them in.
 *
 * Env vars loaded from artifacts/api-server/.env.
 * SUPABASE_SERVICE_ROLE_KEY is never exposed to any client/EXPO_PUBLIC var.
 */

import { createClient } from "@supabase/supabase-js";
import { osmNeighborhood } from "../src/lib/osmPlaceShape.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Load .env from api-server ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const envPath    = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const BACKFILL_MODE = process.argv.includes("--backfill-coords");

// ── City definitions ──────────────────────────────────────────────────────────

interface CityConfig {
  name: string;
  bbox: [number, number, number, number]; // south, west, north, east (Overpass order)
}

const CITIES: CityConfig[] = [
  { name: "Tokyo",           bbox: [35.52, 139.55, 35.82, 139.90] },
  { name: "Cebu",            bbox: [10.22, 123.83, 10.45, 124.05] },
  { name: "Bangkok",         bbox: [13.65, 100.43, 13.86, 100.72] },
  { name: "Miami",           bbox: [25.70, -80.32, 25.87, -80.14] },
  { name: "Fort Lauderdale", bbox: [26.07, -80.20, 26.22, -80.07] },
];

// ── Category queries ──────────────────────────────────────────────────────────

interface QuerySpec {
  appCategory: string;
  filters: string[];
  limit: number;
}

const QUERIES: QuerySpec[] = [
  {
    appCategory: "food",
    filters: ['["amenity"="restaurant"]', '["amenity"="cafe"]'],
    limit: 12,
  },
  {
    appCategory: "nightlife",
    filters: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="nightclub"]'],
    limit: 8,
  },
  {
    appCategory: "places",
    filters: [
      '["tourism"="attraction"]',
      '["tourism"="museum"]',
      '["historic"="monument"]',
      '["historic"="memorial"]',
    ],
    limit: 12,
  },
  {
    appCategory: "beaches",
    filters: ['["natural"="beach"]', '["leisure"="beach_resort"]'],
    limit: 6,
  },
];

// ── Overpass fetch ────────────────────────────────────────────────────────────

const OVERPASS_URL    = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT   = 30_000;

function buildQuery(bbox: CityConfig["bbox"], filters: string[], limit: number): string {
  const [s, w, n, e] = bbox;
  const bb = `${s},${w},${n},${e}`;
  const parts = filters
    .map((f) => `node${f}(${bb});\n  way${f}(${bb});\n  relation${f}(${bb});`)
    .join("\n  ");
  return `[out:json][timeout:25];\n(\n  ${parts}\n);\nout center ${limit};`;
}

async function fetchOverpass(query: string): Promise<any[]> {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept":       "application/json, */*",
      "User-Agent":   "TravelBuddySeedScript/1.0",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (res.status === 429) throw new Error("rate-limited (429) — wait 60s and retry");
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json() as { elements?: any[] };
  return json.elements ?? [];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── OSM → discovery_places normaliser ────────────────────────────────────────

interface DiscoveryPlaceInsert {
  city:         string;
  name:         string;
  place_type:   string;
  category:     string;
  neighborhood: string | null;
  blurb:        string | null;
  image_url:    null;
  submitted_by: null;
  tag:          string;          // 'osm:<type>/<id>' — dedup key
  note:         string | null;
  rating:       number | null;
  source:       string;
  status:       string;
  verified:     boolean;
  // lat / lng intentionally omitted: migration 0060 not yet applied.
  // Run --backfill-coords after applying 0060.
}

/** Coords extracted alongside the insert, keyed by OSM tag for backfill use. */
const coordsMap = new Map<string, { lat: number; lng: number }>();

function osmToPlace(el: any, city: string, appCategory: string): DiscoveryPlaceInsert | null {
  const tags = el.tags ?? {};
  const name = tags["name:en"] ?? tags.name ?? tags.official_name ?? null;
  if (!name?.trim()) return null;

  const lat: number | null = el.type === "node" ? el.lat : (el.center?.lat ?? null);
  const lng: number | null = el.type === "node" ? el.lon : (el.center?.lon ?? null);
  const osmTag = `osm:${el.type}/${el.id}`;

  if (lat != null && lng != null) {
    coordsMap.set(osmTag, {
      lat: Math.round(lat * 1e7) / 1e7,
      lng: Math.round(lng * 1e7) / 1e7,
    });
  }

  // SHARED with the live Discovery route. The two paths had drifted -- this
  // path missed addr:neighbourhood, the live one missed suburb -- so the same
  // real place got a neighbourhood from one and none from the other, making a
  // genuine defect indistinguishable from a path difference during QA.
  const neighborhood = osmNeighborhood(tags);
  const rawStars     = parseFloat(tags.stars ?? "");
  const rating       = isNaN(rawStars) ? null : Math.min(5, Math.max(1, rawStars));

  return {
    city,
    name:         name.trim(),
    place_type:   "traveler_pick",
    category:     appCategory,
    neighborhood,
    blurb:        tags.description ?? tags.inscription ?? null,
    image_url:    null,
    submitted_by: null,
    tag:          osmTag,
    note:         null,
    rating:       rating,
    source:       "osm",
    status:       "active",
    verified:     true,
  };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

async function fetchExistingTags(city: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("discovery_places")
    .select("tag")
    .ilike("city", city)
    .like("tag", "osm:%");
  if (error) {
    console.warn(`    ⚠  Could not fetch existing tags: ${error.message}`);
    return new Set();
  }
  return new Set((data ?? []).map((r: any) => r.tag as string));
}

async function seedCity(city: CityConfig): Promise<number> {
  console.log(`\n📍  ${city.name}`);

  const existing = await fetchExistingTags(city.name);
  console.log(`    existing OSM rows: ${existing.size}`);

  const toInsert: DiscoveryPlaceInsert[] = [];
  const seen = new Set<string>(existing);

  for (const q of QUERIES) {
    await sleep(800);
    try {
      const elements = await fetchOverpass(buildQuery(city.bbox, q.filters, q.limit));
      console.log(`    ${q.appCategory.padEnd(12)} → ${elements.length} OSM elements`);
      for (const el of elements) {
        const place = osmToPlace(el, city.name, q.appCategory);
        if (!place || seen.has(place.tag)) continue;
        seen.add(place.tag);
        toInsert.push(place);
      }
    } catch (err: any) {
      console.warn(`    ⚠  ${q.appCategory}: ${err.message}`);
    }
  }

  if (toInsert.length === 0) {
    console.log(`    ✓  nothing new to insert`);
    return 0;
  }

  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const { error } = await supabase.from("discovery_places").insert(toInsert.slice(i, i + BATCH));
    if (error) {
      console.error(`    ❌  insert error: ${error.message}`);
    } else {
      inserted += toInsert.slice(i, i + BATCH).length;
    }
  }
  console.log(`    ✅  inserted ${inserted} places`);
  return inserted;
}

// ── Backfill coords (run after migration 0060 adds lat/lng columns) ───────────

async function backfillCoords() {
  console.log("\n=== Backfilling lat/lng for existing OSM rows ===");
  console.log("(Re-fetching from Overpass to get coordinates)\n");

  for (const city of CITIES) {
    console.log(`📍  ${city.name}`);
    for (const q of QUERIES) {
      await sleep(800);
      try {
        const elements = await fetchOverpass(buildQuery(city.bbox, q.filters, q.limit));
        for (const el of elements) {
          const lat: number | null = el.type === "node" ? el.lat : (el.center?.lat ?? null);
          const lng: number | null = el.type === "node" ? el.lon : (el.center?.lon ?? null);
          if (lat == null || lng == null) continue;
          const osmTag = `osm:${el.type}/${el.id}`;
          coordsMap.set(osmTag, {
            lat: Math.round(lat * 1e7) / 1e7,
            lng: Math.round(lng * 1e7) / 1e7,
          });
        }
      } catch (err: any) {
        console.warn(`    ⚠  ${q.appCategory}: ${err.message}`);
      }
    }
    await sleep(1000);
  }

  console.log(`\nCoords collected for ${coordsMap.size} OSM places. Updating DB rows...`);
  let updated = 0;
  for (const [tag, { lat, lng }] of coordsMap) {
    const { error } = await supabase
      .from("discovery_places")
      .update({ lat, lng })
      .eq("tag", tag)
      .is("lat", null);
    if (!error) updated++;
  }
  console.log(`✅  Updated ${updated} rows with lat/lng`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (BACKFILL_MODE) {
    await backfillCoords();
    return;
  }

  console.log("=== seed-discovery-places ===");
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Cities: ${CITIES.map((c) => c.name).join(", ")}`);
  console.log("Note: lat/lng NOT inserted (migration 0060 not applied).");
  console.log("      Run --backfill-coords after applying docs/sql/0060_discovery_places_coords.sql\n");

  const summary: { city: string; inserted: number }[] = [];
  for (const city of CITIES) {
    try {
      const n = await seedCity(city);
      summary.push({ city: city.name, inserted: n });
    } catch (err: any) {
      console.error(`❌  ${city.name} failed: ${err.message}`);
      summary.push({ city: city.name, inserted: 0 });
    }
    await sleep(1200);
  }

  console.log("\n=== Summary ===");
  let total = 0;
  for (const { city, inserted } of summary) {
    console.log(`  ${city.padEnd(20)} ${inserted} inserted`);
    total += inserted;
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${total}`);

  console.log("\n=== Final DB counts per city ===");
  for (const city of CITIES) {
    const { count } = await supabase
      .from("discovery_places")
      .select("id", { count: "exact", head: true })
      .ilike("city", city.name);
    console.log(`  ${city.name.padEnd(20)} ${count ?? "?"} rows`);
  }

  console.log("\nDone. No EXPO_PUBLIC env vars were modified.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
