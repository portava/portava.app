# The reconciled baseline — 2026-09-14

> **⚠ v1 IS SUPERSEDED BY v2 IN §9. READ §9 FIRST.**
> v1's numbers are preserved below unchanged, because the owner asked that
> version history not be rewritten. **Two v1 statements are corrected in §9.2
> and §9.3 and must not be quoted from §1 or §2.1:** the headline counts, and
> the claim that nine `CPV2` clauses are UNGRADED. **Nothing in the corpus is
> ungraded. That claim was wrong.**

## v1 — 2026-09-14 (superseded)

One record covering **every** requirement in the corpus, including the 24 no
tool could previously read. Produced on the owner's instruction to stop moving
the headline and start keeping a stable record.

| | |
|---|---|
| `head_commit` | `887ef4a81` on `claude/sweet-fermat-fmx7up` |
| Previous baseline | `dd8ec0afe` — the `2,142 / 3,429 = 62.5 %` figure |
| Method | `check:census-integrity` (canonical parser) + the prose gap resolved by hand, row by row, in §2 |
| Verified by | `CENSUS_INTEGRITY_DUMP=ALL`, diffed old-vs-new under last-statement-wins (§4) |

---

## 1. The reconciled totals

Every requirement is in exactly one column. Nothing is counted twice and
nothing is dropped.

| | count | of 3,517 |
|---|---:|---:|
| **C** — built and correct | **2,165** | 61.6 % |
| **W** — built but wrong | **889** | 25.3 % |
| **N** — not built | **423** | 12.0 % |
| **X** — cannot verify | **31** | 0.9 % |
| **UNGRADED** — no verdict exists | **9** | 0.3 % |
| **TOTAL** | **3,517** | 100 % |

- **CONSTRUCTED** (C+W) = 3,054 / 3,517 = **86.8 %**
- **CORRECT** (C) = 2,165 / 3,517 = **61.6 %**
- **GRADED** = 3,508 / 3,517 = **99.7 %**

The canonical parser reads 3,493 of the 3,517 rows and reports
`C 2,164 · W 889 · N 409 · X 31`. §2 resolves the remaining 24 by hand and
adds `C +1 · N +14 · UNGRADED +9`. **That is the whole difference between what
the tool can prove and what this document states**, and it is enumerated
rather than asserted.

### Per census

| census | parsed | C | W | N | X | ungraded | denom | constructed | correct |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compass | 132 | 93 | 32 | 5 | 2 | **9** | 141 | 88.7 % | 66.0 % |
| discovery | 184 | 74 | 67 | 43 | 3 | 0 | 187 | 75.4 % | 39.6 % |
| highlights-memories | 266 | 56 | 131 | 77 | 2 | 0 | 266 | 70.3 % | 21.1 % |
| input-intelligence | 373 | 262 | 55 | 52 | 4 | 0 | 373 | 85.0 % | 70.2 % |
| layover | 296 | 61 | 136 | 99 | 0 | 0 | 296 | 66.6 % | 20.6 % |
| map | 293 | 237 | 46 | 5 | 5 | 0 | 293 | 96.6 % | 80.9 % |
| media | 450 | 297 | 83 | 68 | 2 | 0 | 450 | 84.4 % | 66.0 % |
| passport | 169 | 157 | 10 | 1 | 1 | 0 | 169 | 98.8 % | 92.9 % |
| sensing | 127 | 98 | 26 | 2 | 1 | 0 | 127 | 97.6 % | 77.2 % |
| telegraph | 439 | 229 | 158 | 61 | 3 | 0 | 451 | 85.8 % | 50.8 % |
| trips | 451 | 320 | 128 | 3 | 0 | 0 | 451 | 99.3 % | 71.0 % |
| trust | 108 | 82 | 17 | 7 | 2 | 0 | 108 | 91.7 % | 75.9 % |
| wall | 205 | 199 | 0 | 0 | 6 | 0 | 205 | 97.1 % | 97.1 % |
| **TOTAL** | **3,493** | **2,165** | **889** | **423** | **31** | **9** | **3,517** | **86.8 %** | **61.6 %** |

`parsed` is how many rows the canonical tool reads. The **C/W/N/X/ungraded
columns are reconciled totals** — they include that census's prose-counted
requirements from §2, which is why they sum to `denom` rather than to `parsed`.
**Every row sums to its own denominator**, which is the defect the owner asked
to have fixed. Only compass (9), discovery (3) and telegraph (12) have a prose
gap at all; for the other ten, `parsed` = `denom`.

---

## 2. The 24 the parser cannot read — each one named

These were previously reported only as a count. They are identified here
individually, with how each was found, so they can never again be an
unexamined residue. **Three different causes, and only one of them is a
genuinely ungraded requirement.**

### 2.1 Compass — 9 requirements, genuinely UNGRADED

The owner's Compass v2 specification states twelve clauses, `CPV2-01`…`CPV2-12`.
Three of them are graded because a Compass row carries the same obligation and
the census pairs them explicitly — `CX-06/CPV2-05`, `CPH-11/CPV2-06`,
`CPH-12/CPV2-07`. The other **nine have no verdict anywhere**:

> **CPV2-01, CPV2-02, CPV2-03, CPV2-04, CPV2-08, CPV2-09, CPV2-10, CPV2-11, CPV2-12**

