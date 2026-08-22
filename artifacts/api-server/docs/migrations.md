# Applied migrations — live database record

The live Supabase database is migrated via the Management API
(`POST /v1/projects/{ref}/database/query`, token `SUPABASE_ACCESS_TOKEN`);
direct psql/pooler connections are unreachable from this workspace.
Record every migration here once applied and verified against
`information_schema`.

| Migration | Applied | Verified |
| --- | --- | --- |
| `0209_retire_freeze_flags.sql` | **CI project (`hwokxgbmezheskbzskfr`) only, 2026-08-11. NOT YET APPLIED TO PRODUCTION** — the production block is staged at `_incoming/prod-freeze-retire.sql` (gitignored) for the owner to run in the SQL editor. | Retires the four `freeze_*` flags (`freeze_city`/`freeze_event`/`freeze_circle`/`freeze_booking`), which were seeded by `0065_phase7_safety.sql` as parameterised emergency stops whose target was to live in `feature_flags.metadata` and be read via `getFlagRow()` — a function with zero callers. They gated nothing. The seed rows are also removed from `0065` so a fresh database never creates them, and their `INERT_SEEDED_FLAGS` entries are removed from `scripts/check-flag-polarity.mjs` as its rule R7 requires once a flag is no longer seeded. **`feature_flag_audit_log.flag` REFERENCES `feature_flags(flag)` ON DELETE CASCADE (`0118:8`), so deleting these rows destroys their toggle history without warning — the migration therefore REFUSES and rolls back if any audit rows exist for them, rather than cascading silently.** Verified on CI: the refusal path was red-proofed by planting one audit row (raised `P0001` and all four rows survived, proving rollback); after clearing it the apply left `freeze_rows 0`, `orphan_audit 0`, total flags back to the pre-seed baseline of 5, `disable_*` untouched; and a second run committed cleanly, so it is idempotent. Admin behaviour is unchanged and deliberately so: `routes/admin.ts` still excludes the four from `GET /admin/feature-flags` and returns 400 `not_operational` from `PATCH`, which is what keeps behaviour identical on a database where this has not been applied. Incidental finding: the Management API **does** execute multi-statement bodies — this `BEGIN … COMMIT` script with two `DO` blocks ran as one request, resolving the transport caveat recorded against `0199`. |
| `0155_calling_system.sql` | 2026-07-19 (Phase 1 — calling integration backbone) | `call_sessions`, `call_participants`, `call_preferences` present with constraints + RLS confirmed via `information_schema` / `pg_policies` |
| `2065_live_places_recaps.sql` | 2026-08-03 (Phase 3 Live Places Recaps) | `live_place_recaps` plus version, chapter, source, and immutable snapshot tables, indexes, service policies, and disabled recap flags verified live via `information_schema`, `pg_indexes`, and `pg_policies`. |
| `2066_live_place_recap_lifecycle_rpc.sql` | 2026-08-03 (Phase 3 Live Places Recaps) | `create_live_place_recap`, `regenerate_live_place_recap`, and `transition_live_place_recap` verified live; execution is granted to `service_role` and revoked from `anon`/`authenticated`. |
| `2067_live_place_recap_integrity_hardening.sql` | 2026-08-03 (Phase 3 Live Places Recaps hardening) | Live function definitions verified after application: parent/place, snapshot/source provenance, and chapter references are revalidated transactionally; only `service_role` executes recap writes; restore requires a previously published archived version. |
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
| `20260724_reviews_photos_column.sql` | 2026-07-24 (task 2408 — adds `reviews.photos TEXT[] NOT NULL DEFAULT '{}'` so POST/PATCH /api/reviews can persist up to 3 photo URLs per review) | `column_name=photos`, `data_type=ARRAY`, `column_default='{}'::text[]` confirmed via `information_schema.columns` (Management API status 201) |
| `20260802_image_dimensions.sql` | 2026-07-26 (adds `cover_image_width`/`cover_image_height` to `events` and `trips`; adds `avatar_image_width`/`avatar_image_height`/`cover_image_width`/`cover_image_height` to `profiles` — lets the OG route emit exact `og:image:width`/`og:image:height` tags required by iMessage for the large preview card) | all 8 columns confirmed via `information_schema.columns` (Management API returned `[]`) |
| `0197_rank_events_analytics_columns.sql` | 2026-07-26 (Task 2656 — adds `event_type text` + `content_type text` nullable columns to `rank_events` so the ranking pipeline can emit typed analytics events; widens `outcome` CHECK to include `'analytics'` sentinel; makes `item_kind` and `position` nullable for analytics-only rows; widens `surface` CHECK to cover all SurfaceName values used by DiscoveryRankingService) | `event_type` + `content_type` columns confirmed via `information_schema.columns`; `item_kind` and `position` `is_nullable=YES` confirmed; new CHECK constraints confirmed via `pg_constraint` (Management API status 201) |
| `2045_posts_canonical_place_id.sql` | PENDING (not yet applied to live DB) | Adds `canonical_place_id UUID REFERENCES places(id)` to `posts` and `post_media`; creates `place_mismatch_reports` table (`id`, `post_id`, `reporter_id`, `reported_place_id`, `reason`, `status`, `resolved_by`, `resolved_action`, `resolved_at`, `created_at`) with unique-pending index. Apply via Management API; after applying, remove `place_mismatch_reports` from `SKIP_TABLES` and `posts.canonical_place_id` from `ALLOWLIST` in `src/scripts/checkWritePathColumns.ts`. |
| `20260809_real_place_image_provenance.sql` | 2026-07-26 (Task 2707 — adds provenance columns to `generated_visuals`: `image_source_type`, `accuracy_status`, `canonical_place_id`, `provider_place_id`, `source_url`, `source_provider`, `source_license`, `source_attribution`, `reference_asset_ids`, `reference_image_count`, `generated_with_ai`, `generation_method`, `verification_status`, `verified_by`, `verified_at`, `disclaimer_required`, `disclaimer_text`, `last_accuracy_reviewed_at`; adds `image_source_type` + `image_accuracy_status` to `discovery_places`) | `image_source_type` + `image_accuracy_status` confirmed on `discovery_places` via `information_schema.columns`; all `generated_visuals` columns confirmed (Management API returned `[]`) |
| `20260810_place_image_reports.sql` | 2026-07-26 (Task 2707 — creates `place_image_reports` table for user "wrong place" image reports: `place_id`, `image_url`, `reported_by`, `report_reason`, `status`, `confidence_adjustment`, `reviewed_by`, `reviewed_at`, `created_at`; RLS enabled with self-read policy) | `place_image_reports` table confirmed via `information_schema.tables`; indexes and RLS confirmed (Management API returned `[]`) |
| `20260810_content_translations.sql` | 2026-07-28 (Task 3171 — creates `content_translations` sidecar cache table (entity_type/entity_id/target_language + translated_fields JSONB) used by the on-demand translation pipeline for posts, comments, events, trips, and bios; adds `original_language text` column to `posts`, `posts_comments`, `events`, and `trips`; adds `bio_original_language text` to `profiles` — never touches `profiles.default_language` which is the user preference field) | `content_translations` table + unique index confirmed; `original_language` on all four entity tables confirmed; `profiles.bio_original_language` confirmed via `information_schema.columns` (Management API status 201) |
| `2063_place_days_foundation.sql` | 2026-08-02 (Phase 1 Place Days) | Adds service-role-only `place_days`, unique canonical-place/local-date constraint, lifecycle indexes, RLS, and disabled `place_days_enabled` flag. Verified live: table, four indexes, service policy, and disabled feature flag. |
| `2064_shared_moments_foundation.sql` | 2026-08-03 (Phase 2 Shared Moments prerequisite) | Shared Moments tables, RLS/service policy, and disabled feature flags applied live before the recap foreign key migration. |
| `0199_rank_events_live_pulse_surface.sql` | 2026-08-10 (applied via Supabase Management API, ahead of the Live Pulse serve-writer code as required). Pre-apply check confirmed live `rank_events` held only `pulse`/`compass`/`events`, all inside the new 12-value list, so the revalidating `ADD` could not fail. Post-apply `pg_constraint` read shows `rank_events_surface_check` with all 12 values including `'live_pulse'`, `convalidated = true` — the constraint exists, so the half-applied state described below did not occur. Gate re-run after apply: exit 0 with `GATE live_pulse: PERMITTED`. | Widens `rank_events_surface_check` to add `'live_pulse'` (all eleven 0197 values preserved), giving Live Pulse serve rows their own key space so they cannot hijack outcome attribution from ranked `surface='pulse'` impressions. Wrapped in `BEGIN`/`COMMIT` so a failed revalidating `ADD` cannot leave the table with no surface constraint. Verify with `pnpm run check:rank-events-surfaces`. That check no longer answers "is `'live_pulse'` permitted?" by regex-parsing `pg_get_constraintdef()` — it runs a **behavioural probe**: one self-aborting `DO` statement that attempts a real `INSERT INTO public.rank_events` with `surface='live_pulse'` (sourcing an FK-valid `user_id` from `auth.users` in the same statement, and supplying known-good values for every other constrained column) and then unconditionally `RAISE`s, so the row can never persist on either the success or the failure path. After the probe it counts rows matching the probe's sentinel `item_id` prefix and requires zero. Error classes are read from SQLSTATE captured by `GET STACKED DIAGNOSTICS`, never from message prose: `23514` check_violation = rejected, but **only** once the reported `CONSTRAINT_NAME` is matched against the live `pg_constraint` listing and shown to constrain `surface` and nothing else — an unattributable `23514` is fatal, not a clean "rejected". `23503`/`23502` mean the probe row shape is wrong and prove nothing. Constraint-definition text is still printed, and the old literal harvest still runs, but both are labelled **informational** and can never set the gate verdict. **Proceed only on exit 0 AND with the line `GATE live_pulse: PERMITTED` present in the output. Block on every other exit code, including any code not listed here, and block on an absent `GATE` line whatever the exit code.** The standing pre-existing `living_page` / `compass` rejection reported by the informational harvest is expected on every run; it is printed prominently as a `FINDING` block and **does not change the exit code** — the run still exits 0, because it is information for a human and not a deploy verdict. **Exit 1 is never chosen by the script and always BLOCKS**: 1 is Node's default code for an involuntary death (uncaught exception, unhandled rejection, module-resolution or `tsx`/TypeScript load failure), so if any "proceed" state shared it a crash would be indistinguishable from a pass. Nothing that can throw runs at module scope in that script for the same reason — environment validation and the `new URL(SUPABASE_URL)` project-ref parse both happen inside `main()`, so a malformed `SUPABASE_URL` is a printed `BLOCKED` verdict with exit 2 rather than an uncaught throw exiting 1. Exit 2 means the check could not run (no live credentials, or an unparsable `SUPABASE_URL`) and therefore proved nothing — it BLOCKS, because a gate that no-ops without credentials is not a gate. Exit 3 means BLOCKED and covers **every** fail-closed condition the script chooses, including any throw that escapes `main()` (`main().catch()` converts it to 3 rather than letting Node default it to 1): `live_pulse` rejected by the surface CHECK; an unattributable or non-surface `check_violation`; `foreign_key_violation` / `not_null_violation` (the probe is wrong); read-only transaction or insufficient privilege; any other SQLSTATE; no probe sentinel in the response (result unknown); `auth.users` empty so no FK-valid `user_id` existed; a probe row persisted or the pristine count could not run; `rank_events` has CHECK constraints but none on `surface` (**the half-applied-0199 state: the `DROP` committed and the revalidating `ADD` did not**) or none at all; no CHECK constrains `outcome`; or the `pg_constraint` read itself threw. Note that "more than one CHECK mentions `surface`" is no longer fatal — the probe measures the effective intersection directly — it is now reported for a human. Every path the script controls prints exactly one `GATE live_pulse:` verdict before exiting — `PERMITTED` (the live DB accepted the insert and it was rolled back), `NOT PERMITTED` (the surface CHECK rejected it), or `BLOCKED (<reason>)` (could not be established) — so an absent `GATE` line means the check never ran or died before reaching a verdict, which is itself a block. `pnpm run check:all` runs this gate and scores it under exactly this rule (`run_gate` in `scripts/run-all-checks.sh`, which requires **both** exit 0 **and** a `grep -qxF 'GATE live_pulse: PERMITTED'` match on the captured output, and fails everything else including exit 1); it remains a manual pre-deploy step as well, since check:all needs live credentials. **Transport caveat:** it could not be established from this repo whether `POST /v1/projects/{ref}/database/query` executes multi-statement scripts or one statement per call (the evidence is indirect — this doc says migrations, including multi-statement ones, are applied through this endpoint, but no code in the repo has ever sent a multi-statement body). The probe is therefore a single statement, valid either way; the one transport property it does depend on is that the response body contains the Postgres error message text, and if the sentinel is absent it reports BLOCKED rather than guessing. |

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
## 20260728 — generated_visuals retry/lock columns

