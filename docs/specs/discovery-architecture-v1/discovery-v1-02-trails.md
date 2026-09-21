# 02 — Trails

## 1. Definition

A Trail is a permanent, structured travel discovery space that organizes content, places, events, travelers, routes, and context around a meaningful travel theme.

A Trail replaces the weakness of hashtags without becoming a renamed hashtag.

Example:
- `Bangkok After Dark`
- `Tokyo First-Timer`
- `Da Nang Coffee Crawl`
- `Seminyak Beach Clubs`
- `Kyoto Hidden Temples`

A Trail is **permanent**. Its **spotlights and ranking are temporary**.

## 2. Why Trails exist

Hashtags fragment:
- `#danang`
- `#DaNang`
- `#danangvietnam`
- `#danangtrip`

Trails use canonical identities, relationships, geography, time, and semantics.

## 3. Trail components

Each Trail can contain:
- posts/postcards,
- places,
- events,
- itineraries,
- routes,
- contributors,
- local experts,
- related Trails,
- seasonal modules,
- “happening now” modules.

## 4. Primary Trail vs supporting signals

Content may have:
- one primary Trail,
- optional supporting Trails or Signals.

Signals can represent:
- luxury,
- solo friendly,
- late night,
- family,
- hidden gem,
- rooftop,
- food,
- live music.

Do not let creators attach unlimited discovery labels.

## 5. Trail creation

A Trail can originate from:
- Portava-curated catalog,
- user proposal,
- community growth,
- system suggestion from clusters.

Creation should require canonicalization checks:
- duplicate title similarity,
- destination overlap,
- semantic overlap,
- existing parent/child Trail.

## 6. Trail relationships

Support:
- parent,
- child,
- related,
- seasonal variant,
- geographic sub-Trail,
- experience branch.

Example:
`Bangkok After Dark`
- `Rooftops`
- `Thonglor`
- `Live Music`
- `Luxury Nights`

## 7. Trail lifecycle

Trail state:
- proposed,
- active,
- needs_update,
- stale,
- archived.

Content lifecycle inside a Trail:
- just_arrived,
- growing,
- featured,
- evergreen,
- rediscovered,
- archived_from_active_rotation.

## 8. Spotlight model

A million posts can belong to one Trail without creating a million-item chronological feed.

Recommended spotlights:
- Just Arrived
- Trending Now
- Today’s Favorites
- This Week
- Hidden Gems
- Evergreen
- Local Picks
- Personalized Picks
- Seasonal
- Near You

Each spotlight has its own objective and time horizon.

## 9. Fair exposure

Every eligible new item should receive a bounded exploration opportunity.

Do not promise a fixed number of impressions publicly.

Internally:
1. candidate qualifies,
2. small relevant audience,
3. evaluate normalized response,
4. expand or taper,
5. periodically retest promising items.

Use exposure denominators.

## 10. Trail saturation

When many near-duplicate posts exist:
- cluster by place/content similarity,
- diversify creators,
- diversify media,
- reduce repeated viewpoints,
- preserve access through “more from this place.”

## 11. Trail health

Metrics:
- contributor concentration,
- new-creator exposure,
- content freshness,
- duplicate density,
- report rate,
- place diversity,
- geographic diversity,
- quality-to-noise ratio,
- stale object ratio.

Trail health should influence ranking but not silently erase legitimate content.

## 12. Trail status

User-facing examples:
- Active
- Fresh today
- Needs updates
- Seasonal
- Quiet right now

Avoid exposing opaque quality scores.

## 13. Trail completion

For route-like Trails, users can track:
- places visited,
- stops completed,
- saved stops,
- remaining stops.

Completion is optional and should not turn every Trail into a checklist.

## 14. Trail versions and seasons

Permanent Trail:
`Bangkok`

Seasonal contexts:
- Songkran
- New Year
- Rainy Season
- This Weekend

Prefer contextual modules over cloning the entire Trail unless the event truly needs a distinct historical object.

## 15. Trail moderation

Sources of moderation:
- automated classification,
- community reports,
- trusted local confirmations,
- admin moderation.

Actions:
- remove unrelated content,
- merge duplicate Trails,
- correct place links,
- mark stale,
- resolve abuse.

## 16. Trail reputation

A Trail can carry descriptors:
- rapidly changing,
- highly curated,
- local-heavy,
- family friendly,
- nightlife heavy.

These are descriptive, not absolute quality ranks.

## 17. Trail attribution

When a Trail materially contributes to a booking or other monetizable action, attribution records should preserve:
- trail_id,
- recommendation_id,
- content contributors involved,
- confidence,
- downstream revenue event.

This enables future Trail-builder earnings without paying for raw views.

## 18. Data model (conceptual)

`trails`
- id
- slug
- title
- description
- destination/place scope
- parent_trail_id
- lifecycle_status
- created_by
- canonicalization metadata
- created_at
- updated_at

`content_trails`
- trail_id
- source_type
- source_id
- relationship
- source
- confidence
- created_at

`trail_edges`
- from_trail_id
- to_trail_id
- edge_type
- strength
- updated_at

`trail_health_snapshots`
- trail_id
- metrics
- model_version
- captured_at

## 19. Acceptance criteria

A Trail implementation is acceptable when:
- Trails are canonical objects, not strings,
- ranking is modular rather than chronological-only,
- new content receives fair opportunity,
- duplicate saturation is controlled,
- Trail relationships are navigable,
- user behavior can influence Trail momentum,
- Trail attribution is recordable,
- no user has to understand internal scores.