Found by dumping the 132 ids the parser reads and subtracting them from every
id-shaped token in the census: exactly twelve `CPV2` ids appear in the document
and none is parsed; three carry a paired row's verdict; 12 − 3 = 9, which is
the gap the tool computes independently. **These nine are the only requirements
in the entire corpus with no verdict of any kind.**

### 2.2 Discovery — 3 requirements, GRADED, unparseable for a stated reason

census-discovery §12.3 names them and says why: a `DSV2-nn` id inside a verdict
table risks parsing as a line RANGE, so they were written in prose.

| id | verdict |
|---|---|
| `DSV2-04` | **N** |
| `DSV2-05` | **C** |
| `DSV2-12` | **N** |

Folded into §1 as `C +1 · N +2`.

### 2.3 Telegraph — 12 requirements, GRADED **N**, unparseable for a stated reason

census-telegraph (lines 286–292) marks twenty-one NOT-BUILT verdicts `∅` —
*unguarded absence*: the forbidden path does not exist, but nothing prevents it
being added, so the guarantee "is not constructed; it is merely currently
unviolated." Nine of the twenty-one also appear as ordinary parsed rows. The
twelve that exist **only** as `∅` marks are the gap:

> **T1, T26, T212, T366, T367, T393, T404, T405, T406, T408, T416, T446**

Folded into §1 as `N +12`. The census states the counterfactual itself: a reader
who credits vacuous satisfaction would move all twenty-one to C, giving
telegraph CORRECT 26.4 % rather than crediting them. **This census does not
credit them and neither does this baseline.**

---

## 3. Verified compliance · unresolved · production availability

The owner asked for these three kept apart. They are three different questions
and the same row can sit differently in each.

### 3.1 Verified compliance — what the code satisfies

**2,165 of 3,517 requirements (61.6 %)** are graded C: the code satisfies the
requirement and a citation says where.

This is a statement about the **branch tree**, not about a running system, and
it carries one honesty qualifier the lanes recorded themselves: a C verdict
means *a lane read the code and the code satisfied the clause*. It does not
mean the row was re-executed this pass. census-compass states the sharpest
version — only **12 of its 59 mapped requirements were re-executed**; the other
47 are marked *carried, not re-verified*.

### 3.2 Unresolved — 1,352 requirements

| | count |
|---|---:|
| **W** — built, incorrect | 889 |
| **N** — not built | 423 |
| **X** — cannot verify | 31 |
| **UNGRADED** — no verdict | 9 |
| **TOTAL UNRESOLVED** | **1,352** |

Concentration matters more than the total. Four censuses hold 63 % of all W:
telegraph 158, layover 136, highlights-memories 131, trips 128. Two censuses
hold 42 % of all N: layover 99 and highlights-memories 77.

### 3.3 Production availability — **zero rows have been graded against production**

This is the separation that matters most and the one most easily lost.

| fact | measured |
|---|---|
| Commits on this branch not in `main` | **337** |
| Files differing between `origin/main` and this branch | **1,040** |
| Migrations on this branch not in `main` | **32** (`2778`…`2870`) |
| Those 32 migrations applied to **portava-ci** | **0** — ledger's newest is `2777` |
| Those 32 migrations applied to **production** | **0** |
| PR #483 (`sweet-fermat` → `portava-continuation-uqta94`) | **open** |
| PR #482 (`portava-continuation-uqta94` → `main`) | **open, draft** |

Every one of the 3,493 parsed rows was graded against the branch. **No census
has ever been run against `main`, and none against a deployed system.**

A row-level bound, computed from the canonical parse (each row's verdict line
re-read for backticked file citations, matched against the 1,040 changed
files):

> **788 of the 2,164 parsed C rows (36.4 %) cite at least one file that exists
> only in its branch form.** Those rows cannot be claimed for production
> without being re-read against `main`.

Read that as an upper bound on *claimable*, not a lower bound on *broken*: a
row citing a changed file may still hold on `main`. The remaining 1,376 C rows
are not thereby production-realized either — they are merely not *provably*
branch-dependent from their citations.

**A second finding fell out of the same measurement, and it is a defect in the
record rather than in the product: 644 C rows carry no backticked file citation
on the verdict line at all.** census-trips alone holds 235 of them. Those rows
may well be correct and their evidence may sit in prose above the table, but as
written they cannot be machine-checked against any tree. Backlog item **B7**.

> BUILT ON BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG
> ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.

---

## 4. Every change since the previous baseline, classified

The previous baseline was `2,142 / 3,429` at `dd8ec0afe`. The delta was measured
by dumping every verdict at both commits and comparing them under
last-statement-wins — not by reading the lanes' reports and believing them.

| classification | rows |
|---|---:|
| **Code fix** — a verdict moved because the code changed | **0** |
| **Corrected assessment** — a verdict moved because the earlier reading was wrong | **0** |
| **Added scope** — requirements the census had never enumerated | **64** |
| **Accounting correction** — the same requirements counted differently | **0** |

```
old unique ids = 3429      new unique ids = 3493
VERDICT MOVES among ids present in both:   0
ADDED ids:    64   (compass 15, discovery 34, trust 15)
REMOVED ids:   0
```

**Zero verdicts moved and zero rows disappeared.** The corpus CORRECT figure went
`62.5 % → 61.6 %` and not one point of that is code regressing. The population
widened by 64 requirements that were always obligations of the owner's specs and
had simply never been written down; 42 of the 64 arrived already non-C
(`W 29 · N 9 · X 4`), which is what pulls the percentage down.

The same effect inside the three censuses, in their own words:

