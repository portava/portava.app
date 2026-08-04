-- 2069_circle_invites.sql
-- Trusted-circle invites. The code has referenced this table since the
-- interaction foundation work (routes/friends.ts, routes/requests.ts,
-- routes/groupChat.ts, routes/messaging.ts) but it was never created —
-- every circle-invite endpoint currently fails at the DB layer.
--
-- Lifecycle (all transitions driven by the API server):
--   insert                → status 'pending' (insert supplies only owner_id +
--                           recipient_id; status/created_at come from defaults)
--   recipient accepts     → status 'accepted', responded_at set
--                           (the ONLY path that writes circle_memberships)
--   recipient declines    → status 'declined', responded_at set
--   owner cancels         → status 'cancelled', updated_at set
--   owner re-invites      → existing row reactivated: status back to
--                           'pending', responded_at cleared
--
-- The re-invite path (routes/friends.ts POST /circle-invites) looks up the
-- existing row with .eq(owner_id).eq(recipient_id).maybeSingle() and updates
-- it in place — maybeSingle() throws on >1 row, so (owner_id, recipient_id)
-- MUST be unique.
--
-- Access: service-role only. requireUser() (lib/http.ts) hands every route the
-- SERVICE-ROLE client, and the mobile app never queries this table with the
-- anon key — so RLS is enabled with NO policies (deny-all for anon/authenticated;
-- service role bypasses RLS).

CREATE TABLE IF NOT EXISTS circle_invites (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One invite row per (owner → recipient) pair; declined/cancelled rows are
  -- reactivated in place, never duplicated (friends.ts reactivation logic).
  CONSTRAINT circle_invites_owner_recipient_key UNIQUE (owner_id, recipient_id),
  -- friends.ts rejects self-invites at the API layer; enforce in the DB too.
  CONSTRAINT circle_invites_no_self_invite CHECK (owner_id <> recipient_id)
);

-- Incoming-invite queries: .eq(recipient_id).eq(status,'pending') for badge
-- counts (requests.ts /me/requests/count, messaging.ts pendingSince) and
-- .eq(recipient_id).order(created_at desc) for the inbox list (requests.ts).
CREATE INDEX IF NOT EXISTS circle_invites_recipient_status_idx
  ON circle_invites (recipient_id, status);

-- Outgoing-invite queries: .eq(owner_id).order(created_at desc) (requests.ts)
-- and groupChat.ts pending-invite gate (.eq(owner_id).eq(recipient_id)
-- .eq(status,'pending') — the unique index covers the pair lookup, this one
-- covers owner+status scans).
CREATE INDEX IF NOT EXISTS circle_invites_owner_status_idx
  ON circle_invites (owner_id, status);

-- Deny-all RLS: no policies on purpose. All access goes through the API
-- server's service-role client, which bypasses RLS.
ALTER TABLE circle_invites ENABLE ROW LEVEL SECURITY;
