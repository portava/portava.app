-- 3933_appeal_target_trust_restriction.sql
-- Lane B (payments / identity / Trust), wave 3. Written, NOT applied to any
-- database by the lane that wrote it.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- public.appeal_target_type gains 'trust_restriction'. Nothing is written with
-- it here. No row, no flag, no grant and no other type changes.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- The owner, 2026-10-04:
--   OD-TRUST-4: "Show the user what is restricted, the reason at an appropriate
--   level of detail, duration or review timing, and a clear appeal path."
--   OD-TRUST-5: "preserve access to appeals".
-- A Trust restriction (public.trust_restrictions: hosting, private plans,
-- messaging, location plans) had no appeal target, so a restricted person could
-- only file an `account_warning` appeal, whose approval reverses nothing
-- (services/appeals/resolveAppeal.ts). With this value:
--   - POST /api/appeals accepts { targetType: 'trust_restriction', targetId: <the
--     restriction's id> }, only for the appellant's own ACTIVE restriction.
--   - On approval, resolveAppeal lifts exactly that restriction: the access that
--     decision removed, and nothing else (the owner's appeal-restoration ruling).
--   - GET /api/appeals/me/restrictions lists the person's active restrictions,
--     each with its D-24 sentence, its end (or "until reviewed"), and this
--     appeal path.
--
-- ── BEFORE THIS IS APPLIED ───────────────────────────────────────────────────
-- The INSERT fails with 22P02 (invalid input value for enum). routes/appeals.ts
-- answers that as 503 `appeal_target_unavailable`: "try again later", never
-- `db_error`, and never a silently filed `account_warning`. The list route reads
-- only trust_restrictions and works either way.
--
-- ALTER TYPE … ADD VALUE is not reversible by ALTER TYPE. The rollback rebuilds
-- the type without the value and REFUSES while any appeal holds it.
-- Rollback: db/rollback/2026-10-06-3933-appeal-target-trust-restriction-rollback.sql
BEGIN;
DO $pre$
BEGIN
  IF to_regtype('public.appeal_target_type') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3933): public.appeal_target_type does not exist.';
  END IF;
  IF to_regclass('public.trust_restrictions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3933): public.trust_restrictions does not exist; there is nothing to appeal.';
  END IF;
END
$pre$;

-- Inside the file's one transaction (PostgreSQL 12+, as 3350 and 3468 do): nothing below uses the new value before COMMIT.
ALTER TYPE public.appeal_target_type ADD VALUE IF NOT EXISTS 'trust_restriction';

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'appeal_target_type' AND e.enumlabel = 'trust_restriction') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3933): appeal_target_type lacks trust_restriction.';
  END IF;
  -- The eleven values the baseline declares are all still there.
  IF (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'appeal_target_type'
         AND e.enumlabel IN ('post', 'memory', 'highlight', 'account_warning', 'trust_score_event', 'no_show',
                             'event', 'event_membership', 'trip', 'trip_membership', 'review')) <> 11 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3933): an existing appeal_target_type value is missing.';
  END IF;
END $post$;
