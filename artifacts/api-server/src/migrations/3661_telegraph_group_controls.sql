-- 3661_telegraph_group_controls.sql
-- Telegraph §30A.12 — "Large groups may support slow mode, host-only posting,
-- media/link restrictions, member moderation, and bounded acknowledgement
-- semantics." (census-telegraph T417)
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T-GRP band 3660-3664.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TWO TABLES, BOTH SERVER-ONLY
-- ══════════════════════════════════════════════════════════════════════════════
-- telegraph_thread_controls — one row per group conversation whose host set a
--   control: slow_mode_seconds (0 = off, at most one hour), posting_policy,
--   media_policy and link_policy ('everyone' | 'hosts_only'). No row = no
--   control, which is what every existing conversation reads as. It carries no
--   person's id: who changed a control is not recorded here.
-- telegraph_thread_member_mutes — a host's mute of one member in one group
--   conversation: muted_until NULL = until lifted. Lifting deletes the row.
--   Both people columns REFERENCE auth.users(id) ON DELETE CASCADE, so the row
--   goes when either account is erased (AccountDeletionService's final step),
--   whatever happens to the profiles tombstone.
--
-- Enforcement is server-side, in the shared send guard
-- (lib/telegraphThreadWrite.ts, gate 5b) and the two inline doors of
-- routes/messaging.ts, through domain/telegraph/policies/groupControlsPolicy.ts.
-- A SAFETY send is never refused by any control; a host is never refused by
-- their own conversation's controls.
--
-- Client roles hold NO privilege on either table (rule 4 of
-- check:client-privilege-boundary): RLS on, no policy, REVOKE ALL from PUBLIC,
-- anon and authenticated. service_role is granted exactly what the routes use.
--
-- THE FLAG: telegraph_group_controls_enabled, seeded FALSE. While it is off no
-- code reads or writes either table (a database without this file is never
-- asked for them), every send is decided exactly as before, and the control
-- routes answer feature_disabled.
--
-- ROLLBACK: db/rollback/2026-10-10-3661-telegraph-group-controls-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_threads must exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: auth.users must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Conversation controls
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.telegraph_thread_controls (
  thread_id          uuid PRIMARY KEY REFERENCES public.message_threads(id) ON DELETE CASCADE,
  slow_mode_seconds  integer NOT NULL DEFAULT 0 CHECK (slow_mode_seconds >= 0 AND slow_mode_seconds <= 3600),
  posting_policy     text NOT NULL DEFAULT 'everyone' CHECK (posting_policy IN ('everyone','hosts_only')),
  media_policy       text NOT NULL DEFAULT 'everyone' CHECK (media_policy IN ('everyone','hosts_only')),
  link_policy        text NOT NULL DEFAULT 'everyone' CHECK (link_policy IN ('everyone','hosts_only')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.telegraph_thread_controls IS
  'Telegraph §30A.12 group controls (census T417): slow mode, host-only posting, media and link restrictions, set by a conversation''s host. No row = no control. Read only while telegraph_group_controls_enabled is TRUE; enforced server-side by the shared send guard. SAFETY sends are never refused.';

ALTER TABLE public.telegraph_thread_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegraph_thread_controls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.telegraph_thread_controls TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Member moderation: a host's mute
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.telegraph_thread_member_mutes (
  thread_id    uuid NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_by     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_until  timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id),
  CHECK (user_id <> muted_by)
);

COMMENT ON TABLE public.telegraph_thread_member_mutes IS
  'Telegraph §30A.12 member moderation (census T417): a host muted this member in this group conversation. muted_until NULL = until lifted; lifting deletes the row; an expired mute is simply not in force. A muted member may still respond (acknowledge, vote, react) and send SAFETY. Erased with either account (auth.users CASCADE).';

ALTER TABLE public.telegraph_thread_member_mutes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegraph_thread_member_mutes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegraph_thread_member_mutes TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_group_controls_enabled', false,
   'RESTRICTIVE-WHEN-ON gate for Telegraph §30A.12 group controls: slow mode, host-only posting, media/link restrictions, host mute/remove, bounded acknowledgement rosters. OFF (the seed): neither 3661 table is read or written and every send is decided as before; the control routes answer feature_disabled. ON: hosts may set controls and the shared send guard enforces them; an unreadable flag refuses a group send as retryable.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (catalog and flag row only; recomputed, no session state) ──
DO $post$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegraph_thread_controls','telegraph_thread_member_mutes'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% was not created.', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('public.' || t)::regclass AND relrowsecurity) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on public.%.', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: a client role holds a privilege on public.%.', t;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lacks SELECT/INSERT on public.%.', t;
    END IF;
  END LOOP;

  IF has_table_privilege('service_role', 'public.telegraph_thread_controls', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role must not hold DELETE on telegraph_thread_controls (a control is turned off, not deleted).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_group_controls_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_group_controls_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
