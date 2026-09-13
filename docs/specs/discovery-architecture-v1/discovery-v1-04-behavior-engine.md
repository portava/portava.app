# 04 — Behavior Engine

## 1. Purpose

The Behavior Engine records measurable user actions so Portava can learn from actual behavior rather than only explicit likes/comments.

## 2. Existing repository reality

Do **not** create a new parallel behavior store before fixing `rank_events`.

Known issues:
- `living_page` events were rejected by CHECK constraints and swallowed.
- `discovery` has zero rows despite being permitted.
- several surfaces are allowed but unwired.
- write failures can appear successful.

Therefore milestone 0 is:
**make the existing behavior pipeline truthful.**

## 3. Required properties

Every event write must be:
- schema-valid,
- attributable to a surface,
- observable on failure,
- idempotent where retried,
- versioned,
- privacy-classified.

## 4. Event categories

### Exposure
- candidate_generated
- recommendation_served
- impression
- visible_impression
- position_seen

### Attention
- active_dwell
- expand
- scroll_pause
- scroll_back
- image_swipe
- carousel_complete
- video_start
- video_25
- video_50
- video_75
- video_complete
- video_replay

### Engagement
- stamp
- unstamp
- comment
- reply
- send
- share
- save
- unsave
- profile_open
- follow

### Travel intent
- trail_open
- trail_follow
- place_open
- map_open
- directions_open
- trip_add
- itinerary_add
- event_view
- event_join
- event_attend
- route_start
- route_complete

### Relationship context
- travel_mark_create
- travel_mark_accept
- shared_moment_join
- circle_interaction

### Negative
- immediate_skip
- hide
- not_interested
- report
- mute
- block

Safety/private controls may be recorded for enforcement but must be separated from public reputation scoring.

## 5. Recommendation denominator

Every served item must have a `recommendation_id`.

Minimum recommendation record:
- recommendation_id
- user_id
- session_id
- candidate_type/id
- surface
- rank_position
- model_version
- reason codes
- served_at

Without exposure denominators, engagement rates are misleading.

## 6. Event schema (conceptual)

`rank_events` / canonical event store should be capable of:

- event_id
- user_id
- session_id
- recommendation_id
- event_type
- surface
- source_type
- source_id
- trail_id
- place_id
- trip_id
- dwell_ms
- completion_pct
- rank_position
- metadata_json
- occurred_at
- schema_version

If the current table cannot represent this safely, extend it by migration rather than introducing a competing event store.

## 7. Dwell quality

Distinguish:
- active dwell,
- passive foreground dwell,
- idle dwell.

Do not infer interest from a phone sitting untouched.

## 8. Behavior chains

High-value sequences:
- impression → place_open → save → trip_add
- video_complete → replay → send
- Trail open → place open → directions
- post → place visit → post-visit confirmation

Sequence features should be derived downstream rather than hard-coded into clients.

## 9. Current intent vs long-term preference

Maintain separate representations.

Example:
A user researching Tokyo nightlife for one trip should not permanently become “nightlife-heavy.”

Use:
- session intent,
- trip intent,
- long-term preference.

## 10. Write-path reliability work

Required before PDE:
1. audit every allowed `surface`,
2. prove at least one intentional writer or retire it,
3. remove silent failure catches,
4. instrument rejected event writes,
5. test all CHECK/enum constraints,
6. test recommendation_id propagation,
7. verify discovery events exist once ranking path executes.

## 11. Data retention

Not every raw event needs permanent retention.

Suggested layers:
- raw recent events,
- durable aggregates/features,
- audit/security events with separate retention,
- anonymized/aggregated long-term statistics.

Exact retention must be decided with privacy/legal review.

## 12. Privacy

Do not use:
- private message contents,
- sensitive inferred traits,
- precise historical location beyond product need.

Record action metadata only when necessary.

## 13. Acceptance criteria

Behavior Engine is ready when:
- no event can silently fail,
- all active surfaces are wired,
- recommendation exposures are logged,
- events are versioned,
- raw vs derived features are separated,
- current intent and long-term preference are distinct.
