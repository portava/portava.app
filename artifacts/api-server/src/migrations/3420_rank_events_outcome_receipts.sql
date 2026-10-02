-- 3420_rank_events_outcome_receipts.sql
-- A keyed outcome lands once (census-discovery §62, DV-37; `04` §3 "idempotent
-- where retried").
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── THE DEFECT (census-discovery §59.1 DV-37, pinned by
--    src/test/db/discoveryVerifyChain.db.test.ts V7) ──────────────────────────
-- POST /rank-events/outcome without a recommendation_id moves "the most recent
-- upgradable row for (viewer, item, surface)". Compare-and-set makes two RACING
-- reports move one row, but when the item was served twice a sequential RETRY
-- finds the second exposure and moves it too: one "Not interested", two
-- dismisses, two negative signals. The server cannot tell a retry from a second
-- action without an identity for the action.
--
-- ── THE IDENTITY, AND HOW IT REUSES POST /rank-events' MECHANISM ────────────
-- POST /rank-events accepts `client_event_id` (a UUID the client mints once per
-- action and re-sends on every retry) and makes it the row's identity, so a
-- retry collides on a unique index (2891) and is answered as the duplicate it
-- is. An outcome does not INSERT a row — it UPDATEs an exposure whose
-- `recommendation_id` is the SERVED id (DV-46's join), so the key cannot live in
-- that column. It gets its own unique index instead:
--
--   rank_events.outcome_client_event_id uuid NULL
--     The key of the keyed outcome that last moved this row. Written only by
--     the outcome route's UPDATE, and only when the client sent a key.
--
--   public.rank_event_outcome_receipts, PRIMARY KEY (user_id, client_event_id)
--     One row per keyed outcome that landed. The primary key is the arbiter:
--     the same key cannot land twice for one viewer.
--
--   trigger rank_events_outcome_receipt (AFTER UPDATE OF outcome_client_event_id)
--     Writes the receipt IN THE SAME STATEMENT as the UPDATE that moves the
--     row. A retry that would move a SECOND exposure collides on the receipt's
--     key, the whole UPDATE is rolled back with 23505, and the route answers
--     `duplicate`. The receipt is a separate table, not a unique index on the
--     column alone, because a later keyed outcome on the same row (tap, then
--     save) overwrites the column; the receipt keeps the first key, so its
--     retry is still recognised.
--
-- A KEYLESS outcome is untouched: it writes no key, fires no trigger, and moves
-- the most recent upgradable exposure exactly as before. A genuine second
-- dismissal is still counted. Every client build shipped before the client half
-- of §62 sends keyless outcomes, and they still double-count on a retry after a
-- second serve; refusing them is a rollout decision (census-discovery §62.7).
--
-- ── `10` §4 — cardinality, indexes, EXPLAIN (docs/discovery/query-paths.md QP-25)
-- Cardinality: one receipt per KEYED outcome — at most the number of outcomes
-- rank_events records for the keyed client builds (production: 13 `discovery`
-- rows ever, 2026-09-27). No index but the primary key: its one read is the
-- route's lookup by (user_id, client_event_id), an Index Scan on the key, and
-- account erasure (ON DELETE CASCADE from auth.users), which the key's leading
-- column serves. The trigger fires only when an UPDATE names
-- outcome_client_event_id, which no writer but the keyed outcome route does, so
-- no existing write pays for it. ADD COLUMN of a nullable column with no
-- default is a catalogue change: no rewrite, no scan.
--
-- ── WHO MAY TOUCH IT ────────────────────────────────────────────────────────
-- The API as service_role: SELECT (the lookup), INSERT (the trigger runs as the
-- updating role), DELETE (erasure). No UPDATE: a receipt is immutable. No client
-- role holds any privilege, and every operation carries an explicit restrictive
-- `false` policy for anon and authenticated (3390's pattern, `10` §5).
--
-- Rollback: db/rollback/2026-09-27-3420-rank-events-outcome-receipts-rollback.sql
-- (drops the trigger, its function, the receipts and the column, and deletes
-- this file's ledger row; keyed retries become keyless again).

BEGIN;

DO $pre$
DECLARE
  id_type  text;
  uid_type text;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420): public.rank_events does not exist.';
  END IF;
  SELECT data_type INTO id_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'id';
  SELECT data_type INTO uid_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'user_id';
  IF id_type IS DISTINCT FROM 'uuid' OR uid_type IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420): rank_events.id / user_id are not uuid (%, %); resolve by hand.', id_type, uid_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'outcome_client_event_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420): rank_events.outcome_client_event_id already exists; 3420 is applied, or another lane got here first.';
  END IF;
  IF to_regclass('public.rank_event_outcome_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420): public.rank_event_outcome_receipts already exists.';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420): the anon / authenticated / service_role roles are not all present.';
  END IF;
END $pre$;

ALTER TABLE public.rank_events ADD COLUMN outcome_client_event_id uuid;

COMMENT ON COLUMN public.rank_events.outcome_client_event_id IS
  '3420 / census-discovery DV-37. The client_event_id of the keyed outcome that '
  'last moved this row (POST /rank-events/outcome). NULL for every keyless outcome '
  'and every row no outcome moved. Written only by routes/rankEvents.ts; each value '
  'written is recorded in rank_event_outcome_receipts by trigger, whose key refuses '
  'a second landing.';

CREATE TABLE public.rank_event_outcome_receipts (
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_event_id  uuid        NOT NULL,
  rank_event_id    uuid        NOT NULL,
  item_id          text        NOT NULL,
  surface          text        NOT NULL,
  outcome          text        NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rank_event_outcome_receipts_pkey PRIMARY KEY (user_id, client_event_id)
);

COMMENT ON TABLE public.rank_event_outcome_receipts IS
  '3420 / census-discovery DV-37. One row per KEYED outcome that landed on a '
  'rank_events exposure, written by trigger in the same statement. The primary key '
  '(user_id, client_event_id) is the idempotency arbiter: a retried outcome that '
  'would move a second exposure is refused 23505 and answered duplicate. '
  'rank_event_id is deliberately not a foreign key: a receipt outlives nothing but '
  'the user (ON DELETE CASCADE from auth.users). service_role only; immutable.';

ALTER TABLE public.rank_event_outcome_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rank_event_outcome_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.rank_event_outcome_receipts TO service_role;

-- `10` §5: every operation stated. No client reaches this table; each operation
-- is denied to each client role by a RESTRICTIVE false policy AND by privilege.
CREATE POLICY rank_event_outcome_receipts_deny_select_clients ON public.rank_event_outcome_receipts
  AS RESTRICTIVE FOR SELECT TO anon, authenticated USING (false);
CREATE POLICY rank_event_outcome_receipts_deny_insert_clients ON public.rank_event_outcome_receipts
  AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY rank_event_outcome_receipts_deny_update_clients ON public.rank_event_outcome_receipts
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY rank_event_outcome_receipts_deny_delete_clients ON public.rank_event_outcome_receipts
  AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);

