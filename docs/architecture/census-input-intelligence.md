# Portava Global Input Intelligence — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt` |
| **`.docx` reconciliation** | The `.txt` and the `.docx` are **identical** after whitespace/Unicode normalisation. I extracted `word/document.xml`, stripped tags, NFC-normalised and collapsed whitespace on both sides: 508 non-empty lines each, `difflib` diff length **0**. The "`.docx` is authoritative" clause never had to be exercised, and no verdict here rests on a transcription difference. |
| **Section count** | The brief said 59. **It is 58** (`§1 Product Definition` … `§58 Final Architecture Principle`; verified by `grep -nE '^[0-9]+\. '`, which returns 58 headings plus one false positive at line 101 — §9's inline "1. Exact canonical Portava entity…" ranked list). Four sibling censuses found their briefed section counts wrong; this is a fifth. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. |
| `head_commit` | `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
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
| BUILT-AND-CORRECT | **230** |
| BUILT-BUT-WRONG | **69** |
| NOT-BUILT | **70** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **299 / 373 = 80.2 %** |
| **CORRECT%** (raw) = C/373 | **230 / 373 = 61.7 %** |
| **CORRECT% (spec-attributable)** | **207 / 373 = 55.5 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

The headline hides the finding. Split by whether §51 ever scoped a phase for the
section (§5 below): **sections a phase scoped score 90.7 % constructed / 71.4 %
correct over 280 requirements; sections no phase scoped score 48.4 % / 32.3 %
over 93.** The programme executed its plan well; the plan omitted a quarter of
the spec.

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
| `routes/discoverySearch.ts` (Discovery cross-entity search; its header is an OpenAPI contract note, no GII reference) | `dispatchSearch` + all 17 per-type searchers, `matchTier`, `SEARCH_ALIASES`, the fail-closed block/age gate, the `visibility='public'` gates on events/trips/plans, `gemSearchPosition` | G56, G59, G68, G70, G73, G92, G93, G95, G126, G128, G129, G185, G186, G218, G220 |
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

### §1 Product Definition

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G1 | Understand context — know which kind of field is being typed into | C | `lib/inputAssistance/policyRegistry.ts:95-329` maps all 29 contexts; the client resolves a `fieldId` to one at `platform/input-assistance/contexts/fieldRegistry.ts:57-79`. The context is *declared* by the caller, never inferred — which is what §5 asks for. |
| G2 | Assist — return entities, completions, actions, corrections, validations or AI suggestions per field | C | `gateway.ts:146-593` runs every lane: entities `:343-404`, completion `:423`, validation `:411-418`, creation correction/validation `:299-313`, semantic actions `:457-468`, AI `:480-498`. |
| G3 | Structure — convert selected text into canonical ids, time windows, categories, actions, constraints | C | canonical id + timezone binding `geoResolver.ts:70-81`; temporal windows `semanticParser.ts:264-362`; categories `:141-169`; actions `:611-631`. |
| G4 | Protect — apply privacy/block/eligibility/trust/location rules **before** suggestions reach the client | C | `gateway.ts:373-402` fetches the block + age sets and returns nothing when either is null, before any projection; the picker branch repeats it at `:614-619`. |
| G5 | Learn — improve ranking from accepted **and ignored** suggestions and successful **downstream outcomes**, without optimising for typing volume | W | Only the *accepted* arm exists (`personalization.ts:243-268`, driven by `selection_count`). Nothing records an ignore (`suggestion_dismissed` never fires) and no downstream-outcome signal exists anywhere. ☠prod. |

### §2 Non-Negotiable Principles

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G6 | One platform layer; feature teams must not build independent autocomplete engines | W | The layer is real and 10 screens consume it, but four independent engines are still live and unmigrated: `hooks/useSearchSuggestions.ts`, `hooks/useGooglePlacesAutocomplete.ts`, `hooks/usePlaceSearch.ts` and `components/MentionInput.tsx` (its own 200 ms debounce + abort at `:133-198`). No ratchet forbids a fifth — `src/scripts/` has no input-layer check at all. |
| G7 | The field owns behaviour; the platform owns suggestion intelligence | C | `SmartInput.tsx:97` — `assistEnabled` is decided by `policy.mode`, and a `no_assistance` field renders a plain `TextInput`; the server mirrors it at `gateway.ts:153`. |
| G8 | Canonical entities outrank AI guesses | C | `projection.ts:309-320` `TYPE_RANK` — `entity: 0` … `ai_suggestion: 9`, primary sort key at `:333-335`. |
| G9 | AI never silently replaces user text | C | Every AI row is an editable `replace_text` (`aiWriting.ts:259`, `projection.ts:295`); `SmartInput.tsx:112-117` applies `replacementText` only inside an explicit `handleSelect`. |
| G10 | Low-confidence interpretation preserves raw user input | C | `semanticParser.ts:600-607` `shouldProjectStructured` gates on `SEMANTIC_MIN_CONFIDENCE = 0.6` (`:133`); below it the parse adds nothing and the raw query row survives. |
| G11 | Privacy and eligibility filtering occur before projection | C | `gateway.ts:373-402` — the gate runs, then `projectSearchResult`. Fail-closed comment at `:402`. |
| G12 | Live suggestions carry freshness and are never fabricated when live state is unavailable | C | `liveSuggestions.ts:177-223` `buildFreshnessState` returns `null` for an empty envelope list and every label maps from a real claim value; unknown values return `null` (`:120`, `:138`) rather than a default. |
| G13 | Offline mode degrades gracefully and must not present stale data as live | W | The "never stale-as-live" half is exact (`components/freshnessDisplay.ts:53-58` drops the label and keeps only the age). The "degrades gracefully" half has no substrate: `offlinePolicy` is declared per context and **read by nothing** (see G30), and no local dictionary or city index ships. |
| G14 | Suggestions should accelerate real-world outcomes, not increase keystrokes or engagement for its own sake | W | The only learning signal that moves rank *is* acceptance count: `personalization.ts:220-228` scales the boost by `selection_count`. That is optimising for acceptance, which §45 explicitly forbids. No outcome or task-completion signal exists to balance it. |
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
| G29 | `debounceMs` | C | `policyRegistry.ts:86` defaults to 120 ms; consumed at `useInputAssistance.ts:200`. |
| G30 | `offlinePolicy` declares per-field offline degradation | **N** | Declared at `policyRegistry.ts:87` with five values and set deliberately per context (`static_dictionary` on country/language/interest, `cached_local` on the geo pickers) — and **read by nothing on either side**. The client re-declares a *different* taxonomy that is also unread. This is the mechanism §32 depends on, and it is inert. |
| G31 | `privacyClass` classifies the field's privacy posture | **N** | Declared at `policyRegistry.ts:88` and set to `sensitive_location` / `viewer_scoped` / `private_message` on nine contexts (`:203`, `:210`, `:230`, `:236`, `:256`, `:265`, `:272`) — and **read by nothing**. `test/inputPolicyContractParity.test.ts:139` inspects it, but no production path branches on it; the actual sensitive-location protection comes from `discoverySearch.ts:962` and would be identical if this field were deleted. |
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
| G61 | Transliteration where supported | W | What exists is closed-up **Latin** variants (`danang`, `hochiminh`, `phuquoc`) and one romanised name (`krung thep`). There is no script transliteration anywhere — no Cyrillic, CJK, Thai or Arabic → Latin mapping — so a traveller typing `กรุงเทพ` or `胡志明市` resolves nothing, in a product whose launch cities are in Vietnam, Thailand and the Philippines. |
| G62 | Punctuation and emoji handling **appropriate to field context** | W | Field-appropriate punctuation handling does exist for two contexts: the `@`/`#` sigil strip (`gateway.ts:159-161`) and `canonicalizeHashtag` (`socialIdentity.ts:46-50`, `[A-Za-z0-9]{2,64}`). Everything else gets one global strip (`normalizeLocationName:95-99`) plus `sanitizeQuery`, which removes only `(),` (`discoverySearch.ts:106-108`). **Emoji are not handled at all**: they survive `sanitizeQuery` into the `ilike` pattern and match nothing, and `canonicalizeHashtag('#🔥')` returns `null`, so an emoji hashtag silently produces no reference. |
| G63 | Phone/keyboard typo tolerance **where confidence is sufficient** | **N** | No edit-distance, keyboard-adjacency model, trigram index or confidence measure exists (`2220…sql:16-17` notes "`unaccent` is installed but unused, and there is no `pg_trgm`"). The only tolerance is the fixed alias table already counted at G59; a typo not in that table is simply a miss, and no confidence is computed to decide whether to apply one. |
| G64 | Never normalize stored canonical display names destructively | C | `projectCanonicalCity` labels from `row.name`/`row.display_name` (`projection.ts:114`) while folding only the lookup key; `2220…sql:19-22` states the constraint explicitly and adds a generated column rather than rewriting `normalized_name`. |

### §11 Entity Resolution

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G65 | Resolve to canonical entities, not just strings | C | `projection.ts:63-67` (`open_entity` + `entityId`), `:130` (`set_structured_value` + full binding). |
| G66 | City / Country / Neighborhood: aliases, transliterations, geocoding reconciliation, canonical geographic ID | W | Aliases and canonical id are right (`geoResolver.ts:120-145`). **Neighborhood is not resolved at all**: `entityMap.ts:38` maps `neighborhood → 'cities'` with the comment "Phase 1: neighborhoods resolve through the city path", so a `neighborhood_picker` returns cities. Provider/geocoding reconciliation has no implementation in this layer. |
| G67 | Place: canonical Place first, duplicate/alias handling, current operating state where available | W | Canonical-first and duplicate handling are real (`duplicateDetection.ts:281-370`, reusing `isSamePlace`). **Current operating state is absent**: `InputSuggestion` has no open/closed field (`types.ts:206-244`) and nothing computes one. |
| G68 | Hidden Gem: separate identity, protection and approximate-location rules | C ᵖ | `discoverySearch.ts:960-962` selects `sensitivity_level, approx_latitude, approx_longitude` and the exact pair is "deliberately absent"; `gemSearchPosition:241-255` returns `hidden` for a denied or unparseable sensitivity level. Pre-existing Discovery work that the gateway inherits. |
| G69 | User: username/display name, block/privacy filtering, relationship context | C | `socialIdentity.ts:63-116` builds the candidate pool from the viewer's own follows/friends/threads/trip-crew and returns `null` (⇒ no recipients) on any read error; `:154-229` block-filters and account-status-filters on top. |
| G70 | Trip / Event / Plan: viewer eligibility before result exposure | C ᵖ | `discoverySearch.ts:604` (`.eq("visibility","public")` on events), `:706-707` (trips, plus `show_in_discovery`), `:788-808` (plans, gated by the parent trip's visibility and owner status). Proven end-to-end through the gateway by `test/inputAssistanceCertification.test.ts:330-366`. |
| G71 | Buddy: service category, availability, launch/safety/payment eligibility | W | The only gate is `discoverySearch.ts:470` — `.not("buddy_verified_at","is",null)`. No service-category filter, no availability check, and no safety or payment eligibility gate reaches the suggestion path. |
| G72 | Hashtag: canonical normalized hashtag plus visibility rules | C | `socialIdentity.ts:46-50` `canonicalizeHashtag`; the `is_blocked = false` filter at `:319-390` is mutation-proven in `test/inputAssistanceInvariants.test.ts` (item 2). |
| G73 | Language / Interest: controlled dictionaries where possible | C ᵖ | `discoverySearch.ts:1577-1578` — `searchStatic(q, COMMON_LANGUAGES …)` / `COMMON_INTERESTS`, server-side static lists. Pre-existing. |

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
| G95 | `GeographicFit` | C ᵖ | `gateway.ts:380` passes `{lat, lng, userCity}` into `SearchQueryContext`; `discoverySearch.ts:1550` applies the city boost in `rankCombined`. Pre-existing. |
| G96 | `TripFit` | W | Trip context influences only the **zero-character** defaults (`geoResolver.ts:214-250`) and an exact `cityId` match in `applySessionBias` (`gateway.ts:646-659`). A typed query in a Trip gets no Trip-derived rank term. |
| G97 | `TemporalFit` | **N** | The parser computes a real window (`semanticParser.ts:264-362`, ISO bounds), but nothing consumes it as a ranking or filtering input: `gateway.ts:380` constructs `SearchQueryContext` with `{lat, lng, userCity, nearbyIntent}` only — `startsAfter`/`startsBefore`, which `discoverySearch` supports, are never set. The window is projected into a search *string* and thrown away. |
| G98 | `RelationshipFit` | W | Real and load-bearing for recipient search, where the candidate pool **is** the viewer's graph (`socialIdentity.ts:63-116`). Absent everywhere else: `with_crew` / `followed` parse (`semanticParser.ts:418-425`) and then constrain nothing. |
| G99 | `Freshness` | C | `liveSuggestions.ts:75-78` (+0.06 / +0.03), applied before the final rank at `gateway.ts:576-580`. |
| G100 | `PriorSelection` | C | `personalization.ts:243-268`, clamped to `BOOST_CEILING` and restricted to `BOOSTABLE_TYPES` (`:70`), both mutation-proven. ☠prod. |
| G101 | `TrustConfidence` | **N** | No trust term exists. `verified` and `is_official` are selected by `searchTravelers` (`discoverySearch.ts:463`) and then dropped by the projection whitelist (`projection.ts:82-88`); nothing reads them into `confidence`. |
| G102 | `Diversity` | W | There is a per-type fan-out quota (`gateway.ts:379`, `perType = ceil(max/types)`) and a §13 reserved slot for completions (`projection.ts:360-383`), which produce diversity as a side effect of slot allocation. There is no diversity **term** in the score, so within a type a run of near-identical rows is never spread. |
| G103 | `PrivacyRisk` | **N** | Privacy is strictly binary in this system — included or excluded, fail-closed (`gateway.ts:373-378`). Nothing computes a risk weight, so nothing can be *demoted* for privacy risk rather than dropped. |
| G104 | `Staleness` | W | Stale live claims are removed upstream by `readLiveClaimEnvelopes` and simply never appear, and `freshnessDisplay.ts:53-58` drops a stale label. Correct behaviour, but there is no staleness **penalty** in the score: a stale row is not demoted, it is invisible. |
| G105 | `Ambiguity` | C | `projection.ts:117-124` caps an ambiguous city at 0.55 (the MEDIUM band) and `:163` caps an airport disambiguation at 0.5, so ambiguity actively lowers rank confidence. |
| G106 | `SpamRisk` | **N** | No spam signal anywhere in the layer (see §36: five of seven anti-spam controls are missing). |

### §16 Context Carryover and Session State

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G107 | Inputs within the same task share permitted context; a field must not behave as though it exists in isolation | W | The whole of carryover is `applySessionBias` (`gateway.ts:642-659`): a suggestion whose `entityId` **exactly equals** `sessionContext.cityId` is moved to the front. It is not a constraint, it is a reorder, and it only fires when the candidate was already returned. The spec's four carryover examples — Trip stop picker showing Bangkok places first, Event location scoped to the Trip city, Compass carrying Trip context, Gem lookup prioritising Bangkok gems — none is implemented as a candidate constraint. The gateway's own comment concedes it: *"Fuller §16/§17 carryover is deferred"* (`:552-553`). |
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
| G122 | Before ranking, remove or demote infeasible/inappropriate options | W | `filterInfeasibleCandidates` (`creation.ts:148-180`) is a real, correct, mutation-proven implementation — and has **exactly one caller**, `creation.ts:289-292`, applied to duplicate candidates in creation contexts only. The main suggestion pipeline (`gateway.ts:343-404`) never calls it. |
| G123 | Closed or unavailable where current operating status is relevant | **N** | No operating-status field on `InputSuggestion` (`types.ts:206-244`), no producer, no filter. |
| G124 | Outside Trip date/time window | W | `filterInfeasibleCandidates` supports a window (`creation.ts:170-178`) and **no caller passes one** — the single call site passes `{ city }` only (`:291`). The §18 parser that computes windows never reaches it (G97). |
| G125 | Outside selected city/area where the field is constrained | W | Same function, same single call site: it demotes out-of-city **duplicate** candidates in a creation flow (`creation.ts:287-292`). A city-constrained picker's ordinary candidates are not filtered by city. |
| G126 | Age, trust, membership, role or invite restrictions | C ᵖ | Age: `fetchAgeRestrictedSet` fail-closed (`gateway.ts:374-378`). Membership/role: `discoverySearch.ts:788-808` (plans via parent-trip ownership), `:706-707` (trips). Trust/invite have no separate gate but no path exposes an invite-scoped object either. Pre-existing. |
| G127 | Unavailable Buddy category or required safety/payment gate | **N** | See G71 — only `buddy_verified_at IS NOT NULL`; there is no category, availability, safety or payment gate in the suggestion path. |
| G128 | Blocked / private / ineligible people or content | C ᵖ | `gateway.ts:373-378` and `:614-619`, both fail-closed on a null set. Pre-existing `fetchBlockedSet`. |
| G129 | Protected or sensitive locations whose exact position cannot be surfaced | C ᵖ | Structural: `InputSuggestion` has **no coordinate field at all** (`types.ts:206-244`) and `discoverySearch.ts:962` never selects a gem's exact pair. Deep-scanned by `test/inputAssistanceCertification.test.ts:265-327`. |
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
| G163 | Transcribed speech runs through the same normalization/resolution/intent/privacy/suggestion pipeline | **N** | There is no dictation transport in the app: `travel-buddy-standalone/package.json` declares no speech dependency (`expo-speech`, `@react-native-voice/voice`, `SpeechRecognition` all absent) and no source file references one. The requirement is conditional on dictation existing, and nothing routes it. |

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
| G180 | User verification / trust context where appropriate | **N** | `verified` and `is_official` are selected by `searchTravelers` (`discoverySearch.ts:463`) and dropped by the projection whitelist (`projection.ts:82-88`); no suggestion can carry them. |
| G181 | Hidden Gem protection / status labels | **N** | `sensitivity_level` is read to decide the position (`gemSearchPosition:241-255`) and never projected as a label, so a protected gem looks identical to an unprotected one in a suggestion row. |
| G182 | Why this is suggested, when useful | C | `projection.ts:84` copies `matchedReason` into `reason`; the geo defaults set it explicitly (`geoResolver.ts:243-249`), and `EntitySuggestionRow.tsx:76-80` renders it. |

### §29 Privacy and Eligibility Gateway

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G183 | No suggestion is returned merely because it matched text; viewer eligibility is resolved first | C | `gateway.ts:373-402` — the block and age sets are fetched and, when either is `null`, **nothing** is emitted; the comment at `:402` names it as fail-closed. |
| G184 | Blocked users and blocked relationships suppressed | C ᵖ | `fetchBlockedSet` (pre-existing) at `gateway.ts:374`, `:615`; the null-set refusal is the mutation-proven case in `test/inputAssistanceGateway.test.ts`. |
| G185 | Private Trips/Events/Plans excluded unless the viewer is eligible | C ᵖ | `discoverySearch.ts:604`, `:706-707`, `:788-808`. Proven **through the gateway** by `test/inputAssistanceCertification.test.ts:330-366`. |
| G186 | Private captions/tags/metadata never enter public suggestion indexes | C ᵖ | The projection copies a fixed whitelist (`projection.ts:82-88`) and drops `metadata`, `privacyState`, `accessState`, owner/host ids and counts; the searches select public columns only. |
| G187 | Precise private location never leaked through autocomplete | C | Structural — `InputSuggestion` declares no coordinate field (`types.ts:206-244`); the one place a coordinate legitimately travels is the **public city-centre** inside a picker binding (`geoResolver.ts:70-81`). Deep-scanned adversarially at `test/inputAssistanceCertification.test.ts:265-327`. |
| G188 | Presence/location inference cannot be exposed beyond current authorization | C | The only inference path is the live lane, and it consumes nothing but `readLiveClaimEnvelopes` behind `liveLabelsServable` (`liveSuggestions.ts:271-279`), which owns the full IG gate chain. No presence or location-inference source is wired into the gateway at all. |
| G189 | Memory-based suggestions remain owner-scoped unless deliberately shared | C | `personalization.ts:159-180` filters `.eq('user_id', …)` from a session-derived id, never a parameter; `SURFACEABLE_GEO_TYPES` (`:83`) restricts injection to public geo entities so a remembered **person** can never be re-published around the privacy gate — mutation-proven (`test/inputAssistanceInvariants.test.ts`, item 5). ☠prod. |
| G190 | Sensitive-location and protected-place rules applied before projection | W | The **gem** sensitivity rule is applied at source and is real (`discoverySearch.ts:962`, `gemSearchPosition:241-255`). The repo's actual protected-place gate — `lib/protectedLocations.ts`, built for the Map spec §24 — is **never consulted by this path**, and `protected_zones` is absent from production anyway (`scripts/checkProductionDrift.ts:104-117`). A protected zone that is not a hidden gem has no effect on a suggestion. |
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
| G197 | Countries / languages / interests → local static dictionary | **N** | The dictionaries are **server-side** (`discoverySearch.ts:1577-1578`, `COMMON_LANGUAGES` / `COMMON_INTERESTS` behind `searchStatic`). The client ships none: `platform/input-assistance/` contains no country, language or interest list, so an offline country picker returns nothing. |
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
| G205 | Recommended debounce 100–150 ms | C | `policyRegistry.ts:86` defaults `debounceMs` to 120; consumed at `useInputAssistance.ts:200`. |
| G206 | Cancel stale requests | C | `useInputAssistance.ts:157-159` aborts the previous `AbortController` before each fetch; `:211` aborts on unmount. |
| G207 | Use request sequence IDs | C | `services/raceGuard.ts:33-50` is the single shared monotonic guard; `useInputAssistance.ts:153` + `:179` (`if (!guardRef.current.isCurrent(mySeq)) return`). The server independently stamps `requestId` (`routes/inputAssistance.ts:160`, returned at `:179`). |
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
| G217 | Prefer local: request cancellation / state | C | `services/raceGuard.ts`; `useInputAssistance.ts:157`, `:211`. |
| G218 | Prefer server: canonical entity lookup requiring current DB state | C ᵖ | `gateway.ts:343-404` → `dispatchSearch`. |
| G219 | Prefer server: privacy/eligibility filtering | C | `gateway.ts:373-378`, `:614-619` — server-side and fail-closed; the client explicitly does no re-filtering (`hooks/useTelegraphRecipients.ts:15-18`). |
| G220 | Prefer server: cross-entity search | C ᵖ | `entityMap.ts:16-33` (17 types) → `dispatchSearch` (`discoverySearch.ts:1547-1580`). |
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
| G231 | Keyword-stuffing resistance in business / Buddy / user descriptions | **N** | No term-frequency, repetition or stuffing heuristic anywhere in the layer or in the searchers it calls. |
| G232 | Alias abuse detection | **N** | The alias tables (`canonicalLocations.ts:161-192`, `discoverySearchHelpers.ts:63-95`) are curated, static and one-directional; nothing detects a user-supplied alias being abused. |
| G233 | Impersonation protections for people and businesses | W | `account_status` filtering on recipients is real and mutation-proven (`socialIdentity.ts`, `test/inputAssistanceInvariants.test.ts` item 1), and `verified`/`is_official` exist on the profile row. But nothing in the suggestion path **detects or demotes** an impersonating handle, and the verification flags are dropped before projection (G180), so a viewer cannot even tell the real account from the copy. |
| G234 | Duplicate entity suppression | C | `duplicateDetection.ts:241-370`; `gateway.ts:389-400` (per-id dedup across types) and `:534-546` (collapse a duplicate's redundant entity row). |
| G235 | Rate limits on suggestion-affecting submissions | C ᵖ | `routes/inputAssistance.ts:147` (`input_assist_suggest`, 90/min) and `:252` (`input_assist_select`, 60/min), on the pre-existing `lib/rateLimit` buckets. |
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
| G263 | `services/inputTelemetry.ts` | W | The scrub and allowlist are real (`:48-72`), but the sink is `() => {}` (`:35-36`) and `setTelemetrySink` is called from **no non-test file**. The module emits into a void. |
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
| G274 | QueryNormalizer | W | There is no normalizer service: three unrelated helpers are called inline at `gateway.ts:158-167` (`applyAliases` from Discovery, `sanitizeQuery` from Discovery, `normalizeLocationName` from the location service), with the geographic fold living in `canonicalLocations`. The client's own module names the gap: *"Real alias resolution belongs to the server's QueryNormalizer (§40)"* (`services/queryNormalization.ts:12-15`) — which does not exist. |
| G275 | EntitySuggestionService | C | `gateway.ts:601-640` `dispatchAndProject`. |
| G276 | CityResolver | C | `geoResolver.ts:120-145`. |
| G277 | CountryResolver | W | No canonical country resolver: `entityMap.ts:37` maps `country → 'countries'`, and `discoverySearch.ts:1414-1435` `searchCountries` **aggregates `profiles.home_country`** (`.from("profiles").select("id, home_country").ilike("home_country", pat)`). A country picker therefore resolves against the user table, not a canonical country registry, so a country with no users in it does not exist. |
| G278 | PlaceResolver | C ᵖ | `discoverySearch.ts:1568` `searchPlaces`. |
| G279 | HiddenGemResolver | C ᵖ | `discoverySearch.ts:1569` + `gemSearchPosition:241-255`. |
| G280 | UserResolver | C | `socialIdentity.ts:146-229`. |
| G281 | TripResolver | C ᵖ | `discoverySearch.ts:1560`. |
| G282 | EventResolver | C ᵖ | `discoverySearch.ts:1556`. |
| G283 | BuddyResolver | W | `discoverySearch.ts:1552` is `searchTravelers` with `isBuddy`, whose only buddy-specific predicate is `:470` `.not("buddy_verified_at","is",null)`. No category, availability or eligibility resolution (G71, G127). |
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
| G298 | `open_entity` | C | `projection.ts:63-67`; `socialIdentity.ts:219`; `creation.ts:207`. |
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
| G306 | Measure usefulness without unnecessarily capturing raw private text | W | The privacy half is real and mutation-proven (`services/inputTelemetry.ts:48-62` drops `text`/`query`/`rawText`/`message` for a non-capturing field; `services/__tests__/inputTelemetry.test.ts`). The **measurement** half does not exist: the sink is `() => {}` (`:35-36`) and is never attached outside tests, so nothing is measured at all. |
| G307 | `input_opened` | C | `SmartInput.tsx:170`. |
| G308 | `query_length_changed` | C | `useInputAssistance.ts:154`. |
| G309 | `suggestion_request_started` | C | `useInputAssistance.ts:161`. |
| G310 | `suggestion_request_completed` | C | `useInputAssistance.ts:187`. |
| G311 | `suggestion_rendered` | **N** | Named in the taxonomy (`types/fieldPolicy.ts:75`) and in `STANDARD_TELEMETRY` (`policyRegistry.ts:44`); **never emitted** — no call site. |
| G312 | `suggestion_selected` | C | `SmartInput.tsx:104-110`. |
| G313 | `suggestion_dismissed` | **N** | Declared, never emitted. This is the "ignored" arm §45's loop needs. |
| G314 | `raw_search_submitted` | **N** | Declared in the taxonomy and in `STANDARD_TELEMETRY`; never emitted. |
| G315 | `manual_value_kept` | **N** | Declared, never emitted. |
| G316 | `validation_shown` | **N** | Declared, never emitted — even though validation rows are produced and rendered. |
| G317 | `correction_accepted` | **N** | Declared, never emitted. |
| G318 | `disambiguation_selected` | **N** | Declared, never emitted. |
| G319 | `action_completed` | **N** | Declared and listed in `METADATA_ONLY_TELEMETRY` (`policyRegistry.ts:53`); never emitted. |
| G320 | `downstream_task_completed` | **N** | Declared, never emitted. The outcome signal §45 is built on. |
| G321 | For private-message fields, prefer metadata events over raw message text | C | `policyRegistry.ts:51-54` `METADATA_ONLY_TELEMETRY` on `telegraph_message`; `logRawText: false` on every policy (`:40`); `services/inputTelemetry.ts:48-62` enforces the scrub client-side. Certified at `test/inputAssistanceCertification.test.ts:443-476`. |

**Five of fourteen named events fire.** The nine that do not are the entire
outcome half of the taxonomy.

### §45 Learning Loop

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G322 | Suggestion shown → selected/ignored/edited → did the downstream task succeed → rank calibration | **N** | Only the "selected" arm exists. "Shown" (`suggestion_rendered`), "ignored" (`suggestion_dismissed`), "edited" (`manual_value_kept`) and "downstream success" (`downstream_task_completed`) are all declared-and-never-emitted (G311/G313/G315/G320), and there is no calibration step anywhere — `applyPriorSelectionBoost` is a fixed formula over a raw count, not a calibrated model. |
| G323 | Optimize for successful resolution / task completion / appropriate action / real-world outcome; **do not optimize merely for suggestion acceptance rate** | W | The single signal that moves rank is acceptance count: `personalization.ts:220-228` scales `MAX_BOOST` by `selection_count`. That is the named anti-pattern, and there is no outcome signal to weigh against it. |

### §46 Accessibility

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G324 | Screen readers announce field purpose, suggestion count, active suggestion **and selection result** | W | Purpose: `SmartInput.tsx:165` `accessibilityLabel`. Count: `SuggestionOverlay.tsx:78-90`, a polite live region carrying "N suggestions"/"Loading suggestions". Active row: `EntitySuggestionRow.tsx:51` `accessibilityState={{selected}}`. **Selection result is never announced** — `handleSelect` (`SmartInput.tsx:101-127`) emits telemetry, applies the text and closes the overlay with no announcement, so a screen-reader user hears the list disappear and nothing else. |
| G325 | Arrow-key and keyboard navigation on web/desktop | C | `SmartInput.tsx:129-148` — ArrowDown/ArrowUp wrap the active index, Enter selects, Escape clears and blurs. |
| G326 | VoiceOver/TalkBack focus management on mobile | **N** | No `AccessibilityInfo`, `setAccessibilityFocus` or `accessibilityElementsHidden` anywhere under `platform/input-assistance/` (`DisambiguationSheet.tsx:57` `accessibilityViewIsModal` is the only related prop, and it is on an unconsumed sheet). Focus is never moved into the overlay when it opens or back to the field when it closes. |
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
| G336 | Apply authentication and viewer scope before private entity lookup | C | `routes/inputAssistance.ts:101-103` `requireUser` before anything; the user id used downstream is session-derived, never a body parameter (`:167`, `:274`). |
| G337 | Sanitize pasted URLs and untrusted text before rendering | **N** | `sanitizeQuery` (`gateway.ts:163`) is a PostgREST-filter guard that strips only `(),` (`discoverySearch.ts:106-108`) — not a URL sanitizer. No URL parsing, scheme allowlisting or link sanitization exists in the layer, because no paste path exists (§24). Untrusted *AI* text is sanitized (G339); untrusted pasted text is not, because it never arrives. |
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
| G355 | Telemetry — no prohibited raw private-text capture; **action/result linkage works** | W | The prohibition half is certified and mutation-proven (`test/inputAssistanceCertification.test.ts:443-476`; client `services/__tests__/inputTelemetry.test.ts`). The **linkage** half is not: `requestId` is generated per request (`routes/inputAssistance.ts:160`) and `/select` records an entity, but no event carries the `requestId` back, nothing joins an impression to a selection, and `action_completed`/`downstream_task_completed` never fire (G319/G320). Nothing links an action to a result. |

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
| G363 | §55 Hidden Gem Creation: name/location → entity + duplicate search → existing candidates → sensitive-location policy → exact/approximate/pin → confirm → canonical reference | C | Wired end-to-end: `app/gems/submit.tsx:242-244` registers `hidden_gem_name` through `hooks/useCreationAssistance.ts` and renders `CreationAssist` at `app/gems/submit.tsx:274#CreationAssist`; the backend chain is `duplicateDetection.ts:241-370` → `creation.ts:258-296` (constraint filter) → `projectDuplicate:191-215` (`resolve_existing`), with the sensitive-location rule at `discoverySearch.ts:962` and the pin fallback at `validationSuite.ts:305-315`. |
| G364 | §56 Compass Prompt: type "where should" → suggested prompts → current surface + Trip context attached as structured refs → submit → Compass receives intent + permitted entities | C | `app/(tabs)/ai.tsx:60`, `:398-410` wires `compass_prompt` through `useAiWritingAssist` and renders `CompassStarters` + `AiWritingAssist`; the structured refs are attached at `projection.ts:283-303` and `semanticIntent.ts:231-268` (`open_compass` carrying the parse). |

### §57 Product Success Metrics

None of the nine is instrumented. There is no metric emitter, no analytics
transport (G306), and no store any of these could be computed from.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G365 | Time to valid selection | **N** | No timing instrumentation; `input_opened` and `suggestion_selected` both fire, but into a no-op sink with no session correlation. |
| G366 | Valid entity resolution rate | **N** | No denominator is recorded (`suggestion_rendered` never fires). |
| G367 | Manual fallback rate | **N** | `manual_value_kept` and `raw_search_submitted` never fire. |
| G368 | Wrong-selection reversal rate | **N** | No reversal signal exists in the taxonomy or the code. |
| G369 | Duplicate creation prevented | **N** | The duplicate rows are produced (G148, G234) and their acceptance is never recorded — `/select` is the only write and it records no duplicate-resolution outcome. |
| G370 | Downstream task completion | **N** | `downstream_task_completed` never fires (G320). |
| G371 | Privacy incident count must remain zero (explicit certification metric) | **?** | The construction-side guarantees are strong and tested (G183–G191). Whether zero privacy incidents have occurred in production is a fact about production traffic, and there is no incident counter, alert or log in this layer to answer it from. |
| G372 | P95 suggestion latency | **N** | No latency instrumentation anywhere; the response carries no server timing. |
| G373 | Offline completion rate | **N** | No offline instrumentation, and (G197–G201) little offline behaviour to measure. |

---

## 5. Where the gaps actually are

Split the denominator by whether a section was inside the ten migration phases
§51 names, or outside them:

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
