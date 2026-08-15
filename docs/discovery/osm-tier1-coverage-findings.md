# Tier 1 OSM tag coverage — measured, not estimated

**2026-08-15. Step 3 of the ruled Tier 1 order, and part of the unit rather than
a follow-up.**

Tier 1 stopped discarding six Overpass tags. This is the answer to the question
that makes that change legible: **on what share of real places is each one
actually present?**

> **The rail this exists to satisfy:** *enumerate populations, do not estimate
> them.* "1 of 464 rows" is a finding; "coverage seems good" is not. A mapping
> change that lands without a measurement has delivered an unknown, and **an
> unknown looks exactly like a success.**

Instrument: [`reportOsmTagCoverage.ts`](../../artifacts/api-server/src/scripts/reportOsmTagCoverage.ts)
(`pnpm run report:osm-coverage`). It uses the Discovery route's **own** Overpass
filter and the route's **own** `mapOsmElementToPlace`, so what is counted is what
a card would actually receive — not what the raw tag set happens to contain.

---

## What was measured

**857 named places**, across three destinations and three Discovery categories,
captured 2026-08-15 at a 1000 m radius, capped at 200 elements per
destination+category.

| destination | places | categories captured |
|---|---|---|
| Paris | 493 | food (200), nightlife (200), places (200 → 93 named) |
| Berlin | 258 | food (200), nightlife (58) |
| Cebu | 106 | food (103), nightlife (6) |

## Results

| Field | Present | Share | |
|---|---:|---:|---|
| **chip: outdoor seating** | 283 | **33.0%** | **NEW in Tier 1** |
| **chip: wheelchair** | 283 | **33.0%** | **NEW in Tier 1** |
| **neighborhood** | 130 | **15.2%** | **NEW in Tier 1** |
| **chip: internet access** | 57 | **6.7%** | **NEW in Tier 1** |
| **wikidataId** | 27 | **3.2%** | **NEW in Tier 1** (carried, not rendered) |
| **osmImageUrl** | 4 | **0.5%** | **NEW in Tier 1** (carried, not rendered) |
| address | 426 | 49.7% | pre-existing |
| openingHours | 390 | 45.5% | pre-existing |
| phone | 304 | 35.5% | pre-existing |
| website | 211 | 24.6% | pre-existing |
| description | 29 | 3.4% | pre-existing |

## What this actually says

**The change was worth making, and the two biggest wins are the accessibility
and experiential attributes.** `outdoor_seating` and `wheelchair` each reach a
third of all measured places — that is a higher hit rate than `website`, a field
nobody would propose discarding. Before Tier 1 these were fetched and dropped on
every single request.

**Coverage is wildly uneven by region, and averaging hides it.** This is the
finding with the most consequence for what gets built next:

| | Paris | Berlin | Cebu |
|---|---:|---:|---:|
| neighborhood | **0.0%** | **50.0%** | 0.9% |
| outdoor seating | 27.0% | 57.4% | 1.9% |
| wheelchair | 27.8% | 55.8% | 1.9% |
| internet | 4.7% | 11.6% | 3.8% |
| wikidata | 4.7% | 1.6% | 0.0% |
| image | 0.6% | 0.4% | 0.0% |

- **Berlin is exceptionally well mapped.** Half its places carry a neighbourhood
  and over half carry both attribute tags. A measurement taken only there would
  have reported Tier 1 as a transformative win.
- **Cebu is close to bare** — ~2% on the attributes, 0% on wikidata and image.
  Since Cebu is the app's own default test city, **a manual check there would
  have shown almost no change and read as "Tier 1 did nothing".** It is not
  representative in either direction.
- **Paris returns 0.0% neighborhood** despite being densely mapped otherwise.
  That is not sparse data, it is a **tagging-convention mismatch**: Paris
  encodes location as arrondissements rather than `addr:neighbourhood` /
  `neighbourhood` / `addr:suburb` / `suburb`, which is the chain the route and
  `seed-discovery-places.ts` both use.

**`osmImageUrl` at 0.5% retrospectively confirms a design decision.** Tier 1
deliberately did *not* promote the OSM `image` tag to `headerImageUrl`. At four
places in 857, promoting it would have risked replacing a working FSQ → Google
chain on a handful of cards while doing nothing for the other 99.5%. **The
measurement was taken after the decision, and it agrees with it** — which is
worth recording precisely because it could have gone the other way.

**`wikidata` at 3.2% is a real constraint on Tier 2.** The enumeration called
`wikidata` the join key to free licensed structured data via Wikimedia and named
it the highest-leverage tag in Tier 1. It is a genuine key — but it exists on
roughly **one place in thirty**. Wikimedia enrichment is therefore a
*deep-not-broad* win: excellent content for a small minority of places, and no
effect at all on the rest. **That should be known before anyone budgets Tier 2,
not after.**

## What was NOT measured, stated plainly

A report that silently truncates its own scope reads as "we covered everything".

- **Only 3 of the 7 configured destinations.** New York, Bangkok, Nairobi and
  Lima are unmeasured. The Overpass mirror returned HTTP 504 on several heavier
  queries and the run was not retried indefinitely — chasing it would have been
  the prerequisite chain the owner ruled against.
- **Only 3 of 4 categories**, and `places` only for Paris. The `activities`
  filter was never captured successfully.
- **Not the production endpoint.** `overpass-api.de` is unreachable from this
  workspace (HTTP 000 while `api.github.com` returns 200 — an egress condition,
  not an Overpass outage). Captures came from `overpass.kumi.systems`, a mirror
  of the same OSM database. Tag density is a property of the data, not the
  server, so the shares hold — but this is a deviation and it is recorded as one.
- **This is a census of these 857 places, not a sample of OSM.** No confidence
  interval is claimed and none should be inferred.

**Re-running it where `overpass-api.de` is reachable is one command**
(`pnpm run report:osm-coverage`) and would close all four gaps at once.

## What this does not authorise

Nothing here starts new work. In particular the Paris `neighbourhood` gap is
**a finding, not a mandate** — extending the fallback chain to arrondissement-style
tagging would be more Tier 1 factual mapping, and Tier 1's ruled order is
complete. **Tier 3 remains gated on behavioural data**, and finishing Tier 1
does not open that gate.
