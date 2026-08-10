# Status of these documents — read before implementing from any of them

These are **PROPOSALS**, not descriptions of the system. A six-agent review on 2026-08-10
cross-checked all thirteen against the codebase and found that several read as greenfield
where working-but-broken code already exists.

Known, verified in code:

- `04_Behavior_Engine.md` assumes a clean event store. `rank_events` exists, is a MUTABLE
  STATE table rather than an event log (an outcome updates the impression row in place), and
  silently dropped `living_page` for months. Behaviour chains as specified are structurally
  impossible on it today.
- `01_Portava_Discovery_Engine.md` assumes Discovery ranking runs. Five of six serve paths
  return before any ranking, and the one that ranks uses a partly-constant feature vector.
- `05_Graph_Engine.md` describes building a graph engine. One already ships and is scheduled
  daily.
- `03_Trending.md` normalises by an exposure denominator that currently counts conversions.

**Where a document claims something about current behaviour, it must defer to the fact layer,
not to itself.** Full review output and the fact layer were produced 2026-08-10; the fact
layer carries per-entry provenance tags and an errata.

Nothing here has been reconciled against that review yet.
