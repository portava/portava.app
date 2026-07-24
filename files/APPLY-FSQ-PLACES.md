# APPLY — FSQ OS Places (per-city POI ingestion)

Adds a Foursquare-sourced POI layer (hotels + richer nightlife/food/retail)
that complements OSM. Backend + a DuckDB ingestion script. Flag-gated OFF.

## Two parts
1. **Code (this patch)** — schema, category mapper, transform, read service +
   endpoint, ingestion script. Apply now; it's inert until you ingest a city
   and flip the flag.
2. **Data (needs YOU, one-time)** — FSQ OS Places is a gated open dataset. You
   download it and run the per-city loader. See "Ingest a city" below.

## Apply the code (workspace root)
1. Unzip, `git apply -p1 portava-fsq-places.patch`
   (fallback: copy files/* over the workspace root — note scripts/load-fsq-city.mjs).
2. Run 0184_fsq_places.sql in Supabase.
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green (15 new tests).

## Ingest a city (the data step)
Prereqs (one-time):
  - Accept terms + download the FSQ `places` parquet from
    https://huggingface.co/datasets/foursquare/fsq-os-places
  - Install DuckDB: `npm i -g duckdb` (gives the `duckdb` CLI)
  - Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

Then, from artifacts/api-server, per city (bbox = minLat,minLng,maxLat,maxLng):
  node scripts/load-fsq-city.mjs \
    --city cebu-ph \
    --bbox 10.20,123.80,10.45,124.05 \
    --parquet '/data/fsq/places/*.parquet' \
    --dataset-date 2026-06-01

DuckDB reads ONLY the bounding box (predicate pushdown) — never the whole
100M-row world. Re-running a city is safe (upsert by fsq_id). It prints a
per-category breakdown so you can sanity-check coverage.

## Turn on + use
    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'fsq_places_enabled';
    curl -s "$API/api/cities/cebu-ph/places?category=accommodation" | jq

## Honesty / license
Rows are source='fsq_os_places', confidence='provider', dataset_date recorded.
FSQ OS Places REQUIRES attribution: any surface showing these places must
display "Powered by Foursquare" (the API returns it in `attribution`).

## Notes
- The loader's SELECT column names match the published FSQ schema
  (fsq_place_id, name, latitude, longitude, fsq_category_labels, …). If a future
  dataset revision renames a column, adjust SELECT_COLS at the top of the script;
  the rest of the pipeline reads by those aliases.
- Next integration (optional): feed fsq_places category density into
  neighborhood-match scoring, and surface hotels on accommodation-location
  cards. The read service (getCityPlaces / getCityCategoryCounts) is ready.
