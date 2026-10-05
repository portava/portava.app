# Discovery's denominator: what the 163 actually are

*Measurement only, 2026-10-04, at `f71cfb85f`. Read-only. No census verdict was moved, no
census file was edited, no code was changed, nothing was written to any database, and
production (`ajrurzioarfkagpuxfnb`) was not read. Phase 6 is out of scope and no scope
amendment was adopted here.*

## 0. The answer, first

`check:census-integrity` reports census-discovery as

> `discovery  188 rows  100 C  86 W  2 N  0 X  denom 351  163 counted where this tool cannot read`

**None of the 163 is a requirement. The 163 is not a set at all.** It is the arithmetic
`351 − 188`, where `351` is the number of **repository files census-discovery cites**, swept
into the denominator set by a regex that was looking for a percentage. There is no block of
163 prose requirements to classify, because there is no block.

The owner's hypothesis — "a misread file-count sentence" — is **confirmed**, and the
sentence is a single one. Discovery's honest denominator is **188**; its honest
correct-percentage is **100 / 188 = 53.2 %**; the corpus total is **2436 / 3518 = 69.24 %**,
which is the figure already reported. The 66.2–70.6 % band collapses, because the thing the
band was uncertainty *about* does not exist.

## 1. Where the 351 comes from — the whole provenance, in one sentence

`checkCensusIntegrity.ts` collects denominator candidates from three patterns and then takes
the largest (`artifacts/api-server/src/scripts/checkCensusIntegrity.ts:439-442#const candidates: number[] = [];`,
`artifacts/api-server/src/scripts/checkCensusIntegrity.ts:444#const statedDenominator = uniqueDenoms.length > 0`).
The third pattern is `/ NNN = <number> %`. In census-discovery it matches exactly one thing
that is not a requirement count:

> **`check:census-scope-coverage` passes: census-discovery is at 351 / 351 = 100 %, with the
> seven quoted rule sources declared NOT-GRADED.**
>
> — `docs/architecture/census-discovery.md:11723#census-discovery is at 351 / 351 = 100 %` (§64.8)

`351` is `check:census-scope-coverage`'s output. That checker prints `N cited · M watched · P%`
(`artifacts/api-server/src/scripts/checkCensusScopeCoverage.ts:255#const { counts, ambiguous, unresolved, machinery, declared, cited, uncovered, ratio } = m;`),
and `cited` is a list of **file paths** — the census's citations, minus shared machinery,
minus the paths the census declares NOT-GRADED
(`artifacts/api-server/src/scripts/lib/censusScopeCoverage.ts:153#The denominator: cited, not machinery, not declared.`,
`artifacts/api-server/src/scripts/lib/censusScopeCoverage.ts:199#const cited = all.filter(`). The citations
themselves are `path.ts`-shaped backticked strings
(`artifacts/api-server/src/scripts/lib/censusScopeCoverage.ts:68#export const CITE_RE = /`).

**The decisive corroboration is inside the same census.** The identical quantity is written a
second time, thirteen sections later, and is *invisible* to the regex because that author did
not append `= 100 %`:

> **`check:census-scope-coverage`: census-discovery at 407 / 407.**
>
> — `docs/architecture/census-discovery.md:14966#census-discovery at 407 / 407` (§77)

Run today at `f71cfb85f`, the same checker reports census-discovery at **578 cited · 578
watched · 100 %**. So one quantity — how many files this census cites — is stated three times
in the corpus as 351, 407 and 578, and precisely one of those statements, the one that happened
to carry a percent sign, became Discovery's denominator. A requirement population does not
grow because somebody adds a footnote citing a file.

### 1.1 Demonstrated, not argued

Run against a scratch copy of all thirteen censuses with that one sentence's `= 100 %`
re-worded and nothing else changed (`CENSUS_INTEGRITY_DIR`, the tool's documented test seam,
`artifacts/api-server/src/scripts/checkCensusIntegrity.ts:111#const CENSUS_DIR = process.env.CENSUS_INTEGRITY_DIR`):

| | denom reported | gap reported | corpus gap |
|---|---|---|---|
| real corpus at `f71cfb85f` | 351 | 163 | 163 |
| same corpus, that one sentence re-worded | **188** | **0** | **0** |

Discovery is the **only** census in the corpus with a non-zero gap. The corpus-wide "163
requirements counted somewhere this tool cannot read" is Discovery's 163 and nothing else.

## 2. The five declared denominators, one verdict each

