# Orphaned rows left by the seed-account deletion — 2026-08-09

Status: **recorded, not cleaned.** Nothing here has been deleted. This file exists
so the rows are findable by someone who decides to sweep them, rather than being
discovered again by a future orphan census.

## What was deleted

100 `post_media` rows and their 100 `posts`, all owned by 20 seed accounts
(`demo.friend.N.…@example.com`, UUIDv5, created in one 26-second burst on
2026-07-17). Each account was independently confirmed never to have signed in:
`last_sign_in_at IS NULL`, **zero `auth.sessions`, zero `auth.refresh_tokens`** —
probes proven capable of detecting a sign-in, since the known-active account
returns 81 sessions / 19,418 refresh tokens.

Deletion was scoped by **account ownership**, never by `posts.source`.
`source = 'seed_script'` is not an ownership marker: the real, active account
`anroletrading@gmail.com` owns 21 `seed_script` posts, including the 14 dangling
media rows that were explicitly out of scope.

17 FK children cascaded correctly. Two tables have **no FK to `posts`**, so
nothing cascaded and their rows are now orphaned.

## 1. `content_stamps` — 4 rows (small, cleanable)

Verified present by direct query on 2026-08-09 (observed, not inferred from the
missing FK). All four reference posts that no longer exist, and all four belong
to **`highrollsmoke@gmail.com`** (`5f123260-976f-49f3-a102-52346b4fc0af`) — a
real, active user, not a seed account.

| `content_stamps.id` | `entity_id` (deleted post) | created |
|---|---|---|
| `f4f764cd-e767-4317-8d79-7cd9962414c0` | `29cc8911-24e4-51c8-857b-b104a3f30af0` | 2026-07-30 |
| `131156b1-b11b-46db-8b7d-64295560047e` | `528b75d7-c0c5-54a3-9238-a8aa40a7f3e2` | 2026-07-31 |
| `acca9763-3abf-4aad-bb39-708e2e2758af` | `346ff788-606f-54f7-ad7a-aa55f9ab3947` | 2026-07-31 |
| `63dee836-8134-4397-b539-517a0da535a3` | `7f5415e9-461c-5539-a860-9ce9225b18c1` | 2026-08-04 |

`content_stamps` references posts polymorphically (`entity_type` + `entity_id`),
which is why no FK exists and why a scan for columns *named* `post_id` misses it.

To re-confirm before any sweep:

```sql
select cs.id, cs.entity_id, cs.user_id
  from content_stamps cs
 where cs.entity_type = 'post'
   and not exists (select 1 from posts p where p.id = cs.entity_id);
```

## 2. `rank_events` — 74,452 rows (large; do not sweep casually)

Ranking telemetry for the deleted seed posts. No FK, so none cascaded.

⚠️ **`rank_events` and its surrounding code were flagged as mid-flight work at the
time of the deletion** (`lib/rankLog.ts`, `services/ranking/rankingAnalytics.ts`,
`src/scripts/checkRankEventsSurfaces.ts`). Do not sweep without checking with
whoever owns that work.

It references posts via **`item_id` (text) + `item_kind`**, not a `post_id`
column — the same reason a column-name scan misses it.

**This table was already accumulating orphans independently of the deletion.**
Total orphaned rows with a UUID-shaped `item_id` and no matching post: **145,621**,
of which only 74,452 came from this deletion. The remaining **~71,169 pre-date it**.
Whatever causes that is a separate, ongoing issue and is not addressed here.

## Not an orphan

`post_impressions` and `rent_buddy_tag_consents` also reference `posts` without an
FK, but both held **zero** rows referencing the deleted posts. Checked, not assumed.
