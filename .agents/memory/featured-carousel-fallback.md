---
name: Featured carousel fallback pattern
description: How GET /api/featured avoids a blank Discovery carousel when portava_featured has no live rows.
---

When `portava_featured` has no `status='live'` rows, the endpoint does not
return an empty `groups` array. Instead it queries @Portava's own top posts
(by `like_count`) and synthesizes a single `portava_picks` group, setting
`isFallback: true` in the response so clients can show a notice instead of
treating it as real editorial curation.

**Why:** an admin revoking all featured posts (or a status bug) would
otherwise leave every non-follower of @Portava staring at a blank carousel
with no explanation.

**How to apply:** any future change to the featured pipeline (new categories,
different ranking signal, etc.) must preserve the `isFallback` contract —
mobile's `app/featured.tsx` reads it to render `FallbackNotice`. An admin-only
`POST /admin/featured/reseed` endpoint exists to repopulate real rows without
a deploy, distributing @Portava's top posts round-robin across the 6
standard categories.
