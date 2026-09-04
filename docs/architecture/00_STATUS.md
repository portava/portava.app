# Status of these documents — read before implementing from any of them

These began life as **PROPOSALS**, not descriptions of the system. A six-agent review on
2026-08-10 cross-checked all thirteen against the codebase and found that several read as
greenfield where working-but-broken code already existed.

**Documents `01`–`06` have since been rewritten as current-state descriptions derived from the
repository** (2026-09-04, unit D3). They now describe what the code does, cite the files that do
it, and name what is *not* built and why. `07`–`12` remain proposal stubs and are still bound by
the caveat above.

Where any document claims something about current behaviour, it must still defer to the fact
layer (`docs/fact-layer-20260810/`), which carries per-entry provenance and an errata, and to
the discovery roadmap (`docs/discovery/ROADMAP.md`), which records the owner rulings in force.

## The 2026-08-10 findings, and where each stands now

- **`04_Behavior_Engine.md` — `rank_events` is mutable state, and it silently dropped
  `living_page`.** *Half refreshed.* `rank_events` is **still** a mutable-state table, not an
  event log: an outcome UPDATEs the impression row in place (`outcome`, `outcome_at`;
  fact layer §4.1). That has not changed and behaviour chains as `04` originally specified them
  remain structurally impossible on it — which is precisely why the roadmap's answer is a
  separate append-only **Event Truth** store, and that store is **Phase-B gated and unbuilt**
  (no migrations; `docs/discovery/event-truth-schema-packet.md`). The `living_page` half is
  **fixed**: migration `0202` widened the `rank_events.surface` CHECK so `living_page` and
  `watch_feed` are accepted instead of silently rejected, and `check:rank-events-surfaces`
  guards the set. See `04`.

- **`01_Portava_Discovery_Engine.md` — five of six serve paths return before any ranking, and
  the one that ranks uses a partly-constant feature vector.** *Refreshed.* The surface now has
  **ten** instrumented serve points (`DiscoveryServePoint`, `discoveryServeLog.ts`), and the
  feature vector is **no longer partly-constant** — `portavaRank` scores real taste, actionability,
  trust, social-proof, place-affinity and (capped) momentum signals (`portavaRank.ts`,
  `DEFAULT_WEIGHTS`). The structural observation still holds *in the shipping default*: with the
  engine mode on `legacy`, the cache-A serve points (1–3) still return cached pages without
  ranking. The capability to rank them per request exists and is wired (mode `pde`) but is **held
  OFF** by ruling. See `01` and `06`.

- **`05_Graph_Engine.md` — describes building a graph engine; one already ships.** *Refreshed.*
  The Phase-15 `CompassGraphEngine` ships and is rebuilt on a schedule. Unit D3 widened it to
  admit the `circle` and `experience` node kinds `05` names (migration `2290` + builders), and
  deliberately did **not** admit `trail`. See `05`.

- **`03_Trending.md` — normalises by an exposure denominator that currently counts conversions.**
  *Superseded by ruling.* Trending as a peer scoring system is **STALE** (ROADMAP step 7). There
  is no standalone trend engine to correct; the only velocity signal that ships is a **capped
  `local_momentum` modifier** to the ranker, and its cap is what keeps it a modifier. See `03`.

## What unit D3 built (2026-09-04)

All behind one flag `discovery_ranking_modifiers_enabled`, **seeded OFF** (migration `2289`),
because the ranker is on owner HOLD:

1. **pde-aware serve-point report** — ranked-ness is read from the row
   (`features.rankedInRequest`), not from a static serve-point set, so pde-ranked cache-A serves
   are counted as ranked (`discoveryServePointReport.ts`).
2. **capped `local_momentum`** — a 48h-vs-baseline place velocity signal entering `portavaRank`
   with a hard cap `LOCAL_MOMENTUM_MAX_CONTRIBUTION = 0.15`, below every taste signal
   (`discoveryLocalMomentum.ts`, `portavaRank.ts`).
3. **exploration governor** — a 15–25 % budgeted allocator with reason codes on
   `FeedSlotAllocator`; inert with the flag off, but it still records the allocation it *would*
   have made (`allocateExplorationBudget`).
4. **graph node kinds** — `circle` + `experience` admitted to the graph (migration `2290`), plus
   the world-model **city-confidence** consumed as a bounded, documented ranker input.
