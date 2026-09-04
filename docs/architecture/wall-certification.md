# Portava Wall — Construction Certification

| Field | Value |
| --- | --- |
| **Certified commit** | `8f186410d` (`origin/main`, 2026-09-04) |
| **Certification basis** | Construction / repository evidence only |
| **Database deployment state** | **Not certified by this review** — see §12 |
| **Date** | 2026-09-04 |
| **Lineage** | Campaign audit-with-fixes `#332` (2026-09-03) → adversarial verification `#334`, `#342`, `#343`, `#344`, `#346` → this refresh. Every code claim below was re-verified against `8f186410d`; the two earlier documents were treated as hypotheses, not sources. |

**Headline: ~96% complete by construction** — 38 of 41 spec sections fully built,
3 partial. See §3 for the denominator and the two ways of counting it. This is a
**construction** figure and is *not* a measure of launch readiness: it says the
code named by the spec exists, is wired, typechecks and is tested. It says
nothing about runtime behaviour on a device (§13) or about what is deployed (§12).

Every load-bearing claim cites `file:line` at `8f186410d` so another developer
can reproduce the check. Line numbers drift; symbols are given alongside them.

---

## 1. Scope and limitations

**What this certifies.** For each spec section: does the named code exist, is it
wired into a live path, and is it exercised by a passing test?

**Two limitations, stated up front:**

1. **The canonical Wall spec (§1–41, TABLE 0–7) is not in this repository.** A
   repo-wide search finds no copy; this file is the only artifact that references
   the section numbering. Section *numbering and requirements* are therefore
   inherited from the `#332` certification's reading of that external document.
   Every *code* claim in this file has been independently re-verified; the mapping
   from a section number to what that section demands has not, because the source
   is not available here. A reader who has the spec should re-check the mapping.
2. **Database state is not checked.** Repository presence of a migration is not
   deployment. See §12.

**Trees in scope:** backend `artifacts/api-server/` (paths below are relative to
`src/`), client `travel-buddy-standalone/` (paths relative to
`src/features/wall/` unless stated). The repo-root `src/app` tree is out of scope.

---

## 2. Corrections to the 2026-09-03 certification

That document (`#332`) was stale in **both** directions: five PRs landed after it
(`#334`, `#342`, `#343`, `#344`, `#346`), and two of its verdicts were more
generous than its own prose.

| Change | Section | Was | Now | Why |
| --- | --- | --- | --- | --- |
| **Upgrade** | §12 Shared Moments / media | PARTIAL | **BUILT** | `#334` added `WallCandidateLoaders.ts` and wired all three loaders. The "candidate loader not wired / Posts-only" finding is obsolete. Evidence §5.2. |
| **Downgrade** | §16 Two clocks | BUILT | **PARTIAL** | No producer assigns `experienceAt` anywhere in the server tree. The contract is structurally present but collapses to one clock in practice. `#332` said as much in its own §16 note while scoring it BUILT. §4.1. |
| **Downgrade** | §19 RAB / contextual opportunity | BUILT | **PARTIAL** | The buddy Context Thread is built, but nothing can produce a `contextual_opportunity` object. 1 of 7 Wall object types is unreachable from the server. `#332` listed this gap in prose but did not count it. §4.2. |
| **Reclassify** | §33 Performance | PARTIAL | **BUILT (construction)** | Its construction obligations (bounded fetch, independent live call, lazy media) are all met. The residual — `<500 ms`, 60 fps — is a *runtime measurement*, not a construction artifact; counting it as a construction gap double-counts Runtime QA. Moved to §13. Sensitivity stated in §3. |
| **Correct** | "No privacy, safety, ordering, or degradation defect was found" | asserted | **withdrawn** | Adversarial verification after `#332` found and fixed five Wall defects: a fail-open eligibility path, a §28 cursor-drift path, a false `caughtUp`, a decorative `snapshotAt`, and personal data surviving account deletion. All fixed with regression tests. §5. |
| **Correct** | Client test count | 8 files | **9 files** | `hooks/__tests__/useWallFeed.inFlightGuard.component.test.tsx` was added by `#343`. |
| **Correct** | Test counts | 74 tests / 10 files | **100 tests / 12 files** | `#334` and `#344` added `wallCandidateLoaders` and `wallFollowingCaughtUp`; `#346` added three cursor tests. Reproduced, §11. |
| **Sharpen** | §31 Prefetch | "implicit (FlatList windowing)" | see §4.3 | `WallFeed` sets no windowing props at all; the implicit behaviour is weaker than the prior wording implied. |
| **Correct** | Two symbol citations | `isSocialContent`; server-side `trackRealWorldOutcome` | `isSocialObject` (`WallDiversityService.ts:98`); client-side `wallAnalytics.trackRealWorldOutcome` | Mis-cited in `#332`. |

The `#332` headline of "~96%" and this one's "~96%" coincide by accident, not
agreement: one gap closed and two opened.

---

## 3. Construction score

**Denominator: the 41 spec sections §1–41.** One section = one unit. A section is
BUILT when the code it names exists, is wired into a live path, and is tested;
PARTIAL when the structure exists but a required piece is absent.

| Measure | Value |
| --- | --- |
| **Strict** (partials score 0) | **38 / 41 = 92.7%** |
| **Part-credit** (partials score 0.5) | **(38 + 1.5) / 41 = 39.5 / 41 = 96.3%** |

Sensitivity: if you disagree with the §33 reclassification and count its
unmeasured runtime targets as a construction gap, the figures are **37/41 =
90.2%** strict and **39/41 = 95.1%** part-credit. Nothing else in the ledger is
close to a judgement call.

### Secondary measures (each independently verified)

| Measure | Value | Evidence |
| --- | --- | --- |
| Client object renderers | **7 / 7** | `components/WallObjectRenderer.tsx:92-108` — a `case` for every member of the union, plus `default: return null` so an unknown type never crashes the feed. |
| **Server-emittable** object types | **6 / 7** | `routes/wall.ts classifyObjectType:303-308` emits `discovery`/`video`/`social_post`/`social_update`; `WallCandidateLoaders.ts` emits `postcard` (`:216`), `video` (`:329`), `shared_moment` (`:444`). **Nothing emits `contextual_opportunity`.** |
| Rollout phases (TABLE 7) | **6 built + 1 partial** | Phases 1–5 and 7 built; Phase 6 partial (buddy thread built, Dispatch producer absent). §7. |
| §40 non-negotiables | **7 / 7 PASS** | §8. |
| HARD invariants | **9 / 9 hold**, three of them strengthened since `#332` | §9. |
| Backend Wall tests | **100 / 100 pass, 27 suites, 12 files** | §11 |
| Client Wall tests | **16 / 16 pass, 9 suites** | §11 |

