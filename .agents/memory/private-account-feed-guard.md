---
name: Private-account feed guard
description: Every public post feed must check author is_private, not just post.visibility; shared utility and which surfaces were patched.
---

## The rule

Filtering `post.visibility = 'public'` and `post.status = 'active'` is **not enough** to enforce account privacy. A user with `profiles.is_private = true` may still have posts with `visibility = 'public'` — those posts must only appear for approved followers.

## Shared utility

`artifacts/api-server/src/lib/privacyFilter.ts` — `excludePrivateAuthorPosts(rows, viewerId, sc, opts?)`

- `opts.authorKey` — field holding author UUID (default: `"author_id"`)
- `opts.profilesKey` — when the query already joins profiles, pass the join key (e.g. `"profiles"`) to avoid an extra round-trip; the utility reads `row[profilesKey].is_private` directly
- Fail-open on profiles query failure; fail-closed on follows query failure
- Viewer's own posts always pass (self-exempt)

## Surfaces patched (and approach)

| Route | Surface | Approach |
|---|---|---|
| `pulse.ts` | Pulse feed | Inline filter after block filter; extra profiles+follows queries |
| `featured.ts` | Featured Hub | Inline filter: `is_private` added to profiles join; private authors excluded entirely (no-auth endpoint — cannot check follows) |
| `mediaFeed.ts` `handleGridFeed` | Roam Grid | `excludePrivateAuthorPosts` after eligibility; profiles query needed (no join in grid candidates) |
| `mediaFeed.ts` watch feed | Roam Watch | `excludePrivateAuthorPosts` after ranking (`capped` array); `profilesKey: "profiles"` used — PROFILE_COLUMNS already includes `is_private` |

## Correctly guarded already (no change needed)

- `discoverySearch.ts` — uses `fetchActiveOwnerSet` which filters private + banned authors
- `profileTabs.ts` — uses `applyVisibilityGuard` before the posts query

## Why

`post.visibility` is a post-level field set by the author at publish time. It does NOT reflect the account's current privacy setting. When a user switches to private AFTER publishing public posts, those posts become private retroactively — only followers should see them. The feed queries must enforce this post-fetch.

## How to apply

Any new post-listing endpoint must call `excludePrivateAuthorPosts` (or the equivalent SQL filter) after fetching rows. If the query already joins `profiles!author_id` with `is_private` in the select, pass `profilesKey: "profiles"` to skip the extra round-trip.
