-- 2261_passport_travel_dna_prefs.sql
--
-- Portava Passport §19 "Travel Identity". Stores a traveller's per-dimension
-- Show / Hide / Not-Me choices for their INFERRED Travel DNA (TABLE 20). The DNA
-- itself is never stored — it is projected on read from the canonical profiles
-- row plus light behavioural signals (PassportTravelIdentityService). This table
-- holds ONLY the user's own control state over how that inference is displayed,
-- so the projection stays "explainable and user-controlled" (§19) without the
-- inference becoming an editable profile fact (§12 — verified facts derive from
-- provenance, not editable fields).
--
-- ADDITIVE + IDEMPOTENT: one new table + one CAPABILITY flag seeded OFF. Touches
-- no existing table, column, policy, grant or enum. SAFE TO RE-RUN.
--
-- GRANT / RLS POSTURE: RLS on; a row is private to its owner — authenticated may
-- read AND write ONLY its own rows (auth.uid() = user_id); anon gets nothing.
-- Unlike a server-owned signal table, these ARE self-set client preferences, so
-- the client write grant is intentional (a future PATCH endpoint) and RLS
-- confines it to the caller's own subtree.
--
-- Behind flag `passport_travel_dna_enabled` (CAPABILITY, OFF): while OFF the
-- service reads no prefs and every dimension shows as the default ("shown"), so
-- shipping this migration changes nothing until the flag is turned on.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles missing.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags missing.';
  END IF;
END $$;

-- ── 1. Preferences table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passport_travel_dna_prefs (
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Dimension or trait key from PassportTravelIdentityService (e.g. 'travel_pace',
  -- 'night_explorer'). Free-form so new inferred dimensions need no migration.
  dimension_key TEXT        NOT NULL,
  state         TEXT        NOT NULL DEFAULT 'shown'
                            CHECK (state IN ('shown','hidden','not_me')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dimension_key)
);

CREATE INDEX IF NOT EXISTS passport_travel_dna_prefs_user_idx
  ON passport_travel_dna_prefs (user_id);

ALTER TABLE passport_travel_dna_prefs ENABLE ROW LEVEL SECURITY;

-- Owner-only read.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='passport_travel_dna_prefs'
      AND policyname='travel_dna_prefs_own_select'
  ) THEN
    CREATE POLICY travel_dna_prefs_own_select ON passport_travel_dna_prefs
      FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

-- Owner-only insert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='passport_travel_dna_prefs'
      AND policyname='travel_dna_prefs_own_insert'
  ) THEN
    CREATE POLICY travel_dna_prefs_own_insert ON passport_travel_dna_prefs
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Owner-only update.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='passport_travel_dna_prefs'
      AND policyname='travel_dna_prefs_own_update'
  ) THEN
    CREATE POLICY travel_dna_prefs_own_update ON passport_travel_dna_prefs
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Owner-only delete.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='passport_travel_dna_prefs'
      AND policyname='travel_dna_prefs_own_delete'
  ) THEN
    CREATE POLICY travel_dna_prefs_own_delete ON passport_travel_dna_prefs
      FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- Client grants: authenticated read+write (RLS scopes to own rows); anon none.
REVOKE ALL ON TABLE public.passport_travel_dna_prefs FROM anon;
REVOKE ALL ON TABLE public.passport_travel_dna_prefs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.passport_travel_dna_prefs TO authenticated;

COMMENT ON TABLE public.passport_travel_dna_prefs IS
  '§19 Travel DNA display control — per-dimension Show/Hide/Not-Me state, private '
  'to its owner (RLS auth.uid()=user_id). The DNA is projected on read; only this '
  'control state is stored. Gated by passport_travel_dna_enabled (OFF).';

-- ── 2. Capability flag, seeded OFF ───────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'passport_travel_dna_enabled',
    false,
    'CAPABILITY gate for stored Travel DNA Show/Hide/Not-Me preferences (§19). OFF '
    '(the seed): PassportTravelIdentityService reads no prefs and every inferred '
    'dimension/trait displays as the default "shown"; the passport_travel_dna_prefs '
    'table is inert. ON: the service reads a user''s stored prefs and hides '
    'dimensions the user marked hidden/not_me from non-owner views. Read fail-closed '
    '(isFlagEnabled) so an unreadable flag leaves prefs off.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE anon_privs text; auth_privs text; flag_on boolean;
BEGIN
  IF to_regclass('public.passport_travel_dna_prefs') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_travel_dna_prefs was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.passport_travel_dna_prefs'::regclass AND contype='p'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: primary key (user_id,dimension_key) missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname='passport_travel_dna_prefs' AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on passport_travel_dna_prefs';
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_travel_dna_prefs' AND grantee='anon';
  IF anon_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected no grants', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_travel_dna_prefs' AND grantee='authenticated';
  IF auth_privs <> 'DELETE,INSERT,SELECT,UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected DELETE,INSERT,SELECT,UPDATE', auth_privs;
  END IF;

  -- The flag MUST exist and MUST be OFF.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='passport_travel_dna_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_travel_dna_enabled not present after seed';
  END IF;
  SELECT enabled INTO flag_on FROM public.feature_flags WHERE flag='passport_travel_dna_enabled';
  IF flag_on THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_travel_dna_enabled seeded ON — must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.passport_travel_dna_prefs;
--   DELETE FROM public.feature_flags WHERE flag = 'passport_travel_dna_enabled';
