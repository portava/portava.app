# Discovery Architecture v1 — the owner's specification

**Installed 2026-09-14** from `portava-architecture-upgrades-v2.zip`, provenance recorded in
`../upgrades-v2/SOURCE-MANIFEST.json` (sha256 per file, original paths under
`/Users/areyouok/Downloads/Portava_Discovery_Architecture_v1/`).

## Read this before citing a Discovery document

`docs/architecture/` contains thirteen files with **the same names as the ones in this
directory** — `01_Portava_Discovery_Engine.md`, `02_Trails.md`, and so on. **They are not this
specification and never were.** Their own headers say so:

> `# Portava Discovery Engine — current state`
> *Derived from the repository, 2026-09-04. Authoritative for control flow only where it cites a
> file; where it touches rulings it defers to `docs/discovery/ROADMAP.md`.*

Every one of the thirteen is titled `— current state` and is a description **of the code**. The
owner's specification — titled `# 01 — Portava Discovery Engine (PDE)` and so on — was not in this
repository until now. `01` alone is 276 spec lines against 76 derived ones.

**The hazard is the filename collision, not the derived documents.** They are legitimate as
code-derived notes. But a reader who opens `docs/architecture/01_Portava_Discovery_Engine.md`
expecting the spec gets a description of the implementation, and grading the implementation
against it would be measuring the code against itself — the one form of evidence that cannot
fail. Cite `docs/specs/discovery-v1/` when you mean the specification.

## What this does and does not change

`census-discovery.md` was **not** built from the derived files. It says so itself: it has no spec
of its own and was assembled from *inbound obligations* — sentences in other surfaces' specs that
name Discovery (A01–A25) — plus `cross-cutting-obligations.md`. So no existing Discovery verdict
rests on a code-derived document.

What changes is that Discovery now has its authored scope available for the first time: Trails,
trending, the behavior and graph engines, creator economy, revenue and payment architecture, the
API specification and the implementation plan. `02-DISCOVERY-v2.md` is explicit that it "retains
the original package's broader Trails, trends, graphs, integrity, economic attribution, API and
rollout scope" — that scope is in this directory, and the 67-row census does not yet cover it.
