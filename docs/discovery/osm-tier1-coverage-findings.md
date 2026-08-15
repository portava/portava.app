# Tier 1 OSM tag coverage — the complete matrix

**2026-08-15. Step 3 of the measurement-system rulings, which put it ahead of
starting any new feature.**

> **The key outcome is NOT 33%. It is that you have now built a MEASUREMENT
> SYSTEM capable of telling you where the information deficit actually is.**

This is that system run to completion: **all 7 destinations × 4 categories, 28
of 28 cells, zero failed queries, 2121 named places.**

> **PRESERVE THE PER-CITY AND PER-CATEGORY NUMBERS ALONGSIDE THE AGGREGATE. The
> result must NOT be reduced to one percentage.**
>
> **That instruction was right, and this run proves it twice over** — see
> "What completing the matrix changed" below. Two of the numbers the earlier
> partial run produced were **artifacts of which cells happened to succeed**.

---

## Provenance

| | |
|---|---|
| **endpoint** | `https://overpass.kumi.systems/api/interpreter` — **NOT the production default** |
| why | `overpass-api.de` returns HTTP 000 from this workspace while `api.github.com` returns 200. An egress condition, not an Overpass outage. Ruled: *use the mirror and pace it rather than treating the gap as blocking* |
| validity | The mirror serves the **same OSM database**. Tag density is a property of the data, not the server |
| radius | 1000 m |
| cap | 200 elements per cell |
| completeness | **28/28 cells succeeded.** No cell is unmeasured, so no share below is a network artifact |
| pacing | 6 s between calls, up to 5 attempts, 25 s linear backoff. **11 of 28 cells needed a retry**; every one eventually succeeded |

Instrument: `pnpm run report:osm-coverage`. It uses the Discovery route's **own**
`overpassFilter` and **own** `mapOsmElementToPlace`, so what is counted is what a
card would actually receive.

---

## Aggregate — 2121 named places

| Field | Present | Share | |
|---|---:|---:|---|
| chip: wheelchair | 481 | **22.7%** | NEW |
| chip: outdoor seating | 318 | **15.0%** | NEW |
| **wikidataId** | 254 | **12.0%** | NEW (carried) |
| neighborhood | 151 | **7.1%** | NEW |
| chip: internet access | 122 | **5.8%** | NEW |
| osmImageUrl | 53 | **2.5%** | NEW (carried) |
| address | 962 | 45.4% | pre-existing |
| openingHours | 695 | 32.8% | pre-existing |
| website | 572 | 27.0% | pre-existing |
| phone | 556 | 26.2% | pre-existing |
| description | 75 | 3.5% | pre-existing |

## What completing the matrix changed — read this before acting on the old numbers

**Two headline figures moved substantially, and both moved because the partial
run was category-skewed, not because anything about the world changed.**

| Field | Partial (3 cities, mostly food/nightlife) | **Complete (7 × 4)** | |
|---|---:|---:|---|
| **wikidataId** | 3.2% | **12.0%** | **×3.75 — and this one has consequences** |
| outdoor seating | 33.0% | **15.0%** | halved |
| wheelchair | 33.0% | **22.7%** | down |
| neighborhood | 15.2% | **7.1%** | halved |

The earlier run was heavy on `food` and `nightlife` — the categories where
`wikidata` is near-zero — and missing `places` and `activities` almost entirely,
which are where it concentrates. **The aggregate was not wrong; it was a
measurement of a different population presented as if it were the corpus.**

## The three structures the aggregate hides

### 1. `wikidata` is a CATEGORY property, not a corpus property

This is the most consequential finding in the run.

| category | `wikidata` range across cities |
|---|---|
| **`activities`** | **23.5% – 65.6%** |
| **`places`** (attractions, monuments, museums) | **13.1% – 52.4%** |
| `food` | 0.0% – 2.5% |
| `nightlife` | 0.0% – 3.5% |

Peaks: **Paris `activities` 65.6%**, **Berlin `places` 52.4%**, **New York
`places` 42.9%**, **Bangkok `places` 37.9%**.

**This directly bears on the Tier 2 leverage study's premise.** The study was
scoped because *"if only 3% of the corpus exposes the join key, perfect
enrichment downstream of it still has a hard ceiling."* On the complete matrix
that ceiling is **12% overall — and roughly 40–50% on exactly the categories a
traveller browses for things to see and do.**

The reasoning behind the ruling stands unchanged: **choose the source from
evidence.** But the evidence is now different, and it points at a
**category-scoped** enrichment question rather than a corpus-wide one. A
Wikidata-keyed enrichment aimed at `places` and `activities` is not a 3%
proposition.

### 2. `neighborhood` is a NORMALISATION failure almost everywhere — not a Paris quirk

| destination | neighborhood |
|---|---|
| **Berlin** | **32.4%** |
| Cebu | 0.9% |
| New York | 0.2% |
| **Paris, Bangkok, Nairobi, Lima** | **0.0%** |

**Berlin is the only city where this field works at all.** Six of seven sit at
or near zero.

Step 6 filed Paris as a *narrow* geography adapter. **The complete matrix says
the scope was understated:** this is not a Paris-specific arrondissement quirk,
it is that the key chain (`addr:neighbourhood → neighbourhood → addr:suburb →
suburb`) matches **German** tagging convention and almost nothing else.

**That does not change the classification — it is still normalisation, not
missing data, and still not evidence for Tier 2.** But "narrow" is the wrong
word for a field that returns nothing in 6 of 7 measured cities, and the adapter
should be scoped against that fact. Recorded in
[`paris-geography-adapter.md`](paris-geography-adapter.md).

### 3. Attribute coverage collapses outside Western Europe

| | outdoor seating | wheelchair |
|---|---:|---:|
| Berlin | 32.2% | 47.0% |
| Paris | 23.9% | 25.5% |
| New York | 3.9% | 20.1% |
| Bangkok | 4.6% | 2.8% |
| Nairobi | 2.5% | 4.3% |
| Cebu | 1.8% | 1.8% |
| Lima | 0.0% | 16.2% |

**Berlin and Paris carry the aggregate.** Any decision calibrated on the 33%
figure from the partial run was calibrated on those two cities.

**`wheelchair` degrades more gracefully than `outdoor_seating`** — it holds
16–20% in New York and Lima where outdoor seating is at 0–4%. If one accessibility
signal is worth investing in, the data says it is that one.

## Cebu, and why it stays

Cebu is the flattest destination measured: **0.9% neighborhood, 1.8% on both
attributes, 0.0% wikidata, 0.0% image.** Its `activities` and `places` cells
returned **3 and 2 named places respectively.**

That is precisely why it is kept as the **low-coverage fixture** rather than
removed — *do not solve Cebu by hiding it.* It answers a question no
well-mapped city can: **does the product degrade gracefully when the source has
nothing?** See [`test-destination-fixtures.md`](test-destination-fixtures.md).

## Honest limits

- **A census of these 2121 places, not a sample of OSM.** No confidence interval
  is claimed and none should be inferred.
- **1000 m radius around one point per city** — a city-centre measurement.
  Suburban tagging density is not represented.
- **Cell sizes vary enormously** (Cebu `places` = 2; Berlin `food` = 200). A
  percentage over 2 places is arithmetic, not evidence. **Cell `n` is printed
  beside every share for exactly this reason.**
- **Mirror, not the production endpoint** — recorded above.