CREATE FUNCTION public.rank_events_record_outcome_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- A value the row already carried is not a new landing.
  IF NEW.outcome_client_event_id IS NOT DISTINCT FROM OLD.outcome_client_event_id THEN
    RETURN NULL;
  END IF;
  -- The key: a second landing of one (user, client_event_id) raises 23505 on
  -- rank_event_outcome_receipts_pkey, which rolls back the UPDATE that fired it.
  INSERT INTO public.rank_event_outcome_receipts (user_id, client_event_id, rank_event_id, item_id, surface, outcome)
  VALUES (NEW.user_id, NEW.outcome_client_event_id, NEW.id, NEW.item_id, NEW.surface, NEW.outcome);
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.rank_events_record_outcome_receipt() IS
  '3420 / census-discovery DV-37. AFTER UPDATE OF outcome_client_event_id on '
  'rank_events: records the keyed outcome in rank_event_outcome_receipts, whose '
  'primary key refuses a second landing of one client event.';

REVOKE ALL ON FUNCTION public.rank_events_record_outcome_receipt() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER rank_events_outcome_receipt
  AFTER UPDATE OF outcome_client_event_id ON public.rank_events
  FOR EACH ROW
  WHEN (NEW.outcome_client_event_id IS NOT NULL)
  EXECUTE FUNCTION public.rank_events_record_outcome_receipt();

