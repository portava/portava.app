# 01 — Portava Discovery Engine (PDE)

## 1. Purpose

The Portava Discovery Engine is the platform layer that turns behavior, travel context, content, places, Trails, social relationships, and real-world outcomes into personalized discovery.

PDE is not a single feed ranker. It is a coordinated set of systems that:

- understands current traveler intent,
- generates candidate experiences,
- ranks them by travel value,
- gives new creators fair exploration,
- detects trends,
- maintains Trails,
- protects against spam and manipulation,
- explains recommendations,
- records why each recommendation was shown,
- and attributes downstream economic value.

## 2. Product objective

Optimize for:

**Right traveler × right experience × right place × right time.**

Not:
- maximum session length,
- maximum likes,
- maximum follower growth,
- maximum raw watch time.

Those may be useful signals, but they are subordinate to travel value.

## 3. Inputs

PDE may use:

### Current-session behavior
- impressions,
- active dwell,
- scroll depth,
- rewatches,
- expands,
- map opens,
- place opens,
- Trail opens,
- saves,
- sends,
- trip additions,
- itinerary additions,
- event joins,
- skips,
- hides,
- reports.

### Long-term preferences
- destination affinity,
- travel style,
- budget tendencies,
- activity categories,
- pace,
- food/nightlife/adventure interests,
- solo/group patterns.

### Current trip context
- current city,
- upcoming destination,
- trip dates,
- trip companions,
- saved plans,
- availability,
- time of day,
- nearby places,
- event windows.

### Graph context
- creator affinity,
- circle activity,
- shared experiences,
- trusted local discovery,
- place momentum,
- Trail relationships,
- independent community confirmations.

### Content characteristics
- content type,
- freshness,
- place binding,
- Trail membership,
- event validity window,
- quality signals,
- safety/trust signals.

## 4. Outputs

PDE should rank or recommend:
- postcards/posts,
- places,
- events,
- Trails,
- trips,
- Shared Moments,
- travelers,
- circles,
- itineraries,
- emerging discoveries.

## 5. System components

### 5.1 Behavior Engine
Captures the evidence.

### 5.2 Intent Engine
Separates current intent from long-term preference.

### 5.3 Candidate Generation
Builds a broad set of plausible things to show.

### 5.4 Ranking Engine
Scores candidates differently per surface.

### 5.5 Exploration Engine
Guarantees meaningful opportunity for new or underexposed content.

### 5.6 Trend Engine
Detects velocity, convergence, recurrence, and decay.

### 5.7 Trail Engine
Maintains permanent travel discovery spaces.

### 5.8 Graph Engine
Builds traveler/place/trail/journey/circle relationships.

### 5.9 Integrity Engine
Detects manipulation, spam, low-confidence activity, and duplicate behavior.

### 5.10 Ecosystem Governor
Monitors the health of the system rather than ranking individual items.

## 6. Existing-system constraints

PDE must not assume `rank_events` is trustworthy until:
- all permitted surfaces can actually write,
- rejected events are observable,
- fire-and-forget failures are surfaced,
- missing surface writes are explained,
- recommendation exposures carry denominators,
- discovery ranking is proven to execute on the paths users actually hit.

The first PDE milestone is therefore **evidence integrity**.

## 7. Cache architecture requirement

Before activating PDE:

### Cache A problem
A user-independent candidate cache that serves raw candidates must never bypass personalization/ranking.

Allowed pattern:
1. cache broad candidate set,
2. retrieve candidates,
3. rank per user/session,
4. log recommendation,
5. serve result.

### Cache B problem
Caching final ranked order without feature vectors makes re-ranking, diagnostics, and counterfactual analysis impossible.

Allowed pattern:
- cache candidate features,
- cache expensive retrieval results,
- optionally cache short-lived ranking results keyed by user + context + model/version,
- always preserve recommendation metadata and feature/version references.

## 8. Feature-flag architecture

Use one top-level PDE flag with sub-flags if necessary.

Required states:
- OFF: existing behavior byte-identical.
- SHADOW: new engine computes but does not affect UI.
- COMPARE: old and new rankings logged for analysis.
- PARTIAL: small cohort/surface rollout.
- ON: PDE controls selected surfaces.

No migration, notification cancellation, side effect, or ranking change should occur merely because shadow computation exists.

## 9. Surface-specific objectives

### Pulse
Favor:
- freshness,
- local relevance,
- live context,
- social context,
- event timing.

### Discovery
Favor:
- personalized relevance,
- novelty,
- usefulness,
- diversity,
- travel intent.

### Trail
Favor:
- Trail relevance,
- freshness appropriate to content type,
- diversity of contributors,
- variety of place/experience,
- confidence.

### Trip Planning
Favor:
- itinerary utility,
- trip fit,
- route fit,
- budget/availability,
- save/add-to-trip behavior.

### Trending
Favor:
- velocity,
- independent convergence,
- confidence,
- freshness,
- anti-manipulation.

## 10. Guardrails

PDE must never:
- use private message contents as ranking features,
- expose block/unfollow reasons,
- reward abusive engagement,
- let one creator permanently dominate a Trail,
- treat follower count as a direct quality score,
- suppress new creators solely due to low history,
- infer sensitive personal attributes for ranking,
- make safety/private-control events into public reputation penalties.

## 11. Explainability

Every served recommendation must have internal reasons such as:
- trail_affinity,
- trip_match,
- nearby_now,
- trending_local,
- creator_affinity,
- exploration,
- saved_similar,
- social_context,
- season_match.

User-facing explanations should be plain language, e.g.:
- “Popular with solo travelers this week.”
- “Frequently added to Tokyo trips.”
- “Rising near your hotel.”
- “Because you saved similar rooftop bars.”

## 12. Success criteria

PDE is successful when it improves:
- useful saves,
- itinerary additions,
- place opens,
- completed visits,
- event attendance,
- successful trip actions,
- low regret/hide/report rates,
- creator diversity,
- new-creator discovery,
- Trail freshness,
- repeat traveler satisfaction.

Raw engagement may rise or fall; it is not the sole acceptance criterion.
