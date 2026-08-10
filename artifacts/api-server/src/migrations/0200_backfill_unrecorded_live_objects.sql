-- Migration 0200: BACKFILL of pre-existing live objects (NOT a pending change)
--
-- ⚠️  THIS MIGRATION DOES NOT CHANGE PRODUCTION. ⚠️
--
-- Every object below ALREADY EXISTS in the live database and has for a long
-- time. This file exists so that a CLEAN REBUILD from the migration chain
-- reproduces production. Applying it to the current production database is a
-- no-op by construction (CREATE OR REPLACE with the exact live definition, and
-- DROP/CREATE of triggers that are already identical). Nobody should "apply"
-- this expecting an effect, and nobody should treat it as PENDING work.
--
-- PROVENANCE
-- ----------
-- Each function body below was read from the live database with
-- pg_get_functiondef() and pasted verbatim — not retyped, not reformatted.
-- A backfill that drifts from live is worse than no backfill, because it looks
-- authoritative and is wrong. The bodies are byte-identical to live as of
-- 2026-08-10; scripts/verify-backfill-0200.mjs re-checks that byte-for-byte
-- against the live database.
--
-- WHY THESE OBJECTS
-- -----------------
-- A sweep of live objects against every .sql file in every migration root
-- (artifacts/api-server/src/migrations, artifacts/api-server/migrations,
-- migrations, db, supabase/migrations) found 15 live triggers and 56 live
-- non-extension functions, of which 2 triggers and 6 functions are created by
-- NO migration. This file backfills 4 functions and 2 triggers of those 8.
-- The 2 deliberately-skipped functions are inventoried at the bottom.
--
-- ORDER IS LOAD-BEARING
-- ---------------------
-- is_accepted_trip_member() MUST be created before can_post_to_trip(),
-- can_see_post() and can_see_postcard(), all three of which call it. With
-- check_function_bodies on (the default), a LANGUAGE sql body is validated at
-- CREATE time, so the reverse order fails the rebuild outright.
--
-- SECURITY DEFINER AND search_path — REPRODUCED EXACTLY, NOT "IMPROVED"
-- --------------------------------------------------------------------
-- All four functions are SECURITY DEFINER and none pins a search_path. That is
-- reproduced here exactly as it is live. Dropping SECURITY DEFINER would break
-- the RLS predicates (they must see rows the caller cannot); ADDING a pinned
-- search_path would make this file diverge from production, which is the one
-- thing a backfill must never do.
--
-- The unpinned search_path is a real hardening opportunity, and it is NOT
-- unique to these four: can_see_trip, can_see_location, viewer_is_blocked,
-- is_blocked, in_accepted_circle, shares_trip_with and auth_uid_is_event_host
-- are all live SECURITY DEFINER with no pinned search_path too. Pinning it is a
-- behavioural change to authorization functions across the board and belongs in
-- its own reviewed migration, applied deliberately — not smuggled in through a
-- backfill whose entire contract is "identical to live".
--
-- RLS USAGE (confirmed from pg_policies, not inferred from the names)
-- ------------------------------------------------------------------
--   can_see_post       -> policy on public.posts
--   can_see_postcard   -> policy on public.passport_postcards
--   can_post_to_trip   -> policy on public.posts
--   is_accepted_trip_member -> named in NO policy, but called by all three
--                              above, so a rebuild without it breaks them.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. is_accepted_trip_member — FIRST. The other three call it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_accepted_trip_member(t_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from trip_members m
    where m.trip_id = t_id
      and m.user_id = auth.uid()
      and m.role in ('owner','member')   -- excludes 'invited'
  );
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. can_post_to_trip — RLS predicate on public.posts.
--    Null trip_id means a non-trip post, which is always allowed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_post_to_trip(t_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select t_id is null or is_accepted_trip_member(t_id);
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. can_see_post — RLS predicate on public.posts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_see_post(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from posts p
    where p.id = p_id and (
      p.author_id = auth.uid()
      or (
        p.status = 'active' and p.deleted_at is null and (
          p.visibility = 'public'
          or (p.visibility = 'trip_only' and p.trip_id is not null and is_accepted_trip_member(p.trip_id))
        )
      )
    )
  );
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. can_see_postcard — RLS predicate on public.passport_postcards.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_see_postcard(pc_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from passport_postcards pc
    left join posts p on p.id = pc.post_id
    where pc.id = pc_id and (
      pc.user_id = auth.uid()
      or (
        pc.status = 'active' and pc.deleted_at is null and (
          pc.visibility = 'public'
          or (pc.visibility = 'trip_only' and p.trip_id is not null and is_accepted_trip_member(p.trip_id))
        )
      )
    )
  );
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. set_updated_at triggers on posts and passport_postcards.
--
-- ASSESSED, NOT ASSUMED. These are NOT harmless plumbing, and they are
-- materially different from production if omitted:
--
--   * posts.updated_at and passport_postcards.updated_at are both
--     NOT NULL DEFAULT now(), so on a rebuild without these triggers the
--     column is populated at INSERT and then NEVER ADVANCES on UPDATE.
--   * Many production UPDATE paths on posts do not set updated_at themselves
--     and rely entirely on the trigger — e.g. routes/posts.ts sets
--     post_status='pending_safety_review', geotag_credit_awarded=true,
--     canonical_place_id, post_buckets/bucket_classified, and the whole
--     location-privacy patch (update(patch)), none of which include
--     updated_at.
--   * updated_at is part of POST_COLUMNS, i.e. it is serialized out of the API
--     to clients, so the divergence is externally observable and silent.
--
-- The failure mode is the reason to backfill: nothing errors. A rebuilt
-- environment just quietly reports stale timestamps, and anything ordering,
-- caching, or syncing on that column behaves differently from production while
-- every test still passes.
--
-- set_updated_at() itself IS already recorded (migrations/0001_spine.sql), as
-- are the sibling triggers trg_profiles_updated and trg_trips_updated. Only
-- these two were never captured. DROP IF EXISTS + CREATE keeps re-runs safe and
-- matches the convention used by 0106 and 0199.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_posts_updated ON public.posts;
CREATE TRIGGER trg_posts_updated BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_postcards_updated ON public.passport_postcards;
CREATE TRIGGER trg_postcards_updated BEFORE UPDATE ON public.passport_postcards FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- INVENTORY — live objects found by the sweep and DELIBERATELY NOT backfilled.
-- Recorded explicitly so the decision is auditable rather than implied by
-- absence. Both are live, both are SECURITY DEFINER, neither is authorization.
--
--   increment_counter(table_name text, column_name text, row_id uuid) -> void
--     Guarded counter bump. Hard-codes an allow-list (table must be
--     'hidden_gems', column must be 'save_count' or 'visit_count') and RAISEs
--     otherwise, then does a dynamic EXECUTE format(...) UPDATE. It pins
--     SET search_path TO 'public'. NOT backfilled: it is a mutation helper, not
--     a rebuild-correctness dependency — no RLS policy, view, constraint or
--     other function references it, so a rebuilt schema is structurally
--     complete without it. Its absence would surface loudly as a missing-
--     function error on the hidden-gems save/visit path, not silently.
--
--   purge_old_ranking_debug_samples() -> integer
--     Retention job: DELETEs ranking_debug_samples older than 7 days and
--     returns the row count. NOT backfilled: pure housekeeping over a debug
--     table, nothing depends on its existence for correctness, and its absence
--     costs disk on a debug table rather than changing behaviour.
--
-- Both remain genuine migration-vs-live drift and are candidates for their own
-- migration if anyone wants the chain to be exhaustive. They are excluded here
-- on scope, not because they were overlooked.
-- ─────────────────────────────────────────────────────────────────────────────
