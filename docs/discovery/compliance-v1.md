# Discovery — compliance against the owner's specification, v1

*Lane: DISCOVERY COMPLIANCE. Worktree `/home/user/wt-483` (detached at `7d1f2d498`, PR #483 head
plus the v2 spec install), 2026-09-14, with sibling lanes editing the same tree. This document is
the enumeration and the audit; `docs/architecture/census-discovery.md` §14 carries the rows it adds
and the restated headline. Nothing here was built: this pass wrote **no source file and no test**,
so every verdict below is a measurement of the tree as three other lanes left it.*

**The question this lane was given:** census-discovery's original 67 rows were said to be at risk of
having been graded against `docs/architecture/0*_*.md` — thirteen files that share the owner spec's
filenames and are descriptions of the code. **Measured: none of the 67 was.** What 33 of them *were*
graded against is the code's own module headers, which is the same failure class by a different
route, so those 33 were re-derived against the owner's spec text one at a time. One contract says the
opposite of the specification; one names a property its own evidence does not prove. Both are below,
with the evidence.

---

## 0. Provenance, and which copy of the specification this cites

| Field | Value |
|---|---|
| Specification | `docs/specs/discovery-v1/` — 13 files, 2 085 lines, installed 2026-09-14 (`docs/specs/discovery-v1/00-PROVENANCE.md:3#**Installed 2026-09-14** from `) |
| Upgrade layer | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md` (DSV2-01…12) and `docs/specs/upgrades-v2/00-START-HERE.md` |
| Second copy in the tree | `docs/specs/discovery-architecture-v1/` — **byte-identical**, verified here by `sha256sum` over all thirteen files, thirteen matches, zero differences. §11 of the census cites that path; every one of its citations therefore still resolves and none is restated. |
| The collision | `docs/architecture/01_Portava_Discovery_Engine.md` … `12_Claude_Code_Implementation.md` are **not** this specification. `docs/architecture/00_STATUS.md:7-9#Documents` and `docs/architecture/05_Graph_Engine.md:6-8#schedule (` say so in their own words. **No verdict in this document cites one of them as a requirement.** |

**A finding about the tree, not about a row:** the owner's package is present twice under two
different paths. Nothing is wrong with either copy, but a third reader who finds only one of them
will write citations the other half of the corpus cannot follow, and a fourth who edits one will
create a silent fork of the specification. Recorded for the integration owner as
**cross-lane request X1** (§8).

---

## 1. The enumeration rule, stated before anything was counted

A passage in the fourteen documents is a **testable requirement** when it states an obligation, a
prohibition, or an acceptance condition about the system whose satisfaction can be decided by
reading the repository, the database catalogue, or a test. In practice that means it carries a
deontic verb — *must*, *must never*, *should*, *required*, *never*, *do not*, *cannot*, *is ready
when*, *is complete when*, *is acceptable when* — or it is a bullet under an acceptance-criteria
heading.

A passage is **excluded as stating no testable obligation** when it is a definition, a motivation, an
example, a permissive enumeration (*"PDE may use"*, *"a Trail can contain"*, *"possible features"*,
*"suggested progression"*, *"recommended spotlights"*), or a conceptual data model offered as a shape
rather than as a requirement — **unless** a later acceptance criterion makes that shape testable, in
which case it is counted once at the criterion.

A passage is **DUPLICATE-counted** when it states an obligation another passage already states. It is
enumerated once, at the row that grades it, and named here so the fold is visible rather than silent.

Three consequences of the rule are stated up front because they are where an enumeration usually
cheats:

1. **A prohibition an absence satisfies is still a requirement.** *"Do not let creators attach
   unlimited discovery labels"* is enumerated even though no Trail label system exists. Whether
   absence satisfies it is a grading question, answered per row, not an enumeration question.
2. **A catalogue with a deontic verb at the top is one obligation, not N.** `01` §10's *"PDE must
   never:"* heading over eight bullets is eight obligations, because each bullet is separately
   falsifiable. `04` §4's event-type catalogue under no verb is zero, and is counted once at the
   expansion row that grades it.
3. **An obligation may produce more than one row.** `02` §19 is one passage and eight rows. The 135
   obligations below therefore do not equal the row count; §4 reconciles the two.

### 1.1 The accounting — what was enumerated, folded, and excluded

| Document | Testable obligations | DUPLICATE — counted once elsewhere | Excluded as no testable obligation |
|---|---|---|---|
| `00_README` | 4 (the four repository constraints) | 1 (Guiding product principle → `01` §12) | 4 (audience/scope header, document set, core entities, north-star) |
| `01_Portava_Discovery_Engine` | 8 (§4, §6, §7, §8, §9, §10, §11, §12) | 2 (§2 objective → §12 + `01` §10; §5 components → the per-engine rows) | 2 (§1 purpose, §3 permissive input list) |
| `02_Trails` | 6 (§4, §5, §7, §9, §11, §19) | 4 (§6→DV-24, §10→DV-23, §12→DV-27, §17→DV-26) | 9 (§1, §2, §3, §8, §13, §14, §15, §16, §18) |
| `03_Trending` | 6 (§4, §6, §7, §12, §13, §14) | 3 (§8→DV-14, §9→DV-28, §10→DV-14) | 5 (§1, §2, §3, §5, §11) |
| `04_Behavior_Engine` | 11 (§2, §3, §5, §6, §7, §8, §9, §10, §11, §12, §13) | 1 (§4 event catalogue → DV-78) | 1 (§1 purpose) |
| `05_Graph_Engine` | 6 (§3, §5, §6, §7, §8, §9) | 1 (§4 → DV-34) | 2 (§1, §2) |
| `06_Recommendation_Engine` | 11 (§1–§11) | 0 | 0 |
| `07_Creator_Economy` | 7 (§1, §3, §5, §7, §8, §9, §10) | 0 | 3 (§2, §4, §6) |
| `08_Portava_Revenue_Model` | 4 (§3, §4, §6, §7) | 1 (§2 sponsored labelling → DV-62) | 2 (§1, §5) |
| `09_Payment_Architecture` | 8 (§1, §2, §6, §7, §8, §9, §10, §11) | 1 (§5 wallet rebuildable → DV-66) | 2 (§3, §4) |
| `10_Database_Architecture` | 9 (§1, §2, §4, §5, §6, §7, §8, §9, §10) | 1 (§3 table catalogue → DV-40/DV-72) | 0 |
| `11_API_Specification` | 10 (§1–§10) | 0 | 0 |
| `12_Claude_Code_Implementation` | 19 (§0, Phases 0–13, test classes, deployment rules, stop conditions, completion) | 0 | 0 |
| `02-DISCOVERY-v2` (DSV2) | 26 (12 table rows + 14 prose obligations) | 2 (pipeline sentence → `06` §1; "do not label absence as Quiet" → DSV2-02) | 2 (scope/audience sentence, the agent-process inspection instruction) |
| **Total** | **135** | **17** | **32** |

**32 prose passages were excluded as stating no testable obligation.** The categories, with the
count in each and one named example, so the exclusions can be argued with rather than trusted:

