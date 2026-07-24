/**
 * load-fsq-city.mjs — per-city ingestion of Foursquare OS Places into fsq_places.
 *
 * Uses DuckDB to read the FSQ `places` parquet and extract ONLY a city's
 * bounding box (predicate pushdown — it never loads the ~100M-row whole world),
 * maps categories, and upserts into Supabase.
 *
 * ── PREREQUISITES (one-time) ─────────────────────────────────────────────────
 *   1. Foursquare OS Places is a GATED open dataset — accept the terms and
 *      download the `places` parquet from:
 *        https://huggingface.co/datasets/foursquare/fsq-os-places
 *      (the `places/` parquet part-files). Point PARQUET at a local file or a
 *      glob, e.g. /data/fsq/places/*.parquet
 *   2. Install DuckDB (either works):
 *        npm i -g duckdb           # provides the `duckdb` CLI this script calls
 *      or use the DuckDB CLI binary from duckdb.org and put it on PATH.
 *   3. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node load-fsq-city.mjs \
 *     --city cebu-ph \
 *     --bbox 10.20,123.80,10.45,124.05 \      # minLat,minLng,maxLat,maxLng
 *     --parquet '/data/fsq/places/*.parquet' \
 *     --dataset-date 2026-06-01
 *
 * Re-running a city is safe: rows upsert by fsq_id; the city_key is refreshed.
 *
 * NOTE: the FSQ parquet column names below match the published OS Places
 * schema (fsq_place_id, name, latitude, longitude, fsq_category_labels, …). If
 * a future dataset revision renames a column, adjust SELECT_COLS — the rest of
 * the pipeline is column-name-agnostic (it reads by these aliases).
 */

import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { fsqRowToDbRow } from "../src/lib/fsq/fsqTransform.js";

// ── Args ──────────────────────────────────────────────────────────────────────
function arg(name, required = false) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (required) { console.error(`Missing required --${name}`); process.exit(1); }
  return null;
}
const CITY = arg("city", true);
const BBOX = arg("bbox", true);            // minLat,minLng,maxLat,maxLng
const PARQUET = arg("parquet", true);      // local path or glob
const DATASET_DATE = arg("dataset-date", true);

const [minLat, minLng, maxLat, maxLng] = BBOX.split(",").map(Number);
if ([minLat, minLng, maxLat, maxLng].some((n) => !Number.isFinite(n))) {
  console.error("--bbox must be minLat,minLng,maxLat,maxLng"); process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

// ── DuckDB extract (bbox filter, only this city's rows) ──────────────────────
// Emits newline-delimited JSON so we can stream-parse.
const SELECT_COLS =
  "fsq_place_id, name, latitude, longitude, address, locality, region, postcode, country, " +
  "fsq_category_ids, fsq_category_labels, date_closed";
const sql =
  `COPY (SELECT ${SELECT_COLS} FROM read_parquet('${PARQUET.replace(/'/g, "''")}') ` +
  `WHERE latitude BETWEEN ${minLat} AND ${maxLat} AND longitude BETWEEN ${minLng} AND ${maxLng} ` +
  `AND date_closed IS NULL) TO '/dev/stdout' (FORMAT JSON, ARRAY false);`;

console.log(`[fsq] extracting ${CITY} bbox=${BBOX} from ${PARQUET} …`);
let ndjson;
try {
  ndjson = execFileSync("duckdb", [":memory:", "-c", sql], { maxBuffer: 1024 * 1024 * 512 }).toString();
} catch (e) {
  console.error("[fsq] DuckDB extract failed. Is the `duckdb` CLI installed and PARQUET readable?");
  console.error(String(e.message || e));
  process.exit(1);
}

const rawRows = ndjson.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
console.log(`[fsq] ${rawRows.length} raw places in bbox`);

// ── Transform (shared with the API via fsqTransform) ─────────────────────────
const dbRows = [];
let dropped = 0;
for (const r of rawRows) {
  const row = fsqRowToDbRow(r, { cityKey: CITY, datasetDate: DATASET_DATE });
  if (row) dbRows.push(row); else dropped++;
}
console.log(`[fsq] ${dbRows.length} usable, ${dropped} dropped (closed/malformed)`);

const byCat = {};
for (const r of dbRows) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
console.log(`[fsq] by category:`, byCat);

// ── Upsert ────────────────────────────────────────────────────────────────────
const sc = createClient(SUPABASE_URL, SERVICE_KEY);
const BATCH = 500;
let upserted = 0, failed = 0;
for (let i = 0; i < dbRows.length; i += BATCH) {
  const batch = dbRows.slice(i, i + BATCH).map((r) => ({ ...r, ingested_at: new Date().toISOString() }));
  const { error } = await sc.from("fsq_places").upsert(batch, { onConflict: "fsq_id", ignoreDuplicates: false });
  if (error) { failed++; console.error(`[fsq] batch ${i / BATCH + 1} failed: ${error.message}`); }
  else upserted += batch.length;
}

await sc.from("fsq_city_ingests").upsert(
  { city_key: CITY, place_count: dbRows.length, dataset_date: DATASET_DATE,
    bbox: { minLat, minLng, maxLat, maxLng }, ingested_at: new Date().toISOString() },
  { onConflict: "city_key" },
);

console.log(`[fsq] done — upserted ${upserted}, failed batches ${failed}.`);
console.log(`[fsq] Remember: any surface showing these places must display "Powered by Foursquare".`);
