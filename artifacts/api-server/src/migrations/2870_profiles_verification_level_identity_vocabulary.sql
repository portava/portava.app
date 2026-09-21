-- 2870_profiles_verification_level_identity_vocabulary.sql
--
-- ⚠ STAGED. NOT APPLIED TO ANY DATABASE BY THE LANE THAT WROTE IT.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2870 (Trust).
-- Idempotent. WIDENS ONE CHECK CONSTRAINT. Moves no row, drops no value, grants
-- nothing, flips no flag, and changes no behaviour on its own.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- `profiles.verification_level` accepts `'id_verified'` and
-- `'id_selfie_verified'` IN ADDITION TO the five values it already accepts:
-- 'none' | 'basic_verified' | 'trusted_traveler' | 'host_verified' |
-- 'buddy_verified'. Nothing is removed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — THE SUCCESS PATH OF IDENTITY VERIFICATION IS CURRENTLY UNWRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- `services/identityVerification/types.ts#toVerificationLevel` returns exactly
-- `'id_verified'` (ID only) or `'id_selfie_verified'` (ID + selfie liveness),
-- and `routes/verification.ts#applyVerifiedProfile` writes that value into
-- `profiles.verification_level` on every webhook that resolves to `verified`.
-- The live constraint permits NEITHER, so that write is rejected with 23514.
--
-- MEASURED, not inferred. Production `ajrurzioarfkagpuxfnb`, 2026-09-13,
-- read-only:
--
--   conname: profiles_verification_level_check
--   def:     CHECK ((verification_level = ANY (ARRAY['none'::text,
--              'basic_verified'::text,'trusted_traveler'::text,
--              'host_verified'::text,'buddy_verified'::text])))
--
-- The failure is not silent but it is unrecoverable without this file.
-- `applyVerifiedProfile` binds the error and throws (that much was fixed for
-- audit H5); `webhookHandler` turns the throw into a 5xx ON PURPOSE so the
-- provider retries rather than dropping the KYC result — and the retry writes
-- the same rejected value again. A real provider would loop until it
-- dead-lettered, and `profiles.verification_level` would stay `'none'` for a
-- user who completed a government-ID check and was billed for it.
--
-- What that column gates today, so the blast radius is stated rather than
-- implied: `lib/travelerVerification.ts:86-88` reads
-- `verification_level !== 'none'` as THE id-verified signal, and
-- `routes/rentABuddyRollout.ts` refuses a booking under MVP mode without it.
-- Rent-a-Buddy pairs strangers in person. The gate is not decorative.
--
-- Recorded as open audit item H5 on 2026-08-30
-- (docs/handoff/2026-08-30-session-handoff.md:117), proved on portava-ci there
-- ("`basic_verified` UPDATE succeeds, `id_verified` → 23514"), still open at
-- b7f137a4d. It survived because every verification test runs against an
-- injected fake client with no schema knowledge:
-- `src/test/verification.test.ts:280` asserts `id_verified` round-trips through
-- a double that would have accepted any string at all.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY WIDEN RATHER THAN RE-MAP THE SERVICE ONTO THE EXISTING FIVE
-- ══════════════════════════════════════════════════════════════════════════════
-- Mapping `id_verified` onto `basic_verified` would close the row without an
-- owner. The two vocabularies mean different things: the existing five are
-- PLATFORM standing (a trusted traveller, a verified host, a verified buddy),
-- granted by `routes/admin.ts`; the two added here are the OUTCOME OF A
-- GOVERNMENT-ID CHECK, and the verified-foundation plan distinguishes them by
-- design ("teal = ID verified, gold = ID + selfie"). Collapsing the second pair
-- into the first would make an admin-granted label indistinguishable from a
-- provider-attested one in the column every gate reads. That is a product
-- decision and it is listed for the owner (D-LEVEL-VOCAB), not taken here.
--
-- Widening takes no decision: it makes the value the code already writes
-- storable, and leaves every existing value and every existing row exactly as
-- it is.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED BEFORE WRITING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- Production, 2026-09-13, read-only aggregates: `identity_verifications` 0 rows,
-- `moderation_reports` 0, `moderation_actions` 0, `profiles` 58 of which 0 hold
-- a `verification_level` other than 'none'. There is therefore no row this
-- change can invalidate, and no row it changes. Widening a CHECK can only
-- accept more.
--
-- Postgres has no ALTER CHECK, so the drop and the add are one transaction.
-- The constraint is located by DEFINITION as well as by name, so a database
-- where a restore or a manual repair created it under another name is handled
-- rather than ending up with two constraints that disagree.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS FILE IS NOT SUFFICIENT FOR A WORKING VERIFICATION FLOW
-- ══════════════════════════════════════════════════════════════════════════════
-- It removes ONE blocker. Still open, and each is recorded in
-- docs/architecture/census-trust.md §12:
--   * no real provider adapter exists (both stubs throw) — TV-6b, and the owner
--     half TV-6a is blocked on a provider account;
--   * no `VerifiedBadge` component exists anywhere in the tree — TV-0e;
--   * the settings screen's level vocabulary is the OTHER five
--     (travel-buddy-standalone/app/profile/edit/safety.tsx:34-39), so an
--     `id_verified` user renders a blank label there — TRV2-12.
-- Applying this alone changes nothing a user sees, which is what makes it safe
-- to apply ahead of the rest.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   UPDATE public.profiles SET verification_level = 'none'
--     WHERE verification_level IN ('id_verified','id_selfie_verified');
--   ALTER TABLE public.profiles DROP CONSTRAINT profiles_verification_level_check;
--   ALTER TABLE public.profiles ADD CONSTRAINT profiles_verification_level_check
--     CHECK (verification_level = ANY (ARRAY['none','basic_verified',
--       'trusted_traveler','host_verified','buddy_verified']));
-- The UPDATE must run first or the narrowed constraint will not validate — and
-- it ERASES evidence of completed ID checks, so the rollback is only safe while
-- no such check has completed (0 such rows as measured above).
-- Rollback file: db/rollback/2026-09-13-2870-profiles-verification-level-identity-vocabulary.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on nothing but the existence of `public.profiles`. Independent of
-- 2163 (the privileged-write trigger for these columns), which is already
-- applied to production and is UNAFFECTED: that trigger governs WHO may write
-- the column; this constraint governs WHICH VALUES are storable. Both still
-- apply, in that order.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2870): public.profiles is missing.';
  END IF;
  PERFORM 1
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND column_name = 'verification_level';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2870): profiles.verification_level is missing.';
  END IF;
