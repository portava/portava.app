-- Migration 0206: delete seed pollution from two real accounts (DATA, not schema)
--
-- Two sets, both identified by EXACT ROW ID and both individually re-confirmed
-- against live immediately before this ran. No broad predicate is used anywhere
-- in this file — `source = 'seed_script'` in particular is NOT safe here, because
-- account 92602b6c holds 21 seed_script posts of which only 14 carry the polluted
-- media, and a predicate sweep would take all 21.
--
-- recovery-backups/ is untouched. It is the audit artifact for the earlier
-- seed-post cascade and set (b) below is provable from it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ACCOUNT ATTRIBUTION — CORRECTED
-- ─────────────────────────────────────────────────────────────────────────────
-- The two sets are on DIFFERENT accounts. This was verified, not assumed:
--
--   set (a) 14 post_media rows -> 92602b6c-0eca-433d-9ee2-a82696b3837f
--                                (anroletrading@gmail.com)
--   set (b)  4 content_stamps  -> 5f123260-976f-49f3-a102-52346b4fc0af
--                                (highrollsmoke@gmail.com)
--
-- `SELECT count(*), count(DISTINCT user_id) FROM post_media` returns 16 rows with
-- exactly ONE distinct owner, 92602b6c. There are zero post_media rows owned by
-- 5f123260. The census in docs/admin/moderation-coverage.md describes the owner
-- of the 14 only by attributes — "UUIDv4, @gmail.com, last signed in 2026-08-07,
-- has a genuine Supabase-hosted avatar" — and BOTH accounts signed in on
-- 2026-08-07, which is how the two came to be conflated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SET (a) — 14 post_media rows on 92602b6c
-- ─────────────────────────────────────────────────────────────────────────────
-- Every one re-confirmed live to satisfy ALL FOUR stated properties:
--   * created 2026-07-17
--   * attached to a UUIDv5 (deterministic, generated) post with source='seed_script'
--   * storage object ABSENT (LEFT JOIN storage.objects on bucket+path -> NULL)
--   * post is active/public, so the row renders
--
-- The same account's OTHER 2 post_media rows are deliberately NOT touched: both
-- sit on UUIDv4 posts with source='api_server' and both have their storage
-- objects present. They are genuine user uploads.
--
-- ⚠️  THIS ALONE DOES NOT REMOVE THE BROKEN IMAGES. See the note at the bottom.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SET (b) — 4 content_stamps on 5f123260
-- ─────────────────────────────────────────────────────────────────────────────
-- Orphans from the earlier seed-post cascade. They survived only because
-- content_stamps has NO foreign key to posts, so the cascade that removed their
-- target posts left them behind. Re-confirmed live: all four are owned by
-- 5f123260, entity_type='post', and their entity_id resolves to NO row in posts.
-- All four ids appear verbatim in
-- recovery-backups/2026-08-09-seed-post-cascade/backup_engagement.json.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-running this file is safe: deleting by id a second time affects 0 rows, and
-- the guard passes trivially when the rows are already gone.

BEGIN;

-- Refuse to delete anything if a targeted row no longer matches what was audited.
DO $guard$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM post_media pm
    LEFT JOIN posts p ON p.id = pm.post_id
    LEFT JOIN storage.objects o
           ON o.bucket_id = pm.storage_bucket AND o.name = pm.storage_path
   WHERE pm.id IN (
           'c652cdb0-198d-42f2-8eee-7b5c45c99bda','170354d1-c8ff-4d56-a670-5ec7f4e32be8',
           '9b35939e-e29b-42e7-b9e9-49596d54f9ea','5fab7315-bf02-4245-9acf-401f78bb4607',
           'd2022e13-a1b6-4256-a97d-0dd0f4e7c297','cdf0242f-382f-4115-a76a-5a45aa286801',
           '35314d10-98ba-4b20-b8f3-6b8e961b2f80','5ea9a918-5cf3-4a0a-a9ae-5a226f114d11',
           'ba1bc0cd-8385-469a-ae8b-ad56879504bf','3a1ba991-95e7-4e2e-b33f-b685a3fe9065',
           '290da6ae-0517-4d2f-9c07-6315ae1b950b','7ed58bd4-078a-4985-a9f0-93a4e8f271f9',
           '5f5f8fce-bd72-414b-bd07-5a2d15783215','f1f7f2e2-aceb-492d-82d5-34d88c533657')
     AND (   o.name IS NOT NULL                              -- object appeared
          OR pm.created_at::date <> DATE '2026-07-17'        -- wrong date
          OR substring(pm.post_id::text, 15, 1) <> '5'       -- not a generated post
          OR pm.user_id <> '92602b6c-0eca-433d-9ee2-a82696b3837f');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'guard: % post_media row(s) no longer match the audited state', v_bad
      USING HINT = 'Re-run the audit before deleting. Something changed since it was taken.';
  END IF;

  SELECT count(*) INTO v_bad
    FROM content_stamps cs
    LEFT JOIN posts p ON p.id = cs.entity_id
   WHERE cs.id IN ('63dee836-8134-4397-b539-517a0da535a3','f4f764cd-e767-4317-8d79-7cd9962414c0',
                   '131156b1-b11b-46db-8b7d-64295560047e','acca9763-3abf-4aad-bb39-708e2e2758af')
     AND (   p.id IS NOT NULL                                -- target post came back
          OR cs.entity_type <> 'post'
          OR cs.user_id <> '5f123260-976f-49f3-a102-52346b4fc0af');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'guard: % content_stamps row(s) no longer match the audited state', v_bad
      USING HINT = 'Re-run the audit before deleting. Something changed since it was taken.';
  END IF;
