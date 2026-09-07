# Portava Wall — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Wall_Engineering_Architecture_and_Design_Spec.txt` (§1–41), `.docx` original authoritative |
| **Tree censused** | `claude/portava-continuation-uqta94`, working tree at `ebe72b34`. Sibling agents committed the shared tree during this pass (HEAD is now `2d40aece`); `git diff ebe72b34..2d40aece` over every Wall, Passport, trust and availability path cited below is **empty**, so every verdict holds at HEAD. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a file:line that was opened and read. |
| **Database** | Not queried. Storage facts are the ones supplied as ground truth. |

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **205** |
| BUILT-AND-CORRECT | **188** |
| BUILT-BUT-WRONG | **7** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **9** |
| **CONSTRUCTED%** = (correct+wrong)/denominator | **195 / 205 = 95.1%** |
| **CORRECT%** = correct/denominator | **188 / 205 = 91.7%** |
| CANNOT-VERIFY share | **9 / 205 = 4.4%** |

**Verdict on "~96% complete — 38 of 41 spec sections fully built": the
percentage survives a much finer mesh; the section count is now an
understatement; and the framing hides one thing that matters.**

I did not set out to land near 96 and I would have said so had I landed
elsewhere. At a 205-cell denominator the Wall measures **95.1% constructed**,
which is within noise of the certification's 96.3%. That is a genuinely
unusual result — a coarse score that holds up when you refine the grain
five-fold — and the reason it holds is that the Wall's gaps really are narrow.

Three corrections, in descending order of importance:

1. **"38 of 41" is now too low.** All three sections the certification called
   PARTIAL (§16 two clocks, §19 contextual opportunity, §31 prefetch) have since
   acquired the exact producers its own completion conditions demanded. At the
   section grain the honest count today is **41 of 41**. The certification is
   stale in the *built* direction.
2. **95.1% constructed is not 91.7% correct.** Seven requirements inside
   sections the certification scores BUILT do not do what the spec asks — three
   of §2's eight named real-world actions among them. A 41-cell denominator has
   no cell in which to record "exists and is wrong", so those seven are
   invisible in the certification and visible here.
3. **The most important facts about the Wall are not construction facts at all.**
   Six deployment realities (§3 below) decide whether any of this runs: the whole
   surface is flag-dark, the Live strip's primary kind reads a deliberately-empty
   allowlist, `experienceAt`'s writer is behind another flag, and the §32
   telemetry sink is not deployed. The certification acknowledges the first and
   is silent on the rest.

---

## 1. Denominator: how 205 was counted

One requirement = one independently testable assertion. The rule, applied
identically to both specs in this pair:

- **A bullet that asserts a required property or behaviour = 1 requirement.**
  ("No stale live labels", "Blocked users are excluded from feed…").
- **A table row that names a required artifact, condition or behaviour = 1
  requirement.** §4's six live-object kinds are six requirements; §30's ten
  ownership rows are ten; §34's seven failure modes are seven.
- **A declared TypeScript interface = 1 requirement for the contract**, unless a
  member carries independent behaviour, in which case that member is counted
  separately (§15's seven policy fields are seven, because each names a distinct
  enforcement).
- **A named endpoint, service, phase or test family = 1 requirement.**
- **Narrative, rationale and restatement = 0.** §1's "canonical principle" and
  §41's closing rule contribute one requirement each only where they name a
  structure that must exist.

Per-section counts: §1:1 §2:7 §3:2 §4:13 §5:3 §6:2 §7:6 §8:2 §9:1 §10:5 §11:5
§12:1 §13:7 §14:2 §15:7 §16:2 §17:5 §18:1 §19:6 §20:5 §21:5 §22:1 §23:7 §24:1
§25:6 §26:6 §27:1 §28:5 §29:1 §30:10 §31:6 §32:12 §33:7 §34:7 §35:10 §36:6 §37:6
§38:10 §39:7 §40:7 §41:1 = **205**.

**Method caveat inherited from `src/scripts/checkWriterlessReads.ts`:** a
`from("table")` grep misses variable and RPC access, and that script itself
declares that a dynamic `.from(expr)` anywhere makes writer attribution
INCOMPLETE. Where a verdict below turns on "nothing writes X" I read the writer
sites rather than counting greps, and I say so.

---

## 2. Requirement-by-requirement

Verdict key: **C** = BUILT-AND-CORRECT · **W** = BUILT-BUT-WRONG · **N** =
NOT-BUILT · **?** = CANNOT-VERIFY. Backend paths are relative to
`artifacts/api-server/src/`, client paths to
`travel-buddy-standalone/src/features/wall/` unless stated.

### §1 Product Definition

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W1 | The Wall is a primary social surface that stays a social feed | C | `components/WallScreen.tsx:115-143` composes header→mode→feed; `components/WallFeed.tsx:138` renders projections through a `FlatList` whose header (live strip, quick media) is an optional `ListHeaderComponent` — the feed has no dependency on any intelligence surface. |

### §2 Wall Jobs

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W2 | Familiar low-friction feed for Posts, video, Postcards, Shared Moments, people, network activity | C | `routes/wall.ts:842-862` runs the Post spine plus postcard/video/shared-moment/opportunity loaders in one `Promise.all`; `components/WallObjectRenderer.tsx:238-257` dispatches all seven types. |
| W3 | Small persistent Live For You surface above the feed | C | `components/WallScreen.tsx:106-111` places `LiveForYouStrip` inside the list header, above the feed; `services/wall/LiveForYouService.ts:68` `MAX_LIVE_FOR_YOU = 4`. |
| W4 | Ranked random discovery without forcing chronological consumption | C | `services/wall/WallRankingService.ts:271` `rankForYou` orders by composite score with a session-seeded tiebreak (`:257`), never by time alone. |
| W5 | Strict chronological Following mode | C | `services/wall/FollowingFeedService.ts:105` `buildFollowing`; `:74` `compareDesc` sorts `publishedAt` DESC + `canonicalObjectId` DESC, no relevance term. |
| W6 | Contextual intelligence attached only when it materially improves the object | C | `services/wall/ContextThreadService.ts:105-117` — the eight-condition gate, default false. |
| W7 | Social content → optional real-world actions: see place, save, add to Trip, join, message, map, ask Compass, book a Buddy | **W** | Five of the eight are real: `see_place`/`ask_compass`/`book_buddy` (`services/wall/WallProjectionService.ts:227-266`), `add_to_trip` (`ContextThreadService.ts:412`), `open_map` (`:741`). **`join` and `message` have no producer anywhere** — a repo-wide search for `type: "join"` / `type: "message"` in `services/` + `routes/` returns nothing; they exist only in the client's route resolver (`components/objects/wallItemShared.tsx:117,129`) for actions the server never emits. **`save` is a client-local toggle that persists nothing**: `wallItemShared.tsx:392-396` sets React state and fires analytics; there is no write to any canonical save store, so the bookmark resets on remount. |
| W8 | Preserve distinct identities of Postcards / video / Moments / normal Posts | C | Distinct renderers `components/objects/PostcardWallItem.tsx`, `VideoWallItem.tsx`, `SharedMomentWallItem.tsx`, `SocialPostWallItem.tsx`, dispatched on the discriminant at `WallObjectRenderer.tsx:239`. Server precedence keeps the distinct shape: `WallProjectionService.ts:334-341` ranks `shared_moment`/`postcard` above `video`/`social_post` for the same canonical id. |

### §3 Primary Screen Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W9 | Header (Portava, current city/context, notifications, Telegraph) → Stories → Live For You → Feed Mode → Social Feed | C | `components/WallScreen.tsx:117-141` in exactly that order; `WallHeader` takes `city`, `onOpenNotifications` (`:124`) and `onOpenTelegraph` (`:125`). |
| W10 | Bottom navigation: Wall, Map, Create, Trips, Passport | C | `app/(tabs)/_layout.tsx:471-472` registers the `wall` tab with `href: wallEnabled ? '/wall' : null`, alongside the existing map/create/trips/passport tabs. |

