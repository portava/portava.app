---
name: Passport stamps single pipeline
description: Owner passport stamps are fetched once via /api/stamps/me; legacy shapes are derived, not fetched.
---

The owner passport screen must have exactly ONE paginated stamps fetch: usePassport pages GET /api/stamps/me (v2 shape) and derives the legacy `PassportStamp` list via `toLegacyStamp` (lives in `passportStampMappers.ts`, re-exported as `toLegacy` from StampCard). StampsTab in owner mode is render-only (`data` prop); its `loadMoreRef` is bound to the shared pipeline's loadMore.

**Why:** Previously StampsTab paged /api/stamps/me while usePassport paged /api/me/passport/stamps — every scroll fetched the same stamps twice and the two lists could drift. The legacy client endpoint call (`getMyStamps` in services/profile) was removed.

**How to apply:** Never add a second stamps fetch on the passport screen; feed new consumers from usePassport's `stampsNew`/`stamps`. The snapshot cache key was bumped to `passport-v2` because the snapshot now stores v2-shaped stamps — bump it again on any snapshot shape change. A regression tripwire in StampsTab.pagination.component.test.tsx asserts the passport.tsx wiring textually (isOwner, loadMoreRef, no viewingUsername).
