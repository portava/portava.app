# Creator Economy — current state, and the design that fits it

*Derived from the repository, 2026-09-07. File paths are relative to `artifacts/api-server/src/`
unless the path starts with `docs/`, `supabase/` or `artifacts/`. Current-state claims cite a file
and a line; anything not cited is design, and is labelled as such. Defers to
`docs/discovery/ROADMAP.md` for what may be enabled, and to `00_STATUS.md` for the discovery
defect ledger.*

**The stub this replaces read "Traveler Impact and rewards." Both halves need correcting before
anything can be built from them.** "Traveler Impact" is **not a name in the codebase** — a
whole-tree grep for `Traveler Impact` / `traveler_impact` / `travelerImpact` matches nothing but
that stub line. And "rewards" is not one thing: the tree contains **four separate standings**,
built by different units against different tables, with different reversibility and different
audiences. Treating them as one number is the first mistake available here, so this document
names them apart first and only then says what Impact should mean.

## 0. The four standings that already exist

| Standing | Where it lives | What it measures | Reversible? | Reaches a user today? |
|---|---|---|---|---|
| **CreatorActivityScore** 0–100 | `creator_activity_scores` (`artifacts/api-server/supabase/migrations/20260801_ranking_discovery_foundation.sql:10-47`) | recency-weighted publishing + participation + received response, minus spam | recomputed every pass; can fall | **No** — flag OFF, see §1.2 |
| **Trust** 0–100 + six public levels | `trust_profiles` (`services/trust/TrustScoreService.ts:276-291`) | safety and reliability of a *person* across nine categories | decays; caps clamp | label only; number only to self (`PassportProjectionService.ts:1007-1021`) |
| **Contribution reputation** L1–L5 | derived on read from `passport_contribution_events` (`services/passport/PassportReputationService.ts:134-160`) | qualified real-world contribution volume, paid excluded | derived, never stored | **Yes** — the Passport ContributionCard |
| **Earned credits** (non-cash) | `intel_reward_ledger` (`migrations/2170_intel_reward_ledger.sql:34-56`) | QIU booked against finalized, attributed outcomes | **append-only, immutable** | **No** — `intel_rewards` seeded OFF (`2170:59-65`) |

Plus two **grants**, which are not standings at all and are covered in §3: `portava_featured`
and `profiles.is_official`.

## 1. What Traveler Impact actually measures

### 1.1 The one creator-scoring surface that exists

`services/ranking/CreatorActivityScoreService.ts`. Five components, weights summing to 1.0
(`:121-127`), each normalised 0–100 and passed through a saturating transform
`maxPoints × (1 − e^(−raw/softCap))` (`:237-240`) so **100 events can never equal 100 × one
event**. Windowed counts are decayed at a 14-day half-life (`:159`, `:248-250`).

| Component | Weight | First-class source (verified writers) | Citation |
|---|---|---|---|
| `recentContribution` | 0.30 | `posts` (`status='active' AND post_status='published'`), `events`, `trips`, `reviews`, `discovery_places` | `:508-628`, predicate at `:539-540` |
| `consistency` | 0.20 | distinct active **days**, unioned across 13 tables — authored *and* actions on others' content | `:630-694` |
| `communityParticipation` | 0.20 | `posts_comments` + `event_rsvps`, resolved to the **owner** so the distinct-user half is real | `:777-845` |
| `positiveResponse` | 0.20 | received `post_saves`, `post_shares`, `posts_comments`, `user_follows`, `content_stamps` | `:906-956` |
| `maintenance` | 0.10 | `post_edits` only | `:982-1006` |

Penalties are subtracted after weighting and clamped: spam ≤ 25, repetition ≤ 15 (`:162-163`,
`:322-333`, `:370`). Then a **safety multiplier** from `trust_profiles` multiplies the whole
result (`:374`), and a `NEW_USER_BASE_SCORE = 10` floor applies only to an account with literally
no history and a non-zero multiplier (`:169`, `:377-386`).

