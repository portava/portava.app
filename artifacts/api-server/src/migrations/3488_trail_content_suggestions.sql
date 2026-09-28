-- 3488_trail_content_suggestions.sql
-- A third party's Trail suggestion waits for the content's owner, and spends no
-- §4 budget until it is accepted (census-discovery §86, lane W10-T: DC-20;
-- §51.10 Q5, decided in the register as D-W10T-9).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-T owns
-- 3485-3494). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness (port 55457).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── THE RULE THIS HOLDS ─────────────────────────────────────────────────────
-- §51.6: "a third party's suggest consumes the content's §4 budget, so a
-- stranger can take a post's single primary slot." A suggestion by someone who
-- does not own the content is therefore NOT a `content_trails` row. It is a
-- pending row HERE, invisible to every Trail reader and to 2910/3380's cap, and
-- it becomes a membership (at the suggestion confidence) only when the
-- content's owner accepts it — the post's author, the event's host, the route's
-- owner, the community place's submitter, or for authorless content (a
-- canonical place) the Trail's creator. Accepting spends the owner's own budget
-- through the ordinary insert, so 3380's trigger still judges it.
--
-- A suggestion by the owner themself is a membership at once, as before.
--
-- Rollback: db/rollback/2026-09-28-3488-trail-content-suggestions-rollback.sql
-- (refuses while any pending suggestion exists; see there).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3488): public.trails (2910) and public.profiles are required.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.trail_content_suggestions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id      uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  source_type   text        NOT NULL,
  source_id     uuid        NOT NULL,
  relationship  text        NOT NULL,
  signal        text        NULL,
  suggested_by  uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Who may accept or decline: resolved at suggestion time from the content's
  -- own owner column (or the Trail's creator for authorless content).
  owner_id      uuid        NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  state         text        NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz NULL,
  CONSTRAINT tcs_source_type_known CHECK (source_type IN ('post', 'place', 'event', 'itinerary', 'route')),
  CONSTRAINT tcs_relationship_known CHECK (relationship IN ('primary', 'supporting', 'signal')),
  CONSTRAINT tcs_signal_vocabulary CHECK (
    (relationship = 'signal' AND signal IN ('luxury','solo_friendly','late_night','family','hidden_gem','rooftop','food','live_music'))
    OR (relationship <> 'signal' AND signal IS NULL)),
  CONSTRAINT tcs_state_known CHECK (state IN ('pending', 'accepted', 'declined')),
  CONSTRAINT tcs_decided_when_closed CHECK ((state = 'pending') = (decided_at IS NULL))
);
COMMENT ON TABLE public.trail_content_suggestions IS
  '3488 (census-discovery DC-20; 11 §3 "suggest Trail association"; 02 §4): a third party''s suggestion that someone else''s content belongs in a Trail. Pending rows are read by no Trail reader and are outside 3380''s cap; the content''s owner (owner_id) accepts one into content_trails or declines it.';
-- One OPEN suggestion per (Trail, content, label): a retry is a replay, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tcs_pending_label
  ON public.trail_content_suggestions (trail_id, source_type, source_id, relationship, COALESCE(signal, ''))
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tcs_owner_pending ON public.trail_content_suggestions (owner_id, created_at DESC) WHERE state = 'pending';

ALTER TABLE public.trail_content_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trail_content_suggestions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.trail_content_suggestions TO service_role;

DO $policies$
DECLARE v_op text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.trail_content_suggestions', format('trail_content_suggestions_deny_%s_clients', lower(v_op)));
    EXECUTE format('CREATE POLICY %I ON public.trail_content_suggestions AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('trail_content_suggestions_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
  END LOOP;
END
$policies$;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.trail_content_suggestions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3488): public.trail_content_suggestions was not created';
  END IF;
  IF has_table_privilege('authenticated', 'public.trail_content_suggestions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trail_content_suggestions', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3488): a client role can read or write suggestions';
  END IF;
END $post$;
