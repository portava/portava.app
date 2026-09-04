# Portava Wall — Construction Certification

| Field | Value |
| --- | --- |
| **Certified commit** | `cced3b12` (`main`) |
| **Certification basis** | Construction / repository evidence only |
| **Database deployment state** | **Not certified by this review** — see §9 |
| **Date** | 2026-09-04 |
| **Method** | Re-verified from the code up. The prior (2026-09-03) certification was treated as a hypothesis, not as a source. |

**Headline: ~96% complete by construction** — 38 of 41 spec sections fully built,
3 partial. See §3 for the denominator and the two ways of counting it. This is a
**construction** figure and is *not* a measure of launch readiness: it says the
code named by the spec exists, is wired, typechecks and is tested. It says
nothing about runtime behaviour on a device (§10) or about what is deployed (§9).

---

## 1. Scope and limitations

**What this certifies.** For each spec section: does the named code exist, is it
wired into a live path, and is it exercised by a passing test? Every claim below
cites a file and a symbol so another developer can reproduce the check.

**Two limitations, stated up front:**

1. **The canonical Wall spec (§1–41, TABLE 0–7) is not in this repository.** A
   repo-wide search finds no copy. Section *numbering and requirements* are
   therefore inherited from the prior certification's reading of that external
   document. Every *code* claim in this file has been independently re-verified
   against `cced3b12`; the mapping from a section number to what that section
   demands has not, because the source is not available here. A reader who has
   the spec should re-check the mapping.
2. **Database state is not checked.** Repository presence of a migration is not
   deployment. See §9.

**Trees in scope:** backend `artifacts/api-server/`, client
`travel-buddy-standalone/`. The repo-root `src/app` tree is out of scope.

---

## 2. Corrections to the 2026-09-03 certification

That document was stale in **both** directions. Three PRs landed after it
(`#334`, `#343`/`#344`, `#346`), and one of its verdicts was too generous.

| Change | Section | Was | Now | Why |
| --- | --- | --- | --- | --- |
| **Upgrade** | §12 Shared Moments | PARTIAL | **BUILT** | `#334` added `WallCandidateLoaders.ts` and wired it. The "candidate loader not wired / Posts-only" finding is obsolete. Evidence in §4. |
| **Downgrade** | §16 Two clocks | BUILT | **PARTIAL** | No producer assigns `experienceAt` anywhere in the server tree. The contract is structurally present but collapses to one clock in practice. |
| **Downgrade** | §19 RAB / contextual opportunity | BUILT | **PARTIAL** | The buddy Context Thread is built, but nothing can produce a `contextual_opportunity` object. 1 of 7 Wall object types is unreachable from the server. |
| **Reclassify** | §33 Performance | PARTIAL | **BUILT (construction)** | Its construction obligations (bounded fetch, independent live call, lazy media) are all met. The residual — `<500 ms`, 60 fps — is a *runtime measurement*, not a construction artifact, and counting it as a construction gap double-counts Runtime QA. Moved to §10. |
| **Correct** | Client test count | 8 files | **9 files** | `useWallFeed.inFlightGuard.component.test.tsx` was added by `#343`. |
| **Sharpen** | §31 Prefetch | "implicit (FlatList windowing)" | see §4 | `WallFeed` sets no windowing props at all; the implicit behaviour is weaker than the prior wording implied. |

The prior document's headline of "~96%" and this one's "~96%" coincide by
accident, not agreement: one gap closed and two opened.

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
| Client object renderers | **7 / 7** | `WallObjectRenderer.tsx` — a `case` for every member of the union, plus a `default: return null` so an unknown type never crashes the feed. |
| **Server-emittable** object types | **6 / 7** | `classifyObjectType` (`routes/wall.ts`) emits `discovery`/`video`/`social_post`/`social_update`; `WallCandidateLoaders` emits `postcard`/`video`/`shared_moment`. **Nothing emits `contextual_opportunity`.** |
| Rollout phases (TABLE 7) | **6 built + 1 partial** | Phases 1–5 and 7 built; Phase 6 partial (buddy thread built, Dispatch producer absent). §8. |
| Backend Wall tests | **100 / 100 pass, 27 suites, 12 files** | §7 |
| Client Wall tests | **16 / 16 pass, 9 suites** | §7 |

---

## 4. Remaining construction work

