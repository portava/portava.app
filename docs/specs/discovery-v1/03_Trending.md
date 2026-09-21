# 03 — Trending

## 1. Definition

Trending answers:
> What is gaining meaningful travel relevance now?

Trending is not equivalent to “most liked.”

## 2. Trend targets

Portava may trend:
- content,
- places,
- events,
- Trails,
- experiences,
- travelers/creators,
- circles (internally),
- destinations.

## 3. Trend types

### Trending Now
High short-window velocity.

### Emerging
Small absolute numbers, strong acceleration, broad independent confirmation.

### Local Pulse
Momentum within a geographic radius or neighborhood.

### Trip Planning
High save/add-to-trip intent.

### Hidden Gems
High value relative to low exposure.

### Evergreen
Persistent usefulness over long periods.

### Seasonal
Recurring relevance tied to calendar/weather/event cycles.

### Network Trending
Momentum inside a user’s social/travel graph.

## 4. Trend lifecycle

State machine:
- emerging,
- growing,
- peak,
- cooling,
- evergreen,
- rediscovered,
- inactive.

Trend lifecycle must depend on content type.

A nightclub event decays in hours.
A temple guide may remain valuable for years.

## 5. Trend signals

Positive:
- qualified impression conversion,
- active dwell,
- completion,
- replay,
- sends,
- shares,
- saves,
- add-to-trip,
- itinerary add,
- place open,
- directions open,
- event join,
- verified attendance/visit,
- independent circle adoption,
- post-visit confirmation.

Negative:
- immediate skips,
- hides,
- reports,
- high bounce after click,
- low-confidence engagement bursts,
- duplicate/coordination signals.

## 6. Independent convergence

One of Portava’s strongest travel-specific signals.

A place should trend more confidently when:
- unrelated travelers discover it,
- multiple circles visit independently,
- saves convert into visits,
- visitors post afterward,
- activity occurs across multiple networks.

This should outweigh a single creator’s large audience burst.

## 7. Normalization

Trend velocity must be normalized by:
- exposure,
- creator baseline,
- Trail baseline,
- location baseline,
- time-of-day effects,
- content age.

Avoid simply ranking absolute counts.

## 8. Follower count

Follower count may be used for fraud/context modeling but should not be a direct quality boost.

A small creator with exceptional conversion can outrank a large creator.

## 9. Place momentum model

Conceptual stages:
- unknown,
- emerging,
- trending,
- established,
- cooling,
- rediscovered.

Place momentum should use:
- unique travelers,
- independent circles,
- repeat visits,
- saves,
- trip additions,
- recency,
- diversity of visitors.

## 10. Creator trend model

A traveler can trend because they:
- repeatedly discover places early,
- create highly useful Trails,
- produce high travel-value content,
- influence confirmed trips/actions.

Do not equate creator trend with celebrity.

## 11. Trend explainability

Examples:
- “Rising quickly in Sukhumvit tonight.”
- “Frequently added to weekend trips.”
- “Emerging across several independent traveler groups.”
- “Popular with first-time visitors this month.”

## 12. Anti-gaming

Detect:
- engagement pods,
- account farms,
- repeated reciprocal actions,
- velocity spikes from low-quality cohorts,
- duplicate content,
- automation,
- artificial sends/saves,
- creator self-network amplification.

Trending should require diversity of evidence.

## 13. Trend storage

Prefer storing:
- raw behavior events,
- aggregated windows,
- trend state snapshots,
- explanation features,
- model/version references.

Do not store one opaque “trend score” as the only durable truth.

## 14. Acceptance criteria

Trending is complete when:
- it can distinguish emerging vs established,
- it is geographic and temporal,
- it normalizes for exposure,
- it detects independent convergence,
- it can decay and rediscover,
- it is resistant to single-metric manipulation,
- it can explain major trend reasons.
