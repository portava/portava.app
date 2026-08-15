# FILED: the neighbourhood normalisation gap

**Step 6 of the measurement-system rulings. Filed, not started.**
2026-08-15.

> **Paris is SEPARATE: 0.0% from arrondissement tagging semantics is a
> NORMALISATION problem, not evidence Tier 1 failed and not evidence for
> Tier 2. File it as a narrow geography adapter so it does not contaminate the
> enrichment decision.**

**The classification is correct and this document keeps it. One thing about the
scope is not, and the complete matrix is what changed it.**

---

## The correction, stated first because it changes the work

The ruling was written from the partial matrix, where Paris was the only city
showing 0.0% neighbourhood and Berlin showed 50%. On that evidence "a narrow
geography adapter" is the obvious shape.

**The complete 7 × 4 matrix says the problem is not narrow:**

| destination | neighborhood | n |
|---|---:|---:|
| **Berlin** | **32.4%** | 460 |
| Cebu | 0.9% | 111 |
| New York | 0.2% | 438 |
| Paris | **0.0%** | 560 |
| Bangkok | **0.0%** | 285 |
| Nairobi | **0.0%** | 162 |
| Lima | **0.0%** | 105 |

**Six of seven measured cities are at or near zero. Berlin is the exception, not
Paris.**

So this is not an arrondissement quirk. **The key chain
(`addr:neighbourhood → neighbourhood → addr:suburb → suburb`) matches German
tagging convention and very little else.** Paris was simply the first city where
we happened to look closely.

**Nothing about the ruling's reasoning changes.** It is still normalisation
rather than missing data — the locality information exists in OSM, we are asking
for it by the wrong key. It is still **not evidence Tier 1 failed**: Tier 1
delivered the field, and the field works wherever the tagging matches. And it is
still **not evidence for Tier 2** — buying an external provider to supply
locality we already have would be paying to work around our own key chain.

**Only the word "narrow" needs replacing.** An adapter scoped to Paris would fix
1 of the 6 broken cities and leave the aggregate almost unchanged.

## Why keeping this out of the enrichment decision matters

This is the part of the ruling that does the real work, and the complete matrix
makes it more important rather than less.

**Left in the enrichment bucket, a normalisation defect presents as missing
data.** "Neighbourhood coverage is 7.1%" reads as *the world has not tagged
this*, and the natural response is to go and buy it from a provider. **That
provider would have supplied data OSM already holds**, at a recurring cost, to
work around a key chain we control — and the 7.1% would have become the
strongest-looking argument in the Tier 2 study while being an artifact of our
own mapping.

**With the complete matrix the misreading would have been six times worse than
when the ruling was written.**

## What the work actually is — scoped, not started

A **geography adapter**: a normalisation layer that resolves a locality label
from whatever key a region's mappers actually use, rather than from one chain.

Known shapes to handle, from the measured cities:

| region | how locality appears | current result |
|---|---|---|
| Germany | `addr:suburb`, `suburb` | ✅ works |
| France | arrondissement — `addr:city` is "Paris", the district is encoded in the postcode (`75011`) and in `admin_level=9` boundary relations | ❌ 0.0% |
| USA | neighbourhood is usually a `place=neighbourhood` **node**, not a tag on the venue | ❌ 0.2% |
| Thailand / Kenya / Peru | mostly untagged at venue level; some `addr:district`, `addr:quarter` | ❌ 0.0% |

**Two candidate approaches, both Tier 1 factual, neither authorised here:**

1. **Widen the key chain** — add `addr:district`, `addr:quarter`, `addr:city_district`.
   Cheap, no new dependency, and testable against the captures already on disk.
   **Unknown incremental coverage** — measurable with the instrument before
   writing any of it, which is the point of having the instrument.
2. **Spatial resolution** — a point-in-polygon lookup against OSM
   `place=neighbourhood` / `admin_level` boundaries. Correct for the USA and
   France shapes, materially more work, and needs a boundary source.

**Do the measurement before choosing.** Adding four keys to a chain and
re-running `pnpm run report:osm-coverage` costs almost nothing and would say
whether option 1 closes most of the gap or none of it. **Choosing the
architecture first is exactly the habit the framing ruling was written against.**

## Status

**FILED. Not started, not authorised, and not a blocker for anything.**

It sits ahead of Tier 2 in the same sense step 4 did — it is a correctness
problem in what we already have, and resolving it changes what a Tier 2 study
would conclude. It does not need to be finished before that study begins, but
its **existence must be known to the study**, so that 7.1% neighbourhood
coverage is never cited as a reason to buy locality data.
