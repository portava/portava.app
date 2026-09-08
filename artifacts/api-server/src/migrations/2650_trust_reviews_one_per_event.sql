-- 2650 — one trust review per trust event, enforced by the database.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- A serious/severe trust event is written with status='pending_review' and then
-- QUEUED for an admin by inserting a `trust_reviews` row keyed on
-- source_event_id. That queue insert is deliberately non-fatal: the event is the
-- record of the finding and is already committed, so a failed queue insert
-- delays adjudication rather than losing evidence.
--
-- Non-fatal means the delivery is AT-LEAST-ONCE at best: today it is at-MOST-once,
-- because nothing retries it. A repair sweep is what makes it at-least-once — and
-- an at-least-once repair without a uniqueness backstop produces a
-- MORE-THAN-ONCE effect: the same finding queued twice, adjudicated twice, and
-- (through TrustAdminService.confirmEvent / dismissEvent, which close
-- `trust_reviews WHERE source_event_id = :id`) closed by a statement that already
-- assumes at most one row.
--
-- So the invariant the code has always assumed is written down where it is
-- actually enforced. TrustEventService's own comment states it — "One review per
-- event, keyed by source_event_id" — and this index is that sentence in the
-- schema. With it, the sweep can INSERT unconditionally and read 23505 as
-- "already queued", which is exactly-once effect from at-least-once delivery.
--
-- ── PARTIAL, ON PURPOSE ──────────────────────────────────────────────────────
-- Only rows that name an event are constrained. `trust_reviews` also holds
-- reviews with no source_event_id (review_type other than 'event_review'), and
-- many of those must be allowed to coexist. A plain UNIQUE would treat NULLs as
-- distinct in Postgres and so would also work, but the partial form says the
-- intent out loud and cannot be changed by a future NULLS NOT DISTINCT default.
--
-- ── PRECHECK, MEASURED ON PRODUCTION (ajrurzioarfkagpuxfnb) 2026-09-08 ────────
--   trust_reviews rows                                   0
--   rows sharing a source_event_id (would block this)    0
--   trust_events                                         5, all status='applied'
--   trust_events pending_review with no review row       0
--   existing indexes    trust_reviews_pkey, trust_reviews_open_idx,
--                       trust_reviews_user_idx  — no uniqueness on source_event_id
-- There is nothing to backfill and nothing that can violate the constraint.
--
-- ── NON-VACUITY ──────────────────────────────────────────────────────────────
-- The index does not exist. The postcheck below asserts it does afterwards, so a
-- run that changed nothing fails instead of reporting success.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS public.trust_reviews_source_event_unique;
-- Loses no data: an index is derived state. After the rollback a duplicate
-- review becomes possible again, which is the pre-2650 behaviour.

CREATE UNIQUE INDEX IF NOT EXISTS trust_reviews_source_event_unique
  ON public.trust_reviews (source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Postcheck: fail loudly rather than report a silent no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'trust_reviews'
      AND indexname  = 'trust_reviews_source_event_unique'
  ) THEN
    RAISE EXCEPTION '2650 postcheck failed: trust_reviews_source_event_unique was not created';
  END IF;
END $$;
