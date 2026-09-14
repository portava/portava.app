# Compass — compliance against the owner's own specifications, v1

*Written 2026-09-14 in worktree `/home/user/wt-483` (detached at `7d1f2d498`). This document is
**spec-first**: it enumerates the requirements of the three documents the owner supplied, and only
then asks what the census says about each. It is not a restatement of `census-compass.md` and it
does not inherit that document's denominator.*

**The three authoritative specifications, and nothing else:**

| # | Document | What it contributes |
|---|---|---|
| S1 | `docs/specs/upgrades-v2/01-COMPASS-v2.md` | 12 acceptance rows (CPV2-01..12) **and** 24 prose obligations outside the table |
| S2 | `docs/compass/phase1-spec.md` | 22 clauses across §1–§7 and the Phase-4 appendix |
| S3 | `docs/compass/master-roadmap.md` | 6 global rules, 15 phase *Done-when* clauses, 9 guardrails, the standing evaluation set, and the sequencing rule in its preamble |

---

## 0. Headline — four buckets, with the denominator each is out of

> **74 distinct testable requirements · 43 SATISFIED · 26 PARTIAL/INCORRECT · 3 MISSING ·
> 2 CANNOT-VERIFY.**
> **SATISFIED = 43 / 74 = 58.1 %.** CONSTRUCTED (SATISFIED + PARTIAL) = 69 / 74 = 93.2 %.

| Bucket | Count | Denominator | Share |
|---|---|---|---|
| SATISFIED | 43 | 74 | 58.1 % |
| PARTIAL / INCORRECT | 26 | 74 | 35.1 % |
| MISSING | 3 | 74 | 4.1 % |
| CANNOT-VERIFY | 2 | 74 | 2.7 % |

Per source document, because one figure over three documents hides which one is being failed:

| Source | requirements | SATISFIED | PARTIAL | MISSING | CANNOT-VERIFY | SATISFIED % |
|---|---|---|---|---|---|---|
| S3 master roadmap | 30 | 21 | 8 | 1 | 0 | **70.0 %** |
| S2 phase-1 spec | 16 | 12 | 3 | 0 | 1 | **75.0 %** |
| S1 COMPASS v2 | 28 | 10 | 15 | 2 | 1 | **35.7 %** |

**The v2 upgrade specification is the document Compass satisfies least, by thirty-four points**, and
it is also the newest. Twelve of its twenty-eight requirements live in prose the census's denominator
never reached (§4) — twelve of the fifteen gaps in this document are its.

**Coverage of the census's denominator, stated as its own number: 15 of these 74 requirements — 20.3 % —
have no row in `census-compass.md`.** They are listed in full in §4. The census cannot have graded
what it never counted, and nothing here criticises it for a verdict it never made.

---

## 1. The enumeration rule, stated before the list so the list can be rejected

**A statement in one of the three documents is a REQUIREMENT if a reader can execute it against this
tree and get a yes or a no.** Applied literally:

1. **A *Done-when* clause is one requirement**, and the phase's descriptive paragraph above it
   supplies that requirement's criteria. Phase 11's "three presence levels" is not a separate
   requirement; it is a criterion of Phase 11's *Done-when*. This is the census's §13.1 parent rule,
   applied at enumeration time rather than after.
2. **A global rule is a requirement**, and **where one bullet enumerates several prohibitions with
   separate falsifiers, each prohibition is its own requirement.** The roadmap's *"Never put mock AI,
   fake live data, or template cards in production paths — fallbacks must honestly say a capability is
   unavailable"* (`docs/compass/master-roadmap.md:15#fallbacks must honestly say a capa`) is four requirements, because four different
   things can go wrong and three of them are separately testable.
3. **A guardrail is a requirement** — including the six that restate a global rule. They are
   enumerated, then marked as internal duplicates and counted once (§2.4). Silently dropping them
   would understate the enumeration; silently keeping them would inflate the denominator.
4. **A table row in S1's acceptance table is a requirement**, and its *Evidence required* column is
   that requirement's bar. The *Basis* column is provenance and is not an obligation.
5. **A prose sentence is a requirement when it states an obligation** — *must*, *do not*, *preserve*,
   *apply*, *run*, *reuse*, *never*. S1 carries twenty-four of these outside its table and they are
   enumerated with the same weight as the table rows.
6. **Headings, titles and table-of-contents lines are not clauses** and appear in neither count.

**What this produces: 96 enumerated clauses, 22 of them internal duplicates (the same obligation
stated twice within or across the three documents), leaving 74 distinct requirements.** Both numbers
are reported everywhere so a reader who rejects the de-duplication can work from 96.

### 1.1 Excluded prose — 13 statements, each named, so the exclusion can be disputed

An enumeration that quietly drops the awkward statements is the failure mode this section exists to
prevent, so every exclusion is listed with the reason it states no testable obligation **about this
tree**.

