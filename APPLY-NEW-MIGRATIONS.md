# APPLY — circle_invites table + RLS hardening

Two migrations. The first fixes a **Critical** bug: the code has shipped
circle-invite endpoints (friends.ts, requests.ts, groupChat.ts, messaging.ts)
against a `circle_invites` table that was never created — every circle-invite
call fails at the DB layer. The second closes a **High** exposure: 12 live
tables have no RLS while the mobile app ships the anon key.

## Files
1. `artifacts/api-server/src/migrations/2069_circle_invites.sql`
   Creates `circle_invites` (uuid PK, owner/recipient FKs → profiles ON DELETE
   CASCADE, status pending/accepted/declined/cancelled with default 'pending',
   responded_at/created_at/updated_at, UNIQUE (owner_id, recipient_id) — the
   re-invite path updates the existing row in place via maybeSingle(), so the
   pair must be unique — plus recipient+status and owner+status indexes).
   RLS enabled, no policies: all access is via the API's service-role client.
2. `artifacts/api-server/src/migrations/2070_rls_hardening.sql`
   Enables deny-all RLS on: devices, key_packages, post_reactions,
   comment_likes, post_shares, post_edits, stamp_milestones, post_event_links,
   media_stamp_reactions, place_mismatch_reports, feature_flags, job_health.
   Each wrapped in a to_regclass() existence check (idempotent, safe if a
   table is missing in an environment). NO permissive policies on purpose:
   the client audit (see the migration header) found zero direct client-side
   `.from()` usage of these tables — the app goes through the API, and the
   API uses the service role, which bypasses RLS.

## Apply (Supabase SQL editor)
1. Open the Supabase dashboard → SQL Editor.
2. Paste and run `2069_circle_invites.sql`.
3. Paste and run `2070_rls_hardening.sql`.
   Both are idempotent — re-running is safe.
4. No code changes needed; the server already targets this schema.
   Optional smoke test: `cd artifacts/api-server && pnpm test 2>&1 | tail -6`.

## Verify
2069 — table exists with the expected shape and RLS on:

    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'circle_invites'
    ORDER BY ordinal_position;
    -- expect: id, owner_id, recipient_id, status (default 'pending'),
    --         responded_at (nullable), created_at, updated_at

    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid = 'public.circle_invites'::regclass;
    -- expect: pkey, two profiles FKs (ON DELETE CASCADE), status CHECK,
    --         UNIQUE (owner_id, recipient_id), no-self-invite CHECK

2070 — RLS enabled everywhere, and no accidental permissive policies:

    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('circle_invites', 'devices', 'key_packages',
        'post_reactions', 'comment_likes', 'post_shares', 'post_edits',
        'stamp_milestones', 'post_event_links', 'media_stamp_reactions',
        'place_mismatch_reports', 'feature_flags', 'job_health')
    ORDER BY relname;
    -- expect: relrowsecurity = true for every row returned
    -- (a missing row means that table doesn't exist in this env — fine,
    --  the DO-block skipped it)

    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('circle_invites', 'devices', 'key_packages',
        'post_reactions', 'comment_likes', 'post_shares', 'post_edits',
        'stamp_milestones', 'post_event_links', 'media_stamp_reactions',
        'place_mismatch_reports', 'feature_flags', 'job_health');
    -- expect: zero rows (deny-all — service role bypasses RLS)

## Honesty / rollback
- Deny-all means anon/authenticated keys are fully locked out of these
  tables. That is the intent. If some untracked client build does query one
  of them directly, the symptom is empty reads / failed writes from the app
  only — the API keeps working. Rollback for a single table:
  `ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY;` (then add a scoped
  policy instead and re-enable).
- 2069 only creates a table that nothing could have written to before; there
  is no data-migration risk.

# APPLY — atomic stamp progress + user_stamps uniqueness

> **RENAMED (2026-08-05):** these two files were renamed from
> `2071_stamp_progress_atomic.sql` / `2072_user_stamps_unique.sql` to
> `2075_stamp_progress_atomic.sql` / `2076_user_stamps_unique.sql` to resolve
> duplicate prefixes with `2071_feature_flags_deny_anon.sql` /
> `2072_track_profiles_full_name.sql`. Both were **ALREADY APPLIED to
> production Supabase under the old names on 2026-08-05 — do not re-apply.**
> The apply/verify steps below are kept for the historical record.