| File | Status |
|------|--------|
| `src/migrations/2034_generated_visuals_retry_cols.sql` | applied 2026-07-28 |

Adds `retry_after`, `locked_until`, and `locked_by` to `generated_visuals`.
Required by `VisualGenerationWorker` (pessimistic lock + exponential-backoff retry).
Without these columns the worker crashed on every poll cycle producing repeated
WARN logs.  Applied via Supabase Management API; indexes for the queued/generating
status filters also created.

## 20260807 — hidden_gems feed columns

| File | Status |
|------|--------|
| `supabase/migrations/20260807_hidden_gems_feed_columns.sql` | applied 2026-08-07 |

Adds `canonical_place_id`, `source_type`, and `moderation_status` columns to `hidden_gems`.
Required by the Gems feed endpoint (`/api/media/gems-feed`) for eligibility filtering and AI-provenance labeling.

## 2053 — discovery_places.canonical_location_id

| File | Status |
|------|--------|
| `src/migrations/2053_discovery_places_canonical_location_id.sql` | applied 2026-07-28 |

Adds `canonical_location_id UUID REFERENCES places(id)` to `discovery_places`.
Allows search results to carry a direct link to the canonical Living Destination Page
(`/place/:id`) without a separate join at query time. NULL = no canonical page yet.

