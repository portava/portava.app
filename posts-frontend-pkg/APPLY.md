# Travel Buddy — Posts FRONTEND client (data layer only)

The backend posts API is live and tested (20/20). This package adds the FRONTEND
data seams that call it. It does NOT rewrite the Pulse UI components — that's a
later display pass. These are the typed client + hooks the UI will consume.

## Files -> exact paths (place individually)
    travel-buddy/src/services/posts.ts  -> artifacts/travel-buddy/src/services/posts.ts (NEW)
    travel-buddy/src/hooks/usePosts.ts  -> artifacts/travel-buddy/src/hooks/usePosts.ts (NEW)
    api-server/TEST_RUNNER_TECH_DEBT.md -> artifacts/api-server/TEST_RUNNER_TECH_DEBT.md (NEW — tech-debt note for the vitest shim)

## What this provides
src/services/posts.ts — typed client over the API SERVER (never supabase tables
for posts, never the service-role key). Mirrors createTrip(): refresh session ->
Bearer token -> fetch ${EXPO_PUBLIC_API_BASE_URL}/api/posts... -> typed result.
  createPost / listGlobalPosts / listTripPosts / updatePost / deletePost
  Typed errors: unauthenticated | forbidden | not_member | invalid_payload |
                not_found | db_error | network_unreachable | config_error

src/hooks/usePosts.ts — same {data, loading, error, reload} shape as useBackend:
  useGlobalFeed()          -> public standalone feed
  useTripPosts(tripId)     -> trip feed + isMember flag
  usePostActions()         -> { create, edit, remove, submitting }

## Verified contract (frontend <-> backend, checked field-by-field)
  POST   /api/posts                 body { content, mediaUrls, tripId, visibility }
  GET    /api/posts                 -> { posts: [...] }
  GET    /api/trips/:tripId/posts   -> { posts: [...], isMember }
  PATCH  /api/posts/:postId
  DELETE /api/posts/:postId         -> 204
Response rows map: author_id/trip_id/media_urls/created_at/updated_at (snake) ->
camelCase PostRow. Confirmed matching the route's POST_COLUMNS exactly.

## Requirements to work at runtime
- EXPO_PUBLIC_API_BASE_URL must be set (already in artifacts/travel-buddy/.env,
  pointing at the Replit API server domain). Without it, reads return [] and
  writes return config_error (app still runs).
- User must be signed in (Bearer token attached automatically).

## NOT in this package (intentionally deferred)
- Pulse feed UI rewrite (PulseFeedCard/PulseCreate still render mock data)
- Post composer wiring to usePostActions().create
- UI tests
These come next, once you confirm the client compiles/typechecks.

## Verify
    cd artifacts/travel-buddy
    npx tsc --noEmit        # or the project's typecheck
Then a quick smoke test from any signed-in screen:
    import { listGlobalPosts, createPost } from '../services/posts';
    // createPost({ content: 'hello' }) -> should 201 and return a PostRow

## Boundaries kept
No service-role key on the client. No direct supabase writes for posts. author_id
is always server-derived. Client cannot bypass membership/visibility — the server
re-checks everything (and RLS is defense-in-depth).
