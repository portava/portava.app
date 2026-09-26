-- Rollback for 3002_intel_contribution_identity.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- 3002 itself has not been applied to any database either; this file exists so
-- the forward change is reviewable as a pair, which is what "reviewed migration"
-- means in §22.
--
-- WHAT 3002 DID
-- =============
--   * CREATE TABLE intel_contributor_pepper (per-epoch HMAC pepper, no grants)
--   * CREATE FUNCTION intel_contributor_token_for_pepper / intel_contributor_token
--     / intel_assign_contributor_token / intel_self_contributor_tokens
--   * CREATE TRIGGER <t>_contributor_token BEFORE INSERT on intel_observations,
--     intel_evidence, intel_confirmations
--   * DROP the actor_id -> profiles foreign key and the actor_id NOT NULL on
--     those same three tables
--   * UPDATE every existing row: actor_id := intel_contributor_token(actor_id)
--   * intel_observations.subject_id: DROP NOT NULL (the places FK is KEPT),
--     widen intel_observations_subject_kind_check by 'temporary_world_object'
--     and 'unknown', add intel_observations_subject_resolution_check, add a
--     partial index on unowned rows
--   * re-key intel_observations_select_own / intel_confirmations_select_own to
--     the caller's own tokens
--   * CREATE OR REPLACE erase_intel_for_actor(uuid) as a token-aware superset
--     of 2278's version
--
-- ── THIS ROLLBACK IS PARTIAL, AND THE PART IT CANNOT DO IS THE POINT ────────
-- The relabelling in step 5 is ONE-WAY. A contributor token is sha256 over a
-- pepper; there is no inverse, and nothing anywhere records which account each
-- token came from — that absence IS the privacy property 3002 exists to create.
-- So this file CANNOT restore actor_id to profiles.id, and therefore CANNOT
-- restore `actor_id NOT NULL REFERENCES public.profiles(id)`: every relabelled
-- row would violate it instantly.
--
-- What that means in practice, stated so nobody discovers it at 3am:
--
--   * If 3002 was applied to a database holding ZERO contribution rows (which is
--     production's state today — every capture flag is off and public.places
--     holds no rows to observe), this rollback is COMPLETE. The guarded block
--     below restores the foreign key and the NOT NULL only in that case, and
--     refuses loudly otherwise rather than half-restoring a constraint.
--   * If rows exist, this rollback removes the MECHANISM (trigger, functions,
--     pepper) and the §18.3 subject widening, and leaves actor_id holding
--     tokens. Erasure for those rows is then IMPOSSIBLE, because dropping the
--     pepper table destroys the only way to re-derive a token from an account.
--     DO NOT RUN THE PEPPER DROP UNTIL THOSE ROWS HAVE BEEN ERASED OR SWEPT.
--     The block that drops it refuses while relabelled rows are still present.
--
-- Idempotent: every statement is IF EXISTS / guarded.

BEGIN;

-- ── 1. Remove the boundary first, so nothing new is tokenised ───────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_contributor_token', t);
  END LOOP;
END $$;

-- ── 2. §18.3 subject boundary, back to 2130's shape ─────────────────────────
-- Refuse rather than destroy: an unowned observation cannot be represented by
-- 2130's schema at all, so restoring NOT NULL would either fail or (if someone
-- "fixed" it) require inventing a place for it — the snap §14 forbids.
DO $$
DECLARE unowned bigint;
BEGIN
  IF to_regclass('public.intel_observations') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO unowned FROM public.intel_observations WHERE subject_id IS NULL;
  IF unowned > 0 THEN
    RAISE EXCEPTION
      'REFUSED: % observation(s) have subject_id IS NULL (§18.3 unknown / temporary_world_object). Restoring 2130''s NOT NULL would require assigning each one a place, which is exactly the nearest-place snap §14 and §18.3 forbid. Erase or re-home them deliberately first.', unowned;
  END IF;

  ALTER TABLE public.intel_observations
    DROP CONSTRAINT IF EXISTS intel_observations_subject_resolution_check;
  DROP INDEX IF EXISTS public.intel_observations_unowned_zone_claim_observed;

  ALTER TABLE public.intel_observations
    DROP CONSTRAINT IF EXISTS intel_observations_subject_kind_check;
  ALTER TABLE public.intel_observations
    ADD CONSTRAINT intel_observations_subject_kind_check
    CHECK (subject_kind IN ('experience','zone','neighborhood','route','event','service'));

  ALTER TABLE public.intel_observations ALTER COLUMN subject_id SET NOT NULL;
