# Travel Buddy — Posts backend package

Security-sensitive backend for the posts feature. Apply + verify on Replit
BEFORE any frontend wiring. Nothing here touches the frontend.

The posts table migration is ALREADY APPLIED on the live Supabase project
(ajrurzioarfkagpuxfnb): has_posts=1, post_policies=4 confirmed. The migration is
included for source control / re-creation only.

## File map (place at these exact paths in the Repl)

    migrations/0003_posts.sql                          -> migrations/0003_posts.sql   (already applied)
    api-server/src/lib/http.ts            -> artifacts/api-server/src/lib/http.ts        (NEW)
    api-server/src/lib/postSchemas.ts     -> artifacts/api-server/src/lib/postSchemas.ts (NEW)
    api-server/src/routes/posts.ts        -> artifacts/api-server/src/routes/posts.ts    (NEW)
    api-server/src/routes/index.ts        -> artifacts/api-server/src/routes/index.ts    (REPLACE — mounts postsRouter)
    api-server/src/test/helpers.ts        -> artifacts/api-server/src/test/helpers.ts    (NEW)
    api-server/src/test/posts.test.ts     -> artifacts/api-server/src/test/posts.test.ts (NEW)
    api-server/vitest.config.ts           -> artifacts/api-server/vitest.config.ts       (NEW)
    api-server/package.json               -> artifacts/api-server/package.json           (REPLACE — adds zod dep + vitest/supertest devDeps + test script)

IMPORTANT (lesson from before): place files individually at the exact paths.
Do NOT drop a folder over src/.

## Install + run (in the Repl shell, from artifacts/api-server)

    cd artifacts/api-server
    pnpm install            # or npm install --legacy-peer-deps if this artifact is run with npm
    pnpm test               # runs the 20 vitest authorization tests
    pnpm run typecheck      # tsc --noEmit (catch any type nits — see caveat below)
    pnpm run build          # esbuild bundle
    pnpm run start          # start the API server (needs .env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)

## Endpoints added
    POST   /api/posts                 create standalone or trip-attached post
    GET    /api/posts                 global feed (public standalone active only)
    GET    /api/trips/:tripId/posts   trip feed (trip_only only for accepted members)
    PATCH  /api/posts/:postId         author-only edit
    DELETE /api/posts/:postId         author-only SOFT delete (status=deleted)

## Security model (enforced in BOTH the API server and RLS)
- Auth: Bearer token -> supabase.auth.getUser(token) (verifies ECC P-256; the
  same path that fixed the trips 403). No token / invalid -> 401 unauthenticated.
- author_id / created_by / updated_by are ALWAYS set from the verified user.
  Any client-supplied author_id/user_id is ignored (test #2).
- Trip-attached create: trip must exist (404) AND user must be owner or ACCEPTED
  member. 'invited' (not yet accepted), declined, removed, non-member -> 403
  not_member (tests #7, #8).
- visibility=trip_only requires trip_id (schema + DB check constraint; test #10).
- Global feed returns ONLY public standalone active posts — trip_only/private
  never leak (test #11).
- Edit/delete: author only (tests #12-16). Delete is soft (status=deleted).
- Service role key stays server-side (artifacts/api-server/.env). NEVER exposed
  to the Expo app. RLS remains enabled as defense-in-depth (4 policies live).

## Error envelope
    { "error": "<code>", "message": "<detail>" }
    codes: server_not_configured | unauthenticated | forbidden | not_member |
           invalid_payload | not_found | db_error

## Test coverage (20 tests, src/test/posts.test.ts)
    1  standalone create by authed user
    2  author_id set from token, client author_id IGNORED
    3  no token -> 401      3b invalid token -> 401
    4  empty payload -> 400
    5  owner can trip-post  6 accepted member can trip-post
    7  invited CANNOT trip-post -> 403 not_member
    8  non-member CANNOT trip-post -> 403 not_member
    9  non-existent trip -> 404
    10 trip_only without trip -> 400
    11 global feed: no trip_only/private leak
    12 author can edit       13 non-author cannot edit -> 403
    14 trip_only on standalone -> 400
    15 author soft-delete     16 non-author cannot delete -> 403
    17 non-member trip feed isMember=false
    17b accepted member isMember=true
    17c invited isMember=false (invitation != membership)

## CAVEATS / things to verify on Replit (I could not run these in my sandbox —
## no network for npm/tsc mid-session)
1. TYPECHECK: I validated syntax with a tokenizer and checked every zod-v3 and
   supabase-js API call by hand, but could not run `tsc`. Run `pnpm run
   typecheck`. The most likely (minor) nit is an Express 5 handler return-type:
   if tsc complains about handlers returning a value, the fix is to ensure each
   `return;` in a route is a bare return (they are) — but confirm.
2. VITEST MOCK PATH: tests mock "../lib/supabase". If a test unexpectedly hits a
   real client ("server_not_configured"), the mock specifier didn't match —
   align it with how http.ts imports supabase ("./supabase").
3. zod is added as a direct dependency (^3.24.2) — it was previously only
   transitive via @workspace/api-zod. If pnpm catalog is preferred, change
   "^3.24.2" to "catalog:" to match the workspace.
4. The fake test client does not exercise the .or() visibility filter in the
   trip-feed read path (tests assert membership flagging, not row filtering for
   that endpoint). Row-level visibility for the global feed IS asserted (#11).
   Full trip-feed row filtering is best confirmed with a live-DB integration
   test once the frontend is wired.

## After this passes on Replit
Then (separate package): frontend posts client (Bearer token), Pulse feed +
composer wiring, UI tests. Not included here by design.
