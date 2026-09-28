-- 3486_trail_moderation_audit.sql
-- Trails moderation and admin actions, each audited in the transaction that
-- makes the change (census-discovery §86, lane W10-T: DC-04, DV-24, DV-74).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-T owns
-- 3485-3494). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness (port 55457).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
-- `11` §8 names six Discovery admin actions and `11` §10 requires "admin
-- actions are audited". Three were built (drift diagnostics; creator fraud
-- holds and ledger audit, §52). This file builds the other three — Trail merge,
-- Trail archive, trend integrity review — plus `02` §15's other moderation
-- moves and §6's declared relationships, on §52's pattern: ONE function call is
-- ONE transaction that makes the change AND appends its audit row, or does
-- neither; a retried call with the same idempotency key is a replay, and a
-- replay whose request differs is refused as a conflict.
--
--   (1) public.discovery_admin_audit_events   append-only; RLS on, clients denied
--   (2) public.trails.merged_into_trail_id    where a merged Trail went (E-5)
--   (3) public.content_trails.content_state_changed_at, stamped by a trigger on
--       every §7 content-state change (DV-21's rediscovered horizon; §9 step 5)
--   (4) public.trail_edges.review_state / declared_by — a declared relationship
--       is navigable only once accepted (DV-24, §51.10 Q1)
--   (5) public.trend_integrity_reviews        `11` §8 "trend integrity review"
--   (6) the functions:
--         trail_admin_move_lifecycle   §15 "mark stale", needs_update, reactivate, and `11` §8 "Trail archive"
--         trail_admin_merge            §15 "merge duplicate Trails", `11` §8 "Trail merge" (E-5)
--         trail_admin_review_edge      §6's five declarable kinds, accepted or rejected by moderation
--         trend_integrity_review_record `11` §8 "trend integrity review"
--         trail_admin_curate           `02` §5's "Portava-curated catalog": the one writer of
--                                      source = 'curated', which Local Picks serves (DV-21)
--
-- Every function is SECURITY INVOKER with a pinned search_path (`10` §6) and is
-- executable by service_role ONLY, because each takes its actor as an argument;
-- the one caller is services/trails/trailAdmin.ts behind lib/requireAdmin.ts.
--
-- ── RUNTIME EFFECT ON EXISTING SURFACES ─────────────────────────────────────
-- None until an admin acts. Existing trail_edges rows take review_state
-- 'accepted' (every one was written by proposeTrail's `child` insert, which is
-- the proposer declaring their own sub-Trail). The columns are nullable or
-- constant-defaulted: catalogue-only in PostgreSQL 11+.
--
-- Rollback: db/rollback/2026-09-28-3486-trail-moderation-audit-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.content_trails') IS NULL
     OR to_regclass('public.trail_edges') IS NULL OR to_regclass('public.trail_follows') IS NULL
     OR to_regclass('public.trail_reports') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3486): 2910''s Trails tables are not all present.';
  END IF;
  IF to_regprocedure('public.trails_lifecycle_transition()') IS NULL
     OR to_regprocedure('public.content_trails_state_transition()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3486): 3381 (the §7 transition triggers) is not applied; every writer here relies on it.';
  END IF;
  IF to_regclass('public.discovery_admin_audit_events') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'discovery_admin_audit_events' AND column_name = 'idempotency_key') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3486): public.discovery_admin_audit_events exists and is not the table this file creates.';
  END IF;
END
$pre$;