**This lane was dead until 2026-09-06 and the rewrite is why it is citable at all.** Commit
`d7398bd` (#440) moved every component off `public.activity_events`, a table with exactly one
writer — an internal-secret-gated route nothing called — so 0.70 of the weight and both penalties
were structurally zero and a real score was the floor of 10 (`:41-58`). The scheduler had the
same shape twice and **no creator was ever scored a first time** (`lib/creatorActivityScoreScheduler.ts:20-42`).
`ACTIVITY_SCORE_VERSION` was bumped 1.0 → 2.0 precisely to force recalculation rather than let
those values persist (`:109-113`). A static guard now exists for the whole class:
`check:writerless-reads` (`scripts/checkWriterlessReads.ts:1-45`).

Two honest caveats the rewrite recorded rather than hid, and both constrain the design below:

- **`positiveResponse` is a COUNT, not a rate.** The old denominator was reach; no first-class
  source for reach exists (`post_impressions` has no writer either), and every substitute was
  worse — `profile_views` saturates every creator, and being privacy-gated it would have coupled
  *restrictive privacy settings to a higher rank* (`:860-886`).
- **Several sources are mutable state, not a log.** `post_saves`, `content_stamps`,
  `user_follows` and `event_rsvps` rows are DELETEd on unsave/unstamp/unfollow/cancel, and
  `user_follows` in both directions on a block. A creator's score can fall because somebody else
  undid their engagement, and past active days can shrink retroactively. Signal is only lost,
  never invented — but **the score is not reproducible from an audit trail** (`:91-98`).

### 1.2 Current state: nothing is scored, and that is a flag, not a defect

`ACTIVITY_DISCOVERY_BOOST_ENABLED` is seeded `false` in both migrations that create it
(`artifacts/api-server/supabase/migrations/20260801_ranking_discovery_foundation.sql:276`,
`migrations/2084_codify_live_read_flags.sql:55`) and **no migration in the tree flips it**. The
scheduler reads that same flag and returns a no-op when it is off
(`lib/creatorActivityScoreScheduler.ts:96-140`), and `creator_activity_scores` has exactly one
writer — that job (`CreatorActivityScoreService.ts:1152-1181`). So the table is empty, the batch
load returns an empty map (`services/ranking/DiscoveryRankingService.ts:277-297`), `activityBoost`
is zeroed by shadow mode anyway (`:922-925`) and shadow mode returns the caller's **input order
unchanged** (`:1029-1034`).

**Say the consequence plainly, because it is the invariant this repo keeps re-learning: an empty
`creator_activity_scores` is what a working system and a broken one both look like from the
outside.** The distinguishing fact is the flag, not the row count.

### 1.3 DESIGN — what Traveler Impact should be

**D1. Traveler Impact is the product name for the persisted CreatorActivityScore components. It
is not a new score and must not become a sixth table.** The components are already persisted
column-by-column (`:1160-1174`), which is what makes an explanation possible; a single opaque
0–100 is not explainable and a second scorer would immediately disagree with the first.

**D2. "Impact" means *a traveller did something in the real world because of this contribution*,
and that measurement is BLOCKED on Event Truth.** Nothing in `CreatorActivityScore` measures a
downstream traveller outcome: its strongest signal is *received engagement*, which is a
proxy for attention, not for impact. The only place in the tree where a contribution is tied to a
traveller's real outcome is the intel attribution lane (§3, rung 3), and it covers `intel_*`
observations only. Generalising it needs the append-only decision store — ROADMAP **step 2**,
**NOT STARTED, gated, no migrations, no tables** (`ROADMAP.md:944`; `04_Behavior_Engine.md`).
**Until Event Truth exists, Traveler Impact can honestly be called a contribution-and-care score,
and must not be called an impact measurement in any user-facing string.**

**D3. Impact must degrade to *absent*, not to *zero*.** A creator with no row is not a creator
with no impact. `DiscoveryRankingService` currently defaults a missing row to `score: 0`
(`:898-900`) while the scheduler deliberately writes a floor-10 row for every profile *because*
those two produce different downstream boosts (`lib/creatorActivityScoreScheduler.ts:178-184`).
That asymmetry is a live trap: any future consumer must branch on **row present / row absent**,
never on `score === 0`.

## 2. Why Impact must NOT be a popularity metric

This is not a preference; it is an invariant already enforced by tests on a neighbouring surface.

**Compass ships a dual score, and the two halves are forbidden to share inputs.** Compass Match
(personal fit) is built from `MATCH_WEIGHTS` — interest, city, language, social, safety, budget,
distance, openNow, history, memory, availability, time — and contains **no popularity term at
all** (`compass/CompassRecommendationEngine.ts:101-114`). Community Score is the popularity half:
quality 45, saved-count 25, attendance 15, `authorTrustScore` 15, minus reports and spam
(`:69-91`). `.agents/memory/compass-dual-score-ranking.md` records the rule and notes that tests
assert independence **in both directions** — adding a shared signal to either breaks them.

Three consequences follow, and they are the whole of the ranking design in this document:

1. **Creator standing is a property of the author, not of the viewer. It can therefore only ever
   enter the Community Score half.** Community Score already carries exactly one author-standing
   input — `authorTrustScore` at weight 15 — which is the precedent to follow, not to duplicate.
2. **Volume must never buy rank.** The saturating transform (`CreatorActivityScoreService.ts:237-240`)
   and the soft caps (`:151-156`) are the mechanism; they are code constants, not config values,
   and must stay that way. The same principle is enforced independently on the trust side, where
   a category is the **mean** of decayed deltas so "a thousand small positives land in the same
   place as one" (`services/trust/TrustScoreService.ts:162-215`).
3. **Received engagement is scored as an unnormalised count today**, which — stated as the
   rewrite states it — means large accounts are no longer normalised down
   (`CreatorActivityScoreService.ts:304-316`). That is a popularity coupling. It is tolerable
   only while the boost is OFF; it is a **prerequisite to fix, not a detail**, before any enable.

**Nothing here proposes a ranking change.** The ranker is on explicit owner **HOLD**
(`ROADMAP.md:222`, `:648`), the step-7/8 modifiers ship behind `discovery_ranking_modifiers_enabled`
seeded OFF with a migration postcondition that RAISEs if it is ever seeded on
(`migrations/2289_discovery_ranking_modifiers_flag.sql:70-74`), and Phase F is **FROZEN + NOT
AGENT WORK** (`ROADMAP.md:534`). This document proposes no new weight, no new feature and no
flag flip.

## 3. The reward ladder — earned versus granted

The distinction that matters operationally is **who writes the row**.

| Rung | Artifact | Earned or granted | Written by | Reversible | Gate |
|---|---|---|---|---|---|
| 0 | Contribution level L1–L5 | **earned, derived on read** | nobody — computed from `passport_contribution_events` | recomputes | `passport_contribution_events_enabled`, seeded **TRUE** (`2084:60`) |
| 1 | CreatorActivityScore | **earned, recomputed** | the scheduler only | falls freely | `ACTIVITY_DISCOVERY_BOOST_ENABLED`, **OFF** |
| 2 | Passport stamp (`user_stamps`) | **earned, minted** | `StampAwardEngine.awardStamp`, server-side only, idempotent on `(user, def, source_type, source_id)` (`services/passport/StampAwardEngine.ts:1-11`, `:246-250`) | revoke/restore, each requiring a successful audit write (`:8`, `:694`, `:774`) | per-definition criteria |
| 3 | Non-cash credits (`intel_reward_ledger`) | **earned, booked** | `RewardService.recordEarnedReward` via `lib/intelRewardScheduler` | **never** — INSERT+SELECT grant only (`2170:55-56`) | `intel_rewards`, **OFF** (`2170:59-65`) |
| — | Featured by Portava | **granted** | an admin, plus the creator's own permission for video (`routes/adminFeatured.ts:12-19`, `:303-325`) | revoke decrements the count (`:551-565`) | admin role |
| — | `profiles.is_official` | **granted** | privileged writers only; a BEFORE trigger rejects non-privileged writes in both directions (`migrations/2079_is_official_privileged_both_directions.sql:123`, `:168`) | admin | none on the grant; the boost it triggers is gated by `PORTAVA_PUBLISHER_BOOST_ENABLED` (`services/ranking/MediaFeedRankingService.ts:895`) |

### What "earned" is required to mean here

Rung 3 is the strictest thing in the tree and is the model the rest should be held to. A credit
is booked only when **every** gate passes, and the gate enumerates exactly why it refused
(`lib/rewardEligibility.ts:35-43`): outcome finalized, commercial-use permission, funding source,
ledger version, no fraud hold. The eligibility context is **derived from real DB state by an
oracle**, never taken from caller booleans (`services/intel/RewardOracle.ts:1-17`), and with
`intel_outcome_attribution_enabled` on, "served" is not enough — the contribution must carry a
non-contradicting, graded attribution row, i.e. **a traveller went and reported an outcome that
did not contradict the claim** (`RewardOracle.ts:52-70`). Amounts are QIU-derived, never a flat
per-post rate, so "gaming volume without impact earns nothing"
(`lib/rewardEarnings.ts:1-12`, `lib/qiuShadow.ts:34-48`).

**Cash is a boundary, not a milestone.** `cash_amount` is `0` by CHECK
(`2170:40`), the eligibility module says so in prose (`rewardEligibility.ts:10-13`), and the
migration records why: a money transfer is a separate switch behind payments/KYC/tax/fraud
infrastructure **that does not exist** (`2170:12-15`). **DESIGN: the stub's word "rewards" must
never be written in a user-facing string in a way that implies money.** No redemption path, no
balance UI and no cash pool exist; do not describe one.

### DESIGN — the rules that keep the ladder honest

- **D4. A granted artifact must never feed an earned score.** Verified true today:
  `portava_featured`, `profiles.featured_count` and `profiles.is_official` appear nowhere in
  `CreatorActivityScoreService` (grep), and `MediaFeedRankingService.loadCreatorSignals` reads
  `profiles.is_official` **only** — it does not touch `creator_activity_scores`
  (`services/ranking/MediaFeedRankingService.ts:1066-1090`). If a grant fed the score, an admin
  decision would silently become evidence.
- **D5. A grant that affects another person's content requires that person's consent.** Already
  the shape of the featured flow for video by a non-@Portava author: status
  `pending_permission` until the creator accepts (`routes/adminFeatured.ts:303-325`,
  `:419-422`). Extend that rule to any future creator-facing grant; do not special-case it.
- **D6. Revocation must be as auditable as award.** `StampAwardEngine` already fails the
  revoke if the audit write fails (`StampAwardEngine.ts:7-8`). `featured_count`, by contrast, is
  maintained by a **read-modify-write increment** (`routes/adminFeatured.ts:333-342`,
  `:444-449`, `:561-565`) — the pattern `.agents/memory/counter-update-atomicity.md` records as
  rejected in completion review, requiring a SECURITY DEFINER RPC with `GREATEST(0, col + delta)`.
  **Named as a known defect; not fixed here** (this task writes no code).

## 4. Anti-gaming and Sybil resistance

### What is actually built

| Defence | Where |
|---|---|
| Self-actions excluded from every received-signal query | `CreatorActivityScoreService.ts:430-433`, `:826-836`, `:902` |
| Blocked accounts (both directions) excluded from participation and response | `:483-500`, `:831-835`, `:948` |
| Diminishing returns on every component | `:237-240` with soft caps `:151-156` |
| Burst posting (>10 posts in any 60 s), rapid same-type (<5 min apart), duplicate bodies | `:1042-1064` |
| Double-count defence: `content_stamps` is polymorphic and one user can hold two rows for one post — deduped on `(user_id, entity_id)` | `:925-955` |
| Every `.in()` chunked at 100 — an unbounded list is a 414 that supabase-js *returns*, reading identically to "nobody engaged", **monotonically worse the more a creator posts** | `:129-149`, `:731-742` |
| Trust veto collapses the score at `overall_score < 20` | `:1135` |
| Ring / cluster / rapid-jump detection that **never auto-penalises** — it files a `trust_reviews` row of type `gaming_suspected` | `services/trust/TrustGamingDetectionService.ts:1-11`, `:68-80` |
| Per-creator frequency caps on assembled feeds (max 2 consecutive, 3 per page) | `services/ranking/CreatorCapEnforcer.ts:1-30` |
| Admin concentration alarm — `creator_concentration` top-1/5/10 % with an `alert` boolean | `routes/adminRankingMetrics.ts:52` |

### What is NOT built, stated as absence

- **There is no Sybil resistance in the creator-economy lane at all.** No account-linkage, device,
  payment-instrument or graph-clustering signal is read anywhere in `CreatorActivityScoreService`
  (grep). The only ring detection in the tree is `TrustGamingDetectionService`, it is behind
  `trust_gaming_detection_enabled` (`:55-66`), and it opens a review rather than acting.
- **Follow-cycling and event create/delete cycles report 0 and are not representable.**
  `user_follows` is current state, hard-deleted on unfollow, so a cycle leaves no trace at all;
  events are soft-deleted by state and nothing records a create→delete pair (`:1013-1024`). Both
  are declared absences now, not empty queries — which is the point — but they are still absences.
- **The `NEW_USER_BASE_SCORE = 10` floor is granted per account** (`:169`, `:383`), and the
  scheduler seeds **every profile**, not only contributors (`lib/creatorActivityScoreScheduler.ts:36-39`).
  N sockpuppets earn N floors. This costs nothing while the boost is OFF; **it becomes a Sybil
  surface on the day the flag is flipped.**
- **Nothing is reproducible from an audit trail** on rungs 0–1, because the sources are mutable
  (§1.1). Rungs 2–3 are the exception and are the reason they are the strict ones.

**D7. The invariant to design to: a reward must be keyed to a unique, costly, verified act — not
to an account.** Both strict rungs already obey it. Rung 3 keys idempotency on the **observation
id**, so one contribution is booked once, forever, on an append-only ledger
(`lib/intelRewardScheduler.ts:66-72`; replay detected via the 23505 and returned as the original
entry, `services/intel/RewardService.ts:75-91`). Rung 2 keys on
`(user, definition, source_type, source_id)` and downgrades anything self-reported to the
`reported` tier rather than `verified` (`StampAwardEngine.ts:22-33`). Any Impact-derived reward
must be keyed the same way.

**D8. Enabling `ACTIVITY_DISCOVERY_BOOST_ENABLED` is a Sybil decision, not a flag flip.** The
prerequisites this document asserts, in order: (a) the unnormalised received-engagement count of
§2 (point 3) is bounded; (b) the new-user floor stops being a free per-account grant; (c) the
concentration alarm at `adminRankingMetrics.ts:52` has a baseline read *after* the #366/#387
instrument corrections, since **no reading taken before `4cc19af82` is comparable with one taken
after** (`00_STATUS.md`). None of these is an owner gate; the flip itself sits under the ranker
HOLD and is not this document's to propose.

## 5. Creator standing and Trust are different things

They are routinely conflated because both are 0–100 and both decay. They are not the same
measurement and must never be merged.

| | Trust | Creator standing |
|---|---|---|
| Subject | a **person's** safety and reliability | a **creator's** contribution activity |
| Source | `trust_events` with status `applied`/`confirmed` (`TrustScoreService.ts:112-125`) | first-class content and interaction tables (§1.1) |
| Shape | nine weighted categories → one overall (`TrustScoreService.ts:249-270`) | five weighted components → one score |
| Half-life | 90 days (`TrustScoreService.ts:60`) | 14 days (`CreatorActivityScoreService.ts:159`) |
| Asymmetry | **deliberate**: positives ramp with a confidence weight of 5, negatives bite at full strength on the first occurrence (`TrustScoreService.ts:151-215`) | symmetric; penalties are capped at 25/15 |
| Ceilings | `trust_caps` clamp a category from above regardless of positive history (`TrustScoreService.ts:127-149`, `:249-255`) | none |
| What it gates | **capabilities** — `public_level` maps through `LEVEL_RANK` to `canHostTrip`, `canCreateLargePlan`, `canUseCrewLocation`, `canContributeLiveIntel`, `canBecomeBuddy` (`services/passport/PassportProjectionService.ts:552-577`) | **ranking only**, and only when a flag is on |
| Visibility | label to everyone, number to self only (`PassportProjectionService.ts:1007-1021`) | never shown to anyone (§6) |

**There is exactly one coupling, and it runs one way.** `trust_profiles.overall_score` becomes a
**safety multiplier** on the creator score — `< 20 → 0.0`, `< 30 → 0.3`, `< 40 → 0.6`,
`< 50 → 0.8`, else `1.0` (`CreatorActivityScoreService.ts:1123-1143`). Trust is a **veto on
creator standing, not a component of it**, and creator standing never feeds trust in the other
direction (grep: no trust write anywhere in the ranking services).

That reader also carries a warning worth preserving: its predecessor collapsed the score on
`public_level in ('suspended','restricted')` — **labels the CHECK constraint cannot hold**, so
the branch was never taken (`:1086-1097`). It was not repointed at `trust_restrictions`, because
those four types are behavioural scopes (hosting, messaging, private-plan, location-plan) and
de-ranking a creator for being unable to start a DM would de-rank a different population than
"this creator's content is unsafe to boost" — *the wrong-but-plausible signal, which is worse
than a missing one* (`:1099-1116`).

### Reconciliation with the in-flight trust PRs

Read before changing anything in this area: **#449, #450, #453, #454, #455, #458, #467 are open
and actively rework trust scoring.** This document is written not to contradict them, and the two
places it touches them are called out rather than left to be discovered.

- **#449 — "a user with no evidence is not persisted as one with earned trust."** A user with
  zero qualifying events and no existing row is **computed but not persisted**; absence of a row
  becomes the canonical representation of "no earned trust". *Consequence here:* the safety
  multiplier's `no profile → 1.0` (`:1131`) becomes the **common** case rather than a rare one.
  That is the correct direction — an unmeasured person must not be de-ranked — but it means the
  veto only ever fires for users who **have** evidence. Recorded so nobody later "fixes" the
  fail-open into a fail-closed and silently zeroes every unscored creator. #449 also states the
  reason the veto matters: with `trust_engine_enabled` seeded false
  (`migrations/0166_feature_flags_reconcile.sql:25`, `artifacts/api-server/migrations/0043_trust_engine.sql:237`)
  and `trust_events` therefore empty, a naive first enable would have promoted **every user at
  once** to `reliable_traveler`.
- **#458 — "a failed read must never be reported as empty, clean, or done."** `loadSettings`,
  `loadEvents` and `loadCaps` now **throw** `TrustInputUnavailableError` instead of substituting
  defaults, because a row computed from inputs that failed to load is a fabricated measurement
  wearing a fresh `last_recalculated_at`. (**Correction, 2026-09-07:** `getTrustProfileResult`,
  the three-state `ok` / `absent` / `unavailable` read, is **#467**, not #458 —
  `git show pr/458 | grep -c getTrustProfileResult` is 0 and `pr/467` is 9. #458 contributes
  `TrustInputUnavailableError` and the three throwing loaders; #467 contributes the union.)
  *Consequence here:* `_fetchSafetyMultiplier` reads
  `trust_profiles` directly and never calls `recalculateTrustScore`, so it does not break — **but
  its `catch → 1.0` fail-open (`:1140-1142`) becomes the last place in the trust-consuming code
  that still turns an unreadable input into a confident value.** Under #458's rule the honest
  posture is to **skip the creator this pass**, not to score them at full multiplier. Flagged as a
  contract gap; deliberately **not changed here**.
- **#467, #453, #454, #455 — display side.** They stop the constant 50 being presented as a
  measurement — today `buildTrust` falls back to a literal `50` for the per-domain projection when
  no profile is readable (`services/passport/PassportProjectionService.ts:992`) — and render the
  server's real per-domain strengths and recovery hints instead of client constants.
  *Consequence here:* **do not design a creator-facing "trust tier" or "impact tier"
  chip.** The tier vocabulary that exists (`new_inactive` … `highly_active`,
  `routes/adminRankingMetrics.ts:73-95`) is an **admin distribution bucket**, not a user-facing
  label, and promoting it to the UI would recreate exactly the defect #467 is closing.
- **#450 — restriction expiry** gets a caller and a bound. No creator-economy surface reads
  `trust_restrictions`, by the deliberate decision quoted above; no interaction.

## 6. Privacy posture

- **Creator scores are internal, full stop.** `creator_activity_scores` has RLS enabled with a
  `FOR ALL USING (FALSE)` deny-public policy — service role only, which bypasses RLS
  (`artifacts/api-server/supabase/migrations/20260801_ranking_discovery_foundation.sql:37-47`). No route returns a
  per-user score: the only reader outside the scorer and the ranker is
  `routes/adminRankingMetrics.ts:305`, `:335`, which is `requireAdmin`-gated (`:160`) and returns
  **distributions and tier fractions**, never a named creator's number.
- **No leaderboard exists, and none should.** The passport certification records the §34 non-goal
  and the shape it takes in code: no compatibility or match percentage, and city expertise derived
  from qualified history — "never follower count; never paid volume"
  (`PassportReputationService.ts:63-69`; `docs/architecture/passport-certification.md`, §4 invariant 7).
  A public ranking of creators by Impact would invert every incentive §2 exists to prevent.
- **Paid contributions may never inflate a factual reputation number**
  (`PassportReputationService.ts:16-21`, `:81-87`).
- **Stamps carry location provenance that is never projected.** `user_stamps.lat/lng` are marked
  PRIVATE at the schema (`migrations/0081_stamp_system_v2.sql:49-51`, `:62-63`) and no read path
  selects them; visibility is enforced by RLS per row (`:75-95`).
- **The reward ledger is not user-facing data** — RLS deny-default, no `anon`/`authenticated`
  grant at all, `service_role` INSERT+SELECT only (`2170:49-56`) — and it is **explicitly erased
  on account deletion** by its own deletion step, because the `ON DELETE CASCADE` never fires
  under the anonymised tombstone (`lib/deletionDispositions.ts:86-93`).
- **Known gap, named rather than papered over: `creator_activity_scores` is in
  `UNCLASSIFIED_BACKLOG`** (`lib/deletionDispositions.ts:256`, `:324`) — its account-deletion fate
  has not been triaged. It is a per-user behavioural derivative keyed on `user_id`; it should be
  classified before anything makes it user-visible or increases what it retains.

## 7. What is NOT built, and why

- **Traveler Impact as a measured construct.** The name exists only in the stub this file
  replaces. What can be measured today is contribution and care; **impact requires attributing a
  traveller's real-world outcome to a contribution, and that needs Event Truth — ROADMAP step 2,
  gated, no migrations, no tables** (`ROADMAP.md:944`). The one place attribution exists is the
  `intel_*` lane, and it does not generalise.
- **Any enabled creator boost.** `ACTIVITY_DISCOVERY_BOOST_ENABLED` OFF; shadow mode preserves
  input order (`DiscoveryRankingService.ts:1029-1034`). Enabling it is an owner call under the
  ranker HOLD.
- **Any reward that reaches a user.** `intel_rewards` OFF (`2170:59-65`).
- **Cash, redemption, balances.** A financial-control boundary, not a milestone (`2170:12-15`).
- **Sybil resistance.** Nothing in this lane reads an identity, device or linkage signal (§4).
- **A creator-facing Impact surface of any kind** — score, tier, chip or leaderboard (§6).
- **Learned weighting of any of the above (ROADMAP step 9).** Its entry condition is trustworthy
  outcomes, and step 2 is unbuilt (`ROADMAP.md:951`).

**Blocked on Event Truth, stated once so it is not restated as a possibility elsewhere:** D2, any
outcome-weighted Impact, any generalisation of rung 3's attribution beyond `intel_*`, and step 9.
