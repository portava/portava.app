-- 4091_telegraph_diagnostics_durable_audit.sql
-- Telegraph §30A.17 — the internal support tooling's audit becomes a DURABLE row.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T2 band 4090-4119.
--
-- Spec §30A.17, verbatim:
--   "Internal support tooling should expose delivery and projection diagnostics,
--    event IDs, conversation IDs, and authorized moderation context with
--    purpose-scoped access and audit logging rather than casual access to
--    private content."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T435 (BUILT-BUT-WRONG): "Ceiling: the audit is a structured LOG LINE, not a
--   durable row. admin_access_log constrains record_type to five values, none of
--   which is this, so a durable audit would need either a migration no database
--   has or mislabelling a diagnostics read as a profile read." This is that
--   migration: one more value in the CHECK, nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES
-- ══════════════════════════════════════════════════════════════════════════════
-- admin_access_log_record_type_check gains 'telegraph_diagnostics'. The five
-- existing values are kept verbatim, so no existing row can fail the new CHECK
-- (it is validated when re-added). The flag telegraph_diagnostics_durable_audit_enabled
-- is seeded FALSE: while it is off, GET /api/telegraph/diagnostics keeps its
-- audit LOG LINE and writes no row (a database without this file would refuse
-- the value). ON, every served read writes one row first and the read is
-- REFUSED if that row cannot be written — an unaudited read of the tooling is
-- the thing the clause rules out.
--
-- No table, no column, no grant. The row carries no private content: record_id
-- is the literal 'snapshot', reason is the admin's stated purpose.
--
-- ROLLBACK: db/rollback/2026-10-05-4091-telegraph-diagnostics-durable-audit-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.admin_access_log') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.admin_access_log must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

ALTER TABLE public.admin_access_log
  DROP CONSTRAINT IF EXISTS admin_access_log_record_type_check;
ALTER TABLE public.admin_access_log
  ADD CONSTRAINT admin_access_log_record_type_check
  CHECK (record_type = ANY (ARRAY['profile'::text, 'event'::text, 'trip'::text, 'gps_event'::text, 'check_in'::text, 'telegraph_diagnostics'::text]));

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_diagnostics_durable_audit_enabled', false,
   'CAPABILITY gate for the durable audit of GET /api/telegraph/diagnostics (Telegraph §30A.17). OFF (the seed): the read is audited by a structured log line only, as before. ON: every served read first writes an admin_access_log row (record_type telegraph_diagnostics, reason = the stated purpose), and the read is refused if the row cannot be written.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.admin_access_log'::regclass
     AND conname = 'admin_access_log_record_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: admin_access_log_record_type_check is missing.';
  END IF;
  IF position('telegraph_diagnostics' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the CHECK does not admit telegraph_diagnostics: %', v_def;
  END IF;
  IF position('profile' IN v_def) = 0 OR position('event' IN v_def) = 0 OR position('trip' IN v_def) = 0
     OR position('gps_event' IN v_def) = 0 OR position('check_in' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an existing record_type was dropped from the CHECK: %', v_def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_diagnostics_durable_audit_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_diagnostics_durable_audit_enabled was not seeded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_diagnostics_durable_audit_enabled' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_diagnostics_durable_audit_enabled must be seeded FALSE.';
  END IF;
END $post$;

COMMIT;
