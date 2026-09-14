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