### §4 Live For You

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W11 | Normally 2–4 items and a single See Live action | C | `services/wall/LiveForYouService.ts:68` `MAX_LIVE_FOR_YOU = 4`, clamped again at `routes/wall.ts:1007-1009`; `components/LiveForYouStrip.tsx` renders one `See Live` control. |
| W12 | Place/area state kind, fresh + confident + user-relevant | C | `routes/wall.ts:682-686` builds `place_state` candidates from the feed's places only; truth comes from `lib/liveClaimRead.readLiveClaimEnvelopes`, whose three fail-closed gates (`lib/liveClaimRead.ts:18-25`) drop expired/below-floor/not-privacy-eligible claims. *Deployment note in §4 below: the promoted-scope allowlist ships empty, so this kind returns nothing in production until a scope is promoted.* |
| W13 | Event state kind, time-valid and relevant | C | `LiveForYouService.buildEventStateLiveCandidates`, delegating to the canonical `routes/mapSearch.loadNearbyEvents` (imported `LiveForYouService.ts:39`) with `eventPhaseAt` timing (`:44-49`). |
| W14 | Hidden Gem kind, protection + disclosure policy satisfied | C | `LiveForYouService.ts:82` `PROTECTED_GEM_SENSITIVITY` excludes `protected` / `reveal_after_acceptance` from the strip. |
| W15 | Social presence kind, viewer authorized for the disclosed granularity | C | `LiveForYouService.ts:79-81` `SOCIAL_PRESENCE_MIN = 2` k-anonymity floor; candidates built from followed people's public posts only. |
| W16 | Buddy availability kind: availability active, service eligible, no precise private coordinate | C | `LiveForYouService.buildBuddyLiveCandidates` behind `isRentBuddyMasterEnabled` (`:57`), `BUDDY_AVAILABILITY_MS = 30 min` horizon (`:85`), city-area subject only. |
| W17 | Trip signal kind, trip-scoped authorization | C | `routes/wall.ts:704` `buildTripSignalLiveCandidates(sc, viewerId, viewer.viewerTripIds, placeRefs)` — the viewer's own accepted trips only. |
| W18 | No generic city-wide firehose | C | `LiveForYouService.ts:71-77` `MAX_SUBJECT_PROBES = 16`, `MAX_PRODUCER_PLACES = 12`; candidates derive from the feed's own places (`routes/wall.ts:935-943`), never a city enumeration. |
| W19 | No stale live labels | C | `lib/liveClaimRead.ts:23-25` drops expired snapshots; `LiveForYouService.ts:110` a `validUntil` in the past is treated as stale and dropped; client `hooks/useLiveForYou.ts` degrades on TTL. |
| W20 | No exact private location leakage | C | `lib/wallProjection.ts:352-357` `LiveForYouItem` carries decision-exposure fields only — no coordinates, contributor ids or exact cohort counts. |
| W21 | No paid placement masquerading as live intelligence | C | A search of `services/wall/` + `routes/wall.ts` for `promoted`/`sponsored`/`is_paid`/`boost` returns nothing outside the unrelated `intel_live_promoted_scopes` allowlist name; there is no paid lever on the strip at all. |
| W22 | Do not repeat a live signal in the feed after it appears in the strip | C | `routes/wall.ts:959-966` builds both the subject set and the `(subject, kind)` signal set, passed into `attachContextThreads`; `ContextThreadService.ts:161-172` `threadDuplicatesLiveStrip` folds it into the gate's `duplicatesLiveStrip`. |
| W23 | Live For You may be ignored; normal scrolling remains fully functional | C | `components/LiveForYouStrip.tsx` returns `null` when empty; it is a header fragment (`WallScreen.tsx:106`), never gates scroll. Test: `components/__tests__/WallScreen.liveDegrades.component.test.tsx`. |

### §5 Feed Modes

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W24 | For You: ranked, non-chronological, optimizing social relevance and quality | C | `WallRankingService.ts:63` `FOR_YOU_SURFACE = "explore"`; `:301-320` ranks the full set then slices. |
| W25 | Following: strict reverse chronology, no relevance reordering, only safety/visibility filters | C | `FollowingFeedService.ts:74-85`; the gate ran upstream (`WallProjectionService.projectObjects:325`), and `routes/wall.ts:868-869` explicitly refuses to apply the intent steer in Following. |
| W26 | For You is the default exploratory experience | C | `routes/wall.ts:718` `mode: z.enum([...]).optional().default("for_you")`; client `components/WallScreen.tsx:62` `useState<WallMode>('for_you')`. |

### §6 Feed Object Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W27 | The seven-member discriminated union, each member emittable and renderable | C | `lib/wallProjection.ts:254-261` the union; **all seven now have a server producer** — `routes/wall.ts:361-366` (social_post/video/social_update/discovery), `WallCandidateLoaders.ts` postcard (`:461`), shared_moment (`:716`), and `loadContextualOpportunityCandidates` (wired at `routes/wall.ts:856`). Client: `WallObjectRenderer.tsx:239-257`, seven cases plus `default: return null`. |
| W28 | `WallProjection` base carries the declared fields | C | `lib/wallProjection.ts:232-252` — projectionId, objectType, canonicalObjectId, actor, publishedAt, experienceAt, visibility, media, text, place, contextThread, actions, ranking. |

### §7 Social-First Composition Rules

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W29 | A normal social post remains a normal social post | C | `WallProjectionService.buildActions:225` seeds only `open_object`; every other action is conditional. |
| W30 | Do not add the full intelligence action stack to every object | C | `WallProjectionService.ts:227-266` — `see_place` only with a place, `ask_compass` only behind its flag, `book_buddy` only for buddy opportunities, `follow` only for discovery objects the viewer does not already follow. |
| W31 | Creator/person visually primary | C | `components/objects/wallItemShared.tsx` `ActorByline` renders first in every object renderer (`WallObjectRenderer.tsx:190,218`, `VideoWallItem.tsx:76`). |
| W32 | Commercial identity secondary to person identity for Buddies | C | `WallCandidateLoaders.ts` opportunity actor is built from the `profiles` row with the buddy row's `display_name` only as fallback, `isBuddy`/`buddyRole` as secondary marks (`lib/wallProjection.ts:61-64`). |
| W33 | Discovery insertions visually identifiable and explainable | C | Server drops unexplained outside-graph objects (`routes/wall.ts:535-551`); `DiscoveryProjection.discoveryReason` is required (`lib/wallProjection.ts:308-311`); `components/objects/DiscoveryWallItem.tsx` renders it. |
| W34 | Feed rhythm; avoid a uniform stack of identical cards | C | `WallDiversityService.ts:193-194` enforces `postcardSpacingHint` (default 3, `:83`); `:59-70` caps same-actor (2) and same-type (3) within a 6-item window (`:86`). |

### §8 Context Thread

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W35 | A compact attachment beneath an object, rendered only when useful | C | `WallProjectionService.attachContextThreads` attaches at most one thread per object (`ContextThreadService.selectContextThread:202`); client `components/ContextThreadView.tsx` renders below the body. |
| W36 | All eight kinds | C | All eight have readers: `ContextThreadService.ts:333` live_place, `:420` trip_relevance, `:506` social_presence, `:618` hidden_gem, `:696` buddy, `:748` map, `:803` memory, `:854` compass. (The 2026-09-04 certification credited five.) |

### §9 Context Thread Eligibility Gate

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W37 | The eight-condition gate, ANDed, defaulting to false | C | `ContextThreadService.ts:105-117` reproduces the spec's boolean verbatim against `DEFAULT_CONTEXT_THREAD_POLICY` (`:66-70`: minConfidence 0.55, maxAge 6 h, minUtility 0.5). |

