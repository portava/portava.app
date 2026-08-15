# The measurement-system rulings — what Tier 1 was actually for

**GOVERNING. 2026-08-15, from the owner.** Follows
[`place-intelligence-owner-rulings.md`](place-intelligence-owner-rulings.md),
which it does not supersede.

---

## THE FRAMING — recorded verbatim, because it reframes what Tier 1 was for

> **The key outcome is NOT 33%. It is that you have now built a MEASUREMENT
> SYSTEM capable of telling you where the information deficit actually is.
> Exploit that before building the next supply layer.**

This is a correction to the natural reading of the coverage findings, and it
changes what happens next. The obvious response to "33% of places carry outdoor
seating" is to go and find a source for the other 67% — **that is building the
next supply layer, and it is exactly what this defers.**

The instrument is the asset. Every item below is an exploitation of it:
completing the matrix that was only partly run, fixing a mismatch the
measurement exposed, changing a test city the measurement proved unrepresentative,
and separating a normalisation defect from an enrichment decision it would
otherwise have contaminated. **None of them adds a provider.**

---

## THE SEQUENCE

### STEP 1 — Republish #66–#85. Authorised; the owner presses it.

**The verification is re-run IMMEDIATELY BEFORE, not earlier the same day.**
The rule is immediately-before, and a check from hours ago is not that check.

**The supply-path condition set previously is MOOT and is formally retired
here.** Its purpose was to stop Tier 1 starting from a baseline it was about to
modify. That cannot happen now for two reasons: **#83–#85 *are* the supply
path**, and **Tier 1's coverage was measured against real Overpass data rather
than the deployed build**, so the deployed build was never an input to the
measurement. Nothing couples them.

### STEP 2 — Apply migration `2095`, immediately after the republish verifies.

**Full discipline, even though an empty table makes the data risk tiny.** The
discipline is not proportional to the risk of this migration; it is the practice
that makes the next one safe. Required in order:

1. snapshot and **before-state**
2. the **sanctioned migration path**
3. **after-state and schema verification**
4. **ONE REAL photo-resolution and persistence proof, end to end**

Step 4 is the one that cannot be skipped or simulated. A created table proves a
migration ran; it does not prove a photo was ever stored. **A zero-row table is
indistinguishable from a table nothing writes to** — this workstream's own
invariant, and the reason an end-to-end proof is part of applying rather than a
follow-up.

**Staged by the agent, executed by the owner.**

### STEP 3 — Run the COMPLETE coverage matrix: all 7 destinations × 4 categories.

**This outranks starting any new feature.**

> **PRESERVE THE PER-CITY AND PER-CATEGORY NUMBERS ALONGSIDE THE AGGREGATE. The
> result must NOT be reduced to one percentage.**

This is the ruling's own guard against the failure the partial matrix already
demonstrated: the aggregate said 15.2% neighbourhood coverage while Berlin was
at 50.0% and Paris at 0.0%. **The aggregate was true and useless.** A single
percentage cannot say where the information deficit is, which is the whole point
of having the instrument.

**On the endpoint:** if `overpass-api.de` stays unreachable from the workspace,
**use the mirror and pace it rather than treating the gap as blocking.** The
mirror is the same OSM database, and **a complete matrix from the mirror beats a
partial one from the canonical host.** Record which endpoint produced the
numbers.

### STEP 4 — Fix the seed/live neighbourhood mismatch. AHEAD of Tier 2.

`seed-discovery-places.ts` and the live route **must represent the same place
shape.** They currently resolve `neighborhood` through different key chains.

**Why it outranks enrichment:** a divergence between the seeded and live shapes
means QA produces **both false regressions and false confidence** — the same
place looks different depending on which path produced it, so a real defect and
a path difference are indistinguishable. Every measurement taken across both
paths inherits that ambiguity.

### STEP 5 — Change the default test city away from Cebu. KEEP Cebu.

> **Do not solve Cebu by hiding it.**

Cebu measured ~2% on the Tier 1 attributes and 0% on wikidata and image. As the
default test city that made enrichment work look like no work at all. But
removing it would discard the only low-coverage case in the fixture set.

**Two standing tests are wanted, and they ask different questions:**

| | |
|---|---|
| **Does enrichment work when the source has data?** | a high-coverage fixture |
| **Does the product degrade gracefully when it does not?** | **Cebu, kept explicitly as the low-coverage fixture** |

### STEP 6 — Paris is a NORMALISATION problem, filed separately.

Paris returning **0.0%** neighbourhood is arrondissement tagging semantics.

> **It is NOT evidence Tier 1 failed and NOT evidence for Tier 2.**

Filed as a **narrow geography adapter** specifically so it does not contaminate
the enrichment decision. Left in the enrichment bucket, a normalisation defect
would present as missing data and argue for a provider that would not have fixed
it — buying an external dependency to solve a mapping problem we already have
the data for.

---

## TIER 2 — NOT AUTHORISED AS A PROVIDER INTEGRATION

What **is** authorised, and only after the steps above, is a **TIER 2 LEVERAGE
STUDY**. Not an integration, not a spike, not a prototype behind a flag — a
study, answering:

- which **missing card fields actually matter**
- which **sources could supply them**
- **matchability WITHOUT Wikidata ids**
- **expected incremental coverage**
- **latency and cost**
- **whether results can be persisted into the corpus**

**The 3.2% wikidata figure is the reason this is a study rather than a build.**
If only ~3% of the corpus exposes the join key, then **perfect enrichment
downstream of it still has a hard ceiling of 3%.** The enumeration called
`wikidata` the highest-leverage Tier 1 tag and it was right about leverage per
place — but the measurement showed the population it applies to, and that is a
different question. Which is the framing ruling in miniature: **the instrument
changed the answer.**

> **Choose the source from evidence, not architecture aesthetics.**

---

## STILL PARKED — unchanged

**Phase B. Ranker work. Tier 3. The photo non-goals** (crawling, bulk
enrichment, multiple candidates per place, quality scoring, cross-provider
deduplication, pre-populating cities).

> **The corpus remains the constraint. Ranking two-thirds of structurally thin
> places more intelligently does not create information.**

That sentence is the reason the ranker hold is not merely a sequencing
preference. A better ranker over a corpus that does not carry the facts cannot
recover them; it can only reorder places it knows nothing about with more
confidence.