- **Trust** — constructed 91.7 %, correct 75.9 %, **both fell** as scope widened.
- **Discovery** — correct 43.1 % → 39.6 %; *"No code changed; the whole −3.5
  points is denominator."*
- **Compass** — roadmap 70.0 %, phase-1 75.0 %, **v2 spec 35.7 %**.

### Why the earlier `3,553` figure was not reproducible

The owner asked for the displayed denominators to be reconciled, noting they
summed to 3,553 rather than 3,453. Adding the stated denominators row by row at
`dd8ec0afe` gives **3,453**, reproducibly, and the same addition today gives
**3,517**. The 100-row discrepancy is not present in the census files as they
stand; it was in a displayed summary, not in the record. If the 3,553 came from
a source still held, it should be re-checked against §1 — this document does not
claim the owner misread, only that the addition it can perform does not
reproduce that number.

---

## 5. Old → new mapping, so nothing silently disappears

**No requirement id present in the previous baseline is absent from this one.**
`REMOVED ids: 0`, measured, not assumed. Every one of the 3,429 prior ids
carries forward with its verdict unchanged.

The 64 new ids, in full:

| census | new ids |
|---|---|
| trust (15) | `TV-U1`…`TV-U12`, `TV-G1`, `TV-P0`, `TV-6c` |
| compass (15) | `CCL-01`…`CCL-15` |
| discovery (34) | `DC-01`…`DC-34` |

Their provenance:

- **Trust** — 66 spec clauses enumerated (12 TRV2 table + 16 TRV2 prose + 7 plan
  goal/invariants + 31 phase bullets). 15 coverage gaps, **14 of them in prose**.
  14 prose passages excluded with a stated reason each.
- **Compass** — 109 statements → 96 clauses → 22 duplicates → 74 distinct
  requirements. 15 coverage gaps, **13 from prose**. 13 exclusions listed.
- **Discovery** — 135 obligations enumerated, 17 duplicates, 32 prose exclusions
  categorised, 34 new rows.

**The dominant finding is coverage, not grading.** A requirement with no row
could never be graded — so it could never be counted as missing either. Of the
44 coverage gaps across the three, **27 were in spec prose** the censuses' tables
had no row for.

### Discovery answered the owner's re-check question directly

The owner asked whether rows had been graded against repository-derived
descriptions instead of the specs. Discovery checked all 67 of its original rows:
**zero were graded against a `docs/architecture/0*_*.md` current-state file.**
They came from other surfaces' owner-supplied specs (A01–A25), census-input-
intelligence's G-rows (B01–B09), and **Discovery's own module headers (C01–C33)**
— which is the same failure class, so all 33 were re-derived individually against
the code: **31 unchanged, 1 confirmed already-moved, 1 mis-stated reason
corrected, 0 new verdict moves.**

---

## 6. Spec integrity — re-verified at this commit

The owner asked whether the uploaded spec files are still present and unchanged
against their recorded hashes.

| check | result |
|---|---|
| `SOURCE-MANIFEST.json` entries verified by sha256 | **17 / 17 byte-identical** |
| v2 documents verified against the uploaded zip | **5 / 5 byte-identical** |
| Files missing | **0** |
| Files changed | **0** |
| Upload still on disk | yes — zip `992447229eae25d9…` |

Every manifest entry was located by **content hash** across `docs/`, not by
path, so a moved or renamed file is found rather than reported missing. The
Discovery package is installed under
`docs/specs/discovery-architecture-v1/` with renamed files whose bytes match the
zip exactly.

**One defect stands (backlog B5):** the Discovery package is installed **twice** —
`docs/specs/discovery-v1/` (14 files) and `docs/specs/discovery-architecture-v1/`
(13 files). Two copies of a specification is two things to drift apart. One
should be retired, and the manifest points at `discovery-architecture-v1`.

---

## 7. What is NOT established by this document

Stated rather than left to be discovered, per P24 — *what exactly would turn
this red?*

1. **This does not certify any verdict is correct.** `check:census-integrity`
   checks that each document agrees with itself. Correctness against the code is
   the lanes' claim, carried here.
2. **47 of compass's 59 mapped requirements were not re-executed this pass**, and
   the other censuses carry comparable carried-forward populations.
3. **The 644 uncited C rows cannot be machine-checked against any tree.**
4. **Citation rot is measured and unrepaired.** census-trips sampled 21.0 % of its
   C rows by a rule written before any row was read and found **42 % citing code
   that is no longer there, with zero verdicts falsified**. Four censuses
   produced the same shape independently. ~124 broken anchored citations remain
   repo-wide.
5. **Nothing here is production-realized** — §3.3.
6. **Attribution is not compliance.** Per `docs/architecture/attribution-method.md`,
   UNKNOWN is the default, and no row infers that code was not built from a spec
   merely because it predates the spec's upload.

---

## 8. The implementation backlog

Ordered by what it buys per unit of work, not by census size. Owner-blocked items
are separated because no lane can start them.

### Agent-executable now

