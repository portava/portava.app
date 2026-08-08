# Feed algorithm — signal availability audit

**The gating question: which signals in the owner's spec exist in the data
today, and which need new instrumentation.** Audit only; the spec is the
owner's and is not reinterpreted here.

Date: 2026-08-08.

---

## 0. Headline

The **ranking machinery already exists and is closer to the spec than
expected.** `lib/portavaRank.ts` is a real, documented, pure scoring core whose
stated design principle is almost verbatim the north-star metric:

> *"TikTok/Instagram optimize predicted WATCH TIME. Portava optimizes predicted
> REALIZED VALUE — the probability that a recommendation leads to something
> real in the physical world."*

**What is missing is not the algorithm. It is the outcome instrumentation that
would let the algorithm be fitted or evaluated.**

Of the eleven rungs in the success hierarchy, **one is emitted by the client.**
The accepted outcome vocabulary is `[tap, save, join, rsvp, attended]`; the
only `fireRankOutcome` call sites in the whole app send `'save'`, from
`SaveButton`, on the `'pulse'` surface. `tap`, `join`, `rsvp` and `attended`
are accepted by the API and **never sent**.

That is the gap. Everything else is detail.

---

## 1. Existing infrastructure

| Component | File | State |
|---|---|---|
| Scoring core | `lib/portavaRank.ts` | Real, pure, documented. v1 hand-tuned weights |
| Media feed ranking | `services/ranking/MediaFeedRankingService.ts` | Exists |
| Creator activity score | `services/ranking/CreatorActivityScoreService.ts` + scheduler | Exists |
| Creator cap / diversity | `services/ranking/CreatorCapEnforcer.ts` | Exists |
| Fatigue | `lib/rankingFatigueSweeper.ts`, `viewer_creator_fatigue` | Exists |
| Impression logging | `lib/rankLog.ts` → `rank_events` | Exists |
| Outcome upgrade | `POST /api/rank-events/outcome` | Exists, tested, barely called |
| Tunable weights | `routes/adminRankingConfig.ts` | Exists, admin-gated |
| Metrics | `routes/adminRankingMetrics.ts` | Exists |
| Compass | ~50 `compass_*` tables incl. `compass_intent_modes`, `compass_outcome_events`, `compass_served_recommendations` | Extensive |

`portavaRank` already implements diversity (`diversify`), exploration
(`injectExploration`), a seen-penalty, recency decay with a 36h half-life, an
actionability kernel keyed on `startsAt`, and availability fit. Its own header
lays out a v1→v2→v3 plan where **v2 = "weights fitted offline from the
impression→join→attended funnel"** — which is precisely what the missing
instrumentation blocks.

---

## 2. Portava Score — component-by-component

| Component | Weight | Data today | Verdict |
|---|---|---|---|
| **Intent Match** | 30% | Compass captures explicit intent: `compass_intent_modes`, `compass_user_preferences`, `compass_recent_context`, `compass_user_context_snapshots` | **Data exists, not wired into `portavaRank`.** `ViewerContext` has `interestTags` and `categoryAffinities` but no Compass intent field. Largest weight, weakest wiring |
| **Location/Trip Relevance** | 20% | `cityMatch`, `neighborhoodMatch`, `distance` kernels all implemented; `trips`, `trip_destinations`, `trip_members` exist | **Mostly present.** Trip-phase awareness missing (§4) |
| **Social Connection** | 15% | `followedIds`, `mutualIds`, `engagedAuthorIds` in `ViewerContext`; weights `followedAuthor` 0.5 / `mutualAuthor` 0.35 / `engagedAuthor` 0.3 | **Present** |
| **Content Quality** | 15% | `ranking.weights.quality` config exists; `watch_qualified_view`, `watch_completion`, `watch_rewatch` logged via `POST /api/media/analytics/batch` | **Present for video.** No quality signal for non-video posts |
| **Freshness** | 10% | `recencyScore()`, 36h half-life | **Present** |
| **Exploration** | 5% | `injectExploration()`, `ranking.weights.exploration`, `underexposure` weight | **Present** |
| **Trust/Safety** | 5% | `trust` + `verifiedBonus` weights; `trust-admin.ts`, trust reviews, `compass_safety_filter_logs` | **Present** |

**Net: six of seven components have usable signal. Intent Match — the largest
at 30% — has rich data in Compass that the ranking core cannot see.**

---

## 3. Success hierarchy — instrumentation status

Strongest to weakest, as specified.

| # | Outcome | Accepted by API? | Emitted by client? |
|---|---|---|---|
| 1 | joined plan | `join` ✅ | **NO** |
| 1 | attended | `attended` ✅ | **NO** |
| 1 | booked buddy | **NO** | **NO** |
| 2 | shared moment together | **NO** | **NO** |
| 3 | saved place/plan | `save` ✅ | **YES** — the only one |
| 4 | Telegraph conversation | **NO** | **NO** |
| 5 | followed traveller | **NO** | **NO** |
| 6 | shared post | **NO** | **NO** |
| 7 | stamped | **NO** | **NO** |
| 8 | commented | `comment_posted` as an *event_type*, not an outcome | partial |
| 9 | profile opened | **NO** | **NO** |
| 9 | place opened | `place_view` event_type ✅ | **YES** — `app/place/[id].tsx` |
| 10 | dwell time | `watch_qualified_view` / `completion` / `rewatch` ✅ | **YES** — `useMediaAnalytics` |
| 11 | raw impression | `impression` ✅ | **YES** — server-side via `rankLog` |

