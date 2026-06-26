---
name: Follow suggestions endpoint
description: GET /api/users/suggestions — "people you may know" endpoint pattern and test approach
---

# Follow suggestions endpoint

## Shape
`GET /api/users/suggestions` (in `artifacts/api-server/src/routes/follows.ts`) returns up to 10 followers the caller hasn't followed back yet, excluding blocked users.

Response: `{ users: TravelerSearchResult[] }` where `TravelerSearchResult` = `{ id, displayName, username, avatarUrl, followerCount, isFollowing: false, isPrivate }`.

## Why
Added for #126 to populate the Discover tab idle state with real "People you may know" suggestions instead of a static placeholder.

## Mobile service
`getSuggestedTravelers(limit?)` in `artifacts/travel-buddy/src/services/follows.ts` — calls the endpoint, returns `FollowResult<TravelerSearchResult[]>`.

## Test pattern
`src/test/userSuggestions.test.ts` — uses the same fake-client pattern as other route tests: `_setTestClient` + `_setTestServiceClient`, inline `makeFakeClient()` that handles `user_follows`, `profiles`, `user_blocks` tables. 6 tests covering: 401, empty followers, already followed back, follow-back candidates, block exclusion, response shape.
