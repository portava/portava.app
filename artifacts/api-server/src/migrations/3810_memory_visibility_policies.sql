-- 3810_memory_visibility_policies.sql
-- Highlights/Memories spec §3 `memory_visibility_policies` ("Audience and location
-- precision policy") and §10's person visibility ladder on a MEMORY.
-- Census-highlights-memories H33 (§BN). B58 cluster MEM-POLICY.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (B58 memories band 3802-3819).
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive and idempotent: one
-- table, one index, one view, grants. No flag, no function, no trigger, no row.
--
-- ── WHAT §3 NAMES, AND WHERE EACH PART ALREADY LIVES ────────────────────────
-- §10 has three policy dimensions. Two already have storage, on the Memory:
--   audience            memories.visibility, allowed_user_ids, hidden_user_ids (0067)
--   location precision  memories.location_precision (2338, applied to production)
-- They are NOT copied here. A second copy would be a second source of truth whose
-- disagreement with the first nothing could resolve, and every writer of the
-- audience (PATCH /memories/:id, the 2711 kernel, 3676's merge and split) would
-- have to keep both in step. Owner question Q-H33 asks whether to migrate them
-- into this table instead; the default built here is "no copy".
--
-- The third dimension had no storage: the person ladder
--     NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN
-- was only ever DERIVED per participant (services/memory/
-- memoryParticipantVisibility.ts). This file stores the OWNER's half of it — a
-- per-Memory CEILING on how the people on the Memory are disclosed to anyone but
-- the owner and the person themself — in `memory_visibility_policies`, and joins
-- the three dimensions into the one relation §3 names in the view
-- `memory_visibility_policy_effective`, which reads the first two from
-- `memories` itself (security_invoker), so nothing is duplicated.
--
-- ── WHAT A ROW MEANS ────────────────────────────────────────────────────────
-- One row per Memory whose owner set a ceiling. No row = no ceiling (the derived
-- ladder alone, exactly as before 3810). Clearing the ceiling deletes the row.
-- The row holds two ids, a rung and a time — no Memory content.
--
-- ── WHO READS AND WRITES IT, AND HOW EACH FAILS ─────────────────────────────
-- Written only by PUT /memories/:id/visibility-policy
-- (routes/memoryVisibilityPolicy.ts), owner only, as service_role. Read by
--   services/memory/memoryVisibilityPolicy.ts readPersonCeilings — for the
--     participant ladder (GET /memories/:id, GET /memories/:id/tags, the trip
--     recap, §23 canSeeParticipant) and for the §18 registry's shared
--     TripMemoryProjection (the crew search), applied at BUILD time;
--   readEffectivePolicy — the owner's GET, through the view.
-- Absent (this file not applied: 42P01 / PGRST205 only) ⇒ no ceiling anywhere,
-- every surface exactly as before. Unreadable ⇒ every person on the Memory is
-- HIDDEN to everyone the ceiling binds, and a non-owner derivative that names
-- people is not built. The ceiling only ever NARROWS (memoryVisibilityPolicy.ts
-- applyPersonCeiling, property-tested over every rung pair).
--
-- ── NO CLIENT ROLE, ON THE TABLE OR THE VIEW ────────────────────────────────
-- Supabase's default privileges hand anon and authenticated a new table AND a new
-- view. Both are revoked here (check:client-privilege-boundary rule 4 for the
-- table, rule 5 for the view). The view must not stay client-readable for a
-- second reason: 3813 (PR #726, unapplied) refuses to apply while any view over
-- public.memories is readable by a client role, and its postcondition re-checks
-- it — a client grant on this view would block 3813. The view is
-- security_invoker regardless, so even a future grant would read through
-- memories' own RLS rather than past it. RLS is on the table with no policy:
-- service_role only.
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- memory_id cascades from public.memories (the §21 lifecycle's hard delete and
-- account deletion's Memory delete) and owner_id from auth.users (account
-- deletion's final step). lib/deletionDispositions.ts: ERASED_BY_CASCADE.
--
-- Rollback: db/rollback/2026-10-14-3810-memory-visibility-policies-rollback.sql
-- Proof: src/test/db/memoryVisibilityPolicies.db.test.ts (CI local-db tier, the
-- real chain) and sql/rehearsals/3810_01_memory_visibility_policies.sql (PGlite).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3810): public.memories does not exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3810): auth.users is missing, so the erasure cascade cannot be created.';
  END IF;
  -- The view reads these four columns where they live. location_precision is 2338's.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.memories'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('visibility', 'allowed_user_ids', 'hidden_user_ids', 'location_precision')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3810): public.memories lacks one of visibility, allowed_user_ids, hidden_user_ids, location_precision (2338).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_visibility_policies') AND relkind <> 'r') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3810): public.memory_visibility_policies exists and is not a table.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_visibility_policy_effective') AND relkind <> 'v') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3810): public.memory_visibility_policy_effective exists and is not a view.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.memory_visibility_policies (
  memory_id                 uuid NOT NULL PRIMARY KEY REFERENCES public.memories(id) ON DELETE CASCADE,
  owner_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_visibility_ceiling text NOT NULL
    CONSTRAINT memory_visibility_policies_person_ceiling_check
    CHECK (person_visibility_ceiling IN ('NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN')),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_visibility_policies_owner_idx
  ON public.memory_visibility_policies (owner_id);

ALTER TABLE public.memory_visibility_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_visibility_policies FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_visibility_policies TO service_role;

COMMENT ON TABLE public.memory_visibility_policies IS
  'Spec §3/§10 (migration 3810, census H33): the owner''s per-Memory ceiling on the §10 person ladder (NAMED > PROFILE_LINKED > CREW_ONLY > ANONYMOUS_COUNT > HIDDEN) for everyone but the owner and the person themself. No row = no ceiling. Audience and location precision are NOT stored here: they stay on public.memories, joined in memory_visibility_policy_effective. Written by PUT /memories/:id/visibility-policy; read by services/memory/memoryVisibilityPolicy.ts (absent = no ceiling, unreadable = HIDDEN). service_role only.';

CREATE OR REPLACE VIEW public.memory_visibility_policy_effective
  WITH (security_invoker = true) AS
SELECT m.id                        AS memory_id,
       m.owner_id                  AS owner_id,
       m.visibility                AS visibility,
       m.allowed_user_ids          AS allowed_user_ids,
       m.hidden_user_ids           AS hidden_user_ids,
       m.location_precision        AS location_precision,
       p.person_visibility_ceiling AS person_visibility_ceiling,
       p.updated_at                AS person_visibility_ceiling_updated_at
  FROM public.memories m
  LEFT JOIN public.memory_visibility_policies p ON p.memory_id = m.id;

REVOKE ALL ON public.memory_visibility_policy_effective FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.memory_visibility_policy_effective TO service_role;

COMMENT ON VIEW public.memory_visibility_policy_effective IS
  'Spec §3 memory_visibility_policies as one relation (migration 3810, census H33): a Memory''s audience and location precision read from public.memories where they live, plus the owner''s person ceiling from memory_visibility_policies (NULL = none). security_invoker; service_role only. Read by the owner''s GET /memories/:id/visibility-policy.';

COMMIT;

-- ── Postconditions (a separate request on the live applier: catalog reads only,
--    nothing from the applying session, re-runnable on the committed database) ──
DO $post$
DECLARE
  v_leak text;
  v_cols text;
  v_rung text;
BEGIN
  -- The table, its keys and its cascades.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_visibility_policies') AND relkind = 'r') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policies was not created';
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.memory_visibility_policies'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'memory_id,owner_id,person_visibility_ceiling,updated_at' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policies has columns % — it must hold the ceiling only, never a copy of the audience or the precision (Q-H33)', v_cols;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memory_visibility_policies'::regclass
               AND attname IN ('memory_id', 'owner_id', 'person_visibility_ceiling', 'updated_at') AND NOT attnotnull) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): a memory_visibility_policies column is nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_visibility_policies'::regclass AND contype = 'p'
                   AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.memory_visibility_policies'::regclass AND attname = 'memory_id')]::int2[]) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_id is not the primary key (one policy per Memory)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_visibility_policies'::regclass AND contype = 'f'
                   AND confrelid = 'public.memories'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_id does not cascade from public.memories';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_visibility_policies'::regclass AND contype = 'f'
                   AND confrelid = 'auth.users'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): owner_id does not cascade from auth.users';
  END IF;
  FOREACH v_rung IN ARRAY ARRAY['NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_visibility_policies'::regclass
                     AND conname = 'memory_visibility_policies_person_ceiling_check'
                     AND pg_get_constraintdef(oid) LIKE '%''' || v_rung || '''%') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3810): the person ceiling CHECK does not admit %', v_rung;
    END IF;
  END LOOP;

  -- RLS on, no policy: service_role only.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_visibility_policies'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): RLS is not enabled on memory_visibility_policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_visibility_policies'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policies must carry no policy';
  END IF;

  -- The view: security_invoker, over both relations.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_visibility_policy_effective') AND relkind = 'v'
                   AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policy_effective is missing or not security_invoker';
  END IF;
  IF (SELECT count(DISTINCT d.refobjid) FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
       WHERE w.ev_class = 'public.memory_visibility_policy_effective'::regclass AND d.refclassid = 'pg_class'::regclass
         AND d.refobjid IN ('public.memories'::regclass, 'public.memory_visibility_policies'::regclass)) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policy_effective does not read both public.memories and memory_visibility_policies';
  END IF;

  -- No client role or PUBLIC holds anything on either relation, at table or column level.
  SELECT string_agg(format('%s %s:%s', c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO v_leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid IN ('public.memory_visibility_policies'::regclass, 'public.memory_visibility_policy_effective'::regclass)
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): a client role or PUBLIC holds a privilege: %', v_leak;
  END IF;
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ')
    INTO v_leak
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid, LATERAL aclexplode(a.attacl) x
   WHERE c.oid IN ('public.memory_visibility_policies'::regclass, 'public.memory_visibility_policy_effective'::regclass)
     AND a.attnum > 0 AND a.attacl IS NOT NULL
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): a client role or PUBLIC holds a column privilege: %', v_leak;
  END IF;
  SELECT string_agg(r || ' ' || t || ':' || p, ', ')
    INTO v_leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['public.memory_visibility_policies', 'public.memory_visibility_policy_effective']) t,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, t, p) OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r, t, p));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): a client role can use: %', v_leak;
  END IF;

  -- The API's role: the writer sets and clears; the view is read-only.
  SELECT string_agg(p, ', ') INTO v_leak
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE NOT has_table_privilege('service_role', 'public.memory_visibility_policies', p);
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): service_role lacks % on memory_visibility_policies', v_leak;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.memory_visibility_policy_effective', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): service_role cannot read memory_visibility_policy_effective';
  END IF;
  IF has_table_privilege('service_role', 'public.memory_visibility_policy_effective', 'INSERT')
     OR has_table_privilege('service_role', 'public.memory_visibility_policy_effective', 'UPDATE')
     OR has_table_privilege('service_role', 'public.memory_visibility_policy_effective', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810): memory_visibility_policy_effective is writable; the policy has one writer, the table';
  END IF;
  RAISE NOTICE '3810 postcondition: memory_visibility_policies (ceiling only) and the security_invoker view are service_role only.';
END $post$;
