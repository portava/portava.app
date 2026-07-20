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

Earlier migrations (`0001`–`0154`) predate this record and are live; see the
legacy migration reconciliation notes for the history of the legacy directory.