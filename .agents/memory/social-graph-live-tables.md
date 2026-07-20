---
name: Social-graph live table names
description: Which social/graph tables actually exist in the live Supabase DB vs. names guessed in code
---

Verified against the live production schema (Supabase Management API, information_schema):

- EXIST: `user_follows(follower_id, following_id, created_at)`, `user_friendships(user_a, user_b, created_at)`, `friend_requests(requester_id, recipient_id, status, ...)`, `circle_memberships(user_id, other_id, status, created_at)`, `passport_stamps`, `discovery_places`.
- DO NOT EXIST: `follows`, `places`, `stamps`, `circle_members`, `friend_connections`.

**Why:** several routes guessed table names; queries against non-existent tables fail silently in fail-open paths. The Section-A audit assumed the whole friends system was orphaned, but `user_friendships`/`friend_requests` are live — only `friend_connections` was an orphan. Decision recorded in `routes/friends.ts`: keep the friends system.

**How to apply:** when touching social-graph queries, use the EXIST list above; `circle_memberships` uses `user_id` = circle owner, `other_id` = member (a circle's id is its owner's user id). Code elsewhere still uses `owner_id`/`member_id` against it — column renames are Section C scope.