| # | Statement | Why it is not a requirement |
|---|---|---|
| X1 | `docs/compass/master-roadmap.md:3#> Source: owner-provided master ro` *"Source: owner-provided master roadmap (July 2026)."* | Provenance. |
| X2 | `docs/compass/phase1-spec.md:3#Scope: make Compass a real convers` *"Scope: … No new features beyond this. Do not touch translation, stamps, privacy guards, or the context engine's data sources except as specified."* | An obligation on **one diff**, not on a tree. The Phase-1 diff is not recoverable at this head, and asking "was anything else touched?" of a tree that has since had fourteen more phases built on it has no answer. |
| X3 | `docs/compass/phase1-spec.md:7#*Current:** stateless single-shot;` §1 **Current:**/**Target:** | Describes the pre-state. |
| X4 | `docs/compass/phase1-spec.md:19#*Current:** if/contains keyword ma` §2 **Current:**/**Target:** | Same. |
| X5 | `docs/compass/phase1-spec.md:34#*Current:** fixed food/nightlife/m` §4 **Current:**/**Target:** | Same. |
| X6 | `docs/compass/phase1-spec.md:15#- History compaction is out of sco` *"History compaction is out of scope for Phase 1"* | A scope exclusion; forbids nothing and requires nothing. |
| X7 | `docs/compass/phase1-spec.md:30#- Structured card responses may re` *"Structured card responses may remain non-streamed in Phase 1"* | A permission. Nothing falsifies it. |
| X8 | `docs/compass/phase1-spec.md:52## Explicitly out of scope for Phas` *"Explicitly out of scope for Phase 1 … Do not start these."* | **Superseded by the owner.** Every capability it names — tools, memory, Home, proactive alerts, live data, social intelligence, permissions — is a roadmap phase the same owner subsequently ordered built. Grading it would score Compass down for obeying the newer instruction. |
| X9 | `docs/compass/phase1-spec.md:59#So Phase 1 data structures don't b` *"Do NOT implement in Phase 1"* (appendix timing) | Same supersession; the appendix's tool list itself IS counted, as P1-20. |
| X10 | `docs/specs/upgrades-v2/01-COMPASS-v2.md:3#Extend the existing conversational` *"Read 00-START-HERE.md and the complete bundled COMPASS and C1 baselines."* | An instruction to the reader, not a property of the system. |
| X11 | `docs/specs/upgrades-v2/01-COMPASS-v2.md:3#Extend the existing conversational` *"This is an additive specification, not a replacement implementation."* | Framing; its operative content is CPV2-01 and the "existing foundation" clauses, which are counted. |
| X12 | `docs/specs/upgrades-v2/01-COMPASS-v2.md:9#An older inspected checkout contai` *"An older inspected checkout contains CompassConversationService … These are navigation hints, not evidence of the current head. Locate their current owners before editing."* | A process instruction to an implementer. No state of the tree satisfies or violates it. |
| X13 | `docs/specs/upgrades-v2/01-COMPASS-v2.md:23#CPV2-01` the table's **Basis** column (12 cells) | Provenance per row. |

**96 counted + 13 excluded = 109 statements examined.** No statement in the three documents is
absent from one of the two lists.

### 1.2 What each grade means here

| Grade | Bar |
|---|---|
| **SATISFIED** | Built, reachable, and something fails if it breaks. A `file:line#needle` for the behaviour **and** the test that pins it. `⌀` marks a *vacuous* satisfaction — nothing exists that could violate the rule — which is honest but is not the same as a guard. |
| **PARTIAL / INCORRECT** | Built and wrong, or half-built. The row says **which half**. A requirement whose only carrier is inert on every deployment is PARTIAL, never SATISFIED — built on a branch is not merged, merged is not deployed, deployed is not flag-enabled. |
| **MISSING** | Not built. |
| **CANNOT-VERIFY** | Named evidence, named supplier. "Needs more work" is not a reason; "the owner's approved value, which exists outside this repository" is. |

---

## 2. The clause list

Columns: **id** · the clause with its anchor · the census row that carries it (or **GAP**) ·
grade · evidence. `†` marks a row this pass re-executed against the tree rather than carried from
the census; unmarked mapped rows are **carried, not re-verified** — 47 of the 59 mapped
requirements, and saying so is part of the measurement.

### 2.1 S3 — master roadmap: preamble, global rules, phases, evaluation set, guardrails

| id | Clause | Census row | Grade | Evidence |
|---|---|---|---|---|
| RM-01 | `docs/compass/master-roadmap.md:5#> the previous phase's "Done when"` a phase may not start until the previous phase's *Done-when* is fully met and its tests pass | **GAP** | **PARTIAL** † | Phase 1 was never certified by this programme's own gate: `docs/compass/phase-summaries.md:8## Phase 1 — Conversational Foundat` records it *"(as found, July 2026)"* — inherited, not verified — and the first end-to-end measurement of it is dated after Phase 15 shipped (`docs/compass/phase-summaries.md:741## Live answer-quality eval — 2026-`). Phases 3–15 were therefore built over an ungated Phase 1, which `CPH-01` still grades `W`. The rule was honoured **once**, visibly: the Phase-3 pre-flight note at `docs/compass/phase-summaries.md:30#guard GPS stripping), plus feed/ca`. One instance of a gate is not a gate. |
| RM-04 | `:12-14` preserve Trips, Passport, Circles, Telegraph, Discovery, privacy guards | `CR-01` | SATISFIED | Seven registered suites green; see `CR-01`. |
| RM-05 | `:15` no mock AI in production paths | `CGR-01` | SATISFIED | No mock-model path exists; flag-off returns no content. |
| RM-06 | `:15` no fake live data | `CX-04` | PARTIAL † | The output boundary exists (`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:402#if (!evidence.hasVerifiedLive && N`) but is turn-scoped, not claim-scoped — see CCL-12. |
| RM-07 | `:15` no template cards in production paths | `CGR-03` | SATISFIED | Degraded feed is assembled from the user's own rows, not authored copy. |
| RM-08 | `:16-17` fallbacks must honestly say a capability is unavailable | `CR-02` | SATISFIED | `HONEST_FALLBACK_MESSAGE` on all four error paths; pinned by `artifacts/api-server/src/test/compass-ask.test.ts:428#it("returns 'temporarily unavailab`. |
| RM-09 | `:17-18` money · booking · messaging · location-sharing: server-authorized **and** explicitly confirmed | `CR-03` | SATISFIED ⌀ † | Re-executed against the 25 declared tools (`artifacts/api-server/src/compass/CompassTools.ts:144#name: "get_user_profile",` … `artifacts/api-server/src/compass/CompassTools.ts:497#name: "get_group_recommendation",`): none spends, books, sends a message or shares a location. The one consequential tool proposes (`add_to_trip`, `CC-06`). **Vacuous, and the vacuity is the finding** — there is no guard to break because there is nothing to guard. |
| RM-10 | `:19-20` all private context through coordinate stripping and block/mute filtering | `CR-04` (+`CC-04`, `CTG-02`, `CP-03`) | SATISFIED | Thirteen prompt producers audited by `CR-04`. |
| RM-11 | `:21-22` all UGC wrapped as data-not-instructions | `CR-05` | SATISFIED | `wrapUgc` across every producer that can carry user text. |
| RM-12 | `:23-24` after each phase: full suite · the phase's tests · a summary | `CR-06` | SATISFIED | `docs/compass/phase-summaries.md` carries every phase but the owner-reserved Phase 2. |
| RM-13 | Phase 1 *Done-when* `:30-31` | `CPH-01` | PARTIAL | *Tests pass* ✓; *works end to end* ✗ — the only real-model measurement on record returned no text for 7 of 9 standing queries. |
| RM-14 | Phase 2 *Done-when* `:33-34` install the owner's finalized prompt verbatim | `CPH-02` | MISSING † | Owner-reserved and **unbuildable by any lane**: the source document is not in this repository. What ships is engineering-authored (`artifacts/api-server/src/lib/prompts/compass-v1.ts:21#export const COMPASS_ASK_PROMPT_VE` — `"compass-v2"`). |
| RM-15 | Phase 3 *Done-when* `:41-42` | `CPH-03` | SATISFIED | Group, reservations, travel history all assembled. |
| RM-16 | Phase 4 *Done-when* `:53-55` | `CPH-04` | SATISFIED | Eight named tools declared and dispatched; results privacy-guarded at one exit. |
| RM-17 | Phase 5 *Done-when* `:61-62` | `CPH-05` | SATISFIED | Block type synthesised server-side when the model declares none. |
| RM-18 | Phase 6 *Done-when* `:71-73` | `CPH-06` | SATISFIED | Four memory layers; group memory bounded to the circle. |
| RM-19 | Phase 7 *Done-when* `:81-83` | `CPH-07` | SATISFIED | Compass Match defined popularity-independently. |
| RM-20 | Phase 8 *Done-when* `:91-93` | `CPH-08` | PARTIAL | Confidence labelling ✓; live fetch fails on three of the five named sources. |
| RM-21 | Phase 9 *Done-when* `:101-103` | `CPH-09` | SATISFIED | Group recommendation aggregates most-restrictive constraints. |
| RM-22 | Phase 10 *Done-when* `:110-111` | `CPH-10` | SATISFIED | Traveller-local hour resolved before the cache. |
| RM-23 | Phase 11 *Done-when* `:118-119` | `CPH-11` | SATISFIED | Mid-run permission re-read; pinned by `artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts:301#describe("B. CPH-11 / CPV2-06 — a`. |
| RM-24 | Phase 12 *Done-when* `:125-126` | `CPH-12` | SATISFIED | Delivery-time session re-read; pinned at `artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts:219#describe("A. CPH-12 / CPV2-07 — a`. |
| RM-25 | Phase 13 *Done-when* `:134-136` | `CPH-13` | SATISFIED | Partial re-plan and conflict detection pinned by `compass-autopilot.test.ts`. |
| RM-26 | Phase 14 *Done-when* `:143-144` | `CPH-14` | PARTIAL | The nine-stage chain is not tracked end to end. |
| RM-27 | Phase 15 *Done-when* `:151-153` | `CPH-15` | PARTIAL | Three of four criteria; see also CPV2-12. |
| RM-28 | `:155-157` run the nine queries against every phase from Phase 1 on | `CPH-EVAL` | PARTIAL | The nine questions exist verbatim; the run is one, on 2026-07-21, against `compass-v1.1` while the shipped prompt is `compass-v2` (`artifacts/api-server/src/lib/prompts/compass-v1.ts:21#export const COMPASS_ASK_PROMPT_VE`). |
| RM-29 | `:169-171` measure the eight named dimensions each time | `CPH-EVAL` | PARTIAL | Twelve measures are declared and separated; Tier B stays `unjudged` until a reader supplies a verdict. |
| RM-33 | `:178` no precise-location inference | `CGR-04` | SATISFIED | Approximate area only, server and model input. |
| RM-37 | `:182` keep basic Compass useful without premium | `CGR-08` | SATISFIED ⌀ | No entitlement gate exists on any Compass path. |
| RM-38 | `:183` don't lock essential safety features behind progression | `CGR-09` | SATISFIED ⌀ | No progression gate; both safety stages run unconditionally. |

**Internal duplicates enumerated and then deduplicated (8):** RM-02 `:6-7` (Phase 2 owner-reserved
≡ RM-14) · RM-03 `:8` (running summary ≡ RM-12) · RM-30 `:175` ≡ RM-05 · RM-31 `:176` ≡ RM-06 ·
RM-32 `:177` ≡ RM-07 · RM-34 `:179` ≡ RM-10 · RM-35 `:180` ≡ RM-09 · RM-36 `:181` ≡ RM-11.

### 2.2 S2 — phase-1 technical spec

| id | Clause | Census row | Grade | Evidence |
|---|---|---|---|---|
| P1-01 | `docs/compass/phase1-spec.md:10#- Add a` the two tables with the stated columns | `C1-01` | PARTIAL | `trip_id`/`status` absent; `role` CHECK makes `system-event` impossible. The census found this and it holds. |
| P1-02 | `:11` last N turns, N=20, ~4k-token history cap, real `messages[]` | `C1-01` | PARTIAL † | N=20 ✓ (`artifacts/api-server/src/services/compass/CompassConversationService.ts:18#const MAX_HISTORY_MESSAGES = 20;`); the cap is `24_000` chars ≈ **6 000** tokens (`artifacts/api-server/src/services/compass/CompassConversationService.ts:19#const TOKEN_BUDGET_CHARS   = 24_00`) against the spec's ~4k — 50 % over. |
| P1-03 | `:12` persist both messages, including structured card payloads | `C1-01` | SATISFIED | Round-trip pinned at `artifacts/api-server/src/test/compass-ask.test.ts:215#it("returns a conversationId when`. |
| P1-04 | `:13` `conversationContext` accepted but ignored once `conversation_id` is sent | `C1-01` | SATISFIED | Survives only as a schema line; no reader. |
| P1-05 | `:14` new conversation when `conversation_id` is omitted or last activity > 6 h **(configurable)** | `C1-01` | PARTIAL † | The 6 h rule is built and correct (`artifacts/api-server/src/services/compass/CompassConversationService.ts:17#export const INACTIVITY_THRESHOLD_`) — and it is a **compile-time constant**, read from no environment variable, flag or settings row, so the parenthesis the clause closes with is unmet. The census counted this criterion as passing; the row is already `W` for other reasons, so this adds a criterion rather than moving a verdict. |
| P1-06 | `:22` one cheap classifier call, temp 0, strict JSON, input = last user message **+ last 2 turns** | `C1-02` | SATISFIED † | Closed by §13.8: the last two turns are passed at `artifacts/api-server/src/routes/compass.ts:1445#history.slice(-CLASSIFIER_CONTEXT_`, bound declared at `artifacts/api-server/src/services/compass/CompassIntentClassifier.ts:54#message is being asked to route a`. |
| P1-07 | `:23` below confidence 0.6 → plain conversation, never a card pipeline | `C1-02` | SATISFIED | `isItineraryIntent` requires ≥ 0.6. |
| P1-08 | `:24` keep the two existing pipelines as-is downstream; only the router changes | **GAP** | SATISFIED † | Both survive and the router is the only thing that chose between them: the itinerary branch is taken on `isItineraryIntent` alone (`artifacts/api-server/src/routes/compass.ts:1449#intentResult !== null &&`) and everything else falls through to the conversation/tool loop, as the block comment at `artifacts/api-server/src/routes/compass.ts:1431#Promoted out of shadow mode: "itin` states. |
| P1-09 | `:25` delete the keyword router **once the classifier is verified against it** — shadow-run, disagreements logged | **GAP** | **CANNOT-VERIFY** † | The deletion happened (`C1-02`). Whether the verification preceded it cannot be read off this tree: no disagreement log, no shadow comparator and no keyword router remain. **The classifier's own header still claims the opposite** — *"Phase-1 shadow mode: runs alongside the legacy keyword router"* and *"Disagreements are logged by the caller"* (`artifacts/api-server/src/services/compass/CompassIntentClassifier.ts:8#Phase-1 shadow mode: runs alongsid`, `artifacts/api-server/src/services/compass/CompassIntentClassifier.ts:9#Disagreements are logged by the ca`) — while the caller records the promotion *"out of shadow mode"* (`artifacts/api-server/src/routes/compass.ts:1431#Promoted out of shadow mode: "itin`). **What would settle it:** the shadow-period disagreement logs or the PR that removed the router. **Who can supply it:** the owner or whoever holds this service's log retention — not a lane reading the tree. |
| P1-10 | `:29` stream text deltas via SSE | `C1-03` | SATISFIED | Headers, per-token writes and a `done` event. |
| P1-11 | `:35` the model proposes 2–4 quick actions alongside its reply | `C1-04` | SATISFIED † | Asked for at `artifacts/api-server/src/lib/prompts/compass-v1.ts:68#quickActions — propose 2–4 buttons` and capped server-side at four (`artifacts/api-server/src/routes/compass.ts:1110#.slice(0, 4)`). **The floor of two is deliberately not enforced** and should not be: the only way a server could guarantee two is to invent one, which guardrail `docs/compass/master-roadmap.md:177#- No template cards replacing real` forbids. The prompt says so in the clause's own terms — *"0 is fine if none fit"*. |
| P1-12 | `:35` server-validated against a whitelist; no new client capabilities | `C1-04` | SATISFIED † | Twelve allowed types (`artifacts/api-server/src/routes/compass.ts:1048#const ALLOWED_QUICK_ACTION_TYPES =`); anything else is filtered out before the reply is assembled. |
| P1-14 | `:39` versioned prompt file · version logged per request | `C1-05` | SATISFIED | `COMPASS_ASK_PROMPT_VERSION` with a stated bump rule, logged and returned. |
| P1-17 | `:48` the existing suite stays green | `C1-07` | SATISFIED | 163 registered tests green in `CR-01`'s measurement. |
| P1-18 | `:49` four named new tests | `C1-07` | SATISFIED | All four exist and are registered. |
| P1-19 | `:50` manual eval script with the four-turn sequence; the last must fail gracefully | `C1-07` | SATISFIED | The graceful-failure turn is pinned by `artifacts/api-server/src/test/compass-ask.test.ts` block D. |

**Internal duplicates (6):** P1-13 `:39` install the provided identity prompt ≡ RM-14 · P1-15 `:40`
UGC delimiters ≡ RM-11 · P1-16 `:44` honest fallback copy, no template cards in the error path ≡
RM-08 + RM-07 · P1-20 `:61-68` the eight reserved tool signatures ≡ RM-16 · P1-21 `:70` every tool
result through the privacy guards ≡ RM-10 · P1-22 `:70` `structured_payload` carries tool
calls/results ≡ RM-16.

### 2.3 S1 — COMPASS v2 upgrade: the table, and the twenty-four prose obligations around it

| id | Clause | Census row | Grade | Evidence |
|---|---|---|---|---|
| V2-03 | `docs/specs/upgrades-v2/01-COMPASS-v2.md:7#Preserve all fifteen roadmap phase` do not reinstall the system prompt or rebuild conversation storage to add sensing | **GAP** | SATISFIED † | One conversation store, one owner: `compass_conversations` / `compass_conversation_messages` are written only through `artifacts/api-server/src/services/compass/CompassConversationService.ts:96#.from("compass_conversation_messag`, and the prompt is one versioned module (`artifacts/api-server/src/lib/prompts/compass-v1.ts:21#export const COMPASS_ASK_PROMPT_VE`) whose bumps are Compass-identity changes, not sensing installs. No second conversation table, no second prompt source. |
| V2-05 | `:13` the processing chain: authorized request → **existing** context assembly → shared world/experience/forecast/opportunity projections → **existing** decision/ranking owner → grounded explanation → **existing** UI/action contract | **GAP** (adjacent: `CX-10`, `CX-11`) | **PARTIAL** † | Every stage exists as an object and the chain does not. The shared kernel and the opportunity engine are real platform modules (graded in §5 rather than cited here, because they are outside this census's watched scope), and **`POST /compass/ask` reaches neither**: its context block is assembled by thirteen local producers and its ranking is `CompassPipeline`. `CX-10` says the kernel is Compass-local and consumed by no other surface; `CX-11` says each Compass surface builds candidates directly. The clause's *topology* — one shared projection layer between context and ranking — is the half that is missing, and it is missing on every deployment. |
| V2-07 | `:15` **Compass consumes** the current-context projection and other authorized context to explain what to do | **GAP** | **MISSING** † | `/compass/ask` imports exactly one thing from Home, a time-of-day helper: `artifacts/api-server/src/routes/compass.ts:57#import { timeOfDayForHour } from "`. The projection Home builds is not read by the answer path; Compass rebuilds equivalent context itself. Home's half of the clause is `CX-06` and is met. |
| V2-09 | `:15`, `:46` neither Sense nor Live becomes a second sensing ingest route; the authentication posture stays Sensing's | **GAP** | SATISFIED † | Executed, not assumed. No Compass route ingests: `grep` for writes across `artifacts/api-server/src/compass/` returns only `compass_*` and `trip_*` tables, and no module in `compass/` or `routes/compass*.ts` touches a claim, observation or snapshot table. Live intelligence enters through the one read seam in three places and no others — `artifacts/api-server/src/compass/CompassMediaContext.ts:58#import { readLiveClaimEnvelopes }`, `artifacts/api-server/src/compass/CompassLiveConstraints.ts:67#} from "../lib/liveClaimRead.js";`, `artifacts/api-server/src/routes/compassDecision.ts:31#import { liveLabelsServable, readL`. |
| V2-10 | `:17` the decision result carries subject references · action class · evidence references · truth metadata · validity · reasons · constraints · **any confirmation requirement** | **GAP** | **PARTIAL** † | Seven of eight, and the eighth is absent by construction. Present: action class and reasons (`artifacts/api-server/src/lib/compassDecision.ts:188#export interface CompassDecisionRe`), truth metadata (`grounding`), evidence references (`claimRefs`), validity (`horizonAt`), constraints (`switchingCost`, `interception`), subject reference — echoed by the route rather than the engine (`artifacts/api-server/src/routes/compassDecision.ts:132#subjectId: q.subjectId,`). **Absent: any confirmation requirement** — `CompassDecisionResult` has no field for one, so a decision whose action needed confirmation could not say so. Today nothing it emits executes anything, which makes the omission harmless and not yet wrong; it becomes wrong the first time a decision is wired to an action. And the whole surface is inert: `artifacts/api-server/src/routes/compassDecision.ts:78#if (!(await isFlagEnabled(sc, "com` gates it on a flag seeded FALSE. |
| V2-11 | `:17` the action vocabulary is GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | `CX-03` | PARTIAL † | All seven exist verbatim (`artifacts/api-server/src/lib/compassDecision.ts:81#export const COMPASS_DECISIONS = [`) and are served by one route that is flag-off everywhere. |
| V2-12 | `:17` map it to the existing action model with compatibility handling; **do not blindly add enum values** | **GAP** | **PARTIAL** † | The "don't blindly add" half is honoured — the existing conversational action model is untouched at twelve types (`artifacts/api-server/src/routes/compass.ts:1048#const ALLOWED_QUICK_ACTION_TYPES =`) and the seven decisions are a separate vocabulary. A mapping with compatibility handling exists, but onto the opportunity vocabulary rather than Compass's action contract, and three of the seven decisions map to nothing and become refusals carrying the decision (graded in §5). **No decision reaches `/compass/ask`'s action contract at all**, so the clause's "existing action model" is precisely the one not mapped. |
| V2-13 | CPV2-01 `:23` reuse existing conversation, intent, memory, tool and streaming owners | `CX-09` | SATISFIED | The four journeys each have a registered test; verified by §13.4 against CPV2-01's own bar. **Mapping checked against the spec text and it holds**, with one caveat recorded in §6. |
| V2-14 | CPV2-02 `:24` ground answers in shared structured evidence; never upgrade inference into fact | `CX-04` | PARTIAL † | Mapping correct. The bar — *predicted, inferred, conflicting, stale and unknown fixtures retain their qualification in tool output, UI **and generated explanation*** — is met on the input side and turn-scoped on the output side (CCL-12). |
| V2-15 | CPV2-03 `:25` safety · feasible time · travel friction · user/crew constraints before opportunity advice | `CPV2-03` | PARTIAL | Safety ungated ✓; the other three reachable on no deployment. |
| V2-16 | CPV2-04 `:26` current Experience value and switching cost | `CX-05` | PARTIAL | The substance is exactly the clause (`artifacts/api-server/src/lib/compassDecision.ts:92#export const SWITCHING_COST = 0.25`) and it is behind a FALSE-seeded flag. |
| V2-17 | CPV2-05 `:27` Home uses a server-built current-context projection | `CX-06` | SATISFIED † | Mapping checked: the clause's object is the projection, which is `CX-06`'s, not `CPH-10`'s. Per-section availability at `artifacts/api-server/src/routes/compassHome.ts:172#export type SectionAvailability =` and `artifacts/api-server/src/routes/compassHome.ts:439#bestNextMove:   bestNextMove.ok`, pinned by `artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts:419#describe("C. CX-06 / CPV2-05 — Hom`. |
| V2-18 | CPV2-06 `:28` Sense routes changes through the attention policy and user-controlled presence | `CPH-11` (+`CX-08`) | SATISFIED | Presence, per-category permission, dedupe and cap all present and re-read mid-run. **`CX-08` stays `N`** — Sensing's named Attention Engine (relevance, novelty, half-life, interruption cost, budget) is a different obligation from a different spec and is not claimed here. |
| V2-19 | CPV2-07 `:29` Live start/stop/revocation control ongoing context and queued attention | `CPH-12` | SATISFIED | Stop during an in-flight read prevents later disclosure. |
| V2-20 | CPV2-08 `:30` propose Trip changes through the canonical Trip command path | `CT-01` (+`CC-18`) | PARTIAL † | Mapping checked and the census's reading of it holds: execution-time re-check ✓ (`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:651#Re-verify at confirm time: permiss`), fixed items refused ✓, duplicate execution idempotent ✓ (`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:696#idempotencyKey:`). `CT-01` stays `W` on its own residual — Compass still writes canonical trip tables from engine sites the kernel does not own. |
| V2-21 | CPV2-09 `:31` preserve confirmation for money, bookings, messages, location sharing | `CR-03` | SATISFIED ⌀ | Same four classes as RM-09, same vacuity. |
| V2-22 | CPV2-10 `:32` keep private/group context and anonymous intelligence separate | `CR-04`,`CR-05`,`CTG-02`,`CPH-06`,`CX-13` | SATISFIED | Every clause has a carrier, including contributor identifiers. One reason-drift recorded in §6. |
| V2-23 | CPV2-11 `:33` learn from permitted actual outcomes · idempotent · **revocation follows lineage** | `CPV2-11` | MISSING | No foreign key, no revocation path; account deletion is not revocation. |
| V2-24 | CPV2-12 `:34` shared city/time confidence and graph context without duplicating truth | `CPV2-12` | PARTIAL | Degrades honestly ✓; duplicates the platform's coverage store ✗. |
| V2-26 | `:38` a world-intelligence failure must not disable ordinary grounded conversation | `CX-09` | SATISFIED | The live seam is fail-closed and the stage is gated; a failure returns `[]`, not an error. |
| V2-27 | `:38` distinguish authorized empty results from dependency failure internally, and give an honest user-facing limitation | **GAP** | SATISFIED † | Both halves are built and one is pinned. Home reports per-section availability and refuses to cache a degraded payload (`artifacts/api-server/src/routes/compassHome.ts:172#export type SectionAvailability =`), and the distinction is asserted — with a control for the empty-but-healthy case — at `artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts:419#describe("C. CX-06 / CPV2-05 — Hom`. The tool surface carries the same distinction into the model's context as an `info` string per tool, separating outage from flag-off from empty: `artifacts/api-server/src/compass/CompassTools.ts:827#if (error) return { candidates: []`. |
| V2-28 | `:38` do not fabricate a fallback candidate, open status, travel duration, safety verdict, or current crowd | **GAP** | **PARTIAL** † | Five named classes, graded one at a time. **Fallback candidate** ✓ — the degraded feed is the user's own rows (`artifacts/api-server/src/compass/CompassFallbackFeedBuilder.ts:2#CompassFallbackFeedBuilder — Phase`). **Open status** ✓ narrowly and **current crowd** ✓ — both policed at the output boundary, but only when the sentence carries an explicit now-marker (`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:402#if (!evidence.hasVerifiedLive && N`). **Safety verdict** ✓⌀ — no tool produces one. **Travel duration ✗ — there is no trigger for it at all**: the only numeric claim the boundary reads is a wait/queue figure (`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:286#const WAIT_CLAIM =`), so an unhedged *"it's a ten-minute walk"* with no route datum in the turn is published unqualified. That is one of the five classes the clause names, and it is the one with no owner. |
| V2-29 | `:40` **attach evidence to the particular claim it supports**; do not attach a general valid citation to unsupported generated prose | **GAP** | **PARTIAL** † | This is the sharpest gap in the document, because the module that exists is *shaped* like the requirement and stops one level short. The evidence band is computed over the **whole turn** — `artifacts/api-server/src/routes/compass.ts:1357#readGroundingEvidence(toolLog.map(` pools every tool result — and reduced to four turn-level booleans (`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:80#export interface GroundingEvidence`). So a `verified_live` datum about place A licenses an unhedged live sentence about place B in the same answer: a general valid citation covering unsupported prose, which is what this clause forbids in as many words. Nothing is bound to a subject. **What would close it:** carry the subject id alongside each datum and match it against the subject named in the sentence. |
| V2-30 | `:40` revalidate expiring evidence when an action is taken, rather than treating conversational history as current authority | **GAP** | **PARTIAL** † | The *trip-state* half is exactly right and is the tree's best instance of the pattern: at confirm the engine re-reads settings and plan items and re-checks lock type before executing (`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:651#Re-verify at confirm time: permiss`). The *expiring-evidence* half is absent: the live datum that motivated a proposal — hours, weather, conditions — is not re-read at confirm, so a proposal confirmed hours later executes against evidence nobody revalidated. `CC-18` grades the first half and no row states the second. |
| V2-32 | `:42` record factual grounding, permission compliance, action correctness, continuity and live-provider limitations **separately** | `CPH-EVAL` | PARTIAL | Twelve measures declared and structurally separated; no run has produced verdicts for the adjudicated tier. |
| V2-33 | `:42` real model/provider behaviour needs a configured integration evaluation before that part is declared complete | `CPH-01` | PARTIAL | The one integration run on record failed 7 of 9 questions and predates the current prompt version. The requirement is honoured in the negative — nothing declares it complete — and unmet in the positive. |
| V2-35 | `:46` reuse **approved** attention budgets, switching policy, confidence/freshness rules and permission scopes | **GAP** | **CANNOT-VERIFY** † | The tree carries values (`artifacts/api-server/src/compass/CompassSenseEngine.ts:80#export const AWARE_DAILY_CAP = 3;`, `artifacts/api-server/src/compass/CompassSenseEngine.ts:81#export const ACTIVE_DAILY_CAP = 6;`; `artifacts/api-server/src/lib/compassDecision.ts:92#export const SWITCHING_COST = 0.25`) and each is documented as engineering's tunable rather than an owner ruling. Whether an **approved** set exists that these should have reused is not a fact about this repository. **What would settle it:** the owner naming the approved budgets/policy, or confirming none were ever approved — in which case this requirement collapses into V2-36 and the answer there stands. |
| V2-36 | `:46` if absent: ask for the values or policy approval · implement **configurable** contracts and tests with explicitly synthetic fixtures · leave activation/certification unresolved | **GAP** | **PARTIAL** † | Three of four. **Ask** ✓ — `docs/architecture/census-compass.md` §7 records D3 (decision vocabulary and switching cost semantics) and D4 (the Attention Engine's ownership) as owner decisions, reported and not made. **Activation left unresolved** ✓ — every affected surface is behind a FALSE-seeded flag (`artifacts/api-server/src/routes/compassDecision.ts:78#if (!(await isFlagEnabled(sc, "com`). **Synthetic fixtures marked** ✓ — the eval criteria are unit-tested against synthetic transcripts with no provider present, as their own header states. **Configurable contracts ✗** — the policy values are compile-time constants read from no environment variable, flag or settings row: `artifacts/api-server/src/compass/CompassSenseEngine.ts:80#export const AWARE_DAILY_CAP = 3;` (`AWARE_DAILY_CAP = 3`), `artifacts/api-server/src/compass/CompassSenseEngine.ts:81#export const ACTIVE_DAILY_CAP = 6;` (`ACTIVE_DAILY_CAP = 6`), `artifacts/api-server/src/lib/compassDecision.ts:92#export const SWITCHING_COST = 0.25` (`SWITCHING_COST = 0.25`). An owner who approves a different number today needs a deploy, which is the outcome this clause was written to avoid. |

**Internal duplicates (8):** V2-01 `:7` preserve all fifteen phases ≡ RM-13..RM-27 · V2-02 `:7`
retain phase dependency and owner-trigger rules ≡ RM-01 + RM-14 · V2-04 `:9` reuse existing tools,
ranking, streaming, context guards, session models, UI ≡ V2-13 · V2-06 `:15` Home consumes a
server-built projection ≡ V2-17 · V2-08 `:15` Sense sends eligible attention, Live keeps only
permitted session context ≡ V2-18 + V2-19 · V2-25 `:38` basic Compass without premium ≡ RM-37 ·
V2-31 `:42` run the nine-query set ≡ RM-28 · V2-34 `:46` preserve the finalized-prompt boundary ≡
RM-14.

---

## 3. Verdict moves — none, and why that is the answer

The brief permits a census verdict to move **only where evidence supports it**, on the same
failing-test discipline as any other move. This pass moves none, and the reasons are specific rather
than cautious:

- **Nothing was found built-and-correct that the census grades `W`.** Every `W` row this pass
  re-executed (`CX-04`, `CX-05`, `C1-01`, `C1-02`'s residual, `CT-01`, `CPV2-03`, `CPV2-12`,
  `CPH-01`, `CPH-EVAL`) still has the stated residual, and in two cases (`C1-01`, `CX-04`) this pass
  found an **additional** failing criterion rather than a closing one.
- **Two `C` rows were probed for a downgrade and held.** `C1-04` (quick actions) looked like a
  candidate because the server enforces only the upper bound of "2–4"; it holds, because enforcing
  the lower bound would require inventing an action, which a guardrail forbids — the row is right
  and the reasoning behind it is now written down (P1-11). `CR-03` holds as a vacuous `C ⌀`, and the
  vacuity is restated rather than quietly inherited.
- **Fifteen requirements the census never counted are new rows, not re-grades** (§4), which is
  exactly what the brief asks for.

---

## 4. Coverage gaps — 15 requirements with no census row

**Denominator: 74. Gaps: 15 = 20.3 %.** Of the 15: **4 SATISFIED · 8 PARTIAL · 1 MISSING ·
2 CANNOT-VERIFY.** They are carried into `docs/architecture/census-compass.md` §16 as rows
`CCL-01`..`CCL-15`, taking that census's denominator from 126 to 141.

| row | requirement | grade | one-line reason |
|---|---|---|---|
| `CCL-01` | RM-01 sequential phase gating | PARTIAL | Phase 1 was inherited "as found" and first measured after Phase 15. |
| `CCL-02` | P1-08 both pipelines kept, only the router changed | SATISFIED | Both survive; the router is the only chooser. |
| `CCL-03` | P1-09 keyword router deleted only after shadow verification | CANNOT-VERIFY | No log, no comparator, and a header that still claims shadow mode. |
| `CCL-04` | V2-03 no rebuilt conversation store, no reinstalled prompt | SATISFIED | One store, one versioned prompt module. |
| `CCL-05` | V2-05 the processing chain's topology | PARTIAL | Every stage exists; `/compass/ask` runs through none of the shared ones. |
| `CCL-06` | V2-07 Compass consumes the current-context projection | MISSING | It imports a time-of-day helper and nothing else. |
| `CCL-07` | V2-09 no second sensing ingest route | SATISFIED | No ingest anywhere in Compass; one read seam, three importers. |
| `CCL-08` | V2-10 the decision result's field inventory | PARTIAL | Seven of eight; no confirmation-requirement field; flag-off. |
| `CCL-09` | V2-12 map the decision vocabulary to the existing action model | PARTIAL | Mapped onto the opportunity vocabulary, never onto Compass's action contract. |
| `CCL-10` | V2-27 authorized-empty vs dependency failure | SATISFIED | Per-section availability, tested with a control; `info` strings on the tool surface. |
| `CCL-11` | V2-28 the five fabrication classes | PARTIAL | Four owned; **travel duration has no trigger**. |
| `CCL-12` | V2-29 evidence attached to the particular claim | PARTIAL | Turn-scoped booleans; no subject binding. |
| `CCL-13` | V2-30 revalidate expiring evidence at action time | PARTIAL | Trip state re-read; the live datum is not. |
| `CCL-14` | V2-35 reuse **approved** policy values | CANNOT-VERIFY | Whether an approved set exists is the owner's to state. |
| `CCL-15` | V2-36 configurable contracts when values are absent | PARTIAL | Asked ✓, unactivated ✓, synthetic fixtures ✓, **configurable ✗**. |

**Why these were missed is worth one sentence, because it is a pattern rather than an oversight:**
thirteen of the fifteen come from **prose**, not from a numbered list — twelve of them from the
twenty-four obligations S1 states outside its acceptance table, and one from the roadmap's preamble.
The remaining two are sub-clauses buried inside S2's bullets. A denominator built by reading the
tables of a specification will reproduce this gap against the next specification too.

---

## 5. Evidence that lives outside this census's watched scope

Three of the grades above rest on modules that are **not** in `CENSUS_SCOPE["census-compass.md"]`, so
their citations are made here and deliberately not in the census, where they would lower its
scope-coverage ratio below its floor without making the census any fresher:

- **V2-05 / `CCL-05`** — `artifacts/api-server/src/lib/contextKernel.ts:2#contextKernel — Sensing §6's CONTE` is Sensing §6's context
  kernel as a shared platform object, and `artifacts/api-server/src/lib/opportunityEngine.ts:21#this tree — lib/compassDecision, §`
  is the opportunity engine downstream of it. Both exist; `/compass/ask` imports neither.
- **V2-12 / `CCL-09`** — the compatibility mapping is
  `artifacts/api-server/src/lib/opportunityEngine.ts:72#export const KIND_OF_DECISION: Rea`, which maps four of the seven decisions
  onto opportunity kinds and turns the other three into refusals that carry the decision and its
  reasons. That is compatibility handling, and it is not a mapping onto Compass's action contract.
- **V2-09 / `CCL-07`** — the ingest routes Compass does **not** duplicate are
  `artifacts/api-server/src/routes/intel.ts` and
  `artifacts/api-server/src/routes/mapObservations.ts`, neither of which Compass imports.

**Cross-lane request** to the integration owner: adding `lib/contextKernel.ts`,
`lib/opportunityEngine.ts` and `routes/opportunities.ts` to `CENSUS_SCOPE["census-compass.md"]`
would let these three rows be cited in the census itself and watched for staleness. This lane does
not edit `checkCensus*.ts`.

---

## 6. Two reasons that have drifted, on rows that do not move

Recorded because a verdict that is right for an expired reason decays silently.

1. **`CX-13` / CPV2-10 — "in two modules and no others".** §13.2's argument for CPV2-10 rests on the
   live seam being imported by two modules. It is now **three**:
   `artifacts/api-server/src/compass/CompassMediaContext.ts:58#import { readLiveClaimEnvelopes }`,
   `artifacts/api-server/src/compass/CompassLiveConstraints.ts:67#} from "../lib/liveClaimRead.js";` and
   `artifacts/api-server/src/routes/compassDecision.ts:31#import { liveLabelsServable, readL`. The verdict is unaffected — the third is
   the same fail-closed seam through the same envelope — but the count in the reason is wrong.
2. **The intent classifier's header contradicts its caller.**
   `artifacts/api-server/src/services/compass/CompassIntentClassifier.ts:8#Phase-1 shadow mode: runs alongsid` still describes shadow
   mode and a legacy keyword router that no longer exists, while
   `artifacts/api-server/src/routes/compass.ts:1431#Promoted out of shadow mode: "itin` records the promotion out of it. This is a
   source-(c)-class defect: a contract a module states about itself that is false. It does not move
   `C1-02`, whose verdict rests on the caller's behaviour, and it is the single reason `CCL-03` is
   CANNOT-VERIFY rather than answerable.

---

## 7. Attribution — a separate question, answered separately

**Attribution is not compliance and nothing in this section changed a single grade above.** A
requirement can be SATISFIED by code that names no specification, and a module can cite a
specification and still fail it.

**The rule, applied as the owner directed.** Code is **not** treated as unattributed merely because
it predates a specification's upload to this repository — a specification can exist outside the repo,
and the upload date is evidence about the repository, not about the work. Attribution is therefore
**UNKNOWN unless there is positive evidence in the file**:

- **attributable-to-this-spec** — an in-file header naming `master-roadmap.md`, `phase1-spec.md`,
  the v2 upgrade, or a `CPV2-xx` id; **or** a header naming "Phase N" **where N matches the
  roadmap's own subject for that phase**.
- **attributable-elsewhere** — an in-file header naming a *different* specification and no
  reference to these three: Sensing `§`/`:line`, `IG-0x`, `AT-1x`, `Trips §`, `Telegraph §18.3`.
- **unknown** — no specification reference in any carrier of the requirement.

**The "Phase N" qualifier is load-bearing and was checked rather than assumed.** Three Compass
modules carry a *different programme's* phase numbering, and reading them as roadmap references
would have manufactured attribution: `artifacts/api-server/src/compass/CompassSafetyFilter.ts:2#CompassSafetyFilter — Phase 2 hard`
("Phase 2 hard-block gate" — the roadmap's Phase 2 is the owner's prompt),
`artifacts/api-server/src/compass/CompassPipeline.ts:2#CompassPipeline — Phase 2 single-e` ("Phase 2 single-entry-point orchestrator")
and `artifacts/api-server/src/compass/CompassNotificationEngine.ts:2#CompassNotificationEngine — Phase` ("Phase 5 notification
priority" — the roadmap's Phase 5 is dynamic UI). All three are excluded from the attributable count.

### 7.1 The counts

| | count | denominator | share |
|---|---|---|---|
| attributable **to these three specs** | 55 | 74 | 74.3 % |
| attributable **elsewhere** | 11 | 74 | 14.9 % |
| **unknown** | 8 | 74 | 10.8 % |

| Source | to-this-spec | elsewhere | unknown |
|---|---|---|---|
| S3 master roadmap (30) | 25 | 1 | 4 |
| S2 phase-1 spec (16) | 14 | 0 | 2 |
| S1 COMPASS v2 (28) | 16 | 10 | 2 |

**The strongest positive evidence**, so the 55 can be checked rather than believed: twelve engine
and route modules head themselves with the roadmap's own phase number *and that phase's subject* —
`artifacts/api-server/src/compass/CompassStructuredContext.ts:2#CompassStructuredContext — Phase 3` (Phase 3), `artifacts/api-server/src/compass/CompassTools.ts:2#CompassTools — Phase 4 native func` (Phase 4), `artifacts/api-server/src/compass/CompassUiBlocks.ts:2#CompassUiBlocks — Phase 5 dynamic`
(Phase 5), `artifacts/api-server/src/compass/CompassMemoryService.ts:2#CompassMemoryService — Phase 6: La` (Phase 6), `artifacts/api-server/src/compass/CompassRecommendationEngine.ts:2#CompassRecommendationEngine — Phas` (Phase 7),
`artifacts/api-server/src/compass/CompassSocialEngine.ts:2#CompassSocialEngine — Phase 9 soci` (Phase 9), `artifacts/api-server/src/routes/compassHome.ts:2#Compass Home — Phase 10.` (Phase 10),
`artifacts/api-server/src/compass/CompassSenseEngine.ts:2#CompassSenseEngine — Phase 11: Com` (Phase 11), `artifacts/api-server/src/compass/CompassLiveEngine.ts:2#CompassLiveEngine — Phase 12: Comp` (Phase 12),
`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:2#CompassAutopilotEngine — Phase 13:` (Phase 13), `artifacts/api-server/src/compass/CompassOutcomeEngine.ts:2#CompassOutcomeEngine — Phase 14 ou` (Phase 14),
`artifacts/api-server/src/compass/CompassGraphEngine.ts:2#CompassGraphEngine — Phase 15 Trav` (Phase 15). Two name a document outright —
`artifacts/api-server/src/compass/CompassStructuredContext.ts:8#Privacy guarantees (see docs/compa` cites
`docs/compass/master-roadmap.md` for its privacy guarantees, and
`scripts/src/compass-answer-quality-eval.mjs:3#Standing 9-question Compass answer` names it as the source of the nine questions. Two
name the phase-1 spec — `artifacts/api-server/src/services/compass/CompassIntentClassifier.ts:49#The Phase 1 spec fixes this at two`
quotes it by clause. One test file names CPV2 ids directly:
`artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts:6#A. CPH-12 / CPV2-07 — Phase 12's *`.

**The eleven attributable-elsewhere are not a criticism.** They are the clauses S1 imports from the
Sensing architecture — the decision vocabulary, the switching cost, the grounding boundary, the live
read seam, the context kernel — and the modules that implement them cite *that* specification,
correctly, because that is where the semantics are defined:
`artifacts/api-server/src/lib/compassDecision.ts:2#compassDecision — Sensing §10's de` ("Sensing §10's decision"),
`artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:2#CompassGroundingEnvelope — Sensing` ("Sensing `:148`"),
`artifacts/api-server/src/compass/CompassLiveConstraints.ts:2#CompassLiveConstraints — IG-07: li` ("IG-07"),
`artifacts/api-server/src/lib/contextKernel.ts:2#contextKernel — Sensing §6's CONTE` ("Sensing §6").

**The eight unknowns, named, because an unknown is a result and not a shrug:** Phase 2 (nothing
built), RM-04 (preserve-existing-functionality — carried by tests and capability gates, no header),
RM-37 and RM-38 (no carrier exists — the vacuous guardrails), P1-17 and P1-18 (the suite and the
four named tests — `artifacts/api-server/src/test/compass-ask.test.ts:2#Compass ask endpoint tests — POST` lists the spec's four
coverage areas nearly verbatim but names no document, and a near-quotation is not a citation),
V2-03 (`artifacts/api-server/src/services/compass/CompassConversationService.ts:2#CompassConversationService` names no
specification at all, which for the tree's only conversation store is the most surprising single
result in this section), V2-07 (nothing built).

---

## 8. What this pass could not verify, stated plainly

- **`CCL-03` / P1-09** — whether the keyword router's deletion was preceded by the shadow comparison
  the spec requires. Settled by the disagreement logs or the removing PR; supplied by the owner or
  log retention, not by a lane reading the tree.
- **`CCL-14` / V2-35** — whether an approved set of attention budgets, switching policy and
  freshness rules exists to be reused. Settled by the owner naming them or confirming there are none.
- **47 of the 59 mapped requirements were carried from the census, not re-executed here.** They are
  the unmarked rows in §2. This pass re-executed 12 mapped requirements (the ones marked `†`) plus
  all 15 gaps — 27 of 74. A carried
  verdict is a citation of another pass's work, and it is marked as such rather than presented as
  this pass's measurement.
- **No real-model behaviour was measured.** Every grade above is over code, tests and fixtures. The
  one integration measurement that exists is the July eval, and V2-33's grade says what it showed.

---

## 9. How to reject this document

1. **Reject the enumeration rule** (§1) and the denominator moves. The 22 internal duplicates are
   listed by id, so a reader who wants all 96 clauses counted can add them back; every bucket count
   is reported against 74 and the arithmetic is shown.
2. **Reject the exclusions** (§1.1). All 13 are named with reasons; restoring any of them adds a
   requirement whose grade would have to be argued, and X2 and X8 are the two most arguable.
3. **Reject the vacuous satisfactions.** Four grades are `⌀` — RM-09/V2-21 (nothing to confirm),
   RM-37, RM-38. Subtracting all four gives **39 / 74 = 52.7 %** SATISFIED.
4. **Reject the gated constructions.** Six requirements are graded on code that is inert on every
   deployment (V2-10, V2-11, V2-12, V2-15, V2-16, and V2-36's activation criterion). They are graded
   PARTIAL here, never SATISFIED, so rejecting them moves nothing upward.
5. **Reject the carried verdicts** and read only the 27 requirements this pass re-executed — the 15
   gaps and the 12 mapped rows marked `†`.

---

## 10. B1 — the nine "ungraded" requirements, and what re-reading them changed here

*Added 2026-09-14 at `7c6255de7`. §§0–9 are unchanged; this section is additive and moves no grade
above it.*

`docs/architecture/reconciled-baseline-v1.md` §2.1 names nine requirements as the corpus's only
ungraded population and makes grading them backlog item B1. This document had already graded all
twelve `CPV2` clauses as V2-13…V2-24 in §2, so B1's work here was narrower than in the census: check
the premise, re-execute the nine against the tree, and record the one grade that moved.

**The premise does not hold, and the census now says why.** `census-compass` §17.0 shows that the
nine-row gap `check:census-integrity` prints for compass is the six `C1-0n` rows plus `CPV2-03`,
`CPV2-11` and `CPV2-12` — and the last three have carried verdicts since §13.3. Six of the nine
clauses the baseline names (`CPV2-01`, `-02`, `-04`, `-08`, `-09`, `-10`) are DUPLICATES that add no
requirement to any denominator; their verdict is their carrier's. **UNGRADED was never nine.**

**One grade moves in this document, and only one.** V2-14 (`CPV2-02`) was PARTIAL † on the reading
that the qualification bar *"is met on the input side and turn-scoped on the output side"*. That
reading was incomplete: of the five fixture classes the clause names, **`conflicting` was not met on
the input side either**. The §32 comparator reduced a live-claim envelope to band, source class and
observation time and dropped `conflictState`, so a reading whose reports materially disagree reached
`/compass/ask`'s prompt as an ordinary grounded baseline. That is now carried and stated
(`artifacts/api-server/src/compass/CompassMediaContext.ts:214#conflictState: hit === null ? null : normalizeConflictState(hit.conflictState),`),
pinned by `artifacts/api-server/src/test/compassCpv2Grounding.test.ts:66#describe("CPV2-02 — a conflicting fixture keeps its qualification through the Compass boundary"`.
**V2-14 stays PARTIAL**: the place/live tool surface's own confidence vocabulary
(`artifacts/api-server/src/compass/CompassTools.ts:526#CONFIDENCE RULE (Phase 8): tool data carries a "confidence" object with a sourceClass`)
is still four classes with no conflict member, and V2-29's per-claim attachment is untouched. The
grade is unchanged; **the reason behind it is now one class narrower and materially different**, and
recording that is the point of §6's rule about reasons that decay.

**Two grades are restated with a sharper reason and do not move.**

- **V2-21 (`CPV2-09`) — `SATISFIED ⌀`, and the tool surface was enumerated to say so.** At this
  commit the surface is 25 + 8 + 8 tools and **not one is in the four named classes**: no payment,
  no booking, no message-send, no location-share. Every write-shaped tool stops at a proposal.
  §3 recorded this as "the same vacuity"; what is new is that the vacuity is **watched** — a tool
  cannot be added silently, because `artifacts/api-server/src/test/compassToolCountContract.test.ts:18#`COMPASS_TOOL_COUNT_IN_HEADER` equals `COMPASS_TOOL_DEFINITIONS.length`.`
  turns red on any addition — and **not guarded**: nothing would refuse such a tool shipped with an
  updated count and no confirmation step. `⌀` is the honest mark and §9 item 3's arithmetic for
  rejecting it stands.
- **V2-23 (`CPV2-11`) — MISSING, and not closable inside this lane.** The deletion half is an hour's
  work in `CompassOutcomeEngine`. The other half is not: no row records that a ranking-weight nudge
  was applied (`artifacts/api-server/src/compass/CompassOutcomeEngine.ts:192#async function applyRankingNudge(`
  read-modify-writes a whole JSON column and keeps no ledger), so a withdrawal has nothing to walk
  back. Closing it needs a foreign key and a nudge ledger — two migrations. Building the deletion
  half alone would turn an honest MISSING into a PARTIAL that looks closer than it is.

**Everything else in §2's V2-13…V2-24 was re-executed at this commit and holds**, including the two
whose citations had drifted: `SWITCHING_COST` is still at `artifacts/api-server/src/lib/compassDecision.ts:92#export const SWITCHING_COST = 0.25;`
behind `artifacts/api-server/src/routes/compassDecision.ts:78#if (!(await isFlagEnabled(sc, "compass_decision_enabled"))) {`,
and `CPV2-12`'s duplicate store is still upserted at `artifacts/api-server/src/compass/CompassGraphEngine.ts:1153#const { error } = await db.from("compass_city_confidence").upsert(`.

**Headline: unchanged at 43 / 74 SATISFIED.** No bucket moves. A pass that re-executes twelve
requirements and moves nothing has either confirmed the document or not looked; the difference is
the paragraph above, where one PARTIAL's reason was wrong in the direction that flatters the tree
and is now corrected.
