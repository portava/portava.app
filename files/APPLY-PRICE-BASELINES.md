# APPLY — Price baselines seed (makes the budget feature live)

Seeds the empty price_baselines table so the trip cost-estimate (and the FX
conversion built on top of it) actually produce numbers instead of
`no_baseline_data`. Backend seed only — no code path changes, no flag.

## What it seeds
- 24 GLOBAL rows (every category × tier, per person/day, USD) — the fallback
  that gives EVERY trip an estimate.
- 64 countries × 24 rows, derived by scaling the global baseline by a curated
  relative price index (Thailand ~0.65×, Switzerland ~1.85×, etc.).
- 1,560 rows total.

## Honesty
confidence='curated'; source_note flags these as indicative curated baselines,
NOT a live cost-of-living feed. The budget engine already appends its estimate
disclaimer. This is the admin-curated state the roadmap expects to REPLACE with
a licensed provider (Numbeo) at live-user scale — the confidence column makes
that a clean swap (curated always overrides provider).

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-price-baselines.patch`
   (fallback: copy files/* over the workspace root).
2. Run 0185_seed_price_baselines.sql in Supabase (1,560 INSERTs, re-run-safe).
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green (6 new tests).

## Verify it's live
`GET /api/trips/<id>/cost-estimate` on a trip with dates → now returns
`available: true` with per-day/total bands (was `no_baseline_data`). Pair with
`?home=<ISO4217>` + budget_fx_conversion_enabled for the converted view.

## Tuning
Baselines live in lib/priceBaselines.ts (GLOBAL_BASELINE + COUNTRY_PRICE_INDEX);
edit + regenerate, or adjust individual rows via admin/SQL (admin edits are
preserved on re-run). Add a country by adding it to COUNTRY_PRICE_INDEX.

---
## ALSO IN THIS DROP: upsert_city_stamp RPC check (separate, important)
See CHECK-upsert_city_stamp-RPC.sql. The GPS city-stamp write path calls a
Postgres function that isn't defined in the repo migrations. Run that query to
confirm whether it exists in your live DB. If it's missing, GPS city stamps are
silently failing to write — send me the result + your passport_stamps columns
and I'll reconstruct it to match. (This is NOT fixed by this patch — it needs
your live-DB check first.)
