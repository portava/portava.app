# Applied migrations — live database record

The live Supabase database is migrated via the Management API
(`POST /v1/projects/{ref}/database/query`, token `SUPABASE_ACCESS_TOKEN`);
direct psql/pooler connections are unreachable from this workspace.
Record every migration here once applied and verified against
`information_schema`.

| Migration | Applied | Verified |
| --- | --- | --- |
| `0155_calling_system.sql` | 2026-07-19 (Phase 1 — calling integration backbone) | `call_sessions`, `call_participants`, `call_preferences` present with constraints + RLS confirmed via `information_schema` / `pg_policies` |
| `20260719_unique_open_group_room.sql` | 2026-07-19 (Phase 4 — one open group room per context) | partial unique index `uniq_open_group_room_per_context` verified via `pg_indexes` |
| `0156_event_voice_rooms.sql` | 2026-07-19 (Phase 5 — event voice rooms) | `call_participants.hand_raised_at` + `call_moderation_actions` verified via `information_schema` |
| `20260720_compass_preference_columns.sql` | 2026-07-20 (adds the 10 preference columns PATCH /compass/me/preferences accepts but the live table lacked — travel_styles, preferred_languages, hidden_categories, notification_preferences, boost_visibility_enabled, location_privacy_mode, delayed_post_default, visibility_sub_controls, safety_preference, rent_buddy_discoverable) | all 10 columns confirmed via `information_schema.columns`; full-field upsert via PostgREST returned 201 with values persisted |
| `0161_friend_requests_responded_at.sql` | 2026-07-20 (response-time auditing for friend requests) | `friend_requests.responded_at` + `updated_at` (timestamptz) verified via `information_schema` |
| `0162_rent_buddy_availability_blocks.sql` | 2026-07-20 (buddy wizard fix — column defined in legacy 0047/0134 but never applied live) | `rent_buddy_profiles.availability_blocks jsonb NOT NULL DEFAULT '[]'` confirmed via `information_schema.columns` |
| `0163_write_path_drift_columns.sql` | 2026-07-20 (wizard-write-path drift audit — adds `posts.filter_id`/`filter_intensity`/`media_duration_seconds`, `rent_buddy_bookings.country_code`, `rent_buddy_policy_flags.updated_at`, all written by routes but absent live) | all 5 columns confirmed via `information_schema.columns` |
| `0164_write_path_drift_columns_2.sql` | 2026-07-20 (second write-path drift batch — found by the maintained checker, see below; adds `highlights.filter_id`/`filter_intensity`/`updated_at`, `message_requests.updated_at`, `message_threads.created_by`, `moderation_actions.metadata`, `plan_attendance_events.metadata`, `reports.notes`, `trip_plan_items.added_by`/`city`/`country`/`description`, `user_friendships.accepted_request_id`) | all 13 columns confirmed via `information_schema.columns` |
| `0165_city_timezones.sql` | 2026-07-21 (persists coordinate-learned city→IANA timezone entries so restarts don't reset new cities to UTC; loaded on boot by CompassGraphEngine) | `city_timezones` columns (`city_key`,`timezone`,`created_at`,`updated_at`) confirmed via `information_schema.columns` |
| `20260723_compass_conversations.sql` | 2026-07-20 (compass conversational-AI session tables — applied when the write-path checker flagged `compass_conversations` + `compass_conversation_messages` as written-but-absent) | both tables present with RLS enabled confirmed via `pg_class.relrowsecurity` |
| `20260726_compass_ranking_factors.sql` | 2026-07-20 (Phase 7 formal recommendation engine — adds `compass_served_recommendations.ranking_factors` JSONB storing the grounded ranking snapshot `{ compassMatch, communityScore, factors }` per served recommendation for factor-grounded /compass/why explanations) | column confirmed via `information_schema.columns` (Management API status 201) |
| `20260724_compass_memories.sql` | 2026-07-20 (Phase 6 layered Compass memory — `compass_memories` table for structured insights scoped session/trip/long_term/circle, plus `compass_conversations.compressed_message_count` for bounded compression cadence) | table + both indexes and the new column confirmed via `information_schema` (Management API status 201) |
| `20260727_compass_live.sql` | 2026-07-21 (Phase 12 Compass Live — `compass_live_sessions` per-user live-session records: rolling JSONB context, checks/nudges counters, end-of-session summary; one active session per user via partial unique index) | table + all 11 columns confirmed via `information_schema.columns`; `live_sessions_own` policy confirmed via `pg_policy` (Management API status 201) |
| `0156` RLS addendum (`ALTER TABLE call_moderation_actions ENABLE ROW LEVEL SECURITY`) | 2026-07-19 (Phase 7 readiness audit — original 0156 omitted RLS on the audit table) | `pg_class.relrowsecurity = true` confirmed live; no policies on purpose (service-role-only table) |

## Wizard-write-path drift audit — 2026-07-20 (task 1925)

Every multi-column `.insert()`/`.upsert()`/`.update()` payload in
`src/routes` and `src/services` was mechanically extracted and diffed
against the live `information_schema.columns`. High-traffic wizard-style
paths verified column-by-column:

| Write path (table) | Result |
| --- | --- |
| `profiles` (PATCH /profile settings wizard) | all columns present live |
| `trips` (create + edit wizard) | all columns present live |
| `events` (create wizard — writes `state`, not `status`) | all columns present live |
| `profile_privacy_settings` (privacy upsert) | all columns present live |
| `passport_postcards` (postcard edit) | all columns present live |
| `compass_user_preferences` (preferences upsert) | covered by `20260720_compass_preference_columns.sql` |
| `rent_buddy_profiles` (buddy wizard) | covered by 0162 + existing probes |
| `message_threads` (group chat sync insert) | all columns present live |
| `posts` (POST /posts creation) | **drifted** — `filter_id`, `filter_intensity`, `media_duration_seconds` missing live → applied `0163` |
| `rent_buddy_bookings` (rebook insert) | **drifted** — `country_code` missing live → applied `0163` |
| `rent_buddy_policy_flags` (admin resolve update) | **drifted** — `updated_at` missing live → applied `0163` |

All drifted columns were migrated live and are now probed by
`CRITICAL_COLUMNS` in `src/lib/schemaDriftCheck.ts`, along with one
sentinel column per audited path (guarded by
`src/test/schemaDriftCheck.test.ts`).

### Maintained write-path column check (task 1939)

The ad-hoc perl extraction above is superseded by a committed, repeatable
check:

```
pnpm run check:write-path-columns          # from artifacts/api-server
pnpm run check:write-path-columns -- --verbose
```

`src/scripts/checkWritePathColumns.ts` parses `src/routes` + `src/services`
with the TypeScript AST (no greedy regex — chained calls, multi-line
payloads, spreads, arrays, and same-scope `const payload = {...}` variables
are handled), extracts every column written by `.insert()`/`.upsert()`/
`.update()` on a `.from("<table>")` chain, and diffs them against the live
`information_schema.columns` via the Supabase Management API
(`SUPABASE_PROJECT_TOKEN` or `SUPABASE_ACCESS_TOKEN`). Exit 1 lists every
written column (or table) absent live with the `file:line` of each write
site; unresolvable sites (dynamic table names, non-static payloads) are
counted and shown with `--verbose`, never failed. Known-good exceptions go
in the annotated `ALLOWLIST` in the script.

**Read-side (select-list) coverage (task 1947).** The same script also
extracts every column read via a string-literal `.select("col_a, col_b")`
on a `.from("<table>")` chain and diffs those against the live schema — a
missing select-list column fails the whole read with PGRST100, the same
drift class from the read side. The select list is parsed PostgREST-style:
aliases (`alias:col`), casts (`col::text`), and JSON paths (`col->x`)
resolve to the base column; `*`, `count`, and embedded resources
(`rel(...)`) are skipped. Non-literal select lists are counted as
unresolvable (shown with `--verbose`). Missing read columns/tables fail
with exit 1 and share the `ALLOWLIST`/`SKIP_TABLES` handling.

Adding read coverage (2026-07-21) surfaced 28 pre-existing read drifts
(e.g. `circle_memberships.member_id`/`owner_id` — the live columns are
`user_id`/`other_id` — the whole `passport_stamps` select list, and the
dead `circle_members` table). These are recorded in the annotated
`READ_BASELINE` / `READ_BASELINE_TABLES` sets in the script: baselined,
NOT fixed, so the check stays green while catching new drift. Each entry
is a latent runtime read failure — burn the list down (apply the missing
migration or fix the select list, then delete the entry); never grow it.

Run it before release and after any migration wave. Its first full run
(2026-07-20) found a second batch of 13 drifted columns across 8 tables —
applied live as `0164_write_path_drift_columns_2.sql` (see table above).

Earlier migrations (`0001`–`0154`) predate this record and are live; see the
legacy migration reconciliation notes for the history of the legacy directory.