# Apply migration 0007 — Friend requests + circle bridge

## One-time setup

Open your Supabase project → SQL Editor → New query. Paste and run
`friends-backend/migrations/0007_friends.sql`.

## What this creates

| Table | Purpose |
|-------|---------|
| `friend_requests` | pending / accepted / declined / cancelled request rows |
| `user_friendships` | normalized accepted pairs (user_a < user_b) |
| `circle_invites` | explicit invite needed before circle access |
| `circle_memberships` | created ONLY when a circle_invite is accepted |

## Privacy guarantee (structural, not just policy)

* `user_friendships` has **no FK** to `circle_memberships` or `trip_members`.
  The tables are completely separate. No trigger, cascade, or function writes
  between them.
* `circle_memberships` RLS blocks direct client inserts (`with check (false)`).
  Only the API server (service-role key) writes to it — via
  `POST /api/circle-invites/:id/accept`.
* `trip_members` with `role='invited'` is created only via
  `POST /api/trips/:tripId/invite` (trip owner only).
  Friendship does not touch `trip_members`.

## Trip invite note

Trip invites reuse the existing `trip_members` table with `role = 'invited'`.
No new table is needed. The invite flow is:
1. Trip owner calls `POST /api/trips/:tripId/invite` with `{ userId }`.
2. Invitee calls `POST /api/trips/:tripId/accept-invite` → role becomes `member`.
3. Invitee calls `POST /api/trips/:tripId/decline-invite` → row is deleted.

## Verify the migration ran

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('friend_requests','user_friendships','circle_invites','circle_memberships');
```

Should return 4 rows.
