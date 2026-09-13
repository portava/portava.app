# Owner-supplied source specifications, 2026-09-13 — provenance and what they changed

The owner supplied `portava-architecture-upgrades-v2.zip`: three newly authored v2 upgrade
specifications, a framing document, and five bundled baselines with a `SOURCE-MANIFEST.json`
carrying a sha256 per file. This document records what arrived, what was already here, and the
one finding that changes how `census-discovery.md` must be read.

Every file restored below is **byte-exact**: its sha256 equals the one the owner's manifest
declares. Nothing was annotated in place, precisely so that equality stays checkable —
`sha256sum` against the values in this table is the whole verification.

## 1. Three of the five bundled baselines were already in this repository, byte-identical

Checked by `sha256sum`, not by reading:

| Supplied baseline | Already present at | sha256 | Verdict |
|---|---|---|---|
| `compass-master-roadmap.md` | `docs/compass/master-roadmap.md` | `a7a73ec432c923b5…` | **byte-identical** |
| `trust-verified-foundation-plan.md` | `docs/trust/verified-foundation-plan.md` | `193ce14385f68ffd…` | **byte-identical** |
| `sensing-upgrade-v1.docx` | `docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.docx` | `08f5465c083fa9e0…` | **byte-identical** |

These three carry **no new information**. In particular `census-compass.md` §2.1's fifteen
`CX-` rows were already graded against this exact Sensing document, citing its line numbers, so
those rows were never spec-less and are not re-opened by this delivery.

The correction this forces is to a premise of my own, recorded here rather than quietly dropped:
the three censuses were described as having no specification. That was true of **Discovery's
requirements** and of the **v2 upgrade layer**, and false of the Sensing obligations already
counted. It was also false in a second way — see §3.

## 2. What was genuinely new, and where it now lives

| Restored to | Lines | sha256 (16) | Source |
|---|---|---|---|
| `docs/specs/Portava_Architecture_Upgrades_v2_START_HERE.md` | 51 | `fd717afaa205a62b` | `00-START-HERE.md` |
| `docs/specs/Portava_Compass_Architecture_Upgrade_v2.md` | 46 | `a78debc86053d9ab` | `01-COMPASS-v2.md` |
| `docs/specs/Portava_Discovery_Architecture_Upgrade_v2.md` | 42 | `b7f1a246e1636e22` | `02-DISCOVERY-v2.md` |
| `docs/specs/Portava_Trust_Architecture_Upgrade_v2.md` | 46 | `2c31203165d4fe38` | `03-TRUST-v2.md` |
| `docs/specs/compass-phase1-spec.md` | 70 | `dcf1a0581c45d6a7` | `compass-phase1-spec.md` |
| `docs/specs/discovery-architecture-v1/` (13 files) | 2 075 | per file below | `Portava_Discovery_Architecture_v1/` |

The three v2 documents carry **36 numbered upgrade requirements** — `CPV2-01`…`CPV2-12`,
`DSV2-01`…`DSV2-12`, `TRV2-01`…`TRV2-12` — each with a stated evidence requirement and a basis.

### The restored Discovery Architecture v1 package

| Restored file | Lines | sha256 (16) | Original name |
|---|---|---|---|
| `discovery-v1-00-readme.md` | 75 | `f6fe166eba939960` | `00_README.md` |
| `discovery-v1-01-discovery-engine.md` | 276 | `5060b13ca8c8bc0f` | `01_Portava_Discovery_Engine.md` |
| `discovery-v1-02-trails.md` | 283 | `f7072dd7dc9a73c7` | `02_Trails.md` |
| `discovery-v1-03-trending.md` | 193 | `f11d4422c2385c05` | `03_Trending.md` |
| `discovery-v1-04-behavior-engine.md` | 207 | `ac934ff8abbaa356` | `04_Behavior_Engine.md` |
| `discovery-v1-05-graph-engine.md` | 125 | `3b279a2fa456d878` | `05_Graph_Engine.md` |
| `discovery-v1-06-recommendation-engine.md` | 131 | `3e500fd933aee040` | `06_Recommendation_Engine.md` |
| `discovery-v1-07-creator-economy.md` | 121 | `208c9bac59b53a7e` | `07_Creator_Economy.md` |
| `discovery-v1-08-revenue-model.md` | 86 | `9b336148cb2b6f6a` | `08_Portava_Revenue_Model.md` |
| `discovery-v1-09-payment-architecture.md` | 121 | `0197464bb3ab88b2` | `09_Payment_Architecture.md` |
| `discovery-v1-10-database-architecture.md` | 128 | `391979b4f3dc0145` | `10_Database_Architecture.md` |
| `discovery-v1-11-api-specification.md` | 112 | `8dd14ffb29dd2c43` | `11_API_Specification.md` |
| `discovery-v1-12-implementation-plan.md` | 227 | `4841cecb6442a945` | `12_Claude_Code_Implementation.md` |

