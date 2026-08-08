# Feed algorithm — signal availability audit

**The gating question: for every signal in the owner's spec, does the data
exist today, exist in an unusable form, or need entirely new instrumentation?**

Audit only. The spec is the owner's and is not reinterpreted here.

Date: 2026-08-08. Tree: `travel-buddy-standalone`, branch `bughunt-20260805`.
Schema read from `artifacts/api-server/src/lib/database.types.ts` (397 tables,
generated from live).

---

## 0. Headline — the answer is weeks, not months

Two findings decide this, and they point the same way.

**First: the ranking machinery already exists.** `lib/portavaRank.ts` is a real,
pure, documented scoring core whose stated design principle is almost verbatim
the north-star metric:

> *"TikTok/Instagram optimize predicted WATCH TIME. Portava optimizes predicted
> REALIZED VALUE — the probability that a recommendation leads to something
> real in the physical world."*

**Second, and this is the important one: the outcome data for almost the entire
success hierarchy already exists in dedicated tables, with timestamps.** Joins,
attendance, bookings, follows, shares, stamps, comments, saves and profile
opens are all persisted today. Ten of the eleven rungs have a real table behind
them.

What does *not* exist is the **link between a ranking decision and the outcome
it caused**. `rank_events` carries `session_id`; **no domain outcome table
does.** You can prove a user joined a meetup. You cannot prove which served
impression made them join.

> **The gap is attribution, not capture.** This is a join-and-backfill problem
> across tables that already hold the data — not a months-long instrumentation
> project. That is the answer to the gating question.

---

## 1. Existing infrastructure

| Component | File / table | State |
|---|---|---|
| Scoring core | `lib/portavaRank.ts` | Real, pure, documented. v1 hand-tuned weights |
| Media feed ranking | `services/ranking/MediaFeedRankingService.ts` | Exists |
| Creator activity score | `services/ranking/CreatorActivityScoreService.ts` | Exists |
| Creator cap / diversity | `services/ranking/CreatorCapEnforcer.ts` | Exists |
| Fatigue | `lib/rankingFatigueSweeper.ts`, `viewer_creator_fatigue` | Exists |
| Impression log | `lib/rankLog.ts` → `rank_events` | Exists |
| Outcome upgrade endpoint | `POST /api/rank-events/outcome` | Exists, tested |
| Tunable weights | `routes/adminRankingConfig.ts`, `ranking_config` | Exists, admin-gated |
| Compass | ~50 `compass_*` tables | Extensive |

`portavaRank` already implements diversity (`diversify`), exploration
(`injectExploration`), a seen-penalty, recency decay on a 36h half-life, an
actionability kernel keyed on `startsAt`, and availability fit. Its header lays
out a v1→v2→v3 plan where **v2 = "weights fitted offline from the
impression→join→attended funnel"** — precisely what the attribution gap blocks.

### 1a. `rank_events` — the funnel table, verified

`artifacts/api-server/src/migrations/0153_add_rank_events.sql:14`:

```sql
CREATE TABLE IF NOT EXISTS rank_events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, item_id text NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('post','event','plan','buddy','place','gem')),
  position smallint NOT NULL, features jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'impression'
    CHECK (outcome IN ('impression','tap','save','join','rsvp','attended')),
  served_at timestamptz NOT NULL DEFAULT now(), outcome_at timestamptz,
  surface text NOT NULL CHECK (surface IN ('pulse','discovery','events')),
  session_id uuid
);
```

**Two things this settles.**

1. **The outcome vocabulary is constrained in the database, not just in
   TypeScript.** `routes/rankEvents.ts:82` declares
   `OUTCOME_VALUES = ["tap","save","join","rsvp","attended"] as const`, but the
   `CHECK` above is the real gate. **Extending the vocabulary requires a
   migration, not a one-line change.** (An earlier draft of this audit listed
   this as unverified and guessed one-line. It is a migration.)
2. `session_id` exists here — and, per §3a, nowhere useful.

`surface` is `pulse|discovery|events`; migration 0154 widens it to add
`compass`.

> **Superseded by production evidence (§10).** The two paragraphs above quote
> the *migration files*. The **live** constraints are wider than either file:
> `outcome` also permits `analytics`, and `surface` permits eleven values. The
> structural claim — that the vocabulary is DB-constrained and extending it
> needs a migration — still holds. The specific value lists above do not.
> This document warned against trusting migration files over live schema and
> then did exactly that here; §10 has the live definitions.

---

## 2. Portava Score — component by component