---

## 4. Remaining construction work

Three items. All three are **missing producers, not missing plumbing** — in every
case the type, the projection path, the renderer and the consumer already exist
on both sides. That is why the score is high and the remaining work is narrow.
This list is exhaustive as of `8f186410d`; it is deliberately not padded with
speculative improvements.

### 4.1 §16 — `experienceAt` has no producer

The two-clock contract is structurally complete and functionally inert.

*Present:* the optional field on the projection base
(`lib/wallProjection.ts:213`); the field on the loader input type
(`WallCandidate.experienceAt`, `services/wall/WallProjectionService.ts:70`); the
pass-through in `projectOne` (`:253`, `experienceAt: c.experienceAt ?? undefined`);
five client consumers — `PostcardWallItem` (date stamp), `SharedMomentWallItem`,
`VideoWallItem`, `ActorByline` (`components/objects/wallItemShared.tsx:223-256`,
which shows "Happened …" only when `experienceAt !== publishedAt`, `:232`) and the
two `WallObjectRenderer` inline items.

*Absent:* any assignment. A search of the whole server tree for `experienceAt`
outside tests returns exactly five hits — two type declarations, two doc comments
(`lib/wallProjection.ts:247`, `FollowingFeedService.ts:12`) and the one
pass-through. Neither the Posts spine (`routes/wall.ts loadCandidates:310`) nor
any of the three loaders in `WallCandidateLoaders.ts` sets it.

*Consequence:* every client consumer takes its `?? publishedAt` fallback on every
object. The Wall renders one clock, always.

