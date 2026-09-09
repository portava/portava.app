-- 2720_highlight_resurfacing_preferences.sql
--
-- WHAT: one new table, public.highlight_resurfacing_preferences, holding the
-- six §11 user controls as (owner_id, control, subject_type, subject_id) rows.
-- No column is added to any existing table; nothing is dropped; no existing
-- policy is altered. RLS on, owner-scoped, four policies.
--
-- WHY. Highlights/Memories Development Architecture Spec v1 §11 names six user
-- controls:
--
--     DO_NOT_RESURFACE            DO_NOT_INCLUDE_IN_RECAPS
--     HIDE_PERSON_FROM_RESURFACING HIDE_TRIP
--     KEEP_PRIVATE_FOREVER        RETAIN_BUT_DO_NOT_PERSONALIZE
--
-- and §3.6 names the table for them, `memory_resurfacing_preferences`. §21 then
-- insists that "delete, archive, do-not-resurface, and 'keep but do not
-- personalize' are different operations and must remain SEPARATE in both data
-- model and UX".
--
-- WHAT WAS MEASURED BEFORE WRITING THIS.
--
--   * Nothing on the Highlights surface implements ANY of the six. Grepped the
--     whole repository for each control name: zero hits outside the spec text,
--     the census, and the TypeScript added alongside this migration.
--
--   * The nearest existing artifact is `memory_feedback` (migration 2183),
--     kinds `hide` / `forget`, which suppresses MEMORY PROJECTIONS, not
--     Memories and not Highlights. `compass/MemoryRecapsService.ts` reuses that
--     same suppression set for recaps, so DO_NOT_RESURFACE and
--     DO_NOT_INCLUDE_IN_RECAPS are ONE control there, not two — census H87/H88.
--     This table does not touch `memory_feedback` and does not migrate it; the
--     projection family belongs to another surface and merging the two
--     vocabularies is not this migration's business.
--
--   * `memory_projections.state = 'hidden'` hides AND de-personalises in one
--     value (census H92). That is precisely the collapse §21 forbids, and it is
--     why `control` here is a discrete value with a CHECK rather than a
--     boolean pair or a bitmask: two rows, two controls, no shared spelling.
--
--   * public.highlights holds 23 rows on production (ajrurzioarfkagpuxfnb,
--     measured 2026-09-07 and recorded in migration 2339's header). This table
--     starts empty, so applying it changes nothing anyone can see.
--
-- WHY subject_type / subject_id RATHER THAN A NULLABLE COLUMN PER SCOPE. The
-- six controls have four different scopes — a Highlight, a person, a trip, and
-- (for a future owner-wide switch) the owner. Four nullable FK columns with a
-- CHECK that exactly one is set is the alternative, and it is worse here for
-- one specific reason: `subject_id` may legitimately reference a row in a table
-- this migration must not depend on (trips, profiles) or one that does not
-- exist yet (memories/episodes, §3.6). A text subject_id with a declared
-- subject_type keeps the control table honest about being a POLICY table rather
-- than a graph edge, and the CHECK below still pins the pairing so a HIDE_TRIP
-- row cannot claim subject_type='highlight'.
--
-- READ-SIDE CONTRACT, WHICH IS THE POINT OF THE TABLE.
-- services/highlights/highlightResurfacing.ts reads this table and returns a
-- THREE-state result:
--     ready      the table answered. Enforce exactly what it holds.
--     absent     the table does not exist (this migration is not applied).
--                Report, log, DO NOT enforce — otherwise every deployment that
--                has not run this migration goes dark.
--     unreadable the read failed. SUPPRESS EVERYTHING. supabase-js RESOLVES on
--                a database error, so an unbound `.error` would turn an outage
--                into "nobody suppressed anything", which on this surface means
--                resurfacing a Memory somebody asked never to see again.
-- Applying this migration flips that code from `absent` to `ready`; with zero
-- rows the enforced answer is identical to the unenforced one.
--
-- REVERSIBLE BY:
--   DROP TABLE IF EXISTS public.highlight_resurfacing_preferences;
-- The read code returns to `absent` and the surface behaves exactly as it does
-- before this migration is applied. No other object is touched, so there is
-- nothing else to undo.
--
-- NOT APPLIED BY THIS LANE. Written only.

CREATE TABLE IF NOT EXISTS public.highlight_resurfacing_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  control       TEXT NOT NULL
                  CHECK (control IN (
                    'DO_NOT_RESURFACE',
                    'DO_NOT_INCLUDE_IN_RECAPS',
                    'HIDE_PERSON_FROM_RESURFACING',
                    'HIDE_TRIP',
                    'KEEP_PRIVATE_FOREVER',
                    'RETAIN_BUT_DO_NOT_PERSONALIZE'
                  )),
  subject_type  TEXT NOT NULL
                  CHECK (subject_type IN ('highlight', 'person', 'trip', 'owner')),
  subject_id    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Each control has exactly one legal scope. Without this a HIDE_TRIP row
  -- could carry subject_type='highlight' and the read code would key it under
  -- a highlight id that is really a trip id, silently suppressing nothing.
  CONSTRAINT highlight_resurfacing_scope_matches_control CHECK (
    (control IN ('DO_NOT_RESURFACE', 'DO_NOT_INCLUDE_IN_RECAPS',
                 'KEEP_PRIVATE_FOREVER', 'RETAIN_BUT_DO_NOT_PERSONALIZE')
       AND subject_type = 'highlight')
    OR (control = 'HIDE_PERSON_FROM_RESURFACING' AND subject_type = 'person')
    OR (control = 'HIDE_TRIP' AND subject_type = 'trip')
  )
);

