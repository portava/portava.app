-- ═══════════════════════════════════════════════════════════════════════════
-- 3003 — the four tables 3002 left bridging a contribution to an account
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 3002's own header names them and declines them, deliberately:
--
--   "Tables OUTSIDE this migration's scope still bridge an observation to an
--    account: intel_presence_verifications (2276), intel_attributions (2277),
--    intel_scoped_trust (2278) and intel_reward_ledger (2170) ... Until that
--    ruling, the §24 checklist item is satisfied for the contribution tables
--    and NOT for the intel family as a whole."
--
-- This is that ruling, and it is not four instances of one question. Measured
-- against production on 2026-09-25 (`ajrurzioarfkagpuxfnb`) rather than read
-- out of a migration file:
--
--   table                        exists in prod  observation link  actor_id FK
--   intel_presence_verifications  YES            observation_id     -> profiles
--   intel_attributions            NO  (2277)     observation_id     -> profiles
--   intel_scoped_trust            NO  (2278)     none (PK half)     -> profiles
--   intel_reward_ledger           YES            NONE AT ALL        -> profiles
--
-- REVERSE-LINKABILITY IS NOT THE SAME QUESTION AS "NAMES AN ACCOUNT". A table
-- that holds an account id and nothing that identifies a contribution cannot
-- resolve a tokenised contribution back to a person; a table that holds BOTH
-- can, with one join, and 3002's whole guarantee dies there. So the four split
-- two ways, and only the first group is changed.
--
-- ── 1. THE TWO THAT ARE ALREADY RECEIVING TOKENS, AND WOULD BREAK ───────────
-- This is the part that is a CORRECTNESS defect and not only a privacy ruling.
-- `intel_attributions.actor_id` is not written from a session, it is COPIED
-- from the observation it credits:
--
--   lib/intelAttributionScheduler.ts   .map((o) => ({ observationId: o.id, actorId: o.actor_id }))
--
-- and `o.actor_id` is a contributor TOKEN the moment 3002 lands. The column
-- REFERENCES profiles(id), so the very next attribution pass after 3002 would
-- have its INSERT rejected — 23503, every row, silently logged and skipped by
-- that scheduler's per-event catch. `intel_scoped_trust` folds those same rows
-- (lib/intelScopedTrustApply.ts writes `actor_id: next.actor_id`), so it
-- inherits the token and the same broken FK.
--
-- Dropping those two foreign keys is therefore not a weakening: the column has
-- already stopped being an account id by the time 3002 is applied, and the
-- constraint is asserting something that is no longer true. NO TRIGGER is added
-- to either — the value arrives already tokenised, and tokenising a token would
-- produce a second, wrong identity for the same contributor.
--
-- ── 2. THE ONE THAT IS THE ACTUAL REVERSE-LINK ─────────────────────────────
-- `intel_presence_verifications` is the one that matters for S118, and it is
-- the only one of the four that is BOTH live in production AND holds both ends:
-- `observation_id NOT NULL REFERENCES intel_observations(id)` next to
-- `actor_id NOT NULL REFERENCES profiles(id)`. Post-3002 it is a standing
-- lookup table from a tokenised observation to the account that made it — one
-- join, no pepper needed. Its writer supplies an account id directly
-- (services/intel/IntelCaptureService.ts recordPresenceVerification passes the
-- capture's actorId, not the stored one), so unlike the two above it needs the
-- same BEFORE INSERT trigger 3002 installs.
--
-- WHAT THE TOKEN COSTS IT: nothing it is for. The row exists to record that a
-- verification of a given LEVEL was reached for a given observation, so a later
-- reader can weigh that observation. Weighing does not need a name.
--
-- ── 3. THE ONE THAT IS RULED UNCHANGED, AND WHY THAT IS NOT A LOOPHOLE ─────
-- `intel_reward_ledger` KEEPS `actor_id -> profiles`. Two reasons, and the
-- second is the load-bearing one:
--
--   a) You cannot pay a token. A ledger that books money to a rotating
--      identifier whose pepper is deleted after retention is a ledger that
--      loses the payee, and §3's carve-out is written for exactly this: "unless
--      a narrowly justified, reviewed security requirement proves it
--      necessary". A financial obligation to a person is that.
--   b) IT CARRIES NO LINK TO A CONTRIBUTION. Measured: its columns are id,
--      actor_id, source, qiu, earned_units, cash_amount, ledger_version,
--      commercial_use_permission, created_at, idempotency_key,
--      reverses_entry_id. There is no observation_id, no claim_id and no
--      subject. So it cannot answer "who made this contribution" for any
--      contribution; it answers "what is owed to this account", which is a
--      different question with a different lawful basis.
--
-- That second reason is a property of the SCHEMA, and a property can be lost.
-- So it is not left as prose: the postcondition below RAISES if a column whose
-- name could carry a contribution reference is ever added to that table. The
-- day someone adds `observation_id` to the reward ledger, this migration's
-- successor has to rule again rather than inherit a ruling that was made about
-- a different table.
--
-- ── WHAT THIS DOES NOT CLOSE ───────────────────────────────────────────────
-- Stated rather than left to be inferred, because S118 is about the STORE and
-- not only about these four tables:
--
--   * The pepper is still readable inside the database by a superuser, and the
--     one-way property rests on no APPLICATION role holding it. 3002 says this.
--   * Deleting SPENT peppers is still not automated. Until an epoch's pepper is
--     gone, that epoch's tokens are re-derivable from an account by anything
--     that can execute intel_contributor_token(). 3002 records this as OWED and
--     this migration does not discharge it.
--   * The reward path must now map a token back to an account to pay anyone,
--     and it MUST NOT do that with a database-side resolver. The direction is
--     inverted in code instead — enumerate consenting accounts, derive their
--     tokens, match in the application — so the database never gains a
--     token -> account function. lib/intelRewardScheduler.ts carries that.
--
-- DEPENDS ON: 3002 (the token, the pepper table and the trigger function).
-- ROLLBACK:   db/rollback/2026-09-25-3003-intel-identity-bridges-rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. Refuse to run out of order
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regprocedure('public.intel_assign_contributor_token()') IS NULL THEN
    RAISE EXCEPTION
      '3003 requires 3002: public.intel_assign_contributor_token() does not exist. Apply 3002_intel_contribution_identity.sql first.';
  END IF;
  IF to_regclass('public.intel_contributor_pepper') IS NULL THEN
    RAISE EXCEPTION
      '3003 requires 3002: public.intel_contributor_pepper does not exist. Apply 3002_intel_contribution_identity.sql first.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. intel_presence_verifications — the reverse-link, closed
