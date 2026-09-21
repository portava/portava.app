# Portava Discovery Architecture v1

Status: Canonical design package for implementation planning  
Audience: Claude Code, engineers, product, security, data/ML  
Scope: Discovery Engine, Trails, Trending, behavior telemetry, graphs, ranking, creator economy, Portava revenue, payment attribution, database/API architecture, rollout plan.

## Non-negotiable implementation constraints discovered in the current repository

This package intentionally incorporates findings already established in the live codebase rather than assuming a clean-slate architecture.

1. `rank_events` already exists and is the current behavior-event store.
   - `living_page` impressions were rejected by a CHECK constraint and silently swallowed by a fire-and-forget path.
   - `discovery` is permitted as a surface but has zero rows.
   - Several permitted surfaces have never written events.
   - Therefore the first behavior-engine milestone is **reliability of the existing write path**, not creation of a second parallel event table.

2. Discovery ranking is not consistently executed.
   - Cache A serves raw candidates on a user-independent key and bypasses the ranker.
   - Cache B stores already-ranked order and discards feature vectors.
   - A new Discovery Engine must not inherit either behavior accidentally.
   - Cache architecture must be made explicit before PDE ranking is activated.

3. Feature-flag rollout already has a proven repository pattern.
   - The account-scoping work uses a flag-off path that is tested to be byte-identical/inert.
   - PDE must reuse the same rollout philosophy: build behind a flag, prove the off-path is inert, shadow/compare, then activate.

4. Media ingest is not yet canonical.
   - Signed upload completion, HEIC fallback, and admin base64 upload bypass the full re-encode/sanitize path.
   - One path can leave an unstripped original behind if compose is abandoned.
   - Media sanitation must happen at or before durable ingest, not rely on a later completion action.

## Document set

- `01_Portava_Discovery_Engine.md`
- `02_Trails.md`
- `03_Trending.md`
- `04_Behavior_Engine.md`
- `05_Graph_Engine.md`
- `06_Recommendation_Engine.md`
- `07_Creator_Economy.md`
- `08_Portava_Revenue_Model.md`
- `09_Payment_Architecture.md`
- `10_Database_Architecture.md`
- `11_API_Specification.md`
- `12_Claude_Code_Implementation.md`

## Guiding product principle

Portava should optimize for **travel value**, not raw engagement.

A post is useful when it helps a traveler discover, decide, plan, go, experience, confirm, or share something meaningful. Likes, stamps, comments, views, dwell, sends, follows, and rewatches are signals; they are not the objective.

## Core entities

- Traveler
- Content
- Place
- Event
- Trip
- Trail
- Shared Moment
- Travel Mark
- Circle
- Recommendation
- Behavior Event
- Attribution
- Earning / Ledger Entry

## North-star outcome

The system should answer:

> What is the most valuable travel opportunity for this traveler, in this context, right now?

while preserving fairness, privacy, safety, creator opportunity, and explainability.
