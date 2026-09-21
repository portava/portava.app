# 12 — Claude Code Implementation Plan

## 0. Rule

Do not implement PDE as a greenfield subsystem.

Inspect and reuse the current repository architecture first.

## Phase 0 — Repository truth

### 0.1 Fix schema drift
Terminal condition: zero unexplained drift.

### 0.2 Finish CI
Require:
- ci-verdict
- live-db-verdict
- unwired-verdict

### 0.3 Complete privacy/tagging Phase 0
Fix:
- pending tag visibility,
- friends-only notification leak,
- `disable_tagging` fail-open,
- other catalogued Phase 0 findings.

### 0.4 Canonicalize media ingest
Redesign durable ingest so no raw unstripped original can persist merely because a completion handler never runs.

## Phase 1 — Repair behavior evidence

1. Inventory every `rank_events.surface`.
2. Map each surface to actual writers.
3. Remove silent write failures.
4. Add regression tests for CHECK constraints.
5. Add recommendation_id support.
6. Prove discovery writes occur on the real user path.
7. Add observability for rejected events.

Do not proceed to ranking rollout until behavior evidence is trustworthy.

## Phase 2 — Resolve discovery cache architecture

### Cache A
Prevent raw-candidate cache from bypassing ranker.

### Cache B
Preserve feature/model metadata; do not treat cached final order as permanent truth.

Deliver a design note documenting:
- candidate cache key,
- ranking cache key,
- invalidation,
- model/version handling,
- personalization boundary.

## Phase 3 — Feature flag

Reuse proven account-scoping flag pattern.

Required tests:
- flag OFF: byte-identical behavior.
- no migration side effects.
- no notification side effects.
- no cache/ranker side effects visible to users.

States:
OFF → SHADOW → COMPARE → PARTIAL → ON.

## Phase 4 — Recommendation logging

Implement:
- recommendation records,
- item ranks,
- reasons,
- model/version,
- exposure events.

## Phase 5 — Behavior expansion

Add missing high-value actions:
- dwell,
- replay,
- place open,
- Trail open,
- send/share,
- trip add,
- itinerary add,
- negative feedback.

Batch client telemetry where appropriate.

## Phase 6 — Trails MVP

Build:
- canonical Trail table,
- content attachment,
- Trail detail,
- related Trails,
- Trail follow,
- modular spotlight sections.

Do not build automatic AI Trail publishing initially.

## Phase 7 — Trending MVP

Build:
- Trending Now,
- Emerging,
- Local Pulse,
- Hidden Gems.

Use exposure-normalized metrics.

## Phase 8 — Graph projections

Start with Postgres-derived projections:
- place momentum,
- Trail relations,
- creator/place early-discovery history,
- circle momentum.

Avoid external graph DB until justified.

## Phase 9 — Ranking shadow mode

Compute PDE ranking without serving it.

Compare:
- overlap,
- save rate potential,
- diversity,
- creator concentration,
- place diversity,
- estimated travel intent.

## Phase 10 — Partial rollout

Small cohorts / one surface first.

Recommended first surface:
Discovery, after cache bypass is resolved.

## Phase 11 — Creator attribution foundation

Create:
- conversion events,
- attribution records,
- ledger accounts,
- immutable ledger entries.

No payouts yet.

## Phase 12 — Revenue integration

Add:
- affiliate/booking conversion ingestion,
- marketplace attribution,
- creator provisional earnings.

## Phase 13 — Ecosystem Governor

Monitor:
- creator concentration,
- new creator opportunity,
- Trail staleness,
- duplicate saturation,
- spam,
- repeat recommendations.

## Required test classes

### Unit
- scoring feature transforms
- Trail lifecycle
- trend lifecycle
- ledger math
- attribution rule versioning

### Integration
- event write path
- recommendation → behavior → attribution
- RLS
- Trail visibility
- feature flag OFF inertness

### Database
- migrations from current canonical baseline
- CI rehearsal
- schema drift

### Shadow diagnostics
- old vs new ranking comparison
- cache-path correctness
- recommendation coverage

## Deployment rules

1. rehearse on `portava-ci`,
2. run all verdict checks,
3. shadow first,
4. activate small cohort,
5. observe,
6. expand.

## Stop conditions

Stop rollout if:
- event rejection rises,
- recommendation logging gaps appear,
- creator concentration spikes,
- reports/hides increase materially,
- cache bypass reappears,
- RLS leaks occur,
- attribution double-counts.

## Completion definition

PDE v1 is complete when:
- behavior evidence is trustworthy,
- cache paths cannot bypass ranking,
- Trails are canonical objects,
- Trending uses normalized travel signals,
- recommendation exposures are logged,
- shadow/flag rollout exists,
- attribution and ledger are wired,
- payouts remain disabled until economics are validated.