-- ── (2)(3)(4) columns ────────────────────────────────────────────────────────
ALTER TABLE public.trails ADD COLUMN IF NOT EXISTS merged_into_trail_id uuid NULL
  REFERENCES public.trails(id) ON DELETE SET NULL;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trails'::regclass AND conname = 'trails_not_merged_into_self') THEN
    ALTER TABLE public.trails ADD CONSTRAINT trails_not_merged_into_self CHECK (merged_into_trail_id IS DISTINCT FROM id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trails'::regclass AND conname = 'trails_merged_is_archived') THEN
    ALTER TABLE public.trails ADD CONSTRAINT trails_merged_is_archived CHECK (merged_into_trail_id IS NULL OR lifecycle_status = 'archived');
  END IF;
END
$c$;
COMMENT ON COLUMN public.trails.merged_into_trail_id IS
  '3486 (census-discovery DV-74, E-5): the Trail this one was merged into by trail_admin_merge. Set only on an archived Trail. NULL for every Trail that was not merged.';

ALTER TABLE public.content_trails ADD COLUMN IF NOT EXISTS content_state_changed_at timestamptz NULL;
COMMENT ON COLUMN public.content_trails.content_state_changed_at IS
  '3486 (census-discovery DC-04/DV-21): when content_state last changed, stamped by content_trails_state_stamp_trg. NULL while a member is still in the state it was inserted with (its created_at is then the state''s start).';

ALTER TABLE public.trail_edges ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'accepted';
ALTER TABLE public.trail_edges ADD COLUMN IF NOT EXISTS declared_by uuid NULL;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trail_edges'::regclass AND conname = 'trail_edges_review_state_known') THEN
    ALTER TABLE public.trail_edges ADD CONSTRAINT trail_edges_review_state_known CHECK (review_state IN ('pending', 'accepted', 'rejected'));
  END IF;
END
$c$;
COMMENT ON COLUMN public.trail_edges.review_state IS
  '3486 (census-discovery DV-24, §51.10 Q1): pending | accepted | rejected. Only accepted is navigable (TrailService.relatedTrails). An owner of BOTH Trails declares accepted; an owner of one proposes pending; moderation accepts or rejects (trail_admin_review_edge, audited).';
COMMENT ON COLUMN public.trail_edges.declared_by IS
  '3486: the profile that declared the edge — an audit fact, deliberately not a foreign key (an erased account must not erase the relation it declared).';

CREATE OR REPLACE FUNCTION public.content_trails_state_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.content_state IS DISTINCT FROM OLD.content_state THEN
    NEW.content_state_changed_at := now();
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.content_trails_state_stamp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS content_trails_state_stamp_trg ON public.content_trails;
CREATE TRIGGER content_trails_state_stamp_trg
  BEFORE UPDATE OF content_state ON public.content_trails
  FOR EACH ROW EXECUTE FUNCTION public.content_trails_state_stamp();

-- ── (1) the audit table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discovery_admin_audit_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action           text        NOT NULL,
  subject_kind     text        NOT NULL,
  -- text, not uuid: a trend review's subject may be a served place id (db/<uuid>).
  subject_id       text        NOT NULL,
  related_id       text        NULL,
  -- An audit FACT, deliberately not a foreign key (as 3387's actor_user_id):
  -- an admin's own erasure must not erase the record of what they did.
  actor_user_id    uuid        NULL,
  reason           text        NOT NULL,
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daae_action_known CHECK (action IN (
    'trail_lifecycle', 'trail_merge', 'trail_edge_review', 'trend_integrity_review', 'trail_curate')),
  CONSTRAINT daae_subject_kind_known CHECK (subject_kind IN ('trail', 'trail_edge', 'place')),
  CONSTRAINT daae_reason_given CHECK (length(btrim(reason)) > 0),
  CONSTRAINT daae_idempotency_key_unique UNIQUE (idempotency_key)
);
COMMENT ON TABLE public.discovery_admin_audit_events IS
  '3486 (census-discovery DV-74; 11 §8, 11 §10 "admin actions are audited"): one append-only row per Trail lifecycle move, Trail merge, edge review or trend integrity review, written in the SAME transaction as the change by the trail_admin_* / trend_integrity_review_record functions. Carries the actor, the reason and what changed.';
CREATE INDEX IF NOT EXISTS idx_daae_subject ON public.discovery_admin_audit_events (subject_kind, subject_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.discovery_admin_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'discovery_admin_audit_events is append-only (%)', TG_OP USING ERRCODE = 'check_violation';
END;
$fn$;
REVOKE ALL ON FUNCTION public.discovery_admin_audit_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS daae_append_only ON public.discovery_admin_audit_events;
CREATE TRIGGER daae_append_only
  BEFORE UPDATE OR DELETE ON public.discovery_admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.discovery_admin_audit_append_only();

-- ── (5) trend integrity reviews ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trend_integrity_reviews (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind  text        NOT NULL,
  subject_id    text        NOT NULL,
  verdict       text        NOT NULL,
  -- What the reviewer saw (the admin diagnostic reading, `11` §4 permits raw
  -- numbers there), frozen with the verdict.
  evidence      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reason        text        NOT NULL,
  reviewed_by   uuid        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tir_subject_kind_known CHECK (subject_kind IN ('trail', 'place')),
  CONSTRAINT tir_verdict_known CHECK (verdict IN ('confirmed', 'suspect', 'suppressed', 'cleared')),
  CONSTRAINT tir_reason_given CHECK (length(btrim(reason)) > 0)
);
COMMENT ON TABLE public.trend_integrity_reviews IS
  '3486 (census-discovery DV-74; 11 §8 "trend integrity review"; 03 §12 anti-gaming): an admin verdict on one trend subject. The NEWEST row per (subject_kind, subject_id) is in force. suppressed = the subject''s trend is not published as trending (a Trail: GET …/trending answers false with no items); cleared lifts it; confirmed / suspect record a reading without changing what is served. Append-only.';
CREATE INDEX IF NOT EXISTS idx_tir_subject ON public.trend_integrity_reviews (subject_kind, subject_id, created_at DESC);
DROP TRIGGER IF EXISTS tir_append_only ON public.trend_integrity_reviews;
CREATE TRIGGER tir_append_only
  BEFORE UPDATE OR DELETE ON public.trend_integrity_reviews
  FOR EACH ROW EXECUTE FUNCTION public.discovery_admin_audit_append_only();

-- ── RLS: server-only, clients denied (3390's posture) ───────────────────────
ALTER TABLE public.discovery_admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trend_integrity_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_admin_audit_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.trend_integrity_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.discovery_admin_audit_events TO service_role;
GRANT SELECT, INSERT ON public.trend_integrity_reviews TO service_role;

DO $policies$
DECLARE v_op text; v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['discovery_admin_audit_events', 'trend_integrity_reviews'] LOOP
    FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', format('%s_deny_%s_clients', v_t, lower(v_op)), v_t);
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR %s TO anon, authenticated %s',
        format('%s_deny_%s_clients', v_t, lower(v_op)), v_t, v_op,
        CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                  WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                  ELSE 'USING (false)' END);
    END LOOP;
  END LOOP;
END
$policies$;

-- ── (6) the functions ────────────────────────────────────────────────────────

-- The replay rule, shared: a key already recorded answers `replayed` when the
-- request is the same one, and `conflict` when it is not.
CREATE OR REPLACE FUNCTION public.discovery_admin_replay(p_key text, p_action text, p_subject text, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE r record;
BEGIN
  SELECT action, subject_id, detail INTO r FROM public.discovery_admin_audit_events WHERE idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.action = p_action AND r.subject_id = p_subject AND (r.detail -> 'request') = p_request THEN
    RETURN jsonb_build_object('outcome', 'replayed', 'detail', r.detail);
  END IF;
  RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
END;
$fn$;
REVOKE ALL ON FUNCTION public.discovery_admin_replay(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_admin_replay(text, text, text, jsonb) TO service_role;

-- §15 moderation moves and `11` §8 "Trail archive". 3381's trigger is the
-- relation; this function adds the lock, the audit row and the replay rule.
CREATE OR REPLACE FUNCTION public.trail_admin_move_lifecycle(
  p_trail_id uuid, p_to text, p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_request jsonb := jsonb_build_object('to', p_to);
  v_replay jsonb;
  v_from text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reason_required');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'idempotency_key_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discovery_admin:' || p_idempotency_key, 0));
  v_replay := public.discovery_admin_replay(p_idempotency_key, 'trail_lifecycle', p_trail_id::text, v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT lifecycle_status INTO v_from FROM public.trails WHERE id = p_trail_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail'); END IF;
  IF p_to IS NULL OR p_to NOT IN ('proposed', 'active', 'needs_update', 'stale', 'archived') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_state');
  END IF;
  IF v_from = p_to THEN
    -- 3381 lets a same-state UPDATE through (it is not a transition); §7 refuses a no-op move.
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'no_op', 'from', v_from, 'to', p_to);
  END IF;
  BEGIN
    UPDATE public.trails SET lifecycle_status = p_to, updated_at = now() WHERE id = p_trail_id;
  EXCEPTION WHEN check_violation THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'transition_not_allowed', 'from', v_from, 'to', p_to);
  END;

  INSERT INTO public.discovery_admin_audit_events (action, subject_kind, subject_id, actor_user_id, reason, detail, idempotency_key)
  VALUES ('trail_lifecycle', 'trail', p_trail_id::text, p_actor, p_reason,
          jsonb_build_object('request', v_request, 'from', v_from, 'to', p_to), p_idempotency_key);
  RETURN jsonb_build_object('outcome', 'moved', 'from', v_from, 'to', p_to);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_admin_move_lifecycle(uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_admin_move_lifecycle(uuid, text, uuid, text, text) TO service_role;

-- `02` §15 "merge duplicate Trails" / `11` §8 "Trail merge" (E-5's semantics,
-- decided in the register, W10-T): the SOURCE Trail's members, followers,
-- relationships, children and open membership reports move to the TARGET; a
-- member whose content the target already holds is dropped (the target's label
-- stands, so §4's budget is never charged twice), and its open reports follow it
-- onto the target's row; the source's own Trail-level open reports are resolved
-- 'merged'; the source is archived with merged_into_trail_id set. Its health
-- snapshots stay with it as history. Nothing is deleted that is not re-homed.
CREATE OR REPLACE FUNCTION public.trail_admin_merge(
  p_from uuid, p_into uuid, p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_request jsonb := jsonb_build_object('into', p_into);
  v_replay jsonb;
  v_from_state text; v_into_state text;
  v_moved int := 0; v_dropped int := 0; v_follows int := 0; v_edges int := 0;
  v_children int := 0; v_reports_moved int := 0; v_reports_followed int := 0; v_reports_resolved int := 0;
  v_detail jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reason_required');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'idempotency_key_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discovery_admin:' || p_idempotency_key, 0));
  v_replay := public.discovery_admin_replay(p_idempotency_key, 'trail_merge', p_from::text, v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_from = p_into THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'same_trail'); END IF;

  -- Both rows locked, in id order, so two merges over one pair cannot deadlock.
  PERFORM 1 FROM public.trails WHERE id IN (p_from, p_into) ORDER BY id FOR UPDATE;
  SELECT lifecycle_status INTO v_from_state FROM public.trails WHERE id = p_from;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail'); END IF;
  SELECT lifecycle_status INTO v_into_state FROM public.trails WHERE id = p_into;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_target'); END IF;
  IF v_from_state = 'archived' THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'source_archived'); END IF;
  IF v_into_state = 'archived' THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'target_archived'); END IF;
  -- A target that descends from the source would become its own ancestor's parent.
  IF EXISTS (
    WITH RECURSIVE up(id, parent, depth) AS (
      SELECT id, parent_trail_id, 0 FROM public.trails WHERE id = p_into
      UNION ALL
      SELECT t.id, t.parent_trail_id, up.depth + 1 FROM public.trails t JOIN up ON t.id = up.parent WHERE up.depth < 64
    ) SELECT 1 FROM up WHERE parent = p_from
  ) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'target_descends_from_source');
  END IF;

  -- Members the target already holds (same content): their open reports move to
  -- the target's row for that content, then the duplicate is dropped.
  WITH dup AS (
    SELECT f.id AS from_row,
           (SELECT i.id FROM public.content_trails i
             WHERE i.trail_id = p_into AND i.source_type = f.source_type AND i.source_id = f.source_id
             ORDER BY i.id LIMIT 1) AS into_row
      FROM public.content_trails f
     WHERE f.trail_id = p_from
       AND EXISTS (SELECT 1 FROM public.content_trails i
                    WHERE i.trail_id = p_into AND i.source_type = f.source_type AND i.source_id = f.source_id)
  ), moved AS (
    UPDATE public.trail_reports r SET content_trail_id = dup.into_row, trail_id = p_into
      FROM dup WHERE r.content_trail_id = dup.from_row AND r.resolution IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_reports_moved FROM moved;

  WITH d AS (
    DELETE FROM public.content_trails f
     WHERE f.trail_id = p_from
       AND EXISTS (SELECT 1 FROM public.content_trails i
                    WHERE i.trail_id = p_into AND i.source_type = f.source_type AND i.source_id = f.source_id)
    RETURNING 1
  ) SELECT count(*) INTO v_dropped FROM d;

  WITH m AS (
    UPDATE public.content_trails SET trail_id = p_into WHERE trail_id = p_from RETURNING id
  ), rep AS (
    UPDATE public.trail_reports r SET trail_id = p_into
      FROM m WHERE r.content_trail_id = m.id AND r.resolution IS NULL
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM m), (SELECT count(*) FROM rep) INTO v_moved, v_reports_followed;
  v_reports_moved := v_reports_moved + v_reports_followed;

  WITH r AS (
    UPDATE public.trail_reports SET resolution = 'merged'
     WHERE trail_id = p_from AND content_trail_id IS NULL AND resolution IS NULL
    RETURNING 1
  ) SELECT count(*) INTO v_reports_resolved FROM r;

  WITH ins AS (
    INSERT INTO public.trail_follows (trail_id, user_id, created_at)
    SELECT p_into, user_id, created_at FROM public.trail_follows WHERE trail_id = p_from
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO v_follows FROM ins;
  DELETE FROM public.trail_follows WHERE trail_id = p_from;

  WITH ins AS (
    INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type, strength, updated_at, review_state, declared_by)
    SELECT CASE WHEN e.from_trail_id = p_from THEN p_into ELSE e.from_trail_id END,
           CASE WHEN e.to_trail_id = p_from THEN p_into ELSE e.to_trail_id END,
           e.edge_type, e.strength, now(), e.review_state, e.declared_by
      FROM public.trail_edges e
     WHERE (e.from_trail_id = p_from OR e.to_trail_id = p_from)
       AND NOT (e.from_trail_id = p_into OR e.to_trail_id = p_into)
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO v_edges FROM ins;
  DELETE FROM public.trail_edges WHERE from_trail_id = p_from OR to_trail_id = p_from;

  WITH c AS (
    UPDATE public.trails SET parent_trail_id = p_into, updated_at = now()
     WHERE parent_trail_id = p_from AND id <> p_into
    RETURNING 1
  ) SELECT count(*) INTO v_children FROM c;

  UPDATE public.trails SET lifecycle_status = 'archived', merged_into_trail_id = p_into, updated_at = now()
   WHERE id = p_from;

  v_detail := jsonb_build_object(
    'request', v_request, 'from_state', v_from_state,
    'members_moved', v_moved, 'members_dropped_as_duplicates', v_dropped,
    'follows_moved', v_follows, 'edges_rehomed', v_edges, 'children_reparented', v_children,
    'open_reports_moved', v_reports_moved, 'trail_reports_resolved_merged', v_reports_resolved);
  INSERT INTO public.discovery_admin_audit_events (action, subject_kind, subject_id, related_id, actor_user_id, reason, detail, idempotency_key)
  VALUES ('trail_merge', 'trail', p_from::text, p_into::text, p_actor, p_reason, v_detail, p_idempotency_key);
  RETURN jsonb_build_object('outcome', 'merged', 'detail', v_detail);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_admin_merge(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_admin_merge(uuid, uuid, uuid, text, text) TO service_role;

-- §6's five declarable kinds (`child` is written by a proposal that names its
-- parent). Moderation accepts (navigable) or rejects (kept, not navigable).
CREATE OR REPLACE FUNCTION public.trail_admin_review_edge(
  p_from uuid, p_to uuid, p_edge_type text, p_verdict text, p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_request jsonb := jsonb_build_object('to', p_to, 'edge_type', p_edge_type, 'verdict', p_verdict);
  v_replay jsonb; v_prior text; v_n int;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reason_required');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'idempotency_key_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discovery_admin:' || p_idempotency_key, 0));
  v_replay := public.discovery_admin_replay(p_idempotency_key, 'trail_edge_review', p_from::text, v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_edge_type IS NULL OR p_edge_type NOT IN ('parent', 'related', 'seasonal_variant', 'geographic_sub', 'experience_branch') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'edge_type_not_declarable');
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('accepted', 'rejected') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_verdict');
  END IF;
  IF p_from = p_to THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'same_trail'); END IF;
  SELECT count(*) INTO v_n FROM public.trails WHERE id IN (p_from, p_to) AND lifecycle_status <> 'archived';
  IF v_n <> 2 THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail'); END IF;

  SELECT review_state INTO v_prior FROM public.trail_edges
   WHERE from_trail_id = p_from AND to_trail_id = p_to AND edge_type = p_edge_type FOR UPDATE;
  INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type, strength, updated_at, review_state, declared_by)
  VALUES (p_from, p_to, p_edge_type, 0.5, now(), p_verdict, p_actor)
  ON CONFLICT (from_trail_id, to_trail_id, edge_type)
  DO UPDATE SET review_state = EXCLUDED.review_state, updated_at = now();

  INSERT INTO public.discovery_admin_audit_events (action, subject_kind, subject_id, related_id, actor_user_id, reason, detail, idempotency_key)
  VALUES ('trail_edge_review', 'trail_edge', p_from::text, p_to::text, p_actor, p_reason,
          jsonb_build_object('request', v_request, 'prior_state', v_prior), p_idempotency_key);
  RETURN jsonb_build_object('outcome', 'reviewed', 'prior_state', v_prior, 'review_state', p_verdict);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_admin_review_edge(uuid, uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_admin_review_edge(uuid, uuid, text, text, uuid, text, text) TO service_role;

-- `11` §8 "trend integrity review": the verdict row and its audit row, together.
CREATE OR REPLACE FUNCTION public.trend_integrity_review_record(
  p_subject_kind text, p_subject_id text, p_verdict text, p_evidence jsonb,
  p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_request jsonb := jsonb_build_object('subject_kind', p_subject_kind, 'verdict', p_verdict);
  v_replay jsonb; v_id uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reason_required');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'idempotency_key_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discovery_admin:' || p_idempotency_key, 0));
  v_replay := public.discovery_admin_replay(p_idempotency_key, 'trend_integrity_review', p_subject_id, v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF p_subject_kind IS NULL OR p_subject_kind NOT IN ('trail', 'place') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_subject_kind');
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('confirmed', 'suspect', 'suppressed', 'cleared') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_verdict');
  END IF;
  IF p_subject_kind = 'trail' AND NOT EXISTS (SELECT 1 FROM public.trails WHERE id::text = p_subject_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail');
  END IF;

  INSERT INTO public.trend_integrity_reviews (subject_kind, subject_id, verdict, evidence, reason, reviewed_by)
  VALUES (p_subject_kind, p_subject_id, p_verdict, coalesce(p_evidence, '{}'::jsonb), p_reason, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.discovery_admin_audit_events (action, subject_kind, subject_id, related_id, actor_user_id, reason, detail, idempotency_key)
  VALUES ('trend_integrity_review', p_subject_kind, p_subject_id, v_id::text, p_actor, p_reason,
          jsonb_build_object('request', v_request, 'evidence', coalesce(p_evidence, '{}'::jsonb)), p_idempotency_key);
  RETURN jsonb_build_object('outcome', 'reviewed', 'review_id', v_id, 'verdict', p_verdict);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trend_integrity_review_record(text, text, text, jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trend_integrity_review_record(text, text, text, jsonb, uuid, text, text) TO service_role;

-- `02` §5 "Portava-curated catalog" → §8's Local Picks (DV-21, D-W10T-3): the
-- ONE writer of content_trails.source = 'curated'. Moderation curates content the
-- service has already verified exists and is PUBLIC (verifyAttachSources as an
-- anonymous viewer). A label the Trail already holds is marked curated; a new one
-- is inserted under 3380's cap like any other; a proposed Trail becomes active,
-- as on its first content.
CREATE OR REPLACE FUNCTION public.trail_admin_curate(
  p_trail_id uuid, p_source_type text, p_source_id uuid, p_relationship text, p_signal text,
  p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_request jsonb := jsonb_build_object('source_type', p_source_type, 'source_id', p_source_id, 'relationship', p_relationship, 'signal', p_signal);
  v_replay jsonb; v_state text; v_row uuid; v_mode text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reason_required');
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'idempotency_key_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discovery_admin:' || p_idempotency_key, 0));
  v_replay := public.discovery_admin_replay(p_idempotency_key, 'trail_curate', p_trail_id::text, v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT lifecycle_status INTO v_state FROM public.trails WHERE id = p_trail_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail'); END IF;
  IF v_state = 'archived' THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unknown_trail'); END IF;

  SELECT id INTO v_row FROM public.content_trails
   WHERE trail_id = p_trail_id AND source_type = p_source_type AND source_id = p_source_id
     AND relationship = p_relationship AND COALESCE(signal, '') = COALESCE(p_signal, '')
   FOR UPDATE;
  BEGIN
    IF FOUND THEN
      UPDATE public.content_trails SET source = 'curated', confidence = GREATEST(confidence, 0.9) WHERE id = v_row;
      v_mode := 'marked';
    ELSE
      INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal, source, confidence, contributor_id, content_state)
      VALUES (p_trail_id, p_source_type, p_source_id, p_relationship, p_signal, 'curated', 0.9, p_actor, 'just_arrived')
      RETURNING id INTO v_row;
      v_mode := 'inserted';
    END IF;
  EXCEPTION WHEN check_violation OR unique_violation THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'label_refused', 'detail', SQLERRM);
  END;
  IF v_state = 'proposed' THEN
    UPDATE public.trails SET lifecycle_status = 'active', updated_at = now() WHERE id = p_trail_id;
  END IF;

  INSERT INTO public.discovery_admin_audit_events (action, subject_kind, subject_id, related_id, actor_user_id, reason, detail, idempotency_key)
  VALUES ('trail_curate', 'trail', p_trail_id::text, v_row::text, p_actor, p_reason,
          jsonb_build_object('request', v_request, 'mode', v_mode), p_idempotency_key);
  RETURN jsonb_build_object('outcome', 'curated', 'mode', v_mode, 'content_trail_id', v_row);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_admin_curate(uuid, text, uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_admin_curate(uuid, text, uuid, text, text, uuid, text, text) TO service_role;


COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['discovery_admin_audit_events', 'trend_integrity_reviews'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3486): public.% was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3486): RLS is not enabled on public.%', t;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3486): a client role can read or write public.%', t;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.trail_admin_merge(uuid, uuid, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trail_admin_move_lifecycle(uuid, text, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3486): a client role can execute an admin function';
  END IF;
END $post$;
