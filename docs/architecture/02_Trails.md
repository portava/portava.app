# Trails — current state

*Derived from the repository, 2026-09-04.*

## Ruling: Trails as a peer scoring system is STALE

The original `02` proposed Trails as a first-class discovery primitive — permanent branching
discovery spaces with their own health and moderation, ranked as a **peer** of the other
components. The owner redirect of 2026-08-15 marks anything that "assumes the six P1 components
are peer scoring systems" as **STALE — must be re-scoped before implementation**
(`docs/discovery/ROADMAP.md`). ROADMAP **step 7** keeps trails only as a **future modifier** to
the ranker, never a parallel engine, and lists them alongside "graph, behaviour … and capped
`local_momentum` as modifiers only".

**Consequence for construction:** there is no Trails scoring engine to build or document as one,
and none is built. Unit D3 honoured this in two concrete places:

- **The graph does not admit a `trail` node kind.** Migration `2290` widened
  `compass_graph_nodes.node_type` to add `circle` and `experience` and *deliberately excluded*
  `trail`; the migration's postcondition **fails** if `trail` is ever admitted, and
  `CompassGraphEngine.GRAPH_NODE_KINDS` carries no `trail`. There is also no trail construct in
  the app to build such a node from.
- **No trail term enters `portavaRank`.** The ranker's modifiers are place-affinity and capped
  local momentum; trails are not among them.

## What of "trails" actually exists in the code

Only `lib/trailFollowup.ts` — a follow-up/notification helper on the intel-capture side (IG-06
Trail capture, `03`-adjacent), not a discovery scoring system. It is unrelated to the proposed
Trails primitive and is untouched by unit D3.

**If Trails is ever revived** it must be re-scoped first (the ruling), and any graph
representation would come through a *new* migration lane admitting a `trail` node with a real
source — not by relaxing `2290`.