Two migrations closing stamp-award concurrency bugs. The first fixes a
**Med-High** lost-update bug: StampAwardEngine incremented stamp_progress with
a read-modify-write, so concurrent awards of a repeatable stamp lost counts.
The second closes a **Med-High** double-award race: user_stamps has no unique
index, so concurrent awardStamp calls for the same (user, definition, source)
could both insert.

## Files
1. `artifacts/api-server/src/migrations/2075_stamp_progress_atomic.sql`
   (renamed from `2071_stamp_progress_atomic.sql` on 2026-08-05; already
   applied under the old name — do not re-apply)
   Creates `increment_stamp_progress(p_user_id uuid, p_definition_id uuid)` —
   a single-statement INSERT ... ON CONFLICT (user_id, stamp_definition_id)
   DO UPDATE SET progress_count = progress_count + 1 RETURNING progress_count.
   EXECUTE is revoked from PUBLIC/anon and granted to service_role only (the
   API's service-role client is the sole caller).
2. `artifacts/api-server/src/migrations/2076_user_stamps_unique.sql`
   (renamed from `2072_user_stamps_unique.sql` on 2026-08-05; already applied
   under the old name — do not re-apply)
   First dedups existing rows: (a) non-repeatable definitions keep only the
   earliest live stamp per (user_id, stamp_definition_id); (b) all definitions
   keep only the earliest live stamp per (user_id, stamp_definition_id,
   source_type, source_id). Then creates partial unique index
   `user_stamps_live_award_unique` on (user_id, stamp_definition_id,
   COALESCE(source_type,''), COALESCE(source_id::text,'')) WHERE is_revoked =
   false. COALESCE makes NULL sources collide; the partial predicate keeps the
   revoke → re-award heal path working.

## Apply (Supabase SQL editor) — DONE 2026-08-05; do not re-apply
1. Open the Supabase dashboard → SQL Editor.
2. Paste and run `2075_stamp_progress_atomic.sql` (applied 2026-08-05 as `2071_…`).
3. Paste and run `2076_user_stamps_unique.sql` (applied 2026-08-05 as `2072_…`).
   Both are idempotent — re-running is safe (verified against Postgres 16:
   dedup, re-run, 23505 on live duplicates, re-award after revoke all pass).
4. Code is already deployed-order safe: the engine calls the RPC and falls
   back to the legacy upsert on PGRST202 (function missing), and it already
   maps 23505 on the stamp insert to already_earned / already_awarded.

## Verify
2075 (formerly 2071) — function exists and counts atomically:

    SELECT increment_stamp_progress('<some-user-uuid>', '<some-def-uuid>');
    -- run twice: expect 1 then 2; clean up the test row afterwards:
    -- DELETE FROM stamp_progress WHERE user_id = '<some-user-uuid>'
    --   AND stamp_definition_id = '<some-def-uuid>';

2076 (formerly 2072) — index exists and no live duplicates remain:

    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'user_stamps' AND indexname = 'user_stamps_live_award_unique';
    -- expect: UNIQUE ... WHERE (is_revoked = false)

    SELECT user_id, stamp_definition_id, COALESCE(source_type,''),
           COALESCE(source_id::text,''), count(*)
    FROM user_stamps WHERE is_revoked = false
    GROUP BY 1,2,3,4 HAVING count(*) > 1;
    -- expect: zero rows

## Honesty / rollback
- 2072 DELETES duplicate stamp rows (keeping the earliest per key). These rows
  are the double-awards the migration exists to remove, but if you want a
  paper trail, snapshot first:
  `CREATE TABLE user_stamps_pre_2072 AS SELECT * FROM user_stamps;`
- The index only constrains live (non-revoked) rows; non-repeatable stamps
  awarded from two DIFFERENT sources are still guarded app-side only (the
  index predicate cannot join stamp_definitions.is_repeatable).
- Rollback: `DROP INDEX IF EXISTS user_stamps_live_award_unique;` and
  `DROP FUNCTION IF EXISTS increment_stamp_progress(uuid, uuid);` — the engine
  degrades to its legacy paths automatically.
