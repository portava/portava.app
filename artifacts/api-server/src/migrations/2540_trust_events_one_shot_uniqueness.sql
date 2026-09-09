-- 2540_trust_events_one_shot_uniqueness.sql
--
-- A partial UNIQUE index on trust_events' dedup key, scoped to the event types
-- whose emitters are ONE-SHOT by construction. Closes the read-then-insert
-- race that code-side dedup cannot. No data change, no policy, no grant, no
-- flag, no reader.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2540
-- (Trust, 2540-2549).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases:
--
--                                              production        portava-ci
--   feature_flags.trust_engine_enabled         TRUE (2026-07-17) NO ROW (-> false)
--   trust_events rows                          5                 0
--   trust_events rows of the five types below  0                 0
--   UNIQUE constraint/index on the dedup key   NONE              NONE
--   trust_events_source_idx (non-unique)       present           present
--     btree (user_id, event_type, source_type, source_id) WHERE source_id IS NOT NULL
--
-- WHAT IS MISSING, AND WHY IT IS DECIDED HERE
-- ===========================================
-- TrustEventService.recordTrustEvent deduplicates by READING for an existing
-- (user_id, event_type, source_type, source_id) row inside a window and then
-- INSERTING. Between the read and the insert there is nothing: two concurrent
-- deliveries of the same trigger — a double-clicked admin button, a retried
-- request, two routes for one action — both read "new" and both insert, and
-- the scorer then counts one finding twice. The only index on that key is
-- non-unique, so the database cannot refuse the second row.
--
-- The previous Trust pass proposed this index and deliberately did not author
-- it, because WHICH types are one-shot is an emitter-side decision, and no
-- emitter of a declared type lived in a Trust-owned file. That has changed:
-- this pass wired five emitters (routes/events.ts, routes/admin.ts), and each
-- is one-shot by its own provenance rule:
--
--   event_host_cancelled      keyed on the EVENT id       — an event is cancelled once
--   event_positive_review     keyed on the event_reviews  — a review is one piece of
--   event_negative_review       row id                       evidence, edits do not re-emit
--   content_removed           keyed on the CONTENT id     — one removal per content item
--                               (avatar/cover: the audit row id — one per removal)
--   message_report_confirmed  keyed on the MESSAGE id     — two reports on one message
--                                                            confirm it once
--
-- Every other emitted type is LEFT OUT on purpose. gps_* keys carry a day
-- stamp and are meant to recur; checkin/gem types may legitimately repeat
-- outside their window; those decisions belong to the lanes that own the
-- emitters. Widening the WHERE clause is a one-line follow-up per type, and
-- must be made by that type's owner.
--
-- HOW THE CODE MEETS IT
-- =====================
-- recordTrustEvent treats a 23505 (unique_violation) on insert as a dedup
-- skip — the same fact as "a row with this key already exists" — rather than
-- throwing. Callers see `{ skipped: true, skipReason: "dedup" }` from either
-- path, so a race and a replay are indistinguishable from the emitter's point
-- of view, which is the point.
--
-- INERT BY CONSTRUCTION
-- =====================
-- Against the measured state (0 rows of these types in either database) the
-- index is created empty and constrains nothing that exists. Against future
-- rows it refuses exactly the second insert of a key the code already refuses
-- on read; nothing a user sees changes. A database WITHOUT this migration
-- behaves as today: the code-side dedup still runs, only the race stays open.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the table holds five rows in
-- production and CONCURRENTLY cannot run inside the transaction this file is
-- applied in. The lock is momentary at this scale.
--
-- PRECONDITION (checked, RAISEs only on violation): no existing rows of the
-- five types share a key — otherwise the index build itself would fail with
-- a less useful message.
-- POSTCONDITION (checked, RAISEs only on violation): the index exists, is
-- UNIQUE, and is partial.
--
-- ROLLBACK: db/rollback/2026-09-07-2540-trust-events-one-shot-uniqueness-rollback.sql

BEGIN;

-- ── Precondition ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  dupes int;
BEGIN
  SELECT count(*) INTO dupes
    FROM (
      SELECT user_id, event_type, source_type, source_id
        FROM public.trust_events
       WHERE source_id IS NOT NULL
         AND event_type IN ('event_host_cancelled', 'event_positive_review', 'event_negative_review',
                            'content_removed', 'message_report_confirmed')
       GROUP BY 1, 2, 3, 4
      HAVING count(*) > 1
    ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION '2540 precondition: % duplicate one-shot trust_events keys already exist — resolve them before applying', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_events_one_shot_uniq
  ON public.trust_events (user_id, event_type, source_type, source_id)
  WHERE source_id IS NOT NULL
    AND event_type IN ('event_host_cancelled', 'event_positive_review', 'event_negative_review',
                       'content_removed', 'message_report_confirmed');

COMMENT ON INDEX public.trust_events_one_shot_uniq IS
  '2540: one-shot trust event types may exist at most once per (user, type, source). Closes the read-then-insert dedup race in TrustEventService.recordTrustEvent; the code treats 23505 here as a dedup skip. Extend the type list only with the owning emitter''s consent.';

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'trust_events'
     AND indexname  = 'trust_events_one_shot_uniq'
     AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
     AND indexdef ILIKE '%WHERE%';
  IF n <> 1 THEN
    RAISE EXCEPTION '2540 postcondition: expected one partial UNIQUE index trust_events_one_shot_uniq, found %', n;
  END IF;
END $$;

COMMIT;
