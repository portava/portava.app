# 05 — Graph Engine

## 1. Purpose

The Graph Engine captures relationships among travelers, places, Trails, trips, events, and experiences.

It should not be confused with a public “friend graph.”

## 2. Graphs

### Traveler Graph
Edges from:
- follows,
- shared trips,
- shared events,
- accepted Travel Marks,
- Shared Moments,
- repeated interactions.

### Place Graph
Edges from:
- geographic proximity,
- common itinerary co-occurrence,
- same Trail,
- same trip sequence,
- traveler transitions.

### Trail Graph
Edges from:
- parent/child,
- related topic,
- geographic branch,
- common content,
- common traveler flow.

### Journey Graph
Connects:
- trips,
- places,
- events,
- Shared Moments,
- Travel Marks,
- Trails.

### Circle Graph
Internal model of travel-group activity and drift.

### Experience Graph
Connects experiences commonly consumed/visited together.

## 3. Relationship drift

Portava may internally learn:
- circle momentum,
- circle stability,
- expansion,
- inactivity,
- reconnection.

Private actions such as block/unfollow can affect visibility/safety but should not be exposed as reasons or public reputation penalties.

## 4. Independent-community signal

A strong quality/trend feature:
- multiple unrelated circles independently adopt the same place/Trail.

This is more trustworthy than one dense social cluster.

## 5. Edge types

Edges should be typed and time-aware.

Example:
- `shared_event`
- `shared_trip`
- `co_visit`
- `follow`
- `travel_mark`
- `content_to_place`
- `content_to_trail`
- `trail_related`
- `place_next_place`

## 6. Edge strength

Use derived strength from:
- recency,
- frequency,
- diversity,
- confirmed experiences.

Do not store “relationship truth” as a single permanent score.

## 7. Privacy boundary

Graph-derived data should be used for:
- recommendations,
- safety,
- personalization,
- aggregate insights.

It should not reveal:
- who blocked whom,
- why a relationship changed,
- private communications.

## 8. Implementation guidance

Start relationally in Postgres.
Do not introduce a graph database until query pressure proves the need.

Materialized/derived tables can serve:
- traveler affinities,
- place co-occurrence,
- Trail relations,
- circle momentum.

## 9. Acceptance criteria

Graph Engine is useful when:
- it improves candidate generation,
- it can detect independent convergence,
- it respects privacy,
- it can decay stale relationships,
- it remains explainable enough for debugging.