-- One row per (owner, control, subject). Setting the same control twice is the
-- same control, not two.
CREATE UNIQUE INDEX IF NOT EXISTS highlight_resurfacing_unique_idx
  ON public.highlight_resurfacing_preferences (owner_id, control, subject_type, subject_id);

-- The read path is "every control this owner has set", which is the batch form
-- used by the feeds.
CREATE INDEX IF NOT EXISTS highlight_resurfacing_owner_idx
  ON public.highlight_resurfacing_preferences (owner_id);

ALTER TABLE public.highlight_resurfacing_preferences ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs. §23: "Owner-only access to canonical private
-- Memory facts by default." A resurfacing preference is a statement about what
-- its owner does not want to see; nobody else has any business reading it, and
-- in particular the PERSON hidden by a HIDE_PERSON_FROM_RESURFACING row must
-- not be able to learn that they were hidden.
-- DROP POLICY IF EXISTS before each CREATE POLICY, added 2026-09-09. The
-- policies below already exist on portava-ci: this file was applied there by
-- hand, from an unmerged branch, with no ledger row — so the first run of the
-- sanctioned applier that reached it died on
--   ERROR: 42710: policy "highlight_resurfacing_select_own" for table "highlight_resurfacing_preferences" already exists
-- and stopped the 20 migrations behind it. A migration that cannot be re-run
-- against a database that already has its objects is not deployable twice, and
-- "twice" includes "once on CI and once on production". DROP-then-CREATE inside
-- the file's own transaction is this repo's existing convention (2335).
DROP POLICY IF EXISTS highlight_resurfacing_select_own ON public.highlight_resurfacing_preferences;
CREATE POLICY highlight_resurfacing_select_own
  ON public.highlight_resurfacing_preferences
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS highlight_resurfacing_insert_own ON public.highlight_resurfacing_preferences;
CREATE POLICY highlight_resurfacing_insert_own
  ON public.highlight_resurfacing_preferences
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS highlight_resurfacing_update_own ON public.highlight_resurfacing_preferences;
CREATE POLICY highlight_resurfacing_update_own
  ON public.highlight_resurfacing_preferences
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS highlight_resurfacing_delete_own ON public.highlight_resurfacing_preferences;
CREATE POLICY highlight_resurfacing_delete_own
  ON public.highlight_resurfacing_preferences
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

COMMENT ON TABLE public.highlight_resurfacing_preferences IS
  'Highlights/Memories spec v1 §11 user controls. One row per (owner, control, subject). '
  'Read by services/highlights/highlightResurfacing.ts, which fails CLOSED on an unreadable '
  'read and reports (does not enforce) an absent table.';
