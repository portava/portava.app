-- 2140_deletion_receipt.sql
-- Owner ruling 3 of 2026-08-23: Portava must be able to evidence its own
-- deletions without keeping the person it deleted.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- `user_id` is not merely part of user_deletion_requests' primary key — it IS
-- the key, the table's only identifying column. So the row cannot outlive the
-- person it is about: a record keyed by the identity you are erasing is erased
-- with it. The row proving a deletion was requested, scheduled and executed dies
-- in the act of executing, and no foreign-key rule can change that.
--
-- Meanwhile journey_revocation_jobs keeps an equivalent record for the Journey
-- scope and survives, because it has a surrogate id. The two disagreed about
-- whether Portava can show what it deleted.
--
-- ── THE SHAPE THE OWNER RULED ───────────────────────────────────────────────
-- An execution receipt that is evidence of an EVENT, not a record of a PERSON:
--   * independent deletion_request_id as the key
--   * user_id nullable, used only while processing, NULL on completion
--   * a random receipt code issued to the user, so THEY can refer to it
--   * request and completion timestamps
--   * policy and worker versions, so a receipt says which rules it ran under
--   * final status, per-domain deletion/tombstone counts, failure/retry codes
--   * no email, username, IP, device identifier, or stable subject hash
--
-- ── WHY THERE IS NO HASH, WHICH IS THE POINT ────────────────────────────────
-- The obvious design is a keyed hash of the user id, so completed receipts can
-- still be matched to a person "if we ever need to". The owner ruled that out
-- explicitly, and the ICO's anonymisation guidance is the reason: a stable hash
-- is reversible by anyone holding the key and the candidate set, so it is
-- PSEUDONYMOUS, and pseudonymous data is still personal data. A receipt that can
-- be relinked has not evidenced a deletion — it has recorded one, which is the
-- thing being deleted.
--
-- receipt_code is therefore RANDOM and unrelated to the user: gen_random_uuid()
-- text, generated per request. It identifies the deletion, not the deleted.
--
-- ── ON THE EXISTING DATA ────────────────────────────────────────────────────
-- Zero rows on production and zero on CI, so the primary key can be replaced
-- outright rather than migrated around. Verified before writing this, not
-- assumed — a PK swap on a populated table would need a different file.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.user_deletion_requests') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_deletion_requests does not exist.';
  END IF;
  SELECT count(*) INTO n FROM public.user_deletion_requests;
  IF n > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: user_deletion_requests holds % row(s). This file replaces the primary key outright, which is only safe while the table is empty. Migrate the rows deliberately instead.', n;
  END IF;
END $$;

-- ── 1. A key that is not a person ───────────────────────────────────────────
ALTER TABLE public.user_deletion_requests
  ADD COLUMN IF NOT EXISTS deletion_request_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.user_deletion_requests DROP CONSTRAINT IF EXISTS user_deletion_requests_pkey;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_pkey PRIMARY KEY (deletion_request_id);

-- ── 2. user_id becomes working state, not identity ──────────────────────────
ALTER TABLE public.user_deletion_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.user_deletion_requests DROP CONSTRAINT IF EXISTS user_deletion_requests_user_id_fkey;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── 3. The receipt, and what it records ─────────────────────────────────────
ALTER TABLE public.user_deletion_requests
  ADD COLUMN IF NOT EXISTS receipt_code    text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS policy_version  text,
  ADD COLUMN IF NOT EXISTS worker_version  text,
  ADD COLUMN IF NOT EXISTS deleted_counts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tombstoned_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS failure_code    text,
  ADD COLUMN IF NOT EXISTS retry_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at    timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS user_deletion_requests_receipt_code
  ON public.user_deletion_requests (receipt_code);
-- UNIQUE, not a plain index, and deliberately NOT partial.
--
-- routes/profile.ts:1456 creates a request with
--   .upsert({...}, { onConflict: "user_id" })
-- which needs a unique constraint on user_id to infer. Dropping the old primary
-- key would have broken the request-creation path with "no unique or exclusion
-- constraint matching the ON CONFLICT specification" — found by reading the
-- call sites before applying this, not after.
--
-- A plain UNIQUE on a nullable column is exactly the shape needed: Postgres
-- treats NULLs as distinct, so at most ONE live request per user coexists with
-- unlimited COMPLETED receipts whose user_id is NULL. A partial unique index
-- would not do — PostgREST cannot express the predicate ON CONFLICT needs.
CREATE UNIQUE INDEX IF NOT EXISTS user_deletion_requests_user_id
  ON public.user_deletion_requests (user_id);

-- The executor is staff; sever them like every other actor.
ALTER TABLE public.user_deletion_requests DROP CONSTRAINT IF EXISTS user_deletion_requests_executed_by_fkey;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_executed_by_fkey
  FOREIGN KEY (executed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON TABLE public.user_deletion_requests IS
  'A deletion EXECUTION RECEIPT: evidence that a deletion happened, not a record of who it happened to. Keyed by deletion_request_id. user_id is working state only and is NULL once status is completed. Deliberately holds no email, username, IP, device identifier or subject hash — a stable hash would be reversible and therefore pseudonymous, which is still personal data (owner ruling 3, 2026-08-23).';
COMMENT ON COLUMN public.user_deletion_requests.receipt_code IS
  'Random, unrelated to the user. Issued to them so they can refer to their deletion after their account is gone. It identifies the deletion, not the deleted.';
COMMENT ON COLUMN public.user_deletion_requests.user_id IS
  'Working state while the request is processed. Set to NULL on completion — and severed automatically if the profile goes first. A completed receipt must not name a person.';
COMMENT ON COLUMN public.user_deletion_requests.deleted_counts IS
  'Per-domain counts of rows erased, e.g. {"posts": 12, "messages": 0}. Counts, never identifiers.';
COMMENT ON COLUMN public.user_deletion_requests.tombstoned_counts IS
  'Per-domain counts of rows kept with identity severed. Together with deleted_counts this is what the receipt actually evidences.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  bad text := '';
  pk_cols text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO pk_cols
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
   WHERE c.conrelid='public.user_deletion_requests'::regclass AND c.contype='p';

  IF pk_cols IS DISTINCT FROM 'deletion_request_id' THEN
    bad := bad || format(' primary key is (%s), expected deletion_request_id;', coalesce(pk_cols,'none'));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='user_deletion_requests'
                AND column_name='user_id' AND is_nullable='NO') THEN
    bad := bad || ' user_id is still NOT NULL — a completed receipt could not drop it;';
  END IF;

  -- The ruling names these by category; refuse any column that would carry them.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='user_deletion_requests'
                AND column_name ~ '(email|username|handle|ip_address|device|user_hash|subject_hash)') THEN
    bad := bad || ' a forbidden identifying column is present (email/username/ip/device/hash);';
  END IF;

  -- The request-creation upsert infers a unique index on user_id. If this is
  -- missing, POST /me/delete-request fails at runtime rather than here, which is
  -- the worst place to discover it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='user_deletion_requests'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(user_id)%') THEN
    bad := bad || ' no UNIQUE index on user_id — routes/profile.ts upsert onConflict:user_id would fail;';
  END IF;

  -- The status the service actually writes must be writable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.user_deletion_requests'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%completed%') THEN
    bad := bad || ' status CHECK does not permit ''completed'', which AccountDeletionService writes;';
  END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED:%', bad;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Restoring user_id as the primary key restores the defect: the evidence of a
-- deletion becomes destructible by that deletion. Only unwind a bad apply.
