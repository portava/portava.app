# APPLY — FX in trip budgets + daily refresh

Wires the fx_rates table (loaded last session) into the trip cost estimate, and
adds a daily scheduler to keep rates current. Backend + one mobile service
addition. Flag-gated OFF; scheduler env-gated OFF.

## What it does
- lib/fx.ts — currency conversion over fx_rates (base EUR; cross-rate pivots
  through EUR). Honest: labeled with rate_date + "indicative ECB rate"
  disclaimer; returns null (never a fabricated number) when a rate is missing.
- GET /trips/:tripId/cost-estimate?home=<ISO4217> — when
  budget_fx_conversion_enabled is on, the response gains a `converted` block
  (perDay/total bands in the home currency). The source-currency `estimate` is
  never altered.
- lib/fxRefreshScheduler.ts + index.ts — when FX_REFRESH_ENABLED=true, pulls
  ECB rates from frankfurter.dev daily into fx_rates (best-effort, never blocks
  startup). Replaces the manual re-run.
- migration 0183 — the flag.
- mobile: fetchCostEstimateWithFx(tripId, homeCurrency?, tier?) — additive;
  the existing fetchCostEstimate is unchanged so the current budget UI keeps
  working.

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-budget-fx.patch`
   (fallback: copy files/* over the workspace root).
2. Run 0183_budget_fx_conversion.sql in Supabase.
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green (9 new fx tests).

## Turn on
- Conversion:  UPDATE feature_flags SET enabled = TRUE WHERE flag = 'budget_fx_conversion_enabled';
- Daily refresh (in the api-server service env): FX_REFRESH_ENABLED=true
  (optional: FX_REFRESH_INTERVAL_MS, FX_REFRESH_URL). Without it, rates stay at
  whatever was last loaded — conversion still works, just not auto-updated.

## Try it
    curl -s "$API/api/trips/<tripId>/cost-estimate?home=USD" | jq '.converted'
(null until the flag is on and the trip's baseline currency differs from USD)

## UI (optional, hand to Replit agent)
In the budget section, when `converted` is present show the home-currency band
under the source figure, with the `disclaimer` line. Use fetchCostEstimateWithFx
with the user's home currency. Never hide the source-currency number.
