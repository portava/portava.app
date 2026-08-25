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
 *     [--allow-empty]                          # diagnostic: permit a 0-row ingest
 *
 * Re-running a city is safe: rows upsert by fsq_id; the city_key is refreshed.
 *
 * ── EXTRACTION IS FAIL-CLOSED ─────────────────────────────────────────────────
 * DuckDB writes the JSON extract to a UNIQUELY-created temp file under
 * os.tmpdir() (NOT `/dev/stdout` — that device is unavailable on Replit and made
 * a failed extract look like a legitimate 0-row result). If DuckDB fails, or the
 * bbox returns 0 usable rows without an explicit --allow-empty, the run exits
 * non-zero BEFORE any Supabase write, and the fsq_city_ingests ledger is written
 * ONLY after every fsq_places batch has upserted successfully — so a failed run
 * is never recorded as a success.
 *
 * NOTE: the FSQ parquet column names below match the published OS Places
 * schema (fsq_place_id, name, latitude, longitude, fsq_category_labels, …). If
 * a future dataset revision renames a column, adjust SELECT_COLS — the rest of
 * the pipeline is column-name-agnostic (it reads by these aliases).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { fsqRowToDbRow } from "../src/lib/fsq/fsqTransform.js";

// The FSQ OS Places columns to extract — the dataset semantics live here.
export const SELECT_COLS =
  "fsq_place_id, name, latitude, longitude, address, locality, region, postcode, country, " +
  "fsq_category_ids, fsq_category_labels, date_closed";

const BATCH = 500;