### §10 Postcards

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W38 | Distinct typography/layout from standard posts | C | `components/objects/PostcardWallItem.tsx` — paper frame, rotation, date stamp; not the `SocialPostWallItem` shell. |
| W39 | Place and experience date can be prominent | C | `PostcardProjection.storyPresentation` (`lib/wallProjection.ts:281-284`); `experienceAt` populated by `WallCandidateLoaders.ts:469`. |
| W40 | Open Postcard enters the canonical Postcard viewer | C | `components/objects/__tests__/postcardOpenRoute.component.test.ts` pins the route; `wallItemShared.tsx:93` `resolveActionRoute`. |
| W41 | Contextual actions allowed, story presentation stays primary | C | `PostcardWallItem` renders `ContextualActionChips` beneath the card body, never in place of it. |
| W42 | Never rendered as a normal Post with a Postcard badge | C | Distinct projection type produced server-side (`WallCandidateLoaders.ts:461` `objectType: "postcard"`) and given precedence over the Post spine's plain shape (`WallProjectionService.ts:334-341`). |

### §11 Video

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W43 | Inline playback, no mandatory full-screen takeover | C | `components/objects/VideoWallItem.tsx:82-88` mounts `SharedVideoPlayer` inline inside the card frame. |
| W44 | Autoplay only under product policy and user/device conditions; scrolling away pauses | C | `services/videoAutoplayPolicy.ts:60-63` — visible AND !reduceMotion AND userEnabled, always muted; `VideoWallItem.tsx:62-65` feeds it viewport visibility. Test: `objects/__tests__/VideoWallItem.component.test.tsx:101` "pauses when scrolled off". |
| W45 | Tap may enter the dedicated Media Viewer | C | `VideoWallItem.tsx:96` and `:107` both call `openViewer`. |
| W46 | Video carries place/time context without claiming to prove current state | C | The video projection carries `place`/`publishedAt`/`experienceAt` only; a current-state label can reach it solely through a Context Thread, which is gated by §9 and sourced from `lib/liveClaimRead`. |
| W47 | Watch time must not become the primary optimization target | C | `WallRankingService.ts:9-30` maps the §14 terms onto the ranker's signals; no watch-time or dwell signal appears in `WallRankSignals` (`:69-88`). |

### §12 Shared Moments

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W48 | Shared Moments enter the Wall as a special social object; visibility follows the underlying consent policy | C | `WallCandidateLoaders.loadSharedMomentCandidates` reads accepted `shared_moment_memberships` and sets `callerVisibilityResolved: true` (`:731`) so the gate still applies eligibility + block; real owner `account_status` threaded (`:727`). |

### §13 Discovery in For You

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W49 | Discovery stays social — explains why, never a naked directory listing | C | `routes/wall.ts:535-551` — an outside-graph object with no explanation is dropped (`continue`), not rendered. |
| W50 | Followed-by / mutual context | C | `routes/wall.ts:300-318` second-degree follow set; consumed as `mutualFollowedAuthorIds` in `WallDiscoveryInsertionService.explainDiscovery`. |
| W51 | Trip or destination relevance | C | `routes/wall.ts:284-297` upcoming/active trip destination cities → `discoveryViewer.tripCities` (`:513`). |
| W52 | Interest relevance | C | `routes/wall.ts:276-278` viewer interests → `discoveryViewer.interests` (`:516`). |
| W53 | High-quality social content the user likely missed | C | `explainDiscovery` receives like/save/comment counts and `createdAt` (`routes/wall.ts:542-545`). |
| W54 | Hidden Gem content only where disclosure policy allows | C | `routes/wall.ts:494-509` — only `sensitivity_level` in {public, approximate} on an active gem enters `permittedGemPlaceIds`. |
| W55 | Creator popularity must not dominate contributor reliability / real-world relevance | C | `WallDiscoveryInsertionService.explainDiscovery` orders relationship → trip → interest → quality, with popularity last; unexplained-but-popular objects are dropped by W49's rule. |

### §14 For You Ranking

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W56 | ForYouScore composed of the fourteen named terms | C | `WallRankingService.ts:9-28` maps every §14 term to a `DiscoveryRankingService.rankItems` signal; the mapping table is in the file header and the signal struct is `:69-88`. |
| W57 | The objective is not maximum watch time | C | `WallRankingService.ts:63` uses the ranker's `explore` surface profile (exploration/diversity heavy) and supplies no watch-time signal. |

### §15 Feed Diversity Controller

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W58 | maxSameActorInWindow | C | `WallDiversityService.ts:59,81` (default 2), enforced by `enforceCreatorCapsGeneric` + the windowed spacing pass. |
| W59 | maxSameObjectTypeInWindow | C | `WallDiversityService.ts:61,82` (default 3) — the "five videos in a row" rule. |
| W60 | maxContextThreadsInWindow | C | `WallDiversityService.ts:63-68,83` carried on the policy, enforced in `attachContextThreads` (handed the value at `routes/wall.ts:969`) so the excess thread is never built. |
| W61 | minSocialObjectRatio | C | `WallDiversityService.ts:71,84` (0.5), enforced by `pruneDiscovery`. |
| W62 | maxDiscoveryInsertionsInWindow | C | `WallDiversityService.ts:73,85` (2). |
| W63 | postcardSpacingHint | C | `WallDiversityService.ts:74,83` and enforced at `:193-194`. |
| W64 | liveStripDeduplication | C | The policy *field* was deliberately removed as a permanent no-op (`WallDiversityService.ts:24-41` explains why: diversity runs before the strip exists); the *rule* is enforced earlier and more completely in `ContextThreadService.threadDuplicatesLiveStrip:161-172`, which dedups every place-anchored kind rather than only `live_place`. |

### §16 Two Clocks

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W65 | Ordering uses `publishedAt` for chronological Following | C | `FollowingFeedService.ts:11-14` ("never experienceAt") and `:74-85`. |
| W66 | `experienceAt` separately displayed when the experience time differs | C | **Now has a real producer**, contrary to the 2026-09-04 certification: `WallCandidateLoaders.loadCapturedAtByEntity:201` reads `media_attachments → media_assets.captured_at`; assigned at `:469` (postcards) and `:721` (shared moments), each *only when it differs from publishedAt*. The upstream writer is `routes/posts.ts:143` `capturedAtFromImageBytes(rawBody)` → `recordMediaAsset(… capturedAt)` (`:270`). Client shows "Happened …" only on a difference (`components/objects/wallItemShared.tsx` `ActorByline`). *Chain caveat under §4 below: `recordMediaAsset` is gated on `media_canonical_enabled` (`lib/mediaAssets.ts:119`).* |

### §17 Global Input Intelligence Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W67 | Consumes the platform-wide layer; no separate Wall autocomplete engine | C | `services/wall/WallSessionIntentService.ts` delegates parsing to the `lib/inputAssistance` gateway; the Wall owns no tokenizer. |
| W68 | Typed intent creates a temporary Wall session context | C | `routes/wall.ts:784-798` — a per-request `session_intent` is parsed fresh and never persisted; otherwise the stored intent applies. Store: `wall_session_intents` (migration 2271), written at `WallSessionIntentService.ts:203`, deleted at `:227` and on account deletion (`services/accountDeletion/AccountDeletionService.ts:1068`). |
| W69 | Canonical entities become structured filters, not raw strings | C | `lib/wallProjection.ts:401-417` `StructuredIntentFilter` carries `kind` + `entityId`; residual text stays in `keywords`. |
| W70 | Clearing the intent restores the prior Wall state | C | `routes/wall.ts:1085-1099` `DELETE /wall/session-intent` → `clearStoredIntent`; client `hooks/useWallSessionIntent.ts` re-fetches unsteered. |
| W71 | Voice input and typo normalization use the same global engine | **?** | The Wall correctly delegates to the shared gateway, so *if* voice/typo normalization live there the Wall inherits them. Whether the shared engine actually implements voice input is a Global Input Intelligence question, out of this spec's tree and censused by the sibling agent on that spec. Not counted for or against the Wall. |

### §18 Stories / Quick Media

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W72 | Lightweight top row of short-lived media from followed people; not the main Media system; must not compete with Live For You | C | `routes/wall.ts:1195-1221` `GET /wall/quick-media` → `loadQuickMediaItems` (24 h window, bounded by `MAX_QUICK_MEDIA_ITEMS`), fail-soft to an empty row; client `hooks/useQuickMedia.ts`, `components/QuickMediaRow.tsx` renders nothing when empty and opens the canonical media viewer (`WallScreen.tsx:102-104`). |