## 2052 — content_stamps: extend entity_type CHECK for memory + place

| File | Status |
|------|--------|
| `src/migrations/2052_content_stamps_memory_type.sql` | pending — apply after 2049 (content_stamps table creation) |

Extends the `content_stamps_entity_type_check` constraint to include `'memory'` and `'place'`.
Required because Task #3049 wired StampButton to memory detail screens using `entityType="memory"`,
and the place detail screen uses `entityType="place"`. Apply immediately after 2049 lands.


## 2059 — stamp_artwork_versions: expand generation_source CHECK to include 'placeholder'

| File | Status |
|------|--------|
| `src/migrations/2059_stamp_artwork_generation_source_placeholder.sql` | applied 2026-07-31 |

Drops the old unnamed check constraint (`generation_source IN ('ai_generated','admin_upload')`) and replaces it with a named constraint that also allows `'placeholder'`. Required for the placeholder-provider detection feature (task 2957): when `STAMP_WORKER_ENABLED=true` but no OpenAI key is set, candidates are stored with `generation_source='placeholder'` so the admin review screen can filter them and the `provider_degraded` health flag has persistent evidence to query.


## 2079 — profiles.is_official: privileged in BOTH directions

| File | Status |
|------|--------|
| `src/migrations/2079_is_official_privileged_both_directions.sql` | applied 2026-08-09 |

