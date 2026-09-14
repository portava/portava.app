# The reconciled baseline, v1 — 2026-09-14

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