| stated | what it is | verdict |
|---|---|---|
| **67** | §1/§2d: the first population — `A01–A25` (inbound obligations) + `B01–B09` (shared with Input Intelligence) + `C01–C33` (Discovery's own code contracts). `docs/architecture/census-discovery.md:31#The 67 rows below come from three sources`; tallied at `docs/architecture/census-discovery.md:145#CONSTRUCTED = (46+11)/67 = ` | **real, superseded.** A genuine requirement population, replaced by 153 |
| **153** | §11.3: the 67 **plus** the 82 restored-package rows **plus** the four DSV2 rows that are SPLITs. `docs/architecture/census-discovery.md:737#CONSTRUCTED 109 / 153 = 71.2 %`; the four splits at `docs/architecture/census-discovery.md:726#The only four of the twelve DSV2 requirements` | **real, superseded** |
| **187** | §14.6: the 153 plus 34 `DC-` rows. `docs/architecture/census-discovery.md:1933#CONSTRUCTED 141 / 187 = 75.4 %` | **real, superseded** |
| **188** | §28.1: the 187 plus `DV-83`. `docs/architecture/census-discovery.md:3785#Population 187 → 188.` Declared as *the* population at `docs/architecture/census-discovery.md:3997#The four buckets sum to 188 exactly, and every requirement in` | **real and CURRENT. This is the one to use.** |
| **351** | §64.8's report of `check:census-scope-coverage` — a count of **cited files** | **not a requirement count at all. Its presence in the denominator set is a bug in the tool's candidate regex, surfacing as a document defect** |

Why **188** and not one of the others: the census states it as the current population, the
sixty-plus restatements after §29 all read `/ 188` and say "the denominator is unchanged", and
— the strongest reason — the 188 is a **closed, gapless enumeration** (§3). 67, 153 and 187
are the same population measured before it finished being assembled; they are smaller, so they
can never be the right answer to "how many requirements are there now".

## 3. The 188 is closed and gapless, so there is no room for 163 more

Dumped from the parser itself (`CENSUS_INTEGRITY_DUMP=ALL`) and checked for holes:

| series | count | range | missing ids inside the range |
|---|---|---|---|
| `A01`–`A25` | 25 | contiguous | none |
| `B01`–`B09` | 9 | contiguous | none |
| `C01`–`C33` | 33 | contiguous | none |
| `DV-1`–`DV-83` | 83 | contiguous | none |
| `DC-1`–`DC-34` | 34 | contiguous | none |
| `DSV2-` | 4 | `04`, `05`, `06`, `12` | `01`–`03`, `07`–`11` — ruled DUPLICATE, see §4 |
| **total** | **188** | | |

This reconciles to the document's own construction exactly: 67 (A+B+C) + 82 restored-package
rows + 4 DSV2 splits = 153; + 34 `DC-` rows = 187; + `DV-83` = 188. Every id the census
numbers has a verdict, and every verdict belongs to a numbered id. A population of 351 would
require 163 ids that no series contains.

## 4. Every candidate for "an uncounted requirement", classified individually

The 163 cannot be enumerated, so the honest thing is to enumerate what *could* have been
mistaken for it and give each item a verdict. There are three candidate pools, and all of them
are accounted for below. **Nothing in any of them is an uncounted requirement.**

### 4.1 The one sentence that produces the 351 — 1 item

| item | what it actually counts | verdict |
|---|---|---|
| §64.8's "351 / 351 = 100 %" | files census-discovery cites, as measured by `check:census-scope-coverage` | **a file count. Not a requirement. Not in the denominator.** |

### 4.2 The eight DSV2 ids with no verdict row — 8 items

§11.4 rules each of the twelve DSV2 obligations individually
(`docs/architecture/census-discovery.md:763#Eight DUPLICATE, four SPLIT, none a pure ADDITION`).
The four SPLITs became rows and are in the 188. The eight DUPLICATEs did not, **on purpose**,
and each names the row it duplicates:

| item | duplicate of | verdict |
|---|---|---|
| `DSV2-01` | `A02` | **duplicate of a row already counted in the 188** |
| `DSV2-02` | `A01` | **duplicate** |
| `DSV2-03` | `A05` | **duplicate** |
| `DSV2-07` | `DV-06`, `DV-07`, `DV-37`, `DV-46`, `C25` | **duplicate** |
| `DSV2-08` | `A04` | **duplicate** |
| `DSV2-09` | `A07` | **duplicate** |
| `DSV2-10` | `DV-53`, `DV-54`, `DV-55`, `DV-32` | **duplicate** |
| `DSV2-11` | `DV-08` (+ `A06`, `C20`, `C22`, `C23`, `C24`) | **duplicate** |

§11.3 states the refusal in its own words: it does not replace the existing denominator and it
does not count one feature twice. That is exactly right, and it is why these eight are not
rows.

### 4.3 The 759 id-keyed rows carrying no verdict — 337 distinct ids

The tool prints these per census and does not count them. Of the 337 distinct ids in them,
**zero** are requirements; every one is the row label of a different kind of table. Classified
by the table that holds them:

| count | what the id actually is | verdict |
|---|---|---|
| 280 | a **mutation-case number** in a mutation-testing table (`# \| mutation \| red`, `id \| mutation \| red`, `# \| file \| mutation \| red`, …) — 131 + 102 + 100 + 73 + 59 + 56 + … rows of kill-matrix bookkeeping | **not a requirement: a test-mutation case** |
| 23 | a mutation-case number that also appears in a test/decision/lane ledger | **not a requirement** |
| 14 | a **work-package label** in `package \| status \| row \| first blocker class \| requirement` (`docs/architecture/census-discovery.md:7125#first blocker class` — `P1 Search safety`, `P2 Ranking & cache correctness`, …). The real census id is in the `row` column and is already in the 188 | **not a requirement: a work-package name** |
| 8 | the DSV2 DUPLICATE rulings of §4.2 | **duplicate** |
| 5 | a row label in a test/decision/lane ledger | **not a requirement** |
| 6 | a package label that also appears in a mutation table | **not a requirement** |
| 1 | `NOT-BUILT` — the §2d tally's **bucket name**, read as a named id by the parser's `[A-Z]{1,4}-[A-Z]{2,8}` grammar (`docs/architecture/census-discovery.md:137#A (inbound)`) | **not a requirement: a bucket label** |
| **337** | | **0 real requirements** |

The remaining non-verdict rows are re-read logs and probe tables (`row \| verdict \| the probe,
and what it showed`, `row \| says \| actually`, `id \| verdict \| the sentence that was false`)
whose ids are **already in the 188** — they carry no parseable verdict because the verdict sits
in a prose cell, not because the requirement is missing.

### 4.4 Prose that enumerates several requirements in one paragraph — 0 items

This is the thing the tool's gap number was designed to describe
(census-highlights-memories' "eleven of the seventeen operations … each is BBW"). **In
census-discovery there is none.** The census says so itself, in the section that declared the
188:

> **The four buckets sum to 188 exactly, and every requirement in that denominator was parsed
> — there is no prose gap here for a discrepancy to hide in.**
>
> — `docs/architecture/census-discovery.md:3997#The four buckets sum to 188 exactly, and every requirement in` (§29.4)

That sentence was written at §29. The 351 entered the corpus at §64, thirty-five sections
later, and manufactured the prose gap the census had already correctly denied having.

## 5. The count

| | |
|---|---|
| of the 163, **real enumerated requirements** | **0** |
| of the 163, **not requirements** | **all of them**, and they are **one number**: a count of 351 cited files |
| of the 163, **duplicates of rows already in the 188** | 0 (the 8 DSV2 duplicates are a separate pool, not part of the 163) |
| of the 163, **unresolvable** | 0 |
| **Discovery's honest denominator** | **188** |
| **Discovery's honest correct-percentage** | **100 / 188 = 53.2 %** |
| **Discovery's honest constructed-percentage** | **186 / 188 = 98.9 %** |

## 6. The corpus total on that basis

Recomputed from `check:census-integrity`'s own per-census rows at `f71cfb85f`:

| | C | rows |
|---|---|---|
| compass | 126 | 141 |
| **discovery** | **100** | **188** |
| highlights-memories | 69 | 266 |
| input-intelligence | 294 | 373 |
| layover | 83 | 296 |
| map | 238 | 293 |
| media | 408 | 450 |
| passport | 158 | 169 |
| sensing | 113 | 127 |
| telegraph | 239 | 451 |
| trips | 320 | 451 |
| trust | 89 | 108 |
| wall | 199 | 205 |
| **total** | **2436** | **3518** |

- **Corpus CORRECT = 2436 / 3518 = 69.24 %.** This is the already-reported 69.2 %.
- The band it was reported with is reproducible and now void: treating the 163 as
  not-correct requirements gives `2436 / 3681 = 66.18 %`; treating them as correct gives
  `2599 / 3681 = 70.61 %`. Both arms rest on the file count.
- **Nothing in the headline figure moves.** The value of settling this is that the one part of
  the figure the repo admitted was unknown is no longer unknown, and the stated uncertainty was
  never real.

## 7. A consequence to know before anyone "fixes" the 351

With 351 out of the candidate set, parsed rows (188) equal the denominator (188), and that is
the condition under which the headline check fires
(`artifacts/api-server/src/scripts/checkCensusIntegrity.ts:537#if (r.statedDenominator !== null && parsedTotal === r.statedDenominator && r.statedHeadline) {`).
Measured on the scratch copy, it fires immediately:

> `census-discovery.md: its stated headline is C 101 / W 85 / N 2 / X 0 but its own rows count
> C 100 / W 86 / N 2 / X 0.`

This is **not** census drift. §98.8's four-bucket block says `101`
(`docs/architecture/census-discovery.md:16547#BUILT-AND-CORRECT`), and §98.9 — the integrator,
the *later* statement — moves `DV-83` back to `W` and says so in prose:

> **Headline at this head, from the rows: C 100 / W 86 / N 2 / X 0 over 188.**
>
> — `docs/architecture/census-discovery.md:16570#Headline at this head, from the rows`

The rows and the document's last prose statement agree at **100**. The tool reads only
four-bucket *table* blocks as headlines, and §98.9 wrote its correction as a sentence. So the
351 artifact is currently **masking** a formatting mismatch, and removing the artifact without
restating §98.9's headline as a block would turn `check:census-integrity` red for a reason that
is purely typographic. This document does not make that edit: PRs #593 and the
remaining-surfaces re-census own the `census-*.md` files.

## 8. Unknown

- **Whether the §64.8 run printed exactly `351`.** The sentence names the tool, the tool counts
  files, and the same quantity is written as `407` at §77 and measures `578` today — but `351`
  itself is not re-derived here. It would be settled by running
  `check:census-scope-coverage` at `9b7438baf`, the commit that added the sentence
  (`git log -S`), in a checkout of that tree. Nothing in this document's conclusion depends on
  the exact value: any count of cited files is the wrong kind of number for a denominator.
- **Whether any of the 188 verdicts is right.** Out of scope and unmeasured here. No guard in
  this repository establishes it, and `check:census-integrity` says so about itself.
- **Whether 188 is the *complete* set of things Discovery must do.** It cannot be known:
  Discovery has no spec, the population is assembled from three sources plus a restored
  package, and §11.7 names where the specification is genuinely incomplete. 188 is the honest
  denominator *of this census*; it is not a claim that Discovery has 188 obligations in the
  world.
- **Whether `69.24 %` is a meaningful corpus figure.** It is an unweighted count of C rows over
  all parsed rows in thirteen documents whose populations were assembled independently and
  whose verdicts are, in large part, each surface grading its own homework. It is arithmetic on
  the censuses, not a measurement of the product.
- **Whether other censuses could acquire the same defect.** Today none has: the other twelve
  all report a gap of 0, so for each of them the largest stated number *is* the population. An
  artifact that is *smaller* than the true population is harmless, because the tool takes the
  largest. Only an artifact that is larger can do this, and only Discovery has one.

## 9. What would turn this document wrong (P24)

- **A real prose-enumerated requirement found in census-discovery.** §4.4 rests on the census's
  own §29.4 sentence plus the gapless series in §3. One paragraph scoring requirements that no
  `A`/`B`/`C`/`DV-`/`DC-`/`DSV2-` id covers would falsify it. Searched for and not found.
- **An id in the 188 that is not a requirement**, or two ids that are the same requirement under
  different names. That would make 188 too *large*, not too small, and would lower 53.2 %.
- **The DSV2 duplicate rulings being wrong.** §11.4 gives each of the eight a named target row;
  if any target does not in fact cover the obligation, that DSV2 row is a real uncounted
  requirement and the denominator is 189 or more. Each ruling is reviewable in §11.4; this
  document accepts them as stated and did not re-grade them.
- **The candidate regex changing.** If `artifacts/api-server/src/scripts/checkCensusIntegrity.ts:442#candidates.push(Number(m[1]));` is narrowed so a percentage
  sentence can no longer become a denominator, §1's finding becomes historical rather than
  current — and §7's consequence arrives with it.

## 10. Verification run at `f71cfb85f`

- `check:census-integrity` — PASSED (and reports the 163 described above).
- `check:census-scope-coverage` — PASSED; census-discovery at 578 cited · 578 watched · 100 %.
- `check:doc-citations` — RESULT clean.
- `check:census-policy-citations` — PASSED.
- Not run: anything against `portava-ci` or production. No database was read or written.
