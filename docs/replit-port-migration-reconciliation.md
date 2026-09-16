# Incoming-migration reconciliation (lead-owned)

Measured, not assumed: every row below was checked against BOTH live schemas
(prod `ajrurzioarfkagpuxfnb`, CI `hwokxgbmezheskbzskfr`) and against repository
history, on 2026-09-16.

Two ledgers exist and neither is complete:
- `public.schema_migration_ledger` (this repo's own; cols: filename, checksum,
  applied_at, applied_by, notes) — written by `execute_sql` applies.
- `supabase_migrations.schema_migrations` (Supabase CLI) — written by
  `apply_migration`. The Replit agent used THIS one, so none of its work has a
  repo-ledger row.

## The eleven incoming files

| Replit file | prod | CI | supabase version (prod / CI) | disposition |
|---|---|---|---|---|
| 2222_input_selection_history.sql | absent | APPLIED | — / (pre-existing) | **DO NOT PORT.** Byte-identical to main's `2258_input_selection_history.sql` apart from a header. Main already renumbered it, for a documented reason: replit's `2222` collides with main's APPLIED `2222_map_telemetry_refusal_event.sql` (prod ledger row, `applied_by=backfill`, 2026-09-15). Replit's copy is the pre-rename snapshot. |
| 2260_privacy_safe_sensing_credentials.sql | APPLIED | APPLIED | 20260916075630 / 20260916075548 | **Renumber file only; record as already-applied.** Number collides with main's `2260_availability_windows.sql`. |
| 2261_presence_cleanup_flag.sql | APPLIED | APPLIED | 20260916075633 / 20260916075553 | **Renumber file only; record as already-applied.** Collides with main's `2261_passport_travel_dna_prefs.sql`. |
| 2262_coverage_state.sql | APPLIED | APPLIED | 20260916075635 / 20260916075559 | Number free in main, but keep it in the same renumbered block as 2260/2261 so the three sensing files stay contiguous. Record as already-applied. |
| 2264_world_experience_intelligence.sql | absent | absent | — | Genuinely unapplied. Allocate a fresh number; rehearse on CI before prod. |
| 2265_experience_sessions_outcomes.sql | absent | absent | — | **DO NOT PORT** — `routes/experienceSessions.ts` is rejected as a duplicate (main's is table-free and wired to calibration), so its table has no consumer. |
| 2266_map_telemetry_retention.sql | CANNOT RUN | applicable | — | Creates `purge_expired_map_telemetry()` over `map_telemetry_events` / `map_telemetry_drops`. Both tables + `expires_at` exist on CI; **neither table exists in production**. Port and apply to CI; production application is blocked behind main's own unapplied map-telemetry migrations, which is a pre-existing backlog, not this port's to force. |
| 3000_media_processing_lifecycle.sql | APPLIED | APPLIED | 20260916120414 / 20260916120301 | Number free. Record as already-applied. |
| 3001_media_asset_deletion_lifecycle.sql | APPLIED | APPLIED | 20260916120416 / 20260916120308 | Number free. Record as already-applied. |
| 3002_media_processing_retention.sql | APPLIED | APPLIED | 20260916120418 / 20260916120313 | Number free. Adds four `media_assets` columns; idempotent. Record as already-applied. |
| 3003_media_lifecycle_rls.sql | APPLIED | APPLIED | 20260916120421 / 20260916120319 | Number free. Record as already-applied. |

## The 2128 edit is not a migration

Replit edited the ALREADY-APPLIED `2128_intel_contracts_seed.sql` in place to add
one `freshness_policies` row (`safety.constraint`, ttl 900, hard 3600). Editing an
applied migration changes its checksum and manufactures exactly the rename/edit
drift the ledger gate exists to catch, and `ON CONFLICT (claim_type) DO NOTHING`
means a replay would be a silent no-op on a database that already has the other
rows — so the row would never arrive.

`safety.constraint` is absent from BOTH prod and CI. Correct port: leave 2128
untouched; carry the single row in a NEW forward migration.

## Already-applied is recorded, not replayed

For every row marked "record as already-applied": the file is renumbered/imported
and a `schema_migration_ledger` row is written naming the new filename, its
checksum, and — in `notes` — the `supabase_migrations.schema_migrations` version
it ACTUALLY ran as in each environment. The SQL is not re-executed against prod.
Each file must still be idempotent so a fresh database (the CI kernel job) builds
correctly.

## Number allocation

FIRST ATTEMPT WAS WRONG AND THE GUARD CAUGHT IT. I allocated 3000-3010 on the
reasoning that main's highest sequential number is 2995, so 3000+ was "free".
`check:migration-prefixes` refused all nine files: the canonical band is
2100-2999 (`/^2[1-9]\d{2}_/`), and a 4-digit prefix >= 3000 is rejected outright.
The four incoming media files were already NUMBERED 3000-3003 by their author, so
they were never importable at those numbers either.

The 8-digit dated form (`20260916_...`) is NOT an escape hatch. Apply order is
plain lexicographic, and "20260916" sorts BEFORE "2100" (second character '0' <
'1'), so a dated file runs near the START of the chain, not the end.

So the allocation is a free contiguous run inside the band, placed after every
dependency. `2951-2969` is free and 19 wide. Dependency floors, read from the
migrations that create each object rather than assumed:

    media_assets ............. 0191_media_assets.sql
    feature_flags ............ 0037_feature_flags.sql
    freshness_policies ....... 2122_freshness_policies.sql
    intel_coverage_snapshots . 2181_intel_coverage_snapshots.sql
    map_telemetry_events ..... 2202_map_telemetry.sql
    map_telemetry_drops ...... 2202_map_telemetry.sql

Every floor is <= 2202, so the whole run is safe.

| new | from | note |
|---|---|---|
| 2951 | 3000_media_processing_lifecycle | already applied both envs |
| 2952 | 3001_media_asset_deletion_lifecycle | already applied both envs |
| 2953 | 3002_media_processing_retention | already applied both envs |
| 2954 | 3003_media_lifecycle_rls | already applied both envs; needs 2952 |
| 2955 | NEW — media_asset_write_boundary | revoke; needs 2951/2952 |
| 2956 | 2260_privacy_safe_sensing_credentials | frees main's 2260_availability_windows |
| 2957 | 2261_presence_cleanup_flag | frees main's 2261_passport_travel_dna_prefs |
| 2958 | 2262_coverage_state | already applied both envs |
| 2959 | RESERVED for 2264_world_experience_intelligence | Map lane, with its consuming code |
| 2960 | RESERVED for 2266_map_telemetry_retention | Map lane; CI-applicable only |
| 2961 | NEW — safety_constraint_freshness_policy | replaces the in-place 2128 edit |

2959 and 2960 are RESERVED, not committed: their objects have no reader until the
Map lane's code lands, and a table nobody reads is not something to ship ahead of
the feature that needs it. The Map lane owns both numbers.

Every renumbered filename must be repointed wherever it is referenced — src/,
docs/, census files, and any backfill list naming it.

## Media boundary, measured (directive point 4)

Run against portava-ci (`hwokxgbmezheskbzskfr`) inside a DO block aborted by a
deliberate RAISE, so nothing persisted. A real asset was seeded first — an
earlier attempt with no seeded row produced a vacuous "PERMITTED" on UPDATE and
DELETE, because zero matching rows raise no error.

READS (rows visible for one owner's asset):

| role | media_asset_lifecycle_events | media_processing_attempts | media_assets |
|---|---|---|---|
| anon (`auth.uid()` NULL, claims explicitly cleared) | 0 | 0 | 0 |
| a different authenticated user | 0 | 0 | 0 |
| the OWNER (control) | 1 | 1 | 1 |

WRITES:

    anon INSERT media_assets ......................... DENIED (42501)
    other-user INSERT media_assets ................... DENIED (42501)
    other-user INSERT media_asset_lifecycle_events ... DENIED (42501)
    other-user INSERT media_processing_attempts ...... DENIED (42501)
    other-user UPDATE another's media_assets ......... 0 rows affected
    other-user DELETE another's media_assets ......... 0 rows affected

The 42501s are RLS refusing the WITH CHECK (all three tables have RLS enabled and
carry ONLY an owner SELECT policy, so every other command has no policy and is
denied). The zero-row UPDATE/DELETE are the same RLS filter excluding the row.

PROBE ARTIFACT WORTH RECORDING: `set_config('request.jwt.claims', …, true)` is
TRANSACTION-local, not statement-local. A first run showed `anon` seeing 1 row —
it had inherited the OWNER's claims from the preceding block. Clearing the claims
before switching to `anon`, and asserting `auth.uid() = NULL` in the same branch,
produced the 0 above. Any future probe of this kind must clear claims per branch.

So no media read or write exposes another user's private objects today. What
remains is that `anon` and `authenticated` still hold table-level INSERT, UPDATE
and DELETE on all three tables (identical on prod and CI) — unnecessary, and one
`FOR ALL` policy away from being live. That is the 2972 pattern, and 3010 revokes
them.
