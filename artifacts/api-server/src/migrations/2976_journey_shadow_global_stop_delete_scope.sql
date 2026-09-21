-- 2976_journey_shadow_global_stop_delete_scope.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2976.
-- Repairs public.global_journey_shadow_stop_v1(uuid), which EXISTS IN PRODUCTION
-- AND CANNOT RUN. Idempotent: re-running is a no-op replace of identical text.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
-- The installed body carries THREE unqualified deletes:
--
--     DELETE FROM public.journey_shadow_ground_truth;
--     DELETE FROM public.journey_observations;
--     DELETE FROM public.journey_segment_revisions;
--
-- Production runs `session_preload_libraries = supautils`, whose `safeupdate`
-- guard raises "DELETE requires a WHERE clause" for PostgREST-role sessions.
-- The deletes sit AFTER the four (correctly qualified) UPDATEs that actually
-- stop collection, so a call through the API raises at the FIRST delete and the
-- whole transaction rolls back -- including the flag disable, the stage
-- deactivation and the cohort/issuance revocations.
--
-- THE STOP THEREFORE DOES NOTHING AT ALL. It is a safety control for a
-- location-tracking research programme, and it is inoperative.
--
-- ── WHY IT IS ABSENT FROM THIS REPOSITORY, ESTABLISHED NOT GUESSED ───────────
-- It was authored in `2127_journey_shadow_controlled_rollout.sql` SECTION 9, on
-- branch `origin/fix/rls-hardening-signin-flake` (commit 46b1f0383, 2026-08-23,
-- itself a renumber of 2123 from cf9730823, 2026-08-21). That branch was NEVER
-- merged to `main` -- `git merge-base --is-ancestor 46b1f0383 origin/main` is
-- false -- but the migration WAS applied to production. Its intended callers
-- were authored on the same unmerged branch:
--   * `src/routes/adminJourney.ts` -- POST /admin/journey-shadow/stop
--   * `src/services/journey/JourneyShadowRolloutService.ts:187` -- globalJourneyShadowStop()
-- Neither exists on `main`, so the RPC has no live caller today. The body
-- installed in production is BYTE-IDENTICAL to the body authored in 2127
-- (md5 of pg_get_functiondef = 05e711b9fb218e42171988c1c56b8d26, length 2891):
-- the defect was authored, not introduced by drift.
--
-- The programme is DORMANT. Measured on production 2026-09-21: all of
-- journey_observations, journey_segment_revisions, journey_shadow_ground_truth,
-- journey_shadow_cohort_assignments, journey_shadow_session_issuances,
-- journey_shadow_stages, journey_shadow_qa_reports and journey_revocation_jobs
-- hold ZERO rows; no COMPASS_JOURNEY_* flag is enabled; no open journey-purpose
-- location_session exists. This repair is therefore PREVENTIVE -- it fixes the
-- control before the programme it guards is ever switched on.
--
-- ── THE CONTRACT: DISABLE **AND** ERASE (both), AND WHY ──────────────────────
-- Unrestricted deletion was NOT assumed. The evidence that erasure is intended:
--
--   1. The function's own installed COMMENT says so verbatim: "Immediate global
--      stop: disables all Journey flags, deactivates stages, revokes assignments
--      ..., revokes issuances, ends issued sessions, deletes all observations,
--      segment revisions, and ground-truth rows."
--   2. `revoke_journey_shadow_cohort_v1` is the PER-ASSIGNMENT analogue of this
--      function and is already in production, already correctly scoped, and it
--      DOES erase: ground truth for the assignment, observations and segment
--      revisions for the user. The global stop is that operation fanned out.
--   3. `purge_journey_observations_on_session_revocation` synchronously erases
--      raw and derived rows the moment a journey session ends, calling itself an
--      "Atomic erasure boundary (not queue-only)".
--   4. `lib/d6Classifications.ts` classifies all three deleted tables ERASE
--      under ruling 3 (journey_observations: "The single clearest erase in the
--      set"). They are research-subject personal data, not audit evidence.
--
-- AUDIT EVIDENCE IS NOT DESTROYED, and this was checked rather than asserted.
-- The tables d6 classifies as retained or anonymised are exactly the ones this
-- function does NOT delete from: `journey_revocation_jobs`
-- (RETAIN_LEGAL_SECURITY -- "DELETION AUDIT EVIDENCE"), `journey_retention_health`
-- (RETAIN_AGGREGATE_NON_PERSONAL), `journey_shadow_qa_reports` (ANONYMIZE --
-- programme intelligence survives), `journey_shadow_stages` (ANONYMIZE), and the
-- cohort-assignment and session-issuance history rows, which are UPDATEd to
-- revoked and KEPT. Ground truth is a 30-day-bounded per-subject QA record, not
-- a ledger. So "stop erases the subject data, the record that it happened
-- survives" is the existing design, and this migration preserves it exactly.
--
-- ── THE QUALIFICATION IS THE REAL PREDICATE, NOT `WHERE true` ────────────────
-- `WHERE true` is deliberately NOT used. The stop's scope has a name already
-- written into this very function: the LAST statement in the body scopes the
-- session end to `journey_purpose = 'journey_observation_v1'`. That is the
-- programme's boundary, and the deletes now use the same one:
--
--     WHERE <tbl>.location_session_id IN (
--             SELECT ls.id FROM public.location_sessions ls
--              WHERE ls.journey_purpose = 'journey_observation_v1')
--
-- This is not a tautology. `location_sessions` holds `live_share`, `trip_check_in`
-- and `auto` sessions that have nothing to do with the shadow programme; a row
-- attached to one of those is not this stop's to erase, and now survives it.
-- Today the predicate happens to select every row only because these tables
-- currently hold nothing but programme data -- a property of the data, not of
-- the predicate. The moment that stops being true the scoped form stays correct
-- and `WHERE true` would silently over-delete.
--
-- COMPLETENESS, per table, checked against the live FK posture:
--   * journey_observations       -- FK location_session_id -> location_sessions
--                                   ON DELETE CASCADE, NOT NULL. A row cannot
--                                   outlive its session, so the session-purpose
--                                   clause alone is complete.
--   * journey_shadow_ground_truth -- same FK posture. Complete.
--   * journey_segment_revisions  -- HAS NO FK on location_session_id (verified:
--                                   its only FKs are user_id -> profiles CASCADE
--                                   and supersedes_id -> self). A row could in
--                                   principle outlive its session row, so this
--                                   one takes a SECOND clause naming the other
--                                   real scope -- programme participants:
--                                     OR jsr.user_id IN (SELECT ca.user_id
--                                          FROM journey_shadow_cohort_assignments ca)
--                                   The union is exhaustive: segment revisions
--                                   are written only by
--                                   append_journey_segment_revisions_v2, gated by
--                                   journey_shadow_authorize_v1, which requires a
--                                   live issuance and therefore an assignment;
--                                   and assignments disappear only by profile
--                                   cascade, which cascades the segments too.
--
-- ── ATOMICITY IS KEPT, DELIBERATELY ─────────────────────────────────────────
-- The obvious alternative was to let the revocations commit even if cleanup
-- fails (wrap the deletes in an EXCEPTION block and queue the erasure to
-- journey_revocation_jobs). That is REJECTED. A stop that swallows an erasure
-- failure and returns a success payload tells an admin that personal data is
-- gone when it is not -- the silent-partial-success failure mode this codebase
-- has repeatedly had to remove. Kept atomic, the caller either gets the whole
-- stop or an error it can retry, and never a false success.
--
-- The reason atomicity was unsafe BEFORE is that erasure was guaranteed to
-- raise. With the deletes qualified, the guard cannot fire, so the failure mode
-- atomicity protects against is no longer the normal path. Statement ORDER is
-- also preserved: collection is stopped first, so any later failure aborts the
-- transaction rather than leaving a half-applied stop.
--
-- ── SHAPE OF THIS MIGRATION, AND THE `certify:migrations` TRAP ──────────────
-- 2965 did text surgery on the installed definition via a DO block containing
-- EXECUTE. That pattern springs two traps in `certify:migrations` stage 4, which
-- re-runs every DO block as if it were a postcondition (docs/migrations.md,
-- "A TRAP IN `certify:migrations` THAT 2965 SPRANG"): a non-idempotent
-- precondition raises on the post-state, and a DO block containing EXECUTE is
-- refused as not read-only.
--
-- This file avoids BOTH, and #516 has since made the reasoning exact. Stage 4
-- does not in fact re-run "every DO block": it collects only the blocks that
-- isAssertionOnlyDoBlock() accepts (scripts/lib/migrationSqlBlocks.ts), and a
-- block containing EXECUTE is not one of them -- it is never collected, so it
-- is never re-run and never "refused" either. #516 additionally holds back
-- `$pre$`-tagged blocks via isPreconditionDoBlock(), because a precondition
-- describes the state BEFORE the apply.
--
-- So of this file's three DO blocks, stage 4 re-runs exactly one:
--   `$mig$`  -- contains EXECUTE, therefore not assertion-only: not collected.
--   `$pre$`  -- assertion-only but tagged as a precondition: held back by #516.
--   `$post$` -- assertion-only, re-run, and it TOLERATES every state this file
--              can leave: the repaired body, a re-apply, and the deliberate
--              no-op where the object is absent.
-- `$pre$` is nonetheless written to tolerate the post-state as well, so it is
-- correct inside the applier's own transaction on a second apply rather than
-- relying on #516 to excuse it.
--
-- Spelling out the canonical definition in full (rather than patching the
-- installed text) is also the point: a live object that no file describes is its
-- own defect, and is half of why this happened. From this migration on, the
-- function IS in the repository -- verbatim, inside the `$mig$` block's
-- dollar-quoted `EXECUTE` literal rather than at top level, because the repair
-- has to be conditional (see "CHAIN REPLAYABILITY" below). The text is the same
-- text; it is still readable and greppable in this file, and it is still what
-- `check:security-definer-oracles` reads the object out of. The safety of doing it this way comes from the
-- `$pre$` md5 gate -- the body is replaced only if what is installed is exactly
-- the body this file was written against, byte for byte.
--
-- ── CHAIN REPLAYABILITY: THE ABSENT CASE IS A NO-OP, NOT AN ERROR ───────
-- Every file in the canonical chain must replay cleanly onto a database built
-- from that chain. A migration that ABORTS the replay is broken however right
-- it is about production, because it stops every later file from running.
--
-- This file's first version failed that. It RAISED when the function was
-- absent, and the function is absent from any chain-built database BY
-- CONSTRUCTION: it was authored in 2127 SECTION 9 on a branch that was never
-- merged, so no file in the chain creates it. Measured, not assumed:
--   * CI, `kernel SQL executed on a throwaway database` (run 35587567086):
--     "local-db: 2976_... failed and is not in KNOWN_UNREPLAYABLE.json /
--      ERROR: 2976: public.global_journey_shadow_stop_v1 is absent."
--   * portava-ci, the project `live-db.yml` applies to: the function is
--     absent there too (count(*) = 0 over pg_proc, verified 2026-09-21), so
--     the same abort would have turned `main` red after merge. This was NOT
--     only a rehearsal limitation; it was a defect in this file.
--
-- THE FIX IS A QUIET SKIP, IN ALL THREE BLOCKS, FROM ONE OBSERVATION:
--   `$pre$`  -- absent: RAISE NOTICE and RETURN.
--   `$mig$`  -- absent: RAISE NOTICE and RETURN, so nothing is created from
--              nothing and the REVOKE/GRANT/COMMENT cannot raise either.
--   `$post$` -- absent: RAISE NOTICE and RETURN; there is nothing to assert.
-- They agree because each re-derives the same fact from the same catalog, so
-- the skip and the assertions can never disagree about what happened.
--
-- WHAT IS DELIBERATELY NOT WEAKENED. Absence and an unrecognised body are
-- DIFFERENT branches and stay different. If the function EXISTS but its body is
-- neither the recorded pre-image (md5 05e711b9fb218e42171988c1c56b8d26) nor the
-- post-state, `$pre$` still RAISES and still refuses to overwrite a body this
-- file has not read. The md5 gate is untouched. Only "there is no object here"
-- became a no-op, and on a chain-built database that is the correct outcome:
-- this file repairs an existing object, and there is no existing object.
--
-- WHY NOT `KNOWN_UNREPLAYABLE.json`. That registry exists (9 entries) and 2976
-- would have been accepted into it. It was rejected as the remedy for two
-- reasons. Its own `_rule` says an entry is "a measured failure with the
-- migration's own message" -- a fact about the replay, not permission to ignore
-- the file -- and this failure is avoidable rather than inherent. And it is
-- read only by `scripts/local-db/up.sh`: it would have silenced the throwaway
-- CI job while leaving `live-db.yml`'s apply to portava-ci to abort exactly as
-- before. A registry entry would have hidden half the defect.
--
-- ── DELIVERY NOTE ───────────────────────────────────────────────────────────
-- Applied to production through the Supabase Management API
-- (`mcp__Supabase__apply_migration`), which supplies its own transaction. The
-- self-wrapped `BEGIN;`/`COMMIT;` below is therefore OMITTED from the text sent
-- to production and present here for the file's own replayability
-- (`scripts/local-db/up.sh`, `db:apply-migrations`).

BEGIN;

-- ── PRECONDITIONS (assertion-only; tolerates the post-state) ────────────────
DO $pre$
DECLARE
  d            text;
  v_unqual     int;
  v_scoped     int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.prokind  = 'f'
     AND p.proname  = 'global_journey_shadow_stop_v1';

  -- ABSENT: nothing to repair, and that is a CORRECT outcome, not an error.
  -- The object this file repairs was authored out of band (2127 SECTION 9 on an
  -- unmerged branch) and is therefore NOT in the canonical chain. A database
  -- built from the chain alone -- the throwaway PostgreSQL in CI, and
  -- portava-ci, where this function is measurably absent -- has no such object.
  -- This file still REFUSES to create one from nothing (see the apply block
  -- below, which is gated on the same fact); it simply does so quietly, because
  -- a migration that aborts the replay of its own chain is broken however right
  -- it is about production. See the header, "CHAIN REPLAYABILITY".
  IF d IS NULL THEN
    RAISE NOTICE '2976: public.global_journey_shadow_stop_v1 is absent; this migration repairs an existing out-of-band object and will not create one from nothing. Nothing to repair -- skipping (no-op).';
    RETURN;
  END IF;

  -- The exact body this file was written against.
  IF md5(d) = '05e711b9fb218e42171988c1c56b8d26' THEN
    RAISE NOTICE '2976: pre-image recognised (md5 05e711b9..., 3 unqualified deletes); replacing.';
    RETURN;
  END IF;

  -- Already applied: the post-state. Return quietly so `certify:migrations`
  -- stage 4 can re-run this block on the run that applied it.
  v_unqual := (length(d) - length(replace(d, 'DELETE FROM public.journey_observations;', ''))) / length('DELETE FROM public.journey_observations;')
            + (length(d) - length(replace(d, 'DELETE FROM public.journey_segment_revisions;', ''))) / length('DELETE FROM public.journey_segment_revisions;')
            + (length(d) - length(replace(d, 'DELETE FROM public.journey_shadow_ground_truth;', ''))) / length('DELETE FROM public.journey_shadow_ground_truth;');
  v_scoped := (length(d) - length(replace(d, 'journey_purpose = ''journey_observation_v1''', ''))) / length('journey_purpose = ''journey_observation_v1''');

  IF v_unqual = 0 AND v_scoped >= 4 THEN
    RAISE NOTICE '2976: already applied (0 unqualified deletes, % scoped references); re-running is a no-op.', v_scoped;
    RETURN;
  END IF;

  RAISE EXCEPTION
    '2976: the installed body is neither the recorded pre-image (md5 05e711b9fb218e42171988c1c56b8d26) nor the post-state (found md5 %, % unqualified delete(s), % scoped reference(s)). REFUSING rather than overwriting a body this file has not read.',
    md5(d), v_unqual, v_scoped;
END
$pre$;

-- ── THE CANONICAL DEFINITION ────────────────────────────────────────────────
-- Identical to the body installed in production except for the three DELETE
-- statements, which gain the programme-scope predicate, and their comments.
--
-- GATED ON PRESENCE -- and this gate is the same fact the `$pre$` block reports,
-- not a second opinion about it. The DDL below runs ONLY if the object is
-- already installed. That is what keeps "this migration repairs an existing
-- out-of-band object and will not create one from nothing" TRUE while letting
-- the file replay cleanly onto a database built from the canonical chain, where
-- the object is absent and there is genuinely nothing to repair.
--
-- WHY THIS IS A `DO` BLOCK AND NOT TOP-LEVEL SQL. Top-level SQL has no
-- conditional, and every statement here needs the same guard: a bare
-- `CREATE OR REPLACE` would create the object from nothing, and the REVOKE,
-- GRANT and COMMENT would each raise "function does not exist". Wrapping them
-- is the only way to make the whole repair one decision.
--
-- IT IS STILL SAFE FROM THE `certify:migrations` STAGE 4 TRAP, for a better
-- reason than the top-level form had. Stage 4 collects a file's assertion
-- blocks via isAssertionOnlyDoBlock() (scripts/lib/migrationSqlBlocks.ts): a
-- `DO` block containing EXECUTE is not assertion-only, so it is never collected
-- and never re-run. The `$pre$` block is additionally held back by
-- isPreconditionDoBlock(), added by #516. Only `$post$` is re-run, and it
-- tolerates every state this file can leave behind, including the no-op.
--
-- THE CANONICAL TEXT IS STILL IN THIS FILE, VERBATIM, which was the point of
-- spelling it out: `EXECUTE` takes a dollar-quoted literal, so the definition
-- below is byte-for-byte the definition installed in production, readable and
-- greppable, not assembled at runtime from the installed text the way 2965 had
-- to do it.
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prokind  = 'f'
       AND p.proname  = 'global_journey_shadow_stop_v1'
  ) THEN
    RAISE NOTICE '2976: global_journey_shadow_stop_v1 is absent; refusing to create it from nothing. No-op -- nothing to repair on a database built from the canonical chain.';
    RETURN;
  END IF;

  EXECUTE $def$