**Completion condition:** a legitimate source assigns `experienceAt` from when the
represented experience occurred (e.g. a Postcard's trip/experience date, a
delayed-location post's capture time), **with tests proving `publishedAt` and
`experienceAt` can differ** and that Following still sorts on `publishedAt` only
(`FollowingFeedService.ts:11-14` — "never experienceAt").

### 4.2 §19 / Phase 6 — `contextual_opportunity` has no candidate producer

**1 of 7 Wall object types is currently unreachable from the server.**

*Present:* the union member and projection interface
(`lib/wallProjection.ts:231,290`); the `kind` field on `WallCandidate`
(`WallProjectionService.ts:88`, commented "contextual_opportunity kind (spec
§19)"); the `projectOne` case (`:280-283`); dedupe precedence
(`CANDIDATE_TYPE_RANK.contextual_opportunity = 6`, `:341`); diversity
classification — `isSocialObject` (`WallDiversityService.ts:98-99`) treats it as
an *insertion*, so the discovery-cap prune already governs it; the client type
and the `ContextualOpportunityWallItem` renderer (`WallObjectRenderer.tsx:104`).

*Absent:* any candidate source. Nothing anywhere constructs a `WallCandidate`
with `objectType: "contextual_opportunity"` — the only occurrence of that
literal in `services/` + `routes/` is the projection's own pass-through
(`WallProjectionService.ts:283`). `projectOne` can *translate* such a candidate;
no code path can *create* one.

Note this is distinct from the rest of §19: the Rent-a-Buddy **Context Thread**
half is built and tested (`ContextThreadService.readBuddyCandidate:572-620`,
city granularity only, reads only the honest `available_now` flag `:586`, behind
`wall_rab_integration_enabled`).

**Completion condition:** a real candidate source feeds `contextual_opportunity`
into the candidate/projection pipeline, with eligibility, ranking and diversity
tests — the same bar the three `#334` loaders met.

### 4.3 §29 / §31 — no explicit prefetch architecture

*Absent:* `wallPrefetch.ts`, named by the spec, does not exist. A
case-insensitive search for `prefetch` across the entire
`travel-buddy-standalone/src/features/wall/` tree returns **zero** hits.

*What actually happens today:* `components/WallFeed.tsx:96-103` renders a
`FlatList` that sets `onEndReachedThreshold`, `onViewableItemsChanged` and
`viewabilityConfig` — but **no** windowing props (`windowSize`,
`initialNumToRender`, `maxToRenderPerBatch`, `removeClippedSubviews` are all left
at RN defaults). Media caching comes from `CachedImage` → `expo-image`
(`components/CachedImage.tsx:3`), which is a cache-on-first-paint: nothing warms it
ahead of the scroll.

This should not be credited as an implementation of the specified behaviour. The
codebase demonstrates it knows the difference —
`components/media/WatchFeedList.tsx:484-491` implements real poster prefetch
("preload upcoming items", next 2 on active-index change via `Image.prefetch`).
The Wall does not use it.

**Completion condition:** implement the specified prefetch layer with bounded
resource behaviour (an explicit lookahead window and cache ceiling), plus tests.

---

## 5. Fixes landed since the 2026-09-03 certification

One ledger, oldest first. Each entry names the defect, the fix and the regression
test. Entries 5.3–5.6 are the adversarial-verification fixes; they are the reason
the `#332` sentence "no privacy, safety, ordering, or degradation defect was
found" is withdrawn (§2).

### 5.1 `#332` — bare `<Image>` for private-bucket media (invariant #9 / §35) — FIXED

`WallImage` rendered post/postcard/video/discovery/shared-moment media through a
bare React-Native `<Image>`, which cannot load a private-bucket reference and
paints dead whitespace. Swapped for `CachedImage` (which signs private-bucket
URLs via `useHydratedMedia` and shows a fallback on a null resolve). Re-verified
at `8f186410d`: zero bare `<Image>` remain in the Wall tree;
`components/objects/wallItemShared.tsx:17` imports `CachedImage`, `:208` renders
it, `:237` uses it for the avatar.

### 5.2 `#334` — candidate loaders for postcards / video / shared moments — closed §12 and the `media` gap

`#332`'s largest open finding read: "the candidate *loader* for shared_moment is
not yet wired into `routes/wall.ts loadCandidates` (Posts-only today)", and
separately that `media` was not populated. Both are obsolete.

**The loaders exist:** `services/wall/WallCandidateLoaders.ts` exports
`loadPostcardCandidates:216` (reads `posts` + `post_media`, `:258`),
`loadVideoMediaCandidates:329` (delegates to the canonical media feed's
`loadEligibleCandidates:338` + `toMediaProjection:352`) and
`loadSharedMomentCandidates:444` (reads `shared_moment_memberships`, `:458`).
Each is capped at `LOADER_FETCH = 60` (`:52`).

**They are wired:** `routes/wall.ts:673-687` calls all three in a `Promise.all`
alongside the Posts spine, each with its own `.catch` that degrades to an empty
set (§34 fail-soft, so a broken loader costs one object *type*, never the feed).
`mergeLoadedCandidates` (`:688`) unions the results.

**The media projection path is complete:** `loadPostcardCandidates` populates
`media` from `post_media`; `loadVideoMediaCandidates` builds a `DisplayMedia`
from the canonical media projection. The results merge through `dedupeCandidates`
(`WallProjectionService.ts:364-375`), whose `candidateRichness` (`:351-352`) is
`CANDIDATE_TYPE_RANK[type] * 2 + hasMedia` — an explicit media tiebreak, so a
media-populated candidate supersedes the spine's media-less candidate for the
same `canonicalObjectId` while keeping its original feed position.

**Tested:** `test/wallCandidateLoaders.test.ts`, 19 tests, including "projects an
add_to_passport post as a postcard with media + place" (`:115`), "populates
DisplayMedia and classifies video vs photo" (`:237`), "surfaces an accepted
moment with block-filtered coarse participants" (`:299`), per-loader fail-soft
(`:136,256,375`), "postcards run the same visibility gate" (`:195`), and — for the
precedence rule — "prefers a media-populated projection over a media-less one of
the same type" (`:413`). "a merged mixed feed still gates + dedups through
projectObjects" (`:443`) proves the merged set still passes §23.

### 5.3 `#342` — `wall_session_intents` survived account deletion — FIXED (privacy)

`wall_session_intents` (migration 2271) carries `user_id … ON DELETE CASCADE`, but
account deletion keeps an anonymised tombstone profile rather than deleting the
`profiles` row, so the cascade never fires. Rows — including the `raw_text` echo
of what the user typed (`2271_wall_session_intents.sql:40-42`,
`WallSessionIntentService.ts:207`) — survived deletion as orphaned personal data.
Fix: an explicit, audited, user-scoped delete step `delete_wall_session_intent`
(`services/accountDeletion/AccountDeletionService.ts:1068`), classified in
`lib/deletionDispositions.ts:127,443`. Test:
`test/accountDeletionCascade.test.ts:340`. (The same PR fixed two Passport tables
the same way; out of scope here.)

### 5.4 `#343` (D12) — `useWallFeed` in-flight guard released by a stale request — FIXED (client)

`doFetch`'s `finally` guarded the loading resets by generation but cleared
`inFlightRef` unconditionally, so a superseded request resolving dropped the
guard while a newer request still ran; a refresh in that window stranded
`loading` true (permanent spinner). Fix: the `inFlightRef` release is now
generation-guarded too (`hooks/useWallFeed.ts:139-148`). Test:
`hooks/__tests__/useWallFeed.inFlightGuard.component.test.tsx:48`. (The same PR
fixed three Passport client defects; out of scope here.)

### 5.5 `#344` — three backend Wall defects — FIXED

- **D4 (MED, fail-open eligibility).** `loadSharedMomentCandidates` hardcoded
  `authorAccountStatus: 'active'` for the moment owner, so `passesEligibility`
  (`WallProjectionService.ts:178-183`) could never drop a banned/suspended owner's
  moment. Fix: real status threaded from the already-loaded profile
  (`WallCandidateLoaders.ts:411`; postcards likewise at `:298`). Test:
  `wallCandidateLoaders.test.ts:317` ("drops a shared moment whose OWNER is
  suspended/banned").
- **D5 (MED, §28 cursor stability).** The Post spine froze to `snapshotAt` but the
  three supplementary loaders were called with no horizon, so a newly-published
  postcard/video/moment entered mid-pagination and shifted ranks. Fix: the For You
  cursor's `snapshotAt` is threaded into all three (`routes/wall.ts:673`;
  postcards bound at the DB `WallCandidateLoaders.ts:237`, media and moments by
  `withinSnapshot:89-92`). Tests: `wallCandidateLoaders.test.ts:141,343`.
- **D10 (LOW, false `caughtUp`).** Following fetched only the newest
  `CANDIDATE_FETCH` (150) followed posts with no cursor lower bound; past the
  150th item the tail was unreachable and `caughtUp=true` was reported anyway.
  Fix: the fetch window slides to the cursor (`routes/wall.ts:344-346`) and
  `caughtUp` is asserted only when the fetch came back short of its cap
  (`:349`, `FollowingFeedService.ts:133-138`). Tests: `wallFollowingFeed.test.ts:96`;
  route-level `wallFollowingCaughtUp.test.ts:188,200`.

(The same PR fixed two Passport authz/privacy leaks — journey-memory visibility
and the shared-context block guard; out of scope here.)

### 5.6 `#346` — For You `snapshotAt` was never handed to the ranker — FIXED (§28)

`rankForYou` set `snapshotAt` on a new session and round-tripped it through the
cursor but scored against the wall clock, read once **per item**. Two
consequences: a tied pair could reorder between two calls when a millisecond
boundary fell between them (the one observed CI flake of
`wallForYouCursor.test.ts` "byte-for-byte stable", measured at ~0.045% with the
fix reverted), and page N+1 was scored later than page N so items near the slice
boundary could be served twice or skipped. Fix: `rankItems` gained `nowMs`,
resolved once per call; `rankForYou` passes `Date.parse(sess.snapshotAt)`
(`WallRankingService.ts:292-293,319`). Tests: `wallForYouCursor.test.ts:186,206,248`
(one instant not per item; snapshot not wall clock; a later snapshot ranks
differently — the positive control).

---

## 6. Section-by-section verdict (§1–41)

**BUILT** = present, wired, tested. **PARTIAL** = structure present, a required
piece absent. **MISSING** = absent. *No section is MISSING.*

| § | Topic | Verdict | Evidence (file · symbol · line at `8f186410d`) |
| --- | --- | --- | --- |
| 1–2 | Product definition / Wall jobs | BUILT | `components/WallScreen.tsx:88-122` composes QuickMedia→LiveForYou→Header→FeedMode→Feed; `WallFeed.tsx` renders projections with no dependency on intelligence (header is an optional `ListHeaderComponent`, `:56,101`). |
| 3 | Primary screen architecture | BUILT | `WallScreen.tsx`; bottom nav is the app tab bar (`app/(tabs)/_layout.tsx:423`, registered hidden behind `wall_enabled`). |
| 4 | Live For You | BUILT | `services/wall/LiveForYouService.ts` · `MAX_LIVE_FOR_YOU = 4` (`:42`, clamped `:117`), `MAX_SUBJECT_PROBES = 16` (`:46,129`), feed dedup; `LiveForYouStrip.tsx:54` renders `null` when empty. Test: `wallLiveForYou.test.ts:100,115`. |
| 5 | Feed modes | BUILT | For You `WallRankingService.rankForYou:273`; Following `FollowingFeedService.buildFollowing:105` (strict reverse-chron); `FeedModeSwitcher.tsx` (`WallScreen.tsx:111`). |
| 6 | Feed object model | BUILT | `lib/wallProjection.ts:224-231` · `WallObjectType` 7-member union + `WallProjection` base. *See §3 for the 6/7 emittable caveat.* |
| 7 | Social-first composition | BUILT | `WallProjectionService.buildActions:204-244` adds actions only when the object warrants; `ContextualActionChips` (`wallItemShared.tsx:308-309`) renders only non-`open_object` actions; person is visually primary (`ActorByline`). |
| 8 | Context Thread | BUILT | `services/wall/ContextThreadService.ts` — one compact attachment; readers for live (`:231`), trip, social (`:384`), gem, buddy (`:572`). |
| 9 | Context Thread eligibility gate | BUILT | `ContextThreadService.shouldAttachContextThread:103-117` — the 8-condition boolean ANDed, default false. Test: `wallContextThread.test.ts:152-176`. |
| 10 | Postcards | BUILT | `objects/PostcardWallItem.tsx` distinct paper frame + date stamp; producer `loadPostcardCandidates` (`WallCandidateLoaders.ts:216`); never a Post with a badge. Test: `wallCandidateLoaders.test.ts:115`. |
| 11 | Video | BUILT | `objects/VideoWallItem.tsx` inline poster, no forced fullscreen; producer `loadVideoMediaCandidates` (`:329`). Test: `wallCandidateLoaders.test.ts:237`. |
| **12** | **Shared Moments** | **BUILT** *(was PARTIAL)* | `loadSharedMomentCandidates:444` + wiring (`routes/wall.ts:683`) + dedupe precedence; owner eligibility real since `#344` (`:411`). Coarse participants, block-filtered. **Full evidence in §5.2, §5.5.** |
| 13 | Discovery in For You | BUILT | `WallDiscoveryInsertionService.explainDiscovery` — relationship/relevance ladder, popularity last; unexplained outside-graph objects dropped (`routes/wall.ts:470-484`). Tests: `wallDiscoveryInsertion.test.ts:77,85,100`; `wallDiscoveryRoute.test.ts:169,179`. |
| 14 | For You ranking | BUILT | `WallRankingService.rankForYou:273` wraps `DiscoveryRankingService.rankItems` (`:312-319`); "explore" surface, not watch-time. |
| 15 | Feed diversity controller | BUILT | `WallDiversityService.applyFeedDiversity:263-299` · `DEFAULT_FEED_DIVERSITY_POLICY:62` — actor/type spacing, discovery-cap prune, annotation cap, live-strip dedup. Test: `wallDiversity.test.ts:59-172`. |
| **16** | **Two clocks** | **PARTIAL** *(was BUILT)* | Shape + 5 client consumers present; **no producer assigns `experienceAt`.** `FollowingFeedService.ts:11-14` correctly sorts on `publishedAt` only. **§4.1.** |
| 17 | Global Input Intelligence | BUILT | `WallSessionIntentService` delegates to `lib/inputAssistance` gateway; session-scoped, `MAX_INTENT_TEXT` echo only (`:35,102`); steer never empties the feed (`routes/wall.ts:525-530`). Test: `wallSessionIntent.test.ts:19-110`. |
| 18 | Stories / Quick Media | BUILT | `QuickMediaRow.tsx` — top row (`WallScreen.tsx:88`), renders nothing when empty, `CachedImage`. |
| **19** | **Rent a Buddy / contextual opportunity** | **PARTIAL** *(was BUILT)* | Buddy Context Thread BUILT (`ContextThreadService.readBuddyCandidate:572-620`, city granularity, `available_now` only `:586`, behind `wall_rab_integration_enabled`). **`contextual_opportunity` has no producer — 1 of 7 object types unreachable. §4.2.** |
| 20 | Hidden Gems | BUILT | Protected / reveal-after-acceptance gems set `sensitiveDisclosure` (`ContextThreadService.ts:528,553`) and `viewerAuthorized: false` (`:547`) so the §9 gate suppresses them; discovery gem reason only when disclosure is public/approximate (`routes/wall.ts:425,480`). Tests: `wallContextThread.test.ts:236,262`. |
| 21 | Compass integration | BUILT | Action-only; `buildActions:220-222` adds `ask_compass` only when `compassHandoffEnabled` (flag read `routes/wall.ts:624`); `services/wallCompass.ts:12,44` phrases a QUESTION, never asserts inference; ids-only handoff. Test: `WallCompassHandoff.component.test.tsx:95,122`. |
| 22 | Map & Place | BUILT | No second place-state system — all current-state labels via `lib/liveClaimRead` (`LiveForYouService.ts:6,32`); place refs built with placeId/name/city/country only, no `lat`/`lng` (`routes/wall.ts:409-414`; `PublicPlaceRef` `lib/wallProjection.ts:73-81`). |
| 23 | Privacy / safety / visibility | BUILT | `WallProjectionService.projectObjects:303-324` — eligibility (`:311`) → block (`:314`) → visibility (`:323`) upstream of ordering; `loadBlockedAuthorIds:145-173` fail-closed both directions; `passesVisibility:189-201` defaults to not-authorized. Test: `wallProjection.test.ts:60-118`. |
| 24 | Projection architecture | BUILT | canonical → projection (`routes/wall.ts:701`) → gate → rank/sort (`:713,730`) → diversity/dedup (`:743`) → context (`:771`) → API (`:780-787`) → UI. |
| 25 | Service boundaries | BUILT | TABLE 2 owns/does-not-own honoured per service header; each service owns shape/order, never truth. |
| 26 | API shape | BUILT | `routes/wall.ts` — GET `/wall` (`:599`), GET `/wall/live` (`:795`), POST `/wall/session-intent` (`:832`), DELETE `/wall/session-intent` (`:869`), POST `/wall/impression` (`:887`), POST `/wall/action` (`:936`). |
| 27 | Response contract | BUILT | `lib/wallProjection.ts:387` · `WallResponse` = `mode`/`sessionIntent`/`liveForYou`/`items`/`nextCursor`/`caughtUp`/`generatedAt`; `caughtUp` honest since `#344` (§5.5). |
| 28 | Cursor & pagination | BUILT | Following cursor `publishedAt`+id tiebreak (`FollowingFeedService.decodeFollowingCursor:56`); For You cursor carries session+version+`snapshotAt`, which freezes the candidate set (`routes/wall.ts:337,363,673`) **and, since `#346`, is the ranker's evaluation instant** (`WallRankingService.ts:292-293,319`). Tests: `wallForYouCursor.test.ts` (9), `wallFollowingFeed.test.ts` (6). |
| 29 | Client architecture | BUILT | `src/features/wall/` matches the spec tree (components/objects/hooks/services/types). Naming variance: `ContextThreadView.tsx` for the spec's `ContextThread.tsx`. `wallPrefetch.ts` absent — scored under §31. |
| 30 | State ownership | BUILT | Rank score = Wall Ranking; cursor = Wall; intent = `wall_session_intents` (migration 2271, deleted with the account since `#342`); everything else read from its canonical owner. |
| **31** | **Caching & prefetch** | **PARTIAL** | Live strip short-TTL (`hooks/useLiveForYou.ts:21`) + degrade-when-stale (`isValid:43-44`); feed keeps items on failure. **No explicit prefetch layer exists. §4.3.** |
| 32 | Analytics | BUILT | `services/wallAnalytics.ts:72-202` full event set; ids + enums + counts only, never raw text (`services/wallApi.ts:248-263`). Test: `WallFeedAnalytics.component.test.tsx:99-155`. |
| **33** | **Performance targets** | **BUILT (construction)** *(was PARTIAL)* | Construction obligations met: `CANDIDATE_FETCH = 150` (`routes/wall.ts:98`), `LOADER_FETCH = 60` (`WallCandidateLoaders.ts:52`), live strip independent + probe-bounded (`LiveForYouService.ts:46`), lazy media. **Runtime targets unmeasured — §13, not a construction gap.** |
| 34 | Failure modes | BUILT | Every subsystem call in `routes/wall.ts` wrapped: live→empty strip (`buildLiveStrip:555-571`), projection→empty (`:700-705`), each loader→empty (`:675-686`), context→unannotated (`:770-778`); ranking→input order (`WallRankingService.ts:324-327`). Test: `wallRouteDegradation.test.ts:208-252`. |
| 35 | Design system rules | BUILT | One object at a time; Postcards break rhythm; purple as accent. Private-bucket media goes through `CachedImage` (§5.1). Runtime visual QA owed (§13). |
| 36 | Accessibility | BUILT (construction) | Labels/roles throughout; live state conveyed as TEXT not colour (`ContextThreadView.freshnessLabel:48-60`, `LiveForYouStrip.stateLabel:36`). On-device screen-reader pass owed (§13). |
| 37 | Security & abuse | BUILT | Server-side eligibility authoritative; `checkRateLimit` on session-intent / impression / action (`routes/wall.ts:854,906,953`); ranking metadata never exposes raw score (`lib/wallProjection.ts:185-194`); moderation drop in `passesEligibility:183`. |
| 38 | Testing matrix | BUILT | TABLE 6 families all represented across 12 backend + 9 client Wall test files. §10. |
| 39 | Rollout plan | BUILT | §7. |
| 40 | Non-negotiable product tests | BUILT — 7/7 | §8. The §16 and §19 downgrades touch none of them (neither `experienceAt` nor `contextual_opportunity` appears in any of the seven). |
| 41 | End-to-end Wall loop | BUILT | open→live→feed→object→context→handoff→create realized across route + client; social graph/memory feedback rides the existing canonical systems. |

---

## 7. Rollout phases (TABLE 7)

| Phase | Scope | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Shell, For You/Following, Posts/photos/video/Postcards | BUILT | Route + 7 object renderers + mode switch. Flag `wall_enabled`. |
| 2 | Live For You strip | BUILT | `LiveForYouService` + `useLiveForYou`. Flag `wall_live_for_you_enabled`. |
| 3 | Context Threads (Place/Trip/Gem) | BUILT | `ContextThreadService` + §9 gate. Flag `wall_context_threads_enabled` (migration 2272). |
| 4 | Shared Moments, discovery insertions, diversity | **BUILT** *(was partial)* | Shared-Moment loader wired by `#334` (§5.2), owner eligibility fixed by `#344`; discovery + diversity wired. Flag `wall_discovery_insertions_enabled`. |
| 5 | Input Intelligence steering, Compass handoffs | BUILT | `WallSessionIntentService` + `wallCompass`. Flags `wall_input_intelligence_enabled`, `wall_compass_handoff_enabled`. |
| 6 | RAB/Buddy integration, Dispatch | **PARTIAL** | Buddy Context Thread built behind `wall_rab_integration_enabled`. **Dispatch: `contextual_opportunity` has no producer (§4.2).** |
| 7 | Outcome learning, personalization, continuous certification | BUILT (seams) | Client `wallAnalytics.trackRealWorldOutcome(projection, outcome, consented)` (`:202-207`) returns early when `consented` is false, so an un-consented outcome is never recorded; the outcome is a coarse enum, never raw text. Personalization rides `DiscoveryRankingService`. Continuous certification is this document + the test matrix. |

**6 built + 1 partial.**

---

## 8. §40 Non-Negotiable Product Tests (as code assertions)

| # | Test | Result | Why (file:line at `8f186410d`) |
| --- | --- | --- | --- |
| a | Enjoyable as **pure social media** | **PASS** | `components/WallFeed.tsx:96-103` renders projections in order with zero dependency on live strip or context threads; the header is an optional `ListHeaderComponent` (`:56`). A plain text post renders as a plain post (`objects/SocialPostWallItem.tsx`). Test: `WallScreen.liveDegrades.component.test.tsx:59` ("keeps a working social feed when the live strip fails"). |
| b | Live For You **ignorable** | **PASS** | `components/LiveForYouStrip.tsx:54` returns `null` when empty; it is a header fragment (`WallScreen.tsx:92,122`), never gating scroll. `hooks/useLiveForYou.ts:51,65` idles when disabled. Server bounds it to ≤4 (`LiveForYouService.ts:42,117`). Tests: `LiveForYouStrip.boundedIgnorable.component.test.tsx:41,53`. |
| c | **Strict chronological Following** exists | **PASS** | `FollowingFeedService.buildFollowing:105-140` orders `publishedAt` DESC + `canonicalObjectId` DESC tiebreak, **no relevance reordering** (TABLE 1; header `:11-14` "never experienceAt"); `FeedModeSwitcher` always rendered (`WallScreen.tsx:111`). Tests: `wallFollowingFeed.test.ts:27`; `wallRouteDegradation.test.ts:221`; `WallScreen.modeSwitch.component.test.tsx:63`. |
| d | Postcards/videos **native + distinct** | **PASS** | Distinct renderers `objects/PostcardWallItem.tsx` (paper/rotation/date-stamp) and `objects/VideoWallItem.tsx` (inline); dispatched by `WallObjectRenderer.tsx:92-108` on discriminated `objectType`; never one card template. Since `#334` both are server-produced (`WallCandidateLoaders.ts:216,329`). Tests: `WallScreen.objectTypes.component.test.tsx:55`; `wallCandidateLoaders.test.ts:115,237`. |
| e | Contextual intelligence **only when useful** | **PASS** | `ContextThreadService.shouldAttachContextThread:103-117` defaults false and requires all 8 conditions; at most one thread per object (`selectContextThread:149-160`); `attachContextThreads` reads `wall_context_threads_enabled` once, fail-closed (`WallProjectionService.ts:417`); flag seeded OFF (2272). Tests: `wallContextThread.test.ts:152-176,406`; `wallDiscoveryRoute.test.ts:193,208`. |
| f | Social object → Map/Trip/Compass/Gem/Buddy **without forced transition** | **PASS** | Actions are additive & optional (`buildActions:204-244`; `ask_compass` only behind its flag `:220-222`); the client renders chips only when present (`ContextualActionChips`, `wallItemShared.tsx:308-309`). Handoffs route to canonical surfaces on tap (`resolveActionRoute`, `wallItemShared.tsx:93`; `services/wallCompass.ts:44-73`), never auto-navigate; a missing route never crashes the feed (`wallCompass.ts:63-73`). Tests: `WallCompassHandoff.component.test.tsx:95,122`; `WallFeedAnalytics.component.test.tsx:114`. |
| g | All intelligence fails → **safe social feed remains** (§34) | **PASS** | Route wraps every subsystem: rank→input order (`WallRankingService.ts:324-327`), projection→empty (`routes/wall.ts:700-705`), each loader→empty (`:675-686`), live→empty strip (`buildLiveStrip:562-571`), context→unannotated (`:770-778`). Tests: `wallRouteDegradation.test.ts:208` ("returns a safe social feed when the live subsystem fails"), `:231`; `wallLiveForYou.test.ts:141,156`; `WallScreen.liveDegrades.component.test.tsx:59`. |

---

## 9. HARD invariants — verified with evidence

1. **Server-side eligibility authoritative + fail-closed flags; master flag
   short-circuits before canonical reads (§37/§24).**
   Every route checks `isFlagEnabled(sc, "wall_enabled")` and returns
   `feature_disabled` *before* any candidate read: `routes/wall.ts:606-607`
   (GET /wall), `:802-803` (GET /wall/live), `:839-840` (POST session-intent),
   `:876-877` (DELETE session-intent), `:894-895` (POST impression), `:943-944`
   (POST action). `isFlagEnabled` returns `false` on any error
   (`lib/featureFlags.ts:21,24`). All seven flags seeded OFF: migrations
   `2270_wall_feature_flags.sql` (5; postcondition `:85-86`) +
   `2272_wall_context_thread_flags.sql` (2; postcondition `:72-73`), each raising
   `POSTCONDITION FAILED … seeded ON` if `on_count <> 0`. Test:
   `wallRouteDegradation.test.ts:252` ("gates every route behind wall_enabled").

2. **No blocked/private/sensitive leakage in items, context, or live strip (§23).**
   Gate order is eligibility→block→visibility, upstream of all ordering:
   `WallProjectionService.projectObjects:303-324` (`:311`, `:314`, `:323`).
   Block is bidirectional and **fail-closed** — an unreadable `blocks` table
   drops the whole queried author set (`loadBlockedAuthorIds:145-173`, returns
   `new Set(unique)` at `:163,173`). Visibility for non-post objects defaults to
   *not authorized* (`passesVisibility:199-201`). **Strengthened by `#344` D4:**
   a shared moment's owner status is now real, so a banned/suspended owner's
   moment is dropped by `passesEligibility:178-183` (`WallCandidateLoaders.ts:411`).
   Context threads: protected/reveal-after-acceptance gems set
   `sensitiveDisclosure` + `viewerAuthorized: false`
   (`ContextThreadService.ts:528,547,553`) so the §9 gate suppresses them;
   social-presence has a k-anonymity floor `SOCIAL_PRESENCE_MIN = 2` (`:375`) and
   reads only PUBLIC posts by followed people (`:384-399`). Live strip carries
   only decision-exposure fields, never coordinates (`lib/wallProjection.ts:322-346`;
   `LiveForYouService.labelFor:74-84`). Tests: `wallProjection.test.ts:70,78,90,102,111`;
   `wallCandidateLoaders.test.ts:195,317,364`; `wallContextThread.test.ts:262,371,386`.

3. **For You cursor stable — page 2 never reshuffles page 1; no cross-page dupes (§28).**
   The full candidate set is ranked to a *total* order (finalScore desc +
   session-seeded deterministic tiebreak, `WallRankingService.ts:333-338`) and
   sliced at the cursor offset, with the candidate set held steady by
   `snapshotAt` on the Post spine (`routes/wall.ts:337,363`) **and, since `#344`
   D5, on all three supplementary loaders** (`:673`; `WallCandidateLoaders.ts:237,
   89-92`). **Since `#346`, `snapshotAt` is also the ranker's evaluation instant**
   (`WallRankingService.ts:292-293,319`), so every page of a session is scored at
   one moment; previously the clock was read per item, which made a tied pair
   reorder between calls and let items near the offset boundary be served twice
   or skipped. De-dupe by `canonicalObjectId` in the ranked set (`:297-302`) and
   again client-side (append-only, `hooks/useWallFeed.ts:50-63`). Tests:
   `wallForYouCursor.test.ts:51` ("page 2 continues page 1 with no overlap and no
   reshuffle"), `:76` ("byte-for-byte stable"), `:107` (dedupe), `:186,206,248`
   (evaluation instant); `wallCandidateLoaders.test.ts:141,343` (loader horizon).

4. **Stale live labels degrade, never fabricated (§4/§34).**
   `LiveForYouService.freshnessFor:66-68` marks expired claims `stale` and the
   assembler skips them (`:149-150`); the read path itself returns `[]` whenever
   Live intelligence is not servable (`:15-17`). Client `useLiveForYou.isValid:43-44`
   expires items past `validUntil` between refetches;
   `ContextThreadView.freshnessLabel:48-60` returns `null` for stale/unknown so no
   "live" label is ever shown on a stale fact. Tests: `wallLiveForYou.test.ts:128,141`.

5. **Diversity controller prevents floods (§15).**
   `WallDiversityService.applyFeedDiversity:263-299` — discovery-cap prune,
   `CreatorCapEnforcer` consecutive-run break (`:277`) + windowed actor/type
   spacing (the "5 videos in a row" cap), annotation cap, live-strip dedup. Only
   prunable insertions (`!isSocialObject`, `:98-99`) are ever dropped; social
   objects are only reordered. Tests: `wallDiversity.test.ts:59,78,100,127,152,172`.

6. **Context Thread earns space; §9 gate defaults false (§8/§9).**
   `ContextThreadService.shouldAttachContextThread:103-117` is the spec boolean
   verbatim (all 8 conditions ANDed); at most one thread selected
   (`selectContextThread:149-160`); whole surface behind
   `wall_context_threads_enabled` (fail-closed, read once,
   `WallProjectionService.attachContextThreads:409-417`). Tests:
   `wallContextThread.test.ts:156,203,212,220,406`.

7. **Map integration read-only; no second place-state system (§22).**
   The Wall stores/derives no place state. Every live/current-state label comes
   from `lib/liveClaimRead` (`LiveForYouService.ts:32`,
   `ContextThreadService.readLivePlaceCandidate:231`); place refs deliberately
   omit coordinates (`routes/wall.ts:409-414`). Actions route into canonical
   Map/Place surfaces (`resolveActionRoute`, `wallItemShared.tsx:93`).

8. **Analytics never log raw private text (§32).**
   `services/wallAnalytics.ts` events carry only `objectId`/`objectType`/enums/
   counts; server mutation payloads are ids + verb only
   (`services/wallApi.ts:248-263`); session intent stores the *structured* intent
   plus a bounded echo, never a transcript (`WallSessionIntentService.ts:35,102,207`;
   `2271_wall_session_intents.sql:15,40-42`). **Strengthened by `#342`:** that
   echo is now deleted with the account (§5.3). Test:
   `WallFeedAnalytics.component.test.tsx:138` ("signals the server (ids only)").

9. **No bare `<Image>` for private-bucket media (§35).**
   Re-verified: zero bare `<Image>` remain in `src/features/wall/`; `WallImage`
   uses `CachedImage` (`wallItemShared.tsx:17,208`). Fixed in `#332` (§5.1).

---

## 10. Testing matrix (TABLE 6) — what proves each family

| Family | Proven by |
| --- | --- |
| Ordering | `wallFollowingFeed.test.ts` (6), `wallForYouCursor.test.ts` (9), `wallFollowingCaughtUp.test.ts` (2) |
| Privacy | `wallProjection.test.ts` (block both-directions, private drop, trip gate, fail-closed), `wallCandidateLoaders.test.ts:195,317,364`, `wallContextThread.test.ts` (gem disclosure, k-anonymity) |
| Dedup | `wallForYouCursor.test.ts:107`, `wallFollowingFeed.test.ts:86`, `wallCandidateLoaders.test.ts:405-443`, client `useWallFeed` |
| Freshness | `wallLiveForYou.test.ts`, `wallContextThread.test.ts`, `wallForYouCursor.test.ts:186-248` (evaluation instant) |
| Media | `wallCandidateLoaders.test.ts:115,237,413`; client `WallScreen.objectTypes.component.test.tsx` |
| Postcards | `wallCandidateLoaders.test.ts:115-195`; `PostcardWallItem` distinct route |
| Context | `wallContextThread.test.ts` (gate), `wallDiscoveryRoute.test.ts:193,208`, `WallCompassHandoff.component.test.tsx` |
| Offline / failure | `wallRouteDegradation.test.ts`, `wallCandidateLoaders.test.ts:136,256,375`, `wallLiveForYou.test.ts:141,156`, `WallScreen.liveDegrades.component.test.tsx`, `useWallFeed.inFlightGuard.component.test.tsx` |
| Accessibility | labels/roles across components (construction); runtime SR pass owed (§13) |

---

## 11. Test results — reproduced

Reproduced on a checkout whose Wall trees are byte-identical to `8f186410d`
(`git diff 8f186410d -- artifacts/api-server/src travel-buddy-standalone/src` is
empty). Not inherited from `#332` or `#352`.

| Suite | Command | Result |
| --- | --- | --- |
| Backend Wall | `node --import tsx/esm --test src/test/wall*.test.ts` | **100 tests / 27 suites / 0 fail** (12 files, 2.3 s) |
| Client Wall | `npx jest --testPathPattern='features/wall/.*\.component\.test\.'` | **16 tests / 9 suites / 0 fail** |
| Backend typecheck | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` | **PASS** (exit 0, clean) |
| Client full gate | `standalone · check:all` (guards + node:test + jest) | **PASS** as a required CI check on this branch |

Backend Wall test files (12): `wallCandidateLoaders`, `wallContextThread`,
`wallDiscoveryInsertion`, `wallDiscoveryRoute`, `wallDiversity`,
`wallFollowingCaughtUp`, `wallFollowingFeed`, `wallForYouCursor`,
`wallLiveForYou`, `wallProjection`, `wallRouteDegradation`, `wallSessionIntent`.

Client Wall test files (9): the 8 under `components/__tests__/` plus
`hooks/__tests__/useWallFeed.inFlightGuard.component.test.tsx` (added by `#343`).

Reproduction notes:
- `wallRouteDegradation`, `wallDiscoveryRoute` and `wallFollowingCaughtUp` bind a
  loopback socket. Under a sandbox that blocks `listen(2)` they hang rather than
  fail — a sandboxed run silently under-tests the Wall by three files. The
  counts above are from an unsandboxed run.
- `npx tsc` at the api-server root can exit 0 without compiling; use the
  `./node_modules/.bin/tsc` path above.
- The one Wall test ever observed to flake in CI (`wallForYouCursor.test.ts:76`)
  had its root cause removed by `#346` (§5.6).
- Between `cced3b12` (`#346`, the base `#352` certified) and `8f186410d`, the only
  Wall-tree change is a type annotation on a test callback in
  `useWallFeed.inFlightGuard.component.test.tsx` (test-typecheck work). Every
  line reference in this document was taken at `8f186410d`.

---

## 12. Deployment / rollout posture — NOT construction

Kept deliberately separate. Nothing here is counted as a construction gap.

**Feature flags — 7, all seeded OFF, fail-closed.** Repository evidence:
`src/migrations/2270_wall_feature_flags.sql` seeds 5 (`wall_enabled`,
`wall_live_for_you_enabled`, `wall_discovery_insertions_enabled`,
`wall_input_intelligence_enabled`, `wall_compass_handoff_enabled`) and
`2272_wall_context_thread_flags.sql` seeds 2 (`wall_context_threads_enabled`,
`wall_rab_integration_enabled`) — every one `false`. Both migrations carry a
postcondition that raises `POSTCONDITION FAILED: … seeded ON — … must ship OFF`
if `on_count <> 0` (`2270:85-86`, `2272:72-73`). `wall_enabled` is the master
gate and every route checks it before any canonical read (§9 #1);
`isFlagEnabled` treats an unreadable flag as off. The client tab is registered
but hidden (`app/(tabs)/_layout.tsx:423`).

**Migrations 2270 / 2271 / 2272 are present in the repository.**

> **Database application state not certified by this construction review.**

Repository presence of a migration is not a deployed migration. No database was
queried for this certification. Whether 2270–2272 have been applied to CI or
production — and therefore whether the flags physically exist as rows and
`wall_session_intents` exists to be deleted from — is unverified here and must be
established separately before any go-live decision.

---

## 13. Runtime QA — owed before go-live, not construction

Provable only on a device against a live backend:

- **Scroll performance** — 60 fps (TABLE 4) with a full media feed; needs an
  on-device profiler. Related: §4.3 (no prefetch layer) is the most likely
  construction-side contributor to a miss here.
- **First-page latency** — `< 500 ms` backend-excluding-network against a
  production-sized `posts`/`post_media`/`profiles`/`places`/`blocks` dataset.
  The fetch is bounded (`CANDIDATE_FETCH = 150`, `LOADER_FETCH = 60` ×3) but real
  latency needs a load test.
- **Autoplay + reduced motion** — the shell defers autoplay to policy; actual
  autoplay-on-scroll, pause-on-scroll-away and OS reduced-motion (§11/§36) need
  iOS + Android verification.
- **Live intelligence with real claims** — `liveClaimRead` returns `[]` in test,
  so Live For You and live_place freshness/label/dedup are unexercised end to end.
- **Private-bucket media paint** — `CachedImage` is correct by construction; the
  sign-endpoint round-trip should be eyeballed on device now that `#334`
  populates `media`.
- **End-to-end intent steering + Compass/Buddy handoffs** with the real Global
  Input Intelligence layer and the AI tab prefill.
- **Screen-reader pass** and the §35 visual density/rhythm judgement.

---

## 14. How to reproduce this certification

```
git checkout 8f186410d
cd artifacts/api-server && ln -s <shared>/node_modules node_modules
node --import tsx/esm --test src/test/wall*.test.ts          # 100/100, unsandboxed
./node_modules/.bin/tsc -p tsconfig.json --noEmit            # clean
cd ../../travel-buddy-standalone
npx jest --testPathPattern='features/wall/.*\.component\.test\.'   # 16/16

# §4.1 — no experienceAt writer outside the two type decls + pass-through.
# Returns NOTHING.
grep -rn "experienceAt" artifacts/api-server/src --include='*.ts' \
  | grep -v /test/ | grep -v "wallProjection.ts\|WallProjectionService.ts\|FollowingFeedService.ts"

# §4.2 — no contextual_opportunity producer. Returns exactly ONE line,
# WallProjectionService.ts projectOne's own pass-through; a producer would
# appear as a second hit in a loader or route.
grep -rn 'objectType: "contextual_opportunity"' \
  artifacts/api-server/src/services artifacts/api-server/src/routes

# §4.3 — no prefetch anywhere in the Wall tree. Returns NOTHING.
grep -rni "prefetch" travel-buddy-standalone/src/features/wall/

# §9 #9 — no bare <Image> in the Wall tree. Returns only a code comment.
grep -rn '<Image\b' travel-buddy-standalone/src/features/wall/

# §5.3 — wall_session_intents is deleted with the account.
grep -n 'delete_wall_session_intent' \
  artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts
```