-- ═══════════════════════════════════════════════════════════════════════════
-- The table is live in production, so every step is written to be a no-op on a
-- database that already has it done, and the constraint is found by catalogue
-- lookup rather than by assuming its default name.
DO $$
DECLARE c text;
BEGIN
  IF to_regclass('public.intel_presence_verifications') IS NULL THEN
    RAISE NOTICE '3003: intel_presence_verifications absent (2276 not applied here) — skipping.';
    RETURN;
  END IF;

  -- (a) Convert the rows that already exist. Leaving them would mean the table
  -- still resolves OLD observations to accounts, which is the whole finding.
  -- The conversion uses the SAME derivation the trigger will use, so a row
  -- written before this migration and one written after carry the same token
  -- for the same contributor in the same epoch.
  PERFORM set_config('portava.erasure_in_progress', 'on', true);
  UPDATE public.intel_presence_verifications v
     SET actor_id = public.intel_contributor_token(v.actor_id, v.created_at)
   WHERE v.actor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v.actor_id);
  PERFORM set_config('portava.erasure_in_progress', 'off', true);

  -- (b) Drop the account foreign key, by lookup.
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'intel_presence_verifications'
       AND con.contype = 'f'
       AND con.confrelid = 'public.profiles'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.intel_presence_verifications DROP CONSTRAINT %I', c);
  END LOOP;

  -- (c) The boundary, so no writer can put an account id back.
  EXECUTE 'DROP TRIGGER IF EXISTS intel_presence_verifications_contributor_token ON public.intel_presence_verifications';
  EXECUTE 'CREATE TRIGGER intel_presence_verifications_contributor_token '
       || 'BEFORE INSERT ON public.intel_presence_verifications '
       || 'FOR EACH ROW EXECUTE FUNCTION public.intel_assign_contributor_token()';
