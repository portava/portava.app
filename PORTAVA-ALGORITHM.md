# The Portava Algorithm
### A ranking engine for realized experiences, not watch time

## 1. The core insight — don't fight TikTok on TikTok's field

TikTok, Instagram, and Facebook run the best watch-time predictors ever built. You will
not out-predict them at "what will this person passively consume next," and you shouldn't
try — because that objective is wrong for Portava. Their algorithms succeed when the user
*stays on the phone*. Portava succeeds when the user *puts the phone away* — because they're
at the meetup, on the food crawl, with the buddy, earning the stamp.

So the Portava algorithm optimizes a different quantity:

> **Expected Realized Value (ERV):** the probability that showing this item to this
> traveler, here, now, leads to a real-world outcome — a plan joined, an event attended,
> a gem visited, a connection made — weighted by how good that outcome turns out to be.

This is also Portava's unfair advantage. The big feeds know what you watch. Portava knows
five things they structurally don't: **where you are, where you're going, when you're
free, who's around you, and whether the humans involved can be trusted** — plus the one
signal none of them have at all: **GPS-verified ground truth that the recommendation
actually happened** (verified check-ins, stamps, safe returns, post-event reviews).
TikTok's feedback loop ends at a rewatch. Portava's ends at a passport stamp. Train on
that, and you have a moat no watch-time engine can cross.

## 2. The objective function

Every candidate item is scored as:

```
ERV(item, viewer, now) = Σ  w_f · f(item, viewer, now)
```

a weighted sum of features across the six context groups your spec (§42) defines —
user, time, preference, social, behavioral, quality. v1 ships with hand-tuned weights
(`DEFAULT_WEIGHTS` in `lib/portavaRank.ts`); v2 fits them from logged outcomes (§7).
The weights encode the product thesis directly: **actionability (0.9) is the single
heaviest feature** — a joinable event tonight in your city from a trusted host beats a
viral post from nowhere. That ordering *is* Portava.

## 3. The features (what's implemented today)

**Time — the Portava edge**
- `recency` — exponential decay, 36-hour half-life (a travel feed is a *now* feed;
  the old 7-day linear decay let stale content linger).