Replaces `enforce_is_official_service_role()` with
`enforce_is_official_privileged()`, which delegates to
`caller_may_write_profile_role()` (added by 2078) and guards **any** change to
`is_official`, in either direction, on INSERT and UPDATE.

**Two defects fixed, both found by probing the control rather than reading it.**

*1 — the guard rejected the only path that could use it.* The old function tested
`current_setting('role')` alone. On a direct postgres connection (Supabase SQL
editor, psql, Management API) that GUC is `'none'`, so superuser administration
was refused. Verified by executing `UPDATE profiles SET is_official = true` as
`postgres`: it raised `is_official can only be set by the service role`. Since
**no application path writes this column at all** — every reference in `src/` is
a read or serializer — direct DB access was the only way to grant official
status, and it was exactly the path being refused.

> The failure mode is what makes this more than untidy: an operator with full
> superuser access is told "only the service role may do this", which is false
> from where they are standing. Under time pressure the likely resolution is to
> drop or edit the trigger — losing the control entirely. **A control that
> misleads its operator is worse than one that merely blocks, because it invites
> its own removal.**

*2 — the guard was one-directional.* It fired only on `false → true`. `true →
false` was unguarded (verified by executing the demotion). Combined with 2078
re-granting `authenticated` column UPDATE on all non-`role` columns, and RLS
permitting `id = auth.uid()`, an official account holder could **clear their own
badge and could not restore it** — a one-way door out of a state that gates
publisher surfaces. This was not in the original finding, which is why it was
fixed rather than filed.