### §19 Rent a Buddy Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W73 | Buddy Dispatch from someone followed or engaged with | C | `WallCandidateLoaders.loadContextualOpportunityCandidates` — engaged-buddy set from the viewer's own `rent_buddy_bookings`, then `isDispatch = followedCreatorIds.has(userId) \|\| engagedBuddyIds.has(profileId)`. |
| W74 | Temporary "I'm Around" availability matched to interest/context | C | Same loader: `available_now === true` re-checked in memory, `available_now_until` horizon enforced, `inContext` from current city + upcoming trip cities, `matchCategory` against viewer interests. |
| W75 | Buddy experience media as social content | C | `buddyMediaToDisplay(row)` populates `media` on the opportunity candidate. |
| W76 | Context Thread beneath a place/nightlife post when human help is materially useful | C | `ContextThreadService.readBuddyCandidate:659` — city granularity only, honest `available_now` only, behind `wall_rab_integration_enabled` AND the RAB master (`services/wall/wallRabGate.ts`). |
| W77 | Never expose precise Buddy coordinates; approved area / service zone only | C | The opportunity carries `opportunityArea` = city plus at most `MAX_ZONE_LABELS` named meetup zones; `WallProjectionService.ts:255-266` passes only `params: { area }`. No lat/lng path exists. |
| W78 | Paid Buddy promotion cannot alter factual Live Intelligence confidence | C | The buddy strip producer reads only `available_now` and the booking gate; live confidence comes from `lib/liveClaimRead`'s source-class boundary, which has no paid input. No promotion field is read anywhere in `services/wall/`. |

### §20 Hidden Gems Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W79 | Gems can appear through social content, Postcards, discovery or Context Threads | C | Discovery reason path `routes/wall.ts:494-509`; thread path `ContextThreadService.readHiddenGemCandidate:558`; strip path `LiveForYouService.buildGemLiveCandidates`. |
| W80 | Do not optimize Gem exposure for virality | C | Gem exposure is gated on disclosure policy and freshness, never on engagement counts; no gem term appears in `WallRankSignals`. |
| W81 | Respect approximate/coarse location and intentional-open rules | C | `routes/wall.ts:504` admits only `public`/`approximate`; `LiveForYouService.ts:82` excludes `protected`/`reveal_after_acceptance`. |
| W82 | Current Gem state only when evidence is fresh and qualified | C | `LiveForYouService.ts:86` `GEM_FRESH_MS` (3 d) plus the resolved-fact `validUntil` drop. |
| W83 | A social post may be associated with a Gem without revealing protected access info | C | The discovery reason names the gem relationship but the projection's `PublicPlaceRef` omits coordinates entirely for Wall place refs (`routes/wall.ts:475-483`, comment at `:480-482`). |

### §21 Compass Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W84 | No permanent giant Compass panel; an action or interpretation only | C | Compass exists solely as one optional action (`WallProjectionService.ts:238-245`) and one Context Thread kind (`ContextThreadService.ts:854`). No Wall component renders a Compass panel. |
| W85 | Ask Compass from a place-linked post | C | `WallProjectionService.ts:236-245` — added only when `c.place` exists and `compassHandoffEnabled` (flag read `routes/wall.ts:766`). |
| W86 | Interpret a cluster of social signals only when evidence and privacy rules allow | **W** | The gate exists (`ContextThreadService.readCompassCandidate:838` runs through the §9 gate), but no *cluster* interpretation is implemented — the compass thread is a per-object prompt, not an interpretation over a set of social signals. The affordance is a question, which is safe; the "interpret a cluster" behaviour named by the spec is absent. |
| W87 | Never present inference as verified fact | C | `services/wallCompass.ts:12,44` phrases a QUESTION and hands off ids only. |
| W88 | Compass references canonical objects in its responses/actions | C | `services/wallCompass.ts:44-73` — ids-only handoff into the canonical Compass surface; a missing route degrades rather than crashing (`:63-73`). |

### §22 Map and Place Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W89 | Wall objects link into canonical Map/Place surfaces; no second place-state system; all current-state labels from the shared Live projections | C | Every current-state label routes through `lib/liveClaimRead` (`LiveForYouService.ts:29-32`, `ContextThreadService.ts:46`); the Wall's place refs carry placeId/name/city/country only (`routes/wall.ts:475-483`); the events reader is the Map gateway's own (`LiveForYouService.ts:34-39` explicitly refuses a second events gate). |

### §23 Privacy, Safety and Visibility

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W90 | Every object passes canonical visibility/block/moderation before projection | C | `WallProjectionService.projectObjects:325-345` — eligibility → block → visibility, then project; `routes/wall.ts:879-885` runs it before any ordering. |
| W91 | Exact person location never inferred from a public post | C | Wall place refs omit coordinates by construction (`routes/wall.ts:480-482`); social presence is derived from public posts at a place with a k≥2 floor, never from a position read. |
| W92 | Delayed posting preserves the user's location-disclosure policy | C | `routes/wall.ts:392-394` filters `post_status = 'published'` in the query and re-checks `isPostPublished(r)` in memory at `:442`; the comment at `:126-130` records the defect this closed. |
| W93 | Blocked users excluded from feed, social proof and typeahead surfaces | C | `WallProjectionService.loadBlockedAuthorIds:152-181` is bidirectional and **fails closed** (`:170`, `:179` return the whole queried set on error); shared-moment participants are block-filtered inside their loader. |
| W94 | Trip/private-circle context cannot leak through "people here" labels | C | The social-presence reader uses only PUBLIC posts by people the viewer follows (`ContextThreadService.ts:16-19`), with the k≥2 floor; no trip or circle membership feeds it. |
| W95 | Sensitive places and protected Gems use disclosure policy before rendering context | C | `ContextThreadService` sets `sensitiveDisclosure` / `viewerAuthorized:false` for protected and reveal-after-acceptance gems, which the §9 gate then suppresses. |
| W96 | Safety suppressions override ranking and context rendering | C | `passesEligibility` (`WallProjectionService.ts:184-201`) drops `removed`/`takedown`/`moderated` and any non-`active` author status *before* the ranker sees the candidate; the ranker cannot re-admit a dropped object because it only ever sees survivors. |

### §24 Projection Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W97 | canonical → projection → eligibility/privacy/moderation → rank or sort → diversity/dedup → API → UI | C | `routes/wall.ts`: loaders (`:804-862`) → `projectObjects` (`:881`) → mode order (`:892-925`) → `applyFeedDiversity` (`:923`) → context threads (`:968`) → `WallResponse` (`:978-987`). |

### §25 Service Boundaries

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W98 | WallProjectionService owns projection, not canonical truth | C | `services/wall/WallProjectionService.ts:1-33` header states the boundary; every emitted value is copied from a canonical row. |
| W99 | WallRankingService owns For You ordering, not visibility authorization | C | `WallRankingService.ts:1-6`; it consumes already-gated projections and its own comment at `:329-331` notes the Wall gate is authoritative over the ranker's advisory eligibility net. |
| W100 | WallDiversityService owns mix/fatigue/dedup, not content truth | C | `WallDiversityService.ts:1-49` — pure and DB-free, transforms an already-ranked, already-gated list. |
| W101 | LiveForYouService owns the strip, not the underlying live claims | C | `LiveForYouService.ts:1-6`; truth is read through `lib/liveClaimRead`. |
| W102 | ContextThreadService owns optional attachments, not independent feature databases | C | `ContextThreadService.ts:1-38` — each kind reads through its owning system's gated read path. |
| W103 | FollowingFeedService owns strict chronology, not relevance reordering | C | `FollowingFeedService.ts:1-23`, pure and DB-free. |