-- ── Behavioural postcondition, INSIDE the applying transaction ─────────────
-- It writes (rolled back by its own exception block), so it runs before COMMIT.
-- It needs one existing rank_events row; a database with none (a fresh harness)
-- skips it and says so — the harness suite db/discoveryVerifyChain V7 drives the
-- same arbitration through the real route.
DO $probe$
DECLARE
  r   record;
  k1  uuid := gen_random_uuid();
  k2  uuid := gen_random_uuid();
  n   int;
BEGIN
  SELECT id, user_id INTO r FROM public.rank_events LIMIT 1;
  IF r.id IS NULL THEN
    RAISE NOTICE '3420: rank_events is empty; the receipt probe is skipped.';
    RETURN;
  END IF;
  BEGIN
    UPDATE public.rank_events SET outcome_client_event_id = k1 WHERE id = r.id;
    SELECT count(*) INTO n FROM public.rank_event_outcome_receipts WHERE user_id = r.user_id AND client_event_id = k1 AND rank_event_id = r.id;
    IF n <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3420): a keyed UPDATE wrote % receipt(s), not 1.', n;
    END IF;
    UPDATE public.rank_events SET outcome_client_event_id = k2 WHERE id = r.id;   -- a later keyed outcome on the same row
    BEGIN
      UPDATE public.rank_events SET outcome_client_event_id = k1 WHERE id = r.id; -- the first key, landing a second time
      RAISE EXCEPTION 'POSTCONDITION FAILED (3420): a second landing of one client event was accepted.';
    EXCEPTION WHEN unique_violation THEN
      IF SQLERRM NOT LIKE '%rank_event_outcome_receipts_pkey%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3420): the second landing was refused by another constraint: %', SQLERRM;
      END IF;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P3420', MESSAGE = '3420 probe complete';
  EXCEPTION WHEN SQLSTATE 'P3420' THEN NULL;   -- everything above is rolled back
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate: they assert what persisted) ──────────────────
DO $post$
DECLARE
  rel  regclass := 'public.rank_event_outcome_receipts'::regclass;
  leak text;
  n    int;
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'outcome_client_event_id') IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): rank_events.outcome_client_event_id is absent or NOT NULL.';
  END IF;
  IF (SELECT count(*) FROM public.rank_events WHERE outcome_client_event_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): the probe left a key on a rank_events row.';
  END IF;
  IF (SELECT count(*) FROM public.rank_event_outcome_receipts) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): the probe left a receipt.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): RLS is not enabled on rank_event_outcome_receipts.';
  END IF;
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): a client role holds a privilege on rank_event_outcome_receipts: %.', leak;
  END IF;
  IF NOT (has_table_privilege('service_role', rel, 'SELECT') AND has_table_privilege('service_role', rel, 'INSERT')
          AND has_table_privilege('service_role', rel, 'DELETE')) OR has_table_privilege('service_role', rel, 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): service_role must hold exactly SELECT, INSERT and DELETE (no UPDATE) on the receipts.';
  END IF;
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid = rel AND NOT polpermissive AND polname LIKE 'rank_event_outcome_receipts_deny_%_clients';
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): % of the four restrictive client-deny policies exist.', n;
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.rank_events'::regclass AND tgname = 'rank_events_outcome_receipt' AND tgenabled = 'O';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): the receipt trigger is absent or disabled.';
  END IF;
  IF has_function_privilege('authenticated', 'public.rank_events_record_outcome_receipt()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rank_events_record_outcome_receipt()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420): a client role may EXECUTE the receipt trigger function.';
  END IF;
  -- rank_events' client posture is not this file's: 3390 revokes client DML
  -- where it is applied, and where it is not (production, 2026-09-27) no client
  -- UPDATE policy exists, so a client UPDATE moves no row and cannot set a key.
  -- Either way a key a client somehow set would fail the trigger's INSERT, which
  -- no client role may perform.
END $post$;
