-- 3941_telegraph_member_private_state_column_privileges.sql
-- No client role can read a thread member's private per-member state: when they last read the thread
-- (last_read_at), whether they archived it (archived_at), whether and how they muted it (muted_at, and
-- 3760's notification_level and muted_until where 3760 is applied). POST-CUTOVER CANONICAL FORWARD
-- MIGRATION (3000-3999 band; lane TELEGRAPH's census-drive band 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. A privilege change on one table. No data, policy, function, trigger or flag
-- change. It narrows what the anon key and a signed-in client key can read from a live table, so it
-- needs the owner's production approval and is sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE LEAK (found on main at ffdf6428c while fixing PR #786)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- anon and authenticated hold a TABLE-level SELECT on public.message_thread_members (the baseline's
-- Supabase-default ACL; production and this harness alike), and policy mtm_select admits every row of
-- a thread to every active member of it (`auth.uid() = user_id OR authz.is_active_thread_member(...)`).
-- So any member of a group could ask PostgREST, with the shipped anon key and their own JWT,
--     GET /rest/v1/message_thread_members?thread_id=eq.<t>&select=user_id,last_read_at,archived_at,muted_at
-- and learn, for every co-member: the instant they last read the thread (a presence signal, and the
-- per-member read receipt the receipt rules never give a group — a group receipt is a COUNT,
-- src/test/telegraphDeliveryReceipts.test.ts), whether they archived the conversation, and whether
-- they muted it. A filter needs no select list: `?last_read_at=gt.<t>` is a range oracle on it.
-- None of the three is anyone's business but the member's own; the API answers each to its owner only
-- (GET /me/threads `archivedAt`, the receipts route, the notification-state route).
--
-- notification_level and muted_until (3760) are the same disclosure as muted_at — "has this person
-- muted us, and until when" — so they are withheld too, where they exist. On a database where 3760 is
-- not applied they are simply absent, and when 3760 lands later its ADD COLUMN creates them with no
-- client privilege (this file leaves no table-level grant behind to cover them).
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE FIX, AND WHY IT COMPOSES WITH 3940 IN EITHER ORDER
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- A column privilege cannot be revoked from under a table-level grant, so for each of anon and
-- authenticated this file: (1) reads the columns the role can read RIGHT NOW (has_column_privilege —
-- table-level or column-level), (2) revokes SELECT on the table (which also revokes every column
-- privilege), and (3) grants back SELECT on exactly the columns from (1) minus the private set.
-- It only ever NARROWS: a column some other migration already withheld stays withheld.
--
-- 3940 (PR #786, telegraph_member_cursor_column_privileges) changes the SAME table's client SELECT — it
-- withholds the receipt cursors delivered_sequence and seen_sequence. Composition:
--   * 3940 then 3941 (filename order; every fresh replay, CI and this harness): 3940 leaves column grants
--     without the cursors; this file reads that state and removes its five columns from it. End state:
--     neither the cursors nor the private state are client-readable.
--   * 3941 then 3940 (if this file reaches production first): this file narrows the table-level grant
--     to every column but the private set (the cursors stay readable — that is 3940's subject, not
--     this file's). 3940 as written at #786 head 19e6e6f68 re-derives its grant list from the CATALOG
--     ("every column except the two cursors") and would RE-GRANT this file's five. #786 is asked to
--     derive its list the way this file does (what the role can read now, minus its two), and to stop
--     pinning last_read_at as client-readable in its postcondition and db test; with that change the
--     end state is the same in both orders. Until then, the reopening is NOT silent: certify:migrations
--     stage 4 re-runs THIS file's postcondition after any later apply and it raises.
--
-- service_role — the API's only client (lib/supabase.ts; handRolledAuthAccountState.test.ts pins that
-- no other file builds one) — keeps its full table-level privileges. INSERT, UPDATE and DELETE grants
-- are untouched (no client policy admits an UPDATE or DELETE; mtm_insert is unchanged).
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHO READS THESE COLUMNS AS A CLIENT ROLE (inventoried 2026-10-24 on main ffdf6428c)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- * No client code. travel-buddy-standalone has no PostgREST read of message_thread_members (removed for
--   T295; the telegraph-slos ratchet goes red if one returns); its one realtime subscription is on
--   generated_visuals, and the table is in no publication. The repo-root app has none either.
-- * The API reads them only as service_role: routes/messaging.ts (/me/threads, the read marker),
--   routes/telegraphLifecycle.ts (receipts), routes/telegraphArchive.ts, services/telegraph/
--   threadNotificationState.ts, safetyNotifications.ts, compass/TelegraphConversationTools.ts.
-- * SQL: the one function that reads any of them, telegraph_unsend_message_before_seen, is SECURITY
--   DEFINER and not client-executable. No view depends on the table; no policy on any table names them;
--   the only invoker function on the table (the telegraph_member_visibility_window trigger) reads no
--   column through a SELECT.
--
-- A COLUMN ADDED LATER is not client-readable until a migration grants it — the safe default for a
-- table whose rows describe other people.
--
-- ACCEPTED STARTING STATES (anything else refuses the apply — it is a state nobody wrote down):
--   S1  the baseline: anon and authenticated each hold a table-level SELECT.
--   S2  3940's end state: no client table-level SELECT; column SELECT on a subset of the columns.
--   Either way PUBLIC holds no SELECT on the table and no client role holds SELECT WITH GRANT OPTION.
--
-- ORDER: needs the baseline's three columns; reads 3760's two and 3940's state only if present.
--
-- ROLLBACK: db/rollback/2026-10-24-3941-telegraph-member-private-state-column-privileges-rollback.sql
-- (grants SELECT on the private columns back; touches nothing 3940 did; the leak returns with it).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  r text;
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3941): public.message_thread_members does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND NOT attisdropped
        AND attname IN ('last_read_at', 'archived_at', 'muted_at')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3941): message_thread_members must carry last_read_at, archived_at and muted_at.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid = 'public.message_thread_members'::regclass AND a.grantee = 0 AND a.privilege_type = 'SELECT'
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a
     WHERE t.attrelid = 'public.message_thread_members'::regclass AND t.attacl IS NOT NULL AND a.grantee = 0 AND a.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3941): PUBLIC holds SELECT on message_thread_members — an unrecorded state; a role-level revoke would not close it.';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.message_thread_members', 'SELECT WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3941): % holds SELECT WITH GRANT OPTION on message_thread_members — an unrecorded state.', r;
    END IF;
  END LOOP;