### §26 API Shape

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W104 | `GET /wall?mode=&cursor=&session_intent=` | C | `routes/wall.ts:741`, schema `:717-722`. |
| W105 | `GET /wall/live?limit=4` | C | `routes/wall.ts:993`, limit clamped to `MAX_LIVE_FOR_YOU` at `:1006-1009`. |
| W106 | `POST /wall/session-intent { text }` | C | `routes/wall.ts:1046`, schema `:724`. |
| W107 | `DELETE /wall/session-intent` | C | `routes/wall.ts:1085`. |
| W108 | `POST /wall/impression` | C | `routes/wall.ts:1103`, schema `:726-730`. |
| W109 | `POST /wall/action` | C | `routes/wall.ts:1154`, schema `:732-737`. |

### §27 Response Contract

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W110 | `WallResponse` = mode, sessionIntent, liveForYou, items, nextCursor, caughtUp, generatedAt | C | `lib/wallProjection.ts:423-433`; assembled at `routes/wall.ts:978-987`. |

### §28 Cursor and Pagination Rules

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W111 | Following cursor stable against publishedAt + deterministic tiebreaker | C | `FollowingFeedService.ts:26-31,52-67,88-96`. |
| W112 | For You cursor carries rank session/version so page 2 does not reshuffle page 1 | C | `WallRankingService.ForYouCursor:104-110` carries session + version + snapshotAt; `:288-292` scores AT the snapshot instant, not "now" — the header at `:39-47` explains why both jobs are required. |
| W113 | Never duplicate canonicalObjectId in one active feed session | C | `WallRankingService.ts:294-300` and `FollowingFeedService.ts:111-118` both dedupe; `WallProjectionService.dedupeCandidates` collapses multi-loader collisions upstream. |
| W114 | Feed refresh may start a new rank session | C | `WallRankingService.ts:275-278` — an absent or version-mismatched cursor calls `newRankSession()`. |
| W115 | Live For You refreshes independently from feed pagination | C | Separate endpoint `GET /wall/live` (`routes/wall.ts:993`) and a separate client hook (`hooks/useLiveForYou.ts`) with its own TTL. |

### §29 Client Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W116 | The `/features/wall` tree with components/objects/hooks/services/types | C | Present and complete, including the previously-missing `services/wallPrefetch.ts`. One naming variance: `components/ContextThreadView.tsx` for the spec's `ContextThread.tsx`. |

### §30 State Ownership

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W117 | Follow relationship ← Social Graph | C | `routes/wall.ts:214-222` reads `user_follows`; the Wall never writes it. |
| W118 | Post/video/Postcard media ← canonical media/content systems | C | `WallCandidateLoaders.loadVideoMediaCandidates` delegates to `services/media/MediaProjectionService` (imported `:41-45`). |
| W119 | Place identity/state ← Places + Live Intelligence | C | `routes/wall.ts:468-488` reads `places`; state via `lib/liveClaimRead` only. |
| W120 | Trip membership/saves ← Trips | C | `routes/wall.ts:223-234` reads `trip_members`; `:284-297` reads `trips`. |
| W121 | Hidden Gem qualification ← Hidden Gem system | C | `routes/wall.ts:494-509` reads `hidden_gems`; `ContextThreadService` uses `deriveGemProjection` from `services/hiddenGems/`. |
| W122 | Buddy availability/service eligibility ← RAB | C | The opportunity loader reads `rent_buddy_profiles` and runs the canonical `enforceBookingCreationGates` imported from `routes/rentABuddy.ts` (`WallCandidateLoaders.ts:53`) — the Wall does not re-implement the gate. |
| W123 | Viewer privacy/block eligibility ← Policy/Trust/Safety | C | `lib/postVisibility.decidePostReadable` and the `blocks` table are the only sources (`WallProjectionService.ts:206-222`). |
| W124 | For You rank score ← Wall Ranking | C | `WallRankingService.rankForYou`. |
| W125 | Feed session cursor ← Wall | C | `WallRankingService` + `FollowingFeedService` encode/decode; no other system reads them. |
| W126 | Temporary typed Wall intent ← Wall session using GII | C | `wall_session_intents` is Wall-owned (migration 2271 header states exactly this) while parsing is delegated to the GII gateway. |

### §31 Caching and Prefetch

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W127 | Cache the first For You page for fast reopen, but revalidate eligibility | C | **Now built**, contrary to the 2026-09-04 certification: `services/wallPrefetch.ts:47-56` (version, 10-min TTL, 24-h max age, 12-item cap); `hooks/useWallFeed.ts:153-160` writes the first page and `:145-147` treats the live page as authoritative on arrival. |
| W128 | Following may cache recent projections but must not display deleted/blocked content after revalidation | C | The cache is per-mode keyed (`wallPrefetch.ts:58-60`) and is only ever *displayed* when the live fetch fails (`useWallFeed.ts:168-186`); a successful fetch replaces it wholesale, so a revoked object cannot survive a successful revalidation. |
| W129 | Prefetch media for the next small number of visible objects only | C | `services/wallPrefetch.ts:55` `DEFAULT_PREFETCH_COUNT = 4`; `prefetchWallMedia` signs through `hydrateMediaUrls` then warms `expo-image`; called at `hooks/useWallFeed.ts:219`. |
| W130 | Live For You short TTL, visibly degrading when stale | C | `hooks/useLiveForYou.ts` TTL + validity check; `components/LiveForYouStrip.tsx` renders text state labels, not a fabricated live claim. |
| W131 | Do not cache exact/private location beyond the owning feature's policy | C | Nothing cacheable carries a coordinate: the persisted page is `WallProjection[]`, whose `PublicPlaceRef` is populated without lat/lng by the Wall's own loaders. |
| W132 | Offline mode may show cached social content; live-state UI removed or marked stale | C | `useWallFeed.ts:168-186` serves the cached page with `stale: true` + `cachedAt` on an initial-load failure and never restores a typed-intent session; tests `hooks/__tests__/useWallFeed.offlineCache.component.test.tsx:66,76,90`. |

### §32 Analytics

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W133 | Feed open and mode selection | C | `services/wallAnalytics.ts:72,76`. |
| W134 | Post/video/Postcard/Moment impressions | C | `services/wallAnalytics.ts:85-99` + `POST /wall/impression`. |
| W135 | Stamp/comment/share/save | C | `services/wallAnalytics.ts` `trackEngagement`; emitted from `components/objects/wallItemShared.tsx:385,389,394,398`. |
| W136 | Follow from feed | C | `services/wallAnalytics.ts` `trackFollowFromFeed`. |
| W137 | Context Thread shown / acted / ignored | C | `services/wallAnalytics.ts:125,129,134`. |
| W138 | Live For You shown / opened | C | `services/wallAnalytics.ts:117,121`. |
| W139 | Map/Place/Trip/Compass/Buddy handoff | C | `services/wallAnalytics.ts` `trackHandoff` with a surface enum. |
| W140 | Discovery follow conversion | C | `trackFollowFromFeed(projection, fromDiscovery)` carries the conversion flag. |
| W141 | Caught-up rate | C | `services/wallAnalytics.ts` `trackCaughtUp`. |
| W142 | Hide / not-interested signals | C | `trackNotInterested` + `NotInterestedControl` (`wallItemShared.tsx`). |
| W143 | Real-world outcome signals where valid and consented | C | `trackRealWorldOutcome(projection, outcome, consented)` returns early when `consented` is false; outcome is a coarse enum. |
| W144 | Never log raw private message text or unnecessary raw typed content | C | Every event payload is ids + enums + counts (`services/wallAnalytics.ts:72-207`); the server re-derives each payload from a per-event allow-list (`routes/wallTelemetry.ts`) and migration 2308 adds a database CHECK refusing coordinate-, contact- or free-text-shaped keys. |

