# Refreshing the schema-drift guards' live column lists

The api-server schema-drift tests (`artifacts/api-server/src/test/*SchemaDrift.test.ts`)
validate queried column names against a generated snapshot of the LIVE Supabase
public schema:

- Generated data: `artifacts/api-server/src/test/generated/liveColumns.json`
- Loader (fails loudly if the file is missing or a table is absent):
  `artifacts/api-server/src/test/helpers/liveColumns.ts`

## Refresh command

```
pnpm --filter @workspace/scripts run refresh:live-columns
```

This queries `information_schema.columns` (table_schema='public') on the live
database via the Supabase Management API (requires `SUPABASE_URL` and
`SUPABASE_ACCESS_TOKEN` in the environment) and rewrites the JSON snapshot for
ALL public tables/views, so one command refreshes every drift guard.

Run it whenever a column is renamed/added/dropped live, then commit the updated
JSON. Never edit the generated file by hand.

## Read this before trusting a green drift run

The guards check route columns against the **snapshot**, not against live. So
the snapshot's staleness decides whether a green run means anything, and the
two directions of staleness are not equally safe:

| Drift | Effect on the gate |
|---|---|
| Column live but **not** in snapshot | **Safe.** Gate is stricter than reality. If route code starts using that column the test fails until the snapshot is refreshed — noisy, never blind. |
| Column in snapshot but **dropped live** | **Dangerous.** The gate passes while production is broken. This is the failure the guards exist to catch, and a stale snapshot is exactly how they miss it. |

**Audited 2026-08-09** — snapshot dated `2026-07-21` (19 days stale), checked
against live for every guarded table (`profiles`, `trust_events`,
`trust_profiles`, `trust_restrictions`, `trust_reviews`, `trust_settings`,
`stamp_award_events`, `stamp_campaigns`, `stamp_definitions`, `rank_events`):

- **No snapshot column was missing live** — the gate is **sound, not blind**.
- Live-only (harmless) drift found: `profiles.passport_hidden_sections`,
  `avatar_image_width/height`, `cover_image_width/height`, `is_official`,
  `bio_original_language`, `featured_count`, `show_profile_picture_publicly`;
  `trust_events.updated_at`; `stamp_definitions.template_family`,
  `edition_size`, `is_limited`, `display_priority`; `rank_events.event_type`,
  `content_type`.

**Sound but stale.** Being stale in the safe direction today is luck, not a
property — re-run the refresh (and re-check the dangerous direction) after any
live column drop or rename, before treating a green drift run as evidence.
