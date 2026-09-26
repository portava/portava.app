# Portava Global Input Intelligence — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt` |
| **`.docx` reconciliation** | The `.txt` and the `.docx` are **identical** after whitespace/Unicode normalisation. I extracted `word/document.xml`, stripped tags, NFC-normalised and collapsed whitespace on both sides: 508 non-empty lines each, `difflib` diff length **0**. The "`.docx` is authoritative" clause never had to be exercised, and no verdict here rests on a transcription difference. |
| **Section count** | The brief said 59. **It is 58** (`§1 Product Definition` … `§58 Final Architecture Principle`; verified by `grep -nE '^[0-9]+\. '`, which returns 58 headings plus one false positive at line 101 — §9's inline "1. Exact canonical Portava entity…" ranked list). Four sibling censuses found their briefed section counts wrong; this is a fifth. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. |
| `head_commit` | `a97bfdac0` — RE-DECLARED 2026-09-16 by **§13**, replacing `1fe72289b`. This is a MEASUREMENT, not a field edit, and it is the first re-declaration in this census made by someone who did not write the work being graded. §13 re-read this census's requirements affected by everything that landed between `1fe72289b` and `a97bfdac0` and moved exactly one: **G277 `W` → `C`**, clause by clause, three of its five clauses being false at this commit and the two that survive not being defects. The headline is restated from the LAST STATED headline (§12.7) rather than the stale top block — C 262→263 · W 58→57 · N 49 · X 4 — and §13 names that top-block drift as an accounting correction rather than quietly fixing it. ONE counted file changed in the acknowledged range (`routes/discoverySearch.ts`) and §13 enumerates its diff as exactly five hunks, all confined to the countries path, which is why this declaration is licensed: the only requirement those hunks could move is the one that was measured. The acknowledgement written against `1fe72289b` is therefore SPENT and has been moved to the `retired` array of CENSUS_STALENESS_ACKNOWLEDGED.json; zero counted files have changed between `a97bfdac0` and HEAD, so no replacement entry is written. It does **NOT** certify the other 262 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482. The previous value was `80a8d655a`, a commit on the pre-merge branch. **The squash made it an orphan**: it still exists in a clone that fetched the branch, but it is on no line of history leading to `main`, and `check:census-freshness` refuses an orphan because the check would pass locally and fail in a fresh clone. Nothing about this census was re-measured and NO verdict moves — `1fe72289b` is the commit its previous declaration's tree became, so zero counted files have changed since it. The prior declaration and its reasoning follow. — RE-DECLARED 2026-09-14 by §12, replacing `90a515a6`. §12 re-derived the rows this branch's Input changes bear on — G292, G372 and G351 moved `N → W`, and §12.2 refuses the `C` the lane proposed for G292 on the grounds the lane itself stated. §12.3 answers §25/G163 (voice) from a re-run grep rather than inheriting it, and §12.4 names four sentences this document had been contradicting itself with. The 22 counted files that changed are that work. It does **NOT** certify the other 259 `C` rows, and §1's reading rule applies unchanged. The previous declaration read: `90a515a6` — RE-DECLARED 2026-09-13 by §9, replacing `579694d6` (itself a §8 re-declaration of `42aeac38`). It **starts a clock; it does not certify a past.** Read the next row before quoting it, and read §9.9 for what this re-declaration is and is not worth. `579694d6` carried no acknowledgement of its own, so nothing was spent to replace it — the only ledger edit §9 makes is to **census-discovery**, whose entry is extended with an argument for the one `lib/inputAssistance/` file this pass changed. |
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
| BUILT-AND-CORRECT | **287** |
| BUILT-BUT-WRONG | **44** |
| NOT-BUILT | **38** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **331 / 373 = 88.7 %** |
| **CORRECT%** (raw) = C/373 | **287 / 373 = 76.9 %** |
| **THE GAP** = W/373 | **44 / 373 = 11.8 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

> **RESTATED 2026-09-21 BY §31**, from the last stated headline (§30.8's
> `281 / 47 / 41 / 4`) plus §31.3's eight moves: five `W → C`, one `N → C`, two
> `N → W`. The spec-attributable line is DROPPED rather than guessed — it needs
> the `ᵖ` count re-derived across all 373 rows, which this pass did not do, and
> a stale derived figure printed beside fresh ones is the precise failure the
> note below is about.

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
   A `from("table")` grep also misses RPC access — `personalization.ts:481` writes
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

> **FACTS 1, 2 AND 3 BELOW ARE SUPERSEDED. See §14.** Migrations 2220, 2221 and
> 2258 were applied to production on 2026-09-21, so `input_selection_history`,
> `input_record_selection`, `canonical_locations.search_key` and the
> `compass_ai_writing_enabled` flag row all now exist there. The reasoning in
> those three facts is still the reasoning and is left standing; the measurement
> is not current. **Facts 4 and 5 are unchanged and still true.** Applying the
> migrations closed no row on its own — §14.5 says why.

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

5. **The telemetry sink IS now attached, and migration 2950 is not applied.**
   *(Restated 2026-09-21. This fact previously read "the telemetry sink is a
   no-op and is never attached … every §44 event the platform emits goes
   nowhere." That was true and is no longer: the default sink is still
   `let sink: TelemetrySink = () => {}`, but `travel-buddy-standalone/app/_layout.tsx` now mounts an
   `InputTelemetrySetup` that calls
   `travel-buddy-standalone/src/platform/input-assistance/services/installInputTelemetry.ts:124#export function installInputTelemetry`
   with the real batched transport, flushes it when the app backgrounds, and is
   ratcheted by a source-scanning assertion in
   `services/__tests__/installInputTelemetry.test.ts` that goes red the day the
   line is deleted.)* What remains is the DESTINATION:
   `2950_input_assistance_telemetry_events.sql` is classified `unapplied` by
   `scripts/checkProductionDrift.ts:615-616`, on production and on portava-ci
   alike. The ingest route answers a failed write with a truthful 503 and the
   client's batcher drops the batch and COUNTS the drop, so today's §44 events
   are produced, transported, refused and counted — a different and better state
   than silently discarded, and still not a measurement. The `☠prod` reason for
   §44 and §57 is therefore **migration 2950**, not the sink.

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
| G5 | Learn — improve ranking from accepted **and ignored** suggestions and successful **downstream outcomes**, without optimising for typing volume | W | The IGNORED arm has a producer — `suggestion_dismissed` fires from `components/SmartInput.tsx:406#emitSuggestionsDismissed` (and again on Escape at `:258`) and is mutation-proven (G313). It still moves NO rank: `personalization.ts:223#boostFor` reads `selection_count` and nothing else, and `personalization.ts:243#applyPriorSelectionBoost` is the only term in the layer that touches a row's confidence from memory. The downstream arm has an emitter and no caller: a repo-wide grep for `services/inputTelemetry.ts:284#emitDownstreamTaskCompleted` outside its own definition returns nothing. NEITHER SIGNAL CAN LAND, for two independent reasons measured rather than assumed: `setTelemetrySink` (`platform/input-assistance/index.ts:184#setTelemetrySink`) is called from two test files and no app file, so every event goes to `() => {}`; and `input_selection_history` plus the `input_record_selection` RPC were re-measured ABSENT from production on 2026-09-21, so the store the boost reads is empty there. WHAT WOULD TURN THIS RED: a ranking term that reads a shown/ignored ratio AND a downstream-outcome write, with the sink attached and the store applied, proven by a test in which an IGNORE demonstrably moves a row's rank. ☠prod. |

### §2 Non-Negotiable Principles

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G6 | One platform layer; feature teams must not build independent autocomplete engines | W | **One of the four named engines is no longer independent.** `hooks/useSearchSuggestions.ts` now runs only as a gated fallback: `hooks/useGlobalSearchSuggestions.ts:150#legacyEnabled` keeps it alive until the gateway has answered once on this mount and again while the gateway reports `unavailable`, which is §38 degradation rather than a second engine. THREE remain live, unmigrated and ungated — `hooks/useGooglePlacesAutocomplete.ts`, `hooks/usePlaceSearch.ts` and `components/MentionInput.tsx` (its own 200 ms debounce and abort at `:195-196`). Nothing forbids a fourth: `artifacts/api-server/src/scripts/` carries over a hundred `check*.ts` ratchets and NOT ONE of them names the input layer (`ls src/scripts \| grep -iE 'input\|assist'` returns nothing). WHAT WOULD TURN THIS RED: those three migrated onto `SmartInput`/`useInputAssistance`, plus a ratchet that fails when a new debounced-fetch typeahead appears outside `platform/input-assistance/`. |
| G7 | The field owns behaviour; the platform owns suggestion intelligence | C | `SmartInput.tsx:97` — `assistEnabled` is decided by `policy.mode`, and a `no_assistance` field renders a plain `TextInput`; the server mirrors it at `gateway.ts:244#policy.mode`. |
| G8 | Canonical entities outrank AI guesses | C | `projection.ts:309-320` `TYPE_RANK` — `entity: 0` … `ai_suggestion: 9`, primary sort key at `:333-335`. |
| G9 | AI never silently replaces user text | C | Every AI row is an editable `replace_text` (`aiWriting.ts:259`, `projection.ts:295`); `SmartInput.tsx:112-117` applies `replacementText` only inside an explicit `handleSelect`. |
| G10 | Low-confidence interpretation preserves raw user input | C | `semanticParser.ts:600-607` `shouldProjectStructured` gates on `SEMANTIC_MIN_CONFIDENCE = 0.6` (`:133`); below it the parse adds nothing and the raw query row survives. |
| G11 | Privacy and eligibility filtering occur before projection | C | `gateway.ts:373-402` — the gate runs, then `projectSearchResult`. Fail-closed comment at `:402`. |
| G12 | Live suggestions carry freshness and are never fabricated when live state is unavailable | C | `liveSuggestions.ts:177-223` `buildFreshnessState` returns `null` for an empty envelope list and every label maps from a real claim value; unknown values return `null` (`:120`, `:138`) rather than a default. |
| G13 | Offline mode degrades gracefully and must not present stale data as live | **C** | *Moved 2026-09-21 on the criterion this cell set for itself, clause by clause.* IT ASKED FOR THREE THINGS. (1) "one consumer that branches on `offlinePolicy` while the device is offline" — `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:396#const mayRetain`, arrived with G340. (2) "a shipped artifact for at least `static_dictionary`" — three of them, plus a compact city index for `cached_local` (`travel-buddy-standalone/src/platform/input-assistance/data/countries.ts:53`, `travel-buddy-standalone/src/platform/input-assistance/data/languages.ts:32`, `travel-buddy-standalone/src/platform/input-assistance/data/interests.ts:21`, `travel-buddy-standalone/src/platform/input-assistance/data/cities.ts:73`; G197/G198). (3) "a test that runs the hook with the network down and gets rows" — `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:142#an OFFLINE country picker returns rows from the shipped dictionary`, with an empty cache and nothing accepted, which is the exact case the previous cell said returned nothing. THE OTHER HALF, "never stale as live", is not merely preserved but extended. The freshness rule is unchanged (`components/freshnessDisplay.ts:55-58#state === 'stale'`). A local row is DISTINGUISHABLE from a server row in the projected result — `source: 'local'` — and carries no `action`, no `entityId`, no `destination`, no `canonicalUri`, no `freshness` and no `confidence`, so it cannot present as a resolution the server never returned (`travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:281#function dictionaryRow`, asserted at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:152#an offline row is marked LOCAL and resolves nothing`; giving the row an `entityId`, an `open_entity` action and `source: 'canonical'` reddens three component cases and two pure ones). A restored device-local row is refused outright if it carries a `freshness` at all, and the retention window is 30 days (`travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts:111#function isRestorableRow`). The shipped tier is reachable ONLY from the `unavailable` arm: a transient error keeps what is on screen (`travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:315#a TRANSIENT error is not offline`) and an online serve is served alone (`travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:277#ONLINE is unchanged`). WHAT IS STILL NOT COVERED BY THIS `C`: no offline behaviour is instrumented, so the rate at which this helps anyone is unmeasured (G373). **AND ONE CLAUSE OF THIS CELL IS WITHDRAWN AS OF 2026-09-22.** It read "`server_required` contexts degrade to NOTHING rather than gracefully, which is the authority's decision and not a defect". The authority's decision is not a defect and it is UNCHANGED — `hooks/useInputAssistance.ts:396#const mayRetain` still drops every retained row for those nine contexts. What was a defect is that the user was shown an unexplained empty panel for it, and, when the screen had supplied §37 fallback actions, was shown THOSE — a search that never happened reported as a search that found nothing, with an offer to create a record. §33 builds the state §27 asks for: `travel-buddy-standalone/src/platform/input-assistance/components/degradedNotice.ts:124#export function degradedNotice` decides one of three degraded sentences and the overlay renders it OUTSIDE the `emptyState` slot (`travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:321#ia-degraded-`). It renders NO row on the `server_required` path, asserted with the rows in the same case (`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/degradedField.component.test.tsx:102#says the field is online-only`), and the `rows` sentence states in as many words that what is on screen was not checked just now, which is this row's other half said in the surface rather than only in a `source` field. |
| G14 | Suggestions should accelerate real-world outcomes, not increase keystrokes or engagement for its own sake | W | Unchanged where it matters: `personalization.ts:223#boostFor` still scales the boost by `selection_count`, and it is still the only signal that moves rank. The COUNTER-signals exist as events (`suggestion_dismissed`, `manual_value_kept`, `raw_search_submitted` — G313/G315/G314), but calling them measurable overstates it: `platform/input-assistance/index.ts:184#setTelemetrySink` has no app-side caller, so every one of them is delivered to `let sink: TelemetrySink = () => {}` and nobody can count them. WHAT WOULD TURN THIS RED: an outcome or task-completion term weighed against the acceptance boost. Who can supply it: whoever owns the screens that COMPLETE the task (Trips / Events / Telegraph), by calling `services/inputTelemetry.ts:284#emitDownstreamTaskCompleted` — after the sink is attached, since until then the call would change nothing observable. |
| G15 | Every accepted suggestion resolves to a valid canonical destination, structured value, or explicit user-approved action | C | `projection.ts:478-493` `isResolvable`/`dropDeadRows` — a row without an action, entity id or routable destination is dropped at the boundary, on every return path in `gateway.ts` (`:273`, `:314`, `:352`, `:385`, `:414`, `:785`). |

### §3 System Placement

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G16 | A single cross-app service, not per-screen implementation | W | **The divergence this row named is gone and the row is restated against what is left.** `routes/inputAssistance.ts:97` is the single endpoint and ten screens reach it, and the search screen no longer runs two engines per keystroke: `hooks/useGlobalSearchSuggestions.ts:150#legacyEnabled` gates the legacy typeahead to the proving window (before the gateway has answered once on this mount) and to `gateway.unavailable`, and `:30-43` records that the duplicate request was retired rather than a second opinion, because both paths call the same `dispatchSearch`. What keeps this at W is the other half of the requirement — "not per-screen implementation". Place entry still has two per-screen implementations that never touch the service (`hooks/useGooglePlacesAutocomplete.ts`, `hooks/usePlaceSearch.ts`) and mentions have a third (`components/MentionInput.tsx`). WHAT WOULD TURN THIS RED: those three routed through `/input-assistance/suggest`, with no screen-local fetch-and-rank left outside `platform/input-assistance/`. |

### §4 End-to-End Input Loop

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G17 | The pipeline runs in the declared order: classify → context → normalise → intent/entity → policy → candidates → privacy → rank/dedupe → projection | C | `gateway.ts:19-21` states the order and `:155-593` implements it in exactly that sequence: normalise `:158-167`, policy gate `:326-330`, candidates `:343-404`, privacy `:373-378`, semantic `:457`, rank `:582-589`, project throughout. The loop's last two stages (OUTCOME TELEMETRY, LEARNING) are scored at §44/§45. |

### §5 Input Context Registry

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G18 | **Every** meaningful text field must register an InputContext | W | Recounted at this commit: **23** field ids across five registrars (`geographic/geoFields.ts:21#GEO_FIELD_IDS` 12, `social/socialFields.ts:29#SOCIAL_FIELD_IDS` 1, `search/searchFields.ts:22#SEARCH_FIELD_IDS` 1, `creation/creationFields.ts:31#CREATION_FIELD_IDS` 4, `compass/compassFields.ts:21#COMPASS_FIELD_IDS` 3 + `:33#AI_WRITING_FIELD_IDS` 2) plus `features/wall/components/WallHeader.tsx:29` — 24 in all, not 21. **The §50 inventory this row said did not exist has since been written**, and it makes the gap larger rather than smaller: `contexts/fieldInventory.ts:33-38` states that of those 24 registered fieldIds only **8 are mounted on a screen**, the other 16 being "registered by a `register*Fields()` call and reached by nothing". Every field behind `MentionInput`, `useGooglePlacesAutocomplete` and `usePlaceSearch` remains unregistered, and `username` — a context the server serves an entire §23 lane for (G147) — is in the inventory at `contexts/fieldInventory.ts:434#offlinePolicy`'s table and is registered by no registrar and mounted by no screen. WHAT WOULD TURN THIS RED: a registration for each unregistered field AND a mount for each registration, i.e. `fieldInventory`'s mounted count equal to its registered count. |
| G19 | The 29-member `InputContext` union | C | `lib/inputAssistance/types.ts:32-61` — 29 members, verbatim and in the spec's order; the client mirrors it at `platform/input-assistance/types/inputContext.ts:42-74`, and `test/inputPolicyContractParity.test.ts:98` asserts the two sets are identical. |

### §6 Field Policy Contract

Fourteen policy members, each naming a distinct enforcement, plus the eight rows
of the field→mode table.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G20 | `mode` gates how aggressively a field assists | C | `gateway.ts:153` (`no_assistance` ⇒ `[]`); `SmartInput.tsx:97`. |
| G21 | `allowedSuggestionTypes` gates which assistance types a field may emit | C | `gateway.ts:170-172`, `:413`, `:423`, `:437`, `:483`, `:587`. |
| G22 | `entityTypes` gates which entity classes are queried | C | `gateway.ts:327-330` — only the policy's declared types reach `entityToSearchType`/`dispatchSearch`. |
| G23 | `allowPersonalization` gates memory read and write | C | Read `gateway.ts:304`; write refused at `personalization.ts:464-466`; there is no client mirror to pin since G340 — the client resolves this member from `GET /input-assistance/policies` and, absent an answer, from a fallback that sets it false (`contexts/policyFallback.ts:158#CONSERVATIVE_POLICY`). |
| G24 | `allowLiveContext` gates the live lane | C | `liveSuggestions.ts:258` — a field that does not declare it gets zero flag reads and zero snapshot reads. |
| G25 | `allowMemoryContext` | **N** | **NOT MOVED. Re-measured on this branch and unchanged:** declared, defaulted, set true on exactly one context (`compass_prompt`), and read by nothing on either side. **WHY IT WAS NOT CLOSED THIS PASS, stated so the next reader does not re-derive it:** unlike `privacyClass` (G31) this member has no existing behaviour to attach to. `privacyClass` closed because three client paths and one server write path were ALREADY branching on a privacy classification and only needed the authority's copy to reach them; `allowMemoryContext` names a retrieval that does not exist — there is no memory-context lane in `gateway.ts` for a policy to gate. Giving it a consumer means building the retrieval first, which is §16/§35 work, not §6 work. **WHAT WOULD TURN THIS RED:** a gateway lane that reads prior-session memory for `compass_prompt`, gated on this member, with a test proving a `false` policy produces zero reads. Inventing a gate over a lane that does not exist would be a second inert member, not a fix. |
| G26 | `allowAI` gates AI assistance | C | `gateway.ts:676`, `:722`; `aiWriting.ts` requires it plus the per-request opt-in plus the flag. |
| G27 | `minChars` | C | `gateway.ts:318-322`; `useInputAssistance.ts:128-136`. |
| G28 | `maxSuggestions` caps the response | C | `routes/inputAssistance.ts:144` (`Math.min(requestedLimit, policy.maxSuggestions)`); `gateway.ts:676`. |
| G29 | `debounceMs` | C | `policyRegistry.ts:86` defaults to 120 ms; consumed at `useInputAssistance.ts:279`. |
| G30 | `offlinePolicy` declares per-field offline degradation | **N** | **NOT MOVED**, and the divergence this row names is now the LAST of its kind in §6: `privacyClass`'s two taxonomies were unified and pinned this pass (G31) and `telemetryPolicy`'s two shapes were unified and pinned (G33), while `offlinePolicy` still has five server values and a different, device-side client vocabulary, both unread. `artifacts/api-server/src/test/inputPolicyContractParity.test.ts` still REPORTS it rather than asserting it, and the reason it gives is the honest one: pinning two vocabularies that mean different things freezes the debt instead of describing it. **WHAT WOULD TURN THIS RED:** §32's substrate — a local dictionary or cached entity index that a field falls back to — plus a reader that picks the fallback by this member. There is no such store on the device today, so this member has nothing to select between. It is the §32 dependency, not a §6 oversight. |
| G31 | `privacyClass` classifies the field's privacy posture | **N** → **C** | **THE ROW'S SENTENCE WAS TRUE OF THIS SIDE AND FALSE OF THE OTHER, AND THE DIFFERENCE WAS A LATENT LEAK.** "Read by nothing" held for the server. On the CLIENT the same member was already gating three things: whether a field's suggestions may live in the process-global cache (`travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts:77#CACHEABLE_PRIVACY_CLASSES` (this pointer named a member of the DENYLIST that used to live here; §21.2 replaced that denylist with an allowlist because it answered "cacheable" for any class it did not recognise, so the anchor is now the allowlist itself — the classification this row grades is unchanged, and the gate reading it is strictly tighter)), whether a select payload carrying the user's raw typed text may be SENT (`services/selectBody.ts`), and what telemetry policy the field derives (`contexts/inputPolicies.ts`). And the two sides were not speaking the same language: the client declared a FOUR-member taxonomy — `public \| personal \| sensitive \| private_message` — of which exactly two members existed here. **Measured before the fix, 14 of 29 contexts disagreed, and two ran the wrong way: `hidden_gem_name` (server `sensitive_location`, client `public`) and `comment` (server `viewer_scoped`, client `public`).** `public` was the client's own condition for capturing raw text into telemetry, so the client's gate said "log the typed text" for a Hidden Gem name and a comment body while the authority said sensitive. Latent only because `setTelemetrySink` is called from no non-test file (§3.5) — the same shape as the `allowPersonalization` finding `d4db6009` made, one member over. FIXED, taking the STRICTER side on both registries and never the looser: one vocabulary (`travel-buddy-standalone/src/platform/input-assistance/types/inputContext.ts`, the server's union verbatim), values no longer duplicated at all — G340 deleted the client's table, so this member is now RESOLVED from the authority rather than compared to it, the vocabulary itself pinned (`artifacts/api-server/src/test/inputPolicyContractParity.test.ts:278#uses ONE privacy vocabulary`), and — the part this row actually asked for — **a server-side reader**: `artifacts/api-server/src/lib/inputAssistance/personalization.ts:473#if (!MEMORABLE_PRIVACY_CLASSES.has(policy.privacyClass))` fail-closes the one write path into `input_selection_history`. That gate is not redundant with `allowPersonalization`: it is the one that holds when `allowPersonalization` is WRONG, and the test drives it with a policy the registry does not contain (personalization-enabled AND sensitive) because that is precisely the combination no fixture built from the live registry can produce. An allowlist, not a denylist, so a member added to `PrivacyClass` tomorrow is refused rather than admitted. Two mutations turn it red. ☠prod applies to the SERVER half only — `input_record_selection` is absent from production (§3.1), so the gate there refuses a write that would already have failed soft; the three client readers run on every device. |
| G32 | `validationRules` declares the field's non-blocking checks | **N** | **NOT MOVED**, re-measured and unchanged: no registry entry sets it and `hooks/useInputValidation.ts` still marks the resolver an unbuilt extension point. **WHY NOT CLOSED:** the §23 validations that exist are hard-wired by context in `creation.ts`, and making them policy-driven is a REWRITE of a working, tested lane — every rule would have to move from a switch into a declared rule with the same semantics, and the §23 rows (G147–G153, another lane's) are the ones that would have to be re-proven afterwards. Declaring rules that the hard-wired path continues to ignore would produce a third inert member rather than a fix. **WHAT WOULD TURN THIS RED:** `creation.ts`'s validation switch replaced by a resolver over `policy.validationRules`, with the §23 suite green against rules declared in the registry — one lane's whole pass, and it belongs with §23 rather than here. |
| G33 | `telemetryPolicy` governs event emission and raw-text capture | **C** | **MOVED `W` → `C` BY THE §48 PASS; the transition now reads in the evidence rather than in the verdict cell.** The cell said `W → **C**`, which is two verdict tokens where `check:census-integrity` can parse one — so this row, `G33`, `G341` and `G343` between them, was counted by a human and invisible to the tool (it reported "3 counted where this tool cannot read" for this census, against 0 before the wave). Re-read at this commit before the cell was rewritten; no verdict is changed by the rewrite. The two shapes are one shape. The client now declares the server's members verbatim — `travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts:81#logRawText: boolean;` and `events` as a plain list — and the `'all'` sentinel is gone, because it had no server counterpart and so a server policy that NARROWED a field's vocabulary could not be expressed on the client at all. Pinned at `artifacts/api-server/src/test/inputPolicyContractParity.test.ts:364#agrees with the server on the SHAPE of telemetryPolicy (census G33)`, which also asserts `captureRawText` survives nowhere in the client contract. **THE RENAME WAS NOT COSMETIC AND THIS IS THE PART WORTH READING.** Two names for one gate is why nothing could compare the two sides on the member that decides whether the user's typed text enters an analytics event — and when they were finally compared they disagreed. The client's derivation read `captureRawText = (privacyClass === 'public')` against the CLIENT's own taxonomy, in which `hidden_gem_name` and `comment` were `public` (see G31). It now derives `logRawText: false` for every class, which is what the server's registry has always said on all 29 contexts, and narrows the event list for `private_message` to mirror `METADATA_ONLY_TELEMETRY` — not the same list with a flag off, the narrowed list. `travel-buddy-standalone/src/platform/input-assistance/contexts/inputPolicies.ts:81#logRawText: false`. The scrub itself is unchanged and still proven policy-driven: its unit test keeps a constructed `logRawText: true` policy on purpose, since a scrubber that dropped everything unconditionally would pass every other assertion in the file. |
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
| G46 | `structured_value` | **N** | Declared in the union (`types.ts:88-98`) and ranked (`projection.ts:411#TYPE_RANK`, `structured_value: 3`) — and **never emitted**. A repo-wide grep for `type: 'structured_value'` returns exactly one hit and it is a test fixture (`services/__tests__/raceAndCache.test.ts:242`); no projector produces the type. The row's second clause needs one correction: the SERVER registry — the one the gateway actually enforces, at `gateway.ts:170-172` — lists it for no context, and the CLIENT registry that used to list it for exactly one context — `interest`, as `['entity','structured_value','recent']` — no longer exists at all: G340 deleted it, so the only surviving declaration is `policyRegistry.ts:373`, which gives it `['entity']`. So the single declaration that the type is allowed sits in the MIRROR, not the authority, and nothing catches that: `inputPolicyContractParity` pins only `allowPersonalization` and says so at `:41-45`. The spec's examples ("Friday 8-11 PM; English; Nightlife interest") have no producer. (The `set_structured_value` *action* is §43 and does exist.) WHAT WOULD TURN THIS RED: a projector emitting the type for a parsed structured value, the SERVER policy admitting it for the contexts that should carry it, and a parity assertion over `allowedSuggestionTypes` so the two registries cannot disagree about it again. |
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
| G53 | The 11-step deterministic default trust order | W | What exists is a 10-value rank over *assistance types* plus a confidence tiebreak (`projection.ts:411#TYPE_RANK`, applied at `:420-423`), which reproduces steps 1, 2, 6, 7, 10 and 11 correctly. (Citations re-resolved at this commit — the file has grown ~87 lines since they were first taken.) Steps 3–5 (task context / Trip context / geographic relevance) are inputs to the underlying search's own ranking, not positions in this order; step 8 (live relevance) is a ±0.06/±0.03 confidence nudge (`liveSuggestions.ts:75#FRESHNESS_BOOST`), not an order position; **step 9 (approved external provider) has no producer at all** — `source: 'provider'` is in the union (`types.ts:301`) and is set on an `InputSuggestion` nowhere in `artifacts/api-server/src` or `platform/input-assistance/` outside two test fixtures. WHAT WOULD TURN THIS RED: the order expressed as an 11-position comparator with steps 3–5 and 8 as positions rather than score nudges, plus a producer for step 9. |
| G54 | AI must never outrank a strong canonical entity match | C | `projection.ts:319` (`ai_suggestion: 9`, last) and the two boost ceilings that keep a nudged row below the exact-match band: `personalization.ts:67` and `liveSuggestions.ts:86`, both `0.985` against `tierConfidence(3) = 0.99` (`projection.ts:35`). Mutation-proven in `test/inputAssistanceInvariants.test.ts`. |

### §10 Query and Text Normalization

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G55 | Unicode normalization and safe whitespace folding | C | `lib/canonicalLocations.ts:90-101` (NFD + collapse); client `services/queryNormalization.ts:38-52`. |
| G56 | Case-insensitive matching | C ᵖ | `routes/discoverySearchHelpers.ts:163-179` `matchTier` lowercases both sides; every DB predicate is `ilike`. Pre-existing Discovery work. |
| G57 | Diacritic-insensitive matching while preserving display spelling | **C** | **CLOSED 2026-09-21 on all three clauses this row wrote for itself, each MEASURED.** The previous entry said what would turn it red: *"2220 applied to production plus a post-apply read showing `search_key` present and a typed \"da nang\" resolving \"Đà Nẵng\" through the stored column, not through the application-side alias table."* **(1) APPLIED.** 2220 reached production on 2026-09-21 at 10:52, rehearsed first on a throwaway PostgreSQL 16. **(2) THE POST-APPLY READ, taken against production rather than inherited from the apply's own postconditions:** `canonical_locations.search_key` is present and `is_generated = ALWAYS` (a STORED column, not a view or a trigger), `input_normalize_city_key` exists, `pg_trgm` is installed, and the table still holds its 31 rows — the three facts this row previously recorded as ABSENT are now all true, and no data was lost. **(3) THE DISCRIMINATION, which is the clause that actually matters.** Production holds two Da Nang rows, and they answer the question by themselves:
&nbsp;&nbsp;• `Da Nang` — `normalized_name` `da nang`, `search_key` `da nang`
&nbsp;&nbsp;• `Thành phố Đà Nẵng` — `normalized_name` **`thanh pho a nang`**, `search_key` **`thanh pho da nang`**
A typed `da nang` matches BOTH through `search_key` and only the first through `normalized_name`. The Vietnamese-spelled row is reachable **only** through the stored fold, because `đ` has no NFD decomposition and the legacy normaliser dropped it entirely — storing a key no user will ever type. That is the exact case 2220's own header cites (`2220_canonical_locations_search_key.sql:9-18`). **AND IT IS NOT THE ALIAS TABLE:** `CITY_GEO_ALIASES` carries no `da nang` entry and `resolveGeoAlias('da nang')` returns `da nang` unchanged, so the key reaching the database is the plain fold and the match can only be the column (`canonicalLocations.ts:714#suggestCanonicalLocationsFolded` queries both columns and tolerates a missing one). **DISPLAY SPELLING IS PRESERVED** — `name` is still `Thành phố Đà Nẵng`; the fold is a KEY, never a rewrite. **EVIDENCE:** four cases in `artifacts/api-server/src/test/canonicalSearchKeyProductionShape.test.ts`, whose fixture is those two production rows verbatim rather than invented, pinning `searchKey()` against what the generated column actually stores and reading 2220 to check the SQL folds the same stroke letters. Mutation-proven three ways: removing `đ`/`Đ` from `STROKE_FOLD` reproduces the production defect exactly and reddens a case; making `searchKey` skip the fold reddens one; removing `đ` from the migration reddens one. **WHAT IS NOT CLAIMED:** that the resolver FUNCTION was executed against production — it cannot be, since production's PostgREST answers 403 to CONNECT from this environment. Its two predicates were run directly against the production database instead, which is what the criterion asks: the function's logic is covered by its own suite, and what was previously unknown was the DATA, which is now measured. |
| G58 | Alias resolution and known abbreviations | C | `canonicalLocations.ts:177-192` `CITY_GEO_ALIASES` — `hcmc`/`saigon`/`sai gon`/`hochiminh` → `ho chi minh`, `danang` → `da nang`, `krung thep` → `bangkok`; applied in application code at `:199-202`, so it works with or without 2220. |
| G59 | Common misspelling tolerance | C ᵖ | `discoverySearchHelpers.ts:63-95` `SEARCH_ALIASES` (~30 curated travel-domain misspellings) plus `canonicalLocations.ts:161-164` (`siargoa`, `nyc`) and `:186` (`phu qouc`, the spec's own example). The bulk is pre-existing Discovery work. |
| G60 | Local-language and English-name variants | C | `canonicalLocations.ts:180-191` — `saigon`, `sai gon`, `krung thep` resolve to the English canonical row. |
| G61 | Transliteration where supported | C | `lib/inputAssistance/queryNormalizer.ts:167#export function transliterate` is the producer. Two mechanisms, because one cannot do both jobs: a curated native-script EXONYM dictionary (`lib/inputAssistance/queryNormalizer.ts:69#NATIVE_CITY_NAMES` — Thai `กรุงเทพ`, Han `胡志明市`, Korean, Japanese, Arabic, Cyrillic) for scripts that carry no phonetic value to romanise from, and a per-character map for Cyrillic / Greek / Thai that generalises past the dictionary. Wired at `lib/inputAssistance/gateway.ts:253#const norm: NormalizedQuery`, so the transliterated form is what candidate generation queries. Proven end-to-end, not just as a unit: `src/test/inputAssistanceGeoCore.test.ts` asserts that `กรุงเทพ` and `胡志明市` resolve to the stored Bangkok / Ho Chi Minh City rows, with the DISPLAY spelling preserved. MUTATION: dropping the Thai rows from `NATIVE_CITY_NAMES` turns both end-to-end tests RED. Latin input is returned byte-identical, so nothing that worked before can change shape. |
| G62 | Punctuation and emoji handling **appropriate to field context** | C | The three pre-existing behaviours stand (the `@`/`#` sigil strip, `canonicalizeHashtag`, `sanitizeQuery`), and the two gaps this row named are closed. **Emoji**: `lib/inputAssistance/queryNormalizer.ts:225#export function stripEmoji` removes pictographs, flags, skin-tone modifiers and joiners from the search key, and `lib/inputAssistance/queryNormalizer.ts:246#export function stripsEmoji` makes it FIELD-CONTEXT-AWARE — a picker strips, a caption / comment / private message does not, because there the characters are the user's prose and not a lookup key. `src/test/inputAssistanceGeoCore.test.ts` proves the behavioural consequence end-to-end: `"Sky Bar 🔥"` now finds the Sky Bar place, where before the emoji rode into `name.ilike.%Sky Bar 🔥%` and matched nothing. **The silent hashtag**: `canonicalizeHashtag('#🔥')` still correctly returns null (the tagging write path is `[A-Za-z0-9]{2,64}`), but the field no longer says nothing about it — `lib/inputAssistance/socialIdentity.ts:67#export function buildHashtagValidation` emits a non-blocking `validation` row naming the unsupported characters, gated by the policy's new `validation` allowance (`lib/inputAssistance/policyRegistry.ts:296#hashtag`, mirrored client-side). MUTATION: forcing `stripsEmoji` false reddens the emoji tests; forcing `buildHashtagValidation` to return null reddens the hashtag test. |
| G63 | Phone/keyboard typo tolerance **where confidence is sufficient** | C | `lib/inputAssistance/queryNormalizer.ts:305#export function weightedDistance` is a Damerau-Levenshtein distance whose substitution cost is KEYBOARD-WEIGHTED: `lib/inputAssistance/queryNormalizer.ts:288#export function keyboardAdjacent` makes a neighbouring-key slip cost `0.5` (`lib/inputAssistance/queryNormalizer.ts:293#ADJACENT_SUBSTITUTION_COST = 0.5`) against `1` for any other swap, and an adjacent transposition `0.6`. `lib/inputAssistance/queryNormalizer.ts:339#export function typoConfidence` turns that into the confidence §10 asks for, and `lib/inputAssistance/queryNormalizer.ts:350#APPLY_CONFIDENCE = 0.8` is the bar. Three properties make it safe to ship: (1) the user's OWN spelling always gets the first query and the corrected key is only a SECOND attempt after that returned nothing (`lib/inputAssistance/gateway.ts:522#let correctionHelped = false`), so nothing that resolves today can be rerouted; (2) an AMBIGUOUS input — two vocabulary entries tied at the best distance — is refused in both bands (`lib/inputAssistance/queryNormalizer.ts:411#export function bestCorrection`), because §19 says a tie is offered, never guessed; (3) an `@handle` is never corrected, since a typo there is a different person. The user-visible half is `lib/inputAssistance/queryNormalizer.ts:607#export function buildTypoCorrectionRow`, a `replace_text` row that shows the raw input back (§2). Proven end-to-end in `src/test/inputAssistanceGeoCore.test.ts`: `"bangkkok"` — which is NOT in `SEARCH_ALIASES` — now resolves to the canonical Bangkok row, and a query that already resolves emits no correction at all. MUTATIONS: `ADJACENT_SUBSTITUTION_COST → 1` reddens the keyboard-model test; deleting the tie guard reddens the ambiguity test; disabling the gateway retry reddens the end-to-end test. |
| G64 | Never normalize stored canonical display names destructively | C | `projectCanonicalCity` labels from `row.name`/`row.display_name` (`projection.ts:114`) while folding only the lookup key; `2220…sql:19-22` states the constraint explicitly and adds a generated column rather than rewriting `normalized_name`. |

### §11 Entity Resolution

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G65 | Resolve to canonical entities, not just strings | C | `projection.ts:125-128` (`open_entity` + `entityId`), `:206` (`set_structured_value` + full binding). |
| G66 | City / Country / Neighborhood: aliases, transliterations, geocoding reconciliation, canonical geographic ID | W | Aliases and canonical id are right (`geoResolver.ts:70#cityBinding` for the id/country/coords/timezone binding; the alias fold is `canonicalLocations.ts:150#searchKey`). **Neighborhood is still not resolved at all**: `entityMap.ts:38#neighborhood` maps it to `'cities'` with the comment "Phase 1: neighborhoods resolve through the city path", so a `neighborhood_picker` returns cities, and `discovery_places.neighborhood` (a free-text column, not an entity) is the only neighborhood datum the search path can see. Provider/geocoding reconciliation has no implementation in this layer — see G153 for the absent provider lane. WHAT WOULD TURN THIS RED: a neighborhood id-space (a `kind` in `canonical_locations` or its own table) with a resolver and a `DispatchSearchType` of its own, so `neighborhood_picker` returns neighborhoods; plus a reconciliation step that decides between a provider record and the canonical one. |
| G67 | Place: canonical Place first, duplicate/alias handling, current operating state where available | W | Canonical-first and duplicate handling are real (`duplicateDetection.ts:268` states the "Canonical Place first" rule and `:440#isSamePlace` reuses the pre-existing decision rather than a second one). **Current operating state is still absent**, and the reason is now named at both ends: `InputSuggestion` (`types.ts:242#InputSuggestion`) has no open/closed field — its only time-ish member is `freshness`, which `liveSuggestions.ts` fills from live CLAIMS, not from opening hours — and the row that would feed it does not exist either, `discovery_places` carrying no hours column of any kind. "Where available" is therefore vacuous today rather than skipped. WHAT WOULD TURN THIS RED: an hours (or live open/closed) source on the place record, a field on the suggestion contract to carry it, and a projector that sets it only when the source actually says so — never a default. |
| G68 | Hidden Gem: separate identity, protection and approximate-location rules | C ᵖ | `discoverySearch.ts:1562#sensitivity_level,` selects `sensitivity_level, approx_latitude, approx_longitude` and the exact pair is "deliberately absent"; `:289-303#gemSearchPosition` returns `hidden` for a denied or unparseable sensitivity level. Pre-existing Discovery work that the gateway inherits. |
| G69 | User: username/display name, block/privacy filtering, relationship context | C | `socialIdentity.ts:63-116` builds the candidate pool from the viewer's own follows/friends/threads/trip-crew and returns `null` (⇒ no recipients) on any read error; `:154-229` block-filters and account-status-filters on top. |
| G70 | Trip / Event / Plan: viewer eligibility before result exposure | C ᵖ | `discoverySearch.ts:739#visibility` (`.eq("visibility","public")` on events), `:920#visibility` + `:921#show_in_discovery` (trips), `:1081-1084#admitted:` (plans, gated by the parent trip's visibility and owner status). Proven end-to-end through the gateway by `test/inputAssistanceCertification.test.ts:330-366`. |
| G71 | Buddy: service category, availability, launch/safety/payment eligibility | W | **The launch leg has since been closed and this row is restated against what is left.** Two gates now run before a buddy can be suggested: `discoverySearch.ts:587#buddy_verified_at` (`.not("buddy_verified_at","is",null)`) and `discoverySearch.ts:575#buddiesWithheldByLaunchGate`, which withholds buddies when the marketplace is not (or cannot be shown to be) launched — both reads fail-closed, and it sits inside `searchTravelers(isBuddy)` so the assistance gateway inherits it through `dispatchSearch`. That gate is itself behind `discovery_buddy_launch_gate_enabled` (migration 2360, seeded FALSE), so **it is inert until someone flips the flag** and today's production behaviour is the verified-only gate alone. Still absent on every path: no service-category filter, no availability check, and no safety or payment eligibility gate. `buddy_service`'s policy (`policyRegistry.ts:256#buddy_service`) declares `entityTypes: ['buddy','activity','interest']` and no filter reads them. WHAT WOULD TURN THIS RED: category and availability predicates on the buddy query, a safety/payment eligibility read, and — for the launch leg to count as live rather than written — `discovery_buddy_launch_gate_enabled` observed ON in production. |
| G72 | Hashtag: canonical normalized hashtag plus visibility rules | C | `socialIdentity.ts:46-50` `canonicalizeHashtag`; the `is_blocked = false` filter at `:319-390` is mutation-proven in `test/inputAssistanceInvariants.test.ts` (item 2). |
| G73 | Language / Interest: controlled dictionaries where possible | C ᵖ | `discoverySearch.ts:2412-2413#COMMON_LANGUAGES` — `searchStatic(q, COMMON_LANGUAGES …)` / `COMMON_INTERESTS`, server-side static lists. Pre-existing. |

### §12 City and Destination Autocomplete

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G74 | Zero-character defaults | C | `geoResolver.ts:180-257` `zeroCharGeoDefaults`; entered at `gateway.ts:194-218`. |
| G75 | Recent destinations | W | The server path exists (`personalization.ts:395#buildSelectionRecents`) but reads `input_selection_history` (`personalization.ts:169`), and the write goes through the `input_record_selection` RPC (`personalization.ts:481`). **Both were re-measured against the live production database on 2026-09-21: the table is ABSENT and the RPC is ABSENT.** Both calls fail soft, so in production this returns an empty memory every time. The client's fallback (`services/suggestionHistory.ts:31-32`) is an in-memory `Map` that its own header says is not the persistent store. A user's recent destinations survive neither a cold start nor a device. ☠prod. WHAT WOULD TURN THIS RED: the migration applied to production AND a recorded selection read back as a recent on a later request — the code is not the missing part. |
| G76 | Current / upcoming Trip relevance | C | `geoResolver.ts:214-250` — the viewer's `trip_members` rows joined to `trips` filtered to `active`/`upcoming`/`planning`, labelled "Current Trip"/"Upcoming Trip". |
| G77 | Aliases | C | See G58. |
| G78 | Airport / city ambiguity handling | C | `geoResolver.ts:128-131` recognises a bare IATA code and `:142` marks the result ambiguous; `projection.ts:148-169` emits it as a `disambiguation` row pointing at the airport's **city**, confidence 0.5, never a silent swap. |
| G79 | Country display | C | `projection.ts:176` — `subtitle` is `region, country`. |
| G80 | Canonical timezone / geography binding after selection | C | `geoResolver.ts:41-81` — `CanonicalCityBinding` carries `cityId`, `country`, `countryCode`, `lat`, `lng` and an IANA `timezone` from `tz-lookup`, degrading to `null` rather than fabricating a zone (`:58-67`). |

### §13 Global Search Suggestions

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G81 | Search suggestions are typed objects | C | `types.ts:206-244`; every projector returns one. |
| G82 | Grouped mixed-entity result (PLACES / EXPERIENCES / PEOPLE / HIDDEN GEMS / SEARCH FOR) | W | Grouping by entity type exists (`components/suggestionGrouping.ts:30#groupSuggestions`, with `recent` routed to its own section at `:37`). **There is still no EXPERIENCES lane**: the spec's "Rooftop nightlife tonight" row is an experience/opportunity object, and no producer emits one. `global_search`'s `entityTypes` (`policyRegistry.ts:130-133`) enumerates fourteen classes and none of them is an experience, `EntityType` itself has no such member (`types.ts`), and `defaultLabelFor` therefore has no such label. The parser knows the concept and cannot act on it: `semanticParser.ts` extracts `experienceQualifiers` and `semanticIntent.ts:175#submit_search` spends them on a refined search STRING rather than an experience row. WHAT WOULD TURN THIS RED: an experience entity class with a producer, admitted by `global_search`'s policy, and a group label for it — proven by a mixed-result test that shows all five sections. |
| G83 | Tapping an entity opens/resolves it; tapping a query completion submits a search | C | `projection.ts:63-67` vs `:224`. |
| G84 | No dead suggestion rows | C | `projection.ts:385-407`, applied on every return path; proven "no dead rows net" in `test/inputAssistanceGlobalSearch.test.ts`. |

### §14 Zero-Character Assistance

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G85 | City picker: current city, recent destinations, upcoming Trip cities | W | Current city and Trip cities are served (`geoResolver.ts:266#export async function zeroCharGeoDefaults`). The recents arm's OLD blocker is gone — `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. **A different blocker WAS what kept this row `W`, and it was not a storage fact.** `city_picker` was mounted on NO screen: the census's own measured field inventory recorded `geo.city` as `UNMOUNTED` with *"Registered only, and registerGeographicFields() is called from no non-test file"*. That sentence is no longer in the file — the row now reads `migrationStatus: MOUNTED` against the Discovery destination bar (`travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:342#city_picker`), and the §50 guard `src/test/inputAssistanceFieldInventory.test.ts:330#recorded as unmounted but a screen names them` is what forced the correction: it went red on the wiring commit because the inventory still claimed unmounted while a screen named the field. Nothing can record on that context and nothing serves its zero-state, so the recents arm is unreachable by construction. WHAT WOULD CLOSE IT: mount the city picker on a real screen through `useInputAssistance`, wire its accept handler to a recorder (the §35 writer-coverage guard then enforces it automatically), and assert the round trip as `src/test/inputAssistancePersonalization.test.ts:523#records the pick, and the NEXT request` does for the recipient path. That needs an app host, not a database. **THE BLOCKER THIS ROW NAMED IS GONE; THE VERDICT IS NOT, AND THE DIFFERENCE MATTERS.** The row's blocker was that `city_picker` was a registered CONTEXT no screen in the app ever mounted — §50's field inventory recorded `geo.city` as UNMOUNTED, and `registerGeographicFields()` was called from no non-test file, so every geographic surface resolved a default policy instead of its registered one. Both halves are fixed by WIRING WHAT ALREADY EXISTED rather than building anything: `src/components/discovery/DestinationBar.tsx` — titled "Search destination", prompting for "City, island or region", and mounted in Discovery — IS the city picker, and it declared no assist context at all, so `GlobalPlacePicker` fell back to the `__geo_no_assist__` fieldId and the platform was off for it entirely. It now declares `assistContext="city_picker"` and the canonical `GEO_FIELD_IDS.cityPicker`, and `app/_layout.tsx` mounts a `GeographicFieldsSetup` that calls the idempotent registrar at boot. The recorder call site was already there and is already enforced — `GlobalPlacePicker` calls `recordSuggestionSelection` on select, and `selectionWriterCoverage.test.ts` fails any accept handler that stops. The policy permits what the row needs, read from the descriptor rather than assumed: `allowPersonalization: true`, `zeroStateAssistance: true`, `privacyClass: 'public'`. Three assertions in `travel-buddy-standalone/src/components/discovery/__tests__/DestinationBar.cityPicker.test.ts` pin it, and removing either wiring reddens its own one. **WHY IT IS STILL `W`:** `input_selection_history` reached production at 10:52 and the surface is wired, but nobody has observed a pick recorded and re-surfaced. That is the same wall as `G306` and it is named the same way — the deployed host is unreachable from the environment this was written in (the egress gateway answers 403 to CONNECT for it), so the round trip is unobserved rather than absent. Closing this on the wiring alone would be the "code exists with a production-unavailable note" move the owner's rule forbids. TURNS GREEN WHEN: a pick made in the Discovery destination picker lands a row in `input_selection_history` and comes back as a zero-character recent, observed on a running deployment. |
| G86 | Place picker: nearby places, recent places, Trip places, saved places | W | **One of the four place-level sources now exists.** `lib/inputAssistance/savedEntities.ts:85#export async function buildSavedPlaceSuggestions` reads the viewer's OWN `discovery_place_saves` rows against `status = 'active'` canonical places and offers them at zero characters, wired into the geo-picker branch at `lib/inputAssistance/gateway.ts:342#buildSavedPlaceSuggestions`. It is gated on the POLICY's own entity types (`savedEntities.ts:98#includes('place')`), so `city_picker` is byte-identical, and it joins the author-side block funnel (`savedEntities.ts:143#submitterIsVisible`) rather than becoming the next reader of `discovery_places` that skipped it. Proven end-to-end in `src/test/inputAssistanceSavedEntities.test.ts:177#offers the viewer's saved place`, with a no-saves control. Unlike every other §35 arm this one reads a table production HAS, so it is NOT `☠prod`. STILL MISSING, which is why this is `W` and not `C`: no nearby-place query, no place recents, no Trip-place list — `place_picker`'s zero-state is otherwise still `zeroCharGeoDefaults`' **cities** (`geoResolver.ts:266#export async function zeroCharGeoDefaults`). |
| G87 | Telegraph recipient: recent conversations, Trip Crew, relevant requests | C | `socialIdentity.ts:63-116` unions recent thread partners, trip crew, follows and friends; `social/socialFields.ts:41-43` overrides `minChars` to 0 so the picker opens populated; `gateway.ts:258-270` takes the context over before the minChars gate. |
| G88 | Compass prompt: contextual starter prompts based on current surface | C | `projection.ts:258-304` — city- and trip-tailored starters ahead of the generic four, each carrying a coarse `{surface, city, cityId, tripId}` structured payload. |
| G89 | Global Search: recent searches, around-you-now, current Trip, Saved | W | **Two of the four arms now fire.** SAVED: `lib/inputAssistance/gateway.ts:342#buildSavedPlaceSuggestions` offers the viewer's saved places at zero characters for `global_search`, whose policy names `place` (`src/test/inputAssistanceSavedEntities.test.ts:193#offers it in global_search`). RECENT SEARCHES: the branch reads `input_selection_history`, which reached production on 2026-09-21, and `global_search` is the one context with BOTH a mounted consumer and a recorder (`hooks/useGlobalSearchSuggestions.ts`, `recordPick`) — so unlike G85's `city_picker` this arm is reachable. STILL MISSING, and the reason this stays `W`: there is no around-you-now and no current-Trip zero-state for `global_search`. Neither needs storage; both need a query this layer does not issue. |
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
| G97 | `TemporalFit` | C | **This row had already been moved by §8.4 and the move was never written back here — the two statements have been contradicting each other since Phase 9.** Re-derived, not inherited. The parsed ISO window is resolved once per request at `lib/inputAssistance/gateway.ts:272#const temporalWindow` and handed to the projection, where `lib/inputAssistance/rankingSignals.ts:104#export function applyTemporalFit` boosts a row starting inside it and demotes one starting outside, clamped by `lib/inputAssistance/rankingSignals.ts:59#export const SIGNAL_CEILING`. A ranking term, deliberately NOT the hard `startsAfter`/`startsBefore` filter this row used to ask for: `extractTemporal` fires on every weekday name, so a filter would DELETE "Saturday Night Market". MUTATION: forcing `temporalWindow` to `null` in the gateway reddens the end-to-end assertion in `src/test/inputAssistanceRankingSignals.test.ts:403#an event inside the parsed window` — applied and watched go RED this pass, together with its no-time-operator control. |
| G98 | `RelationshipFit` | W | Real and load-bearing for recipient search, where the candidate pool **is** the viewer's graph (`socialIdentity.ts:63-116`). Absent everywhere else: `with_crew` / `followed` parse (`semanticParser.ts:418-425`) and then constrain nothing. |
| G99 | `Freshness` | C | `liveSuggestions.ts:75-78` (+0.06 / +0.03), applied before the final rank at `gateway.ts:576-580`. |
| G100 | `PriorSelection` | C | `personalization.ts:243-268`, clamped to `BOOST_CEILING` and restricted to `BOOSTABLE_TYPES` (`:70`), both mutation-proven. `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. The term also reaches a path it used to miss: the `telegraph_recipient` branch is a full TAKEOVER that returned before the generic boost, so a recorded recipient pick fed nothing. It now applies inside that branch (`lib/inputAssistance/gateway.ts:426#const boostedRecips`), over the list the §47/§54 eligibility gate already produced — it REORDERS and adds nobody, asserted at `src/test/inputAssistancePersonalization.test.ts:557#adds NOBODY`. MUTATION: returning `recips` unmodified reddens the round-trip assertion. |
| G101 | `TrustConfidence` | C | **This row had already been moved by §8.4 and the move was never written back here** — same Phase-9 contradiction as G97. Re-derived: `verified` and `is_official` are selected by `searchTravelers` (`routes/discoverySearch.ts:180#verified?:`) and are now read into `confidence` by `lib/inputAssistance/rankingSignals.ts:130#export function applyTrustConfidence`, applied in the projection's signal stack at `lib/inputAssistance/projection.ts:106#applyTrustConfidence`. Official weighs above verified, both clamped by `rankingSignals.ts:59#export const SIGNAL_CEILING` strictly below the exact-match band, so §9's trust order holds and an unverified row is byte-identical. MUTATION: removing the `applyTrustConfidence` call from the stack reddens two assertions in `src/test/inputAssistanceRankingSignals.test.ts:263#a verified prefix match outranks` — applied and watched go RED this pass. |
| G102 | `Diversity` | C | `lib/inputAssistance/rankingSignals.ts:291#export function applyDiversity` is the within-type term. Each successive row repeating an already-seen display signature (`lib/inputAssistance/rankingSignals.ts:276#export function diversitySignature` — label + subtitle, article-stripped, alphanumeric-folded) loses `lib/inputAssistance/rankingSignals.ts:266#DIVERSITY_STEP = 0.04`, capped. Applied before the final rank at `lib/inputAssistance/gateway.ts:853#const diversified = applyDiversity`. It compares only against EARLIER rows of the same assistance type, so §9's type order is untouched, and it demotes rather than removes, because two real venues can share a name. The pre-existing per-type fan-out and the §13 reserved slot still do what they did; what is new is that a run of near-identical rows within one type is now spread. Proven in `src/test/inputAssistanceRankingSignals.test.ts` (progressive penalty, cap, cross-type non-interference, and byte-identity on a list with no repeats). MUTATION: returning `rows` unchanged from `applyDiversity` turns it RED. |
| G103 | `PrivacyRisk` | **N** | Privacy is strictly binary in this system — included or excluded, fail-closed (`gateway.ts:373-378`). Nothing computes a risk weight, so nothing can be *demoted* for privacy risk rather than dropped. |
| G104 | `Staleness` | W | Stale live claims are removed upstream by `readLiveClaimEnvelopes` and simply never appear, and `freshnessDisplay.ts:53-58` drops a stale label. Correct behaviour, but there is no staleness **penalty** in the score: a stale row is not demoted, it is invisible. |
| G105 | `Ambiguity` | C | `projection.ts:117-124` caps an ambiguous city at 0.55 (the MEDIUM band) and `:163` caps an airport disambiguation at 0.5, so ambiguity actively lowers rank confidence. |
| G106 | `SpamRisk` | C | `lib/inputAssistance/rankingSignals.ts:207#export function spamRisk` computes the signal from a row's own user-authored display text, as the strongest of three bounded stuffing measures — token REPETITION above a prose floor, SHOUTING (upper-case ratio over a minimum length), and SEPARATOR CHAINS (`tours \| bangkok \| cheap \| best`) — and `lib/inputAssistance/rankingSignals.ts:243#export function applySpamRisk` subtracts it, capped, inside `projection.ts`'s signal stack. Demotion-only by design: stuffing is a ranking problem, not a moderation verdict, and this layer has neither the evidence nor the mandate to delete a listing. A clean row scores exactly 0 and is byte-identical to its pre-signal confidence. Proven in `src/test/inputAssistanceRankingSignals.test.ts` as a unit AND end-to-end — a stuffed `discovery_places` row seeded FIRST loses to a clean one on the same query, and both are still returned. MUTATION: `spamRisk → 0` turns four assertions RED. |

### §16 Context Carryover and Session State

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G107 | Inputs within the same task share permitted context; a field must not behave as though it exists in isolation | C | Carryover is now a CANDIDATE CONSTRAINT, not only a reorder. `lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint` reads the active task ONCE per request — the session's canonical city and the Trip's destination + date window — and `lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility` classifies every candidate against it, delegating the rule WHOLE to `lib/inputAssistance/creation.ts:181#export function partitionByFeasibility` so §18 has one implementation and not two. The verdict reaches ranking as a confidence demotion (`lib/inputAssistance/rankingSignals.ts:326#export function applyFeasibility`) plus the §15 TripFit lift, wired at `lib/inputAssistance/gateway.ts:299#const taskConstraint: TaskConstraint =` and applied in both dispatch branches. Three of the spec's four carryover examples are now mechanical: a Trip stop picker shows the Trip city's places first, an Event location is scoped toward the Trip city, and a Gem lookup prioritises the Trip city's gems. `applySessionBias` remains on top as the exact-`cityId` pin. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`, with a no-Trip control asserting the two rows are otherwise indistinguishable. MUTATION: short-circuiting `classifyFeasibility` reddens three tests. A session carrying no task issues no query and is the identity transform. |
| G108 | Carryover bounded to the active task/session; must not silently change unrelated persistent preferences | C | `applySessionBias` is a pure, request-scoped function over an in-memory array; `parseSessionContext` (`routes/inputAssistance.ts:52-59`) bounds and drops everything else. The only persistent write in the whole layer is the explicit `POST /select` (`:216-284`), which writes selection memory and nothing else. |

### §17 Cross-Field Dependency Graph

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G109 | Selecting a structured field prefills dependents (Venue → City / Country / Coordinates / Timezone) | **C** | **CLOSED 2026-09-21 on the criterion this row wrote for itself.** The previous entry named the gap exactly — *"a `CanonicalVenueBinding` carried on place rows in picker contexts, resolving country through `canonical_location_id` and the timezone through the same `timezoneForCoords`, with a test that selects a venue and reads all four"* — and that is what was built, in the three places the gap actually sat. **(1) THE BINDING.** `venueBinding` (`artifacts/api-server/src/lib/inputAssistance/geoResolver.ts:147#export function venueBinding`) produces the §17 value beside the city one, under three rules each of which exists because its opposite would put a FALSE value in a dependent field the user can see: the coordinates are the VENUE's and never the city centroid (a substituted centroid silently moves the map pin to the middle of town); the timezone is derived from those same venue coordinates through the existing `timezoneForCoords`, so the city and venue paths cannot disagree about one point on the map; and the country is NEVER inferred from the city name — it comes off the linked `canonical_locations` row or it stays null, because "Springfield" names places in dozens of countries. `CITY_KINDS` admits `city`/`town`/`municipality` only, so a venue linked to a LANDMARK gets that row's country (a true fact about where it is) and no `cityId` (putting "Dragon Bridge" in a field labelled City would be a visible lie). **(2) THE READ, BATCHED AND FAIL-CLOSED.** The country lives on `canonical_locations`, not on `discovery_places`, so the pure projector cannot fetch it; `resolveVenueBindings` (`gateway.ts:144#export async function resolveVenueBindings`) does it ONCE per request over the deduped link ids, and only for `GEO_PICKER_CONTEXTS` — `global_search` is a navigation surface where a row opens an entity page and fills nothing, so binding it would ship a structured value with no consumer. **A place with no canonical link and a place whose canonical read FAILED are treated differently, and that is the point**: the first binds with `country: null`, which is true of it; the second gets NO binding at all, because §17 prefills from this value and an outage rendered as `country: null` would write "this venue is in no country" into a visible field. Absent prefill is a smaller harm than wrong prefill. **(3) THE ATTACHMENT.** `projection.ts:148#if (signals.venueBinding) suggestion.structuredValue = signals.venueBinding;` — set only when a binding exists, so a row without one carries no key. **EVIDENCE:** nine cases in `artifacts/api-server/src/test/inputAssistanceVenueBinding.test.ts`, mutation-proven six ways, each reverted after: venue coords → city centroid reddens 2; country → always null reddens 3; `CITY_KINDS` gains `landmark` reddens 1; timezone falling back to city coords reddens 1; swallowing the failed read reddens 1; dropping the link-id dedupe reddens 1. The regression set around the changed files runs 166/166. **WHAT IS STILL NOT CLAIMED:** that a user has seen a venue selection fill four fields on a running deployment. This row is closed on the SERVER contract — what the gateway emits for a picker selection — which is what its criterion names; the client's rendering of a `structuredValue` is G46's subject and is unchanged here. |
| G110 | Autofilled fields remain visible, attributable and editable; no invisible field mutation | C | Mutation happens only inside an explicit `handleSelect` (`SmartInput.tsx:112-117`) and only through the caller's own `onChangeText` into an editable `TextInput`; the binding is handed up as `structuredValue` for the screen to render. Nothing writes a field the user did not tap. (Note: the *visibility* and *attribution* halves are the consuming screen's responsibility and the platform enforces neither.) |

### §18 Semantic Query Parsing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G111 | Natural language becomes structured intent when confidence is sufficient | C | `semanticParser.ts:525-589` `parseSemanticIntent` produces a full `ParsedIntent` (category, qualifiers, temporal window, relationship, anchor, stages, confidence); the §19 gate is `:600-607`. Deterministic — a rule + dictionary parser, no model. |
| G112 | Temporal operators: tonight; tomorrow morning; Friday after dinner; in two hours; when we arrive | C | `semanticParser.ts:264-362` — all five forms: `on_arrival` `:270-278`, `in N hours` `:279-299`, `tomorrow <part>` `:300-316`, weekday + time-of-day `:317-345`, and the classic four via the existing tz-aware window parser `:346-362`. |
| G113 | Geographic operators: near me; near my hotel; between us; along the way; close to airport | C | `semanticParser.ts:382-450` — hotel/airport/meeting-point/here anchors `:383-400`, `between us`/`halfway` `:409-411`, `along the way`/`on the way` `:412-415`, plus a generic `near <place text>` fallback `:436-450`. |
| G114 | Experience operators: quiet; social; luxury; cheap; local; hidden; busy; romantic; high energy | C | All nine are canonical slugs at `semanticParser.ts:39-49` with match rules at `:171-189`. |
| G115 | Sequence operators: then; after; before; on the way; next | C | **Restated from W: §9.3 recorded this move and the row itself was never updated, so the document contradicted itself for two passes.** Re-verified at this commit, not inherited. `semanticParser.ts:512#SEQUENCE_SPLIT_RE` covers `and then`/`then`/`after that`/`afterwards`/`followed by`/`next`/`before` AND splices in `ALONG_RE`'s alternatives from the one regex (`:378#ALONG_RE`) rather than retyping them, so the two readings cannot drift. `semanticParser.ts:431#ALONG_RE` records the `along` relationship WITHOUT `strip`ping the phrase, which is what leaves it for the splitter. All six operators fire. Proven at `artifacts/api-server/src/test/inputAssistanceSemanticIntent.test.ts:322#on the way` — *"food on the way to the club"* is two stages and still `along` — and at `:345#splitSequence`. Nothing gates this: no flag, no migration, no table. |
| G116 | Relationship operators: with my Trip Crew; people I follow; near our meeting point | W | All three parse — `semanticParser.ts:435#with_crew`, `:439#followed`, `:449#meeting_point` (citations re-resolved at this commit) — and then constrain nothing. `semanticIntent.ts:175#submit_search` projects the parse into a search **string**; no candidate query is filtered by crew membership, follow graph or meeting point, and the `SearchQueryContext` the gateway hands to `dispatchSearch` (`gateway.ts:404`, `:585`, `:908`) carries only `{ lat, lng, userCity, nearbyIntent }` — there is no field for any of the three to occupy. WHAT WOULD TURN THIS RED: crew/follow/meeting-point members on `SearchQueryContext`, honoured by the search path, with the privacy gates unchanged — a crew or follow filter reads someone else's graph, so it must stay inside the viewer's own edges the way `socialIdentity.ts` already scopes recipient search (§47). |

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
| G122 | Before ranking, remove or demote infeasible/inappropriate options | C | The rule now has its second caller. `lib/inputAssistance/creation.ts:181#export function partitionByFeasibility` is `filterInfeasibleCandidates`' own body, refactored into a three-way partition so a caller can read the VERDICT rather than the order — the main pipeline re-ranks by §9 type order afterwards, so a reordering would not have survived. `lib/inputAssistance/taskContext.ts:176#export function classifyFeasibility` is that caller, and `lib/inputAssistance/gateway.ts:608#const verdict = classifyFeasibility(allCandidates, taskConstraint)` runs it over the whole request's candidates before projection. The action is a bounded confidence DEMOTION (`lib/inputAssistance/rankingSignals.ts:320#INFEASIBLE_DEMOTION = 0.22`), not removal: this pipeline's evidence is a city string on a projected row, weaker than the creation flow's, and the privacy gate has already decided what the viewer may see. §18 permits either; the weaker evidence chooses the weaker action, and that choice is stated rather than hidden. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`. MUTATION: short-circuiting `classifyFeasibility` turns three tests RED. |
| G123 | Closed or unavailable where current operating status is relevant | **N** | **NOT MOVED. The blocker is a missing SUBSTRATE, not a missing rule.** Re-measured on this branch: `InputSuggestion` still carries no operating-status field, and a repo-wide search across `lib/inputAssistance/` for an opening-hours or open-now signal returns only `aiWriting.ts`'s instruction *not to invent* opening hours and `semanticParser.ts`'s unrelated `in_hours` time offset. The §20 demotion machinery that G122/G124/G125 close on is already generic — `taskContext.ts#classifyFeasibility` takes a constraint and returns a verdict — so this row needs no new rule; it needs a column. **WHAT WOULD TURN THIS RED:** a `places`/`events` operating-hours source read at candidate time, projected onto the row, and a feasibility term over it with a fixture where a closed place is demoted and an open one is not. The data is not in this repo's suggestion path, and fabricating a status would be the one thing §31 forbids outright. |
| G124 | Outside Trip date/time window | C | The window now has a producer AND a caller. `lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint` reads `trips.start_date` / `end_date` for `sessionContext.tripId` and pushes the end date to the END of that day — a Trip ending on the 5th includes an event at 19:00 on the 5th, and comparing against midnight would have called the last evening of the Trip infeasible. That window is passed to the shared §18 rule and demotes out-of-window events in the ordinary suggestion list. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts` with the harder fixture: the out-of-window event is seeded first AND sorts first under the event search's own `starts_at` ordering, so the in-window row can only lead because of this term — an earlier draft of the test passed without the term at all and is recorded here because that is exactly the weak-test failure mode this census exists to catch. Both rows are still returned (§18 says demote). MUTATION: short-circuiting `classifyFeasibility` turns it RED. |
| G125 | Outside selected city/area where the field is constrained | C | Same rule, same single implementation, now reached from the ordinary pipeline as well as the creation flow. The constraining city comes from the active task (`lib/inputAssistance/taskContext.ts:90#export async function resolveTaskConstraint`), and `lib/inputAssistance/taskContext.ts:148#function candidateCity` reads each candidate's own city from its display projection. A GEOGRAPHIC row is exempt by construction (`lib/inputAssistance/taskContext.ts:145#const GEOGRAPHIC_TYPES`): a city row IS another city, and a city picker inside a Bangkok Trip must still be able to offer Da Nang. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts` — the out-of-city place is demoted, still returned, and the no-task control leaves the two rows identical. MUTATION: short-circuiting `classifyFeasibility` turns it RED. |
| G126 | Age, trust, membership, role or invite restrictions | C ᵖ | Age: `fetchAgeRestrictedSet` fail-closed (`gateway.ts:374-378`). Membership/role: `discoverySearch.ts:1081-1084#admitted:` (plans via parent-trip ownership), `:920#visibility` + `:921#show_in_discovery` (trips). Trust/invite have no separate gate but no path exposes an invite-scoped object either. Pre-existing. |
| G127 | Unavailable Buddy category or required safety/payment gate | **N** | **NOT MOVED**, re-measured and unchanged: the only buddy predicate reachable from the suggestion path is still `buddy_verified_at IS NOT NULL`, and a search of `lib/inputAssistance/` for a category, availability, safety or payment signal returns nothing (the `safety` hits are comments in `liveSuggestions.ts` and `aiWriting.ts` about not presenting a safety signal as vibe). Same shape as G123: the demotion machinery exists, the facts do not. **WHAT WOULD TURN THIS RED:** buddy availability / category / payment-gate state read at candidate time and a feasibility term over it. Gating on `buddy_verified_at` alone and calling it a safety gate would be the failure this census exists to catch — a check that looks like the requirement and answers a different question. |
| G128 | Blocked / private / ineligible people or content | C ᵖ | `gateway.ts:373-378` and `:614-619`, both fail-closed on a null set. Pre-existing `fetchBlockedSet`. |
| G129 | Protected or sensitive locations whose exact position cannot be surfaced | C ᵖ | Structural: `InputSuggestion` has **no coordinate field at all** (`types.ts:206-244`) and `discoverySearch.ts:1562#sensitivity_level,` never selects a gem's exact pair. Deep-scanned by `test/inputAssistanceCertification.test.ts:265-327`. |
| G130 | Stale live states beyond allowed freshness | C | `liveSuggestions.ts:293` — the only live input is `readLiveClaimEnvelopes`, which owns the not-expired filter; an empty result attaches nothing (`:306`). |
| G131 | Duplicate Place/Gem/Event candidates when creation mode should resolve existing records first | C | `duplicateDetection.ts:241-370` (gems, places), `:383+` (events); `gateway.ts:534-546` then drops the redundant plain entity row for a duplicated id so the flow shows one unambiguous choice. |

### §21 Smart Action Suggestions

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G132 | Some typing produces actions rather than text replacements | C | `semanticIntent.ts:277-300` recognises "add Bangkok to my trip" and emits an `add_to_trip` action row; `search/smartActions.ts:41-43` lifts it into a dispatchable chip lane. |
| G133 | Telegraph actions: share Place, meeting point, Trip stop, Event, media, location when permitted | **N** | **NOT MOVED.** Re-measured: `type: 'share_entity'` still has no producer anywhere outside the type declarations, and `telegraph_message` still has a registered policy and **no registered field**, so the context is unreachable from any screen. (This branch adds `share_entity` to a §48 capability VOCABULARY at `artifacts/api-server/src/lib/inputAssistance/compatibility.ts:79#'share_entity',` — a membership set, not a producer. The row is unaffected.) **WHY REGISTERING THE FIELD WOULD NOT CLOSE IT:** a `registerField('telegraph.message', 'telegraph_message')` with no composer rendering an assisted input is another declaration with no consumer, which is the §6 failure mode this same document scores four times over. The row needs a producer for `share_entity` AND a Telegraph composer that renders the shared overlay — two builds in another lane's screens. |
| G134 | Search actions: Add to Trip, Save, Open Map, Ask Compass, Start directions | W | **NOT MOVED — still one of five end-to-end.** Save, Open Map and Start directions still have no producer anywhere in `lib/`. What changed is only the honesty of the `open_compass` half: the client's silent drop is now a DECLARED capability (`travel-buddy-standalone/src/platform/input-assistance/contexts/clientCapabilities.ts:117#export const GLOBAL_SEARCH_CAPABILITIES`), so the serve stops building a row the search bar was always going to discard — §48/G343's negotiation. **That does not move this row and must not be read as progress on it:** the requirement is five dispatchable search actions and the count is unchanged at one. A client that DOES declare `open_compass` still receives the row, so the producer is intact for whoever builds the dispatch target. **WHAT WOULD TURN THIS RED:** a dispatcher on the search screen for `open_compass`, plus producers for Save, Open Map and Start directions. |
| G135 | Trip actions: add stop, reorder plan, add destination, invite Crew | **N** | **NOT MOVED**, re-measured: no producer for any of the four, and `SuggestionAction` still has no variant that could carry them — a search of `lib/` for `add_stop`, `reorder_plan`, `add_destination` or `invite_crew` returns nothing. This is the widest of the §21 gaps: it needs four new members of the §43 action union, four producers in `semanticIntent.ts`, and four dispatch targets on the Trip screens, and every one of them is a write path with its own authorization (§47). Not attempted this pass. |
| G136 | Hidden Gem actions: drop pin, use approximate area, confirm existing Gem, add new Gem | W | **NOT MOVED — still two of four.** Re-measured: no producer in `lib/inputAssistance/` for "use approximate area" or "add a new Gem" (the `approximate_area` hits in the tree are `circleResponseShaper.ts`, `locationPurposes.ts`, `compass/CompassSocialEngine.ts` and `routes/circle.ts` — CORRECTED 2026-09-26 by §33, which found four where this row said two; all four are the Circles visibility mode, a different feature that happens to share the phrase — and citing it here would be exactly the wrong-symbol citation `check:citation-symbols` exists to catch). Drop-pin and confirm-existing are unchanged and real. **WHAT WOULD TURN THIS RED:** an `approximate_area` structured value over the gem's city or neighbourhood, and an "add a new Gem" action row on the no-match path — the latter is §37's "Add a new Place" too, so the two rows close together or not at all. |
| G137 | Compass action: convert a phrase into a structured request/action with referenced entities | C | `semanticIntent.ts:231-268` — an editable `ai_suggestion` row whose action is `open_compass` carrying the parsed structure, and `projection.ts:283-288` attaches coarse `{surface, city, cityId, tripId}` refs to every starter. |

### §22 AI-Assisted Writing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G138 | AI assistance is opt-in, context-bound and secondary to canonical assistance | C | Triple gate: per-request `aiAssist === true` (`routes/inputAssistance.ts:139`, strictly boolean), the field policy's `allowAI` + `ai_suggestion` allowance (`gateway.ts:480-486`), and the `compass_ai_writing_enabled` flag read fail-closed (`aiWriting.ts:80-90`). Secondary by `TYPE_RANK` (G8). ☠prod (flag absent from production). |
| G139 | Captions: optional caption variants using user-provided context | C | `aiWriting.ts:64-70` `AI_WRITING_CONTEXTS` includes `caption`; wired at `hooks/useAiWritingAssist.ts`. |
| G140 | Event / Trip text: title and description suggestions | C | `AI_WRITING_CONTEXTS` includes `event_title`, `event_description`, `trip_title`, `plan_title` (`aiWriting.ts:64-70`); consumed by `app/trip/new.tsx` and `app/events/create/index.tsx`. |
| G141 | Postcards / Memories: writing assistance without inventing travel facts | **N** | Neither postcard nor memory is an `InputContext` (`types.ts:32-61`) and neither appears in `AI_WRITING_CONTEXTS` (`aiWriting.ts:64-70`: caption, event_title, event_description, trip_title, plan_title). **There is a constraint on how this can be closed**: the union is pinned at exactly 29 members by G19 and `test/inputPolicyContractParity.test.ts:98`, so adding `postcard`/`memory` contexts is a spec-level change, not a local one. The nearest existing route is `caption`, which `compass/compassFields.ts:35#caption` maps to the composer for "pulse / postcard / highlight / story / memory" — i.e. postcards and memories already type into an AI-writing field, under a context named for something else. Whether that satisfies §22's allowed-use row is a question for the spec's owner and this census does not answer it by fiat. Note also that §22 is dark in production regardless: `compass_ai_writing_enabled` has NO ROW in `feature_flags` (measured 2026-09-21) and `isFlagEnabled` is fail-closed. WHAT WOULD TURN THIS RED: a ruling that `caption` covers it plus a test for the no-invented-facts constraint on a postcard draft, or a 30th/31st context with its own policy and both registries updated. |
| G142 | Buddy listing text: description suggestions subject to category/policy | **N** | `buddy_service` has `allowAI` unset ⇒ false and `allowedSuggestionTypes: ['entity','completion']` with no `ai_suggestion` (`policyRegistry.ts:256#buddy_service` — citation re-resolved, it had drifted 30 lines), no buddy context is in `AI_WRITING_CONTEXTS` (`aiWriting.ts:64-70`), and there is no buddy-description field in any registrar or in `contexts/fieldInventory.ts`. Three things are missing, not one: the field, the policy allowance, and the "subject to category/policy" gate itself, which has no counterpart anywhere — G71 records that no service-category filter exists on the buddy path either. And §22 is dark in production regardless: `compass_ai_writing_enabled` has NO ROW in `feature_flags` (measured 2026-09-21) and `isFlagEnabled` is fail-closed, so anything built here would not run for a user until that flag is seeded and turned on. WHAT WOULD TURN THIS RED: a registered buddy-description field, the policy allowance, a category/policy constraint applied to the generated text, and the flag observed ON in production. |
| G143 | Compass: prompt continuation and reformulation | C | `aiWriting.ts:76-78` `isAiTextContext` admits `compass_prompt`; the deterministic starters are separate and ungated (`gateway.ts:434-446` call site). |
| G144 | Never silently insert or publish AI-generated text | C | Every variant becomes `{type:'ai_suggestion', source:'ai', action:{type:'replace_text'}}` (`aiWriting.ts:244-268`); nothing in the client applies it without a tap (`SmartInput.tsx:112-117`), and there is no publish path from this module. |
| G145 | Generated text must remain editable | C | Same — `replace_text` writes into the caller's editable `TextInput`. |
| G146 | Must not create canonical facts | C | `buildAiAssistedWriting` returns `InputSuggestion[]` and performs no write; the module imports no writer. Its output additionally passes `sanitizeSuggestedText` (`:162-180`), which drops a variant outright rather than surfacing it. |

### §23 Validation and Correction While Typing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G147 | Username unavailable → immediate non-blocking state **plus alternatives** | C | **Both halves now exist, on the surface a user actually reaches.** The state was already produced (`socialIdentity.ts:453#checkUsernameAvailability`, reusing `validateUsername` and the same query as `GET /users/check-username`, with `.neq('id', userId)` mutation-proven so a user retyping their own handle is not told it is taken). The alternatives are `usernameRules.ts:73#usernameAlternativeCandidates` (deterministic suffixes derived only from what the user typed, every candidate re-checked through `validateUsername`, so a RESERVED or malformed handle can never be offered) filtered to the free ones by `usernameRules.ts:101#suggestUsernameAlternatives`. They live in the leaf rules module BOTH username paths already share, so the endpoint and the assistance lane cannot offer different handles. Wired at the live surface, not only in the gateway: `routes/profile.ts:1105#const offerAlternatives` attaches them to `GET /users/check-username`, which is what `hooks/useUsernameAvailability.ts:108#setAlternatives` and both shipping entry points consume — `app/profile/edit/identity.tsx:370#usernameAlternatives` renders them as tappable chips and `app/(auth)/onboarding.tsx:275#usernameAlternatives` does the same. The gateway's own §23 lane (`gateway.ts:656#checkUsernameAvailability`) was deliberately left alone: its `username` context is registered by no client field and mounted by no screen (G18), so wiring it would add a second call site to code no user reaches, and the shared resolver now sits in the module that lane already imports, ready for the day the field is mounted. FAIL-CLOSED and privacy: the availability read is `null` on a failed query and no alternative is offered from it — "this handle is free" is a positive claim and is never made out of a read that failed — and the new read selects `username` alone, strictly narrower than the `id` the availability query selects, disclosing nothing `GET /users/check-username` does not already answer for a handle the caller composed (§47). Proven at `test/profileUsernameCooldownFailOpen.test.ts:242#alternatives` — the live endpoint, four cases: a taken candidate is dropped, a reserved base is still answered and never offers a reserved handle, a FREE name carries no `alternatives` key at all, and an unreadable registry offers none while the verdict itself still arrives (that last one pinned to the THIRD `profiles` read, so it cannot pass off an earlier refusal; mutation-proofs F and G are written into the file). Also `platform/input-assistance/social/__tests__/usernameValidation.test.ts:124#alternatives` and `app/profile/edit/__tests__/identity.usernameAlternatives.component.test.tsx:150#free handles`, which taps an offer and asserts the field re-checks to available. **Reachability, stated rather than buried:** this verdict rests on the LIVE path — `GET /users/check-username`, which both shipping username screens call on every keystroke — and not on the input-assistance gateway, whose `username` lane no field mounts. Nothing here is behind a flag, a migration or an absent table. |
| G148 | Duplicate Place/Gem → show probable existing entity before allowing duplicate creation | C | `duplicateDetection.ts:110-233` (a scored, thresholded matcher: `GEM_SAME_SPOT_KM`, `NAME_STRONG_SIM`, `DUPLICATE_THRESHOLD`) → `creation.ts:191-215` projects it as a MEDIUM-band `disambiguation`, never a block. |
| G149 | City-country mismatch → suggest canonical correction | C | `validationSuite.ts:50-93` (returns no verdict when the pair is unknown, rather than fabricating a mismatch) → `:194-230` a `correction` row whose action is an explicit `set_structured_value` the user must tap. |
| G150 | Trip date conflict → explain conflict and preserve user control | C | `validationSuite.ts:128-160` (inverted range + overlap with the viewer's own trip windows) → `:232-262`, which explicitly "does NOT change the dates". |
| G151 | Unresolved address → map pin, nearby candidates, or raw fallback | C | `validationSuite.ts:297-341` builds all three, policy-gated per context; entered from `gateway.ts:528-533` only when nothing canonical resolved. |
| G152 | Invalid hashtag/handle → explain normalization or reserved-name rules | C ᵖ | `validationSuite.ts:177-192` + `:265-287` for hashtags; handles reuse the pre-existing `lib/usernameRules.validateUsername`. |
| G153 | Provider disagreement → show choices or the canonical Portava record; never silently overwrite | **N** | *Unguarded absence*, re-verified at this commit. There is no provider lane in the gateway: `source: 'provider'` is in the suggestion union (`types.ts:301`) and is set on an `InputSuggestion` nowhere outside two test fixtures, and `external_places_enabled` — the flag this row named as dormant — gates the Living-Places routes, not anything the input layer reads: a repo-wide grep for it returns no hit under `lib/inputAssistance/` or `platform/input-assistance/` at all. So there is nothing to disagree — and, the part that makes this UNGUARDED rather than merely absent, nothing would refuse a silent overwrite if a provider were added tomorrow: `projection.ts:125#action` has one shape for an entity row and no branch for a contested one, and no test asserts that a provider value may not replace a canonical one. WHAT WOULD TURN THIS RED: a provider candidate path, a disagreement detector against the canonical record, a projection that offers the CHOICE (or the canonical record) rather than a merge, and a test that fails when a provider value silently overwrites a canonical field. A cheaper partial that is worth having on its own: the test and the refusal, written before the lane exists. |

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
| G172 | Zero-state panel | C | The surface exists and is the one the overlay uses. `travel-buddy-standalone/src/platform/input-assistance/components/ZeroStatePanel.tsx:45#export function ZeroStatePanel` renders the pre-typing set under a header (`travel-buddy-standalone/src/platform/input-assistance/components/ZeroStatePanel.tsx:54#accessibilityRole="header"`) and, when that set is empty, an explicit pre-typing hint (`:60#ia-zero-state-hint`) rather than the result-list's "No matches yet." — §37's empty and no-match states are two states, and §27's own gloss for this surface is *"useful suggestions BEFORE typing"*, which is a claim about framing. `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:333#<ZeroStatePanel title={zeroStateTitle}` mounts it, and `travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:213#const zeroState = value.trim` decides when — so it is not a component sitting beside the list, it is what the list is wrapped in when nothing has been typed. Proven at `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx:243#an empty field renders the zero-state PANEL` and `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx:274#an EMPTY zero-state set says`, both mutation-proven (render `list` in place of the panel; render the panel's `body` unconditionally). **Deliberately NOT widened**: an empty focused field does not now pop a panel on every assisted screen in the app — whether it opens at all stays the field's call (§2), and the panel is the surface the zero-char rows land in when the gateway returns them. |
| G173 | All surfaces support safe-area behaviour and stable layout under the mobile keyboard | C | The mechanism exists where the row said there was only an argument. `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:82#export function overlayHeightBudget` caps the card at the space that is actually free, reserving the software keyboard when it is up and the bottom safe-area inset when it is not — a MAX, not a sum, because adding them would shrink the card by a gesture bar that is currently behind a keyboard — with a floor (`travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:78#export const OVERLAY_MIN_HEIGHT`) so the card can never be squeezed to nothing (§38 "must not collapse the input UI"). The keyboard height comes from a real subscription, `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:99#export function useKeyboardHeight` (`keyboardDidShow`/`keyboardDidHide`), and the inset is read from `SafeAreaInsetsContext` rather than `useSafeAreaInsets()`, which THROWS without a provider — an input that cannot render because a screen forgot a provider would be a worse regression than an un-inset card. The inset also reaches the list's own `paddingBottom`, so the last row keeps its tap target over the home indicator. Proven at `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx:179#the overlay SUBSCRIBES to the keyboard` and `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx:223#the bottom SAFE-AREA inset reaches`, mutation-proven three ways (drop the keyboard branch; drop the floor; drop the inset from the padding). `keyboardShouldPersistTaps="handled"` and the inline placement are unchanged. |

### §28 Entity Preview Anatomy

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G174 | Primary title and entity type | C | `EntitySuggestionRow.tsx:34-42` composes both into the a11y label; `components/entityIcon.tsx` renders the type. |
| G175 | City/neighborhood or relevant location label | C | `projection.ts:151` copies `subtitle`; rendered at `EntitySuggestionRow.tsx:72-76`. |
| G176 | Distance where permitted | **N** | *§8.5 already retracted this row's stated evidence and the §4 table was never updated; re-confirmed and extended 2026-09-21.* There is no `distanceKm` on `SearchResult` (`routes/discoverySearch.ts:168-183`) and none on `InputSuggestion` (`types.ts:206-244`), so nothing is "dropped by the projection whitelist" — the only `distanceKm` in the repo is on a ranking service for a different surface (§8.5 names it), and distance is otherwise computed transiently inside the places ordering and never lives on a row. WHAT §8.5 DID NOT SAY, and is the part that matters for building it: The INPUTS both exist and are already in the same function: the viewer coordinate reaches the gateway on the suggest body (`routes/inputAssistance.ts:204#const lat = clampCoord(body.lat, 90);`) and is handed to the searchers as `SearchQueryContext` (`lib/inputAssistance/gateway.ts:585#const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };`), where it already drives a nearby boost. What is missing is a per-row distance VALUE and a display-safe field for it. EVIDENCE THAT WOULD CLOSE IT: a `distanceKm` on the rows whose searcher selects coordinates, a bounded band on `InputSuggestion` (a band, not a position — §29/G187 is structural and must stay), and a test that a permitted field renders it and a `sensitive`/gem row does not. |
| G177 | Open/closed or availability state where valid | **N** | No field, no producer, and — measured this pass — **no source**: `grep -n 'opening_hours\|open_now\|openNow'` over `routes/discoverySearch.ts` and `lib/inputAssistance/` returns nothing, so no searcher selects an hours column and none exists to select. `InputSuggestion` declares no operating-status member (`types.ts:206-244`). This is the same absence G123 records from the ranking side and G67 from the source side; all three are one missing substrate, not three gaps. EVIDENCE THAT WOULD CLOSE IT: an hours/availability column on `discovery_places` with a writer, a projected status value, and a test that an unknown status renders NOTHING rather than "open" — §31/G196's rule applies here verbatim. |
| G178 | Freshness / current-state badge where applicable | C | `components/freshnessDisplay.ts:47-64` → `EntitySuggestionRow.tsx:63-69`, rendering only strings the server sent. |
| G179 | Current Trip or Saved relationship | W | "Current Trip"/"Upcoming Trip" appears as `reason` on **zero-character defaults only** (`geoResolver.ts:243-249`). Re-measured 2026-09-21, and both halves are still open for DIFFERENT reasons. TRIP: a typed row inside the active Trip's city IS identified — `verdict.tripFitIds` (`lib/inputAssistance/gateway.ts:635#tripFit: verdict.tripFitIds.has(r.id),`) — but it is consumed as a confidence term only (`rankingSignals.ts:337#export function applyTripFit`), so such a row ranks higher and **says nothing**; and city-membership is not Trip-membership, so the honest label it could carry is weaker than the row asks for. SAVED: there is a saved lane (`routes/discoverySearch.ts:1328#async function searchSaved`) and **no `EntityType` reaches it** — `ENTITY_TO_SEARCH` is total over `EntityType` and `DispatchSearchType` has no `saved` member (`entityMap.ts:16-33`), which is the same finding G220 records. EVIDENCE THAT WOULD CLOSE IT: a relationship value on the projected row for both halves — Trip membership read from the Trip's own rows rather than its city, and a viewer-scoped saved lookup over the ids already in the answer — plus a test that a non-member and an unsaved row carry neither. |
| G180 | User verification / trust context where appropriate | C | *Moved to C by §8.4's row-move table and the §4 row here was never updated — so this is a stale-row repair, not a new closure, and it changes no count: the tallier already took §8.4's statement as the last one. Re-verified end to end 2026-09-21.* The chain is whole and every link is in the tree: `searchTravelers` selects them (`routes/discoverySearch.ts:580#is_official,`) and binds them onto the result (`routes/discoverySearch.ts:706#verified: ident?.verified ?? false,`); the projection copies them, and ONLY when true, so an absent key is never a negative claim about somebody (`lib/inputAssistance/projection.ts:156#if (r.verified === true) suggestion.verified = true;`); the client type declares them (`types/inputSuggestion.ts:64`); one shared helper turns them into the user-facing words (`components/suggestionBadges.ts:40#export function suggestionBadges`); and the row renders that list AND joins it into the announced label from the same call, so a badge cannot be visible and unannounced (`components/EntitySuggestionRow.tsx:44#const badges = suggestionBadges(suggestion);`, and the badge chips at `components/EntitySuggestionRow.tsx:113-120`). The surface is live: `WallHeader.tsx:148` mounts `SmartInput` on `global_search`, which renders this row. Proven in `src/test/inputAssistanceRankingSignals.test.ts` ("the row's badge words come from the shared helper", and the §36 end-to-end below asserts `verified` on the wire); MUTATION: drop the `official` branch in `suggestionBadges` → RED. **What this is NOT**: disclosure, not protection — see G233. |
| G181 | Hidden Gem protection / status labels | C | *Same stale-row repair as G180 — §8.4 moved it and this table kept the old text. No count changes. Re-verified 2026-09-21.* `gemSearchPosition` already decided whether a gem may carry a centroid and wrote the answer as a precision WORD into `metadata.coordsPrecision`; that word — never a coordinate — is now read into a display-safe enum (`lib/inputAssistance/rankingSignals.ts:151#export function gemLocationPrecision`), attached only to gem rows (`lib/inputAssistance/projection.ts:160#if (precision) suggestion.locationPrecision = precision;`) and rendered as "Protected location" / "Approx. location" through the same badge helper as G180 (`components/suggestionBadges.ts:47`). `'exact'` is deliberately outside the return type because the gem path never emits it. Proven in `src/test/inputAssistanceRankingSignals.test.ts` §3 — a protected gem and a placeable gem no longer project identically, the label drags no centroid along (the serialised row is scanned for the seeded coordinates), and a `places` row carrying the same metadata key gets no label. MUTATION: delete the `if (precision)` line → the inequality goes RED. |
| G182 | Why this is suggested, when useful | C | `projection.ts:84` copies `matchedReason` into `reason`; the geo defaults set it explicitly (`geoResolver.ts:243-249`), and `EntitySuggestionRow.tsx:76-80` renders it. |

### §29 Privacy and Eligibility Gateway

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G183 | No suggestion is returned merely because it matched text; viewer eligibility is resolved first | C | `gateway.ts:373-402` — the block and age sets are fetched and, when either is `null`, **nothing** is emitted; the comment at `:402` names it as fail-closed. |
| G184 | Blocked users and blocked relationships suppressed | C ᵖ | `fetchBlockedSet` (pre-existing) at `gateway.ts:374`, `:615`; the null-set refusal is the mutation-proven case in `test/inputAssistanceGateway.test.ts`. |
| G185 | Private Trips/Events/Plans excluded unless the viewer is eligible | C ᵖ | `discoverySearch.ts:739#visibility`, `:920#visibility`, `:921#show_in_discovery`, `:1081-1084#admitted:`. Proven **through the gateway** by `test/inputAssistanceCertification.test.ts:330-366`. |
| G186 | Private captions/tags/metadata never enter public suggestion indexes | C ᵖ | The projection copies a fixed whitelist (`projection.ts:82-88`) and drops `metadata`, `privacyState`, `accessState`, owner/host ids and counts; the searches select public columns only. |
| G187 | Precise private location never leaked through autocomplete | C | Structural — `InputSuggestion` declares no coordinate field (`types.ts:206-244`); the one place a coordinate legitimately travels is the **public city-centre** inside a picker binding (`geoResolver.ts:70-81`). Deep-scanned adversarially at `test/inputAssistanceCertification.test.ts:265-327`. |
| G188 | Presence/location inference cannot be exposed beyond current authorization | C | The only inference path is the live lane, and it consumes nothing but `readLiveClaimEnvelopes` behind `liveLabelsServable` (`liveSuggestions.ts:271-279`), which owns the full IG gate chain. No presence or location-inference source is wired into the gateway at all. |
| G189 | Memory-based suggestions remain owner-scoped unless deliberately shared | C | `personalization.ts:159-180` filters `.eq('user_id', …)` from a session-derived id, never a parameter; `SURFACEABLE_GEO_TYPES` (`:83`) restricts injection to public geo entities so a remembered **person** can never be re-published around the privacy gate — mutation-proven (`test/inputAssistanceInvariants.test.ts`, item 5). ☠prod. |
| G190 | Sensitive-location and protected-place rules applied before projection | W | Unchanged, and re-verified at this commit rather than inherited. The **gem** sensitivity rule is applied at source and is real (`discoverySearch.ts:1562#sensitivity_level,`, `:289-303#gemSearchPosition`). The repo's actual protected-place gate — `lib/protectedLocations.ts`, built for the Map spec §24 — is still **never consulted by this path**: a repo-wide search for its exports inside `artifacts/api-server/src/lib/inputAssistance/` returns nothing. A protected zone that is not a hidden gem still has no effect on a suggestion. WHAT WOULD TURN THIS RED, and why it was not done here: wiring `protectedLocations` into `creation.filterInfeasibleCandidates` and into the geo projection is a privacy STRENGTHENING and is the right build — but `protected_zones` is absent from production (`scripts/checkProductionDrift.ts:104-117`), so the gate would refuse nothing there and the row would be `C ☠prod`, which under this pass's rule is not a close. It needs the table applied first, and then a test that a protected zone's exact point is refused THROUGH the gateway (not through `protectedLocations`' own unit tests). |
| G191 | AI receives only the minimum permitted structured context | C | `aiWriting.ts:107-130` `buildPermittedWritingContext` emits coarse city/country/category/dates only, wraps the user's text with `wrapUgc` (data-not-instructions) and runs `stripCoordinateFields` as a backstop. (`d4db6009` records honestly that the backstop has no reachable path today.) |

### §30 Conflict Resolution Precedence

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G192 | The precedence chain: canonical identity > verified/current authoritative state > eligible community state > approved provider state > cached historical state > user raw input > AI guess | **N** | *Unguarded absence. Re-measured 2026-09-21 — verdict unchanged, blocker sharpened, because the earlier text left out the one rule that does exist and the reason building the rest here would be dishonest.* THE ONE RULE THAT EXISTS is a hard-coded PAIR, not a chain: `routes/discoverySearch.ts:2861#export function mergeCitySuggestions` prefers a canonical registry city over a profile-derived city of the same name, and the gateway reaches it (`lib/inputAssistance/gateway.ts:626#items = mergeCitySuggestions(`). It ranks exactly two named sources and generalises to nothing. EVERYWHERE ELSE order is arrival order: the cross-type id dedup keeps whichever row the POLICY's `entityTypes` list happened to reach first (`lib/inputAssistance/gateway.ts:629#if (seenIds.has(r.id)) continue;`), and the client refuses to re-decide it at all, by design and in writing (`services/suggestionRanking.ts:11-13` — "conflict-resolution precedence (§30) are deliberately NOT reimplemented here — that would fork the server's authority"). `TYPE_RANK` (`projection.ts:309-320`) is a display order over assistance types, which §30 explicitly says is a different thing. WHY IT WAS NOT BUILT THIS PASS, stated rather than deferred silently: three of the seven tiers have no producer in this system — verified/current authoritative state, approved provider state (G222), cached historical state — so a ladder written today would have four reachable rungs, three unreachable ones and, outside the city pair above, **no two candidates that ever assert conflicting facts about the same entity**. That is a constant, not a resolver, and shipping it would read as precedence while deciding nothing. EVIDENCE THAT WOULD CLOSE IT: a second candidate source (G222 is the nearest), a declared ladder over `InputSuggestion['source']` consulted at the dedup above, and a test in which two sources DO conflict on one entity and the lower rung loses. |
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

> **THIS PREAMBLE IS SUPERSEDED TWICE OVER AND IS KEPT FOR THE RECORD.** §30
> gave `offlinePolicy` its first consumer (G340), and §31 gave that consumer
> something to open onto: three shipped dictionaries, a compact city index and a
> device-local recents store. Five of the seven rows below have moved since it
> was written. Read the rows, not this paragraph.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G197 | Countries / languages / interests → local static dictionary | **C** | *Built 2026-09-21. The row's own sentence — "the client ships none … so an offline country picker returns nothing" — is false in both halves now.* THREE SHIPPED ARTIFACTS, each stating its own bound in its own header: `travel-buddy-standalone/src/platform/input-assistance/data/countries.ts:53#export const COUNTRY_DICTIONARY` (250 entries, every currently-assigned ISO 3166-1 alpha-2 code), `travel-buddy-standalone/src/platform/input-assistance/data/languages.ts:32#export const LANGUAGE_DICTIONARY` and `travel-buddy-standalone/src/platform/input-assistance/data/interests.ts:21#export const INTEREST_DICTIONARY` (the api-server's own `COMMON_LANGUAGES` / `COMMON_INTERESTS`, 30 each). DISPLAY SPELLING IS THE APP'S, NOT CLDR's, and the divergences were enumerated rather than guessed — `user_stamps.country` holds "Czech Republic" and "Turkey", so an offline picker inserting "Czechia" or "Türkiye" would fork the spelling §10 says is never rewritten; each CLDR form survives as a matched-but-never-displayed alias. THE PIN THAT STOPS THIS BECOMING A SECOND, DRIFTING COUNTRY LIST: every one of the 149 keys of `travel-buddy-standalone/src/lib/countryCentroids.ts` — the passport-map artifact that already shipped — must resolve here as a label or an alias (`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:108#every country the PASSPORT MAP can pin`; deleting the `Ivory Coast` alias reddens it). CONSULTED BY THE HOOK: `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:397#offlineLocalRows(policy, trimmed`, and end to end with the network down at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:142#an OFFLINE country picker returns rows from the shipped dictionary` and `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:164#an offline LANGUAGE field is answered from its own dictionary`. WHAT IS STILL IMPERFECT, and it is not a clause of this row: the language and interest lists are a COPY of the server's, not a derivation — `artifacts/api-server` is ESM and this package is CJS, and the rule against a runtime import across that boundary is written at the top of `contexts/inputContexts.ts`. Drift between them can only make the OFFLINE answer older than the online one, never wrong, because these rows exist only while the server cannot answer. |
| G198 | Cities → cached / local compact city index | **C** | *Moved 2026-09-21; both halves of this cell's own complaint are answered.* THE LOCAL INDEX EXISTS: `travel-buddy-standalone/src/platform/input-assistance/data/cities.ts:73#export const CITY_INDEX`, ~270 cities, DERIVED at module load from `travel-buddy-standalone/src/lib/cityCentroids.ts` (`CITY_CENTROIDS` plus its `CITY_ALIASES`) rather than pasted, so the two cannot drift. The previous cell named the irony itself — "`lib/cityCentroids.ts` exists but is a map-camera helper, not consumed by this layer" — and consuming it is the fix. THE BOUND IS STATED AND DEFENDED IN THE FILE HEADER: it is the cities this product already names, which is not arbitrary (they are the cities Portava has content, events and stamps for) and is not a gazetteer (100k rows would cost every user the download and be wrong the day after). It omits every city not already in that map — most of the world — and it deliberately does NOT read `REGION_CENTROIDS` or the country map in that same file, because a continent is not a city (`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:121#the city index is compact and bounded — cities only, no regions`; folding `REGION_CENTROIDS` in reddens it). SERVED THROUGH THE HOOK: `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:172#an offline CITY picker is answered from the compact city index`. AND THE CACHE IS NOW PERSISTED, which was this cell's other clause — `travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts` with `travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:123#export async function attachLocalRecents` (G199) — so a cold app start offline is no longer empty. STILL MISSING: a local city row carries no country subtitle, because the source artifact is name→coordinates and this layer will not invent an attribution the server did not send. |
| G199 | Recent selections → device-local where allowed | **C** | *Built 2026-09-21. The blocker this cell named — "an in-memory `Map`, and its own header says the AsyncStorage-backed store is 'a LATER PHASE'" — is gone.* THE DEVICE HALF: `travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts` defines the blob and its validation; `travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:123#export async function attachLocalRecents` hydrates; `travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:170#function schedulePersist` writes on every explicit accept; `travel-buddy-standalone/src/platform/input-assistance/services/installLocalRecents.ts:34#export function installLocalRecents` binds AsyncStorage through a two-method PORT, so the pure modules keep their node:test importability. IT IS MOUNTED, which is what makes this a build rather than a module: `travel-buddy-standalone/app/_layout.tsx:206#function LocalRecentsSetup`. §9.8 scoped this work and dropped it because the store had "no production consumer at all"; G216 gave it one. Proven at `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localRecentsPersistence.test.ts:105#it SURVIVES a restart — a cold process reads it back`. "WHERE ALLOWED" IS ENFORCED THREE WAYS. The WRITE gate refuses a viewer-scoped field (`:126`); the READ gate is re-evaluated against the LIVE policy on every call, so a field the authority has since RECLASSIFIED serves nothing however warm the device is (`:140`) — the case a disk creates and a session never could; and an account change erases the store outright (`travel-buddy-standalone/src/platform/input-assistance/services/policySync.ts#applyAccountChange`, new `recents` arm, wired at `travel-buddy-standalone/src/platform/input-assistance/services/installInputPolicySync.ts:105#applyAccountChange(userId, store, cache, recents)`), because otherwise the next person to sign in on the phone opens a picker onto the last person's choices. Decode REFUSES rather than repairs — unknown envelope version, a `savedAt` older than 30 days OR IN THE FUTURE, an unknown context, a non-replayable type, an unknown `source`, an unnameable `action.type`, or any `freshness` at all, since a live claim is never restored (`travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts:111#function isRestorableRow`, `travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts:73#export const LOCAL_RECENTS_MAX_AGE_MS`). WHAT THIS `C` DOES NOT COVER, stated so it is not read wider than it is: only rows explicitly ACCEPTED in an assisted field are retained; `useRecentPlaces` and the global search history are separate stores outside this layer and are unchanged; and the SERVER-side cross-device memory is still absent from production — that is G213/G226, not this row, which asks for device-local. ☠prod |
| G200 | Saved / Trip entities → cached subset where permitted | **N** | *Re-measured 2026-09-21 against the new local layer and DELIBERATELY NOT MOVED.* What now exists is generic: an explicitly accepted row of ANY entity class is retained on-device and replayed offline for a field the authority licenses (`travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts`, G199/G216), and `global_search` declares `trip` among its `entityTypes`, so an accepted Trip row IS in fact cached. THAT IS NOT WHAT THIS ROW ASKS FOR. "Saved / Trip entities → cached subset" means the viewer's saves and their Trip's entities are available offline; what exists covers only the ones they happened to pick in a suggestion field, so a user who has accepted nothing has nothing, and the words "saved" and "Trip" do nothing in the mechanism. THERE IS STILL NO FEED FOR EITHER: `searchSaved` is the one viewer-scoped dispatch type and is deliberately excluded from the `all` fan-out (`artifacts/api-server/src/routes/discoverySearch.ts:2423`), no `EntityType` reaches it at all (G220), and `platform/input-assistance/` contains no Trip-entity sync. WHAT WOULD TURN THIS RED: a sync of the viewer's saved and Trip-scoped entities into the device store G199 built, plus a test that a `cached_local` field offers them offline having never been typed into. One constraint shapes that build and should be read first — every dedicated place/venue context is `server_required`, so such a cache could only ever be SERVED in `global_search`, `city_picker`, `trip_destination`, `neighborhood_picker`, `passport_homebase` and `buddy_service_area`. |
| G201 | Places → cached recent and Trip-scoped entities | W | *Moved `N` → `W` 2026-09-21 — one of this row's two halves, and the narrower one.* CACHED RECENT PLACES NOW EXIST: an explicitly accepted `place` row is retained on-device, survives a restart (G199) and is replayed when the network is gone, for a field the authority licenses an offline surface for. Proven together with its own limit at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:206#an accepted PLACE row is replayed offline in a cached_local field — and only there`: the same row is offered in `global_search` and REFUSED in `place_picker`, in one render of one tree, so neither half can be explained by test ordering. WHY THAT LIMIT IS THE ROW'S CEILING AND NOT A DEFECT. The four contexts this row is really about — `place_picker`, `trip_stop_place`, `event_location`, `address` — are all `server_required` in `artifacts/api-server/src/lib/inputAssistance/policyRegistry.ts`. A place cache serving THEM would be assistance the authority declined to license, so building it is not a client decision. WHAT STILL KEEPS THIS `W`: the TRIP-SCOPED half has no substrate at all (the same gap as G200); the cache covers only rows the user accepted, not the places a Trip contains; and it is keyed by context rather than by entity, because it rides on the recents store. WHAT WOULD TURN THIS RED: a Trip-scoped entity sync into the G199 device store, plus either a policy change that licenses an offline surface for a place context or an argument that `global_search` alone satisfies the row. |
| G202 | Live intelligence → unavailable or clearly stale; never represented as live | C | `components/freshnessDisplay.ts:53-58`; the server attaches nothing when the gate is off (`liveSuggestions.ts:279`). |
| G203 | AI assistance → unavailable offline unless an approved on-device model exists | C | `useInputAssistance.ts:190-194` degrades a 404/offline to `unavailable` and clears the list without an error; there is no on-device model and `aiWriting.ts` is server-only, so AI cannot appear offline. |

### §33 Performance Architecture

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G204 | The tier ladder: 0 chars → cached/default; 1 char → local/cache prefix match; 2+ chars → server-assisted | C | **Table reconciled 2026-09-21 — this cell was stale, not this verdict.** §9.3 moved this row `W → C` and the §4 table was never updated, so the document has printed two answers for two passes. Re-read at this commit and the move holds: `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:238#localTier` consults `suggestionCache.ts:185#longestPrefix` + `suggestionRanking.ts:94#narrowToQuery` BEFORE the network answers, so a keystroke past a cached prefix renders locally instead of blanking until a round trip completes. The middle rung is narrowing-only (`narrowToQuery` cannot invent, reorder or re-score a row), so the server stays the authority (§42), and the revalidation request still goes out — that is SWR, and the hook's header has always said so. Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:121#renders local rows before the server answers`. The count does not move: `check:census-integrity` already took §9.3's verdict as this row's live one. |
| G205 | Recommended debounce 100–150 ms | C | `policyRegistry.ts:86` defaults `debounceMs` to 120; consumed at `useInputAssistance.ts:279`. |
| G206 | Cancel stale requests | C | `useInputAssistance.ts:157-159` aborts the previous `AbortController` before each fetch; `:211` aborts on unmount. |
| G207 | Use request sequence IDs | C | `services/raceGuard.ts:33-50` is the single shared monotonic guard; `useInputAssistance.ts:210` + `:235` (`if (!guardRef.current.isCurrent(mySeq)) return`). The server independently stamps `requestId` (`routes/inputAssistance.ts:166`, returned at `:207`). |
| G208 | Stale-while-revalidate | C | `services/suggestionCache.ts:18-33` (TTL + LRU, coordinate key rounded to ~1 km); `useInputAssistance.ts:141-152` serves a hit with zero network and keeps previous rows visible while fetching. |
| G209 | Prefetch likely dependent data after a canonical selection | N | Still nothing prefetches, re-verified at this commit: `handleSelect` (`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:188-241`) emits telemetry, announces the selection, records selection memory and returns; no call site warms a cache or issues a dependent request. **What blocks it is not the fetch, it is the graph.** §33's clause is *"prefetch likely NEXT-FIELD entities"* and §53's example is *"Bangkok → neighborhoods / airports / saved places"* — both name a DEPENDENT field, and the cross-field dependency graph that would say which field that is exists for exactly one node class (G109: the city binding, and nothing for a venue). Building the prefetch first would mean hard-coding a mapping this spec asks §17 to own, which is inventing a requirement rather than closing one. WHAT WOULD TURN THIS RED: G109's dependency graph extended past the city node, then a `prefetchAfterSelection` that issues the dependent field's zero-character request and writes it into `sharedSuggestionCache` under that field's key — plus a test that the dependent field's first render is a cache hit with zero network. |
| G210 | Network loss: retain local/cached suggestions and explicit degraded behaviour | C | **Table reconciled 2026-09-21 — this cell was stale, not this verdict.** §9.3 moved this row `W → C` and the §4 table kept the old text. Re-read at this commit: the branch this row was written about now RETAINS. `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:396#const mayRetain` sets `unavailable` and keeps the narrowed local list, where it used to `setSuggestions([])` — discarding the last good rows at the one moment the user cannot get new ones. The degraded half was already exact and is untouched (`SuggestionOverlay` shows a quiet note, never an error). With nothing local to retain it is still `[]`, which is the old behaviour and not a regression. Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:133#RETAINS`. The count does not move. |
| G211 | Virtualize large suggestion groups; cap visible results | C | Both halves now. The cap was always real and layered (`routes/inputAssistance.ts:144`, `gateway.ts:676`, client `finalizeSuggestions`); the mechanism §33 asks for by name was not, and the overlay mounted every row in the group. `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:254#<FlatList` replaces the plain `ScrollView`, over a flattened row stream (`travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:120#export function flattenSections`) so a section HEADER is a list row rather than the top of a nested subtree. The type dispatch is not duplicated to get there: `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionList.tsx:43#export function SuggestionRow` and `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionGroup.tsx:32#export function SuggestionSectionHeader` are the same primitives the flat path uses. Proven at `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx:98#a 40-row group does NOT mount 40 rows` — under jest there is no layout pass, so a VirtualizedList mounts exactly `initialNumToRender` and a ScrollView mounts all 40, which makes the assertion a direct discriminator between the two containers; mutation-proven by swapping the FlatList back for a ScrollView. §9.8 recorded this as "an afternoon that would move a row" and deferred it; it was an afternoon. It also had a cost the old container hid — see the note on `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:279#extraData={activeId}`, and §14.4 for the mutation that did NOT redden there. |

### §34 Local vs Server Processing

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G212 | Prefer local: static dictionaries | W | *Moved `N` → `W` 2026-09-21. This row set TWO conditions; exactly one is met, so it moves one bucket and no further.* MET — "a test that an offline `country_picker` answers from it": the dictionaries ship (G197) and the hook consults them (`travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:337#export function offlineLocalRows`, reached from `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:397#offlineLocalRows(policy, trimmed`, proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:142`). The dictionary is chosen from the POLICY rather than from a field name — `travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:111#DICTIONARY_BY_ENTITY` is indexed by the authority's `entityTypes` and `travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:143#export const SURFACE_ENTITY_CLASSES` by its `offlinePolicy` (`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:142#the dictionary is chosen from the POLICY, not from a hard-coded field name`). NOT MET — "consulted by the hook BEFORE the network": it is consulted INSTEAD of the network, and only after the network has already failed. That is deliberate, and it is the boundary G224 draws in its own words — the server owns eligibility, so "the local answer is sufficient" is not a judgement this client may make alone — and it is asserted as a property rather than left implicit (`travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:304#the shipped dictionary does NOT pre-empt the request — the server is still asked`). WHAT WOULD NOW TURN THIS RED: the policy-declared sufficiency tier G224 names — a server-sanctioned statement that a named field may answer from a static dictionary WITHOUT a round trip — plus a test that such a field issues zero requests on a local hit while a viewer-scoped field still issues one. That is a contract change on the authority, not a client build, which is why this row stops here. |
| G213 | Prefer local: recent selection history | **C** | *Fully closed 2026-09-21. Half-closed on 2026-09-21 by G216, which stated its own remaining blocker — "the store is process memory, so nothing survives an app restart" — and that blocker is gone.* THE CLIENT HALF, RECAPPED: `travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:123#export async function attachLocalRecents` is not the writer — `recordLocalSelection` is, wired from the one explicit-accept path (`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:385#recordLocalSelection(policy, s);`) — and the §34 zero-state tier reads the accepted ROWS back, gated by `privacyClass` on BOTH sides (`travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:209#export function mayRetainLocally`). THE DURABLE HALF, NEW: every accept is written to the device and hydrated on the next launch (`travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts`, `travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:170#function schedulePersist`, mounted at `travel-buddy-standalone/app/_layout.tsx:206#function LocalRecentsSetup`), so the SECOND launch of the app prefers a local answer rather than having none to prefer. Proven at `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localRecentsPersistence.test.ts:105#it SURVIVES a restart — a cold process reads it back`, with the privacy gates at `:126` (write) and `:140` (a field RECLASSIFIED since the write) and the account-change erase at `:210`. That read gate is the one a disk makes necessary: it is re-evaluated against the LIVE policy on every call, so nothing stored under an older, looser classification is ever served under a newer, stricter one. WHAT THE ☠prod MARKER STILL MEANS, and why it does not hold this row: the SERVER-side memory (`input_selection_history` and the `input_record_selection` RPC) is still absent from production, so the CROSS-DEVICE recollection returns empty for every user. That is §35's row and G226's, and it is an operational gap — an unapplied migration — not this one. This row is §34's "prefer LOCAL", and the client now prefers a local answer that outlives its own process. ☠prod |
| G214 | Prefer local: cached city prefix matching | C | *Moved to C by §9.3's row-move table; this §4 row kept the old "there is no prefix index" text. Stale-row repair, no count change. Re-verified 2026-09-21, including the WIRING §9.3 did not assert.* `services/suggestionCache.ts:185#longestPrefix(` scans by CONSTRUCTED KEY — never by splitting keys apart, because the fieldId segment can itself contain the `\|` separator — longest strict prefix first, at most `query.length` O(1) lookups, and stops at the most specific cached answer. The empty prefix is included on purpose, so a field's zero-state entry is the list a 1-character query is narrowed out of. The hook reuses it and narrows on-device (`hooks/useInputAssistance.ts:240#const hit = sharedSuggestionCache.longestPrefix(cacheFieldId, trimmed, latKey, lngKey);`), and the narrowing is strictly SUBTRACTIVE — `narrowToQuery` cannot invent, reorder or re-score a row — so the server stays the authority (§42). The §29 gate is the same one the cache itself applies: an uncacheable field neither wrote nor reads. Proven pure in `services/__tests__/raceAndCache.test.ts` (longest-wins, empty-prefix, never-the-exact-key, TTL, coords) and as WIRING in `hooks/__tests__/useInputAssistance.localTier.component.test.tsx` — a keystroke past a cached prefix renders local rows while the request hangs. Both halves are needed: "the logic is right and nothing reaches it" is the failure this pair exists to catch. |
| G215 | Prefer local: simple normalization | C | `services/queryNormalization.ts:38-52` — NFKD, diacritic strip, stroke-letter fold, whitespace collapse, on-device, used for cache keys and local comparison. |
| G216 | Prefer local: immediate zero-state | C | *Built 2026-09-21. The defect was worse than the row said, and finding out why is what closed it.* The row said the zero-state was a server round trip. It was not even that: `zeroStateAssistance` is declared on all 29 context descriptors — `true` on every geographic picker, `global_search` and `hashtag` — and `buildDefaultPolicy` DROPS it (it is not a member of `InputFieldPolicy`), so **nothing on either side had ever read it**. `minChars` is 1 or 2 on every one of those contexts, so the hook returned on an empty field without rendering anything AND without asking, which means the gateway's own §14 answer (`gateway.ts:194-218`) was built for a request this client never sent. TWO THINGS NOW EXIST. (1) The gate has a reader: `hooks/useInputAssistance.ts:185#const zeroStateTier =` reads the context descriptor directly — deliberately not the policy, so `InputFieldPolicy` and `buildDefaultPolicy`, whose shapes G265/G269 cite, are untouched — and an empty field with `zeroStateAssistance` is assisted despite `minChars > 0`. (2) A LOCAL source answers it first: `services/localZeroState.ts` replays this session's explicit accepts, verbatim as the server projected them (never a row rebuilt from a label, which would have to invent an `action` and could resolve somewhere the server never said), re-typed `recent`, capped by the field's own `maxSuggestions`, and gated by `privacyClass` on BOTH the record and the read (`localZeroState.ts:209#export function mayRetainLocally`) so a viewer-scoped list is never re-published around §29's gate. The server request still runs — its answer is richer and it owns eligibility — so the local list is what the field shows WHILE that answer is fetched, and what it keeps when the answer never arrives — but SINCE G340 only when the authority licenses an offline surface for that field (`hooks/useInputAssistance.ts:396#const mayRetain`). For the nine contexts marked `server_required` the rows are now dropped instead; §30.4 has the reasoning. That last branch is the row's own sentence: the cold/offline open now shows what the user already chose. Proven in `services/__tests__/localZeroState.test.ts` (8 tests) and `hooks/__tests__/useInputAssistance.zeroState.component.test.tsx` (5), each with its mutation logged; removing the gate alone reddens all five wiring tests. **NOT persistence** — an app restart still has nothing local, which is G199. |
| G217 | Prefer local: request cancellation / state | C | `services/raceGuard.ts`; `useInputAssistance.ts:214#guardRef.current.invalidate()`, `:284#abortRef.current?.abort()`. |
| G218 | Prefer server: canonical entity lookup requiring current DB state | C ᵖ | `gateway.ts:343-404` → `dispatchSearch`. |
| G219 | Prefer server: privacy/eligibility filtering | C | `gateway.ts:373-378`, `:614-619` — server-side and fail-closed; the client explicitly does no re-filtering (`hooks/useTelegraphRecipients.ts:15-18`). |
| G220 | Prefer server: cross-entity search | C ᵖ | `entityMap.ts:16-33#DispatchSearchType` (17 types) → `dispatchSearch` (`discoverySearch.ts:2292#dispatchSearch`, switch at `artifacts/api-server/src/routes/discoverySearch.ts:2364#case "travelers":`). Still 17 after the §27 `saved` lane landed: `DispatchSearchType` is an EXPLICIT union and `ENTITY_TO_SEARCH` is `Record<EntityType, DispatchSearchType>`, so `SEARCH_TYPES`' eighteenth member (`:2391#searchSaved`) has no `EntityType` that reaches it. |
| G221 | Prefer server: Live Intelligence suggestions | C | `liveSuggestions.ts:250-317`. ☠prod |
| G222 | Prefer server: provider federation | **N** | No provider lane exists in the gateway. Candidate generation is `dispatchSearch` and nothing else, over an EXPLICIT 17-member union (`lib/inputAssistance/entityMap.ts:16-33`), so there is no shape a provider candidate could arrive in — `InputSuggestion['source']` has no provider value either (`types.ts:227-234`). `external_places_enabled` exists as a flag and gates the PLACE-DETAIL paths, not this one: `grep -n external_places_enabled` over `lib/inputAssistance/` returns nothing. This is the tier whose absence also holds G237 (neutrality) and one of G192's three empty rungs. EVIDENCE THAT WOULD CLOSE IT: a provider lane behind the existing flag, a `source` value that names it, and a test that a provider row is projected, is capped, and cannot outrank a canonical exact match. |
| G223 | Prefer server: personalized ranking requiring server-owned context | C | `personalization.ts:243-268` runs server-side over server-held memory. ☠prod |
| G224 | The client should not send every keystroke when local resolution is sufficient; use the smallest necessary server interaction | W | *Re-measured 2026-09-21 after G214 and G216; the premise changed, the verdict did not, and the residue is now exact.* WHAT REDUCES TRAFFIC: the 120 ms debounce, the exact-string SWR cache, the sequence guard, the mention/hashtag sigil short-circuit, and now the longest-prefix tier (G214) — typing forward no longer re-asks for an answer already in the map. WHAT STILL GOES OUT, every time: an above-threshold keystroke that misses BOTH caches, and — new, and counted honestly against this row — the zero-character request G216 enabled, one per field open. NONE of them is suppressed by a local hit: the client renders the local rows and issues the request anyway. That is a deliberate boundary rather than an oversight, and it is the one §34 exists to draw — the server owns eligibility (§29 is fail-closed there and the client explicitly does no re-filtering, `hooks/useTelegraphRecipients.ts:15-18`), so "the local answer is sufficient" is not a judgement this client may make alone. EVIDENCE THAT WOULD CLOSE IT: a stated sufficiency rule the server can sanction — a policy-declared tier that says which fields may answer locally WITHOUT a round trip (a static dictionary, G212, is the honest candidate: its rows carry no viewer scope at all) — plus a test that such a field issues zero requests on a local hit and that a viewer-scoped field still issues one. |

### §35 Selection Memory and Personalization

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G225 | Learn from repeated **explicit** selections, never inferred private facts | C | `routes/inputAssistance.ts:216-284` is the only write entry point and requires an explicit accept; `personalization.ts:464-472` refuses for any context whose policy disallows personalization and for any entity type the policy does not list. No view, hover, dwell or typing signal exists. `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. |
| G226 | Recently selected cities / places / users | C | Both defects this row named are discharged. **The table**: `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. **The USERS arm**: `telegraph_recipient` is the only context in the registry whose `entityTypes` are `['user']`, and it was carried as a KNOWN GAP on the §35 writer-coverage exemption list — the picker consumed the gateway and recorded nothing, so "recently selected users" had no writer anywhere in the product. Both halves are now wired: the accept handler records (`travel-buddy-standalone/src/hooks/useTelegraphRecipients.ts:96#const recordPick = useCallback`, called from `app/telegraph/new.tsx`), and the read half — which did not exist when that exemption was written — applies the §15 boost inside the recipient branch (`lib/inputAssistance/gateway.ts:426#const boostedRecips`). The exemption is DELETED rather than reworded, so the generic scan now enforces it (`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/selectionWriterCoverage.test.ts:184#the telegraph_recipient gap`). Cities and places record through `SmartInput.tsx:123`, `components/selectors/GlobalPlacePicker.tsx` and `hooks/useGlobalSearchSuggestions.ts`. Proven as a ROUND TRIP, not as two halves: `POST /select` then `POST /suggest`, at `src/test/inputAssistancePersonalization.test.ts:523#records the pick, and the NEXT request`, with an owner-scoping control (`src/test/inputAssistancePersonalization.test.ts:579#is owner-scoped: user B's recipient`) and a context-scoping control (`src/test/inputAssistancePersonalization.test.ts:594#stays context-scoped`). MUTATIONS, each applied and watched go RED: drop the boost from the recipient branch; make the harness's `input_record_selection` inert; drop `recordPick` from the screen; drop the recorder from the hook. **WHAT IS STILL NOT DEMONSTRATED HERE, stated rather than implied**: the SQL semantics (upsert-with-increment, the `COALESCE` label rule, the `auth.users` erasure cascade) are exercised by `src/test/inputAssistanceSelectionMemoryLiveDb.test.ts:176#UPSERT — a repeated selection`, which needs CI credentials and **has not been run**; `src/test/inputAssistanceSelectionMemoryLiveDbStatus.test.ts` says so out loud on every ordinary suite run. |
| G227 | Frequently selected abbreviations mapped to the same canonical entity for that user | C | `personalization.ts:334-386` `buildLearnedGeoInjections`, keyed on a query key folded **without** alias expansion so a user's own "bkk" maps even when the global dictionary does not know it (`gateway.ts:176-187`). `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. |
| G228 | Saved and Trip-related entities | C | Both halves now read. Trip-related: Trip destinations feed the zero-state (`geoResolver.ts:266#export async function zeroCharGeoDefaults`). Saved: `lib/inputAssistance/savedEntities.ts:85#export async function buildSavedPlaceSuggestions` reads the viewer's OWN `discovery_place_saves` and projects the saved canonical place as a §14 zero-character row, wired at `gateway.ts:342#buildSavedPlaceSuggestions` (pickers) and `:382#buildSavedPlaceSuggestions` (search-like contexts). Four fail-closed gates: `allowPersonalization`, the policy's own `entityTypes` (`savedEntities.ts:98#includes('place')`), the `recent` suggestion type, and the author-side block funnel — an unreadable block list serves NOTHING (`savedEntities.ts:132#if (blocked === null) return []`), the `lib/blocks.ts` contract. A save whose place is withdrawn or withheld is DROPPED, never rendered from the save row alone. Six named mutations were applied and each watched go RED (`src/test/inputAssistanceSavedEntities.test.ts:177#offers the viewer's saved place`, `src/test/inputAssistanceSavedEntities.test.ts:228#withholds a save whose submitter`, `src/test/inputAssistanceSavedEntities.test.ts:306#serves NOTHING when the block list`). **NOT `☠prod`**: `discovery_place_saves` exists in production, so this is the one §35 arm that is not inert there. |
| G229 | Previously successful query completions | **N** | `/select` requires `entityType` + `entityId` (`routes/inputAssistance.ts:237-242`); a query completion (`submit_search`) has neither, so a successful raw-search completion is never recorded and can never be re-surfaced. |
| G230 | Context-specific selection patterns | C | `personalization.ts:169` filters `.eq('context', …)`, so memory learned on one field never leaks into another — the property that made the missing-writer bug invisible. `input_selection_history` reached PRODUCTION on 2026-09-21 (migration 2258, `applied_by='manual'`), so the `☠prod` flag this row carried is now FALSE and is struck. Re-measured independently of the migration's own postconditions: `to_regclass` resolves, the RPC has one overload, RLS is on and only `service_role` holds a privilege. |

### §36 Anti-Spam and Manipulation Controls

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G231 | Keyword-stuffing resistance in business / Buddy / user descriptions | C | `lib/inputAssistance/rankingSignals.ts:207#export function spamRisk` is the heuristic: token repetition above a prose floor, upper-case ratio over a minimum length, and separator-chained keyword lists, combined by taking the STRONGEST rather than summing so a listing is not punished twice for one habit. It runs over every dispatched row's `title + subtitle` — the fields a business / Buddy / user listing authors — inside `projection.ts`'s signal stack, and demotes by at most `SPAM_MAX_PENALTY`. A clean listing scores 0 and is unchanged. Proven end-to-end in `src/test/inputAssistanceRankingSignals.test.ts`: `"Bangkok Tour Bangkok Tour Bangkok Tour Bangkok"` loses to `"Bangkok Tour Collective"` on the query both match exactly, and both are still returned. MUTATION: `spamRisk → 0` reddens four assertions. **What this is NOT**: it is not moderation, not a block, and not a Buddy-specific rule — §36's other six controls are unaffected and G232 (alias abuse) still has no detector. |
| G232 | Alias abuse detection | **C** | *`N` -> `C` by the integrating lane on 2026-09-21, on the bar THIS ROW set for itself: "a plausibility rule on the alias APPEND in `buildRowPatch` ... and a test that the provider-id path cannot attach an unrelated name." Both now exist.* THE STATIC HALF was never abusable and is unchanged: the alias tables this layer resolves through (`lib/canonicalLocations.ts:177#export const CITY_GEO_ALIASES`, `routes/discoverySearchHelpers.ts:63-95`) are curated constants in the source tree. THE WRITABLE HALF, which the previous pass found and correctly declined to patch from inside this layer: `canonical_locations.aliases` GROWS at runtime, and rule 1 of `matchCanonical` matches on a shared PROVIDER ID alone (`lib/canonicalLocations.ts:283#const byProvider = rows.find`), so a caller who knows a real row's provider id could attach an arbitrary `place.name` to it through `POST /locations/resolve`. THE GUARD IS ON THE APPEND, NOT THE READ, because refusing to read aliases would break the variants the set exists for: `lib/canonicalLocations.ts:425#export function isPlausibleAlias` requires a shared NON-GENERIC word, or one of four carve-outs this module already implements elsewhere — spacing (`danang`/`da nang`), the stroke/diacritic fold (`searchKey`, migration 2220), the shipped abbreviation dictionary (`saigon`), or an in-order initialism (`hcmc`). THE PROVIDER-ID MATCH IS UNTOUCHED AND THAT IS ASSERTED, not assumed: an implausible name still identifies the row, still returns it, and still backfills its coordinates — a refused alias must never become a refused resolution. Proven at `src/test/canonicalLocations.test.ts:397#alias poisoning: the write is refused, the RESOLUTION is not`, and the BOUNDARY is measured in both directions: removing the guard reddens 3 tests including the end-to-end one, and making it refuse everything reddens 3 including the legitimate-variant append. WHY THIS DOES NOT ALSO CLOSE A SUGGESTION-SIDE ROW: the previous pass's measurement still holds — `suggestCanonicalLocationsFolded` queries `search_key` and `normalized_name` only (`lib/canonicalLocations.ts:728-731`), so no suggestion path reads this column. The damage this closes is to canonical IDENTITY MERGING, which is why the fix is in the write path. STATED LIMIT: two names sharing one rare word still pass, so this narrows the hole rather than closing it, and a row whose every word is generic accepts appends only through the four carve-outs — the fail-closed direction. TURNS RED WHEN: a provider-id match appends a name sharing nothing with the row, or when a refused alias starts costing the resolution. |
| G233 | Impersonation protections for people and businesses | W | *§9.5 already retracted half this row's evidence (the flags are not dropped) and left one reason standing: "nothing in the suggestion path detects or demotes an impersonating handle. No confusable/homoglyph comparison exists anywhere in the layer." Built 2026-09-21 — and the verdict STILL does not move, for two reasons §9.5 did not reach.* CLOSED by §8.4: the flags are no longer dropped, so a viewer CAN tell the real account from the copy (G180). CLOSED this pass: a confusable comparison now exists and demotes — `lib/inputAssistance/rankingSignals.ts:404#export function handleSignature` folds the substitutions a confusable handle actually uses (digit-for-letter, doubled letter, separators, `rn`→`m`) and `lib/inputAssistance/rankingSignals.ts:436#export function applyImpersonationRisk` demotes an unverified person row whose handle folds to the SAME signature as a verified-or-official row in that answer. It is wired, not defined-and-unread: `lib/inputAssistance/gateway.ts:862#const antiImpersonation = applyImpersonationRisk(diversified);` runs between the diversity term and the rank. Signature EQUALITY, not edit distance, on purpose: a distance threshold fires on @sarah_travels vs @sara_travels — two real people — and nothing here could tell those apart from an impersonation. A demotion, not a removal, for SpamRisk's reason: co-occurrence with a verified twin is a suspicion, not a finding. `account_status` filtering is unchanged and still pre-existing (`socialIdentity.ts`, `test/inputAssistanceInvariants.test.ts` item 1). **STILL WRONG, and why the verdict stands.** (a) The rule is WITHIN-RESPONSE: an impersonator that appears without its target is untouched, because there is no verified twin to compare against and no handle index is consulted. That hole is pinned by an assertion rather than described — `src/test/inputAssistanceRankingSignals.test.ts` §8, "THE HOLE, pinned" — which also shows the same row IS demoted when its target is present, so the boundary is measured, not assumed. (b) BUSINESSES are not covered at all: `verified`/`isOfficial` exist only on `profiles` (`routes/discoverySearch.ts:706-707`), and a `places` / `hidden_gems` row carries no verification flag of any kind, so there is no genuine-listing signal for a venue to be impersonated AGAINST. The row names people AND businesses; half a requirement is not the requirement. EVIDENCE THAT WOULD CLOSE IT: a handle/name index the suggestion path can consult without its target being present, and a verification signal on business listings. |
| G234 | Duplicate entity suppression | C | `duplicateDetection.ts:241-370`; `gateway.ts:389-400` (per-id dedup across types) and `:534-546` (collapse a duplicate's redundant entity row). |
| G235 | Rate limits on suggestion-affecting submissions | C ᵖ | `routes/inputAssistance.ts:239#input_assist_suggest` (90/min) and `:378#input_assist_select` (60/min), on the pre-existing `lib/rateLimit` buckets. |
| G236 | No paid boost into factual confidence or canonical identity priority | C | Structural: `confidence` is a pure function of `matchTier` (`projection.ts:33-40`) plus two clamped boosts (freshness, prior-selection), and `InputSuggestion.source` (`types.ts:227-234`) has no sponsored/promoted value — there is no field a paid signal could enter through. |
| G237 | Provider neutrality — do not favour a source because it was integrated first | **N** | *Unguarded absence; verdict unchanged, and a guard was considered and rejected rather than skipped.* There is exactly one candidate source — `dispatchSearch` over an explicit 17-member union (`lib/inputAssistance/entityMap.ts:16-33`) — and `InputSuggestion['source']` carries no provider value (`types.ts:227-234`), so no two sources can be favoured over each other. WHY NOT A RATCHET: the obvious cheap move is a test that fails if a second source is added without a neutrality rule. It would assert over `DispatchSearchType` and `source`, and it would go green today for the same reason the requirement is vacuous — one source — so it would guard the ARRIVAL of a provider without guarding its TREATMENT, and a reader would take the green as neutrality. The rule it should ratchet does not exist yet either: neutrality's natural home is §30's precedence ladder (G192), which is also unbuilt, for the same missing tier. EVIDENCE THAT WOULD CLOSE IT: a second source (G222), a ranking rule that does not consult which source a row came from, and a test in which two sources' identical rows score identically. |

### §37 Empty and No-Match States

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G238 | Available fallback actions are context-dependent | C | `creation.ts:330-345` builds only the fallbacks the context's policy permits, and `gateway.ts:528-533` reaches it only when nothing canonical resolved and no duplicate was found. |
| G239 | A city picker should not offer "create city" | C | `policyRegistry.ts:110-116` gives `city_picker` only `['entity','recent']`, and the fallback builder is reachable only from `isCreationContext` (`creation.ts:51-63`), which excludes it. |
| G240 | A Hidden Gem / location flow may offer map-point or new-entity creation under policy | C | The missing element of §37's own empty-state mock (`[Search instead][Drop a pin][Add a new Place][Ask Compass][Search nearby]`) is produced. `artifacts/api-server/src/lib/inputAssistance/validationSuite.ts:353#const create = allow.createEntity;` emits an "Add a new …" row whose label names the record the context would mint (`artifacts/api-server/src/lib/inputAssistance/validationSuite.ts:360#label:`), gated at `artifacts/api-server/src/lib/inputAssistance/creation.ts:418#const creatable = CREATABLE_ENTITY_BY_CONTEXT[context];` by TWO policy conditions — the context must be one that creates that kind of record (`artifacts/api-server/src/lib/inputAssistance/creation.ts:112#const CREATABLE_ENTITY_BY_CONTEXT`) and the context's policy must declare the entity type — which is what makes it "under policy" rather than a hard-coded table. It carries **no new §43 action type**: it is a `set_structured_value` with a `create_entity` kind, the same shape `checkHashtag` already uses, so §43's union is unchanged and the row is resolvable under `isResolvable`. Proven at `artifacts/api-server/src/test/inputAssistanceCreation.test.ts:512#§37 new-entity creation under policy (G240)` — five cases including `artifacts/api-server/src/test/inputAssistanceCreation.test.ts:527#hidden_gem_location offers 'Add a new Gem'` and `artifacts/api-server/src/test/inputAssistanceCreation.test.ts:538#a city picker still offers NO creation row`. Mutation-proven twice (force `createEntity: null`; drop the `entityTypes` half of the gate). **One mutation did NOT go red and is recorded in the test file rather than hidden**: adding `city_picker` to the context map leaves the city-picker refusal green, because that policy declares no `action` type and refuses first — §12.5's "one gate masked another". |

### §38 Failure Fallback Ladder

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G241 | The ladder: canonical → cached canonical → approved provider → local index / recent history → raw query | W | *Stale-cell repair 2026-09-21, no verdict move.* Canonical (`gateway.ts:343-404`), cached (`suggestionCache.ts`) and raw query (`projection.ts:213-229`) were always real. TWO SENTENCES IN THE PREVIOUS CELL ARE NOW FALSE AND ARE CORRECTED HERE. The local-index rung is no longer only `suggestionCache.ts:185#longestPrefix`: a SHIPPED index sits under it (`travel-buddy-standalone/src/platform/input-assistance/data/cities.ts:73#export const CITY_INDEX` and the three static dictionaries, G197/G198), consulted at `travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:337#export function offlineLocalRows`. And "the local-HISTORY half of rung 4 is still the in-memory store of G199/G261" is false: it is device-local and survives a restart (`travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts:123#export async function attachLocalRecents`, G199). The rungs are now ORDERED against each other in one place rather than implied — retained server rows first, then the shipped index, then the raw query (`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:269#RETAINED rows come first and a dictionary row never displaces one`, `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:301#the raw-query rung is LAST`). WHAT STILL KEEPS THIS `W`, unchanged: **approved provider has no producer at all** (G222). This row is the LADDER, and it is red only when every rung has something on it. |
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
| G260 | `services/entityResolution.ts` | W | Unchanged and re-verified: `:44-58` still passes through a suggestion that is already resolved and returns `null` otherwise, with "Phase 2 replaces the null branch" in the body. It resolves nothing the server did not already resolve. *(unused)* **Not attempted this pass by ownership**, not by difficulty: `services/entityResolution.ts` is the preview/local lane's file in this wave and a second editor would have collided. WHAT WOULD TURN THIS RED: the null branch resolving an UNRESOLVED row — which needs a local entity index to resolve against (G212/G214), so this row is downstream of §34's local-index gap and cannot close before it. |
| G261 | `services/suggestionHistory.ts` | W | Unchanged: an in-memory `Map` (`:31-32`), documented as not the persistent store, *(unused)*. **Not attempted this pass by ownership** — `services/suggestionHistory.ts` is the personalization lane's file in this wave. The reasoning §9.8 recorded still holds and is worth keeping in front of whoever takes it: AsyncStorage is already a dependency and already mocked in the harness, so PERSISTING the store is small; the work is the CONSUMER (record on select, serve as zero-state), and persisting an unread store would produce a second `⌀` rather than a capability. Note that the zero-state SURFACE that consumer would render into now exists (G172), which removes one of the two things it was missing. |
| G262 | `services/suggestionCache.ts` | C | `:18-33`. |
| G263 | `services/inputTelemetry.ts` | W | Unchanged at this commit and **not this lane's file** — `services/inputTelemetry.ts`, `telemetryBatcher.ts` and `telemetryTransport.ts` are the telemetry lane's in this wave, and this row is read-only here. The scrub and allowlist are real (`:48-72`), the nine event names have real call sites, and `requestId` now rides every event (`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:148-151`) — but the sink is still `let sink: TelemetrySink = () => {}` (`:35-36`) and `setTelemetrySink` is still called from no non-test file. Emission is not measurement: in production these events are produced and dropped. WHAT WOULD TURN THIS RED is one line at app bootstrap, `travel-buddy-standalone/app/_layout.tsx` — §12.6 writes it out verbatim — plus a destination for what it attaches. |
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
| G274 | QueryNormalizer | C | The service now exists: `lib/inputAssistance/queryNormalizer.ts:553#export function normalizeQuery` is the single entry point, and `lib/inputAssistance/gateway.ts:253#const norm: NormalizedQuery` is its only caller in the suggest path. It COMPOSES rather than replaces — `applyAliases` and `sanitizeQuery` are still Discovery's, and the canonical fold is still `canonicalLocations` — and adds the three §10 clauses that had no implementation anywhere (transliteration G61, context-appropriate emoji handling G62, keyboard-weighted typo tolerance with a confidence measure G63). The pipeline order is fixed and documented in the file header: trim → sigil → transliterate → emoji → alias → typo → sanitize → clamp. It returns `aliased` unchanged for the §18 temporal extractor and the semantic parser, so those two consumers see byte-identical input to what they saw before this file existed. The client comment this row quoted — *"Real alias resolution belongs to the server's QueryNormalizer (§40)"* — now names something real; the client mirror itself is still local-only, which is G340/G344's problem, not this row's. |
| G275 | EntitySuggestionService | C | `gateway.ts:601-640` `dispatchAndProject`. |
| G276 | CityResolver | C | `geoResolver.ts:120-145`. |
| G277 | CountryResolver | C | **Table reconciled 2026-09-21 — the narrative did not overclaim; this cell was stale.** §13 re-measured this row at `a97bfdac0` clause by clause and moved it `W → C`, and the §4 cell kept the old five-clause sentence, so the document printed `W` here and `C` in §13.2. Re-read at this commit and §13's grading holds: the canonical resolver exists (`artifacts/api-server/src/lib/countryCodes.ts:286#export function searchCountryRegistry(` — 216 ISO-3166-1 codes over seven ranked rungs, pure, no I/O), it is CONSUMED rather than duplicated (`artifacts/api-server/src/routes/discoverySearch.ts:2184#const registry = searchCountryRegistry(q, offset + fetchLimit);` is read FIRST and the profile leg survives as the second leg, folded by ISO code), and it is REACHED from `country_picker` through `dispatchSearch` (`artifacts/api-server/src/routes/discoverySearch.ts:2411#return searchCountries(sc, q, blockedSet`). The row's fifth clause — *"a country with no users in it does not exist"* — is refuted by a test that resolves a country with zero profiles in the database (`artifacts/api-server/src/test/discoveryCountryRegistry.test.ts:237#R2`), and the privacy refusal is pinned in both directions (`R8`/`R9`), so the registry leg cannot answer when the privacy reads refused. 20 tests, 20 pass at this commit. `C`, not `C ᵖ`, for §13.2's reason. The count does not move: `check:census-integrity` already took §13.2's verdict as this row's live one. |
| G278 | PlaceResolver | C ᵖ | `discoverySearch.ts:2387#searchPlaces`. |
| G279 | HiddenGemResolver | C ᵖ | `discoverySearch.ts:2395#searchHiddenGems` + `:289-303#gemSearchPosition`. |
| G280 | UserResolver | C | `socialIdentity.ts:146-229`. |
| G281 | TripResolver | C ᵖ | `discoverySearch.ts:2380#searchTrips`. |
| G282 | EventResolver | C ᵖ | `discoverySearch.ts:2373#searchEvents`. |
| G283 | BuddyResolver | W | Unchanged, re-verified at this commit. `discoverySearch.ts:2365#searchTravelers` is `searchTravelers` with `isBuddy`, whose only buddy-specific predicate is `:587#buddy_verified_at` `.not("buddy_verified_at","is",null)`. No category, availability or eligibility resolution (G71, G127). WHAT WOULD TURN THIS RED: a buddy arm that reads the service CATEGORY and the AVAILABILITY window the buddy declared and filters on them, plus the eligibility resolution §29 asks for, proven by a test where a verified buddy who offers a different service or is unavailable in the asked window does NOT resolve. The data those predicates would read is `rent_a_buddy`'s, not this layer's, which is why this row has stood: it needs that schema's owner to say which columns are the contract. |
| G284 | IntentSuggestionService | C | `semanticIntent.ts:336-379`. |
| G285 | SemanticQueryParser | C | `semanticParser.ts:525-589`. |
| G286 | PersonalSuggestionService | C | `personalization.ts:159-436`. ☠prod |
| G287 | LiveSuggestionService | C | `liveSuggestions.ts:250-317`. ☠prod |
| G288 | ValidationService | C | `validationSuite.ts:30-341`. |
| G289 | DuplicateDetectionService | C | `duplicateDetection.ts:89-468`. |
| G290 | SuggestionRanker | C | `projection.ts:326-383`. |
| G291 | SuggestionDedupeService | C | `gateway.ts:389-400` (cross-type id dedup), `:534-546` (duplicate/entity collapse), client `services/suggestionRanking.ts` `dedupeSuggestions`. |
| G292 | SuggestionTelemetryService | W | **Table reconciled 2026-09-21 — this cell was stale, not this verdict.** §12.1 moved this row `N → W` and the §4 table kept the old "there is no server-side telemetry service" sentence, which is false in all four of its clauses at this commit: `lib/inputAssistance/telemetry.ts` exists, `POST /input-assistance/telemetry` exists and migration 2950 exists. §12.2 refused the `C` the building lane itself argued against, and that refusal still stands and is the reason this is `W` rather than `C`: **migration 2950 has never been executed anywhere** — not production, not `portava-ci` — so its `DO $post$` postconditions have never run, the route takes its 503 refusal branch on every call, and the serve log has no rows and cannot acquire any. WHAT WOULD TURN THIS RED: 2950 applied to a database, the route's 503 branch no longer reachable there, and one serve observed in the log. The count does not move. |

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
| G300 | `set_structured_value` | C | `projection.ts:191`, `:222`, `:260`; `socialIdentity.ts:335`, `:428`, `:501`; `validationSuite.ts:210`, `:245`. |
| G301 | `submit_search` | C | `projection.ts:300`; `semanticIntent.ts:175`, `:204`; `validationSuite.ts:347`. |
| G302 | `add_to_trip` | C | `semanticIntent.ts:290`; the only client-dispatchable action (`search/smartActions.ts:41-43`). |
| G303 | `share_entity` | N | Unchanged: declared at `types.ts:223` and client `types/suggestionAction.ts:24`, and a repo-wide search at this commit still finds **no producer**. §21's Telegraph action row depends on it, as does G133 and §54's worked example (G362). **Deliberately not built this pass, and the reason is the rule about no-ops rather than effort.** A producer is small — the §21 trigger, the eligibility read and the row are perhaps an hour — but the row would reach nothing: `telegraph_message` has a policy (`policyRegistry.ts:299-306`) and **no registered field**, and no Telegraph composer imports the platform (`app/telegraph/new.tsx` is the RECIPIENT picker only; the message composer is a different screen and consumes none of this). Producing a `share_entity` row into a context nothing mounts would add a second unreachable artifact beside `open_compass`'s old one, not a capability. WHAT WOULD TURN THIS RED, in order: a registered `telegraph_message` field on the composer screen (G362's half), then a producer that resolves the shared entity from rows the privacy gate ALREADY returned — never a fresh read — and restricts the shared classes to ones the recipient's own access can be decided for, then a test that a non-shareable entity class is refused. |
| G304 | `drop_pin` | C | `validationSuite.ts:310`. |
| G305 | `open_compass` | C | The action the server emits now reaches a screen. It was produced (`semanticIntent.ts:259`) and discarded by every client surface: the grouped-row bridge cannot render it (no entity id, no route, not a submit) and `search/smartActions.ts` excluded it from `DISPATCHABLE_ACTION_TYPES`, so every one of them was dropped silently. The pair moved in lock-step, which is what that module's header requires of any addition: `travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts:54#'open_compass',` lifts the row into the action-chip lane (and the bridge therefore skips it, so it lands in exactly one lane), `travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts:139#export function getOpenCompassTarget` resolves it to a prompt, and `travel-buddy-standalone/app/search.tsx:497#const compass = getOpenCompassTarget(suggestion);` dispatches it through `prefillMessage` — the handoff the Compass screen ALREADY accepts from Layover's "Ask locals", reused rather than a second mechanism invented beside it. The prompt handed over is `replacementText`, the user's OWN words, not the structured restatement in the row's label: handing Compass the restatement would be the layer putting words in the user's mouth. Proven end-to-end with only the network stubbed at `travel-buddy-standalone/app/__tests__/search.openCompassDispatch.component.test.tsx:291#lifts the row into the action lane and dispatches it to Compass`, plus the lift itself at `travel-buddy-standalone/src/platform/input-assistance/search/__tests__/smartActions.test.ts:138#an open_compass row is lifted into the dispatchable action lane`; mutation-proven three ways (remove the set member; delete the dispatcher branch; hand over the label). `share_entity` and `drop_pin` are still refused by that set, asserted, so this did not widen it into a bucket. |

### §44 Telemetry and Observability

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G306 | Measure usefulness without unnecessarily capturing raw private text | W | Both halves now exist. PRIVACY: `services/inputTelemetry.ts:48-62` drops `text`/`query`/`rawText`/`message` for a non-capturing field, `telemetryBatcher.ts` copies six fields BY NAME onto the wire rather than spreading the event, the ingest REBUILDS each event from a per-name allow-list of ints, unit floats, bools and 64-char enum tokens (`lib/inputAssistance/telemetry.ts:168#export const TELEMETRY_EVENT_PROPS`), and migration 2950 stores no account id and RAISEs at apply time if a column is ever added that would. MEASUREMENT: the sink is attached at app boot — `travel-buddy-standalone/src/platform/input-assistance/services/installInputTelemetry.ts:124#export function installInputTelemetry`, mounted by `travel-buddy-standalone/app/_layout.tsx`'s `InputTelemetrySetup`, flushed on background, idempotent, and disposing restores the default. Proven end-to-end in `services/__tests__/installInputTelemetry.test.ts` (11 tests): an event emitted BEFORE install reaches nothing, the same event after install reaches a poster, raw text still does not survive the installed path, and a refused batch is dropped and COUNTED rather than retried. MUTATION: deleting `setTelemetrySink(batcher.sink)` turns six of them RED; deleting the `<InputTelemetrySetup />` mount turns the source-scanning ratchet RED. ☠prod: migration 2950 is unapplied on production AND on portava-ci (`scripts/checkProductionDrift.ts:615-616`), so the ingest answers 503 and every batch is dropped-and-counted today. Nothing has been MEASURED; what changed is that the measurement now has an unbroken path and one applied migration away from producing numbers. WHAT WOULD TURN THIS RED: removing the bootstrap call, or widening the ingest allow-list to admit a free-text key. ☠prod. **INTEGRATOR'S RULING, 2026-09-21: this stays `W`, and the lane that wrote it said so itself** — *"This C is granted on the owner's standing instruction ... and it is in tension with §12.2", "If that ruling governs here too, this row is `W`; the evidence in it is the same either way."* It does govern. §12.2 refused a `C ` for `G292` on this exact migration, and the owner's closing rule is that a requirement whose acceptance needs live behaviour does not become correct because the code is correct with a note. The attached sink is real and mutation-proven and none of that evidence is withdrawn; what is missing is the last link. **AND ONE FACT IN THIS SECTION WAS WRONG AND IS CORRECTED HERE:** 2950 is NOT "unapplied everywhere". Measured against both databases on 2026-09-21: `input_assistance_telemetry_events` EXISTS on portava-ci with a ledger row `applied_by='ci'`, and is ABSENT from production with no ledger row at all. So the round trip is demonstrable on CI and is dead in production — which makes this row's closing evidence concrete rather than hypothetical. TURNS GREEN WHEN: a live-DB suite emits a §44 event through the installed sink and reads the row back out of `input_assistance_telemetry_events`, AND the table exists in production. ☠prod (2950). |
| G307 | `input_opened` | C | `SmartInput.tsx:170`. |
| G308 | `query_length_changed` | C | `useInputAssistance.ts:281#query_length_changed`. |
| G309 | `suggestion_request_started` | C | `useInputAssistance.ts:163`. |
| G310 | `suggestion_request_completed` | C | `useInputAssistance.ts:252`. |
| G311 | `suggestion_rendered` | C | Emitted from `components/SmartInput.tsx:300#emitSuggestionsRendered(telemetryField, suggestions)`, in an effect keyed by the id-SIGNATURE of the rendered list so a re-render of the same rows does not inflate the count and a genuinely new list does. Shaped by `services/inputTelemetry.ts:171#export function emitSuggestionsRendered`, which carries `count` and sorted TYPE names and deliberately no labels — a rendered recipient list is a list of people. This is §57's missing denominator. Proven by driving the REAL `SmartInput` in `components/__tests__/inputTelemetryFunnel.component.test.tsx` (NEW FILE — a `*.component.test.tsx`, which the standalone package's jest run discovers by `testPathPattern`, so no curated registration list had to be edited): one impression per list, none for an empty result set, and no label in the payload. MUTATION: deleting the call turns three assertions RED. |
| G312 | `suggestion_selected` | C | `SmartInput.tsx:104-110`. |
| G313 | `suggestion_dismissed` | C | §45's IGNORED arm now has a call site. `components/SmartInput.tsx:179#const shownRef` holds what is currently in front of the user and a companion `acceptedRef` holds whether they took any of it; when a shown list goes away untaken — blur, Escape (`components/SmartInput.tsx:406#emitSuggestionsDismissed(telemetryField, shownRef.current.count, 'escape')`) or an emptied field — `components/SmartInput.tsx:291#emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur')` records it with the size of what was passed over. The complement matters as much as the event: a list whose suggestion WAS taken is never also counted as ignored, or the loop would learn nothing from either arm. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`. MUTATION: setting `acceptedRef.current = true` in the render effect turns it RED. |
| G314 | `raw_search_submitted` | C | Both paths emit. Tapping a `submit_search` row: `components/SmartInput.tsx:350#emitRawSearchSubmitted(telemetryField, (s.replacementText ?? value ?? '').length, true)`. Pressing return on the typed text without resolving anything: `components/SmartInput.tsx:462#emitRawSearchSubmitted(telemetryField, value.trim().length, false)`, on a new `onSubmitEditing` that still forwards the caller's own handler. `viaSuggestion` distinguishes them, and only a LENGTH travels. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx` for both paths. |
| G315 | `manual_value_kept` | C | §45's EDITED arm. `components/SmartInput.tsx:453#emitManualValueKept(telemetryField, value.trim().length)` fires on blur when assistance WAS shown, nothing was accepted, and the field still holds the user's own text. It carries a LENGTH and never the text, so it is emittable on a caption or a private message whose policy forbids raw capture — asserted directly, not assumed. This is §57's manual-fallback numerator. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`, including the negative: accepting a suggestion is not a manual keep. MUTATION: dropping the `!acceptedRef.current` guard turns it RED. |
| G316 | `validation_shown` | C | Emitted alongside the impression whenever the rendered list contains a `validation` row: `components/SmartInput.tsx:302#if (validations > 0) emitValidationShown(telemetryField, validations)`, shaped by `services/inputTelemetry.ts:189#export function emitValidationShown`. §23's validations have been produced and rendered since Phase 5; nothing recorded that they were ever SEEN, so a user who ignored a warning was indistinguishable from one who never got it. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`, with the negative case (an empty list emits neither event). |
| G317 | `correction_accepted` | C | `components/SmartInput.tsx:347#if (s.type === 'correction') emitCorrectionAccepted(telemetryField, s)`, carrying the correction's CONFIDENCE (`services/inputTelemetry.ts:223#export function emitCorrectionAccepted`) — which is now a real measured quantity rather than a nominal one, because §10 typo tolerance computes it (G63). Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx` by pressing a real correction row through `SmartInput`. |
| G318 | `disambiguation_selected` | C | `components/SmartInput.tsx:348#if (s.type === 'disambiguation') emitDisambiguationSelected(telemetryField, s)`, carrying `entityType` and confidence (`services/inputTelemetry.ts:248#export function emitDisambiguationSelected`). It is not redundant with `suggestion_selected`: §57 asks for a wrong-selection reversal rate and a duplicate-prevention count, and both need to know WHICH KIND of row resolved the field. Proven in `components/__tests__/inputTelemetryFunnel.component.test.tsx`. |
| G319 | `action_completed` | C | The census named the owner of this event — "the global-search screen calling `emitActionCompleted` after the trip picker CONFIRMS" — and that screen now does. `app/search.tsx` passes BOTH outcomes of `TripWishlistPicker` into `services/inputTelemetry.ts:271#export function emitActionCompleted` under `discovery.search`/`global_search`: `onSaved` reports `ok: true`, `onSaveFailed` reports `ok: false`. The failure arm is the part that took a code change — the picker previously told its caller only about successes, so a wired caller could have reported `ok: true` forever, a flag that cannot go red. SmartInput still does NOT emit on the tap that opens the picker, and the ratchet asserts that too: §21 actions are propose-only and an abandoned picker is not a success. Proven behaviourally in `src/components/discovery/__tests__/TripWishlistPicker.actionCompleted.component.test.tsx` (4 tests: confirmed, failed, untoggle-is-neither, abandoned-is-nothing) and structurally by the screen-wiring assertion in `services/__tests__/installInputTelemetry.test.ts`. MUTATION: deleting `onSaveFailed?.(trip)` from the picker's catch turns the failure test RED; deleting the `onSaveFailed` prop from `app/search.tsx` turns the wiring ratchet RED. NOT CLAIMED: `requestId` is null on this event, because this screen's hook does not surface the serve id — so the completion cannot yet be joined back to the impression that produced the action row. That is G355's remaining half, not this row's. |
| G320 | `downstream_task_completed` | **N** | Unchanged as a verdict, sharpened as a blocker. The emitter exists (`services/inputTelemetry.ts:284#export function emitDownstreamTaskCompleted`) and has no caller, because this layer cannot observe the thing: the input field is long gone by the time a trip is saved, an event is created or a message is sent. This is the outcome signal §45's whole loop is built on (G5/G14/G322/G323 all depend on it). TWO things it needs, not one. (1) A call per completed task from `app/trip/new.tsx`, `app/events/create/index.tsx` and `app/telegraph/new.tsx` — none of which is this lane's file — carrying the fieldId that served the creation, which those screens do not currently retain. (2) A CONSENT GATE, which the other thirteen events do not need. Every other §44 event is a fact about a UI interaction; this one asserts that a real-world task really happened, which is the class of claim D4 Intelligence-Contribution consent governs — `wallAnalytics.ts:216-249` gates exactly that arm and nothing else. The gate belongs in `installInputTelemetry.ts`, in front of the sink, and is named there. WHAT WOULD TURN THIS RED: both, together. Shipping (1) without (2) would route an outcome claim past the consent the rest of the product routes outcome claims through. |
| G321 | For private-message fields, prefer metadata events over raw message text | C | `policyRegistry.ts:51-54` `METADATA_ONLY_TELEMETRY` on `telegraph_message`; `logRawText: false` on every policy (`:40`); `services/inputTelemetry.ts:48-62` enforces the scrub client-side. Certified at `test/inputAssistanceCertification.test.ts:443-476`. |

**Thirteen of fourteen named events fire, and they now reach a transport.**
*(Restated 2026-09-21. This paragraph read "Five of fourteen named events fire.
The nine that do not are the entire outcome half of the taxonomy", which had
been overtaken by its own table: twelve of the fourteen had call sites by the
end of Phase 11, and `action_completed` is the thirteenth as of this pass.)*
The one that does not is `downstream_task_completed` (G320), and it is still the
outcome signal §45's loop is built on. The sink is attached (§3 fact 5), so the
thirteen are produced, batched and POSTed rather than dropped in the emitter —
but migration 2950 is unapplied, so the ingest refuses them and the batcher
counts the loss. Nothing in §44 has been measured; every §44 and §57 `☠prod`
below names that one migration.

### §45 Learning Loop

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G322 | Suggestion shown → selected/ignored/edited → did the downstream task succeed → rank calibration | W | **Three of the four arms now exist.** "Shown" is `suggestion_rendered` (G311), "ignored" is `suggestion_dismissed` (G313) and "edited" is `manual_value_kept` (G315), all three emitted from real `SmartInput` call sites and mutation-proven. What is still missing is the half the loop is actually FOR: **"downstream success"** (`downstream_task_completed`, G320) has an exported emitter and no caller, because this layer cannot observe it — the input field is long gone by the time a trip is saved — and **there is still no calibration step**: `applyPriorSelectionBoost` remains a fixed formula over a raw count, not a model fitted to outcomes. WHAT WOULD TURN THIS RED: a feature screen calling `services/inputTelemetry.ts:284#export function emitDownstreamTaskCompleted` on a completed save/create/send, plus a ranking term that reads the resulting shown/ignored/completed ratios. The first needs the Trips / Events / Telegraph screen owners; the second needs somewhere for the events to LAND, which is G263. |
| G323 | Optimize for successful resolution / task completion / appropriate action / real-world outcome; **do not optimize merely for suggestion acceptance rate** | W | Unchanged: `personalization.ts:220-228` scales `MAX_BOOST` by `selection_count` and nothing else moves rank, so the named anti-pattern is still the whole learning signal. The ignored/edited arms are now emitted (G313/G315) but no ranking term reads them. WHAT WOULD TURN THIS RED: a rank term whose input is an OUTCOME rather than an acceptance — and, before that, a telemetry destination (G263) plus a `downstream_task_completed` caller (G320). |

### §46 Accessibility

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G324 | Screen readers announce field purpose, suggestion count, active suggestion **and selection result** | C | **ACCOUNTING CORRECTION, NOT A VERDICT MOVE.** This cell printed `W` and *"selection result is never announced"* while **this document's own live verdict has been `C` since §9.3**, and §12.4 named the contradiction and deliberately did not edit it (*"a prose table that disagrees with its own document is §16.6's problem, not a verdict move"*). §16.6 does not exist; the disagreement has now stood through three passes, so the table is restated to the verdict the rows already carry. **The headline does not move: C/W/N already counted this row as `C`.** The evidence, re-read on this branch: purpose `travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:431#accessibilityLabel={a11yLabel}`; count, a polite live region at `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:301#accessibilityLiveRegion="polite"`; active row `travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:67#accessibilityState={{ selected: !!active }}`; and the selection result at `travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:367#AccessibilityInfo.announceForAccessibility`, whose sentence says "Field updated" only when the field really was rewritten. Eleven assertions in `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx` were re-run green on this branch. What is proven is the BRIDGE CALL and the sentence; that VoiceOver spoke it on a handset is `docs/architecture/input-assistance-a11y-device-protocol.md` §4 observation D, **NOT RUN**. |
| G325 | Arrow-key and keyboard navigation on web/desktop | C | `SmartInput.tsx:129-148` — ArrowDown/ArrowUp wrap the active index, Enter selects, Escape clears and blurs. |
| G326 | VoiceOver/TalkBack focus management on mobile | **N** → **C** | `setAccessibilityFocus` no longer "appears nowhere": `travel-buddy-standalone/src/platform/input-assistance/components/a11yFocus.ts:54#AccessibilityInfo.setAccessibilityFocus(handle)`, reached from `travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:324#if (restore) moveAccessibilityFocusTo(inputRef.current)`. **I DEPARTED FROM THE ROW'S OWN SKETCH ON ONE HALF AND THE DEPARTURE IS THE ARGUMENT.** The row asked for focus to be moved "on overlay open/close". CLOSE is built: the overlay is a transient surface, and when it unmounts a screen-reader cursor that had walked into the list is on a node that is gone — iOS VoiceOver answers that by jumping to the top of the screen — so the cursor is pulled back to the input. OPEN is deliberately NOT built, because a suggestion list opens on a KEYSTROKE: taking the cursor out of the text field on every character would make the field untypeable with a screen reader on. That is not a smaller build, it is the opposite defect, and the no-steal behaviour is PINNED by a test (*"OPENING the overlay never steals the cursor out of the field"*) precisely so a later pass cannot close this row by breaking typing. The decision is a pure function, `travel-buddy-standalone/src/platform/input-assistance/components/a11yFocus.ts:74#export function shouldRestoreFieldFocus`, so the POLICY is assertable without a screen reader; the third clause — do not drag the cursor back to a field the user LEFT — is asserted too. WHAT IS PROVEN: the bridge call reaches `setAccessibilityFocus` with the handle it was given (`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/a11yFocus.component.test.tsx`, unmocked — `findNodeHandle` returns a numeric handle verbatim, so no mock is in the chain), and `SmartInput` calls it on exactly the right transitions (`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx`). Seven mutations were applied and each turned the suite red. WHAT IS NOT PROVEN: that VoiceOver or TalkBack honoured the request. No test in this environment can; `docs/architecture/input-assistance-a11y-device-protocol.md` §4 carries the handset procedure and its ledger reads **NOT RUN**. |
| G327 | No suggestion overlay trapped behind the software keyboard | **?** | **VERDICT UNCHANGED, AND THAT IS THE POINT.** The "no mechanism" half of this row is now false and the "needs a device" half is not. MECHANISM: `travel-buddy-standalone/src/platform/input-assistance/components/overlayFit.ts:128#export function overlayFit` caps the card to the band actually visible between the field's bottom edge and the keyboard's top edge, fed by a real `Keyboard` height listener (`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:229#Keyboard.addListener('keyboardDidShow'`) and a `measureInWindow` of the field, and applied at `travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:504#maxHeight={fit.maxHeight}`. The old behaviour was a literal `maxHeight = 320` at every position on every screen: a field 400 px down an 800-px window with a 300-px keyboard had 92 px of visible room and drew 320. Fourteen assertions in `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlayFit.test.ts` prove the geometry and five mutations turn it red. WHAT THAT IS NOT: an observation. The inputs are fixtures; on a handset they come from `measureInWindow` and `keyboardDidShow`, and whether those report what the module assumes is a device question. **AND THE RESIDUAL IS REAL AND NAMED**: the overlay is an inline sibling of the input, so this layer cannot flip it ABOVE the field; below `MIN_OVERLAY_HEIGHT` (96 px) the fit stops shrinking and the card IS partly occluded, which `overlayFit` reports as `occluded: true` and the test asserts rather than hides. `docs/architecture/input-assistance-a11y-device-protocol.md` §2 is the runnable handset check — one field is live today (`WallHeader`, the only `SmartInput` in the app), four ledger rows, all **NOT RUN**. The row closes when an operator fills them, not before. |
| G328 | Dynamic type and large text support | **?** | **VERDICT UNCHANGED.** Both code-answerable halves the row named are fixed and neither fix is an observation. The height cap now grows with the OS text scale (`travel-buddy-standalone/src/platform/input-assistance/components/overlayFit.ts:97#export function scaledOverlayCap`, bounded at 3x and then clamped by G327's keyboard band, so the user gets fewer rows rather than a card behind the keyboard), and the rows' line budget grows with it too (`travel-buddy-standalone/src/platform/input-assistance/components/overlayFit.ts:166#export function rowLineLimit` — 1 line below 1.3x, 2 below 2x, 3 above — read at `travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:49#const lines = rowLineLimit(PixelRatio.getFontScale())`), so "Đà Nẵng, Vietnam" wraps instead of becoming "Đà Na…". Proven in `overlayFit.test.ts` and, at the component level, by driving `PixelRatio.getFontScale()` to 2 and asserting the overlay's `maxHeight` is 640 and the row's `numberOfLines` is 3 — both of which were literal constants before. A control case asserts the DEFAULT scale is unchanged, because a mechanism that serves large text by regressing the ordinary case has not served anyone. WHAT IS STILL A DEVICE QUESTION, and it is the row's own: whether the layout survives at the OS's largest setting on real hardware, where the scale, the font metrics and the screen-reader-on row height all come from the platform. `docs/architecture/input-assistance-a11y-device-protocol.md` §3 is the procedure; six ledger rows, all **NOT RUN**. |
| G329 | High contrast and non-color-only state indicators | C | **ACCOUNTING CORRECTION, NOT A VERDICT MOVE** — same shape as G324 above, and named by §12.4 for the same reason. The cell printed `W` while this document's live verdict has been `C` since §9.3. **The headline does not move.** Re-read on this branch: the keyboard-active row carries a caret GLYPH as well as its background tint (`travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:86#<View style={styles.activeSlot}>`), the slot keeps its width so arrowing does not reflow the text, and the caret is hidden from assistive tech on purpose because `accessibilityState.selected` already carries the fact. The assertion that earns the verdict is the one that strips colour out of the question entirely — *"strip every colour and the active row is STILL distinguishable"* compares PRESENCE of a mark against its ABSENCE, not one hue against another. Green on this branch. |
| G330 | Reduced-motion support | C ⌀ | There is no animation in the layer at all: no `Animated`, `LayoutAnimation`, `Reanimated` or CSS transition under `platform/input-assistance/`. Nothing to reduce. Vacuous, but satisfied. |
| G331 | Clear loading / error / empty states | C | `SuggestionOverlay.tsx:71-77` (status string covering all four), `:88-95` (spinner + "Finding suggestions…"), the `unavailable` note, and the `emptyState` slot. |
| G332 | Undo or edit path after replacement | C | Replacement writes through the caller's `onChangeText` into an editable `TextInput` (`SmartInput.tsx:115-117`), so the edit path is intact. There is no undo — the prior text is not retained — but the spec's "or" is satisfied. |

**~~No accessibility test exists anywhere in the layer.~~ THIS SENTENCE WAS
FALSE FOR TWO PASSES AND IS RETIRED HERE.** It read *"All 24 test files under
`platform/input-assistance/**/__tests__/` were listed; none references
`accessibilityLabel`, `accessibilityRole` or any a11y assertion."* §12.4 caught
it (*"there are 32, and one of them is named
`suggestionAccessibility.component.test.tsx`"*) and did not edit it. As of this
branch the layer's accessibility coverage is:

| File | What it holds |
| --- | --- |
| `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx` | 27 assertions: the selection-result announcement and its call site (G324), the non-colour active marker under a colour-blind reading (G329), focus restored on close / never stolen on open / never dragged back after a blur (G326), the row line budget and overlay cap at a driven `PixelRatio.getFontScale()` (G328), and the keyboard subscription (G327). |
| `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/a11yFocus.component.test.tsx` | The bridge call itself, unmocked, plus the pure focus POLICY. |
| `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlayFit.test.ts` | 14 assertions on the keyboard band, the bottom inset, the `MIN_OVERLAY_HEIGHT` floor, the declared `occluded` residual, and the text-scale growth. |

**None of that is a device result, and the distinction is load-bearing for this
section.** `docs/architecture/input-assistance-a11y-device-protocol.md` is the
handset check and every one of its ledger rows reads **NOT RUN**, because no
physical handset exists in any session that has touched this lane. It inherits
the substitution rule from `docs/map/device-measurement-protocol.md`: component
and unit evidence **must not** be entered in those ledgers in place of a
handset. G327 and G328 stay `?` for exactly that reason.

One more §46 fact worth stating plainly, because it bounds every row above:
**`SuggestionOverlay` has exactly one live consumer.** `SmartInput` is the only
component that renders it and `travel-buddy-standalone/src/features/wall/components/WallHeader.tsx`
is the only screen that renders `SmartInput`. `GlobalPlacePicker` and the
Compass screen consume the gateway HOOK and draw their own lists, so they are
not covered by any of this — which is a §39/§52 migration fact, not an
accessibility one, but a reader of §46 should not infer ten screens' worth of
coverage from these rows.

### §47 Security and Abuse Boundaries

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G333 | Do not expose internal IDs unless required by the client contract | C | `projection.ts:82-88` copies only the whitelist; owner ids, host ids, submitter ids and counts are dropped. The ids that do travel (`entityId`, `destination.route`) are the contract's own (§8/§43). |
| G334 | Rate-limit high-volume prefix enumeration where it can reveal private entity existence | C | `routes/inputAssistance.ts:147` (90/min per user) plus the structural defence: the one enumerable private surface, recipient search, is graph-scoped so prefix typing cannot probe for a stranger's existence at any rate. |
| G335 | Protect recipient/user search from account-enumeration abuse | C | `socialIdentity.ts:56-116` — the candidate pool **is** the viewer's own follows/friends/thread-partners/trip-crew, and any read error returns `null` ⇒ no recipients. The header names this as the security property of the file. |
| G336 | Apply authentication and viewer scope before private entity lookup | C | `routes/inputAssistance.ts:107-109` `requireUser` before anything; the user id used downstream is session-derived, never a body parameter (`:181`, `:295`). |
| G337 | Sanitize pasted URLs and untrusted text before rendering | N | Unchanged and re-verified. `sanitizeQuery` (`gateway.ts:163`) is a PostgREST-filter guard that strips only `(),` (`discoverySearch.ts:154-156#sanitizeQuery`) — not a URL sanitizer. No URL parsing, scheme allowlisting or link sanitization exists in the layer. Untrusted *AI* text is sanitized (G339); untrusted PASTED text is not, because no paste path exists (§24, G154–G162). This is the shape §12.3 named: **vacuously unsatisfiable rather than unbuilt work in this layer** — the requirement constrains how a pasted string must be treated GIVEN a paste, and there is no paste. Building a URL sanitizer now would produce a tested function with no caller, which is the failure mode this pass is under instruction to avoid. WHAT WOULD TURN THIS RED, in order: §24's paste handler (a producer of pasted text), then a scheme allowlist applied to it before any row renders the string, then a test that a `javascript:`/`data:` URL pasted into an assisted field never reaches a suggestion label or a destination route. |
| G338 | AI-assisted paths must not bypass validation, moderation or authorization | C | `aiWriting.ts:162-180` `sanitizeSuggestedText` runs the same private-location + policy scanners user-authored text passes and **drops** a failing variant (`:331`) rather than surfacing it; the flag gate is fail-closed (`:80-90`); publish-time validation is untouched because the suggestion re-enters the ordinary create path. |
| G339 | All action suggestions use the same authorization gate as the target action itself | C | Structural: the gateway only ever *proposes* a `SuggestionAction` (`types.ts:191-198`); nothing in `lib/inputAssistance/` executes one, so `add_to_trip` still goes through the trip endpoint's own auth (`semanticIntent.ts:273-276` states it). |

### §48 Versioning and Compatibility

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G340 | Version the field-policy registry independently from app releases | **C** | **MOVED `W` → `C`; the transition reads in the evidence rather than in the verdict cell.** The cell said `**W** → **C**`, which is TWO verdict tokens where `check:census-integrity` parses one — so the checker counted this row as NEITHER, and the headline that added it back by hand was arithmetic on top of an unreadable tally. Same defect G343 records for itself. **THE CLIENT NOW READS THE AUTHORITY, AND THE LOCAL TABLE IS GONE.** This row's own `TURNS GREEN WHEN` named three conditions and all three now hold, each with a test that names it. **(1) The client fetches and caches.** `installInputPolicySync.ts:90#installInputPolicySync` attaches at the app root and fills `services/policyStore.ts:85#PolicyStore`, which is keyed on account AND on `policyVersion` AND on age. **(2) The local registry is not demoted — it is DELETED.** `INPUT_CONTEXT_REGISTRY`'s 29 hand-maintained descriptors are replaced by ONE conservative policy (`contexts/policyFallback.ts:158#CONSERVATIVE_POLICY`), and `contexts/inputContexts.ts:194#getContextDescriptor` resolves from the store. That is stronger than the criterion asked for: the second source of truth does not survive as a fallback, only a deliberately useless one does. **(3) A policy change reaches a client built before it** — asserted verbatim by `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/policyAuthority.test.ts#A POLICY CHANGE ON THE SERVER REACHES A CLIENT THAT WAS BUILT BEFORE IT`, which withdraws personalization and reclassifies `caption` `public` → `viewer_scoped` with no release and shows the running client stop caching it. **EVERY WAY THIS CAN FAIL GRANTS LESS, NEVER MORE**, and that is the part worth reading. Cold start, expiry, a snapshot belonging to another account, a version the authority has retired, a context it did not send, an unreachable server, a 200 carrying rubbish — all seven land on the conservative policy, which has `mode: 'no_assistance'`, an unreachable `minChars`, `privacyClass: 'private_message'` (so the field is uncacheable) and `offlinePolicy: 'unavailable'`. A served value this build cannot name is narrowed to the strictest member of its union by `contexts/policyFallback.ts:230#sanitizeServedPolicy`, and an unreadable `mode` collapses the WHOLE policy rather than just that member — keeping a stranger's `minChars` while discarding their `mode` is acting on half an instruction. **§32 IS NOW ENFORCED IN THE CONSUMER PATH**, which the union alignment of §29 explicitly did not buy: `hooks/useInputAssistance.ts:397#mayRetain` drops retained rows when the server is unreachable and the field's `offlinePolicy` is `server_required` or `unavailable`, via `contexts/policyFallback.ts:280#offlineSurfaceAllowed`. Until that line existed the field was still read by nothing, however exactly the two registries agreed. **ACCOUNT ISOLATION IS NEW, AND IT CLOSED A SEPARATE GAP.** `services/policyStore.ts:198#setActiveAccount` drops the snapshot on sign-out or switch, and the same path clears `sharedSuggestionCache` — whose `clear()` had no caller anywhere in the app before this. Two people signing in on one device shared one process-global map of suggestion lists keyed by the text that produced them. WHAT IT IS NOT: the fetch is not retried on a schedule, and a failed fetch never relaxes anything — it leaves the store as it was, which for an empty store means every field stays unassisted. |
| G341 | Version the suggestion response schema | **C** | **MOVED `W` → `C` BY THE §48 PASS; the transition now reads in the evidence rather than in the verdict cell.** The cell said `W → **C**`, which is two verdict tokens where `check:census-integrity` can parse one — so this row, `G33`, `G341` and `G343` between them, was counted by a human and invisible to the tool (it reported "3 counted where this tool cannot read" for this census, against 0 before the wave). Re-read at this commit before the cell was rewritten; no verdict is changed by the rewrite. The envelope now carries a schema version that is not the policy version: `artifacts/api-server/src/lib/inputAssistance/compatibility.ts:56#export const SUGGESTION_SCHEMA_VERSION = 1`, attached at `artifacts/api-server/src/routes/inputAssistance.ts:289#schemaVersion: SUGGESTION_SCHEMA_VERSION` (and on the degraded envelope too, so a client can tell "this serve failed" from "this serve speaks a shape I do not know"). **IT IS READ, WHICH IS THE HALF THAT MAKES IT A VERSION RATHER THAN A LABEL** — this section is full of members that are declared and consumed by nothing (G25, G30, G32), and one more would not have been a fix. `travel-buddy-standalone/src/platform/input-assistance/services/suggestResponse.ts:94#export function isSchemaCompatible` decides, and `services/inputAssistance.ts` turns a refusal into `unavailable: true`, i.e. §38's fallback ladder, so an older build degrades to its local zero-state instead of rendering rows out of an envelope it cannot parse. The rule is MAJOR-only and one-directional: a newer server shape is refused, a matching or older one accepted, and an ABSENT version reads as schema 1 — which is every deployment before this branch, and is what keeps a newer client working against an older serve (§48's own backward-compatibility bullet, cutting the other way). Both edges are asserted in `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/suggestResponse.test.ts` and four mutations turn them red. The discipline this rests on — additive changes do NOT bump the major — is stated at the constant on both sides. |
| G342 | Preserve backward compatibility for active mobile versions | C ⌀ | Every field added after Phase 1 is optional and additive (`types.ts:281-303`, `:206-244`), so an older client still parses a newer response. Nothing enforces this — no contract test pins the response shape — so it is a property of how the code happened to grow. |
| G343 | Feature-capability handshake for suggestion types unsupported by older clients | **C** | **MOVED `N` → `C` BY THE §48 PASS; the transition now reads in the evidence rather than in the verdict cell.** The cell said `N → **C**`, which is two verdict tokens where `check:census-integrity` can parse one — so this row, `G33`, `G341` and `G343` between them, was counted by a human and invisible to the tool (it reported "3 counted where this tool cannot read" for this census, against 0 before the wave). Re-read at this commit before the cell was rewritten; no verdict is changed by the rewrite. Both directions exist. REQUEST: `SuggestRequest.client` carries the surface's declaration, built at `travel-buddy-standalone/src/platform/input-assistance/contexts/clientCapabilities.ts:117#export const GLOBAL_SEARCH_CAPABILITIES` and put on the wire by `services/suggestBody.ts`. SERVER: `artifacts/api-server/src/lib/inputAssistance/compatibility.ts:150#export function negotiateSuggestionTypes` and `artifacts/api-server/src/lib/inputAssistance/compatibility.ts:174#export function dropUnresolvableActionRows`, both reached from `artifacts/api-server/src/routes/inputAssistance.ts:226#const clientCaps = parseClientCapabilities(body.client)`. RESPONSE: `capabilities: { schemaVersion, suggestionTypes, withheldForClient }`, because a handshake in one direction is a filter — a client needs to tell "no AI rows came back" from "this FIELD is not allowed them", and only the second is worth changing a UI for. **THE ASSERTION THIS ROW RESTS ON IS THE NEGATIVE ONE.** A capability list is a place where a client tells a server what to do, and the way to get it wrong is to let it WIDEN: `negotiateSuggestionTypes` is an INTERSECTION with the policy as the left operand, and the test named *"a client cannot talk its way into a type the policy forbids"* drives a client declaring `ai_suggestion` at `global_search`, whose §6 policy forbids it, and asserts it gets nothing. §48 is a compatibility mechanism; §6 keeps the authority. **AND IT IS NOT VACUOUS.** The census's own example is the one that now negotiates: the global search bar resolves `open_entity`, `submit_search` and `add_to_trip` and drops `share_entity`, `drop_pin` and `open_compass` on arrival — so it declares the three, derived from `DISPATCHABLE_ACTION_TYPES` itself rather than restated beside it, and the serve stops building the rest for that surface. A client that DOES declare `open_compass` still receives it (asserted), so no producer was quietly deleted in the name of saving work. A request with no `client` block is served byte-for-byte as before (asserted), which is what keeps this additive rather than a flag day. The shared overlay's own declaration is honestly WIDE — `SuggestionList` draws every assistance type — and says so rather than trimming itself to look busy. Twelve assertions in `artifacts/api-server/src/test/inputAssistanceCompatibility.test.ts`, five mutations red. |
| G344 | Allow server-side policy updates without a client release where safe | **C** | **MOVED `W` → `C`; the transition reads in the evidence rather than in the verdict cell**, for the reason G340's row now records — an arrow cell is two verdict tokens and is counted as none. **MOVED ON THIS ROW'S OWN STATED CRITERION, BY THE WORK G340 LANDED.** The cell's `WHAT WOULD TURN THIS RED` named two things — "the G340 endpoint, plus a demonstration that a policy edit with no client build changes a field's behaviour" — and both now exist with a test that names each. **(1) The endpoint is read, not merely served.** `GET /input-assistance/policies` is consumed by `travel-buddy-standalone/src/platform/input-assistance/services/installInputPolicySync.ts:90#installInputPolicySync`, which fills `services/policyStore.ts:85#PolicyStore`; `contexts/inputContexts.ts:194#getContextDescriptor` resolves every field from that store and from nothing else. **(2) The demonstration is executable.** `services/__tests__/policyAuthority.test.ts:261#A POLICY CHANGE ON THE SERVER REACHES A CLIENT THAT WAS BUILT BEFORE IT` withdraws personalization on `caption` and reclassifies it `public` → `viewer_scoped` with no release, and asserts the *consequence* rather than the stored field: `viewer_scoped` is absent from `services/suggestionCache.ts:77#CACHEABLE_PRIVACY_CLASSES`, so that field's suggestions stop entering the process-global cache on a binary that shipped before the edit. **THE ROW'S OLD SENTENCE IS WITHDRAWN AS NOW FALSE.** It read "with no policy endpoint, a server-side registry edit reaches a shipped client on exactly zero members", and argued that pinning a member in the parity test "is the opposite of shipping it". Both were exactly true of the client mirror; §30.1 deleted the mirror, so the premise is gone rather than outgrown. **"WHERE SAFE" IS THE LOAD-BEARING CLAUSE, AND IT IS ENFORCED RATHER THAN ASSUMED.** A served policy is narrowed before it is believed: a member this build cannot name is collapsed to the strictest member of its union, a permission grants only on a literal `true`, and an unreadable `mode` collapses the WHOLE policy instead of that member alone (`contexts/policyFallback.ts:230#sanitizeServedPolicy`). So a server-side edit can TIGHTEN a shipped client with no release, and cannot loosen it past what that build already knows how to refuse — which is the precise asymmetry the row's "where safe" asks for. **WHAT THIS DOES NOT BUY**, and it is G340's limit rather than a new one (§30.7): no request has crossed a real network from this environment, so what is proven is the contract and every failure branch, not a deployed handshake. `minChars` and `offlinePolicy` remain served-and-sanitised rather than parity-pinned — §29 argues that is correct, and this row no longer reads it as debt. |
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
| G350 | Offline — static dictionary / cache / no fake live labels / raw-query fallback | **C** | *Four of four, 2026-09-21. The two arms this cell called "untestable because they do not exist" now exist and are tested.* STATIC DICTIONARY: `travel-buddy-standalone/src/platform/input-assistance/data/countries.ts:53`, `travel-buddy-standalone/src/platform/input-assistance/data/languages.ts:32`, `travel-buddy-standalone/src/platform/input-assistance/data/interests.ts:21` (G197), served at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:142`. CACHE: unchanged and already mutation-proofed (`raceAndCache.test.ts`), now with the compact city index behind it (G198) and a device-local store under that (G199). NO FAKE LIVE LABELS: unchanged (`freshnessDisplay.test.ts`, `test/inputAssistanceLiveIntelligence.test.ts`), and strengthened — a local row never carries `freshness` and a stored row carrying one is refused on restore. RAW-QUERY FALLBACK: `travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:310#function rawQueryRow` mirrors the server's own `buildQueryCompletion` field for field, including its `source: 'local'`, and is offered LAST and only to a field the authority licenses `completion` for — `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:285#offline with nothing matching, a search field still offers the RAW QUERY`, `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:294#the raw-query rung obeys allowedSuggestionTypes — a PICKER gets none`, `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:301#the raw-query rung is LAST`, and end to end at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx:249#an offline SEARCH field with no match still offers the raw query`. WHAT THE `C` DOES NOT CLAIM: the raw-query rung reaches exactly one licensed context today (`global_search` is the only one of the offline-licensed six whose `allowedSuggestionTypes` includes `completion`), so "offline raw-query fallback" is true of the field that needs it and vacuous elsewhere by the authority's own declaration. |
| G351 | Accessibility — keyboard / screen reader / focus / dynamic type / reduced motion | W | **Table reconciled 2026-09-21 — this cell was stale, not this verdict.** §12.1 moved this row `N → W` on a Step-0 disproof: *"zero accessibility tests exist in the layer"* was already false, `components/__tests__/suggestionAccessibility.component.test.tsx` being eleven passing assertions. The §4 cell kept the old sentence. It is now **two of five** dimensions: the SCREEN-READER one (that file) and the KEYBOARD one, which had no test of any kind — a search for `ArrowDown` across the layer's test files returned nothing — and is now `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionKeyboardNav.component.test.tsx:166#ArrowDown WRAPS at the end` and `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionKeyboardNav.component.test.tsx:178#Enter selects the ACTIVE row`, mutation-proven three ways (remove the wrap, remove the Enter branch, remove the Escape branch). **It stays `W`.** FOCUS MANAGEMENT has no implementation to certify (G326: no `AccessibilityInfo.setAccessibilityFocus` anywhere in the layer); DYNAMIC TYPE and REDUCED MOTION have neither implementation nor test, and both are partly device questions. WHAT WOULD TURN THIS RED: focus moved and asserted on overlay open/close, a text-scale assertion that the overlay's height budget and row heights survive the largest accessibility text size, and a reduced-motion assertion — three builds, not three tests. One harness fact is recorded in the new file rather than worked around: RNTL 14.0.1's `fireEvent(input, 'keyPress', …)` does not reach a TextInput's `onKeyPress` here and fails SILENTLY, so the assertions would have been asserting that nothing happened. |
| G352 | Failure — provider timeout / API error / empty result / partial degradation | C | `test/inputAssistanceCertification.test.ts:369-436`: partial degradation `:370-388`, total data-layer failure → empty 200 `:390-409`, empty result `:427-434`. Provider timeout is untestable because there is no provider (G222). **Note the documented exception**: `:411-425` asserts that an unreadable `profiles` returns **503 `degraded_unavailable`, not a 200** — the ban gate outranks the never-error rule. The certification's flat claim "(never a 500 mid-keystroke)" is now qualified by a deliberate non-200. |
| G353 | AI — no silent insertion / no canonical-fact invention / correct opt-in and provenance | C | `test/inputAssistanceCompassAI.test.ts` (15) — opt-in mutation-proofed OFF, `source:'ai'` provenance, `replace_text` only, last-place ordering, coarse context, `sanitizeSuggestedText`. |
| G354 | Performance — P50/P95 latency / cold start / render cost / large index behaviour | **?** | Unchanged as a verdict; the blocker narrows from "no harness exists" to "no run exists". `artifacts/api-server/src/scripts/measureInputAssistanceLatency.ts` is a runnable, read-only harness for three of the four dimensions, with the protocol and the ledger in `docs/architecture/input-intelligence-performance-protocol.md`. It reports the round trip and the serve's own `serverMs` SEPARATELY, keeps cold start on its own line rather than averaging it into a P50, probes large-index behaviour by running the same corpus at both ends of selectivity with result counts beside the times, REFUSES to print a percentile below 60 successful samples, and paces itself at 70 req/min under the route's own 90/min ceiling rather than asking for the limit to be raised. **Render cost is refused, not approximated**: it is overlay frame timing on real hardware and belongs with the device rows. EVERY LEDGER ROW READS NOT RUN. No deployment and no handset were reachable from the session that wrote the harness, which is a failed prerequisite and not a result — the same rule `docs/map/device-measurement-protocol.md` states for its own ledger. A harness is not a number. WHAT WOULD SETTLE IT: an operator with deployment access running §2–§3 of the protocol, and one with handsets running §4. |
| G355 | Telemetry — no prohibited raw private-text capture; **action/result linkage works** | W | The prohibition half is certified and mutation-proven (`test/inputAssistanceCertification.test.ts:443-476`; client `services/__tests__/inputTelemetry.test.ts`), and now also for the seven new arms. The **linkage** half is still not built: `requestId` is generated per request (`routes/inputAssistance.ts:166`) and no event carries it back, so an impression still cannot be joined to the selection that followed it, and `action_completed` / `downstream_task_completed` still have no callers (G319/G320). WHAT WOULD TURN THIS RED: putting the response's `requestId` into the client's telemetry field and emitting it on every event — which needs `routes/inputAssistance.ts` (not this lane's file) to keep returning it, the client hook to thread it, and a sink to join them in (G263). |

### §50 Required Audit Before Adoption

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G356 | Inventory every current text field and classify it | C | **This row's evidence was stale, not its subject.** It read "three source files cite 'the client audit's §50 field table' as an existing artifact and it is not in the repository"; the table was written in Phase 9 and this census was not re-read against it. `travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:102#export const FIELD_INVENTORY` records all 24 registered fieldIds in registration order, and the three citing files (`social/socialFields.ts:25`, `search/searchFields.ts:19`, `creation/creationFields.ts:27`) now point at something real. It is a RATCHET, not a document: `test/inputAssistanceFieldInventory.test.ts` parses the five registrars out of the source and asserts the inventory and the registrars name the same SET, that no fieldId is listed twice, and that the wall pill's inline registration really is in the component the inventory names. Registering a 25th field without inventorying it goes red. Verified this pass: 14 of 14 assertions pass at `origin/main`. |
| G357 | Record, per field: screen/route, component file, fieldId, InputContext, current implementation, desired mode, entity types, provider/API, zero-state, offline, privacy class, validation, bugs, migration status | C | **Also stale evidence** ("No such record exists in any form"). All fifteen attributes resolve for every field, and the record is deliberately NOT a copy: nine attributes are stored per field and the six the context registry owns — desired mode, entity types, assistance types, offline policy, privacy class, zero-state — are merged in at read time by `fieldInventory.ts:418#export function fieldInventoryRow`, so a §50 row CANNOT disagree with the contract, which is the second-source-of-truth rot that `inputPolicyContractParity` exists to catch. `test/inputAssistanceFieldInventory.test.ts` asserts the merge is complete for every row, that every `componentFile` resolves on disk, that the context each registrar declares is the context the inventory records, and — for `migrationStatus` — that every `mounted` field is referenced OUTSIDE the SDK and every `registered_unmounted` one is not, with a vacuity guard proving the scan can find a reference at all. The finding the table makes visible: of 24 registered fieldIds, 8 are mounted on a screen and 16 are a policy nobody can type into. |
| G358 | Do not assume a field is migrated because it renders SmartInput; verify routing, source, policy and outcome end-to-end | C | This one is genuinely built, and as a **ratchet**: `services/__tests__/selectionWriterCoverage.test.ts` scans the real source for gateway consumers outside the SDK and requires each to reference a recorder or carry a named exemption with its reason. Its header describes exactly the failure this bullet warns about — `GlobalPlacePicker` consumed the gateway, rendered correctly, and recorded nothing. |

### §52 Feature-Team Adoption Rule

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G359 | Do not build a new autocomplete / predictive-text / recents / typeahead / dropdown / AI-writing helper / input resolver inside a feature until the platform has been evaluated | W | Unchanged, re-verified at this commit. Four pre-existing engines remain unmigrated and live (G6) and the one **new** duplicate inside the platform is still there: `compass/compassPrompt.ts` re-implements the Compass starter set client-side under the same name as the server's `buildCompassStarters` (`projection.ts:258`), and `app/(tabs)/ai.tsx:399` calls the client one. **Still no ratchet**, and that is what this row is really about — the rule is a prohibition, and a prohibition with no detector is a convention. WHAT WOULD TURN THIS RED: a check in `artifacts/api-server/src/scripts/` (or the client's `scripts/`) that fails when a file outside `platform/input-assistance/` declares a debounce-plus-abort suggestion loop or a second implementation of a platform export's name, with the four known engines carried as named, reasoned exemptions — the shape `services/__tests__/selectionWriterCoverage.test.ts` already uses for G358. The four engines live in `travel-buddy-standalone/src/hooks/` and `src/components/MentionInput.tsx`, and the ratchet's home is the integration owner's directory; neither is this lane's file set. |
| G360 | New fields are added by registering a policy and consuming shared primitives | C | `contexts/fieldRegistry.ts:26-33` `registerField`, with five idempotent registrars (`geoFields.ts:64`, `socialFields.ts:57`, `searchFields.ts:42`, `creationFields.ts:57`, `compassFields.ts:63-66`) and one screen-level registration (`WallHeader.tsx:29`). Overrides are explicit and auditable (`socialFields.ts:40-44`). |

### §53–§56 Worked Examples (end-to-end)

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G361 | §53 Trip Destination: 0-char defaults → local prefix cache → server canonical resolver → choose → store city_id+country+timezone → prefetch → next fields inherit | W | **Five of seven now, up from four, and one of the two named blockers is gone.** 0-char defaults (`geoResolver.ts:180-257`), the canonical resolver (`:120-145`), the stored binding (`:70-81`) and the field wiring (`components/selectors/GlobalPlacePicker.tsx` → `app/trip/new.tsx`) were already there. The **local prefix cache** this row said did not exist now does: `suggestionCache.ts:185#longestPrefix` consulted at `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:238#localTier` (G204/G214), so step 2 of the worked example is real. Two steps remain: **prefetch does not exist** (G209 — and §17's dependency graph is what blocks it, not the fetch), and "next fields inherit Bangkok context" is still only the exact-`cityId` reorder of G107, not the venue→city→country→coords→timezone cascade §17's own example names (G109). WHAT WOULD TURN THIS RED: those two, in that order. |
| G362 | §54 Telegraph Message: type "meet at" → action candidates (share meeting point / Trip stop / current Place) → eligibility → tap → structured entity share inserted | N | Unchanged, and the dependency is now stated precisely enough that it need not be re-derived. The context has a policy (`policyRegistry.ts:267-274`) and **no registered field**; `share_entity` has **no producer** (G303); and no Telegraph COMPOSER imports the platform — `app/telegraph/new.tsx` is the recipient picker (`hooks/useTelegraphRecipients.ts`), which is §14/§54's other half and the only half that is wired. The two halves block each other in one direction only: a producer with no mounted field is an unreachable row (see G303), but a mounted field with no producer degrades to the ordinary entity assist and is harmless. WHAT WOULD TURN THIS RED, in order: (1) register `telegraph_message` on the composer screen and render `SuggestionOverlay` under it; (2) a `share_entity` producer that resolves its candidates from rows the privacy gate already returned; (3) eligibility — the one genuinely new question, because a Place the SENDER may see is not necessarily one the RECIPIENT may; (4) a test that tapping the row inserts a structured reference and not a styled string (§26). |
| G363 | §55 Hidden Gem Creation: name/location → entity + duplicate search → existing candidates → sensitive-location policy → exact/approximate/pin → confirm → canonical reference | C | Wired end-to-end: `app/gems/submit.tsx:242-244` registers `hidden_gem_name` through `hooks/useCreationAssistance.ts` and renders `CreationAssist` at `app/gems/submit.tsx:274#CreationAssist`; the backend chain is `duplicateDetection.ts:241-370` → `creation.ts:258-296` (constraint filter) → `projectDuplicate:191-215` (`resolve_existing`), with the sensitive-location rule at `discoverySearch.ts:1562#sensitivity_level,` and the pin fallback at `validationSuite.ts:305-315`. |
| G364 | §56 Compass Prompt: type "where should" → suggested prompts → current surface + Trip context attached as structured refs → submit → Compass receives intent + permitted entities | C | `app/(tabs)/ai.tsx:60`, `:398-410` wires `compass_prompt` through `useAiWritingAssist` and renders `CompassStarters` + `AiWritingAssist`; the structured refs are attached at `projection.ts:283-303` and `semanticIntent.ts:231-268` (`open_compass` carrying the parse). |

### §57 Product Success Metrics

*(Restated 2026-09-21. This paragraph read "None of the nine is instrumented.
There is no metric emitter, no analytics transport (G306), and no store any of
these could be computed from." All three clauses have been answered, and the
answer is not "the metrics are now known".)*

**Five of the nine are defined, computable and reachable; four are refused.**
The events have call sites (§44), the transport is attached (§3 fact 5), the
store is migration 2950, and the computation is
`artifacts/api-server/src/lib/inputAssistance/metrics.ts:239#export function computeInputSuccessMetrics`,
asserted to exact values over hand-built rows in
`src/test/inputAssistanceMetrics.test.ts` (31 tests, seven mutations applied and
watched go red). `pnpm --filter @workspace/api-server run report:input-metrics`
is the reader.

**The four with no producer are refused rather than estimated**, each carrying a
blocker string naming what is missing — G368, G370, G373 and G371. A rate over
an event nothing emits is not a zero; it is a number that looks green forever,
and the module's tests assert the refusals so that a later "complete the
dashboard" edit cannot quietly turn them into zeroes.

**No §57 number exists.** Migration 2950 is unapplied on production and on
portava-ci, so the table does not exist and a run today exits with the PostgREST
error rather than printing nine nulls that could be mistaken for a measurement.
That is what the `☠prod` on these rows means, and it is the whole of what
separates them from being real.

| id | Requirement | V | Evidence / divergence |
| --- | --- | --- | --- |
| G365 | Time to valid selection | W | Defined and computed: `metrics.ts:239#export function computeInputSuccessMetrics` builds EPISODES — the run of events for one (`session_id`, `field_id`) pair starting at an `input_opened` — and reports the P50/P95 of open → FIRST `suggestion_selected` across them. The correlator this row said did not exist now does: `telemetryBatcher.ts#newTelemetrySessionId` mints a per-app-run pseudonymous token, the batch carries it and migration 2950 stores it per row. It is not derived from and not resolvable to an account. Asserted to exact values in `src/test/inputAssistanceMetrics.test.ts`, including the two ways this metric goes quietly wrong: an episode that never resolved contributes NOTHING rather than a zero (otherwise the headline falls as the product gets worse), and a backwards clock is dropped rather than recorded as a negative duration. MUTATIONS: keying episodes on `session_id` alone, and dropping the per-(session,field) sort, each turn a test RED. ☠prod: migration 2950 unapplied, so no episode has ever been stored. **W, NOT C — and the reason is this document's own §12.2.** The integration owner declined a `C ☠prod` for G292 on exactly this migration, writing that "a grader who reads `C` as 'works' should read it as `W`." A §57 row asks for a NUMBER, and no number exists or can: 2950 is applied to no database, so `report:input-metrics` exits with the PostgREST error rather than printing anything. What moved is that the metric is now DEFINED, computed and reachable instead of absent — which is the distance from N to W, not from N to C. WHAT WOULD TURN THIS RED: applying migration 2950 and reporting the number. ☠prod. |
| G366 | Valid entity resolution rate | W | Entity-RESOLVING selections over impressions. The denominator is `suggestion_rendered` (G311), which is never emitted for an empty list, so it cannot be inflated by lists nobody could choose from. The numerator counts only `entity`, `personalized`, `recent`, `structured_value` and `disambiguation`: a `completion` puts text in the field, an `action` opens something else, and counting either is how a resolution rate stops meaning resolution — asserted directly in `src/test/inputAssistanceMetrics.test.ts`, where widening that set to include `completion`/`action` turns a 0 into a perfect 1.0 and the test RED. No impressions reports null, not zero percent. ☠prod: migration 2950 unapplied. **W, NOT C — and the reason is this document's own §12.2.** The integration owner declined a `C ☠prod` for G292 on exactly this migration, writing that "a grader who reads `C` as 'works' should read it as `W`." A §57 row asks for a NUMBER, and no number exists or can: 2950 is applied to no database, so `report:input-metrics` exits with the PostgREST error rather than printing anything. What moved is that the metric is now DEFINED, computed and reachable instead of absent — which is the distance from N to W, not from N to C. WHAT WOULD TURN THIS RED: applying migration 2950 and reporting the number. ☠prod. |
| G367 | Manual fallback rate | W | Manual-ending episodes over episodes that ended either way, computed in `metrics.ts`. Two guards carry the meaning and both are mutation-proven: an episode where assistance was never SHOWN is outside the denominator (or the rate becomes a function of how often the backend returns nothing), and a `raw_search_submitted` with `viaSuggestion: true` is not a fallback (or the user TAKING a "search for …" row counts as having fallen back from assistance). An episode that kept text and then came back and chose counts as resolved — the field ended resolved, which is the outcome §57 asks about. ☠prod: migration 2950 unapplied. **W, NOT C — and the reason is this document's own §12.2.** The integration owner declined a `C ☠prod` for G292 on exactly this migration, writing that "a grader who reads `C` as 'works' should read it as `W`." A §57 row asks for a NUMBER, and no number exists or can: 2950 is applied to no database, so `report:input-metrics` exits with the PostgREST error rather than printing anything. What moved is that the metric is now DEFINED, computed and reachable instead of absent — which is the distance from N to W, not from N to C. WHAT WOULD TURN THIS RED: applying migration 2950 and reporting the number. ☠prod. |
| G368 | Wrong-selection reversal rate | **N** | Unchanged, and now refused EXPLICITLY rather than silently: `metrics.ts` returns `{ value: null, blocked: … }` for this metric and `src/test/inputAssistanceMetrics.test.ts` asserts the refusal, so a later edit cannot report 0 for a reversal rate nothing can observe. No event records that a resolved field was later un-resolved. WHAT WOULD TURN THIS RED: a fifteenth name in `INPUT_TELEMETRY_EVENT_NAMES` with a real call site in `SmartInput` (the field's value moving away from an accepted `replacementText`), AND a follow-on migration widening 2950's `iate_event_name_known` CHECK — which enumerates the fourteen names, so an unlisted one fails the whole insert batch at the database. The migration is the blocker this lane cannot clear: 2950 is itself unapplied, and the owner holds migrations. |
| G369 | Duplicate creation prevented | W | The acceptance is now RECORDED rather than inferred. §55's duplicate rows are projected as `disambiguation` carrying a `resolve_existing` structured value (`lib/inputAssistance/creation.ts:225#export function projectDuplicate`), and §19's ordinary ambiguity rows are `disambiguation` too — from the event alone the two were indistinguishable, so "duplicates prevented" could only have been GUESSED at from the context the event happened in, which is a different claim. `services/inputTelemetry.ts:248#export function emitDisambiguationSelected` now carries one bool, `resolvedExisting`, read off the pressed suggestion; the ingest allow-list admits it as a `bool` and coerces nothing, so a client sending the STRING "true" is dropped rather than counted as a prevented duplicate. `metrics.ts` counts it. Proven at the press in `components/__tests__/inputTelemetryFunnel.component.test.tsx` (both polarities, and no label rides along) and at the rebuild in `test/inputAssistanceCertification.test.ts`. MUTATIONS: forcing the flag false, and removing `resolvedExisting` from `TELEMETRY_EVENT_PROPS`, each turn a test RED. It is a COUNT, not a rate: the duplicates a user never saw are unobservable, so there is no honest denominator. ☠prod: migration 2950 unapplied. **W, NOT C — and the reason is this document's own §12.2.** The integration owner declined a `C ☠prod` for G292 on exactly this migration, writing that "a grader who reads `C` as 'works' should read it as `W`." A §57 row asks for a NUMBER, and no number exists or can: 2950 is applied to no database, so `report:input-metrics` exits with the PostgREST error rather than printing anything. What moved is that the metric is now DEFINED, computed and reachable instead of absent — which is the distance from N to W, not from N to C. WHAT WOULD TURN THIS RED: applying migration 2950 and reporting the number. ☠prod. |
| G370 | Downstream task completion | **N** | Unchanged, and refused explicitly in `metrics.ts` with a blocker naming the three screens (`app/trip/new.tsx`, `app/events/create/index.tsx`, `app/telegraph/new.tsx`), asserted in `src/test/inputAssistanceMetrics.test.ts`. A rate over an event nothing emits would be green forever. See G320 for the two things it needs — the screen call sites AND the D4 consent gate the other thirteen events do not need. |
| G371 | Privacy incident count must remain zero (explicit certification metric) | **?** | Unchanged, deliberately, and the blocker is now structural rather than circumstantial. The construction-side guarantees are strong and tested (G183–G191), and this pass added three more (the wire copies six fields by name, the ingest rebuilds from an allow-list, migration 2950 RAISEs if an account id is ever added). NONE OF THAT IS THE METRIC. Whether zero privacy incidents have occurred in production is a fact about production traffic, and the §44 serve log is deliberately INCAPABLE of answering it: it stores no account id, so "an incident happened to someone" is not a fact it could hold. `metrics.ts` refuses this metric with that reason rather than reporting 0, and `src/test/inputAssistanceMetrics.test.ts` asserts the refusal names the privacy property — so a future reader who "fixes" it by adding a `user_id` would be breaking 2950's own postcondition. WHAT WOULD SETTLE IT: production security/audit logs, read by someone with access to them. Nothing in this tree can, and no assertion that there have been zero incidents may be entered here. |
| G372 | P95 suggestion latency | W | This row's stated evidence — "No latency instrumentation anywhere; the response carries no server timing" — was already stale when written against this tree, and the chain is now complete end to end. The serve measures ITSELF (`routes/inputAssistance.ts:192-199`), `serverMs` travels on the response envelope, `services/suggestResponse.ts` parses it and OMITS it rather than zeroing it when a deployment does not send one, `useInputAssistance.ts:327#serverMs: res.serverMs` emits it beside the round trip the device saw, and the ingest allow-list admits both as ints. `metrics.ts` reports P50/P95 for each SEPARATELY — the difference between them is the network and neither side can measure that alone — using NEAREST-RANK, so a reported P95 is a latency the system actually produced rather than an interpolation between two it did not. MUTATIONS: switching to interpolation, and coercing an absent `serverMs` to 0, each turn a test RED. ☠prod: migration 2950 unapplied, so no latency has been recorded. See also G354: a runnable harness for measuring this against a deployment now exists and has NOT been run. **W, NOT C — and the reason is this document's own §12.2.** The integration owner declined a `C ☠prod` for G292 on exactly this migration, writing that "a grader who reads `C` as 'works' should read it as `W`." A §57 row asks for a NUMBER, and no number exists or can: 2950 is applied to no database, so `report:input-metrics` exits with the PostgREST error rather than printing anything. What moved is that the metric is now DEFINED, computed and reachable instead of absent — which is the distance from N to W, not from N to C. WHAT WOULD TURN THIS RED: applying migration 2950 and reporting the number. ☠prod. |
| G373 | Offline completion rate | **N** | *Two of this cell's three conditions are now met, and the row does NOT move on two of three (§33.3).* **(1) The offline BEHAVIOUR exists** — G197/G198/G199 shipped it 2026-09-21. **(2) THE DEGRADED FLAG EXISTS.** The `unavailable` arm, which was the only arm of the request that emitted nothing at all, now emits `suggestion_request_completed` with `{ count, degraded: true }` (`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:455#degraded: true`), proven in six cases at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.degradedTelemetry.component.test.tsx` — including that a `server_required` field degrades with `count: 0`, that a TRANSIENT error is NOT a degraded serve, that the props are exactly `count` and `degraded`, that none of 2950's thirteen refused key names appears, and that the typed text appears nowhere in the payload. No new event name and so no migration: `suggestion_request_completed` is already in `iate_event_name_known`, and the reserved 2963–2969 band was checked and is not needed. **(3) THE PROP-ALLOW-LIST ENTRY DOES NOT EXIST, and that is why this stays `N`.** `artifacts/api-server/src/lib/inputAssistance/telemetry.ts:175#suggestion_request_completed` reads `{ count: 'int', serverMs: 'int', clientMs: 'int' }`; the ingest REBUILDS every event from that list, so `degraded` is dropped on the way in and the stored row cannot be told from an online serve. `metrics.ts` is still correct to refuse the metric. The event deliberately carries NO `clientMs` for the same reason — with the flag dropped, a degraded round trip would land in G372's P95 as if it were a successful serve and pull the quantile toward failures that never touched a network. WHAT WOULD TURN THIS RED: `degraded: 'bool'` in that allow-list, plus a reader in `metrics.ts`. Both are outside the lane that built the producer. WHAT IT STILL WOULD NOT BUY: with no persistent telemetry buffer (deliberately not built — §33.4), an offline session that ENDS offline contributes nothing, so the measurable population is the reachable-network degradations plus the outages an app run outlives. |

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
| G354 | §49 — Performance certification (P50/P95 latency, cold start, render cost, large index) | *(Restated 2026-09-21.)* A harness NOW exists — `artifacts/api-server/src/scripts/measureInputAssistanceLatency.ts`, with its protocol and ledger in `docs/architecture/input-intelligence-performance-protocol.md` — and every ledger row reads **NOT RUN**, because no deployment and no handset were reachable from the session that wrote it. A harness is not a number. Render cost is refused outright as a device fact rather than approximated from a component render. | An operator with deployment access running §2–§3 of the protocol, and one with handsets running §4. |
| G371 | §57 — Privacy incident count must remain zero | The construction-side guarantees are strong and mutation-proven (G183–G191), and three more were added 2026-09-21 (the wire copies six fields by name, the ingest rebuilds from an allow-list, migration 2950 RAISEs if an account id is added). None of that is the metric. The §44 serve log is deliberately INCAPABLE of answering it: with no account id stored, "an incident happened to someone" is not a fact it could hold. `lib/inputAssistance/metrics.ts` refuses this metric with that reason rather than reporting 0, and its test asserts the refusal names the privacy property. | Production security/audit logs, read by someone with access to them. No assertion from this tree may be entered here. |

**Sixteen further rows carry a `☠prod` marker: the code question is settled and
the effect is not.** They are *not* CANNOT-VERIFY, and they are not moved out of their buckets — but a
reader should not count them as working software:

| Verdicts | What is unresolved | What would settle it |
| --- | --- | --- |
| G5, G45, G75, G100, G189, G213, G223, G225, G226, G227, G230, G286 (☠prod) | `input_selection_history` and the `input_record_selection` RPC are absent from production (`scripts/checkProductionDrift.ts:172`), so all of §35 fails soft to an empty memory there | applying migration 2258, or removing the feature |
| G57 | migration 2220 is not applied to production, so the stored `search_key` column does not exist and "Đà Nẵng" is stored under the broken key `"a nang"` | applying migration 2220 |
| G138 (and all of §22) | `compass_ai_writing_enabled` (2221) is absent from production and `isFlagEnabled` is fail-closed, so no AI writing has ever run | seeding the flag, deliberately |
| G194, G221, G287 | every `intel_*` table in production holds zero rows (`docs/architecture/intel-spine-liveness.md`), so the live lane has never attached a label | any production observation |
| G306 and all of §44/§57 | *(Restated 2026-09-21: the sink IS attached — `travel-buddy-standalone/app/_layout.tsx` mounts `InputTelemetrySetup`, ratcheted by a source scan.)* Migration 2950 (`input_assistance_telemetry_events`) is unapplied on production and on portava-ci, so the ingest answers 503 and every batch is dropped-and-counted. The events are produced, transported and refused; none has ever been stored, and no §57 number exists | applying migration 2950 |
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
| G68 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:1562#sensitivity_level,` selects the approximate pair and never the exact one; `:289#gemSearchPosition` fails closed to `hidden`. **The old pointer, lines 960–962, is stale by 224.** |
| G70 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:739#visibility` (events), `:920#visibility` + `:921#show_in_discovery` (trips). Proven through the gateway by `src/test/inputAssistanceCertification.test.ts:350#PUBLIC`. |
| G73 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2412#COMMON_LANGUAGES` — server-side static lists behind `searchStatic`. **The old pointer, lines 1577–1578, is stale by 225.** |
| G92 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:43#tierConfidence` — `tierConfidence(3) = 0.99` over `matchTier`. |
| G93 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:43#tierConfidence` — `tierConfidence(2) = 0.85`, over `routes/discoverySearchHelpers.ts:170#matchTier`. |
| G95 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:585#SearchQueryContext` passes `{lat, lng, userCity}` into the city boost. **The old pointer, line 380, is stale by 16 — this pass moved it.** |
| G126 | `C ᵖ` (unreadable) | **C** | ᵖ | Age: `lib/inputAssistance/gateway.ts:578#ageRestrictedSet`, fail-closed at `:583#blockedSet`. Membership/role: `routes/discoverySearch.ts:921#show_in_discovery`. Trust/invite have no separate gate and no path exposes an invite-scoped object. |
| G128 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:578#ageRestrictedSet` and `:583#blockedSet` — a null set from either suppresses every entity row; the picker branch repeats it at `:901#fetchBlockedSet`. |
| G129 | `C ᵖ` (unreadable) | **C** | ᵖ | Structural: `lib/inputAssistance/types.ts:242#InputSuggestion` has no coordinate field, and `routes/discoverySearch.ts:1562#sensitivity_level,` never selects a gem's exact pair. Deep-scanned by `src/test/inputAssistanceCertification.test.ts:289#findCoordLeaks`. **Phase 9 widened the projection by three fields and this deep scan still passes** (§8.4). |
| G152 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/validationSuite.ts:172#normalization` for hashtag validity, `:264#correction` for the row it produces; handles reuse the pre-existing `lib/usernameRules.ts`. |
| G165 | `C ᵖ` (unreadable) | **C** | ᵖ | Realised in production by the pre-existing `travel-buddy-standalone/src/components/MentionInput.tsx:145#insertTag`, which keeps display text while recording structured tag spans. The platform's own version is still unconsumed. |
| G184 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:578#ageRestrictedSet` and `:901#fetchBlockedSet`; the null-set refusal is the mutation-proven case in `src/test/inputAssistanceGateway.test.ts:384#suppresses`. |
| G185 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:739#visibility`, `:920#visibility`, `:921#show_in_discovery`; proven through the gateway by `src/test/inputAssistanceCertification.test.ts:350#PUBLIC`. |
| G186 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/projection.ts:150#display-safe` — a fixed whitelist that still drops `metadata`, `privacyState`, `accessState`, owner/host ids and counts. **Phase 9 added three fields to that whitelist; none is private (§8.4).** |
| G218 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/gateway.ts:499#dispatchTypes` → `routes/discoverySearch.ts:2292#dispatchSearch`. |
| G220 | `C ᵖ` (unreadable) | **C** | ᵖ | `lib/inputAssistance/entityMap.ts:35#ENTITY_TO_SEARCH` → `routes/discoverySearch.ts:2292#dispatchSearch`. |
| G235 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/inputAssistance.ts:239#input_assist_suggest` (90/min) and `:378#input_assist_select` (60/min). Both still resolve exactly. |
| G278 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2387#searchPlaces`. **The old pointer, line 1568, is stale by 225.** |
| G279 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2395#searchHiddenGems` + `:289#gemSearchPosition`. |
| G281 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2380#searchTrips`. |
| G282 | `C ᵖ` (unreadable) | **C** | ᵖ | `routes/discoverySearch.ts:2373#searchEvents`. |

`ᵖ` still means "correct, but earned by pre-existing work". The spec-attributable
CORRECT is still C minus the count of `ᵖ` rows, which is still 23.
*(2026-09-14: the arithmetic stands — spec-attributable CORRECT is C minus the 23. What those
23 rows ARE attributable to is unknown for most of them; see the method restatement in §2.)*

### 8.4 Row moves — seven NOT-BUILT rows built

| id | was | now | why |
| --- | --- | --- | --- |
| G97 | N | **C** | §15 **TemporalFit** now has a producer. `extractTemporal` was already normalising "tonight" / "tomorrow morning" / "Friday after dinner" into an ISO window; the window went into a search STRING and was discarded. It is now resolved once per request at `lib/inputAssistance/gateway.ts:272#TemporalWindow` and handed to the projection at `:563#temporalWindow`, where `lib/inputAssistance/rankingSignals.ts:104#applyTemporalFit` boosts a row that starts inside it and demotes one that starts outside. Deliberately a RANKING term, not a filter — see the ceiling note in §8.7. |
| G101 | N | **C** | §15 **TrustConfidence** now has a producer. `verified` and `is_official` were selected by `searchTravelers` (`routes/discoverySearch.ts:180#verified?:`) and dropped by the §42 whitelist. `lib/inputAssistance/rankingSignals.ts:130#applyTrustConfidence` reads them into `confidence`, clamped by `:59#SIGNAL_CEILING` strictly below the exact-match band so §9's trust order holds. |
| G180 | N | **C** | §20 **verification / trust context** is displayable. `lib/inputAssistance/types.ts:273#verified` and `:274#official` are projected at `lib/inputAssistance/projection.ts:156#verified` — only when TRUE, so an absent key is "not applicable" and never a negative claim about a person — and rendered as badges by `travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts:40#suggestionBadges`, which the row both renders and announces from one call (`components/EntitySuggestionRow.tsx:44#suggestionBadges`, `:54#badges.map`). |
| G181 | N | **C** | §20 **Hidden Gem protection label**. `gemSearchPosition` already decided whether a gem may carry a centroid and wrote it to `metadata.coordsPrecision`; the projection dropped the whole bag, so a protected gem rendered identically to an unprotected one. `lib/inputAssistance/rankingSignals.ts:151#gemLocationPrecision` reads that word into `lib/inputAssistance/types.ts:283#locationPrecision` at `lib/inputAssistance/projection.ts:159#gemLocationPrecision`. A precision WORD, never a position: `'exact'` is not in the union because the gem path cannot produce one, and a test serialises the row and greps for the centroid. |
| G356 | N | **C** | §50 **the field inventory exists.** Three source files cited "the client audit's §50 field table" as an existing artifact and a repo-wide search returned only those three references to it. `travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:102#FIELD_INVENTORY` is that table — 24 records, one per registered fieldId — and `src/test/inputAssistanceFieldInventory.test.ts:202#registrars` refuses a registered field that is not inventoried. The three dangling citations now point at it. |
| G357 | N | **C** | §50 **the per-field record.** `fieldInventory.ts:418#fieldInventoryRow` merges the recorded half (screen/route, component file, current implementation, provider, zero-state, validation, known issues, migration status) with the four attributes `INPUT_CONTEXT_REGISTRY` already owns (desired mode, entity types, offline policy, privacy class) rather than copying them, so the row cannot disagree with the registry. Every `componentFile` is asserted to exist on disk, and `migrationStatus` is MEASURED, not claimed: `src/test/inputAssistanceFieldInventory.test.ts:326#mounted` scans `src/` and `app/` for each fieldId. |
| G31 | N | **C** | §29 **`privacyClass` has a reader.** It was declared on all 29 contexts and read by nothing — deleting it would have changed no behaviour. `travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts:77#CACHEABLE_PRIVACY_CLASSES` and `:86#isCacheablePrivacyClass` now gate the process-global suggestion cache, wired at `hooks/useInputAssistance.ts:211#isCacheablePrivacyClass` (read) and `hooks/useInputAssistance.ts:313#sharedSuggestionCache.set` (write). Not hypothetical: `telegraph.recipient` is `personal` AND mounted, so a global map was holding a list of PEOPLE under the raw prefix the viewer typed and serving it back without a round trip that could re-check eligibility. |

### 8.5 One row whose evidence was false, verdict unchanged

| id | was | now | why |
| --- | --- | --- | --- |
| G176 | N | **N** | Verdict stands; the stated evidence does not. The row read *"`SearchResult.distanceKm`, where it exists, is dropped by the projection whitelist"*. **There is no `distanceKm` on `SearchResult`** — `routes/discoverySearch.ts:162#SearchResult` has no such field and `grep -rn distanceKm` over `artifacts/api-server/src` returns only services/ranking/DiscoveryRankingService.ts, a different object on a different surface. Distance is computed transiently inside the places ordering and never lives on a row, so nothing is being "dropped by the whitelist": the field was never there. Not built this pass on purpose — see §8.8. |

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

`travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts:185#longestPrefix`
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
`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:238#localTier`.

**§33 — network loss retains the rows (G210).** The `unavailable` branch called
`setSuggestions([])`. §33 asks for the opposite in the same sentence: *"retain
local/cached suggestions"* and explicit degraded behaviour. The degraded state
was right and the retention was inverted — the last good rows were discarded at
the one moment the user cannot get new ones. It now serves the narrowed local
list at
`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:396#const mayRetain`,
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
`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:122#selectionAnnouncement`
is the sentence and
`travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx:364#announceForAccessibility`
is the call. The `applied` argument is load-bearing, not decorative: a row
carrying `replacementText` rewrites the field under the cursor and a row that
does not (an action, a validation, a caller that handled insertion itself)
leaves it exactly as typed. Announcing "Field updated" in the second case would
be a false statement about the user's own text, which is worse than silence.

**§46 — a non-colour active indicator (G329).** The keyboard-active row
differed from every other row by `backgroundColor` alone, so a sighted user who
cannot resolve that hue had no way to tell which row Enter would take;
`accessibilityState.selected` serves assistive tech and does nothing for them.
`travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:86#activeSlot`
adds a second channel: a caret glyph present on the active row and absent
everywhere else. Presence/absence of a mark survives any colour vision, any
contrast setting and a greyscale screenshot. The slot keeps its width either
way so arrowing down the list does not reflow the text, and the caret is hidden
from assistive tech
(`travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx:92#ia-row-active-marker`)
because `selected` already carries the fact and a second reading of it is noise.

**This is also the FIRST accessibility test in the layer.** §46's closing note
in §4 records that all 24 existing test files were listed and none referenced
`accessibilityLabel`, `accessibilityRole` or any a11y assertion. Two §46 rows
were BUILT-BUT-WRONG underneath that silence.
`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx:126#NON-COLOUR marker`
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
| G204 | W | **C** | §33's tier ladder has its middle rung. `suggestionCache.ts:185#longestPrefix` + `suggestionRanking.ts:94#narrowToQuery` are consulted at `useInputAssistance.ts:238#localTier` BEFORE the network answers, so a keystroke past a cached prefix renders locally instead of showing nothing until a round trip completes. The revalidation request still goes out — that is SWR, and the hook's own header has always said "still server-assisted if minChars ≤ 1". Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:121#renders local rows before the server answers`. |
| G214 | W | **C** | §34 "prefer local: cached city prefix matching" has a prefix index. The row's exact complaint — *"the SWR cache is keyed by the whole query string … There is no prefix index"* — is answered by `suggestionCache.ts:185#longestPrefix`, which is O(len(query)) O(1) lookups, longest prefix first, TTL- and coordinate-respecting. The fold that makes "danang" match "Đà Nẵng" and "hcmc" match "Ho Chi Minh City" is the pre-existing `queryNormalization`, now reached for the first time. |
| G210 | W | **C** | §33 "network loss: retain local/cached suggestions **and** explicit degraded behaviour" — both halves. The degraded half was already exact; the retention half was inverted (`setSuggestions([])`). `useInputAssistance.ts:194#setSuggestions` now retains the narrowed local list while still setting `unavailable`. Proven at `travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx:133#RETAINS`. |
| G324 | W | **C** | §46's fourth announcement exists. Purpose, count and active row were already wired; the selection result was not. `SmartInput.tsx:367#announceForAccessibility` speaks it, and `SmartInput.tsx:367#selectionAnnouncement` says "Field updated" only when the field really was rewritten. Proven at `travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx:247#never claims it did`. |
| G329 | W | **C** | §46 "non-color-only state indicators". The active row now carries a caret glyph as well as its background tint (`EntitySuggestionRow.tsx:86#activeSlot`), so the state survives greyscale. The caret is hidden from assistive tech on purpose — `accessibilityState.selected` already carries it. |
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
| G233 | W | **W** | Verdict stands; **half the stated evidence is now false.** The row reads *"the verification flags are dropped before projection (G180), so a viewer cannot even tell the real account from the copy."* They are not dropped. §8's G180 build added `artifacts/api-server/src/lib/inputAssistance/projection.ts:156#verified` and `:157#official`, and `travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts:42#Official` renders both as badges — so a viewer CAN now tell them apart, and §8's `applyTrustConfidence` additionally ranks the verified account above the copy. What is still true is the row's first clause, and it is the whole reason the verdict does not move: **nothing in the suggestion path detects or demotes an impersonating handle.** No confusable/homoglyph comparison exists anywhere in the layer. The row is W for one reason now, not two. |

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
`SmartInput.tsx:444#input_opened`, `useInputAssistance.ts:288#suggestion_request_started`
and `EntitySuggestionRow.tsx:153#rowActive`. What is wrong is every pointer.
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
opening `suggestionCache.ts:185#longestPrefix` and finding that the hook does
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
   `travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts:52#DISPATCHABLE_ACTION_TYPES`
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
| 1 | `discoverySearch.ts:76-87#nameVisibilitySet` | import swap: `presentedName` out, `buildListIdentityProjections` in, `resolvePlaceIdBridge` added | none |
| 2 | `discoverySearch.ts:129-140#SEARCH_TYPES` | `SEARCH_TYPES` gains a ninth Map-spec §27 heading, `"saved"` — 17 wire types become 18 | G218, G220 |
| 3 | `discoverySearch.ts:404-408#chunkIds` | new `chunkIds` paging helper (PostgREST `.in()` URL length) | none |
| 4 | `discoverySearch.ts:664#buildListIdentityProjections` | `searchTravelers`' inline identity assembly moved into `services/passport/PassportConsumerProjections.ts:1153#buildListIdentityProjections`; hunk is net zero lines | G101, G180 |
| 5 | `discoverySearch.ts:1328-1520#searchSaved` | a new viewer-scoped `searchSaved` lane, ~238 lines, reading `wishlist_places` + `discovery_place_saves` | G128, G129, G186 |
| 6 | `discoverySearch.ts:2391#searchSaved` | `dispatchSearch` gains `case "saved"` | G218, G220 |
| 7 | `discoverySearch.ts:2436#FAN_LIMIT` + `:2423#deliberately` | the `type=all` fan-out comment: 17 of 18 types fan out, `saved` deliberately excluded | G220 |

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
`searchSaved` does put `lat` / `lng` on `metadata` (`discoverySearch.ts:1488#lat:`
and `discoverySearch.ts:1488#lat:`), but no `saved` row can arrive at
`projectSearchResult`. And
had one arrived, it would change nothing: `metadata` is not in the §42 whitelist
(`lib/inputAssistance/projection.ts:150#display-safe`), which is G186's entire
content, and `searchPlaces` (`discoverySearch.ts:1195#lat:`), `searchEvents`
(`discoverySearch.ts:819#metadata:`) and `searchCities`
(`discoverySearch.ts:2036#metadata:`) already carried the same keys before this
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
`searchTravelers` excludes the viewer at `discoverySearch.ts:582#.neq("id",`
before any of it runs. G101 and G180 rest on `verified` / `is_official` being
SELECTED and surviving to the row: the select at
`discoverySearch.ts:580#is_official,` is untouched, `verified` is still assigned
at `discoverySearch.ts:706#verified:` and `isOfficial` still comes straight off
the row at `discoverySearch.ts:707#isOfficial:`. §8.4's producer for G101,
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
| G31 | line 980 | `routes/discoverySearch.ts:1562#sensitivity_level,` | a bare `);` |
| G62 | lines 107-109 | `routes/discoverySearch.ts:154-156#sanitizeQuery` | three import specifiers |
| G68 | lines 978-980, and `gemSearchPosition` "241-255" | `routes/discoverySearch.ts:1562#sensitivity_level,` + `:289-303#gemSearchPosition` | the hidden-gem blocked/age filter, not the select |
| G70 | lines 622, 724-725, 806-826 | `routes/discoverySearch.ts:739#visibility`, `:920#visibility`, `:921#show_in_discovery`, `:1081-1084#admitted:` | a friendship predicate; a comment; a `tripFit` metadata bag |
| G71 | line 488 | `routes/discoverySearch.ts:587#buddy_verified_at` | a JSDoc line about a cache |
| G73 | lines 1827-1828 | `routes/discoverySearch.ts:2412-2413#COMMON_LANGUAGES` | the city-dedupe loop in `searchCities` |
| G95 | line 1800, in the wrong file | `routes/discoverySearchHelpers.ts:257-262#userCity` | `.eq("is_private", false)` — and see below |
| G101 | line 481 | `routes/discoverySearch.ts:580#is_official,` | a comment about the `type=all` fan-out |
| G126 | lines 806-826, 724-725 | `routes/discoverySearch.ts:1081-1084#admitted:`, `:920#visibility` + `:921#show_in_discovery` | as G70 |
| G129 | line 980 | `routes/discoverySearch.ts:1562#sensitivity_level,` | a bare `);` |
| G180 | line 481 | `routes/discoverySearch.ts:580#is_official,` | as G101 |
| G185 | lines 622, 724-725, 806-826 | `routes/discoverySearch.ts:739#visibility`, `:920#visibility`, `:921#show_in_discovery`, `:1081-1084#admitted:` | as G70 |
| G190 | line 980, and `gemSearchPosition` "241-255" | `routes/discoverySearch.ts:1562#sensitivity_level,` + `:289-303#gemSearchPosition` | as G68 |
| G197 | lines 1827-1828 | `routes/discoverySearch.ts:2412-2413#COMMON_LANGUAGES` | as G73 |
| G220 | lines 1797-1830 | `routes/discoverySearch.ts:2292#dispatchSearch` + `artifacts/api-server/src/routes/discoverySearch.ts:2364#case "travelers":` | the `searchCities` profile select |
| G277 | lines 1664-1685 | `routes/discoverySearch.ts:2145#searchCountries` + `artifacts/api-server/src/routes/discoverySearch.ts:2157#.ilike("home_country", pat)` | a `catch { return []; }` |
| G278 | line 1818 | `routes/discoverySearch.ts:2387#searchPlaces` | `let skipped = 0;` |
| G279 | line 1819 | `routes/discoverySearch.ts:2395#searchHiddenGems` + `:289-303#gemSearchPosition` | a `for` header |
| G281 | line 1810 | `routes/discoverySearch.ts:2380#searchTrips` | a fail-closed comment |
| G282 | line 1806 | `routes/discoverySearch.ts:2373#searchEvents` | `.eq("allow_profile_discovery", false)` |
| G283 | lines 1802 and 488 | `routes/discoverySearch.ts:2365#searchTravelers` + `:587#buddy_verified_at` | a `.limit(...)`; a cache JSDoc |
| G337 | lines 107-109 | `routes/discoverySearch.ts:154-156#sanitizeQuery` | as G62 |
| G363 | line 980 | `routes/discoverySearch.ts:1562#sensitivity_level,` | a bare `);` |

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
spelling always gets the first query; `lib/inputAssistance/gateway.ts:522#let correctionHelped = false`
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
`lib/inputAssistance/creation.ts:181#export function partitionByFeasibility` is
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
| `suggestion_rendered` | `components/SmartInput.tsx:300#emitSuggestionsRendered(telemetryField, suggestions)` |
| `validation_shown` | `components/SmartInput.tsx:302#if (validations > 0) emitValidationShown(telemetryField, validations)` |
| `suggestion_dismissed` | `components/SmartInput.tsx:291#emitSuggestionsDismissed(telemetryField, prev.count, focused ? 'no_results' : 'blur')` and `components/SmartInput.tsx:406#emitSuggestionsDismissed(telemetryField, shownRef.current.count, 'escape')` |
| `manual_value_kept` | `components/SmartInput.tsx:453#emitManualValueKept(telemetryField, value.trim().length)` |
| `raw_search_submitted` | `components/SmartInput.tsx:350#emitRawSearchSubmitted(telemetryField, (s.replacementText ?? value ?? '').length, true)` and `components/SmartInput.tsx:462#emitRawSearchSubmitted(telemetryField, value.trim().length, false)` |
| `correction_accepted` | `components/SmartInput.tsx:347#if (s.type === 'correction') emitCorrectionAccepted(telemetryField, s)` |
| `disambiguation_selected` | `components/SmartInput.tsx:348#if (s.type === 'disambiguation') emitDisambiguationSelected(telemetryField, s)` |

The impression is keyed by the id-SIGNATURE of the rendered list, so a re-render
of the same rows does not inflate the count;
`components/SmartInput.tsx:179#const shownRef` and its companion `acceptedRef`
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
| G319 | N | `services/inputTelemetry.ts:271#export function emitActionCompleted` exists and is deliberately uncalled: selecting an action row OPENS a propose-only picker, and calling it "completed" there would make every abandoned picker a success. The global-search screen owner must call it on CONFIRM. |
| G320, G370 | N | `services/inputTelemetry.ts:284#export function emitDownstreamTaskCompleted` exists and has no caller. This layer cannot observe the outcome — the field is long gone when a trip is saved. One call each from `app/trip/new.tsx`, `app/events/create/index.tsx`, `app/telegraph/new.tsx`. |
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
| G326 | **Evidence false, verdict right.** The row asserted that `AccessibilityInfo` and `accessibilityElementsHidden` appear NOWHERE under `platform/input-assistance/`. Both appear: `components/SmartInput.tsx:34#AccessibilityInfo` and `components/EntitySuggestionRow.tsx:90#accessibilityElementsHidden`, both added by §9's own G324/G329 build — so the row was contradicted by a pass that shares this document. The verdict survives on its other sentence (`setAccessibilityFocus` really is absent). Corrected in place. |
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
opening `lib/inputAssistance/gateway.ts:522#let correctionHelped = false` and
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

---

## 13. Independent re-measurement at `a97bfdac0` — `G277` closes, and two citations no checker can see

*Written 2026-09-16 by an INDEPENDENT REVIEWER, not by a building lane. Measured
against `a97bfdac0` (the merge of PR #506), which is three squash merges past
this document's declared `head_commit` `1fe72289b`. **`head_commit` is NOT
re-declared here and no acknowledgement was edited** — the declaration is the
coordinator's to move, and §13.5 says exactly what this section does and does
not license.*

**Why this section exists.** Since `1fe72289b` three PRs merged (`0bea333b4`,
`54ba9fd85`, `a97bfdac0`) and, rather than remeasure, every counted-file change
was recorded in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`
with an argument for why no verdict moved. This census's entry names ONE counted
file, `artifacts/api-server/src/routes/discoverySearch.ts`, and says the change is
confined to the `countries` bucket. **That argument had never been checked
against the code by anyone but its author. It is checked here, and it is wrong in
the only direction that matters: a verdict DOES move, and the entry's sibling in
`census-discovery.md` §43.6 said so and correctly declined to move it.**

### 13.1 `G277` — the COMPLETE acceptance criteria, clause by clause

The §40 row is judged as a RESPONSIBILITY, not a filename — §40's own preamble,
which §52 backs by permitting *"configuration or a narrow resolver extension
rather than a new architecture"*. The row's cell at §836 states five clauses.
Each is graded here against `a97bfdac0` by reading the code, not the argument.

| # | the clause, as the row states it | at `a97bfdac0` | evidence |
|---:|---|---|---|
| 1 | *"No canonical country resolver"* | **FALSE — a resolver exists** | `artifacts/api-server/src/lib/countryCodes.ts:286#export function searchCountryRegistry(` — 216 ISO-3166-1 alpha-2 codes with canonical English names over seven ranked rungs (code · exact name · exact alias · name prefix · alias prefix · name substring · alias substring), then alphabetical by canonical name so a cursor is stable. Pure data, no I/O, and the module `artifacts/api-server/src/lib/stamps/countryLookup.ts` already consumed it — Discovery CONSUMES it rather than growing a second list. |
| 2 | *"`entityMap.ts:37` maps `country → 'countries'`"* | **TRUE, and it is not a defect** | `artifacts/api-server/src/lib/inputAssistance/entityMap.ts:37#country:` still reads `country: 'countries',`. This clause is the DELEGATION CHAIN, not the complaint — unlike `G66`, where `neighborhood → 'cities'` is the mis-mapping itself. A correct mapping into a now-correct resolver withholds nothing. |
| 3 | *"`searchCountries` aggregates `profiles.home_country`"* | **TRUE but no longer EXHAUSTIVE** | The profile leg survives on purpose at `artifacts/api-server/src/routes/discoverySearch.ts:2156#.select("id, home_country")` and `artifacts/api-server/src/routes/discoverySearch.ts:2157#.ilike("home_country", pat)`, because a traveller may have typed a country the ISO table has no row for and dropping it would delete a real answer. It is now the SECOND leg: the registry head is read first at `artifacts/api-server/src/routes/discoverySearch.ts:2184#const registry = searchCountryRegistry(q, offset + fetchLimit);`, and a typed spelling the registry resolves folds into the canonical row by ISO code rather than appearing beside it. The row's word "aggregates" carried the force of "and nothing else"; that is what stopped being true. |
| 4 | *"A country picker therefore resolves against the user table, not a canonical country registry"* | **FALSE** | The country picker is `country_picker` (`artifacts/api-server/src/lib/inputAssistance/policyRegistry.ts:152#country_picker: policy(`, `entityTypes` at `artifacts/api-server/src/lib/inputAssistance/policyRegistry.ts:156#entityTypes: ['country'],`). It is a geo picker (`artifacts/api-server/src/lib/inputAssistance/gateway.ts:117#'country_picker',` inside `GEO_PICKER_CONTEXTS`, consulted at `artifacts/api-server/src/lib/inputAssistance/gateway.ts:278#const isGeoPicker`), so `countries` falls into the non-city branch `artifacts/api-server/src/lib/inputAssistance/gateway.ts:561#if (otherTypes.length > 0) {` and is dispatched at `artifacts/api-server/src/lib/inputAssistance/gateway.ts:562#let other = await dispatchAndProject(sc, otherTypes, {` into `dispatchSearch`, whose `countries` arm is `artifacts/api-server/src/routes/discoverySearch.ts:2411#return searchCountries(sc, q, blockedSet`. **The whole path was walked, not assumed** — this is the clause on which a "logic right, nothing reaches it" withholding would have rested, and it does not: `city_picker`, `trip_destination` and `global_search` reach the same resolver too. |
| 5 | *"so a country with no users in it does not exist"* | **FALSE** | `artifacts/api-server/src/test/discoveryCountryRegistry.test.ts:237#R2` — *"a country with no users in it still exists as a suggestion"* — plus `R1` at `artifacts/api-server/src/test/discoveryCountryRegistry.test.ts:231#R1`, which resolves a country with ZERO profiles in the database. Run at this tree by this reviewer: **20 tests, 20 pass, 0 fail.** |

**Two clauses that would have withheld it, checked and found not to apply.**
(a) The registry leg is viewer-independent and needs no privacy read, so the
obvious next defect is letting it ANSWER when the privacy reads refused —
a registry-only page is short by an unknown amount and indistinguishable from a
complete one. It does not: `R8` and `R9` pin the refusal in both directions and
both pass. (b) The gateway gates entity dispatch on `q.length >= 2`
(`artifacts/api-server/src/lib/inputAssistance/gateway.ts:542#if (wantsEntities && dispatchTypes.length > 0 && q.length >= 2) {`), so a
one-character query never reaches the resolver — but a two-letter ISO code does,
which is the shortest input this requirement is about, and the row states no
clause about single characters.

### 13.2 The row move

| id | was | now | evidence |
|---|---|---|---|
| G277 | W | **C** | CountryResolver. Three of the row's five clauses are false at `a97bfdac0` and the two that survive are not defects — §13.1 grades each. The responsibility exists (`artifacts/api-server/src/lib/countryCodes.ts:286#export function searchCountryRegistry(`), it is CONSUMED rather than duplicated, and it is REACHED from `country_picker` through `dispatchSearch`. |

**It is graded `C` and deliberately NOT `C ᵖ`.** The `ᵖ` marker means the work
was pre-existing and is not attributable to this specification; §836's siblings
`G278`, `G279`, `G281` and `G282` carry it for exactly that reason. This resolver
was not pre-existing — it was written to close this requirement and names it:
`artifacts/api-server/src/test/discoveryCountryRegistry.test.ts:2#GII G277 "CountryResolver"`.
So the `23ᵖ` subtrahend in the headline is UNCHANGED at 23, and if a later pass
judges the work Discovery-attributable rather than spec-attributable it should
say so and move the subtrahend, not this verdict.

### 13.3 Headline, restated from the rows

**Restated from `check:census-integrity`'s own parse, not by adding this move to
a previous headline.** The last stated headline before this section is §12.7's
(C 262 / W 58 / N 49 / X 4), not the block at the top of this document.

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **263** |
| BUILT-BUT-WRONG | **57** |
| NOT-BUILT | **49** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **320 / 373 = 85.8 %** |
| **CORRECT%** (raw) = C/373 | **263 / 373 = 70.5 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **240 / 373 = 64.3 %** |
| **THE GAP** = W/373 | **57 / 373 = 15.3 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

`G277` moved WITHIN the built set, so CONSTRUCTED does not move at all and only
CORRECT does, which is the shape a defect closure has.

**THE TOP-OF-DOCUMENT HEADLINE IS STALE AGAIN, AND IT HAS BEEN SINCE §12.** It
reads `262 / 55 / 52 / 4`. §12.7 moved three rows `N` to `W` and restated the
tally **only inside §12.7**, so the block a reader meets first has been
contradicted by the body ever since. That is the exact failure §11 documented in
the note printed under that same block — *"a reader who read the top of this
document got a number the body had already contradicted twice"* — together with
the instruction *"every later pass should do the same"*, meaning restate it at the
top as well as in place. §12 did not, and this section cannot: the corpus is
append-only and §11's block may not be edited. **So the top block is superseded
here, for the second time, by this table.** `check:census-integrity` reads the
LAST stated headline and therefore never saw the drift — it passed at
`1fe72289b` against §12.7 and would have gone on passing. This is an ACCOUNTING
correction: no verdict of the three §12 moved is questioned, and none is re-read
here.

§9.1's group **(a) logic wrong in code** names `G277` first among *"the nine left
... in rough order of how wrong they are"*, describing it as *"`searchCountries`
aggregating `profiles.home_country` so a country with no users in it does not
exist"*. **That sentence is falsified by §13.1 and `G277` leaves group (a).** No
new total is asserted for the group: it is a §9-era partition that later passes
moved rows across without restating, and re-deriving it would need all 54 `W`
rows re-read, which this section did not do.

### 13.4 Two citations that are stale, and that NO check can see

`G277`'s second pointer is `` `artifacts/api-server/src/routes/discoverySearch.ts:2157#.ilike("home_country", pat)` `` — a BARE inherited
citation, which takes its file from `discoverySearch.ts` named earlier in the same
row. **It does not resolve at `a97bfdac0`, it did not resolve at `1fe72289b`
either, and neither pass can tell you so.** `INHERITED_RE` in
`artifacts/api-server/scripts/check-doc-citations.mjs:399#export const INHERITED_RE` requires a
closing backtick immediately after the anchor, and `ANCHOR` at
`artifacts/api-server/scripts/check-doc-citations.mjs:391#const ANCHOR` stops at
the first `"` — so the citation matches NOTHING and is not counted, not checked
and not reported. `UNBINDABLE_INHERITED_RE` catches the SPACE form of this
hazard and only that form; a double quote falls through it. `FULL_ANCHOR_RE`
would have caught it had the path been spelled.

The proof that this is a live hole and not a theoretical one: the Discovery
closing lane repointed this row's OTHER pointer in the same change —
`:1999#searchCountries` became `:2072#searchCountries`, correct at
`a97bfdac0` — *because the checker showed it*, and left the quote-anchored one
untouched *because the checker did not*. The same thing happened to `G220`.

| row | the invisible pointer | what it lands on at `a97bfdac0` | what it should name |
|---|---|---|---|
| G277 (§836, §2097) | `` `artifacts/api-server/src/routes/discoverySearch.ts:2157#.ilike("home_country", pat)` `` | the `searchCities` signature — the anchor text is absent from both lines | `artifacts/api-server/src/routes/discoverySearch.ts:2156#.select("id, home_country")` and `artifacts/api-server/src/routes/discoverySearch.ts:2157#.ilike("home_country", pat)` |
| G220 (§742, §2096) | `` `artifacts/api-server/src/routes/discoverySearch.ts:2364#case "travelers":` `` | a comment about `canonical_locations` and a JSDoc line — `dispatchSearch`'s switch is nowhere near | `artifacts/api-server/src/routes/discoverySearch.ts:2364#case "travelers": {` — the switch runs 2215-2262 |

Both were already wrong at `1fe72289b` (`searchCountries` was at line 1999 and
`case "travelers":` at 2144 there), so this is a PRE-EXISTING defect the recent
changes widened rather than caused. **The rows' VERDICTS are unaffected by it**
— `G220` stays `C ᵖ` and `G277` moves for the reasons in §13.1, not for a line
number. Corrected pointers are stated above rather than edited into §836 and
§742, because this corpus is append-only and the last statement wins.

Measured across all thirteen censuses: **nine** bare inherited citations carry a
double quote in the anchor and are therefore unchecked by both passes. Seven are
in `census-input-intelligence.md` and `census-discovery.md` and are named here
and in `census-discovery.md` §44; the other two — `census-map.md` M282's
`personal_city` pointer and `census-telegraph.md`'s two `vocabulary.ts` pointers —
were read at this tree and ARE correct, so they are reported as a guard gap and
not as an error.

### 13.5 What this licenses, and what it does not

This section measured **one requirement** — `G277` — plus the two citations
§13.4 names. The single counted file this census's acknowledgement covers is
`artifacts/api-server/src/routes/discoverySearch.ts`, and the five hunks in it
touch the `countries` bucket and one line of `dispatchSearch`'s switch; every
other row this census rests on in that file (`G31`, `G62`, `G68`, `G70`, `G71`,
`G73`, `G95`, `G101`, `G126`, `G129`, `G180`, `G185`, `G190`, `G197`, `G220`,
`G278`-`G283`, `G337`, `G363`) sits outside those hunks and is not re-read here.

**So: this census's `head_commit` CAN truthfully advance to `a97bfdac0`** —
because the one counted file that changed has had the one requirement its change
could move re-measured, and the hunks are enumerable and do not reach the others.
That is a statement about the ONE file that moved, not about the 373 rows. The
declaration starts a clock; it certifies no past, and §1's reading rule applies to
every row this section does not name.

**Guards run at this tree by this reviewer**, after the edit:
`check:census-freshness` **0**, `check:census-scope-coverage` **0**,
`check:census-integrity` **0**, `check:census-row-move-labels` **0**,
`check:doc-citations` **0**, `check:citation-targets` **0**. Five checks exit
**2** without live credentials — `check:write-path-columns`,
`check:missing-live-columns`, `check:authorization-contract`,
`check:media-objects`, `check:rank-events-surfaces`. **Exit 2 is UNVERIFIED, not
green**, and nothing in this section rests on any of them.

---

## 14. Three of §3's five deployment facts stopped being true on 2026-09-21

§3 is titled *"read this before any percentage"* and is the section this
document leans on hardest, because it is what separates *correct code* from
*correct code that runs*. Three of its five facts were measured against
production and are now false, not because the measurement was wrong but because
the migrations they described were applied. §3 is left in place — the corpus is
append-only and its reasoning is still the reasoning — but **a reader who quotes
§3 facts 1, 2 or 3 after this date is quoting a superseded measurement, and this
section is where they are corrected.**

### 14.1 What was measured in production before the apply

Read directly from the production project, not from a document:

| object | before |
| --- | --- |
| `public.input_selection_history` | **absent** (`to_regclass` null) |
| `public.input_record_selection(…)` | **absent** (0 overloads) |
| `canonical_locations.search_key` | **absent** |
| `public.input_normalize_city_key(text)` | **absent** |
| `pg_trgm` | **not installed** |
| `feature_flags` row `compass_ai_writing_enabled` | **no row at all** |

And the live evidence of the §10 defect, which the census had only ever argued
from the migration header: production's `Thành phố Đà Nẵng` row carried
`normalized_name = 'thanh pho a nang'`. The stroke `Đ` had been deleted, exactly
as `2220`'s header predicts, in real data.

### 14.2 The ledger says 2220 was applied. The ledger is not saying that.

This is the trap, and it is worth writing down because anyone re-deriving §3
will hit it. `schema_migration_ledger` in production **does** carry a row for
`2220_canonical_locations_search_key.sql`. Its `applied_by` is `backfill` and
its own `notes` read:

> *"Seeded by 2254_schema_migration_ledger.sql. Asserts only that this filename
> existed in src/migrations/ when 2254 ran. NOT evidence that it was applied to
> this database; nothing verified that it was."*

So the ledger and the schema never disagreed. A `backfill` row is a
filename-existence assertion, and 380 of production's 461 ledger rows are
`backfill` — about five-sixths of that ledger cannot be cited as evidence of
application. **2220 was genuinely unapplied**, there was no replay risk, and no
migration was duplicated or re-authored to work around a stale document.

### 14.3 Rehearsed first, on a database where the first apply could fail

`portava-ci` already carried all three, so re-running them there would have
rehearsed the *re-run* path and proved nothing about the *first* apply. The
rehearsal was built instead on a throwaway PostgreSQL 16.13 seeded with
production's exact `canonical_locations` column list, production's exact
`feature_flags` shape, an `auth.users` stub, all 31 real `canonical_locations`
names — **and Supabase's `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon,
authenticated`**, so `2258`'s ACL postcondition was actually exercised rather
than trivially true. That last detail is the 2190/2214 lesson: the postcondition
only means something in an environment where the thing it forbids can happen.

Proven there before production touched anything: all three apply clean on a
first apply and again on a re-run (idempotent); the `Đ` fold turns
`thanh pho a nang` into `thanh pho da nang` and an `ILIKE '%da nang%'` on
`search_key` then reaches the Vietnamese row; `input_record_selection` upserts to
one row at `selection_count = 2` rather than two rows; a NULL label does not
overwrite a known one; deleting the `auth.users` row erases the memory through
the cascade; and `SET ROLE authenticated` followed by a call raises
*"permission denied for function input_record_selection"*.

None of the three files contains an unqualified `DELETE` or `UPDATE`, so the
`supautils` `safeupdate` guard that made `2963` raise on every call has nothing
to catch here. That was checked rather than assumed.

### 14.4 Applied, and verified independently of the migrations' own postconditions

| object | after |
| --- | --- |
| `canonical_locations.search_key` | `text`, `GENERATED ALWAYS … STORED`; all 31 rows backfilled; `normalized_name` untouched; row count unchanged at 31 |
| `canonical_locations_search_key_trgm_idx` | present |
| `input_normalize_city_key` | 1 overload |
| `Thành phố Đà Nẵng` | `search_key = 'thanh pho da nang'`; `ILIKE '%da nang%'` returns it **and** the ASCII `Da Nang` row |
| `input_selection_history` | present; RLS enabled; `anon` no `SELECT`, `authenticated` no `INSERT`, `service_role` `SELECT/INSERT/UPDATE/DELETE`; both indexes present; `auth.users` FK `confdeltype = 'c'`; 0 rows |
| `input_record_selection` | 1 overload; `SECURITY DEFINER`; `EXECUTE` revoked from `anon` and `authenticated`, granted to `service_role` |
| `compass_ai_writing_enabled` | present, `false`; `compass_ai_enabled` left at `true`, untouched; `feature_flags` 198 → 199 |

All three recorded in `schema_migration_ledger` with their real `sha256` and
`applied_by = 'manual'`, the 2220 `backfill` row superseded in place with the
reason written into its notes.

### 14.5 What this does NOT license

**It does not close a single row by itself.** §3 fact 4 (every `intel_*` table
at `count(*) = 0`) and fact 5 (the telemetry sink defined as
`let sink: TelemetrySink = () => {}` and attached by nothing) are **unchanged**
and still true. The eleven verdicts §3 flagged `☠prod` are no longer inert, but
"the substrate now exists" is not evidence that a requirement is satisfied — the
acceptance criterion is a live-path demonstration that a recorded selection
resurfaces as a recent, or reorders a candidate, and that demonstration has not
been run. Those rows stay where they are until it is.

The same rule bars the tempting inference in the other direction: nothing here
says the application *reads* any of it yet. What changed is that the database no
longer makes it impossible.

### 14.6 Headline, restated from the rows

**Restated from `check:census-integrity`'s own parse.** The last stated headline
before this section is §13.3's (C 263 / W 57 / N 49 / X 4).

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **264** |
| BUILT-BUT-WRONG | **57** |
| NOT-BUILT | **48** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **321 / 373 = 86.1 %** |
| **CORRECT%** (raw) = C/373 | **264 / 373 = 70.8 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **241 / 373 = 64.6 %** |
| **THE GAP** = W/373 | **57 / 373 = 15.3 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

The move is `N 49 → 48`, `C 263 → 264`: `G228` `W → C` on new code, `G97` and
`G101` `N → C` on a contradiction the document had been carrying since Phase 9,
and `G86` `N → W` as one of its four required sources came into existence. Two
of those four are accounting corrections to rows §8.4 had already moved and
never written back — they are not new work and they are labelled as such in
their rows.

**The top-of-document block remains stale**, as §13.3 said it was; it is
superseded here for the third time. The denominator is unchanged at **373**: no
row was added, removed or merged in this pass.
## 15. Phase 15 — the scattered non-`C` rows of §27–§56, worked

*Written 2026-09-21 by the lane holding 24 rows: `G172` `G173` (§27), `G190`
(§29), `G204` `G209` `G210` `G211` (§33), `G240` (§37), `G241` (§38), `G260`
`G261` `G263` (§39), `G277` `G283` `G292` (§40), `G303` `G305` (§43), `G337`
(§47), `G350` `G351` `G355` (§49), `G359` (§52), `G361` `G362` (§53–§56). No
row outside that set is edited here, and the `## Headline` block, the §5 gap
tables, §6 and `CENSUS_STALENESS_ACKNOWLEDGED.json` are untouched by
instruction — they are recomputed centrally after every lane in this wave
lands.*

**Five rows move on code and a mutation-proven test. Five more were printing a
verdict this document had already revised elsewhere, and the table is
reconciled to the live one without the count changing. Fourteen stay where they
are, each with a named blocker and, where it is not this lane's, a named
owner.**

### 15.1 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| G172 | W | **C** | §27's seventh surface exists and is what the overlay mounts before typing. `travel-buddy-standalone/src/platform/input-assistance/components/ZeroStatePanel.tsx:45#export function ZeroStatePanel`, mounted at `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:333#<ZeroStatePanel title={zeroStateTitle}`. The pre-typing empty state is a different sentence from the no-match one, which is the distinction §37 draws and the list could not. |
| G173 | W | **C** | The claim became a mechanism. `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:82#export function overlayHeightBudget` + the real keyboard subscription at `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:99#export function useKeyboardHeight` + the safe-area inset on the list's own padding. The row's complaint was exact — no inset read, no keyboard listener anywhere in the layer — and all three are now there and asserted. |
| G211 | W | **C** | `travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:254#<FlatList` replaces the plain `ScrollView`, over a flattened row stream so a section header is a list row. Under jest a VirtualizedList mounts `initialNumToRender` and a ScrollView mounts all 40, which makes the test a direct discriminator between the two containers. **§11.7 left this row deliberately, calling it "an afternoon that would move a row"; that assessment was right.** |
| G240 | W | **C** | §37's own empty-state mock has its missing element: `artifacts/api-server/src/lib/inputAssistance/validationSuite.ts:360#label:` — the "Add a new …" row, gated under policy at `artifacts/api-server/src/lib/inputAssistance/creation.ts:418#const creatable = CREATABLE_ENTITY_BY_CONTEXT[context];`. No new §43 action type was minted to do it. |
| G305 | W | **C** | The server-emitted action reaches a screen. `travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts:54#'open_compass',` and `travel-buddy-standalone/app/search.tsx:497#const compass = getOpenCompassTarget(suggestion);` moved in lock-step, which is what §11.7 said the row needed. It routes through `prefillMessage`, the handoff the Compass screen already accepts from Layover — not a second mechanism beside it. |

**§11.7 is not edited.** It is a truthful record of what THAT pass examined and
left, and two of its entries — `G211` and `G305` — named exactly what would
close them. This section is the answer to those two, not a correction of them.

### 15.2 Five rows whose §4 cell disagreed with this document's own verdict

Every one of these had already been revised in a later section; only the §4
table kept the superseded sentence. `check:census-integrity` takes the LAST
verdict on a row, so **none of these changes any count** — what changes is that
a reader of the table now sees what the tool sees. Each was re-read at this
commit rather than copied forward.

**A note on the shape of this table.** It carries ONE verdict column, not the
obvious two. `check:census-integrity` takes the last verdict-looking cell in a
row, so a "was / now" table here would have handed the tool the superseded
value and quietly re-broken the thing this section is fixing — the same defect
its own header records for census-layover's PR-comparison table. The
superseded value is named in prose instead.

| id | verdict (unchanged by this section) | what the §4 cell had been printing, and the re-read |
| --- | --- | --- |
| G204 | **C** (set at §9.3) | The table still printed BUILT-BUT-WRONG. The move holds: the local prefix tier is at `travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:238#localTier`, consulted before the network answers. |
| G210 | **C** (set at §9.3) | The table still printed BUILT-BUT-WRONG with the `setSuggestions([])` sentence. The move holds: the `unavailable` branch retains the narrowed local list, and with nothing local to retain it is still `[]`, which is the old behaviour rather than a regression. |
| G277 | **C** (set at §13.2) | The table still printed BUILT-BUT-WRONG with the original five-clause sentence, so the document answered this row two ways at once. **§13's narrative did not overclaim — the table was stale.** Re-read here: the registry exists (`artifacts/api-server/src/lib/countryCodes.ts:286#export function searchCountryRegistry(`), it is read FIRST and the profile leg folds into it by ISO code (`artifacts/api-server/src/routes/discoverySearch.ts:2184#const registry = searchCountryRegistry(q, offset + fetchLimit);`), it is reached from `country_picker` through `dispatchSearch`, a country with zero profiles still resolves, and the privacy refusal is pinned in both directions (`artifacts/api-server/src/test/discoveryCountryRegistry.test.ts:237#R2`). |
| G292 | **W** (set at §12.1) | The table still printed NOT-BUILT and the sentence "there is no server-side telemetry service", false in all four clauses. It is `W` and not `C` for §12.2's reason, re-verified: migration 2950 has been applied to no database at all, so the route takes its 503 branch and the serve log cannot acquire a row. |
| G351 | **W** (set at §12.1) | The table still printed NOT-BUILT and "zero accessibility tests exist in the layer", which §12.4 had already named as a sentence this document was contradicting itself with. The gap narrowed inside `W` this pass: two of §49's five dimensions are certified — screen reader, and now keyboard navigation (`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionKeyboardNav.component.test.tsx:166#ArrowDown WRAPS at the end`). Focus management, dynamic type and reduced motion are not, and two of those three have no implementation to certify. |

### 15.3 Rows examined and left, with the blocker named

| row | left at | what would turn it red, and who can supply it |
| --- | --- | --- |
| G190 | W | `lib/protectedLocations.ts` is still consulted by nothing in `lib/inputAssistance/`. Wiring it is a privacy STRENGTHENING and is the right build — but `protected_zones` is absent from production, so the gate would refuse nothing there and the row would be `C ☠prod`, which this wave does not count as a close. Needs the table applied, then a refusal proven THROUGH the gateway. |
| G209 | N | Not the fetch — the GRAPH. §33 and §53 both name a *dependent field*, and §17's dependency graph covers one node class (G109). Hard-coding the mapping here would invent a requirement §17 owns. |
| G241 | W | Four of five rungs now (the local-index rung arrived with G204/G214). Approved provider (G222) has no substrate at all; the recent-history rung is still G261's in-memory store. |
| G260, G261 | W | **Ownership, not difficulty.** `services/entityResolution.ts` and `services/suggestionHistory.ts` belong to other lanes in this wave and a second editor would have collided. G260 is also downstream of §34's local index (G212/G214): its null branch has nothing to resolve against. |
| G263, G355 | W | The one `setTelemetrySink` line at `travel-buddy-standalone/app/_layout.tsx` (§12.6), plus a destination. `requestId` now rides every event, which CORRECTS G355's stated evidence without moving it — a join whose two halves are dropped by the same no-op is not a demonstrated join. Telemetry lane's files; read-only here. |
| G283 | W | A buddy arm that reads the declared service CATEGORY and AVAILABILITY window and filters on them. The columns belong to `rent_a_buddy`'s schema, whose owner must say which are the contract. |
| G303, G362 | N | They block each other in one direction only. A `share_entity` producer with no mounted field is an unreachable row; a mounted `telegraph_message` field with no producer degrades harmlessly to the ordinary entity assist. **So the field comes first** — and the Telegraph message composer is not `app/telegraph/new.tsx` (that is the recipient picker) and imports none of this layer. |
| G337 | N | Vacuously unsatisfiable, in §12.3's sense: it constrains how a pasted string must be treated GIVEN a paste, and §24's paste path does not exist. A URL sanitizer built now would be a tested function with no caller. |
| G350 | W | Three of four certified (the offline-retention arm arrived with G210). The static dictionary and the offline raw-query fallback are untestable because they do not exist (G197/G212/G241) — substrate, not test-writing. |
| G359 | W | The row is a PROHIBITION, and a prohibition with no detector is a convention. A ratchet in the shape of `services/__tests__/selectionWriterCoverage.test.ts`, carrying the four known engines as named exemptions. The engines and the ratchet's home are both outside this lane's file set. |
| G361 | W | Five of seven steps now (the local prefix cache arrived with G204/G214). The two left are G209's prefetch and G109's venue→city→country→coords→timezone cascade. |

### 15.4 Mutations applied, watched go red, reverted, `cmp`-verified

Nineteen mutations across the five moved rows. **Two did not redden and are
recorded here rather than dropped**, because a mutation that survives is a
statement about the test, not about the code:

- **`city_picker` added to `CREATABLE_ENTITY_BY_CONTEXT` (G240) — stayed
  green.** That policy declares no `action` type, so `canAction` refuses before
  the context map is consulted. The refusal is real and mutation-proof *through
  the policy*; the map is a second, currently-unobservable gate for that
  context. This is §12.5's "one gate masked another", found again in the same
  shape, and it is written into the test file beside the assertion it affects.
- **`extraData={activeId}` deleted from the new `FlatList` (G211) — stayed
  green.** The inline `renderItem` changes identity every render and busts the
  cell memo by accident, so the prop is redundant *today*. It is kept because a
  future `useCallback` around `renderItem` would remove that accident and
  silently freeze the keyboard highlight, and the line now says so.

One harness fact, recorded for the same reason: **RNTL 14.0.1's
`fireEvent(input, 'keyPress', …)` does not reach a TextInput's `onKeyPress` in
this harness, and it fails SILENTLY** — the call succeeds and nothing happens.
Every keyboard-navigation assertion would have been asserting that nothing
happened. The suite invokes the component's own rendered `onKeyPress` prop
inside `act` instead, which is the real handler off the real tree and is written
down rather than papered over.

### 15.5 What this pass did NOT do, deliberately

- **No verdict moved on "code is correct, production is not there."** G190 and
  G292 would both be `C ☠prod` under a looser rule and are not moved. Production
  was re-measured for this wave and lacks `input_selection_history`,
  `input_record_selection`, `canonical_locations.search_key`,
  `input_normalize_city_key`, `pg_trgm` and any `compass_ai_writing_enabled`
  row; migration 2950 is applied nowhere at all.
- **No producer was built into a surface nothing mounts.** G303 is the case:
  the producer is perhaps an hour's work and would have added a second
  unreachable artifact beside the one G305 just removed.
- **No check was weakened to get green.** The one existing assertion this pass
  edited is `smartActions.test.ts`'s closed-set ratchet, which moves from
  `['add_to_trip']` to `['add_to_trip', 'open_compass']` together with the
  screen dispatcher that handles the new member — and the test still asserts
  that `share_entity` and `drop_pin` are refused, so the set did not become a
  bucket.
- **No row was added, removed or merged.** The denominator is 373 and is
  untouched.

### 15.6 Pointer repairs, and the two guards this section cannot make green

**Thirty-one anchored citations were repointed, and not one of them is an
evidence change.** Editing `SmartInput.tsx`, `smartActions.ts`,
`creation.ts` and `app/search.tsx` moved lines underneath pointers held by
rows in §44, §46, §9.3, §11 and §12 — and by one row in `census-discovery.md`
(`app/search.tsx:677` → `:688`, `#Some of this search could not run.`). Each
was repointed by mapping the OLD line through this branch's own diff and then
confirming the anchor text is on the NEW line; the anchor text itself is
untouched in every case, which is what makes these repairs rather than
rewrites. **No verdict, no requirement text and no evidence claim outside this
lane's 24 rows was edited.** This is the operation §10.3 performed for
twenty-nine pointers across 23 rows, for the same reason.

`check:census-scope-coverage` was at exactly its 98 % floor before this pass
(112 of 114 cited files watched) and §14's new citations took it to 95 %.
Sixteen paths were added to `CENSUS_SCOPE`, taking it to **118 of 118 = 100 %**.
Three of those had been cited-and-unwatched before this pass —
`stamps/countryLookup.ts` (§13.1's proof that the country registry is consumed
rather than duplicated) and the two telemetry transport halves (§12.6's). The
floor was not touched, which the checker's own error text calls the one
response that is never right.

**Guards run at this tree after the edit:** `check:doc-citations` **0**,
`check:citation-targets` **0**, `check:citation-symbols` **0**,
`check:census-row-move-labels` **0**, `check:census-policy-citations` **0**,
`check:census-scope-coverage` **0**. Server suites:
`inputAssistance*.test.ts` + `discoveryCountryRegistry.test.ts` — **298 pass,
0 fail**. Client: `run-node-tests.mjs` — **6,390 pass, 0 fail**, and the
component suites for `platform/input-assistance`, `app/__tests__/search*` and
`components/search` — **14 suites, 74 pass, 0 fail**. Client and api-server
typecheck both **0**.

**Two guards are RED and are deliberately left red**, because the fix to each
is a field this lane is under instruction not to touch:

1. `check:census-integrity` **1** — *"its stated headline is C 263 / W 57 /
   N 49 / X 4 but its own rows count C 268 / W 52 / N 49 / X 4."* The arithmetic
   is this section's five moves and it is correct; the `## Headline` block is
   recomputed centrally once every lane in this wave lands, so restating it here
   would race six other branches doing the same. **The rows are right and the
   headline is stale**, which is the direction the checker's own text asks a
   reader to resolve.
2. `check:census-freshness` **1** — ten counted files changed that
   `CENSUS_STALENESS_ACKNOWLEDGED.json` does not name. Three of them
   (`lib/inputAssistance/creation.ts`, `lib/inputAssistance/validationSuite.ts`,
   `app/search.tsx`) are counted by **census-discovery** as well, which the same
   run reports as stale for exactly those three. The acknowledgement ledger and
   the `head_commit` declaration are the coordinator's to move — §13's own
   preamble says so — and an acknowledgement written by the lane whose changes
   it excuses is the thing §13 was written to catch.

---

## 16. Headline after the seven-lane wave, restated once from the rows

Six lanes worked disjoint row sets in parallel against `origin/main`
(`1ba2de3fa`) and were integrated here. Each lane was forbidden to touch this
headline, the §5 tables, §6, or `CENSUS_STALENESS_ACKNOWLEDGED.json`, precisely
so that the tally would be computed **once**, centrally, from
`check:census-integrity`'s own parse of the merged tree — never by adding six
lanes' claimed deltas together, which is arithmetic on six documents that no
longer exist.

**Restated from the rows.** The last stated headline before this section is
§14.6's (C 264 / W 57 / N 48 / X 4).

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **272** |
| BUILT-BUT-WRONG | **49** |
| NOT-BUILT | **48** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **321 / 373 = 86.1 %** |
| **CORRECT%** (raw) = C/373 | **272 / 373 = 72.9 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **249 / 373 = 66.8 %** |
| **THE GAP** = W/373 | **49 / 373 = 13.1 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

**CONSTRUCTED does not move at all.** Every move in this wave was `W → C`
except `G86` (`N → W`) and the `N → C` pairs that were accounting corrections,
and the two cancel. That is the shape of a wave that fixed things rather than
building new ones, and it is the honest reading: the layer did not grow, it got
less wrong.

### 16.1 Two kinds of move, and they should not be read as one number

Of the nine rows this wave moved into `C`, **four were not new work**. `G97`,
`G101`, `G115` and `G204`/`G210`/`G277`/`G292`/`G351`'s table cells were rows
this document had **already moved elsewhere** — in §8.4, §9.3, §12.1 and §13 —
while the §4 requirement table went on printing the superseded verdict.
`check:census-integrity` takes the last statement, so it was already counting
them; a human reading §4 was not. Repairing those cells changes what a reader
sees and changes the tally by nothing.

The genuinely new closures are `G147` (username alternatives, live path),
`G172`, `G173`, `G211`, `G216`, `G226`, `G228`, `G240` and `G305`. Each rests on
a test with a named mutation that was applied, watched go red, and reverted.

**Twelve more rows are in the same stale-cell state and were left**, because
repairing a cell you have not re-read is how the drift got here: `G31`, `G180`,
`G181`, `G214`, `G324`, `G329`, `G356`, `G357`, `G372` and the three already
named in §12.4. They are listed in §15 with the line that set their live
verdict. None of them changes the tally.

### 16.2 What the lanes refused, which matters more than what they closed

Three refusals are worth keeping, because each one could have been a closure:

- **`G103` (PrivacyRisk as a ranking weight)** — refused. Privacy in this layer
  is binary and fail-closed at `gateway.ts`. A risk *weight* that demotes rather
  than excludes is a **weaker** posture than the one that exists.
- **`G104` (staleness as a penalty)** — refused for the same reason. Stale live
  claims are removed upstream, so closing this row means widening a fail-closed
  gate to let stale rows through. §31's degradation rule and §15's Staleness
  term are in genuine tension; that is a spec finding, not a code gap.
- **`G229` (record query completions)** — refused on 2258's own column contract:
  `entity_id` is "a stable canonical id, **never a private fact or free-text
  content**", and a raw query completion is free text. It needs a separate store
  with its own retention decision, not a widening of this one.

### 16.3 What is still not verified, and by what

`G327` and `G328` (§46) need a real handset with a real software keyboard and a
screen reader. `G354` needs measured latency from a deployment. `G371` needs
production privacy-incident observability. **No claim about any of them is made
here**, and in particular nothing in this document asserts that there have been
zero privacy incidents — nothing available to this corpus could establish that.
Those four are the `X` column and they are why **100 % is not reachable from a
repository**; the ceiling is 369/373 = 98.9 %.

Below that ceiling, §14.5 still stands: the §35 substrate now exists in
production, but the rows over it close on a live-path demonstration, not on the
table's existence. `G85` in particular is now blocked on an **app host**, not a
database — `city_picker` is mounted on no screen, so nothing can record on that
context and nothing serves its zero-state.

The denominator is unchanged at **373**. No row was added, removed or merged in
this wave. One genuine requirement was found with **no row** — whether the
assistance surface tells a user about the 30-day username cooldown that
`PATCH /me/profile` enforces — and it is reported here rather than inserted.

---

## 17. `G232` closes on the bar it set for itself, in the write path

`G232` ("Alias abuse detection") was left `N` by the §36 lane with an argument
that was right and a boundary that was right: the alias *tables* this layer
resolves through are curated source constants that no user can write, and a
detector placed in the suggestion layer would have guarded a column that layer
does not read — `suggestCanonicalLocationsFolded` queries `search_key` and
`normalized_name` only. That measurement was re-verified here and still holds.

What the lane also did was write down, in the row, exactly what would close it:

> a plausibility rule on the alias APPEND in `buildRowPatch` (an incoming name
> that shares no token with the row it is being attached to is not a variant of
> it), and a test that the provider-id path cannot attach an unrelated name.

Both now exist, in `lib/canonicalLocations.ts` — the write path, which is where
the reachable damage was.

### 17.1 The defect, stated once

`matchCanonical`'s first rule is *"shared provider id → same location, always"*,
with no name or country comparison. That is correct: a provider id **is** the
identity. But `buildRowPatch` then appended the **incoming** name to that row's
alias set unconditionally, and both `matchCanonical`'s later name test and
`resolveCanonicalLocation`'s candidate query **read** aliases. `POST
/locations/resolve` is authenticated and rate-limited, but `place.id` and
`place.name` are entirely caller-supplied and provider ids travel in the app's
own place payloads — so a caller holding a real row's provider id could attach
an arbitrary name to that place, and from then on that name resolved to it.

### 17.2 The guard is on the append, and the resolution is asserted intact

Refusing to **read** aliases would break the variants the set exists for.
Refusing an implausible **write** keeps the set meaning what it says.

`isPlausibleAlias` requires a shared non-generic word, or one of four carve-outs
this module already implements elsewhere rather than four new inventions:
spacing (`danang` / `da nang`), the stroke/diacritic fold (`searchKey`, migration
2220), the shipped abbreviation dictionary (`saigon`), and an in-order initialism
(`hcmc`). Generic geographic particles do not count as evidence, so "San Juan" is
not a plausible alias of "San Francisco".

**A refused alias must never become a refused resolution**, and that is asserted
rather than assumed: the end-to-end test sends an unrelated name on a real
provider id and pins that the row is still identified, still returned, and still
has its empty coordinates backfilled — only the alias set does not grow.

### 17.3 The boundary is measured in both directions

Two mutations, each applied and watched:

| mutation | result |
| --- | --- |
| `isPlausibleAlias` always true (the pre-fix behaviour) | **3 red**, including the end-to-end poisoning test |
| `isPlausibleAlias` always false (a guard that refuses everything) | **3 red**, including the legitimate-variant append |

A guard proven only in the refusing direction is a guard that could be refusing
everything. Both directions are pinned.

### 17.4 Limits, stated rather than papered over

Two names that share one rare word still pass, so this narrows the hole rather
than closing it. A row whose every word is generic accepts appends only through
the four carve-outs — the fail-closed direction. And **no existing data was at
risk either way**: `canonical_locations` carries zero rows with a non-empty
alias array in production and zero rows at all on portava-ci, measured rather
than assumed, so the rule could not reject a real variant that already exists.
That also means the question "does the token rule reject real variants in
practice?" has no empirical answer yet — the first real appends will be the test.

Nothing in `routes/locations.ts` was widened and no rate limit was relaxed.

### 17.5 Headline

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **273** |
| BUILT-BUT-WRONG | **49** |
| NOT-BUILT | **47** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **322 / 373 = 86.3 %** |
| **CORRECT%** (raw) = C/373 | **273 / 373 = 73.2 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **250 / 373 = 67.0 %** |
| **THE GAP** = W/373 | **49 / 373 = 13.1 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

`N → C`, so CONSTRUCTED moves for the first time this wave: this one is new
code, not an accounting correction. The denominator is unchanged at 373.
## 18. Phase 18 — the §44 sink attached, §57 computed, and the two rows that stay unverifiable

**Written:** 2026-09-21 · **Branch:** `claude/ii-telemetry-metrics` · **Base:** `1ba2de3fa`
**Scope:** §44 Telemetry, §50 Required Audit, §57 Product Success Metrics, plus
§49's G354. No row outside those sections is moved here.

Every OLD verdict below was read from `check:census-integrity`'s own recount,
not from this document's prose — §11.6 and §9.6 both record why that matters,
and this pass found the §4 tables for six of its own rows disagreeing with the
last statement about them.

### 18.1 What this pass built

**1. The sink is attached.** §3 fact 5 — *"the telemetry sink is a no-op and is
never attached … every §44 event the platform emits goes nowhere"* — was the
root cause under G263, G306, G355, G365, G366, G367 and the whole of §57. It is
now false. `travel-buddy-standalone/src/platform/input-assistance/services/installInputTelemetry.ts`
is the seam; `travel-buddy-standalone/app/_layout.tsx` mounts an `InputTelemetrySetup` that calls it with
the real batched transport, flushes on background, is idempotent against a
re-mounting root layout, and restores the default sink on dispose. It follows
`installPassportTelemetry` exactly, because that is the pattern this app already
uses for a boot-time telemetry binding.

**Why it is not gated on D4 Intelligence-Contribution consent, written down
rather than assumed.** `wallAnalytics.ts:216-249` gates `trackRealWorldOutcome`
and NOTHING else in that module, because a real-world outcome is a claim that a
person physically did something. No §44 event is such a claim: they carry
counts, lengths and enum tokens under a per-app-run token, with four independent
enforcement points (client scrub; a wire that copies six fields BY NAME rather
than spreading; a server that REBUILDS from a per-name allow-list; a table that
RAISEs if an account id is ever added). Gating this on D4 would widen what D4
means rather than honour it. **One future event does belong behind that gate and
is named in the installer's header: `downstream_task_completed` (G320/G370).**

**2. The store is bounded.** `input_assistance_telemetry_events` shipped with no
retention. `lib/intelRetentionScheduler.ts#runInputTelemetryRetentionSweep` is
the 90-day sweep (`docs/ops/retention-policy.md:3`), registered on the existing
timer, bounding on the server's `received_at` rather than the device's
`occurred_at`. **Flagless on purpose**, following `sensing_credential_cleanup`:
a retention flag shipped unseeded declares a promise and never keeps it, and
seeding one needs a migration this lane does not own.

**3. §57 is computed.** `lib/inputAssistance/metrics.ts` defines all nine
metrics over the serve log and `pnpm --filter @workspace/api-server run
report:input-metrics` is the reader. Five are computed; **four are REFUSED with
a blocker string rather than estimated** (G368, G370, G373, G371), and the tests
assert the refusals, so a later "complete the dashboard" edit cannot turn a
metric over an event nothing emits into a forever-green zero.

**4. G354 has a harness.** `src/scripts/measureInputAssistanceLatency.ts` plus
`docs/architecture/input-intelligence-performance-protocol.md`. **Every ledger
row reads NOT RUN.** A harness is not a number.

### 18.2 Row moves

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **G306** | **W** | **W** | The measurement half now exists end to end and is mutation-proven at the seam that was missing: an event emitted BEFORE install reaches nothing, the same event after install reaches a poster, and deleting either `setTelemetrySink(batcher.sink)` or the `<InputTelemetrySetup />` mount turns tests RED. The privacy half was never in doubt and gained three more enforcement points. **This C is granted on the owner's standing instruction that an attached sink with a detachment-detecting test is what turns a §44 row to C, and it is in tension with §12.2** — which declined a `C ☠prod` for G292 on the same unapplied migration. If that ruling governs here too, this row is `W`; the evidence in it is the same either way. ☠prod (2950). **— THE INTEGRATOR TOOK THE OTHER BRANCH OF THIS ROW'S OWN CONDITIONAL.** The cell above read `C` when this section was written; it is `W` now, on the sentence this entry already contains: *"If that ruling governs here too, this row is `W`; the evidence in it is the same either way."* §12.2's ruling does govern, and the owner's closing rule says a requirement whose acceptance needs live behaviour is not satisfied by correct code with a note. None of the evidence here is withdrawn and none of the mutation proofs are questioned — only the verdict. **A FACT IN §18.1 IS ALSO CORRECTED:** 2950 is not "unapplied everywhere". Measured against both databases 2026-09-21: `input_assistance_telemetry_events` EXISTS on portava-ci (ledger row, `applied_by='ci'`) and is ABSENT from production (no ledger row at all). |
| **G319** | **N** | **C** | `app/search.tsx` now calls `emitActionCompleted` on BOTH outcomes of the trip picker — `onSaved` → `ok:true`, a NEW `onSaveFailed` → `ok:false`. The failure arm is the part that needed a code change: the picker told its caller only about successes, so a wired caller could have reported `ok:true` forever. The tap that OPENS the picker still emits nothing, and a test asserts that too. No dependency on migration 2950 beyond the one its twelve already-`C` siblings share. |
| **G365** | **N** | **W** | The metric is defined and computed (episodes per session+field; P50/P95 of open → first selection), and the session correlator this row said did not exist now does and is stored per row. `W` not `C`: see 14.3. |
| **G366** | **N** | **W** | Entity-resolving selections over impressions, computed, with the entity-resolving set deliberately excluding `completion` and `action`. `W` not `C`: see 14.3. |
| **G367** | **N** | **W** | Manual-ending episodes over episodes that ended either way, computed, with both meaning-carrying guards mutation-proven. `W` not `C`: see 14.3. |
| **G369** | **N** | **W** | The acceptance of a duplicate row is now RECORDED rather than inferred from context: `emitDisambiguationSelected` carries `resolvedExisting`, read off the pressed suggestion's `resolve_existing` structured value, admitted by the ingest as a `bool` with no coercion. `W` not `C`: see 14.3. |

**G356 and G357 are not in this table because they did not move.** §8.4 moved
both `N → C` when `contexts/fieldInventory.ts` was written; the §4 rows were
never updated and still read NOT-BUILT with the evidence *"it is not in the
repository"*. They have been rewritten against the tree and the ratchet that
enforces them (`test/inputAssistanceFieldInventory.test.ts`, 14 passing
assertions, verified this pass). That is a documentation correction, not a
verdict change, and it moves no number.

### 18.3 The `C` this pass did not grant on five rows

`metrics.ts` computes G365, G366, G367, G369 and G372. It would have been easy
to call all five `C ☠prod` and note the migration. §12.2 is the reason not to:
the integration owner refused exactly that trade on exactly this migration,
writing that *"a grader who reads `C` as 'works' should read it as `W`."*

A §44 row asks whether an event is emitted; a §57 row asks for a NUMBER. Nothing
in this tree can produce one — 2950 is applied to no database, so a run of
`report:input-metrics` today exits with the PostgREST error rather than printing
anything. The distance travelled is from *absent* to *defined, computed and
reachable*, which is N → W. **Applying migration 2950 and reporting the numbers
is what moves these five to C**, and it is one action, held by the owner.

### 18.4 Rows examined and deliberately NOT moved

| row | left at | what would turn it red, and who can supply it |
| --- | --- | --- |
| G320, G370 | N | TWO things, not one. (1) A call per completed task from `app/trip/new.tsx`, `app/events/create/index.tsx`, `app/telegraph/new.tsx`, carrying the fieldId that served the creation — which those screens do not currently retain. (2) A CONSENT GATE: this is the only §44 event that asserts a real-world task happened, the class of claim D4 governs. Shipping (1) without (2) routes an outcome claim past the consent the rest of the product routes outcome claims through. The gate is named in `installInputTelemetry.ts`. |
| G368 | N | A fifteenth name in `INPUT_TELEMETRY_EVENT_NAMES` with a real call site, AND a follow-on migration widening 2950's `iate_event_name_known` CHECK — which enumerates the fourteen, so an unlisted name fails the whole insert batch at the database. `metrics.ts` refuses this metric explicitly rather than reporting 0. The migration is the blocker: the owner holds migrations. |
| G373 | N | *Restated 2026-09-22.* The offline behaviour now exists (G197–G199) AND the `degraded` bool is now emitted on `suggestion_request_completed` — no new event name, no migration. The row stays `N` on its remaining half: the ingest's prop allow-list (`lib/inputAssistance/telemetry.ts:175`) does not name `degraded`, so the flag is dropped and the stored row is indistinguishable from an online serve. One line, outside the lane that built the producer. |
| G372 | W | Left where §12.1 put it. The P95 is now computed and reachable, which corrects the row's evidence; the number does not exist. Same argument as 14.3. |
| G354 | ? | A harness now exists for three of the four dimensions and **every ledger row in `docs/architecture/input-intelligence-performance-protocol.md` reads NOT RUN** — no deployment and no handset were reachable. Render cost is refused outright as a device fact rather than approximated from a component render. An operator with deployment access runs §2–§3; one with handsets runs §4. |
| G371 | ? | **Must never close on an assertion from this tree.** The construction guarantees got stronger again this pass and none of them is the metric. The serve log is deliberately INCAPABLE of answering it: with no account id stored, "an incident happened to someone" is not a fact it could hold. `metrics.ts` refuses it with that reason and its test asserts the reason names the privacy property, so a future reader who "fixes" it by adding a `user_id` would be breaking migration 2950's own postcondition. Production security/audit logs settle it; nothing else does. |

### 18.5 Mutation log — every one applied, watched go red, reverted, `cmp`-verified

| mutation | what went red |
| --- | --- |
| `installInputTelemetry.ts`: delete `setTelemetrySink(batcher.sink)` | 6 of 11 in `installInputTelemetry.test.ts` |
| `installInputTelemetry.ts`: drop the background flush | the AppState-flush test |
| `travel-buddy-standalone/app/_layout.tsx`: unmount `<InputTelemetrySetup />` | the bootstrap source-scan ratchet |
| `app/search.tsx`: drop the `onSaveFailed` arm | the G319 wiring ratchet |
| `TripWishlistPicker.tsx`: delete `onSaveFailed?.(trip)` from the catch | the "a FAILED save is not silence" test |
| `inputTelemetry.ts`: force `resolvedExisting` false | the G369 funnel test |
| `lib/inputAssistance/telemetry.ts`: drop `resolvedExisting` from the allow-list | the ingest rebuild test |
| `metrics.ts`: widen the entity-resolving set with `completion`/`action` | the G366 test (0 → a perfect 1.0) |
| `metrics.ts`: drop the `suggestion_rendered` guard on the fallback rate | the G367 denominator test |
| `metrics.ts`: interpolate instead of nearest-rank | the "a P95 is a latency the system produced" test |
| `metrics.ts`: coerce an absent `serverMs` to 0 | the G372 omission test |
| `metrics.ts`: count every `disambiguation_selected` | the G369 count test (1 → 3) |
| `metrics.ts`: key episodes on `session_id` alone | the two-fields-one-session test |
| `metrics.ts`: ignore the `contexts` scope | the scoping test |
| `intelRetentionScheduler.ts`: window 90 → 180 days | the cutoff-boundary test |
| `intelRetentionScheduler.ts`: bound on `occurred_at` | the server-clock test |
| `intelRetentionScheduler.ts`: report an absent table as a clean sweep | the "absent table is an error" test |
| `intelRetentionScheduler.ts`: unregister the pass | both registration tests |
| `fieldInventory.ts`: flip an unmounted row to `mounted` | the §50 mounted-claim test |
| `fieldInventory.ts`: delete a record / dangle a `componentFile` | the bijection and file-pointer tests |

### 18.6 What this pass does NOT license

- **No §57 number exists.** Every metric this section claims is computable is
  computable against an empty table that does not exist on any database.
- **No latency has been measured.** G354's ledger is NOT RUN in every row.
- **No privacy-incident count has been observed**, and none can be from here.
- **Nothing was applied to any database**, and migration 2950 is unchanged.
- The headline and §5 are untouched by this pass and must be recomputed from the
  rows by whoever integrates it. Recounted at this tree, the rows read
  **C 265 / W 60 / N 44 / X 4 = 373**.

---

## 19. The last lane, its stopped author, and one verdict taken back

`claude/ii-telemetry-metrics` (§18) and `claude/ii-a11y-versioning` were the two
lanes that had not landed when the wave was integrated. **Both agents were
stopped mid-flight and will not be resumed.** Neither produced a final report.

Their worktrees held 24 and 39 uncommitted files respectively, so both were
committed to their own branches as explicit **salvage** commits — preserved
before review, with the commit message saying in its first line that nothing in
it had been reviewed. Discarding a worktree because its author stopped is how
real work disappears; endorsing it because it exists is how unreviewed work gets
counted. §18 is the telemetry lane's own account, kept as it wrote it, with the
two corrections below made in place rather than by quiet edit.

### 19.1 `G306` goes back to `W`, on the lane's own conditional

§18.2 granted `G306` a `C` and immediately wrote down why it might not deserve
one:

> This C is granted on the owner's standing instruction … **and it is in tension
> with §12.2** … If that ruling governs here too, this row is `W`; the evidence
> in it is the same either way.

It does govern. §12.2 refused a `C ☠prod` for `G292` on this same migration, and
the owner's closing rule is that a requirement whose acceptance needs live
behaviour does not become correct because the code is correct with a note. So
the row is `W`. **None of §18's evidence is withdrawn and none of its mutation
proofs are questioned** — the sink really is attached, and detaching it really
does turn tests red. What is missing is the last link, and a row is graded on
the whole chain.

That is the fourth time in this wave a lane has written down the argument
against its own verdict. Every one of them was right to.

### 19.2 A fact in §18.1 was wrong, and the correction makes the row sharper

§18 says migration 2950 is *"still unapplied everywhere"*. Measured against both
databases on 2026-09-21 rather than inherited:

| database | `input_assistance_telemetry_events` | ledger |
| --- | --- | --- |
| portava-ci | **present** | `2950_input_assistance_telemetry_events.sql`, `applied_by='ci'` |
| production | **absent** | no row at all |

So the §44 round trip is **demonstrable on CI today** and dead in production.
That makes `G306`'s closing evidence concrete instead of hypothetical: a live-DB
suite that emits an event through the installed sink and reads the row back out
of the table, plus the table existing in production.

### 19.3 What the sink attachment does change

§3 fact 5 — *"the telemetry sink is a no-op and is never attached … every §44
event the platform emits goes nowhere"* — is **now false as a statement about
the code**. `installInputTelemetry.ts` is the seam and `app/_layout.tsx` mounts
it, following `installPassportTelemetry`, the pattern this app already uses.
That was the last of §3's five deployment facts still standing as a code fact;
§3 facts 1–3 were retired by the applies in §14, and fact 4 (`intel_*` tables
empty) is unchanged and still true.

Two things the lane did that deserve keeping, because both are refusals:

- **Four of the nine §57 metrics are REFUSED with a blocker string rather than
  estimated**, and the tests assert the refusals — so a later "complete the
  dashboard" edit cannot turn a metric over an event nothing emits into a
  forever-green zero.
- **`G354`'s deliverable is a harness, and every ledger row reads NOT RUN.** A
  harness is not a number. `G371` is untouched: nothing observable establishes
  an absence of privacy incidents.

### 19.4 Headline

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **274** |
| BUILT-BUT-WRONG | **53** |
| NOT-BUILT | **42** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **327 / 373 = 87.7 %** |
| **CORRECT%** (raw) = C/373 | **274 / 373 = 73.5 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **251 / 373 = 67.3 %** |
| **THE GAP** = W/373 | **53 / 373 = 14.2 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

`N` falls from 47 to 42 and `W` rises from 49 to 53: five things that did not
exist now exist and are not yet right, which is what a lane that builds
honestly looks like. CONSTRUCTED moves 86.3 % → 87.7 % for the same reason.

The `claude/ii-a11y-versioning` salvage is **not** in this count — it is pushed
and unreviewed, and merging it is the next step, not this one. The denominator
is unchanged at 373; no row was added, removed or merged.

---

## 20. The a11y/versioning lane, integrated — and a readability regression it introduced

`claude/ii-a11y-versioning` was the seventh and last lane. Like the §44 lane, its
agent was **stopped mid-flight with no final report**, its 39 uncommitted files
were committed to its own branch as an explicit salvage, and this section is the
review rather than an endorsement.

### 20.1 What it built, and the two rows it correctly refused to close

`components/overlayFit.ts` and `components/a11yFocus.ts`, each with a suite, are
the §46 engineering half that CAN be asserted without a handset:

- The overlay cap was a literal `maxHeight = 320` at every position on every
  screen. A field 400 px down an 800-px window with a 300-px keyboard had 92 px
  of visible room and drew 320. It is now fitted to the band actually visible,
  fed by a real `Keyboard` height listener and a `measureInWindow`.
- The cap and the per-row line budget now grow with the OS text scale, so
  "Đà Nẵng, Vietnam" wraps instead of becoming "Đà Na…", with a control case
  asserting the default scale is unchanged — a mechanism that serves large text
  by regressing the ordinary case has served nobody.

**`G327` and `G328` stay `?`, which is the right answer.** The lane built the
mechanism and then said plainly that the mechanism is not an observation: the
inputs are fixtures, and whether `measureInWindow` and `keyboardDidShow` report
what the module assumes is a device question.
`docs/architecture/input-assistance-a11y-device-protocol.md` is the runnable
handset check, and **every one of its ledger rows reads NOT RUN**. It also names
a residual rather than hiding it: the overlay is an inline sibling of the input,
so this layer cannot flip it above the field, and below a 96 px floor the card
IS partly occluded — which `overlayFit` reports as `occluded: true` and the test
asserts.

`compatibility.ts` and `clientCapabilities.ts` are the §48 lane: a client
declares what it can render, and rows carrying an action it cannot resolve are
dropped rather than shown dead.

### 20.2 One defect the salvage caught, and it was a leak in the safe direction's clothing

`inputAssistanceFieldInventory.test.ts` asserted

```
isCacheablePrivacyClass("personal")  === false
isCacheablePrivacyClass("sensitive") === false
```

Neither string is a member of `types/inputContext.ts#PrivacyClass`, whose
members are `public | viewer_scoped | owner_only | sensitive_location |
private_message`. The function returns **true** — *cacheable*, the leaking
direction — for any class not in its uncacheable set. **Those two assertions
would have gone red the first time the suite ran, and it never ran.** The test
now pins all four real viewer-scoped members as uncacheable, so `G31`'s evidence
covers more of the class space than it did, not less. That is a strengthening,
not a typecheck appeasement, and it is the strongest argument for committing a
stopped agent's worktree and reviewing it rather than discarding it unseen.

### 20.3 A readability regression, named rather than absorbed

Before this lane, `check:census-integrity` reported **0 requirements counted
somewhere it cannot read** for this census. It now reports **3**: requirements
counted inside prose paragraphs rather than table rows. The checker calls that
*"a legitimate way to count them and an impossible one to parse"*, and it passes
— the prose gap is exactly what makes a headline/row mismatch expected rather
than wrong.

It is still a regression, and it is stated here rather than absorbed into a
number: **three of this census's rows can no longer be checked by the one tool
that checks whether the document agrees with itself.** Converting them back to
table rows is a job for whoever next opens §46, and it must be done by re-reading
those rows, not by transcribing a paragraph.

### 20.4 Headline

Parsed from the table rows, with the prose remainder stated separately instead
of being split by guess:

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT (parsed) | **274** |
| BUILT-BUT-WRONG (parsed) | **51** |
| NOT-BUILT (parsed) | **41** |
| CANNOT-VERIFY (parsed) | **4** |
| *counted in prose, unparseable* | *3* |
| **CORRECT%** (raw) = C/373 | **274 / 373 = 73.5 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **251 / 373 = 67.3 %** |

**`C` does not move from §19.4 and that is not a disappointment — it is the
lane's own restraint.** Its two headline rows are `?` because they need a
handset; its §48 work moved rows inside the built set; and its one accounting
correction (`G329`) was already counted. A lane that builds a real mechanism and
still refuses the verdict is the behaviour this corpus is for.

All seven lanes are now integrated. The denominator is unchanged at **373**; no
row was added, removed or merged in the whole wave.

---

## 21. Validating the salvage: four behavioural failures, one real leak, and three rows the tool could not see

§19 and §20 integrated two lanes whose agents were stopped, on typechecks and
documentation guards. **That is not validation.** This section is what happened
when the 63 salvaged files were actually run.

### 21.1 Four failures, and none of them was a flaky test

The client suite went **6438 pass / 4 fail**. Every one was a genuine
cross-lane collision — two lanes changing the same contract in the same wave,
neither able to run the other's tests:

| failure | cause | fix |
| --- | --- | --- |
| `§44: the installed sink carries NO raw text onto the wire` | The §44 lane's test passed `{ events: 'all', captureRawText: false }`. The §48 lane had removed the `'all'` sentinel in the same wave (G33) and `isEventAllowed` now does `policy.events.includes(name)` — which on the *string* `'all'` is false. The event never reached the sink; the assertion read `p.batches[0]` of an empty array. `captureRawText` has never been a field of that type either; the scrub reads `logRawText`. | The test now uses the real shape. **The code was right and the test was two versions stale.** |
| `the §35 in-memory buffer finally has a writer` | see below | fixture |
| `§29: a PERSONAL field retains nothing and reads nothing back` | **A real leak. See §21.2.** | allowlist |
| `§48: the global search bar declares LESS than the shared overlay` | The §48 lane asserted `open_compass` "has no dispatch target in the search bar and must not be claimed". §43/G305 gave it one in the same wave — `app/search.tsx:497#getOpenCompassTarget`, routing through `prefillMessage`, the handoff Compass already accepts from Layover. Verified dispatchable before touching the test. | `open_compass` removed from the dead list, and the stale sentence in `clientCapabilities.ts`'s header corrected. `share_entity` and `drop_pin` remain genuinely dead, so the test still proves the search bar declares *less* rather than becoming a tautology. |

**6443 / 6443 now**, both client typechecks at exactly their baselines
(173/60 and 863/115).

### 21.2 The cache gate answered "cacheable" for classes it had never heard of

`isCacheablePrivacyClass` carried a doc comment promising it was *"fail-CLOSED
on an unknown or missing class"*. The code was a **denylist** of four private
classes, and it failed closed on `null`/`undefined` **only**. Any other string —
including one this build had never heard of — came back **cacheable**.

**That is a reachable runtime path, not a fixture artifact.** `privacyClass`
arrives in the *server's* field policy, and §48 exists precisely because client
and server versions skew. A server classifying a new field as, say,
`crew_scoped` hands an older build a class it cannot recognise, and the denylist
answers "cacheable" — retaining a viewer-scoped list of **people** in a
process-global map keyed by typed text, served back without a round trip that
could re-check eligibility. *The newer and more careful the server, the worse
the failure.*

It surfaced because a fixture used `'personal'`, which has never been a member
of `PrivacyClass`. The fixture was wrong; the answer it got was worse.

The gate is now an **allowlist**: `public` is cacheable and nothing else is —
which is what the file's own prose already said, *"the cache is safe there and
only there"*. Explicitly public data still caches; that is asserted as a control,
because an allowlist that refused everything would pass the leak test and
silently disable the cache for the one class it exists to serve.

**Mutation-proven in both directions.** Restoring the denylist reddens exactly
the new skew test and nothing else — which also establishes that `public` was
the only class the denylist had ever legitimately admitted.

### 21.3 The three rows no checker could see

§20.3 named a regression: `check:census-integrity` reported **3 requirements
"counted somewhere this tool cannot read"**, against 0 before the wave. They are
**`G33`, `G341` and `G343`**, and the cause was mechanical rather than
editorial: each wrote its verdict cell as a *transition* — `W → **C**`,
`**N** → **C**` — which is two verdict tokens where the parser reads one.

Each was re-read against the code before the cell was rewritten, not
transcribed:

- **`G33`** — `telemetryPolicy` is one shape on both sides, `logRawText` plus a
  plain `events` list, and the `'all'` sentinel is gone. Independently confirmed
  by §21.1: the only surviving `'all'` in the tree was the stale test, and
  fixing it required using the real shape.
- **`G341`** — `compatibility.ts:56#SUGGESTION_SCHEMA_VERSION = 1`, distinct
  from the policy version, with `clientCapabilities.ts:54#CLIENT_SCHEMA_VERSION`
  as its counterpart.
- **`G343`** — both directions: the request carries the surface's declaration
  (`parseClientCapabilities` at `routes/inputAssistance.ts:158`) and the response
  is thinned to it (`negotiateSuggestionTypes` at `:159`,
  `dropUnresolvableActionRows`).

All three resolve to `C`, the transition now reads in the evidence, and
**`check:census-integrity` reports 373 rows parsed and 0 it cannot read.**

### 21.4 Headline

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **277** |
| BUILT-BUT-WRONG | **51** |
| NOT-BUILT | **41** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **328 / 373 = 87.9 %** |
| **CORRECT%** (raw) = C/373 | **277 / 373 = 74.3 %** |
| **CORRECT% (spec-attributable)** = (C-23<sup>p</sup>)/373 | **254 / 373 = 68.1 %** |
| **THE GAP** = W/373 | **51 / 373 = 13.7 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

**`C` rises 274 → 277 and NOT ONE of those three is a new closure.** `G33`,
`G341` and `G343` were already `C` in this document and already counted by a
human reader; what changed is that the tool can now see them. A reader comparing
this table with §20.4 should read the difference as *visibility restored*, not
as work delivered — and the row for each says so in its own cell.

The denominator is unchanged at **373**.

---

## 22. G85's host, and the five Map flags re-evaluated one at a time

### 22.1 `G85` — the city picker was always on screen, it just never said so

The row's blocker was that `city_picker` was a registered **context** that no
screen in the app ever mounted. §50's field inventory recorded `geo.city` as
UNMOUNTED, and `registerGeographicFields()` — idempotent, unit-tested, shipped
since Phase 2 — was called from **no non-test file**, so every geographic
surface resolved a default policy rebuilt from its descriptor instead of its
registered one.

`src/components/discovery/DestinationBar.tsx` **is** the city picker: titled
"Search destination", prompting for "City, island or region", mounted in
Discovery. It declared no assist context at all, so `GlobalPlacePicker` fell
back to the `__geo_no_assist__` fieldId and the platform was off for it
entirely. It now declares `assistContext="city_picker"` and the canonical
`GEO_FIELD_IDS.cityPicker`, following the idiom `app/trip/new.tsx` and
`app/trip/edit.tsx` already used — those two were the **only** screens in the
product passing an assist context, both `trip_destination`. `app/_layout.tsx`
mounts a `GeographicFieldsSetup` beside the telemetry installer.

**The write side needed nothing.** `GlobalPlacePicker` has called
`recordSuggestionSelection` on select all along, and
`selectionWriterCoverage.test.ts` already fails any accept handler that stops.
It recorded nothing for this surface because an unnamed field has no policy that
permits personalization.

**It stays `W`.** The substrate reached production at 10:52 and the surface is
wired, but nobody has observed a pick recorded and re-surfaced. Same wall as
`G306`, named the same way.

### 22.2 The five Map flags, individually — and why none is enabled

`protected_zones` (2217) cleared the prerequisite all five shared;
`check:flag-schema-prerequisites` went from **24 latent flags to 18**, and none
of the five still reports an absent object. That half of the re-evaluation is a
real result. The other half is not:

| flag | schema prerequisites | production `feature_flags` row | server read sites |
| --- | --- | --- | --- |
| `map_display_resolver_enabled` | **satisfied** | **no row at all** | `lib/mapDisplayResolver.ts`, `routes/mapProjection.ts` |
| `map_experience_state_enabled` | **satisfied** | **no row at all** | `lib/mapProjection.ts`, `routes/mapProjection.ts`, `routes/mapProjectionTemporal.ts` |
| `map_projection_enabled` | **satisfied** | **no row at all** | `routes/mapProjection.ts`, `routes/mapProjectionTemporal.ts` |
| `map_world_moments_enabled` | **satisfied** | **no row at all** | `lib/mapProducers/worldMomentProducer.ts`, `routes/mapProjection.ts` |
| `locate_friends_enabled` | **satisfied** — "missing in production: none" | present, `false` | 6 sites incl. `routes/locateFriends.ts`, `routes/safeReturn.ts` |

Two facts decide this, and neither is a matter of taste:

1. **Four of the five have no row in production at all.** `isFlagEnabled` is
   fail-closed, so an absent row reads OFF. "Enabling" them is not flipping a
   switch — it is **seeding flags no migration has seeded in production**, which
   is a different and larger act than the one the instruction describes.
2. **The deployed consumer cannot be verified from here.** Every one of these
   flags gates server code, and whether the deployment is running code that
   reads them is not observable: the host is unreachable from this environment
   (403 to CONNECT at the egress gateway), and much of the code that reads them
   is on an unmerged branch.

Enabling a map flag turns on **user-visible behaviour** over real people's
locations. Doing that on a verified schema and an unverified consumer is exactly
the "looks correct, runs nowhere" failure this corpus keeps cataloguing, with
the consequences pointing at users rather than at a number. **So none is
enabled, and the blocker is reachability, not judgement.**

What would let each be enabled, in order: a reachable deployment; confirmation
that its build carries the reading code; for the four, a seeded row (OFF first);
then one flag at a time, with the map surface observed after each.

## 23. `G371`'s metric is still unanswerable — but the subsystem could not have raised the alarm either

`G371` asks for privacy-incident observability. Two separate questions hide in
that row, and only one of them is answerable from this tree.

**THE ROW'S OWN METRIC STAYS `?`, AND THAT IS THE CORRECT ANSWER.** §57's
privacy-incident rate is a count of incidents per account over a window, and the
serve log deliberately stores **no account id** — the same by-design omission
recorded for `input_assistance_telemetry_events` in §18. `metrics.ts` already
refuses the metric rather than computing `0` over a column that does not exist,
which is the honest behaviour: a metric that cannot be computed must not report
the reassuring number. Reporting zero incidents because nothing can be counted
is exactly the "silence as proof of correctness" the owner's rule forbids. The
row is settled by production security and audit logs, read by someone who has
access to them, and by nothing in this repository.

**WHAT WAS BUILDABLE, AND WAS BROKEN.** While grading that row, the ingest
write path turned out to answer **every** failure the same way:

```ts
const { error } = await db.from(TELEMETRY_TABLE).insert(rows as TelemetryRow[]);
if (error) {
  if (log) log.warn({ err: error, count: rows.length }, 'input telemetry ingest write failed');
  return { recorded: 0, refusal: { retryable: true, reason: 'write_failed' } };
}
```

`retryable: true` — including for a CHECK violation, which the function's own
doc comment already listed as a thing that happens. Two defects, one of them a
privacy defect:

1. **A poison pill.** A batch that violates a constraint can never be accepted,
   and the client was told to try again forever. Every event queued behind it
   never lands, so the §57 denominators quietly stop moving — a telemetry
   subsystem that fails by going silent rather than by erroring.
2. **Privacy blindness.** Migration 2950's `iate_props_no_raw_text` firing means
   the server's per-event-name rebuild allow-list and the migration's
   forbidden-key list **disagree**. Nothing leaked — the constraint is the gate
   and it held — but a line of defence meant to be unreachable was reached, and
   it was logged indistinguishably from a network blip.

**THE FIX** is `classifyWriteFailure`
(`artifacts/api-server/src/lib/inputAssistance/telemetry.ts:463#function classifyWriteFailure`).
The raw-text constraint emits an `error`-level line naming the constraint, the
SQLSTATE, the batch size, the distinct event names and **which forbidden key
names were present** — matched against this file's own
`FORBIDDEN_PROP_KEYS` (`telemetry.ts:373#export const FORBIDDEN_PROP_KEYS`),
which mirrors 2950's thirteen keys exactly and is pinned by a test that reads the
migration. **The props themselves are never logged.** Writing the offending blob
into the log to diagnose a raw-text leak would move the exact harm the constraint
prevents somewhere with weaker retention controls. Key NAMES travel; values do
not. Other permanent SQLSTATEs (`telemetry.ts:356#const PERMANENT_SQLSTATES` —
`23514`, `23502`, `23503`, `23505`, `22001`) refuse without retry. **Everything
else still retries**, which is the deliberate default: the honest answer to an
unrecognised error is to let the client try again, and a test pins that floor so
a later edit cannot quietly turn "unknown" into "give up".

The route now answers **422** for a permanent refusal instead of 503 with a
`Retry-After` (`artifacts/api-server/src/routes/inputAssistance.ts`), so the
batcher drops the batch and moves on rather than replaying it.

**THE CONSTRAINT WAS FIRED, NOT ASSUMED.** Against the throwaway PostgreSQL 16
where 2950 is applied, an insert carrying a forbidden key returned:

```
ERROR:  new row for relation "input_assistance_telemetry_events" violates check constraint "iate_props_no_raw_text"
SQLSTATE: 23514
```

which confirms the SQLSTATE and that PostgreSQL puts the constraint NAME in the
message text.

**WHAT THAT MEASUREMENT DOES NOT ESTABLISH, corrected rather than left
standing.** It was taken through `psql`, not through PostgREST, and PostgREST is
what production runs. So whether a `constraint` FIELD reaches `supabase-js`
alongside the message is *not* something it settles. An earlier draft of this
section said the message fallback "is the path that will actually fire in
production" — an inference dressed as a measurement. **Withdrawn.** Neither
production's REST endpoint nor the CI project's is reachable from here (403 to
CONNECT at the egress gateway, re-tested 2026-09-21 13:30 rather than inherited
from the G306 finding), so which branch fires there is unknown and is recorded
as unknown.

**TRYING TO WRITE THAT DOWN FOUND TWO REAL DEFECTS, which is the argument for
writing it down.**

*First, the fallback branch had no test at all.* Both existing cases passed a
`constraint` field, so the message path was never exercised. Worse, the obvious
fix was vacuous: a `23514` with no constraint field takes the second disjunct of
the privacy-guard condition anyway, so a test asserting the outcome went green
with the fallback deleted. It took a mutant that *removed* the fallback and
still passed to expose that.

*Second, and this is the one that mattered:* `constraintName` matched only this
file's own `RAW_TEXT_CONSTRAINT` inside the message and returned `''` for
anything else — which made every OTHER constraint indistinguishable from an
unidentifiable one. 2950 declares **eight** checks and seven have nothing to do
with privacy. So an oversized props blob (`iate_props_bounded`) or an undeclared
event name (`iate_event_name_known`) was reported as
*"PRIVACY GUARD FIRED: the serve-log rebuild allow-list admitted a key migration
2950 forbids"*. That is false, and **a privacy alarm that cries wolf is worse
than none, because it trains the next reader to skip the real one.**

The parse is now generic —
`/violates check constraint "([^"]+)"/` (`telemetry.ts:388#CHECK_CONSTRAINT_IN_MESSAGE`)
— so a named, different constraint falls through to the ordinary
permanent-refusal branch and raises no privacy alarm, while a `23514` whose
constraint genuinely cannot be identified still does (the noisier error is the
safe one: a false alarm sends someone to a log line that names no values, a
missed one means the single signal that the allow-list and the database disagree
went out as a shrug).

**MEASURED AGAINST THE DATABASE, NOT AGAINST MY RECOLLECTION OF IT.** Both
messages were re-fired on the throwaway PostgreSQL 16 where 2950 is applied and
the regex run against the verbatim output:

```
... violates check constraint "iate_props_no_raw_text"   ->  iate_props_no_raw_text
... violates check constraint "iate_props_bounded"       ->  iate_props_bounded
```

Both inserts were REFUSED, so the probe wrote nothing — verified by count rather
than assumed, the same discipline 2950's own production probe used.

Eight tests in `artifacts/api-server/src/test/inputTelemetryPrivacyGuard.test.ts`
cover it: both `constraintName` branches, the false-alarm discrimination above, a
control that an unknown failure stays retryable, and one asserting no `props`
**values** reach the log line. Mutation-proven — reverting the parse to the
name-only match, or deleting it, each reddens its own case.

**AND THIS IS NOT `G371`.** This is a near-miss detector for one specific
disagreement inside one subsystem. It does not count privacy incidents, it
cannot see anything outside the telemetry ingest, and it produces no §57 metric.
`G371` keeps its verdict. Recording this as closing that row would be counting a
smoke alarm in one room as fire coverage for the building.

## 24. Twenty-two evidence pointers in this census pointed at nothing

`check:citation-targets` judges only UNANCHORED citations — a bare
`file.ts:NNN` with no backticked symbol after it — and it can say just one
thing about them: whether the cited line is blank or holds a lone brace. It
reported twelve such misses in this document. Reading them turned up ten more
that the tool could not see, because a stale pointer that happens to land on
a line of real code is invisible to it.

**WHY THIS MATTERS MORE THAN A LINE NUMBER.** Every one of the twenty-two sits
in the evidence column of a `C` row. A `C` verdict is a claim that someone
read the code and found the requirement met; the citation is the only way a
later reader can check that without redoing the work. A pointer into the
wrong function does not merely inconvenience them — it is an assurance with
nothing behind it, and it fails in the direction that hurts, because the row
still reads CORRECT.

**HOW EACH WAS REPOINTED.** By reading the claim and finding what satisfies it,
not by applying an offset. Two cases are worth naming because they show the
difference:

* `G15`'s six bare `gateway.ts` pointers name the six `dropDeadRows` return
  paths. The file has exactly six, and the drift is NOT uniform (+61, +73,
  +88, +94, +94, +192), so an offset would have been wrong on five of them.
  They were mapped positionally onto the six real call sites, which the equal
  counts license.
* `G23` cited `gateway.ts:183-186` for the `allowPersonalization` read. That
  read is at `:227`. Its sibling citation in the same row,
  `personalization.ts:464-466`, was checked too and is **correct** — the
  refusal is at `:465` — so it was left alone. A sweep that had "corrected"
  both would have introduced an error while claiming to remove one.

`projection.ts` had drifted a uniform +61 across five separate citations,
which is what a pure insertion above them looks like; `socialIdentity.ts` a
uniform +41. Those were verified one at a time against the symbol each claim
names rather than inferred from the pattern.

Measured after: `check:citation-targets` reports **zero** dead pointers in
this census, down from twelve, and the corpus figure falls 222 → 210. Both
ceilings were LOWERED to the new measurement (`MAX_DEAD_TARGETS` 223 → 210,
`MAX_MISPLACED_SYMBOLS` 39 → 38), because a ratchet left slack is a ratchet
that admits the next regression for free. `check:doc-citations` RESULT clean,
`check:citation-symbols` 0 above its zero ceiling.

**WHAT THIS DOES NOT DO.** It does not re-grade a single row. Every verdict
here is exactly what it was; what changed is that a reader who follows one of
these pointers now lands on the code the row is talking about. The tool's own
disclaimer is the honest summary and it still applies: a citation that lands
on real code may still land on the WRONG real code, and no script can tell.

## 25. G109 built: a venue selection now prefills all four dependents

This is a BUILD, and the one verdict move in this pass. The row is closed
against the criterion it wrote for itself, and the full account lives in the
row rather than here.

**THE GAP WAS NAMED EXACTLY, WHICH IS WHY IT COULD BE BUILT.** The previous
entry said what would turn it red: *"a `CanonicalVenueBinding` carried on place
rows in picker contexts, resolving country through `canonical_location_id` and
the timezone through the same `timezoneForCoords`, with a test that selects a
venue and reads all four."* Every clause of that is now true. The §17 city
binding had been complete since Phase 2; the spec's worked example runs from a
VENUE (Sky36 → Da Nang → Vietnam → coordinates → `Asia/Ho_Chi_Minh`), and a
place selection emitted a bare `open_entity` with no structured value at all —
so the dependency graph existed for one node class out of the two named.

**THE THREE DESIGN RULES ARE EACH A REFUSAL.** Coordinates are the venue's, not
the city centroid's, because substituting the centroid silently moves the map
pin to the middle of town. The timezone is derived from those same venue
coordinates through the existing helper, so the city and venue paths cannot
disagree about one point on the map. And country is never inferred from a city
NAME — "Springfield" names places in dozens of countries, and a prefilled
country the user did not choose is worse than an empty one they will.

**THE FAIL-CLOSED RULE IS THE PART WORTH READING TWICE.** A place with no
canonical link and a place whose canonical read FAILED are treated differently.
The first binds with `country: null`, which is true of it. The second gets no
binding at all — because §17 PREFILLS dependent fields from this value, so an
outage rendered as `country: null` would write "this venue is in no country"
into a field the user can see. Absent prefill is a smaller harm than wrong
prefill, and a mutation that collapses the two reddens its own case.

Nine cases in `artifacts/api-server/src/test/inputAssistanceVenueBinding.test.ts`,
mutation-proven six ways with every mutant reverted; the regression set around
the three changed files runs 166/166.

**WHAT IS NOT CLAIMED.** That a user has seen four fields fill on a running
deployment. This closes the SERVER contract — what the gateway emits for a
picker selection — which is what the criterion names. The client's rendering of
a `structuredValue` is G46's subject and is untouched.

### 25.1 Headline, restated from the rows

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **278** |
| BUILT-BUT-WRONG | **50** |
| NOT-BUILT | **41** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **328 / 373 = 87.9 %** |
| **CORRECT%** (raw) = C/373 | **278 / 373 = 74.5 %** |
| **THE GAP** = W/373 | **50 / 373 = 13.4 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

The denominator is unchanged and no requirement was added, removed or
reclassified: exactly one row moved `W → C`, so C rises by one and W falls by
one. `CONSTRUCTED%` is unchanged because C+W is unchanged — which is the point
of keeping both figures.

## 26. G57 closes on a production measurement, not on the apply

The second verdict move of the day, and it needed no new code at all — 2220 had
been applied to production at 10:52 and nobody had gone back to read what that
did. **An applied migration is not a closed requirement**, which is why this row
stayed `W` through the apply and is closed only now, against the three clauses
it wrote for itself.

**WHAT THE PRODUCTION READ FOUND.** `search_key` present and
`is_generated = ALWAYS` — a STORED column, which matters because a view or a
trigger would be a different guarantee. `input_normalize_city_key` present,
`pg_trgm` installed, 31 rows intact. The three facts the row had recorded as
ABSENT are all true, and the row count is unchanged, so nothing was lost.

**AND THE TWO ROWS THAT SETTLE IT.** Production holds two Da Nang entries:

| name | `normalized_name` (legacy) | `search_key` (2220) |
| --- | --- | --- |
| `Da Nang` | `da nang` | `da nang` |
| `Thành phố Đà Nẵng` | **`thanh pho a nang`** | **`thanh pho da nang`** |

A typed `da nang` matches both through `search_key` and only the first through
`normalized_name`. The Vietnamese-spelled row is reachable **only** through the
stored fold, because `đ` has no NFD decomposition: the legacy normaliser dropped
it and stored a key no user will ever type. That is precisely the case 2220's
own header cites, still sitting in the production data, now answerable.

**THE ISOLATION WAS CHECKED RATHER THAN ASSUMED**, because it is the clause that
could have been faked: the requirement is that the match come from the STORED
COLUMN and not from the application-side alias table. `CITY_GEO_ALIASES` has no
`da nang` entry and `resolveGeoAlias('da nang')` returns `da nang` unchanged, so
the key reaching the database is the plain fold. There is nothing else it could
be.

**THE TEST'S FIXTURE IS THE PRODUCTION DATA, VERBATIM.** Two implementations of
one rule — the SQL in 2220 and `searchKey()` in TypeScript — is the arrangement
that rots, because the SQL is applied once and never read again while the
TypeScript is edited whenever a new caller needs folding. The new suite pins
them together against what production actually stores. Mutation-proven three
ways: removing `đ`/`Đ` from `STROKE_FOLD` reproduces the production defect
exactly; making `searchKey` skip the fold reddens a case; removing `đ` from the
migration reddens a case. 2220 was restored byte-identical after that last one —
its checksum is recorded on portava-ci and an edit would drift it.

**WHAT IS NOT CLAIMED.** That the resolver FUNCTION ran against production. It
cannot: production's PostgREST answers 403 to CONNECT from this environment, the
same wall as G306. Its two predicates were run directly against the production
database instead, which is what the criterion asks for — the function's logic is
covered by its own suite, and what was previously unknown was the DATA.

### 26.1 Headline, restated from the rows

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **279** |
| BUILT-BUT-WRONG | **49** |
| NOT-BUILT | **41** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **328 / 373 = 87.9 %** |
| **CORRECT%** (raw) = C/373 | **279 / 373 = 74.8 %** |
| **THE GAP** = W/373 | **49 / 373 = 13.1 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

Denominator unchanged, nothing added or reclassified: one row moved `W → C`, so
C rises by one and W falls by one. `CONSTRUCTED%` is unchanged because C+W is.

## 27. The mirror disagrees with the authority in 27 of 29 contexts

Found while grading **G46**, whose third clause asks for exactly this guard:
*"a parity assertion over `allowedSuggestionTypes` so the two registries cannot
disagree about it again."* The assertion is built. **G46 does not move** — its
other two clauses need a projector emitting the `structured_value` TYPE and a
server policy admitting it, and neither exists.

**MEASURED, BOTH DIRECTIONS.** Comparing `policyRegistry.ts` (the authority the
gateway enforces) against the client's `INPUT_CONTEXT_REGISTRY`:

* **`allowedSuggestionTypes`: 27 of 29 contexts disagree.** Only
  `telegraph_message` and `generic_text` match.
* **`defaultMode`: 3 of 29 disagree** — `buddy_service` and `username`
  (`search` vs `free_text_assisted`), and `display_name`.

**`display_name` IS THE SHARP ONE AND IT IS AN OWNER QUESTION.** The server
calls it a `search` context serving `['entity']`; the client calls it
`no_assistance` with an empty list. That is not a tuning difference — the two
sides disagree about whether the field is assisted **at all**, and whether a
person's display-name field should offer people-search suggestions is a product
decision, not a merge. It is raised here rather than settled.

**THE DRIFT IS INERT TODAY, AND THAT IS THE WORRYING PART.** The server enforces
`allowedSuggestionTypes` at roughly fourteen decision points in `gateway.ts`.
The client's copy is declared, cloned into `inputPolicies.ts`, recorded in the
§50 inventory, asserted by three of its own tests — and read by **no runtime
consumer**. The server's type negotiation
(`artifacts/api-server/src/routes/inputAssistance.ts:223#negotiateSuggestionTypes`)
runs against client CAPABILITIES, a different field entirely.

So nothing is broken for a user right now. **This is precisely the shape
`privacyClass` had until this morning**: declared on both sides, read on one,
drifted on 14 of 29 — and two of those ran the UNSAFE way, which nobody noticed
until someone measured it. A mirror free to drift further is how the next such
surprise gets built.

**WHY A CEILING RATHER THAN A ZERO.** Aligning the mirror to the authority is
mechanically safe — nothing reads the mirror — but it would commit thirty values
that encode product decisions this pass may not invent, `display_name` foremost.
So the two new assertions in
`artifacts/api-server/src/test/inputPolicyContractParity.test.ts` are RATCHETS at
today's measurement (27 and 3): the drift can only shrink, and the comment says
to lower the ceiling on each fix and never raise it. Mutation-proven three ways —
drifting one of the two contexts that currently agree reddens the type ratchet
(28 > 27); changing one `defaultMode` reddens the mode ratchet; and breaking the
client's shared type constants so the lists stop resolving reddens a separate
non-vacuity assertion, because a parser that silently matches nothing would
otherwise report perfect agreement.

**THE REAL FIX IS G340**, which this does not attempt: a policy endpoint the
client fetches and caches, with the local registry demoted to a cold-start
fallback. That deletes the mirror instead of aligning it, and it is a runtime
change across every consuming screen. G340 stays `W`.

No verdict moves in this section. The headline is unchanged at
**279 C / 49 W / 41 N / 4 X of 373**.

## 28. Two owner decisions, implemented

Both questions §27 left open were answered by the owner on 2026-09-21. Neither
is re-argued here; what follows is what was built and what it did and did not
settle.

### 28.1 `display_name` is MANUAL — and the old shape was worse than a mismatch

**The ruling:** no entity suggestions, no assistance.

The two registries had disagreed about this field, and the disagreement was not
a tuning difference: the SERVER declared `mode: 'search'` with
`allowedSuggestionTypes: ['entity']` over `entityTypes: ['user']`, while the
CLIENT declared `no_assistance` with an empty list. They disagreed about whether
the field is assisted **at all**.

Reading it in that light is what makes the ruling obvious in hindsight.
`display_name` is the field on which a person edits **their own name**. Serving
it `entity` rows over `entityTypes: ['user']` means typing your own name
searches OTHER PEOPLE and offers them back — a people-search mounted on a
profile-edit field. Nothing in §23 asks for it, and no client ever surfaced it,
so the capability existed on the wire and nowhere else. The authority now agrees
with the mirror.

It is `no_assistance` rather than merely an empty type list because the gateway
short-circuits on the MODE (`gateway.ts:244`) and returns before issuing any
read. An empty list would still walk the request path and depend on every
downstream arm checking its own gate — one missed check and the field is
assisted again.

Four cases in `artifacts/api-server/src/test/displayNameManual.test.ts`, proven
failing-first the honest way: with the old policy restored, **two fail on the
real assertions** (`expected: 'no_assistance'`), and the two that pass in both
states are the privacy-class check, unchanged by design, and a non-vacuity
control asserting a comparable `search` context still carries entity
assistance.

**BOTH PARITY RATCHETS FELL** as a consequence, and were lowered rather than
left with slack: `allowedSuggestionTypes` drift **27 → 26**, `defaultMode` drift
**3 → 2**. That is the instruction in §27's own comment being followed.

### 28.2 G340: the authoritative policy endpoint exists; the row stays `W`

**The ruling:** build the endpoint rather than hand-align the mirror — it
deletes the mirror instead of aligning it.

`GET /input-assistance/policies` serves all 29 contexts and the
`POLICY_VERSION` the suggest path already stamps, so a shipped client can
compare what it holds against the authority and fetch the difference. The
endpoint is a **projection** of `resolvePolicy()`, and that is asserted rather
than intended: the suite walks every served field of every context against the
registry and fails on any divergence — hand-rolling one value reddens it.
`telemetryPolicy` is deliberately not served; it governs what the SERVER logs
and the client may not choose it.

**THE ROW DOES NOT MOVE, because an endpoint nothing fetches versions nothing.**
The client still declares all 29 contexts locally and reads its own copy. What
is left is smaller than this row had been claiming, and §28.3 corrects that.

A fixture defect is worth recording because it cost a wrong first reading: the
endpoint answered `503 degraded_unavailable` on its first test run and looked
broken. It was not — `requireUser` performs the §9 three-state read of
`profiles.account_status` before any handler runs, and the test's fake client
refused every table. The fixture now serves that one read and still throws on
anything else, so the HANDLER is still proven not to touch the database. The
route comment was corrected too: it had claimed the request touches no database,
which is true of the handler and false of the gate above it.

### 28.3 A correction to G340's own scoping

The row said a policy endpoint would be *"a runtime change across every
consuming screen, not a test."* Measured, that is wrong, and a row that
overstates its own difficulty stays open longer than it should.

Every RUNTIME consumer reaches the registry through **two functions in one
module** — `resolveFieldPolicy` and `getContextDescriptor`:
`hooks/useInputAssistance.ts`, `voice/voiceIntake.ts` and `app/search.tsx` all
go through them; `platform/input-assistance/index.ts` is a barrel re-export and
`contexts/fieldInventory.ts` is the §50 documentation surface, not a runtime
path. **No screen reads the registry directly.** So the remaining work is a
fetch, a cache keyed on `policyVersion`, and a cold-start fallback behind those
two functions.

No verdict moves in this section. The headline is unchanged at
**279 C / 49 W / 41 N / 4 X of 373**.

---

## §29 — One vocabulary on the wire: the prerequisite G340 turned up

§28.3 said the remaining G340 work was "a fetch, a cache keyed on
`policyVersion`, and a cold-start fallback." Before writing the fetch I compared
the two sides' **type unions**, because a fetch only works if the client can
name what the authority sends. Two of the six could not.

| union on the wire | client | server | verdict |
| --- | ---: | ---: | --- |
| `InputContext` | 29 | 29 | identical |
| `AssistanceType` | 10 | 10 | identical |
| `PrivacyClass` | 5 | 5 | identical (fixed 2026-09-21, §27) |
| mode (`InputAssistanceMode` / `InputMode`) | 6 | 6 | identical |
| `EntityType` | 13 | 18 | **server superset by 5** |
| `OfflineInputPolicy` | 4 | 5 | **only 2 members shared** |

### 29.1 `offlinePolicy` — a dialect, not a second vocabulary

`inputPolicyContractParity.test.ts` had already MEASURED this drift — its header
says `offlinePolicy` differed "on 26 (the two unions are not even the same
taxonomy)". What was new was not the number but the EXCUSE attached to it: the
file left the field unasserted because the client's was "a different,
device-side vocabulary", and pinning it "would freeze that debt instead of
describing it."

Taken apart context by context, that did not hold. Of the 29:

* **7 were a pure rename** — `cached_entities` here is `cached_local` there, and
  the three `static_dictionary` contexts already agreed outright.
* **12 were a collapsed distinction** — the client's `none` stood in for both
  `server_required` (the field IS assisted, but only with a network) and
  `unavailable` (never assisted). The authority draws a line the client could
  not express.
* **10 were genuine disagreement**, and **9 ran the same direction**: the client
  declared it could serve suggestions offline — `cached_entities` or
  `recent_only` — for a field the authority marks `server_required`. Those nine
  are `place_picker`, `trip_stop_place`, `event_location`,
  `hidden_gem_location`, `buddy_service_area`, `address`, `hashtag`,
  `telegraph_recipient`, `telegraph_message`. `global_search` was the only one
  running the other way.

One renamed member and one lost distinction is a dialect. Nine over-claims are a
defect. **Nothing on the client branches on the field**, so none of it was ever
live — the same "latent only because nothing consumes it" shape as the
`allowPersonalization` and `privacyClass` findings, and the same argument for
fixing it while it is still free.

What changed the urgency is G340 itself. Once `GET /input-assistance/policies`
serves `offlinePolicy`, the client's local copy stops being a private opinion
and becomes a **prediction of what the authority will hand it** — and a wrong
prediction changes behaviour on the first fetch, before any of the fetch code is
written. The client union was widened to the authority's five members and all 26
disagreeing contexts took the authority's value. The parity suite now asserts
both the vocabulary and the per-context value, failing-first proven and
mutation-proven.

`global_search` is the one context where adopting the authority made the client
declaration **looser** (`recent_only` → `cached_local`). It is recorded here
rather than quietly taken, because whoever first wires offline behaviour should
see that this one was not a tightening.

### 29.2 `EntityType` — and a latent mis-route the widening exposed

The server can serve five entity classes the client could not name: `activity`,
`circle`, `post`, `stamp`, `vibe`. Four are in served `entityTypes` today —
`circle`/`post`/`stamp` on `global_search`, `activity` on `plan_title` and
`buddy_service`. The client union was widened to the authority's whole set,
`vibe` included, so the next server addition is the thing that drifts rather
than this list.

Widening it immediately reddened the client typecheck at
`search/globalSearch.ts`, on a `Record<EntityType, string>` whose own comment
reads: *"Kept exhaustive so a new entity type is a compile error here rather
than a silently mis-iconed row."* That promise was real but was only ever
exhaustive over the **client's narrower union**. A served `stamp` never reached
the map as a compile error — it fell through the `|| 'places'` default beneath
it and rendered as a **Place, with a MapPin, in the Places group**. Widening the
union converted a latent mis-route into the compile error the comment always
promised, which is the guard working, one union late.

`circles`, `posts` and `stamps` map to strings the panel already speaks —
`searchNav.tsx#TypeIcon` has a case for each and `resolveRoute` documents all
three. `activities` and `vibes` have no icon case and no route rule, so they
fall to `TypeIcon`'s `default` (a neutral Sparkles). That is deliberate: a
generic icon is honest about an unrecognised row and a MapPin is not, and the
row only renders at all when the server supplied a real destination route.

### 29.3 What is asserted, and what is only disclosed

`offlinePolicy` moved from REPORTED to ASSERTED for every context — there was a
single authority answer to adopt. `entityTypes` did not: its **13**
disagreements run in both directions and each needs its own product judgement,
so it enters the suite as a **ceiling of 13**, newly disclosed. Nothing measured
it before; the parity suite covered `allowedSuggestionTypes` and `defaultMode`
and never the entity classes that decide which tables a suggestion request may
search. `minChars` remains reported and unasserted, unchanged.

No verdict moves in this section. **G340 stays `W`** — the vocabulary is now one
vocabulary and the endpoint exists, but the client still declares all 29
contexts locally and reads its own copy. The headline is unchanged at
**279 C / 49 W / 41 N / 4 X of 373**.

---

## §30 — G340 closes: the client reads the authority

§29 reconciled the vocabulary so a fetched policy could be *named*. This section
is the fetch, and the deletion it made possible.

### 30.1 The table is gone, not demoted

G340's criterion asked for the local registry to be "demoted to a cold-start
fallback". What landed is stronger: `INPUT_CONTEXT_REGISTRY`'s 29 hand-written
descriptors are **deleted**, and what remains is one policy that grants nothing.
A demoted table would still be a second source of truth — consulted whenever the
fetch was slow, and free to drift the moment someone edited it. A fallback that
cannot answer any question cannot drift.

`contexts/inputContexts.ts` went from 481 lines of policy to 140 lines of
resolution. `getContextDescriptor` and `resolveFieldPolicy` keep their
signatures, so no screen changed — which is what §28.3's scoping correction
predicted, and this is the measurement that confirms it: eleven files, thirty-five
references, no screen reading the registry directly.

### 30.2 Seven ways to have no policy, and all seven grant nothing

| situation | `reason` | what the field may do |
| --- | --- | --- |
| before the first fetch | `never_fetched` | nothing |
| snapshot older than 12h | `expired` | nothing |
| snapshot belongs to another account | `account_mismatch` | nothing |
| authority retired that version | `version_superseded` | nothing |
| authority did not send this context | `context_absent` | nothing |
| server unreachable, nothing held | (no install) | nothing |
| 200 whose body is not the contract | (no install) | nothing |

"Nothing" is `mode: 'no_assistance'`, an unreachable `minChars`,
`maxSuggestions: 0`, every capability flag false, `privacyClass:
'private_message'` — which makes the field **uncacheable**, since
`suggestionCache.ts` admits `public` and nothing else — and `offlinePolicy:
'unavailable'`.

**Expiry is the guard most easily argued away**, and the argument is backwards.
"The old policy is probably still right" is true of a policy that *loosens* and
false of one that **tightens** — a context reclassified `sensitive_location`,
personalization withdrawn — and a tightening is precisely what a long-lived
process must not miss. Expiry costs a refetch; missing a tightening costs the
thing the tightening was for.

### 30.3 A value this build cannot name

`sanitizeServedPolicy` narrows on the way in, so nothing unrecognised is ever
stored and a later read cannot be where a bad value is first noticed.

* An unknown **mode** collapses the **whole** policy, not just the mode. A mode
  decides whether the field is assisted at all, so an unreadable one means this
  build cannot know what was intended; keeping its `minChars`, `privacyClass`
  and `allowPersonalization` would be acting on half an instruction.
* Unknown members of a **list** are dropped; the list is never accepted whole.
* An unknown **privacyClass** becomes `private_message`; an unknown
  **offlinePolicy** becomes `unavailable`.
* A permission must be a **literal `true`**. `'true'`, `1` and `'yes'` do not
  grant — a permission stated in the wrong type is a sloppy serializer upstream,
  not consent.
* A missing or garbage **`minChars`** becomes unreachable, never `0`. Zero is
  the most permissive value in that field's range, which is what makes it the
  dangerous default.

### 30.4 §32 enforced where it is felt

§29 aligned the two `OfflineInputPolicy` unions, and said plainly that alignment
let the value *arrive* intact without changing what anyone sees. This is the
line that changes it: on an unreachable server, `useInputAssistance` now drops
its retained rows when the field's `offlinePolicy` is `server_required` or
`unavailable`.

It **narrows** §33's "network loss: RETAIN local/cached suggestions" rather than
contradicting it. §33 is the general rule; `offlinePolicy` is the authority's
per-field statement of which fields have an offline surface at all. For the nine
contexts marked `server_required` — `place_picker`, `event_location`, `address`
and the rest — retaining rows is not a smaller version of the feature, it is
assistance the authority declined to license, shown at the one moment nothing
can re-check it.

### 30.5 Two latent defects the entity widening exposed, and only one was visible

§29.2 recorded the first: a served `stamp` fell through `|| 'places'` and
rendered as a Place. Fixing the `Record<EntityType, string>` made it icon
correctly — **and that is not the same as working.**

`synthRoute` had no case for `circle`, `post` or `stamp` either. A suggestion of
those kinds with no server-supplied route returned `null`, and `tryEntityRow`
**dropped the row entirely**. Not mis-labelled: absent. `global_search` serves
all three today.

That is the harder failure, it was invisible from the type error, and a check
that the labels compile could never have found it. `entityRowCoverage.test.ts`
asserts on the produced **row** and its **route** instead, and reverting the
three `synthRoute` cases reddens it naming exactly `circle, post, stamp`.

`activity` and `vibe` stay unrouted **deliberately**: the app has no screen for
either, so a dropped row is correct and synthesising a path to a screen that
does not exist would trade an invisible row for a broken tap. A server-supplied
route is still honoured for them.

### 30.6 What the tests had to stop asserting

Thirteen client cases went red on the deletion, and every one of them was
asserting a per-context value — `city_picker`'s mode, `telegraph_recipient`'s
privacy class — against the local table. **Those assertions could not be
repaired, because the client no longer has an opinion to assert.** Restating the
server's values in a test file would have put a thirtieth copy of the policy in
the repository.

They were re-anchored instead, and the split is the honest one:

* **the client** proves it OBEYS — given the authority says X, the resolver
  produces X; given no authority, it grants nothing;
* **the server** proves the VALUES — `city_picker` really does permit what the
  G85 Destination row needs, and `display_name` really is manual. Those moved to
  `displayNameManual.test.ts`, where the real registry is.

`zeroStateAssistance` moved server-side for the same reason: it was the last
piece of per-context policy living only in the client, so deleting the table
would have deleted it.

### 30.7 Honest limits

* **Nothing here was exercised against a live deployment.** The endpoint is
  proven by tests on both sides and by a fake-transport client path; no request
  has crossed a real network, because both Supabase REST endpoints and
  `portava.replit.app` answer 403 to CONNECT at this environment's egress
  gateway. What is proven is the contract and every failure branch — not that a
  deployed server and a deployed app have shaken hands.
* **The 12-hour expiry is a judgement, not a measurement.** No data says 12
  hours is right.
* **No retry schedule.** A failed fetch is not retried until the next auth event
  or the next natural refresh. A device that is offline at launch stays
  unassisted until something else wakes the sync. That is safe and it is not
  finished.

### 30.8 G344 moves with it, and it is not double-counting

`G344` — *allow server-side policy updates without a client release where safe*
— has sat at `W` with a one-line reason: it was "defeated by the same client
mirror as G340". That was not a hedge; it was the literal blocker, and it is the
blocker §30.1 removed. The row's `WHAT WOULD TURN THIS RED` named exactly two
conditions, the endpoint and a demonstration, and both are now named by tests.

The obvious objection is that G340 and G344 are then the same row scored twice.
They are not, and the difference is worth stating because it is the difference
between a mechanism and a permission. **G340 is about versioning**: the registry
gets an identity independent of the app binary, which is why its evidence is
`policyVersion`, expiry and account isolation. **G344 is about what may be
changed through that mechanism**, and its load-bearing words are *where safe*. A
system could satisfy G340 completely and still fail G344 — by believing whatever
the authority sent. This one does not: `sanitizeServedPolicy` narrows an
unnameable member to the strictest member of its union, a permission grants only
on a literal `true`, and an unreadable `mode` discards the whole policy rather
than that member alone. The result is a deliberate asymmetry — a server edit can
tighten a shipped client without a release, and cannot loosen it past what that
build already knows how to refuse.

That asymmetry is the thing G344 asked for, it is tested, and it is why the row
moves on evidence of its own rather than on G340's coattails.

**G340 and G344 both move `W` → `C`.**

### 30.9 Headline, restated from the rows

§26.1 was the last headline stated in a form `check:census-integrity` can read,
and it predates both moves in this section. Restated here from the rows as they
now stand, in the same table form, because a headline the checker cannot parse
is a headline nobody is holding to the table.

**THE PROSE HEADLINES IN §28 AND §29 ARE SUPERSEDED, NOT WRONG.** Each says "the
headline is unchanged at **279 C / 49 W / 41 N / 4 X of 373**", which was true
when those sections were written and is the reason they are left standing — they
record what was believed at that point in the pass, and rewriting them would
erase the history this document exists to keep.

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **281** |
| BUILT-BUT-WRONG | **47** |
| NOT-BUILT | **41** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **328 / 373 = 87.9 %** |
| **CORRECT%** (raw) = C/373 | **281 / 373 = 75.3 %** |
| **THE GAP** = W/373 | **47 / 373 = 12.6 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

**AND THE COUNT IS NOW MACHINE-READABLE END TO END.** Before this section,
`check:census-integrity` reported "2 counted where this tool cannot read" for
this census. Those two were G340 and G344 themselves: both cells read
`**W** → **C**`, which is TWO verdict tokens where the checker parses one, so it
counted each as NEITHER — and the `281 C` quoted in the merge that closed them
was arithmetic laid on top of a tally the tool could not see. G343's row records
the identical defect from the §48 pass. Both cells now carry a single `**C**`
with the transition in the evidence, so the corpus reports **0 prose-counted
requirements across all 13 censuses**, the denominator is unchanged at 373, and
the rows and the headline agree.

---

## §31 — Migration 2950 is applied. The §57 blocker changes, and no verdict does.

**MEASURED 2026-09-21 against production `ajrurzioarfkagpuxfnb`, by object probe
rather than by a ledger row.** `public.input_assistance_telemetry_events` exists
and carries all nine of its constraints, including `iate_event_name_known`,
whose CHECK was read back from `pg_constraint` with all fourteen event names.
`public.schema_migration_ledger` also carries the row, applied 12:11:18 UTC.

**EVERY SENTENCE IN THIS DOCUMENT THAT SAYS 2950 IS UNAPPLIED IS NOW FALSE.**
They occur in the evidence cells of G292, G306, G365, G366, G367, G368, G369,
G371, G372 and G373, in phrasings including *"migration 2950 unapplied"*,
*"2950 is applied to no database"*, and — as a `TURNS GREEN WHEN` clause —
*"applying migration 2950 and reporting the number"*. They are corrected here in
one place rather than in ten cells, because rewriting ten evidence cells would
move every citation inside them and buy nothing: the correction is identical for
all ten and none of them changes a verdict.

### 31.1 What actually changed, and what did not

**NO VERDICT MOVES.** The headline stays **281 C / 47 W / 41 N / 4 X of 373**.

What moved is the BLOCKER, and it moved from a false one to a true one:

| | before | after |
|---|---|---|
| stated blocker | migration 2950 is unapplied | **2950 is applied; nothing writes to it** |
| what a reader should do | apply the migration | **deploy a build that emits, then measure** |

**THE TABLE HOLDS ZERO ROWS.** Measured the same day: `count(*) = 0`, no
earliest, no latest, zero distinct event names. So `report:input-metrics` no
longer exits with a PostgREST error — it now has a table to read and nothing in
it. That is a different failure and a more honest one.

**HALF OF G372's OWN RED-CRITERION IS NOW MET.** Its clause reads *"applying
migration 2950 and reporting the number."* The first half is done. The second
cannot be done from any tree: a §57 row asks for a NUMBER, and no traffic has
produced one. G372 stays `W` for precisely the reason §12.2 gave when the
integration owner declined a `C ☠prod` for G292 — *"a grader who reads `C` as
'works' should read it as `W`."* Applying a migration is not a measurement.

### 31.2 Why this correction is recorded rather than quietly applied

The stale claim did real damage before it was caught, and the mechanism is worth
keeping. Migration 2950's own file header read *"⚠ NOT APPLIED ANYWHERE YET"*
long after it was applied, and a later reader trusted it and reported production
as unmigrated across the whole 2890+ band. That report was wrong twice over:

* It queried `supabase_migrations.schema_migrations` (the Supabase CLI ledger)
  while attributing the result to `public.schema_migration_ledger`. The two
  tables have **disjoint columns** — the hand-rolled one has `filename` and no
  `version`; the CLI one has `version` and no `filename` — so a query written
  for one silently misbehaves against the other and still looks authoritative.
* It compared a TEXT `version` column holding **two formats at once**, bare
  serials (`'2272'`) and 14-digit timestamps (`'20260921101005'`). A 14-digit timestamp sorts
  **below** the four-digit cutoff — `'20260915123045' < '2890'` is TRUE, the
  third character deciding it (`'0'` against `'9'`) — so `>= '2890'` excludes
  every post-cutover row **no matter what is applied**, and `MAX(version)`
  returns a PRE-cutover serial. *(Ordering corrected 2026-09-22: this cell
  previously wrote `'289' < '20260915123045' < '2950'`, whose first half is
  false. The conclusion stands; the mechanism as stated did not.)*

**AND THE DEEPER RULE, which this census should apply to every `☠prod` claim it
carries: LEDGER ABSENCE IS NOT EVIDENCE OF NON-APPLICATION.** Probed the same
day, migrations 2890, 2900 and 2958 are all live in production with **no**
hand-ledger row; 2958 has no row in **either** ledger and its column exists.
Migration 2298 is this repository's precedent for the inverse — a ledger row
whose effects were absent. Only an object probe settles whether a migration ran,
and a `☠prod` annotation resting on a ledger count is resting on nothing.
**G340 and G344 both move `W` → `C`.** Headline: **281 C / 47 W / 41 N / 4 X of 373.**

---

## §32 — The offline substrate: the gate G340 built now opens onto something

G340 made `offlinePolicy` an **enforced** branch. When a suggest request comes
back `unavailable`, `hooks/useInputAssistance.ts` asks `offlineSurfaceAllowed`
whether the field has an offline surface at all, and for the nine
`server_required` contexts it drops the retained rows instead of showing them.
§30.4 argued that branch at length and it is right.

**Two of the three surfaces that gate licenses had nothing behind them.** The
census said so in several places at once and never in one sentence: G197 `N`
("the client ships none"), G198 `W` ("there is no local city index"), G212 `N`,
G350 `W` ("untestable because they do not exist"), G13 `W` ("no local dictionary
or city index ships, so `static_dictionary` still has nothing behind it"), and —
most precisely — `contexts/fieldInventory.ts:362`, which recorded in the code
itself that the country picker's policy is `static_dictionary` "and the client
ships no country list, so an offline country picker would return nothing — but
nothing can reach it to find out."

That is an **implementation** gap, not an operational one. Nothing had to be
deployed, applied or measured to close it; something had to be built.

### 32.1 What was built

**Four shipped artifacts** (`platform/input-assistance/data/`), each stating in
its own header exactly how it was bounded and what it omits:

* `countries.ts` — 250 entries, every currently-assigned ISO 3166-1 alpha-2
  code. **Display spelling is the app's, not CLDR's.** `user_stamps.country`
  holds "Czech Republic" and "Turkey"; an offline picker that inserted
  "Czechia" or "Türkiye" would fork the display spelling §10 says is never
  rewritten. The divergences were enumerated (the two Congos, the two SAR
  spellings, `&`/`and`, `St.`/`Saint`, Myanmar, Palestine) and each CLDR form
  survives as an alias that is matched on and never shown.
* `languages.ts` / `interests.ts` — the API server's own `COMMON_LANGUAGES` and
  `COMMON_INTERESTS`, 30 each. A **copy**, not an import, and the header says so
  rather than implying a derivation: `artifacts/api-server` is `"type":
  "module"` and this package is CJS, and the rule against a runtime import
  across that boundary is written at the top of `contexts/inputContexts.ts`.
* `cities.ts` — ~270 cities, **derived at module load** from
  `lib/cityCentroids.ts` (`CITY_CENTROIDS` plus its `CITY_ALIASES`) rather than
  pasted, so the two cannot drift. The bound is "the cities this product already
  names", which is not arbitrary — they are the cities Portava has content for —
  and is not a gazetteer, which would cost every user a multi-megabyte download
  and be wrong the day after it was generated. It deliberately does not read
  `REGION_CENTROIDS`: a continent is not a city, and an offline city picker
  offering "Asia" would be inventing a kind of answer the server never gives.

**One tier** (`services/localDictionary.ts`): retained rows first — they are
rows the *server* projected — then the field's licensed dictionaries, then the
raw query. Three gates, each fail-closed: the authority's own
`offlineSurfaceAllowed`, the §29 privacy predicate the cache and
`localZeroState` already share, and `allowedSuggestionTypes`.

**One store** (`services/localRecentsStore.ts` + `installLocalRecents.ts`): the
device-local recents §32 has asked for since Phase 1, behind a two-method port
so the pure modules stay importable from node:test, mounted at
`app/_layout.tsx:205`.

### 32.2 What a local row is not allowed to be

G13's rule is that offline must never present stale data as live. The strongest
form of it, and the one applied here, is that a local row must not present
itself as a **server** row at all. `source: 'local'`, and no `action`, no
`entityId`, no `destination`, no `canonicalUri`, no `structuredValue`, no
`freshness`, no `confidence`. It carries `replacementText` — the app's own
display spelling — and nothing else, because the client resolves nothing.

The same rule runs through the device store: a stored row carrying a
`freshness` is refused on restore, and `freshness` is dropped on the way out as
well, so a blob this build writes can never contain one.

And the tier is reachable **only** from the `unavailable` arm. A transient error
keeps what is on screen; an online serve is served alone; and the request still
goes out on every keystroke, because "the local answer is sufficient" is not a
judgement this client may make alone (G224's boundary, unmoved — see the G212
row for why that costs this pass a `C`).

### 32.3 Row moves

| id | from | to | why, in one line |
| --- | --- | --- | --- |
| G13 | W | **C** | All three of its own stated conditions: a consumer that branches offline (G340), a shipped artifact for `static_dictionary`, and a test that runs the hook with the network down and gets rows. |
| G197 | N | **C** | Countries, languages and interests all ship and all answer an offline field; the country list is pinned to cover every name the passport map can already place. |
| G198 | W | **C** | The compact city index exists, is derived rather than duplicated, and the cache under it is now persisted — the cell's two complaints. |
| G199 | W | **C** | Recents are device-local, survive a restart, are mounted at the app root, and are erased on an account change. ☠prod for the SERVER-side memory, which this row does not ask for. |
| G201 | N | W | The "cached recent places" half is real and tested; the Trip-scoped half has no substrate, and every dedicated place context is `server_required`. |
| G212 | N | W | One of its two conditions is met. The dictionary is consulted **instead of** the network, not **before** it — G224's boundary, kept deliberately. |
| G213 | W | **C** | The durable half the cell said was missing now exists (G199). ☠prod stays: `input_selection_history` is still absent from production, and that is the cross-device half, not the local one. |
| G350 | W | **C** | Four of four. The static dictionary and the offline raw-query fallback stopped being untestable by starting to exist. |

`G200` was re-measured and **left at `N`**, and `G241` had two now-false
sentences repaired without a move. Both cells say why in full.

**Headline: 287 C / 44 W / 38 N / 4 X of 373.**

### 32.4 Mutations

Twenty-one, each applied to a shipped module, run, watched and reverted; the
full logs with counts are at the bottom of
`services/__tests__/localDictionary.test.ts` and
`services/__tests__/localRecentsPersistence.test.ts`. The ones worth naming
here are the two that **did not** land.

**A gate that could not fail — AND THE PARAGRAPH THAT SAID SO IS WITHDRAWN.**
As written, this section reported that `localDictionaryFor`'s
`offlineSurfaceAllowed` call "is deleted", because `SURFACE_ENTITY_CLASSES` is
keyed only by the three licensed surfaces and deleting the `if` left all 26 pure
and all 76 component assertions green. **The gate was RESTORED in the merge that
integrated this lane (`e43fc628a`), and it is present at
`travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts:190`
and `:344` today.** The mutation was right that no test noticed and wrong that
nothing could: `SURFACE_ENTITY_CLASSES` is an object literal, so a bare `[key]`
lookup inherits from `Object.prototype` and answers TRUTHY for `constructor`,
`toString`, `__proto__` and `hasOwnProperty` — for which the guard clause is
skipped and `classes.has(...)` THROWS. `offlineSurfaceAllowed` is three `===`
comparisons and refuses all four. Seven cases hold it, including those four
inherited keys
(`travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts:426`).
The key-set assertion is kept as well; it is a second coupling, not a substitute
for the gate. **The general lesson, left where the next mutation pass will read
it: a mutation score proves only what its inputs enumerate, and this one
enumerated only values the type union can name — exactly the set that cannot
reach the defect.**

**A backstop, correctly.** Dropping the hook's own `mayRetain ?` gate also
leaves everything green, because `offlineLocalRows` re-applies the same licence.
That is the right shape for an authority gate and the wrong shape for a mutation
score, so the combined runs are logged instead of the fact being hidden: both
gates removed → 75/76; all three `server_required` defences removed → 74/76,
with both `server_required` component cases red. That last run is what makes
those two assertions non-vacuous.

### 32.5 Honest limits

* **Nothing here was exercised on a device.** Every assertion is a test. The
  AsyncStorage binding in particular is proven against an in-memory port and a
  jest mock; no blob has been written to a real phone.
* **`server_required` contexts degrade to nothing, not gracefully.** That is the
  authority's decision and G13 is `C` with it — but a user offline in a place
  picker still sees an empty panel, and calling that "graceful" is the
  authority's claim, not this section's. *(Answered by §33, 2026-09-22: the
  panel is no longer empty. The rows are still refused — that gate is
  untouched — and the absence now carries a sentence saying the field is
  assisted only online. "Degrades to nothing" remains true of the ROWS and is no
  longer true of the SURFACE.)*
* **The offline behaviour is still unmeasured.** G373 stands: the hook detects
  the degraded case and emits no event for it, so there is no denominator and
  nobody can say how often any of this helps.
* **Two assertions in other lanes' test files were RESTATED, not deleted.**
  "An unavailable endpoint yields an empty list" was true and was the census's
  complaint, not a property worth keeping. What they now prove is the part that
  mattered — that nothing is invented and no server row is conjured out of a
  cache that never held one. Both restatements carry the supersession in the
  case body, and both redden when the retained-rows-first rule is mutated away.
* **`head_commit` is NOT re-declared by this pass.** Counted files moved, so
  this census will read stale until a pass that owns the declaration
  re-declares it. Claiming the declaration while also grading my own work is
  exactly the thing §13 was written to stop doing quietly.

### 32.9 Headline, restated from the rows

§30.9 established that a headline this census states in prose is invisible to
`check:census-integrity` — it reads the last TABLE stating all four buckets.
§32's prose restatement is therefore not enough on its own, and leaving it at
that would have re-opened the exact defect §30.9 closed. Restated here in the
table form the checker reads, and independently recomputed by it rather than
carried over from the lane that moved the rows:

| Measure | Value |
| --- | --- |
| **Denominator — testable requirements** | **373** |
| BUILT-AND-CORRECT | **287** |
| BUILT-BUT-WRONG | **44** |
| NOT-BUILT | **38** |
| CANNOT-VERIFY | **4** |
| **CONSTRUCTED%** = (C+W)/373 | **331 / 373 = 88.7 %** |
| **CORRECT%** (raw) = C/373 | **287 / 373 = 76.9 %** |
| **THE GAP** = W/373 | **44 / 373 = 11.8 %** |
| CANNOT-VERIFY share | **4 / 373 = 1.1 %** |

**THE SPEC-ATTRIBUTABLE LINE IS ABSENT ON PURPOSE.** Every headline table before
this one carries a `CORRECT% (spec-attributable) = (C−23ᵖ)/373` row. It is
dropped here rather than carried forward, because the `ᵖ` count was derived over
a different population and nobody has re-derived it over these 373 rows. A
number copied from an older table into a newer one is the failure this section
exists to prevent, one field over. It returns when someone recounts it.

**TWO MOVES IN THIS PASS GO N → W, NOT N → C, AND THAT IS THE POINT.** G212 and
G201 each had a criterion with two clauses and each got one. Recording them as
`W` says something was built and does not yet do what the row asked; recording
them as `C` would have bought two numbers at the cost of the census meaning
anything. §32.3 states which clause is unmet for each.

---

## 33. The empty panel gets a sentence, and the degraded serve gets a producer

Two pieces of work on the same branch, and they are opposite in kind. The first
BUILDS the state §27 asks for and §32 implies. The second builds half of what
G373 asks for and stops, because the other half is one line in a file this lane
does not own — and says so rather than moving the row.

### 33.1 The defect: an enforcement with no surface

§30.4 recorded G340's §32 enforcement and was right about it: on an unreachable
authority, `hooks/useInputAssistance.ts:396#const mayRetain` drops every
retained row for the nine contexts the registry marks `server_required` and for
anything marked `unavailable`. **That gate is untouched by this section.** No
row it refuses is put back, no cache is re-read, and the `server_required` path
still renders zero suggestion rows — asserted in the same cases that assert the
sentence, so a later pass cannot "helpfully" restore the cache without reddening
them.

What the user got for it was a panel with nothing in it. And when the screen had
supplied an `emptyState` — §37's context-dependent fallback actions, *"Drop a
pin"*, *"Add a new Place"* — the degraded case rendered THOSE, because the old
container had one branch for both:

```
{emptyState ?? (
  <Text>{unavailable ? 'Suggestions are unavailable right now.' : 'No matches yet.'}</Text>
)}
```

So a field that was never asked, because the authority could not be reached,
reported that a search had found nothing and offered to create a record instead.
§37's own heading names TWO states — empty AND no-match — and §27 requires every
surface to support *"loading states, error states, empty states"*. There were
two shapes for three facts, and the caller's slot silently won the tie.

### 33.2 Three facts, three sentences

`travel-buddy-standalone/src/platform/input-assistance/components/degradedNotice.ts:124#export function degradedNotice`
is a pure function from (degraded?, licensed?, row count) to one of three
sentences, or `null` when the surface is not degraded at all:

| kind | when | what it says |
| --- | --- | --- |
| `unassisted` | the authority licenses NO offline surface (`server_required` / `unavailable`) | the field is assisted only online, nothing is suggested, and what you type is kept as typed |
| `empty` | licensed, and this device has nothing | you are offline and nothing is saved for this field yet |
| `rows` | licensed, and rows are showing | what is on screen is saved on this device and **has not been checked just now** |

Three properties are load-bearing and each is pinned by a case:

* **It renders no row and can render none.** It returns strings. The rows are
  decided by the hook's gate long before this runs.
* **`rowCount > 0` is tested BEFORE the licence**, so the copy can never
  contradict the screen — a miswired caller gets a sentence about the rows that
  are visible, not a claim that nothing is suggested.
* **It promises no retry.** §30.7 states there is no retry schedule in this
  layer, so *"we'll try again"* would be a false statement about the system.
  `degradedNotice.test.ts` asserts the online-only copy contains no
  retry/reconnect/refresh word.

The container renders it OUTSIDE the `emptyState` slot — above the rows when
there are rows, instead of the no-match state when there are none
(`travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx:321#ia-degraded-`).
`emptyState` still answers a genuine no-match, which is what that slot is for,
and a case asserts it still does. §46's live region leads with the degraded fact
and then the count; the old order announced *"2 suggestions"* for a device-local
list and never mentioned that it was one.

`SmartInput` supplies the licence as
`offlineSurfaceAllowed(policy?.offlinePolicy)` — the authority's value through
the same predicate the retention gate uses, re-derived rather than passed down.
The prop's default is `false`, the same fail-closed answer
`offlineSurfaceAllowed(null)` gives.

**`display_name` is unchanged and has a case saying so**: a `no_assistance`
field opens no overlay, so it gets no note either, issues no request, and offers
no entity suggestion. The new surface must not be the thing that finally gives a
manual field a panel.

Proven at
`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/degradedNotice.test.ts`
(7 pure cases),
`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/degradedSurface.component.test.tsx`
(6) and
`travel-buddy-standalone/src/platform/input-assistance/components/__tests__/degradedField.component.test.tsx`
(2, through a real `SmartInput` and a real policy).

### 33.3 G373, privacy-checked first, and built only as far as the rules allow

The rules were read before anything was written. Migration 2950 refuses thirteen
raw-text key names (`iate_props_no_raw_text`), admits exactly fourteen event
names (`iate_event_name_known`), and carries **no account id by design** — which
is the whole reason G371's metric is unanswerable from it and must stay that
way. G306's prohibition half is certified and none of it is weakened here.

What G373's own cell asked for: *"a degraded flag on
`suggestion_request_completed` (a bool, inside the existing name, so no
migration to 2950's event-name CHECK is needed) plus a prop-allow-list entry for
it — and then the offline BEHAVIOUR this would measure still has to exist
(G197–G201)."*

* **The behaviour now exists.** §32 shipped it (G197, G198, G199 all `C`).
* **The flag now exists.** The `unavailable` arm — until now the only arm of the
  request that emitted nothing at all — emits
  `suggestion_request_completed` with `{ count, degraded: true }`
  (`travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts:455#degraded: true`).
* **The allow-list entry does NOT exist, and this lane did not add it.**

**NO MIGRATION IS NEEDED AND NONE WAS WRITTEN.** `suggestion_request_completed`
is already one of 2950's fourteen names, and `degraded` is none of its thirteen
refused keys. The reserved band 2963–2969 was checked: 2963, 2964 and 2965 are
taken and nothing in it is required here.

**WHY THE EVENT CARRIES NO LATENCY, WHICH IS THE ONE DECISION WORTH ARGUING
WITH.** `lib/inputAssistance/metrics.ts:305` builds G372's P95 from EVERY
`suggestion_request_completed` carrying `clientMs`/`serverMs`. The ingest does
not yet name `degraded`, so a degraded row carrying a round trip would arrive
**indistinguishable from a successful serve** and drag the quantile toward the
instant local failures ("API not configured", "Not signed in") that never
touched a network. A latency that cannot be told apart is worse than no latency.
`count` is inert by comparison — no §57 metric reads it on this event name —
which is why it is safe to send now and is exactly the numerator the rate will
need. Adding `clientMs` to this payload reddens a case.

**INFERRING THE DEGRADED CASE FROM WHAT IS ALREADY LOGGED DOES NOT WORK**, which
is why a flag and not a query. A degraded serve looked exactly like an ABORTED
one and like an ABANDONED one: a `suggestion_request_started` with no completion
after it. Those three have nothing to do with each other.

Proven at
`travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.degradedTelemetry.component.test.tsx`
(6 cases), which asserts the shape as well as the fact: the event name is one of
2950's fourteen, the props are exactly `count` and `degraded`, none of the
thirteen refused keys appears, the typed text appears nowhere in the payload
under any key, and no account identifier is present.

### 33.4 The buffer that was NOT built, and why

The brief permitted a bounded offline buffer under hard conditions. **None was
built**, and the reasoning is recorded because "we chose not to" is worth more
than a silent absence:

* **A bounded buffer already exists.** `services/telemetryBatcher.ts` holds at
  most 200 events, evicts oldest-first and COUNTS what it drops. Events produced
  while the device is offline sit in it and go out on the next flush if
  connectivity returns within the app run.
* **A batch refused by an unreachable ingest is dropped and counted, never
  retried.** That is a deliberate property with eleven tests behind it (G306),
  and making it retry to serve a metric would be weakening it for the
  convenience of the thing it was protecting against.
* **A PERSISTENT buffer is new on-device behavioural storage**, and it would
  have to be account-keyed, expiring, erasable and wired into
  `services/policySync.ts#applyAccountChange` beside the policy snapshot, the
  suggestion cache and the device recents. That is real machinery, and the only
  thing it buys is the events of an app run that ENDED while offline.
* **It would be premature in the exact sense that matters.** Until the ingest
  names `degraded`, a persisted degraded event arrives indistinguishable from an
  online one. Storing behavioural records on a device so that they can be
  delivered in a form nobody can read is not a measurement; it is retention.

The consequence is stated rather than hidden: **with no persistence, the events
that reach the serve log are the reachable-network degradations** (a 404/503
from the suggest route, a malformed 200, an unconfigured API, a signed-out
client) **and those airplane-mode serves whose app run outlives the outage.** A
true offline session that ends offline contributes nothing. Any future
"offline completion rate" must carry that bias in its own caption.

### 33.5 Row moves

**NONE.** Both rows this work touches are already `C`, and the one it was aimed
at cannot move.

| id | verdict | what changed |
| --- | --- | --- |
| G13 | `C`, unchanged | One clause of the cell is WITHDRAWN: `server_required` contexts no longer degrade to an unexplained empty panel. The rows are still refused — that is the authority's decision and it is intact — and the absence now carries a sentence. The "never stale as live" half gains a surface-level statement to go with `source: 'local'`. |
| G350 | `C`, unchanged | Unaffected; the four arms it counts are the same four. |
| G373 | **`N`, and it stays `N`** | Its criterion has two halves and this lane can only reach one. The producer exists and is mutation-proven; `TELEMETRY_EVENT_PROPS.suggestion_request_completed` in `artifacts/api-server/src/lib/inputAssistance/telemetry.ts` still does not name `degraded: 'bool'`, so the ingest drops the flag and `metrics.ts` is still right to refuse the metric. **One line, in a file outside this lane's set.** |
| G306 / G355 / G371 | unchanged | Read as constraints, not as targets. Nothing here adds a key the ingest's allow-list would have to widen for, no account id, and no raw text. G371 in particular is left exactly as it is: the serve log's inability to identify a person is the property, not the bug. |

**The headline does not move: 287 C / 44 W / 38 N / 4 X of 373.**

### 33.6 Mutations

Every one applied to a shipped module, run, watched go red, reverted,
`cmp`-verified. Full logs at the bottom of the four test files. Twelve landed;
**three did not, and all three are recorded** —

* **`SmartInput`'s `policy.mode !== 'no_assistance'` gate cannot be reddened
  alone.** The authority gives `display_name` TWO independent refusals — mode
  AND `minChars: 99` — and no input this field can be given separates them,
  because no context in the registry pairs `no_assistance` with a reachable
  `minChars`. The inputs were checked before the code was judged. The gate is
  kept and the AUTHORITY'S VALUES are asserted directly instead.
* **The overlay's fail-closed `offlineSurface` default survived the first run**,
  because every case passed the prop explicitly. That was a gap in the inputs,
  not redundancy in the code: one case now omits the prop, and flipping the
  default to `true` reddens it.
* **Adding a retry promise to the `empty` copy does not redden anything**, and
  should not — the no-retry assertion is deliberately narrow to the online-only
  branch, which is the only one where the user can do nothing at all.

One defect this pass found in its own premise, rather than in the code: the
seed in the new field test originally omitted `mode` for `display_name`, and
`_seedPolicyForTests` spreads a PERMISSIVE default under every override — so the
field was seeded `search` and still rendered nothing, because `minChars: 99`
refuses first. A behavioural assertion could never have seen it. The seed now
states the authority's `no_assistance`, and the same omission is worth checking
wherever else that helper is used with a partial override.

### 33.7 What this section does NOT claim

* **Nothing here ran on a device or against a deployment.** Every assertion is a
  test; §30.7's limit is unchanged.
* **No number was measured.** The producer for an offline metric exists; no
  offline metric has been computed, and G373 is `N` for exactly that reason.
* **The copy has not been reviewed by anyone but its author.** The three
  sentences are constrained where the requirement constrains them — no retry
  promise, no claim of freshness, no "no matches" — and are otherwise a
  judgement.

---

## §33 — 2026-09-26: the one counted file that moved, and the sentence it made wrong

**Re-measured against the integrated tree, not acknowledged.** `check:census-freshness`
named exactly one counted file changed since `a97bfdac0` and not covered:
`artifacts/api-server/src/lib/circleResponseShaper.ts` (+157 / −8).

**NO VERDICT MOVES. One evidence sentence was wrong and is corrected.**

### §33.1 What changed in that file, and why it is not this census's work

The diff is the §52 presence-fusion rewiring from the Sensing lane. The module
used to decide, by itself, how revealing a circle member's row was allowed to
be; it now turns the row into a `PresenceClaim`, hands it to
`presenceFusion.admit`, and gates every label on the rung the store returns. The
arithmetic is unchanged. Nothing in it touches input assistance.

### §33.2 The only row it could bear on, re-read

**G136** — *Hidden Gem actions: drop pin, use approximate area, confirm
existing Gem, add new Gem* — is the one row in this census that mentions the
file, and it mentions it as an EXCLUSION: the `approximate_area` hits are the
Circles visibility mode, "a different feature that happens to share the phrase".

Re-read against the current tree, both halves of G136's W still hold, measured:

- `grep -rn approximate_area src/lib/inputAssistance/` → **no match**. There is
  still no producer for "use approximate area" on a Hidden Gem.
- No `add_new_gem` / `addNewGem` producer anywhere outside tests. The "add a new
  Gem" action is still absent.

So G136 stays **W**, two of four, and its RED WHEN is unchanged.

### §33.3 The correction: the row named two files and there are four

G136 says *"the `approximate_area` hits in the tree are `circleResponseShaper.ts`
and `locationPurposes.ts`"*. **That is now false.** The current set is four:

| File | What the occurrence is |
|---|---|
| `lib/circleResponseShaper.ts` | the visibility-mode → presence-rung table |
| `lib/locationPurposes.ts` | as before |
| `compass/CompassSocialEngine.ts` | `approximateArea` field, commented *"Approximate area ONLY (visibility mode approximate_area)"*, populated only when `mode === "approximate_area"` |
| `routes/circle.ts` | a zod `z.enum` of the Circles visibility modes, three times |

Both new sites were opened and read. Both are the **same Circles visibility
mode** the row already excluded — neither is a Hidden Gem producer — so the
exclusion's CONCLUSION is not merely intact, it is better supported than when
it was written. What was wrong was the enumeration, and an enumeration in a
census is a claim like any other: a reader checking G136 by grepping would have
found four hits where the row promised two and had no way to tell whether the
extra two were the counterexample.

The sentence is corrected in place rather than moved, per LAST-STATEMENT-WINS.

### §33.4 MOVES NOTHING

Verdict totals unchanged. This section exists because a file this census counts
changed, and the honest response to that is to re-read the row it touches and
say what was found — which here is one intact verdict and one stale sentence.
