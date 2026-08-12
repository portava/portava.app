# Consumers of the post `media` projection — enumeration

Required before broadening the `media` array with synthetic external entries
(#3586). Enumeration, not sampling: every consumer across both trees, with
whether it depends on fields a synthetic entry would lack.

**Result: the enumeration falsified the diagnosis it was meant to de-risk.**
Every *live* consumer of the post media projection already falls back to
`mediaUrls`. See §4.

## 1. Server — where the projection is built

| Site | Endpoint | Notes |
|---|---|---|
| `posts.ts:1152` | `GET /posts` (following) | `filterPostMedia` |
| `posts.ts:1298` | `GET /posts` (global) | `filterPostMedia` |
| `posts.ts:1462` | `GET /trips/:tripId/posts` | `filterPostMedia` |
| `posts.ts:1643` | `GET /posts/:postId` | inline projection, same shape |
| `posts.ts` `withPostMedia` | pending + 4 mutation routes | added by the #3585 fix |

Converted-to-resolver routes returning a **merged** `mediaUrls` (storage +
external, deduped, storage first by `sort_order`): pulse, profileTabs, hashtags,
airport, discoverySearch, eventPostsDiscovery (×2).

## 2. Client — consumers of the post `media` array

| Consumer | Live? | Falls back to `mediaUrls`? | Depends on |
|---|---|---|---|
| `PulseFeedCard.tsx:269,289` | **live** (`app/(tabs)/index.tsx`) | **yes** — `media[0]?.thumbnail_url ?? media[0]?.url ?? mediaUrl` | `media_type`, `thumbnail_url`, `duration_seconds`, `stamp_overlay` |
| `app/post/[id].tsx:128` | **live** | **yes** — `firstMediaItem?.url ?? post.mediaUrls[0]` | `url` |
| `services/pulse.ts:144` | **live** | **yes** | `thumbnail_url`, `url` |
| `app/destination/[slug].tsx:225` | **live** | **yes** | `thumbnail_url`, `url` |
| `services/profile.ts:361` `enrichPostcard` | **live** (postcards) | via legacy `mediaUrl` | **`processing_status`**, **`media_type`** |
| `PostcardsTab.tsx:182` local tile | **live** | **yes** — "fall back to legacy mediaUrl" | `thumbnail_url` |
| `PassportSections.tsx:92,106` `PostcardList` | **DEAD** — nothing imports it; only `TrustChip` is re-exported | no | — |
| `components/PostcardTile.tsx` | **DEAD** — re-exported via `domainCards`, no `app/` importer; shadowed by `PostcardsTab`'s local tile | no | — |
| `media/GemsFeed.tsx:186`, `GemsItemOverlay.tsx:104` | live, but **out of scope** — `GemsFeedItem.media` is `ServerMediaItem[]` from the `media_assets` pipeline, not the post projection | n/a | — |

## 3. The field-dependency finding

`enrichPostcard` (`services/profile.ts:361`) is the consumer that constrains any
synthetic entry:

```js
const readyMedia = media.filter((m) => m.processing_status === 'ready');
const primary = readyMedia[0] ?? media[0];
hasVideo: media.some((m) => m.media_type === 'video')
```

A synthetic entry omitting `processing_status` is dropped from `readyMedia`
(survives only via the `?? media[0]` tail), and one omitting `media_type` makes
`hasVideo` silently wrong. So synthetic entries **must** carry
`processing_status: 'ready'` and a real `media_type`, or this consumer must
branch on the `source` discriminator. No live consumer reads `id`,
`sort_order` or `moderation_status` off the projection.

## 4. Why the projection is not the fix for #3586

Every **live** consumer of the post media projection already falls back to
`mediaUrls`, and the routes that feed the surfaces where editorial posts appear
return a **merged** `mediaUrls` containing the external reference. The two
readers that are `media`-only — `PassportSections.PostcardList` and
`components/PostcardTile.tsx` — are **dead code**.

So "external post has no `media` entry" does not, on this evidence, explain a
user-visible render failure. Shipping the synthetic projection would broaden a
response contract consumed by six live surfaces to fix nothing observable, and
would introduce the `processing_status` / `media_type` coupling in §3 for no
measured gain.

**The diagnosis needs the actual repro before a fix is chosen.** What is needed
from the #3586 record: which screen, which post, and what "fails to render"
means — blank tile, designed fallback, or an error.

## 5. What remains true regardless

- `posts.media_urls` stays the storage home for external references, and
  `checkMediaUrlsExternalOnly` still enforces it. Nothing here proposes changing
  storage.
- If the projection is later shipped, §3 is its contract: `source:
  'storage' | 'external'` as a declared discriminator, plus
  `processing_status: 'ready'` and a real `media_type` on synthetic entries.
- The two dead readers should be deleted or wired, deliberately. Leaving a
  `media`-only reader in the tree is how the next surface inherits this bug.
