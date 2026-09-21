# How "spec-attributable" is derived

**Owner ruling, 2026-09-14.** *Keep historical "spec-attributable" provenance separate from
compliance. Do not infer that code wasn't built from a spec merely because it predates the
spec's repository upload; mark attribution unknown where evidence is missing.*

This file states the rule once so the next census does not rediscover it. It changes **no
verdict**: attribution and compliance are different questions and this document has nothing to
say about the second one. A row can be BUILT-AND-CORRECT with unknown attribution, and a row can
cite this spec in its header and still be BUILT-BUT-WRONG — both are common in this corpus.

---

## 1. The three values

Every BUILT verdict carries exactly one of these. There is no fourth value and no default of
zero.

| value | what it means | what establishes it |
| --- | --- | --- |
| **attributable to this spec** | the artifact was written for the specification this census measures | the artifact's own text names this specification — its path, or its name plus its section numbering |
| **attributable elsewhere** | the artifact was written for a different, identifiable programme | the artifact's own text names that other specification or programme, in the same form |
| **attribution unknown** | nobody has evidence either way | this is the **default**. Every row starts here and leaves only on evidence |

## 2. What counts as evidence

**Positive evidence, in the artifact itself.** A header block, comment or migration preamble
that names a specification and, ideally, the sections it implements. Three worked examples from
this tree, strongest first:

- A spec **path**: `artifacts/api-server/src/lib/memoryCommandBus.ts:4#Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`,
  followed by the sections it implements. Unambiguous — one file, one document.
- A spec **name plus its own section numbering**:
  `artifacts/api-server/src/lib/mapProducers/worldPulseProducer.ts:2#worldPulseProducer`, whose
  same line reads *"the `world_pulse` kind (Map spec §36 Phase 7)"*. The document is named, so
  the section resolves.
- A **programme** that describes itself, where the artifact points at a document that does:
  `artifacts/api-server/src/migrations/2260_availability_windows.sql:3#Open-to-Plans / Temporary Intent (Passport spec §8, TABLE 7/8/10)`.

**A migration band or programme id counts** when the census declares the band up front and the
band is the programme's own (census-media.md's `2250`–`2257`, `2300`; the Intelligence Gathering
buildout's unit→file→migration table). It is weaker than a header and should be said to be.

## 3. What does not count

**Dates, in any form.** "The spec entered the repository on 2026-09-07 and this file predates
it", "the PR landed five hours before the spec file was committed", "predates every architecture
document in `docs/specs/`" — none of these is evidence about what an author was working from. A
specification can be written, circulated, argued over and implemented for months before anyone
commits a copy here. Predating the upload is consistent with having been built from the spec and
with never having heard of it, so it separates nothing. This is the specific inference the owner
ruled out.

**An absence of citation, read as a positive finding.** "No file cites this spec" is a real
measurement and worth reporting; "therefore nothing was built for this spec" is not what it
shows. A team can implement a document faithfully and cite nothing. Absence of evidence for
*attributable to this spec* is not evidence for *attributable elsewhere*; it is
**unknown**.

**A bare section number with no document.** `LiveForYouService.ts:2#LiveForYouService` reads
*"the small, bounded, personalized live strip (spec §4)"* — which spec? The programme is being
read off the directory the file sits in. That is a good inference and worth recording as
*likely-elsewhere, unconfirmed*; it is not a citation.

**This census's own say-so.** A row that reads "pre-existing work for another spec" with no
artifact quoted is an assertion, not a measurement, and belongs in **unknown** until someone
opens the file.

## 4. UNKNOWN is the answer, not a gap in the answer

A census that reports a large unknown column has measured something true. The failure modes are
the two attempts to avoid it:

- **Filling it with zero.** "0 % spec-attributable" stated as "nothing was built for this spec"
  claims knowledge the evidence does not carry.
- **Filling it with a guess.** census-trips.md §36.4 refused to do this — it **withdrew** a
  falsified 0.0 % rather than substitute an estimate, and that is the model. Withdrawn-and-not-
  restated and attribution-unknown are the same state said two ways.