END $$;

DO $$
BEGIN
  IF to_regclass('public.intel_presence_verifications') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.intel_presence_verifications.actor_id IS
      'NOT a profiles.id. Since 3003 this holds the same ROTATING, NON-REVERSIBLE CONTRIBUTOR TOKEN as intel_observations.actor_id, written by the intel_presence_verifications_contributor_token BEFORE INSERT trigger. Before 3003 this column plus observation_id was a standing lookup from a tokenised observation to the account that made it, which defeated 3002 in one join (census-sensing S118). Erasure goes through erase_intel_for_actor(uuid), which derives the token.'$c$;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. intel_attributions — the FK that would reject its own writer
-- ═══════════════════════════════════════════════════════════════════════════
-- No trigger and no row conversion: the value arrives from
-- intel_observations.actor_id, so it is ALREADY the token, and any row written
-- before 3002 already holds an account id that erase_intel_for_actor's account
-- arm still matches.
DO $$
DECLARE c text;
BEGIN
  IF to_regclass('public.intel_attributions') IS NULL THEN
    RAISE NOTICE '3003: intel_attributions absent (2277 not applied here) — skipping.';
    RETURN;
  END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'intel_attributions'
       AND con.contype = 'f'
       AND con.confrelid = 'public.profiles'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.intel_attributions DROP CONSTRAINT %I', c);
  END LOOP;
  EXECUTE $c$COMMENT ON COLUMN public.intel_attributions.actor_id IS
    'NOT a profiles.id. This column is COPIED from intel_observations.actor_id by lib/intelAttributionScheduler, so since 3002 it holds a rotating contributor token; 3003 removes the profiles foreign key that had started rejecting its own writer (23503 on every attribution row). No trigger: the value is already a token and tokenising it again would mint a second identity for the same contributor.'$c$;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. intel_scoped_trust — the same token, one fold further downstream
-- ═══════════════════════════════════════════════════════════════════════════
-- actor_id is half of this table's PRIMARY KEY (actor_id, scope_key). The
-- primary key is KEPT: scoped reliability is per contributor per scope and the
-- token is the contributor. Only the profiles reference goes.
DO $$
DECLARE c text;
BEGIN
  IF to_regclass('public.intel_scoped_trust') IS NULL THEN
    RAISE NOTICE '3003: intel_scoped_trust absent (2278 not applied here) — skipping.';
    RETURN;
  END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'intel_scoped_trust'
       AND con.contype = 'f'
       AND con.confrelid = 'public.profiles'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.intel_scoped_trust DROP CONSTRAINT %I', c);
  END LOOP;
  EXECUTE $c$COMMENT ON COLUMN public.intel_scoped_trust.actor_id IS
    'NOT a profiles.id. Folded from intel_attributions.actor_id, which is copied from intel_observations.actor_id, so since 3002 it is a rotating contributor token; 3003 removes the profiles foreign key. It remains half of the primary key: scoped reliability is per contributor per scope, and the token IS the contributor.'$c$;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. intel_reward_ledger — RULED UNCHANGED, and the ruling is guarded
-- ═══════════════════════════════════════════════════════════════════════════
-- No DDL. The comment records the ruling where a reader of the schema will find
-- it, and the postcondition below enforces the property the ruling rests on.
DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.intel_reward_ledger.actor_id IS
      'DELIBERATELY STILL A profiles.id, ruled by 3003 rather than overlooked. A payout is owed to a person and cannot be booked to a rotating token whose pepper is deleted after retention (§3''s "narrowly justified, reviewed security requirement" carve-out). This is safe ONLY because the table carries NO reference to any contribution — no observation_id, no claim_id, no subject — so it cannot resolve a tokenised contribution to an account. 3003''s postcondition RAISES if such a column is ever added; adding one requires a NEW ruling, not this one.'$c$;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Erasure — widened, because two of its arms were account-only by design