END
$guard$;

-- (a) 14 post_media rows — exact ids only
DELETE FROM post_media WHERE id IN (
  'c652cdb0-198d-42f2-8eee-7b5c45c99bda','170354d1-c8ff-4d56-a670-5ec7f4e32be8',
  '9b35939e-e29b-42e7-b9e9-49596d54f9ea','5fab7315-bf02-4245-9acf-401f78bb4607',
  'd2022e13-a1b6-4256-a97d-0dd0f4e7c297','cdf0242f-382f-4115-a76a-5a45aa286801',
  '35314d10-98ba-4b20-b8f3-6b8e961b2f80','5ea9a918-5cf3-4a0a-a9ae-5a226f114d11',
  'ba1bc0cd-8385-469a-ae8b-ad56879504bf','3a1ba991-95e7-4e2e-b33f-b685a3fe9065',
  '290da6ae-0517-4d2f-9c07-6315ae1b950b','7ed58bd4-078a-4985-a9f0-93a4e8f271f9',
  '5f5f8fce-bd72-414b-bd07-5a2d15783215','f1f7f2e2-aceb-492d-82d5-34d88c533657');

-- (b) 4 orphaned content_stamps — exact ids only
DELETE FROM content_stamps WHERE id IN (
  '63dee836-8134-4397-b539-517a0da535a3','f4f764cd-e767-4317-8d79-7cd9962414c0',
  '131156b1-b11b-46db-8b7d-64295560047e','acca9763-3abf-4aad-bb39-708e2e2758af');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️  THE BROKEN IMAGES ARE NOT GONE YET — DELIBERATELY OUT OF SCOPE HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- Deleting the post_media rows removes the pollution from that table, but the
-- client does not render posts from post_media alone. `posts.media_urls` is a
-- separate array column and it is part of POST_COLUMNS in routes/posts.ts:223,
-- i.e. serialized to clients on every read.
--
-- Measured after this migration ran, on account 92602b6c:
--
--   post uuid | source      | media_urls | object exists | object missing
--   ----------|-------------|------------|---------------|----------------
--   v4        | api_server  |          1 |             1 |              0
--   v5        | seed_script |         21 |             0 |             21
--
-- So the visible breakage is **21 posts, not 14**. The 14 post_media rows were
-- only part of it: the other 7 seed_script posts advertise media through
-- media_urls with no post_media row at all, which is why a post_media-only
-- cleanup cannot fix the rendering. The one genuine post's URL resolves.
--
-- Clearing it means UPDATEing `posts.media_urls` on the 21 seed_script posts on
-- account 92602b6c — posts explicitly ruled out of scope. That is a decision
-- about a real person's visible content and it is NOT taken here. Options, for
-- whoever decides:
--
--   1. UPDATE posts SET media_urls = '{}' WHERE id IN (<the 21 seed_script post ids>);
--      Removes the broken images, leaves the text posts.
--   2. Delete the 21 seeded posts outright (the census's original
--      recommendation), which also removes their text.
--   3. Leave as-is; the images stay broken.
--
-- Option 1 is the smallest change that achieves "the broken images should be
-- gone" without deleting anyone's post text.
