-- Rollback for 3003_intel_identity_bridges.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- 3003 itself has not been applied to any database either, and it cannot be
-- applied before 3002. This file exists so the forward change is reviewable as
-- a pair, which is what "reviewed migration" means in §22.
--
-- WHAT 3003 DID
-- =============
--   * intel_presence_verifications: converted every existing actor_id to the
--     contributor token, DROPped the actor_id -> profiles foreign key, and
--     installed the BEFORE INSERT trigger
--     intel_presence_verifications_contributor_token
--   * intel_attributions:  DROPped the actor_id -> profiles foreign key
--   * intel_scoped_trust:  DROPped the actor_id -> profiles foreign key
--     (both conditional on the table existing — 2277/2278 are unapplied in
--     production, so there both blocks are no-ops)
--   * intel_reward_ledger: NO DDL. Ruled unchanged, with a COMMENT and a
--     postcondition that RAISES if a contribution-shaped column appears.
--   * erase_intel_for_actor(uuid): CREATE OR REPLACE, widening the scoped-trust
--     and attributions arms to match on token OR account, and adding a
--     presence-verifications arm.
--
-- ── THIS ROLLBACK IS PARTIAL, FOR THE SAME REASON 3002'S IS ────────────────
-- The presence-verification conversion is ONE-WAY. `actor_id` now holds
-- sha256 over a pepper; there is no inverse, and nothing records which account
-- each token came from — that absence IS the privacy property. So this file
-- CANNOT put the account ids back, and therefore CANNOT restore the
-- actor_id -> profiles foreign key on intel_presence_verifications: re-adding
-- it would fail validation against rows whose values are not profiles ids, and
-- forcing it with NOT VALID would leave a constraint asserting something false.
--
-- What it CAN do, and does:
--   * remove the trigger, so new rows are stored as supplied again
--   * restore the two foreign keys on intel_attributions and intel_scoped_trust
--     ONLY IF every row in them still resolves to a profile — which is the case
--     exactly when no attribution pass has run since 3002. It refuses loudly
--     otherwise rather than leaving an unvalidated constraint.
--   * restore erase_intel_for_actor to 3002's arms
--
-- If the rows must be un-tokenised, the answer is a restore from a backup taken
-- before 3003, not this file. Saying so is the honest position; a rollback that
-- claims to undo a one-way function is not.

-- ── 1. The trigger comes off ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS intel_presence_verifications_contributor_token
  ON public.intel_presence_verifications;

-- ── 2. The two foreign keys, only where they can be honestly restored ──────
DO $$
DECLARE
  unresolvable int;
BEGIN
  IF to_regclass('public.intel_attributions') IS NOT NULL THEN
    SELECT count(*) INTO unresolvable
      FROM public.intel_attributions a
     WHERE a.actor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = a.actor_id);
    IF unresolvable > 0 THEN
      RAISE EXCEPTION
        'ROLLBACK REFUSED: % intel_attributions row(s) hold a contributor token, not an account id. Restoring the profiles foreign key would assert something false. Restore from a backup taken before 3003 instead.', unresolvable;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
       WHERE con.conrelid = 'public.intel_attributions'::regclass
         AND con.contype = 'f' AND con.confrelid = 'public.profiles'::regclass
    ) THEN
      ALTER TABLE public.intel_attributions
        ADD CONSTRAINT intel_attributions_actor_id_fkey
        FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    END IF;
  END IF;

  IF to_regclass('public.intel_scoped_trust') IS NOT NULL THEN
    SELECT count(*) INTO unresolvable
      FROM public.intel_scoped_trust s
     WHERE s.actor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = s.actor_id);
    IF unresolvable > 0 THEN
      RAISE EXCEPTION
        'ROLLBACK REFUSED: % intel_scoped_trust row(s) hold a contributor token, not an account id. Restore from a backup taken before 3003 instead.', unresolvable;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
       WHERE con.conrelid = 'public.intel_scoped_trust'::regclass
         AND con.contype = 'f' AND con.confrelid = 'public.profiles'::regclass
    ) THEN
      ALTER TABLE public.intel_scoped_trust
        ADD CONSTRAINT intel_scoped_trust_actor_id_fkey
        FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

-- ── 3. Erasure back to 3002's arms ─────────────────────────────────────────
-- Scoped trust and attributions revert to the ACCOUNT arm only, and the
-- presence-verifications arm is removed, exactly as 3002 shipped it.
CREATE OR REPLACE FUNCTION public.erase_intel_for_actor(p_actor_id uuid)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
  v_tokens uuid[];
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'erase_intel_for_actor: actor id is required';
  END IF;

  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  SELECT coalesce(array_agg(public.intel_contributor_token_for_pepper(p_actor_id, p.epoch, p.pepper)), ARRAY[]::uuid[])
    INTO v_tokens
    FROM public.intel_contributor_pepper p;

  DELETE FROM public.intel_scoped_trust WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_scoped_trust'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_attributions WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_attributions'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role;

COMMENT ON FUNCTION public.erase_intel_for_actor(uuid) IS
  'Single auditable erasure path for a user''s intelligence contributions (2130, widened by 2278, made token-aware by 3002). Declares portava.erasure_in_progress for the transaction, derives the actor''s contributor token for every live epoch, and removes their scoped trust, attributions, evidence, confirmations and observations by account id OR token. Derived claims/snapshots are NOT deleted — they are aggregate and are recomputed.';

-- ── 4. The comments 3003 wrote ─────────────────────────────────────────────
-- Left in place deliberately where the underlying fact is still true. The
-- presence-verification column IS still a token after this rollback (the
-- conversion is one-way), so a comment saying it is a profiles.id would be the
-- lie this file exists to avoid. Only the reward-ledger comment is dropped,
-- because its ruling was 3003's.
DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NOT NULL THEN
    EXECUTE 'COMMENT ON COLUMN public.intel_reward_ledger.actor_id IS NULL';
  END IF;
END $$;