| Why excluded | Count | Example |
|---|---|---|
| Definition or purpose statement | 9 | `01` §1 *"The Portava Discovery Engine is the platform layer that…"* |
| Motivation / rationale with no obligation | 5 | `02` §2 *"Hashtags fragment"* |
| Permissive enumeration — *may / can / possible / suggested / recommended* | 10 | `01` §3 *"PDE **may** use:"*; `03` §2 *"Portava **may** trend:"*; `07` §4 *"**Suggested** progression"*; `02` §8 *"**Recommended** spotlights"* |
| Catalogue of examples | 5 | `03` §11's four example trend sentences; `02` §12's five user-facing status strings |
| Conceptual field/state list with no obligation verb, made testable only by a later criterion | 3 | `09` §3 earnings states; `09` §4 attribution-record fields; `02` §18 data model |

**The hard ones were not dropped, and here is the proof for the two most likely to have been.**
`09` §2 *"Never make wallet balance the source of truth"* and `10` §5 *"Every user-visible table must
explicitly define read, insert, update, delete policies"* are both obligations over subsystems that
are absent or under-specified; both are enumerated (DV-66 and DV-71 respectively) and both are graded
against, not around. Nothing was excluded on the ground that it would be expensive to satisfy.

---

## 2. The provenance audit — which document each of the original 67 rows was graded against

This is the owner's explicit instruction, and it is answered mechanically first and by re-derivation
second.

### 2.1 Mechanical result: zero of the 67 cite a current-state architecture document

`grep` over the whole of `docs/architecture/census-discovery.md` for any citation of
`docs/architecture/0N_*.md` / `1N_*.md` returns **six lines, all of them inside §11.1's evidence
table**, where those files are cited *as evidence about the collision* — quoting their own headers
admitting they are derived — and never as a requirement. Restricted to the §2 rows themselves
(lines 55–133, all 67), the same grep returns **nothing**.

**So the defect the owner asked to be rechecked did not occur in the form it was feared.** The
census's own §1 said this would be the case; this pass is the check rather than the restatement.

### 2.2 Where the 67 requirements actually come from

| Rows | Requirement source | Is it a description of the code? | Verified how |
|---|---|---|---|
| **A01–A25** (25) | Sentences in **other surfaces' owner-supplied specs** under `docs/specs/` that name Discovery — Sensing, Trips, Passport, Telegraph, Layover, Map, Global Input Intelligence | **No.** Owner-authored specifications for other surfaces. | Every quoted sentence was re-read at its cited line in the named `.txt` this pass. 23 of 25 pointers resolve exactly; 2 are wrong and are corrected in §2.4. |
| **B01–B09** (9) | Rows of `census-input-intelligence.md` (G-ids), which derive from `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt` | **No.** A sibling census over an owner spec. | `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt:7#Core rule: Anywhere the user types, Porta` and `:8` re-read; the GII spec is the authority the B rows inherit. |
| **C01–C33** (33) | **Discovery's own module headers, guards and named tests** — the code stating its own invariants | **YES — and this is the finding.** Not a `docs/architecture/` file, but the same epistemic defect: a contract written by the code cannot record an obligation the code does not meet. The census says so itself: *"the (c) rows are the easiest to satisfy — they are the surface grading its own homework — and they are 33 of 67."* | All 33 re-derived against the owner's spec text in §2.3. |

### 2.3 The 33 self-described contracts, re-derived against the owner's specification

Each row's contract was read, the clause of `docs/specs/discovery-v1/` (or DSV2) that speaks to the
same subject was identified, and the verdict re-decided against the spec rather than against the
header. **31 survive, 1 was already moved and is confirmed, 1 keeps its verdict but loses its
sentence.**

| Row | Its contract (source: the code) | Owner-spec clause over the same subject | Outcome |
|---|---|---|---|
| C01 | suspended/banned/deleted excluded | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:11#Search answers which entities match. Recom` — *"Private or blocked entities remain ineligible regardless of ranking benefit"* (adjacent, not identical) | **C survives** |
| C02 | profile-discovery opt-outs, fail-closed | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` — *"Anonymous contributors cannot become discoverable people"* | **C survives** |
| C03 | blocks both directions; unknown → empty | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:11#Search answers which entities match. Recom` ineligibility clause; `01` §10 block-reason guardrail (DV-11) | **C survives** |
| C04 | content from suspended owners excluded | none in this package | **C survives** — a self-imposed invariant the spec neither requires nor forbids |
| C05 · C06 | private trips/events/plans: public or caller-owned only | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` — *"Searchers cannot gain unauthorized trip data through recommendation joins or cached projections"* | **C survives** |
| C07 | private fields never selected | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` privacy paragraph | **C survives** |
| C08 | age-restricted hidden, fail-closed | none | **C survives** |
| C09 | hidden names not searchable | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` — public explanations must not disclose private social context | **C survives** |
| C10 | the viewer is never redacted | none | **C survives** |
| C11 | header matches the code on private accounts | none — a documentation contract | **C survives** |
| C12 | `hasMore` from limit+1 overflow | none | **C survives** |
| C13 | rate limited 30/min | none | **C survives** |
| **C14** | **`/discovery/suggest` is fail-soft: any internal error → `200 { groups: [] }`** | **`docs/specs/discovery-v1/11_API_Specification.md:103#A failure must not masquerade as success.` and §9's six distinguishable failure classes — the specification says the OPPOSITE of the header** | **C → W. Moved by census §11.6; RE-EXECUTED HERE and confirmed.** All three exits still collapse to one empty success: `artifacts/api-server/src/routes/discoverySearch.ts:2485#discoveryRefusal("validation", "query_too_short", "GET /discovery/suggest")`, `artifacts/api-server/src/routes/discoverySearch.ts:2531#discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/suggest")`, `artifacts/api-server/src/routes/discoverySearch.ts:2590#discoveryRefusal("transient_db", "suggest_failed", "GET /discovery/suggest")`. The failure IS observable server-side (`logger.warn`) and is not observable to the caller, which is what §9 asks for. Owner decision D11 stands. |
| C15 | suggest reuses `dispatchSearch`, not a parallel matcher | `10` §1 *"Avoid parallel systems"*; `12` §0 | **C survives** — and is the one place the parallel-system rule is clearly met |
| C16 | `GET /discovery` unauthenticated, public data only, `submitted_by` never serialised | `06` §4 — the *"unless that surface explicitly requires no personalization"* exception applies to the anonymous path; `11` §10 governs mutations only | **C survives** |
| C17 | the submitter block rule is `lib/blocks.submitterIsVisible`, shared | `10` §1 | **C survives** |
| C18 | viewer sees their own byline | none | **C survives** |
| C19 | display-name redaction shape | DSV2 `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` | **W unchanged** |
| C20 | engine mode resolves to `legacy` on every failure | `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:180#- OFF: existing behavior byte-identical.` | **C survives** |
| C21 | an unreadable/absent/malformed cohort includes NOBODY | `01` §8 PARTIAL state — whether a cohort gate *is* PARTIAL is DV-08's `W`; C21's own claim is narrower | **C survives** |
| C22 · C23 · C24 | shadow and modifier inertness | `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:186#No migration, notification cancellation, s` | **C survives** ×3 |
| C25 | serve log inert until seeded; a rejected insert is reported, never thrown | `01` §6 *"rejected events are observable"*; `04` §3 *"observable on failure"*; `04` §10.4 *"instrument rejected event writes"* — three restatements, counted once here | **C survives, re-executed at this tree.** `artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even` branches the error and warns with serve point, route and count; a throw is warned separately and recorded as `threw`. |
| C26 | L2 rows purged **past** expiry because stale rows are served | `01` §7 governs cache **bypass**, not cleanup | **C survives** — but see §5, note (b): the spec-level judgement on the path C26 describes is DV-03's `W` |
| C27 | photo store never stores a credential | `09` §10 security posture (different domain) | **C survives** |
| C28 | `discovery_places` client write boundary (GRANT) | `10` §5 requires four explicit RLS policies per user-visible table — that is DV-71's `W`; C28's claim is about the GRANT | **C survives**, and the qualifier is repeated rather than dropped: it rests on a catalogue read taken **2026-09-07** and **not** re-verified here (no production read was made by this pass) |
| C29 | serve-point report refuses a verdict on an empty window | `01` §6 evidence integrity | **C survives** |
| C30 | momentum is non-negative with a minimum-evidence floor | `03` §12 *"Trending should require diversity of evidence"* — that bar is DV-32's `W` | **C survives** |
| C31 | stale L2 entries served while revalidation runs | `01` §7 Cache A | **C survives** — see §5 note (b) |
| **C32** | **"One ranking pipeline in the tree — the route no longer imports the ranker directly"** | `10` §1 *"Avoid parallel systems"*; `docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy`; `06` §3 | **C survives on its stated evidence; its CONTRACT SENTENCE is falsified.** The evidence claim — that `routes/discovery.ts` imports `portavaRank` type-only — holds. The sentence *"one ranking pipeline in the tree"* does not: `artifacts/api-server/src/routes/discovery.ts:36#import { rankItemsForDiscovery } from "../` is a **value** import of Compass's ranker and it is called on the same route at `:2128`. Two rankers order a Discovery page, chosen by `category`. **No verdict move** — the row's evidence proves what it proves. The spec-level obligation the sentence claims is now **DC-24**, graded `W`. |
| C33 | the two `profiles` reads are the caller's own `date_of_birth` | `04` §12 privacy | **C survives** |

