# Portava Discovery Architecture

Current-state architecture notes for the discovery / intelligence backend. **Read
`00_STATUS.md` first** — it records which of these documents describe the running system and
which are still unreconciled proposals.

| Doc | Subject | State |
|---|---|---|
| `00_STATUS.md` | Provenance, the 2026-08-10 findings, what unit D3 built | current |
| `01_Portava_Discovery_Engine.md` | The discovery serve pipeline — ten serve points, caches in series, engine mode | current-state |
| `02_Trails.md` | Trails — STALE as a peer scoring system (ruling) | current-state |
| `03_Trending.md` | Trending — superseded by capped `local_momentum` (ruling) | current-state |
| `04_Behavior_Engine.md` | `rank_events` reality and the Event-Truth gate | current-state |
| `05_Graph_Engine.md` | `CompassGraphEngine` — nodes, edges, world model, city confidence | current-state |
| `06_Recommendation_Engine.md` | `portavaRank`, the modifiers, the exploration governor | current-state |
| `07`–`12` | Creator economy, revenue, payments, DB, API, implementation | proposal stubs |

Two documents outside this set govern what may be built here:

- `docs/discovery/ROADMAP.md` — the owner rulings and the 1–10 step sequence. The ranker is on
  **HOLD**; Event Truth is **Phase-B gated**; Trails and Trending as peer systems are **STALE**.
- `docs/fact-layer-20260810/` — per-entry verified facts about the running system, with errata.
