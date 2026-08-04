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