| Component | Weight | Where the data lives | Verdict |
|---|---|---|---|
| **Intent Match** | 30% | `compass_intent_modes`, `compass_user_preferences`, `compass_recent_context`, `compass_user_context_snapshots` | **Exists, not usable by the ranker.** `ViewerContext` has `interestTags`/`categoryAffinities` but no Compass intent field. Largest weight, weakest wiring |
| **Location / Trip Relevance** | 20% | `trips.destination_lat/lng/destination_city`, `trip_destinations.lat/lng/arrival_date/departure_date`, `user_location_state.lat/lng/city` | **Exists and partly wired.** `cityMatch`/`neighborhoodMatch`/`distance` kernels implemented. Trip-*phase* awareness missing (§4) |
| **Social Connection** | 15% | `user_follows.follower_id/following_id`, `user_friendships`, `circle_memberships` | **Exists and wired.** `followedIds`/`mutualIds`/`engagedAuthorIds` in `ViewerContext` |
| **Content Quality** | 15% | `media_events` (`watch_qualified_view`, `watch_completion`, `watch_rewatch`), `creator_activity_scores` | **Exists for video only.** No quality signal for text/photo posts |
| **Freshness** | 10% | `posts.created_at` etc. | **Exists and wired.** `recencyScore()`, 36h half-life |
| **Exploration** | 5% | — | **Exists and wired.** `injectExploration()`, `underexposure` weight |
| **Trust / Safety** | 5% | `trust_profiles`, `user_trust_scores`, `trust_events`, `compass_safety_filter_logs` | **Exists and partly wired.** `trust` + `verifiedBonus` weights |

**Six of seven components have usable signal. Intent Match — the largest single
weight at 30% — has rich data in Compass that the ranking core cannot see.**
That is a wiring job against existing tables, not new capture.

---

## 3. Success hierarchy — the three-way question

For each rung: **does the data exist**, is it **captured but unusable**, or does
it need **new instrumentation**? Strongest to weakest, as specified.

| # | Outcome | Table + column that holds it today | Status |
|---|---|---|---|
| 1 | joined plan | `trip_members.joined_at`, `.status`; `trip_join_requests.status`; `event_rsvps.status`; `meetups` | **EXISTS** |
| 1 | attended | `event_attendee_states.checked_in_at`, `.confirmed_at`, `.no_show_at`; `plan_checkins.checked_in_at`; `plan_attendance_events.event_type` | **EXISTS** — real check-in, incl. no-show |
| 1 | booked buddy | `buddy_bookings.status`, `.confirmed_at`, `.started_at`, `.completed_at`, `.cancelled_at` | **EXISTS** — full lifecycle |
| 2 | shared moment together | `shared_moments`, `shared_moment_contributions.contributor_id`, `.approved_at` | **EXISTS** |
| 3 | saved place/plan | `post_saves`, `saved_places.saved_at`, `event_saves.saved_at`, `discovery_place_saves`, `trip_saved_places`, `wishlist_places` | **EXISTS** + is the one rung wired to `rank_events` |
| 4 | Telegraph conversation | `message_threads.created_at`, `.thread_type`; `telegraph_chat_suggestions.acted_on_at`, `.status` | **EXISTS** — `acted_on_at` is close to purpose-built |
| 5 | followed traveller | `user_follows.created_at` | **EXISTS** |
| 6 | shared post | `post_shares.created_at`, `.target` | **EXISTS** — `target` even gives the destination |
| 7 | stamped | `user_stamps.earned_at`, `.source_type`, `.source_id`; `stamp_award_events` | **EXISTS** — and `source_type`/`source_id` is a content link |
| 8 | commented | `posts_comments.created_at`, `.post_id` | **EXISTS** |
| 9 | profile opened | `profile_views.viewer_id`, `.target_id`, `.viewed_at` | **EXISTS** |
| 9 | place opened | `user_recent_places`, `place_days`; `place_view` event | **EXISTS** |
| 10 | dwell time | `media_events.event_type`, `.payload`, `.occurred_at` | **EXISTS** |
| 11 | raw impression | `rank_events`, `post_impressions` | **EXISTS** |

**Every rung has a table. None needs new capture.** This is the single most
important correction to make against the assumption that the feed is blocked on
instrumentation.

### 3a. What is actually missing: attribution

Grepping every table in the schema for `session_id` returns **ten tables**:

```
layover_events, layover_plan_stops, layover_recommendations,
media_ranking_snapshots, rank_events, ranking_debug_samples,
rent_buddy_search_events, safe_return_contacts, safe_return_events,
safe_return_live_shares
```

