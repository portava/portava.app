# Travel Buddy — Follow graph (Phase 1, backend)

Standalone one-directional FOLLOW. Backend first; UI after this passes.

HARD RULE: a follow is PUBLIC SOCIAL DISCOVERY ONLY. It grants nothing sensitive
— no private posts, no trip_only, no live location, no circle, no trip access.
Separate from circle_memberships and trip_members (this code never touches them).

## STEP 1 — migration (Supabase SQL editor, project ajrurzioarfkagpuxfnb)
Run migrations/0006_follows.sql. Creates user_follows (composite PK blocks dups,
no_self_follow check), 2 indexes, RLS (select public edge, insert/delete self-only,
NO update).
Verify:
    select count(*) from information_schema.tables where table_name='user_follows';   -- 1
    select count(*) from pg_policies where tablename='user_follows';                  -- 3
    select conname from pg_constraint where conrelid='user_follows'::regclass;        -- includes no_self_follow + PK

## STEP 1a — IMPORTANT: confirm the FK constraint names for the list endpoints
The /me/following and /me/followers routes join profiles using these FK names:
    user_follows_following_id_fkey
    user_follows_follower_id_fkey
Postgres usually auto-names them exactly this, but CONFIRM:
    select conname from pg_constraint
      where conrelid='user_follows'::regclass and contype='f';
If the names differ, update the two .select() join strings in routes/follows.ts
to match (the `profiles!<constraint_name>` part). The follow/unfollow/status
endpoints do NOT depend on these names — only the two list endpoints do.

## STEP 2 — files -> exact paths (place individually; never folder-over-src)
    api-server/src/lib/followDecisions.ts   -> artifacts/api-server/src/lib/followDecisions.ts   (NEW)
    api-server/src/routes/follows.ts        -> artifacts/api-server/src/routes/follows.ts        (NEW)
    api-server/src/routes/index.ts          -> artifacts/api-server/src/routes/index.ts          (REPLACE — mounts follows)
    api-server/src/test/followDecisions.test.ts -> artifacts/api-server/src/test/followDecisions.test.ts (NEW)

## STEP 3 — build + test
    cd artifacts/api-server
    pnpm run build
    node --import tsx/esm --test src/test/followDecisions.test.ts   # 10 tests pass
    pnpm run typecheck

## Endpoints (all require auth; follower is the verified user, never client-supplied)
    POST   /api/users/:userId/follow          -> { following:true, userId }   (idempotent)
    DELETE /api/users/:userId/follow          -> { following:false, userId }
    GET    /api/users/:userId/follow-status    -> { isFollowing, followersCount, followingCount }
    GET    /api/me/following                    -> { users:[{id,handle,name,avatarUrl,since}] }
    GET    /api/me/followers                    -> { users:[...] }

## Rules enforced
- follow another user (existing profile)            ✓
- unfollow (idempotent)                             ✓
- cannot follow self (check + decision)             ✓
- duplicate blocked (composite PK + idempotent upsert) ✓
- cannot create a row for someone else (follower_id = verified user; RLS insert
  with_check follower_id=auth.uid())                ✓
- follow does NOT create circle_memberships/trip rows (code never references them) ✓
- follow does NOT expose private/trip_only posts or live location (follows code
  never reads those; their own RLS still guards them)                              ✓
- blocked hook present (blocked=false until a block table exists)                  ✓

## Tests (10 pass — decision layer)
follow ok · unauth · no-self · not-found · invalid-uuid · blocked · unfollow auth ·
unfollow bad-target · isUuid · sensitive-access-surface invariant.
NOTE: these test the gatekeeping logic. The "grants nothing sensitive" property is
structural (follow code touches no posts/trips/circles/locations) + enforced by
the other tables' RLS. A full integration test needs two live users; do it in the
live check below.

## CAVEAT
Could not run tsc/build here. Run pnpm run build + typecheck on Replit. The FK
join-name confirmation (Step 1a) is the one runtime risk — verify it.

## Live check (optional, proves end-to-end with 2 users)
With user A signed in, follow user B:
    curl -X POST $API/api/users/<B>/follow -H "Authorization: Bearer <A-token>"
    -- then:
    select * from user_follows;                       -- one row A->B
    select count(*) from circle_memberships;          -- UNCHANGED (follow didn't touch it)
    select count(*) from trip_members;                -- UNCHANGED

## Next (after this passes): Phase 1 UI — follow button + counts on profile/passport,
unfollow, optional "Following" feed filter. Friend-request model is Phase 2 (separate).