**Result: 33 re-derived · 31 unchanged · 1 confirmed already-moved (C14) · 1 mis-stated reason with a
surviving verdict (C32) · 0 new verdict moves.** The substitute denominator's weakest third holds up
better against the real specification than its own §1 caveat predicted — with the one exception the
specification contradicts outright.

### 2.4 Two citation pointers in the A rows are wrong, and are corrected

Found by re-reading every A-row quotation at its cited line in the owner-supplied spec. The quoted
**text** is right in both cases; the **line** is not, and both land on a different surface's row of
the same table — the in-range-but-wrong class this census has recorded four times before.

| Row | Cited | What is actually at that line | What the row quotes, and where it really is |
|---|---|---|---|
| **A14** | Layover §25 `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:754#Map` | `Map` | *"Only show experiences from certified action universe in Layover mode"* is at **`docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:753#Only show experiences from certified actio`**, under the `Discovery` label at `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:752#Discovery` |
| **A16** | Passport §21 `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:213#Identity, relevant trust eligibility, lang` | the **Trips** projection, not Discovery's | *"Identity, verification, availability, Open to Plans, shared context, permitted trust summary"* is at **`docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:211#Identity, verification, availability, Open`**, under the `Discovery` label at `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:210#Discovery` |

Neither changes a verdict. Both are repaired in census-discovery §14.3, and both are named here
because a pointer that lands on another surface's row is exactly how a requirement gets quietly
re-scoped.

---

## 3. The DSV2 disposition, verified against the specification rather than trusted

`docs/architecture/census-discovery.md:763#**DSV2, all twelve.** Eight DUPLICATE, fou` states: *"**DSV2, all twelve.** Eight DUPLICATE, four SPLIT, none a pure
ADDITION."* Each of the twelve was re-read in `docs/specs/upgrades-v2/02-DISCOVERY-v2.md` and matched
against the row it is dispositioned onto.

**The headline count is correct.** DUPLICATE = DSV2-01, -02, -03, -07, -08, -09, -10, -11 (**8**).
SPLIT = DSV2-04, -05, -06, -12 (**4**). ADDITION = **0**. Verified, not inherited.

**Two sub-clauses were not enumerated when the disposition was written, and both are real:**

| Where | The un-enumerated clause | Disposition now |
|---|---|---|
| DSV2-07 | *"…and actual outcomes stay distinct from predictions."* The §11.4 row names four clauses and stops at *"exposures have denominators"*. | **DUPLICATE of A03** — truth class on the served projection is exactly the observation/prediction separation, and A03 grades it. Counted once at A03; no new row. |
| DSV2-12 | *"…no synthetic production visits, conversions or Trust awards."* The §11.4 row splits only the traceability half. | **ADDITION → DC-34**, graded `C`. |
| DSV2-01 | *"…real search and recommendation routes are both exercised."* A test-coverage obligation A02 does not grade. | **DUPLICATE of DC-33**, the DSV2 wiring-test obligation added below. |

So the sentence at `docs/architecture/census-discovery.md:763#**DSV2, all twelve.** Eight DUPLICATE, fou` survives as written, with three clauses now placed rather than
unaccounted. One of the three is a genuine addition, which is why *"none a pure ADDITION"* is true of
the twelve requirement rows and not of every sentence in the document.

---

## 4. Coverage gaps — spec clauses with no census row, and what they grade to

Thirty-four enumerated obligations had **no row in the 153**. Each was checked against all 153
existing rows for overlap of subject — not for a missing citation — before being added. Each is
graded here with evidence read at this tree; the rows are carried in census-discovery §14.1 so
`check:census-integrity` counts them.

Ids are `DC-nn`. The prefix is deliberately two letters ending in a letter: §11.13 measured that
`parseIdCell` reads a prefix ending in a digit as a RANGE, so `DSV2-04` would expand to phantom ids.
`DC-01` parses as one id.

### 4.1 `01` Portava Discovery Engine

| id | Clause | Verdict | Evidence, read at this tree |
|---|---|---|---|
| DC-01 | §4 — `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:96#PDE should rank or recommend:` ten output kinds: posts, places, events, Trails, trips, Shared Moments, travelers, circles, itineraries, emerging discoveries | **W** | 7 of 10. Present: posts, places, events, trips, travelers, circles, and itineraries as `plans` — eighteen retrieval types at `artifacts/api-server/src/routes/discoverySearch.ts:126#const SEARCH_TYPES = [`, nine ranked candidate kinds at `artifacts/api-server/src/lib/portavaRank.ts:29#export type CandidateKind =`. **Trails FAIL** (no object, DV-20). **Shared Moments FAIL** — `grep -rIn -i "shared_moment\|sharedMoment" routes/discovery*.ts lib/discovery*.ts lib/portavaRank.ts` → nothing; the kind is not in `SEARCH_TYPES` and not in `CandidateKind`. **Emerging discoveries FAIL** — trend states now exist (DV-28) but behind `discovery_ranking_modifiers_enabled` and never as an output kind. |

### 4.2 `02` Trails — four clauses, one reason