| id | item | size | buys |
|---|---|---|---|
| **B1** | **Grade the 9 `CPV2` clauses.** The only requirements in the corpus with no verdict. Each needs a row in census-compass with evidence or a stated absence. | S | Removes the last ungraded population; corpus becomes 100 % graded |
| **B2** | **Wall to 100 %.** 6 X rows, 0 W, 0 N — the shortest distance to a finished surface. | S | One census at 100 % correct |
| **B3** | **Passport to 100 %.** 10 W + 1 N + 1 X, already at 92.9 %. | S | Second census finished |
| **B4** | **Trust's 17 W + 7 N.** Includes `TV-4b` suspension UX, `TV-5b` age-gate (`is_over_18` written and read by no gate), `TV-7a` `requestProviderDeletion` called from nowhere — a live GDPR erasure hole. | M | 75.9 % → ~90 %; closes a real privacy defect |
| **B5** | **Retire the duplicate Discovery spec install.** Keep `discovery-architecture-v1/`. | S | Removes a drift surface (§6) |
| **B6** | **Repair the ~124 broken anchored citations** and bank the ratchets (`MAX_MISPLACED_SYMBOLS` 60→44, `check:citation-targets` 275→267). | M | Makes the record checkable again |
| **B7** | **Give the 644 uncited C rows citations**, starting with census-trips' 235. | L | Makes 30 % of all C claims machine-checkable |
| **B8** | **Widen `CENSUS_SCOPE`** for discovery (11 files), compass (`lib/contextKernel`, `lib/opportunityEngine`, `routes/opportunities`), and add `docs/compass/` to `COVERED`. | S | Freshness checks stop being blind |
| **B9** | **Wire `DiscoveryRankingService.ts`** — built, and no Discovery route imports it. | S | Dead code becomes the ranking path, or is deleted |
| **B10** | **Fix `parseIdCell`'s digit-suffix range defect** — the bug that forced Discovery's 3 rows into prose (§2.2). | S | Removes 3 of the 24 permanently |
| **B11** | **The 158 telegraph W + 136 layover W + 131 highlights W.** Telegraph's own split: 51 are branch-fixable today with no new storage and no flag. | XL | The largest correctness mass in the corpus |

**Start with B1, B2, B3, B5, B10** — all small, and between them they finish two
censuses, close the ungraded population, and permanently remove 12 of the 24
unreadable requirements.

### Owner-blocked — no lane can start these

| id | item | why blocked |
|---|---|---|
| **O1** | Production deploy, runbook **Batch C** then **Batch D** | Production is manual by design. All 32 migrations rehearsed on portava-ci inside `BEGIN…ROLLBACK`, zero failures, nothing persisted. `2870` is independently applicable — all four preconditions measured on production. |
| **O2** | **D-SCORING** — ratify the twelve trust scoring families | Sent for review: `docs/trust/scoring-parameters-for-ratification.md` |
| **O3** | The finalized **Compass system prompt** | `CPH-02` stays **N** until it exists |
| **O4** | **D-PROVIDER** — Stripe Identity or Persona | `TV-6a`: account, API keys, webhook secret. ~$1.50–3.00 per attempt. Blocks `TV-6b`. |
| **O5** | **D-SUSPENSION-UX**, **D-REVERSAL** | Product decisions surfaced by `TV-4b` and `TRV2-10` |

The owner's four standing decisions are recorded and in force: the brand palette
(`docs/architecture/brand-palette-decision.md`), Trust override CAP-now/PIN-later,
send the twelve families for review, and rehearse the whole batch against
portava-ci first. All four are honoured in the work above.

---

# 9. Baseline v2 — 2026-09-14, after five lanes and the integration round

**This supersedes §1 and §2.** It is the consolidated record; the integration
lead is the only author of it.

| | |
|---|---|
| `head_commit` | `38ba7759b` on `claude/sweet-fermat-fmx7up` |
| Previous baseline | v1 above, at `7c6255de7` |
| Lanes consolidated | Citation repair · Tooling · Trust · Wall+Passport · Compass |

## 9.1 The reconciled totals

| | count | of 3,517 |
|---|---:|---:|
| **C** — built and correct | **2,173** | 61.8 % |
| **W** — built but wrong | **890** | 25.3 % |
| **N** — not built | **423** | 12.0 % |
| **X** — cannot verify | **31** | 0.9 % |
| **UNGRADED** | **0** | 0 % |
| **TOTAL** | **3,517** | 100 % |

- **CONSTRUCTED** (C+W) = 3,063 / 3,517 = **87.1 %**
- **CORRECT** (C) = 2,173 / 3,517 = **61.8 %**
- **GRADED = 3,517 / 3,517 = 100 %**

| census | C | W | N | X | denom | sums | constructed | correct |
|---|---:|---:|---:|---:|---:|:---:|---:|---:|
| compass | 98 | 35 | 6 | 2 | 141 | ✓ | 94.3 % | 69.5 % |
| discovery | 74 | 67 | 43 | 3 | 187 | ✓ | 75.4 % | 39.6 % |
| highlights-memories | 56 | 131 | 77 | 2 | 266 | ✓ | 70.3 % | 21.1 % |
| input-intelligence | 262 | 55 | 52 | 4 | 373 | ✓ | 85.0 % | 70.2 % |
| layover | 61 | 136 | 99 | 0 | 296 | ✓ | 66.6 % | 20.6 % |
| map | 237 | 46 | 5 | 5 | 293 | ✓ | 96.6 % | 80.9 % |
| media | 297 | 83 | 68 | 2 | 450 | ✓ | 84.4 % | 66.0 % |
| passport | 158 | 9 | 1 | 1 | 169 | ✓ | 98.8 % | 93.5 % |
| sensing | 98 | 26 | 2 | 1 | 127 | ✓ | 97.6 % | 77.2 % |
| telegraph | 229 | 158 | 61 | 3 | 451 | ✓ | 85.8 % | 50.8 % |
| trips | 320 | 128 | 3 | 0 | 451 | ✓ | 99.3 % | 71.0 % |
| trust | 84 | 16 | 6 | 2 | 108 | ✓ | 92.6 % | 77.8 % |
| wall | 199 | 0 | 0 | 6 | 205 | ✓ | 97.1 % | 97.1 % |
| **TOTAL** | **2,173** | **890** | **423** | **31** | **3,517** | ✓ | **87.1 %** | **61.8 %** |

