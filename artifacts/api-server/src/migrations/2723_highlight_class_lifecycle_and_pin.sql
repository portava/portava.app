-- 2723_highlight_class_lifecycle_and_pin.sql
--
-- WHAT: five nullable columns on public.highlights —
--   lifetime_class    §4 HighlightLifetime
--   lifecycle_state   §3.5 / §5 Highlight lifecycle
--   highlight_type    §3.5 highlight_type
--   pinned_at         §12 manual_pin
--   renderer_version  §3.5 renderer_version
-- plus one partial index for the pin read. No column is dropped, no column is
-- altered, no existing constraint or policy is touched, and every new column is
-- NULLABLE with no default, so no existing row changes and no existing INSERT
-- breaks.
--
-- WHY. Highlights/Memories Development Architecture Spec v1 §3.5 gives a
-- Highlight eleven fields; production's `highlights` holds three of them. §12
-- names five lifetime classes and states the ranking rule; §5 draws the
-- lifecycle. Census H94-H98 (the classes), H99 (ranking), H100 (pin) are all
-- NOT-BUILT, and the census's note on H99 is the whole problem in one line:
-- "routes/highlights.ts orders by created_at ascending. No score exists."
--
-- MEASURED BEFORE WRITING THIS (snapshot 20260908-production-schema.json):
--   public.highlights = id, owner_id, media_url, media_type,
--   video_duration_seconds, caption, location_name, location_city,
--   location_country, visibility, expires_at, created_at, deleted_at,
--   archived_at, filter_id, filter_intensity, updated_at.
--   No lifetime_class, no lifecycle_state, no highlight_type, no pin, no
--   ranking_score, no reason_codes, no presentation_json, no renderer_version.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION REFUSES TO DO, AND WHY EACH REFUSAL MATTERS
-- ══════════════════════════════════════════════════════════════════════════════
--
-- 1. IT DOES NOT MAKE `expires_at` NULLABLE, so PERMANENT stays unrepresentable.
--    A PERMANENT Highlight is one with no expiry. Production's expires_at is
--    NOT NULL (baseline/20260819_baseline_structure.sql:6774). Making it
--    nullable is exactly what unmerged PR #461 / migration 2313 does, and 2313
--    must not be adopted: applied unpatched it reintroduces a `trip_members`
--    self-join that applied migration 2530 removed, reopening a defect where
--    removed members and pending invitees could read trip-scoped Highlights.
--    Whether a Highlight may be permanent is an owner ruling attached to that
--    PR, not a column this migration may take on its own. So the CHECK below
--    admits 'PERMANENT' as a value — the enum is §4's, not a subset — and
--    `representableLifetimeClasses()` in
--    services/highlights/highlightLifecycle.ts REPORTS that production cannot
--    hold one, rather than the schema pretending it can.
--
-- 2. IT BACKFILLS NOTHING. Every existing Highlight gets NULL in all five
--    columns. It would be one UPDATE to bucket `expires_at - created_at` into
--    LIVE / DAY / TRIP, and it would be fabrication: §12 assigns no hour
--    boundaries to the classes, so those boundaries would be invented product
--    policy wearing the spec's vocabulary. §22 states the rule for exactly this
--    situation — "Unknowns remain null/unresolved until evidence supports
--    reconciliation." The read code reports `provenance: "unavailable"` for a
--    NULL class and never infers one from the expiry window.
--
-- 3. IT ADDS NO `ranking_score` COLUMN. §3.5 lists one, and a stored score is
--    the wrong shape here: of the six automatic factors §12 names, this
--    repository can measure exactly ONE honestly (recency, from created_at).
--    Persisting a number computed from one signal out of six would make an
--    unmeasured ranking look like a measured one, and the column would then be
--    read as authoritative. services/highlights/highlightRanking.ts computes
--    the score at read time and returns `factorsUsed` / `factorsMissing`
--    alongside it, so the caller can see the score was built from one factor.
--    When significance and presentation-quality engines exist, a persisted
--    score becomes worth storing and gets its own migration.
--
-- 4. `pinned_at` IS A TIMESTAMP, NOT A BOOLEAN OR AN INTEGER ORDER. §12:
--    "Pinned/manual order always outranks automatic ordering." A boolean
--    carries no order; an integer `pin_order` requires a renumber on every
--    insert and a uniqueness constraint nobody wants to fight. A timestamp
--    gives a total order for free (most recently pinned first, or oldest first
--    — the read code chooses and the column does not care) and answers "when
--    did they pin this" for the audit §28.15 asks for.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY EVERY COLUMN IS NULLABLE WITH NO DEFAULT
-- ══════════════════════════════════════════════════════════════════════════════
-- A DEFAULT on `lifecycle_state` would write a state onto 23 existing rows that
-- no state machine ever transitioned them into, and §5's machine has no entry
-- edge into ACTIVE except from DRAFT. NULL means "this row predates the column"
-- and the read code derives ACTIVE / EXPIRED / HIDDEN from expires_at,
-- archived_at and deleted_at with the derivation stated in the result
-- (`provenance: "derived"`), which is honest in a way a backfilled DEFAULT is
-- not.
--
-- NOTE ON THE INSERT PATH: routes/highlights.ts POST /highlights lists its
-- inserted columns explicitly and does not use `SELECT *`, so these columns are
-- simply not written by it. One unknown column fails a WHOLE PostgREST insert
-- (PGRST204), which is why adding columns here is safe and adding them to the
-- insert without applying this first would not be.
--
-- REVERSIBLE BY:
--   DROP INDEX IF EXISTS public.highlights_pinned_idx;
--   ALTER TABLE public.highlights
--     DROP COLUMN IF EXISTS lifetime_class,
--     DROP COLUMN IF EXISTS lifecycle_state,
--     DROP COLUMN IF EXISTS highlight_type,
--     DROP COLUMN IF EXISTS pinned_at,
--     DROP COLUMN IF EXISTS renderer_version;
-- Since nothing is backfilled and nothing writes these columns yet, the drop
-- loses no data that existed before this migration.
--
-- NOT APPLIED BY THIS LANE. Written only.