All four are `N` for the single reason DV-20 records and §11.3a verified in production: no Trail
object exists in the repository or in `ajrurzioarfkagpuxfnb`. They are enumerated rather than folded
because each is separately falsifiable the moment a Trail table lands, and an enumeration that drops
the obligations of an absent subsystem understates what building it must satisfy.

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-02 | §4 — `docs/specs/discovery-v1/02_Trails.md:58#Do not let creators attach unlimited disco` | **N** | No Trail or Signal label exists to attach. The analogous control on the label system that *does* exist is real and is named rather than counted: hashtags are capped at `artifacts/api-server/src/services/tagging/tagPolicy.ts:47#export const MAX_HASHTAGS = 20;`. Graded `N` on DV-13's precedent — a page-scoped or tag-scoped analogue is not the Trail-scoped control the clause names. |
| DC-03 | §5 — `docs/specs/discovery-v1/02_Trails.md:68#Creation should require canonicalization c` (duplicate title similarity, destination overlap, semantic overlap, existing parent/child) | **N** | No Trail creation path. |
| DC-04 | §7 — Trail lifecycle (proposed/active/needs_update/stale/archived) and in-Trail content lifecycle (six states) | **N** | Neither state machine exists under any name. Distinct from DV-28: that is `03` §9's **place** momentum, which was built; this is a **Trail** and **content** lifecycle, and `03` §4's content lifecycle is separately recorded as absent inside DV-28's `W`. |
| DC-05 | §11 — nine Trail health metrics; `docs/specs/discovery-v1/02_Trails.md:163#Trail health should influence ranking but ` | **N** | No Trail, no health snapshot, no ranking input. |

### 4.3 `03` Trending

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-06 | §7 — `docs/specs/discovery-v1/03_Trending.md:106#Trend velocity must be normalized by:` exposure · creator baseline · Trail baseline · location baseline · time-of-day effects · content age | **W** | 2 of 6. **exposure PASS** — the denominator is `content_distribution_stats.eligible_impressions`, incremented on the impression path only (DV-30 `C`). **content age PASS** — recency weighting inside the momentum window, and the place's own 30-day baseline at `artifacts/api-server/src/lib/discoveryLocalMomentum.ts:66#export const MOMENTUM_RECENT_WINDOW_MS   =`. **creator baseline FAIL · Trail baseline FAIL · location baseline FAIL · time-of-day FAIL** — no such normaliser exists under any name; momentum divides a place by *itself*, never by its creator, its Trail, its city or the hour. DV-30's `C` is against `03` §14's one-word criterion *"it normalizes for exposure"* and stands; §7's six-way requirement is this row and had none. |
| DC-07 | §13 — store raw behavior events · aggregated windows · trend state snapshots · explanation features · model/version references; `docs/specs/discovery-v1/03_Trending.md:182#Do not store one opaque “trend score” ` | **W** | 1 of 5 durable, and the prohibition held. **raw events PASS** — `rank_events`. **aggregated windows FAIL · state snapshots FAIL · explanation features FAIL · model/version FAIL** — the three windows at `artifacts/api-server/src/lib/discoveryTrendState.ts:88#export const TREND_RECENT_MS = 48 * HOUR;` are recomputed per request into a ten-minute process cache and never persisted; no `place_momentum` table exists in repository or production (§11.3a). **The prohibition is satisfied** — and vacuously, because nothing durable is stored at all, which is the opposite failure from the one it guards against and is said plainly rather than scored as a win. |

### 4.4 `04` Behavior Engine

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-08 | §2 *"Do not create a new parallel behavior store before fixing `rank_events`"* + `docs/specs/discovery-v1/04_Behavior_Engine.md:134#If the current table cannot represent this` + `10` §1 *"Avoid parallel systems"* | **C** | Discovery writes behaviour evidence to exactly one store: `artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`. The three fields `04` §5 named as missing were put **into the `features` jsonb that table already writes** rather than into a new table (§13.3), and the vocabulary was extended by migration (`0197`, `0199`, `0202`, `2297`, `2298`). `discovery_shadow_serves` (`artifacts/api-server/src/lib/discoveryShadow.ts:371#const { error } = await sc.from("discovery`) is not a counter-example: it is `12` Phase 9's shadow comparison record, which the specification itself asks for, and C22 pins that it never changes what was served. **What would turn this red:** any Discovery insert of an impression or outcome row into a table other than `rank_events`. |
| DC-09 | §8 — `docs/specs/discovery-v1/04_Behavior_Engine.md:153#Sequence features should be derived downst` | **W** | 1 of 2 halves. **The prohibition PASSES:** no client computes a chain. The client sends single discrete outcomes and the funnel logic is server-side at `artifacts/api-server/src/routes/rankEvents.ts:139#export function upgradableOutcomesFor(outc`, applied at `artifacts/api-server/src/routes/rankEvents.ts:208#.in("outcome", upgradableOutcomesFor(outco`. **The obligation FAILS:** *"derived downstream"* has no implementation either — none of §8's four named chains (impression→place_open→save→trip_add, video_complete→replay→send, Trail open→place open→directions, post→place visit→post-visit confirmation) exists as a feature anywhere. Nothing is hard-coded in the client because nothing is computed at all. |

### 4.5 `05` Graph Engine

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-10 | §8 — *"Start relationally in Postgres. "* `docs/specs/discovery-v1/05_Graph_Engine.md:110#Do not introduce a graph database until qu` | **C** | No graph-database dependency exists: the api-server manifest carries no `neo4j`, `gremlin`, `neptune`, `arango`, `janus`, `dgraph` or `tigergraph` package. The graph that ships is two Postgres tables (`artifacts/api-server/src/migrations/20260730_compass_intelligence_graph.sql`). §8's second half — the four materialized projections — is DV-72's `W` and is not re-counted here. **What would turn this red:** a graph-DB client dependency, or an external graph service in the serve path. |

