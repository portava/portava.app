---
name: Media feed column drift
description: Multiple columns referenced in mediaFeed.ts FEED/GRID/PROFILE column constants did not exist in the live posts/profiles tables, causing 42703 errors.
---

## The rule
Before adding any column name to a `FEED_POST_COLUMNS`, `GRID_POST_COLUMNS`, `POST_MEDIA_COLUMNS`, or `PROFILE_COLUMNS` string constant in `mediaFeed.ts`, verify the column exists in the live DB via a test `curl` against the Supabase REST API. Code was written anticipating future schema additions that never landed.

## Confirmed live column mapping (as of 2026-07-27)

**`posts` table — columns that DO NOT exist (code assumed they would):**
- `moderation_status` → not on posts (IS on post_media ✓)
- `publish_at` → not there (live column is `published_at`; scheduled-publish gate omitted for now)
- `geo_restriction`, `age_restriction_enabled`, `age_min`, `age_max` → none exist
- `event_id` → not there (live column is `venue_id`)
- `tags` → not there
- `view_count`, `qualified_view_count` → not there

**`profiles` table — columns that DO NOT exist:**
- `is_verified` → use `verified` instead
- `followers_count`, `following_count` → not there

**What was fixed:**
- `GRID_POST_COLUMNS` stripped to: `id, author_id, location_name, location_city, location_country, location_lat, location_lng, created_at, category, status, post_status, visibility`
- `FEED_POST_COLUMNS` stripped to: `id, author_id, trip_id, content, visibility, status, post_status, created_at, category, location_name, location_city, location_country, location_source, save_count, like_count, comment_count`
- `PROFILE_COLUMNS` and `GEM_PROFILE_COLUMNS`: removed `is_verified` → `verified`, removed `followers_count`/`following_count`
- `mediaFeedItem.ts`: `profile?.is_verified` → `profile?.verified`

**Why:** Downstream eligibility/hydration code already handles absent columns gracefully (`?? 0`, `?? null`, `if (c.geo_restriction)` short-circuits on undefined), so stripping non-existent columns is safe.

## Seed script gotcha
`seed-test-media.ts` originally included `moderation_status` and `tags` in the posts insert — both non-existent columns. This caused PGRST204, silently skipping all video post inserts (only the one pre-existing post with video media survived). Fix: removed those two fields; changed the existing-post idempotency branch to also PATCH `has_video=true` on any previously-seeded post that has it wrong. Run `pnpm seed:test-media` from `artifacts/api-server` after this fix to back-fill all demo user video posts.

## How to apply
Any new column added to these constants must be smoke-tested:
```
curl "${SUPABASE_URL}/rest/v1/posts?select=<col>&limit=1" -H "apikey: ${KEY}" -H "Authorization: Bearer ${KEY}"
```
A 42703 response means the column doesn't exist — don't add it to the SELECT string.
