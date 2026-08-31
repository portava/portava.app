-- 2213_memory_passport_controls.sql
--
-- Memory + Experience Intelligence — the §12 "What Portava Remembers" surface.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS ADDS, AND WHY
-- -----------------------
-- §12 requires a PRIVATE, owner-only area inside the user's own Passport that
-- shows the derived memory Portava holds about them, with per-item controls
-- (view source / correct / forget / visibility). The read side needs a row set
-- the existing readers do NOT assemble:
--
--   * memory_retrieve(...,'passport') returns an id but drops the
--     derived_preference class by policy (inferred preferences would vanish),
--     and it exposes neither provenance, sensitivity nor visibility — the exact
--     columns a transparency surface must show.
--   * memory_export_for_user(...) exposes sensitivity/visibility/derivation but
--     no projection id, no source_event_ids, and does not exclude social memory
--     about a since-deleted OTHER profile — a leak this surface must not make.
--
-- So this migration adds ONE read function, memory_remembers_for_user, that
-- assembles exactly the allow-listed, owner-safe derived memory with the fields
-- the controls need, and enforces the DENY boundary in SQL, fail-closed. It is
-- the single, auditable place the allow/deny boundary for derived memory lives.
--
-- It also adds memory_feedback.corrected_value so the "Correct" control can
-- record the value the user says is right alongside the 'incorrect' signal,
-- without a second table. Nothing existing changes behaviour; the column is
-- nullable and ignored by every current reader.
--
-- LEAST PRIVILEGE (the 2182/2190 rule, restated because it is load-bearing):
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every NEW public
-- function to anon AND authenticated. memory_remembers_for_user returns a user's
-- entire derived memory keyed by a CALLER-SUPPLIED id, so an anon/authenticated
-- grant would be a privacy oracle. It is REVOKEd from PUBLIC, anon, authenticated
-- and GRANTed only to service_role, and the postcondition below re-checks EVERY
-- memory_* / project_* function, not just the one added here.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL
     OR to_regclass('public.memory_feedback') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory contract (2183) missing.';
  END IF;
  IF to_regclass('public.memory_policy') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2192 first (memory_policy + sensitivity/visibility/source_event_ids).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='source_event_ids') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory_projections.source_event_ids missing — apply 2192.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='visibility') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory_projections.visibility missing — apply 2192.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='account_status') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles.account_status missing — the deleted-profile deny guard needs it.';
  END IF;
END $$;

-- ── Correction value for the "Correct" control (§17) ─────────────────────────
-- A user correcting an inferred preference records an 'incorrect' feedback row
-- (which the remembers read treats as a suppression, so the wrong value stops
-- surfacing and cannot be resurrected by re-projection) PLUS the value they say
-- is right. There was nowhere to put that value; this is it. Nullable, so every
-- existing feedback row and every existing writer is unaffected.
ALTER TABLE public.memory_feedback
  ADD COLUMN IF NOT EXISTS corrected_value text;

COMMENT ON COLUMN public.memory_feedback.corrected_value IS
  '§17 Correct: the value the user asserts is right, recorded alongside a kind=''incorrect'' signal. NULL for every other feedback kind. The remembers read treats ''incorrect'' as a suppression so the corrected-away value does not reappear after the projector''s next pass.';

