\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users (id) VALUES
 ('11111111-1111-1111-1111-111111111111'),
 ('22222222-2222-2222-2222-222222222222');

INSERT INTO stories (id, owner_id, media_url, media_type, expires_at, state) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111',
  'post-media/stories/11111111-1111-1111-1111-111111111111/a.jpg','image', now() - interval '400 days','expired');
INSERT INTO story_views  (story_id, viewer_id) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','22222222-2222-2222-2222-222222222222');
INSERT INTO story_reactions (story_id, user_id, emoji) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','22222222-2222-2222-2222-222222222222','🔥');
INSERT INTO story_replies (story_id, user_id, message) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','22222222-2222-2222-2222-222222222222','hi');

-- The job's step 1: the ledger is written while the story still exists.
INSERT INTO story_purge_queue (story_id, owner_id, media_url, storage_bucket, storage_path, reason)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111',
        'post-media/stories/11111111-1111-1111-1111-111111111111/a.jpg','post-media',
        'stories/11111111-1111-1111-1111-111111111111/a.jpg','archive_expired');

-- The job's step 2: the row goes.
DELETE FROM stories WHERE id='aaaaaaaa-0000-0000-0000-00000000000a';

DO $$ DECLARE n int; p text; BEGIN
  SELECT count(*) INTO n FROM stories WHERE id='aaaaaaaa-0000-0000-0000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'R1 FAIL: the story row survived the purge'; END IF;
  RAISE NOTICE 'R1 pass: the story row is gone';

  SELECT count(*) INTO n FROM story_views WHERE story_id='aaaaaaaa-0000-0000-0000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'R2 FAIL: % viewer rows survived', n; END IF;
  SELECT count(*) INTO n FROM story_reactions WHERE story_id='aaaaaaaa-0000-0000-0000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'R2 FAIL: % reaction rows survived', n; END IF;
  SELECT count(*) INTO n FROM story_replies WHERE story_id='aaaaaaaa-0000-0000-0000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'R2 FAIL: % reply rows survived', n; END IF;
  RAISE NOTICE 'R2 pass: viewers, reactions and replies cascaded with the row';

  -- THE POINT OF THE LEDGER: it must still be here, still naming the object.
  SELECT storage_path INTO p FROM story_purge_queue WHERE story_id='aaaaaaaa-0000-0000-0000-00000000000a';
  IF p IS NULL THEN
    RAISE EXCEPTION 'R3 FAIL: the ledger entry vanished with the story — the object path is lost and the bytes are now unfindable';
  END IF;
  RAISE NOTICE 'R3 pass: the ledger outlived the row and still names %', p;
END $$;

-- R4: a cascading FK would have destroyed the ledger. Prove that, so R3 is not
-- a coincidence of this schema.
ALTER TABLE story_purge_queue
  ADD CONSTRAINT tmp_fk FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE NOT VALID;
INSERT INTO stories (id, owner_id, media_url, media_type, expires_at, state) VALUES
 ('bbbbbbbb-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','post-media/stories/x/b.jpg','image', now() - interval '400 days','expired');
INSERT INTO story_purge_queue (story_id, owner_id, media_url, storage_bucket, storage_path, reason)
VALUES ('bbbbbbbb-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','post-media/stories/x/b.jpg','post-media','stories/x/b.jpg','archive_expired');
DELETE FROM stories WHERE id='bbbbbbbb-0000-0000-0000-00000000000b';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM story_purge_queue WHERE story_id='bbbbbbbb-0000-0000-0000-00000000000b';
  IF n <> 0 THEN RAISE EXCEPTION 'R4 FAIL: the cascade did not fire, so R3 proves nothing'; END IF;
  RAISE NOTICE 'R4 pass: with a cascading FK the ledger IS destroyed — the absent FK is load-bearing';
END $$;
ROLLBACK;
