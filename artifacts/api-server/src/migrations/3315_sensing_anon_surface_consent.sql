-- 3315_sensing_anon_surface_consent.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PER-CONTRIBUTION CONSENT FOR `surface` (census-sensing S39 / S24, §27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT
--   `surface_permitted boolean NOT NULL DEFAULT false` on
--   sensing_anon_contributions: whether THIS contribution's own contributor
--   agreed to it being shown to other people. Written by the ingest
--   (routes/sensingIngest.ts) from the session the contribution was presented
--   under — true only when that session's `purpose_scopes` (2480) contain
--   `surface`, which the session issuer (routes/sensingSession.ts) grants only
--   when the person's recorded consent covers it AND the policy in force does
--   (lib/sensingConsentScopes). The publisher (lib/sensingPublicationScheduler)
--   aggregates ONLY rows where it is true, so a cohort publishes only if at
--   least k contributors who each agreed to be surfaced are in it.
--
-- WHY A COLUMN AND NOT ONLY THE POLICY
--   The policy (`SENSING_ANON_GRANTED_SCOPES`) is the owner's ruling on what
--   this store may do. It cannot establish what any contributor agreed to.
--   Without this column, adding `surface` to the policy would surface every
--   contribution already stored — each collected under a disclosure that said
--   nothing about being shown to others. With it, the policy change surfaces
--   nothing that was not consented to, contribution by contribution.
--
-- DEFAULT FALSE, AND WHY THAT IS THE ONLY SAFE DEFAULT
--   Every existing row, every row from a client or server that predates this
--   column, and every row from a session without `surface` reads false. The
--   ingest omits the column when false, so a legacy-shape insert is unchanged
--   and a pre-3315 database still accepts it. The ingest can only write TRUE on
--   a database that has this column — and it only does so for a session that
--   carries `surface`, which no consent recorded today can produce.
--
-- THE PRIVACY ARGUMENT
--   One bit per row, shared by every contribution a consenting device makes.
--   It names no one, joins to nothing (the table still has no foreign key and
--   no identity-shaped column — 2315's name checks re-run below), and is never
--   published: aggregates carry counts over the rows it admits, not the bit.
--
-- Additive, idempotent. Rollback:
--   db/rollback/2026-09-26-3315-sensing-anon-surface-consent-rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.sensing_anon_contributions (2315) does not exist.';
  END IF;
END $$;

ALTER TABLE public.sensing_anon_contributions
  ADD COLUMN IF NOT EXISTS surface_permitted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sensing_anon_contributions.surface_permitted IS
  'Whether THIS contribution''s contributor consented to it being shown to other people (the `surface` purpose scope). Stamped by the ingest from the session''s purpose_scopes, which the issuer grants only when the recorded consent disclosure AND the policy in force both cover it. The publisher aggregates only rows where it is true. Default false: nothing stored before consent existed is ever surfaced.';

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_type text;
  v_nullable text;
  v_default text;
  v_col text;
  v_fks int;
BEGIN
  SELECT data_type, is_nullable, column_default INTO v_type, v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = 'surface_permitted';
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions.surface_permitted is absent.';
  END IF;
  IF v_type <> 'boolean' OR v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: surface_permitted must be boolean NOT NULL (found %, nullable=%); NULL must not be a third answer to "did this person agree".', v_type, v_nullable;
  END IF;
  IF v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: surface_permitted defaults to % rather than false; a default of anything else surfaces contributions nobody consented to.', v_default;
  END IF;

  -- No existing row may read true: this migration grants nothing.
  IF EXISTS (SELECT 1 FROM public.sensing_anon_contributions WHERE surface_permitted) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a contribution reads surface_permitted = true immediately after the column was added.';
  END IF;

  -- 2315's rulings, re-checked over the widened table.
  SELECT count(*) INTO v_fks FROM pg_constraint c
   WHERE c.conrelid = 'public.sensing_anon_contributions'::regclass AND c.contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key(s).', v_fks;
  END IF;
  FOREACH v_col IN ARRAY ARRAY[
    'user_id','actor_id','profile_id','account_id','auth_id','owner_id',
    'created_by','contributor_id','device_id','session_id','installation_id',
    'credential_hash','consent_version','consented_at'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has a column named %; consent is carried as one bit, never as a handle back to the session or the account.', v_col;
    END IF;
  END LOOP;
END $$;
