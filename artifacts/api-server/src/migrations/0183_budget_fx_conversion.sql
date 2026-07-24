-- Migration 0183: Budget FX conversion flag
--
-- Wires the existing fx_rates table (ECB reference rates, base EUR, loaded via
-- 0174 + the frankfurter loader) into the trip cost-estimate endpoint: when
-- this flag is on and the caller passes ?home=<ISO4217>, the response includes
-- a `converted` view of the perDay/total bands in the traveler's home currency.
--
-- Additive + fail-soft: source-currency figures are never altered; conversion
-- is omitted when a rate is unavailable (honest — never fabricated). The daily
-- refresh that keeps fx_rates current is a separate, env-gated scheduler
-- (FX_REFRESH_ENABLED=true), not governed by this flag.
--
-- Safe to re-run. feature_flags PK column is `flag` (NOT `key`).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('budget_fx_conversion_enabled', FALSE,
   'Trip budget FX: convert cost-estimate bands to the traveler home currency (?home=ISO4217) using fx_rates (ECB, indicative)')
ON CONFLICT (flag) DO NOTHING;
