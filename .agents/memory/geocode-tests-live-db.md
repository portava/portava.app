---
name: Geocode tests and the live DB cache
description: Geocode-related node:tests must explicitly null the DB client override or they hit the real Supabase geocode cache table.
---

The countryGeocoder fetch test hook (`_setGeocodeFetchForTests`) deliberately does NOT reset the DB-client override. With real Supabase secrets in the environment, any geocode test that doesn't call `_setGeocodeDbClientForTests(null)` will read/write the live `city_country_geocode_cache` table — rows persisted by one run then break later runs' pre-conditions (e.g. "unresolved" cities resolving from stale live rows).

**Why:** the two hooks were decoupled on purpose so tests can control fetch and DB independently; older test files still assumed the fetch hook disabled the DB.

**How to apply:** in geocode test files, default `_setGeocodeDbClientForTests(null)` in `beforeEach`; inject a fake client only where a DB is needed. If geocode tests fail with resolved values where null was expected, suspect live-DB leakage first.