**Every census row sums to its own denominator**, and so does the corpus.

## 9.2 CORRECTION — "nine ungraded requirements" was wrong

v1 §2.1 stated that nine `CPV2` clauses were *"the only requirements in the
entire corpus with no verdict of any kind."* **That is false, and the error was
mine, not the census's.**

How it happened: I derived the nine by subtracting the ids the parser reads from
every id-shaped token in `census-compass.md`, found twelve `CPV2` ids of which
three were paired to graded rows, and concluded 12 − 3 = 9 ungraded. The
subtraction was right and the **inference was wrong** — an id the parser cannot
read is not an id without a verdict.

What the nine actually are:

| ids | what they are | verdict |
|---|---|---|
| `CPV2-03`, `CPV2-11`, `CPV2-12` | graded in §13.3 since 2026-09-13, unparsed only because the id cell was written in backticks | **W · N · W** |
| `C1-01`, `C1-02`, `C1-03`, `C1-04`, `C1-05`, `C1-07` | Phase-1 spec rows, same backtick cause (**there is no `C1-06`**) | **5 C + 1 W** |

Verified independently of the lane that reported it: every one printed from the
census, and `C1-02`'s last statement is `C` at line 1572 — it moved W→C when its
build landed, which is exactly why the arithmetic closes at 5 C and not 4.

The six remaining `CPV2` ids (`-01`, `-02`, `-04`, `-08`, `-09`, `-10`) are §13.2
DUPLICATEs: they add no requirement to any denominator and their verdict is their
carrier's. So **no `CPV2` clause was ever ungraded either.**

The true, narrower statement — which v1 should have made — is that **no `CPV2`
id carried a verdict cell addressed to its own acceptance bar**. census-compass
§17.1 now fixes that, grading all twelve against their own bars: **C 3 · W 5 ·
N 1** across the nine non-duplicates.

## 9.3 Every change since v1, classified

| classification | C | W | N | X | UNGRADED | rows |
|---|---:|---:|---:|---:|---:|---:|
| **Code fix** — a verdict moved because the code changed | +3 | −2 | −1 | 0 | 0 | **3** |
| **Corrected assessment** — v1 mis-stated a verdict that already existed | +5 | +3 | +1 | 0 | −9 | **9** |
| **Added scope** | 0 | 0 | 0 | 0 | 0 | **0** |
| **Accounting correction** — rows became machine-readable; no verdict changed | 0 | 0 | 0 | 0 | 0 | **0** |
| **NET** | **+8** | **+1** | **0** | **0** | **−9** | |

### The three code fixes — each failing-first, each with a revert proof

| id | move | what was actually wrong |
|---|---|---|
| **TV-1a** | W → C | Verification sessions were born in `pending`; the column default and first documented lifecycle state is `created`. RED 3/2 → GREEN 3/3; revert the one literal → 2/1. |
| **TV-6c** | N → C | The V-6 obligation *"monitor attempts per verified user"* had no measurement at all. Built `attemptMetrics.ts` + a reachable admin caller. RED 9/6/3 → GREEN 9/9, with **five** named mutations. |
| **P45** | W → C | The worst of the three. The Passport Trust screen **rebuilt six domain rows from capability flags and printed the constant `In good standing` on every in-scope domain** — so a domain the server measured as "Building" or "New" was shown to a person as good standing. The client was not duplicating the server, it was overriding a measured verdict with a flattering constant. RED 9 failed/3 passed → GREEN 12/12; revert → 9/3 again. |

### The accounting correction, stated separately because it moved no verdict

The parser read **3,493** rows at v1 and reads **3,499** now. Six rows became
machine-readable: discovery's three (`DSV2-04/05/12`, rewritten from prose into a
verdict table) and compass's three (`CPV2-03/11/12`, restated with plain ids).
The corpus prose gap fell **24 → 18**. Denominators did not move; **no verdict
changed**; a full `CENSUS_INTEGRITY_DUMP=ALL` diff over all thirteen censuses
showed **+3 lines, 0 removed, 0 changed** for the discovery half.

### A v1 backlog item that was already done

v1 §8 listed **B10**, "fix the `parseIdCell` digit-suffix range defect." It was
**already repaired** by `e8f5552b1` on 2026-09-13; census-discovery §12.3 was
written the next day still claiming it was open, and three sections repeated the
claim. The claim was stale when written and nobody re-ran it. No parser change
was needed — the rows simply had to be written as table rows. The repair is now
**pinned** by `censusDigitPrefixIds.test.ts`, whose positive control writes a copy
of the parser with the branch deleted and *requires the copy to fail*.

## 9.4 The 18 that remain unparsed — all graded

| census | count | ids | verdicts | cause |
|---|---:|---|---|---|
| compass | 6 | `C1-01`…`C1-05`, `C1-07` | 5 C + 1 W | **id cell written in backticks — `parseIdCell` silently drops it** |
| telegraph | 12 | `T1, T26, T212, T366, T367, T393, T404, T405, T406, T408, T416, T446` | 12 N | marked `∅` *unguarded absence*, not a verdict cell |

