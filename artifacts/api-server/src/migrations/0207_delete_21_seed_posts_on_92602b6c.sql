-- Migration 0207: delete the 21 seed_script posts on 92602b6c (DATA, not schema)
--
-- Owner-approved. 0206 removed the 14 polluted post_media rows, which was correct
-- and complete for that table, but it could not fix the rendering: the client
-- reads `posts.media_urls` (POST_COLUMNS, routes/posts.ts:223), not post_media,
-- and 7 of these 21 posts have no post_media row at all. Measured after 0206:
-- 21 media_urls entries on these posts, all 21 pointing at objects that do not
-- exist. Deleting the posts is the approved remedy over clearing media_urls.
--
-- BACKED UP FIRST: recovery-backups/2026-08-10-seed-post-21-cascade/
--   backup_posts.json             21 posts, full rows
--   backup_cascade_children.json  the 501 rows CASCADE removes, keyed by table
--   will_orphan_not_deleted.json  rows that do NOT cascade, recorded not deleted
--   MANIFEST.md                   the measurement below, and restore order
-- The 2026-08-09 artifact is untouched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CASCADE MEASURED BEFORE DELETING — 17 FK children (15 CASCADE, 2 SET NULL,
-- 0 RESTRICT)
-- ─────────────────────────────────────────────────────────────────────────────
--   posts_likes                            CASCADE   252
--   post_saves                             CASCADE   122
--   posts_comments                         CASCADE   103
--   passport_postcards                     CASCADE    21
--   post_reactions                         CASCADE     3
--   10 other CASCADE children              CASCADE     0
--   live_place_recap_sources               SET NULL    0
--   shared_moment_contributions            SET NULL    0
--   ------------------------------------------------------
--   TOTAL DELETED BY CASCADE                          501
--
-- Last time this operation took 7 rows nobody had counted. This time they were
-- counted first, and all 501 are in the backup.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO-FK REFERENCES — these do NOT cascade and ARE silently orphaned
-- ─────────────────────────────────────────────────────────────────────────────
--   rank_events.item_id                     18404   (OUT OF SCOPE, untouched)
--   content_stamps.entity_id                  252
--   compass_recommendation_scores.item_id      99
--   trip_plan_items.source_id                   1
--   ------------------------------------------------------
--   TOTAL ORPHANED                          18756
--
-- 32 post_id-shaped columns were swept. Two notes:
--   * `reviews` cannot reference posts at all — its review_entity_type enum is
--     (trip, rent_buddy_booking, place). Checked rather than left unknown.
--   * `trip_plan_items` row 68c2a847 is a MIS-TYPED reference: source_type='place'
--     but its source_id exists in posts and not in places. It was already
--     pointing at the wrong kind of thing; this delete makes it dangle.
--
-- rank_events is deliberately NOT touched. Its impact on the ranking corpus is
-- recorded in docs/algorithm/rank-events-signal-gaps.md.
--
-- Re-running is safe: deleting by id a second time affects 0 rows, and the guard
-- passes trivially once the rows are gone.

BEGIN;

-- Refuse to delete if any targeted post no longer matches what was audited.
-- Named per-post rather than counted, so a failure says WHICH post moved.
DO $guard$
DECLARE
  r record;
  v_bad int := 0;
BEGIN
  FOR r IN
    SELECT p.id::text AS id,
           (substring(p.id::text, 15, 1) = '5')                              AS is_v5,
           (p.source = 'seed_script')                                        AS is_seed,
           (p.author_id = '92602b6c-0eca-433d-9ee2-a82696b3837f')            AS is_owner
      FROM posts p
     WHERE p.id IN (
       '71703437-ea64-583d-a35d-b01d4dee9a96','64e34efe-fda8-507e-aa63-6e6d5b99623f',
       'b53cdea6-ac35-543f-87cf-4c446cec09d5','0188021a-1980-5e5a-a199-ff21e4301dd2',
       '60f39fe7-e995-5d12-958d-ea2e52b8f277','534778d4-b32d-59a0-a2ca-b8a5e990f0c0',
       '72a051b3-76f7-57da-8801-5f0365915bf8','84b5714e-6099-50af-b559-fdee9e3fa59f',
       'e6b991a0-4a0f-5909-93a4-ef74531ffacd','2b9e4314-1359-5017-beec-5a954cf98055',
       '3e66bf36-a29b-5016-9997-3e679621e6ca','58ea6504-4f76-5161-9a1d-95c7792738db',
       '2b3c2d5e-ed0c-55c7-a392-a2313e34a0ef','a99309a0-5d63-5ba1-b407-50c0d06003cb',
       'abacd1c7-1a54-5d9e-a615-a1a09748791e','7bbe4b1a-8cb5-5ea7-a69d-9d83929877ff',
       '2b6eb663-52c4-5e3f-a9aa-0e4b8f51c77f','615cf1ca-0184-5e93-8212-745819ac2bd9',
       'bf8ef8a3-a062-5eb3-ae74-4944cf6777df','8efd5605-0661-532e-93b4-c783c2ac3e1c',
       'e6cfd3b5-9f29-5a6e-8781-de905a4f698c')
  LOOP
    IF NOT (r.is_v5 AND r.is_seed AND r.is_owner) THEN
      v_bad := v_bad + 1;
      RAISE WARNING 'post % fails a check (v5=% seed=% owner=%) — SKIPPING NOTHING, aborting whole delete',
        r.id, r.is_v5, r.is_seed, r.is_owner;
    END IF;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION '% of the 21 posts no longer match the audited state', v_bad
      USING HINT = 'See the WARNINGs above for which. Re-audit before deleting.';
  END IF;
END
$guard$;

DELETE FROM posts WHERE id IN (
  '71703437-ea64-583d-a35d-b01d4dee9a96','64e34efe-fda8-507e-aa63-6e6d5b99623f',
  'b53cdea6-ac35-543f-87cf-4c446cec09d5','0188021a-1980-5e5a-a199-ff21e4301dd2',
  '60f39fe7-e995-5d12-958d-ea2e52b8f277','534778d4-b32d-59a0-a2ca-b8a5e990f0c0',
  '72a051b3-76f7-57da-8801-5f0365915bf8','84b5714e-6099-50af-b559-fdee9e3fa59f',
  'e6b991a0-4a0f-5909-93a4-ef74531ffacd','2b9e4314-1359-5017-beec-5a954cf98055',
  '3e66bf36-a29b-5016-9997-3e679621e6ca','58ea6504-4f76-5161-9a1d-95c7792738db',
  '2b3c2d5e-ed0c-55c7-a392-a2313e34a0ef','a99309a0-5d63-5ba1-b407-50c0d06003cb',
  'abacd1c7-1a54-5d9e-a615-a1a09748791e','7bbe4b1a-8cb5-5ea7-a69d-9d83929877ff',
  '2b6eb663-52c4-5e3f-a9aa-0e4b8f51c77f','615cf1ca-0184-5e93-8212-745819ac2bd9',
  'bf8ef8a3-a062-5eb3-ae74-4944cf6777df','8efd5605-0661-532e-93b4-c783c2ac3e1c',
  'e6cfd3b5-9f29-5a6e-8781-de905a4f698c');

COMMIT;
