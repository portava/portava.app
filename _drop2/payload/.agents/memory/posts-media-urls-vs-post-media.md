---
name: posts.media_urls drives rendering, not post_media
description: Two independent media stores exist on posts; every render path reads posts.media_urls, and cleaning one store does not fix the other.
---

`posts.media_urls` (`text[]` of public Storage URLs) and the structured `post_media`
table are **separate stores that are not kept in sync**. Every user-visible render
path reads `media_urls`.

**Derive the set, do not read it from here.** An earlier version of this entry
enumerated eight call sites and said that was all of them. It was not: it missed
the **main Pulse feed** (`routes/pulse.ts`), `routes/airport.ts`,
`routes/events.ts`, `routes/adminPortavaPosts.ts`, `routes/placeDays.ts`,
`routes/discoverySearch.ts` and `lib/places/placeCollections.ts`, and two of the
line numbers it did give had already moved. The list is too large and too mobile
to hold by hand — run this instead:

```bash
# every non-test read/write of the column (authoritative)
grep -rn 'media_urls' artifacts/api-server/src/routes artifacts/api-server/src/lib \
  --include='*.ts' | grep -v '\.test\.ts' | grep -v 'database\.types\.ts'
```

54 hits across 18 files as of 2026-08-10 — that count rots; the command does not.

```bash
# the narrower "projected into a response field" subset
grep -rnE '\b(mediaUrls?|imageUrl|thumbnailUrl|media_url)\s*:\s*.*media_urls' \
  artifacts/api-server/src/routes artifacts/api-server/src/lib \
  --include='*.ts' | grep -v '\.test\.ts'
```

17 hits across 14 files as of 2026-08-10: `pulse.ts`, `airport.ts`, `events.ts`,
`adminPortavaPosts.ts`, `profileTabs.ts`, `hashtags.ts`, `placeLiving.ts`,
`placeRecaps.ts`, `placeDays.ts`, `sharedMoments.ts`, `discoverySearch.ts`,
`eventPostsDiscovery.ts`, `placeCollections.ts`, `placeCollectionsWorker.ts`.

**The narrow grep is not sufficient on its own** — `routes/posts.ts` renders
`media_urls` and matches neither pattern shape, because its select list
(`:223`) is handed to `mapPublicPost()` and the column passes through under its
snake_case name. Any surface that spreads the row rather than naming the field
is invisible to a field-name grep. Use the broad command when the question is
"who reads this column".

Shape notes that survive the churn:

- **Whole array** → a `mediaUrls` field (`… media_urls ?? []`, or
  `Array.isArray(post.media_urls) ? post.media_urls : []`).
- **First element only** → a single `mediaUrl`/`imageUrl`/`media_url` field.
  On these surfaces a dead `media_urls[0]` renders as broken/absent media even
  when later entries in the array are healthy — the array is never consulted past
  index 0.
- `routes/posts.ts` post creation writes `media_urls` and inserts **no**
  `post_media` row in the same handler.
- `lib/mediaAccess.ts` even authorizes by `.contains("media_urls", [publicUrl])`
  as a distinct branch from its `post_media` branch.

`post_media` is read by media moderation (`routes/adminMedia.ts`), the postcards
upload path (`routes/postcards.ts:191,426`), and the pHash dedup worker. It carries
per-item metadata `media_urls` cannot (`0103_post_media.sql` header lists exactly
which gaps it was added to close) — it did **not** replace the array column.

**Why:** a post can therefore have a broken/dead URL in `media_urls` and no
`post_media` row at all, or a healthy `post_media` row while the feed still renders
the stale array. A live census on 2026-08-09 reported 7 posts in the first state.
*(That count was not re-verified when this note was written — re-run the query
rather than quoting it.)*

**How to apply:** when a post renders wrong media, or renders none, query
`posts.media_urls` first — that is what the user sees. Fixing or deleting
`post_media` rows changes nothing about rendering, and vice versa; a cleanup task
scoped to one store must state explicitly that the other is untouched. Confirm both
sides against live before declaring a media problem fixed.
