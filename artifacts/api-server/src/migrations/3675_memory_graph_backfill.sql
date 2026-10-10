-- 3675_memory_graph_backfill.sql
-- Highlights/Memories spec §22 step 3: "Backfill legacy rows with
-- source_mode=LEGACY_IMPORTED and conservative confidence." Census H195.
-- Decision and plan: docs/architecture/memories-graph-model-decision.md §3.1, §4.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- WHAT IT DOES. Runs 3674's public.memory_graph_backfill_legacy to completion,
-- which calls public.memory_graph_mirror_memory for every Memory in id order:
-- each live Memory's trip / event / place and APPROVED tags become
-- memory_relations rows (RELATED, confidence 0.500, source_mode LEGACY_IMPORTED,
-- detector_version legacy-mirror@1). A deleted or removed Memory gets none.
-- Nothing is invented: a NULL column produces no edge (§22 "never fabricate trip
-- IDs, place IDs, participant links"). The memories rows themselves are not
-- written: their LEGACY_IMPORTED source_mode is 3674's missing-value default.
--
-- WHY A MIGRATION AND NOT A SCHEDULER. It is one pass. After it, 3674's triggers
-- keep the edges current on every write, and the shadow comparison measures any
-- drift. A scheduler would add a boot job for a one-time pass. The function stays
-- installed for an operator-paced re-run (it is idempotent: a second pass over
-- unchanged data changes nothing).
--
-- THE POSTCONDITION IS INDEPENDENT OF THE FUNCTION. It re-derives the expected
-- edge set from memories + memory_tags with its own SQL, not by calling the
-- mirror, and requires the LEGACY_IMPORTED rows to equal it exactly (both
-- directions), so a wrong mirror cannot certify itself. It reads data and the
-- catalog only; nothing from the body's session.
--
-- Rollback: db/rollback/2026-10-10-3675-memory-graph-backfill-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_graph_backfill_legacy(uuid, integer)') IS NULL
     OR to_regprocedure('public.memory_graph_mirror_memory(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3675): 3674''s mirror functions are missing; apply 3674 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'memory_relations' AND column_name = 'source_mode') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3675): memory_relations.source_mode (3674) is missing.';
  END IF;
END $pre$;

DO $backfill$
DECLARE
  v_after uuid := NULL;
  v_res jsonb;
BEGIN
  LOOP
    v_res := public.memory_graph_backfill_legacy(v_after, 500);
    EXIT WHEN (v_res->>'done')::boolean OR (v_res->>'last_id') IS NULL;
    v_after := (v_res->>'last_id')::uuid;
  END LOOP;
END $backfill$;

-- ── Postcondition: the LEGACY_IMPORTED edge set equals the legacy model ─────
DO $post$
DECLARE
  v_missing bigint;
  v_extra bigint;
  v_shape bigint;
  v_unconsented bigint;
BEGIN
  WITH expected AS (
    SELECT m.id AS source_id, 'TRIP'::text AS target_type, m.trip_id::text AS target_id
      FROM public.memories m WHERE m.state NOT IN ('deleted', 'removed') AND m.trip_id IS NOT NULL
    UNION
    SELECT m.id, 'EVENT', m.event_id::text
      FROM public.memories m WHERE m.state NOT IN ('deleted', 'removed') AND m.event_id IS NOT NULL
    UNION
    SELECT m.id, 'PLACE', nullif(coalesce(m.canonical_location_id::text, nullif(m.place_id, '')), '')
      FROM public.memories m WHERE m.state NOT IN ('deleted', 'removed')
       AND nullif(coalesce(m.canonical_location_id::text, nullif(m.place_id, '')), '') IS NOT NULL
    UNION
    SELECT t.memory_id, 'PERSON', t.tagged_user_id::text
      FROM public.memory_tags t JOIN public.memories m ON m.id = t.memory_id
     WHERE t.status = 'approved' AND m.state NOT IN ('deleted', 'removed')
  ), actual AS (
    SELECT r.source_id, r.target_type, r.target_id
      FROM public.memory_relations r
     WHERE r.source_type = 'MEMORY' AND r.source_mode = 'LEGACY_IMPORTED'
  )
  SELECT (SELECT count(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) x),
         (SELECT count(*) FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) y)
    INTO v_missing, v_extra;
  IF v_missing <> 0 OR v_extra <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3675): legacy edges differ from the legacy model: % missing, % extra', v_missing, v_extra;
  END IF;

  SELECT count(*) INTO v_shape FROM public.memory_relations r
   WHERE r.source_mode = 'LEGACY_IMPORTED'
     AND (r.relation_type <> 'RELATED' OR r.confidence IS DISTINCT FROM 0.500
          OR r.detector_version IS DISTINCT FROM 'legacy-mirror@1' OR r.source_type <> 'MEMORY'
          OR r.owner_id IS DISTINCT FROM (SELECT m.owner_id FROM public.memories m WHERE m.id = r.source_id));
  IF v_shape <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3675): % LEGACY_IMPORTED edge(s) are not RELATED / 0.500 / legacy-mirror@1 / owned by the Memory owner', v_shape;
  END IF;

  -- Belt and braces on consent: no PERSON edge of ANY mode without an approved tag.
  SELECT count(*) INTO v_unconsented FROM public.memory_relations r
   WHERE r.source_type = 'MEMORY' AND r.target_type = 'PERSON'
     AND NOT EXISTS (SELECT 1 FROM public.memory_tags t
                      WHERE t.memory_id = r.source_id AND t.tagged_user_id::text = r.target_id AND t.status = 'approved');
  IF v_unconsented <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3675): % PERSON edge(s) name someone without an approved tag', v_unconsented;
  END IF;
END $post$;

COMMIT;
