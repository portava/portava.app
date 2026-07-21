---
name: Intelligence graph conventions
description: Phase 15 graph substrate design rules — edge identity, UTC slices, read-time privacy.
---

- Graph edges are keyed by (src_type, src_key, dst_type, dst_key, edge_type). Any dimension that must not collapse across observations (e.g. activity category in `active_during:<category>`) MUST live in the edge_type/key, not attrs — attrs get overwritten on upsert.
  **Why:** category stored in attrs caused all time-slice observations for a city+slice to merge into one edge with a single category.
- Time slices (`fri:evening` etc.) currently use UTC (`timeSliceKey`); a local-clock follow-up task exists.
- Privacy is enforced at read time: person nodes carry NO profile attrs; every read API (world model, confidence, context lines) returns aggregates only.
- Rebuild path: buildGraphFromSources → buildCityWorldModels → computeCityConfidenceIndex (rebuildIntelligenceGraph), idempotent, admin POST /api/compass/graph/rebuild.