**Scope check.** `caller_may_write_profile_role()` was only *added* as a
consumer, never modified. Its two existing consumers
(`enforce_profile_role_privileged`, `admin_set_profile_role`) are untouched and
behave identically. It is deliberately not renamed despite the `_role` name:
renaming would require rewriting both consumers and the test that calls it as an
RPC.

**Drift note — RETRACTED 2026-08-10, there was no drift.** This previously
claimed that `profiles.is_official`, `enforce_is_official_trigger` and
`enforce_is_official_service_role()` appear in no migration file. That was
wrong. `supabase/migrations/0106_profiles_is_official.sql` creates the function
(line 14), the trigger (lines 28–30) and `idx_profiles_is_official`. The
"tree-wide search" behind the original claim evidently did not cover the
`supabase/migrations/` root — this repo has five migration roots
(`artifacts/api-server/src/migrations`, `artifacts/api-server/migrations`,
`migrations`, `db`, `supabase/migrations`), and searching only the first
manufactures drift that does not exist. The follow-on claim that 2078's
"`enforce_is_official_trigger` (migration 0106)" citation was bogus is wrong for
the same reason: 2078 pointed at the right number in a different directory
(`supabase/migrations/0106_profiles_is_official.sql`, not
`0106_engagement_indexes.sql` — two unrelated files share the 0106 prefix across
two roots). 2078's citation stands. What remains true: 2079 is the first time
the **both-directions** guard is captured in the chain; the objects themselves
were already recorded by 0106.

**Tests — `src/test/isOfficialPrivileged.test.ts`, 8 tests, live DB.**

```
pnpm run test:is-official-privileged
```

Proven capable of failing, three ways:

| Run | Result |
|---|---|
| Against the **unpatched** schema | **2 fail** — both `true → false` demotion tests; the gap is real |
| With the trigger **dropped entirely** | **5 fail** — every negative assertion goes red |
| After 2079 | **8 pass** |

The 3 that stay green under a dropped trigger are the ones the trigger does not
govern, and that is deliberate: cross-user writes are blocked by RLS, the
service-role path is privileged, and an ordinary signup INSERT must *not* be
blocked. A file where every test goes red when you remove one object is a file
that is not distinguishing anything.

Direct-postgres administration — the path the test suite cannot reach, since it
goes through PostgREST — was verified separately by executing both `false→true`
and `true→false` as `postgres`: both now succeed (rolled back).

⚠️ A first draft of the test had order-dependent fixtures: the cross-user test
asserted "badge still true" and failed only because the self-demotion test had
already cleared it, reporting the wrong defect at the wrong line. Each
badge-dependent test now restores state via `ensureBadge()` first.


## Intelligence Gathering (2128-2133)

See [intelligence-gathering-buildout.md](./intelligence-gathering-buildout.md). All unapplied; every flag seeded false.

- 2128 intel contracts seed (13 claim types, hard_expiry_seconds)
- 2130 intel storage (5 tables, append-only + erasure function)
- 2131 intel_live_label_crowd flag
- 2132 intel_claim_projection_crowd flag
- 2133 intel retention sweep + flag