Three items. All three are **missing producers, not missing plumbing** — in every
case the type, the projection path, the renderer and the consumer already exist
on both sides. That is why the score is high and the remaining work is narrow.
This list is exhaustive as of `cced3b12`; it is deliberately not padded with
speculative improvements.

### 4.1 §16 — `experienceAt` has no producer

The two-clock contract is structurally complete and functionally inert.

*Present:* the optional field on the projection base (`WallProjectionBase.experienceAt`,
`lib/wallProjection.ts`); the field on the loader input type
(`WallCandidate.experienceAt`, `WallProjectionService.ts`); the pass-through in
`projectOne` (`experienceAt: c.experienceAt ?? undefined`); five client consumers
— `PostcardWallItem` (date stamp), `SharedMomentWallItem`, `VideoWallItem`,
`ActorByline` (`wallItemShared.tsx`) and the two `WallObjectRenderer` inline
items.

*Absent:* any assignment. A search of the whole server tree for `experienceAt`
outside tests returns exactly five hits — two type declarations, two doc comments
and the one pass-through. Neither the Posts spine (`routes/wall.ts loadCandidates`)
nor any of the three loaders in `WallCandidateLoaders.ts` sets it.

*Consequence:* every client consumer takes its `?? projection.publishedAt`
fallback on every object. The Wall renders one clock, always.

