# What the discovery ranker actually ranks on

**Roadmap phase C0. A code read at HEAD, not a build. No scoring was changed.**

## The question this answers

*"Is the engine the thing that changes outcomes?"*

That question cannot be answered from the packet, which argues about **reach** —
how many requests reach a ranker — and never about **signal** — what the ranker
does once reached. Both matter, and they fail differently:

| | if this is weak | consequence |
|---|---|---|
| **reach** | ranking runs for ~1 user per city per 2 h | D5=B fixes it |
| **signal** | ranking produces the same order for everyone | **D5=B fixes nothing a user would notice** |

**A ranker with no user-specific term produces the same order for every viewer.**
Running it on every request instead of one in a thousand would then change
nothing except CPU cost. So this had to be established before Phase D is
described as the headline.

Evidence standard: file:line, as in `phase-minus-1-repository-proof.md`.
Classification per signal:

- **(a) live** — populated on the discovery path and able to change the order
- **(b) computed but discarded** — calculated, then not used in the final order
- **(c) present but non-discriminating** — populated, but the same for every
  candidate, so it shifts all scores equally and changes no ordering
- **(d) declared and never populated** — the field exists, discovery never sets
  it, the term is structurally zero

---

## The answer, first

**The discovery ranking stack has exactly ONE user-specific signal that can
change the order: interest-tag overlap.** Everything else user-specific is
either hardcoded off, never populated, or constant across all candidates.

Most consequentially: **the follow graph is dead in both rankers.**
`loadPdeViewer` issues a `user_follows` query on every ranked request
(`lib/discoveryPde.ts:250-257`), and **no candidate carries an author or creator
id**, so every term that consults it is structurally zero:

- portavaRank: `f.followedAuthor` reads `c.authorId`, and the discovery mapping
  never sets `authorId` (`lib/discoveryPde.ts:311-320`) → always `0`
  (`lib/portavaRank.ts:267`).
- DRS: `calcRelationshipRelevance` opens `if (!input.creatorId) return 0`
  (`DiscoveryRankingService.ts:477`), and discovery hardcodes
  `creatorId: null` (`lib/discoveryPde.ts:343`) and `isFollowedByViewer: false`
  (`:361`).

So a per-request database read feeds a term that cannot fire. That is a
concrete, removable cost, and it is stated here rather than fixed because this
phase does not change scoring.

**Weight split.** Of the portavaRank weight that discovery can actually
exercise, **≈0.3 of ≈1.10 is user-specific — and all of it is the single
`interestTag` term.** The rest is item-intrinsic: distance, social proof,
verified, kind prior.

---

## portavaRank — `lib/portavaRank.ts`

Candidate fields are set at `lib/discoveryPde.ts:311-320`; the viewer context at
`:301-306`.