END $$;

-- ── 3. RLS back to 2130's `actor_id = auth.uid()` ───────────────────────────
DROP POLICY IF EXISTS intel_observations_select_own ON public.intel_observations;
CREATE POLICY intel_observations_select_own ON public.intel_observations
  FOR SELECT TO authenticated USING (actor_id = auth.uid());

DROP POLICY IF EXISTS intel_confirmations_select_own ON public.intel_confirmations;
CREATE POLICY intel_confirmations_select_own ON public.intel_confirmations
  FOR SELECT TO authenticated USING (actor_id = auth.uid());

-- ── 4. erase_intel_for_actor back to 2278's body ────────────────────────────
CREATE OR REPLACE FUNCTION public.erase_intel_for_actor(p_actor_id uuid)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'erase_intel_for_actor: actor id is required';
  END IF;

  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  DELETE FROM public.intel_scoped_trust WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_scoped_trust'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_attributions WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_attributions'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role;

-- ── 5. The account foreign key, ONLY if no relabelled row would break it ────
DO $$
DECLARE
  t         text;
  tokenised bigint;
BEGIN
  SELECT count(*) INTO tokenised
    FROM (
      SELECT actor_id FROM public.intel_observations  WHERE actor_id IS NOT NULL
      UNION ALL
      SELECT actor_id FROM public.intel_evidence      WHERE actor_id IS NOT NULL
      UNION ALL
      SELECT actor_id FROM public.intel_confirmations WHERE actor_id IS NOT NULL
    ) x
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = x.actor_id);

  IF tokenised > 0 THEN
    RAISE WARNING
      '3002 rollback: % contribution row(s) carry a contributor token, not an account id. The profiles foreign key and the actor_id NOT NULL are NOT restored — doing so would fail on every one of them, and the account id they came from is unrecoverable by design. The mechanism is removed; the identifiers stay pseudonymous.', tokenised;
  ELSE
    FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE CASCADE',
        t, t || '_actor_id_fkey');
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN actor_id SET NOT NULL', t);
    END LOOP;
  END IF;
END $$;

-- ── 6. The derivation, and last of all the pepper ───────────────────────────
-- Order matters: the pepper is what makes a token erasable. It goes only when
-- nothing is keyed to it.
DROP FUNCTION IF EXISTS public.intel_assign_contributor_token();
DROP FUNCTION IF EXISTS public.intel_self_contributor_tokens();
DROP FUNCTION IF EXISTS public.intel_contributor_token(uuid, timestamptz);

DO $$
DECLARE tokenised bigint;
BEGIN
  SELECT count(*) INTO tokenised
    FROM (
      SELECT actor_id FROM public.intel_observations  WHERE actor_id IS NOT NULL
      UNION ALL
      SELECT actor_id FROM public.intel_evidence      WHERE actor_id IS NOT NULL
      UNION ALL
      SELECT actor_id FROM public.intel_confirmations WHERE actor_id IS NOT NULL
    ) x
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = x.actor_id);

  IF tokenised > 0 THEN
    RAISE WARNING
      '3002 rollback: intel_contributor_pepper and intel_contributor_token_for_pepper are KEPT because % row(s) are still keyed to a token. Dropping them would make those rows permanently unerasable. Drop them by hand once retention has swept those rows.', tokenised;
  ELSE
    DROP FUNCTION IF EXISTS public.intel_contributor_token_for_pepper(uuid, integer, text);
    DROP TABLE IF EXISTS public.intel_contributor_pepper;
  END IF;
END $$;

COMMIT;
