# 06 — Recommendation Engine

## 1. Pipeline

1. Context assembly
2. Candidate generation
3. Eligibility filtering
4. Feature computation
5. Scoring
6. Diversity/exploration
7. Integrity checks
8. Serve
9. Log recommendation
10. Learn from outcomes

## 2. Candidate sources

- followed creators
- nearby places
- current Trail
- related Trails
- trip destination
- saved-similar
- trending local
- emerging discoveries
- social/circle context
- editorial/curated
- exploration pool

## 3. Surface-specific scoring

Maintain feature families:
- relevance
- travel_intent
- freshness
- quality
- trust
- novelty
- social_relevance
- place_relevance
- trail_relevance
- exploration_value
- negative_feedback

Do not collapse everything into one permanent universal score.

## 4. Cache rule

Candidate caches may be user-independent.
Final ranking must not be.

Never serve raw candidate-cache order directly to users unless that surface explicitly requires no personalization.

## 5. Cache metadata

Preserve:
- model_version,
- feature_version,
- candidate source,
- recommendation reasons,
- ranking timestamp.

## 6. Diversity

Apply constraints across:
- creator,
- place,
- Trail,
- content type,
- geography,
- repeated recommendation history.

## 7. Exploration

Reserve controlled inventory for:
- new creators,
- low-exposure content,
- emerging places,
- new Trails.

Exploration should be relevant, not random.

## 8. Ecosystem Governor

Monitors:
- concentration,
- new-creator success,
- stale content,
- repeated recommendations,
- spam rate,
- Trail freshness,
- hidden-gem exposure.

Governor adjusts policy bounds, not individual user outcomes directly.

## 9. Cold start

New user:
- explicit onboarding interests,
- destination/trip context,
- local context,
- diversified high-confidence content.

New creator:
- exploration window,
- content semantics,
- place/Trail fit.

New Trail/place:
- local/contextual exploration with confidence controls.

## 10. Shadow evaluation

Before activation:
- compute old ranking,
- compute PDE ranking,
- compare overlap,
- compare offline utility,
- store counterfactual recommendation sets.

Feature flag must keep old user-visible output unchanged.

## 11. Acceptance criteria

The engine is ready when:
- cache paths cannot bypass ranking accidentally,
- recommendation logging is complete,
- exploration is explicit,
- diversity is enforced,
- model/version attribution is preserved,
- shadow comparison is available.