- `actionability` — a bell curve around start time: peak 0–6h before ("you can still
  make it"), 0.7 today, 0.4 tomorrow, 0.25 while ongoing, zero once it's over. Content
  you cannot act on decays to background.
- `availabilityFit` — fits the viewer's *explicitly shared* free window: +1 inside a
  layover/availability window, −0.5 for a layover recommendation that can't fit, 0 when
  the viewer shared nothing. **Never inferred** — same honesty rule as the availability chip.

**Place**
- `cityMatch` + `neighborhoodMatch` — same city (stacked bonus for neighborhood detail).
- `distance` — smooth decay (5 km ≈ half), city-level only; the ranking never touches
  precise coordinates, honoring the privacy architecture.

**People**
- `followedAuthor`, `mutualAuthor` (stacks — mutuals are stronger than follows),
  `engagedAuthor` (authors you've recently liked/saved/commented — short-term taste).

**Preference**
- `interestTag` — hashtag/interest overlap; `categoryAffinity` — the learned 0–1
  affinities your preference engine already produces (`compass_user_preferences`).

**Quality & trust — the manipulation firewall**
- `socialProof` — **log-scaled** (10k likes ≠ 1000× 10 likes) with joins worth 2× likes,
  then **multiplied by author trust**: engagement farmed on a low-trust account buys
  almost no rank. This is the anti-botting design: on Portava, rank is earned through
  the trust system, not raw counters.
- `trust` — host/author Trust Score directly; `verifiedBonus` — GPS-verified items;
  `capacityOpen` — joinable beats full.

**Fatigue**
- `seenPenalty` (−0.6) — items the viewer already saw sink; the feed moves forward.

## 4. After scoring: diversity and exploration

**Diversity (greedy MMR):** repetition penalties over a sliding window stop one loud
author or one content type from owning consecutive slots — the feed stays a *mix* of
posts, events, plans, gems, and people, which §4 of your spec demands of Pulse.

**Exploration (seeded epsilon-slots):** every 7th position is filled from the long
tail instead of the head. This is how a brand-new creator, a just-added gem, or a
quiet city gets its first impressions — and how the system generates the training data
to keep learning instead of feeding back its own priors. The randomness is seeded per
(user, hour): stable pagination within a session, fresh mix the next.

## 5. Candidate generation (the funnel above scoring)

Scoring ranks; candidates decide what *can* rank. Each surface pulls from sources it
already has, and the shared core merges them:

- **Pulse:** city posts (wired today) + starting-soon events + tonight's plans +
  available buddies + follow graph recency.
- **Discover:** places, gems, traveler picks, neighborhoods — same scorer, distance
  features doing more work.
- **Compass:** the same ERV scores become the *explanation layer* ("starting in 2h,
  3 mutuals going, fits your free evening") — Compass is the algorithm made articulate.
- **Pre-trip:** when a trip to Tokyo exists, Tokyo candidates enter the pool early
  (spec §5) with a dampened city weight that ramps as departure nears.

## 6. Cold start — good on day one

New user: onboarding interests + travel style seed `interestTags`/`categoryAffinities`;
their city seeds geo; "popular with travelers" (your existing activity-ranked cities and
gems) fills the gap where personal signal is missing. New item: exploration slots
guarantee first impressions; verified/trusted authors start warmer. New city: editorial
gems + events carry the feed until traveler activity accumulates. Nothing needs to be
faked — the empty states stay honest while the pool is thin.

## 7. The learning loop (v2 — the part that compounds)

Every ranked impression already returns its **feature vector** (`ScoredCandidate.features`).
Log it with the outcome funnel you already track:

```
impression → tap → save/join/RSVP → attended (GPS-verified) → rated well
```

That table (`rank_events`: user, item, features, position, outcome) is everything needed to:
1. **Fit weights offline** — logistic regression from features → deep-funnel outcomes
   (attended > joined > saved > tapped; a tap that ends in a real meetup teaches more
   than a thousand passive likes). Replace `DEFAULT_WEIGHTS`, A/B against v1.
2. **Per-user deltas** — small personal weight adjustments on top of global weights
   (some travelers are spontaneous free-tonight types; some are planners).
3. **Counterfactual checks** — exploration slots double as unbiased holdouts, so you
   can measure what the ranker *would have missed*.

v3 adds embedding recall (two-tower user/item vectors) for candidate generation — but
only after v2's logged data exists. Never build the fancy layer before the feedback loop.

## 8. What the algorithm refuses to do (by design)

- **No doomscroll objective.** Session length is not a reward. If a session ends
  because the user tapped "Join" and left for the bar — that's a *win*, and the metrics
  treat it as one.
- **No inferred availability, no GPS in ranking features, no fake urgency.** The same
  honesty rules as the UI. Not-opted-in users are simply absent from people-candidates.
- **No pay-to-rank or virality worship.** Trust-dampened, log-scaled social proof means
  the path to reach on Portava is being a real, trusted traveler — not buying engagement.
- **Safety floor:** blocked users never appear (already enforced upstream); low-trust
  hosts sink; reported content is removed from pools at the candidate stage.

## 9. Metrics that matter

Rank the launch dashboards by this order, not raw engagement:
1. **Realized Connection Rate** — % of sessions leading to a join/RSVP/booking/meetup.
2. **Time-to-Plan** — median seconds from open → committed action ("land in a city,
   know what to do in a minute").
3. **Verified follow-through** — % of joins that become GPS-verified attendance.
4. **Discovery breadth** — % of impressions from exploration slots that convert
   (health of the long tail).
5. D7/D30 retention — the lagging confirmation the above are working.

## 10. What shipped today (v1)

- `artifacts/api-server/src/lib/portavaRank.ts` — the pure, dependency-free core:
  all §3 features, MMR diversity, seeded exploration, `rankCandidates()` one-call
  pipeline, tunable `DEFAULT_WEIGHTS`, feature vectors exposed for logging.
- `artifacts/api-server/src/test/portavaRank.test.ts` — 14 tests locking in the
  product-defining behaviors ("event tonight beats viral post from elsewhere",
  trust-dampened virality, no inferred availability, deterministic exploration).
  Run: `node --import tsx/esm --test src/test/portavaRank.test.ts`
- **Pulse now ranks through the core** — same signals as before (recency, follow,
  hashtag, city) plus exponential recency, author diversity, and exploration slots.
  Zero behavior cliffs: missing signals contribute 0.

**Next steps, in order:** (1) wire events + plans + buddies into Pulse's candidate
pool with `actionability`/`availabilityFit` live, (2) route Discover and Events
ordering through the core, (3) add the `rank_events` impression log, (4) fit v2
weights from 4–6 weeks of beta data. Each step is an incremental patch on this
foundation — no rewrites.
