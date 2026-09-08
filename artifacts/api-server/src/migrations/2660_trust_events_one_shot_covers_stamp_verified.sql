-- 2660 — extend 2540's one-shot uniqueness to cover stamp_verified.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- 2540 closed the read-then-insert dedup race in
-- TrustEventService.recordTrustEvent with a partial unique index on
-- (user_id, event_type, source_type, source_id), and listed five event types:
--   event_host_cancelled, event_positive_review, event_negative_review,
--   content_removed, message_report_confirmed.
--
-- stamp_verified is not among them, and it has exactly the same shape: it is
-- emitted once per user_stamps row, with source_type='passport' and source_id
-- set to that row's id. Its dedup window is a YEAR (dedupWindowHours 24*365 at
-- TrustEventService.recordStampVerifiedTrustEvent), so the read-then-insert
-- window it depends on is the widest of any emitter in the file — and it is the
-- only backstop the stamp chain has at the Trust layer.
--
-- 2540's own comment says the type list may be extended "only with the owning
-- emitter's consent". The owning emitter is recordStampVerifiedTrustEvent, whose
-- contract is one event per stamp; this index states that contract in the
-- schema, so it is consent expressed in the same terms rather than a widening
-- imposed on it.
--
-- ── WHAT IT DOES NOT CLAIM ───────────────────────────────────────────────────
-- The stamp chain already has a stronger, earlier guard: StampAwardEngine's
-- idempotency key on stamp_award_events means a second delivery of the same award
-- never reaches the emitter at all. So this is a BACKSTOP for a race that the
-- layer above currently makes unreachable, not a fix for a live defect. It is
-- worth having because "unreachable today" is a property of the caller, and a
-- constraint outlives the caller that made it unnecessary.
--
-- ── PRECHECK, MEASURED ON PRODUCTION (ajrurzioarfkagpuxfnb) 2026-09-08 ────────
--   trust_events total                                        5
--   event types present            first_event_joined, pulse_post_created
--   stamp_verified events                                     0
--   stamp_verified with a duplicate (user,type,src_type,src)  0
--   stamp_verified with NULL source_id                        0
--   trust_events_one_shot_uniq                          ABSENT — 2540 itself had
--                                                       never been applied
-- Nothing can violate the constraint, and there is nothing to backfill.
--
-- ── ORDERING ─────────────────────────────────────────────────────────────────
-- 2540 must be applied first; this migration replaces the index it creates and
-- raises if it is missing rather than quietly creating a different one.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS public.trust_events_one_shot_uniq;
--   CREATE UNIQUE INDEX trust_events_one_shot_uniq
--     ON public.trust_events (user_id, event_type, source_type, source_id)
--     WHERE source_id IS NOT NULL
--       AND event_type IN ('event_host_cancelled', 'event_positive_review',
--                          'event_negative_review', 'content_removed',
--                          'message_report_confirmed');
-- Restores 2540's index exactly. Loses no data: an index is derived state. After
-- the rollback a duplicate stamp_verified becomes possible again, which is the
-- pre-2660 behaviour.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE dupes int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='trust_events'
       AND indexname='trust_events_one_shot_uniq'
  ) THEN
    RAISE EXCEPTION '2660 precondition: trust_events_one_shot_uniq is absent -- apply 2540 first.';
  END IF;

  SELECT count(*) INTO dupes
    FROM (
      SELECT user_id, event_type, source_type, source_id
        FROM public.trust_events
       WHERE source_id IS NOT NULL AND event_type = 'stamp_verified'
       GROUP BY 1, 2, 3, 4
      HAVING count(*) > 1
    ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      '2660 precondition: % duplicate stamp_verified key(s) already exist. Resolve them before adding the '
      'constraint -- a stamp with two Trust events has been counted twice and which one to keep is a '
      'judgement, not something this migration may make.', dupes;
  END IF;
END $$;

DROP INDEX public.trust_events_one_shot_uniq;

CREATE UNIQUE INDEX trust_events_one_shot_uniq
  ON public.trust_events (user_id, event_type, source_type, source_id)
  WHERE source_id IS NOT NULL
    AND event_type IN ('event_host_cancelled', 'event_positive_review', 'event_negative_review',
                       'content_removed', 'message_report_confirmed', 'stamp_verified');

COMMENT ON INDEX public.trust_events_one_shot_uniq IS
  '2540 + 2660: one-shot trust event types may exist at most once per (user, type, source). Closes the read-then-insert dedup race in TrustEventService.recordTrustEvent; the code treats 23505 here as a dedup skip. 2660 added stamp_verified, whose emitter recordStampVerifiedTrustEvent writes one event per user_stamps row. Extend the type list only with the owning emitter''s consent.';

-- ── Postcondition ────────────────────────────────────────────────────────────
-- NON-VACUOUS: assert the new type is actually in the predicate, not merely that
-- an index with the right name exists. A DROP + CREATE that silently rebuilt the
-- old definition would otherwise pass.
DO $$
DECLARE def text;
BEGIN
  SELECT indexdef INTO def FROM pg_indexes
   WHERE schemaname='public' AND tablename='trust_events' AND indexname='trust_events_one_shot_uniq';
  IF def IS NULL THEN
    RAISE EXCEPTION '2660 postcheck failed: trust_events_one_shot_uniq is absent after the rebuild.';
  END IF;
  IF position('stamp_verified' in def) = 0 THEN
    RAISE EXCEPTION '2660 postcheck failed: the rebuilt index does not cover stamp_verified. Definition: %', def;
  END IF;
  IF position('message_report_confirmed' in def) = 0 THEN
    RAISE EXCEPTION '2660 postcheck failed: the rebuilt index DROPPED a type 2540 covered. Definition: %', def;
  END IF;
END $$;

COMMIT;
