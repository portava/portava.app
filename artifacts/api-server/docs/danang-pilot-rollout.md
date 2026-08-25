# Da Nang pilot — production go-live runbook (25 Aug 2026)

Owner decision (2026-08-25): **Da Nang, Vietnam is the initial market.** This is
the end-to-end sequence to light up live intelligence for Da Nang. Steps 1–2 run
in the **Replit / prod-connected env** (they need the FSQ dataset + DuckDB + prod
Supabase creds, which do not exist in the local api-server clone). Steps 4–7 can
be driven from a session with prod DB access (Supabase MCP).

## Current state (verified 2026-08-25)

- **Prod `fsq_places` = 0 rows** — the FSQ ingest has not run. `external_places_enabled`
  and `fsq_places_enabled` are already **on**; `live_places_enabled` is off.
- **Prod `places` = 0 rows.**
- **Prod has none of the intel stack** — `intel_observations` and the other 2130
  tables do not exist, and there are zero intel flags. So the intel schema chain
  must be applied to prod before any intel E2E (see `intelligence-gathering-prod-rollout.md`).
- **CI is staged, enabled, and E2E-proven**: capture/trail/missions/rewards flags
  on; a seeded Da Nang place round-tripped capture → claim → live-state snapshot →
  `liveClaims` → place-card LIVE label, and all three IG-09 gates (kill / pilot-off
  / label-off) suppressed correctly.

## Zones + bounding box

Pilot key: **`da-nang-vn`** (`toFsqCityKey("Da Nang","Vietnam")`).

Priority traveler/intelligence zones (for surfacing + mission targeting; the
ingest bbox covers all of them):

| Zone | Approx centre (lat, lng) | Wedge |
|---|---|---|
| An Thuong / My An | 16.044, 108.244 | nightlife, bars, cafes, restaurants |
| My Khe beachfront | 16.059, 108.248 | beach, hotels, beach clubs |
| Son Tra (developed W/S) | 16.100, 108.270 | attractions, viewpoints, resorts |
| Hai Chau city centre | 16.068, 108.221 | markets, malls, food, transit |
| Han River / Dragon Bridge | 16.061, 108.227 | attractions, nightlife, transit nodes |

Ingest bounding box covering all five (minLat,minLng,maxLat,maxLng):
**`15.98,108.18,16.15,108.32`**

Priority categories (surfacing order, not an ingest filter — `load-fsq-city.mjs`
ingests every venue in the bbox and maps categories): nightlife / bars / clubs →
restaurants / cafes → hotels → attractions / beaches → markets / malls → transit /
transport nodes → other high-traffic traveler venues.

## Step 1 — FSQ ingest (Replit / prod env)

Prereqs: DuckDB CLI, the FSQ OS Places parquet files (gated on Hugging Face — see
`docs/fsq-ingestion-runbook.md`), and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
pointed at **prod** (`ajrurzioarfkagpuxfnb`).

```bash
# from artifacts/api-server/
node scripts/load-fsq-city.mjs \
  --city da-nang-vn \
  --bbox 15.98,108.18,16.15,108.32 \
  --parquet '/data/fsq/places/*.parquet' \
  --dataset-date <snapshot-date-of-your-parquet>
```

Re-running is safe (rows upsert by `fsq_id`).

## Step 2 — canonical `places` backfill (Replit / prod env)

```bash
SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-key> \
  node --import tsx/esm src/scripts/backfill-canonical-places.ts
```

Refuses unless `external_places_enabled` is on (it is). Idempotent — keyed on
`(provider, provider_place_id)`, dedups by proximity, so re-running never
duplicates. `fsq_places` is the source; OSM `discovery_places` is not (no
coordinates to dedup on).

## Step 3 — verify coverage + canonical IDs

```sql
select count(*) from public.fsq_places where city_key = 'da-nang-vn';   -- provider rows ingested
select count(*) from public.places where city ilike 'da nang%';          -- canonical places created
select category, count(*) from public.fsq_places where city_key='da-nang-vn' group by category order by 2 desc;
-- spot-check a few An Thuong / My Khe venues resolved to canonical places with coords + provider refs
```

Confirm the priority zones have coverage (nightlife/food in An Thuong, hotels on
My Khe, attractions on Son Tra, markets/malls in Hai Chau).

## Step 4 — apply the intel schema to prod (owner-pressed)

Per `intelligence-gathering-prod-rollout.md`: apply `2128`, `2130`–`2133`,
`2165`–`2170` (all seed flags OFF), then verify tables + RLS + grants + the
`cash_amount = 0` CHECKs.

## Step 5 — enable the dependency-satisfied flags on prod

`intel_capture_quick_signal`, `intel_trail_followup`, `intel_missions`,
`intel_rewards` → true. (Capture now writes to real Da Nang places instead of
failing closed to `unknown_subject`.)

## Step 6 — production IG E2E proof against real Da Nang places

Drive the chain and confirm each stage against a real Da Nang venue:
Quick Signal capture → canonical claim (propose/approve) → aggregation/derived
state (projection → `intel_state_snapshots`) → `liveClaims` read → place-card LIVE
label → Trail follow-up (`experience.next_move`). This mirrors the CI proof
already passed; re-run it on prod once steps 1–5 land.

## Step 7 — enable the live read/projection flags (only after step 6 passes)

`intel_claim_projection_crowd` (compute snapshots) and `intel_live_label_crowd`
(show the LIVE label), and promote the Da Nang scope via `intel_limited_live`
after it clears the §26 density gate — or, per the owner's "don't wait for
hypothetical traffic," enable the read/projection now and let the IG-09 density
gate + kill switch govern exposure. Keep `disable_intel_live_labels` (kill) off.

## Held gates (independent reasons — do NOT flip as part of this)

- `intel_compass_rhythm_actor_gate` — ⚠ stays OFF until the per-slice
  distinct-actor rebuild exists + owner review (the k=1 fix is already deployed as
  suppression).
- **Cash payouts** — `cash_amount = 0` enforced by the DB on both financial
  tables; a money transfer is a separate switch behind payments/KYC/tax/fraud.
- **External / commercial API** — no external, unauthenticated surface; external
  credential issuance stays owner-controlled.

Da Nang becomes the market where coverage gaps, missions, QIU, contributor
rewards, and crowd/venue/movement intelligence are measured before expanding
city-by-city.
