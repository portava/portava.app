-- Rollback for 3933_appeal_target_trust_restriction.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3933 DID: added 'trust_restriction' to public.appeal_target_type.
-- WHAT THIS ROLLBACK DOES:
--   * REFUSES while ANY appeal row holds 'trust_restriction'. That row is a
--     person's appeal of a restriction, and rewriting it to another target would
--     change what they appealed. The operator resolves those appeals
--     deliberately, before this runs.
--   * rebuilds the enum without the value (PostgreSQL cannot DROP an enum
--     value): rename, create the eleven-value type, move appeals.target_type
--     across (its UNIQUE (appellant_id, target_type, target_id) constraint is
--     rebuilt by the type change), drop the old type.
--   * deletes 3933's ledger row.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.appeals WHERE target_type::text = 'trust_restriction') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3933): an appeal targets a trust_restriction. Resolve those appeals deliberately first.';
  END IF;
END $$;

ALTER TYPE public.appeal_target_type RENAME TO appeal_target_type_3933;
CREATE TYPE public.appeal_target_type AS ENUM (
  'post', 'memory', 'highlight', 'account_warning', 'trust_score_event', 'no_show',
  'event', 'event_membership', 'trip', 'trip_membership', 'review'
);
ALTER TABLE public.appeals
  ALTER COLUMN target_type TYPE public.appeal_target_type USING target_type::text::public.appeal_target_type;
DROP TYPE public.appeal_target_type_3933;

DELETE FROM public.schema_migration_ledger WHERE filename = '3933_appeal_target_trust_restriction.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = 'appeal_target_type' AND e.enumlabel = 'trust_restriction') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3933 rollback): trust_restriction is still a value.';
  END IF;
END $post$;
