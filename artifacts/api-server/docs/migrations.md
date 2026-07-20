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
| `0156` RLS addendum (`ALTER TABLE call_moderation_actions ENABLE ROW LEVEL SECURITY`) | 2026-07-19 (Phase 7 readiness audit — original 0156 omitted RLS on the audit table) | `pg_class.relrowsecurity = true` confirmed live; no policies on purpose (service-role-only table) |

Earlier migrations (`0001`–`0154`) predate this record and are live; see the
legacy migration reconciliation notes for the history of the legacy directory.