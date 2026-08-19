-- 2116_post_media_storage_policy_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates)
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY for the four DROPs (§8 item
-- 9d) — Q3's captured live text for composer-pkg's four policy names is the
-- rollback. Do not apply until that capture exists.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §2.3 root #17 and §7 row 2116.
-- `composer-pkg/migrations/0005_storage_post_media.sql` (frozen, FREEZE —
-- APPLY.md carries a production project ref) declares four `storage.objects`
-- policies on the `post-media` bucket, disjoint by name from canonical's:
--
--   "post-media public read"     SELECT, (no TO clause → role public),
--                                 USING (bucket_id = 'post-media')
--   "post-media auth upload own" INSERT, TO authenticated,
--                                 WITH CHECK (bucket_id = 'post-media' AND
--                                   (storage.foldername(name))[1] = auth.uid()::text)
--   "post-media auth update own" UPDATE, TO authenticated, same predicate
--   "post-media auth delete own" DELETE, TO authenticated, same predicate
--
-- Canonical's own history on the same bucket: `0103_post_media.sql` created
-- `post_media_storage_owner_insert`, `post_media_storage_owner_delete`, and
-- `post_media_storage_public_read` (three policies). Canonical's later
-- `2089_revoke_post_media_public_read.sql` DROPS
-- `post_media_storage_public_read` specifically, after measuring — against
-- production, with the shipped anon key — that the bucket was fully
-- readable and listable despite being marked private, because closing the
-- URL shape did not drop the GRANT behind it (2089's own header: "RLS
-- policies OR together... a bucket that is 'private' only in the sense that
-- ONE URL SHAPE 400s"). Canonical's LIVE-INTENDED set, post-2089, is
-- therefore just two policies: `post_media_storage_owner_insert` and
-- `post_media_storage_owner_delete` — no SELECT policy at all; reads go
-- through the service-role-signed-URL relay (2089's header: "Signed URLs
-- are minted by the service role, which bypasses RLS").
--
-- THE HOLE composer-pkg REOPENS, IF LIVE
-- =========================================
-- If composer-pkg's `"post-media public read"` (USING bucket_id = 'post-media',
-- role public, i.e. unauthenticated) is also live, it is the EXACT hole 2089
-- was written to close, reachable under a different name — 2089's own DROP
-- cannot have removed it, since DROP POLICY's identity is the name and this
-- name is disjoint. RLS policies OR together, so 2089's fix is defeated by a
-- policy 2089 never knew existed. `composer-pkg` additionally grants
-- UPDATE, a capability canonical's own family never had at all — if live,
-- any authenticated user could overwrite objects in their own folder, not
-- merely upload/delete them.
--
-- INTENDED FINAL STATE
-- =====================
-- composer-pkg's four names dropped. Canonical's two post-2089 policies
-- (`post_media_storage_owner_insert`, `post_media_storage_owner_delete`)
-- ensured present. No SELECT policy of any kind and no UPDATE policy of any
-- kind remain on `storage.objects` for the `post-media` bucket.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'post_media_storage_owner_insert'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: canonical''s post_media_storage_owner_insert is not live — this migration assumes 0103/2089 already ran. Re-derive from Q3.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'post_media_storage_public_read'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: post_media_storage_public_read is still live — 2089 was supposed to have dropped this already. Investigate before proceeding.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "post-media public read"        ON storage.objects;
DROP POLICY IF EXISTS "post-media auth upload own"     ON storage.objects;
DROP POLICY IF EXISTS "post-media auth update own"     ON storage.objects;
DROP POLICY IF EXISTS "post-media auth delete own"     ON storage.objects;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'post_media_storage_owner_delete'
  ) THEN
    CREATE POLICY "post_media_storage_owner_delete"
      ON storage.objects FOR DELETE TO authenticated
      USING (
        bucket_id = 'post-media'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN ('post-media public read', 'post-media auth upload own',
                          'post-media auth update own', 'post-media auth delete own')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a composer-pkg storage.objects policy name is still present.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname LIKE '%post-media%' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a SELECT policy on the post-media bucket still exists — canonical''s intended state has none.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'post_media_storage_owner_insert'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: post_media_storage_owner_insert is missing after this migration ran.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS — the signed-URL relay this bucket depends on for ALL reads would stop working.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Cannot be written here for the four DROPs — see BLOCKED ON banner. Once
-- Q3's pre-apply capture exists for each of composer-pkg's four names, the
-- rollback is CREATE POLICY of each captured text, verbatim.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT policyname, roles, cmd, qual, with_check FROM pg_policies
--  WHERE schemaname = 'storage' AND tablename = 'objects'
--    AND (policyname LIKE '%post-media%' OR policyname LIKE 'post_media%');
-- -- expect exactly two rows: post_media_storage_owner_insert (INSERT),
-- -- post_media_storage_owner_delete (DELETE), both TO authenticated.
-- -- Manually confirm anon GET/list against the post-media bucket still 400s.