An unknown becomes known the moment someone opens the artifact and finds a header, or finds
none. Nothing else — not a date, not a commit order, not a plausible story about who was working
on what — moves a row out of it.

## 5. Reporting shape

State attribution as three numbers over a stated denominator, never as one percentage:

> *attributable to this spec N · attributable elsewhere M · attribution unknown K, of C
> BUILT-AND-CORRECT rows (denominator D)*

and say which of the three were measured per-row and which were measured over a group. Where a
census has evidence for one value and not the others — the common case — report the evidenced
one and put the whole remainder in **unknown** rather than splitting it by argument.

## 6. Boundary

**Attribution moves no verdict.** Finding that a BUILT-AND-CORRECT row's artifact cites a
different spec does not make the requirement less satisfied; finding that an artifact cites this
spec does not make it more so. If a compliance verdict looks wrong while auditing attribution,
report it and leave it — a different pass, with the code open, moves verdicts.

---

## 7. The corpus as it stands, 2026-09-14

Every attribution claim in the thirteen `docs/architecture/census-*.md` was read and classified
by METHOD. Counts are over each census's own BUILT-AND-CORRECT column, as that census last
stated it, against its own denominator. **No verdict and no CONSTRUCTED/CORRECT figure was
changed by this pass**; only attribution labels and the reasoning behind them.

| census | C | denom | to this spec (evidenced) | elsewhere (evidenced) | unknown | method found |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| compass | 89 | 126 | — | — | — | makes no attribution claim |
| discovery | 65 | 153 | — | — | — | makes no attribution claim |
| highlights-memories | 52 | 266 | 37 | 0 | 15 | headline was dates (c); A.6 and later sections are in-file headers (a) |
| input-intelligence | 262 | 373 | 239 | not counted | 23 less the uncounted | in-file headers (a); the 23 exclusions mixed (b) and (c) |
| layover | 61 | 296 | 34 | not counted | 27 less the uncounted | spec-path headers (a); §2's programme table (b); the 0/296 conclusion was (c)/(d) |
| map | 237 | 293 | 226 (222 on the stricter re-measure) | 11 | 2 | in-file headers both ways (a)+(b) — the strongest in the corpus |
| media | 297 | 450 | 226 | 0 | 71 | headers + declared migration band (a); the "pre-existing" class was (c) |
| passport | 157 | 169 | — | — | — | makes no attribution claim |
| sensing | 98 | 127 | unreconciled (0, 2 and 12 all stated) | the four-programme table (b), 2 of 4 rows weak | the remainder | (b) for the table; the headline row was (d) and is withdrawn; the PR #475 dating was (c) |
| telegraph | 209 | 451 | 0 | not counted | the remainder | (a)-negative grep + (b) table; pillar 2 was (c) and is withdrawn |
| trips | 89 | 451 | ≥1 (migration `2420` cites the spec) | 4 of 5 programme-table rows | not measured — WITHDRAWN | (b) for four rows, (c) for the spine row; the figure was correctly withdrawn |
| trust | 72 | 93 | — | — | — | makes no attribution claim |
| wall | 199 | 205 | — | — | — | makes no attribution claim |

**Corpus totals, stated only where they are countable.** Eight censuses make an attribution
claim; five make none at all. Of those eight, **762 BUILT-AND-CORRECT rows carry positive
evidence of attribution to their own spec** (37 + 239 + 34 + 226 + 226, plus sensing's
unreconciled figure and trips' unmeasured one). **13 carry positive evidence of attribution
elsewhere and are counted as such** (map's 11, plus the two named in the telegraph and sensing
tables that resolve to a single artifact each); every other elsewhere-claim in the corpus names
an artifact family without mapping it to rows, so it cannot be totalled and is not. **Everything
remaining in those eight censuses is attribution UNKNOWN** — at minimum 15 + 23 + 27 + 2 + 71 =
**138 rows**, plus the whole of telegraph's 209, sensing's 98 and trips' 89 that no pass has
classified per row.

The one number worth carrying forward: **no census in this corpus has ever measured the
elsewhere column per row.** Attribution has been measured in one direction — does this artifact
cite MY spec — and the other direction has been inferred. That is why the unknown column is the
large one, and saying so is the honest form of the finding.