Of those, only `rank_events`, `ranking_debug_samples` and
`media_ranking_snapshots` are ranking-related, and all three are the *serving*
side. **Not one outcome table — not `trip_members`, not
`event_attendee_states`, not `buddy_bookings`, not `user_follows` — carries a
`session_id` or any reference back to `rank_events`.**

So the funnel query the ranker needs ("of the impressions served in session X,
which led to a join within 24h?") cannot be written today. The join has no key.

Three ways to close it, in rising order of cost:

1. **Emit outcomes at existing call sites.** `join`, `rsvp`, `attended` and
   `tap` are already valid `CHECK` values on an endpoint that already exists
   and already has tests (`test/rankEventsOutcome.test.ts`). Calling
   `fireRankOutcome` from the join/RSVP/check-in paths needs **no migration**.
   This is the cheapest and should come first.
2. **Add `session_id` (nullable) to the outcome tables** for durable
   attribution that survives a missed client call. One migration per table.
3. **Time-window heuristic attribution** — join `rank_events` to outcomes on
   `(user_id, item_id)` within a window. No schema change at all, works
   retroactively on data already collected, and is imprecise. Worth doing
   immediately as a measurement stopgap regardless of 1 and 2.

### 3b. The watch-time bias, and a fork divergence that matters

The spec's key principle: 45s of passive watching must rank **below** a 6s view
ending in a meetup join.

Today the system records the 45-second watch three ways (`watch_qualified_view`,
`watch_completion`, `watch_rewatch` in `media_events`) and **cannot attribute
the meetup join to the impression at all.** The instrumentation is currently
biased toward exactly the metric the spec rejects — not by design, but by which
call sites got wired.

**`fireRankOutcome` call sites differ between the two app trees, and this is
test-pinned, not accidental:**

| Outcome | `artifacts/travel-buddy` | `travel-buddy-standalone` (this tree) |
|---|---|---|
| `save` | ✅ `SaveButton.tsx:120,165` | ✅ `SaveButton.tsx:120,165` |
| `tap` | ✅ `app/(tabs)/index.tsx:665` | ❌ **not wired** |

The standalone test file states it outright:

> *"DIVERGENT FORK: the standalone index.tsx does NOT wire fireRankOutcome or an
> onTouchStart tap handler onto the per-item wrapper (that is a mobile-only
> feature)... These tests pin the standalone tree's ACTUAL behavior so a future
> refactor can't silently change it."*

So **on this tree exactly one outcome (`save`) is emitted**; on the mobile tree
two are. Any funnel measured on standalone data will be missing taps entirely.
Whoever fits v2 weights needs to know which tree produced the data.

---

## 4. Travel states — derivable, not new tracking

Spec: Home / Planning / Arriving Soon / Currently Traveling / Leaving Soon /
Post-Trip, each getting a different feed.

**No state column exists.** There is no `travel_state` or `trip_phase` anywhere
in the 397 tables.

**But all six are derivable from data already present, with no new user input:**

| Input | Column |
|---|---|
| Trip window | `trips.start_date`, `trips.end_date` |
| Trip lifecycle | `trips.status` (enum `trip_status`), `trips.progress` |
| Per-city window | `trip_destinations.arrival_date`, `.departure_date`, `.city`, `.lat/lng` |
| Membership | `trip_members.status`, `.joined_at` |
| Where the user actually is | `user_location_state.city`, `.country`, `.lat/lng`, `.last_known_at` |

A derivation sketch — dates against `now`, cross-checked with actual location:

- **Home** — no trip with `status` active/upcoming, user in home city
- **Planning** — trip exists, `start_date` more than ~7 days out
- **Arriving Soon** — `start_date` within ~7 days, or user not yet at destination
- **Currently Traveling** — `now` between `start_date` and `end_date` **and**
  `user_location_state.city` matches a `trip_destinations.city`
- **Leaving Soon** — `end_date` (or `departure_date`) within ~48h
- **Post-Trip** — `now` past `end_date`

Cross-checking dates against `user_location_state` matters: a trip whose dates
say "traveling" while the user is still in their home city is a delayed
departure, and the date-only rule would give them the wrong feed.

**Verdict: new derivation logic plus a `ViewerContext.travelState` field.
No new data capture, no new user input.** The thresholds above are
placeholders — the boundaries are a product decision (see §8).

---

## 5. Penalties

| Penalty | Data today | Status |
|---|---|---|
| Reports | `reports`, `moderation_reports`, `report_evidence` | **EXISTS**, well shaped |
| Blocks | `blocks` + `is_blocked()` helper | **EXISTS** |
| Repetition / already-seen | `seenPenalty` weight, `viewer_creator_fatigue`, `user_suggestion_seen` | **EXISTS** |
| Repeatedly showing ignored content | `viewer_creator_fatigue` tracks impressions *per creator*, not ignored-after-impression | **Partial** — needs the §3a attribution to compute |
| Spam | `compass_abuse_flags`, gaming-flags admin screen | **Partial** — no feed-level spam score |
| Misleading location tags | `place_mismatch_reports`, `location_trust_events`, `impossible_speed` event | **Captured, not fed into ranking** |
| Self-promotion | — | **NEW SIGNAL NEEDED** |
| Engagement bait | — | **NEW SIGNAL NEEDED** |

Reports and blocks exist cleanly and are the two most defensible to wire first.

---

## 6. Three layers

- **Candidate generation** — exists per surface (`CompassFeedBuilder`,
  `discovery.ts`, `pulse.ts`, `events.ts`, `mediaFeed.ts`). No unified candidate
  pool; `portavaRank`'s header says this is deliberate: *"callers assemble a
  ViewerContext and Candidates from whatever data their surface already loads."*
- **Personalised ranking** — exists (`scoreCandidate` + `DEFAULT_WEIGHTS`),
  hand-tuned, not fitted, because the funnel it would be fitted on cannot be
  joined (§3a).
- **Feed composition** — partial. `diversify()` and `CreatorCapEnforcer` prevent
  one creator dominating. The specified **type rotation** (traveller → place →
  shared moment → postcard → plan → recommendation) is **not implemented**;
  `kindPrior` biases kinds but does not interleave them.

---

## 7. The gap, stated plainly

**Needs nothing but new call sites (no migration):**
1. Emit `join`, `rsvp`, `attended`, `tap` from the paths that already write
   `trip_members`, `event_rsvps`, `event_attendee_states`, `plan_checkins`.
   **Do this first.**

**Needs wiring of data that already exists (no migration):**
2. Compass intent → `ViewerContext` — 30% of the score.
3. Reports/blocks → ranking penalties.
4. Travel-state derivation → `ViewerContext.travelState` (§4).
5. Retroactive time-window attribution as a measurement stopgap (§3a item 3).

**Needs a migration:**
6. Extending the outcome vocabulary beyond
   `impression|tap|save|join|rsvp|attended` — the `CHECK` constraint is in the
   database (§1a). Covers: booked buddy, shared moment, Telegraph conversation,
   followed traveller, shared post, stamped, profile opened.
7. `session_id` on outcome tables for durable attribution (§3a item 2).
8. `surface` widening if feeds beyond `pulse|discovery|events|compass` are ranked.

**Needs genuinely new signal design:**
9. Self-promotion and engagement-bait detection; feed-level spam score.
10. Quality signal for non-video posts (§2).

**Needs implementation, data already sufficient:**
11. Feed-composition type rotation (§6).

---

## 8. Decisions needed

Recorded rather than blocked on, per instruction.

1. **Travel-state boundaries.** How many days out is "Planning" vs "Arriving
   Soon"? Is "Leaving Soon" 24h or 48h? §4 uses placeholders.
2. **Which tree is canonical for funnel data** — standalone emits `save` only,
   mobile emits `save` + `tap` (§3b). Fitting on mixed data will mislead.
3. **Attribution strategy** — client-emitted outcomes (cheap, lossy) vs
   `session_id` on outcome tables (durable, one migration per table) vs
   time-window heuristic (free, imprecise). These are not exclusive.
4. **Attribution window** — how long after an impression may a join still be
   credited to it? A meetup joined a week later is a real outcome but a weak
   attribution.
5. **Does `no_show_at` count against the score?** `event_attendee_states`
   records no-shows. An RSVP that becomes a no-show arguably ranks *below* a
   save, which the hierarchy does not currently address.

---

## 9. Verification note

Every claim above was read from the schema or the code, not inferred from a
grep hit.

- Table and column names come from `database.types.ts` (397 tables, generated
  from live), not from migration files — migration files record intent, and at
  least one migration in this repo was written but never applied live (see
  `docs/design/tagging-directions.md` §1a for a case where that matters).
- The `rank_events.outcome` `CHECK` was read from migration 0153 directly. An
  earlier draft of this audit recorded it as unverified and guessed that
  extending the vocabulary was a one-line TypeScript change. **It is a
  migration.**
- The instrumentation claims were checked **at the call site**, not the
  endpoint. `POST /api/rank-events/outcome` has a dedicated test file covering
  three scenarios and is called by nothing that sends `join` — endpoint tests
  passing is exactly what makes "join is recorded" look true when no client
  sends it.
- The fork divergence in §3b was confirmed by reading both `index.tsx` files
  and the standalone test that pins the absence.

**Not verified — cannot be without running code this session may not change:**
whether the `rank_events` rows in production actually carry a non-null
`session_id` in practice, and what proportion of impressions ever receive an
outcome upgrade. Both need a query against live data. They determine whether
the time-window attribution stopgap (§3a item 3) has enough signal to be worth
running before the call sites are wired.

---

## 10. Production evidence (2026-08-08)

Read-only queries via the Supabase Management API, resolving the items §9 left
unverified. **No writes, no schema changes.**

### 10a. Corpus caveat — read everything below through this

| Measure | Value |
|---|---|
| `profiles` | 56 |
| Distinct users in `rank_events` | **5** |
| Distinct posting users | 24 |
| `trips` | 43 |
| `posts` | 138 |

**This is a dev/QA corpus, not production traffic.** Five users generated
195,612 rank events. Ratios below are real, but they describe how the *system*
behaves, not how *users* behave. Do not fit weights on this data.

### 10b. `session_id` is populated — attribution's missing half is the other side

| Measure | Value |
|---|---|
| `rank_events` rows | 195,612 |
| Non-null `session_id` | 183,577 (**93.8%**) |
| Range | 2026-07-20 → 2026-08-08 |

**§3a's concern is half-resolved.** `session_id` is reliably written on the
serving side. The gap is entirely on the outcome side: no domain outcome table
records it, so there is still nothing to join *to*.

### 10c. The funnel is empirically dead

| `outcome` | Rows |
|---|---|
| `analytics` | 140,331 |
| `impression` | 55,265 |
| `tap` | 15 |
| `save` | 1 |
| `join` / `rsvp` / `attended` | **0** |

**Outcome upgrade rate: 16 of 55,281 impression-family rows ever received an
`outcome_at` — 0.03%.**

This is §3b's watch-time bias, measured. `join`, `rsvp` and `attended` are
valid values that have never once been written. The 15 `tap` rows are
consistent with §3b's fork finding: `tap` is wired only in
`artifacts/travel-buddy`, not in this tree.

Surfaces actually serving: `pulse` 177,906 · `compass` 12,506 · `events` 5,200.

### 10d. Live CHECK constraints — wider than every migration file

```
rank_events_outcome_check:
  outcome IN ('impression','tap','save','join','rsvp','attended','analytics')

rank_events_surface_check:
  surface IN ('pulse','discovery','events','compass','search','nearby',
              'story','event','trip','profile','explore')
```

Migration 0153 defines six outcome values and three surfaces; 0154 adds
`compass`. **Live has seven and eleven.** Something widened both outside the
migration files this audit read — most likely 0197
(`rank_events_analytics_columns`), unverified.

Consequences for §7:
- Item 6 (extend outcome vocabulary) — still a migration, but the baseline is
  seven values, not six.
- Item 8 (widen `surface`) — **already done live.** Eight surfaces beyond the
  original three are permitted today.

### 10e. Outcome-table row counts

| Table | Rows |
|---|---|
| `post_saves` | 134 |
| `posts_comments` | 118 |
| `user_follows` | 62 |
| `user_stamps` | 45 |
| `trip_members` | 42 |
| `event_rsvps` | 25 |
| `profile_views` | 10 |
| `post_shares` | 3 |
| `buddy_bookings` | **0** |
| `event_attendee_states` | **0** |
| `shared_moments` | **0** |

§3 said every rung has a table. True — but three of the strongest rungs
(booked buddy, attended, shared moment) have **no rows at all**. The tables are
ready; the behaviours have not happened yet in this corpus. Weight-fitting on
the top of the hierarchy is blocked by absence of events, not only by absence
of attribution.

### 10f. Decision-ready — not acted on

1. **Live schema has drifted from the migration files for `rank_events`, in the
   same way it did for `tags` (finding 16).** Two CHECK constraints differ.
   Nobody has recorded which change widened them or when. This is migration
   ownership and is explicitly out of scope here — flagged, not touched.
2. **Do not fit v2 weights on this corpus** (§10a). It needs real traffic.
