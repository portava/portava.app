-- Migration: 0015_blocks.sql
-- Creates the blocks table, RLS policies, is_blocked() helper, and amends RLS
-- on dependent tables (messages, follows, profiles) to respect blocks.

-- ── Blocks table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_pair_unique UNIQUE (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self     CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocker_idx ON public.blocks (blocker_id);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON public.blocks (blocked_id);

-- ── RLS on blocks ─────────────────────────────────────────────────────────────

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

-- Blocker can read their own block rows
CREATE POLICY "blocks_select_own"
  ON public.blocks FOR SELECT
  USING (blocker_id = auth.uid());

-- Blocker can insert their own block rows
CREATE POLICY "blocks_insert_own"
  ON public.blocks FOR INSERT
  WITH CHECK (blocker_id = auth.uid());

-- Blocker can delete their own block rows (unblock)
CREATE POLICY "blocks_delete_own"
  ON public.blocks FOR DELETE
  USING (blocker_id = auth.uid());

-- ── Helper function ───────────────────────────────────────────────────────────
-- is_blocked(a, b) returns TRUE if either party has blocked the other.
-- SECURITY DEFINER so it can bypass RLS from inside other policies.

CREATE OR REPLACE FUNCTION public.is_blocked(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b)
       OR (blocker_id = b AND blocked_id = a)
  );
$$;

-- ── Amend RLS on profiles ─────────────────────────────────────────────────────
-- Add a policy so blocked users cannot see each other's profile rows.
-- NOTE: Apply DROP + re-CREATE if a conflicting policy with this name already exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'profiles_hide_blocked'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "profiles_hide_blocked"
        ON public.profiles FOR SELECT
        USING (
          id = auth.uid()
          OR NOT public.is_blocked(auth.uid(), id)
        )
    $policy$;
  END IF;
END;
$$;

-- ── Amend RLS on user_follows ─────────────────────────────────────────────────
-- Prevent blocked users from appearing in each other's follower/following lists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_follows' AND policyname = 'user_follows_hide_blocked'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "user_follows_hide_blocked"
        ON public.user_follows FOR SELECT
        USING (
          NOT public.is_blocked(auth.uid(), follower_id)
          AND NOT public.is_blocked(auth.uid(), following_id)
        )
    $policy$;
  END IF;
END;
$$;

-- ── Amend RLS on messages ─────────────────────────────────────────────────────
-- Hide messages in direct threads from blocked users (server is authority;
-- message thread access is already gated by message_thread_members).
-- Service-role client bypasses RLS for all API writes, so this guards direct
-- Supabase Realtime / PostgREST access only.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'messages_hide_blocked_sender'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "messages_hide_blocked_sender"
        ON public.messages FOR SELECT
        USING (
          NOT public.is_blocked(auth.uid(), sender_id)
        )
    $policy$;
  END IF;
END;
$$;