The compass six have a known, measured, one-line cause and are the cheapest
remaining accounting fix in the corpus. **`parseIdCell` silently dropping a
backticked id cell is a parser defect that will recur**, and it is now the only
thing between the corpus and a fully machine-readable record.

## 9.5 Production availability — unchanged, and the hold stands

Nothing in this round was merged or deployed. `main` is still `014a25d56`.
The 32 migrations `2778–2870` exist in **no** database.

**What did change is the evidence for one of them.** `2870` was rehearsed
**alone** on portava-ci inside `BEGIN … ROLLBACK` (runbook **D4**), and the
rehearsal observed the failure the migration exists to fix rather than arguing
it: `UPDATE profiles SET verification_level='id_verified'` → **`23514` check
constraint violation** before, **7 of 7 values accepted** after, **nothing
persisted** (constraint reverted, ledger still 500/2777, 0 sessions idle).
Production was read read-only and its four preconditions re-confirmed.
**THE PRODUCTION HOLD REMAINS IN PLACE.**

## 9.6 CI: `check:doc-citations` is clean for the first time

| guard | at `dd8ec0afe` | now |
|---|---|---|
| `check:doc-citations` | **failed** — 255 findings, 125 broken anchors | **RESULT clean — 0 / 0** |
| `check:citation-targets` | **failed** — 276 of ceiling 275 | **253 of ceiling 257** |
| `check:citation-symbols` | PASSED | PASSED |
| `check:test-registration` | passing, but **4 suites unregistered and silently never run** | **1187 / 1216, all four registered** |
| `check:census-integrity` | PASSED | PASSED, 3,499 rows |

**96 anchors were repointed by reading the claim and locating the line — never
by offset.** Three citations were found already correct with corrupted anchor
*text*, the signature of an earlier bad automated repair; a naive "fix" would
have moved the line and broken them.

---

# 10. Reporting corrections — 2026-09-14, at `f8e82d97b`

The owner caught two arithmetic errors in a verbal summary and asked for the
3,429 → 3,517 bridge and a production separation backed by evidence. All four
are answered here. **No verdict moves in this section; it is accounting and
evidence only.**

## 10.1 Two corrected figures

| claim I made | correct | error |
|---|---|---|
| *"telegraph + layover + highlights hold **59 %** of all W"* | 158 + 136 + 131 = 425; **425 / 889 = 47.8 %** | overstated by 11.2 points |
| *"layover + highlights are **604** of 1,343 unresolved (**45 %**)"* | layover 136+99+0 = **235**; highlights 131+77+2 = **210**; together **445 / 1,343 = 33.1 %** | 604 does not correspond to any sum in the corpus; overstated by 159 requirements and 11.9 points |

**Unresolved by census, correctly ranked** (W + N + X, of 1,343):

| census | unresolved | W | N | X | cumulative |
|---|---:|---:|---:|---:|---:|
| layover | 235 | 136 | 99 | 0 | 17.5 % |
| telegraph | 222 | 158 | 61 | 3 | 34.0 % |
| highlights-memories | 210 | 131 | 77 | 2 | 49.7 % |
| media | 153 | 83 | 68 | 2 | 61.1 % |
| trips | 131 | 128 | 3 | 0 | 70.8 % |
| discovery | 113 | 67 | 43 | 3 | 79.2 % |
| input-intelligence | 111 | 55 | 52 | 4 | 87.5 % |
| map | 56 | 46 | 5 | 5 | 91.7 % |
| compass | 43 | 35 | 6 | 2 | 94.9 % |
| sensing | 29 | 26 | 2 | 1 | 97.0 % |
| trust | 23 | 15 | 6 | 2 | 98.7 % |
| passport | 11 | 9 | 1 | 1 | 99.6 % |
| wall | 6 | 0 | 0 | 6 | 100 % |

**It takes three censuses to pass 47.8 % of W and four to pass half of all
unresolved requirements.** There is no two-census shortcut.

## 10.2 The 88 requirements between 3,429 and 3,517 — every one accounted for

The two numbers are different measures, which is how the gap got loose in the
first place: **3,429 was the PARSED row count** at `dd8ec0afe`; **3,517 is the
DENOMINATOR** now. The bridge:

```
3,429   parsed rows at dd8ec0afe
  + 24  requirements already IN that denominator, unreadable by the parser
────────
3,453   stated denominator at dd8ec0afe
  + 64  NEW requirements enumerated from the owner's specs
────────
3,517   denominator now
```

**88 = 24 + 64, and only the 64 are additions.** The 24 were counted the whole
time; they were prose the parser could not read.

**The 64 new requirements**, all from the three compliance passes, all still
present, none retired:

| census | count | ids |
|---|---:|---|
| trust | 15 | `TV-U1`…`TV-U12`, `TV-G1`, `TV-P0`, `TV-6c` |
| compass | 15 | `CCL-01`…`CCL-15` |
| discovery | 34 | `DC-01`…`DC-34` |

**The 24, and where they went.** Six became machine-readable this session
(rewritten as table rows, no verdict changed); 18 remain prose-counted and all
18 carry verdicts:

| census | at `dd8ec0afe` | became parseable | still prose |
|---|---:|---|---:|
| compass | 9 | `CPV2-03`, `CPV2-11`, `CPV2-12` | 6 — `C1-01`…`C1-05`, `C1-07` (5 C + 1 W) |
| discovery | 3 | `DSV2-04`, `DSV2-05`, `DSV2-12` | 0 |
| telegraph | 12 | — | 12 — all N, marked `∅` *unguarded absence* |

Cross-check, both directions: parsed `3,429 + 64 + 6 = 3,499` ✓ and
`3,499 + 18 = 3,517` ✓.

**Measured, not reasoned**: dumping every verdict at both commits and comparing
under last-statement-wins gives **70 ids added, 0 removed, and exactly 3 verdict
moves among ids present in both** — `passport/P45`, `trust/C22`, `trust/TV-1a`
(all W → C). `trust/TV-6c` is not in that list because it did not exist at
`dd8ec0afe`; it is one of the 64, added as N and closed to C in the same session.

## 10.3 Production, branch, and migration-blocked — separated, with evidence

An earlier summary said *"none of the 61.8 % is production-realized."* **That
was asserted, not measured, and it is wrong.** Production is a live system with
a large working surface. Corrected below, read-only from
`ajrurzioarfkagpuxfnb` on 2026-09-14.

### What IS live in production

| fact | value |
|---|---|
| public base tables | **430** |
| feature flags defined / **ENABLED** | 185 / **106** |
| profiles | 58 |
| `rent_buddy_launch_controls` | 13 rows |
| `trust_events` / `trust_profiles` | 5 / 2 |

A 430-table schema with 106 enabled flags is not an unrealized system.

### What is NOT in production — measured object by object

The branch adds **32 migrations** (`2778`–`2870`). Every object they create was
checked against the live schema:

| kind | result |
|---|---|
| the 17 tables they create | **17 of 17 ABSENT** |
| the 14 feature flags they seed | **14 of 14 ABSENT** |

Named, so the claim is falsifiable: `airport_fact_observations`,
`conversation_action_refs`, `layover_external_events`, `message_attachments`,
`message_edits`, `message_reactions`, `telegraph_outbox`,
`telegraph_report_evidence`, `trip_decisions`, `trip_disruptions`,
`trip_meeting_checkpoint_participants`, `trip_meeting_checkpoints`,
`trip_reservation_events`, `trip_subgroup_members`, `trip_subgroups`,
`trip_transport_policies`, `trip_transport_segments` — and the flags
`compass_decision_enabled`, `discovery_live_rank_enabled`,
`experience_session_enabled`, `intel_safety_candidates_enabled`,
`layover_live_intersection_enabled`, `opportunity_engine_enabled`,
`telegraph_live_references_enabled`, `telegraph_message_kernel_enabled`,
`telegraph_report_evidence_enabled`, `telegraph_request_origin_enabled`,
`trip_absence_guard_enabled`, `trip_operational_projections_enabled`,
`trip_retention_sweep_enabled`, `wall_moments_enabled`.

**Any requirement whose behaviour needs one of those 31 objects cannot work in
production today.** That is evidence, not inference.

### The C rows, split by how far their evidence is from `main`

2,169 parsed C rows, classified by what their verdict line cites. 660 files are
**new** on this branch and 365 are **modified**:

| class | C rows | what it means |
|---|---:|---|
| cites a file **untouched** by this branch | **733** | evidence is in `main` verbatim |
| cites a file this branch **modified** | **570** | the file is in `main`; whether the cited behaviour is needs re-reading |
| cites a file this branch **created** | **219** | **not in `main` at all** |
| **no file citation on the verdict line** | **647** | cannot be classified from the row — this is defect **B7**, not a category |

`733 + 570 + 219 + 647 = 2,169` ✓

**So the honest statement is neither extreme.** At least **733** C rows rest on
code this branch never touched, which is in `main`. **219** demonstrably are
not. The middle 570 and the uncited 647 need per-row reading, and **1,217 of
2,169 C rows (56 %) therefore cannot be assigned to production or to branch from
the record as it stands.** Reducing that number is what backlog **B7** is for.

### Migration-dependence cannot be measured from citations

Attempting it returned **0 rows** for every census — not because nothing depends
on the 32 migrations, but because census verdict lines almost never cite a
migration file. The measurement above (17 + 14 objects, absent) is the evidence
that stands; a per-row migration attribution does not exist yet and is not
claimed.

---

# 11. Two findings the Layover/Trips round produced before it finished

## 11.1 CENSUS-SCHEMA DEFECT — there is no terminal state for a superseded requirement

The owner ruled that a census row conflicting with a **later ratified** decision must not be left
looking like unfinished implementation, and that if the census has no truthful terminal
classification for "intentionally removed from scope", **that is to be reported as a schema defect
rather than papered over by abusing `C`/`W`/`N`/`X`.**

**It has none.** Measured:

- `artifacts/api-server/src/scripts/checkCensusIntegrity.ts:119#type Verdict` is
  `type Verdict = "C" | "W" | "N" | "X"` — four buckets and no fifth.
- `artifacts/api-server/src/scripts/checkCensusIntegrity.ts:157#const VERDICT_ALIASES` admits only
  `C/BAC/BC`, `W/BBW/BW`, `N/NB`, `X/CV`. A cell reading `SUPERSEDED` parses to **nothing**, so the
  row silently leaves the denominator — which is worse than mis-classifying it.
- Across all thirteen censuses the words *superseded*, *retired* and *withdrawn* appear **four
  times in total**, all as prose inside an evidence cell. None is a verdict.