-- ═══════════════════════════════════════════════════════════════════════════
-- 3002's erase_intel_for_actor deletes scoped trust and attributions by ACCOUNT
-- ID alone, and says why: "the tables outside this migration's scope that
-- legitimately keep the account link (attributions, scoped trust)". They are
-- inside scope now, so account-only would erase nothing written after 3002 —
-- an erasure that silently misses is worse than one that fails. Both arms, the
-- same shape every other table in the function already uses.
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

  -- I4a derived state first: it references intel_attributions (cursor FK) and
  -- intel_attributions references intel_observations.
  DELETE FROM public.intel_scoped_trust WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_scoped_trust'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_attributions WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_attributions'; deleted_count := n; RETURN NEXT;

  -- 3003: the verification audit is tokenised too, so it needs both arms.
  DELETE FROM public.intel_presence_verifications WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_presence_verifications'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  -- The REWARD LEDGER is deliberately NOT deleted here and never was. It is a
  -- financial record with its own retention obligation, it is reversed rather
  -- than erased (services/ledger/RewardReversal.ts), and it names no
  -- contribution. Erasing intelligence contributions is not erasing what was
  -- owed for them.
  --
  -- Claims and snapshots are DERIVED and carry no actor column: they are
  -- aggregate beliefs about a place, not personal data, and are recomputed from
  -- the surviving observations.
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role;

COMMENT ON FUNCTION public.erase_intel_for_actor(uuid) IS
  'Single auditable erasure path for a user''s intelligence contributions (2130, widened by 2278, made token-aware by 3002, widened again by 3003). Derives the actor''s contributor token for every live epoch and removes scoped trust, attributions, presence verifications, evidence, confirmations and observations by account id OR token. The reward ledger is NOT erased — it is a financial record, reversed rather than deleted, and it names no contribution. Derived claims/snapshots are NOT deleted — they are aggregate and are recomputed.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Postconditions
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  fks       int;
  trig      int;
  bad_cols  text;
  leftover  int;
BEGIN
  -- (a) No bridge table references profiles any more.
  SELECT count(*) INTO fks
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'
     AND rel.relname IN ('intel_presence_verifications','intel_attributions','intel_scoped_trust')
     AND con.contype = 'f'
     AND con.confrelid = 'public.profiles'::regclass;
  IF fks <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % foreign key(s) from the intel bridge tables to profiles survive — the reverse-link is still open.', fks;
  END IF;

  -- (b) The boundary exists on the one table whose writer supplies an account.
  IF to_regclass('public.intel_presence_verifications') IS NOT NULL THEN
    SELECT count(*) INTO trig
      FROM pg_trigger tg
      JOIN pg_class rel ON rel.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'intel_presence_verifications'
       AND NOT tg.tgisinternal
       AND tg.tgname = 'intel_presence_verifications_contributor_token'
       AND (tg.tgtype & 2) <> 0   -- BEFORE
       AND (tg.tgtype & 4) <> 0   -- INSERT
       AND (tg.tgtype & 1) <> 0;  -- FOR EACH ROW
    IF trig <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: the BEFORE INSERT row trigger on intel_presence_verifications is missing — a writer could store an account id again.';
    END IF;

    -- (c) No row still holds something that is a profiles id.
    SELECT count(*) INTO leftover
      FROM public.intel_presence_verifications v
      JOIN public.profiles p ON p.id = v.actor_id;
    IF leftover <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: % presence verification row(s) still resolve to a profile — the conversion did not complete.', leftover;
    END IF;
  END IF;

  -- (d) THE RULING ON THE REWARD LEDGER IS A PROPERTY, NOT A PROMISE. It keeps
  -- its account link only because it cannot name a contribution. If it ever
  -- can, this migration's reasoning no longer applies to it and somebody has to
  -- rule again.
  IF to_regclass('public.intel_reward_ledger') IS NOT NULL THEN
    SELECT string_agg(a.attname, ', ') INTO bad_cols
      FROM pg_attribute a
      JOIN pg_class rel ON rel.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'intel_reward_ledger'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN ('observation_id','claim_id','subject_id','zone_id','evidence_id','confirmation_id','contribution_id');
    IF bad_cols IS NOT NULL THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: intel_reward_ledger now carries %, so it CAN resolve a tokenised contribution to an account. 3003 ruled its profiles foreign key acceptable precisely because it could not. Rule again before shipping this.', bad_cols;
    END IF;
  END IF;
END $post$;
