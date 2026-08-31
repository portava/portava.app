-- 2252_hidden_gem_contributions.sql
--
-- Media v2 — Phase 8 (Hidden Gem Intelligence, §16.3). Adds the structured
-- gem-contribution OBSERVATION store: the nine §16.3 contribution types
-- (still_here / still_worth_it / access_changed / closed / too_crowded /
-- seasonal / harder_to_reach / better_entrance / no_longer_hidden). Each row is
-- an observation a traveller records against a gem. It feeds gem confidence and
-- the derived HiddenGemState — it is NEVER on its own an immediate canonical
-- state change (§16.3). No state/status column is flipped here.
--
-- ADDITIVE + IDEMPOTENT. New table only. No change to hidden_gems columns,
-- policies, grants, or enums (the 10-state HiddenGemState and the numeric gem
-- confidence are DERIVED at read time from existing signals + these rows, never
-- stored, so nothing can drift). Generated types for existing tables untouched.
--
-- GRANT POSTURE mirrors the sibling observation tables (hidden_gem_verifications,
-- hidden_gem_reports, 0043 + the 2147/2154 write-boundary work): RLS on;
-- authenticated may INSERT and read ONLY its own rows; anon gets nothing (a
-- contribution requires a signed-in traveller). Server aggregation runs on the
-- service-role client, which bypasses RLS. No client UPDATE/DELETE grant — the
-- observation timestamp is refreshed only via the service-role upsert path.
--
-- SAFE TO RE-RUN.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hidden_gems') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.hidden_gems missing — apply 0043_hidden_gems.sql first.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles missing.';
  END IF;
END $$;

-- ── hidden_gem_contributions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hidden_gem_contributions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gem_id            UUID NOT NULL REFERENCES hidden_gems(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contribution_type TEXT NOT NULL CHECK (contribution_type IN (
    'still_here', 'still_worth_it', 'access_changed', 'closed', 'too_crowded',
    'seasonal', 'harder_to_reach', 'better_entrance', 'no_longer_hidden'
  )),
  notes             TEXT CHECK (char_length(notes) <= 500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One observation of a given type per user per gem. Re-observing refreshes the
  -- timestamp (service-role upsert) so distinct-contributor counts stay honest
  -- and a single user cannot flood one type to force a state flip.
  UNIQUE (gem_id, user_id, contribution_type)
);

CREATE INDEX IF NOT EXISTS hidden_gem_contributions_gem_idx
  ON hidden_gem_contributions (gem_id);
CREATE INDEX IF NOT EXISTS hidden_gem_contributions_gem_type_idx
  ON hidden_gem_contributions (gem_id, contribution_type);

ALTER TABLE hidden_gem_contributions ENABLE ROW LEVEL SECURITY;

-- Caller reads only its own observations (aggregation is service-role).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='hidden_gem_contributions'
      AND policyname='hgc_obs_own_read'
  ) THEN
    CREATE POLICY hgc_obs_own_read ON hidden_gem_contributions
      FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='hidden_gem_contributions'
      AND policyname='hgc_obs_own_insert'
  ) THEN
    CREATE POLICY hgc_obs_own_insert ON hidden_gem_contributions
      FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());
  END IF;
END $$;

-- Client grants: authenticated INSERT + SELECT (RLS scopes to own rows); anon
-- nothing. No UPDATE/DELETE — the upsert refresh runs service-role.
REVOKE ALL ON TABLE public.hidden_gem_contributions FROM anon;
REVOKE ALL ON TABLE public.hidden_gem_contributions FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.hidden_gem_contributions TO authenticated;

COMMENT ON TABLE public.hidden_gem_contributions IS
  'Structured §16.3 gem contributions as OBSERVATIONS (nine types). Each row '
  'feeds derived gem confidence + HiddenGemState; it never flips canonical '
  'status/verification on its own. authenticated holds INSERT+SELECT (RLS = own '
  'rows only); anon none; aggregation + timestamp refresh are service-role.';

-- ── Postcondition — prove the table, constraint, and grant posture ───────────
DO $$
DECLARE anon_privs text; auth_privs text;
BEGIN
  IF to_regclass('public.hidden_gem_contributions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: hidden_gem_contributions was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.hidden_gem_contributions'::regclass AND contype='u'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: unique (gem_id,user_id,contribution_type) missing';
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gem_contributions' AND grantee='anon';
  IF anon_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected no grants', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gem_contributions' AND grantee='authenticated';
  IF auth_privs <> 'INSERT,SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected INSERT,SELECT', auth_privs;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.hidden_gem_contributions;