| Signal | Weight | Scoring line | Discovery input | Class | Why |
|---|---|---|---|---|---|
| `recency` | 1.00 | `:264` | `createdAt` **never set** | **(d)** | Highest weight in the table, structurally zero here. `recencyScore` returns `0` for a null date (`:176-177`). OSM venues have no creation date. |
| `followedAuthor` | 0.50 | `:267` | `authorId` **never set** | **(d)** | The follow graph is loaded per request and cannot apply. |
| `mutualAuthor` | 0.35 | `:268` | `authorId` never set; `ctx.mutualIds` never set | **(d)** | |
| `engagedAuthor` | 0.30 | `:269` | `authorId` never set; `ctx.engagedAuthorIds` never set | **(d)** | |
| **`interestTag`** | **0.30** | `:272` | `tags` ← OSM tags (`:319`); `interestTags` ← `compass_user_preferences.interests` (`:261-270`) | **(a) live — USER-SPECIFIC** | **The only term in this table that both varies per user and varies per candidate.** Binary: any one tag match scores the full 0.30. |
| `categoryAffinity` | 0.40 | `:277` | `ctx.categoryAffinities` **never set** | **(d)** | The learned-preference hook exists and discovery does not populate it. |
| `cityMatch` | 0.45 | `:281` | `c.city` ← `viewer.city` for **every** candidate (`:314`) | **(c)** | Every candidate is given the same city as the viewer, so `cityHit` is true for all of them. Adds a constant 0.45 to every score and changes no ordering. |
| `neighborhoodMatch` | 0.20 | `:282` | `neighborhood` **never set** | **(d)** | |
| **`distance`** | **0.35** | `:284` | `distanceKm` (`:316`) | **(a) live — item-intrinsic** | `1/(1+km/5)` (`:225-228`). The single largest *effective* ordering term. |
| `actionability` | 0.90 | `:285` | `startsAt` **never set** | **(d)** | The second-highest weight in the table — "the Portava edge: things you can DO" — and it is zero for every place, because places have no start time. |
| `availabilityFit` | 0.50 | `:286` | `startsAt` never set → early `return 0` (`:209`) | **(d)** | |
| **`socialProof`** | **0.25** | `:287` | `likeCount` ← `savedCount` (`:318`) | **(a) live — item-intrinsic** | Log-scaled (`:236-244`). Damped ×0.6 because `authorTrustScore` is absent. **Pre-launch, `savedCount` is 0 for effectively every place, so this is 0 today.** |
| `trust` | 0.30 | `:289` | `authorTrustScore` **never set** | **(d)** | |
| **`verifiedBonus`** | **0.15** | `:292` | `verified` ← `id.startsWith("db/")` (`:317`) | **(a) live — item-intrinsic** | Separates community DB places from OSM places. Not user-specific. |
| `capacityOpen` | 0.10 | `:293` | `hasCapacity` **never set** | **(d)** | |
| `seenPenalty` | −0.60 | `:294` | `ctx.seenIds` **never set** | **(d)** | Discovery repeats items across sessions with no suppression. |
| **`kindPrior`** | 0.05 / 0 | `:295` | `kind` ← gem \| place (`:313`) | **(a) live — item-intrinsic** | `gem: 0.05`; `place` is absent from `kindPrior` so it scores `0` (`:167`). A second, smaller db-vs-OSM separator. |
| `officialPublisher` | ×1.2 | `:304` | `isOfficialPublisher` **never set** | **(d)** | |
| `placeEngagement` | ×1.15 | `:313` | `placeId` / `ctx.placeAffinities` **never set** | **(d)** | |

**Effective weight on the discovery path: ≈1.10** — distance 0.35, interestTag
0.30, socialProof 0.25, verified 0.15, kindPrior ≤0.05 — against ~5.6 declared.
**Roughly 80 % of the declared scoring weight is inert on this surface.**

Excluding the constant `cityMatch`, and excluding `socialProof` while
`savedCount` is 0 pre-launch, **today's live ordering signal is: distance,
interest-tag match, verified, kind.** One of those four is user-specific.

---

## DiscoveryRankingService — the re-rank pass

Inputs built at `lib/discoveryPde.ts:340-372`; viewer at `:373-387`.

| Component | Fn | Discovery input | Class | Why |
|---|---|---|---|---|
| `freshness` | `:372` | `createdAt: null` (`:344`) | **(d)** | Returns 0 for a null date. |
| `viewerRelevance` | `:379` | `travelStyles` ← interests; `preferredCities` ← `[city]` (`:377`) | **(c)→(a)** | Jaccard of viewer terms against item tags. `preferredCities` is always non-empty, so the `viewerSet.size === 0` default at `:391` **never fires** — the viewer set always contains the city name. Overlap is therefore 0 unless an OSM tag matches an interest, in which case it is user-specific. |
| `contentRelevance` | `:402` | `travelStyles` vs `tags` + `category` | **(c) with no interests, (a) with them** | With no interests it returns a flat `max * 0.3` for every candidate (`:410`) — constant, no ordering effect. With interests it discriminates. |
| `geographicRelevance` | `:420` | `distanceKm`, `city` (db/ only, `:345`) | **(a) item-intrinsic** | For OSM places `city` is null → constant `max*0.3` branch (`:429`); db places match → `max*0.8`. So it re-expresses db-vs-OSM plus distance. |
| `contentQuality` | `:437` | `hasMedia`, `completeness`, `positiveReviewRate`, `flagCount: 0` | **(a) item-intrinsic** | `completeness` is a two-valued proxy: 0.9 with image+description, else 0.5 (`:351`). |
| `qualityEngagement` | `:451` | `saveCount`, `shareCount: 0`, `commentCount: 0`, `impressionCount`, `uniqueViewerCount` | **(b)/(c)** | **`impressionCount` is fabricated as `Math.max(1, savedCount)` (`:357`) and `uniqueViewerCount` as `savedCount` (`:358`).** So the engagement *rate* — engagement ÷ impressions — is computed against a denominator derived from the numerator. It is not an engagement rate; it is an artefact. Pre-launch, with `savedCount` 0 everywhere, it is 0. |
| `relationshipRelevance` | `:471` | `creatorId: null` (`:343`) | **(d)** | `if (!input.creatorId) return 0` at `:477`. |
| `explorationBoost` | `:482` | `isFirstImpression: false`, `isUnfamiliarCategory: false` (`:371`) | **(d)** | Both hardcoded false. |
| `activityBoost` | `:494` | keyed on `creatorId`, which is null | **(d)** | |
| `fatiguePenalty` | — | keyed on creator | **(d)** | |
| `underexposureBoost` | — | flag `UNDEREXPOSED_CONTENT_BOOST_ENABLED` | **(d)** | Keyed on item; gated on a flag. |