**Completion condition:** a legitimate source assigns `experienceAt` from when the
represented experience occurred (e.g. a Postcard's trip/experience date, a
delayed-location post's capture time), **with tests proving `publishedAt` and
`experienceAt` can differ** and that Following still sorts on `publishedAt` only
(`FollowingFeedService` — "never experienceAt").

### 4.2 §19 / Phase 6 — `contextual_opportunity` has no candidate producer

**1 of 7 Wall object types is currently unreachable from the server.**

*Present:* the union member and projection interface (`lib/wallProjection.ts`);
the `kind` field (`WallCandidate`, commented "contextual_opportunity kind (spec
§19)"); the `projectOne` case (`WallProjectionService.ts`); dedupe precedence
(`CANDIDATE_TYPE_RANK.contextual_opportunity = 6`); diversity classification —
`isSocialObject` treats it as an *insertion*, so the discovery-cap prune already
governs it (`WallDiversityService.ts`); the client type and the
`ContextualOpportunityWallItem` renderer.

*Absent:* any candidate source. Nothing anywhere constructs a `WallCandidate`
with `objectType: "contextual_opportunity"` — the only two occurrences of that
literal in the server tree are the type declaration and the projection's own
pass-through. `projectOne` can *translate* such a candidate; no code path can
*create* one.

Note this is distinct from the rest of §19: the Rent-a-Buddy **Context Thread**
half is built and tested (`ContextThreadService.readBuddyCandidate`, city
granularity only, behind `wall_rab_integration_enabled`).

**Completion condition:** a real candidate source feeds `contextual_opportunity`
into the candidate/projection pipeline, with eligibility, ranking and diversity
tests — the same bar the three `#334` loaders met.

### 4.3 §29 / §31 — no explicit prefetch architecture

*Absent:* `wallPrefetch.ts`, named by the spec, does not exist. A
case-insensitive search for `prefetch` across the entire
`travel-buddy-standalone/src/features/wall/` tree returns **zero** hits.

*What actually happens today:* `WallFeed` renders a `FlatList` that sets
`onEndReachedThreshold`, `onViewableItemsChanged` and `viewabilityConfig` — but
**no** windowing props (`windowSize`, `initialNumToRender`, `maxToRenderPerBatch`,
`removeClippedSubviews` are all left at RN defaults). Media caching comes from
`CachedImage` → `expo-image` ("disk + memory caching"), which is a
cache-on-first-paint: nothing warms it ahead of the scroll.

This should not be credited as an implementation of the specified behaviour. The
codebase demonstrates it knows the difference — `components/media/WatchFeedList.tsx`
implements real poster prefetch ("preload upcoming items", next 2 on active-index
change). The Wall does not use it.

**Completion condition:** implement the specified prefetch layer with bounded
resource behaviour (an explicit lookahead window and cache ceiling), plus tests.

---

## 5. Recently closed gap — §12 / media projection (was PARTIAL)

The prior certification's largest open finding is obsolete. It read: "the
candidate *loader* for shared_moment is not yet wired into `routes/wall.ts
loadCandidates` (Posts-only today)", and separately that `media` was not
populated. `#334` ("wave5 wall-backend: candidate loaders for
postcards/video/shared-moments") closed both.

**Evidence — the loaders exist:** `services/wall/WallCandidateLoaders.ts` exports
`loadPostcardCandidates` (reads `posts` + `post_media`),
`loadVideoMediaCandidates` (delegates to the canonical media feed's
`loadEligibleCandidates` + `toMediaProjection`) and `loadSharedMomentCandidates`
(reads `shared_moment_memberships`).

**Evidence — they are wired:** `routes/wall.ts` imports all three and calls them
in a `Promise.all` alongside the Posts spine, each with its own `.catch` that
degrades to an empty set (§34 fail-soft, so a broken loader costs one object
*type*, never the feed). All three receive the same `snapshotAtIso` horizon as
the spine, so a postcard/video/moment published mid-session cannot enter the
candidate set and drift ranks across pages (§28).

**Evidence — the media projection path is complete:** `loadPostcardCandidates`
populates `media` from `post_media`; `loadVideoMediaCandidates` builds a
`DisplayMedia` from the canonical media projection. The results merge through
`mergeLoadedCandidates` → `dedupeCandidates`, whose `candidateRichness` is
`CANDIDATE_TYPE_RANK[type] * 2 + hasMedia` — an explicit media tiebreak, so a
media-populated candidate supersedes the spine's media-less candidate for the
same `canonicalObjectId` while keeping its original feed position.

**Evidence — tested:** `src/test/wallCandidateLoaders.test.ts`, 19 tests,
including "projects an add_to_passport post as a postcard with media + place",
"populates DisplayMedia and classifies video vs photo", "surfaces an accepted
moment with block-filtered coarse participants", per-loader fail-soft and
snapshot-horizon cases, and — for the precedence rule — "prefers a
media-populated projection over a media-less one of the same type".

---

## 6. Section-by-section verdict (§1–41)

**BUILT** = present, wired, tested. **PARTIAL** = structure present, a required
piece absent. **MISSING** = absent. *No section is MISSING.*

| § | Topic | Verdict | Evidence (file · symbol) |
| --- | --- | --- | --- |
| 1–2 | Product definition / Wall jobs | BUILT | `WallScreen.tsx` composes Header→QuickMedia→LiveForYou→FeedMode→Feed; `WallFeed.tsx` renders projections with no dependency on intelligence. |
| 3 | Primary screen architecture | BUILT | `WallScreen.tsx`; bottom nav is the app tab bar. |
| 4 | Live For You | BUILT | `LiveForYouService` · `MAX_LIVE_FOR_YOU = 4`, `MAX_SUBJECT_PROBES = 16`, feed dedup; `LiveForYouStrip.tsx` renders `null` when empty. Test: `wallLiveForYou.test.ts`. |
| 5 | Feed modes | BUILT | For You `WallRankingService`; Following `FollowingFeedService.buildFollowing` (strict reverse-chron); `FeedModeSwitcher.tsx`. |
| 6 | Feed object model | BUILT | `lib/wallProjection.ts` · `WallObjectType` 7-member union + `WallProjection` base. *See §3 for the 6/7 emittable caveat.* |
| 7 | Social-first composition | BUILT | `WallProjectionService.buildActions` adds actions only when the object warrants; `ContextualActionChips` renders only non-`open` actions. |
| 8 | Context Thread | BUILT | `ContextThreadService` — one compact attachment; live/trip/social/gem/buddy readers. |
| 9 | Context Thread eligibility gate | BUILT | `ContextThreadService.shouldAttachContextThread` — the 8-condition boolean, default false. Test: `wallContextThread.test.ts`. |
| 10 | Postcards | BUILT | `PostcardWallItem.tsx` distinct paper frame + date stamp; `loadPostcardCandidates` producer; never a Post with a badge. |
| 11 | Video | BUILT | `VideoWallItem.tsx` inline poster, no forced fullscreen; `loadVideoMediaCandidates` producer. |
| **12** | **Shared Moments** | **BUILT** *(was PARTIAL)* | `loadSharedMomentCandidates` + wiring + dedupe precedence. **Full evidence in §5.** |
| 13 | Discovery in For You | BUILT | `WallDiscoveryInsertionService.explainDiscovery` — relationship/relevance ladder, popularity last; unexplained outside-graph objects dropped. Test: `wallDiscoveryInsertion.test.ts`. |
| 14 | For You ranking | BUILT | `WallRankingService.rankForYou` wraps `DiscoveryRankingService.rankItems`; "explore" surface, not watch-time. |
| 15 | Feed diversity controller | BUILT | `WallDiversityService.applyFeedDiversity` · `DEFAULT_FEED_DIVERSITY_POLICY` — actor/type spacing, discovery-cap prune, annotation cap. Test: `wallDiversity.test.ts`. |
| **16** | **Two clocks** | **PARTIAL** *(was BUILT)* | Shape + 5 client consumers present; **no producer assigns `experienceAt`.** `FollowingFeedService` correctly sorts on `publishedAt` only. **§4.1.** |
| 17 | Global Input Intelligence | BUILT | `WallSessionIntentService` delegates to `lib/inputAssistance` gateway; session-scoped. Test: `wallSessionIntent.test.ts`. |
| 18 | Stories / Quick Media | BUILT | `QuickMediaRow.tsx` — top row, renders nothing when empty, `CachedImage`. |
| **19** | **Rent a Buddy / contextual opportunity** | **PARTIAL** *(was BUILT)* | Buddy Context Thread BUILT (`ContextThreadService.readBuddyCandidate`, city granularity, behind `wall_rab_integration_enabled`). **`contextual_opportunity` has no producer — 1 of 7 object types unreachable. §4.2.** |
| 20 | Hidden Gems | BUILT | Protected / reveal-after-acceptance gems set `sensitiveDisclosure`; the §9 gate suppresses them (`ContextThreadService`). |
| 21 | Compass integration | BUILT | Action-only; `buildActions` adds `ask_compass` only behind `wall_compass_handoff_enabled`; `wallCompass.ts` phrases a question, ids-only handoff. |
| 22 | Map & Place | BUILT | No second place-state system — all current-state labels via `lib/liveClaimRead`; place refs omit coordinates. |
| 23 | Privacy / safety / visibility | BUILT | `WallProjectionService.projectObjects` — eligibility→block→visibility upstream of ordering; `loadBlockedAuthorIds` fail-closed both directions; `passesVisibility` defaults to not-authorized. Test: `wallProjection.test.ts`. |
| 24 | Projection architecture | BUILT | canonical → projection → gate → rank/sort → diversity/dedup → API → UI, as `routes/wall.ts`. |
| 25 | Service boundaries | BUILT | TABLE 2 owns/does-not-own honoured per service header; each service owns shape/order, never truth. |
| 26 | API shape | BUILT | `routes/wall.ts` — 2 GET (`/wall`, `/wall/live`), 3 POST (`session-intent`, `impression`, `action`), 1 DELETE (`session-intent`). |
| 27 | Response contract | BUILT | `lib/wallProjection.ts` · `WallResponse` = `mode`/`sessionIntent`/`liveForYou`/`items`/`nextCursor`/`caughtUp`/`generatedAt`. |
| 28 | Cursor & pagination | BUILT | Following cursor `publishedAt`+id tiebreak (`decodeFollowingCursor`); For You cursor carries session+version+`snapshotAt`, **and `snapshotAt` is now the ranker's evaluation instant** (`#346`). Tests: `wallForYouCursor.test.ts` (9), `wallFollowingFeed.test.ts`. |
| 29 | Client architecture | BUILT | `src/features/wall/` matches the spec tree (components/objects/hooks/services/types). Naming variance: `ContextThreadView.tsx` for the spec's `ContextThread.tsx`. `wallPrefetch.ts` absent — scored under §31. |
| 30 | State ownership | BUILT | Rank score = Wall Ranking; cursor = Wall; intent = `wall_session_intents` (migration 2271); everything else read from its canonical owner. |
| **31** | **Caching & prefetch** | **PARTIAL** | Live strip short-TTL + degrade-when-stale (`useLiveForYou`); feed keeps items on failure. **No explicit prefetch layer exists. §4.3.** |
| 32 | Analytics | BUILT | `wallAnalytics.ts` full event set; ids + enums + counts only, never raw text (`wallApi.ts`). Test: `WallFeedAnalytics.component.test.tsx`. |
| **33** | **Performance targets** | **BUILT (construction)** *(was PARTIAL)* | Construction obligations met: `CANDIDATE_FETCH = 150` cap, `LOADER_FETCH` caps, live strip independent + probe-bounded, lazy media. **Runtime targets unmeasured — §10, not a construction gap.** |
| 34 | Failure modes | BUILT | Every subsystem call in `routes/wall.ts` wrapped: ranking→input order, projection→empty, live→empty strip, context→unannotated, each loader→empty. Test: `wallRouteDegradation.test.ts`. |
| 35 | Design system rules | BUILT | One object at a time; Postcards break rhythm; purple as accent. Private-bucket media goes through `CachedImage` (no bare `<Image>` remains in the Wall tree). Runtime visual QA owed (§10). |
| 36 | Accessibility | BUILT (construction) | Labels/roles throughout; live state conveyed as TEXT not colour (`ContextThreadView.freshnessLabel`, `LiveForYouStrip.stateLabel`). On-device screen-reader pass owed (§10). |
| 37 | Security & abuse | BUILT | Server-side eligibility authoritative; `checkRateLimit` on impression/action/intent; ranking metadata never exposes raw score. |
| 38 | Testing matrix | BUILT | TABLE 6 families all represented across 12 backend + 9 client Wall test files. §7. |
| 39 | Rollout plan | BUILT | §8. |
| 40 | Non-negotiable product tests | BUILT — 7/7 | Re-verified; the §16 and §19 downgrades touch none of them (neither `experienceAt` nor `contextual_opportunity` appears in any of the seven). |
| 41 | End-to-end Wall loop | BUILT | open→live→feed→object→context→handoff→create realized across route + client. |

---

## 7. Test results — reproduced on `cced3b12`

| Suite | Command | Result |
| --- | --- | --- |
| Backend Wall | `node --import tsx/esm --test src/test/wall*.test.ts` | **100 tests / 27 suites / 0 fail** (12 files) |
| Client Wall | `npx jest --testPathPattern='features/wall/.*\.component\.test\.'` | **16 tests / 9 suites / 0 fail** |
| Backend typecheck | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` | **PASS** (exit 0, clean) |

Backend Wall test files (12): `wallCandidateLoaders`, `wallContextThread`,
`wallDiscoveryInsertion`, `wallDiscoveryRoute`, `wallDiversity`,
`wallFollowingCaughtUp`, `wallFollowingFeed`, `wallForYouCursor`,
`wallLiveForYou`, `wallProjection`, `wallRouteDegradation`, `wallSessionIntent`.

Reproduction note: `wallRouteDegradation`, `wallDiscoveryRoute` and
`wallFollowingCaughtUp` bind a loopback socket. Under a sandbox that blocks
`listen(2)` they hang rather than fail — a sandboxed run silently under-tests the
Wall by three files. The counts above are from an unsandboxed run.

Client Wall test files (9): the 8 under `components/__tests__/` plus
`hooks/__tests__/useWallFeed.inFlightGuard.component.test.tsx` (added by `#343`).

---

## 8. Rollout phases (TABLE 7)

| Phase | Scope | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Shell, For You/Following, Posts/photos/video/Postcards | BUILT | Route + 7 object renderers + mode switch. Flag `wall_enabled`. |
| 2 | Live For You strip | BUILT | `LiveForYouService` + `useLiveForYou`. Flag `wall_live_for_you_enabled`. |
| 3 | Context Threads (Place/Trip/Gem) | BUILT | `ContextThreadService` + §9 gate. Flag `wall_context_threads_enabled`. |
| 4 | Shared Moments, discovery insertions, diversity | **BUILT** *(was partial)* | Shared-Moment loader wired by `#334` (§5); discovery + diversity wired. Flag `wall_discovery_insertions_enabled`. |
| 5 | Input Intelligence steering, Compass handoffs | BUILT | `WallSessionIntentService` + `wallCompass`. Flags `wall_input_intelligence_enabled`, `wall_compass_handoff_enabled`. |
| 6 | RAB/Buddy integration, Dispatch | **PARTIAL** | Buddy Context Thread built behind `wall_rab_integration_enabled`. **Dispatch: `contextual_opportunity` has no producer (§4.2).** |
| 7 | Outcome learning, personalization, continuous certification | BUILT (seams) | Client `wallAnalytics.trackRealWorldOutcome(projection, outcome, consented)` returns early when `consented` is false, so an un-consented outcome is never recorded; the outcome is a coarse enum, never raw text. Personalization rides `DiscoveryRankingService`. |

**6 built + 1 partial.**

---

## 9. Deployment / rollout posture — NOT construction

Kept deliberately separate. Nothing here is counted as a construction gap.

**Feature flags — 7, all seeded OFF, fail-closed.** Repository evidence:
`src/migrations/2270_wall_feature_flags.sql` seeds 5 (`wall_enabled`,
`wall_live_for_you_enabled`, `wall_discovery_insertions_enabled`,
`wall_input_intelligence_enabled`, `wall_compass_handoff_enabled`) and
`2272_wall_context_thread_flags.sql` seeds 2 (`wall_context_threads_enabled`,
`wall_rab_integration_enabled`) — every one `false`. Both migrations carry a
postcondition that raises `POSTCONDITION FAILED: … seeded ON — the Wall must ship
OFF` if `on_count <> 0`. `wall_enabled` is the master gate and every route checks
it before any canonical read; `isFlagEnabled` treats an unreadable flag as off.

**Migrations 2270 / 2271 / 2272 are present in the repository.**

> **Database application state not certified by this construction review.**

Repository presence of a migration is not a deployed migration. No database was
queried for this certification. Whether 2270–2272 have been applied to CI or
production — and therefore whether the flags physically exist as rows — is
unverified here and must be established separately before any go-live decision.

---

## 10. Runtime QA — owed before go-live, not construction

Provable only on a device against a live backend:

- **Scroll performance** — 60 fps (TABLE 4) with a full media feed; needs an
  on-device profiler. Related: §4.3 (no prefetch layer) is the most likely
  construction-side contributor to a miss here.
- **First-page latency** — `< 500 ms` against a production-sized dataset. The
  fetch is bounded (`CANDIDATE_FETCH = 150`) but real latency needs a load test.
- **Autoplay + reduced motion** — the shell defers autoplay to policy; actual
  autoplay-on-scroll, pause-on-scroll-away and OS reduced-motion (§11/§36) need
  iOS + Android verification.
- **Live intelligence with real claims** — `liveClaimRead` returns `[]` in test,
  so Live For You and live_place freshness/label/dedup are unexercised end to end.
- **Private-bucket media paint** — `CachedImage` is correct by construction; the
  sign-endpoint round-trip should be eyeballed on device.
- **Screen-reader pass** and the §35 visual density/rhythm judgement.

---

## 11. HARD invariants — re-verified

1. **Server-side eligibility authoritative; master flag short-circuits before any
   canonical read (§37/§24).** Every route gate checks `wall_enabled` and returns
   `feature_disabled` first. All 7 flags fail-closed (§9).
2. **No blocked / private / sensitive leakage (§23).** Gate order
   eligibility→block→visibility, upstream of all ordering
   (`WallProjectionService.projectObjects`). Block bidirectional and fail-closed —
   an unreadable `blocks` table drops the whole queried author set
   (`loadBlockedAuthorIds`). `passesVisibility` defaults to not-authorized for
   non-post objects. Protected gems set `sensitiveDisclosure` so the §9 gate
   suppresses them. Live strip carries decision-exposure fields only, never
   coordinates.
3. **For You cursor stable; no cross-page duplicates (§28).** Total order
   (finalScore desc + session-seeded tiebreak) sliced at the cursor offset, over a
   candidate set frozen by `snapshotAt`. **`#346` closed the remaining hole here:**
   `snapshotAt` is now also the ranker's *evaluation instant*, so every page of a
   session is scored at one moment. Previously the clock was read per item, which
   made a tied pair reorder between calls (~0.045% of the time) and let items near
   the offset boundary be served twice or skipped. Tests: `wallForYouCursor.test.ts`,
   including three that pin the evaluation instant.
4. **Stale live labels degrade, never fabricated (§4/§34).** Expired claims marked
   `stale` and skipped; `freshnessLabel` returns `null` for stale/unknown.
5. **Diversity controller prevents floods (§15).** Only prunable insertions are
   dropped; social objects are only reordered.
6. **Context Thread earns space; §9 gate defaults false (§8/§9).** At most one
   thread per object; whole surface behind a fail-closed flag.
7. **Map integration read-only (§22).** No second place-state system; place refs
   omit coordinates.
8. **Analytics never log raw private text (§32).** Ids + enums + counts only.
9. **No bare `<Image>` for private-bucket media (§35).** Re-verified: zero bare
   `<Image>` remain in `src/features/wall/`; `WallImage` uses `CachedImage`.

---

## 12. How to reproduce this certification

```
git checkout cced3b12
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
```