**Why the basenames were changed, when everything else was preserved byte-for-byte.** The
original names collide with thirteen files already at `docs/architecture/` (§3), and those
basenames are cited — `01_Portava_Discovery_Engine.md` six times, `09_Payment_Architecture.md`
six times. A second file of the same name would make every one of those citations resolve to two
files, which `check:doc-citations` refuses by design (it was taught to refuse ambiguous anchors
deliberately). Renaming the restored copies keeps both sets citable. The bytes inside are
untouched, so the sha256 column above is the proof that renaming was all that happened.

## 3. The finding: Discovery's requirements were overwritten by a description of the code

`docs/architecture/00_README.md` … `12_Claude_Code_Implementation.md` are **the same thirteen
documents, replaced**. `docs/architecture/00_STATUS.md:3-4` states it in its own words:

> "These began life as **PROPOSALS**, not descriptions of the system."

and `:7-9` records the replacement: *"Documents `01`–`06` have since been rewritten as
current-state descriptions derived from the repository."* `05_Graph_Engine.md:5-8` is the
clearest single instance — *"The original `05` described **building** one; this document
describes the running one."*

So at those paths the **requirement** was replaced by a **description of what was built**. That
replacement was recorded honestly and the current-state documents are real, cited work; none of
them is being removed or edited here. But it has one consequence that must be stated plainly,
because it bears directly on a percentage:

> **`census-discovery.md` built its denominator in a period when the Discovery requirements
> existed in the repository only as derivations of the code.** A census measured against a
> document derived from the same code cannot find the code missing. Its 67 rows, at
> C=48 W=12 N=7, are not wrong so much as **scored against the wrong population** — and the
> restored package above is the population they were always owed.

The same hole exists twice more, and by a simpler mechanism — nothing overwrote anything, the
documents were simply never used as a denominator:

- `docs/compass/master-roadmap.md` has been in this repository throughout. `census-compass.md`
  names it **once**, at `:57`, in a descriptive table of "what Compass is". **None** of its
  fifteen phases' *Done when* criteria, its seven global rules or its nine guardrails is a
  counted row.
- `docs/trust/verified-foundation-plan.md` has likewise been present throughout.
  `census-trust.md` names it **zero** times. Its five privacy invariants and its phases
  `V-0`…`V-7` are entirely outside that census's 52 rows — which is the context in which its
  headline reads CORRECT 96.2 %.

Correcting these three denominators is the work this delivery authorises, and it moves the
percentages **down**. That direction is the expected one: a denominator that grows because the
requirements it was always owed have been restored is a denominator becoming honest, not a
regression. Per the owner's framing document, the existing rows are preserved and mapped rather
than replaced — `Portava_Architecture_Upgrades_v2_START_HERE.md` is explicit that the shorter
upgrade checklist must not become the new denominator, and that additions, splits and genuine
duplicates are each to be recorded.

## 4. What this document does not claim

It does not claim any of the restored requirements is built, unbuilt, or correctly built. Not one
row has been regraded at the time of writing; that is the next pass, and it must cite code. It
does not lift any hold, and it authorises nothing in production — the owner's framing document
says so in its own terms, and no line of it is read here as permission.