/** Escape single quotes for a SQL string literal. */
const esc = (s) => String(s).replace(/'/g, "''");

/**
 * Build the DuckDB COPY that extracts the bbox rows to `outFile` as newline-
 * delimited JSON. The SELECT columns, the bbox predicate and the
 * `date_closed IS NULL` filter are unchanged — only the destination is a real
 * temp file rather than `/dev/stdout`.
 */
export function buildExtractSql({ selectCols, parquet, bbox, outFile }) {
  const { minLat, minLng, maxLat, maxLng } = bbox;
  return (
    `COPY (SELECT ${selectCols} FROM read_parquet('${esc(parquet)}') ` +
    `WHERE latitude BETWEEN ${minLat} AND ${maxLat} AND longitude BETWEEN ${minLng} AND ${maxLng} ` +
    `AND date_closed IS NULL) TO '${esc(outFile)}' (FORMAT JSON, ARRAY false);`
  );
}

/** Parse newline-delimited JSON. Throws on a malformed line (never silently drops). */
export function parseNdjson(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Real DuckDB runner — the COPY in `sql` writes to the temp file itself. */
export function runDuckDbCli(sql) {
  execFileSync("duckdb", [":memory:", "-c", sql], {
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/**
 * Extract the city's bbox rows via DuckDB into a UNIQUELY-created temp dir under
 * os.tmpdir(), parse the NDJSON, and ALWAYS delete the temp dir in `finally`.
 *
 * Throws (so the caller exits non-zero) when DuckDB fails or writes no readable
 * output — a failed extraction can never masquerade as an empty-but-successful
 * result. `runDuckDb(sql, outFile)` is injectable for tests.
 */
export async function extractCityRows({
  selectCols,
  parquet,
  bbox,
  runDuckDb = runDuckDbCli,
  fsImpl = { mkdtempSync, readFileSync, rmSync },
  osTmpdir = tmpdir,
  pathJoin = join,
}) {
  const dir = fsImpl.mkdtempSync(pathJoin(osTmpdir(), "fsq-load-"));
  const outFile = pathJoin(dir, "extract.ndjson");
  const sql = buildExtractSql({ selectCols, parquet, bbox, outFile });
  try {
    try {
      runDuckDb(sql, outFile);
    } catch (e) {
      throw new Error(
        `DuckDB extract failed (is the \`duckdb\` CLI installed and the parquet readable?): ${e?.message || e}`,
      );
    }
    let text;
    try {
      text = fsImpl.readFileSync(outFile, "utf8");
    } catch (e) {
      throw new Error(
        `DuckDB produced no readable output at ${outFile} — the extraction did not complete: ${e?.message || e}`,
      );
    }
    return parseNdjson(text);
  } finally {
    try {
      fsImpl.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Transform → upsert → ledger.
 *
 * Fail-closed on zero usable rows unless `allowEmpty`. The fsq_city_ingests
 * ledger is written ONLY after every fsq_places batch upserts successfully; any
 * batch error throws BEFORE the ledger write, so a failed run is never recorded
 * as a success.
 */
export async function ingestCity({
  rawRows,
  cityKey,
  datasetDate,
  bbox,
  sc,
  transform = fsqRowToDbRow,
  allowEmpty = false,
  batchSize = BATCH,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  const dbRows = [];
  let dropped = 0;
  for (const r of rawRows) {
    const row = transform(r, { cityKey, datasetDate });
    if (row) dbRows.push(row);
    else dropped++;
  }
  const byCategory = {};
  for (const r of dbRows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  log(`[fsq] ${dbRows.length} usable, ${dropped} dropped (closed/malformed)`);

  if (dbRows.length === 0 && !allowEmpty) {
    throw new Error(
      `Refusing to record ${cityKey}: extraction yielded 0 usable rows ` +
        `(raw=${rawRows.length}, dropped=${dropped}). This usually means the bbox/parquet ` +
        `produced nothing or the extract failed silently. Pass --allow-empty to override for diagnostics.`,
    );
  }

  let upserted = 0;
  const totalBatches = Math.ceil(dbRows.length / batchSize) || 0;
  for (let i = 0; i < dbRows.length; i += batchSize) {
    const batch = dbRows.slice(i, i + batchSize).map((r) => ({ ...r, ingested_at: now() }));
    const { error } = await sc
      .from("fsq_places")
      .upsert(batch, { onConflict: "fsq_id", ignoreDuplicates: false });
    if (error) {
      throw new Error(
        `fsq_places batch ${Math.floor(i / batchSize) + 1}/${totalBatches} failed: ${error.message}. ` +
          `Aborting BEFORE the fsq_city_ingests ledger write — this run is NOT recorded as a success.`,
      );
    }
    upserted += batch.length;
  }

  // Ledger ONLY after every batch succeeded.
  const { error: ledgerErr } = await sc.from("fsq_city_ingests").upsert(
    {
      city_key: cityKey,
      place_count: dbRows.length,
      dataset_date: datasetDate,
      bbox,
      ingested_at: now(),
    },
    { onConflict: "city_key" },
  );
  if (ledgerErr) {
    throw new Error(`fsq_places upserted but the fsq_city_ingests ledger write failed: ${ledgerErr.message}`);
  }
  return { upserted, dropped, placeCount: dbRows.length, byCategory };
}

/**
 * Orchestrate a full ingest: extract (fail-closed) THEN upsert. Extraction runs
 * to completion before `ingestCity` performs any Supabase write, so a DuckDB
 * failure aborts before the database is touched. Deps are injectable for tests.
 */
export async function runIngestFlow({
  cityKey,
  datasetDate,
  bbox,
  parquet,
  sc,
  selectCols = SELECT_COLS,
  runDuckDb = runDuckDbCli,
  transform = fsqRowToDbRow,
  allowEmpty = false,
  batchSize = BATCH,
  now,
  log = () => {},
  extract = extractCityRows,
}) {
  const rawRows = await extract({ selectCols, parquet, bbox, runDuckDb });
  log(`[fsq] ${rawRows.length} raw places in bbox`);
  return ingestCity({ rawRows, cityKey, datasetDate, bbox, sc, transform, allowEmpty, batchSize, now, log });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv = process.argv) {
  const arg = (name, required = false) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    if (required) {
      console.error(`Missing required --${name}`);
      process.exit(1);
    }
    return null;
  };
  const cityKey = arg("city", true);
  const bboxStr = arg("bbox", true);
  const parquet = arg("parquet", true);
  const datasetDate = arg("dataset-date", true);
  const allowEmpty = argv.includes("--allow-empty");
  const [minLat, minLng, maxLat, maxLng] = bboxStr.split(",").map(Number);
  if ([minLat, minLng, maxLat, maxLng].some((n) => !Number.isFinite(n))) {
    console.error("--bbox must be minLat,minLng,maxLat,maxLng");
    process.exit(1);
  }
  return { cityKey, parquet, datasetDate, allowEmpty, bbox: { minLat, minLng, maxLat, maxLng } };
}

async function main() {
  const { cityKey, parquet, datasetDate, allowEmpty, bbox } = parseArgs();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  console.log(`[fsq] extracting ${cityKey} bbox=${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng} from ${parquet} …`);

  // 1) Extract FIRST. A DuckDB failure or a fail-closed 0-row result throws here,
  //    before the Supabase client is even created — no write can precede it.
  const rawRows = await extractCityRows({ selectCols: SELECT_COLS, parquet, bbox });
  console.log(`[fsq] ${rawRows.length} raw places in bbox`);

  // 2) Only now touch Supabase.
  const sc = createClient(url, key);
  const res = await ingestCity({
    rawRows,
    cityKey,
    datasetDate,
    bbox,
    sc,
    allowEmpty,
    log: (m) => console.log(m),
  });

  console.log(`[fsq] by category:`, res.byCategory);
  console.log(`[fsq] done — upserted ${res.upserted}, dropped ${res.dropped}, place_count ${res.placeCount}.`);
  console.log(`[fsq] Remember: any surface showing these places must display "Powered by Foursquare".`);
}

/** True only when this file is executed directly (not when imported by a test). */
function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(`[fsq] ${e?.message || e}`);
    process.exit(1);
  });
}
