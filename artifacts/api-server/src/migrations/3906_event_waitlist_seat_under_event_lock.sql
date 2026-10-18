-- 3906_event_waitlist_seat_under_event_lock.sql
-- Events waitlist (census-trust, the waitlist corrections' "Still open": "Two
-- passes in the same instant can each offer one person for one seat"): a waitlist
-- OFFER is claimed, and an offer is ACCEPTED, only under the event row's lock, after
-- counting the seats. POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, gap
-- number 3906; docs/ops/wave5-owner-decisions-20261018.md "Migrations").
--
-- WRITTEN, NOT APPLIED. Additive: two functions. No table, column, row, policy,
-- grant on a table, or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT: check-then-write across two tables
-- ══════════════════════════════════════════════════════════════════════════════
-- routes/events.ts offers a freed seat to the queue in three steps over PostgREST:
-- "is an offer already live?" (hasActiveWaitlistOffer), "who is next?" (the queue
-- head, then the eligibility gate), then the claim — an UPDATE that re-asserts
-- `offer_expires_at IS NULL`. That last guard stops two claims of the SAME person
-- and nothing else. Pass A and pass B (two syncs, or a sync and a leave) both read
-- "no live offer"; A claims W1; B's head read lands after A's claim, finds W2, and
-- claims W2: two offers for one seat. Accepting is the same shape one table over:
-- two holders of live offers for the last seat both count `going < max_attendees`
-- and both upsert `going` — two seated in one seat.
-- A PostgREST UPDATE filter binds only its own table's columns: "claim this row
-- only if going + live offers < max_attendees" cannot be said in the claim's own
-- statement, and nothing in the schema serialises the passes (event_waitlist has
-- only PK (event_id, user_id) and UNIQUE (event_id, position)). Hence a function.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX: two functions, one lock, the count taken under it
-- ══════════════════════════════════════════════════════════════════════════════
--   public.claim_waitlist_seat(p_event_id uuid, p_user_id uuid, p_offer_expires_at timestamptz) -> text
--     Locks the event row; when max_attendees is set, counts `going` RSVPs plus
--     LIVE offers (offer_expires_at > now(), hasActiveWaitlistOffer's predicate);
--     only when that is below max_attendees does it claim the named person's
--     queue row (offer_expires_at IS NULL -> p_offer_expires_at). Answers:
--       claimed    the offer is theirs
--       no_seat    going + live offers >= max_attendees: nothing written
--       contended  the row was not claimable (already offered, or gone): nothing written
--       no_event   no such event: nothing written
--     WHICH person is the caller's: the eligibility gate (blocks, bans, trust,
--     age, private-event membership) stays in routes/events.ts
--     (pickEligibleWaitlisted); this function decides only WHETHER a seat is free.
--     An event with no max_attendees has no capacity to count: the claim proceeds
--     exactly as the route's unconditional claim does today.
--   public.accept_waitlist_seat(p_event_id uuid, p_user_id uuid) -> text
--     Locks the event row; refuses an event that is not live (open / full /
--     waitlist), a person who is not queued, holds no offer or holds a lapsed one;
--     when max_attendees is set, refuses when `going` >= max_attendees (the route's
--     own overbooking check); otherwise upserts the `going` RSVP and deletes the
--     queue row, both or neither. Answers: seated | no_seat | not_live |
--     not_queued | no_offer | expired | no_event. Only `seated` writes.
--
-- WHY ONE ROW LOCK SERIALISES IT. Both functions take the SAME lock on the SAME
-- row (SELECT ... FROM public.events WHERE id = p_event_id FOR NO KEY UPDATE)
-- before they read a count, and each SQL statement after the lock takes a fresh
-- snapshot under READ COMMITTED (both are VOLATILE plpgsql). So the second of two
-- racing calls waits for the first to commit and then COUNTS the first one's
-- offer or seat. Under a transaction snapshot (REPEATABLE READ / SERIALIZABLE) the
-- count after the lock would not see the racer: both functions REFUSE to run at any
-- isolation but READ COMMITTED (3415's rule for trail_propose) rather than decide
-- without the guarantee. PostgREST runs an RPC at READ COMMITTED.
-- FOR NO KEY UPDATE, not FOR UPDATE: it conflicts with itself, with FOR UPDATE and
-- with every UPDATE or DELETE of the event row (a cancel, a capacity edit, the
-- route's own count writes), which is all the serialisation needs; unlike FOR
-- UPDATE it does not block the FOR KEY SHARE that every INSERT into a child table
-- (event_rsvps, event_waitlist, event_roles, ...) takes on the event row for its
-- foreign key, so an unrelated RSVP elsewhere on the event never queues behind a
-- claim, and an RSVP racing an accept for the SAME person cannot deadlock with it.
--
-- WHAT IT DOES NOT CLOSE (stated): only the two route paths that call these
-- functions are serialised. The background sweeper (lib/eventWaitlistSweeper.ts)
-- still claims with its own unlocked UPDATE, and the admissions that take a seat
-- without the queue (POST /rsvp, the join-request approvals, PATCH attendee
-- status) still count outside the lock; each can interleave with a locked call.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SECURITY (house form: 3415 trail_propose, 3977 trail_review_decide)
-- ══════════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER, search_path pinned to pg_catalog, every object
-- schema-qualified. Neither needs definer rights: the one caller is the API's
-- service client (service_role), which already holds ALL on the three tables and
-- bypasses their RLS, so the function reads and writes exactly what the route's
-- own PostgREST statements do today. A client role must not call either: both
-- take the person as an argument. EXECUTE is revoked from PUBLIC, anon and
-- authenticated and granted to service_role.
--
-- THE CODE HALF (routes/events.ts, appended section "Wave 5 follow-up B4"):
-- promoteNextWaitlisted and POST /events/:id/waitlist/accept call these through
-- `.rpc()` once a side-effect-free probe (a nil event id: answers no_event, writes
-- nothing) has seen the function answer. Absent (PGRST202 / 42883, production
-- today) or not established, they run exactly today's statements. Present, a
-- failed call is a failure: the seat is HELD (claim) or the accept answers 503,
-- never the unlocked path.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRECONDITION / POSTCONDITION
-- ══════════════════════════════════════════════════════════════════════════════
-- PRECONDITION ($pre$, refuses, changes nothing):
--   public.events (id uuid, max_attendees integer, state public.event_state),
--   public.event_rsvps (event_id uuid, user_id uuid, status
--   public.event_rsvp_status, updated_at timestamptz) with a unique key on exactly
--   (event_id, user_id) for the upsert, public.event_waitlist (event_id uuid,
--   user_id uuid, offer_expires_at timestamptz); the labels 'going' and 'open',
--   'full', 'waitlist'; the roles service_role, anon, authenticated; service_role's
--   own privileges for what the functions do (SECURITY INVOKER: SELECT + UPDATE on
--   events — the row lock needs UPDATE — SELECT + INSERT + UPDATE on event_rsvps,
--   SELECT + UPDATE + DELETE on event_waitlist); and no function of either name
--   that this file did not make (another signature, or the same one without this
--   file's comment).
-- POSTCONDITION ($post$, after COMMIT, assertion-only): both functions exist with
--   these signatures, return text, are VOLATILE, SECURITY INVOKER, search_path =
--   pg_catalog; anon, authenticated and PUBLIC cannot EXECUTE them; service_role
--   can; each body takes the event row lock and counts under it; each carries its
--   3906 comment; and both run — a nil event id answers `no_event` from each,
--   writing nothing (the probe the route sends).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3906 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on baseline objects (baseline/20260819_baseline_structure.sql):
-- public.events, public.event_rsvps (+ event_rsvps_pkey), public.event_waitlist,
-- the enums public.event_state and public.event_rsvp_status, and the roles. No
-- file numbered above 3906 (3930-3933, 3970-3983, 3986-3999 at writing) names
-- events, event_rsvps, event_waitlist, max_attendees, offer_expires_at, either
-- enum, either function, ALL FUNCTIONS, DEFAULT PRIVILEGES or any role change:
-- nothing above alters, drops or redefines what this file reads or creates
-- (grep evidence in the lane handback). It creates no object anything else names.
--
-- LOCKS taken by applying it: none on a table (CREATE FUNCTION only).
--
-- ROLLBACK (the code half then sees PGRST202 / 42883 and runs today's statements;
-- reload PostgREST's schema cache so it stops answering from the cached function):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.claim_waitlist_seat(uuid, uuid, timestamptz);
--   DROP FUNCTION IF EXISTS public.accept_waitlist_seat(uuid, uuid);
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3906_event_waitlist_seat_under_event_lock.sql';
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

DO $pre$
DECLARE
  v_fn text;
BEGIN
  IF to_regclass('public.events') IS NULL OR to_regclass('public.event_rsvps') IS NULL OR to_regclass('public.event_waitlist') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): public.events, public.event_rsvps and public.event_waitlist must exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.events'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'max_attendees' AND atttypid = 'integer'::regtype)
           OR (attname = 'state' AND atttypid = to_regtype('public.event_state')))) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): public.events must carry id uuid, max_attendees integer and state public.event_state.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.event_rsvps'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'event_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'user_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'status' AND atttypid = to_regtype('public.event_rsvp_status'))
           OR (attname = 'updated_at' AND atttypid = 'timestamptz'::regtype))) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): public.event_rsvps must carry event_id uuid, user_id uuid, status public.event_rsvp_status and updated_at timestamptz.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.event_waitlist'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'event_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'user_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'offer_expires_at' AND atttypid = 'timestamptz'::regtype))) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): public.event_waitlist must carry event_id uuid, user_id uuid and offer_expires_at timestamptz.';
  END IF;
  -- The upsert's ON CONFLICT (event_id, user_id) needs a unique index on exactly those columns.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.event_rsvps'::regclass AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
       AND i.indnkeyatts = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM pg_attribute a
             WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])) = ARRAY['event_id', 'user_id']
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): public.event_rsvps has no unique key on exactly (event_id, user_id); the accept''s upsert would fail.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'public.event_rsvp_status'::regtype AND enumlabel = 'going')
     OR (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.event_state'::regtype AND enumlabel IN ('open', 'full', 'waitlist')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): event_rsvp_status must have ''going'' and event_state ''open'', ''full'' and ''waitlist''.';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): the roles service_role, anon and authenticated must exist.';
  END IF;
  -- SECURITY INVOKER: the caller's own privileges do the work. The row lock needs UPDATE on events.
  IF NOT (has_table_privilege('service_role', 'public.events', 'SELECT') AND has_table_privilege('service_role', 'public.events', 'UPDATE')
          AND has_table_privilege('service_role', 'public.event_rsvps', 'SELECT') AND has_table_privilege('service_role', 'public.event_rsvps', 'INSERT')
          AND has_table_privilege('service_role', 'public.event_rsvps', 'UPDATE')
          AND has_table_privilege('service_role', 'public.event_waitlist', 'SELECT') AND has_table_privilege('service_role', 'public.event_waitlist', 'UPDATE')
          AND has_table_privilege('service_role', 'public.event_waitlist', 'DELETE')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): service_role must hold SELECT and UPDATE on events, SELECT, INSERT and UPDATE on event_rsvps, and SELECT, UPDATE and DELETE on event_waitlist (both functions are SECURITY INVOKER).';
  END IF;
  -- A function of either name must be this file's own (a re-run), or absent.
  SELECT min(format('public.%s(%s)', p.proname, oidvectortypes(p.proargtypes))) INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('claim_waitlist_seat', 'accept_waitlist_seat')
     AND (format('%s(%s)', p.proname, oidvectortypes(p.proargtypes)) NOT IN ('claim_waitlist_seat(uuid, uuid, timestamp with time zone)', 'accept_waitlist_seat(uuid, uuid)')
          OR coalesce(obj_description(p.oid, 'pg_proc'), '') NOT LIKE '3906 %');
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3906): a function % exists that this migration did not make. Refusing to replace it.', v_fn;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.claim_waitlist_seat(p_event_id uuid, p_user_id uuid, p_offer_expires_at timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_max   integer;
  v_going bigint;
  v_live  bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'claim_waitlist_seat requires READ COMMITTED (this transaction is %): under a transaction snapshot the count after the event lock cannot see a racing claim', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_offer_expires_at IS NULL OR p_offer_expires_at <= now() THEN
    RAISE EXCEPTION 'claim_waitlist_seat: an event, a person and an offer expiry in the future are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The lock every claim and accept on this event takes first: the second of two racing calls waits here.
  SELECT e.max_attendees INTO v_max FROM public.events AS e WHERE e.id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_event';
  END IF;

  -- Counted under the lock (each statement a fresh READ COMMITTED snapshot): a racer's committed offer is seen here.
  IF v_max IS NOT NULL THEN
    SELECT count(*) INTO v_going FROM public.event_rsvps AS r WHERE r.event_id = p_event_id AND r.status = 'going';
    SELECT count(*) INTO v_live FROM public.event_waitlist AS w WHERE w.event_id = p_event_id AND w.offer_expires_at > now();
    IF v_going + v_live >= v_max THEN
      RETURN 'no_seat';
    END IF;
  END IF;

  UPDATE public.event_waitlist AS w
     SET offer_expires_at = p_offer_expires_at
   WHERE w.event_id = p_event_id AND w.user_id = p_user_id AND w.offer_expires_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'contended';
  END IF;
  RETURN 'claimed';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.accept_waitlist_seat(p_event_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_state text;
  v_max   integer;
  v_offer timestamptz;
  v_going bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'accept_waitlist_seat requires READ COMMITTED (this transaction is %): under a transaction snapshot the count after the event lock cannot see a racing accept', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'accept_waitlist_seat: an event and a person are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The same lock as claim_waitlist_seat: accepts, and claims, on one event are taken one at a time.
  SELECT e.state::text, e.max_attendees INTO v_state, v_max FROM public.events AS e WHERE e.id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_event';
  END IF;
  IF v_state NOT IN ('open', 'full', 'waitlist') THEN
    RETURN 'not_live';
  END IF;

  SELECT w.offer_expires_at INTO v_offer FROM public.event_waitlist AS w
   WHERE w.event_id = p_event_id AND w.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_queued';
  END IF;
  IF v_offer IS NULL THEN
    RETURN 'no_offer';
  END IF;
  IF v_offer <= now() THEN
    RETURN 'expired';
  END IF;

  -- The route's overbooking check, counted under the lock: a racing accept's committed seat is seen here.
  IF v_max IS NOT NULL THEN
    SELECT count(*) INTO v_going FROM public.event_rsvps AS r WHERE r.event_id = p_event_id AND r.status = 'going';
    IF v_going >= v_max THEN
      RETURN 'no_seat';
    END IF;
  END IF;

  INSERT INTO public.event_rsvps AS r (event_id, user_id, status, updated_at)
  VALUES (p_event_id, p_user_id, 'going', now())
  ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going', updated_at = now();
  DELETE FROM public.event_waitlist AS w WHERE w.event_id = p_event_id AND w.user_id = p_user_id;
  RETURN 'seated';
END;
$fn$;

COMMENT ON FUNCTION public.claim_waitlist_seat(uuid, uuid, timestamptz) IS
  '3906 (census-trust, events waitlist): claim one waitlist offer only while a seat is free. Locks the event row (FOR NO KEY UPDATE), counts going RSVPs plus live offers (offer_expires_at > now()) against max_attendees, and only below it sets the named person''s offer_expires_at (IS NULL -> the expiry given). Answers claimed | no_seat | contended | no_event; only claimed writes. The eligibility pick stays in routes/events.ts (promoteNextWaitlisted). READ COMMITTED only. SECURITY INVOKER, search_path pg_catalog, EXECUTE for service_role only.';
COMMENT ON FUNCTION public.accept_waitlist_seat(uuid, uuid) IS
  '3906 (census-trust, events waitlist): accept a waitlist offer only while a seat is free. Locks the event row (FOR NO KEY UPDATE, the same lock as claim_waitlist_seat), refuses a non-live event, a person not queued, without an offer or with a lapsed one, and refuses when going RSVPs >= max_attendees; otherwise upserts the going RSVP and deletes the queue row together. Answers seated | no_seat | not_live | not_queued | no_offer | expired | no_event; only seated writes. READ COMMITTED only. SECURITY INVOKER, search_path pg_catalog, EXECUTE for service_role only.';

REVOKE ALL ON FUNCTION public.claim_waitlist_seat(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_waitlist_seat(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_seat(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_waitlist_seat(uuid, uuid) TO service_role;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ─────────────
DO $post$
DECLARE
  f   text;
  def text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.claim_waitlist_seat(uuid,uuid,timestamptz)', 'public.accept_waitlist_seat(uuid,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): % is absent.', f;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(f)
         AND NOT p.prosecdef AND p.provolatile = 'v' AND p.prorettype = 'text'::regtype
         AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog' = ANY (p.proconfig)
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): % must be a VOLATILE SECURITY INVOKER function returning text with search_path pinned to pg_catalog.', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): a client role (or PUBLIC) may execute %.', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): service_role cannot execute %.', f;
    END IF;
    def := pg_get_functiondef(to_regprocedure(f));
    IF position('FROM public.events AS e WHERE e.id = p_event_id FOR NO KEY UPDATE' IN def) = 0
       OR position('r.status = ''going''' IN def) = 0
       OR position('current_setting(''transaction_isolation'') <> ''read committed''' IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): % does not lock the event row, count going RSVPs under it and refuse other isolation levels.', f;
    END IF;
    IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE '3906 %' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3906): % does not carry its 3906 comment.', f;
    END IF;
  END LOOP;
  IF position('w.offer_expires_at > now()' IN pg_get_functiondef('public.claim_waitlist_seat(uuid,uuid,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3906): claim_waitlist_seat does not count live offers.';
  END IF;
  -- Both bodies run: a nil event id passes the guards and the lock statement and answers no_event, writing nothing
  -- (no event row exists to lock) — the same probe routes/events.ts sends before it trusts either function.
  IF public.claim_waitlist_seat('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', now() + interval '1 day') IS DISTINCT FROM 'no_event'
     OR public.accept_waitlist_seat('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000') IS DISTINCT FROM 'no_event' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3906): a nil event id did not answer no_event from both functions.';
  END IF;
END $post$;