END $pre$;

DO $narrow$
DECLARE
  r text;
  v_cols text;
  v_private constant text[] := ARRAY['last_read_at', 'archived_at', 'muted_at', 'notification_level', 'muted_until'];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- What the role can read NOW (table-level or column-level), minus the private set. Read BEFORE the revoke.
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
      FROM pg_attribute
     WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
       AND attname <> ALL (v_private)
       AND has_column_privilege(r, 'public.message_thread_members', attname, 'SELECT');
    EXECUTE format('REVOKE SELECT ON public.message_thread_members FROM %I', r);
    IF v_cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.message_thread_members TO %I', v_cols, r);
    END IF;
  END LOOP;
END $narrow$;

DO $post$
DECLARE
  r text;
  c text;
  v_private constant text[] := ARRAY['last_read_at', 'archived_at', 'muted_at', 'notification_level', 'muted_until'];
  v_membership constant text[] := ARRAY['thread_id', 'user_id', 'role', 'joined_at', 'left_at'];
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3941): public.message_thread_members does not exist.';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.message_thread_members', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3941): % still holds a table-level SELECT on message_thread_members.', r;
    END IF;
    FOREACH c IN ARRAY v_private LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND attname = c AND NOT attisdropped)
         AND has_column_privilege(r, 'public.message_thread_members', c, 'SELECT') THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3941): % can read message_thread_members.%.', r, c;
      END IF;
    END LOOP;
    -- Membership itself stays readable: the policy's row set and the history bound are unchanged.
    FOREACH c IN ARRAY v_membership LOOP
      IF NOT has_column_privilege(r, 'public.message_thread_members', c, 'SELECT') THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3941): % lost SELECT on message_thread_members.%.', r, c;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['last_read_at', 'archived_at', 'muted_at'] LOOP
    IF NOT has_column_privilege('service_role', 'public.message_thread_members', c, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3941): the API''s service role can no longer read message_thread_members.%.', c;
    END IF;
  END LOOP;
END $post$;

COMMIT;