### §33 Performance Targets

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W145 | Cached Wall first paint: immediate skeleton/content where available | C | `services/wallPrefetch.ts` first-page cache seeds the initial paint; `components/WallFeed.tsx` renders a loading state rather than a blank screen. |
| W146 | First server page < 500 ms backend | **?** | `test/wallPerformance.test.ts:322,349` asserts a p50/p95 ceiling — but against an in-memory fake client (`:205-227`), so it bounds *read count and slope*, not wall-clock latency against Postgres. The construction obligations are met (`routes/wall.ts:124` `CANDIDATE_FETCH = 150`, `WallCandidateLoaders.ts:63` `LOADER_FETCH = 60`); the 500 ms target itself is unmeasured. |
| W147 | Mode switch reuses a cached mode if fresh, else progressive load | C | Per-mode cache key (`wallPrefetch.ts:58-60`) plus `useWallFeed`'s generation-guarded refetch on mode change. |
| W148 | Live strip refreshes independently and never blocks feed render | C | Separate hook and endpoint; `routes/wall.ts:635-651` `buildLiveStrip` defers the entire candidate assembly behind a thunk so an OFF flag costs nothing, and any failure degrades to `[]`. |
| W149 | 60 fps scroll on supported devices | **?** | Requires a device. `components/WallFeed.tsx:145` sets explicit windowing props, and `components/__tests__/WallFeed.renderCost.component.test.tsx` bounds render cost, but neither measures frame rate. |
| W150 | Video lazy load, only near viewport | C | `components/objects/VideoWallItem.tsx:53-58` lazy-mounts the player only once the item enters the viewport. |
| W151 | Images: responsive variants + CDN/cache | C | `routes/posts.ts` builds a `feedUrl` feed-sized derivative; client renders through `CachedImage` → `expo-image` disk/memory cache, warmed by `prefetchWallMedia`. |

### §34 Failure Modes

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W152 | Live Intelligence unavailable → hide/degrade strip, social feed normal | C | `routes/wall.ts:642-650` catches and returns `[]`. Test: `test/wallRouteDegradation.test.ts`. |
| W153 | Ranking unavailable → fallback eligible recent/relevance-safe ordering | C | `WallRankingService.ts:322-327` — on a ranker throw every item scores 0 and the stable tiebreak preserves input order. |
| W154 | Place resolver unavailable → render the social object without place intelligence | C | `routes/wall.ts:486-488` — a failed `places` read logs and leaves `placeRef` null; the object still projects. |
| W155 | Compass unavailable → remove the action, do not block the post | C | The action is added only behind its flag (`WallProjectionService.ts:238`); the client tolerates a missing route (`services/wallCompass.ts:63-73`). |
| W156 | RAB unavailable → remove Buddy context only | C | `routes/wall.ts:855-860` — the opportunity loader is skipped or caught to an empty load; `ContextThreadService.readBuddyCandidate` is fail-closed on both flags. |
| W157 | Media processing pending → placeholder without breaking the feed | C | `DisplayMedia.processing` (`lib/wallProjection.ts:111`); `VideoWallItem.tsx:69` falls back to the poster when `media?.processing`. |
| W158 | Network offline → cached social feed, no fake live states | C | `useWallFeed.ts:168-186` serves the cached page labelled stale; nothing fabricates a live item (the strip is server-only and simply absent). |

### §35 Design System Rules

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W159 | Clean social-media density, generous whitespace | **?** | A visual judgement; spacing tokens are applied consistently but "generous" is not statically decidable. |
| W160 | One primary content object at a time in the vertical scroll | C | `components/WallFeed.tsx:138` `FlatList` renders one projection per row; no grid layout exists in the tree. |
| W161 | Live For You compact and horizontally browsable | C | `components/LiveForYouStrip.tsx:81-82` horizontal `ScrollView`, ≤4 items. |
| W162 | For You / Following switch simple and persistent near feed start | C | `components/WallScreen.tsx:127` renders `FeedModeSwitcher` unconditionally, directly above the feed. |
| W163 | Postcards visibly break the normal feed language | C | `components/objects/PostcardWallItem.tsx` — distinct paper frame, rotation, date stamp. |
| W164 | Video remains inline and cinematic | C | Inline is enforced (`VideoWallItem.tsx:82-88`); "cinematic" is a full-bleed wide frame (`ratio={aspect.wide}`). |
| W165 | Context Threads visually quieter than the post | C | `components/ContextThreadView.tsx:145-156` — muted `t.small` type, `color.faint` reason line, paper background with a hairline border. |
| W166 | Portava purple is an interaction/accent colour, not a background wash | **W** | The Wall's accent tokens are **not purple**: `src/theme/tokens.ts:12` `signal: '#FF4D2E'` (vermilion) and `:14` `deep: '#0A3D4A'` (teal-ink), and those are what the Wall components use (`ContextThreadView.tsx:103,155`, `wallItemShared.tsx`). The *structural* half of the rule holds — no card uses the accent as a background wash — but the specified colour is absent. Same family of divergence as Passport §27. |
| W167 | Avoid dashboard grids, event-page density, giant recommendation modules, excessive badges | **?** | Structurally supported (single-column list, one thread per object, ≤4 strip items), but "excessive" is a visual judgement. |
| W168 | The user should understand the Wall without knowing Portava's architecture | **?** | A comprehension claim; needs users. |

### §36 Accessibility

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W169 | All feed actions have accessible labels | C | `components/objects/wallItemShared.tsx` — 12 `accessibilityRole`/`accessibilityLabel` sites, including every control in `SocialActionRow:401-421`; strip, switcher, header and video controls likewise. |
| W170 | Video controls remain keyboard/screen-reader accessible | **?** | The Wall's own open control is labelled (`VideoWallItem.tsx:99`), but the transport controls belong to `SharedVideoPlayer` and their screen-reader behaviour needs a device. |
| W171 | Autoplay respects reduced motion and user settings | C | `services/videoAutoplayPolicy.ts:60-63`; `hooks/useReducedMotionSetting.ts`. Tests: `objects/__tests__/VideoWallItem.component.test.tsx:122,159,191,200`. |
| W172 | Live state must not rely on colour alone | C | `components/ContextThreadView.tsx` `freshnessLabel` and `components/LiveForYouStrip.tsx` `stateLabel` render the state as TEXT. |
| W173 | Postcard decorative typography preserves readable accessible text | **?** | Needs a rendered screen and a screen reader. |
| W174 | Mode switch and horizontal Live For You list support logical focus order | **?** | Focus order is a runtime property of the RN accessibility tree; no test exercises it. |

### §37 Security and Abuse Controls

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W175 | Server-side eligibility is authoritative; never rely on client hiding | C | The gate runs in `WallProjectionService.projectObjects` before anything is serialized; every route short-circuits on `wall_enabled` before any canonical read (`routes/wall.ts:748,1000,1053,1092,1110,1161,1202`), and `lib/featureFlags.isFlagEnabled` returns false on error. |
| W176 | Rate-limit impression/action mutation endpoints | C | `routes/wall.ts:114-118` `WALL_RATE_LIMITS`, applied at `:1069`, `:1123`, `:1172`. Test: `test/wallRateLimits.test.ts`. |
| W177 | Prevent ranking manipulation through keyword stuffing or repeated self-engagement | C | No free-text term feeds the ranker (`WallRankSignals`, `WallRankingService.ts:69-88`, is tags/category/counts only), so keyword stuffing has no lever; and Wall telemetry rows are written with `outcome: "analytics"` precisely so they "never collide with the impression-finding query" (`routes/wall.ts:138-166`), so flooding your own object through `POST /wall/impression` cannot move ranking. Rate limits bound the flood regardless. |
| W178 | Paid/promoted content, if introduced later, is explicitly labeled and separated from factual live confidence | **N** | No promoted-content concept exists in the Wall at all — no field, no label, no separation mechanism. The rule holds *vacuously* today (there is nothing to mislabel), but nothing implements it, so it is counted as not built rather than credited. |
| W179 | Moderation takedowns propagate to cached Wall projections | **W** | Server-side propagation is real: `passesEligibility` (`WallProjectionService.ts:198-200`) drops `removed`/`takedown`/`moderated` on every request. The **client cache does not**: `services/wallPrefetch.ts` persists whole `WallProjection` objects for up to 24 h and `useWallFeed.ts:168-186` re-displays them offline with no re-validation against a takedown — the offline path is the one path where a taken-down object can still paint. It is labelled stale, which mitigates but does not implement the requirement. |
| W180 | Impersonation, blocked-user and private-account rules apply before social proof is constructed | C | The block read is bidirectional and fail-closed (`WallProjectionService.ts:152-181`) and runs before projection; social presence is built only from already-visible public posts by followed accounts. |

