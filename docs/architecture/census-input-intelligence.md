# Portava Global Input Intelligence — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt` |
| **`.docx` reconciliation** | The `.txt` and the `.docx` are **identical** after whitespace/Unicode normalisation. I extracted `word/document.xml`, stripped tags, NFC-normalised and collapsed whitespace on both sides: 508 non-empty lines each, `difflib` diff length **0**. The "`.docx` is authoritative" clause never had to be exercised, and no verdict here rests on a transcription difference. |
| **Section count** | The brief said 59. **It is 58** (`§1 Product Definition` … `§58 Final Architecture Principle`; verified by `grep -nE '^[0-9]+\. '`, which returns 58 headings plus one false positive at line 101 — §9's inline "1. Exact canonical Portava entity…" ranked list). Four sibling censuses found their briefed section counts wrong; this is a fifth. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. |
| `head_commit` | `80a8d655a` — RE-DECLARED 2026-09-14 by §12, replacing `90a515a6`. §12 re-derived the rows this branch's Input changes bear on — G292, G372 and G351 moved `N → W`, and §12.2 refuses the `C` the lane proposed for G292 on the grounds the lane itself stated. §12.3 answers §25/G163 (voice) from a re-run grep rather than inheriting it, and §12.4 names four sentences this document had been contradicting itself with. The 22 counted files that changed are that work. It does **NOT** certify the other 259 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `90a515a6` — RE-DECLARED 2026-09-13 by §9, replacing `579694d6` (itself a §8 re-declaration of `42aeac38`). It **starts a clock; it does not certify a past.** Read the next row before quoting it, and read §9.9 for what this re-declaration is and is not worth. `579694d6` carried no acknowledgement of its own, so nothing was spent to replace it — the only ledger edit §9 makes is to **census-discovery**, whose entry is extended with an argument for the one `lib/inputAssistance/` file this pass changed. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. Its verdicts were taken at a pre-squash working tree that **exists nowhere**: verified against FULL history (`git fetch --unshallow`, 4,300 commits, then `git cat-file -e`), not assumed — a shallow clone had made every such commit look unresolvable for the wrong reason. So `nobody` can diff that tree against `42aeac38`, and this declaration **does not claim that interval was empty**. What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the paths in `CENSUS_SCOPE` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED — the weakest of the three states, not the safest. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. Declared by the Trips lane while recounting the sibling census; if this lane disagrees, reverting costs only the check. |
| **Method** | Requirement-level, four buckets, exactly one bucket per requirement. Every BUILT verdict cites a `file:line` I opened and read. |
| **Database** | Not queried. Every production fact below comes from the supplied ground truth, from `src/scripts/checkProductionDrift.ts` (which records a direct CI-vs-production comparison), or from a commit message whose author did measure it. |

Backend paths are relative to `artifacts/api-server/src/`, client paths to
`travel-buddy-standalone/src/` unless stated.

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **262** |
| BUILT-BUT-WRONG | **55** |
| NOT-BUILT | **52** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **317 / 373 = 85.0 %** |
| **CORRECT%** (raw) = C/373 | **262 / 373 = 70.2 %** |
| **CORRECT% (spec-attributable)** = (C−23ᵖ)/373 | **239 / 373 = 64.1 %** |
| **THE GAP** = W/373 | **55 / 373 = 14.7 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

> **THIS TABLE WAS STALE AND IS NOW RESTATED FROM THE ROWS (§11).** It read
> `230 / 69 / 70 / 4` — the original count — through two later passes that moved
> rows without touching it (§8 to `237 / 69 / 63 / 4`, §9 to `243 / 63 / 63 / 4`),
> each of which restated the headline only inside its own section. A reader who
> read the top of this document got a number the body had already contradicted
> twice. `check:census-integrity` reads the LAST stated headline, so it never saw
> this one and never complained: the drift was invisible to the guard by
> construction. §11 restates it here as well as in §11.10, and every later pass
> should do the same. **Two derived tables in §5 are NOT restated and are marked
> superseded in place** — recomputing them needs a full re-derivation of all 373
> row→section attributions, which this pass did not do, and a partially-patched
> table would be wrong in a newer and less obvious way.

The headline hides the finding. Split by whether §51 ever scoped a phase for the
section (§5 below): the sections a phase scoped score far better than the ones no
phase ever did. That gap narrowed this pass only because §11 deliberately spent
its effort on UNSCOPED sections — §10's three normalization clauses, §36's
stuffing control, and seven of §44's telemetry arms. The programme executed its
plan well; the plan omitted a quarter of the spec.

### The three things that matter most

1. **This is the first census in the set with genuinely non-zero attribution.**
   Two completed sibling censuses returned 0.0 % spec-attributable and I expected
   a third. It is not what the tree says. Every file under
   `lib/inputAssistance/` and `platform/input-assistance/` opens with a header
   that names this specification and cites *its* section numbers — §5/§6/§7/§8/§43
   in `lib/inputAssistance/types.ts:11-15`, §22/§56 in `aiWriting.ts:2`, §20/§36/§55
   in `duplicateDetection.ts:2`, §31/§15/§8/§40 in `liveSuggestions.ts:2`, §35/§15/§14
   in `personalization.ts:2`, §18/§19 in `semanticParser.ts:2`, §42 in `projection.ts:2`.
   Those numbers resolve correctly against *this* document and against no other
   spec in `docs/specs/`. All ten numbered migration phases of §51 appear by name in file
   headers, three migrations were written for it (2220 §10, 2221 §22, 2258 §35),
   and 12 backend plus 24 client test files carry its section numbers.
   The attributable figure below is a floor, not a courtesy.

2. **The certification's central claim does not survive.** It says the audit
   "found **no actual defect**". Thirty-five commits later, on the same branch,
   `d4db6009` (PR #430) re-audited the same lane and found: the entire Phase-8
   selection-memory feature was **a read with no writer** on every picker context
   ("Every Phase-8 feature on every picker context … was reading a table nothing
   in the app could fill"); **8 of 22** declared invariants stayed GREEN with the
   production code reverted, i.e. the 168-test suite the certification leaned on
   did not demonstrate them; and the client policy registry disagreed with the
   server's on `allowPersonalization` for **14 of 29 contexts**, which would have
   sent users' raw caption/comment text off the device — a case that commit
   describes exactly: *"The §49 Telemetry certification … was true of STORAGE and
   silent about transmission."* Those are defects, in the lane, found after the
   certification, by reading the same code.

3. **The certification's excluded bucket is NOT inflated the way Passport's was —
   but it is misclassified.** All **6 of 6** items in its "Runtime / QA-required"
   list are real spec requirements (§46 + §49 Accessibility; §49 + §57 Performance;
   §32 + §49 Offline; §49 Failure/provider timeout; §44 + §49 Telemetry funnel;
   §57 privacy-incident metric). That is the opposite of the Passport finding,
   where six of seven were not in the spec at all. The problem here is different
   and I would not have found it by counting: **4 of those 6 have a code-answerable
   construction gap underneath them** that the runtime framing hides. See §5 below.

---

## 1. Denominator — how 373 was decided

A line of the spec is a **testable requirement** when it asserts a property,
artifact or prohibition that could be *falsified by reading this tree*. The rule,
applied uniformly:

- **A bullet asserting a required property or behaviour = 1.**
- **A table row naming a required artifact, condition or behaviour = 1.** §7's ten
  assistance types are ten; §23's seven validations are seven; §32's seven offline
  data classes are seven; §57's nine metrics are nine.
- **A declared interface = 1 for the contract**, *unless* a member carries
  independent behaviour. This bites twice, in opposite directions, and the
  asymmetry is deliberate:
  - **§6 `InputFieldPolicy` counts 14** (every member except `fieldId`/`context`),
    because the spec calls the registry *"the central contract controlling what
    assistance is allowed"* — each member names a distinct **enforcement**, and
    four of them turn out to be enforced by nothing.
  - **§8 `InputSuggestion` counts 1**, because its members are payload carriage;
    the behaviours they imply (`freshness` → §31, `action` → §43, `source` → §9,
    `policyVersion` → §48) are counted in those sections instead.
- **A named file, service, endpoint, phase or test family = 1.** §39's 28 SDK
  files are 28; §40's 22 server domain services are 22 — judged as
  *responsibilities*, not filenames, since §52 explicitly permits "configuration
  or a narrowly scoped resolver extension".
- **An enumerated term inside a required formula = 1.** §15's `SuggestionScore`
  names 15 signals; each is present or absent in code, so each is one requirement.
  This is the single most arguable block in the denominator and I flag it as such:
  a reader who treats the formula as narrative should read the alternative numbers
  in §1.2 below.
- **Narrative, rationale, restatement and diagrams = 0.** §3's ASCII diagram,
  §4's stage list (counted once, as an *ordering* requirement, since every stage
  has its own section), §42's pipeline (duplicate of §4), §58's closing principle.
- **§51 (Suggested Migration Phases) is excluded entirely — 0.** Its ten phase
  rows restate §5/§12/§13/§4/§18/§22/§35/§31/§49. Counting them would score the
  same work twice.
- **Duplicates merge to one id.** §49's "Privacy" row and §29's bullets are not
  double-counted: §49's ten rows are counted as *certification* requirements
  ("does a test family certifying this area exist?"), distinct from §29's
  *behaviour* requirements ("is the gate there?").

Per-section contribution: §1 5 · §2 10 · §3 1 · §4 1 · §5 2 · §6 22 · §7 10 ·
§8 1 · §9 2 · §10 10 · §11 9 · §12 7 · §13 4 · §14 6 · §15 16 · §16 2 · §17 2 ·
§18 6 · §19 5 · §20 10 · §21 6 · §22 9 · §23 7 · §24 9 · §25 1 · §26 2 · §27 8 ·
§28 9 · §29 9 · §30 2 · §31 3 · §32 7 · §33 8 · §34 13 · §35 6 · §36 7 · §37 3 ·
§38 2 · §39 28 · §40 22 · §41 3 · §42 1 · §43 9 · §44 16 · §45 2 · §46 9 · §47 7 ·
§48 6 · §49 10 · §50 3 · §51 0 · §52 2 · §53 1 · §54 1 · §55 1 · §56 1 · §57 9 ·
§58 0 = **373**.

### 1.1 The rule for prohibitions

Inherited unchanged from the Sensing census so the two are comparable:

- A prohibition is **BUILT-AND-CORRECT** when a concrete artifact makes the
  violation unrepresentable or refuses it — a type with no field for it, a
  fail-closed branch, an explicit refusal list. Citation required.
- A prohibition whose forbidden path simply **does not exist**, with nothing
  guarding against its addition, is **NOT-BUILT** — annotated *unguarded absence*.
  The guarantee is not constructed; it is merely currently unviolated. This is
  why §24 (Paste), §30 (Conflict precedence) and §36's provider-neutrality land
  where they do.

Verdicts marked `⌀` are **vacuously satisfied**: the guard is real, but the path
it guards is empty (there is no provider to fail, no animation to reduce). They
are counted BUILT-AND-CORRECT and flagged so a stricter reader can subtract them.

### 1.2 Alternative denominators, for a reader who disagrees with a rule

| If you reject | Denominator | CONSTRUCTED% | CORRECT% |
| --- | --- | --- | --- |
| nothing (this census) | 373 | 80.2 % | 61.7 % |
| §15's 15 formula terms as requirements | 358 | 80.4 % | 62.3 % |
| §39 + §40's 50 named artifacts as requirements | 323 | 77.4 % | 57.9 % |
| both of the above | 308 | 77.6 % | 58.4 % |

The direction is the point: the score **falls** when the structural inventories
(§39/§40) come out, because that is where the tree is strongest, and **rises**
slightly when §15 comes out, because that is where it is weakest. Neither move
changes the shape of the finding.

### 1.3 Method caveats, stated so a re-run can improve on them

1. **Writer/reader attribution is incomplete by the repo's own admission.**
   `scripts/checkWriterlessReads.ts` declares that a dynamic `.from(expr)`
   anywhere makes its attribution INCOMPLETE and that it errs toward silence.
   Every "nothing writes X" / "nothing reads X" claim here inherits that caveat.
   A `from("table")` grep also misses RPC access — `personalization.ts:479` writes
   through `db.rpc('input_record_selection', …)` and would be invisible to one —
   so I used greps only to find candidates and read the module before concluding.
2. **Client behaviour is asserted from code, not from a device.** Where a code
   answer was decisive (no `AccessibilityInfo` call exists; no `Animated` import
   exists) I ruled from it; where it was not (keyboard occlusion, large-type
   layout, latency), the requirement is CANNOT-VERIFY — four in total, never
   folded into either side.
3. **No database was queried.** Where a migration file and a production-drift
   record disagree, the drift record wins: a migration is not evidence of live
   state.

---

## 2. Attribution — and why this one is different

The instruction was to measure, not to assume. The measurement:

```
files under lib/inputAssistance/ + routes/inputAssistance.ts
  + platform/input-assistance/                                     100
of those, citing a § number that resolves against THIS spec          96
files repo-wide whose header names "Global Input Intelligence"       70
migrations written for it   2220 (§10 search_key) · 2221 (§22 AI-writing flag)
                            2258 (§35 selection history)
```

All ten §51 migration phases appear by name in file headers (Phase 1×17,
Phase 2×18, Phase 3×7, Phase 4×10, Phase 5×13, Phase 6×6, Phase 7×12,
Phase 8×13, Phase 9×3, Phase 10×1). The section numbers are not decorative:
`aiWriting.ts:2` cites §22 (which *is* AI-Assisted Writing) and §56 (which *is*
Example: Compass Prompt); `duplicateDetection.ts:2` cites §20/§36/§55 (Constraint-
Aware Suggestions / Anti-Spam / Hidden Gem Creation); `liveSuggestions.ts:2`
cites §31/§15/§8/§40. Every one resolves. Nothing else in `docs/specs/` numbers
its sections that way.

**So the spec-attributable figure is real, and it is the great majority of the
correct column.** The exceptions are the places where the platform is a *wrapper*
and the guarantee lives underneath it, in work that predates the programme:

| Pre-existing substrate | What it already provided | Verdicts it, not this spec, earns |
| --- | --- | --- |
| `routes/discoverySearch.ts` (Discovery cross-entity search; its header is an OpenAPI contract note, no GII reference) | `dispatchSearch` + all 18 per-type searchers (the eighteenth, `searchSaved`, is Map spec §27's viewer-scoped "Saved items" heading; it is unreachable from this layer — see G220), `matchTier`, `SEARCH_ALIASES`, the fail-closed block/age gate, the `visibility='public'` gates on events/trips/plans, `gemSearchPosition` | G56, G59, G68, G70, G73, G92, G93, G95, G126, G128, G129, G185, G186, G218, G220 |
| `lib/canonicalLocations.ts` (universal location service) — its *pre-GII* half: `normalizeLocationName`, `CITY_NAME_ALIASES`, `matchCanonical` | Unicode/case/punctuation folding, two misspelling entries | G55 (partly), G59 |
| `lib/blocks.ts`, `lib/usernameRules.ts`, `lib/rateLimit.ts`, `lib/http.requireUser` | block set, username rules, rate buckets, auth | G184, G152, G235, part of G-§47 |
| Intelligence Gathering programme (`lib/liveClaimRead.ts`, the IG gate chain) | the gated, fail-closed live read the §31 lane consumes verbatim | the substrate under G194/G196, though the projection above it is GII's |
| Compass programme (`lib/openai.ts`, `compass/CompassStructuredContext.ts`, `lib/rentaBuddyScanner.ts`) | the model client, `wrapUgc`/`stripCoordinateFields`, the moderation scanner | the substrate under G191/G-§47-AI |
| `components/MentionInput.tsx` (pre-GII composer) | @/# trigger detection with structured tag spans | G165 |

**Marked `ᵖ` in the table.** A BUILT-AND-CORRECT verdict is counted
**spec-attributable** when the artifact I cite as proof lives in the input-
assistance layer, in a migration written for it, or in a test named for it; and
**not attributable** (`ᵖ`) when the cited proof is entirely pre-existing code the
platform merely calls.

> **METHOD RESTATED 2026-09-14 — the attributable half stands; `ᵖ` is renamed UNKNOWN, except
> where the table above names a specific other programme.**
>
> **What stands.** Every file under `lib/inputAssistance/` and `platform/input-assistance/`
> opens with a header naming this specification and citing its section numbers, and all ten
> §51 phases appear by name in file headers. That is positive evidence of attribution TO this
> spec, and the 239 (earlier 207 / 214 / 220) is a count of rows carrying it. **It does not
> move.**
>
> **What does not stand.** *"Entirely pre-existing code the platform merely calls"* is two
> claims wearing one label. The part that is measured — the cited artifact lives outside the
> input-assistance layer — supports only *"not evidenced as this spec's"*. The part that is not
> measured is *"pre-existing"*, i.e. that the code was written for something else because it was
> there first; the prose above says so directly (*"work that predates the programme"*), and the
> owner has ruled that inference out. A file older than a spec's upload can still have been
> written from it.
>
> **So the 23 `ᵖ` rows split two ways, and this document already has the evidence for the
> split.** Where the table above names an identifiable other programme and that programme names
> itself in its own files — the Intelligence Gathering gate chain, the Compass programme's
> model client and scanner, Map spec §27's `searchSaved` — those rows are **attributable
> ELSEWHERE, evidenced**. Where the entry is a bare pre-GII substrate with no spec citation of
> its own — `routes/discoverySearch.ts` (whose header this document itself describes as *"an
> OpenAPI contract note, no GII reference"*), `lib/canonicalLocations.ts`'s pre-GII half,
> `lib/blocks.ts`, `lib/usernameRules.ts`, `lib/rateLimit.ts`, `lib/http.requireUser`,
> `components/MentionInput.tsx` — those rows are **attribution UNKNOWN**. This pass did not
> re-read the 23 rows one by one, so the split between the two is not counted here; what is
> withdrawn is the claim that all 23 are somebody else's work.
> See `docs/architecture/attribution-method.md`.

**Result: 23 of the 230 correct verdicts are `ᵖ`. Spec-attributable CORRECT% =
207 / 373 = 55.5 %,** against 61.7 % raw — a 6.2-point haircut, not a wipeout.
The wrapper is thin where it wraps, and everything else was written for this
document.

This is the first census in the set where that distinction produces a large
number rather than zero. It should not be read as praise for the outcome —
the correct column is what it is — but the "who built this" question has a
different answer here than it did for Sensing, Wall, Passport or
Highlights/Memories.

---

## 3. Deployment reality — read this before any percentage

Five facts decide whether the correct column means anything in production. None
of them is a code defect and none is folded into a bucket.

1. **`input_selection_history` does not exist in production.** It is in
   `portava-ci` only, and `scripts/checkProductionDrift.ts:172` ratchets it as
   `unapplied` — a classification the file's own header (`:49`) says "MUST reach
   zero. They are not a steady state." The whole of §35 (Phase 8) reads and writes
   it: `personalization.ts:169` (`.from('input_selection_history')`) and
   `:479` (`db.rpc('input_record_selection', …)`). Both fail soft, so in
   production the §14 zero-character recents, the §35 learned-abbreviation
   mapping and the §15 PriorSelection term are all **no-ops that return an empty
   memory**. Eleven verdicts below are code-correct and inert for this reason;
   they are flagged `☠prod`.

2. **Migration 2220 is not applied to production either**, so §10's flagship
   example cannot work there. The commit that measured it says so directly
   (`d4db6009`: *"migration 2258 … IS applied to CI, as are 2220 … and 2221. None
   of the three is applied to PROD. So in production today the Phase-2
   diacritic/stroke fold degrades to `normalized_name` (no Đ-stroke fold)"*).
   `2220_canonical_locations_search_key.sql:9-18` explains what that means:
   `normalizeLocationName` NFD-decomposes and then strips punctuation, but `Đ`
   has no Unicode decomposition, so the stored key for **Đà Nẵng is the broken
   string "a nang"** — which a typed "da nang" can never match. The spec's own
   headline example (`da nang → Đà Nẵng`, §10) is unresolvable in production
   through the stored column. It survives only for the queries the *application-
   side* alias table covers (`canonicalLocations.ts:177-192`, e.g. `danang`,
   `hcmc`), because that fold runs before the query.

3. **`compass_ai_writing_enabled` (migration 2221) is not applied to production**,
   and `isFlagEnabled` is fail-closed. All of §22's model-generated writing —
   nine requirements' worth — is dark there by construction. That is the
   *intended* posture (2221 seeds it OFF), but it means the §22 verdicts describe
   code that has never run for a user.

4. **The live lane has no data.** `liveSuggestions.ts` consumes
   `readLiveClaimEnvelopes`, and `docs/architecture/intel-spine-liveness.md`
   measured every `intel_*` table in production at `count(*) = 0`. §31's three
   requirements are correct code over an empty substrate.

5. **The telemetry sink is a no-op and is never attached.**
   `platform/input-assistance/services/inputTelemetry.ts:35-36` defines
   `let sink: TelemetrySink = () => {}`, and `setTelemetrySink` is exported from
   `index.ts:124` and called from **no non-test file in the app**. Every §44 event
   the platform emits goes nowhere.

A reader who wants "correct *and* demonstrated in production" should treat the
CORRECT column as an upper bound. Its realised value for §14 recents, §35
personalization, §22 AI writing and §31 live freshness is currently zero.

---

## 4. Requirement-by-requirement

Verdict key: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT ·
**?** CANNOT-VERIFY. `ᵖ` = correct, but earned by pre-existing work (not
spec-attributable). `⌀` = vacuously satisfied. `☠prod` = the code is right and
inert in production.
*(`ᵖ` restated 2026-09-14: read it as **not evidenced as this spec's** — the cited artifact
lives outside the input-assistance layer. It is an UNKNOWN unless §2's substrate table names an
identifiable other programme for that row, in which case it is attributable-elsewhere. It is not
a finding that the work was done for something else. See `docs/architecture/attribution-method.md`.)*

### §1 Product Definition

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G1 | Understand context — know which kind of field is being typed into | C | `lib/inputAssistance/policyRegistry.ts:95-329` maps all 29 contexts; the client resolves a `fieldId` to one at `platform/input-assistance/contexts/fieldRegistry.ts:57-79`. The context is *declared* by the caller, never inferred — which is what §5 asks for. |
| G2 | Assist — return entities, completions, actions, corrections, validations or AI suggestions per field | C | `gateway.ts:146-593` runs every lane: entities `:343-404`, completion `:423`, validation `:411-418`, creation correction/validation `:299-313`, semantic actions `:457-468`, AI `:480-498`. |
| G3 | Structure — convert selected text into canonical ids, time windows, categories, actions, constraints | C | canonical id + timezone binding `geoResolver.ts:70-81`; temporal windows `semanticParser.ts:264-362`; categories `:141-169`; actions `:611-631`. |
| G4 | Protect — apply privacy/block/eligibility/trust/location rules **before** suggestions reach the client | C | `gateway.ts:373-402` fetches the block + age sets and returns nothing when either is null, before any projection; the picker branch repeats it at `:614-619`. |
| G5 | Learn — improve ranking from accepted **and ignored** suggestions and successful **downstream outcomes**, without optimising for typing volume | W | The IGNORED arm now has a producer — `suggestion_dismissed` fires from `components/SmartInput.tsx:170#emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur')` and is mutation-proven (G313). It still moves NO rank: `personalization.ts:243-268` is unchanged and reads only `selection_count`, and the downstream-outcome signal still has no caller (G320). So the verdict is unchanged and one of the row's two named gaps has moved from "no signal" to "signal with no consumer". WHAT WOULD TURN THIS RED: a ranking term that reads a shown/ignored ratio, plus a downstream-outcome write — both of which need a place for the events to LAND first (G263). ☠prod. |

### §2 Non-Negotiable Principles

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G6 | One platform layer; feature teams must not build independent autocomplete engines | W | The layer is real and 10 screens consume it, but four independent engines are still live and unmigrated: `hooks/useSearchSuggestions.ts`, `hooks/useGooglePlacesAutocomplete.ts`, `hooks/usePlaceSearch.ts` and `components/MentionInput.tsx` (its own 200 ms debounce + abort at `:133-198`). No ratchet forbids a fifth — `src/scripts/` has no input-layer check at all. |
| G7 | The field owns behaviour; the platform owns suggestion intelligence | C | `SmartInput.tsx:97` — `assistEnabled` is decided by `policy.mode`, and a `no_assistance` field renders a plain `TextInput`; the server mirrors it at `gateway.ts:166#policy.mode`. |
| G8 | Canonical entities outrank AI guesses | C | `projection.ts:309-320` `TYPE_RANK` — `entity: 0` … `ai_suggestion: 9`, primary sort key at `:333-335`. |
| G9 | AI never silently replaces user text | C | Every AI row is an editable `replace_text` (`aiWriting.ts:259`, `projection.ts:295`); `SmartInput.tsx:112-117` applies `replacementText` only inside an explicit `handleSelect`. |
| G10 | Low-confidence interpretation preserves raw user input | C | `semanticParser.ts:600-607` `shouldProjectStructured` gates on `SEMANTIC_MIN_CONFIDENCE = 0.6` (`:133`); below it the parse adds nothing and the raw query row survives. |
| G11 | Privacy and eligibility filtering occur before projection | C | `gateway.ts:373-402` — the gate runs, then `projectSearchResult`. Fail-closed comment at `:402`. |
| G12 | Live suggestions carry freshness and are never fabricated when live state is unavailable | C | `liveSuggestions.ts:177-223` `buildFreshnessState` returns `null` for an empty envelope list and every label maps from a real claim value; unknown values return `null` (`:120`, `:138`) rather than a default. |
| G13 | Offline mode degrades gracefully and must not present stale data as live | W | The "never stale-as-live" half is exact (`components/freshnessDisplay.ts:53-58` drops the label and keeps only the age). The "degrades gracefully" half has no substrate: `offlinePolicy` is declared per context and **read by nothing** (see G30), and no local dictionary or city index ships. |
| G14 | Suggestions should accelerate real-world outcomes, not increase keystrokes or engagement for its own sake | W | Unchanged where it matters: `personalization.ts:220-228` still scales the boost by `selection_count` and it is still the only signal that moves rank. What changed is that the COUNTER-signals now exist as events (`suggestion_dismissed`, `manual_value_kept`, `raw_search_submitted` — G313/G315/G314), so the imbalance is now measurable rather than invisible. WHAT WOULD TURN THIS RED: an outcome or task-completion term weighed against the acceptance boost. Who can supply it: whoever owns the screens that COMPLETE the task (Trips / Events / Telegraph), by calling `services/inputTelemetry.ts:266#export function emitDownstreamTaskCompleted`. |
| G15 | Every accepted suggestion resolves to a valid canonical destination, structured value, or explicit user-approved action | C | `projection.ts:391-407` `isResolvable`/`dropDeadRows` — a row without an action, entity id or routable destination is dropped at the boundary, on every return path in `gateway.ts` (`:212`, `:241`, `:264`, `:291`, `:320`, `:593`). |

### §3 System Placement

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G16 | A single cross-app service, not per-screen implementation | W | `routes/inputAssistance.ts:97` is the single endpoint and ten screens reach it. But the migration is additive-only, by design: `hooks/useGlobalSearchSuggestions.ts:11-22` states that the legacy hook "ALWAYS runs and is the fallback", and the gateway's rows are shown only when it returns some — so on the main search screen two engines run in parallel on every keystroke. |

### §4 End-to-End Input Loop

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G17 | The pipeline runs in the declared order: classify → context → normalise → intent/entity → policy → candidates → privacy → rank/dedupe → projection | C | `gateway.ts:19-21` states the order and `:155-593` implements it in exactly that sequence: normalise `:158-167`, policy gate `:326-330`, candidates `:343-404`, privacy `:373-378`, semantic `:457`, rank `:582-589`, project throughout. The loop's last two stages (OUTCOME TELEMETRY, LEARNING) are scored at §44/§45. |

### §5 Input Context Registry

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G18 | **Every** meaningful text field must register an InputContext | W | 21 field ids are registered across five registrars (`geographic/geoFields.ts:40-51`, `social/socialFields.ts:36`, `search/searchFields.ts:29`, `creation/creationFields.ts:41-44`, `compass/compassFields.ts:43-50`) plus `features/wall/components/WallHeader.tsx:29`. Every field behind `MentionInput`, `useGooglePlacesAutocomplete` and `usePlaceSearch` is unregistered, and the §50 inventory that would size the gap does not exist (G-§50a). |
| G19 | The 29-member `InputContext` union | C | `lib/inputAssistance/types.ts:32-61` — 29 members, verbatim and in the spec's order; the client mirrors it at `platform/input-assistance/types/inputContext.ts:42-74`, and `test/inputPolicyContractParity.test.ts:98` asserts the two sets are identical. |

### §6 Field Policy Contract

Fourteen policy members, each naming a distinct enforcement, plus the eight rows
of the field→mode table.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G20 | `mode` gates how aggressively a field assists | C | `gateway.ts:153` (`no_assistance` ⇒ `[]`); `SmartInput.tsx:97`. |
| G21 | `allowedSuggestionTypes` gates which assistance types a field may emit | C | `gateway.ts:170-172`, `:413`, `:423`, `:437`, `:483`, `:587`. |
| G22 | `entityTypes` gates which entity classes are queried | C | `gateway.ts:327-330` — only the policy's declared types reach `entityToSearchType`/`dispatchSearch`. |
| G23 | `allowPersonalization` gates memory read and write | C | Read `gateway.ts:183-186`; write refused at `personalization.ts:464-466`; the client's mirror is pinned to the server's by `test/inputPolicyContractParity.test.ts:109`. |
| G24 | `allowLiveContext` gates the live lane | C | `liveSuggestions.ts:258` — a field that does not declare it gets zero flag reads and zero snapshot reads. |
| G25 | `allowMemoryContext` | **N** | Declared at `types.ts:180`, defaulted at `policyRegistry.ts:81`, set true on exactly one context (`compass_prompt`, `:283`) — and **read by nothing**. A repo-wide grep for the identifier outside the type/registry files returns no consumer. |
| G26 | `allowAI` gates AI assistance | C | `gateway.ts:436`, `:482`; `aiWriting.ts` requires it plus the per-request opt-in plus the flag. |
| G27 | `minChars` | C | `gateway.ts:318-322`; `useInputAssistance.ts:128-136`. |
| G28 | `maxSuggestions` caps the response | C | `routes/inputAssistance.ts:144` (`Math.min(requestedLimit, policy.maxSuggestions)`); `gateway.ts:586`. |
| G29 | `debounceMs` | C | `policyRegistry.ts:86` defaults to 120 ms; consumed at `useInputAssistance.ts:277`. |
| G30 | `offlinePolicy` declares per-field offline degradation | **N** | Declared at `policyRegistry.ts:87` with five values and set deliberately per context (`static_dictionary` on country/language/interest, `cached_local` on the geo pickers) — and **read by nothing on either side**. The client re-declares a *different* taxonomy that is also unread. This is the mechanism §32 depends on, and it is inert. |
| G31 | `privacyClass` classifies the field's privacy posture | **N** | Declared at `policyRegistry.ts:88` and set to `sensitive_location` / `viewer_scoped` / `private_message` on nine contexts (`:203`, `:210`, `:230`, `:236`, `:256`, `:265`, `:272`) — and **read by nothing**. `test/inputPolicyContractParity.test.ts:139` inspects it, but no production path branches on it; the actual sensitive-location protection comes from `discoverySearch.ts:1443#sensitivity_level,` and would be identical if this field were deleted. |
| G32 | `validationRules` declares the field's non-blocking checks | **N** | Declared optional at `types.ts:189`; **no registry entry sets it**, and `hooks/useInputValidation.ts:61` marks the resolver an unbuilt "Phase 5 extension point". The §23 validations that do exist are hard-wired by context in `creation.ts:298-322`, not driven by this field. |
| G33 | `telemetryPolicy` governs event emission and raw-text capture | W | The enforcement is real on the client (`services/inputTelemetry.ts:48-62` drops `text`/`query`/`rawText`/`message`; allowlist at `:66-72`). But the two sides declare **different shapes** — server `{logRawText: boolean; events: string[]}` (`types.ts:161-166`) vs client `{captureRawText: boolean; events: 'all' \| names[]}` (`types/fieldPolicy.ts:64-68`) — so the "implemented verbatim … matches byte-for-byte" claim at `types.ts:5-7` is false for this member, and a server policy change to it cannot reach the client. |
| G34 | `discovery.search` → `search` | C | `policyRegistry.ts:97-107`. |
| G35 | `trip.destination` → `canonical_picker` | C | `policyRegistry.ts:139-146`. |
| G36 | `event.location` → `canonical_picker` | C | `policyRegistry.ts:166-172`. |
| G37 | `telegraph.message` → `action_assisted` | C | `policyRegistry.ts:267-274`. |
| G38 | `post.caption` → `free_text_assisted` | C | `policyRegistry.ts:244-250`. |
| G39 | `compass.prompt` → `ai_assisted` | C | `policyRegistry.ts:277-285`. |
| G40 | `passport.homebase` → `canonical_picker` (canonical city/country only) | C | `policyRegistry.ts:288-293` — `entityTypes: ['city','country']`, no free text. |
| G41 | `hiddenGem.location` → `canonical_picker` | C | `policyRegistry.ts:205-211`. |

### §7 Assistance Types

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G42 | `entity` | C | `projection.ts:69-80`. |
| G43 | `completion` | C | `projection.ts:213-229` — `Search "<q>"` → `submit_search`. |
| G44 | `recent` | C | `projection.ts:177-207` (`type: 'recent'` for zero-char defaults); `personalization.ts:295-332`. |
| G45 | `personalized` | C | `personalization.ts:295-332` `buildLearnedGeoInjections`. ☠prod. |
| G46 | `structured_value` | **N** | Declared in the union (`types.ts:88-98`) and ranked (`projection.ts:313`) — and **never emitted**. No projector produces `type: 'structured_value'` and no registry policy lists it in `allowedSuggestionTypes`. The spec's examples ("Friday 8-11 PM; English; Nightlife interest") have no producer. (The `set_structured_value` *action* is §43 and does exist.) |
| G47 | `action` | C | `validationSuite.ts:305-325`; `semanticIntent.ts:277-300`. |
| G48 | `correction` | C | `validationSuite.ts:194-230` (city-country), `:265-287` (hashtag). |
| G49 | `validation` | C | `socialIdentity.ts:444-470` (username); `validationSuite.ts:232-262` (trip dates). |
| G50 | `disambiguation` | C | `projection.ts:107-141` (same-name cities), `:148-169` (airport codes); `creation.ts:191-215` (duplicates). |
| G51 | `ai_suggestion` | C | `projection.ts:289-303` (deterministic starters); `aiWriting.ts:250-270` (model output). |

### §8 Canonical Suggestion Object

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G52 | The `InputSuggestion` contract | C | `types.ts:206-244` — field-for-field with the spec including the seven-value `source` union, `canonicalUri`, `structuredValue`, `freshness`, `reason`, `destination`, `policyVersion`. The client mirror is `types/inputSuggestion.ts`. |

### §9 Candidate Source Hierarchy

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G53 | The 11-step deterministic default trust order | W | What exists is a 10-value rank over *assistance types* plus a confidence tiebreak (`projection.ts:309-343`), which reproduces steps 1, 2, 6, 7, 10 and 11 correctly. Steps 3–5 (task context / Trip context / geographic relevance) are inputs to the underlying search's own ranking, not positions in this order; step 8 (live relevance) is a ±0.06 confidence nudge (`liveSuggestions.ts:75-78`), not an order position; **step 9 (approved external provider) has no producer at all**. |
| G54 | AI must never outrank a strong canonical entity match | C | `projection.ts:319` (`ai_suggestion: 9`, last) and the two boost ceilings that keep a nudged row below the exact-match band: `personalization.ts:67` and `liveSuggestions.ts:86`, both `0.985` against `tierConfidence(3) = 0.99` (`projection.ts:35`). Mutation-proven in `test/inputAssistanceInvariants.test.ts`. |

### §10 Query and Text Normalization

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G55 | Unicode normalization and safe whitespace folding | C | `lib/canonicalLocations.ts:90-101` (NFD + collapse); client `services/queryNormalization.ts:38-52`. |
| G56 | Case-insensitive matching | C ᵖ | `routes/discoverySearchHelpers.ts:163-179` `matchTier` lowercases both sides; every DB predicate is `ilike`. Pre-existing Discovery work. |
| G57 | Diacritic-insensitive matching while preserving display spelling | W | The fold is correct in code — `canonicalLocations.ts:103-152` adds an explicit stroke-letter map (`đ→d`, `ø→o`, `ł→l`, …) because NFD does not decompose them, and `searchKey` composes it with the diacritic strip. But the **stored** side needs the `search_key` column from migration 2220, which is not applied to production; `2220_canonical_locations_search_key.sql:9-18` records that the legacy `normalized_name` for "Đà Nẵng" is the broken key `"a nang"`. `suggestCanonicalLocationsFolded:562-567` queries both columns and tolerates the missing one, so in production the fold silently degrades to a column that cannot match. |
| G58 | Alias resolution and known abbreviations | C | `canonicalLocations.ts:177-192` `CITY_GEO_ALIASES` — `hcmc`/`saigon`/`sai gon`/`hochiminh` → `ho chi minh`, `danang` → `da nang`, `krung thep` → `bangkok`; applied in application code at `:199-202`, so it works with or without 2220. |
| G59 | Common misspelling tolerance | C ᵖ | `discoverySearchHelpers.ts:63-95` `SEARCH_ALIASES` (~30 curated travel-domain misspellings) plus `canonicalLocations.ts:161-164` (`siargoa`, `nyc`) and `:186` (`phu qouc`, the spec's own example). The bulk is pre-existing Discovery work. |
| G60 | Local-language and English-name variants | C | `canonicalLocations.ts:180-191` — `saigon`, `sai gon`, `krung thep` resolve to the English canonical row. |
| G61 | Transliteration where supported | C | `lib/inputAssistance/queryNormalizer.ts:167#export function transliterate` is the producer. Two mechanisms, because one cannot do both jobs: a curated native-script EXONYM dictionary (`lib/inputAssistance/queryNormalizer.ts:69#NATIVE_CITY_NAMES` — Thai `กรุงเทพ`, Han `胡志明市`, Korean, Japanese, Arabic, Cyrillic) for scripts that carry no phonetic value to romanise from, and a per-character map for Cyrillic / Greek / Thai that generalises past the dictionary. Wired at `lib/inputAssistance/gateway.ts:175#const norm: NormalizedQuery`, so the transliterated form is what candidate generation queries. Proven end-to-end, not just as a unit: `src/test/inputAssistanceGeoCore.test.ts` asserts that `กรุงเทพ` and `胡志明市` resolve to the stored Bangkok / Ho Chi Minh City rows, with the DISPLAY spelling preserved. MUTATION: dropping the Thai rows from `NATIVE_CITY_NAMES` turns both end-to-end tests RED. Latin input is returned byte-identical, so nothing that worked before can change shape. |
| G62 | Punctuation and emoji handling **appropriate to field context** | C | The three pre-existing behaviours stand (the `@`/`#` sigil strip, `canonicalizeHashtag`, `sanitizeQuery`), and the two gaps this row named are closed. **Emoji**: `lib/inputAssistance/queryNormalizer.ts:225#export function stripEmoji` removes pictographs, flags, skin-tone modifiers and joiners from the search key, and `lib/inputAssistance/queryNormalizer.ts:246#export function stripsEmoji` makes it FIELD-CONTEXT-AWARE — a picker strips, a caption / comment / private message does not, because there the characters are the user's prose and not a lookup key. `src/test/inputAssistanceGeoCore.test.ts` proves the behavioural consequence end-to-end: `"Sky Bar 🔥"` now finds the Sky Bar place, where before the emoji rode into `name.ilike.%Sky Bar 🔥%` and matched nothing. **The silent hashtag**: `canonicalizeHashtag('#🔥')` still correctly returns null (the tagging write path is `[A-Za-z0-9]{2,64}`), but the field no longer says nothing about it — `lib/inputAssistance/socialIdentity.ts:67#export function buildHashtagValidation` emits a non-blocking `validation` row naming the unsupported characters, gated by the policy's new `validation` allowance (`lib/inputAssistance/policyRegistry.ts:268#hashtag`, mirrored client-side). MUTATION: forcing `stripsEmoji` false reddens the emoji tests; forcing `buildHashtagValidation` to return null reddens the hashtag test. |
| G63 | Phone/keyboard typo tolerance **where confidence is sufficient** | C | `lib/inputAssistance/queryNormalizer.ts:305#export function weightedDistance` is a Damerau-Levenshtein distance whose substitution cost is KEYBOARD-WEIGHTED: `lib/inputAssistance/queryNormalizer.ts:288#export function keyboardAdjacent` makes a neighbouring-key slip cost `0.5` (`lib/inputAssistance/queryNormalizer.ts:293#ADJACENT_SUBSTITUTION_COST = 0.5`) against `1` for any other swap, and an adjacent transposition `0.6`. `lib/inputAssistance/queryNormalizer.ts:339#export function typoConfidence` turns that into the confidence §10 asks for, and `lib/inputAssistance/queryNormalizer.ts:350#APPLY_CONFIDENCE = 0.8` is the bar. Three properties make it safe to ship: (1) the user's OWN spelling always gets the first query and the corrected key is only a SECOND attempt after that returned nothing (`lib/inputAssistance/gateway.ts:400#let correctionHelped = false`), so nothing that resolves today can be rerouted; (2) an AMBIGUOUS input — two vocabulary entries tied at the best distance — is refused in both bands (`lib/inputAssistance/queryNormalizer.ts:411#export function bestCorrection`), because §19 says a tie is offered, never guessed; (3) an `@handle` is never corrected, since a typo there is a different person. The user-visible half is `lib/inputAssistance/queryNormalizer.ts:607#export function buildTypoCorrectionRow`, a `replace_text` row that shows the raw input back (§2). Proven end-to-end in `src/test/inputAssistanceGeoCore.test.ts`: `"bangkkok"` — which is NOT in `SEARCH_ALIASES` — now resolves to the canonical Bangkok row, and a query that already resolves emits no correction at all. MUTATIONS: `ADJACENT_SUBSTITUTION_COST → 1` reddens the keyboard-model test; deleting the tie guard reddens the ambiguity test; disabling the gateway retry reddens the end-to-end test. |
| G64 | Never normalize stored canonical display names destructively | C | `projectCanonicalCity` labels from `row.name`/`row.display_name` (`projection.ts:114`) while folding only the lookup key; `2220…sql:19-22` states the constraint explicitly and adds a generated column rather than rewriting `normalized_name`. |

### §11 Entity Resolution

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G65 | Resolve to canonical entities, not just strings | C | `projection.ts:63-67` (`open_entity` + `entityId`), `:130` (`set_structured_value` + full binding). |
| G66 | City / Country / Neighborhood: aliases, transliterations, geocoding reconciliation, canonical geographic ID | W | Aliases and canonical id are right (`geoResolver.ts:120-145`). **Neighborhood is not resolved at all**: `entityMap.ts:38` maps `neighborhood → 'cities'` with the comment "Phase 1: neighborhoods resolve through the city path", so a `neighborhood_picker` returns cities. Provider/geocoding reconciliation has no implementation in this layer. |
| G67 | Place: canonical Place first, duplicate/alias handling, current operating state where available | W | Canonical-first and duplicate handling are real (`duplicateDetection.ts:281-370`, reusing `isSamePlace`). **Current operating state is absent**: `InputSuggestion` has no open/closed field (`types.ts:206-244`) and nothing computes one. |
| G68 | Hidden Gem: separate identity, protection and approximate-location rules | C ᵖ | `discoverySearch.ts:1443#sensitivity_level,` selects `sensitivity_level, approx_latitude, approx_longitude` and the exact pair is "deliberately absent"; `:286-300#gemSearchPosition` returns `hidden` for a denied or unparseable sensitivity level. Pre-existing Discovery work that the gateway inherits. |
| G69 | User: username/display name, block/privacy filtering, relationship context | C | `socialIdentity.ts:63-116` builds the candidate pool from the viewer's own follows/friends/threads/trip-crew and returns `null` (⇒ no recipients) on any read error; `:154-229` block-filters and account-status-filters on top. |
| G70 | Trip / Event / Plan: viewer eligibility before result exposure | C ᵖ | `discoverySearch.ts:727#visibility` (`.eq("visibility","public")` on events), `:899#visibility` + `:900#show_in_discovery` (trips), `:1044-1047#admitted:` (plans, gated by the parent trip's visibility and owner status). Proven end-to-end through the gateway by `test/inputAssistanceCertification.test.ts:330-366`. |
| G71 | Buddy: service category, availability, launch/safety/payment eligibility | W | The only gate is `discoverySearch.ts:584#buddy_verified_at` — `.not("buddy_verified_at","is",null)`. No service-category filter, no availability check, and no safety or payment eligibility gate reaches the suggestion path. |
| G72 | Hashtag: canonical normalized hashtag plus visibility rules | C | `socialIdentity.ts:46-50` `canonicalizeHashtag`; the `is_blocked = false` filter at `:319-390` is mutation-proven in `test/inputAssistanceInvariants.test.ts` (item 2). |
| G73 | Language / Interest: controlled dictionaries where possible | C ᵖ | `discoverySearch.ts:2064-2065#COMMON_LANGUAGES` — `searchStatic(q, COMMON_LANGUAGES …)` / `COMMON_INTERESTS`, server-side static lists. Pre-existing. |

### §12 City and Destination Autocomplete

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G74 | Zero-character defaults | C | `geoResolver.ts:180-257` `zeroCharGeoDefaults`; entered at `gateway.ts:194-218`. |
| G75 | Recent destinations | W | The server path exists (`personalization.ts:395-436` `buildSelectionRecents`) but reads `input_selection_history`, absent from production; the client's fallback (`services/suggestionHistory.ts:31-32`) is an in-memory `Map` that its own header says is not the persistent store. A user's recent destinations survive neither a cold start nor a device. ☠prod. |
| G76 | Current / upcoming Trip relevance | C | `geoResolver.ts:214-250` — the viewer's `trip_members` rows joined to `trips` filtered to `active`/`upcoming`/`planning`, labelled "Current Trip"/"Upcoming Trip". |
| G77 | Aliases | C | See G58. |
| G78 | Airport / city ambiguity handling | C | `geoResolver.ts:128-131` recognises a bare IATA code and `:142` marks the result ambiguous; `projection.ts:148-169` emits it as a `disambiguation` row pointing at the airport's **city**, confidence 0.5, never a silent swap. |
| G79 | Country display | C | `projection.ts:115` — `subtitle` is `region, country`. |
| G80 | Canonical timezone / geography binding after selection | C | `geoResolver.ts:41-81` — `CanonicalCityBinding` carries `cityId`, `country`, `countryCode`, `lat`, `lng` and an IANA `timezone` from `tz-lookup`, degrading to `null` rather than fabricating a zone (`:58-67`). |

### §13 Global Search Suggestions

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G81 | Search suggestions are typed objects | C | `types.ts:206-244`; every projector returns one. |
| G82 | Grouped mixed-entity result (PLACES / EXPERIENCES / PEOPLE / HIDDEN GEMS / SEARCH FOR) | W | Grouping by entity type exists (`components/suggestionGrouping.ts:29-43`, with `recent` routed to its own section). **There is no EXPERIENCES lane**: the spec's "Rooftop nightlife tonight" row is an experience/opportunity object, and no producer emits one — `global_search`'s `entityTypes` (`policyRegistry.ts:100-103`) has no experience class and `defaultLabelFor` has no such label. |
| G83 | Tapping an entity opens/resolves it; tapping a query completion submits a search | C | `projection.ts:63-67` vs `:224`. |
| G84 | No dead suggestion rows | C | `projection.ts:385-407`, applied on every return path; proven "no dead rows net" in `test/inputAssistanceGlobalSearch.test.ts`. |

### §14 Zero-Character Assistance

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G85 | City picker: current city, recent destinations, upcoming Trip cities | W | Current city and Trip cities are served (`geoResolver.ts:196-250`); recents are the dead path of G75. |
| G86 | Place picker: nearby places, recent places, Trip places, saved places | **N** | `place_picker` is in `GEO_PICKER_CONTEXTS` (`gateway.ts:98`), so its zero-state is `zeroCharGeoDefaults` — the viewer's **city** and Trip **destinations**. None of the four required place-level sources exists: no nearby-place query, no place recents, no Trip-place list, no saved-place list. |
| G87 | Telegraph recipient: recent conversations, Trip Crew, relevant requests | C | `socialIdentity.ts:63-116` unions recent thread partners, trip crew, follows and friends; `social/socialFields.ts:41-43` overrides `minChars` to 0 so the picker opens populated; `gateway.ts:258-270` takes the context over before the minChars gate. |
| G88 | Compass prompt: contextual starter prompts based on current surface | C | `projection.ts:258-304` — city- and trip-tailored starters ahead of the generic four, each carrying a coarse `{surface, city, cityId, tripId}` structured payload. |
| G89 | Global Search: recent searches, around-you-now, current Trip, Saved | W | Only the §35 recents branch fires (`gateway.ts:226-248`), and it is the dead path of G75. There is no around-you-now, no current-Trip and no Saved zero-state for `global_search`. |
| G90 | Hidden Gem location: current area, map point, nearby canonical places, add-new flow | W | Map-point and raw fallback exist (`validationSuite.ts:297-341`) but only **after** a failed match, not as a zero-state — and `hidden_gem_location` keeps the default `minChars: 2` (`policyRegistry.ts:205-211`), so the field has no zero-character behaviour at all. |

### §15 Context-Aware Ranking

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G91 | The same text ranks differently depending on the active field and task | C | The policy restricts the entity set (`gateway.ts:327-330`) and the geo-picker branch (`:344-368`) produces bindings and disambiguation where the generic branch (`:369-403`) produces `open_entity` rows — same query, different objects and order. |
| G92 | `ExactMatch` | C ᵖ | `projection.ts:33-40` `tierConfidence(3) = 0.99` over `matchTier` (pre-existing). |
| G93 | `PrefixMatch` | C ᵖ | `tierConfidence(2) = 0.85`; `discoverySearchHelpers.ts:168`. |
| G94 | `ContextFit` | C | The policy gate is the context-fit term: only the field's declared entity types are ever queried (`gateway.ts:327-330`). |
| G95 | `GeographicFit` | C ᵖ | `gateway.ts:380` passes `{lat, lng, userCity}` into `SearchQueryContext`; `discoverySearchHelpers.ts:257-262#userCity` applies the city boost inside `discoverySearchHelpers.ts:227#rankCombined` — the old pointer named `discoverySearch.ts`, which only imports and calls it. Pre-existing. |
| G96 | `TripFit` | C | `lib/inputAssistance/rankingSignals.ts:337#export function applyTripFit` is the term, fed by `lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility`, which marks every candidate sitting inside the ACTIVE Trip's city. It is applied inside `projection.ts`'s signal stack on every dispatched row, so a TYPED query in a Trip now carries a Trip-derived rank term — the exact thing this row said did not exist. Clamped by `SIGNAL_CEILING` and never below base, so an unrelated row is byte-identical. Proven in `src/test/inputAssistanceRankingSignals.test.ts` both as a unit and end-to-end (a Bangkok place outranks an identically-matching Da Nang place when `sessionContext.tripId` names a Bangkok Trip, and the SAME request without the Trip leaves the two indistinguishable — the control that makes the first assertion mean something). MUTATION: `applyTripFit → identity` reddens the unit test; short-circuiting `classifyFeasibility` reddens the end-to-end one. |
| G97 | `TemporalFit` | **N** | The parser computes a real window (`semanticParser.ts:264-362`, ISO bounds), but nothing consumes it as a ranking or filtering input: `gateway.ts:380` constructs `SearchQueryContext` with `{lat, lng, userCity, nearbyIntent}` only — `startsAfter`/`startsBefore`, which `discoverySearch` supports, are never set. The window is projected into a search *string* and thrown away. |
| G98 | `RelationshipFit` | W | Real and load-bearing for recipient search, where the candidate pool **is** the viewer's graph (`socialIdentity.ts:63-116`). Absent everywhere else: `with_crew` / `followed` parse (`semanticParser.ts:418-425`) and then constrain nothing. |
| G99 | `Freshness` | C | `liveSuggestions.ts:75-78` (+0.06 / +0.03), applied before the final rank at `gateway.ts:576-580`. |
| G100 | `PriorSelection` | C | `personalization.ts:243-268`, clamped to `BOOST_CEILING` and restricted to `BOOSTABLE_TYPES` (`:70`), both mutation-proven. ☠prod. |
| G101 | `TrustConfidence` | **N** | No trust term exists. `verified` and `is_official` are selected by `searchTravelers` (`discoverySearch.ts:577#is_official,`) and then dropped by the projection whitelist (`projection.ts:82-88`); nothing reads them into `confidence`. |
| G102 | `Diversity` | C | `lib/inputAssistance/rankingSignals.ts:291#export function applyDiversity` is the within-type term. Each successive row repeating an already-seen display signature (`lib/inputAssistance/rankingSignals.ts:276#export function diversitySignature` — label + subtitle, article-stripped, alphanumeric-folded) loses `lib/inputAssistance/rankingSignals.ts:266#DIVERSITY_STEP = 0.04`, capped. Applied before the final rank at `lib/inputAssistance/gateway.ts:718#const diversified = applyDiversity`. It compares only against EARLIER rows of the same assistance type, so §9's type order is untouched, and it demotes rather than removes, because two real venues can share a name. The pre-existing per-type fan-out and the §13 reserved slot still do what they did; what is new is that a run of near-identical rows within one type is now spread. Proven in `src/test/inputAssistanceRankingSignals.test.ts` (progressive penalty, cap, cross-type non-interference, and byte-identity on a list with no repeats). MUTATION: returning `rows` unchanged from `applyDiversity` turns it RED. |
| G103 | `PrivacyRisk` | **N** | Privacy is strictly binary in this system — included or excluded, fail-closed (`gateway.ts:373-378`). Nothing computes a risk weight, so nothing can be *demoted* for privacy risk rather than dropped. |
| G104 | `Staleness` | W | Stale live claims are removed upstream by `readLiveClaimEnvelopes` and simply never appear, and `freshnessDisplay.ts:53-58` drops a stale label. Correct behaviour, but there is no staleness **penalty** in the score: a stale row is not demoted, it is invisible. |
| G105 | `Ambiguity` | C | `projection.ts:117-124` caps an ambiguous city at 0.55 (the MEDIUM band) and `:163` caps an airport disambiguation at 0.5, so ambiguity actively lowers rank confidence. |
| G106 | `SpamRisk` | C | `lib/inputAssistance/rankingSignals.ts:207#export function spamRisk` computes the signal from a row's own user-authored display text, as the strongest of three bounded stuffing measures — token REPETITION above a prose floor, SHOUTING (upper-case ratio over a minimum length), and SEPARATOR CHAINS (`tours \| bangkok \| cheap \| best`) — and `lib/inputAssistance/rankingSignals.ts:243#export function applySpamRisk` subtracts it, capped, inside `projection.ts`'s signal stack. Demotion-only by design: stuffing is a ranking problem, not a moderation verdict, and this layer has neither the evidence nor the mandate to delete a listing. A clean row scores exactly 0 and is byte-identical to its pre-signal confidence. Proven in `src/test/inputAssistanceRankingSignals.test.ts` as a unit AND end-to-end — a stuffed `discovery_places` row seeded FIRST loses to a clean one on the same query, and both are still returned. MUTATION: `spamRisk → 0` turns four assertions RED. |

### §16 Context Carryover and Session State

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G107 | Inputs within the same task share permitted context; a field must not behave as though it exists in isolation | C | Carryover is now a CANDIDATE CONSTRAINT, not only a reorder. `lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint` reads the active task ONCE per request — the session's canonical city and the Trip's destination + date window — and `lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility` classifies every candidate against it, delegating the rule WHOLE to `lib/inputAssistance/creation.ts:167#export function partitionByFeasibility` so §18 has one implementation and not two. The verdict reaches ranking as a confidence demotion (`lib/inputAssistance/rankingSignals.ts:326#export function applyFeasibility`) plus the §15 TripFit lift, wired at `lib/inputAssistance/gateway.ts:221#const taskConstraint: TaskConstraint =` and applied in both dispatch branches. Three of the spec's four carryover examples are now mechanical: a Trip stop picker shows the Trip city's places first, an Event location is scoped toward the Trip city, and a Gem lookup prioritises the Trip city's gems. `applySessionBias` remains on top as the exact-`cityId` pin. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`, with a no-Trip control asserting the two rows are otherwise indistinguishable. MUTATION: short-circuiting `classifyFeasibility` reddens three tests. A session carrying no task issues no query and is the identity transform. |
| G108 | Carryover bounded to the active task/session; must not silently change unrelated persistent preferences | C | `applySessionBias` is a pure, request-scoped function over an in-memory array; `parseSessionContext` (`routes/inputAssistance.ts:52-59`) bounds and drops everything else. The only persistent write in the whole layer is the explicit `POST /select` (`:216-284`), which writes selection memory and nothing else. |

### §17 Cross-Field Dependency Graph

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G109 | Selecting a structured field prefills dependents (Venue → City / Country / Coordinates / Timezone) | W | The **city** binding is complete and exactly what §17 asks for (`geoResolver.ts:41-81`). But the spec's worked example runs from a **Venue** (Sky36 → Da Nang → Vietnam → coords → `Asia/Ho_Chi_Minh`), and selecting a place emits a bare `open_entity` with no binding (`projection.ts:63-67`), so a venue selection prefills nothing. The dependency graph exists for one node class out of the two named. |
| G110 | Autofilled fields remain visible, attributable and editable; no invisible field mutation | C | Mutation happens only inside an explicit `handleSelect` (`SmartInput.tsx:112-117`) and only through the caller's own `onChangeText` into an editable `TextInput`; the binding is handed up as `structuredValue` for the screen to render. Nothing writes a field the user did not tap. (Note: the *visibility* and *attribution* halves are the consuming screen's responsibility and the platform enforces neither.) |

### §18 Semantic Query Parsing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G111 | Natural language becomes structured intent when confidence is sufficient | C | `semanticParser.ts:525-589` `parseSemanticIntent` produces a full `ParsedIntent` (category, qualifiers, temporal window, relationship, anchor, stages, confidence); the §19 gate is `:600-607`. Deterministic — a rule + dictionary parser, no model. |
| G112 | Temporal operators: tonight; tomorrow morning; Friday after dinner; in two hours; when we arrive | C | `semanticParser.ts:264-362` — all five forms: `on_arrival` `:270-278`, `in N hours` `:279-299`, `tomorrow <part>` `:300-316`, weekday + time-of-day `:317-345`, and the classic four via the existing tz-aware window parser `:346-362`. |
| G113 | Geographic operators: near me; near my hotel; between us; along the way; close to airport | C | `semanticParser.ts:382-450` — hotel/airport/meeting-point/here anchors `:383-400`, `between us`/`halfway` `:409-411`, `along the way`/`on the way` `:412-415`, plus a generic `near <place text>` fallback `:436-450`. |
| G114 | Experience operators: quiet; social; luxury; cheap; local; hidden; busy; romantic; high energy | C | All nine are canonical slugs at `semanticParser.ts:39-49` with match rules at `:171-189`. |
| G115 | Sequence operators: then; after; before; on the way; next | W | `SEQUENCE_SPLIT_RE` (`:488`) covers `and then`/`then`/`after that`/`afterwards`/`followed by`/`next`/`before`. **`on the way` never splits a sequence**: it is consumed earlier by the geographic `along` extractor (`:412-415`), which runs on the whole query before the sequence split, so "food on the way to the club" parses as one stage with an `along` relationship. |
| G116 | Relationship operators: with my Trip Crew; people I follow; near our meeting point | W | All three parse (`semanticParser.ts:418-425`, `:392`) — and then constrain nothing. `semanticIntent.ts:153-186` projects the parse into a `submit_search` **string**; no candidate query is filtered by crew membership, follow graph or meeting point, and `SearchQueryContext` (`gateway.ts:380`) carries no such field. |

### §19 Progressive Disambiguation

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G117 | Ambiguity must produce clarification choices, not silent guesses | C | `geoResolver.ts:135-143` counts distinct exact-key cities and flags a bare IATA code; `projection.ts:117-124` then emits `type: 'disambiguation'` rows rather than picking one. |
| G118 | HIGH confidence → direct entity suggestion | C | `projection.ts:35` tier 3 → 0.99, `type: 'entity'`. |
| G119 | MEDIUM → multiple ranked choices | C | `projection.ts:118-120` caps every ambiguous row at 0.55 and returns all of them (`gateway.ts:353-357`), with the country as the distinguishing `reason` (`projection.ts:139`). |
| G120 | LOW → raw search remains prominent | C | `projection.ts:360-383` `orderSuggestionsReserving` protects a slot for the "SEARCH FOR" completion so a full page of entity rows can never cap it out; wired at `gateway.ts:587-589`. |
| G121 | VERY LOW → do not auto-replace | C | Two independent guarantees: `semanticParser.ts:600-607` emits no structured row below 0.6, and nothing in the client auto-replaces at any confidence — replacement requires an explicit tap (`SmartInput.tsx:112-117`). |

### §20 Constraint-Aware Suggestions

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G122 | Before ranking, remove or demote infeasible/inappropriate options | C | The rule now has its second caller. `lib/inputAssistance/creation.ts:167#export function partitionByFeasibility` is `filterInfeasibleCandidates`' own body, refactored into a three-way partition so a caller can read the VERDICT rather than the order — the main pipeline re-ranks by §9 type order afterwards, so a reordering would not have survived. `lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility` is that caller, and `lib/inputAssistance/gateway.ts:486#const verdict = classifyFeasibility(allCandidates, taskConstraint)` runs it over the whole request's candidates before projection. The action is a bounded confidence DEMOTION (`lib/inputAssistance/rankingSignals.ts:320#INFEASIBLE_DEMOTION = 0.22`), not removal: this pipeline's evidence is a city string on a projected row, weaker than the creation flow's, and the privacy gate has already decided what the viewer may see. §18 permits either; the weaker evidence chooses the weaker action, and that choice is stated rather than hidden. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`. MUTATION: short-circuiting `classifyFeasibility` turns three tests RED. |
| G123 | Closed or unavailable where current operating status is relevant | **N** | No operating-status field on `InputSuggestion` (`types.ts:206-244`), no producer, no filter. |
| G124 | Outside Trip date/time window | C | The window now has a producer AND a caller. `lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint` reads `trips.start_date` / `end_date` for `sessionContext.tripId` and pushes the end date to the END of that day — a Trip ending on the 5th includes an event at 19:00 on the 5th, and comparing against midnight would have called the last evening of the Trip infeasible. That window is passed to the shared §18 rule and demotes out-of-window events in the ordinary suggestion list. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts` with the harder fixture: the out-of-window event is seeded first AND sorts first under the event search's own `starts_at` ordering, so the in-window row can only lead because of this term — an earlier draft of the test passed without the term at all and is recorded here because that is exactly the weak-test failure mode this census exists to catch. Both rows are still returned (§18 says demote). MUTATION: short-circuiting `classifyFeasibility` turns it RED. |
| G125 | Outside selected city/area where the field is constrained | C | Same rule, same single implementation, now reached from the ordinary pipeline as well as the creation flow. The constraining city comes from the active task (`lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint`), and `lib/inputAssistance/taskContext.ts:148#function candidateCity` reads each candidate's own city from its display projection. A GEOGRAPHIC row is exempt by construction (`lib/inputAssistance/taskContext.ts:145#const GEOGRAPHIC_TYPES`): a city row IS another city, and a city picker inside a Bangkok Trip must still be able to offer Da Nang. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts` — the out-of-city place is demoted, still returned, and the no-task control leaves the two rows identical. MUTATION: short-circuiting `classifyFeasibility` turns it RED. |
| G126 | Age, trust, membership, role or invite restrictions | C ᵖ | Age: `fetchAgeRestrictedSet` fail-closed (`gateway.ts:374-378`). Membership/role: `discoverySearch.ts:1044-1047#admitted:` (plans via parent-trip ownership), `:899#visibility` + `:900#show_in_discovery` (trips). Trust/invite have no separate gate but no path exposes an invite-scoped object either. Pre-existing. |
| G127 | Unavailable Buddy category or required safety/payment gate | **N** | See G71 — only `buddy_verified_at IS NOT NULL`; there is no category, availability, safety or payment gate in the suggestion path. |
| G128 | Blocked / private / ineligible people or content | C ᵖ | `gateway.ts:373-378` and `:614-619`, both fail-closed on a null set. Pre-existing `fetchBlockedSet`. |
| G129 | Protected or sensitive locations whose exact position cannot be surfaced | C ᵖ | Structural: `InputSuggestion` has **no coordinate field at all** (`types.ts:206-244`) and `discoverySearch.ts:1443#sensitivity_level,` never selects a gem's exact pair. Deep-scanned by `test/inputAssistanceCertification.test.ts:265-327`. |
| G130 | Stale live states beyond allowed freshness | C | `liveSuggestions.ts:293` — the only live input is `readLiveClaimEnvelopes`, which owns the not-expired filter; an empty result attaches nothing (`:306`). |
| G131 | Duplicate Place/Gem/Event candidates when creation mode should resolve existing records first | C | `duplicateDetection.ts:241-370` (gems, places), `:383+` (events); `gateway.ts:534-546` then drops the redundant plain entity row for a duplicated id so the flow shows one unambiguous choice. |

### §21 Smart Action Suggestions

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G132 | Some typing produces actions rather than text replacements | C | `semanticIntent.ts:277-300` recognises "add Bangkok to my trip" and emits an `add_to_trip` action row; `search/smartActions.ts:41-43` lifts it into a dispatchable chip lane. |
| G133 | Telegraph actions: share Place, meeting point, Trip stop, Event, media, location when permitted | **N** | `share_entity` is declared in the union (`types.ts:199`) and **produced by nothing** — a repo-wide search for `type: 'share_entity'` outside the type declarations returns no producer. `telegraph_message` has a registered policy (`policyRegistry.ts:267-274`) and **no registered field**, so the context is unreachable from any screen. |
| G134 | Search actions: Add to Trip, Save, Open Map, Ask Compass, Start directions | W | One of five is real end-to-end (`add_to_trip`). `open_compass` is produced (`semanticIntent.ts:259`) but `smartActions.ts:35-43` explicitly excludes it from `DISPATCHABLE_ACTION_TYPES` — "no dispatch target in the global search bar today" — so the client drops it. Save, Open Map and Start directions have no producer. |
| G135 | Trip actions: add stop, reorder plan, add destination, invite Crew | **N** | No producer for any of the four; `SuggestionAction` has no variant that could carry them beyond `add_to_trip`. |
| G136 | Hidden Gem actions: drop pin, use approximate area, confirm existing Gem, add new Gem | W | Drop-pin exists (`validationSuite.ts:305-315`) and confirm-existing exists (`creation.ts:191-215`, a `resolve_existing` structured value). "Use approximate area" and "add a new Gem" have no producer — §37's "Add a new Place" is likewise absent. |
| G137 | Compass action: convert a phrase into a structured request/action with referenced entities | C | `semanticIntent.ts:231-268` — an editable `ai_suggestion` row whose action is `open_compass` carrying the parsed structure, and `projection.ts:283-288` attaches coarse `{surface, city, cityId, tripId}` refs to every starter. |

### §22 AI-Assisted Writing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G138 | AI assistance is opt-in, context-bound and secondary to canonical assistance | C | Triple gate: per-request `aiAssist === true` (`routes/inputAssistance.ts:139`, strictly boolean), the field policy's `allowAI` + `ai_suggestion` allowance (`gateway.ts:480-486`), and the `compass_ai_writing_enabled` flag read fail-closed (`aiWriting.ts:80-90`). Secondary by `TYPE_RANK` (G8). ☠prod (flag absent from production). |
| G139 | Captions: optional caption variants using user-provided context | C | `aiWriting.ts:64-70` `AI_WRITING_CONTEXTS` includes `caption`; wired at `hooks/useAiWritingAssist.ts`. |
| G140 | Event / Trip text: title and description suggestions | C | `AI_WRITING_CONTEXTS` includes `event_title`, `event_description`, `trip_title`, `plan_title` (`aiWriting.ts:64-70`); consumed by `app/trip/new.tsx` and `app/events/create/index.tsx`. |
| G141 | Postcards / Memories: writing assistance without inventing travel facts | **N** | Neither postcard nor memory is an `InputContext` (`types.ts:32-61`) and neither appears in `AI_WRITING_CONTEXTS`. The allowed-use row has no implementation. |
| G142 | Buddy listing text: description suggestions subject to category/policy | **N** | `buddy_service` has `allowAI` unset ⇒ false (`policyRegistry.ts:214-218`), no buddy context is in `AI_WRITING_CONTEXTS`, and there is no buddy-description field registered. |
| G143 | Compass: prompt continuation and reformulation | C | `aiWriting.ts:76-78` `isAiTextContext` admits `compass_prompt`; the deterministic starters are separate and ungated (`gateway.ts:434-446` call site). |
| G144 | Never silently insert or publish AI-generated text | C | Every variant becomes `{type:'ai_suggestion', source:'ai', action:{type:'replace_text'}}` (`aiWriting.ts:244-268`); nothing in the client applies it without a tap (`SmartInput.tsx:112-117`), and there is no publish path from this module. |
| G145 | Generated text must remain editable | C | Same — `replace_text` writes into the caller's editable `TextInput`. |
| G146 | Must not create canonical facts | C | `buildAiAssistedWriting` returns `InputSuggestion[]` and performs no write; the module imports no writer. Its output additionally passes `sanitizeSuggestedText` (`:162-180`), which drops a variant outright rather than surfacing it. |

### §23 Validation and Correction While Typing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G147 | Username unavailable → immediate non-blocking state **plus alternatives** | W | Availability and the reason are produced (`socialIdentity.ts:412-470`, reusing `validateUsername` and the same query as `GET /users/check-username`, with `.neq('id', userId)` mutation-proven so a user retyping their own handle is not told it is taken). **No alternatives are ever suggested** — `buildUsernameValidation` emits one `validation` row with a message and no candidate handles. |
| G148 | Duplicate Place/Gem → show probable existing entity before allowing duplicate creation | C | `duplicateDetection.ts:110-233` (a scored, thresholded matcher: `GEM_SAME_SPOT_KM`, `NAME_STRONG_SIM`, `DUPLICATE_THRESHOLD`) → `creation.ts:191-215` projects it as a MEDIUM-band `disambiguation`, never a block. |
| G149 | City-country mismatch → suggest canonical correction | C | `validationSuite.ts:50-93` (returns no verdict when the pair is unknown, rather than fabricating a mismatch) → `:194-230` a `correction` row whose action is an explicit `set_structured_value` the user must tap. |
| G150 | Trip date conflict → explain conflict and preserve user control | C | `validationSuite.ts:128-160` (inverted range + overlap with the viewer's own trip windows) → `:232-262`, which explicitly "does NOT change the dates". |
| G151 | Unresolved address → map pin, nearby candidates, or raw fallback | C | `validationSuite.ts:297-341` builds all three, policy-gated per context; entered from `gateway.ts:528-533` only when nothing canonical resolved. |
| G152 | Invalid hashtag/handle → explain normalization or reserved-name rules | C ᵖ | `validationSuite.ts:177-192` + `:265-287` for hashtags; handles reuse the pre-existing `lib/usernameRules.validateUsername`. |
| G153 | Provider disagreement → show choices or the canonical Portava record; never silently overwrite | **N** | *Unguarded absence.* There is no provider lane in the gateway (`external_places_enabled` is dormant and no provider candidate reaches `projection.ts`), so there is nothing to disagree — and nothing would refuse a silent overwrite if a provider were added. |

### §24 Paste Intelligence

No paste path exists anywhere in the input layer. A repo-wide search for
`onPaste`, `Clipboard`, `paste` or `pasted` under `lib/inputAssistance/` and
`platform/input-assistance/` returns **nothing**; the app's only `Clipboard`
uses are share/copy affordances (`components/ShareSheet.tsx`,
`components/stamps/StampDetailModal.tsx`) that write out, never read in.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G154 | Pasted input passes through the same classification/resolution pipeline | **N** | No paste handler exists on `SmartInput` or anywhere in the layer. |
| G155 | Place names and addresses | **N** | — |
| G156 | Map links via configured parsers/providers | **N** | — |
| G157 | Coordinates | **N** | — |
| G158 | Event links | **N** | — |
| G159 | Flight/hotel text | **N** | — |
| G160 | Itinerary blocks | **N** | — |
| G161 | Lists of stops or destinations | **N** | — |
| G162 | Bulk extraction must always lead to a review screen before persistent mutation | **N** | *Unguarded absence.* There is no bulk-extraction path, and nothing would require a review screen if one were added. |

### §25 Voice and Dictation

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G163 | Transcribed speech runs through the same normalization/resolution/intent/privacy/suggestion pipeline | **N** | **Re-verified by this lane at this tree, for cross-census W71 (`census-wall.md`), not inherited.** There is no speech-to-text producer anywhere: `grep -rniE 'voice\|speech\|dictat\|transcri\|microphone'` over `artifacts/api-server/src/lib/inputAssistance/` and `travel-buddy-standalone/src/platform/input-assistance/` returns NOTHING (exit 1 on both), the client package declares no `expo-speech`, no `@react-native-voice/voice` and no `SpeechRecognition`, and every `voice` match in the client tree is WebRTC **voice calling** (`src/components/calls/`, and the events voice-room card)  — a different feature that produces no transcript. `expo-av` is present for media playback and is not a dictation transport. So **voice input does not exist and is not planned in any artifact in this tree**: no flag, no stub, no `InputContext` in `lib/inputAssistance/types.ts:32-61`, and no §51 phase for §25. The requirement is conditional on dictation existing and nothing routes it. WHAT WOULD TURN THIS RED: a dictation surface that hands its transcript to `lib/inputAssistance/queryNormalizer.ts:553#export function normalizeQuery` like any other typed text. Until one exists this row is correctly N and cannot be closed by this layer. |

### §26 Mention, Hashtag and Entity Insertion

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G164 | `@` / `#` create canonical references, not merely styled strings | C | `socialIdentity.ts:294` (`set_structured_value` → `{kind:'mention', userId, handle}`) and `:387` (`{kind:'hashtag', slug}`); routed at `gateway.ts:274-292`. (Caveat: none of the three `WRITING_CONTEXTS` — caption, comment, telegraph_message — has a registered field, so this path has no consumer yet.) |
| G165 | The rendered text stays human-readable while the underlying attachment is structured | C ᵖ | The split is realised in production by the pre-existing `components/MentionInput.tsx`, which keeps display text while recording structured tag spans (`insertTag` replaces the trigger token and records the span). The platform's own version is the unconsumed path above. |

### §27 Suggestion UI Surfaces

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G166 | Dropdown | C | `components/SuggestionOverlay.tsx:78-100` — a height-capped, internally-scrolling card anchored under the field. |
| G167 | Bottom sheet | C | `components/DisambiguationSheet.tsx:56-75` — scrim + `accessibilityViewIsModal` sheet with a "Search X instead" escape. |
| G168 | Inline chips | C | `components/SuggestionChip.tsx:26-30`. No consumer outside `index.ts` today. |
| G169 | Action chips | C | `components/ActionSuggestionRow.tsx:29-32`; `search/smartActions.ts:56-58` lifts dispatchable actions into their own chip lane so a row lands in exactly one place. |
| G170 | Correction banner | C | `components/CorrectionBanner.tsx:41-42` — `accessibilityRole="alert"` with accept/dismiss. |
| G171 | Entity preview row | C | `components/EntitySuggestionRow.tsx:44-83`. |
| G172 | Zero-state panel | W | There is no zero-state **panel**: `SuggestionOverlay`'s `emptyState` is a caller-supplied `ReactNode` (`:43`, `:60`), and the zero-character rows the server returns are rendered through the ordinary list. The platform ships no component for the surface the spec names. |
| G173 | All surfaces support safe-area behaviour and stable layout under the mobile keyboard | W | `keyboardShouldPersistTaps="handled"` (`SuggestionOverlay.tsx:100`) keeps taps working while the keyboard is up, and the header claims the "no overlay trapped behind the keyboard" guarantee follows from being inline. But there is **no safe-area inset and no keyboard-height awareness anywhere in the layer** — no `useSafeAreaInsets`, no `KeyboardAvoidingView`, no `Keyboard` listener — so the claim is an argument, not a mechanism. |

### §28 Entity Preview Anatomy

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G174 | Primary title and entity type | C | `EntitySuggestionRow.tsx:34-42` composes both into the a11y label; `components/entityIcon.tsx` renders the type. |
| G175 | City/neighborhood or relevant location label | C | `projection.ts:83` copies `subtitle`; rendered at `EntitySuggestionRow.tsx:72-76`. |
| G176 | Distance where permitted | **N** | `InputSuggestion` has no distance field (`types.ts:206-244`) and nothing computes one — `SearchResult.distanceKm`, where it exists, is dropped by the projection whitelist. |
| G177 | Open/closed or availability state where valid | **N** | No field, no producer. See G67. |
| G178 | Freshness / current-state badge where applicable | C | `components/freshnessDisplay.ts:47-64` → `EntitySuggestionRow.tsx:63-69`, rendering only strings the server sent. |
| G179 | Current Trip or Saved relationship | W | "Current Trip"/"Upcoming Trip" appears as `reason` on **zero-character defaults only** (`geoResolver.ts:243-249`). A typed result never carries a Trip relationship, and "Saved" is nowhere — no saved-entity lookup exists in the layer. |
| G180 | User verification / trust context where appropriate | **N** | `verified` and `is_official` are selected by `searchTravelers` (`discoverySearch.ts:577#is_official,`) and dropped by the projection whitelist (`projection.ts:82-88`); no suggestion can carry them. |
| G181 | Hidden Gem protection / status labels | **N** | `sensitivity_level` is read to decide the position (`gemSearchPosition:241-255`) and never projected as a label, so a protected gem looks identical to an unprotected one in a suggestion row. |
| G182 | Why this is suggested, when useful | C | `projection.ts:84` copies `matchedReason` into `reason`; the geo defaults set it explicitly (`geoResolver.ts:243-249`), and `EntitySuggestionRow.tsx:76-80` renders it. |

### §29 Privacy and Eligibility Gateway

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G183 | No suggestion is returned merely because it matched text; viewer eligibility is resolved first | C | `gateway.ts:373-402` — the block and age sets are fetched and, when either is `null`, **nothing** is emitted; the comment at `:402` names it as fail-closed. |
| G184 | Blocked users and blocked relationships suppressed | C ᵖ | `fetchBlockedSet` (pre-existing) at `gateway.ts:374`, `:615`; the null-set refusal is the mutation-proven case in `test/inputAssistanceGateway.test.ts`. |
| G185 | Private Trips/Events/Plans excluded unless the viewer is eligible | C ᵖ | `discoverySearch.ts:727#visibility`, `:899#visibility`, `:900#show_in_discovery`, `:1044-1047#admitted:`. Proven **through the gateway** by `test/inputAssistanceCertification.test.ts:330-366`. |
| G186 | Private captions/tags/metadata never enter public suggestion indexes | C ᵖ | The projection copies a fixed whitelist (`projection.ts:82-88`) and drops `metadata`, `privacyState`, `accessState`, owner/host ids and counts; the searches select public columns only. |
| G187 | Precise private location never leaked through autocomplete | C | Structural — `InputSuggestion` declares no coordinate field (`types.ts:206-244`); the one place a coordinate legitimately travels is the **public city-centre** inside a picker binding (`geoResolver.ts:70-81`). Deep-scanned adversarially at `test/inputAssistanceCertification.test.ts:265-327`. |
| G188 | Presence/location inference cannot be exposed beyond current authorization | C | The only inference path is the live lane, and it consumes nothing but `readLiveClaimEnvelopes` behind `liveLabelsServable` (`liveSuggestions.ts:271-279`), which owns the full IG gate chain. No presence or location-inference source is wired into the gateway at all. |
| G189 | Memory-based suggestions remain owner-scoped unless deliberately shared | C | `personalization.ts:159-180` filters `.eq('user_id', …)` from a session-derived id, never a parameter; `SURFACEABLE_GEO_TYPES` (`:83`) restricts injection to public geo entities so a remembered **person** can never be re-published around the privacy gate — mutation-proven (`test/inputAssistanceInvariants.test.ts`, item 5). ☠prod. |
| G190 | Sensitive-location and protected-place rules applied before projection | W | The **gem** sensitivity rule is applied at source and is real (`discoverySearch.ts:1443#sensitivity_level,`, `:286-300#gemSearchPosition`). The repo's actual protected-place gate — `lib/protectedLocations.ts`, built for the Map spec §24 — is **never consulted by this path**, and `protected_zones` is absent from production anyway (`scripts/checkProductionDrift.ts:104-117`). A protected zone that is not a hidden gem has no effect on a suggestion. |
| G191 | AI receives only the minimum permitted structured context | C | `aiWriting.ts:107-130` `buildPermittedWritingContext` emits coarse city/country/category/dates only, wraps the user's text with `wrapUgc` (data-not-instructions) and runs `stripCoordinateFields` as a backstop. (`d4db6009` records honestly that the backstop has no reachable path today.) |

### §30 Conflict Resolution Precedence

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G192 | The precedence chain: canonical identity > verified/current authoritative state > eligible community state > approved provider state > cached historical state > user raw input > AI guess | **N** | *Unguarded absence.* No precedence implementation exists. Three of the seven tiers have no producer at all in this system (verified authoritative state, approved provider state, cached historical state), so two sources never assert conflicting facts about the same entity — and nothing would resolve them in the required order if they did. `TYPE_RANK` (`projection.ts:309-320`) is a display order over assistance types, which §30 explicitly says is a different thing. |
| G193 | If uncertainty remains, show disambiguation rather than inventing resolution | C | `geoResolver.ts:135-143` → `projection.ts:117-124`; the airport case at `:148-169` is the clearest instance — a bare code is never resolved to a city silently. |

### §31 Freshness and Live Intelligence

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G194 | Live suggestions remain **projections** of the Live Intelligence system | C | `liveSuggestions.ts:250-317` attaches a `freshness` object to an otherwise-unchanged canonical entity; it computes no confidence and decides no eligibility, consuming `readLiveClaimEnvelopes`' output verbatim (`:293`). ☠prod (zero intel rows). |
| G195 | If live intelligence is stale/unavailable, remove the live label or show the last-updated state | C | `components/freshnessDisplay.ts:47-64` — `unavailable`/absent ⇒ render nothing; `stale` ⇒ drop the state label and keep only the server's age string. |
| G196 | Never manufacture "busy now", "available now" or similar | C | `liveSuggestions.ts:110-140` — every formatter is total and returns `null` for an unrecognised value rather than a default; `buildFreshnessState:181` returns `null` for an empty envelope list; `freshnessDisplay.ts:60-63` has no fallback label branch. Both sides are mutation-proofed (`test/inputAssistanceLiveIntelligence.test.ts`, `components/__tests__/freshnessDisplay.test.ts`). |

### §32 Offline and Degraded Mode

The mechanism this section depends on — the per-field `offlinePolicy` — is
declared and read by nothing (G30). What follows is what actually exists.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G197 | Countries / languages / interests → local static dictionary | **N** | The dictionaries are **server-side** (`discoverySearch.ts:2064-2065#COMMON_LANGUAGES`, `COMMON_LANGUAGES` / `COMMON_INTERESTS` behind `searchStatic`). The client ships none: `platform/input-assistance/` contains no country, language or interest list, so an offline country picker returns nothing. |
| G198 | Cities → cached / local compact city index | W | Only the 60-entry, 60-second in-memory SWR cache (`services/suggestionCache.ts:18-33`). There is no local city index, and the cache is not persisted, so a cold app start offline has nothing. (`lib/cityCentroids.ts` exists but is a map-camera helper, not consumed by this layer.) |
| G199 | Recent selections → device-local where allowed | W | `services/suggestionHistory.ts:31-32` is an in-memory `Map`, and its own header says the AsyncStorage-backed store is "a LATER PHASE". Recents do not survive an app restart on either side (server table absent, client store in memory). |
| G200 | Saved / Trip entities → cached subset where permitted | **N** | No saved-entity cache and no Trip-entity cache in the layer. |
| G201 | Places → cached recent and Trip-scoped entities | **N** | No place cache beyond the generic suggestion SWR cache, which is keyed by query text, not by entity. |
| G202 | Live intelligence → unavailable or clearly stale; never represented as live | C | `components/freshnessDisplay.ts:53-58`; the server attaches nothing when the gate is off (`liveSuggestions.ts:279`). |
| G203 | AI assistance → unavailable offline unless an approved on-device model exists | C | `useInputAssistance.ts:190-194` degrades a 404/offline to `unavailable` and clears the list without an error; there is no on-device model and `aiWriting.ts` is server-only, so AI cannot appear offline. |

### §33 Performance Architecture

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G204 | The tier ladder: 0 chars → cached/default; 1 char → local/cache prefix match; 2+ chars → server-assisted | W | Only two of the three tiers exist, and the middle one is the one that matters. `useInputAssistance.ts:113-200` checks `minChars`, then the SWR cache, then goes to the **server**. There is no local prefix-match tier: a 1-character query on a cache miss is a network round-trip. The hook's own header claims the ladder (`:10-13`); the effect body does not implement it. |
| G205 | Recommended debounce 100–150 ms | C | `policyRegistry.ts:86` defaults `debounceMs` to 120; consumed at `useInputAssistance.ts:277`. |
| G206 | Cancel stale requests | C | `useInputAssistance.ts:157-159` aborts the previous `AbortController` before each fetch; `:211` aborts on unmount. |
| G207 | Use request sequence IDs | C | `services/raceGuard.ts:33-50` is the single shared monotonic guard; `useInputAssistance.ts:208` + `:235` (`if (!guardRef.current.isCurrent(mySeq)) return`). The server independently stamps `requestId` (`routes/inputAssistance.ts:166`, returned at `:207`). |
| G208 | Stale-while-revalidate | C | `services/suggestionCache.ts:18-33` (TTL + LRU, coordinate key rounded to ~1 km); `useInputAssistance.ts:141-152` serves a hit with zero network and keeps previous rows visible while fetching. |
| G209 | Prefetch likely dependent data after a canonical selection | **N** | Nothing prefetches. §53's "Prefetch Bangkok neighborhoods / airports / saved places" has no implementation on either side; `handleSelect` (`SmartInput.tsx:101-127`) emits telemetry, records selection memory and returns. |
| G210 | Network loss: retain local/cached suggestions and explicit degraded behaviour | W | The degraded *state* is explicit and correct (`useInputAssistance.ts:190-194` sets `unavailable`, `SuggestionOverlay.tsx:74-76` shows a quiet note, never an error). But the same branch **clears the list** (`setSuggestions([])`), which is the opposite of "retain local/cached suggestions" — the last good rows are discarded exactly when the network dies. |
| G211 | Virtualize large suggestion groups; cap visible results | W | The cap is real and layered (`routes/inputAssistance.ts:144`, `gateway.ts:586`, client `finalizeSuggestions`). **Nothing is virtualized**: `SuggestionOverlay.tsx:99` renders a plain `ScrollView`, not a `FlatList`/`VirtualizedList`, so every row in the group mounts. (With `maxSuggestions ≤ 8` everywhere this is currently harmless — but it is the mechanism the spec asks for, and it is absent.) |

### §34 Local vs Server Processing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G212 | Prefer local: static dictionaries | **N** | Server-side only — see G197. |
| G213 | Prefer local: recent selection history | W | Server-side by design (`personalization.ts:159-180`), against a table absent from production; the client store is in-memory (G199). Both halves of "local" fail. ☠prod |
| G214 | Prefer local: cached city prefix matching | W | The SWR cache is keyed by the whole query string (`suggestionCache.ts` `key(fieldId, text, lat, lng)`), so backspacing to a prefix is a **miss** unless that exact prefix was typed before. There is no prefix index. |
| G215 | Prefer local: simple normalization | C | `services/queryNormalization.ts:38-52` — NFKD, diacritic strip, stroke-letter fold, whitespace collapse, on-device, used for cache keys and local comparison. |
| G216 | Prefer local: immediate zero-state | W | The zero-state is a **server round-trip**: `gateway.ts:194-218` and `:226-248` produce it, and the client has no local zero-state source. That is the inverse of this row, and it means a cold or offline open of a city picker shows nothing. |
| G217 | Prefer local: request cancellation / state | C | `services/raceGuard.ts`; `useInputAssistance.ts:212`, `:288`. |
| G218 | Prefer server: canonical entity lookup requiring current DB state | C ᵖ | `gateway.ts:343-404` → `dispatchSearch`. |
| G219 | Prefer server: privacy/eligibility filtering | C | `gateway.ts:373-378`, `:614-619` — server-side and fail-closed; the client explicitly does no re-filtering (`hooks/useTelegraphRecipients.ts:15-18`). |
| G220 | Prefer server: cross-entity search | C ᵖ | `entityMap.ts:16-33#DispatchSearchType` (17 types) → `dispatchSearch` (`discoverySearch.ts:2008#dispatchSearch`, switch at `:2020-2057#"travelers":`). Still 17 after the §27 `saved` lane landed: `DispatchSearchType` is an EXPLICIT union and `ENTITY_TO_SEARCH` is `Record<EntityType, DispatchSearchType>`, so `SEARCH_TYPES`' eighteenth member (`:2055#searchSaved`) has no `EntityType` that reaches it. |
| G221 | Prefer server: Live Intelligence suggestions | C | `liveSuggestions.ts:250-317`. ☠prod |
| G222 | Prefer server: provider federation | **N** | No provider lane exists in the gateway; `external_places_enabled` is dormant and no provider candidate is ever projected. |
| G223 | Prefer server: personalized ranking requiring server-owned context | C | `personalization.ts:243-268` runs server-side over server-held memory. ☠prod |
| G224 | The client should not send every keystroke when local resolution is sufficient; use the smallest necessary server interaction | W | Debounce + SWR + the sequence guard genuinely reduce traffic, and the mention/hashtag sigil path short-circuits. But with no local tier (G204) and no local dictionary or prefix index (G212/G214), every above-threshold keystroke that misses the exact-string cache is a server call — including the zero-character one. |

### §35 Selection Memory and Personalization

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G225 | Learn from repeated **explicit** selections, never inferred private facts | C | `routes/inputAssistance.ts:216-284` is the only write entry point and requires an explicit accept; `personalization.ts:464-472` refuses for any context whose policy disallows personalization and for any entity type the policy does not list. No view, hover, dwell or typing signal exists. ☠prod |
| G226 | Recently selected cities / places / users | W | The read is right (`personalization.ts:395-436`), the table is absent from production, and — the finding `d4db6009` made — the writer was missing on every picker context until that commit added it. Today three call sites record: `SmartInput.tsx:123`, `components/selectors/GlobalPlacePicker.tsx`, `hooks/useGlobalSearchSuggestions.ts` (`recordPick`), with `telegraph_recipient` named as a still-open exemption in `services/__tests__/selectionWriterCoverage.test.ts`. ☠prod |
| G227 | Frequently selected abbreviations mapped to the same canonical entity for that user | C | `personalization.ts:334-386` `buildLearnedGeoInjections`, keyed on a query key folded **without** alias expansion so a user's own "bkk" maps even when the global dictionary does not know it (`gateway.ts:176-187`). ☠prod |
| G228 | Saved and Trip-related entities | W | Trip destinations feed the zero-state (`geoResolver.ts:214-250`). **Saved entities feed nothing** — no saved/bookmark source is read anywhere in the layer. |
| G229 | Previously successful query completions | **N** | `/select` requires `entityType` + `entityId` (`routes/inputAssistance.ts:237-242`); a query completion (`submit_search`) has neither, so a successful raw-search completion is never recorded and can never be re-surfaced. |
| G230 | Context-specific selection patterns | C | `personalization.ts:169` filters `.eq('context', …)`, so memory learned on one field never leaks into another — the property that made the missing-writer bug invisible. ☠prod |

### §36 Anti-Spam and Manipulation Controls

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G231 | Keyword-stuffing resistance in business / Buddy / user descriptions | C | `lib/inputAssistance/rankingSignals.ts:207#export function spamRisk` is the heuristic: token repetition above a prose floor, upper-case ratio over a minimum length, and separator-chained keyword lists, combined by taking the STRONGEST rather than summing so a listing is not punished twice for one habit. It runs over every dispatched row's `title + subtitle` — the fields a business / Buddy / user listing authors — inside `projection.ts`'s signal stack, and demotes by at most `SPAM_MAX_PENALTY`. A clean listing scores 0 and is unchanged. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`: `"Bangkok Tour Bangkok Tour Bangkok Tour Bangkok"` loses to `"Bangkok Tour Collective"` on the query both match exactly, and both are still returned. MUTATION: `spamRisk → 0` reddens four assertions. **What this is NOT**: it is not moderation, not a block, and not a Buddy-specific rule — §36's other six controls are unaffected and G232 (alias abuse) still has no detector. |
| G232 | Alias abuse detection | **N** | The alias tables (`canonicalLocations.ts:161-192`, `discoverySearchHelpers.ts:63-95`) are curated, static and one-directional; nothing detects a user-supplied alias being abused. |
| G233 | Impersonation protections for people and businesses | W | `account_status` filtering on recipients is real and mutation-proven (`socialIdentity.ts`, `test/inputAssistanceInvariants.test.ts` item 1), and `verified`/`is_official` exist on the profile row. But nothing in the suggestion path **detects or demotes** an impersonating handle, and the verification flags are dropped before projection (G180), so a viewer cannot even tell the real account from the copy. |
| G234 | Duplicate entity suppression | C | `duplicateDetection.ts:241-370`; `gateway.ts:389-400` (per-id dedup across types) and `:534-546` (collapse a duplicate's redundant entity row). |
| G235 | Rate limits on suggestion-affecting submissions | C ᵖ | `routes/inputAssistance.ts:153` (`input_assist_suggest`, 90/min) and `:275` (`input_assist_select`, 60/min), on the pre-existing `lib/rateLimit` buckets. |
| G236 | No paid boost into factual confidence or canonical identity priority | C | Structural: `confidence` is a pure function of `matchTier` (`projection.ts:33-40`) plus two clamped boosts (freshness, prior-selection), and `InputSuggestion.source` (`types.ts:227-234`) has no sponsored/promoted value — there is no field a paid signal could enter through. |
| G237 | Provider neutrality — do not favour a source because it was integrated first | **N** | *Unguarded absence.* There is exactly one candidate source; no provider lane exists, so neutrality is untested and unguarded. |

### §37 Empty and No-Match States

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G238 | Available fallback actions are context-dependent | C | `creation.ts:330-345` builds only the fallbacks the context's policy permits, and `gateway.ts:528-533` reaches it only when nothing canonical resolved and no duplicate was found. |
| G239 | A city picker should not offer "create city" | C | `policyRegistry.ts:110-116` gives `city_picker` only `['entity','recent']`, and the fallback builder is reachable only from `isCreationContext` (`creation.ts:51-63`), which excludes it. |
| G240 | A Hidden Gem / location flow may offer map-point or new-entity creation under policy | W | Map-point and raw-text fallbacks exist (`validationSuite.ts:297-341`). **New-entity creation does not**: nothing emits an "Add a new Place"/"Add a new Gem" row, so the spec's own empty-state mock cannot be rendered from platform output. |

### §38 Failure Fallback Ladder

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G241 | The ladder: canonical → cached canonical → approved provider → local index / recent history → raw query | W | Three of five rungs exist. Canonical (`gateway.ts:343-404`), cached (`suggestionCache.ts`) and raw query (`projection.ts:213-229`) are real. **Approved provider has no producer** (G222) and **local index does not exist** (G212/G214) — and the local-history rung is the in-memory store of G199. A total failure therefore falls from rung 2 straight to rung 5. |
| G242 | Provider failure must not collapse the input UI; preserve canonical records and valid local fallbacks | C ⌀ | Per-source `.catch(() => [])` on every candidate call (`gateway.ts:385`, `:626`) plus a route-level try/catch that returns a well-formed empty 200 (`routes/inputAssistance.ts:186-198`), plus the client's `unavailable` degradation. Certified at `test/inputAssistanceCertification.test.ts:370-388`. **Vacuous**: there is no provider to fail. |

### §39 Client SDK Architecture

All 28 named files exist at the declared paths under
`platform/input-assistance/`. Six have **no consumer** anywhere in the app,
marked *(unused)*.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G243 | `components/SmartInput.tsx` | C | `:65-201`. |
| G244 | `components/SuggestionOverlay.tsx` | C | `:49-120`. |
| G245 | `components/SuggestionList.tsx` | C | 59 lines; consumed by the overlay. |
| G246 | `components/SuggestionGroup.tsx` | C | `:32` header row; re-exports the pure grouper. |
| G247 | `components/SuggestionChip.tsx` | C | `:26-30`. *(unused)* |
| G248 | `components/EntitySuggestionRow.tsx` | C | `:44-83`. |
| G249 | `components/ActionSuggestionRow.tsx` | C | `:29-32`. |
| G250 | `components/CorrectionBanner.tsx` | C | `:41-66`. |
| G251 | `components/DisambiguationSheet.tsx` | C | `:56-75`. |
| G252 | `hooks/useInputAssistance.ts` | C | `:70-214`; 14 consumers. |
| G253 | `hooks/useAutocomplete.ts` | C | `:15-22` — a real type-narrowing wrapper. *(unused)* |
| G254 | `hooks/useEntitySuggestions.ts` | C | `:16-23`. *(unused)* |
| G255 | `hooks/useTextSuggestions.ts` | C | `:17-28`. *(unused)* |
| G256 | `hooks/useInputValidation.ts` | C | 66 lines; surfaces server `validation`/`correction` rows as one state. *(unused)* |
| G257 | `services/inputAssistance.ts` | C | 103 lines — the fetch client; degrades a 404 to `unavailable`. |
| G258 | `services/suggestionRanking.ts` | C | 50 lines — `finalizeSuggestions`/`capSuggestions`/`dedupeSuggestions`. |
| G259 | `services/queryNormalization.ts` | C | `:38-52`. |
| G260 | `services/entityResolution.ts` | W | A declared **stub**: `:44-58` passes through a suggestion that is already resolved and returns `null` otherwise, with "Phase 2 replaces the null branch" in the body. It resolves nothing the server did not already resolve. *(unused)* |
| G261 | `services/suggestionHistory.ts` | W | In-memory `Map` (`:31-32`), documented as not the persistent store. *(unused)* |
| G262 | `services/suggestionCache.ts` | C | `:18-33`. |
| G263 | `services/inputTelemetry.ts` | W | The scrub and allowlist are real (`:48-72`) and the module now has REAL CALL SITES for nine previously-dead event names (G311–G318, plus the exported emitters for G319/G320) — `services/inputTelemetry.ts:169#export function emitSuggestionsRendered` and its siblings, all driven from `SmartInput` and proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`. **The sink is still `() => {}` (`:35-36`) and `setTelemetrySink` is still called from no non-test file.** Emission is not measurement: in production these events are now produced and dropped. Inventing a transport here would have been worse than leaving the gap, because the only honest destination is a server endpoint that does not exist. WHAT WOULD TURN THIS RED: a telemetry POST target (route owner) plus one `setTelemetrySink` call at app bootstrap — travel-buddy-standalone/app/_layout.tsx, outside this lane's paths. |
| G264 | `contexts/inputContexts.ts` | C | 476 lines, all 29 contexts. |
| G265 | `contexts/inputPolicies.ts` | C | 79 lines, `buildDefaultPolicy`. |
| G266 | `contexts/fieldRegistry.ts` | C | `:26-79`. |
| G267 | `types/inputSuggestion.ts` | C | 157 lines. |
| G268 | `types/inputContext.ts` | C | 159 lines. |
| G269 | `types/fieldPolicy.ts` | C | 114 lines. |
| G270 | `types/suggestionAction.ts` | C | 29 lines, the §43 union. |

### §40 Server Domain Services

Judged as **responsibilities**, not filenames (§52 permits configuration or a
narrow resolver extension rather than a new architecture).

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G271 | InputAssistanceGateway | C | `gateway.ts:146-593`. |
| G272 | InputContextResolver | C | `policyRegistry.ts:334-347` server side; `contexts/fieldRegistry.ts:57-79` client side. |
| G273 | InputPolicyEngine | C | `policyRegistry.ts:72-329`. |
| G274 | QueryNormalizer | C | The service now exists: `lib/inputAssistance/queryNormalizer.ts:553#export function normalizeQuery` is the single entry point, and `lib/inputAssistance/gateway.ts:175#const norm: NormalizedQuery` is its only caller in the suggest path. It COMPOSES rather than replaces — `applyAliases` and `sanitizeQuery` are still Discovery's, and the canonical fold is still `canonicalLocations` — and adds the three §10 clauses that had no implementation anywhere (transliteration G61, context-appropriate emoji handling G62, keyboard-weighted typo tolerance with a confidence measure G63). The pipeline order is fixed and documented in the file header: trim → sigil → transliterate → emoji → alias → typo → sanitize → clamp. It returns `aliased` unchanged for the §18 temporal extractor and the semantic parser, so those two consumers see byte-identical input to what they saw before this file existed. The client comment this row quoted — *"Real alias resolution belongs to the server's QueryNormalizer (§40)"* — now names something real; the client mirror itself is still local-only, which is G340/G344's problem, not this row's. |
| G275 | EntitySuggestionService | C | `gateway.ts:601-640` `dispatchAndProject`. |
| G276 | CityResolver | C | `geoResolver.ts:120-145`. |
| G277 | CountryResolver | W | No canonical country resolver: `entityMap.ts:37` maps `country → 'countries'`, and `discoverySearch.ts:1893#searchCountries` **aggregates `profiles.home_country`** (`:1895-1896#home_country")`) (`.from("profiles").select("id, home_country").ilike("home_country", pat)`). A country picker therefore resolves against the user table, not a canonical country registry, so a country with no users in it does not exist. |
| G278 | PlaceResolver | C ᵖ | `discoverySearch.ts:2052#searchPlaces`. |
| G279 | HiddenGemResolver | C ᵖ | `discoverySearch.ts:2056#searchHiddenGems` + `:286-300#gemSearchPosition`. |
| G280 | UserResolver | C | `socialIdentity.ts:146-229`. |
| G281 | TripResolver | C ᵖ | `discoverySearch.ts:2045#searchTrips`. |
| G282 | EventResolver | C ᵖ | `discoverySearch.ts:2038#searchEvents`. |
| G283 | BuddyResolver | W | `discoverySearch.ts:2034#searchTravelers` is `searchTravelers` with `isBuddy`, whose only buddy-specific predicate is `:584#buddy_verified_at` `.not("buddy_verified_at","is",null)`. No category, availability or eligibility resolution (G71, G127). |
| G284 | IntentSuggestionService | C | `semanticIntent.ts:336-379`. |
| G285 | SemanticQueryParser | C | `semanticParser.ts:525-589`. |
| G286 | PersonalSuggestionService | C | `personalization.ts:159-436`. ☠prod |
| G287 | LiveSuggestionService | C | `liveSuggestions.ts:250-317`. ☠prod |
| G288 | ValidationService | C | `validationSuite.ts:30-341`. |
| G289 | DuplicateDetectionService | C | `duplicateDetection.ts:89-468`. |
| G290 | SuggestionRanker | C | `projection.ts:326-383`. |
| G291 | SuggestionDedupeService | C | `gateway.ts:389-400` (cross-type id dedup), `:534-546` (duplicate/entity collapse), client `services/suggestionRanking.ts` `dedupeSuggestions`. |
| G292 | SuggestionTelemetryService | **N** | There is no server-side telemetry service, no serve log, no impression record and no analytics write anywhere in `lib/inputAssistance/` — the certification says so itself ("The suggest path persists **nothing**"). The only sink is the client's no-op (G263). |

### §41 API Contract

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G293 | One canonical suggest endpoint with context-sensitive projection; narrow endpoints only when justified | C | `routes/inputAssistance.ts:97` is the only suggest endpoint, parameterised by `context`; the one additional route (`:216` `/select`) is a write, not a second suggest path. |
| G294 | The request envelope (`context`, `fieldId`, `text`, `limit`, `sessionContext{tripId,cityId}`) | C | `types.ts:281-303` declares exactly those plus optional additive fields (`lat`/`lng`/`city`/`tz`/`draft`/`aiAssist`); parsed and bounded at `routes/inputAssistance.ts:105-144`, which drops unknown keys and oversized values. |
| G295 | The response envelope (`requestId`, `policyVersion`, `suggestions[]`) | C | `types.ts:305-311`; emitted at `routes/inputAssistance.ts:178-185` and, on failure, identically at `:190-197`. The implementation adds `context` and `fieldId`, which is additive and backward-compatible. |

### §42 Internal Projection Contract

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G296 | Return a UI-ready projection; never expose raw trust vectors, private ranking features or hidden policy decisions | C | `projection.ts:50-91` copies a fixed whitelist and drops `metadata`, `privacyState`, `accessState`, `actionState`, owner/host ids, counts and coordinates. Deep-scanned adversarially by `test/inputAssistanceCertification.test.ts:265-327`. The internal ranking features that *do* survive (`confidence`) are a bounded 0–1 display value, not the score's components. |

### §43 Routing and Action Resolution

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G297 | Every suggestion that looks tappable resolves through the canonical action/destination contract | C | `projection.ts:385-407` — the server-side safety net that drops any row without an action, entity id or route, applied on every return path. |
| G298 | `open_entity` | C | `projection.ts:63-67`; `socialIdentity.ts:260#open_entity`; `creation.ts:207`. |
| G299 | `replace_text` | C | `projection.ts:185`, `:295`; `aiWriting.ts:259`; `validationSuite.ts:336`. |
| G300 | `set_structured_value` | C | `projection.ts:130`, `:161`, `:184`; `socialIdentity.ts:294`, `:387`, `:460`; `validationSuite.ts:210`, `:245`. |
| G301 | `submit_search` | C | `projection.ts:224`; `semanticIntent.ts:175`, `:204`; `validationSuite.ts:323`. |
| G302 | `add_to_trip` | C | `semanticIntent.ts:290`; the only client-dispatchable action (`search/smartActions.ts:41-43`). |
| G303 | `share_entity` | **N** | Declared at `types.ts:199` and client `types/suggestionAction.ts:24`. **No producer anywhere.** §21's entire Telegraph action row depends on it. |
| G304 | `drop_pin` | C | `validationSuite.ts:310`. |
| G305 | `open_compass` | W | Produced (`semanticIntent.ts:259`) and then dropped by every client surface: `search/smartActions.ts:35-43` excludes it from `DISPATCHABLE_ACTION_TYPES` because it has "no dispatch target in the global search bar today", and the grouped-row bridge skips it too. A server-emitted action that no client can act on. |

### §44 Telemetry and Observability

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G306 | Measure usefulness without unnecessarily capturing raw private text | W | The privacy half is real and mutation-proven (`services/inputTelemetry.ts:48-62` drops `text`/`query`/`rawText`/`message` for a non-capturing field; `services/__tests__/inputTelemetry.test.ts`), and the new funnel arms were built to the same rule — every one carries a COUNT or a LENGTH and never the text, asserted directly rather than assumed (`components/__tests__/inputTelemetryFunnel.component.test.tsx`). The **measurement** half still does not exist: the sink is `() => {}` (`:35-36`) and is attached nowhere outside tests. What moved is that there is now something worth transporting — nine event names with call sites instead of nine strings in a union. WHAT WOULD TURN THIS RED: see G263. |
| G307 | `input_opened` | C | `SmartInput.tsx:170`. |
| G308 | `query_length_changed` | C | `useInputAssistance.ts:154`. |
| G309 | `suggestion_request_started` | C | `useInputAssistance.ts:161`. |
| G310 | `suggestion_request_completed` | C | `useInputAssistance.ts:250`. |
| G311 | `suggestion_rendered` | C | Emitted from `components/SmartInput.tsx:179#emitSuggestionsRendered(telemetryField, suggestions)`, in an effect keyed by the id-SIGNATURE of the rendered list so a re-render of the same rows does not inflate the count and a genuinely new list does. Shaped by `services/inputTelemetry.ts:169#export function emitSuggestionsRendered`, which carries `count` and sorted TYPE names and deliberately no labels — a rendered recipient list is a list of people. This is §57's missing denominator. Proven by driving the REAL `SmartInput` in `components/__tests__/inputTelemetryFunnel.component.test.tsx` (NEW FILE — a `*.component.test.tsx`, which the standalone package's jest run discovers by `testPathPattern`, so no curated registration list had to be edited): one impression per list, none for an empty result set, and no label in the payload. MUTATION: deleting the call turns three assertions RED. |
| G312 | `suggestion_selected` | C | `SmartInput.tsx:104-110`. |
| G313 | `suggestion_dismissed` | C | §45's IGNORED arm now has a call site. `components/SmartInput.tsx:131#const shownRef` holds what is currently in front of the user and a companion `acceptedRef` holds whether they took any of it; when a shown list goes away untaken — blur, Escape (`components/SmartInput.tsx:258#emitSuggestionsDismissed(telemetryField, shownRef.current.count, 'escape')`) or an emptied field — `components/SmartInput.tsx:170#emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur')` records it with the size of what was passed over. The complement matters as much as the event: a list whose suggestion WAS taken is never also counted as ignored, or the loop would learn nothing from either arm. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`. MUTATION: setting `acceptedRef.current = true` in the render effect turns it RED. |
| G314 | `raw_search_submitted` | C | Both paths emit. Tapping a `submit_search` row: `components/SmartInput.tsx:211#emitRawSearchSubmitted(telemetryField, (s.replacementText ?? value ?? '').length, true)`. Pressing return on the typed text without resolving anything: `components/SmartInput.tsx:309#emitRawSearchSubmitted(telemetryField, value.trim().length, false)`, on a new `onSubmitEditing` that still forwards the caller's own handler. `viaSuggestion` distinguishes them, and only a LENGTH travels. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx` for both paths. |
| G315 | `manual_value_kept` | C | §45's EDITED arm. `components/SmartInput.tsx:300#emitManualValueKept(telemetryField, value.trim().length)` fires on blur when assistance WAS shown, nothing was accepted, and the field still holds the user's own text. It carries a LENGTH and never the text, so it is emittable on a caption or a private message whose policy forbids raw capture — asserted directly, not assumed. This is §57's manual-fallback numerator. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`, including the negative: accepting a suggestion is not a manual keep. MUTATION: dropping the `!acceptedRef.current` guard turns it RED. |
| G316 | `validation_shown` | C | Emitted alongside the impression whenever the rendered list contains a `validation` row: `components/SmartInput.tsx:181#if (validations > 0) emitValidationShown(telemetryField, validations)`, shaped by `services/inputTelemetry.ts:187#export function emitValidationShown`. §23's validations have been produced and rendered since Phase 5; nothing recorded that they were ever SEEN, so a user who ignored a warning was indistinguishable from one who never got it. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`, with the negative case (an empty list emits neither event). |
| G317 | `correction_accepted` | C | `components/SmartInput.tsx:208#if (s.type === 'correction') emitCorrectionAccepted(telemetryField, s)`, carrying the correction's CONFIDENCE (`services/inputTelemetry.ts:221#export function emitCorrectionAccepted`) — which is now a real measured quantity rather than a nominal one, because §10 typo tolerance computes it (G63). Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx` by pressing a real correction row through `SmartInput`. |
| G318 | `disambiguation_selected` | C | `components/SmartInput.tsx:209#if (s.type === 'disambiguation') emitDisambiguationSelected(telemetryField, s)`, carrying `entityType` and confidence (`services/inputTelemetry.ts:233#export function emitDisambiguationSelected`). It is not redundant with `suggestion_selected`: §57 asks for a wrong-selection reversal rate and a duplicate-prevention count, and both need to know WHICH KIND of row resolved the field. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`. |
| G319 | `action_completed` | **N** | The emitter now exists — `services/inputTelemetry.ts:253#export function emitActionCompleted` — and is deliberately NOT called from `SmartInput`: selecting an action row OPENS a propose-only picker, and calling the event "completed" at that moment would make every abandoned picker look like a success. The only place that knows is the screen that dispatches the action, and `search/smartActions.ts:35-43`'s single dispatchable type (`add_to_trip`) is dispatched by a screen outside this lane's paths. WHAT WOULD TURN THIS RED: the global-search screen calling `emitActionCompleted` after the trip picker CONFIRMS. Who can supply it: the owner of the global-search tab screen. |
| G320 | `downstream_task_completed` | **N** | The emitter now exists — `services/inputTelemetry.ts:266#export function emitDownstreamTaskCompleted` — and has no caller, because this layer cannot observe the thing: the input field is long gone by the time a trip is saved, an event is created or a message is sent. This is the outcome signal §45's whole loop is built on (G5/G14/G322/G323 all depend on it). WHAT WOULD TURN THIS RED: one call per completed task from the screens that complete them — `app/trip/new.tsx`, `app/events/create/index.tsx`, `app/telegraph/new.tsx` — none of which is this lane's file. |
| G321 | For private-message fields, prefer metadata events over raw message text | C | `policyRegistry.ts:51-54` `METADATA_ONLY_TELEMETRY` on `telegraph_message`; `logRawText: false` on every policy (`:40`); `services/inputTelemetry.ts:48-62` enforces the scrub client-side. Certified at `test/inputAssistanceCertification.test.ts:443-476`. |

**Five of fourteen named events fire.** The nine that do not are the entire
outcome half of the taxonomy.

### §45 Learning Loop

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G322 | Suggestion shown → selected/ignored/edited → did the downstream task succeed → rank calibration | W | **Three of the four arms now exist.** "Shown" is `suggestion_rendered` (G311), "ignored" is `suggestion_dismissed` (G313) and "edited" is `manual_value_kept` (G315), all three emitted from real `SmartInput` call sites and mutation-proven. What is still missing is the half the loop is actually FOR: **"downstream success"** (`downstream_task_completed`, G320) has an exported emitter and no caller, because this layer cannot observe it — the input field is long gone by the time a trip is saved — and **there is still no calibration step**: `applyPriorSelectionBoost` remains a fixed formula over a raw count, not a model fitted to outcomes. WHAT WOULD TURN THIS RED: a feature screen calling `services/inputTelemetry.ts:266#export function emitDownstreamTaskCompleted` on a completed save/create/send, plus a ranking term that reads the resulting shown/ignored/completed ratios. The first needs the Trips / Events / Telegraph screen owners; the second needs somewhere for the events to LAND, which is G263. |
| G323 | Optimize for successful resolution / task completion / appropriate action / real-world outcome; **do not optimize merely for suggestion acceptance rate** | W | Unchanged: `personalization.ts:220-228` scales `MAX_BOOST` by `selection_count` and nothing else moves rank, so the named anti-pattern is still the whole learning signal. The ignored/edited arms are now emitted (G313/G315) but no ranking term reads them. WHAT WOULD TURN THIS RED: a rank term whose input is an OUTCOME rather than an acceptance — and, before that, a telemetry destination (G263) plus a `downstream_task_completed` caller (G320). |

### §46 Accessibility

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G324 | Screen readers announce field purpose, suggestion count, active suggestion **and selection result** | W | Purpose: `SmartInput.tsx:165` `accessibilityLabel`. Count: `SuggestionOverlay.tsx:78-90`, a polite live region carrying "N suggestions"/"Loading suggestions". Active row: `EntitySuggestionRow.tsx:51` `accessibilityState={{selected}}`. **Selection result is never announced** — `handleSelect` (`SmartInput.tsx:101-127`) emits telemetry, applies the text and closes the overlay with no announcement, so a screen-reader user hears the list disappear and nothing else. |
| G325 | Arrow-key and keyboard navigation on web/desktop | C | `SmartInput.tsx:129-148` — ArrowDown/ArrowUp wrap the active index, Enter selects, Escape clears and blurs. |
| G326 | VoiceOver/TalkBack focus management on mobile | **N** | Verdict stands; **the stated evidence is now partly false and is corrected here.** The row read *"No `AccessibilityInfo`, `setAccessibilityFocus` or `accessibilityElementsHidden` anywhere under `platform/input-assistance/`"*. Both DO now appear: `components/SmartInput.tsx:26#AccessibilityInfo` (imported, and `announceForAccessibility` called on selection — §9's G324 build) and `components/EntitySuggestionRow.tsx:82#accessibilityElementsHidden` on the non-colour active marker. What remains exactly true is the verdict's own sentence: **`setAccessibilityFocus` appears nowhere**, so focus is still never MOVED into the overlay when it opens or back to the field when it closes. WHAT WOULD TURN THIS RED: `AccessibilityInfo.setAccessibilityFocus(findNodeHandle(...))` on overlay open/close plus a component test asserting the handle it was given — both inside this lane's paths, and not built this pass. |
| G327 | No suggestion overlay trapped behind the software keyboard | **?** | Code-side there is no mechanism: no `KeyboardAvoidingView`, no `Keyboard` height listener, no safe-area inset, and the overlay renders *below* the field (`SmartInput.tsx:184-197`) — the position a keyboard occupies. `keyboardShouldPersistTaps="handled"` (`SuggestionOverlay.tsx:100`) solves tap-through, not occlusion. Whether any real screen actually occludes it depends on where the field sits on that screen at runtime; that cannot be settled from the tree. |
| G328 | Dynamic type and large text support | **?** | Nothing sets `allowFontScaling={false}`, so React Native's default scaling applies and text does grow. Whether the layout survives it is a device question: the overlay's height cap is a fixed `maxHeight = 320` (`SuggestionOverlay.tsx:61`) that does not scale, and rows use `numberOfLines={1}` (`EntitySuggestionRow.tsx:60`), so at large type a label truncates rather than wraps. Needs a device to settle. |
| G329 | High contrast and non-color-only state indicators | W | The keyboard-active row's only visual difference is a background colour: `EntitySuggestionRow.tsx:97-99` `rowActive: { backgroundColor: color.haze }` — no border, weight, icon or marker change. `accessibilityState.selected` serves assistive tech but not a sighted low-vision or colour-blind user, which is exactly the case this bullet names. |
| G330 | Reduced-motion support | C ⌀ | There is no animation in the layer at all: no `Animated`, `LayoutAnimation`, `Reanimated` or CSS transition under `platform/input-assistance/`. Nothing to reduce. Vacuous, but satisfied. |
| G331 | Clear loading / error / empty states | C | `SuggestionOverlay.tsx:71-77` (status string covering all four), `:88-95` (spinner + "Finding suggestions…"), the `unavailable` note, and the `emptyState` slot. |
| G332 | Undo or edit path after replacement | C | Replacement writes through the caller's `onChangeText` into an editable `TextInput` (`SmartInput.tsx:115-117`), so the edit path is intact. There is no undo — the prior text is not retained — but the spec's "or" is satisfied. |

**No accessibility test exists anywhere in the layer.** All 24 test files under
`platform/input-assistance/**/__tests__/` were listed; none references
`accessibilityLabel`, `accessibilityRole` or any a11y assertion, and neither does
`features/wall/components/__tests__/WallHeader.smartInput.component.test.tsx`.

### §47 Security and Abuse Boundaries

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G333 | Do not expose internal IDs unless required by the client contract | C | `projection.ts:82-88` copies only the whitelist; owner ids, host ids, submitter ids and counts are dropped. The ids that do travel (`entityId`, `destination.route`) are the contract's own (§8/§43). |
| G334 | Rate-limit high-volume prefix enumeration where it can reveal private entity existence | C | `routes/inputAssistance.ts:147` (90/min per user) plus the structural defence: the one enumerable private surface, recipient search, is graph-scoped so prefix typing cannot probe for a stranger's existence at any rate. |
| G335 | Protect recipient/user search from account-enumeration abuse | C | `socialIdentity.ts:56-116` — the candidate pool **is** the viewer's own follows/friends/thread-partners/trip-crew, and any read error returns `null` ⇒ no recipients. The header names this as the security property of the file. |
| G336 | Apply authentication and viewer scope before private entity lookup | C | `routes/inputAssistance.ts:107-109` `requireUser` before anything; the user id used downstream is session-derived, never a body parameter (`:181`, `:295`). |
| G337 | Sanitize pasted URLs and untrusted text before rendering | **N** | `sanitizeQuery` (`gateway.ts:163`) is a PostgREST-filter guard that strips only `(),` (`discoverySearch.ts:151-153#sanitizeQuery`) — not a URL sanitizer. No URL parsing, scheme allowlisting or link sanitization exists in the layer, because no paste path exists (§24). Untrusted *AI* text is sanitized (G339); untrusted pasted text is not, because it never arrives. |
| G338 | AI-assisted paths must not bypass validation, moderation or authorization | C | `aiWriting.ts:162-180` `sanitizeSuggestedText` runs the same private-location + policy scanners user-authored text passes and **drops** a failing variant (`:331`) rather than surfacing it; the flag gate is fail-closed (`:80-90`); publish-time validation is untouched because the suggestion re-enters the ordinary create path. |
| G339 | All action suggestions use the same authorization gate as the target action itself | C | Structural: the gateway only ever *proposes* a `SuggestionAction` (`types.ts:191-198`); nothing in `lib/inputAssistance/` executes one, so `add_to_trip` still goes through the trip endpoint's own auth (`semanticIntent.ts:273-276` states it). |

### §48 Versioning and Compatibility

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G340 | Version the field-policy registry independently from app releases | W | `POLICY_VERSION = 'input-2026-08'` exists (`policyRegistry.ts:36`) and travels on every response. But **there is no policy endpoint**, and the client re-declares all 29 contexts locally (`contexts/inputContexts.ts`, 476 lines), so a server-side policy change cannot reach a shipped client. `test/inputPolicyContractParity.test.ts:10-17` records the measured consequence: `minChars` differed on **20 of 29** contexts, `offlinePolicy` on **26 of 29**, `allowPersonalization` on **14 of 29** before that commit pinned the last one. |
| G341 | Version the suggestion response schema | W | The response carries `policyVersion` only (`routes/inputAssistance.ts:180`). There is no independent schema version, so a policy bump and a shape bump are indistinguishable to a client. |
| G342 | Preserve backward compatibility for active mobile versions | C ⌀ | Every field added after Phase 1 is optional and additive (`types.ts:281-303`, `:206-244`), so an older client still parses a newer response. Nothing enforces this — no contract test pins the response shape — so it is a property of how the code happened to grow. |
| G343 | Feature-capability handshake for suggestion types unsupported by older clients | **N** | No handshake in either direction: the request carries no client capability list and the response carries no capability declaration. What exists instead is silent client-side dropping (`search/smartActions.ts:41-43`, the grouped-row bridge), which is graceful degradation, not negotiation — the server keeps spending work on rows it will never see used. |
| G344 | Allow server-side policy updates without a client release where safe | W | Defeated by the same client mirror as G340. The parity test asserts only the privacy-load-bearing field and deliberately leaves `minChars`/`offlinePolicy` drifting, calling it "real §48 debt". |
| G345 | Never change canonical entity semantics through ranking-only configuration | C | Structurally impossible: ranking lives entirely in `confidence` and `TYPE_RANK` (`projection.ts:309-343`) and cannot touch `entityId`/`entityType`; the two boosts are clamped below the exact-match band (`personalization.ts:67`, `liveSuggestions.ts:86`) and `BOOSTABLE_TYPES`/`SURFACEABLE_GEO_TYPES` (`personalization.ts:70`, `:83`) bound what memory may lift — both mutation-proven in `test/inputAssistanceInvariants.test.ts`. |

### §49 Testing and Certification Matrix

Scored as *certification* requirements: does a test family exist that certifies
this area? (The underlying behaviours are scored in their own sections.)

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G346 | Correctness — exact / prefix / typo / alias / transliteration / ambiguous entity / duplicate suppression | C | `test/inputAssistanceGeoCore.test.ts` (14), `…GlobalSearch` (8), `…Creation` (33), client `geographic/__tests__/geoNormalization.test.ts`. Transliteration is thin because the feature is (G61). |
| G347 | Race safety — rapid typing / cancellation / out-of-order / stale cache | C | `services/__tests__/raceAndCache.test.ts` over the shared `raceGuard`/`SuggestionCache`, plus the wiring in `useInputAssistance.ts:157-179`. |
| G348 | Routing — every suggestion opens the right entity/action; missing destination handled | C | `projection.ts:391-407` + the "no dead rows net" assertion in `test/inputAssistanceGlobalSearch.test.ts` and the §8 projection contract test in `…Gateway`. |
| G349 | Privacy — blocked suppression / private Trip·Event exclusion / private-metadata exclusion / precise-location leakage | C | `test/inputAssistanceCertification.test.ts:240-366` — the adversarial coordinate deep-scan and the gateway-level private-event/private-trip cases, both mutation-verified per the certification's own gap table. |
| G350 | Offline — static dictionary / cache / no fake live labels / raw-query fallback | W | Two of four are certified: the SWR cache (`raceAndCache.test.ts`) and no-fake-live (`freshnessDisplay.test.ts` + `test/inputAssistanceLiveIntelligence.test.ts`, both mutation-proofed). The **static dictionary** and **offline raw-query fallback** are not tested and cannot be — neither exists (G197, G241). |
| G351 | Accessibility — keyboard / screen reader / focus / dynamic type / reduced motion | **N** | **Zero accessibility tests exist** in the layer or around its consumers. Two of the five named dimensions (focus management, and the selection-result announcement half of screen reader) are code-answerable failures, not device questions (G324, G326). |
| G352 | Failure — provider timeout / API error / empty result / partial degradation | C | `test/inputAssistanceCertification.test.ts:369-436`: partial degradation `:370-388`, total data-layer failure → empty 200 `:390-409`, empty result `:427-434`. Provider timeout is untestable because there is no provider (G222). **Note the documented exception**: `:411-425` asserts that an unreadable `profiles` returns **503 `degraded_unavailable`, not a 200** — the ban gate outranks the never-error rule. The certification's flat claim "(never a 500 mid-keystroke)" is now qualified by a deliberate non-200. |
| G353 | AI — no silent insertion / no canonical-fact invention / correct opt-in and provenance | C | `test/inputAssistanceCompassAI.test.ts` (15) — opt-in mutation-proofed OFF, `source:'ai'` provenance, `replace_text` only, last-place ordering, coarse context, `sanitizeSuggestedText`. |
| G354 | Performance — P50/P95 latency / cold start / render cost / large index behaviour | **?** | No latency, cold-start, render-cost or large-index test or harness exists. The required certification is a measurement against a running server and device; it cannot be satisfied or refuted from this tree. |
| G355 | Telemetry — no prohibited raw private-text capture; **action/result linkage works** | W | The prohibition half is certified and mutation-proven (`test/inputAssistanceCertification.test.ts:443-476`; client `services/__tests__/inputTelemetry.test.ts`), and now also for the seven new arms. The **linkage** half is still not built: `requestId` is generated per request (`routes/inputAssistance.ts:166`) and no event carries it back, so an impression still cannot be joined to the selection that followed it, and `action_completed` / `downstream_task_completed` still have no callers (G319/G320). WHAT WOULD TURN THIS RED: putting the response's `requestId` into the client's telemetry field and emitting it on every event — which needs `routes/inputAssistance.ts` (not this lane's file) to keep returning it, the client hook to thread it, and a sink to join them in (G263). |

### §50 Required Audit Before Adoption

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G356 | Inventory every current text field and classify it | **N** | Three source files cite "the client audit's §50 field table" as an existing artifact (`social/socialFields.ts:25`, `search/searchFields.ts:19`, `creation/creationFields.ts:27`) and **it is not in the repository** — a repo-wide search for `§50`, a field table, or the fifteen recorded attributes returns only those three references to it. |
| G357 | Record, per field: screen/route, component file, fieldId, InputContext, current implementation, desired mode, entity types, provider/API, zero-state, offline, privacy class, validation, bugs, migration status | **N** | No such record exists in any form. |
| G358 | Do not assume a field is migrated because it renders SmartInput; verify routing, source, policy and outcome end-to-end | C | This one is genuinely built, and as a **ratchet**: `services/__tests__/selectionWriterCoverage.test.ts` scans the real source for gateway consumers outside the SDK and requires each to reference a recorder or carry a named exemption with its reason. Its header describes exactly the failure this bullet warns about — `GlobalPlacePicker` consumed the gateway, rendered correctly, and recorded nothing. |

### §52 Feature-Team Adoption Rule

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G359 | Do not build a new autocomplete / predictive-text / recents / typeahead / dropdown / AI-writing helper / input resolver inside a feature until the platform has been evaluated | W | Four pre-existing engines remain unmigrated and live (G6), and one **new** duplicate was added inside the platform itself: `compass/compassPrompt.ts` re-implements the Compass starter set client-side under the same name as the server's `buildCompassStarters` (`projection.ts:258`), and `app/(tabs)/ai.tsx:399` calls the client one. No ratchet exists to detect the next one. |
| G360 | New fields are added by registering a policy and consuming shared primitives | C | `contexts/fieldRegistry.ts:26-33` `registerField`, with five idempotent registrars (`geoFields.ts:64`, `socialFields.ts:57`, `searchFields.ts:42`, `creationFields.ts:57`, `compassFields.ts:63-66`) and one screen-level registration (`WallHeader.tsx:29`). Overrides are explicit and auditable (`socialFields.ts:40-44`). |

### §53–§56 Worked Examples (end-to-end)

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G361 | §53 Trip Destination: 0-char defaults → local prefix cache → server canonical resolver → choose → store city_id+country+timezone → prefetch → next fields inherit | W | Four of seven steps work: 0-char defaults (`geoResolver.ts:180-257`), the canonical resolver (`:120-145`), the stored binding (`:70-81`), and the field wiring (`components/selectors/GlobalPlacePicker.tsx` → `app/trip/new.tsx`). **Local prefix cache does not exist** (G204/G214), **prefetch does not exist** (G209), and "next fields inherit Bangkok context" is only the exact-`cityId` reorder of G107. |
| G362 | §54 Telegraph Message: type "meet at" → action candidates (share meeting point / Trip stop / current Place) → eligibility → tap → structured entity share inserted | **N** | The context has a policy (`policyRegistry.ts:267-274`) and **no registered field**, `share_entity` has **no producer** (G303), and no Telegraph composer imports the platform. Only the *recipient picker* half of Telegraph is wired (`app/telegraph/new.tsx` via `hooks/useTelegraphRecipients.ts`), which is §14/§54's other half. |
| G363 | §55 Hidden Gem Creation: name/location → entity + duplicate search → existing candidates → sensitive-location policy → exact/approximate/pin → confirm → canonical reference | C | Wired end-to-end: `app/gems/submit.tsx:242-244` registers `hidden_gem_name` through `hooks/useCreationAssistance.ts` and renders `CreationAssist` at `app/gems/submit.tsx:274#CreationAssist`; the backend chain is `duplicateDetection.ts:241-370` → `creation.ts:258-296` (constraint filter) → `projectDuplicate:191-215` (`resolve_existing`), with the sensitive-location rule at `discoverySearch.ts:1443#sensitivity_level,` and the pin fallback at `validationSuite.ts:305-315`. |
| G364 | §56 Compass Prompt: type "where should" → suggested prompts → current surface + Trip context attached as structured refs → submit → Compass receives intent + permitted entities | C | `app/(tabs)/ai.tsx:60`, `:398-410` wires `compass_prompt` through `useAiWritingAssist` and renders `CompassStarters` + `AiWritingAssist`; the structured refs are attached at `projection.ts:283-303` and `semanticIntent.ts:231-268` (`open_compass` carrying the parse). |

### §57 Product Success Metrics

None of the nine is instrumented. There is no metric emitter, no analytics
transport (G306), and no store any of these could be computed from.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G365 | Time to valid selection | **N** | `input_opened`, `suggestion_rendered` and `suggestion_selected` now all fire from real call sites, so the two ENDPOINTS of this measurement exist as events. It is still not a metric: nothing correlates them into a session (each event carries only `at`), and the sink is a no-op so no pair ever meets (G263). WHAT WOULD TURN THIS RED: a session id on the event envelope plus a sink that retains it. |
| G366 | Valid entity resolution rate | **N** | The denominator's EVENT now exists — `suggestion_rendered` has a call site (G311) — which is a correction to this row's stated evidence, not to its verdict. The rate is still not computed and still not recorded anywhere: the sink is `() => {}`, so neither numerator nor denominator survives the function call. WHAT WOULD TURN THIS RED: a telemetry destination (G263) plus a query over impressions vs entity selections. |
| G367 | Manual fallback rate | **N** | Both events now fire — `manual_value_kept` from `components/SmartInput.tsx:300#emitManualValueKept(telemetryField, value.trim().length)` and `raw_search_submitted` from two call sites (G314/G315) — which corrects this row's stated evidence. The RATE is still not computed and the events reach a no-op sink. WHAT WOULD TURN THIS RED: see G263. |
| G368 | Wrong-selection reversal rate | **N** | No reversal signal exists in the taxonomy or the code. |
| G369 | Duplicate creation prevented | **N** | The duplicate rows are produced (G148, G234) and their acceptance is never recorded — `/select` is the only write and it records no duplicate-resolution outcome. |
| G370 | Downstream task completion | **N** | `downstream_task_completed` still never fires; the emitter exists and no screen calls it (G320). WHAT WOULD TURN THIS RED: one call per completed task from the Trips / Events / Telegraph screens, plus a destination for it. |
| G371 | Privacy incident count must remain zero (explicit certification metric) | **?** | The construction-side guarantees are strong and tested (G183–G191). Whether zero privacy incidents have occurred in production is a fact about production traffic, and there is no incident counter, alert or log in this layer to answer it from. |
| G372 | P95 suggestion latency | **N** | No latency instrumentation anywhere; the response carries no server timing. |
| G373 | Offline completion rate | **N** | No offline instrumentation, and (G197–G201) little offline behaviour to measure. |

---

## 5. Where the gaps actually are

Split the denominator by whether a section was inside the ten migration phases
§51 names, or outside them:

> **SUPERSEDED — both tables in this section were computed against the ORIGINAL
> `230 / 69 / 70 / 4` headline and have not been recomputed since.** Three passes
> (§8, §9, §11) have moved 32 rows between buckets. The SHAPE this section
> describes still holds — it is the reason §11 chose the sections it did — but no
> individual cell below should be quoted as current. WHAT WOULD TURN THIS RED:
> re-deriving all 373 row→section attributions and recounting. That is a
> mechanical job; this pass did not do it rather than half-do it.

| Slice | Denominator | C | W | N | ? | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sections **a §51 phase scoped** (§1–§23, §26, §27, §29, §31, §33, §35, §37–§43, §47, §49, §52–§56) | 280 | 200 | 54 | 25 | 1 | **90.7 %** | **71.4 %** |
| Sections **no phase ever scoped** (§24 Paste, §25 Voice, §28 Preview anatomy, §30 Precedence, §32 Offline, §34 Local-vs-server, §36 Anti-spam, §44 Telemetry, §45 Learning, §46 Accessibility, §48 Versioning, §50 Audit, §57 Metrics) | 93 | 30 | 15 | 45 | 3 | **48.4 %** | **32.3 %** |

That is the shape of this programme in one table. Where §51 drew a phase, the
work is unusually good — mutation-proven invariants, fail-closed gates,
structural impossibilities rather than checks. Where §51 drew no phase, the
section is largely absent, and **§51 never drew a phase for Paste, Voice, Offline,
Telemetry, Learning, Accessibility, Versioning or the §50 audit.** The plan the
tree followed was the plan in the spec; the plan omitted a quarter of the spec.

Per-section detail:

| § | Reqs | C | W | N | ? |
| --- | --- | --- | --- | --- | --- |
| §1 | 5 | 4 | 1 | 0 | 0 |
| §2 | 10 | 7 | 3 | 0 | 0 |
| §3 | 1 | 0 | 1 | 0 | 0 |
| §4 | 1 | 1 | 0 | 0 | 0 |
| §5 | 2 | 1 | 1 | 0 | 0 |
| §6 | 22 | 17 | 1 | 4 | 0 |
| §7 | 10 | 9 | 0 | 1 | 0 |
| §8 | 1 | 1 | 0 | 0 | 0 |
| §9 | 2 | 1 | 1 | 0 | 0 |
| §10 | 10 | 6 | 3 | 1 | 0 |
| §11 | 9 | 6 | 3 | 0 | 0 |
| §12 | 7 | 6 | 1 | 0 | 0 |
| §13 | 4 | 3 | 1 | 0 | 0 |
| §14 | 6 | 2 | 3 | 1 | 0 |
| §15 | 16 | 8 | 4 | 4 | 0 |
| §16 | 2 | 1 | 1 | 0 | 0 |
| §17 | 2 | 1 | 1 | 0 | 0 |
| §18 | 6 | 4 | 2 | 0 | 0 |
| §19 | 5 | 5 | 0 | 0 | 0 |
| §20 | 10 | 5 | 3 | 2 | 0 |
| §21 | 6 | 2 | 2 | 2 | 0 |
| §22 | 9 | 7 | 0 | 2 | 0 |
| §23 | 7 | 5 | 1 | 1 | 0 |
| §24 | 9 | 0 | 0 | 9 | 0 |
| §25 | 1 | 0 | 0 | 1 | 0 |
| §26 | 2 | 2 | 0 | 0 | 0 |
| §27 | 8 | 6 | 2 | 0 | 0 |
| §28 | 9 | 4 | 1 | 4 | 0 |
| §29 | 9 | 8 | 1 | 0 | 0 |
| §30 | 2 | 1 | 0 | 1 | 0 |
| §31 | 3 | 3 | 0 | 0 | 0 |
| §32 | 7 | 2 | 2 | 3 | 0 |
| §33 | 8 | 4 | 3 | 1 | 0 |
| §34 | 13 | 7 | 4 | 2 | 0 |
| §35 | 6 | 3 | 2 | 1 | 0 |
| §36 | 7 | 3 | 1 | 3 | 0 |
| §37 | 3 | 2 | 1 | 0 | 0 |
| §38 | 2 | 1 | 1 | 0 | 0 |
| §39 | 28 | 25 | 3 | 0 | 0 |
| §40 | 22 | 18 | 3 | 1 | 0 |
| §41 | 3 | 3 | 0 | 0 | 0 |
| §42 | 1 | 1 | 0 | 0 | 0 |
| §43 | 9 | 7 | 1 | 1 | 0 |
| §44 | 16 | 6 | 1 | 9 | 0 |
| §45 | 2 | 0 | 1 | 1 | 0 |
| §46 | 9 | 4 | 2 | 1 | 2 |
| §47 | 7 | 6 | 0 | 1 | 0 |
| §48 | 6 | 2 | 3 | 1 | 0 |
| §49 | 10 | 6 | 2 | 1 | 1 |
| §50 | 3 | 1 | 0 | 2 | 0 |
| §52 | 2 | 1 | 1 | 0 | 0 |
| §53-56 | 4 | 2 | 1 | 1 | 0 |
| §57 | 9 | 0 | 0 | 8 | 1 |

---

## 6. What could not be verified, and why

Only **four** requirements are CANNOT-VERIFY. None is folded into either side.

| id | Requirement | Why the tree cannot settle it | What would settle it |
| --- | --- | --- | --- |
| G327 | §46 — no suggestion overlay trapped behind the software keyboard | The layer contains no keyboard-avoidance mechanism at all (no `KeyboardAvoidingView`, no `Keyboard` height listener, no safe-area inset) and the overlay renders below the field. But whether it is *actually* occluded depends on where each consuming screen puts the field and how tall the keyboard is on that device. | Opening each of the ~10 wired fields on a real iOS and Android device with the keyboard up. |
| G328 | §46 — Dynamic Type and large text support | RN's default scaling is not disabled, so text does grow; whether the layout survives is a rendering fact. The fixed `maxHeight: 320` (`SuggestionOverlay.tsx:61`) does not scale and rows are `numberOfLines={1}`, so the failure mode would be truncation, not overflow — which is only visible on a device. | A device run at the largest accessibility text size. |
| G354 | §49 — Performance certification (P50/P95 latency, cold start, render cost, large index) | The required certification *is* a measurement against a running server and device. No harness, benchmark or timing assertion exists in the tree to satisfy or refute it. | A load run against a deployed instance plus a device render profile. |
| G371 | §57 — Privacy incident count must remain zero | The construction-side guarantees are strong and mutation-proven (G183–G191), but whether an incident has occurred in production is a fact about production traffic, and this layer emits no incident counter, alert or log. | Production security/audit logs. |

**Sixteen further rows carry a `☠prod` marker: the code question is settled and
the effect is not.** They are *not* CANNOT-VERIFY, and they are not moved out of their buckets — but a
reader should not count them as working software:

| Verdicts | What is unresolved | What would settle it |
| --- | --- | --- |
| G5, G45, G75, G100, G189, G213, G223, G225, G226, G227, G230, G286 (☠prod) | `input_selection_history` and the `input_record_selection` RPC are absent from production (`scripts/checkProductionDrift.ts:172`), so all of §35 fails soft to an empty memory there | applying migration 2258, or removing the feature |
| G57 | migration 2220 is not applied to production, so the stored `search_key` column does not exist and "Đà Nẵng" is stored under the broken key `"a nang"` | applying migration 2220 |
| G138 (and all of §22) | `compass_ai_writing_enabled` (2221) is absent from production and `isFlagEnabled` is fail-closed, so no AI writing has ever run | seeding the flag, deliberately |
| G194, G221, G287 | every `intel_*` table in production holds zero rows (`docs/architecture/intel-spine-liveness.md`), so the live lane has never attached a label | any production observation |
| G306 and all of §44 | the telemetry sink is `() => {}` and `setTelemetrySink` is called from no non-test file | attaching a transport |
| G236, G242, G330, G342 (⌀) | the guard is real and the path it guards is empty — no provider to fail, no animation to reduce, no client old enough to break | a provider integration; an animation; a second client version |

---

## 7. Reconciliation with `input-intelligence-certification.md`

The certification was written against a spec that was not in the repository. It
is now. This section tests it clause by clause.

### 7.1 What it got right

Not a small list, and it should be said first.

- **Its ten §49 dimensions are the real §49 dimensions**, in the spec's order,
  with the spec's own sub-items. Whoever wrote it had the document.
- **Its §2 / §29 / §47 spot-check table is accurate.** Every one of the seven
  principles it lists is a real spec clause and every "where enforced" citation
  I followed was correct: `TYPE_RANK`, `buildFreshnessState` returning null,
  the fail-closed block gate, `InputSuggestion` having no coordinate field,
  `buildPermittedWritingContext`, `sanitizeQuery`, propose-only actions. Those
  are G8, G12, G183, G187, G191, G339 here and I reached the same verdicts
  independently.
- **The five gaps it closed were real gaps, and the closures are real.** I read
  `test/inputAssistanceCertification.test.ts` in full: the adversarial coordinate
  deep-scan (`:265-327`), the gateway-level private-event/private-trip cases
  (`:330-366`), the partial/total/empty failure cases (`:370-434`) and the
  private-text `/select` cases (`:443-476`) all do what it says, and its stated
  mutation proofs are consistent with the code.
- **It named its own runtime exclusions instead of quietly banking them**, and —
  the Passport test — **all six are genuine spec requirements**, not inventions.

### 7.2 The count you asked for

The Passport census found six of seven "Runtime QA" items were not requirements
in the spec at all. Here the answer is the reverse:

| Certification's runtime/QA item | Is it a spec requirement? | Where |
| --- | --- | --- |
| Accessibility on device | **Yes** | §46 (nine bullets) + §49 row "Accessibility" |
| Performance under load | **Yes** | §49 row "Performance"; §57 "P95 suggestion latency" |
| Offline on device | **Yes** | §32 (seven data classes) + §49 row "Offline" |
| Provider failure once `external_places_enabled` is on | **Yes** | §49 row "Failure — provider timeout"; §38 rung 3 |
| §44 outcome funnel | **Yes** | §44 (fourteen events) + §49 "action/result linkage works" |
| Privacy incident count = 0 | **Yes** | §57 final row, named there as an "explicit certification metric" |

**6 of 6.** The cannot-verify bucket is *not* inflated with non-requirements the
way Passport's was.

### 7.3 But it is misclassified, and that matters more

Four of those six have a **code-answerable construction gap underneath them**
that the runtime framing conceals. In each case the certification's own wording
asserts a foundation that is not there.

| Item | Certification says | What the code says |
| --- | --- | --- |
| Accessibility | "**Foundation present** + runtime QA"; lists the device-only parts as the outstanding work | Three of §46's nine bullets fail *in code*, not on a device: **focus management does not exist** (no `AccessibilityInfo`/`setAccessibilityFocus` anywhere in the layer — G326), **the selection result is never announced** (G324), and the active-row indicator is **colour-only** (G329). And there is **no accessibility test of any kind** in the layer's 24 test files (G351) — so "foundation present" is asserted, never demonstrated. |
| Offline | "PASS (construction) + runtime QA"; "*Static dictionary / cached-local / raw-query fallback* are declared per field in `policyRegistry.ts` (`offlinePolicy`)" | **`offlinePolicy` is read by nothing** (G30). Declaring a policy is not constructing a behaviour. Five of §32's seven rows have no local substrate at all: no client static dictionary (G197), no local city index (G198), no persisted recents (G199), no saved/Trip cache (G200), no place cache (G201). The offline "PASS (construction)" rests on a field with no consumer. |
| §44 funnel | "a later analytics-infra item, not a construction gap — **the taxonomy + sink are wired**, the transport is deferred" | The taxonomy is declared and **nine of its fourteen events are never emitted from any call site** (G311, G313–G320) — including every event the funnel needs: `suggestion_rendered`, `suggestion_dismissed`, `action_completed`, `downstream_task_completed`. The "sink" is `let sink = () => {}` (`services/inputTelemetry.ts:35-36`) and `setTelemetrySink` is called from **no non-test file**. Nine missing emitters is a construction gap by any definition. |
| Performance | "PASS (construction) + runtime QA"; cites cold start, `maxSuggestions` cap, `orderSuggestionsReserving`, debounce | Two §33 requirements fail in code: **the local 1-char tier does not exist** (every above-threshold keystroke that misses the exact-string cache is a network call — G204/G224), and **prefetch does not exist** (G209), which is also the step §53's worked example names. The cap is real; virtualization, which §33 asks for by name, is not (G211 — a plain `ScrollView`). |

Only **Provider failure** and **Privacy incident count** are runtime items with
nothing code-shaped hiding under them. So the honest count is: **6 of 6 are real
requirements; 4 of 6 are misclassified.** Different failure mode from Passport's,
same effect on a reader — the excluded bucket carries more weight than it earned.

### 7.4 "The audit found no actual defect" — this is the claim that fails

The certification's headline is: *"The audit found **no actual defect** — no
privacy leak, no fabricated-live path, no silent AI insertion, no raw-private-text
capture."* The narrow claim is true: I hunted the same four and found none.

The general claim is false, and the tree itself proves it. Commit `d4db6009`
(PR #430), **35 commits after** the certification's commit `a745ba11` on this
same branch, re-audited the same lane and found three things:

1. **A dead feature.** *"`input_selection_history` has exactly one writer in the
   product … That call site existed in exactly ONE component (`SmartInput`), which
   is mounted on exactly ONE surface (the Wall header pill). … Every Phase-8
   feature on every picker context (the learned "BKK"→Bangkok abbreviation mapping,
   §14 zero-character recents, the §15 PriorSelection boost) was reading a table
   nothing in the app could fill."* That is an entire §35/§14/§15 feature set
   silently inert — a read with no writer — sitting inside the surface area the
   certification enumerated (`personalization` is in its "Surfaces certified"
   list). The certification did not see it. `services/__tests__/selectionWriterCoverage.test.ts`
   now ratchets it.

2. **Eight guarantees the 168-test suite did not demonstrate.** *"22 declared
   invariants were mutation-probed against the existing 168-test suite. Fourteen
   went RED (genuinely load-bearing). **Eight stayed GREEN with the production code
   reverted** — the behaviour existed, was documented as a guarantee, and nothing
   demonstrated it."* The certification's evidence was that same 168-test suite
   ("Test totals after this pass: backend input-assistance = **168 tests, 0 fail**").
   Seven of the eight were closed by `test/inputAssistanceInvariants.test.ts` and
   include first-order safety properties: a deactivated account offered as a
   Telegraph recipient, a moderated hashtag returned as a canonical reference, a
   remembered **person** re-published as a city outside the privacy gate, a
   PostgREST filter payload surviving into emitted rows.

3. **A latent privacy defect in the client half.** *"`allowPersonalization`
   differed on 14 of 29 contexts. … the client believed `caption` and `comment`
   were personalization-enabled: any surface that wired the SDK's accept handler
   to one of those fields would have transmitted the user's raw caption/comment
   text to `/input-assistance/select`, where the server discards it — after it has
   already left the device and reached the request log. **The §49 Telemetry
   certification ("caption / comment / telegraph_message record NOTHING") was true
   of STORAGE and silent about transmission.**"* That is the certification's own
   §49 Telemetry row, quoted and qualified by a later audit of the same code.

None of the three needed a running app, a device or production traffic. All three
were findable by reading the tree the certification read.

### 7.5 A fourth, from this session

The certification's §49 Failure row claims the endpoint gives *"(b) total
data-layer failure → a well-formed empty 200 (never a 500 mid-keystroke)"*. The
test it added to prove it, `test/inputAssistanceCertification.test.ts`, was one of
five suites found this session to be **passing for the wrong reason**: its fake
errored the `profiles` table globally, and `requireUser`'s ban gate silently
absorbed the injected error, so the assertion was not measuring what it named.

The ban-gate work split that test deliberately (`:390-409` keeps the unchanged
data-layer guarantee; `:411-425` states the exception on purpose), and the
exception is now certified in the opposite direction: **an unreadable `profiles`
returns 503 `degraded_unavailable`, not a 200**, because a request whose ban check
did not run may not be served at all. I have scored that as the right outcome
(G352 remains C; the never-error rule is G352's subject and it now has a stated,
tested exception). But the certification's unqualified "never a 500 mid-keystroke"
is no longer the whole rule, and the test that proved it was not proving it.

### 7.6 Verdict on the certification

**It should not stand as written.** Specifically:

| Its claim | My verdict |
| --- | --- |
| "CERTIFIED for the code-verifiable dimensions" | **Overreach.** Its scope is §49's ten-row matrix in full plus a seven-row spot check touching §2, §29 and §47 — **four of the spec's 58 sections**, and 10 of this census's 373 requirements as scored (§49 = G346–G355). The remaining 363 requirements contain **69 BUILT-BUT-WRONG and 70 NOT-BUILT**. "The Input Intelligence platform is CERTIFIED" reads as a statement about the platform; it is a statement about its test matrix. |
| "The audit found no actual defect" | **False as a general claim** (7.4): a dead §35 feature, eight undemonstrated guarantees, and a latent raw-text transmission path, all found later, all findable then. True as the narrow claim about the four things it hunted. |
| "the safety-load-bearing dimensions … are now each locked by mutation-proven tests" | **True, and it is the document's best work.** I re-read those tests and they are load-bearing. |
| "The remaining items are honestly runtime/QA cert items, not defects" | **Half right** (7.2/7.3): all six are real spec requirements — unlike Passport's — but four of six have a code-answerable construction gap underneath. |
| "Recommendation: certify for launch on the code-verifiable dimensions" | **Not supportable at this denominator.** §24 Paste, §25 Voice, §30 Precedence and §50's field audit are wholly unbuilt; §32 Offline, §44 Telemetry, §45 Learning, §46 Accessibility and §48 Versioning are majority-unbuilt; and §35 personalization, §22 AI writing and §31 live freshness are correct code over storage or flags production does not have. |

### 7.7 What I would keep

The certification's method — take a matrix, cite proving code *and* a proving
test per row, close gaps with additive mutation-proven tests, and list what code
cannot answer — is the right method, and it is better than what most of this
repository has. Two changes would have made it hold up:

1. **State the denominator.** "Certified for §49" is defensible and checkable.
   "The platform is CERTIFIED" is neither.
2. **Do not let "runtime QA" absorb a missing emitter, an unread policy field or
   an absent focus call.** The test for that bucket is not "would a device help?"
   — it is "is there anything in the tree that could be wrong here?" For
   accessibility focus management, the offline substrate, nine telemetry emitters
   and the local performance tier, the answer was yes.

---

## 8. Phase 9 — the counting was wrong before the building was

Measured at `3eaf2436f` and built at `579694d6`. This section does two things in
this order, deliberately: it fixes what the tallier could not read, and only then
moves seven rows. The order matters because six of the seven moved rows were
NOT-BUILT for the same reason the counting was broken — something was declared,
computed or selected, and nothing read it.

### 8.1 The "prose gap" is not prose, and the "verdict-less rows" are not unjudged

`check:census-integrity` at `3eaf2436f` reported this census as:

```
input-intelligence  rows 350  C 207  W 69  N 70  X 4  denom 373
                    23 counted where this tool cannot read
                    [33 id-keyed row(s) carry no verdict — not verdict tables, not counted]
```

Both of those parentheses have been read, by hand, against the document. Neither
says what its wording suggests.

**The 23 are not counted in prose. They are 23 table rows whose verdict cell reads
`C ᵖ`.** `verdictOf` in `src/scripts/checkCensusIntegrity.ts:212#verdictOf` strips
`*` and `[⌀†‡]` before matching (`src/scripts/checkCensusIntegrity.ts:216#replace(/[⌀†‡]/g,`) and does not strip `ᵖ`,
so `C ᵖ` fails its `^([A-Z]{1,3}|\?)$` test and the row vanishes. §2 of this
document states the population itself — *"Result: 23 of the 230 correct verdicts
are `ᵖ`"* — and 373 − 350 = 23. The two sets are the same set. **This census counts
ZERO requirements in prose.** Every one of the 373 is on a row and always was.

**The 33 verdict-less rows decompose into three groups, none of them an unjudged
requirement:**

| group | count | what they are |
| --- | --- | --- |
| `C ᵖ` verdict cells | 23 | The rows above. Judged BUILT-AND-CORRECT, unreadable by the tool. |
| §6 restatements | 4 | G327, G328, G354, G371 restated in "What could not be verified" without a verdict cell. All four already carry `**?**` in §4 and are counted as the 4 CANNOT-VERIFY. |
| §3 deployment table | 6 | Rows keyed by *lists* of ids (`G5, G45, G75, …`) saying what is inert in production. Cross-references to verdicts §4 already holds. |

**Nothing in this census is unjudged.** The brief that commissioned this pass
described these 33 as "requirements nobody has judged … invisible to every number
this repo reports", and that is the one thing they are not. What they are is
*unrecheckable*: see §8.3, where re-reading the 23 found the evidence on most of
them stale by hundreds of lines, which is the real cost of a row a tool cannot
parse.

**One coincidence worth naming before somebody quotes it.** The tool's `C 207`
happens to equal this document's *spec-attributable* CORRECT of 207, and its
`(207+69)/373 = 74.0 %` / `207/373 = 55.5 %` happen to equal the spec-attributable
pair — because the marker the tool cannot read IS the attribution marker. Anyone
who quoted 74.0 % / 55.5 % as "what the tallier says this census is" was right by
accident and would have been wrong the moment one `ᵖ` moved.

### 8.2 What fixing the parse moves, and what it does not — both numbers

The brief asked for this split explicitly, so here it is with nothing folded
together.

| | constructed | correct (raw) |
| --- | --- | --- |
| **What the tallier read before §8** | 74.0 % (276/373) | 55.5 % (207/373) |
| **What the tallier reads after §8.3 alone**, no building | 80.2 % (299/373) | 61.7 % (230/373) |
| **What the tallier reads after §8.4 too** | 82.0 % (306/373) | 63.5 % (237/373) |

So of the **+8.0 points** the machine-visible headline moves in this pass,
**+6.2 points (23/373) is the tallier learning to read `ᵖ` and NOTHING ELSE**, and
**+1.9 points (7/373) is code that did not exist yesterday.** The document's OWN
headline — the one a human reading §4 would compute — moves only by that second
number: **80.2 % → 82.0 % constructed, 61.7 % → 63.5 % correct.** It was never
74.0 %.

The denominator does **not** grow. It was 373 before and is 373 after; no
requirement was discovered, invented or reclassified. A denominator that grows
is honest, but this one had nothing to grow by, and saying otherwise to make the
percentage look earned would be the failure this whole exercise is against.

### 8.3 The 23 `ᵖ` rows, restated so a machine can read them — and re-verified

Every row below keeps its verdict (`C`, earned by pre-existing work — the `ᵖ`
meaning now lives in its own column so the verdict cell is a bare token). Every
citation was re-opened at `579694d6` and **anchored**, because most of the
originals no longer resolve: `discoverySearch.ts` has moved by ~220 lines since
the tree this census was taken on, so evidence written as "lines 960–962 select
sensitivity_level" now lands 224 lines short of the select it names.

| id | was | now | attr | re-verified evidence at `579694d6` |
| --- | --- | --- | --- | --- |
| G56 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearchHelpers.ts:170#matchTier` lowercases both sides; every DB predicate is `ilike`. **The old pointer, lines 163–179, is stale by 7.** |
| G59 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearchHelpers.ts:70#SEARCH_ALIASES` plus `lib/canonicalLocations.ts:162#siargoa` and `:186#qouc` (the spec's own example misspelling). |
| G68 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:1443#sensitivity_level,` selects the approximate pair and never the exact one; `:286#gemSearchPosition` fails closed to `hidden`. **The old pointer, lines 960–962, is stale by 224.** |
| G70 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:727#visibility` (events), `:899#visibility` + `:900#show_in_discovery` (trips). Proven through the gateway by `src/test/inputAssistanceCertification.test.ts:350#PUBLIC`. |
| G73 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2064#COMMON_LANGUAGES` — server-side static lists behind `searchStatic`. **The old pointer, lines 1577–1578, is stale by 225.** |
| G92 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:42#tierConfidence` — `tierConfidence(3) = 0.99` over `matchTier`. |
| G93 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:42#tierConfidence` — `tierConfidence(2) = 0.85`, over `routes/discoverySearchHelpers.ts:170#matchTier`. |
| G95 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:463#SearchQueryContext` passes `{lat, lng, userCity}` into the city boost. **The old pointer, line 380, is stale by 16 — this pass moved it.** |
| G126 | `C ᵖ` (unreadable) | **C** | ᵖ | Age: `lib/inputAssistance/gateway.ts:456#ageRestrictedSet`, fail-closed at `:461#blockedSet`. Membership/role: `routes/discoverySearch.ts:900#show_in_discovery`. Trust/invite have no separate gate and no path exposes an invite-scoped object. |
| G128 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:456#ageRestrictedSet` and `:461#blockedSet` — a null set from either suppresses every entity row; the picker branch repeats it at `:757#fetchBlockedSet`. |
| G129 | `C ᵖ` (unreadable) | **C** | ᵖ | Structural: `lib/inputAssistance/types.ts:230#InputSuggestion` has no coordinate field, and `routes/discoverySearch.ts:1443#sensitivity_level,` never selects a gem's exact pair. Deep-scanned by `src/test/inputAssistanceCertification.test.ts:289#findCoordLeaks`. **Phase 9 widened the projection by three fields and this deep scan still passes** (§8.4). |
| G152 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/validationSuite.ts:172#normalization` for hashtag validity, `:264#correction` for the row it produces; handles reuse the pre-existing `lib/usernameRules.ts`. |
| G165 | `C ᵖ` (unreadable) | **C** | ᵖ | Realised in production by the pre-existing `travel-buddy-standalone/src/components/MentionInput.tsx:145#insertTag`, which keeps display text while recording structured tag spans. The platform's own version is still unconsumed. |
| G184 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:456#ageRestrictedSet` and `:757#fetchBlockedSet`; the null-set refusal is the mutation-proven case in `src/test/inputAssistanceGateway.test.ts:384#suppresses`. |
| G185 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:727#visibility`, `:899#visibility`, `:900#show_in_discovery`; proven through the gateway by `src/test/inputAssistanceCertification.test.ts:350#PUBLIC`. |
| G186 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:135#display-safe` — a fixed whitelist that still drops `metadata`, `privacyState`, `accessState`, owner/host ids and counts. **Phase 9 added three fields to that whitelist; none is private (§8.4).** |
| G218 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:420#dispatchTypes` → `routes/discoverySearch.ts:2008#dispatchSearch`. |
| G220 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/entityMap.ts:35#ENTITY_TO_SEARCH` → `routes/discoverySearch.ts:2008#dispatchSearch`. |
| G235 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/inputAssistance.ts:153#input_assist_suggest` (90/min) and `:275#input_assist_select` (60/min). Both still resolve exactly. |
| G278 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2052#searchPlaces`. **The old pointer, line 1568, is stale by 225.** |
| G279 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2056#searchHiddenGems` + `:286#gemSearchPosition`. |
| G281 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2045#searchTrips`. |
| G282 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2038#searchEvents`. |

`ᵖ` still means "correct, but earned by pre-existing work". The spec-attributable
CORRECT is still C minus the count of `ᵖ` rows, which is still 23.
*(2026-09-14: the arithmetic stands — spec-attributable CORRECT is C minus the 23. What those
23 rows ARE attributable to is unknown for most of them; see the method restatement in §2.)*

### 8.4 Row moves — seven NOT-BUILT rows built

| id | was | now | why |
| --- | --- | --- | --- |
| G97 | N | **C** | §15 **TemporalFit** now has a producer. `extractTemporal` was already normalising "tonight" / "tomorrow morning" / "Friday after dinner" into an ISO window; the window went into a search STRING and was discarded. It is now resolved once per request at `lib/inputAssistance/gateway.ts:194#TemporalWindow` and handed to the projection at `:441#temporalWindow`, where `lib/inputAssistance/rankingSignals.ts:104#applyTemporalFit` boosts a row that starts inside it and demotes one that starts outside. Deliberately a RANKING term, not a filter — see the ceiling note in §8.7. |
| G101 | N | **C** | §15 **TrustConfidence** now has a producer. `verified` and `is_official` were selected by `searchTravelers` (`routes/discoverySearch.ts:177#verified?:`) and dropped by the §42 whitelist. `lib/inputAssistance/rankingSignals.ts:130#applyTrustConfidence` reads them into `confidence`, clamped by `:59#SIGNAL_CEILING` strictly below the exact-match band so §9's trust order holds. |
| G180 | N | **C** | §20 **verification / trust context** is displayable. `lib/inputAssistance/types.ts:261#verified` and `:262#official` are projected at `lib/inputAssistance/projection.ts:141#verified` — only when TRUE, so an absent key is "not applicable" and never a negative claim about a person — and rendered as badges by `travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts:40#suggestionBadges`, which the row both renders and announces from one call (`components/EntitySuggestionRow.tsx:41#suggestionBadges`, `:46#badges.map`). |
| G181 | N | **C** | §20 **Hidden Gem protection label**. `gemSearchPosition` already decided whether a gem may carry a centroid and wrote it to `metadata.coordsPrecision`; the projection dropped the whole bag, so a protected gem rendered identically to an unprotected one. `lib/inputAssistance/rankingSignals.ts:151#gemLocationPrecision` reads that word into `lib/inputAssistance/types.ts:271#locationPrecision` at `lib/inputAssistance/projection.ts:144#gemLocationPrecision`. A precision WORD, never a position: `'exact'` is not in the union because the gem path cannot produce one, and a test serialises the row and greps for the centroid. |
| G356 | N | **C** | §50 **the field inventory exists.** Three source files cited "the client audit's §50 field table" as an existing artifact and a repo-wide search returned only those three references to it. `travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:102#FIELD_INVENTORY` is that table — 24 records, one per registered fieldId — and `src/test/inputAssistanceFieldInventory.test.ts:201#registrars` refuses a registered field that is not inventoried. The three dangling citations now point at it. |
| G357 | N | **C** | §50 **the per-field record.** `fieldInventory.ts:415#fieldInventoryRow` merges the recorded half (screen/route, component file, current implementation, provider, zero-state, validation, known issues, migration status) with the four attributes `INPUT_CONTEXT_REGISTRY` already owns (desired mode, entity types, offline policy, privacy class) rather than copying them, so the row cannot disagree with the registry. Every `componentFile` is asserted to exist on disk, and `migrationStatus` is MEASURED, not claimed: `src/test/inputAssistanceFieldInventory.test.ts:296#mounted` scans `src/` and `app/` for each fieldId. |
| G31 | N | **C** | §29 **`privacyClass` has a reader.** It was declared on all 29 contexts and read by nothing — deleting it would have changed no behaviour. `travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts:41#UNCACHEABLE_PRIVACY_CLASSES` and `:55#isCacheablePrivacyClass` now gate the process-global suggestion cache, wired at `hooks/useInputAssistance.ts:164#isCacheablePrivacyClass` (read) and `:239#sharedSuggestionCache.set` (write). Not hypothetical: `telegraph.recipient` is `personal` AND mounted, so a global map was holding a list of PEOPLE under the raw prefix the viewer typed and serving it back without a round trip that could re-check eligibility. |

### 8.5 One row whose evidence was false, verdict unchanged

| id | was | now | why |
| --- | --- | --- | --- |
| G176 | N | **N** | Verdict stands; the stated evidence does not. The row read *"`SearchResult.distanceKm`, where it exists, is dropped by the projection whitelist"*. **There is no `distanceKm` on `SearchResult`** — `routes/discoverySearch.ts:159#SearchResult` has no such field and `grep -rn distanceKm` over `artifacts/api-server/src` returns only services/ranking/DiscoveryRankingService.ts, a different object on a different surface. Distance is computed transiently inside the places ordering and never lives on a row, so nothing is being "dropped by the whitelist": the field was never there. Not built this pass on purpose — see §8.8. |

### 8.6 Mutations applied, watched go red, reverted, `cmp`-verified

Every behaviour claimed above has a named mutation that was actually applied. Each
was reverted and the file compared byte-for-byte against a backup taken before the
edit (`cmp` clean in every case).

| mutation | failures |
| --- | --- |
| `projection.ts`: drop the `applyTrustConfidence` wrapper | 2 |
| `projection.ts`: drop the `applyTemporalFit` wrapper | 1 |
| `gateway.ts`: drop `{ temporalWindow }` from the `projectSearchResult` call | 1 |
| `projection.ts`: delete `if (r.verified === true) …` | 1 |
| `projection.ts`: delete `if (precision) suggestion.locationPrecision = …` | 1 |
| `suggestionBadges.ts`: delete the `official` branch | 1 |
| `fieldInventory.ts`: flip `discovery.search` to `registered_unmounted` | 1 |
| `fieldInventory.ts`: flip `geo.country` to `mounted` | 1 |
| `fieldInventory.ts`: change one row's `context` | 1 |
| `creationFields.ts`: register a new fieldId without inventorying it | 1 |
| `suggestionCache.ts`: remove `personal` from the uncacheable set | 2 |
| `useInputAssistance.ts`: remove the cache **write** guard, keep the read guard | 1 |
| `EntitySuggestionRow.tsx`: drop the badges from `accessibilityLabel` | 1 |

**One assertion was found worthless this way and strengthened rather than kept.**
The "trust never lifts a weaker match past the exact band" test passed with the
trust term removed entirely — a `<` bound is satisfied by a term that does
nothing. It now asserts the boost actually applies before asserting the ceiling,
which is the same defect the personalization suite had already documented for
`BOOST_CEILING`. The mutation that left it green is recorded here rather than
quietly fixed.

### 8.7 Restated headline

> | Measure | was (§4 as written) | now (§8) |
> | --- | --- | --- |
> | **Denominator — testable requirements** | 373 | **373** |
> | BUILT-AND-CORRECT | 230 | **237** |
> | BUILT-BUT-WRONG | 69 | **69** |
> | NOT-BUILT | 70 | **63** |
> | CANNOT-VERIFY | 4 | **4** |
> | **CONSTRUCTED%** = (C+W)/373 | 80.2 % | **306 / 373 = 82.0 %** |
> | **CORRECT%** (raw) = C/373 | 61.7 % | **237 / 373 = 63.5 %** |
> | **CORRECT% (spec-attributable)** = (C−23ᵖ)/373 | 55.5 % | **214 / 373 = 57.4 %** |
> | CANNOT-VERIFY share | 1.1 % | **4 / 373 = 1.1 %** |

Every one of the 373 requirements is now on a row a machine can parse: parsed rows
= denominator = 373, which switches on `check:census-integrity`'s strictest rule —
the headline must now sum to the denominator or the check fails. It does: 237 + 69
+ 63 + 4 = 373.

**P24 — what would turn this red?** Any of: a `pnpm -s check:census-integrity` run
where the four buckets stop summing to 373; a `check:census-freshness` run after a
counted file moves without an acknowledgement; any of the thirteen mutations in
§8.6 being applied and the suite staying green; or a reader opening one of the
thirty-one anchored citations above and finding the anchor text absent from that
line (`check:doc-citations` asserts exactly that, on the FIRST line of every cited
range).

### 8.8 CEILING — what is not reachable, and why

**Nothing in §8.4 is behind a flag or a migration**, so all seven rows are true on
every deployment that runs this code. That is the strongest thing that can be said
about them, and it is much weaker than "done": built on a branch is not merged,
merged is not deployed, deployed is not in a shipped app binary. Two of the four
§20 display fields only reach a human where a screen mounts the SDK row, and §8.4's
own inventory says that is **8 fieldIds of 24**.

**What this pass could not build, with the reason:**

1. **§48 feature-capability handshake (G343).** The mechanism is a morning's work —
   the request declares what the client renders, the response declares what the
   server can emit, the gateway drops the difference. It was **not** built because
   it would be **vacuous today**: there is exactly one client, and it renders or
   dispatches every suggestion type and every action the server currently emits
   except `share_entity` and `drop_pin`, which have **no producer** (G303), and
   `open_compass`, whose rows also carry `replacementText` and are therefore usable
   anyway. A handshake that filters nothing is a `C ⌀`, and a `⌀` bought with a day
   of work is worse than an honest `N`.
2. **§32 client static dictionaries (G197 / G212).** Shipping a country / language /
   interest list client-side is trivial. It is **unreachable**: the three contexts
   with `offlinePolicy: 'static_dictionary'` are `country_picker`, `language` and
   `interest`, and the inventory now proves that none of them is mounted — the only
   `assistContext` any screen passes is `trip_destination`. Building it would have
   produced a second `⌀`.
3. **§20 distance (G176).** Buildable — haversine over the viewer's coordinates and
   a place's `metadata.lat/lng`. **Not taken, and surfaced instead as an owner
   decision**: a distance from the viewer to a *hidden gem* constrains that gem to a
   circle, and this census's G129 verdict and the certification's coordinate deep
   scan both rest on "`InputSuggestion` has no coordinate field at all". Trading
   that for a distance label is a privacy decision, not a coding one.
4. **§24 paste (G154–G162, G337), §25 dictation (G163), §30 precedence (G192).**
   Untouched. Paste is a ten-row client feature with no handler anywhere; dictation
   is conditional on a speech transport the app does not depend on; precedence has
   three of its seven tiers with no producer, so an implementation would guard a
   conflict that cannot occur.
5. **§44 telemetry emitters (G311, G313–G320) and the §45 loop (G322).** Adding the
   nine missing call sites is small and would move nine rows **N → W, not N → C**,
   because the sink is `() => {}` and `setTelemetrySink` is called from no non-test
   file. Nine rows of "constructed" bought with nine emissions into a black hole is
   exactly the kind of number this census exists to refuse.

**What is NOT reachable at all from a branch**, unchanged from §3: migration 2220
(`canonical_locations.search_key`), 2221 (`compass_ai_writing_enabled`), 2258
(`input_selection_history`) are absent from production, `isFlagEnabled` is
fail-closed, and every `intel_*` table holds zero rows. The 69 BUILT-BUT-WRONG rows
that depend on those are owner deployment actions and none of them moved.

### 8.9 Scope and freshness

`head_commit` is updated in the header table from `42aeac38` to `579694d6`, the
commit this section measures, and the spent acknowledgement for this census is
deleted from the ledger — an acknowledgement written against a superseded
measurement is not a silence anyone should inherit.

Four new paths were added to this census's `CENSUS_SCOPE` entry, because §8 cites
them as evidence and a census must watch what it cites:
`lib/inputAssistance/rankingSignals.ts` (already covered by the directory entry),
`platform/input-assistance/contexts/fieldInventory.ts`,
`platform/input-assistance/components/suggestionBadges.ts`, and the two new test
files.

**Cross-lane.** `lib/inputAssistance/` is counted by **census-discovery** and
`lib/inputAssistance/projection.ts` by **census-compass**. Both entries in
`CENSUS_STALENESS_ACKNOWLEDGED.json` were extended with a per-file argument rather
than a filename: that `projectSearchResult`'s new parameter defaults to `{}` and
both new terms are the identity on their absent inputs, so every caller that passes
no signals gets a byte-identical row; that `dispatchSearch` is called with the same
arguments, so no Discovery ranking path changed; and that for compass_prompt's only
entity types (place / hidden_gem / city) both terms are provably inert, because
none of the three carries `verified`, `is_official` or a `startsAt`. One honest
residue is recorded there rather than hidden: census-discovery's unanchored two-part
citation into `lib/inputAssistance/gateway.ts` (its 27-and-384 pair) now points 15
lines high at its second part. That is a stale pointer in another census's citation, not a moved
verdict, and re-pointing it is that census's to do.

---

## 9. Phase 10 — the CORRECTNESS gap, grouped and then worked

§8 closed the counting. What it left is the only thing left: **the W column.**
CONSTRUCTED% and CORRECT% differ by exactly the BUILT-BUT-WRONG rows — 69 of
them, 18.5 points — and every one of those is a thing the programme paid to
build and did not finish. This section groups all 69 by *why* they are W,
builds six of them, and says precisely what blocks the largest group it did not
build. Measured and built at `90a515a6`.

**Nothing here re-labels a row.** §8 was explicit that of its +8.0-point move,
+6.2 was a tallier learning to read a superscript. There is no such move
available now — every one of the 373 rows already parses — so all of §9's
movement is code, and the constructed percentage does not move at all. Only
CORRECT% does, which is the whole point: **the gap is what shrinks.**

### 9.1 The 69 BUILT-BUT-WRONG rows, grouped by blocker

Every W row was re-read and assigned to exactly one group, by its **dominant**
blocker — several rows have a second one, and where that matters it is named.
The group sizes are the useful output: they say where the remaining 69 actually
live, and they say that only two of the five groups are reachable from a branch
at all.

| group | count | what it means | reachable from a branch? |
| --- | --- | --- | --- |
| **(a) logic wrong in code** | 13 | A production path runs and does the wrong thing. Nothing is missing; something is incorrect. | **Yes** |
| **(b) logic right, nothing reaches it** | 14 | A correct, tested implementation exists and no production path calls it. | **Yes** |
| **(c) emits into a sink nothing consumes** | 6 | The §44/§45 telemetry chain. The event is defined, scrubbed, policy-gated — and its destination is `() => {}`. | **No — see §9.4** |
| **(d) capped by a flag or migration** | 6 | The code is right and the column, table or flag it needs is absent from production. | **No — owner action** |
| **(e) needs something nobody has written** | 30 | Not a defect and not a wiring gap: the thing itself does not exist. | Yes, but it is building, not fixing |

**(a) logic wrong in code — 13.**
G16, G33, G53, G62, G66, G107, **G115**, G173, **G210**, G211, G277, **G324**,
**G329**. Four are built below. The nine left are, in rough order of how wrong
they are: `searchCountries` aggregating `profiles.home_country` so a country
with no users in it does not exist (G277); emoji surviving `sanitizeQuery` into
the `ilike` pattern to match nothing (G62); `neighborhood → 'cities'` so a
neighbourhood picker returns cities (G66); two engines racing on every
keystroke of the main search screen (G16); the client and server declaring
different `telemetryPolicy` shapes under a header that claims they match
byte-for-byte (G33); §16 carryover being a reorder rather than a constraint
(G107); a plain `ScrollView` where §33 asks for virtualization (G211); the
keyboard-occlusion guarantee resting on an argument rather than a mechanism
(G173); and §9's 11-step trust order reproduced as 6 of 11 (G53).

**(b) logic right, nothing reaches it — 14.**
G6, G18, G98, G109, G116, G122, G124, G125, G190, **G204**, **G214**, G261,
G305, G359. Two are built below. This is the group §8 named as the reason six
of its seven moved rows were N: *something was declared, computed or selected,
and nothing read it.* It is still the second-largest group, and it is the
cheapest per row. The three biggest single items in it are one function with
one caller (`filterInfeasibleCandidates` covers G122/G124/G125 between them), a
protected-place gate the suggestion path never consults (G190), and a
`open_compass` action the server emits that every client surface drops (G305).

**(c) emits into a sink nothing consumes — 6.** G5, G14, G263, G306, G323,
G355. §9.4.

**(d) capped by a flag or migration — 6.** G57 (migration 2220's `search_key`),
G75, G85, G89, G213, G226 (migration 2258's `input_selection_history`). None
moved and none can; they are the deployment actions §3 lists.

**(e) needs something nobody has written — 30.** G13, G61, G67, G71, G82, G90,
G96, G102, G104, G134, G136, G147, G172, G179, G198, G199, G216, G224, G228,
G233, G240, G241, G260, G274, G283, G340, G341, G344, G350, G361.

13 + 14 + 6 + 6 + 30 = 69.

### 9.2 What this pass built

**§33/§34 — the local prefix tier (G204, G214, and the defect under G210).**
The SWR cache was keyed by the WHOLE query string, so it only ever answered a
query the user had typed before, character for character. Typing forward — "ba"
→ "ban" → "bang" — missed on every keystroke even though the answer for the
shorter prefix was in the map, and §33's middle rung ("1 char → local/cache
prefix match") had no substrate at all: a miss went straight to the network.
Meanwhile `queryNormalization.ts` already held a diacritic/stroke/alias fold
and `matchesGeographicQuery`, fully unit-tested, with **no production
consumer** — group (b) exactly.

`travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts:154#longestPrefix`
finds the longest cached STRICT prefix of the typed text, by constructed key
rather than by parsing keys apart (the fieldId segment can itself contain the
`|` separator — the §22 AI variant appends a JSON blob — so splitting a key is
not safe). The empty prefix is deliberately in range, because a field's
zero-state list is cached under `''` and is exactly the local list a
one-character query should be narrowed out of.
`travel-buddy-standalone/src/platform/input-assistance/services/suggestionRanking.ts:94#narrowToQuery`
narrows those rows to the typed text. It is **strictly subtractive** — it can
only drop rows, never add, reorder, re-score or rewrite one — so §42's "the
server is the ranking authority" is untouched; it decides only which of the
rows the server already returned survive another keystroke. Query-derived rows
are never reused at all
(`travel-buddy-standalone/src/platform/input-assistance/services/suggestionRanking.ts:71#LOCALLY_REUSABLE_TYPES`):
a `completion` carries the old text in `replacementText` and would submit it, a
`correction`/`validation` judged a string the user has since changed, an
`ai_suggestion` was written for it. The hook consults both at
`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:191#localTier`.

**§33 — network loss retains the rows (G210).** The `unavailable` branch called
`setSuggestions([])`. §33 asks for the opposite in the same sentence: *"retain
local/cached suggestions"* and explicit degraded behaviour. The degraded state
was right and the retention was inverted — the last good rows were discarded at
the one moment the user cannot get new ones. It now serves the narrowed local
list at
`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:240#setSuggestions`,
and with nothing local to retain it is `[]`, the old behaviour exactly.

**§29 is not weakened by any of this, and that is checked rather than asserted.**
The local tier reads the same process-global cache the §8 `privacyClass` gate
guards, so an uncacheable field (`personal` / `sensitive` / `private_message`)
neither writes to it nor reads from it here. The test that proves it seeds the
cache DIRECTLY for `telegraph_recipient` and asserts the hook still serves
nothing, which isolates the read guard from the write guard instead of leaning
on the write guard to make the read guard look correct.

**§46 — the selection result is announced (G324).** `handleSelect` emitted
telemetry, applied the replacement text and closed the overlay: three state
changes, none of them perceivable. A screen-reader user heard the list vanish
and nothing else.
`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:97#selectionAnnouncement`
is the sentence and
`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:228#announceForAccessibility`
is the call. The `applied` argument is load-bearing, not decorative: a row
carrying `replacementText` rewrites the field under the cursor and a row that
does not (an action, a validation, a caller that handled insertion itself)
leaves it exactly as typed. Announcing "Field updated" in the second case would
be a false statement about the user's own text, which is worse than silence.

**§46 — a non-colour active indicator (G329).** The keyboard-active row
differed from every other row by `backgroundColor` alone, so a sighted user who
cannot resolve that hue had no way to tell which row Enter would take;
`accessibilityState.selected` serves assistive tech and does nothing for them.
`travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:78#activeSlot`
adds a second channel: a caret glyph present on the active row and absent
everywhere else. Presence/absence of a mark survives any colour vision, any
contrast setting and a greyscale screenshot. The slot keeps its width either
way so arrowing down the list does not reflow the text, and the caret is hidden
from assistive tech
(`travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:84#ia-row-active-marker`)
because `selected` already carries the fact and a second reading of it is noise.

**This is also the FIRST accessibility test in the layer.** §46's closing note
in §4 records that all 24 existing test files were listed and none referenced
`accessibilityLabel`, `accessibilityRole` or any a11y assertion. Two §46 rows
were BUILT-BUT-WRONG underneath that silence.
`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx:83#NON-COLOUR marker`
is where it stops being silent.

**§18 — "on the way" could not split a sequence (G115).** §18 names six
sequence operators; five split. `extractGeo` runs on the whole query BEFORE
`splitSequence` and used to `strip` this one out as its `along` relationship,
so by the time the splitter ran there was nothing left to split on: *"food on
the way to the club"* parsed as ONE stage. The phrase is genuinely both
operators — §18 lists it under sequence, `extractGeo` reads it as a
relationship — and it is now recorded as the relationship at
`artifacts/api-server/src/lib/inputAssistance/semanticParser.ts:431#ALONG_RE`
and left in place for
`artifacts/api-server/src/lib/inputAssistance/semanticParser.ts:513#ALONG_RE`
to consume. The regex is shared, not retyped, so the two readings can never
drift into covering different phrases. A one-stage query is unchanged: the
splitter drops its own separators, so *"coffee along the way"* still yields one
stage with raw `coffee`.

### 9.3 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| G204 | W | **C** | §33's tier ladder has its middle rung. `suggestionCache.ts:154#longestPrefix` + `suggestionRanking.ts:94#narrowToQuery` are consulted at `useInputAssistance.ts:191#localTier` BEFORE the network answers, so a keystroke past a cached prefix renders locally instead of showing nothing until a round trip completes. The revalidation request still goes out — that is SWR, and the hook's own header has always said "still server-assisted if minChars ≤ 1". Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:98#renders local rows before the server answers`. |
| G214 | W | **C** | §34 "prefer local: cached city prefix matching" has a prefix index. The row's exact complaint — *"the SWR cache is keyed by the whole query string … There is no prefix index"* — is answered by `suggestionCache.ts:154#longestPrefix`, which is O(len(query)) O(1) lookups, longest prefix first, TTL- and coordinate-respecting. The fold that makes "danang" match "Đà Nẵng" and "hcmc" match "Ho Chi Minh City" is the pre-existing `queryNormalization`, now reached for the first time. |
| G210 | W | **C** | §33 "network loss: retain local/cached suggestions **and** explicit degraded behaviour" — both halves. The degraded half was already exact; the retention half was inverted (`setSuggestions([])`). `useInputAssistance.ts:240#setSuggestions` now retains the narrowed local list while still setting `unavailable`. Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:110#RETAINS`. |
| G324 | W | **C** | §46's fourth announcement exists. Purpose, count and active row were already wired; the selection result was not. `SmartInput.tsx:228#announceForAccessibility` speaks it, and `SmartInput.tsx:97#selectionAnnouncement` says "Field updated" only when the field really was rewritten. Proven at `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx:204#never claims it did`. |
| G329 | W | **C** | §46 "non-color-only state indicators". The active row now carries a caret glyph as well as its background tint (`EntitySuggestionRow.tsx:78#activeSlot`), so the state survives greyscale. The caret is hidden from assistive tech on purpose — `accessibilityState.selected` already carries it. |
| G115 | W | **C** | §18's sixth sequence operator fires. `semanticParser.ts:431#ALONG_RE` records the relationship without consuming the phrase, and `semanticParser.ts:513#ALONG_RE` splits on it, so *"food on the way to the club"* is two stages and still `along`. Proven at `artifacts/api-server/src/test/inputAssistanceSemanticIntent.test.ts:324#on the way`. |

Six rows, all W → C. **CONSTRUCTED% does not move** — these were already
counted as constructed, which is exactly what made them the gap.

### 9.4 §44 telemetry: what blocks it, precisely

The brief that commissioned this pass asked for the §44 emitters and described
them as "nine rows sitting at W because the sink is `() => {}`". **They are
not at W. G311 and G313–G320 are `N`** — no call site exists at all — and §8.8
declined to add the call sites for a stated reason: doing so would move them
**N → W**, which widens the very gap this pass exists to close. That reasoning
still holds and this pass did not add them either.

The row that *is* at W is **G306**, and its failing half is the destination.
The question §9 was asked to settle is whether that destination can be given
"on this branch with no migration and no flag". **It cannot, and here is the
mechanical reason rather than an opinion:**

1. **There is no table.** `ls artifacts/api-server/src/migrations | grep -iE
   'input|telemetry'` returns five files. Three are sibling lanes' telemetry
   ingests — the Map, Passport and Wall telemetry-event migrations, numbered
   2202, 2287 and 2308 — and two are §35 selection memory
   (`artifacts/api-server/src/migrations/2258_input_selection_history.sql:1#input_selection_history`)
   and a Map refusal event. **There is no §44 events table in the migration set
   at all.** Not unapplied: absent. The three sibling migrations are named by
   number rather than cited by path on purpose: they are other lanes' files, and
   watching them would age THIS census every time Map, Passport or Wall touch
   their own telemetry.
2. **Every sibling that closed this closed it WITH a migration.** Map, Passport
   and Wall each shipped a table, a route and a collection flag. The Passport
   ingest says so in its own header: *"With `passport_telemetry_enabled` OFF
   (its shipped state) every accepted event is still a no-op inside
   `recordPassportEvent` — the route is the transport, the flag is the
   collection decision."* A §44 destination built to that pattern needs all
   three of the things the brief excludes.
3. **The one destination that does exist is itself dead.** `/input-assistance/select`
   writes `input_selection_history`, and `src/scripts/checkProductionDrift.ts`
   classifies that table `"unapplied"`, *"In portava-ci, absent from
   production."* So the lane's only existing write path is the ☠prod group (d)
   already knows about.
4. **A device-local sink would be a `⌀`.** The alternative to a server is to
   keep the events on the device — but §42 makes ranking server-owned, so
   nothing on the client could consume them, and a sink whose only reader is
   itself is the same black hole with a longer name.

So **G306 stays W**, and G5, G14, G263, G323 and G355 stay W with it. That is
six rows this pass could have made *look* better by emitting nine more events
into nothing, and did not. The honest statement is the one §8.8 already made
and this pass re-verified: **§44 is an owner decision about a migration, not a
coding gap.**

### 9.5 Evidence found false, verdicts unchanged

| id | was | now | why |
| --- | --- | --- | --- |
| G233 | W | **W** | Verdict stands; **half the stated evidence is now false.** The row reads *"the verification flags are dropped before projection (G180), so a viewer cannot even tell the real account from the copy."* They are not dropped. §8's G180 build added `artifacts/api-server/src/lib/inputAssistance/projection.ts:141#verified` and `:142#official`, and `travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts:42#Official` renders both as badges — so a viewer CAN now tell them apart, and §8's `applyTrustConfidence` additionally ranks the verified account above the copy. What is still true is the row's first clause, and it is the whole reason the verdict does not move: **nothing in the suggestion path detects or demotes an impersonating handle.** No confusable/homoglyph comparison exists anywhere in the layer. The row is W for one reason now, not two. |

**A second falsity, and it is larger than one row.** §4's citations into the
files this pass edited do not resolve, and — checked rather than assumed —
**most of them did not resolve at the base commit either.** Three, opened at
`f8384ea5` before a line of this pass was written:

- G307 points at SmartInput.tsx line 170 for the `input_opened` emit. Line 170
  held `autoCapitalize={textInputProps.autoCapitalize ?? 'none'}`.
- G309 points at useInputAssistance.ts line 161 for `suggestion_request_started`.
  Line 161 was blank.
- G329 points at EntitySuggestionRow.tsx lines 97 to 99 for `rowActive`. Those
  three lines held closing JSX.

All three verdicts are right — the emitters and the style rule do exist, at
`SmartInput.tsx:291#input_opened`, `useInputAssistance.ts:216#suggestion_request_started`
and `EntitySuggestionRow.tsx:145#rowActive`. What is wrong is every pointer.
**This is what the UNANCHORED ceiling is for and it is why that ceiling must
keep falling:** `check:doc-citations` caught all three of the *anchored*
citations this pass invalidated and repointed them; it caught none of the ~60
unanchored ones, because a bare `path:line` carries nothing that can be
checked. §4 is deliberately NOT rewritten — it is a measurement taken at a tree,
and editing it to match a later one is the habit this census refuses — but no
reader should take an unanchored §4 pointer as a coordinate. Every citation
§9 adds is anchored.

### 9.6 Mutations applied, watched go red, reverted, `cmp`-verified

Thirteen. Each was applied to the real file, the named suite was run and
watched fail, the file was restored from a backup taken before the edit, and
`cmp` compared the two byte-for-byte (clean in every case).

| mutation | suite | failures |
| --- | --- | --- |
| `suggestionCache.ts`: scan prefixes from `n = q.length` (include the exact key) | raceAndCache | 1 |
| `suggestionCache.ts`: scan prefixes shortest-first | raceAndCache | 1 |
| `suggestionRanking.ts`: drop the `LOCALLY_REUSABLE_TYPES` gate | raceAndCache | 1 |
| `suggestionRanking.ts`: `narrowToQuery` returns its input unfiltered | raceAndCache | 3 |
| `useInputAssistance.ts`: restore `setSuggestions([])` in the `unavailable` branch | localTier | 1 |
| `useInputAssistance.ts`: delete the `if (localTier) setSuggestions(localTier)` block | localTier | 1 |
| `useInputAssistance.ts`: drop the `cacheable` guard on `localTier` | localTier | 1 |
| `SmartInput.tsx`: delete the `announceForAccessibility` call | suggestionAccessibility | 2 |
| `SmartInput.tsx`: pass a literal `true` for `applied` | suggestionAccessibility | 1 |
| `EntitySuggestionRow.tsx`: never render the caret | suggestionAccessibility | 3 |
| `EntitySuggestionRow.tsx`: render the caret unconditionally | suggestionAccessibility | 2 |
| `semanticParser.ts`: restore `strip(ALONG_RE)` in the `along` branch | semanticIntent | 1 |
| `semanticParser.ts`: drop `ALONG_RE.source` from `SEQUENCE_SPLIT_RE` | semanticIntent | 3 |

**Two assertions that could not have failed were caught while writing them, and
are recorded here rather than quietly fixed** — §8.6 found one of this shape (a
trust ceiling satisfied by a term that does nothing) and asked the next pass to
look for more.

1. **The negative caret assertion.** RNTL's queries exclude
   accessibility-hidden elements by default, and the caret is deliberately
   hidden from assistive tech. "An inactive row carries no marker" therefore
   passed for a caret that WAS rendered — the mutation "render the caret
   unconditionally" left it green. Every caret query now passes
   `{ includeHiddenElements: true }`, including the negative one, and that
   mutation now fails.
2. **The announcement sentence tested without its call site.** The first draft
   asserted `selectionAnnouncement`'s output and spied on `AccessibilityInfo`
   in isolation. Both would have stayed green with the call deleted from
   `SmartInput` — a perfect sentence nobody speaks, which is the exact state
   §46 was BUILT-BUT-WRONG in. The suite now drives the real `SmartInput`,
   presses a real row, and asserts what left the component.

A third, smaller one is worth naming because it wasted a run: RNTL 14.0.1's
`render` is ASYNC. An un-awaited `render` returns a Promise whose query methods
are `undefined`, which surfaces as a confident-looking `TypeError` rather than
as a failed assertion. Both new suites await it.

### 9.7 Restated headline

> | Measure | was (§8.7) | now (§9) |
> | --- | --- | --- |
> | **Denominator — testable requirements** | 373 | **373** |
> | BUILT-AND-CORRECT | 237 | **243** |
> | BUILT-BUT-WRONG | 69 | **63** |
> | NOT-BUILT | 63 | **63** |
> | CANNOT-VERIFY | 4 | **4** |
> | **CONSTRUCTED%** = (C+W)/373 | 82.0 % | **306 / 373 = 82.0 %** |
> | **CORRECT%** (raw) = C/373 | 63.5 % | **243 / 373 = 65.1 %** |
> | **CORRECT% (spec-attributable)** = (C−23ᵖ)/373 | 57.4 % | **220 / 373 = 59.0 %** |
> | **THE GAP** = W/373 | **18.5 %** | **63 / 373 = 16.9 %** |
> | CANNOT-VERIFY share | 1.1 % | **4 / 373 = 1.1 %** |

243 + 63 + 63 + 4 = 373, so the four buckets still sum to the denominator and
`check:census-integrity`'s strictest rule stays switched on. The constructed
figure is **identical** before and after, deliberately: a pass that closes the
correctness gap cannot move it, and any pass that claims both numbers rose by
the same work has counted something twice.

None of the six moved rows carries `ᵖ`. The prefix tier reuses pre-existing
fold helpers, but the tier that consumes them did not exist yesterday, so the
spec-attributable count rises by the full six and the `ᵖ` population is still
the same 23 §8.3 lists.

**P25 — what would turn this red?** Any of: a `check:census-integrity` run
where the four buckets stop summing to 373; any of the thirteen mutations in
§9.6 being applied and its named suite staying green; `check:doc-citations`
finding an anchor absent from the first line of a cited range; or a reader
opening `suggestionCache.ts:154#longestPrefix` and finding that the hook does
not call it — which is the failure mode group (b) exists to name, and the
reason both new rows are proven through the hook rather than through the pure
function alone.

### 9.8 CEILING — what was not built, and why

**Nothing in §9.2 is behind a flag or a migration**, so all six rows are true on
every deployment that runs this code. The same caveat §8.8 attached applies
unchanged and is not weakened by repetition: built on a branch is not merged,
merged is not deployed, deployed is not in a shipped app binary, and the §46
work reaches a human only where a screen mounts the SDK row — **8 fieldIds of
24**, by this census's own inventory.

Carried forward from §8.8 and **re-checked**, not assumed:

1. **§48 capability handshake (G343).** The reasoning still holds. There is
   still exactly one client;
   `travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts:40#DISPATCHABLE_ACTION_TYPES`
   is still the single closed set, and the actions outside it are still
   `share_entity` / `drop_pin` (no producer, G303) and `open_compass` (whose
   rows carry `replacementText` and are usable as text anyway). A handshake
   that filters nothing is a `C ⌀`, and a `⌀` bought with a day of work is
   worse than an honest `N`. **Left as is, on purpose.**
2. **§32 client static dictionaries (G197 / G212).** Still unreachable, and the
   §8.4 field inventory is what proves it: the three contexts with
   `offlinePolicy: 'static_dictionary'` are `country_picker`, `language` and
   `interest`, and none of them is mounted.
3. **§20 distance (G176).** Still an owner decision, not a coding one, and §8.5
   already recorded that the row's stated evidence is false in the other
   direction: there is no `distanceKm` on `SearchResult` to be "dropped by the
   whitelist". Not built.
4. **§24 paste (G154–G162, G337), §25 dictation (G163), §30 precedence (G192).**
   Untouched, for §8.8's reasons.
5. **§44 emitters and the §45 loop.** §9.4.

**What §9 chose not to build inside its own reachable groups, and why** — this
is the part a reader should hold against it:

- **§20's constraint filter (G122/G124/G125) was examined and deliberately not
  wired.** It is the most tempting item in group (b): a correct, mutation-proven
  `filterInfeasibleCandidates` with exactly one caller, and three W rows behind
  it. It was not wired because the wiring would have been **vacuous**, and that
  was checked rather than guessed: the function's soft half REORDERS candidates
  feasible-first, and `orderSuggestions` re-sorts everything afterwards by
  `TYPE_RANK` then confidence, so a pre-projection reordering survives only as a
  stability tiebreak among rows that already tie on both keys. Its hard half
  (`blocked` / `sensitiveExact`) is already enforced upstream by the §29 gate and
  by `gemSearchPosition`. Three rows of "constructed" bought with a call whose
  effect the next sort erases is the same trade §8.8 refused for telemetry, and
  it is refused here for the same reason. **Making those rows true needs the
  demotion expressed as a confidence term, the way §15's TemporalFit already is
  — that is a real build, and it is the single best-value item left in group
  (b).**
- **G211 (virtualization) was left alone.** Swapping the overlay's `ScrollView`
  for a `FlatList` is an afternoon and would move a row. With
  `maxSuggestions ≤ 8` on every context it would virtualize nothing that needs
  virtualizing, and this pass preferred four defects that change what a user
  actually gets.
- **G199/G261 (device-local recents) were scoped and dropped.** AsyncStorage is
  already a dependency and already mocked in the harness, so persisting
  `suggestionHistory` is small. It was dropped because the module has **no
  production consumer at all** — persisting an unread store would have produced
  a second `⌀`, and wiring the consumer (record on select, serve as zero-state)
  is a larger build than this pass had room for. It is the best-value item left
  in group (e).

### 9.9 Scope and freshness

`head_commit` moves from `579694d6` to `90a515a6`, the commit §9 measures and
builds. `579694d6` carried **no** acknowledgement of its own, so unlike §8's
re-declaration nothing was spent here.

Three paths join this census's `CENSUS_SCOPE` entry, on §8.9's rule that a
census must watch what it cites:
`artifacts/api-server/src/test/inputAssistanceSemanticIntent.test.ts`,
`platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx`
and `platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx`.
`lib/inputAssistance/semanticParser.ts` is already covered by the directory
entry. The three files §9 changed on the client — `suggestionCache.ts`,
`suggestionRanking.ts`, `useInputAssistance.ts`, `SmartInput.tsx`,
`EntitySuggestionRow.tsx` and `raceAndCache.test.ts` — were all already watched.

**Cross-lane.** Only **census-discovery** needed an acknowledgement, and only
for one file: it watches `lib/inputAssistance/` as a directory and this pass
changed `semanticParser.ts` inside it. Its entry is extended with an argument,
not a filename: that `extractGeo` still sets `relationship = 'along'` off the
same regex — `ALONG_RE` is that regex extracted verbatim, not rewritten — and
that `splitSequence` drops its own separators, so a query with no stage after
the operator yields byte-identical stage text. **The residual is stated there
rather than glossed:** a query that DOES carry a following stage now parses as
two stages, `parsed.sequence` flips to true, and a second `StageIntent` appears.
That is a real behaviour change and is not argued as a no-op; it cannot move a
Discovery verdict only because `grep -rn semanticParser` over
`artifacts/api-server/src` resolves to `lib/inputAssistance/` and its tests and
to nothing under `routes/discovery*`.

**census-compass needed nothing.** It watches `lib/inputAssistance/projection.ts`
and `semanticIntent.ts` by name; this pass changed neither. The residual §8.9
recorded against it — that the trust term is NOT the identity for a row carrying
`verified` or `isOfficial` — is unchanged by §9 and still stands exactly as
written.

---

## 10. The `90a515a6..HEAD` re-read of `routes/discoverySearch.ts`

§9 declared `head_commit` `90a515a6`. One counted file has moved since:
`artifacts/api-server/src/routes/discoverySearch.ts`, +290 / −27 across seven
hunks. This section is the re-read that freshness asks for. **It moves no
verdict and no headline number** — §8.7's table stands unchanged — and its
whole output is a correction to *pointers*, plus one count in §2's inventory.

### 10.1 What the diff actually contains

| hunk | at (HEAD lines) | what changed | rows that could care |
| --- | --- | --- | --- |
| 1 | `discoverySearch.ts:76-84#nameVisibilitySet` | import swap: `presentedName` out, `buildListIdentityProjections` in, `resolvePlaceIdBridge` added | none |
| 2 | `discoverySearch.ts:126-137#SEARCH_TYPES` | `SEARCH_TYPES` gains a ninth Map-spec §27 heading, `"saved"` — 17 wire types become 18 | G218, G220 |
| 3 | `discoverySearch.ts:401-405#chunkIds` | new `chunkIds` paging helper (PostgREST `.in()` URL length) | none |
| 4 | `discoverySearch.ts:655#buildListIdentityProjections` | `searchTravelers`' inline identity assembly moved into `services/passport/PassportConsumerProjections.ts:1153#buildListIdentityProjections`; hunk is net zero lines | G101, G180 |
| 5 | `discoverySearch.ts:1271-1426#searchSaved` | a new viewer-scoped `searchSaved` lane, ~238 lines, reading `wishlist_places` + `discovery_place_saves` | G128, G129, G186 |
| 6 | `discoverySearch.ts:2055#searchSaved` | `dispatchSearch` gains `case "saved"` | G218, G220 |
| 7 | `discoverySearch.ts:2073#FAN_LIMIT` + `:2075#deliberately` | the `type=all` fan-out comment: 17 of 18 types fan out, `saved` deliberately excluded | G220 |

Nothing else in the file changed. No gem predicate, no `visibility` gate, no
`sanitizeQuery`, no static dictionary, no `searchCountries` aggregation, no
`matchTier`, no `rankCombined` (which is not even in this file — see 10.3).

### 10.2 Why no verdict moves, hunk by hunk

**Hunks 2, 6 and 7 — the `saved` lane cannot reach this layer.** The obvious
worry is that an eighteenth search type widens what the Global Input
Intelligence gateway dispatches, and it does not. `dispatchTypes` is typed
`lib/inputAssistance/entityMap.ts:16#DispatchSearchType`, an **explicit**
seventeen-member union that does not contain `saved`, and the only producer of
those values is `lib/inputAssistance/entityMap.ts:35#ENTITY_TO_SEARCH`, a
`Record<EntityType, DispatchSearchType>` — so a search type with no `EntityType`
mapped onto it is unreachable by construction, not by convention. `entityMap.ts`
is **byte-identical** between `90a515a6` and HEAD (`git diff` returns empty), so
this is a property of the merged tree and not an inherited claim. G218 and G220
therefore still describe a seventeen-type dispatch, and their `ᵖ` still holds.

That also disposes of G129 and G186 without needing the whitelist argument:
`searchSaved` does put `lat` / `lng` on `metadata` (`discoverySearch.ts:1375#lat:`
and `discoverySearch.ts:1409#lat:`), but no `saved` row can arrive at
`projectSearchResult`. And
had one arrived, it would change nothing: `metadata` is not in the §42 whitelist
(`lib/inputAssistance/projection.ts:135#display-safe`), which is G186's entire
content, and `searchPlaces` (`discoverySearch.ts:1152#lat:`), `searchEvents`
(`discoverySearch.ts:801#metadata:`) and `searchCities`
(`discoverySearch.ts:1857#metadata:`) already carried the same keys before this
diff. G129's structural claim — `InputSuggestion` has no
coordinate field — is about `lib/inputAssistance/types.ts`, which this diff does
not touch.

**Hunk 4 — the identity move is behaviour-preserving on this caller.** The four
rules that left `searchTravelers` were re-read at their destination rather than
taken on trust: `presentedName` is the same canonical helper
(`PassportConsumerProjections.ts:1178#presentedName`); `nameAllowed` is
`isSelf || allowedRealNames.has(id)`, the old `p.id === userId ||
allowedNames.has(...)`; `avatarUrl` is `(!lockedPreview && showAvatar) ?
avatar_url : null`, the old expression verbatim; and `verified` is `prof.verified
=== true`, which agrees with the old `(p.verified) ?? false` on every boolean and
null. The one genuine difference is the projection's added `isSelf` exemption in
`lockedPreview` and `showAvatar` — and it is unreachable from here, because
`searchTravelers` excludes the viewer at `discoverySearch.ts:579#.neq("id",`
before any of it runs. G101 and G180 rest on `verified` / `is_official` being
SELECTED and surviving to the row: the select at
`discoverySearch.ts:577#is_official,` is untouched, `verified` is still assigned
at `discoverySearch.ts:697#verified:` and `isOfficial` still comes straight off
the row at `discoverySearch.ts:698#isOfficial:`. §8.4's producer for G101,
`lib/inputAssistance/rankingSignals.ts:130#applyTrustConfidence`, reads those two
fields off `SearchResult` and is not in this diff.

Hunk 4 also cannot reach G95: `rankCombined` is not in this file.

**Hunks 1 and 3 are inert** — an import line and an unexported array-paging
helper with no policy content.

### 10.3 Twenty-nine pointers repointed across 23 rows, and what they really named

The merge that produced HEAD advanced this census's `discoverySearch.ts` line
numbers by a MECHANICAL offset (+18 below the new lane, +250 above it). That is
correct for the citations §8.3 had already anchored — all of them still resolve,
which is the anchor form earning its keep for a second time. It is **not**
correct for the unanchored ones in §4, and re-reading them at HEAD found that
every one lands on unrelated code. Most were already wrong at `90a515a6`, and
several were already wrong when §8.3 said so in passing ("the old pointer, lines
960–962, is stale by 224") without repairing the §4 rows that carried them. They
are repaired here, by reading the merged tree for the exact line — never by
offset and never by nearest candidate — and every one now carries an ANCHOR so
the next move is loud.

The measurement, so the claim is checkable: before this pass the document held 49
resolved citations into `routes/discoverySearch.ts`, of which 20 were anchored —
all 20 still resolve, across a 263-line shift — and **29 were unanchored. All 29
were wrong.** After it, every citation into the file is anchored and holds.

| cited row | old pointer (dead) | now | what the old pointer actually named at HEAD |
| --- | --- | --- | --- |
| G31 | line 980 | `routes/discoverySearch.ts:1443#sensitivity_level,` | a bare `);` |
| G62 | lines 107-109 | `routes/discoverySearch.ts:151-153#sanitizeQuery` | three import specifiers |
| G68 | lines 978-980, and `gemSearchPosition` "241-255" | `routes/discoverySearch.ts:1443#sensitivity_level,` + `:286-300#gemSearchPosition` | the hidden-gem blocked/age filter, not the select |
| G70 | lines 622, 724-725, 806-826 | `routes/discoverySearch.ts:727#visibility`, `:899#visibility`, `:900#show_in_discovery`, `:1044-1047#admitted:` | a friendship predicate; a comment; a `tripFit` metadata bag |
| G71 | line 488 | `routes/discoverySearch.ts:584#buddy_verified_at` | a JSDoc line about a cache |
| G73 | lines 1827-1828 | `routes/discoverySearch.ts:2064-2065#COMMON_LANGUAGES` | the city-dedupe loop in `searchCities` |
| G95 | line 1800, in the wrong file | `routes/discoverySearchHelpers.ts:257-262#userCity` | `.eq("is_private", false)` — and see below |
| G101 | line 481 | `routes/discoverySearch.ts:577#is_official,` | a comment about the `type=all` fan-out |
| G126 | lines 806-826, 724-725 | `routes/discoverySearch.ts:1044-1047#admitted:`, `:899#visibility` + `:900#show_in_discovery` | as G70 |
| G129 | line 980 | `routes/discoverySearch.ts:1443#sensitivity_level,` | a bare `);` |
| G180 | line 481 | `routes/discoverySearch.ts:577#is_official,` | as G101 |
| G185 | lines 622, 724-725, 806-826 | `routes/discoverySearch.ts:727#visibility`, `:899#visibility`, `:900#show_in_discovery`, `:1044-1047#admitted:` | as G70 |
| G190 | line 980, and `gemSearchPosition` "241-255" | `routes/discoverySearch.ts:1443#sensitivity_level,` + `:286-300#gemSearchPosition` | as G68 |
| G197 | lines 1827-1828 | `routes/discoverySearch.ts:2064-2065#COMMON_LANGUAGES` | as G73 |
| G220 | lines 1797-1830 | `routes/discoverySearch.ts:2008#dispatchSearch` + `:2020-2057#"travelers":` | the `searchCities` profile select |
| G277 | lines 1664-1685 | `routes/discoverySearch.ts:1893#searchCountries` + `:1895-1896#home_country")` | a `catch { return []; }` |
| G278 | line 1818 | `routes/discoverySearch.ts:2052#searchPlaces` | `let skipped = 0;` |
| G279 | line 1819 | `routes/discoverySearch.ts:2056#searchHiddenGems` + `:286-300#gemSearchPosition` | a `for` header |
| G281 | line 1810 | `routes/discoverySearch.ts:2045#searchTrips` | a fail-closed comment |
| G282 | line 1806 | `routes/discoverySearch.ts:2038#searchEvents` | `.eq("allow_profile_discovery", false)` |
| G283 | lines 1802 and 488 | `routes/discoverySearch.ts:2034#searchTravelers` + `:584#buddy_verified_at` | a `.limit(...)`; a cache JSDoc |
| G337 | lines 107-109 | `routes/discoverySearch.ts:151-153#sanitizeQuery` | as G62 |
| G363 | line 980 | `routes/discoverySearch.ts:1443#sensitivity_level,` | a bare `);` |

**One of those was wrong about the file, not the line.** G95 cited
`discoverySearch.ts` for "applies the city boost in `rankCombined`".
`rankCombined` is defined in `routes/discoverySearchHelpers.ts:227#rankCombined`
and its city tiebreak is `discoverySearchHelpers.ts:257-262#userCity`;
`discoverySearch.ts` only imports and calls it. No mechanical offset could ever
have found that, and §8.3 did not: it re-anchored G95's `gateway.ts` half and
dropped the second half rather than repairing it. The verdict is unaffected —
the boost exists and is applied — but the row now points at the code.

### 10.4 One inventory count corrected

§2's file inventory described `routes/discoverySearch.ts` as "`dispatchSearch` +
all 17 per-type searchers". Hunk 2 makes that 18. The row now says 18 and names
`searchSaved` as the one this layer cannot reach, so the number in §2 and the
seventeen-type claim in G220 no longer look like a contradiction. **This is a
count in a scope table, not a requirement verdict**: no `G` row's bucket changes,
the denominator is still 373, and §8.7's headline is untouched.

### 10.5 Freshness

`head_commit` is **not** re-declared here. This section re-read one file against
`90a515a6..HEAD`; it did not re-measure the other 98 the census cites, and
declaring HEAD would report FRESH about rows nobody reopened — the thing §8.9 and
the header row both refuse. The ledger entry for this census instead names
`since=90a515a6` and carries the argument above per file. The spent
`579694d6` entry, which §9 superseded when it re-declared `head_commit`, is moved
to the ledger's `retired` array rather than deleted, so the two arguments it
carried survive their acknowledgement.

---

## 11. Phase 11 — the Input Intelligence lane

Worked at `7d1f2d498` (PR #483 head + the v2 spec install) in `wt-483`, alongside
six other architecture lanes in the same working tree. **19 rows move W→C or
N→C and one moves N→W**, every one of them by code and a mutation-proven test —
no row in this section moves by re-reading, re-labelling or re-scoping. Where a
row stayed W, N or `?`, this section says what would settle it and who can
supply it, because a gap with no named owner is a gap nobody will close.

### 11.0 What this pass chose, and why

§5 says the programme is good where §51 drew a phase and largely absent where it
did not. §9 worked the phase-scoped `W` column. **This pass deliberately went the
other way**: 11 of its 19 moved rows sit in sections §51 never scoped — §10's
three normalization clauses (§51 scoped §10 only as "the diacritic/trigram DB
work", which is G57's migration and not these), §36's stuffing control, and
seven of §44's declared-never-emitted telemetry arms. That is the half of the
spec §5 says nobody planned for, and it is where the cheap rows were.

Four clusters were built. Every one is ADDITIVE by construction: each new signal
is the identity transform on input that does not trigger it, so no query that
resolves today can change shape because of this pass. That property is asserted,
not assumed — three of the four end-to-end suites carry an explicit CONTROL case
whose only job is to show that two rows are indistinguishable when the new
signal is absent.

### 11.1 Cluster A — the §40 QueryNormalizer, and three §10 clauses (G274, G61, G62, G63)

`lib/inputAssistance/queryNormalizer.ts` is new and is the service §40 names.
Before it, normalization was three unrelated helpers called inline in
`gateway.ts` — Discovery's alias table, Discovery's PostgREST guard, and the
location service's fold — and the client module that wanted the service said so
in a comment. It COMPOSES those three unchanged and adds what was missing:

| clause | producer | proved by |
| --- | --- | --- |
| Transliteration (G61) | `lib/inputAssistance/queryNormalizer.ts:167#export function transliterate` — a curated native-script exonym dictionary (`lib/inputAssistance/queryNormalizer.ts:69#NATIVE_CITY_NAMES`) for Han / Thai / Korean / Japanese / Arabic, plus a per-character Cyrillic / Greek / Thai romanizer that generalises past it | `กรุงเทพ` and `胡志明市` resolve to the stored Bangkok / HCMC rows, display spelling preserved |
| Emoji, per field context (G62) | `lib/inputAssistance/queryNormalizer.ts:225#export function stripEmoji` + `lib/inputAssistance/queryNormalizer.ts:246#export function stripsEmoji` — a picker strips, a caption does not | `"Sky Bar 🔥"` now finds the Sky Bar place; `"#🔥"` now answers with a `validation` row instead of silence |
| Keyboard typo tolerance with a confidence (G63) | `lib/inputAssistance/queryNormalizer.ts:305#export function weightedDistance` (Damerau-Levenshtein, adjacency-weighted through `lib/inputAssistance/queryNormalizer.ts:288#export function keyboardAdjacent`), `lib/inputAssistance/queryNormalizer.ts:339#export function typoConfidence`, `lib/inputAssistance/queryNormalizer.ts:350#APPLY_CONFIDENCE = 0.8` | `"bangkkok"` — not in `SEARCH_ALIASES` — resolves to canonical Bangkok |

**Why the correction is a SECOND attempt and not a rewrite.** The user's own
spelling always gets the first query; `lib/inputAssistance/gateway.ts:400#let correctionHelped = false`
only retries with the corrected key when that returned nothing, and only records
a correction ROW when the retry actually changed the result set. So a query that
resolves today cannot be rerouted, and the row never claims something the
results do not support. Two further refusals are load-bearing: an AMBIGUOUS
input — two vocabulary entries tied at the best distance — produces no
correction in either band (§19 says a tie is offered, never guessed), and an
`@handle` is never corrected at all, because a typo in a handle is a different
person.

### 11.2 Cluster B — §18 feasibility and §16 carryover as a CONSTRAINT (G122, G124, G125, G107, G96)

`filterInfeasibleCandidates` was a real, correct, already-mutation-proven
implementation with exactly one caller. This pass gave §18 its second caller
without giving it a second implementation:
`lib/inputAssistance/creation.ts:167#export function partitionByFeasibility` is
that function's own body, refactored into a three-way partition so a caller can
read the VERDICT rather than the order — which the main pipeline needs, because
it re-ranks by §9 type order afterwards and a reordering would not have
survived. `lib/inputAssistance/taskContext.ts` is new: one bounded, fail-soft
read of the active task
(`lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint`)
and the classification over the request's candidates
(`lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility`).

The verdict reaches ranking as a bounded confidence demotion
(`lib/inputAssistance/rankingSignals.ts:326#export function applyFeasibility`,
`lib/inputAssistance/rankingSignals.ts:320#INFEASIBLE_DEMOTION = 0.22`) plus the
§15 TripFit lift
(`lib/inputAssistance/rankingSignals.ts:337#export function applyTripFit`).
**Demotion, not removal, and the reason is stated rather than hidden**: this
pipeline's evidence is a city string on a projected row, weaker than the
creation flow's, and the privacy gate has already decided what the viewer may
see. §18 permits either action; the weaker evidence chooses the weaker one.

A GEOGRAPHIC row is exempt by construction
(`lib/inputAssistance/taskContext.ts:145#const GEOGRAPHIC_TYPES`) — a city row IS
another city, and a city picker inside a Bangkok Trip must still be able to offer
Da Nang.

### 11.3 Cluster C — two §15 signals that had no producer (G102, G106, G231)

`Diversity` (`lib/inputAssistance/rankingSignals.ts:291#export function applyDiversity`)
is the WITHIN-type term §15 names; the pre-existing per-type fan-out and §13's
reserved slot produce diversity ACROSS types as a side effect of slot
allocation, which is a different thing. `SpamRisk`
(`lib/inputAssistance/rankingSignals.ts:207#export function spamRisk`) is the §15
signal and, on the same code, §36's keyword-stuffing control (G231): repetition
above a prose floor, upper-case ratio, and separator-chained keyword lists,
combined by taking the strongest so a listing is not punished twice for one
habit. Both demote only. Neither can delete a row, and that is deliberate — a
false positive that removes a real venue is far worse than one that costs it two
slots, and this layer has neither the evidence nor the mandate to remove a
listing.

### 11.4 Cluster D — seven §44 events that were declared and never emitted (G311, G313, G314, G315, G316, G317, G318)

Of the fourteen names in `InputTelemetryEventName`, five had a call site. Seven
of the nine that did not now do, all from the REAL `SmartInput`:

| event | call site |
| --- | --- |
| `suggestion_rendered` | `components/SmartInput.tsx:179#emitSuggestionsRendered(telemetryField, suggestions)` |
| `validation_shown` | `components/SmartInput.tsx:181#if (validations > 0) emitValidationShown(telemetryField, validations)` |
| `suggestion_dismissed` | `components/SmartInput.tsx:170#emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur')` and `components/SmartInput.tsx:258#emitSuggestionsDismissed(telemetryField, shownRef.current.count, 'escape')` |
| `manual_value_kept` | `components/SmartInput.tsx:300#emitManualValueKept(telemetryField, value.trim().length)` |
| `raw_search_submitted` | `components/SmartInput.tsx:211#emitRawSearchSubmitted(telemetryField, (s.replacementText ?? value ?? '').length, true)` and `components/SmartInput.tsx:309#emitRawSearchSubmitted(telemetryField, value.trim().length, false)` |
| `correction_accepted` | `components/SmartInput.tsx:208#if (s.type === 'correction') emitCorrectionAccepted(telemetryField, s)` |
| `disambiguation_selected` | `components/SmartInput.tsx:209#if (s.type === 'disambiguation') emitDisambiguationSelected(telemetryField, s)` |

The impression is keyed by the id-SIGNATURE of the rendered list, so a re-render
of the same rows does not inflate the count;
`components/SmartInput.tsx:131#const shownRef` and its companion `acceptedRef`
close an impression so the same list can never land in both the accepted and the
ignored arm, which is the distinction §45's loop is built on. Every payload
carries a COUNT, a TYPE name or a LENGTH and never the text — asserted directly,
because these arms fire on captions and private messages too.

**EMISSION IS NOT MEASUREMENT, and this section does not pretend otherwise.**
The sink is still `() => {}`. In production these seven events are now produced
and dropped. G263, G306 and G355 stay `W` for exactly that reason, and inventing
a transport inside this layer would have been the worse answer, because the only
honest destination is a server endpoint that does not exist yet.

### 11.5 The W71 answer — does voice input exist?

`census-wall.md` W71 asks whether voice input and typo normalization use the same
global engine. The Wall lane proved its half and left this one open. **This lane
re-verified it at this tree rather than inheriting it, and the answer is: voice
input does NOT exist, and nothing in this tree plans it.**

Evidence, re-run here:

- `grep -rniE 'voice|speech|dictat|transcri|microphone'` over
  `artifacts/api-server/src/lib/inputAssistance/` — **exit 1, no match.**
- The same grep over `travel-buddy-standalone/src/platform/input-assistance/` —
  **exit 1, no match.**
- The client package declares no `expo-speech`, no `@react-native-voice/voice`
  and no `SpeechRecognition`. `expo-av` IS present and is a media-playback
  dependency, not a dictation transport.
- Every `voice` match in the client tree is WebRTC **voice calling**
  (`src/components/calls/`, and the events voice-room card)  — a
  different feature, which produces no transcript.
- There is no `voice` / `dictation` `InputContext`
  (`lib/inputAssistance/types.ts:32-61`), no feature flag, no stub, and §51
  scoped no phase for §25.

So the correct reading of W71 is: **the shared engine's typo normalization is
real and proven at the Wall, and there is no voice PRODUCER anywhere to route
through it.** The requirement (G163) is conditional on dictation existing and is
therefore correctly NOT-BUILT — not "wrong", not "partial", and not closable
from this layer. WHAT WOULD TURN IT RED: a dictation surface that hands its
transcript to
`lib/inputAssistance/queryNormalizer.ts:553#export function normalizeQuery` like
any other typed text — which, after §11.1, is a single call rather than a
re-implementation. Nothing else about G163 changes until somebody ships that,
and the Wall's own half needs no revision.

### 11.6 Mutation log — every one applied, watched go red, reverted

A test whose mutation leaves it green is recorded as worthless rather than kept.
Fourteen mutations were run; **all fourteen turned their named suite RED**, and
one weak test was found and rewritten before it was kept.

| # | mutation | suite | result |
| --- | --- | --- | --- |
| 1 | `ADJACENT_SUBSTITUTION_COST` 0.5 → 1 | `src/test/inputAssistanceGeoCore.test.ts` | RED (1) — the keyboard model stops distinguishing an adjacent slip |
| 2 | delete the Thai rows from `NATIVE_CITY_NAMES` | same | RED (2) |
| 3 | delete the `tied` guard in `bestCorrection` | same | RED (1) — an ambiguous input starts being guessed |
| 4 | `stripsEmoji` → always false | same | RED (2) |
| 5 | disable the gateway's typo retry | same | RED (2) |
| 6 | `buildHashtagValidation` → always null | same | RED (1) |
| 7 | `spamRisk` → 0 | `src/test/inputAssistanceRankingSignals.test.ts` | RED (4) |
| 8 | `applyDiversity` → identity | same | RED (1) |
| 9 | `classifyFeasibility` → empty verdict (the pre-change pipeline) | same | RED (3) |
| 10 | `applyTripFit` → identity | same | RED (1) |
| 11 | delete the `emitSuggestionsRendered` call | `components/__tests__/inputTelemetryFunnel.component.test.tsx` | RED (3) |
| 12 | `acceptedRef.current = true` in the render effect | same | RED (1) — accepted and ignored stop being distinguishable |
| 13 | drop the `!acceptedRef.current` guard on blur | same | RED (1) |
| 14 | `scrubProps` returns props unchanged | same | RED (1) |

**The weak test this found, and it is the same failure mode §9.6 warned about.**
The first draft of the §18 Trip-window assertion (G124) passed with mutation 9
applied. The reason was the fixture, not the code: the event search orders by
`starts_at` ascending, so the in-window event led on its own and the assertion
proved nothing. The fixture now seeds the out-of-window event EARLIER than the
in-window one, so the underlying search puts the wrong answer first, and the test
additionally asserts that the winner leads BY CONFIDENCE rather than by input
order. It then reddened under mutation 9. Recorded because §9.6 asked the next
pass to look for exactly this, and it was there.

### 11.7 Rows this lane examined and deliberately did NOT move

Each was opened at this tree and left where it is. The verdict column is
unchanged; what is new is a named blocker and a named owner.

| row | left at | what would turn it red, and who can supply it |
| --- | --- | --- |
| G263, G306, G355 | W | A telemetry POST target (the `routes/` owner — `routes/inputAssistance.ts` is not this lane's file) plus one `setTelemetrySink` call at app bootstrap. Until then nine event names have call sites and no destination. |
| G319 | N | `services/inputTelemetry.ts:253#export function emitActionCompleted` exists and is deliberately uncalled: selecting an action row OPENS a propose-only picker, and calling it "completed" there would make every abandoned picker a success. The global-search screen owner must call it on CONFIRM. |
| G320, G370 | N | `services/inputTelemetry.ts:266#export function emitDownstreamTaskCompleted` exists and has no caller. This layer cannot observe the outcome — the field is long gone when a trip is saved. One call each from `app/trip/new.tsx`, `app/events/create/index.tsx`, `app/telegraph/new.tsx`. |
| G5, G14, G322, G323 | W | All four need an OUTCOME signal to weigh against the acceptance boost. G322 moved N→W this pass because three of its four arms now exist; the fourth is G320 and the calibration step is still absent. |
| G365, G366, G367 | N | Their EVENTS now fire, which corrects the stated evidence on all three. The metrics are still not computed and cannot be until the events land somewhere (G263). Left N rather than moved, because "recorded into a no-op" is not recorded. |
| G163 | N | See §11.5. Voice does not exist. |
| G326 | N | Evidence corrected in the row; verdict stands, because `setAccessibilityFocus` still appears nowhere. Buildable inside this lane's paths and not built this pass. |
| G211 | W | Re-read and confirmed unchanged: `components/SuggestionOverlay.tsx` still renders a plain `ScrollView` with a fixed `maxHeight = 320`. Harmless while `maxSuggestions ≤ 8`, and still not the mechanism §33 asks for. |
| G305 | W | `search/smartActions.ts:35-43` excludes `open_compass` from `DISPATCHABLE_ACTION_TYPES` because the search bar has no dispatch target. Widening that set without also widening the SCREEN's dispatcher switch would create a dead chip, and the screen is not this lane's file — a two-file change needing the search-screen owner. |
| G6, G16, G359 | W | The four unmigrated engines live in `travel-buddy-standalone/src/hooks/` and `src/components/MentionInput.tsx`, outside this lane's paths. A ratchet forbidding a fifth would live in `src/scripts/`, the integration owner's directory. |
| G46, G109, G133, G303, G362 | N / W | Not attempted this pass. Each needs a producer, and for the Telegraph rows a registered field the composer actually mounts. Named here so the next pass need not re-derive the dependency: `share_entity` (G303) is the single missing producer that G133 and G362 both hang off. |

### 11.8 Mis-graded rows found, in both directions

| row | finding |
| --- | --- |
| G326 | **Evidence false, verdict right.** The row asserted that `AccessibilityInfo` and `accessibilityElementsHidden` appear NOWHERE under `platform/input-assistance/`. Both appear: `components/SmartInput.tsx:26#AccessibilityInfo` and `components/EntitySuggestionRow.tsx:82#accessibilityElementsHidden`, both added by §9's own G324/G329 build — so the row was contradicted by a pass that shares this document. The verdict survives on its other sentence (`setAccessibilityFocus` really is absent). Corrected in place. |
| G366, G367 | **Evidence now false, verdict right.** Both said their events "never fire". After §11.4 they do. Both stay `N` because the metric is still not computed, and saying so is the difference between a corrected row and a weakened one. |
| The top-of-document Headline | **Stale by two passes.** It read `230 / 69 / 70 / 4` while §8.7 said `237 / 69 / 63 / 4` and §9.7 said `243 / 63 / 63 / 4`. `check:census-integrity` reads the LAST stated headline, so the guard could not see it. Restated, with a note saying why the guard was blind to it. |
| §5's two tables | **Stale by three passes, now marked so in place.** Not silently patched — see the note there. |

### 11.9 CEILING — what this pass could not do, and the one check that is red around it

**Nothing built here is behind a flag or a migration.** All 19 moved rows are
true on every deployment that runs this code — which is not the same as saying
they are deployed. BUILT ON BRANCH IS NOT MERGED; MERGED IS NOT DEPLOYED;
DEPLOYED IS NOT FLAG-ENABLED. The 16 `☠prod` rows are untouched and none moved.

**A check that was red mid-pass, and is not any more — recorded because the
reason matters.** For part of this pass `pnpm run typecheck:tests` in
`artifacts/api-server` exited 2, and not because of any file in this lane. A
guard added to the shared test-typecheck ratchet script during this wave
correctly refuses to record a baseline when the program contains a TS1xxx
SYNTACTIC error — TypeScript stops before semantic checking for the WHOLE
program when one file will not parse, so every other file would read as
"improved" and `--update` would have written 864 real ceilings down to nothing.
One non-input test file (src/test/geofence.test.ts) carried a duplicate object
key (TS1117). Its owner fixed it and re-recorded the baseline while this lane was
working; the check now passes at **863 diagnostics across 115 files**, and
**every file this lane wrote contributes 0 of them** — measured directly, and
also separately against a scratch project while the parse error was still live.
The standalone package's own ratchet is unchanged at 176 across 61.

**Citation hygiene, because this pass moved lines in three heavily-cited files.**
Editing `gateway.ts`, `projection.ts` and `SmartInput.tsx` shifted 18 distinct
anchored citations elsewhere in this document, which `check:doc-citations`
reported as 42 broken anchors. All 42 were relocated by matching the ORIGINAL
line's content in the new file, and this census now reports **0** broken
anchors. That is the rot an un-anchored `file.ts:NNN` hides: the anchors are
what made the damage visible and fixable at all.

**P25 — what would turn THIS section red?** Any of: `check:census-integrity`
reporting a headline that no longer matches the rows; any of the fourteen
mutations in §11.6 being applied and its named suite staying green; a reader
opening `lib/inputAssistance/gateway.ts:400#let correctionHelped = false` and
finding the corrected key used on the FIRST attempt rather than the second
(which would make G63 destructive and the row wrong); or a reader opening
`components/__tests__/inputTelemetryFunnel.component.test.tsx` and finding it
asserts against the telemetry helpers rather than against the real `SmartInput`
— the exact weakness §9.6 caught in the §46 suite, and the reason every test in
it drives the component.

### 11.10 Restated headline

> | Measure | was (§9.7) | now (§11) |
> | --- | --- | --- |
> | **Denominator — testable requirements** | 373 | **373** |
> | BUILT-AND-CORRECT | 243 | **262** |
> | BUILT-BUT-WRONG | 63 | **55** |
> | NOT-BUILT | 63 | **52** |
> | CANNOT-VERIFY | 4 | **4** |
> | **CONSTRUCTED%** = (C+W)/373 | 82.0 % | **317 / 373 = 85.0 %** |
> | **CORRECT%** (raw) = C/373 | 65.1 % | **262 / 373 = 70.2 %** |
> | **CORRECT% (spec-attributable)** = (C−23ᵖ)/373 | 59.0 % | **239 / 373 = 64.1 %** |
> | **THE GAP** = W/373 | 16.9 % | **55 / 373 = 14.7 %** |
> | CANNOT-VERIFY share | 1.1 % | **4 / 373 = 1.1 %** |

262 + 55 + 52 + 4 = 373, so the four buckets still sum to the denominator.

**Unlike §9, CONSTRUCTED% DOES move here, and by exactly the right amount.**
§9's note — "a pass that closes the correctness gap cannot move it" — is true of
a pass that only fixes `W` rows. This one moved 10 rows out of `N`, which is
construction, so CONSTRUCTED% rises by 10/373 = 2.7 points while CORRECT% rises
by 19/373 = 5.1 points. The 9-point difference is the `W→C` half. Nothing is
counted twice.

None of the 19 carries `ᵖ`: every one rests on a file this lane wrote or a call
site it added, so the spec-attributable count rises by the full 19 and the `ᵖ`
population is still the same 23 §8.3 lists.

### 11.11 Freshness

`head_commit` is **not** re-declared. This pass changed eight counted files, so
this census is correctly STALE against `90a515a6` until somebody re-reads the
rows those files carry. Declaring HEAD here would report FRESH about 350 rows
nobody reopened, which is what §8.9, §9.7 and §10.5 each refused in turn.
`CENSUS_SCOPE` is the integration owner's file and this lane did not edit it.

**A measured note for whoever commits this, because the number moves when they
do.** `check:census-scope-coverage` resolves citations against `git ls-files`, so
this pass's three NEW files are currently UNRESOLVABLE and are skipped from both
sides of the ratio — the check reads 105/106 = 99 % today. Once they are tracked,
two of them (`lib/inputAssistance/queryNormalizer.ts` and
`lib/inputAssistance/taskContext.ts`) resolve INSIDE the
`artifacts/api-server/src/lib/inputAssistance/` directory entry and are watched
automatically, and the third — the new client suite named in §11.6 — resolves to
an unwatched path. That lands at 107/109 = 98.2 %, which clears the 98 % floor
but with almost nothing to spare. **Adding that one client test path to
`CENSUS_SCOPE` takes it to 108/109 = 99 %** and is the right action: a census
must watch the file its evidence names, and that suite is the only proof seven
§44 rows have.

---

## 12. Phase 12 — the serve log, and a `C` the lane asked for that it also argued against

Written by the integration owner after cherry-picking `48ce32e59` and `04796e13b`.
Every OLD verdict was read from `CENSUS_INTEGRITY_DUMP=ALL`, never from this
document's prose — §11.6 and §9.6 both record why.

### 12.1 Three moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **G292** | **N** | **W** | `lib/inputAssistance/telemetry.ts` + `POST /input-assistance/telemetry` + migration 2950. The row's sentence — *"no server-side telemetry service, no serve log, no impression record and no analytics write anywhere in `lib/inputAssistance/`"* — is now false in all four clauses. **`W`, not the `C` the lane proposed: see 12.2.** |
| **G372** | **N** | **W** | *"No latency instrumentation anywhere; the response carries no server timing"* is now half false — `routes/inputAssistance.ts` times the handler and puts `serverMs` on the envelope and in a structured log line. **The P95 itself is computed nowhere**, which is the whole of what the row asks for. |
| **G351** | **N** | **W** | a Step 0 disproof, not a build. *"Zero accessibility tests exist in the layer"* is false at this branch's base: `components/__tests__/suggestionAccessibility.component.test.tsx` is eleven passing assertions, added by `90a515a69` — **the commit this document declares as its own `head_commit`**. One of §46's five named dimensions is certified, so `W`. |

### 12.2 The `C` I did not grant, and the lane's own words for why

The lane proposed **G292 `N → C ☠prod`** and then wrote, in its own report:

> *"`☠prod` is load-bearing: migration 2950 is applied to NO database, not
> production and not `portava-ci`."*
> *"a grader who reads `C` as 'works' should read it as `W`. I would not argue."*

Taking it at its word. **Migration 2950 has never been executed anywhere** — its
`DO $post$` postconditions, including the one asserting that the raw-text CHECK
actually FIRES rather than merely existing, have never run. In production today
the route takes its 503 refusal branch on every call, so the serve log has no
rows and cannot acquire any.

This is the same rule census-discovery §17.2 applies to DV-58/59, census-layover
§22.2 to L110/L112, and census-highlights-memories §K.2 to H219:
**declaring an absence honestly is better than defaulting it, and it is still not
the capability the spec asked for.** Applying it in one census and not another
would make the corpus percentage a function of which lane wrote the row.

### 12.3 VOICE — §25/G163, answered rather than deferred again

**Nothing exists, and the row is correctly `N`.** Re-verified at this branch's
base rather than inherited:

- `grep -rniE 'voice|speech|dictat|transcri|microphone'` over
  `artifacts/api-server/src/lib/inputAssistance/` → **exit 1, no match**.
- the same grep over `travel-buddy-standalone/src/platform/input-assistance/` →
  **exit 1, no match**.
- no `expo-speech`, no `@react-native-voice/voice`, no `SpeechRecognition` in the
  client's `package.json`. `expo-av` is present and is media **playback**.
- every `voice` hit in the client tree is WebRTC **voice calling**, which
  produces no transcript. No `voice`/`dictation` value in `InputContext`, no
  flag, no stub.

**What class of thing would close it: a transcript PRODUCER** — a dictation
surface, a platform speech binding, or a server STT endpoint — that hands its
finished string to `lib/inputAssistance/queryNormalizer.ts#normalizeQuery` and
then into the ordinary gateway, exactly as typed text goes. After Phase 11 the
ROUTING half is one call; the PRODUCER half is an entire unbuilt feature, and
this layer has no microphone.

**A refinement to the framing, offered rather than asserted:** G163 is
*vacuously unsatisfiable* rather than *unbuilt work in the input layer* — it
constrains how a transcript must be routed, GIVEN a transcript. If a future pass
wants a denominator that separates "we failed to build this" from "the
precondition does not exist", G163 belongs with §24's paste rows (G154–G162):
**10 of the 52 `N` rows are in that shape.**

### 12.4 Four stale sentences this document has been contradicting itself with

1. §46's note and **G351** both say *"no accessibility test exists anywhere in
   the layer"* and count *"all 24 test files"*. There are **32**, and one of them
   is named `suggestionAccessibility.component.test.tsx`.
2. **G324** — §46's table still prints `W` and *"selection result is never
   announced"*, while `SmartInput.tsx` calls
   `AccessibilityInfo.announceForAccessibility(selectionAnnouncement(s, applied))`
   — **and this document's own live verdict for G324 is already `C`**, moved at
   §9.3. The §46 table has been contradicted by its own document for two passes.
3. **G329** — same shape: the table prints `W` and says the active row differs
   only by background colour; `EntitySuggestionRow.tsx` renders an `activeSlot`
   caret and the a11y suite's *"strip every colour and the active row is STILL
   distinguishable"* passes. Live verdict already `C`.
4. **Five pointers into `useInputAssistance.ts` were already wrong**, off by 39
   and 47 lines, and invisible to `check:citation-targets` only because they
   happened to land on non-blank lines. **A citation that resolves is not a
   citation that is right** — the same finding the Media lane made about
   `MediaProjectionService.ts` line 379 as it stood then, which was cited three times as
   `readCurrentState` while carrying an unrelated `out.set(id, label)`.

The table verdicts in 2 and 3 are NOT edited here: the rows' live verdicts are
already `C` and a prose table that disagrees with its own document is §16.6's
problem, not a verdict move.

### 12.5 Five of seventeen mutations survived on first run

29 % worthless-test rate on tests the lane had just written and believed in, and
four of the five were the failure §9.6 and §11.6 already warned about: an
assertion running over an empty set, or over a fixture too well-formed to
distinguish the mutation. Two are worth restating:

- **#5, one gate masked another.** An unknown event name is also a name no policy
  declares, so the policy gate refused it first and the vocabulary check could be
  deleted with no test noticing. Its real job is only visible when a policy
  declares a name the §44 vocabulary lacks — the drift that reaches 2950's
  `iate_event_name_known` CHECK and fails the whole batch.
- **#16, the test asserted the mock.** The `serverMs` coercion sat in a module
  that imports the Supabase token helper, so it could only be reached from a
  component test — where the function is a jest mock and the coercion never ran.
  Changing `: undefined` to `: 0` left the suite green.

**A reader should assume any assertion in this repository that has not been
mutated is worth nothing.**

### 12.6 One line, outside every lane's file set, that four rows wait on

`travel-buddy-standalone/app/_layout.tsx`:

```ts
setTelemetrySink(installInputTelemetryTransport().sink);
```

`setTelemetrySink` is still called from **no non-test file**. Both halves of the
transport now exist and `requestId` rides every event, so G263, G306 and G355
each have exactly that one line between them and their evidence — and G365–G370
have it between them and having any data at all. Emission into a batcher nothing
attaches is not measurement.

### 12.7 Tally

> | Measure | was (§11) | now (§12) |
> | --- | --- | --- |
> | **Denominator — testable requirements** | 373 | **373** |
> | BUILT-AND-CORRECT | 262 | **262** |
> | BUILT-BUT-WRONG | 55 | **58** |
> | NOT-BUILT | 52 | **49** |
> | CANNOT-VERIFY | 4 | **4** |
> | **CONSTRUCTED%** = (C+W)/373 | 85.0 % | **320 / 373 = 85.8 %** |
> | **CORRECT%** (raw) = C/373 | 70.2 % | **262 / 373 = 70.2 %** |
> | **THE GAP** = W/373 | 14.7 % | **58 / 373 = 15.5 %** |

**CORRECT does not move and the GAP widens, and both are the honest reading.**
Three things that did not exist now do, so they left `N` — and not one of them
reaches a database, a metric, or a screen reader's full complement, so none
reaches `C`. A pass that built real things and moved the correct-percentage by
zero is what this document looks like when it is not scoring.