END $$;

-- ── Widen the constraint ─────────────────────────────────────────────────────
DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'profiles'
    AND c.contype  = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%verification_level%'
    AND pg_get_constraintdef(c.oid) LIKE '%buddy_verified%'
  LIMIT 1;

  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', conname_found);
  END IF;

  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_verification_level_check
    CHECK (verification_level = ANY (ARRAY[
      'none'::text,
      'basic_verified'::text,
      'trusted_traveler'::text,
      'host_verified'::text,
      'buddy_verified'::text,
      'id_verified'::text,
      'id_selfie_verified'::text
    ]));
END $$;

COMMENT ON COLUMN public.profiles.verification_level IS
  'Two vocabularies share this column and they are not interchangeable. '
  'basic_verified / trusted_traveler / host_verified / buddy_verified are '
  'PLATFORM standing granted by routes/admin.ts. id_verified / '
  'id_selfie_verified are the OUTCOME of a provider government-ID check, '
  'written only by routes/verification.ts#applyVerifiedProfile via '
  'toVerificationLevel(). Writes are restricted to privileged callers by '
  'trg_profiles_verification_privileged (migration 2163). Whether the two '
  'vocabularies should be merged, ranked, or split into separate columns is '
  'owner decision D-LEVEL-VOCAB (docs/architecture/census-trust.md §12.6).';

-- ── Postcondition: the two identity levels are storable, the five are kept ───
DO $$
DECLARE
  def TEXT;
  v   TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'profiles'
    AND c.conname = 'profiles_verification_level_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2870): profiles_verification_level_check is absent after the swap.';
  END IF;

  FOREACH v IN ARRAY ARRAY['none','basic_verified','trusted_traveler','host_verified',
                           'buddy_verified','id_verified','id_selfie_verified']
  LOOP
    IF position('''' || v || '''' in def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2870): % is not permitted by the new constraint: %', v, def;
    END IF;
  END LOOP;
END $$;

COMMIT;
