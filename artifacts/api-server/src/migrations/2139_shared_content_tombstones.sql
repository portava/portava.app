-- 2139_shared_content_tombstones.sql
-- The 18 CASCADE edges that would delete other people's records on convergence.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Second prerequisite for 2136, whose third precondition refuses until this lands.
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
-- 2138 removed the 61 edges that would REJECT a cascading delete. That made
-- deletion complete. It did not make it correct, because 168 other edges point
-- at profiles with ON DELETE CASCADE — and those do not reject a delete, they
-- perform one. Eighteen of them delete rows that belong to, or are shared with,
-- somebody other than the departing user.
--
-- Proven on CI before this file was written. A thread holding one message from
-- the departing user and one reply from a bystander:
--
--     messages before = 2      messages after = 1
--
-- The bystander kept a reply to a message that no longer existed. Ruling 3
-- names this case in as many words: content is deletable "unless retaining a
-- minimal tombstone is required to preserve another user's conversation or
-- transaction integrity."
--
-- ── THE THREE OUTCOMES, AND WHY EACH ROW GETS THE ONE IT GETS ───────────────
--
-- TOMBSTONE (SET NULL) — the record exists for someone else's sake. Deleting it
-- would edit their conversation, their trip, or the event they are attending.
-- The record survives; the departed person's name comes off it.
--     messages.sender_id            a conversation has two sides
--     event_updates.author_id       attendees read these
--     highlight_replies.replier_id  a reply on someone else's highlight
--     trips.owner_id                co-travellers keep the itinerary
--     trip_notes.author_id          notes inside a shared trip
--     events.host_id                attendees keep the event
--     circles.owner_id              members keep the circle
--     meetups.creator_id            attendees keep the meetup
--
-- SEVER (SET NULL) — ruling 2: the contribution is community intelligence, the
-- contributor is not. Same mechanism, different reason: nobody is harmed by
-- losing the record, but the network is poorer without the fact.
--     live_place_recaps.owner_id
--     local_guide_contributions.guide_id
--     event_reviews.reviewer_id
--     shared_moment_contributions.contributor_id
--     discovery_place_reports.reporter_id   (ruling 4 — a moderation report)
--
-- ERASE (CASCADE) — the row is the departing person's own, and nobody else
-- reads it. Ruling 1's default.
--     saved_messages.user_id           their own saved items
--     message_translations.recipient_id  rendered for them, meaningless without
--     posts.author_id                  see the note below
--     message_thread_members.user_id   see the note below
--
-- ── TWO ENTRIES THAT DESERVE MORE THAN A LINE ──────────────────────────────
--
-- message_thread_members.user_id is CASCADE because it CANNOT be anything else:
-- the column sits in the table's primary key, so it may not be nulled — the same
-- wall user_deletion_requests hit. It is also the right answer. A membership row
-- keyed by (thread, user) has no meaning once the user is gone, and the thread
-- and its messages survive independently.
--
-- posts.author_id stays CASCADE, and this is the one judgement call in the file.
-- Ruling 3 makes posts deletable with the account, and executeAccountDeletion
-- ALREADY deletes them explicitly in step 2 — so CASCADE matches the behaviour
-- the owner can see today rather than quietly changing it. But a post can carry
-- other people's comments and reactions, which go with it. If posts should
-- instead tombstone, that is a product decision and it should be made
-- deliberately, not inherited from a foreign-key default. Flagged, not decided.
--
-- trip_documents.creator_id is SET NULL provisionally: its table is still
-- escalated to the owner. SET NULL destroys nothing and can still be tightened;
-- CASCADE could not be undone.
--
-- ── CLIENT IMPACT ───────────────────────────────────────────────────────────
-- 14 columns become nullable. A message with no sender, a trip with no owner and
-- an event with no host will all start appearing once deletions run. Every
-- surface that renders an author must tolerate an absent one — and note that
-- after convergence the profiles tombstone is GONE too, so "Deleted User" cannot
-- be resolved by joining profiles. The absent author has to be handled at the
-- surface, not looked up.
--
-- RUNTIME EFFECT BEFORE A DELETION RUNS: none.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
END $$;

DO $$
DECLARE
  r record;
  applied int := 0;
  skipped int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('messages','sender_id','SETNULL'),
      ('event_updates','author_id','SETNULL'),
      ('highlight_replies','replier_id','SETNULL'),
      ('trips','owner_id','SETNULL'),
      ('trip_notes','author_id','SETNULL'),
      ('events','host_id','SETNULL'),
      ('circles','owner_id','SETNULL'),
      ('meetups','creator_id','SETNULL'),
      ('live_place_recaps','owner_id','SETNULL'),
      ('local_guide_contributions','guide_id','SETNULL'),
      ('event_reviews','reviewer_id','SETNULL'),
      ('shared_moment_contributions','contributor_id','SETNULL'),
      ('discovery_place_reports','reporter_id','SETNULL'),
      ('trip_documents','creator_id','SETNULL'),
      ('saved_messages','user_id','CASCADE'),
      ('message_translations','recipient_id','CASCADE'),
      ('posts','author_id','CASCADE'),
      ('message_thread_members','user_id','CASCADE')
    ) AS t(tbl, col, action)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    IF r.action = 'SETNULL' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', r.tbl, r.col);
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   r.tbl, r.tbl || '_' || r.col || '_fkey');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE %s',
      r.tbl, r.tbl || '_' || r.col || '_fkey', r.col,
      CASE r.action WHEN 'CASCADE' THEN 'CASCADE' ELSE 'SET NULL' END);

    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'shared-content tombstones: % edge(s) set, % skipped', applied, skipped;
END $$;

COMMENT ON COLUMN public.messages.sender_id IS
  'NULL once the sender deletes their account. The message stays so the other side of the conversation is not edited by someone else''s deletion (owner ruling 3, 2026-08-23). Surfaces must render an absent sender without looking one up — after convergence there is no profiles tombstone to join.';
COMMENT ON COLUMN public.trips.owner_id IS
  'NULL once the owner deletes their account. The trip survives for its other members.';
COMMENT ON COLUMN public.events.host_id IS
  'NULL once the host deletes their account. The event survives for its attendees.';

-- ── Postcondition: 2136's third gate must now be satisfiable ───────────────
DO $$
DECLARE
  remaining int;
  sample text;
BEGIN
  SELECT count(*), string_agg(format('%s.%s', c.conrelid::regclass::text, a.attname), ', ')
    INTO remaining, sample
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
     AND c.confrelid = 'public.profiles'::regclass
     AND c.confdeltype = 'c'
     -- The four deliberate CASCADEs are excluded: saved_messages,
     -- message_translations, posts and message_thread_members. Everything else
     -- in the shared-content set must have moved to SET NULL.
     AND c.conrelid::regclass::text IN (
       'messages','message_threads','event_updates','event_reviews','highlight_replies',
       'shared_moment_contributions','live_place_recaps','local_guide_contributions',
       'discovery_place_reports','hidden_gems',
       'trips','trip_notes','trip_documents','events','circles','meetups'
     );
  IF remaining > 0 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: % shared-content edge(s) still cascade: %', remaining, left(sample, 300);
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Restoring CASCADE re-arms the behaviour that deletes one side of a
-- conversation. Re-adding NOT NULL to the 14 widened columns is only possible
-- while no row has been tombstoned.
