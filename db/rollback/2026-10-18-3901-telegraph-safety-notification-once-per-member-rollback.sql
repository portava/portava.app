-- Rollback for 3901_telegraph_safety_notification_once_per_member.sql (census-telegraph T254, the safety lane's
-- durable re-drive; wave 5, docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3901 DID: created ONE partial unique index and its COMMENT,
--   public.notifications_safety_once_per_member_uniq
--     UNIQUE (user_id, (metadata->>'causal_event_id'))
--     WHERE source_type = 'thread_safety_alert' AND (metadata->>'causal_event_id') IS NOT NULL
-- Nothing else: no table, column, row, grant, policy or flag. The only row its apply wrote is the applier's
-- schema_migration_ledger row.
--
-- WHAT THIS DOES: drops that index (its comment goes with it) and deletes 3901's ledger row, so the runner
-- re-applies 3901 later. Nothing depends on the index. services/telegraph/safetyNotifications.ts then behaves
-- as before 3901: no insert conflicts, so its already_told path is never taken. No row is deleted. The safety
-- rows written while the index stood stay, and they are unique by construction.
--
-- ⚠ IT RE-OPENS THE CROSS-INSTANCE DOUBLE-TELL: two API instances re-driving one help request can again both
-- notify the same member.
--
-- Refuses unless an index of that name, if present, is exactly the one 3901 built (the comparison 3901's own
-- $pre$ and $post$ make, so wherever 3901 applied it matches). It never drops a same-named index someone else
-- made. A second run finds no index and clears only the (already absent) ledger row.
--
-- LOCK: DROP INDEX takes ACCESS EXCLUSIVE on public.notifications until the COMMIT. It is a catalog change
-- (no scan), so the lock is brief, but every read and write of notifications waits for it, and it waits behind
-- them.

BEGIN;

DO $pre$
DECLARE
  v_idx regclass := to_regclass('public.notifications_safety_once_per_member_uniq');
BEGIN
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3901 rollback): public.notifications does not exist.';
  END IF;
  IF v_idx IS NULL THEN
    RAISE NOTICE '3901 rollback: notifications_safety_once_per_member_uniq is absent; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.notifications'::regclass
       AND i.indisunique
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'user_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = '(metadata ->> ''causal_event_id''::text)'
       AND pg_get_expr(i.indpred, i.indrelid, true) = 'source_type = ''thread_safety_alert''::text AND (metadata ->> ''causal_event_id''::text) IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3901): an index named notifications_safety_once_per_member_uniq exists but is not the one 3901 built: %. Nothing was dropped.', pg_get_indexdef(v_idx);
  END IF;
END $pre$;

DROP INDEX IF EXISTS public.notifications_safety_once_per_member_uniq;
DELETE FROM public.schema_migration_ledger WHERE filename = '3901_telegraph_safety_notification_once_per_member.sql';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
BEGIN
  IF to_regclass('public.notifications_safety_once_per_member_uniq') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3901): notifications_safety_once_per_member_uniq still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3901_telegraph_safety_notification_once_per_member.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3901): the ledger still records 3901 as applied.';
  END IF;
END $post$;