**Read that table against the key principle.** The spec says a 45-second
passive watch must rank *below* a 6-second view that ends in joining a meetup.
Today the system **records the 45-second watch in three ways** (qualified view,
completion, rewatch) and **cannot record the meetup join at all**. The
instrumentation is currently biased toward exactly the metric the spec
rejects — not by design, but by which call sites got wired.

This is the single highest-leverage fix in the whole feed workstream, and it
needs no schema change: `join`, `rsvp` and `attended` are already valid values
on an endpoint that already exists and already has tests.

---

## 4. Travel states

Spec: Home / Planning / Arriving Soon / Currently Traveling / Leaving Soon /
Post-Trip, each getting a different feed.

**No such state field exists.** There is no `travel_state`, `trip_phase` or
equivalent column anywhere in `database.types.ts`.

The *ingredients* exist and are rich — `trips`, `trip_destinations`,
`trip_members`, `trip_availability`, `trip_readiness_snapshots`,
`compass_user_context_snapshots`, plus the user's current city. The six states
are **derivable** from trip start/end dates against `now` and the viewer's
location, and would not need new user input.

But nothing derives them, and `ViewerContext` has no field to carry one. This
is new work — a derivation function plus a `ViewerContext.travelState` field —
rather than new data capture.

---

## 5. Penalties

| Penalty | Data today |
|---|---|
| Reports | ✅ `reports` table, well shaped |
| Blocks | ✅ `blocks` table with `is_blocked()` helper |
| Repetition / already-seen | ✅ `seenPenalty` weight, `seenIds`, `viewer_creator_fatigue` |
| Repeatedly showing ignored content | ⚠️ Partial — fatigue tracks *impressions per creator*, not *ignored-after-impression* |
| Spam | ⚠️ `compass_abuse_flags`, `gaming-flags` admin screen exist; no feed-level spam score |
| Self-promotion | **NO** signal |
| Misleading location tags | ⚠️ `place-mismatch-reports` admin screen + `impossible_speed` event exist; not fed into ranking |
| Engagement bait | **NO** signal |

Reports and blocks are the two that exist cleanly and are the two most
defensible to wire first.

---

## 6. Three layers

- **Candidate generation** — exists per surface (`CompassFeedBuilder`,
  `discovery.ts`, `pulse.ts`, `events.ts`, `mediaFeed.ts`). No unified
  candidate pool; each surface assembles its own and hands it to `portavaRank`.
  `portavaRank`'s header says this is deliberate: *"callers assemble a
  ViewerContext and Candidates from whatever data their surface already
  loads"*.
- **Personalised ranking** — exists (`scoreCandidate` + `DEFAULT_WEIGHTS`),
  hand-tuned, not fitted, because the funnel it would be fitted on is not
  logged.
- **Feed composition** — partially exists. `diversify()` and
  `CreatorCapEnforcer` prevent 15 posts from one creator. The specified
  *type* rotation (traveller → place → shared moment → postcard → plan →
  recommendation) is **not implemented**; `kindPrior` biases kinds but does not
  interleave them.

---

## 7. The gap, stated plainly

**Needs new instrumentation (client call sites, no schema change):**
1. `join`, `rsvp`, `attended` outcomes — accepted by the API today, never sent.
   **Do this first.**
2. `tap` outcome — accepted, never sent.

**Needs new outcome vocabulary (enum + client, no new tables):**
3. booked buddy, shared moment, Telegraph conversation started, followed
   traveller, shared post, stamped, profile opened. Extending
   `OUTCOME_VALUES` is a one-line change; the enum is currently a TS
   `as const`, so whether the DB constrains it needs checking before relying on it.

**Needs derivation, not capture:**
4. Travel state — derivable from existing trip and location data.

**Needs wiring of data that already exists:**
5. Compass intent → `ViewerContext` (30% of the score).
6. Reports and blocks → ranking penalties.

**Needs genuinely new signal design:**
7. Self-promotion detection, engagement-bait detection, feed-level spam score.
8. Quality signal for non-video posts.

---

## 8. Recommended order

1. **Emit `join`/`rsvp`/`attended`/`tap` from existing call sites.** Zero
   schema change, unblocks v2 weight fitting, and directly corrects the
   watch-time bias described in §3. Nothing else is worth doing first.
2. Wire Compass intent into `ViewerContext` — the largest weight, and the
   structural advantage over IG/TikTok the spec identifies.
3. Derive travel state and add it to `ViewerContext`.
4. Wire reports/blocks as penalties.
5. Extend the outcome vocabulary for the remaining rungs.
6. Only then revisit weights, with real funnel data.

## 9. Verification note

Every row above was read from the code. The instrumentation claims in
particular were checked at the **call site**, not at the endpoint — the
endpoint existing and being tested is exactly what makes "join is recorded"
look true when no client ever sends it. `POST /api/rank-events/outcome` has a
dedicated test file (`test/rankEventsOutcome.test.ts`) covering three
scenarios, and is called by nothing that sends `join`.

Not verified: whether the DB constrains `rank_events.outcome` to a fixed set,
or whether `OUTCOME_VALUES` is enforced only in TypeScript. That determines
whether extending the vocabulary is a one-line change or a migration.
