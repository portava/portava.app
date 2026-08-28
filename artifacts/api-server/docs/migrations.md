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

See [intelligence-gathering-buildout.md](./intelligence-gathering-buildout.md). NOTE (2026-08-26): the "all unapplied" note below is stale for CI — the 2130 tables (intel_observations/claims/evidence/confirmations/state_snapshots) and later intel migrations are applied on the CI project (hwokxgbmezheskbzskfr). Production apply-state is tracked per-migration below; verify before staging a prod apply.

- 2128 intel contracts seed (13 claim types, hard_expiry_seconds)
- 2130 intel storage (5 tables, append-only + erasure function)
- 2131 intel_live_label_crowd flag
- 2132 intel_claim_projection_crowd flag
- 2133 intel retention sweep + flag
- 2171 intel_observations += group_key, party_size_bucket (V1 independent-group signal; additive nullable). **Applied to CI + PROD 2026-08-26** (owner-authorized), ahead of the write-path deploy as required (an insert of group_key fails until the column exists). Both columns text/nullable + the party_size_bucket CHECK verified on prod (ajrurzioarfkagpuxfnb).


## 2026-08-28 — Close the anonymous authz-predicate RPC oracle (2182)

- `2182_close_authz_rpc_oracle.sql` — Moves `is_blocked(uuid,uuid)`, `in_accepted_circle(uuid,uuid)` and `can_see_location(uuid,uuid)` from `public` into a new `authz` schema via `ALTER FUNCTION … SET SCHEMA`. **No body is rewritten and no policy expression is touched.** **Applied to CI (hwokxgbmezheskbzskfr) 2026-08-28. Prod (ajrurzioarfkagpuxfnb) press pending owner.**
  - **The hole (proven live, not inferred).** These three SECURITY DEFINER predicates take the caller's identity **as a parameter** and never consult `auth.uid()`, and Postgres left `EXECUTE` granted to `PUBLIC`. So anyone holding the `sb_publishable_` key that ships in the client bundle could `POST /rest/v1/rpc/is_blocked {"a":…,"b":…}` and `POST /rest/v1/rpc/can_see_location {"viewer":…,"target":…}` → HTTP 200 with a boolean answer: a read oracle over the entire block / accepted-circle / location-privacy graph. `can_see_post`, `can_see_trip`, `shares_trip_with`, `viewer_is_blocked` derive the caller from `auth.uid()` internally and were **not** vulnerable and **not** moved.
  - **Why unexpose, not REVOKE or rewrite.** (1) `REVOKE … FROM anon` breaks anonymous browsing: RLS evaluates a policy with the *querying* role's privileges and 3 of the 4 call sites are `TO public`. (2) Rewriting each body to use `auth.uid()` would make `verify-search-path-hazard.mjs` green while testing nothing (a live control turned into a permanent false green) and would duplicate `viewer_is_blocked`. (3) `SET SCHEMA` mutates `pg_proc` in place, so the OID/ACL/proconfig survive and **all four policies keep binding by OID** with zero expression edits; PostgREST does not expose `authz`, so the three RPC endpoints 404.
  - **`GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role`** is required — without it the policy expressions stop resolving these functions and `loc_select` would deny-all. `can_see_location`'s pinned `search_path` was extended to `authz, public, pg_catalog` because its body calls `in_accepted_circle` unqualified and that function left `public`.
  - **Verified (CI + prod dry-run).** (A) caller inventory from the live catalog = exactly the 4 policies + `can_see_location`'s own body, on **both** CI and prod. (B) post-apply: 3 in `authz`, 0 left in `public`, `viewer_is_blocked` untouched, `can_see_location` search_path carries `authz`. (C) all 4 policies re-render `authz.*` (OIDs survived). (D) **seeded anon differential** — a public `user_locations` row is visible to `anon` **1 → 1** across the migration (an empty-table count would have proven nothing, so a row was seeded inside the txn and rolled back). (E) over real HTTP with the publishable key: `rpc/is_blocked`, `rpc/can_see_location`, `rpc/in_accepted_circle` all **404** post-apply while `GET user_locations` / `GET highlights` stay **200**. The prod run was a full `BEGIN … ROLLBACK` against live data (moved=3, left=0, bound=4, differential 1→1) — nothing committed.
  - **`verify-search-path-hazard.mjs` repointed, deliberately.** The prober called `public.is_blocked` / `public.in_accepted_circle` by hard-coded prefix, which now ERRORs post-2182. It resolves each probed function's schema from `pg_proc` at runtime (`public` **or** `authz`, exactly one — dies if neither/both), so it stays correct on both sides of the migration and the shadow-table red/green differential still runs. Verified against CI: `authz.is_blocked` → HAZARD CLOSED, probe schema rolled back, zero residue.
  - **Follow-ups this migration does NOT do (tracked, not bundled):** four checked-in files still `CREATE OR REPLACE` these functions in `public` and would silently undo 2182 on replay (`migrations/0002_map_privacy.sql`, `travel-buddy-standalone/migrations/0002_map_privacy.sql`, `supabase/migrations/0015_blocks.sql`, `artifacts/api-server/baseline/20260819_baseline_structure.sql`; 0015 also re-declares `SET search_path = public`, dropping 0201's pg_catalog pin). Deduplicating `is_blocked` vs `viewer_is_blocked` is cleanup, not security. And anon can still learn a user broadcasts publicly by reading `user_locations` directly under `loc_select (TO public)` — a **product** decision about the logged-out map, not a bug to fold into a security migration.


## 2026-08-28 — Memory projection contract (2183)

- `2183_memory_projection_contract.sql` — Adds the unifying L2/L3 data contract for the Memory + Experience Intelligence spec: `public.memory_events` (§15 memory_event — append-only action ledger), `public.memory_projections` (§15 memory_item, **renamed** because `public.memory_items` is already the media-slide scrapbook table), and `public.memory_feedback` (§15 — the unified hide/forget/incorrect/not_interested/**already_known** signal the audit found missing for New-to-Me §7). **Applied to CI (hwokxgbmezheskbzskfr) 2026-08-28. Prod press pending owner.**
  - **Additive only, and gated.** Three new tables in `public`; **no existing table, column, or policy is touched**. RLS enabled with **zero policies** (deny-default to anon/authenticated), `service_role`-only grants — the exact intel_* pattern. Feature flag `memory_projection` seeded **OFF** gates the future projector/retrieval writers; the contract tables are inert until then.
  - **Reuses, does not duplicate (spec §24).** `memory_projections.updated_at` uses the shared `public.set_updated_at()` (0001). `experience_edge` (§15) is deliberately NOT created — it already exists and is populated as `compass_graph_edges` (974 rows). `memory_events` is append-oriented via a **memory-specific** `trg_memory_events_no_update` guard that blocks **UPDATE only** — deliberately NOT the shared `intel_append_only()`, which also blocks DELETE (unless an intel erasure flag is set) and would break the account-deletion cascade added in 2187. `memory_events` must stay DELETABLE for deletion + retention.
  - **Idempotent projection (spec §22 step 4).** `memory_projections` upserts on `UNIQUE (user_id, memory_type, subject_type, subject_id)`; `memory_events` de-dupes on `(user_id, event_type, subject_type, subject_id, occurred_at)`. Replay/backfill is deterministic.
  - **Spec-faithful columns.** provenance jsonb + confidence + last_supported_at (§16); sensitivity + visibility "narrow never broaden" (§19); state active/decayed/hidden/forgotten (§17); retention_class over the six §18 classes; valid_to for expiring/intent memory (§9).
  - **Verified on CI (functional, not just structural), all rolled back:** insert an event → **UPDATE blocked by the append-only trigger**; upsert the same projection twice → **exactly 1 row**, confidence updated 0.7→0.95; `already_known` feedback inserts; residue 0/0/0 afterward; `pg_policies` count = 0 with RLS on for all three; flag `enabled=false`.
  - **REVERSAL** block at the file tail. Next slice: the projector service (gated by `memory_projection`) that writes these from canonical facts + the Experience Graph.

## 2026-08-28 — Memory projector (2184)

- `2184_memory_projector.sql` — The first deterministic projector for the memory contract (2183). Two `service_role`-only SQL functions: `project_user_memory(user, enforce_flag)` and `project_all_memory(enforce_flag)`. **Applied to CI 2026-08-28. Prod press pending owner.**
  - **Projects the Experience Graph, does not restate it (spec §21, §24).** Reads a user's `person→city` `visited`/`returned_to` edges from `compass_graph_edges` (the spec's already-populated `experience_edge`) and upserts one **episodic** `memory_projection` per city. Deterministic confidence `least(0.95, 0.60 + 0.08·observed_count + 0.05·returned)`; a `returned_to` edge relabels the memory `"… (returned)"` — the Rediscovery signal (§8).
  - **Idempotent (spec §22 step 4)** — upsert on the projection unique key; `memory_events` de-dupe on their unique index. Re-running only refreshes confidence/`last_supported_at`.
  - **Flag-gated** — respects `memory_projection` (seeded OFF in 2183); `p_enforce_flag=false` exists only for tests/backfill. Off ⇒ returns 0, writes nothing.
  - **Least-privilege, 2182 lesson applied.** These take a caller-supplied `user_id` and WRITE, so `EXECUTE` is revoked from `PUBLIC`, **`anon` and `authenticated`** (Supabase default-privileges grant new public functions to anon/authenticated *explicitly*, so `REVOKE FROM PUBLIC` alone is insufficient — caught and fixed during CI verification) and granted to `service_role` only. `search_path` pinned.
  - **Verified on CI (functional, rolled back):** seed a `visited` edge (obs 3) → flag-gated call returns **0**; bypass-flag call projects **1** episodic city memory, `confidence=0.84`, `type=episodic`, `retention=durable_fact`, `content="Visited testville"`; re-run stays **1 row** (idempotent); add a `returned_to` edge (obs 5 total) → `confidence` caps at **0.95**, `content="Visited testville (returned)"`. Post-fix privilege check: `anon`/`authenticated` EXECUTE = **false**, `service_role` = true. Residue 0.
  - **REVERSAL** at file tail. Next slice: the scheduler that calls `project_all_memory()` on a cadence, then retrieval + retention sweeps.

## 2026-08-28 — Memory retrieval, New-to-Me & retention (2185)

- `2185_memory_retrieval_retention.sql` — The read + governance side of the memory system. Three `service_role`-only functions. **Applied to CI 2026-08-28. Prod press pending owner.**
  - `memory_retrieve(user, surface, limit)` — surface-specific retrieval (spec §10). `discovery` hard-filters `already_known`/`not_interested` subjects (New-to-Me bias) and never returns hidden/forgotten/expired memory; `passport` is a `valid_from` timeline; `compass` ranks by confidence then recency. Feedback filters are hard filters, not weights (§10).
  - `memory_is_new_to_user(user, subject_type, subject_id)` — the New-to-Me primitive (spec §7): true only when the user has **no active memory** of the subject **and** no `already_known`/`not_interested` feedback. A brief impression never marks something known — only a projection or explicit feedback does (§7).
  - `memory_sweep_expired(enforce_flag)` — retention (spec §18): `ephemeral`/`short_lived` memory past `valid_to` is **deleted**; other expired memory **decays** (kept, state→decayed, stops surfacing). Intent memory (§9) decays aggressively here. Flag-gated.
  - Least-privilege (2182/2184 rule): `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`, granted to `service_role` only; `search_path` pinned.
  - **Verified on CI (functional, rolled back):** seeded active Da Nang + Rome (with `already_known`), an expired ephemeral intent, an expired durable place, and an `already_known` on Tokyo (no projection) → `memory_retrieve(compass)`=**2**, `memory_retrieve(discovery)`=**1** (Rome hidden); `is_new_to_user` Da Nang=**false**, Paris=**true**, Tokyo=**false**; `memory_sweep_expired`=**2** (ephemeral deleted, durable→`decayed`). `anon`/`authenticated` EXECUTE=false.
  - **REVERSAL** at file tail. Next: the scheduler that calls `project_all_memory()` + `memory_sweep_expired()` on a cadence, and route wiring for retrieval.

## 2026-08-28 — Memory projector: full §5 taxonomy (2186)

- `2186_memory_projector_taxonomy.sql` — Replaces `project_user_memory` (2184, episodic-only) with the full spec §5 taxonomy, all from canonical sources; widens `project_all_memory` to every user with any signal. **Applied to CI 2026-08-28. Prod press pending owner.**
  - **EPISODIC** ← `compass_graph_edges` person→city (as 2184). **SEMANTIC** ← `compass_user_preferences.interests`/`travel_styles` (explicit, one projection per value). **SOCIAL** ← `user_follows`, **excluding blocked pairs** (§19), marked `sensitivity='sensitive'`. **PLACE** ← `saved_places`.
  - **§19 enforced structurally:** social memory omits any followee the user has blocked or been blocked by (`NOT EXISTS` over `blocks`), so a blocked relationship can never leak into a memory-derived recommendation.
  - Idempotent, flag-gated, `service_role`-only — unchanged from 2184. `project_all_memory` now unions persons from the graph + follows + saved_places + preferences.
  - **Verified on CI (functional, rolled back), full FK chain seeded (auth.users→profiles→discovery_places):** a user with a city visit, interests `{nightlife,food}` + style `{budget}`, follows of A **and a blocked B**, and one saved place → `total=6` (episodic 1, semantic 3, social 1, place 1); **B excluded from social** (`blocked_in_social=0`); social `sensitivity=sensitive`; 3 events; **idempotent** (re-run stays 6 rows). 
  - **REVERSAL** re-applies 2184's bodies.

## 2026-08-28 — Memory account-deletion integrity (2187)

- `2187_memory_deletion_cascade.sql` — Closes the deletion gap: the memory tables were user-keyed but unlinked, so account deletion did not purge them (spec §17/§23/§24). **Applied to CI 2026-08-28. Prod press pending owner.**
  - Adds `ON DELETE CASCADE` FKs `memory_events/memory_projections/memory_feedback.user_id → profiles(id)`. Since `profiles.id → auth.users(id)` is itself `ON DELETE CASCADE`, `auth.admin.deleteUser` now purges all memory via a two-hop cascade — no application code in the loop. Safe: the tables are empty (0 rows), asserted by a precondition.
  - Hardens `project_all_memory` with a **profile-existence guard** on the graph branch, so a stale Experience-Graph person key that no longer has a profile can never produce an FK-violating write (follows/saved/prefs user_ids already FK to profiles).
  - **Design note:** this exposed that 2183's original append-only guard (the shared `intel_append_only()`) blocked the cascade DELETE. 2183 was corrected in the same PR to a memory-specific `trg_memory_events_no_update` (blocks UPDATE only); `memory_events` stays deletable for deletion + retention.
  - **Verified on CI (§23 certification, rolled back):** seed auth.users→profiles→memory (event+projection+feedback) → `DELETE FROM auth.users` → **profile=0, events=0, projections=0, feedback=0** (two-hop cascade purged everything); UPDATE on memory_events still blocked (`update_blocked=true`).
  - **REVERSAL** at file tail.

## 2026-08-28 — Memory Rediscovery (2188)

- `2188_memory_rediscovery.sql` — Adds `memory_rediscover(user, city, limit)`, the Rediscovery surface (spec §8) the audit flagged as the one genuinely-thin piece. **Applied to CI 2026-08-28. Prod press pending owner.**
  - On returning to a city, surfaces the user's standing memory that matters now: FIRST the "you were here before" episodic memory of that city (**case-insensitive** — the graph stores both `Lisbon` and `lisbon`), then durable place/social memory, each tagged with a `reason` (`been_here_before` / `you_saved` / `you_know`) so the surface can explain itself (§8). Hidden/forgotten/decayed memory and `already_known`/`not_interested` subjects are excluded. `service_role` only.
  - **Verified on CI (functional, rolled back):** a user with episodic Lisbon (returned) + episodic Berlin + a saved place (hidden) + a follow → `memory_rediscover(uid,'lisbon')` returns **2** rows, Lisbon-episodic first with `reason=been_here_before` (matched lowercase), the hidden place excluded, the social memory present. Berlin (different city) excluded. `anon` cannot execute.
  - **REVERSAL** at file tail.

## 2026-08-28 — Memory intent producer (2189)

- `2189_memory_intent.sql` — Adds `record_intent_memory(...)`, the request-time producer for layer L5 (spec §5.5 Intent Memory, §9 Intent Engine). 2183 allowed `memory_type='intent'` and the `ephemeral` retention class and 2185's sweep deleted expired ephemeral rows, but **nothing ever wrote intent** — the layer had a shape and no producer. **Applied to CI 2026-08-28. Prod press pending owner.**
  - **The spec's two hard rules are enforced in SQL, not left to callers.** §9 ("intent should decay aggressively and should not silently become a permanent preference") and §24 ("do not turn every short-term intent into a durable personality trait"): the function **hard-codes** `retention_class='ephemeral'` and **always** sets a bounded `valid_to`, and clamps the TTL to **[5, 720] minutes** — a caller cannot pass 0 (never expires) or a year. `ON CONFLICT` **refreshes** the window rather than accumulating, so a repeated signal never compounds into permanence.
  - Flag-gated on `memory_projection`; `service_role`-only (revoked from `PUBLIC`, `anon`, `authenticated` — the 2182 lesson); `search_path` pinned.
  - Producer: `lib/intentMemory.ts` — a **deterministic keyword classifier** (`classifyIntent`) over 10 intent types, chosen over a model call so the ask path stays cheap, predictable and unable to hallucinate an intent; specific beats broad (`coffee` before `food`). `recordIntentFromQuery` is fire-and-forget (never throws) and stores a **derived label**, never the raw question, so question detail cannot leak into a stored memory row. Wired into the Compass ask path in `routes/compass.ts`.
  - **Verified on CI (functional, rolled back):** flag off → returns false and writes nothing; bypassed → one row, `retention_class=ephemeral`, `memory_type=intent`; TTL clamp `0 → 5 min` and `999999 → 720 min`; a repeat signal keeps **1 row** (refresh, not accumulate); an expired intent returns **0 rows from `memory_retrieve`**; `memory_sweep_expired` then deletes it (`swept=3, rows_left=0`).
  - **REVERSAL** at file tail.

## 2026-08-28 — Memory lifecycle correctness (2190 + 2191) — PR #189 merge gate

An audit of 2183-2189 found four blocking defects and two important ones sharing one schema root: the projection layer could not answer *"what still supports this memory?"*. Fixed at the schema, not per symptom. **Both applied to CI 2026-08-28; MUST be applied together (2190's retraction depends on 2191's support stamping). Prod press pending owner.**

- `2190_memory_lifecycle_fixes.sql`
  - **P0-1 deletion.** 2187 relied on `auth.users → profiles → memory ON DELETE CASCADE` and was certified on CI. **Production's `public.profiles` has ZERO foreign keys** (verified against prod `pg_constraint`), and `AccountDeletionService` deliberately keeps an **anonymised tombstone profile** rather than deleting the row — so the cascade could never fire in production. Adds `erase_memory_for_user(uuid)` (SECURITY DEFINER, idempotent, service_role-only), called as a **FATAL** `erase_derived_memory` step in the canonical service, mirroring `erase_intel_for_actor`. The 2187 FKs are kept as defence-in-depth but no longer depended on. Registered in `deletionDispositions.ts` (`ERASED_BY_CASCADE` + `POST_BASELINE_TABLES`).
  - **P0-2 hide/forget.** `memory_retrieve`/`memory_rediscover` now return a stable `id`, and retrieval honours feedback matched by id **or** by the durable subject key. `memory_feedback` gains `memory_type` and its FK becomes `ON DELETE SET NULL`, so a forget **survives re-projection** instead of being deleted by the very pass it was meant to suppress. The route enforces ownership: a projection id is resolved scoped to the caller, so a foreign id 404s and writes nothing.
  - **P0-3 / P1-5 / P1-6 support accounting.** New `last_projected_at` watermark (distinct from `last_supported_at`, which dates the *evidence*), a `retracted` state, and `project_user_memory_with_retraction` which retracts anything a full pass did not re-affirm. One mechanism covers block-after-projection, unfollow, unsave and removed interests. `project_all_memory` now fans out to it.
- `2191_memory_projector_content_and_support.sql`
  - **P0-4 content.** Placeholders (`'Saved a place'`, `'Follows a traveler'`) replaced with real subjects — `Saved Cafe Sua Da in Da Nang`, `Follows Maya Chen`, `Visited Lisbon (has returned)`. Episodic memory is now grouped **case-insensitively** (`initcap(lower(city))`), fixing duplicate contradictory rows from the graph's `Lisbon`/`lisbon` edges.
  - **P0-3 retention.** Semantic memory (`derived_preference`) gets a rolling 180-day `valid_to`, refreshed each pass. Episodic/place/social stay `durable_fact` with `valid_to` NULL **by design** — §18 gives that class "canonical lifecycle/user deletion", so a TTL would be wrong; their lifecycle is retraction-on-loss-of-support.

**Verified on CI (functional, all rolled back).** Proof A: `projected=5 retracted=0` on first pass (watermark correct), episodic deduped to **1** row across `Lisbon`+`lisbon`, real content, semantic `valid_to` set, retrieval returns an id. Proof B: hide via the returned id removes the row (`2 → 1`); a forget **survived** deleting the projection and a full re-projection (`social = 0`); another user's identical memory untouched. Proof C/D: block after projection → social `1 → 0` (`retracted=1`); unsave → place `1 → 0`; semantic forced past `valid_to` → `swept=1`, retrieval `1 → 0`; `erase_memory_for_user` → `left=0`, rerun deletes `0` (idempotent), bystander rows untouched.

**Also corrected:** 2183's grant comment claimed "no anon/authenticated grant", which was **false** — Supabase default privileges do grant those roles table-level access. RLS deny-default (enabled, zero policies) is what actually protects the data; the comment now says so, and flags that adding any policy would make those grants live.

### §7 New-to-Me — BUILT BUT DEFERRED (recorded 2026-08-28)

`memory_is_new_to_user(user, subject_type, subject_id)` (migration 2185) is **built, tested at the SQL level, and deliberately NOT wired to any consumer**. It has zero callers. **Do not describe §7 New-to-Me as delivered.**

**Why deferred:** its intended consumer is the Discovery serve path (§13), which emits candidates in a **different id space** from the one place memory is keyed in — place memory keys on `discovery_places.id` (uuid, via `saved_places`), while Discovery serves prefixed ids (`db/…`, plus OSM ids). Calling the function with a Discovery candidate id would match nothing and report **every** place as "new to me": a silent, confident wrong answer on a user-facing surface, which is worse than the feature being absent.

**What wiring it actually requires** (the next slice, not a patch): (1) an id bridge between the Discovery serve id space and `discovery_places.id` — the same demand-side bridge IG-08 needed (`saved_places → discovery_places → places`); and (2) a product decision on where novelty applies (Discovery serve, Compass "show me something new", or both). Until (1) exists, it stays unwired on purpose.

### §12 Passport and §13 Discovery memory consumers — why both are absent (recorded 2026-08-28)

The memory system exposes `memory_retrieve(user, surface, limit)` with `surface` values `compass | discovery | passport`, but **only `compass` has a consumer**. That was flagged as a gap; on inspection **both absences are correct**, and neither is a small wiring job.

**§12 Passport — absent BY DESIGN, and wiring it into the existing routes would be a privacy defect.**
The main passport surface, `GET /users/:username/passport` (`routes/passport.ts:143`), resolves its viewer with `getOptionalViewerId` — i.e. it is viewable by **other users and by unauthenticated visitors**. Derived memory is the *subject's own* inferred data: remembered places, followed travellers, inferred preferences. §12 is explicit that "private memory and inferred preferences remain private unless the user explicitly chooses to expose them", so injecting `memory_retrieve(..., 'passport', ...)` into that route would publish inferences to arbitrary viewers — precisely the "surveillance-style" outcome §24 forbids.

What a correct §12 consumer needs: (1) a **self-only** surface, following the existing `GET /me/passport/postcards` / `GET /me/stamps` pattern rather than the `/users/:username/...` one; and (2) a product decision about *which* memory classes are appropriate to show a user about themselves — noting `sensitivity='sensitive'` social memory and inferred semantic preferences are the most delicate. That is a design slice, not a wiring slice.

**§13 Discovery — blocked on an id-space mismatch** (see the New-to-Me deferral above): Discovery serves prefixed ids (`db/…`, OSM), while place memory keys on `discovery_places.id`. Any naive wiring reports every place as new.

**Next implementation slice, when these are picked up:** the shared prerequisite is the `saved_places → discovery_places → places` id bridge (the same one IG-08 required). Build that first; it unblocks §13 and §7 together. §12 is independent of it and gated on the self-only-surface design decision instead.

## 2026-08-28 — Memory provenance, visibility, event retention, policy (2192 + 2193)

Closes the remaining **important** findings from the completeness audit (the four P0s landed in 2190/2191 via PR #190). **Applied to CI 2026-08-28; must be applied together and in order. Prod press pending owner.**

- `2192_memory_provenance_policy.sql`
  - **Provenance (§16)** — `memory_projections.source_event_ids uuid[]`. The projection recorded a `derivation` string but not *which* events supported it, so §16's first required question ("what source event(s) produced this memory?") had no answer.
  - **Visibility (§19)** — `memory_projections.visibility`. The invariant *"projections inherit or narrow the visibility of their source; they never broaden it"* was not merely unenforced, it was **unrepresentable**. Defaults to `private`, the narrowest, so a projector that forgets cannot leak.
  - **Event retention (§18/§53)** — `memory_events.expires_at` + the sweep now removes expired events. Without it the append ledger grew unbounded and held identifiable history indefinitely — the "indefinite location history by accident" §53 warns against.
  - **`memory_policy` (§15)** — the six retention classes as inspectable data: TTL, `on_expiry`, `allowed_surfaces`, `user_visible`, `deletion_behavior`, and a rationale per class. Seeded to **describe** what 2189/2191 already do; a disagreement between the table and the code is a defect in the code.
  - **Sensitivity is now read (§19)** — `sensitivity='sensitive'` was written by the social projector and consulted by nothing. Retrieval now excludes sensitive memory from the `discovery` surface (the one feeding other people's recommendations) while keeping it for the user's own Compass answers.
  - Also revokes the 2183 trigger function `memory_events_no_update`, which carried Supabase's default grants. A trigger-returning function is unreachable via PostgREST so there was no practical exposure — but the postcondition deliberately checks **every** `memory_*` function, and weakening it to allow an exception is how the next real mis-grant would slip through.
- `2193_memory_projector_provenance.sql` — the projector **populates** those columns. Columns without a writer are worse than no columns: they look like a control while answering nothing. Every class is written `private` explicitly rather than relying on the DDL default, because derived memory is an *inference* — a public follow does not make "Portava thinks you know Ana" public.

**Verified on CI (rolled back):** `compass=2 / discovery=1` (sensitive social excluded from discovery); `historical_contribution` served on **zero** surfaces (its `allowed_surfaces` is empty by design); default visibility `private`; expired events swept (`events_left=0`). Provenance: episodic and social each carry a source event id and **every referenced id resolves to a real `memory_events` row**. Local: typecheck clean, 81/81 memory+presence tests pass.

## 2026-08-28 — Memory reset + export (2194)

- `2194_memory_reset_export.sql` — the last two §17 user controls. The system had view (retrieve), hide/forget (feedback) and full erasure (account deletion), but no way to say *"start my personalization over"* short of deleting the account, and no way to see everything Portava had derived. **Applied to CI 2026-08-28. Prod press pending owner.**
  - `memory_reset_for_user(user, memory_types)` — §17 "reset personalization **or selected categories**". Passing `NULL` resets everything; passing e.g. `['semantic']` resets one class.
  - `memory_export_for_user(user)` — everything derived, **including the why**: derivation, supporting-event count, and what suppresses it. Deliberately includes decayed/hidden/retracted rows, because an export showing only what we currently serve would understate what is stored.
  - Routes: `POST /api/compass/me/memory/reset`, `GET /api/compass/me/memory/export`.

  **The design decision that matters: reset does NOT delete feedback.** A user who asked us to forget something and then resets personalization has not withdrawn that instruction — they have asked us to rebuild the derived picture. Deleting their suppressions during a reset would silently resurrect memory they explicitly forgot on the very next projector pass — the same resurrection bug 2190 fixed at the re-projection level. So reset clears projections and events; suppressions survive, and the route reports `feedbackKept` so the caller can say so. Erasure (`erase_memory_for_user`) is different and still clears everything, because there is no user left to hold a preference for.

  **Verified on CI (rolled back):** export returns 3 rows, all carrying a derivation; a partial reset of `['semantic']` cleared 1 and left episodic intact; a full reset cleared 2 projections and **kept 1 suppression**; and after re-projection the forgotten social memory was **still not visible** — the forget survived the reset. Locally: typecheck clean, 17/17 route tests.