### 4.6 `06` Recommendation Engine

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-11 | §1 — the ten-stage pipeline: context assembly · candidate generation · eligibility · feature computation · scoring · diversity/exploration · integrity checks · serve · log recommendation · learn from outcomes | **W** | 7 of 10 reachable. PASS: context assembly (`loadPdeViewer`), candidate generation, eligibility (and, since §11.8, on the Cache-B hit path too), feature computation and scoring (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION = "co`), diversity (`artifacts/api-server/src/lib/portavaRank.ts:367#// ── Diversity (greedy MMR-style re-r`, ungated), serve, log recommendation (`artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`, flag-enabled in production). **exploration PARTIAL→FAIL** — `artifacts/api-server/src/lib/discoveryPde.ts:754#governor = allocateExplorationBudget(gc, {` sits inside the modifiers flag, seeded FALSE (DV-53). **integrity checks FAIL** — the only integrity term is an author-trust down-weight (DV-12 `W`); none of `03` §12's eight patterns is detected. **learn from outcomes FAIL** — outcomes are ingested and nothing learns from them; `artifacts/api-server/src/lib/portavaRank.ts:29#export type CandidateKind =`'s module header names weight fitting as a future phase. |
| DC-12 | §2 — eleven candidate sources | **W** | 2 of 11, and the tree says so itself: `artifacts/api-server/src/lib/discoveryRankProvenance.ts:84#* Discovery's serve path today has exactly` — *"Discovery's serve path today has exactly two retrievals plus the case where neither claimed the row, and inventing the other nine would be describing a pipeline that does not run."* The two are curated/canonical rows and the OSM directory read. |
| DC-13 | §3 — eleven feature families; `docs/specs/discovery-v1/06_Recommendation_Engine.md:45#Do not collapse everything into one perman` | **W** | **The prohibition PASSES** — scoring is per request, and since §12 the raw and derived halves are separate fields (DV-48 `C`), so nothing permanent or universal is stored. **The families FAIL as families:** the ranker Discovery runs is a flat seventeen-weight bag with no family grouping; `trail_relevance` has no term (no object) and `negative_feedback` has none. A **named-family** configuration does exist — `artifacts/api-server/src/services/ranking/rankingConfig.ts:71#export interface RankingWeights {` with `artifacts/api-server/src/services/ranking/rankingConfig.ts:98#negativeFeedback: number;` — in a service that declares a `discovery` surface at `artifacts/api-server/src/services/ranking/DiscoveryRankingService.ts:32#| "discovery"` and that **no Discovery route imports**. The families the specification asks for are in the tree and not on Discovery's path. |
| DC-14 | §10 — compute old · compute PDE · compare overlap · compare offline utility · `docs/specs/discovery-v1/06_Recommendation_Engine.md:119#- store counterfactual recommendation sets`; flag keeps user-visible output unchanged | **W** | All six mechanisms are in code and **none has ever run**. Both orders and the counterfactual set are stored on one row (`artifacts/api-server/src/lib/discoveryShadow.ts:371#const { error } = await sc.from("discovery`); overlap and three further dimensions are computed (DV-79, 4 of 6); the flag-inertness leg is C22/C23/C24. `W` because `discovery_shadow_serves` holds **0 rows in production** (census §5) and `DISCOVERY_ENGINE_MODE` is seeded `legacy`, so no comparison the clause exists to produce has ever been produced. |

### 4.7 `10` Database Architecture

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-15 | §4 — every new query path has expected cardinality · index rationale · `docs/specs/discovery-v1/10_Database_Architecture.md:70#- EXPLAIN verification where meaningful.` | **W** | 1 of 3. **rationale PARTIAL-PASS** — present on some (`artifacts/api-server/src/migrations/2092_discovery_shadow_serves.sql:159#-- Per-key chronology: the natural unit of`) and absent on others (`artifacts/api-server/src/migrations/0168_discovery_cache_ddl.sql:25#CREATE INDEX IF NOT EXISTS discovery_cache` carries none). **expected cardinality FAIL** — stated in no Discovery migration. **EXPLAIN FAIL** — `grep -l EXPLAIN src/migrations/*discovery*` → nothing. |
| DC-16 | §6 — SECURITY DEFINER only when necessary · `docs/specs/discovery-v1/10_Database_Architecture.md:89#Pin `search_path`.` · prefer explicit schema qualification | **C** | Discovery owns exactly one SECURITY DEFINER function and it meets all three. Necessity is argued in-file; `artifacts/api-server/src/migrations/0089_decrement_discovery_place_saved_count.sql:39#SET search_path = public` pins the path and `artifacts/api-server/src/migrations/0089_decrement_discovery_place_saved_count.sql:21#--   • SET search_path = public prevents` states why; PUBLIC's implicit grant is revoked and EXECUTE restored only to `service_role`. It is not an unreferenced oracle — `artifacts/api-server/src/routes/wishlist.ts:210#"decrement_discovery_place_saved_count",` calls it — and `src/scripts/checkSecurityDefinerOracles.ts` guards that class. **What would turn this red:** a SECURITY DEFINER function in a Discovery migration without `SET search_path`, or one with no reference. |
| DC-17 | §9 — `docs/specs/discovery-v1/10_Database_Architecture.md:115#Derived features must retain:` source event window · feature version · model version · computation time | **W** | Split, and the split is the finding. **On the rank provenance: 3 of 4** — `artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION = "co`, `artifacts/api-server/src/lib/discoveryRankProvenance.ts:80#export const DISCOVERY_FEATURE_VERSION = "` and a ranking timestamp read when the ranker returned; **source event window FAIL**. **On the two derived stores that actually compute over an event window: 0 of 4** — the momentum map is `place id → number` and the trend reading is a state plus three rates; neither output carries the window it was computed over (`artifacts/api-server/src/lib/discoveryTrendState.ts:88#export const TREND_RECENT_MS = 48 * HOUR;` is a module constant, not a field on the result), a feature version, a model version or a computation time. A consumer cannot tell which window produced a value. |
| DC-18 | §7 — `docs/specs/discovery-v1/10_Database_Architecture.md:94#- never edit an applied migration unless r` · new behaviour gets a new migration · rehearse on `portava-ci` · production rollout only after CI rehearsal (the fifth rule, *"drift audit must explain every object"*, is DV-70's and is not re-counted) | **W** | **new migration per behaviour PASSES**, checkable from the repository alone: every Discovery capability of the last two weeks got its own file — 2289, 2360, 2361, 2550, 2850. **never-edit-an-applied-migration:** the machinery exists and reports exactly this as its own finding (`artifacts/api-server/src/scripts/checkMigrationLedger.ts:28#*   3. Checksum mismatches               ` — *"a file EDITED after it was applied"*), but it compares against a live database **and this pass made no database connection**, so its current state is not certified here. **CI rehearsal / rollout order:** runbooks exist; the terminal state does not — census §5 records 2420, 2220 and 2760–2785 unapplied to production. |

### 4.8 `11` API Specification

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-19 | §2 — `docs/specs/discovery-v1/11_API_Specification.md:14#Prefer server-generated recommendation/exp` plus four conceptual actions: create recommendation exposure · record client behavior batch · validate event schema · query internal diagnostics | **W** | 3 of 4. **server-generated PASS** — the exposure record and its id are minted server-side after the response (`artifacts/api-server/src/lib/discoveryServeLog.ts:444#const { error } = await sc.from("rank_even`), never accepted from a client. **validate event schema PASS** — route-level vocabularies plus database CHECKs (DV-35). **diagnostics PASS** — `artifacts/api-server/src/lib/discoveryServePointReport.ts`. **batch FAIL** — `artifacts/api-server/src/routes/rankEvents.ts:44#router.post("/rank-events", asyncHandler(a` takes one event; there is no array form and no batch endpoint, and §2's own permission (*"Batching is acceptable for high-volume client telemetry"*) is unexercised. |
| DC-20 | §3 — Trails API: list/search · get · modules · follow/unfollow · suggest association · attach/detach · propose · report mismatch · related | **N** | 0 of 9. No Trail route exists. |
| DC-21 | §4 — Trending API: by location · by Trail · personalized · trend explanation · emerging places/Trails | **N** | 0 of 5. Trend states and explanations are computed (DV-28, DV-33) and reach no route; `grep -n trending artifacts/api-server/src/routes/discovery.ts` → nothing. §4's second sentence (*"Never return internal raw scores"*) is DV-27's `C` and is not re-counted. |
| DC-22 | §5 — Recommendation API outputs: recommendation_id · items · reason labels where user-facing · cursor · model/version internally | **W** | 2 of 5 delivered. **items PASS.** **model/version internally PASS** — carried on the Cache-B entry independently of any flag (DV-04). **recommendation_id FAIL** — §13.3 states it plainly: the id is server-side only and no client receives one. **reason labels FAIL** — produced (DV-18) but behind `discovery_candidate_projection_enabled` (2361, seeded FALSE), so no deployment delivers one. **cursor FAIL for this surface** — `GET /discovery` paginates by `page`; the cursor exists on `/discovery/search`, which `11` §5 is not about. |
| DC-23 | §6 — creator-economy API reads (impact summaries · attributed conversions · provisional earnings · payout eligibility) and *"No client-side earning calculation"* | **N** | 0 of 4 reads. The prohibition is satisfied by absence and that is not scored as a pass: on DV-62's reasoning, recording an absent system's guardrail as `C` would weaken the requirement, and the substance of §6 is the four reads. |

### 4.9 `12` Implementation Plan

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-24 | §0 — `docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy` | **W** | **The positive half PASSES and is worth saying:** the PDE work extended existing owners rather than starting over — the ranker was MOVED not copied, the serve log extends `rank_events`, the recommendation id went into an existing jsonb, and `12` Phase 2's cache work edits the existing caches. **The half that fails is the parallel one.** Three ranking implementations can order a Discovery item: `artifacts/api-server/src/lib/portavaRank.ts:29#export type CandidateKind =` via `rankForViewer`; Compass's, value-imported into the same route at `artifacts/api-server/src/routes/discovery.ts:36#import { rankItemsForDiscovery } from "../` and selected by `category`; and `artifacts/api-server/src/services/ranking/DiscoveryRankingService.ts:32#| "discovery"`, which declares a `discovery` surface, reads the named feature families, and **no Discovery route imports**. `10` §1's *"Avoid parallel systems"* is not met, and C32's contract sentence claims otherwise (§2.3). |
| DC-25 | Phase 2 — deliver a design note documenting candidate cache key · ranking cache key · invalidation · model/version handling · personalization boundary | **W** | All five are documented, in code rather than in a note, and one of the five is documented *and violated*. Cache keys and the asymmetry between them: `artifacts/api-server/src/lib/discoveryCacheEligibility.ts:2#* discoveryCacheEligibility — the authoriz` and the header beneath it. Invalidation: the four-reason acceptance rule (DSV2-06 `C`). Model/version handling: `artifacts/api-server/src/lib/discoveryRankProvenance.ts:80#export const DISCOVERY_FEATURE_VERSION = "`. **Personalization boundary: documented and crossed** — DV-03 `W`, serve points 1/2/3 hand the cached order to the user unranked on every deployment. And the deliverable §2 actually names — one design note — does not exist as an artefact. |
| DC-26 | Required test classes — 5 unit · 5 integration · 3 database · 3 shadow diagnostics | **W** | ~9 of 16. PASS: scoring feature transforms, trend lifecycle, event write path, feature-flag OFF inertness, schema drift, CI rehearsal, old-vs-new ranking comparison, cache-path correctness, recommendation coverage. FAIL: Trail lifecycle, Trail visibility, ledger math, attribution rule versioning, recommendation→behavior→attribution (four absent subsystems). **RLS is the one worth naming separately:** the suite that would prove it skips without live credentials and the `test` script pins an unreachable `SUPABASE_URL`, so a green run proves nothing — C28's recorded limitation, restated because `12` asks for this class by name. |
| DC-27 | Deployment rules — rehearse on `portava-ci` → run all verdict checks → shadow first → activate small cohort → observe → expand | **?** | **CANNOT-VERIFY, and recorded as such rather than guessed in either direction.** Discovery has never been rolled out: `DISCOVERY_ENGINE_MODE` is `legacy`, shadow mode has written 0 rows in production, and no cohort has been activated. The six steps describe a sequence that has not begun, so nothing in the repository can say whether it is followed. **Evidence that would settle it:** a rollout record showing rehearsal, verdict-check results, a shadow window and a cohort activation, in that order. **Who supplies it:** the integration owner and the operator; no agent can. |

### 4.10 DSV2 prose and release gates

| id | Clause | Verdict | Evidence |
|---|---|---|---|
| DC-28 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:13#DiscoveryCandidate is a logical extension ` — *"Do not persist transient crowd or vibe as durable place identity attributes."* | **C** | No Discovery migration adds a crowd or vibe column to any place table, and the live layer states the rule about itself and is read-only: `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:28#* NEVER PERSISTED. The grades are properti` — *"The grades are properties of THIS serve … never written into Cache A / L2."* `grep -n "insert\|upsert\|update" lib/discoveryLiveRank.ts lib/discoveryLiveRankRead.ts` → nothing. **What would turn this red:** any write of a crowd or vibe value onto `discovery_places` or `places`, or into the user-independent L2 cache. |
| DC-29 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:11#Search answers which entities match. Recom` — *"Chronological Wall stays chronological; Discovery does not take ownership of it."* | **C** | No Discovery route or lib writes to or orders the Wall: `grep -nE "\bWall\b|wall_|\"wall\"" routes/discovery.ts routes/discoverySearch.ts lib/discovery*.ts` returns **one** line in the whole surface — a prose comment at `artifacts/api-server/src/lib/discoveryCandidate.ts:9#* state consumed by Map / Discovery / Wall /` naming Wall as a fellow consumer of truth-class state. No table read, no write, no ordering. The Wall's Discovery **insertion** is `services/wall/`, which census-discovery §1 explicitly excluded and census-wall owns — named so this `C` is not read as covering it. |
| DC-30 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:34#Never use private message contents or infe` — *"Anonymous contributors cannot become discoverable people."* | **C** | Four independent paths, each already pinned: `submitted_by` is never serialised (C16, with a named test); the community byline resolves through one `nameAllowed` decision and is withheld unless the viewer is the submitter or the submitter opted in (C18, C19); `searchTravelers` requires `allow_profile_discovery` and fails closed (C02); and the live read set carries no contributor identity at all — `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:51#export const RANK_CLAIM_TYPES = [` — *"Nothing else is read, so nothing else can leak."* |
| DC-31 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:36#When live state is unavailable, retain per` — *"Temporary world objects retain their own valid identity instead of borrowing an arbitrary venue ID."* | **C** | Discovery has no temporary world object type, and the direction of the one identity join it does make is the safe one: the live layer reads claims **for** an existing `canonicalPlaceId` rather than minting a place **from** a claim (`artifacts/api-server/src/lib/discoveryLiveRankRead.ts:51#export const RANK_CLAIM_TYPES = [`). **What would turn this red:** any Discovery code that assigns an existing `places.id` or `discovery_places.id` to a transient observation — a crowd reading, a vibe state, an unidentified activity cluster — which is START_HERE's *"never substitute … a nearby place for an unidentified activity cluster."* |
| DC-32 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:42#Existing Ranker and Event Truth holds are ` — *"Reuse approved weights, exploration budgets, sensitive-location policy, freshness and thresholds. Ask for missing policies rather than choosing silent production defaults."* | **W** | 2 of 5. **exploration budget PASSES** — `artifacts/api-server/src/services/ranking/FeedSlotAllocator.ts:358#export const GOVERNOR_BUDGET_MIN_PCT = 15;` is the owner's ruling, `docs/discovery/ROADMAP.md` step 8, *"budget ~15–25 % with reason codes"*. **momentum cap PASSES** — `LOCAL_MOMENTUM_MAX_CONTRIBUTION` is ROADMAP step 7 made numeric and the module says it may change only with a ruling. **sensitive-location policy FAILS** — `lib/protectedLocations.ts` is consulted by nothing in Discovery (B04 `W`). **thresholds FAIL, and this one is a live instance of the gate rather than a legacy gap:** `artifacts/api-server/src/lib/discoveryStopConditions.ts:121#export const EVENT_REJECTION_RATE_THRESHOL` and the 10 % gap beside it were chosen by the lane that built them; census §12.5 discloses that they are *"this lane's proposals, not a ruling"*, which is honest disclosure of exactly what this clause tells an implementer not to do. **freshness thresholds FAIL** — `TREND_MIN_RATE`, the momentum evidence floor and `TRAVEL_HORIZON_MINUTES` are in-code constants with no ruling cited. |
| DC-33 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:38#Test real route→service→projection→c` — test real route→service→projection→client wiring including cache hits, expiry, permission changes, sparse coverage, empty candidates, dependency failure and retry | **W** | 5 of 7 conditions, and the wiring is tested in two disconnected halves. PASS: cache hits, expiry (TTL boundary), permission changes (a block taken inside the TTL), dependency failure (an unreadable block set), empty candidates. **retry FAIL** — there is no retry path to test (DV-37 `N`, and the writer is called once, `void`, after the response). **The client leg FAILS as a leg:** server tests stand the route up and stop at the response, and the client component tests mock the service they would have to cross — `travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryScreen.component.test.tsx:65#jest.mock('../../../services/discovery', ()`. Nothing in the tree exercises route→service→projection→client end to end. |
| DC-34 | `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:30#| DSV2-12 | Measure real utility and calib` — *"no synthetic production visits, conversions or Trust awards"* | **C** | No conversion, visit-confirmation or Trust-award writer exists on this surface (`conversion_events`, `attribution_records` and the ledger tables are NULL in production, §11.3a), so nothing can synthesise one. It is `C` rather than vacuous because the surrounding passes had the opportunity and declined it in writing twice: `whyNow` stays null rather than being manufactured from static popularity (A03), and three `01` §11 reason codes with no producer are named as producerless rather than emitted (DV-18, with a test that fails if one is). **What would turn this red:** any Discovery write that records a visit, conversion or award the user did not perform. |

---

## 5. Grades, with denominators

**Every count below is over the census's full population, and both the old and new denominators are
stated, because a percentage over an undeclared denominator is the thing this whole exercise exists
to prevent.**

| | rows | BUILT-AND-CORRECT | BUILT-BUT-WRONG | NOT-BUILT | CANNOT-VERIFY | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|---|---|
| **Before** — census §13.6 | 153 | 66 | 49 | 36 | 2 | 115/153 = **75.2 %** | 66/153 = **43.1 %** |
| **The 34 coverage-gap rows added here** | 34 | 8 | 18 | 7 | 1 | 26/34 = 76.5 % | 8/34 = 23.5 % |
| **After** | **187** | **74** | **67** | **43** | **3** | **141/187 = 75.4 %** | **74/187 = 39.6 %** |
| delta | +34 | +8 | +18 | +7 | +1 | +0.2 pts | **−3.5 pts** |

**No code changed between the two measurements, and no existing verdict moved.** The whole of the
−3.5 points is denominator: obligations the specification states that no row was counting.

Per-bucket, over the 34 new rows:

- **BUILT-AND-CORRECT — 8 of 34.** DC-08, DC-10, DC-16, DC-28, DC-29, DC-30, DC-31, DC-34. Each
  cites a `file:LINE#needle` opened at this tree, and each names what would turn it red. Four of the
  eight (DC-28, DC-29, DC-31, DC-34) are prohibitions rather than constructions; each is `C` because
  a specific mechanism actively holds the line, not because nothing happens — and where a `C` would
  have been vacuous the row is `N` instead (DC-23, on DV-62's reasoning).
- **BUILT-BUT-WRONG — 18 of 34**, every one with the failing half named and counted:
  DC-01 (7/10) · DC-06 (2/6) · DC-07 (1/5) · DC-09 (1/2) · DC-11 (7/10) · DC-12 (2/11) ·
  DC-13 (families absent, prohibition met) · DC-14 (6 mechanisms, 0 runs) · DC-15 (1/3) ·
  DC-17 (3/4 and 0/4) · DC-18 (1 of 4 certifiable here) · DC-19 (3/4) · DC-22 (2/5) ·
  DC-24 (positive half met, parallel half not) · DC-25 (5 documented, 1 violated, 0 notes) ·
  DC-26 (~9/16) · DC-32 (2/5) · DC-33 (5/7).
- **NOT-BUILT — 7 of 34.** DC-02, DC-03, DC-04, DC-05 (Trails, one reason, verified NULL in
  production by §11.3a and re-grepped here); DC-20, DC-21, DC-23 (three absent API surfaces).
- **CANNOT-VERIFY — 1 of 34.** DC-27, with the evidence and its supplier named in the row.

Two notes the numbers do not carry:

(a) **The gap between CONSTRUCTED and CORRECT is now 35.8 points over 187 rows.** The census's §10.6
  finding still explains most of it — flag-capped, caller-less, or waiting on a decision — and the
  34 new rows add a fourth shape: *specified, partially built, never enumerated*. DC-06, DC-12,
  DC-13, DC-17 and DC-19 are all code that exists and does two-thirds of what its clause asks.

(b) **Three `C` rows sit on code paths a spec-derived row grades `W`.** C26 and C31 certify the L2
  stale-serve behaviour against the code's own memory note; DV-03 grades the bypass over the same
  path `W`. C30 certifies the momentum evidence floor; DV-32 grades `03` §12's diversity-of-evidence
  bar `W`. **None is a mis-grade** — each `C` claim is narrower than the `W` claim and both are true
  — but a reader counting `C`s on the cache and momentum paths should know that the specification's
  own judgement on those paths is the `W`.

---

## 6. Findings that are not verdict moves

1. **C32's contract sentence is falsified by its own file.** §2.3. Verdict stands; the sentence
   *"One ranking pipeline in the tree"* should read *"the route does not value-import `portavaRank`"*,
   which is what its evidence proves. The claim the sentence makes is DC-24, `W`.
2. **Two A-row citations land on another surface's row of the same table.** §2.4 — A14 `docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt:754#Map` → `:753`,
   A16 `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:213#Identity, relevant trust eligibility, lang` → `:211`. Repaired in census §14.3.
3. **`02` was enumerated from §19 alone.** The census's Trail rows are `02` §19's eight acceptance
   criteria; the document states four further testable obligations, added here as DC-02…DC-05. All
   four are `N` for the reason DV-20 already records, so the finding is an enumeration finding and
   not a new absence — but the four are what a Trails build must additionally satisfy, and a
   denominator that omits them understates that build.
4. **`03` §7's six-way normalization requirement had no row.** DV-30's `C` is against `03` §14's
   one-word criterion and is correct as scored; §7 asks for six bases and two are met. DC-06.
5. **The specification is installed twice.** §0. Cross-lane request X1.
6. **`services/ranking/DiscoveryRankingService.ts` declares a `discovery` surface and reads the
   eleven-family weight configuration `06` §3 asks for — and nothing on Discovery's path calls it.**
   This is the single largest "already built, not wired" finding of this pass, and it is reported
   rather than wired: the file is another lane's and wiring it would change the order of a live
   route. It bears on DC-13, DC-24 and DV-09, which all three now name it.

---

## 7. Attribution — separate from compliance, and with its own rule

**The rule applied, stated so it can be checked:** a file is attributed only on positive evidence —
an in-file header naming **this** specification (a `docs/specs/discovery-v1/` path, a backticked
`NN` § reference into it, or a `DSV2-nn` id) or naming a **different** specification. Age is not
evidence. Nothing here infers that code was not built from this specification because it predates the
specification's upload into this repository; a specification can exist outside a repository, and the
census records that this one did.

**The repository cannot supply attribution by history**, which is why the in-file header is the only
admissible evidence: `git log --diff-filter=A` reports `routes/discovery.ts`, `lib/portavaRank.ts`,
`lib/discoveryPde.ts` and `lib/discoveryServeLog.ts` as all created by the **same commit on the same
day** (`a745ba11b`, 2026-09-05). That is an import, not a build history. Measured, not assumed.

Over the **26 source files** census-discovery grades as Discovery's own — the twenty-three
`lib/discovery*.ts` modules, `lib/portavaRank.ts`, `routes/discovery.ts` and `routes/discoverySearch.ts`:

| Attribution | Count | Files |
|---|---|---|
| **Attributable to THIS specification** | **13** | `discoveryCacheEligibility` · `discoveryCandidate` · `discoveryDivergenceReport` · `discoveryLocalMomentum` · `discoveryModifiers` · `discoveryRankProvenance` · `discoveryReasonCodes` · `discoveryRecommendationId` · `discoveryServeLog` · `discoveryShadow` · `discoveryStopConditions` · `discoveryTrendState` · `routes/discovery.ts` |
| **Attributable ELSEWHERE** | **5** | `discoveryLiveRank` and `discoveryLiveRankRead` (Sensing §8) · `discoveryTripProjectionConsumer` (Trips §19.1) · `portavaRank` (*"spec §42"*, `PORTAVA-ALGORITHM.md`) · `routes/discoverySearch.ts` (Passport, Trips, Map, GII and `.agents/memory/` rules) |
| **UNKNOWN** | **8** | `discoveryCacheCleanup` · `discoveryCohort` · `discoveryEngineMode` · `discoveryPde` · `discoveryPersistentCache` · `discoveryPlacePhotoStore` · `discoveryServePointReport` · `discoveryWarmup` |

**The qualification that matters, and it is a large one.** Twelve of the thirteen "attributable to
this specification" files carry their reference because a pass in the last two days *wrote the
reference while grading against the specification* — §11, §12 and §13 of the census. Four of the
thirteen (`discoveryRankProvenance`, `discoveryReasonCodes`, `discoveryStopConditions`,
`discoveryTrendState`) did not exist before 2026-09-14. So the honest reading of the 13 is
**"written against this specification"**, which is a claim about the last two days, and not
**"originally built from this specification"**, which nothing in this repository can establish for
any Discovery file. Both sentences are true of different things and only the first is supported.

**The 8 UNKNOWNs are left UNKNOWN deliberately.** Several of them — `discoveryEngineMode` implements
`01` §8's flag states, `discoveryPde` implements `06` §1's pipeline — read as though they were built
from this package. That is a resemblance, and the rule this lane was given says a resemblance is not
evidence. They stay UNKNOWN until a header, a commit message or the owner says otherwise.

---

## 8. What this pass did not do, and what it hands over

**Not done, stated so nothing above reads as more than it is:**

- **No code, no test, no migration and no flag change.** Every verdict here is a measurement.
  Consequently no citation anywhere in the repository moved, and `check:doc-citations` gained no new
  breakage from this lane.
- **No production read.** Every production figure quoted or relied on is inherited from census §5
  (2026-09-07) and §11.3a (2026-09-13) and is dated there. C28's grants and B01's absent `search_key`
  remain 2026-09-07 measurements.
- **No row of another census was read or edited.**
- **The 34 new rows were graded by reading code, not by running new tests.** Where an existing test
  pins a claim this document names it; where none does, the row says so. DC-08, DC-10, DC-16, DC-28,
  DC-29, DC-30, DC-31 and DC-34 each name what would turn them red, and none of the eight has a test
  written specifically for it — adding one requires `artifacts/api-server/package.json`, which this
  lane does not own.

**Cross-lane requests — none of these was done here:**

| # | Request | Owner |
|---|---|---|
| X1 | **The owner's Discovery package is installed twice**, byte-identical, at `docs/specs/discovery-v1/` and `docs/specs/discovery-architecture-v1/`. Retire one (the provenance note names the first as canonical) or record the duplication where a reader will find it, before the two fork. | integration owner |
| X2 | **Widen `CENSUS_SCOPE["census-discovery.md"]`** in `src/scripts/checkCensusFreshness.ts` with the eleven files the DC rows are evidenced by: `services/ranking/rankingConfig.ts`, `services/ranking/DiscoveryRankingService.ts`, `services/ranking/FeedSlotAllocator.ts`, `compass/CompassFeedBuilder.ts`, `lib/discoveryLiveRank.ts`, `services/tagging/tagPolicy.ts`, `routes/wishlist.ts`, `migrations/0089_decrement_discovery_place_saved_count.sql`, `migrations/0168_discovery_cache_ddl.sql`, `migrations/2092_discovery_shadow_serves.sql`, `src/scripts/checkMigrationLedger.ts`. **Until it is widened those citations are carried HERE and not in the census**, because `check:census-scope-coverage` floors census-discovery at 96 % and eleven unwatched files would take it to 87 % — a guard this lane will not go red to make a point. `docs/discovery/` is inside `check-doc-citations.mjs`'s COVERED registry, so the anchors above are machine-verified where they sit. | integration owner (`checkCensus*.ts` is a named forbidden file) |
| X3 | **`services/ranking/DiscoveryRankingService.ts` declares a `discovery` surface and the eleven-family weight configuration, and no Discovery route calls it.** Either wire it or retire the surface name; today it is a second owner for Discovery ranking that `10` §1 forbids. Wiring it changes a live route's order, so it is an owner decision, not a lane's. | the ranking-services owner, with an owner ruling |
| X4 | **`checkCensusIntegrity.ts`'s `parseIdCell` still reads a prefix ending in a digit as a range** (§11.13). Unfixed and not this lane's file; `DC-nn` was chosen to avoid it. | integration owner |

**Guard state measured at the end of this pass** (documentation-only change, so these are the same
runs the tree already produced):

| guard | result |
|---|---|
| `check:census-integrity` | **PASSED** before this pass — `discovery 150 · 65 · 49 · 34 · 2 → 153`, 3 rows it cannot read. §14.5 of the census restates it after the additions. |
| `check:doc-citations` | **census-discovery.md contributes ZERO of the 125 broken anchors, zero of the 128 whole-anchor failures, zero of the 2 unresolvable and zero of the 8 uncheckable-shape findings.** Its 113 appearances in the report are all INFO: 103 bare `:NNN` specs (the A rows' line references into other surfaces' spec `.txt` files, which name no file on their line) and 10 multi-candidate basenames. The corpus is red on 263 findings, none of them this census's. |
| `check:citation-symbols` | **PASSED** — 138 symbol-naming citations judged, **0** name a symbol their file does not contain (ceiling 0); 44 point more than two lines from it against a ceiling of 60. |
| `check:census-scope-coverage` | census-discovery **100 %** (73 cited · 73 watched, floor 96 %) — preserved by X2's routing decision. |

**BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.** Discovery
remains dark in production on the last reading anyone took: 13 `surface='discovery'` rows ever, the
most recent 2026-08-15. This pass did not re-measure that and it should not be quoted as current.