ALTER TABLE public.highlights
  ADD COLUMN IF NOT EXISTS lifetime_class   TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_state  TEXT,
  ADD COLUMN IF NOT EXISTS highlight_type   TEXT,
  ADD COLUMN IF NOT EXISTS pinned_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renderer_version TEXT;

-- §4 HighlightLifetime. NOT VALID is deliberate and is NOT laziness: the
-- constraint applies to every future write immediately, and skipping the
-- validation scan means no ACCESS EXCLUSIVE lock is held while `highlights` is
-- read. There is nothing to validate anyway — every existing row is NULL, which
-- a CHECK admits. VALIDATE CONSTRAINT can be run later at leisure if a reader
-- wants the catalog to say `validated`.
ALTER TABLE public.highlights
  ADD CONSTRAINT highlights_lifetime_class_check
  CHECK (lifetime_class IS NULL OR lifetime_class IN
         ('LIVE', 'DAY', 'TRIP', 'SEASONAL', 'PERMANENT'))
  NOT VALID;

-- §5 Highlight lifecycle states. DELETED is deliberately absent: §21's deletion
-- lifecycle (ACTIVE -> DELETION_REQUESTED -> ... -> DELETED) is a SEPARATE
-- machine, and `deleted_at` already carries it. Admitting 'DELETED' here would
-- be the same collapse §21 forbids, expressed as a CHECK.
ALTER TABLE public.highlights
  ADD CONSTRAINT highlights_lifecycle_state_check
  CHECK (lifecycle_state IS NULL OR lifecycle_state IN
         ('DRAFT', 'ACTIVE', 'EXPIRED', 'PINNED', 'HIDDEN'))
  NOT VALID;

-- §12: "Pinned/manual order always outranks automatic ordering." The read is
-- always "this owner's pinned Highlights", so the index is partial on the
-- pinned rows and excludes deleted ones, matching the existing
-- highlights_owner_active_idx convention from migration 0026.
CREATE INDEX IF NOT EXISTS highlights_pinned_idx
  ON public.highlights (owner_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN public.highlights.lifetime_class IS
  'Spec v1 §4 HighlightLifetime. NULL = unassigned; the read code reports it as unknown and '
  'NEVER infers a class from the expiry window. PERMANENT is admitted by the CHECK but is '
  'unrepresentable while expires_at is NOT NULL — see migration 2313 / PR #461, unadopted.';

COMMENT ON COLUMN public.highlights.lifecycle_state IS
  'Spec v1 §5 Highlight lifecycle. DELETED is NOT a value here: §21 deletion is a separate '
  'lifecycle carried by deleted_at. NULL = predates the column; the read code derives '
  'ACTIVE/EXPIRED/HIDDEN from expires_at, archived_at and deleted_at and says that it did.';

COMMENT ON COLUMN public.highlights.pinned_at IS
  'Spec v1 §12 manual_pin. A timestamp, not a boolean: the pin needs a total order, and the '
  'ranking implements "pinned always outranks automatic" as a PARTITION, not a weight.';
