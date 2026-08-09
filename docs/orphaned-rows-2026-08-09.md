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

It references posts via **`item_id` (text)** plus *either* `item_kind` *or*
`content_type` — never a `post_id` column, which is why a column-name scan misses
it, and why a query filtering on only one of those two type columns silently sees
a fraction of the table.

### CORRECTION — the "~71,169 pre-existing orphans" claim was wrong

This file originally stated that `rank_events` "was already accumulating orphans
independently of the deletion", with **145,621** total orphans of which only
74,452 were ours and **~71,169 pre-dated** us. **That is retracted.**

The error: every UUID-shaped `item_id` was compared against `posts` alone, but
`rank_events` is polymorphic. Buddy and event rows reference other tables
entirely and were counted as orphans:

```
145,985 "orphans"  =  74,452 real  +  45,360 buddy rows  +  26,173 event rows
```

Measured correctly against the 100 known-deleted post ids:

| | rows |
|---|---:|
| post-referencing rows | 130,353 |
| orphaned (no such post) | 74,452 |
| traceable to this deletion | **74,452** |
| **standing orphans predating it** | **0** |

**There was no pre-existing orphan population.** Every orphaned post reference in
`rank_events` came from this deletion.

The ranking-side analysis — the two-column type convention, the `place:` id
prefix, buddy ids being `profiles.id`, and the fact that 37% of the table now
points at deleted posts — is recorded where the algorithm work will find it:
**`docs/algorithm/rank-events-signal-gaps.md` §4**.

## Not an orphan

`post_impressions` and `rent_buddy_tag_consents` also reference `posts` without an
FK, but both held **zero** rows referencing the deleted posts. Checked, not assumed.
