---
name: Friend requests + circle/trip bridges
description: Privacy rules, endpoint catalog, DB shape, and migration notes for the friend/circle/trip invite system
---

## Privacy rules (structural, not just policy)

- `user_friendships` has NO FK into `circle_memberships` or `trip_members`. They are completely separate tables with no trigger or cascade between them.
- `circle_memberships` is written ONLY by `POST /api/circle-invites/:id/accept` (service-role path). RLS blocks direct client inserts.
- `trip_members` with `role='invited'` is written ONLY by `POST /api/trips/:tripId/invite` (trip owner only). Friendship alone never writes to trip_members.

## DB tables (migration 0007)

- `friend_requests(id, requester_id, recipient_id, status, created_at, responded_at, updated_at)` — unique(requester_id, recipient_id)
- `user_friendships(user_a, user_b, accepted_request_id, created_at)` — PK(user_a, user_b), constraint user_a < user_b
- `circle_invites(id, owner_id, recipient_id, status, created_at, responded_at)` — unique(owner_id, recipient_id)
- `circle_memberships(owner_id, member_id, created_at)` — PK(owner_id, member_id)
- Trip invites reuse existing `trip_members(trip_id, user_id, role='invited')`

## Endpoint catalog

Friend requests:
- `POST /users/:userId/friend-request` — auto-accepts if target already sent a request; idempotent
- `POST /friend-requests/:requestId/accept` — recipient only; creates user_friendships row
- `POST /friend-requests/:requestId/decline` — recipient only
- `POST /friend-requests/:requestId/cancel` — requester only
- `GET /me/friend-requests/incoming` — pending, with requester profiles
- `GET /me/friend-requests/outgoing` — pending, with recipient profiles
- `GET /me/friends` — both user_a/user_b columns, with profiles
- `GET /users/:userId/friend-status` → { status: none|outgoing_pending|incoming_pending|friends|self, requestId? }

Circle invites:
- `POST /circle-invites` — idempotent; re-activates declined/cancelled
- `POST /circle-invites/:id/accept` — ONLY path that writes circle_memberships
- `POST /circle-invites/:id/decline`

Trip invites (added to trips.ts):
- `POST /trips/:tripId/invite` — owner only; inserts trip_members with role='invited'
- `POST /trips/:tripId/accept-invite` — updates role to 'member'
- `POST /trips/:tripId/decline-invite` — deletes the row

Profile lookup:
- `GET /users/by-handle/:handle` — case-insensitive .ilike(); same shape as GET /users/:userId

## Implementation notes

- `normalizedFriendshipPair(a, b)` → always [min, max]; deterministic regardless of input order
- Re-request after decline/cancel: UPDATE existing row back to 'pending' (unique constraint means only one row per ordered pair)
- Migration file: `friends-backend/migrations/0007_friends.sql`; apply doc: `friends-backend/APPLY.md`
- All 14 unit tests in `src/test/friendDecisions.test.ts` pass via `node --import tsx/esm --test`

**Why:**
The ECC P-256 JWT issue means all writes must go through the API server. The service-role pattern used for trip creation is the same pattern used for all friend/circle writes here.
