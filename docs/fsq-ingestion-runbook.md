# FSQ Places — Ingestion & Activation Runbook

Foursquare OS Places is a provider POI layer that adds hotels, nightlife, food,
culture, and shopping venues to destination pages in Portava. It supplements the
existing OSM/Overpass and user-submitted discovery_places data.

**License requirement:** any UI surface that displays FSQ places MUST render
"Powered by Foursquare". The read layer (`lib/fsq/fsqPlaces.ts`) carries the
`attribution` string and the mobile component (`TripFsqPlacesSection`) renders
it unconditionally — do not remove or conditionally hide it.

---

## Prerequisites (one-time setup)

### 1. Accept the FSQ OS Places dataset terms

The Foursquare OS Places dataset is **gated** on Hugging Face. You must accept
the dataset license before downloading:

1. Sign in to [Hugging Face](https://huggingface.co)
2. Go to <https://huggingface.co/datasets/foursquare/fsq-os-places>
3. Click **"Access repository"** and accept the terms

### 2. Download the parquet files

Download the `places/` directory (parquet part-files). Each part-file is
~500 MB; the full dataset is ~20 GB. You do NOT need the whole world — the
ingestion script uses DuckDB predicate pushdown to extract only a city's
bounding box, so any part-files containing your target city are enough.

Save the files somewhere accessible, e.g. `/data/fsq/places/`.

### 3. Install DuckDB CLI

```bash
# macOS
brew install duckdb

# Linux / CI
curl -LO https://github.com/duckdb/duckdb/releases/download/v1.1.0/duckdb_cli-linux-amd64.zip
unzip duckdb_cli-linux-amd64.zip
sudo mv duckdb /usr/local/bin/
```

Verify: `duckdb --version`

### 4. Set environment variables

```bash
export SUPABASE_URL=<your-supabase-url>
export SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

---

## City key naming convention

The FSQ city key format is: **`{city-slug}-{country-iso2}`**

The mobile app derives this automatically from `destinationCity` +
`destinationCountry` using `src/utils/fsqCityKey.ts`. Use the same formula so
keys match:

| City | Country | Key to use |
|------|---------|-----------|
| Cebu | Philippines | `cebu-ph` |
| Manila | Philippines | `manila-ph` |
| Bangkok | Thailand | `bangkok-th` |
| Bali (Denpasar) | Indonesia | `denpasar-id` |
| Singapore | Singapore | `singapore-sg` |
| Tokyo | Japan | `tokyo-jp` |

For multi-word cities, hyphens replace spaces: "Cebu City" → `cebu-city-ph`.

To check the key the app will derive for a given trip, call `toFsqCityKey(city, country)`
from `src/utils/fsqCityKey.ts`.

---

## Ingestion (per city)

Run from `artifacts/api-server/`:

```bash
node scripts/load-fsq-city.mjs \
  --city cebu-ph \
  --bbox 10.20,123.80,10.45,124.05 \
  --parquet '/data/fsq/places/*.parquet' \
  --dataset-date 2026-06-01
```

**Arguments:**

| Flag | Description |
|------|-------------|
| `--city` | Ingestion key (see naming convention above) |
| `--bbox` | `minLat,minLng,maxLat,maxLng` — city bounding box |
| `--parquet` | Path or glob to local parquet files |
| `--dataset-date` | ISO date of the FSQ dataset snapshot |

**Re-running is safe** — rows upsert by `fsq_id`; the city's `fsq_city_ingests`
row is refreshed. Run for each city you want to activate.

**Recommended bounding boxes for key cities:**

| City | `--bbox` |
|------|---------|
| Cebu, PH | `10.20,123.80,10.45,124.05` |
| Manila, PH | `14.40,120.90,14.75,121.10` |
| Bangkok, TH | `13.60,100.40,13.90,100.70` |
| Singapore | `1.22,103.60,1.47,104.00` |
| Tokyo, JP | `35.52,139.55,35.82,139.90` |

---

## Verify row counts

```sql
-- Check ingested cities
SELECT city_key, place_count, dataset_date, ingested_at
FROM fsq_city_ingests
ORDER BY ingested_at DESC;

-- Check place counts per city
SELECT city_key, category, COUNT(*) AS n
FROM fsq_places
GROUP BY city_key, category
ORDER BY city_key, n DESC;
```

Expected: at least a few hundred rows for a major city (accommodation + food +
nightlife + other). If counts are too low, check that your `--bbox` covers the
city properly or that the parquet files include that region.

---

## Flip the feature flag

Once cities are ingested and counts look healthy:

```bash
cd artifacts/api-server
ENABLE=true node scripts/set-flags.mjs fsq_places_enabled
```

This reads the existing row first — it will error if the row is missing (run
migration 0184 first). Confirm output shows:

```
  ✔ [fsq_places_enabled] false → true

set-flags: done.
```

**To roll back:**

```bash
cd artifacts/api-server
ENABLE=false node scripts/set-flags.mjs fsq_places_enabled
```

---

## Verification

After flipping the flag, verify the UI:

1. Open the app and navigate to any trip whose destination has been ingested.
2. Scroll down on the trip detail screen — the **"Places nearby"** section
   should appear, showing grouped accommodation / food / nightlife cards.
3. Confirm **"Powered by Foursquare"** is visible at the bottom of the section.

API-level check:

```bash
curl -H "Authorization: Bearer <user-jwt>" \
  "https://<your-api>/api/cities/cebu-ph/places?category=accommodation&limit=5"
```

Response should include `"enabled": true`, a `places` array, and
`"attribution": "Powered by Foursquare"`.

---

## Adding more cities later

Re-run the ingestion script for each new city. No code changes needed — the
mobile app derives the city key automatically from the trip's destination. As
long as the ingested key matches what `toFsqCityKey` produces, places appear
automatically on relevant trip detail screens.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `duckdb: command not found` | DuckDB CLI not on PATH |
| `DuckDB extract failed` | PARQUET path wrong or files not downloaded |
| `Row not found in feature_flags` | Migration 0184 not applied — run it first |
| `places: []` in API response | City key mismatch, or city not ingested yet |
| Section not showing in app | Flag is off, OR `toFsqCityKey` returned null (country not in map) |
| No "Powered by Foursquare" text | Bug — report immediately; license violation |

To check the flag live:
```sql
SELECT flag, enabled FROM feature_flags WHERE flag = 'fsq_places_enabled';
```