---

## What this means for the roadmap

### D5=B mostly buys CONSISTENCY, not personalisation

On today's code, running the ranker for every user instead of one per city per
two hours changes what a user receives **only through**:

- **distance** — but distance is already applied on the cache path via
  `sortBy=nearest`, and Cache A's stored order is raw Overpass order;
- **verified / kind** — db places surfacing above OSM places;
- **interest-tag match** — the one genuinely per-user effect, and **only for
  users who have set interests in `compass_user_preferences`**.

For a user with no interests recorded, **PDE and legacy produce orders that
differ only by item-intrinsic terms — the same order for every such user.** That
is still a real improvement over raw Overpass order, but it is *consistency and
quality*, not personalisation.

**This does not weaken the case for D5=B**, and it changes what should be
claimed for it. The defect is real and the fix is right. What it must not be
sold as is a personalisation win, because for the majority of users today the
code cannot produce one.

### It also identifies where the gains actually are

The dead terms are not missing features — they are **built and unfed**.
`recency` (1.00), `actionability` (0.90), `categoryAffinity` (0.40),
`seenPenalty` (−0.60) and `trust` (0.30) are implemented, tested, and receive
nothing on this surface. That is ~3.2 of declared weight sitting behind absent
plumbing rather than behind absent code.

**So the honest sizing is: D5=B unlocks the ranker's REACH, and the ranker's
SIGNAL is currently thin. Both need work, and the signal work is mostly wiring
rather than invention.**

### Three cheap findings that fall out of this read

1. **The `user_follows` read is pure cost.** Issued on every ranked request
   (`lib/discoveryPde.ts:250-257`), consumed by two terms that are both
   structurally zero. Removing it is behaviour-preserving *by this analysis* —
   which is exactly why it should be done as its own change, with the analysis
   cited, rather than folded into something else.
2. **`impressionCount: Math.max(1, savedCount)` is a fabricated denominator**
   (`:357`). Any "engagement rate" computed from it is an artefact. It should
   either be a real impression count — which `rank_events` can now supply, since
   Stage 0 instruments every serve point — or be left null so the component
   scores nothing rather than scoring noise.
3. **`cityMatch` fires for every candidate** because the mapping assigns the
   viewer's city to all of them (`:314`). It is a constant, and a constant in a
   scoring function is a rounding artefact waiting to be mistaken for a signal.

### What must not be concluded from this

- **Not** that the ranker is broken. Every dead term is dead because *discovery*
  does not populate it; the same code ranks Pulse with those fields present.
- **Not** that shadow mode will show zero divergence. Divergence on serve points
  1–3 is against *no ranker at all* — raw Overpass order — so distance and
  verified alone will move items.
- **Not** that this measured anything. **It is a code read.** No traffic was
  observed, and the pre-launch corpus (17 posts, 0 places) means `savedCount`,
  interests and trust are all near-empty regardless of what the code would do
  with them. A signal classified **(a) live** here may still contribute nothing
  today for want of data.