**Consequence, stated so it cannot be mistaken for an opinion:** `P13`, `P128` and `P133` are
**correctly `W` and permanently so** under the present schema. `W` means built-but-wrong; these are
*not to be built*. The schema cannot say that, so the row says the wrong thing and the evidence cell
is the only place the truth can live.

**The chronology and authority, proved rather than asserted:**

| | |
|---|---|
| `docs/architecture/census-passport.md` first committed | **2026-09-09**, `42aeac38e` |
| `docs/architecture/brand-palette-decision.md` ratified | **2026-09-14 09:28:13 UTC**, `5b60439b1` |
| The ruling | *"The mockup approves the palette only — not a new layout. Build upon existing components and shared tokens; do not rebuild working screens."* |
| P13 specifically | already ruled by name in that document: **"stays W"**, change **"none"** |

The decision is **five days later** than the requirement text and was recorded at the owner's own
instruction as an explicit owner decision. It supersedes.

**What this costs if left:** a future architecture sweep reads three `W` rows in the
closest-to-finished census and builds Passport dark mode and a new Passport layout — both of which
the owner declined. The guard against that is a decision test, not a verdict letter.

**The fix, when someone takes it:** add a fifth terminal verdict to `Verdict`, `VERDICT_ALIASES`
and the denominator arithmetic — something like `S` (SUPERSEDED) — counted in the denominator,
excluded from CONSTRUCTED and from CORRECT, and required to cite the superseding artifact. Until
then no census may use it, because the parser would drop the row.

## 11.2 CORRECTION — Trips is DEPLOY-blocked, not code-blocked

§10 of this document ranked the architectures by "code-shaped remainder" and placed **trips fifth
with 111 corrections**. For the half now measured, that is **wrong**, and the error is the one §10
warned about in the abstract: a row counts as unblocked when its verdict line does not *name* a
blocker, which is not the same as somebody having checked.

The `TR1`–`TR199` lane checked. It re-derived the verdict set independently, then measured the
blocking facts **directly against production, read-only**:

| measured in production | result |
|---|---|
| `trips.version`, `trip_events`, `trip_outbox`, `trip_command_receipts` | **present** — 2420's chain is deployed |
| `trip_kernel_enabled` | **`false`** |
| `trip_operational_projections_enabled` | **the flag row does not exist** — 2778 never applied |
| `trip_stages`, `trip_legs`, `trip_commitments`, `trip_goals`, `trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`, `trip_snapshots`, `trip_outcomes`, `trip_subgroups`, `trip_plan_participants`, `trip_transport_segments`, `trip_decisions`, `trip_disruptions`, `trip_meeting_checkpoints` | **all absent** |

**Of 86 open rows in that range, ZERO can reach `C` from this branch.**

| blocker | rows |
|---|---:|
| flag-only (storage and code deployed, flag off) | **16** |
| a migration that exists in the tree but in **no** database | **56** |
| **DDL nobody has written yet** | **10** |
| needs a routed travel-time provider / a tile provider's terms | 2 |
| an open owner decision (`APPEAL_RESTORE_SEMANTICS`) | 1 |

The ten with **no migration written** are the ones worth naming, because they are not "apply 27xx":
`TR33`/`TR92`/`TR93` (`trip_plan_items.source_id` is `text NULL` with no FK, and 2770's `place_id`
adds no `REFERENCES` — needs typed FK columns or a reconciliation table **plus** the writers),
`TR77` (`trips.current_stage_id`, `trips.home_timezone` — **0 occurrences in the entire tree**),
`TR116` (a client writer), `TR150` (three further schema objects the census under-records),
`TR152`, `TR153` (three columns remain after 2774, not five), `TR173`, `TR1`.

**So the honest statement is that Trips' 99.3 % constructed / 71 % correct is not waiting on
engineering — it is waiting on the production deploy the owner holds.** That makes it a poor target
for implementation agents and an excellent argument for Batch C/D. The `TR200`–`TR499` half is still
being measured; this correction covers `TR1`–`TR199` only and will be extended when that lane lands.

### Three evidence corrections — verdict unchanged, the stated reason false

| id | the cell says | measured |
|---|---|---|
| `TR12` | `trips` "carries **no `version` column**" | production **has** `trips.version bigint`. Real blocker: `trip_kernel_enabled = false`, so nothing increments it. |
| `TR77` | "no `current_stage_id`, no `home_timezone`, no `version` — **three** of seven" | **two** of seven. `version` is deployed. |
| `TR153` | five proposal fields "are **not columns**" | `2774_trip_proposal_governance.sql:75#ALTER TABLE` adds `decision_rule` and `proposed_by`. **Three** remain. |

### One real defect found and fixed in passing

`loadImpactState` records every table it could not read in `unread` — the census's own standard,
*"a named unread, never a failed completion"*. **Two of its five consumers carried that list to the
caller and three dropped it.** `/trips/:id/simulate`, `/trips/:id/meeting-point` and
`/trips/:id/rescue` answered over a silently degraded state and said nothing, while
`/proposals/preview` and `/replan` — in the same file — disclosed it. Since
`trip_plan_participants`, `trip_commitments` and `trip_transport_segments` are **absent on every
deployment today**, those reads do fail, and the fallback (*"the whole crew is going"*, *"there is
no next commitment"*) was served as a complete answer. RED 5/2 → GREEN 7/7, reverted → the same 5
fail. It moves no verdict and none was claimed.