CREATE OR REPLACE FUNCTION public.global_journey_shadow_stop_v1(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now                 timestamptz := clock_timestamp();
  v_flags_disabled      integer := 0;
  v_stages_stopped      integer := 0;
  v_assignments_revoked integer := 0;
  v_sessions_ended      integer := 0;
  v_observations_deleted integer := 0;
  v_segments_deleted    integer := 0;
  v_ground_truth_deleted integer := 0;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Disable all Journey feature flags
  UPDATE public.feature_flags
     SET enabled = false
   WHERE flag IN (
     'COMPASS_JOURNEY_ENGINE_ENABLED',
     'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
     'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
   )
     AND enabled = true;
  GET DIAGNOSTICS v_flags_disabled = ROW_COUNT;

  -- Deactivate all active stages
  UPDATE public.journey_shadow_stages
     SET is_active = false
   WHERE is_active = true;
  GET DIAGNOSTICS v_stages_stopped = ROW_COUNT;

  -- Revoke all active cohort assignments (actor = admin for audit)
  UPDATE public.journey_shadow_cohort_assignments
     SET revoked_at = v_now,
         revoked_by = p_actor
   WHERE revoked_at IS NULL;
  GET DIAGNOSTICS v_assignments_revoked = ROW_COUNT;

  -- Revoke all active session issuances
  UPDATE public.journey_shadow_session_issuances
     SET revoked_at = v_now
   WHERE revoked_at IS NULL;

  -- Erase the ground truth collected under the programme. Scoped to the
  -- programme's own boundary -- the journey-purpose sessions -- not to every
  -- row the table happens to hold. Complete for this table because
  -- location_session_id is NOT NULL with ON DELETE CASCADE to location_sessions,
  -- so a ground-truth row cannot outlive its session.
  -- (Assignment history rows remain revoked; truth references them but is erased.)
  DELETE FROM public.journey_shadow_ground_truth gt
   WHERE gt.location_session_id IN (
           SELECT ls.id
             FROM public.location_sessions ls
            WHERE ls.journey_purpose = 'journey_observation_v1'
         );
  GET DIAGNOSTICS v_ground_truth_deleted = ROW_COUNT;

  -- Erase the raw observations collected under the programme. Same scope, and
  -- complete for the same reason (NOT NULL FK, ON DELETE CASCADE).
  DELETE FROM public.journey_observations jo
   WHERE jo.location_session_id IN (
           SELECT ls.id
             FROM public.location_sessions ls
            WHERE ls.journey_purpose = 'journey_observation_v1'
         );
  GET DIAGNOSTICS v_observations_deleted = ROW_COUNT;

  -- Erase the derived segment revisions. This table has NO foreign key on
  -- location_session_id, so a revision could outlive its session row; the second
  -- clause names the other real scope of the stop -- the programme's
  -- participants -- so the union cannot leave an orphan behind.
  DELETE FROM public.journey_segment_revisions jsr
   WHERE jsr.location_session_id IN (
           SELECT ls.id
             FROM public.location_sessions ls
            WHERE ls.journey_purpose = 'journey_observation_v1'
         )
      OR jsr.user_id IN (
           SELECT ca.user_id
             FROM public.journey_shadow_cohort_assignments ca
         );
  GET DIAGNOSTICS v_segments_deleted = ROW_COUNT;

  -- End sessions only after counting synchronous erasure above. The normal
  -- session-end trigger also erases raw/derived rows; doing that first would
  -- make this emergency-stop audit incorrectly report zero deletions.
  UPDATE public.location_sessions
     SET ended_at = COALESCE(ended_at, v_now)
   WHERE journey_purpose = 'journey_observation_v1'
     AND ended_at IS NULL;
  GET DIAGNOSTICS v_sessions_ended = ROW_COUNT;

  RETURN jsonb_build_object(
    'flags_disabled',        v_flags_disabled,
    'stages_stopped',        v_stages_stopped,
    'assignments_revoked',   v_assignments_revoked,
    'sessions_ended',        v_sessions_ended,
    'observations_deleted',  v_observations_deleted,
    'segments_deleted',      v_segments_deleted,
    'ground_truth_deleted',  v_ground_truth_deleted,
    'stopped_at',            v_now
  );
END;
$function$;
$def$;

  -- Authorization, restated verbatim from 2127 SECTION 9 so this file is the
  -- complete description of the object. CREATE OR REPLACE preserves the existing
  -- ACL; these are belt-and-braces and must not widen it.
  EXECUTE $def$
  REVOKE ALL ON FUNCTION public.global_journey_shadow_stop_v1(uuid)
    FROM PUBLIC, anon, authenticated;
$def$;
  EXECUTE $def$
  GRANT EXECUTE ON FUNCTION public.global_journey_shadow_stop_v1(uuid)
    TO service_role;
$def$;

  EXECUTE $def$
  COMMENT ON FUNCTION public.global_journey_shadow_stop_v1(uuid) IS
    'INTERNAL SHADOW ONLY. Admin-only. Immediate global stop: disables all Journey flags, '
    'deactivates stages, revokes assignments (with admin as revoked_by), revokes issuances, '
    'ends issued sessions, and erases the observations, segment revisions and ground-truth '
    'rows collected under the programme (scoped to journey_purpose = ''journey_observation_v1'' '
    'and, for segment revisions, to programme participants). Atomic: a failure anywhere leaves '
    'the stop unapplied rather than half-applied. Repaired by 2976 -- the 2127 body carried '
    'three unqualified DELETEs that supautils safeupdate refuses, which made the stop inoperative.';
$def$;
END
$mig$;

-- ── POSTCONDITIONS (assertion-only; true on every re-run) ───────────────────
DO $post$
DECLARE
  d        text;
  v_args   text;
  n        int;
BEGIN
  SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    INTO d, v_args
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.prokind  = 'f'
     AND p.proname  = 'global_journey_shadow_stop_v1';

  -- ABSENT. This is the no-op branch, and it must NOT fail here: the `$pre$`
  -- block and the apply block above are gated on this exact fact, so "absent
  -- after" is the outcome this file deliberately produces on a database built
  -- from the canonical chain. A postcondition that fired on a deliberate skip
  -- would be a false failure of precisely the kind #516 removed from stage 4 --
  -- a guard reporting a migration that worked as a migration that broke.
  --
  -- THIS DOES NOT WEAKEN THE ASSERTIONS BELOW. They are skipped only when there
  -- is no object to assert about, which is observable here and is the same
  -- observation that skipped the repair. Wherever the object EXISTS -- production,
  -- and any database that has the out-of-band 2127 object -- every assertion
  -- below runs in full and unchanged. "Absent -> skip" and "present but
  -- unrecognised -> refuse" stay different branches.
  IF d IS NULL THEN
    RAISE NOTICE '2976: global_journey_shadow_stop_v1 is absent and this migration no-opped; there is nothing to assert. Postconditions skipped.';
    RETURN;
  END IF;

  IF v_args IS DISTINCT FROM 'p_actor uuid' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): signature is now (%), expected (p_actor uuid). A changed argument list would leave the old overload behind and the RPC would still resolve to it.', v_args;
  END IF;

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND p.proname = 'global_journey_shadow_stop_v1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): % overloads of global_journey_shadow_stop_v1; the replacement created one instead of replacing.', n;
  END IF;

  -- The defect itself: not one unqualified delete may remain.
  IF position('DELETE FROM public.journey_observations;' in d) > 0
     OR position('DELETE FROM public.journey_segment_revisions;' in d) > 0
     OR position('DELETE FROM public.journey_shadow_ground_truth;' in d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): an unqualified DELETE is still installed.';
  END IF;

  -- And the qualification must be the real predicate, not `WHERE true`.
  IF position('WHERE true' in d) > 0 OR position('WHERE TRUE' in d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): a tautological WHERE clause is installed; the scope predicate is required.';
  END IF;

  n := (length(d) - length(replace(d, 'journey_purpose = ''journey_observation_v1''', ''))) / length('journey_purpose = ''journey_observation_v1''');
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): expected 4 journey_purpose scope references (3 deletes + the session end), found %.', n;
  END IF;

  IF position('journey_shadow_cohort_assignments ca' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): the participant clause on journey_segment_revisions is missing; that table has no FK to location_sessions and needs it.';
  END IF;

  -- Authorization must be exactly what it was: SECURITY DEFINER, service_role only.
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
           WHERE ns.nspname='public' AND p.proname='global_journey_shadow_stop_v1') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): function is no longer SECURITY DEFINER.';
  END IF;

  IF has_function_privilege('anon', 'public.global_journey_shadow_stop_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.global_journey_shadow_stop_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): anon or authenticated can EXECUTE the global stop.';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.global_journey_shadow_stop_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2976): service_role lost EXECUTE on the global stop.';
  END IF;
END
$post$;

COMMIT;