-- ── memory_remembers_for_user(user) → the §12 allow-listed derived memory ─────
-- Returns ONLY the derived memory that is safe to show the owner about
-- themselves, with the provenance / sensitivity / visibility the controls need.
-- Every clause below is a DENY rule; adding a memory that does not pass all of
-- them is a leak, so the default is exclusion.
CREATE OR REPLACE FUNCTION public.memory_remembers_for_user(p_user_id uuid)
RETURNS TABLE (
  id                uuid,
  memory_type       text,
  subject_type      text,
  subject_id        text,
  content           text,
  confidence        real,
  is_inferred       boolean,
  observation_count integer,
  sensitivity       text,
  visibility        text,
  state             text,
  retention_class   text,
  valid_from        timestamptz,
  valid_to          timestamptz,
  last_supported_at timestamptz,
  derivation        text,
  source_event_ids  uuid[]
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    mp.id, mp.memory_type, mp.subject_type, mp.subject_id, mp.content, mp.confidence,
    -- §5.2 inferred vs stated: an inference is never shown as a stated fact.
    coalesce((mp.provenance->>'inferred')::boolean, mp.subject_type = 'inferred_interest') AS is_inferred,
    coalesce((mp.provenance#>>'{support,observations}')::int, 0)                           AS observation_count,
    mp.sensitivity, mp.visibility, mp.state, mp.retention_class,
    mp.valid_from, mp.valid_to, mp.last_supported_at,
    (mp.provenance->>'derivation')::text AS derivation,
    mp.source_event_ids
  FROM public.memory_projections mp
  LEFT JOIN public.memory_policy pol ON pol.retention_class = mp.retention_class
  WHERE mp.user_id = p_user_id
    -- ALLOW-LIST: only the real derived-memory taxonomy.
    AND mp.memory_type IN ('episodic','semantic','social','place','intent')
    -- DENY expired / non-current: only 'active', unexpired memory is "remembered".
    -- Drops decayed / hidden / forgotten / retracted in one clause.
    AND mp.state = 'active'
    AND (mp.valid_to IS NULL OR mp.valid_to > now())
    -- DENY sensitive: §19 sensitivity='sensitive' (e.g. social co-presence) is
    -- never surfaced here. This is the primary catch for sensitive traits.
    AND mp.sensitivity <> 'sensitive'
    -- DENY by policy: only classes the policy marks user_visible. This excludes
    -- historical_contribution (evidence, never presented as current state),
    -- short_lived tap/search context, and ephemeral intent — none of which are
    -- "what Portava remembers about you" in the §12 sense. Fail-closed: a class
    -- with no policy row is treated as NOT user-visible.
    AND pol.user_visible IS TRUE
    -- DENY sensitive-category inference (fail-closed, defence in depth). Inferred
    -- interests are keyed by a behavioural category (compass_user_preferences
    -- .category_weights keys, e.g. 'food','nightlife'); they are not supposed to
    -- carry health/sexuality/religion/ethnicity/finance/politics traits, but if a
    -- category key or its content ever reads as one, exclude it rather than risk
    -- surfacing an inferred sensitive trait.
    AND NOT (
      mp.subject_type = 'inferred_interest'
      AND (
        lower(coalesce(mp.subject_id, '')) ~ '(health|medical|illness|disease|mental|therapy|psych|sexual|lgbt|\mgay\M|lesbian|queer|\mbi\M|trans|religio|church|mosque|temple|islam|christ|jewish|\mjew\M|hindu|buddhis|ethnic|\mrace\M|racial|politic|election|abortion|\mincome\M|salary|\mdebt\M|bankrupt|\mfinanc|pregnan|disab|addict|hiv)'
        OR lower(coalesce(mp.content, '')) ~ '(health condition|medical|illness|disease|mental health|therapy|sexual orientation|lgbt|religio|ethnic|political|abortion|bankrupt|pregnan|addiction|\mhiv\M)'
      )
    )
    -- DENY another person's deleted data: social memory whose SUBJECT is another
    -- profile that has since been tombstoned (account_status='deleted'). B's
    -- deletion purges B's own memory (erase_memory_for_user, 2190) but NOT the
    -- memory A holds about B, so this is where "you know B" would otherwise leak a
    -- deleted person. Mirrors 2200's tombstone exclusion, at read time.
    AND NOT (
      mp.subject_type = 'user'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id::text = mp.subject_id
          AND p.account_status = 'deleted'
      )
    )
    -- DENY user-suppressed: forget / hide / incorrect. Matched by id OR the
    -- durable subject key, so a suppression SURVIVES a re-projection that
    -- replaced the row (2190) — this is what makes Forget block regeneration.
    AND NOT EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        AND ( f.projection_id = mp.id
              OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                  AND f.subject_id IS NOT DISTINCT FROM mp.subject_id
                  AND (f.memory_type IS NULL OR f.memory_type = mp.memory_type)) )
        AND f.kind IN ('hide','forget','incorrect')
    )
  ORDER BY mp.memory_type, mp.last_supported_at DESC NULLS LAST, mp.subject_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.memory_remembers_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_remembers_for_user(uuid) TO service_role;

COMMENT ON FUNCTION public.memory_remembers_for_user(uuid) IS
  '§12 "What Portava Remembers": the owner''s allow-listed derived memory with provenance/sensitivity/visibility for the transparency surface. Every WHERE clause is a deny rule (expired, non-active, sensitive, non-user-visible policy class, sensitive-category inference, deleted-subject social memory, user-suppressed forget/hide/incorrect); the default is exclusion. service_role only.';

-- ── Postcondition — prove it did what it claims, and stayed least-privilege ───
DO $$
BEGIN
  IF to_regprocedure('public.memory_remembers_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_remembers_for_user not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_feedback' AND column_name='corrected_value') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_feedback.corrected_value missing';
  END IF;
  -- The deny body must actually contain the sensitive + deleted-profile guards,
  -- so a future edit that drops one fails this migration rather than silently
  -- reopening a leak.
  IF position('sensitivity <> ''sensitive''' IN pg_get_functiondef('public.memory_remembers_for_user(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensitivity deny guard missing from memory_remembers_for_user';
  END IF;
  IF position('account_status = ''deleted''' IN pg_get_functiondef('public.memory_remembers_for_user(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: deleted-subject deny guard missing from memory_remembers_for_user';
  END IF;
  -- The DROP/CREATE default-grant trap (2190 lesson) — check EVERY memory/project fn.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memory%')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is executable by anon/authenticated (Supabase default grants after CREATE — re-REVOKE it)';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_remembers_for_user(uuid);
--   ALTER TABLE public.memory_feedback DROP COLUMN IF EXISTS corrected_value;