### §38 Testing Matrix

| id | Test family must prove | V | Evidence |
| --- | --- | --- | --- |
| W181 | Ordering: Following strictly chronological, For You cursor stable | C | `test/wallFollowingFeed.test.ts`, `test/wallForYouCursor.test.ts`. |
| W182 | Privacy: no blocked/private/sensitive leakage in items, context or strip | C | `test/wallProjection.test.ts`, `test/wallContextThread.test.ts`, `test/wallViewerLocationRead.test.ts`. |
| W183 | Dedup: no repeated objects/live signals across page boundaries | C | `test/wallForYouCursor.test.ts`, `test/wallLiveStripDedup.test.ts`. |
| W184 | Freshness: stale live labels disappear/degrade | C | `test/wallLiveForYou.test.ts`, `test/wallLiveForYouKinds.test.ts`. |
| W185 | Media: video pause/resume, image fallback, processing state | C | `objects/__tests__/VideoWallItem.component.test.tsx:101,122`; `test/wallAutoplayContract.test.ts`. |
| W186 | Postcards: distinct projection/viewer route preserved | C | `test/wallCandidateLoaders.test.ts`; `objects/__tests__/postcardOpenRoute.component.test.ts`. |
| W187 | Context: context only appears when the gate passes | C | `test/wallContextThread.test.ts`. |
| W188 | Offline: cached social content works, live truth not fabricated | C | `hooks/__tests__/useWallFeed.offlineCache.component.test.tsx`; `services/__tests__/wallPrefetch.component.test.ts`. |
| W189 | Failure: a subsystem outage never collapses the social feed | C | `test/wallRouteDegradation.test.ts`. |
| W190 | Accessibility: focus, labels, reduced motion, contrast | **W** | Reduced motion is proven four ways (`VideoWallItem.component.test.tsx:122,159,191,200`) and labels are asserted incidentally by query-by-label in several component tests, but **no test exercises focus order or contrast** — there is no accessibility test file in the Wall tree. Two of four properties covered. |

### §39 Rollout Plan

| id | Phase | V | Evidence |
| --- | --- | --- | --- |
| W191 | 1 — Shell, For You/Following, Posts, photos, video, Postcards | C | Route + seven renderers + mode switch, behind `wall_enabled`. |
| W192 | 2 — Live For You strip with strict freshness/privacy | C | `LiveForYouService` + `useLiveForYou`, behind `wall_live_for_you_enabled`. |
| W193 | 3 — Context Threads for Place, Trip, Hidden Gems | C | `ContextThreadService` + the §9 gate, behind `wall_context_threads_enabled` (migration 2272). |
| W194 | 4 — Shared Moments, discovery insertions, diversity controller | C | Shared-moment loader wired (`routes/wall.ts:851`), `WallDiscoveryInsertionService`, `WallDiversityService`. |
| W195 | 5 — Global Input Intelligence steering and Compass handoffs | C | `WallSessionIntentService`, `services/wallCompass.ts`, behind their two flags. |
| W196 | 6 — RAB/Buddy contextual integration and Dispatch projections | C | **Now complete**: the buddy Context Thread *and* `loadContextualOpportunityCandidates` producing `buddy_dispatch`/`buddy_around`, wired at `routes/wall.ts:856` behind `isWallRabEnabled` + the booking KYC gate. This is the item the 2026-09-04 certification called PARTIAL. |
| W197 | 7 — Outcome learning, advanced personalization, continuous certification | C | `trackRealWorldOutcome` (consent-gated), `DiscoveryRankingService` personalization, and the server telemetry sink `routes/wallTelemetry.ts` + migration 2308. *Deployment caveat in §4.* |

### §40 Non-Negotiable Product Tests

| id | Test | V | Evidence |
| --- | --- | --- | --- |
| W198 | Enjoyable purely as social media | C | `WallFeed` renders with zero dependency on live or context surfaces; test `components/__tests__/WallScreen.liveDegrades.component.test.tsx`. |
| W199 | Live For You is ignorable | C | Returns `null` when empty; `components/__tests__/LiveForYouStrip.boundedIgnorable.component.test.tsx`. |
| W200 | Strict chronology is available | C | `FollowingFeedService` + always-rendered `FeedModeSwitcher`; `components/__tests__/WallScreen.modeSwitch.component.test.tsx`. |
| W201 | Postcards and videos feel native and distinct | C | Distinct renderers, distinct server producers; `components/__tests__/WallScreen.objectTypes.component.test.tsx`. |
| W202 | Contextual intelligence appears only when useful | C | The §9 gate defaults false and at most one thread attaches per object. |
| W203 | A social object can lead to Map/Trip/Compass/Gem/Buddy without forcing the transition | **W** | Handoffs are additive and never auto-navigate — but two of the named destinations are unreachable from a Wall object because their actions have no producer (W7: `join`, `message`) and `save` does not persist. Map, Trip, Compass, Gem and Buddy do work; the *set* the spec names is incomplete. |
| W204 | If all intelligence services fail, a safe functional social feed remains | C | Every subsystem call in `routes/wall.ts` is individually wrapped; `test/wallRouteDegradation.test.ts`. |

### §41 End-to-End Wall Loop

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| W205 | open → live → feed → object → engage → context → handoff → real-world action → create → graph/memory → future relevance | **W** | Every hop exists as code except the *return* leg: nothing in the Wall writes back an outcome that changes future relevance. `trackRealWorldOutcome` (`services/wallAnalytics.ts:196-207`) is the only outcome writer, it is client-side and consent-gated, and its destination table (`wall_telemetry_events`, migration 2308) **is not deployed** — production has exactly one `wall*` table, `wall_session_intents`. The loop is open at the point where it is supposed to close. |

---

## 3. What could not be verified (9), and six deployment facts

Nine requirements, counted honestly in their own bucket and never folded into
either side.

| id | § | Why it cannot be settled by construction |
| --- | --- | --- |
| W71 | 17 | Voice input / typo normalization live in the shared Global Input Intelligence engine, outside this spec's tree. The Wall's delegation is correct; the engine's capability is another spec's census. |
| W146 | 33 | `<500 ms` backend needs a real database. The existing test bounds read count against a fake client. |
| W149 | 33 | 60 fps needs a device. |
| W159, W167, W168 | 35 | Visual/comprehension judgements ("generous whitespace", "excessive badges", "understand without knowing the architecture"). |
| W170, W173, W174 | 36 | Screen-reader behaviour of the shared video player, decorative-typography legibility, and focus order are runtime accessibility-tree properties. |

**Six deployment facts that bound the built code.** These are *not* construction
verdicts and are not in the 205 — but they decide whether the built code can do
anything, and they are the most consequential paragraphs in this census.

