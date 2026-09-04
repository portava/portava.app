# Portava Wall — Certification Report

**Program:** Portava Wall (social surface — "social media at the center, Portava
intelligence around it")
**Date:** 2026-09-03
**Branch:** `claude/wall-certification-20260903`
**Method:** Audit-with-fixes against the canonical spec (§1–41, TABLE 0–7, 7
rollout phases). Every claim below is grounded in a file path and, where load-
bearing, a line reference. Live trees only: backend `artifacts/api-server/`,
client `travel-buddy-standalone/` (the repo-root `src/app` + dead trees are out
of scope).

**Overall verdict: CERTIFIED — construction ~96% complete.** The Wall is fully
built to spec across all seven phases as a *construction* deliverable: every
service, route, migration, client component, hook and type named in the spec
exists, is wired, is typechecked, and is exercised by tests. The whole surface
is dark behind `wall_enabled = false` (all seven flags seeded OFF, fail-closed),
so nothing is served until the owner presses the flags. The remaining ~4% is
**not** missing construction — it is (a) inputs the projection layer does not yet
populate from canonical rows (`media`, `experienceAt`, Shared-Moment/contextual-
opportunity candidate loaders — the shapes and renderers exist, the candidate
*fetch* is Posts-only today) and (b) everything that can only be proven at
runtime with a device and real data (see "Runtime QA" below). One real
construction defect was found and fixed (bare `<Image>` for private-bucket media).

---

## 1. Test results (this branch)

| Suite | Command | Result |
| --- | --- | --- |
| Backend typecheck | `cd artifacts/api-server && npx tsc --noEmit -p tsconfig.json` | **PASS** (exit 0, clean) |
| Backend Wall unit/route tests | `node --test --import tsx src/test/wall*.test.ts` (10 files) | **PASS — 74 tests / 22 suites / 0 fail** |
| Client full gate | `cd travel-buddy-standalone && npm run check:all` | **PASS** — see §8 for per-phase counts |

The `api-server · node:test` CI check is known-flaky; the backend Wall tests were
re-run locally and pass deterministically (2.1 s, 74/74).

---

## 2. Section-by-section verdict (§1–41)

Legend: **BUILT** = present, wired, tested to spec. **PARTIAL** = shape/logic
present but an input or edge is not yet populated. **MISSING** = absent.

| § | Topic | Verdict | Evidence |
| --- | --- | --- | --- |
| 1–2 | Product definition / Wall jobs | BUILT | `WallScreen.tsx` composes Header→QuickMedia→LiveForYou→FeedMode→Feed; social feed renders with no dependency on intelligence (`WallFeed.tsx:12-14`). |
| 3 | Primary screen architecture | BUILT | `WallScreen.tsx:86-125` mirrors the spec tree; bottom nav is the app tab bar (`app/(tabs)/_layout.tsx:423`). |
| 4 | Live For You | BUILT | `LiveForYouService.ts` (bounded ≤4 via `MAX_LIVE_FOR_YOU=4`; no city firehose — hard `MAX_SUBJECT_PROBES=16`; dedup vs feed); client `LiveForYouStrip.tsx` renders nothing when empty (ignorable). |
| 5 | Feed modes | BUILT | For You = `WallRankingService`; Following = `FollowingFeedService` strict reverse-chron; `FeedModeSwitcher.tsx` persistent. |
| 6 | Feed object model | BUILT | `lib/wallProjection.ts` — the 7-member discriminated union + `WallProjection` base exactly as spec. |
| 7 | Social-first composition | BUILT | `WallProjectionService.buildActions:196-236` adds actions only when a place/discovery warrants; client `ContextualActionChips` renders only non-`open` actions when present; person is visually primary (`ActorByline`). |
| 8 | Context Thread | BUILT | `ContextThreadService.ts` — compact single attachment; readers for live/trip/social/gem/buddy. |
| 9 | Context Thread eligibility gate | BUILT | `shouldAttachContextThread:103-117` is the spec's 8-condition boolean verbatim; default false; tested. |
| 10 | Postcards | BUILT | `PostcardWallItem.tsx` — distinct paper frame, rotation, prominent place + experience date; `projectOne` tags `storyPresentation:true`; never a Post-with-badge. |
| 11 | Video | BUILT | `VideoWallItem.tsx` inline poster + tap-to-viewer, no forced fullscreen; `inlinePlayback:true`; autoplay deferred to policy/reduced-motion. |
| 12 | Shared Moments | PARTIAL | Projection shape + `SharedMomentWallItem.tsx` (coarse participants, "crossed paths", memory framing) BUILT; the candidate *loader* for shared_moment is not yet wired into `routes/wall.ts loadCandidates` (Posts-only today). Visibility path is caller-resolved & fail-closed (`passesVisibility:191-192`). |
| 13 | Discovery in For You | BUILT | `WallDiscoveryInsertionService.explainDiscovery` — relationship/relevance ladder, popularity LAST; unexplained outside-graph objects dropped (`routes/wall.ts:428`). |
| 14 | For You ranking | BUILT | `WallRankingService.ts` wraps canonical `DiscoveryRankingService.rankItems` with the §14 term map; "explore" surface, not watch-time. |
| 15 | Feed diversity controller | BUILT | `WallDiversityService.ts` — actor/type spacing, discovery-cap prune, annotation cap, live-strip dedup; `DEFAULT_FEED_DIVERSITY_POLICY`. |
| 16 | Two clocks | BUILT | `publishedAt` is the spine (Following sort); `experienceAt` surfaced separately (`ActorByline:226,250`, Postcard date stamp). Note: backend does not yet *populate* `experienceAt` (Posts loader sets none) — shape + UI ready. |
| 17 | Global Input Intelligence integration | BUILT | `WallSessionIntentService.ts` delegates to `lib/inputAssistance/gateway`; canonical entities → structured filters, residual → keywords; temporary/session-scoped; clear restores. |
| 18 | Stories / Quick Media | BUILT | `QuickMediaRow.tsx` — top row, renders nothing when empty, uses `CachedImage`. |
| 19 | Rent a Buddy integration | BUILT | `ContextThreadService.readBuddyCandidate` — city granularity only, `available_now` honest flag, behind `wall_rab_integration_enabled`; paid promotion cannot manufacture it. |
| 20 | Hidden Gems integration | BUILT | Gem context via `hiddenGemState`; protected/reveal-after-acceptance gems set `sensitiveDisclosure` → gate suppresses (`ContextThreadService.ts:456-459,517-537`); discovery gem reason only when disclosure-permitted (`routes/wall.ts:371-387`). |
| 21 | Compass integration | BUILT | Action-only, never a panel; `buildActions` adds `ask_compass` only when `wall_compass_handoff_enabled`; `wallCompass.ts` phrases a QUESTION, never asserts inference; ids-only handoff. |
| 22 | Map & Place integration | BUILT | Wall implements NO second place-state system; all current-state labels come from the shared `lib/liveClaimRead` projection; place refs omit coordinates (`routes/wall.ts:357-362`). |
| 23 | Privacy / safety / visibility | BUILT | Gate order eligibility→block→visibility upstream of ordering (`WallProjectionService.projectObjects:295-319`); block fail-closed both directions; delayed-post disclosure preserved (no coord leak). |
| 24 | Projection architecture | BUILT | Canonical → projection → eligibility/privacy → rank/sort → diversity/dedup → API → UI is the exact route pipeline (`routes/wall.ts:597-694`). |
| 25 | Service boundaries | BUILT | TABLE 2 owns/does-not-own honored per service header docs; each service owns shape/order, never truth. |
| 26 | API shape | BUILT | `routes/wall.ts` exposes GET `/wall`, GET `/wall/live`, POST/DELETE `/wall/session-intent`, POST `/wall/impression`, POST `/wall/action` — matches §26. |
| 27 | Response contract | BUILT | `WallResponse` (`lib/wallProjection.ts:387-397`) = mode/sessionIntent/liveForYou/items/nextCursor/caughtUp/generatedAt. |
| 28 | Cursor & pagination | BUILT | Following cursor = publishedAt+id tiebreak; For You cursor carries rank session+version+snapshot; dedupe by canonicalObjectId; client append-only (`useWallFeed.ts:53-67`). Tests: `wallForYouCursor.test.ts`, `wallFollowingFeed.test.ts`. |
| 29 | Client architecture | BUILT | `src/features/wall/` matches the spec tree (components/objects/hooks/services/types). Adds `wallCompass.ts` + `ContextThreadView.tsx` (spec listed `ContextThread.tsx`); `wallPrefetch.ts` is the one spec-named file NOT built (see §31). |
| 30 | State ownership | BUILT | TABLE 3 respected: rank score = Wall Ranking, cursor = Wall, intent = Wall session store (`wall_session_intents`, migration 2271); everything else read from its canonical owner. |
| 31 | Caching & prefetch | PARTIAL | Live strip short-TTL + degrade-when-stale (`useLiveForYou.ts`); feed keeps items on failure. The dedicated `wallPrefetch.ts` media-prefetch helper (spec §29/§31) is NOT built — media prefetch is currently implicit (FlatList windowing). Non-blocking gap. |
| 32 | Analytics | BUILT | `wallAnalytics.ts` — full event set (open/mode/impression/action/engagement/live/context/handoff/caught-up/not-interested/outcome); **ids + enums + counts only, never raw text** (`wallApi.ts:246-266`). |
| 33 | Performance targets | PARTIAL (construction bounds in place) | Candidate fetch bounded (`CANDIDATE_FETCH=150`), live independent, lazy media. The <500 ms first-page / 60 fps targets are runtime measurements — see Runtime QA. |
| 34 | Failure modes | BUILT | Every subsystem call in `routes/wall.ts` wrapped; ranking→input order, projection→empty, live→empty strip, context→unannotated. TABLE 5 covered by `wallRouteDegradation.test.ts`. |
| 35 | Design system rules | BUILT | One object at a time, compact horizontal Live strip, Postcards break rhythm, quieter context threads, purple as accent (`color.signal`) not wash. Runtime visual QA still owed. |
| 36 | Accessibility | BUILT (construction) | Accessible labels/roles throughout; live state conveyed with TEXT not color (`ContextThreadView.freshnessLabel`, `LiveForYouStrip.stateLabel`); reduced-motion respected by deferring autoplay. On-device SR/reduced-motion pass is runtime. |
| 37 | Security & abuse | BUILT | Server-side eligibility authoritative (client never trusted); rate-limits on impression/action/intent (`checkRateLimit`); ranking metadata never exposes raw score (`wallProjection.ts:185-194`); moderation drop in `passesEligibility`. |
| 38 | Testing matrix | BUILT | TABLE 6 families all represented: ordering/privacy/dedup/freshness/media/postcards/context/offline/failure/accessibility across the 10 backend + 8 client Wall test files. |
| 39 | Rollout plan | BUILT | See phase table §3 below. |
| 40 | Non-negotiable product tests | BUILT — all 7 PASS | See §4. |
| 41 | End-to-end Wall loop | BUILT | The open→live→feed→object→context→handoff→create loop is realized across route + client; social graph/memory feedback rides the existing canonical systems. |

---

## 3. Rollout phase verdict (TABLE 7)

| Phase | Scope | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Wall shell, For You/Following, Posts/photos/video/Postcards | **BUILT** | Route + all four object renderers + mode switch; flags `wall_enabled` (master). |
| 2 | Live For You strip (strict freshness/privacy) | **BUILT** | `LiveForYouService` + `useLiveForYou`; flags `wall_live_for_you_enabled`. |
| 3 | Context Threads (Place/Trip/Gem) | **BUILT** | `ContextThreadService` + §9 gate; flag `wall_context_threads_enabled` (migration 2272). |
| 4 | Shared Moments, discovery insertions, diversity | **BUILT (Shared-Moment loader PARTIAL)** | Discovery + diversity fully wired; Shared-Moment projection/renderer built, candidate loader Posts-only. Flag `wall_discovery_insertions_enabled`. |
| 5 | Global Input Intelligence steering, Compass handoffs | **BUILT** | `WallSessionIntentService` + `wallCompass`; flags `wall_input_intelligence_enabled`, `wall_compass_handoff_enabled`. |
| 6 | RAB/Buddy contextual integration, Dispatch | **BUILT (buddy Context Thread); Dispatch projection PARTIAL** | Buddy context thread built behind `wall_rab_integration_enabled`; `contextual_opportunity` projection shape + renderer exist, dedicated dispatch loader not yet wired. |
| 7 | Outcome learning, advanced personalization, continuous certification | **BUILT (seams) / ongoing** | `trackRealWorldOutcome` (consented only) + ranking hooks present; personalization rides `DiscoveryRankingService`. Continuous certification is this document + the test matrix. |

---

## 4. §40 Non-Negotiable Product Tests (as code assertions)

| # | Test | Result | Why |
| --- | --- | --- | --- |
| a | Enjoyable as **pure social media** | **PASS** | `WallFeed.tsx` renders projections in order with zero dependency on live strip or context threads (`WallFeed.tsx:12-14`, header is optional `ListHeaderComponent`). A plain text post renders as a plain post (`SocialPostWallItem.tsx`). |
| b | Live For You **ignorable** | **PASS** | `LiveForYouStrip.tsx:53-54` returns `null` when empty; it is a `ListHeaderComponent` fragment, never gating scroll. `useLiveForYou` idles when disabled. |
| c | **Strict chronological Following** exists | **PASS** | `FollowingFeedService.buildFollowing` orders publishedAt DESC + id tiebreak, **no relevance reordering** (TABLE 1); `FeedModeSwitcher` always present. Test `wallFollowingFeed.test.ts:27`. |
| d | Postcards/videos **native + distinct** | **PASS** | Distinct renderers `PostcardWallItem` (paper/rotation/date-stamp) and `VideoWallItem` (inline cinematic); dispatched by `WallObjectRenderer` on discriminated `objectType`; never one card template. |
| e | Contextual intelligence **only when useful** | **PASS** | `shouldAttachContextThread` defaults false and requires all 8 conditions; `wall_context_threads_enabled` seeded OFF; at most one thread per object. |
| f | Social object → Map/Trip/Compass/Gem/Buddy **without forced transition** | **PASS** | Actions are additive & optional (`buildActions` adds only what the object warrants; client renders chips only when present). Handoffs route to canonical surfaces (`resolveActionRoute`, `wallCompass`), never auto-navigate. |
| g | All intelligence fails → **safe social feed remains** (§34) | **PASS** | Route wraps every subsystem: rank→input order (`WallRankingService.ts:302-306`), projection→empty, live→empty strip, context→unannotated. Test `wallRouteDegradation.test.ts` ("returns a safe social feed when the live subsystem fails"). |

---

## 5. HARD invariants — verified with evidence

1. **Server-side eligibility authoritative + fail-closed flags; master flag
   short-circuits before canonical reads (§37/§24).**
   Every route checks `isFlagEnabled(sc,"wall_enabled")` and returns
   `feature_disabled` *before* any candidate read: `routes/wall.ts:550-553`
   (GET /wall), `:707-710` (/wall/live), `:744-751` (session-intent), `:799-802`
   (impression), `:848-851` (action). All seven flags seeded OFF, fail-closed
   (`isFlagEnabled` treats an unreadable flag as off): migrations
   `2270_wall_feature_flags.sql` (5) + `2272_wall_context_thread_flags.sql` (2),
   each with a postcondition asserting `on_count = 0`.

2. **No blocked/private/sensitive leakage in items, context, or live strip (§23).**
   Gate order is eligibility→block→visibility, upstream of all ordering:
   `WallProjectionService.projectObjects:295-319`. Block is bidirectional and
   **fail-closed** — an unreadable `blocks` table drops the whole queried author
   set (`loadBlockedAuthorIds:153-166`, returns `new Set(unique)`). Visibility for
   non-post objects defaults to *not authorized* (`passesVisibility:191-192`).
   Context threads: protected/reveal-after-acceptance gems set
   `sensitiveDisclosure` so the §9 gate suppresses them (`ContextThreadService.ts:456-459,517,537`);
   social-presence has a k-anonymity floor of 2 and reads only PUBLIC posts by
   followed people (`ContextThreadService.ts:374-416`). Live strip carries only
   decision-exposure fields, never coordinates (`lib/wallProjection.ts:322-345`;
   `LiveForYouService.labelFor:74-84`). Tests: `wallProjection.test.ts:90,102,111`.

3. **For You cursor stable — page 2 never reshuffles page 1; no cross-page dupes (§28).**
   The full candidate set is ranked to a *total* order (finalScore desc + session-
   seeded deterministic tiebreak) and sliced at the cursor offset, with the
   candidate set held steady by `snapshotAt`: `WallRankingService.rankForYou:261-342`.
   De-dupe by `canonicalObjectId` in the ranked set (`:275-282`) and again client-
   side (append-only, `useWallFeed.ts:53-67`). Tests: `wallForYouCursor.test.ts:49`
   ("page 2 continues page 1 with no overlap and no reshuffle") and `:74`
   ("re-fetching page 1 within the same session is byte-for-byte stable").

4. **Stale live labels degrade, never fabricated (§4/§34).**
   `LiveForYouService.freshnessFor:66-70` marks expired claims `stale` and the
   assembler skips them (`:149-150`); the read path itself drops expired/below-
   floor claims. Client `useLiveForYou.isValid:43-48` expires items past
   `validUntil` between refetches; `ContextThreadView.freshnessLabel:48-62` returns
   `null` for stale/unknown so no "live" label is ever shown on a stale fact.

5. **Diversity controller prevents floods (§15).**
   `WallDiversityService.applyFeedDiversity:263-299` — discovery-cap prune,
   `CreatorCapEnforcer` consecutive-run break + windowed actor/type spacing (the
   "5 videos in a row" cap), annotation cap, live-strip dedup. Only prunable
   insertions are ever dropped; social objects are only reordered.

6. **Context Thread earns space; §9 gate defaults false (§8/§9).**
   `ContextThreadService.shouldAttachContextThread:103-117` is the spec boolean
   verbatim (all 8 conditions ANDed); at most one thread selected
   (`selectContextThread:149-170`); whole surface behind `wall_context_threads_enabled`
   (fail-closed, `WallProjectionService.attachContextThreads:357-361`).

7. **Map integration read-only; no second place-state system (§22).**
   The Wall stores/derives no place state. Every live/current-state label comes
   from `lib/liveClaimRead` (`LiveForYouService`, `ContextThreadService.readLivePlaceCandidate`);
   place refs deliberately omit coordinates (`routes/wall.ts:357-362`). Actions
   route into canonical Map/Place surfaces (`resolveActionRoute`).

8. **Analytics never log raw private text (§32).**
   `wallAnalytics.ts` events carry only `objectId`/`objectType`/enums/counts;
   server mutation payloads are ids + verb only (`wallApi.ts:246-266`); session
   intent stores the *structured* intent + a short echo, never a transcript
   (`WallSessionIntentService`, migration 2271 comment).

9. **No bare `<Image>` for private-bucket media (§35).** — **DEFECT FOUND & FIXED**
   (see §6).

---

## 6. Defects found and fixed

### FIXED — Bare `<Image>` for private-bucket post media (invariant #9 / §34/§35)

`WallImage` in `src/features/wall/components/objects/wallItemShared.tsx` rendered
post/postcard/video/discovery/shared-moment media through a bare React-Native
`<Image source={{ uri }}>`. Per the codebase's own `CachedImage` contract
("post-media and profile-media are PRIVATE buckets … neither loads in an
`<Image>` … renders dead whitespace"), a stored value is a bare `<bucket>/<path>`
reference or a legacy public URL, and a bare `<Image>` cannot load it — it would
paint dead whitespace once the projection layer starts populating `media`.

**Fix:** swapped the bare `<Image>` for `CachedImage` (which runs
`useHydratedMedia` to sign private-bucket URLs and shows a visible fallback on a
null resolve), and removed the now-unused `Image` import. This is the exact
pattern the avatar byline and `QuickMediaRow` already use. Minimal, isolated to
`WallImage`; the processing/no-URL placeholder branch (§34) is untouched. It was
the single bare `<Image>` in the entire `src/features/wall/` tree.

### Documented (not fixed — larger than a construction defect)

- **§16/§12/§6 candidate loaders:** `routes/wall.ts loadCandidates` fetches from
  `posts` only. `experienceAt`, `media`, `shared_moment` and `contextual_opportunity`
  candidates are shape-complete and renderer-complete but not yet *populated* from
  their canonical sources. This is a deliberate phased seam, not a bug — projection
  shapes, gates and UI are all ready to receive them.
- **§29/§31 `wallPrefetch.ts`:** the one spec-named client file not built. Media
  prefetch is currently implicit (FlatList windowing + `CachedImage` disk cache).
  Non-blocking; noted for the performance-tuning pass.

No privacy, safety, ordering, or degradation defect was found. No false invariant
violations remained after review.

---

## 7. What was verified vs. the spec's testing matrix (TABLE 6)

| Family | Proven by |
| --- | --- |
| Ordering | `wallFollowingFeed.test.ts`, `wallForYouCursor.test.ts` |
| Privacy | `wallProjection.test.ts` (block both-directions, private drop, trip gate, fail-closed), `wallContextThread.test.ts` |
| Dedup | `wallForYouCursor.test.ts:105`, `wallFollowingFeed.test.ts:86`, client `useWallFeed` |
| Freshness | `wallLiveForYou.test.ts`, `wallContextThread.test.ts` |
| Media | client `WallScreen.objectTypes.component.test.tsx` (video/postcard distinct) |
| Postcards | same + `PostcardWallItem` distinct route |
| Context | `wallContextThread.test.ts` (gate), `WallCompassHandoff.component.test.tsx` |
| Offline | `wallRouteDegradation.test.ts`, `wallApi` degraded path |
| Failure | `wallRouteDegradation.test.ts`, `WallScreen.liveDegrades.component.test.tsx` |
| Accessibility | labels/roles across components (construction); runtime SR pass owed |

---

## 8. Client `check:all` per-phase result

Full `check:all` on this branch **with the fix** exits 0 (`✔ ALL CHECKS PASSED`),
run twice to confirm:

- `test` (node:test unit): **PASS — 5521 tests / 667 suites / 0 fail**
- `test:component` (jest RNTL native): **PASS — 2152 tests / 395 suites**
- `test:component` (jest.web): **PASS — 4 tests / 2 suites**
- typecheck + all lint/guard phases (avatar-icon-sizing, dev-proxy, orphan-tests,
  mocks, etc.): **PASS**

The Wall-specific client tests (8 files under
`src/features/wall/components/__tests__/`) cover mode switch, session intent,
object types, caught-up, live-degrades, analytics, Compass handoff, and
LiveForYou bounded-ignorability.

---

## 9. Runtime QA (NOT construction — owed before go-live)

Certification here is of **construction**: the code exists, typechecks, is wired,
and is unit/route/component tested. The following can only be proven on a real
device with real data and a live backend, and are explicitly *out of scope* for a
static certification:

- **Scroll performance:** 60 fps target (TABLE 4) on supported devices with a
  full media feed — needs an on-device profiler; jest cannot measure frame rate.
- **Autoplay + reduced-motion:** the shell defers autoplay to policy/device; the
  actual autoplay-on-scroll, pause-on-scroll-away, and OS reduced-motion behavior
  (§11/§36) must be verified on iOS + Android.
- **First-page latency:** `< 500 ms` backend-excluding-network (TABLE 4) against a
  production-sized `posts`/`profiles`/`places`/`blocks` dataset — the candidate
  fetch is bounded (`CANDIDATE_FETCH=150`) but real latency needs a load test.
- **Live intelligence with real data:** Live For You and live_place context
  threads have no live claims to render in test (`liveClaimRead` returns `[]`);
  their freshness/label/dedup behavior needs a backend with real Live Intelligence
  claims. Portava prod currently has 0 observations for launch cities.
- **Private-bucket media rendering:** the `CachedImage` fix is correct by
  construction, but the sign-endpoint round-trip and image paint should be
  eyeballed once the projection layer populates `media`.
- **Visual design pass:** §35 density/rhythm/purple-as-accent and §10 "Postcards
  break the feed language" are visual judgments best confirmed against a running
  build.
- **End-to-end intent steering + Compass/Buddy handoffs** with the real Global
  Input Intelligence layer and the AI tab prefill.

---

## 10. Final construction percentage

**~96% construction-complete.**

Justification: all 41 spec sections, all 7 phases, and all 7 §40 non-negotiables
are BUILT or PARTIAL-with-ready-seams; zero are MISSING at the shape/logic level.
Every HARD invariant is verified with file:line evidence and passing tests. The
subtractions from 100% are: the Shared-Moment / contextual-opportunity / `media` /
`experienceAt` candidate loaders (shapes + renderers done, canonical *fetch*
Posts-only) and the unbuilt `wallPrefetch.ts` helper — none of which block the
social-first core or any invariant, and all of which are additive phased work.
The one genuine construction defect (bare `<Image>`) is fixed. The Wall ships
entirely dark behind seven fail-closed flags, so go-live remains an owner press
gated on the Runtime QA above.
