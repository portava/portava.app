-- 3703_sensing_consent_grants.sql
-- OD-MAP-6: three SEPARATE, separately revocable consents for passive sensing —
-- on-device capture, contribution upload, and showing aggregates to others —
-- none bundled with general app consent, each OFF until the person turns it on.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- The owner's ruling (docs/ops/owner-decisions-20261004.md, OD-MAP-6):
--
--   "Separate consent for on-device capture, contribution upload, and each
--    secondary use. Make it revocable; don't bundle it with general app
--    consent."
--
-- Passive sensing's only consent today is intel_contribution_consent (2172):
-- ONE row per person, one disclosure version. The v2 text written for passive
-- sensing (docs/contracts/sensing-consent-disclosure-v2.md) bundles capture,
-- upload and the `surface` secondary use into that one grant, which the ruling
-- forbids (census-sensing S24/S39). This table records each of the three as its
-- own grant, with the disclosure version the person was shown for THAT consent.
--
-- One row per (person, scope). Granted = withdrawn_at IS NULL. A withdrawal
-- keeps the row (granted_at and the version are the record of what was agreed)
-- and stamps withdrawn_at; a re-grant restamps granted_at and the version and
-- clears withdrawn_at. No row = never granted = OFF.
--
-- POSTURE. RLS on, NO policies, every client privilege revoked: the grants are
-- read and written only through the API (routes/sensingConsent.ts) as
-- service_role, which stamps the version — a client can never write the text it
-- claims to have agreed to.
--
-- ACCOUNT DELETION. user_id REFERENCES auth.users(id) ON DELETE CASCADE — the
-- wall_telemetry_events / input_outcome_consent mechanism: AccountDeletionService's
-- final auth.admin.deleteUser removes the rows (lib/deletionDispositions.ts).
--
-- THE FLAG. sensing_consent_split_enabled, seeded FALSE. Off: nobody can GRANT
-- (a withdrawal is always accepted — revocable means revocable), and the
-- sensing session issuer issues nothing. The wording is the lead's approved
-- draft and is PENDING LEGAL REVIEW (docs/ops/lead-rulings-20261006.md); the
-- flag is not turned on before that review signs off.
--
-- Rollback: db/rollback/2026-10-06-3703-sensing-consent-grants-rollback.sql
-- (refuses while the flag is TRUE; drops the table and the flag row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3703): public.feature_flags must exist.';
  END IF;
  IF to_regclass('public.sensing_consent_grants') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3703): public.sensing_consent_grants already exists; read it before re-running.';
  END IF;
END $pre$;

CREATE TABLE public.sensing_consent_grants (
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope              text        NOT NULL,
  disclosure_version text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  withdrawn_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope),
  CONSTRAINT sensing_consent_grants_scope_check CHECK (scope IN ('capture', 'upload', 'surface')),
  CONSTRAINT sensing_consent_grants_version_check CHECK (length(disclosure_version) BETWEEN 1 AND 64),
  CONSTRAINT sensing_consent_grants_withdrawn_after_granted CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

COMMENT ON TABLE public.sensing_consent_grants IS
  'OD-MAP-6: three separate, revocable passive-sensing consents per person (capture on the device, upload of contributions, showing aggregates to others). Granted = withdrawn_at IS NULL; no row = never granted. Written only by the API as service_role, which stamps disclosure_version.';

ALTER TABLE public.sensing_consent_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensing_consent_grants FROM PUBLIC;
REVOKE ALL ON public.sensing_consent_grants FROM anon;
REVOKE ALL ON public.sensing_consent_grants FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sensing_consent_grants TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'sensing_consent_split_enabled',
    FALSE,
    'OD-MAP-6 separate sensing consents (capture / upload / surface). Off: no grant can be recorded (withdrawals always can) and no sensing session is issued. Wording pending legal review.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.sensing_consent_grants') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): sensing_consent_grants was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sensing_consent_grants'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): RLS is not enabled on sensing_consent_grants.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.sensing_consent_grants'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): sensing_consent_grants has a policy; it must be service-role only.';
  END IF;
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.sensing_consent_grants'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): a client role holds privileges on sensing_consent_grants: %.', bad;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sensing_consent_grants', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.sensing_consent_grants', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.sensing_consent_grants', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): service_role cannot read and write sensing_consent_grants.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'sensing_consent_split_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3703): the sensing_consent_split_enabled flag row is missing.';
  END IF;
  RAISE NOTICE '3703 postcondition: sensing_consent_grants is service-role only; sensing_consent_split_enabled is seeded.';
END $post$;