1. **The whole Wall is dark.** Every route short-circuits on `wall_enabled`, and migration 2270 seeds all five flags OFF with a postcondition that fails the migration if any is ON (`2270_wall_feature_flags.sql:26-30`). 2272 seeds two more OFF. Whether any has since been flipped is a database question this census does not ask.
2. **Live For You's `place_state` kind is structurally empty in production.** `readLiveClaimEnvelopes` returns `[]` when the promoted-scope allowlist is empty (`lib/liveClaimRead.ts:316-317`), and `intel_live_promoted_scopes` is on the writerless-reads ratchet as a deliberately-empty human allowlist whose own note says: *"This is why `wall_live_for_you_enabled` should stay off: it would serve an empty strip"* (`src/scripts/checkWriterlessReads.ts:174-181`). The other five strip kinds have their own producers and are unaffected.
3. **§16's two clocks depend on a flag-gated writer.** `recordMediaAsset` returns early unless `media_canonical_enabled` is on (`lib/mediaAssets.ts:119`), so `media_assets.captured_at` — the only `experienceAt` source — is written only when that flag is lit. The producer chain is complete and correct in code; whether it produces anything is a deployment fact.
4. **§32's server sink is not deployed.** Migration 2308 creates `wall_telemetry_events`; production contains exactly one `wall*` table, `wall_session_intents`. Thirteen of the fifteen client-emitted §32 events therefore have nowhere to land, and the transport is fire-and-forget so the 404 is silent. The client half and the route half are both built and correct.
5. **`wall_session_intents` is the Wall's only storage, and it does have writers** — `WallSessionIntentService.ts:203` (upsert), `:227` (delete), plus the account-deletion step at `AccountDeletionService.ts:1068`. It is *not* on the writerless-reads ratchet (`KNOWN_WRITERLESS_READS`, `checkWriterlessReads.ts:102-213`, does not list it). The counter-signal in the brief — one `wall*` table — is real and is explained: **the Wall genuinely rides on `posts`, `post_media`, `media_assets`, `media_attachments`, `shared_moments`, `places`, `hidden_gems`, `rent_buddy_profiles`, `trips`, `trip_members`, `user_follows`, `blocks` and `rank_events`, and owns almost no state of its own by design (§30).** That is the architecture working as specified, not a gap. The one thing it *should* own and does not yet have deployed is the §32 telemetry sink.
6. **Writer-attribution caveat.** `checkWriterlessReads.ts:39-41` states that a dynamic `.from(expr)` anywhere makes writer attribution INCOMPLETE and that the check errs toward silence. Every "nothing writes X" claim above was settled by reading the writer call sites, not by grepping `from("…")`.

---

## 4. Reconciliation with `wall-certification.md`

That document certifies commit `8f186410d` (2026-09-04). This census reads
`ebe72b34`. Work landed in between, and the certification is stale **in the
built direction on all three of its open items**.

### 4.1 The "38 of 41 sections fully built" claim, tested section by section

I agree that 38 sections are built. I additionally find that **the three it
called PARTIAL are now built too**, so at its own grain the honest count is
41/41:

| § | Certification verdict | This census | Why |
| --- | --- | --- | --- |
| §16 Two clocks | PARTIAL — "no producer assigns `experienceAt`" | **Built** | `WallCandidateLoaders.loadCapturedAtByEntity:201` + assignments at `:469`/`:721`, fed by the `captured_at` writer added at `routes/posts.ts:143,270`. The certification's own completion condition ("a legitimate source assigns `experienceAt` … with tests proving `publishedAt` and `experienceAt` can differ") is met — `test/mediaCapturedAtWriter.test.ts` is that test. |
| §19 / Phase 6 | PARTIAL — "`contextual_opportunity` has no candidate producer; 1 of 7 object types unreachable" | **Built** | `loadContextualOpportunityCandidates` exists and is wired at `routes/wall.ts:856`, behind `isWallRabEnabled` + `checkBookingKycGate` + the consolidated `enforceBookingCreationGates`. All 7 object types are now server-emittable. Tests: `test/wallOpportunityLoader.test.ts`, `test/wallOpportunityRoute.test.ts`. |
| §31 Caching & prefetch | PARTIAL — "`wallPrefetch.ts` … does not exist; zero hits for `prefetch`" | **Built** | `services/wallPrefetch.ts` (264 lines) implements both halves — first-page cache with two horizons and a media prefetch with `DEFAULT_PREFETCH_COUNT = 4` — and `hooks/useWallFeed.ts:219` calls it. Test: `services/__tests__/wallPrefetch.component.test.ts` (12 cases). |

The remaining 38 I also find built at section grain, with these **corrections to
its evidence**, none of which change a section verdict:

- **§8** — the certification credits five Context Thread readers ("live, trip, social, gem, buddy"). There are **eight**; `map` (`:748`), `memory` (`:803`) and `compass` (`:854`) exist too. Its §8 verdict was right for a weaker reason than the code supports.
- **§15** — it cites `liveStripDeduplication` as a policy field. That field no longer exists on `FeedDiversityPolicy`; it was removed as a documented permanent no-op (`WallDiversityService.ts:24-41`) and the rule migrated to `ContextThreadService`, where it now covers every place-anchored kind rather than only `live_place`. Stronger than the cited version.
- **§29** — it lists `wallPrefetch.ts` as absent. It exists.
- **§33** — it reclassifies Performance as "BUILT (construction)" and moves `<500 ms` / 60 fps to Runtime QA. I agree with the *reclassification* and disagree with the *accounting*: the two runtime targets are two of my 205 requirements and they sit in CANNOT-VERIFY, where they are visible, rather than being netted out of the denominator.

### 4.2 Where the numbers part company, and why

The disagreement is not about any single section. It is about what a 41-cell
denominator can express.

A section scores BUILT the moment its named artifact exists and does something.
Seven requirements inside sections the certification scores BUILT do not do what
the spec asks, and there is no cell in that ledger to record them:

- **§2 / §40** — `join` and `message` have **no server producer** anywhere (they exist only in the client's route resolver, `wallItemShared.tsx:117,129`, for actions the server never emits), and `save` is a React state toggle that writes nothing (`wallItemShared.tsx:392-396`). Three of the eight real-world actions §2 names are not real. §2 and §40 both score BUILT in the certification.
- **§21** — the "interpret a cluster of social signals" behaviour is absent; only the safe per-object prompt exists.
- **§35** — the Wall's accent colours are vermilion (`#FF4D2E`) and teal-ink (`#0A3D4A`); Portava purple, which §35 names explicitly, appears nowhere in the Wall tree. The certification scores §35 BUILT citing "purple as accent".
- **§37** — moderation takedowns propagate server-side on every request but **not** through the 24-hour client first-page cache, which is the one path where a taken-down object can still paint. The certification scores §37 BUILT.
- **§38** — the accessibility test family proves reduced motion four ways and proves nothing about focus order or contrast; there is no accessibility test file in the Wall tree. The certification scores §38 BUILT citing "TABLE 6 families all represented".
- **§41** — the loop's return leg (outcome → future relevance) has no deployed destination.

Only one of these (§37's offline takedown path) has a safety edge; the rest are
unwired affordances or cosmetic divergence. That is why the construction number
survives and the correctness number is 3.4 points lower rather than twenty.

### 4.3 Net position

**I do not dispute ~96%.** At 205 requirements the Wall measures **95.1%
constructed**, and the certification's 96.3% part-credit figure is a fair
statement of the same fact. Where I part company is on what that number is
allowed to stand for:

| Question | Certification | This census |
| --- | --- | --- |
| How much of the named code exists and is wired? | ~96% | **95.1%** — agreed |
| How much of it does what the spec says? | not asked | **91.7%** |
| How much is honestly unverifiable? | folded into a "Runtime QA owed" narrative | **4.4%**, itemised, in its own bucket |
| How many sections are fully built? | 38 of 41 | **41 of 41** — the certification is stale, in the Wall's favour |
| Can any of it actually run today? | §12 flags this for §16's flag only | **Six deployment facts**, §3 above |

The certification's real weakness is not its arithmetic. It is that it has one
number where three are needed, it leans on a "runtime-QA" narrative where an
explicit CANNOT-VERIFY count belongs, and it treats the deployment question as a
footnote when — for the §32 telemetry sink, the empty live-scope allowlist and
the flag-gated `captured_at` writer — deployment is the difference between built
code and working product.

---

## 5. Open PRs that would change a verdict

Censused state is `main`. One open PR touches the Wall:

- **#459 — "Make a failed Wall read distinguishable from an empty Wall feed."** It adds `rowsOrThrow` so PostgREST errors reach the `catch` blocks that already exist, records `followGraphFailed` / `spineFailed` as facts, stops inferring `followingReachedEnd` from an unreadable fetch, and adds an optional `WallResponse.degraded?: WallLane[]`. This does **not** move any verdict in this census — §34's fail-soft behaviour is already correct and §27's `caughtUp` is already guarded by `reachedEnd` (`FollowingFeedService.ts:133`) — but it closes a real honesty gap on the *cause* of an empty feed. Nothing in this census depends on it; nothing in it contradicts a verdict here.
