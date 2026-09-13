# Census — Compass (the surface with no spec and no census)

*Built against branch `claude/portava-continuation-uqta94` on 2026-09-07, working tree at `4a166aeb`
plus uncommitted sibling work. Server code under `artifacts/api-server/src/` unless a path says
otherwise. Every BUILT verdict cites a `file:line` opened during this pass. Production figures are
aggregate counts read from the production project on 2026-09-07 (read-only; no user row was selected).*

---

## Declaration

| Field | Value |
|---|---|
| `head_commit` | `fa5d7c25d` — RE-DECLARED 2026-09-13 by the integrating lane, on §12.7's own instruction: *"The `head_commit` to declare is **the commit that carries this section and its six files**, and declaring it is the integrating lane's call, not this one's."* `fa5d7c25d` is that commit. It carries §12, the four rows §12.1 records as BUILT (CT-11, CP-01, CM-03, CT-13), the two rows §12.1 moves N → W because their stated absence had become false (CX-11, CL-05), and every counted file §12.7 names — `CompassSafetyAttention.ts` and `CompassAlgorithmVersion.ts` (new), `CompassPipeline.ts`, `CompassTools.ts`, `CompassMediaContext.ts`, `CompassAutopilotEngine.ts` and `routes/compass.ts`. **IT IS ON THE INTEGRATION BRANCH `claude/sweet-fermat-fmx7up` AND CARRIES THE PRE-SQUASH HAZARD every branch declaration in this repository carries**: this repository squash-merges, so once this branch lands `fa5d7c25d` is an ancestor of nothing and `check:census-freshness` will report this census unreadable (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`) until whoever merges re-declares the squash sha. That is a known cost, taken deliberately rather than leaving the row naming a commit seven counted files older than the tree. **THIS DECLARATION SAYS WHAT THE LAST ONE SAID AND NO MORE.** It says: no counted file has moved since `fa5d7c25d` except two, and those two are named, argued file by file and acknowledged in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` — `artifacts/api-server/src/routes/airport.ts` and `artifacts/api-server/src/services/airport/LayoverCompassService.ts`, both the Layover lane's §15 and neither of them touching a Compass verdict. It does **not** certify the 45 `C` rows §11.6 named, nor the rows §12.6 records as not re-opened. The previous declaration read: `3ca68cb06` — RE-DECLARED 2026-09-13 by §11, replacing `820b60638`. §11 re-executed all 23 BUILT-BUT-WRONG rows and eleven BUILT-AND-CORRECT ones at this commit, and §11.6 names exactly which 45 `C` rows it did **not** re-open. This declaration therefore says the same thing the last one did and no more: no counted file has moved since `3ca68cb06`. It does **not** certify the 45. The previous declaration read: `820b60638` — RE-DECLARED 2026-09-13 by §10, replacing `42aeac38`. This one is different in kind from the one it replaces: `42aeac38` started a clock over verdicts nobody had re-read, and §10 says what happened next — nine of them were false by the time the clock was read. `820b60638` is the commit §10 measured at, and §10.6 states exactly which rows were re-executed there (all 15 N, all 19 W, 12 of 56 C) and which 44 were not. It **still does not certify the 44.** Read the next row, then §10.1. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. Its verdicts were taken at working tree `4a166aeb` **plus uncommitted sibling work**, per the note above — and `4a166aeb` **exists nowhere**: verified against FULL history (`git fetch --unshallow`, 4,300 commits, then `git cat-file -e`), not assumed. This census is therefore the weakest-anchored of the six declared together: its measured state was never a commit at all, so no diff against it is possible even in principle, and this declaration **does not claim otherwise**. What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the 6 paths in `CENSUS_SCOPE["census-compass.md"]` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. Declared by the Trips lane while recounting the sibling census; if this lane disagrees, reverting costs only the check. |

---

## 0. Headline

| | Inbound only (source a) | All three sources (a + c) |
|---|---|---|
| Denominator | **70** | **90** |
| CONSTRUCTED (C + W) | 55 / 70 = **78.6 %** | 75 / 90 = **83.3 %** |
| CORRECT (C) — as found | 35 / 70 = **50.0 %** | 51 / 90 = **56.7 %** |
| CORRECT (C) — after this pass | 36 / 70 = **51.4 %** | 56 / 90 = **62.2 %** |
| CANNOT-VERIFY | **0** | **0** |

**The inbound-only figure is the one to trust.** Source (c) is Compass grading its own homework —
twenty contracts its own headers and guards state — and it lifts the correctness figure by
eleven points, exactly the shape `census-discovery.md` warned about (68.7 % overall vs 40 % inbound).
Compass's gap is smaller because four of its twenty self-stated contracts were *wrong* when
measured, and all four are closed below.

**Zero CANNOT-VERIFY, and I looked hard for one.** Every candidate — "does the prose respect the
deterministic verdict", "is explicit intent weighted", "is the proposal persisted", "does the
client call the person-card endpoint" — turned out to be answerable from code, and was answered.

---

## 1. Why this census had to build its own denominator

Compass is named by all eleven specs and has none of its own (`ls docs/specs/` → no
`Portava_Compass_*`). `docs/architecture/cross-cutting-obligations.md:132-144` records it as *"the
most-obligated surface in Portava"* with *"at least 28 inbound obligations"* and *"no denominator
anywhere against which 'how much of Compass exists' could be asked."* This document is that
denominator. It is stated in full in §2 so it can be rejected before the percentage is trusted.

**What Compass is, measured.** Eight route files, 44 engine modules, 24,149 lines:

| Piece | Where | Size |
|---|---|---|
| Ask / feed / recommendations / memory / passport-remembers / telegraph tray / person card | `routes/compass.ts` | 4,234 lines, 41 endpoints (`:330-4198`) |
| Home | `routes/compassHome.ts` | 403 lines, 1 endpoint (`:285`) |
| Sense, Live, Autopilot, Outcomes, Graph, Admin | `routes/compassSense.ts` (4), `compassLive.ts` (4), `compassAutopilot.ts` (7), `compassOutcomes.ts` (2), `compassGraph.ts` (4), `adminCompass.ts` (14) — all registered at `routes/index.ts:196-203` | 1,843 lines |
| Engines | `compass/*.ts` (44 files) | 17,669 lines |
| Own programme documents | `docs/compass/master-roadmap.md` (15 phases, global rules at `:10-24`), `docs/compass/phase-summaries.md` | — |
| Tests | 47 files matching `compass|autopilot|memoryRecaps|passportRemembers|projectedMemory` under `src/test/` | — |

**Ownership note.** This census measures all eight route files; the pass *edits* only what it owns
(`routes/compass.ts`, `routes/compassHome.ts`, `compass/**`, Compass tests). `routes/compassAutopilot.ts`
writes canonical trip state and is reported to the Trip Kernel owner in §8, not touched.

### 1.1 The three sources, and how each was handled

**(a) Inbound obligations — 70 rows.** `cross-cutting-obligations.md` §2/§8 was the *index*; every
obligation was then read **in the demanding spec** and its line number re-verified (all 41 cited
spec lines checked; none was stale — the registry's citations for Compass hold). One row per
spec clause, not per census sub-row, so a census that split one clause into twelve tool rows
(census-trips TR199–TR210) contributes one row here with the sub-count in the evidence column.
Two candidates were **excluded** as not Compass-owed and are named so the exclusion can be
disputed: GII G25 (`allowMemoryContext` read by nothing — the reader would live in
`lib/inputAssistance`, GII's own layer) and Telegraph T397 (causal-event dedup — owed by
`services/notifications`, which Compass's engine is consulted *by*, not the reverse).

**(b) Sideways rows in `census-passport.md`, `census-input-intelligence.md`, `census-discovery.md`,
`census-trust.md`** (and census-trips/-layover/-telegraph/-highlights/-media/-map/-wall/-sensing,
which also measured Compass sideways — 161 rows mention it). Settled verdicts were not re-litigated;
every row marked `W`/`N` **against Compass** was re-checked. Five of them were wrong or stale and
are corrected in §5.

**(c) Contracts Compass states about itself — 20 rows.** Only headers, guards and tests that
*state* a rule, never a rule inferred from behaviour. Four were false when measured (§3.C) and are
fixed in §6.

### 1.2 Reading the buckets

`C` BUILT-CORRECT · `W` BUILT-BUT-WRONG · `N` NOT-BUILT · `?` CANNOT-VERIFY. `⌀` marks a vacuous
satisfaction (nothing to violate) so a reader who rejects vacuity can subtract it. `(gated)` marks a
construction that is inert in production; it counts as built, consistent with every prior census.

---

## 2. The denominator — source (a), 70 inbound obligations

### 2.1 Sensing spec — 15 rows

| id | Obligation (spec line, verified) | V | Evidence |
|---|---|---|---|
| CX-01 | `:129` Safety constraints outrank opportunity/vibe; a dangerous place is never "best move now" — the **Compass half** (registry SX-09) | **W → C (gated)** | *As found:* `compass/CompassSafetyFilter.ts:119-135` lists sixteen author/content conditions and no world safety state — that half of the registry verdict holds. But the registry stopped there. The gated live-constraint stage **did** see the one server-owned safety claim, `unsafe_density` (`lib/intelContracts.ts:256-257`, *"a safety claim, not a vibe"*), folded it into `PACKED_CROWD_LEVELS` (`compass/CompassLiveConstraints.ts:108`) and (pre-edit `:392-401`) **demoted** it — only for a viewer whose intent was `quiet`. A safety claim treated as a busyness preference is the exact inversion `:129` forbids. *Now:* `:112-130` names it `UNSAFE_CROWD_LEVEL` and `constraintReasonFor` (`:406-415`) returns `kind: "exclude"` for every viewer, whatever the intent; `packed` is unchanged. Inert until `COMPASS_LIVE_CONSTRAINTS_ENABLED=true` (`:76-85`), which production does not set. Pinned by `test/compassCensusGates.test.ts` D1–D4. |
| CX-02 | `:137` Intent modes Right Now · Tonight · Explore · Quiet · Social · High Energy · Nearby · Trip on shared intelligence | **W** | Two vocabularies exist and neither is this one. `compass/CompassIntentModeEngine.ts:5-22` derives nine *context* modes (safety/arrival/night/…) from `CompassContext`, not from shared intelligence. `compass/CompassTemporaryIntent.ts` carries the Map §13 vocabulary into ranking as a bounded addend — `bored · eat · party · explore · meet_people · date_night · chill · local · surprise_me` — which covers Explore, Quiet (`chill`), Social (`meet_people`) and High Energy (`party`): **four of eight**. Right Now, Tonight, Nearby and Trip are unrepresented. Corrects census-sensing S72's "Quiet / High Energy unrepresented". |
| CX-03 | `:147` Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | **N** | `grep -rniE "go_now|go soon|goSoon|switch_cost" compass/ routes/compass*.ts` → one unrelated hit (`routes/compass.ts:156`, timezone comment). Compass returns ranked items, nudges and Plan B (`CompassLiveConstraints.ts:711`), never a decision. |
| CX-04 | `:148` Ground natural-language claims in structured truth | **W** | More grounding exists than the registry credited: the CANDIDATE RULE (`compass/CompassTools.ts:236`), a CONFIDENCE RULE that forbids claiming live status without `verified_live` data (`:231`), factor-grounded "why this" (`CompassRecommendationEngine.ts:23-27`; `routes/compass.ts:956-969`), and UI blocks that drop any id the tools did not return (`CompassUiBlocks.ts:11-15`). All of it is **input**-side or **reference**-side; nothing reads the model's prose back against the confidence band of its inputs. The failure the spec names (*"low-confidence dance_likelihood → 'everyone is dancing'"*) is prevented only by prompt text. |
| CX-05 | `:149` Current Experience value introduces switching cost | **N** | Zero occurrences of `switching`/`switch_cost` in `compass/` and `routes/compass*.ts`. |
| CX-06 | `:150` Home consumes a server-assembled `UserNowProjection`/equivalent | **C** | `routes/compassHome.ts:1-20` — one endpoint assembling bestNextMove, circleActivity, startingSoon, tonightVibe, weatherWindow; `:285` the single route. Name absent, equivalent present (registry SX-24). |
| CX-07 | `:151` Home = "what matters now"; Compass = "what should I do about it" | **C** | `routes/compassHome.ts:285` vs `routes/compass.ts:1314` (`POST /compass/ask`). |
| CX-08 | `:176` Attention Engine is mandatory before NOTIFY / WALL / SILENT / IGNORE | **N** | `compass/CompassNotificationEngine.ts:4-27` is a ten-level priority stack with quiet hours and mutes: a send/suppress filter with no relevance, novelty, half-life, interruption-cost or attention-budget term and no WALL outcome (`:83-90` — the outcome union has no `wall`). Nobody owns this engine (registry SX-45). |
| CX-09 | `:19` Existing Compass paths keep functioning while new projections are partial or gated | **C** | Live intel enters Compass only through the fail-closed `readLiveClaimEnvelopes` seam (`CompassLiveConstraints.ts:11-18`, returns `[]` when anything is off); the stage itself is env-gated OFF (`:76-85`); a disabled `COMPASS_ENABLED` returns an honest fallback envelope (`routes/compassHome.ts:19-20`); `flags.ts:24-37` turns an unreadable `feature_flags` into "every flag off". |
| CX-10 | `:118`, `:191` Context Kernel assembling nine contexts, consumed by all surfaces | **W** | `compass/CompassContextEngine.ts:6-17` is an eleven-state machine that is Compass-local; it has no World, Experience or Attention context and is consumed by no other surface (registry SX-54). |
| CX-11 | `:118` Opportunity Engine downstream of the kernel | **N** | Each Compass surface builds candidates directly (`CompassItemHydrator.ts:7-11`, `CompassFeedBuilder.ts:4-9`); no shared opportunity object (census-sensing S46/S56). |
| CX-12 | `:119` Feature clients must not independently calculate crowd, vibe, safety or opportunity — the Compass client | **C** | `travel-buddy-standalone/src/features/map/compass/compassMapModel.ts:8` *"Compass does not create live facts; it reasons over structured state"* (census-map M104, M288). |
| CX-13 | §6 Product surfaces consume projections; do not reimplement engine logic (S47) | **C** | `compass/CompassMediaContext.ts:26-53` and `CompassLiveConstraints.ts:11-18` both read through `lib/liveClaimRead` and *"never read a snapshot, claim or observation row"*. |
| CX-14 | §6 User dislike ≠ bad venue (S16) | **C** | `compass/CompassFeedbackEngine.ts:23-27` — feedback writes `compass_feedback_events` and `compass_user_preferences` only; no path to an intel claim. |
| CX-15 | §6 `ExperienceSession` bridges opportunity → action → outcome without being a tracking history (S54) | **W** | An equivalent exists under another name and a narrower scope: `compass/CompassOutcomeEngine.ts:4-19` ties recommended → viewed → saved → went → stayed → liked → invited → made_memory → returned back to `compass_served_recommendations`. It bridges a *recommendation* to an outcome, not a *world opportunity*; nothing outside Compass can start one. |

### 2.2 Global Input Intelligence spec — 5 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CG-01 | `:8` Compass consumes the shared layer; no surface builds its own assistance engine | **W** | The client duplicates the server's starter set: `travel-buddy-standalone/src/…/compass/compassPrompt.ts` re-implements `buildCompassStarters` and `app/(tabs)/ai.tsx:399` calls the client one (census-input-intelligence G359 `W`). Client-side; recorded, not edited. |
| CG-02 | `:150-152` Compass prompt: contextual starters based on current surface | **C** | census-input-intelligence G88 `C` (`projection.ts:258-304`), confirmed by the client wiring at `app/(tabs)/ai.tsx:398-410` (G364). |
| CG-03 | `:160-163` Context carryover bounded to the task; Compass prompt carries Trip context; no silent preference rewrite | **C** | Trip context is attached server-side on every ask (`compass/CompassTripContext.ts:1-11`, called at `routes/compass.ts:1486-1490`) and as structured refs on starters (G364). Boundedness: `CompassTemporaryIntent.ts:14-20` *"reads no profile and writes nothing, so it CANNOT rewrite a preference"*; `compass/CompassSearchDecayService.ts:5-9` decays a search nudge so it *"doesn't permanently skew"* the feed. |
| CG-04 | `:213` Compass: convert phrase into structured request/action with referenced entities | **C** | G137 `C` (`semanticIntent.ts:231-268` produces `open_compass` with the parse); the drop is on the *search bar's* client (G305), not Compass's — `app/(tabs)/ai.tsx:98-104` consumes `prefillMessage`. |
| CG-05 | `:216-229` AI-assisted writing for Compass is opt-in, editable, never silently inserted | **C (gated)** | G138/G143 `C`; `compass_ai_writing_enabled` has **no row** in production `feature_flags` (verified 2026-09-07), and `aiWriting.ts:80-90` reads it fail-closed, so no AI writing has run. |

### 2.3 Trips spec — 13 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CT-01 | `:12` No Compass component may independently invent canonical trip state; consequential changes pass through the Trip Kernel | **W — violated** | No kernel exists (census-trips TR1). Compass writes canonical trip tables from **three** engine sites, one more than the registry lists: `compass/CompassAutopilotEngine.ts:206` (`trip_autopilot_settings` upsert), `:598` (`trip_autopilot_proposals` insert), and **`:647-648` (`trip_plan_items` `.update(patch)` when a proposal is confirmed)**; plus `routes/compassAutopilot.ts:229-230,246-247` (proposal status). The engine re-verifies permissions and lock types at confirm (`:66-85`), which is the right *policy* on the wrong *path*. Floor, not ceiling: `.rpc(` in `compass/` is three memory RPCs and one search-signal upsert (`CompassSearchDecayService.ts:87`); no dynamic `.from(expr)` on a trip table. **Production: 0 rows in both autopilot tables** — the violation is structural, not yet a data fact. Owner: Trip Kernel sibling (§8). |
| CT-02 | `:25`, `:373`, `:488` Consume typed Trip projections (`TripCompassProjection`) rather than duplicating Trip semantics | **N** | `TripCompassProjection`: zero occurrences (census-trips TR360 `N`). Compass reads raw `trip_members`/`trips`/`trip_plan_items` (`CompassTools.ts:421-468`; `CompassTripContext.ts:17-21`). Trips' to publish; not closable from Compass. |
| CT-03 | `:185` Consume Temporal Freedom windows rather than independently calculating free time | **W** | No engine exists (TR131), and Compass calculates free time itself in **two** places: `CompassTools.ts:151-165, 647-701` `check_trip_conflicts`, and `compass/CompassSenseEngine.ts:245-246` `free_time_block` (*"no plan item starts within the next 3 hours"* from `trip_plan_items`). census-trips TR133 scores the *consumption* `N`; this row scores the *independent calculation* the clause forbids, which is built and wrong. |
| CT-04 | `:234` Compass may create a proposal but cannot silently mutate others' commitments | **C** | census-trips TR155 `C`: `CompassTools.ts:19-21`, `:161` *"never writes anything"*, `:230`; re-verified. |
| CT-05 | `:278` Authority bound: no bypassing authorization, no invented canonical facts, no relaxed safety, no expanded freedom, no mutation outside the policy path | **C** | TR215–TR219 `C`: `CompassTools.ts:730-735` (`isAcceptedTripMember` + `canEditPlan` before proposing), `:238-250` `sanitizeToolResult`; re-verified. The autopilot confirm write is carried by CT-01, not double-counted here. |
| CT-06 | `:283` Trips remain operational without Compass | **C** | TR222 `C` (`routes/index.ts:146,173,251-254`; `test/tripsHostingDegraded.test.ts`). |
| CT-07 | §12.1 The twelve Compass tools (`getTripContext` … `findMeetingPoint`) | **W** | 3 of 12 exist under other names — `get_current_trip` (TR202 `W`, `CompassTools.ts:85-89`), `get_whos_around` (TR204 `W`), `add_to_trip` (TR210 `W`) — and 9 are absent (TR203, 205–209, 211–212 `N`). |
| CT-08 | §12.3 Value-of-information before asking the traveller | **N** | TR220 `N`; `CompassTools.ts:235` instructs *"CALL the matching tool instead of guessing"* — nothing scores a question. |
| CT-09 | §4 `TripProposal` as a governed object (decision rule, affected objects, expiry) | **W** | **Corrects TR26/TR210** (*"not persisted… no expiresAt"*): the proposal **is** persisted, inside the conversation message payload (`routes/compass.ts:1794-1814` reads `pendingProposals`/`resolvedProposals`), with a 24 h TTL that fails closed on a missing timestamp (`:1728`, `:1771-1774`). What is still missing: `decisionRule`, `affectedObjects`, and a table any *other* participant could see. |
| CT-10 | §15 Compass must escalate to airline / airport / embassy / emergency / human support where appropriate | **N** | No Compass tool or prompt rule names an institution; `services/safeReturn` is not imported by `CompassTools.ts` (TR217). census-trips TR328 credits SafeReturn's contact flow — that is not Compass. |
| CT-11 | §17 Commercial recommendations suppressed when a severe operational/safety state requires attention | **N** | `safety_mode` reaches ranking only as a context boost for `notification`-type items (`compass/CompassScoringEngine.ts:272`); nothing suppresses paid/featured items when `safeReturnActive` (TR319 *"unguarded absence"*). |
| CT-12 | §16 Friend nearby → meetup opportunity, subject to both parties' privacy | **W** | `get_whos_around` is real and privacy-correct (`CompassTools.ts:188-193`; `CompassSocialEngine.ts:350-379` every target through `canViewCirclePresenceBatch`, fail-closed per target) but produces presence, not an opportunity (TR304). |
| CT-13 | §18 Automated suggestions explainable from stored inputs and a versioned algorithm | **W** | Stored inputs: yes — every autopilot proposal persists `reason` and per-item before/after `changes` (`CompassAutopilotEngine.ts:598-606`), and every served recommendation persists its factor snapshot (`routes/compass.ts:956-969`). Versioned algorithm: no — `grep -i "algorithm\|version" CompassAutopilotEngine.ts` → nothing; `compass_algorithm_versions` exists as a table and nothing stamps a proposal with it. |

### 2.4 Layover spec — 7 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CL-01 | `:59` Compass may converse about a layover but does not own feasibility | **C** | census-layover L16 `C`: `services/airport/LayoverCompassService.ts:51-68` recomputes `hardReturnTime` itself; model text reaches only `answer`. |
| CL-02 | `:63`, `:886` Hard safety cannot be overridden by Compass prose | **W** | L3/L101 `W`: structured fields safe by construction; the prose is checked only by prompt text (`LayoverCompassService.ts:71-79`) and a coordinate regex (`LayoverPrivacyGuard.ts:100-106`). Nothing compares the prose with the deterministic verdict. The prose is Compass's, so the row is Compass's. |
| CL-03 | `:66`, `:803` One canonical `LayoverSnapshot` drives Compass; no duplicate time-budget logic | **N** | `grep -rli layover compass/ routes/compass.ts routes/compassHome.ts` → **nothing** (confirms L-03). The only Compass-flavoured layover code lives in `services/airport/` and is reachable only from `routes/airport.ts`. |
| CL-04 | `:748-764` §25 Compass row: tool access to certified context, proactive OpportunityEvents, explanation/clarification | **W** | L268 `W`: explanation only, no tools, no OpportunityEvents, no clarification — and the endpoint is unreachable from the app (layover headline defect 4). |
| CL-05 | §12 Twelve layover tools (`getLayoverContext` …) | **N** | L102–L113 `N`: `CompassTools.ts:70-225` declares eleven tools, none layover. |
| CL-06 | §12 Ask the smallest sufficient number of clarifying questions | **N** | L114 `N`; `LayoverCompassService.ts:90-97` has no tool schema and asks nothing. |
| CL-07 | §23 Contract tests that Compass cannot override deterministic safety fields | **N** | L237 `N`; no test exercises `answerLayoverQuestion` against the engine's numbers. |

### 2.5 Passport spec — 5 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CP-01 | `:94` Weight explicit current intent above generic interests | **W** | **Corrects census-passport P42 / census-discovery A18 / registry P-05** (*"nothing consumes it"* / *COULD NOT ESTABLISH*): `compass/CompassTools.ts:891-915` reads both travellers' explicit windows through `readVisibleExplicitIntent` + `getActiveWindows` at the caller's permitted visibility and applies `explicitIntentBoost` — pinned by `test/compass-social.test.ts` D2. But that is **one of two** people-ranking surfaces: the traveler recommendation list at `routes/compass.ts:3418-3659` builds `sharedInterests` reason codes and reads no window (`grep -i intent` over `:3400-3480` → nothing). |
| CP-02 | `:207-221` Compass consumes its Passport projection variant; §35 does not rebuild identity independently (P100, P169) | **W** | Half-closed since census-passport: `GET /compass/people/:userId/passport` (`routes/compass.ts:4395-4429`) serves `discovery_card` through `buildConsumerProjection` behind the fail-closed `allowDiscoveryPersonCard` gate (`services/passport/PassportConsumerAccess.ts:62-90`). But **no client calls it** (`grep -rn "compass/people/" travel-buddy-standalone/src` → nothing), and the traveler list still reads `profiles` directly — `routes/compass.ts:3418-3425` selects `username, display_name, name, avatar_url, …` — one of the two real direct person-identity readers in the tree (census-discovery C33). Owner decision D2 in §7. |
| CP-03 | `:263` A Passport block propagates into Compass social recommendations | **C** | P120 `C`; re-verified at the two Compass legs: `routes/compass.ts:3399-3415` reads `blocks` **with** `blkErr` bound and answers `block_check_failed` with an empty list (fail-closed), and `CompassTools.ts:1197-1207` re-resolves hidden users per social tool call. |
| CP-04 | §18 Shared context → Compass handoff | **C** | P87 `C` (`SharedContextService.compassHandoff:40-61` → `app/(tabs)/ai.tsx:98-104`). |
| CP-05 | Universal display-name rule (`.agents/memory/display-name-privacy.md`): `@handle` unless opted in; self exempt; via `nameVisibilitySet` | **C** | `routes/compass.ts:3619` `nameVisibilitySet(sc, …)` batched; `:3578-3582` `title` = real name iff `nameOk`, else the **bare** username (null for private non-followed); `data.displayName` null unless `nameOk` (`:3590`). The list excludes the viewer (`:3374` `.neq("id", user.id)`), so the self-exemption cannot be violated here. The client renders `@` from the bare username (`components/compass/CompassTravelerRow.tsx:57-60` via `primaryIdentityText`). **The brief's "third shape, `title`=`@username`" is not what ships** — title is the bare username and this is the *same* shape census-discovery C19 found in Discovery search. |

### 2.6 Telegraph spec v1.1 — 9 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CTG-01 | `:87` Availability expiry revokes across Compass | **C** | The only availability Compass consumes is read live: `CompassTools.ts:68` imports `getActiveWindows` (*"explicit-only, expiry re-evaluated on read"*, `:872-873`), called per tool call at `:889-892`; nothing stores a copy. |
| CTG-02 | `:285` Block cascade into Compass retrieval; no subsystem rediscovers a blocked relationship | **C** | T219 Compass leg `C`: `CompassTools.ts:290-318` `refreshHiddenUsers` per social call; feed-side `CompassSafetyFilter.ts:120-121` conditions 1–2. One hole closed this pass (§3.C CC-08). |
| CTG-03 | `:369`, `:578` Deleted/unsent objects removed from Compass retrieval | **C ⌀** | Compass retrieves **no message content**: `/compass/telegraph` (`artifacts/api-server/src/routes/compass.ts:4343#router.get("/compass/telegraph",`) reads `message_thread_members`, `message_threads`, `trips`, `profiles` — never `messages`; the fallback builder reads membership only (`artifacts/api-server/src/compass/CompassFallbackFeedBuilder.ts:389#.from("message_thread_members")`). A report invalidates the Compass cache — **CITATION REPAIRED, §12.4**: `routes/messaging.ts:2723` was a message-TAGGING side-effect and had been since before `3ca68cb06`; the two real sites are `artifacts/api-server/src/routes/messaging.ts:3557#"thread_report"` and `artifacts/api-server/src/routes/messaging.ts:3784#"message_report"` (T276). Vacuous in the one place it could matter. |
| CTG-04 | `:621` Unavailable/Invisible revokes Compass availability projections promptly | **C** | Same read-time path as CTG-01; presence honours pauses/visibility per target through `canViewCirclePresenceBatch` (`CompassSocialEngine.ts:376-379`). |
| CTG-05 | §18.3 Eight conversation tools (`getConversationContext` … `searchAuthorizedConversationContent`) | **N** | T244–T251: 0 of 8 in `CompassTools.ts:70-225`; `create_meetup_draft` exists outside Compass (`routes/telegraphCommands.ts:34`). |
| CTG-06 | §18.3 Compass sees only data authorized to the conversational context | **C** | T252 `C` (`services/telegraphChatSuggestions.ts:27#export interface TelegraphChatPrivacyVerdict`, `services/telegraphChatSuggestions.ts:106#export async function resolvePrivacyVerdict`, `services/telegraphChatSuggestions.ts:237-255#show_telegraph_dm, show_telegraph_trip, show_telegraph_circle`; `routes/telegraphChat.ts:17-21`). |
| CTG-07 | §18.3 No cross-participant leak, no impersonation, no silent canonical plan | **C** | T253 `C` (`CompassTools.ts:241` SOCIAL RULES; `requires_confirmation: true`). |
| CTG-08 | §30A.1 Canonical relationship model; no independent inference | **W** | T379 `W`: `sharesSocialContext` (`CompassSocialEngine.ts:436-475`) is a fourth relationship resolver with its own vocabulary — correct and fail-closed, not canonical. |
| CTG-09 | §30A.13 Private policy signals constrain, never exposed as a score | **C** | T418 `C`: `CompassTools.ts:844-865` consults `overall_score` as a floor and answers uniformly *"not available"* — never why. Made fail-closed on an unreadable table this pass (CC-07). |

### 2.7 Highlights / Memories spec — 4 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CH-01 | `:460-461` Compass is a consumer of Memory facts; must not mutate canonical facts through prose | **C** | H129 `C`: the tool set has no Memory mutation (`CompassTools.ts:70-225`); `forgetMemory` at `routes/compass.ts:2194` writes `compass_memories` (a chat store), not `memories`. |
| CH-02 | `:462-469` Eight Memory read tools (`getMemory`, `searchMemories`, `getSharedMemories`, `getPlaceHistory`, `getTripMemories`, `getMemoryEvidence`, `createMemoryDraft`, `suggestMemoryCorrection`) | **N** | 0 of 8 in `CompassTools.ts:70-225`. Resolves the registry's H-01 *COULD NOT ESTABLISH*: established absent. Memory reaches the prompt as a projected block instead (CH-04). |
| CH-03 | `:742` Never keep deleted Memories in Compass projections | **W** | Compass's own reads are clean: `CompassGraphEngine.ts:707-713` selects `state = published` and `≠ only_me` (*"belt and braces"* re-check at `:704`); `PassportRemembersService.ts:396-402` drops `deleted/removed/hidden`; the prompt block goes through `memory_retrieve`/`memory_rediscover` (`ProjectedMemoryPrompt.ts:110,120`), Memories-owned RPCs. But a graph **node** built from a memory persists after that memory is deleted: the only pruning is of stale city/time-slice keys (`CompassGraphEngine.ts:1208-1260`); no deletion hook, no per-memory prune. The node carries anchors only (`:693-694` *"never the title, caption or media"*), which bounds the leak to "this owner was at this place/trip/event" — a derived fact of a deleted memory, kept until the next rebuild. |
| CH-04 | `:528` `CompassMemoryProjection` — minimal authorized retrieval facts | **C (gated)** | Equivalent under another name: `compass/ProjectedMemoryPrompt.ts:1-27` — bounded, UGC-wrapped, flag-gated (`memory_projection`, **false in production**), service-role RPC with the caller's own id. |

### 2.8 Media spec — 4 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CM-01 | `:294-304` `CompassMediaContext { mediaAssetId, entityRefs, viewerContext, permittedIntelligenceRefs }` | **C** | `compass/CompassMediaContext.ts:8-12` and the four privacy rules at `:15-35`; consumed at `routes/compass.ts:1511` (MD242–MD246 `C`). |
| CM-02 | `:178` Convert a Trail / Trip recap / itinerary into an executable Compass plan | **N** | MD107 `W` from Media's side (the action adds trip-plan items); on Compass's side no plan compiler exists. Resolves registry MD-05 *COULD NOT ESTABLISH*: absent. |
| CM-03 | §32 The nine questions (*worth going now · find similar · still busy · where is this · build a plan · what's nearby · where after · quieter/cheaper · add to Trip*) | **W** | Four carried (MD246, MD250, `create_plan`, `add_to_trip`); "where should we go after" (MD252) and "quieter/cheaper" (MD101) have no comparator or sequencing concept in `CompassMediaContext.ts`. |
| CM-04 | §33 Compass owns recommendation/decision support; the engine stays propose-only | **C** | MD436 `C`: `CompassMediaContext.ts:12-13` *"does NOT fork the Compass engine; the engine stays propose-only"*. |

### 2.9 Map spec — 3 rows · 2.10 Wall spec — 2 rows · 2.11 Trust — 3 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CMP-01 | Map `:162` Compass does not create live facts | **C** | M104/M288 `C` (`compassMapModel.ts:8,191`). |
| CMP-02 | Map §13 TemporaryIntent is a separate, request-scoped addend to Compass ranking — never written back | **C** | `compass/CompassTemporaryIntent.ts:1-29`; `compass/types.ts:74`; census-map M97/M102 `C`. |
| CMP-03 | Map `:162` Compass Map Mode: 3–5 best next moves with a WHY panel | **C** | M103/M105 `C` (`compassMapModel.ts:67-68, 212-223`); server surface `GET /compass/recommendations` (`routes/compass.ts:3164`). |
| CW-01 | Wall `:146` Compass references canonical objects in responses/actions | **C** | `compass/CompassUiBlocks.ts:7-15` — every block reference validated against the turn's tool results; unknown ids dropped. |
| CW-02 | Wall `:143` Ask Compass from a place-linked post | **C (gated)** | W85 `C`; `wall_compass_handoff_enabled` is **false** in production (2026-09-04). |
| CTR-01 | Trust §35 Consume Trust through the canonical read (`getDisplayTrustScore`) | **W** | census-trust A17: four direct reads in Compass. After this pass **three** remain — `CompassProfileService.ts:86-89` (→ `null` when absent, `:251-252`, never substituted), `CompassTools.ts:855-858` (floor, now fail-closed), `CompassActiveUserRewardEngine.ts:188-199` (`trust_caps`). The fourth (`CompassNotificationEngine.ts:450`, pre-edit) read a value the column cannot hold and is replaced (§6 F2). |
| CTR-02 | Trust TABLE 22: permitted trust summary for the Compass person card | **C** | census-trust A14 `C`; served by CP-02's endpoint. `confidence` is wrong there (P50) and is Passport's (#467). |
| CTR-03 | Sensing `:182-183` Compass never scores a person from passive movement (SX-47/48) | **C ⌀** | No Compass module reads `location_snapshots`/`journey_observations` (`grep` over `compass/` → nothing); the Graph reads `memories`, `user_stamps`, `trips`, `events` (`CompassGraphEngine.ts:9-12`). |

**Source (a) totals: 70 rows — C 36 (7 gated/vacuous flagged) · W 19 · N 15 · ? 0.** As found, CX-01 was W: C 35.

---

## 3. Source (c) — what Compass says about itself, measured (20 rows)

| id | Stated contract (where stated) | V | Evidence |
|---|---|---|---|
| CC-01 | Pipeline runs Safety → Eligibility → Live constraints → Privacy → Scoring → Plan B; an excluded item is never scored (`CompassPipeline.ts:3-21`) | **C** | `test/compass-live-constraints.test.ts:234` *"the exclusion happens BEFORE scoring — scoreItem is never called"*. |
| CC-02 | Safety filter FAIL-CLOSED on exception (`CompassSafetyFilter.ts:137-138`) | **C** | `test/compass-hardening.test.ts:267-316` (six hard-filter checks). |
| CC-03 | Eligibility FAIL-OPEN, trust floor 20 applies only to a *known* score (`CompassEligibilityEngine.ts:36, 54-57, 207`) | **C** | `:55-56` `authorTrust !== null && authorTrust < 20` — an absent score passes. Honest, and **vacuous in production**: 56 of 58 users have no `trust_profiles` row, so the floor decides almost nothing. |
| CC-04 | Every tool result is stripped of coordinate-shaped and private keys before reaching the model (`CompassTools.ts:10-12`) | **C** | `:238-250` `PRIVATE_KEY_RE` + recursive `stripCoordinateFields`; applied at `:1185`. |
| CC-05 | *"Eight tools the model may call"* (`CompassTools.ts:4`) | **W → C** | Eleven are declared (`:61-216`; census-layover L102 counted them). Header corrected to eleven and pointed at `TOOL_DEFINITIONS` as the authority. |
| CC-06 | `add_to_trip` proposes only; the server holds the proposal; confirm re-authorizes (`CompassTools.ts:19-21`) | **C** | `:713-726` authorization before proposing; `routes/compass.ts:1779-1827` finds the held proposal in the conversation, refuses resolved/expired ones (24 h TTL, fail-closed on a missing timestamp). |
| CC-07 | *"Below-floor accounts are not surfaced in social answers"* (`CompassTools.ts:844`) | **W → C** | As found (pre-edit `:826-834`), the gate read `{ data: trust }` only and the comment admitted *"fail-open on infra error"*: an **unreadable** `trust_profiles` surfaced a below-floor account for exactly as long as the outage lasted — the same discarded-`error` defect the event gates carried (`10a91737`). Now `:847-856` binds `error` and answers *"not available"*. Absent row still admitted (owner decision D1). |
| CC-08 | `refreshHiddenUsers` *"never widen visibility"* (`CompassTools.ts:277-289, 309`) | **W → C** | As found (pre-edit `:295-297`), with **no** snapshot (`profile` null) and a failed `blocks`/`user_mutes` read it built the base from **empty** hidden lists — every blocked, blocker and muted user un-hidden for that call. Unreachable from `/compass/ask` today (`routes/compass.ts:1434` loads the profile without a `.catch`), but the signature admits null (`:1208`). Now `:301-309` throws with no snapshot, which `executeCompassTool` turns into *"Tool execution failed."* — closed, not empty. |
| CC-09 | A suspended sender is suppressed through safety-filter parity (`CompassNotificationEngine.ts:5-6, 431-436`) | **W → C** | As found (pre-edit `:449-454`), it compared `trust_profiles.public_level === "suspended"` — a value the live CHECK forbids (`trust_profiles_public_level_check`: new_traveler … city_trusted, read from the production catalogue 2026-09-07; census-trust A17 called it dead, confirmed). Suspension lives in `user_account_states` (`lib/circleAccessGuard.ts:72-88`, `lib/http.ts:348-357`). Now `:459-483` reads that table, honours `expires_at`, binds `error` and logs a failed read instead of discarding it. Posture on an unreadable table stays deliver-with-warning, matching the blocked-sender step at `:406-424`. |
| CC-10 | Live-constraint stage gated OFF by an env-guarded constant (`CompassLiveConstraints.ts:36-41, 76-85`) | **C** | `test/compass-live-constraints.test.ts:178-206`; production sets no such variable. |
| CC-11 | Truth boundary: only a Live-band, unexpired, observation-class envelope may exclude; emerging may only nudge (`:19-27`) | **C** | `test/compass-live-constraints.test.ts:266-313`; `test/compassCensusGates.test.ts` D4 re-pins it for the new safety exclusion. |
| CC-12 | *"All Compass services call `isEnabled()`"*; flags read fail-closed (`flags.ts:5, 24-37`) | **C** | `loadFlags` returns `{}` when `data` is null (supabase-js resolves on error → `data` null → every flag false), so an unreadable `feature_flags` turns Compass OFF, not on. |
| CC-13 | `sharesSocialContext` fail-closed (`CompassSocialEngine.ts:436-475`) | **C** | A failed circle read falls through to trips; a failed trip read returns `false` (`:472-474`). No path yields `true` on error. |
| CC-14 | Profile trust read is honest about absence (`CompassProfileService.ts:6, 251-252`) | **C** | `trustScore: trust?.overall_score ?? null` — no `?? 50` anywhere in `compass/` or `routes/compass*.ts` (grep). |
| CC-15 | Graph reads only PUBLISHED, non-`only_me` memories; person nodes store no profile attributes (`artifacts/api-server/src/compass/CompassGraphEngine.ts:767#"published")`, `artifacts/api-server/src/compass/CompassGraphEngine.ts:31#Person nodes store NO profile attributes.`) | **C** | **CITATION REPAIRED — §12.4.** The old cite (`:700-715`, `:698-700`, `:704`) named the CIRCLES builder and a comment about person↔person edges, and had named them since before `3ca68cb06`; repointing it by offset would have carried a wrong citation to a new number. The filter is `artifacts/api-server/src/compass/CompassGraphEngine.ts:767#"published")` + `:768`, the belt-and-braces re-check is `artifacts/api-server/src/compass/CompassGraphEngine.ts:775#!isPublicWorldMemory(r))`, and both go through one predicate, `artifacts/api-server/src/compass/CompassGraphEngine.ts:548#isPublicWorldMemory`. **The verdict is unchanged and the contract now UNDERSTATES the code**: the read is `visibility = 'public'`, not merely `<> 'only_me'` — §11.2's CH-03 note is why. |
| CC-16 | Passport Remembers excludes deleted/removed/hidden source Memories (`PassportRemembersService.ts:393`) | **C** | `:400-402`. |
| CC-17 | Projected-memory prompt is flag-gated, bounded, never fatal (`ProjectedMemoryPrompt.ts:20-26`) | **C (gated)** | `memory_projection` false in production; RPCs at `:110,120` take the caller's own id. |
| CC-18 | Autopilot: propose, never auto-execute; durable pending row; permissions and lock types re-verified at confirm (`CompassAutopilotEngine.ts:66-85`) | **C** | `:598-606` insert with before/after; confirm path `:647-648` applies within re-verified permissions. Its own contract holds — which is exactly why CT-01 is a *kernel* violation and not a *policy* one. |
| CC-19 | Explanation keys carrying a safety/moderation downrank never reveal the reason (`CompassExplanationEngine.ts:8-12, 14-22`) | **C** | `test/compass-hardening.test.ts:576-600`. |
| CC-20 | CANDIDATE RULE: the model never invents candidates; UI blocks validated against the turn's tool results (`CompassTools.ts:236`; `CompassUiBlocks.ts:7-15`) | **C** | `CompassUiBlocks.ts:11-15` *"any id the tools did not return is silently dropped"*. |

**Source (c) totals: 20 rows — as found C 16 · W 4; after this pass C 20.**

---

## 4. Deployment reality (production, aggregate, 2026-09-07)

**Compass is not dark. Compass chat is.**

| Flag | Production | Since |
|---|---|---|
| `COMPASS_ENABLED`, `COMPASS_FEED_ENABLED`, `COMPASS_V1_RULE_BASED_ENABLED`, `COMPASS_DIVERSITY_ENABLED`, `COMPASS_FAIR_EXPOSURE_ENABLED`, `COMPASS_ACTIVE_REWARDS_ENABLED` | **true** | 2026-07-17 |
| `compass_ai_enabled` | **true** | 2026-07-16 |
| `compass_location_context_enabled`, `hidden_gems_compass_enabled`, `layover_compass_enabled`, `map_compass_commands_enabled`, `shared_moments_compass_suggestions_enabled` | true | Jul–Aug |
| `COMPASS_FALLBACK_MODE_ENABLED`, `COMPASS_JOURNEY_*` (3), `intel_compass_rhythm_actor_gate`, `memory_projection`, `wall_compass_handoff_enabled` | false | — |
| `compass_ai_writing_enabled`, `memory_recaps`, `SEARCH_SIGNAL_DECAY_DAYS` | **no row** (fail-closed readers) | — |
| `COMPASS_LIVE_CONSTRAINTS_ENABLED` | env var, not a flag row; unset | — |

| Table | Lifetime rows | Last write | Last 30 days |
|---|---|---|---|
| `compass_preload_events` | 126,450 | 2026-08-27 | 104,435 |
| `compass_recommendation_scores` | 16,807 | 2026-08-21 | 5,481 |
| `compass_served_recommendations` | 119 | 2026-08-16 | 28 |
| `compass_analytics_events` | 102 | 2026-08-16 | 85 |
| `compass_eligibility_logs` | 117 | 2026-07-28 | 0 |
| `compass_notification_decisions` | 17 | 2026-08-16 | 2 |
| **`compass_conversations` / `_messages`** | **10 / 32** | **2026-07-29** | **0 / 0** |
| `compass_outcome_events` | 9 | 2026-07-30 | 0 |
| `compass_user_preferences` | 2 | — | — |
| `compass_feed_cache` | 56 | — | — |
| `compass_memories`, `compass_sense_nudges`, `compass_sense_settings`, `compass_live_sessions`, `compass_feedback_events`, `compass_safety_filter_logs`, **`trip_autopilot_proposals`, `trip_autopilot_settings`** | **0** | — | — |

Consequences for the buckets: the feed/scoring pipeline is live and exercised (thousands of score
rows a month); the ask surface has had **no conversation for 40 days**, so every chat-side row
(tools, memory, UI blocks, proposals, the four fixes in §6) governs a surface nobody is using;
Sense, Live, Autopilot and Memory have **never** written a row. The Trip Kernel violation (CT-01)
has zero lifetime rows behind it.

---

## 5. Claims that are FALSE or stale on measurement

| Claim | Where | Measured |
|---|---|---|
| `COMPASS_V1_RULE_BASED_ENABLED` is *absent* from production | `census-discovery.md:178` | **FALSE — TRUE since 2026-07-17.** The for_you pipeline is on. |
| Nothing consumes explicit intent on the Compass side | `census-passport.md` P42; `census-discovery.md` A18; registry P-05 (*COULD NOT ESTABLISH*) | **FALSE for `get_travel_compatibility`** — `CompassTools.ts:891-915`, pinned by `test/compass-social.test.ts` D2. Still true for the traveler recommendation list (CP-01 `W`). |
| The `add_to_trip` proposal *"is not persisted, has no … `expiresAt`"* | `census-trips.md` TR210, TR26 | **HALF FALSE** — persisted in the conversation message payload (`routes/compass.ts:1794-1814`) with a 24 h TTL (`:1728, :1771-1774`). No `decisionRule`/`affectedObjects` (CT-09 `W`). |
| *"Eight tools the model may call"* | `compass/CompassTools.ts:4` | **FALSE — eleven.** Fixed. |
| Compass writes canonical trip state from two sites (`:206`, `:598`) | registry T-01 and §6; the brief | **FLOOR** — a third: `CompassAutopilotEngine.ts:647-648` updates `trip_plan_items` on confirm; plus `routes/compassAutopilot.ts:229-230, 246-247`. |
| SX-09 Compass half: *"`CompassSafetyFilter.ts:159-197` reads no world safety state"* | registry; census-sensing S66 | **TRUE BUT INCOMPLETE** — the gated live stage *did* read the safety claim and demoted it only against a `quiet` intent (pre-edit `CompassLiveConstraints.ts:392-401`). Worse than not reading it. Fixed under the gate. |
| *"Quiet / High Energy / Nearby / Right Now have no representation"* | census-sensing S72; registry SX-15 | **PARTLY STALE** — `CompassTemporaryIntent` carries `chill`/`party`/`meet_people`/`explore` into ranking. Right Now, Tonight, Nearby, Trip remain absent (4 of 8). |
| Compass uses a *third* redaction shape with `title` = `@username` | the brief for this pass | **NOT WHAT SHIPS** — `title` is the bare username (`routes/compass.ts:3637-3641`); the client prepends `@`. Same shape as Discovery search (census-discovery C19). |
| `CompassNotificationEngine.ts:454` tests a value the CHECK forbids — a dead check | `census-trust.md` A17 | **CONFIRMED** against the production catalogue; replaced (§6 F2). |
| `memory_recaps` *"seeded off (2214)"* | `census-highlights-memories.md` H15 | Production has **no row** — same effect (the reader is fail-closed), recorded for accuracy. |
| `trust_engine_enabled` is off | (widespread; not repeated by any Compass-facing row) | **FALSE** — true since 2026-07-17. Not repeated here. |

---

## 6. What this pass changed (BUILT-BUT-WRONG first)

No user-visible behaviour changes under production settings. F1, F3 and F4 change only what happens
when a database read **fails**; F2 changes what happens for a sender who is **suspended** — and a
suspended account cannot call the API at all (`lib/http.ts:354`), so the only reachable path is a
scheduled notification on behalf of a since-suspended sender. This follows the precedent of
`10a91737` (event trust gates, same session), which treated a discarded-`error` gate as a defect
rather than a feature. No flag was added and **no migration was written or applied** — the
2380–2389 lane is unused by this pass.

| # | Fix | file:line | Closes |
|---|---|---|---|
| F1 | Social trust floor fails closed on an unreadable `trust_profiles`; absent row unchanged | `compass/CompassTools.ts:844-865` | CC-07; CTG-09 (T418); CTR-01 (one of A17's four reads made safe) |
| F2 | Sender-suspension read moved from the dead `trust_profiles.public_level` compare to `user_account_states` (banned/suspended, `expires_at` honoured), `error` bound and logged | `compass/CompassNotificationEngine.ts:443-483` | CC-09; census-trust A17 dead check |
| F3 | `refreshHiddenUsers` with no snapshot and a failed read now throws (tool answers "failed") instead of using an empty hidden set | `compass/CompassTools.ts:277-318` | CC-08; CTG-02 (T219/T220 Compass leg) |
| F4 | A Live `unsafe_density` claim is a hard exclusion for every viewer (`unsafe_density_safety`), gated behind `COMPASS_LIVE_CONSTRAINTS_ENABLED` | `compass/CompassLiveConstraints.ts:112-130, 406-415` | CX-01 (Sensing `:129` SX-09, Compass half) |
| F5 | Header count corrected (eight → eleven tools) | `compass/CompassTools.ts:4-5` | CC-05 |

**Tests:** `src/test/compassCensusGates.test.ts` (15 cases, A–D), registered in
`artifacts/api-server/package.json` between `compass-ux.test.ts` and `compassRhythmGate.test.ts`.
Run with the four pre-existing suites whose behaviour was touched (`compass-social`, `compass-tools`,
`compass-live-constraints`, `compass-ux`): **208 / 208 pass, exit 0**. `pnpm typecheck` exit 0.
`typecheck:tests` 880 / 118 = baseline. `check:test-registration` exit 0.

**Hand-revert proof** (pristine copies restored with `diff -q` identical after each):

| Reverted file | Result on `compassCensusGates.test.ts` | Failing blocks |
|---|---|---|
| `CompassTools.ts` | exit 1 — 13 pass / 2 fail | A (unreadable trust → surfaced), B (null snapshot → empty hidden set) |
| `CompassNotificationEngine.ts` | exit 1 — 11 pass / 4 fail | C (suspended sender delivered; expired/legacy cases) |
| `CompassLiveConstraints.ts` | exit 1 — 13 pass / 2 fail | D1 (no constraint with intent null), D2 (demotion instead of exclusion) |
| all restored | exit 0 — 15 pass / 0 fail | — |

---

## 7. Owner decisions (reported, not made)

| # | Decision | Why it is the owner's |
|---|---|---|
| D1 | Should an account with **no** `trust_profiles` row pass the social trust floor? Today it does (F1 preserves that). 56 of 58 users are in that state; the engine is on and its emitters are starved (5 `trust_events` in 52 days). | The same decision `10a91737` deferred for the event gates (`TRUST_SCORE_WHEN_NO_PROFILE`). |
| D2 | Source the traveler recommendation cards (`routes/compass.ts:3418-3659`) from the Passport `discovery_card` projection, behind a flag seeded FALSE — closes CP-02/P169's Compass leg and retires one of the two direct person-identity readers. Cost: one projection per candidate (≤ 50) or a batch variant Passport would have to publish. | Changes what a user sees; touches Passport's contract. |
| D3 | Build the Sensing `:147` decision vocabulary and `:149` switching cost without a Compass spec? Both are pure functions over signals Compass already has (open-now, event start, live constraints, Plan B), but their *semantics* — when is WAIT right — are product decisions. | No spec to build against. |
| D4 | The Attention Engine (`:176`) has no owner; Compass's priority stack is the closest artefact and is not it. | Cross-surface ownership. |
| D5 | Wire a client caller for `GET /compass/people/:userId/passport` (none exists) or retire it. | Client scope. |
| D6 | 28 named-but-absent tools — 12 Layover, 8 Telegraph, 8 Memory — and 9 of the 12 Trips tools. Which, if any, are in scope? | Scope; three of the four owning surfaces would need to publish the context first. |
| D7 | `COMPASS_LIVE_CONSTRAINTS_ENABLED` is an env var, not a `feature_flags` row (`CompassLiveConstraints.ts:36-41` explains why). Should it become a flag so the F4 exclusion can be switched on without a deploy? | Operational policy. |
| D8 | Compass chat has had no conversation in production for 40 days while the feed pipeline scores thousands of items a month. | Product question, not an engineering one. |

---

## 8. For the Trip Kernel owner (`routes/trips.ts`, kernel design)

Compass needs, from the kernel, exactly two commands and one store:

1. **`ApplyAutopilotProposal(tripId, proposalId, expectedTripVersion)`** — replaces the direct
   `trip_plan_items.update(patch)` at `compass/CompassAutopilotEngine.ts:647-648`. Compass supplies the
   per-item before/after it already persists (`:598-606`); the kernel re-runs `canEditPlan` and the
   lock-type check the engine does today (`:66-85`) and refuses on a version mismatch.
2. **`SetAutopilotPermissions(tripId, userId, patch)`** — replaces the `trip_autopilot_settings`
   upsert at `:206`, if the kernel considers autopilot permissions canonical trip state (they are
   per-user preferences *about* a trip; the owner may rule them out of scope).
3. **A proposal store** the kernel owns — today `trip_autopilot_proposals` is inserted at `:598` and
   its status flipped at `routes/compassAutopilot.ts:229-230, 246-247`; `add_to_trip` proposals live
   inside `compass_conversation_messages` payloads (`routes/compass.ts:1794-1814`). Trips §4's
   `TripProposal` (decisionRule, affectedObjects, expiresAt) would unify both.

All three sites have **zero lifetime rows** in production; there is no data to migrate.

---

## 9. What was NOT done, and why

- **No identity refactor of the traveler list** (D2) — a user-visible change without a spec ruling.
- **No decision layer, no switching cost, no attention engine** (D3, D4) — inventing semantics.
- **No new tools** (D6) — three of the four source surfaces have no projection to consume yet.
- **No edit to `routes/compassAutopilot.ts`** — outside the pass's ownership; reported in §8.
- **No client edits** (CG-01's duplicate starter set, CP-05's rendering) — outside ownership.
- **No migration** — nothing here needed a flag; the env-guarded gate for F4 pre-existed.

## 10. How to reject this denominator

Every excluded candidate is named (§1.1). Every gated or vacuous `C` is flagged so it can be
subtracted: removing the 7 flagged rows from source (a) gives 29 / 70 = **41.4 %** correct. Removing
source (c) entirely gives the inbound-only figures in §0. Removing the four fixed rows from (c) —
on the argument that a contract fixed today should not be counted as met — gives 52 / 90 = 57.8 %.

---

## 10. Re-measured 2026-09-13 — and most of this document was measuring a tree that no longer exists

*Measured at `820b60638`, the commit above this one, which carries the two builds §10.8 describes and
nothing else. Declared as `head_commit` in the Declaration table at the top of this file, replacing
`42aeac38`; that replacement is the only edit this pass makes above this line, and it is recorded
here so it can be judged rather than discovered.*

### 10.1 First, the thing that is not a percentage: ten rows were invisible to the tallier

`pnpm -s check:census-integrity` at `3eaf2436f` read **80** of this document's 90 rows and reported
`C=47 W=18 N=15` — a headline of 72.2 % constructed, 52.2 % correct. This document has never claimed
those numbers. It claims 83.3 % and 62.2 %, and it was right.

The gap was not prose. Every one of the ten missing requirements was **already a table row**; the
tallier could not read its verdict CELL, because ten cells carry a qualifier the parser refuses:

| The shape | Rows carrying it |
|---|---|
| `**W → C**` — an as-found/now pair inside one cell | CC-05, CC-07, CC-08, CC-09 |
| `**C (gated)**` — a verdict plus a deployment note | CG-05, CH-04, CW-02, CC-17 |
| `**W → C (gated)**` — both | CX-01 |
| `**W — violated**` — a verdict plus an emphasis | CT-01 |

`verdictOf` in `artifacts/api-server/src/scripts/checkCensusIntegrity.ts:194#function verdictOf(cell: string)` strips
`*` and the vacuity flags and then requires the WHOLE cell to be one token. `C (GATED)` is not one
token, so the row vanished from every bucket and every denominator. Ten requirements were in no
number this repository reports, and the census that lost them looked fine.

**The other fourteen "id-keyed rows with no verdict" the tool prints for this census are not
requirements and should not be read as a defect**: five are the §6 fixes table (`F1`–`F5`), eight are
the §7 owner decisions (`D1`–`D8`), and one is a §5 claims row that happens to begin `SX-09`. The
honest count of unmeasurable REQUIREMENTS in census-compass was ten, and after §10.4 it is zero.

**This was not fixed by changing the tool.** The two shapes are dropped corpus-wide and other
censuses use them; changing `verdictOf` mid-flight would move other lanes' published numbers without
their consent. The ten rows are restated below in a parseable cell instead, with the qualifier moved
into the reason column where it loses nothing.

### 10.2 Then the thing that is a percentage: nine of eleven verdict moves are OTHER LANES' code

This document was taken at working tree `4a166aeb` on 2026-09-07. Between then and `3eaf2436f` the
Sensing, Trips and Layover lanes built a great deal of what it scores as NOT-BUILT, and nothing aged
it, because the files they built in were not in this census's `CENSUS_SCOPE`. Re-executing the rows —
running the greps their evidence names, rather than re-reading the sentences — moved nine rows before
this lane wrote a line of code.

**Read the two figures separately, because they are not the same kind of thing.**

| Stage | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|
| What the tallier could read at `3eaf2436f` (80 of 90 rows) | 47 | 18 | 15 | 72.2 % | 52.2 % |
| What this document already claimed, and was right about | 56 | 19 | 15 | 83.3 % | 62.2 % |
| Re-measured at `3eaf2436f`, before this lane changed anything | 60 | 24 | 6 | 93.3 % | 66.7 % |
| After this lane's two builds | 61 | 23 | 6 | 93.3 % | 67.8 % |

So of the +21.1 points of CONSTRUCTED and +15.6 points of CORRECT this section publishes:

- **+11.1 / +10.0 is the tallier learning to read.** Nothing was built. Nothing was even
  re-measured. Ten cells were rewritten so a parser could see verdicts the document had stated all
  along.
- **+10.0 / +4.5 is other lanes' construction, measured here for the first time.** Real code, real
  moves, and not this lane's work.
- **+0.0 / +1.1 is this lane's own construction** — exactly one row, CC-05, and what it built is a
  header word and a test. There is no honest way to describe this pass as having constructed
  anything else in Compass.

### 10.3 Row moves

Nine of these are re-measurements of code other lanes shipped; the two CC-05 rows are this lane's.
Every "was" is what the document said at `3eaf2436f`; every "now" is what the tree says.

| id | was | now | why |
|---|---|---|---|
| CX-03 | N | W | The decision vocabulary EXISTS. `artifacts/api-server/src/lib/compassDecision.ts:80#export const COMPASS_DECISIONS` declares exactly the seven the spec names, and `artifacts/api-server/src/routes/compassDecision.ts:4#GO NOW` serves them. The old evidence — *"one unrelated hit"* on a grep — was true when written and is now false. **W, not C:** gated by `artifacts/api-server/src/routes/compassDecision.ts:39#export const COMPASS_DECISION_FLAG`, migration 2800 seeded FALSE, so on every deployment the route answers `feature_disabled`. |
| CX-05 | N | W | Switching cost is `artifacts/api-server/src/lib/compassDecision.ts:91#export const SWITCHING_COST` — a threshold a candidate must beat before the engine says SWITCH, reported per answer. Same route, same FALSE-seeded flag, same reason for W. |
| CT-02 | N | W | `TripCompassProjection` is no longer *"zero occurrences"*: Trips published it and Compass consumes it at `artifacts/api-server/src/compass/CompassTools.ts:779#const built = await buildTripCompassProjection`, imported at `artifacts/api-server/src/compass/CompassTools.ts:46#import { buildTripCompassProjection }`, and it is NOT behind the operational gate. **W, not C:** the duplication the clause forbids is still there — a grep for `.from("trip` across `compass/` returns raw reads of `trips`, `trip_members` and `trip_plan_items` from eight further modules. One tool consumes the projection; the rest of Compass still reads the tables. |
| CT-08 | N | W | Value-of-information is a computation, not a prompt line: `artifacts/api-server/src/compass/CompassTools.ts:1281#questionsWorthAsking` scores unknowns through `artifacts/api-server/src/domain/trips/services/TripValueOfInformation.ts:1#/**` and splits them into `ask` and `representedAsUncertainty`. **W:** it lives inside `get_opportunities`, whose projection is behind `artifacts/api-server/src/domain/trips/policies/tripOperationalProjections.ts:29#export const TRIP_OPERATIONAL_PROJECTIONS_FLAG` — off on every deployment, so the scorer never runs. |
| CT-10 | N | C | The escalation the row said no tool names is now a tool's whole subject. `artifacts/api-server/src/compass/CompassTools.ts:393#§17.3 Trip Rescue` names airline, airport, operator, property, embassy/consulate, local emergency, human support and the crew; `artifacts/api-server/src/compass/CompassTools.ts:1340#const plan = planRescue` calls `artifacts/api-server/src/domain/trips/services/TripRescue.ts:66#export function planRescue`. **C and not gated:** the tool degrades to the problem's generic plan when the impact state cannot be read, so it answers on every deployment. Reachable but exercised by nobody — §4 records no Compass conversation in production for 40 days. |
| CT-11 | N | W | Commercial suppression under a severe state exists and is applied to a list: `artifacts/api-server/src/domain/trips/policies/TripAttentionFilter.ts:115#const kept = items.filter` keeps only safety-and-logistics candidates while the switch says suppress, called from `artifacts/api-server/src/compass/CompassTools.ts:873#const held = applyAttentionSuppression`. **W for two reasons, both named:** it is behind the same operational flag, off everywhere; and it reads TRIP HEALTH, not `safeReturnActive` — the safe-return leg this row's original evidence named is still unguarded. |
| CL-02 | W | C | *"Nothing compares the prose with the deterministic verdict"* is false. `artifacts/api-server/src/services/airport/LayoverCompassService.ts:174#const bounded = enforceCompassEnvelope` reads the answer the model produced, refuses one stating a later deadline or more usable time than the certified record, falls back to the deterministic answer, and reports the attempt in `boundaryViolations` rather than swallowing it. Ungated. |
| CL-06 | N | C | *"has no tool schema and asks nothing"* is false. A question is asked only when re-certifying the session with the candidate answer flipped would move verdict, risk band or usable minutes, and only the single highest-value one: `artifacts/api-server/src/services/airport/LayoverCompassService.ts:206#clarifyingQuestion`. That is the spec's own test for "smallest sufficient number". |
| CL-07 | N | C | *"no test exercises `answerLayoverQuestion` against the engine's numbers"* is false. `artifacts/api-server/src/test/layoverPrivacyCompassContract.test.ts:409#const answer = await answerLayoverQuestion` does exactly that, and `artifacts/api-server/src/test/layoverPrivacyCompassContract.test.ts:44#enforceCompassEnvelope` drives the boundary directly. The contract test §23 asks for exists. |
| CTG-05 | N | C | *"0 of 8 in `CompassTools.ts`"* is false — they are in a sibling module, all eight, and the mapping to §18.3's names is written down rather than inferred: `artifacts/api-server/src/compass/TelegraphConversationTools.ts:67#export const TELEGRAPH_TOOL_SPEC_NAMES` maps `getConversationContext()` through `searchAuthorizedConversationContent()` one-to-one onto the eight `telegraph_*` tools, dispatched at `artifacts/api-server/src/compass/TelegraphConversationTools.ts:624#export async function executeTelegraphConversationTool` and spread into the Compass definition list. No flag. |
| CC-05 | C | W | **Measured backward, and this is the important one.** §3 recorded CC-05 `W → C` on 2026-09-07 by editing the header from "Eight" to "eleven". At `3eaf2436f` the header read *"Fourteen tools the model may call on demand"* and thirty-three were declared. The row was wrong again, by nineteen, one week after being marked correct. |
| CC-05 | W | C | The count is now checked instead of asserted: `artifacts/api-server/src/compass/CompassTools.ts:4#Forty-one tools the model may call on demand` states it, `artifacts/api-server/src/compass/CompassTools.ts:132#number of tools the file header states` carries it as a constant, and `artifacts/api-server/src/test/compassToolCountContract.test.ts:1#/**` asserts the constant equals the definition count AND that the header's number WORD parses to the constant. Both halves are needed: pinning only the constant leaves the prose free to lie. |

### 10.4 The ten unparseable rows, restated so the tallier can count them

No verdict changes here except where §10.3 already moved it. The `was` column reproduces the cell
the document carried; the `now` column is the same verdict in a shape `verdictOf` can read, and the
qualifier it used to carry is written out in full so nothing is lost.

| id | was | now | why |
|---|---|---|---|
| CX-01 | `W → C (gated)` | C | Unchanged verdict. Built and correct, and **inert on every deployment**: the live-constraint stage needs `COMPASS_LIVE_CONSTRAINTS_ENABLED`, an environment variable no deployment sets. Re-executed: `artifacts/api-server/src/compass/CompassLiveConstraints.ts:130#export const UNSAFE_CROWD_LEVEL` still names it and the exclusion still applies to every viewer. |
| CG-05 | `C (gated)` | C | Unchanged. `compass_ai_writing_enabled` has no row in production and the reader is fail-closed, so no AI writing has ever run. |
| CT-01 | `W — violated` | W | Unchanged. Compass still writes canonical trip tables from three engine sites; no kernel command exists to route them through. |
| CH-04 | `C (gated)` | C | Unchanged. `memory_projection` is false in production. |
| CW-02 | `C (gated)` | C | Unchanged. `wall_compass_handoff_enabled` is false in production. |
| CC-05 | `W → C` | C | Superseded twice by §10.3 above — measured W at `3eaf2436f`, then C with a test. This row exists so the cell parses; §10.3's second CC-05 row is the current statement. |
| CC-07 | `W → C` | C | Unchanged. Social trust floor fails closed on an unreadable `trust_profiles`. |
| CC-08 | `W → C` | C | Unchanged. `refreshHiddenUsers` throws rather than building an empty hidden set. |
| CC-09 | `W → C` | C | Unchanged. Sender suspension reads `user_account_states`, not the dead `trust_profiles.public_level` compare. |
| CC-17 | `C (gated)` | C | Unchanged. The projected-memory prompt is flag-gated and the flag is false. |

### 10.5 Reasons that are now wrong, on rows that did NOT move

A verdict can be right for a reason that has expired. These four keep their bucket and lose their
evidence, which is worth more to a reader than a percentage.

| requirement | verdict | the reason that expired |
|---|---|---|
| CX-02 (Sensing `:137` intent modes) | W | *"Two vocabularies exist and neither is this one"* — there are now **three**. `artifacts/api-server/src/lib/compassDecision.ts:83#export const DECISION_INTENTS` is `quiet · social · high_energy · explore`, four of the spec's eight **in the spec's own words**, while `artifacts/api-server/src/compass/CompassTemporaryIntent.ts:40#export const MAP_INTENT_KINDS` still carries the Map §13 nine. Semantically it is still four of eight — Right Now, Tonight, Nearby and Trip are unrepresented — so the verdict holds and the count of vocabularies in the evidence does not. |
| CT-03 (Trips `:185` temporal freedom) | W | The consumption half is now built: `get_freedom_windows` reads the engine's projection. The row stays W because the clause forbids the independent calculation, and `check_trip_conflicts` still derives free time from `trip_plan_items` itself. |
| CT-07 (Trips §12.1 twelve tools) | W | *"3 of 12 exist under other names and 9 are absent"* is false: **twelve of twelve** are declared and dispatched — `get_current_trip`, `get_today_state`, `get_crew_state`, `get_freedom_windows`, `get_commitments`, `get_saved_ideas`, `get_live_conditions`, `simulate_plan`, `create_proposal`, `replan_day`, `find_meeting_point`, `explain_trip_decision`. It stays W on a different fact: four of them build a projection behind `trip_operational_projections_enabled` and answer *"not enabled"* on every deployment. |
| CT-09 (Trips §4 governed proposal) | W | *"What is still missing: `decisionRule`, `affectedObjects`, and a table"* — `decisionRule` now exists as a first-class enum on `create_proposal` (`host` / `majority` / `unanimous` / `anyone`) and is persisted with the proposal. `affectedObjects` still has zero occurrences, so the row stays W with one third of its gap closed. |

### 10.6 What was NOT re-read, said plainly

This section re-executed **all 15 NOT-BUILT rows, all 19 BUILT-BUT-WRONG rows, and 12 of the 56
BUILT-AND-CORRECT rows** — the ones whose evidence names a file another lane has been editing. The
remaining 44 `C` rows were not re-opened. Their citations resolve (`check:doc-citations` exit 0) but
that proves a line exists, not that the sentence about it is still true, and CC-05 is this pass's own
proof that a `C` can rot in a week. **Any of those 44 may be as stale as CT-02 was.** The
production-flag and row-count facts in §4 were read on 2026-09-07 and were not re-read here.

### 10.7 The two denominators: the reason still holds, and it is stronger

§0 states 70 and 90 on purpose — source (a) is what other specs demand of Compass, source (c) is
Compass grading its own homework — and warns that (c) *"lifts the correctness figure by eleven
points"*. Keep it. After this pass the gap is **wider, not narrower**:

| Population | rows | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|---|
| Source (a) — inbound obligations | 70 | 41 | 23 | 6 | 64 / 70 = **91.4 %** | 41 / 70 = **58.6 %** |
| Source (c) — contracts Compass states about itself | 20 | 20 | 0 | 0 | twenty of twenty | twenty of twenty |
| Both | 90 | 61 | 23 | 6 | 84 / 90 = **93.3 %** | 61 / 90 = **67.8 %** |

Compass now scores **every one of the twenty rules it wrote for itself, and 58.6 % of the seventy
other surfaces wrote for it.** A single 67.8 % averages those two populations into a number that
describes neither. **The inbound figure is still the one to trust**, and after this pass the case for
saying so is 41.4 points wide.

### 10.8 What this pass built, and the mutations that proved it

Two builds. One is Discovery's and is recorded in `census-discovery.md` §9; the Compass half is the
tool-count contract.

| what | where | closes |
|---|---|---|
| `COMPASS_TOOL_COUNT_IN_HEADER` beside the definitions, and a test asserting it against the definition count and against the header's own number word | `artifacts/api-server/src/compass/CompassTools.ts:132#number of tools the file header states`, `artifacts/api-server/src/test/compassToolCountContract.test.ts:1#/**` | CC-05, for the third time and the first time executably |

> **INTEGRATION NOTE, added when this lane was merged (2026-09-13).** The count in
> that header is no longer thirty-three: it is **forty-one**. The Highlights &
> Memories lane merged eight §16 Memory accessors into `COMPASS_TOOL_DEFINITIONS`
> in the same integration, and the citation above is repointed to the live text.
>
> **CC-05's verdict does not move, and the reason is the point of the row.** The
> row claims the count is *checked rather than asserted*, and that claim was
> tested by this very merge: the integrator resolved the two lanes' conflicting
> headers to a provisional `33`, and
> `src/test/compassToolCountContract.test.ts` went RED with `expected: 41,
> actual: 33` before anything was pushed. A number in a comment had drifted for
> the fourth time in a week, and for the first time something noticed
> automatically instead of a human re-reading the file. The prose elsewhere in
> this section that says the list has "grown to thirty-three" is left as written:
> it is what was true at this census's declared `head_commit`, and rewriting
> measured history to match a later tree is the habit this document exists to
> refuse.

Mutations, each applied, watched go red, reverted, and the file compared byte-for-byte with its
backup by `cmp`:

| mutation applied | what went red |
|---|---|
| `header word back to "Fourteen"` (the state at `3eaf2436f`) | C2 — 4 pass / 1 fail |
| `COMPASS_TOOL_COUNT_IN_HEADER set to 14` | C1 and C2 — 3 pass / 2 fail |
| `removed the TELEGRAPH spread — eight tools added without touching the count` | C1 — 4 pass / 1 fail |

**P24 — what would turn this green claim red?** A tool declared somewhere the dispatcher reaches but
the definition list does not contain: the count would be right about the array and wrong about the
surface. C3 closes that from the other side by asserting every dispatchable name is in the
definitions. What is NOT closed: a tool reachable through a path that consults neither — nothing in
this repository can currently see such a tool, and this test does not claim to.

**A mutation that would stay green, said out loud:** renaming a tool leaves both the count and the
test untouched, because neither pins the NAMES. CT-07's twelve-of-twelve finding rests on reading
those names, and nothing executable defends it.

### 10.9 CEILING — what is not reachable from here, and why

- **CX-08 (Attention Engine) is unbuildable by an agent and stays N.** Re-verified:
  `artifacts/api-server/src/compass/CompassNotificationEngine.ts:83#export type NotificationOutcome` has
  seven outcomes and **no `wall`**, and no relevance, novelty, half-life, interruption-cost or
  attention-budget term exists anywhere in `compass/`. Owner decision D4 stands: nobody owns this.
- **CX-11 (Opportunity Engine downstream of the kernel) stays N** even though a `TripOpportunityProjection`
  now exists and a tool reads it — that is a *trip* opportunity object behind the operational gate,
  not the shared kernel-downstream object Sensing `:118` describes, and the feed surfaces still build
  candidates directly. Recording it as C would be crediting a different requirement.
- **CL-03 and CL-05 stay N.** A recursive grep for `layover` across `compass/`, `routes/compass.ts`
  and `routes/compassHome.ts` still returns nothing; the twelve layover tools remain absent from a
  tool list that has grown to thirty-three. This is a real, buildable gap and this lane did not build
  it.
- **CH-02 stays N.** Zero of the eight Memory read tools; Memory reaches the prompt as a projected
  block instead.
- **CM-02 stays N.** No plan compiler on Compass's side.
- **The flags that make five of the moves above inert are the owner's.**
  `compass_decision_enabled` (2800), `trip_operational_projections_enabled` (2778, plus the 2760–2785
  schema it needs), `COMPASS_LIVE_CONSTRAINTS_ENABLED`, `memory_projection`,
  `wall_compass_handoff_enabled` and `compass_ai_writing_enabled` are all off or absent. **BUILT ON A
  BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.** Five of the eleven
  moves in §10.3 are W precisely because of that chain, and no percentage in this document should be
  read as saying a traveller can do any of it.
- **Nothing here changes §4.** Compass chat has still had no production conversation since
  2026-07-29. Every tool row above — twelve Trips tools, eight Telegraph tools, the rescue plan —
  governs a surface nobody is using.

### 10.10 Restated headline

> **Compass, at `820b60638`: 90 requirements · 61 BUILT-AND-CORRECT · 23 BUILT-BUT-WRONG ·
> 6 NOT-BUILT · 0 CANNOT-VERIFY → CONSTRUCTED 93.3 % · CORRECT 67.8 %.** Inbound obligations alone
> (70 rows, the figure to trust): CONSTRUCTED 91.4 % · CORRECT 58.6 %. As found at `3eaf2436f`,
> before this lane changed anything: 60 / 24 / 6 / 0. As the tallier could read it at `3eaf2436f`:
> 47 / 18 / 15 / 0 over 80 of 90 rows. Of the move from 52.2 % to 67.8 % correct, **10.0 points are
> the tallier learning to read, 4.5 points are other lanes' code this census had not measured, and
> 1.1 points — one row — is this lane's.**

| BUILT-AND-CORRECT | **61** |
|---|---|
| BUILT-BUT-WRONG | **23** |
| NOT-BUILT | **6** |
| CANNOT-VERIFY | **0** |

---

## 11. The correctness pass, 2026-09-13 — four rows moved, and two of them were moved by code

*Measured at `3ca68cb06`, the commit below this one, which carries the three builds §11.4 describes
and nothing else. Declared as `head_commit` in the Declaration table at the top of this file,
replacing `820b60638`; that replacement and this section are the only edits this pass makes to this
document.*

### 11.0 What this pass was asked to do, and what it actually moved

§10 published a 15.6-point correctness move of which **1.1 points was its own work** — the rest was a
parser learning to read cells and other lanes' code this census had never measured. This pass had no
parser to fix: all 90 rows already parse. So every point below is either code this lane wrote or a
verdict whose stated evidence was **false when re-executed**, and the two are labelled separately
because they are not the same kind of thing.

| Stage | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|
| At `820b60638`, where §10 left it | 61 | 23 | 6 | 93.3 % | 67.8 % |
| Rows whose evidence was FALSE on re-execution (CTR-01, CH-02) | +2 | −1 | −1 | +1.1 | +2.2 |
| Rows this lane BUILT (CX-04, CH-03) | +2 | −2 | 0 | 0.0 | +2.2 |
| **At `3ca68cb06`** | **65** | **20** | **5** | **94.4 %** | **72.2 %** |

**Half of this move is this lane's own code and half is a stale sentence, and the half that is
code is the smaller claim of the two.** Two rows were BUILT-BUT-WRONG for a reason nobody had
attacked; two were graded against sentences that had quietly expired.

### 11.1 The 23 BUILT-BUT-WRONG rows, grouped by WHY they are wrong

Grouped before anything was built, so the group sizes are a measurement and not a description of
what happened to get done. The question asked of each row was: *what exactly stands between this row
and `C`?*

| group | rows | which |
|---|---|---|
| **(a) logic wrong in code this pass owns** | **5** | CX-04 · CH-03 · CT-02 · CT-03 · CP-01 |
| **(b) logic right, nothing reaches it** | **3** | CG-01 · CL-04 · CP-02 |
| **(c) capped by a flag seeded FALSE or an unapplied migration** | **6** | CX-03 · CX-05 · CT-07 · CT-08 · CT-09 · CT-11 |
| **(d) needs something nobody has written** | **8** | CX-02 · CX-10 · CX-15 · CT-01 · CT-12 · CT-13 · CTG-08 · CM-03 |
| **(e) already correct — the row's own evidence had expired** | **1** | CTR-01 |

**Two of the five (a) rows were built and are `C` below. The other three were not, and the reason is
the same one in each case: each needs a user-visible behaviour change on a live route, with no flag
to hide behind, and this pass was forbidden to write a migration.** CP-01 changes who appears in a
traveler list; CT-02 and CT-03 change where eleven modules read trip state from, which is Trips' to
publish before Compass can consume. Naming them (a) rather than (d) is the honest grade: the code
that is wrong is Compass's, and what stops it is a rule about this pass, not a missing contract.

**All three (b) rows are CLIENT files** — `app/(tabs)/ai.tsx` calls the client's starter set instead
of the server's (CG-01), no screen reaches the layover Compass endpoint (CL-04), and no screen calls
`GET /compass/people/:userId/passport` (CP-02). §9 excluded client edits from this census's
ownership and that exclusion still holds; what changed is that CP-02's *server* half is now closed —
see §11.5.

**The (c) six are the chain §10.9 named**, and nothing in this pass can touch it: *BUILT ON A BRANCH
IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG ENABLED.*

### 11.2 Row moves

| id | was | now | why |
|---|---|---|---|
| CX-04 | W | **C** | **Built.** *"Nothing reads the model's prose back against the confidence band of its inputs"* is no longer true. `artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:126#export function readGroundingEvidence` walks the turn's OWN tool results for a `verified_live` source class, a wait datum and a crowd datum; `artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:221#export function enforceCompassGroundingEnvelope` reads the answer back against them and refuses to publish an UNHEDGED current-conditions claim the turn cannot support. Wired on both branches of `/compass/ask` from the same tool log — `artifacts/api-server/src/routes/compass.ts:1350#function groundCompassAnswer` at `artifacts/api-server/src/routes/compass.ts:1671#const _grounded    = groundCompassAnswer(_rawMessage, toolLog);` (streamed) and `artifacts/api-server/src/routes/compass.ts:1743#const _grounded    = groundCompassAnswer(_rawMessage, toolLog);` (not) — and the violations travel on the response instead of being swallowed. **Ungated**: no flag, no migration, runs on every deployment. Pinned by `artifacts/api-server/src/test/compassCensusCorrectness.test.ts:1#/**` block A, ten cases, three mutations. |
| CH-03 | W | **C** | **Built.** *"A graph node built from a memory persists after that memory is deleted … no deletion hook, no per-memory prune"* is closed for the node. **RESTATED AT INTEGRATION — the function this row first named is not the one on the branch.** Two lanes fixed CH-03 independently and in the same file: this lane wrote `pruneOrphanedExperienceNodes`, the Highlights & Memories lane wrote `reconcileExperienceNodes`, and the merge had to keep ONE. The surviving sweep is `artifacts/api-server/src/compass/CompassGraphEngine.ts:1478#export async function reconcileExperienceNodes`, and this lane's screening predicate is the reason it is the one that survived: `pruneOrphanedExperienceNodes` decided eligibility with `state = 'published' AND visibility <> 'only_me'`, while `buildGraphFromSources` now writes only `published` AND `public` rows, so that sweep would have kept every NAMED audience (`friends_only`, `trip_crew`, `circle_only`, `custom`) in the public world model for good — the leak this row exists to close, wearing the fix's name. The survivor decides through `isPublicWorldMemory`, the same predicate the builder gates its write on. This lane's own contributions were kept: the pure `deadExperienceKeys` helper (delete only on a positive answer), the per-batch `undecided` count, and blocks B1–B6 rewritten against the surviving function, with B2 widened to the four named-audience rungs and mutation-proved red under the discarded predicate. It removes an `experience` node and every edge touching it once the source Memory is deleted, unpublished or no longer `public`, and runs inside the daily rebuild BEFORE the world models and the confidence index derive anything from it (`artifacts/api-server/src/compass/CompassGraphEngine.ts:1574#const experienceRevocations = await reconcileExperienceNodes(db);`). The scheduler that calls it is registered unconditionally, so this is ungated. **It is still not a HOOK**, and the row's `C` is for the sweep, not the window: a node survives until the next daily rebuild. Pinned by block B, six cases, three mutations. |
| CTR-01 | W | **C** | **Not built — MEASURED. The row's evidence expired.** It read *"After this pass three remain"* and named three line ranges in `CompassProfileService.ts`, `CompassTools.ts` and `CompassActiveUserRewardEngine.ts`. All three now go through the service seam the requirement names: `artifacts/api-server/src/compass/CompassProfileService.ts:88#getTrustProfileResult(db, userId),`, `artifacts/api-server/src/compass/CompassTools.ts:109#import { getTrustProfileResult } from "../services/trust/TrustScoreService.js";` and `artifacts/api-server/src/compass/CompassActiveUserRewardEngine.ts:207#const read = await getActiveCapsResult(db, userId);`. Executed, not read: `pnpm -s check:trust-table-ownership` → *"891 source file(s) scanned; 21 read(s) inside services/trust; 3 file(s) owned elsewhere with a written reason; 0 violation(s)"*. census-trust A17 closed this from the other side and this census never noticed. |
| CH-02 | N | **C** | **Not built — MEASURED, and it is the CTG-05 move again.** *"0 of 8 in `CompassTools.ts`, lines 65-220"* is false: all eight §16 Memory accessors are declared in a sibling module and spread into the definition list, and the mapping to the spec's names is WRITTEN DOWN rather than inferred — `artifacts/api-server/src/compass/MemoryCompassTools.ts:102#export const MEMORY_TOOL_SPEC_NAMES` maps `getMemory(memoryId)` … `suggestMemoryCorrection(memoryId, patch)` one-to-one onto `memory_get` … `memory_suggest_correction`, declared at `artifacts/api-server/src/compass/MemoryCompassTools.ts:743#export const MEMORY_COMPASS_TOOL_DEFINITIONS` and spread at `artifacts/api-server/src/compass/CompassTools.ts:513#...MEMORY_COMPASS_TOOL_DEFINITIONS,`. No flag. **CH-01 is unaffected and stays `C`**: not one of the eight issues an INSERT, UPDATE or DELETE — the two write-shaped ones return a proposal the user confirms through the existing authenticated routes. |

### 11.3 Reasons that are now wrong on rows that did NOT move

A verdict can be right for a reason that has expired, and §10.6 warned that 44 `C` rows rested on
sentences nobody had re-read. These are the ones this pass re-executed and found stale. Each keeps
its bucket and loses its evidence.

| requirement | verdict | the reason that expired |
|---|---|---|
| CT-01 (Trips `:12` kernel) | W | **"No kernel exists (census-trips TR1)" is FALSE.** The kernel exists and Compass uses it: `artifacts/api-server/src/compass/CompassAutopilotEngine.ts:691#const r = await executeTripCommand(kernel, {` routes the `trip_plan_items` write — the third site this row itself added to the floor — through `executeTripCommand`, keeping the direct update as an explicitly-marked flag-off twin. `create_proposal` does the same (`artifacts/api-server/src/compass/CompassTools.ts:1320#const r = await executeTripCommand(sc, {`) and REFUSES outright when `trip_kernel_enabled` is false. **The row stays W** on a smaller floor: `trip_autopilot_settings` (`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:219#await sc.from("trip_autopilot_settings").upsert(`) and `trip_autopilot_proposals` (`artifacts/api-server/src/compass/CompassAutopilotEngine.ts:622#const { error } = await sc.from("trip_autopilot_proposals").insert({`) are still written directly, as are the route's status flips. The row moves from group (d) to group (c): what stands between it and `C` is now a flag and two write sites, not an absent kernel. |
| CT-02 (Trips `:25` typed projections) | W | *"A grep for `.from("trip` across `compass/` returns raw reads … from eight further modules"* — it is now **eleven**: `CompassTools`, `CompassTripContext`, `CompassProfileService`, `CompassAutopilotEngine`, `CompassFallbackFeedBuilder`, `CompassSocialEngine`, `CompassGraphEngine`, `CompassSenseEngine`, `CompassLiveEngine`, `MemoryRecapsService`, `PassportRemembersService`. The verdict holds and the number in its evidence does not. |
| CX-14 (§6 user dislike ≠ bad venue) | C | *"Feedback writes `compass_feedback_events` and `compass_user_preferences` **only**"* is false by one table: `artifacts/api-server/src/compass/CompassFeedbackEngine.ts:350#.from("compass_recent_context")` upserts a session-suppression list. **The verdict holds** — that is still a per-user preference store with no path to an intel claim, which is what the clause forbids — but the word "only" is now wrong, and this is exactly the shape of drift §10.6 warned about. |

### 11.4 What this pass built, and the mutations that proved it

Three builds, one of which closes rows in two other censuses and is recorded in full in
`census-passport.md` §12 and `census-discovery.md` §10.

| what | where | closes |
|---|---|---|
| A Sensing `:148` OUTPUT boundary: the turn's tool results reduced to a confidence band, and the answer refused against it | `artifacts/api-server/src/compass/CompassGroundingEnvelope.ts:221#export function enforceCompassGroundingEnvelope` | CX-04 |
| A per-memory sweep of `experience` graph nodes and their edges, inside the daily rebuild | `artifacts/api-server/src/compass/CompassGraphEngine.ts:1478#export async function reconcileExperienceNodes` | CH-03 |
| A viewer-aware BATCH list identity projection, adopted by the Compass traveler list | `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:1153#export async function buildListIdentityProjections` | census-passport P169, census-discovery A15; CP-02's server half |

**Why the grounding envelope APPENDS a correction instead of replacing the answer, said plainly
because it is the weakest part of the build.** The layover precedent replaces a refused answer with
a deterministic one, and it can: that answer is one paragraph about one certified record. A Compass
answer is free prose over many candidates, most of it correctly grounded. Worse, `/compass/ask`'s
streamed branch has already sent the tokens — the client rebuilds the bubble from the accumulated
deltas — so a replacement computed after the last token cannot un-say anything. An appended
correction is one more delta and reaches the live bubble with no client change. **The words already
sent are not retracted, and the correction says so.**

Mutations, each applied, run, watched fail, reverted, and compared byte-for-byte with its backup by
`cmp` — identical every time.

| mutation applied | what went red |
|---|---|
| `hasVerifiedLive` hard-coded `true` — every turn claims a live source | A1 — 15 pass / 1 fail |
| the HEDGE exemption disabled — a correctly-labelled sentence is flagged | A3 — 15 / 1 |
| `waitMinutes: null` counted as a wait reading | A7 — 15 / 1 |
| the prune deletes on an unreadable `memories` table | B3 — 15 / 1 |
| one branch of `/compass/ask` unwired from the envelope | C1 — 17 / 1 |
| the `nodeErr` binding dropped | **STAYED GREEN — see below** |

**A mutation that stayed green, and what it cost to fix.** Dropping the `nodeErr` binding changed
nothing observable: an unreadable `compass_graph_nodes` and a graph with no experience nodes both
produced the identical `{0, 0, 0, 0}` report. That is the exact defect `GraphRebuildReport.nodesFailed`
exists to fix *one function above in the same file*, written again by the same hands. The report now
carries `artifacts/api-server/src/compass/CompassGraphEngine.ts:1412#unresolved: boolean;` — RESTATED AT INTEGRATION: the compass lane found this mutation against its own `ExperiencePruneReport.sourceUnavailable`, and that report did not survive the merge with the Highlights & Memories lane's sweep (see CH-03). The surviving report closes the same mutation with `unresolved`, and block B4 still fails when the error binding is dropped
and the mutation fails. **The test was wrong before the code was**, and only a mutation could say so.

**A mutation that would still stay green, said out loud.** The grounding envelope's triggers are
regular expressions over English. A model that writes *"the place is absolutely rammed as of this
second"* — no NOW-marker from the list, no present-progressive crowd shape — is not caught, and
nothing in this repository can currently see such a sentence. The envelope raises the cost of an
ungrounded claim; it does not make one impossible, and CX-04's `C` should be read as "the boundary
exists and is wired", not "prose can no longer over-claim".

### 11.5 CP-02 stays W, and its remainder is now one hop

CP-02 had two halves: *"no client calls `GET /compass/people/:userId/passport`"* and *"the traveler
list still reads `profiles` directly"*. **The second half is closed** —
`artifacts/api-server/src/routes/compass.ts:3791#const travIdentity = await buildListIdentityProjections(`
takes the name rule, the private-preview rule, the picture opt-out and the badge from the Passport
batch projection instead of the fourth inline copy this file carried. The first half is unchanged:
`grep -rn "compass/people/" travel-buddy-standalone/src` still returns nothing. **Owner decision D5
stands and is now the row's whole remainder.**

That inline copy was not merely duplicated, it was WRONG: it read `display_name ?? name ?? username`
without trimming, so a subject whose `display_name` is whitespace rendered as a **blank title** in
the Compass traveler list while every other surface fell through to the handle. See
`census-passport.md` §12 for the full account.

### 11.6 What was re-read, and what was not

This pass re-executed **all 23 BUILT-BUT-WRONG rows** — that is what §11.1's grouping is — and
**eleven `C` rows** chosen because their evidence names a file another lane has been editing: CC-03,
CC-04, CC-14, CC-20, CH-01, CP-03, CP-05, CTG-01, CTR-03, CX-13, CX-14. **One of the eleven was
wrong** (CX-14, §11.3), and it was wrong in its evidence, not its verdict. The remaining **45 `C`
rows were not re-opened**, and §10.6's warning still applies to every one of them: their citations
resolve, which proves a line exists, not that the sentence about it is still true.

The production flag and row-count facts in §4 were read on 2026-09-07 and were **not** re-read here.
Nothing in this section is a production measurement.

**A side-effect worth recording, because it measures the ratchet's own stated limit.** This pass
inserted lines into `routes/compass.ts` and `compass/CompassGraphEngine.ts`, which shifted every
citation into them by up to 72 lines. Eight ANCHORED citations across four censuses broke and
`check:doc-citations` refused the commit until they were repointed — the anchor half doing exactly
what it exists for. Thirty-eight UNANCHORED ones also moved and **nothing noticed**; they were
repointed mechanically from the diff's own hunk map, which preserves whatever they were worth
before. Two of them turned out to be worth nothing already: `census-media.md` cited
`routes/compass.ts:1491` for `buildCompassMediaContext` on four rows, and the call has been at
`artifacts/api-server/src/routes/compass.ts:1554#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, Date.now());`
through several passes. Those four were repointed AND anchored rather than left; the rest were not
re-read, and an unanchored citation nobody re-read is a number, not evidence.

### 11.7 The two denominators — keep them, and the inbound half is where the move happened

| Population | rows | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|---|
| Source (a) — inbound obligations | 70 | 45 | 20 | 5 | 65 / 70 = **92.9 %** | 45 / 70 = **64.3 %** |
| Source (c) — contracts Compass states about itself | 20 | 20 | 0 | 0 | twenty of twenty | twenty of twenty |
| Both | 90 | 65 | 20 | 5 | 85 / 90 = **94.4 %** | 65 / 90 = **72.2 %** |

All four moves are source (a) rows, so the self-graded twenty did not move and cannot have flattered
this. **The inbound figure is still the one to trust**, and the gap between the two populations is
**35.7 points** — narrower than §10.7's 41.4 only because the inbound half improved, which is the
direction that matters.

### 11.8 Restated headline

> **Compass, at `3ca68cb06`: 90 requirements · 65 BUILT-AND-CORRECT · 20 BUILT-BUT-WRONG ·
> 5 NOT-BUILT · 0 CANNOT-VERIFY → CONSTRUCTED 94.4 % · CORRECT 72.2 %.** Inbound obligations alone
> (70 rows, the figure to trust): CONSTRUCTED 92.9 % · CORRECT 64.3 %. Of the 4.4-point correctness
> move from 67.8 %, **2.2 points are two rows this lane built and 2.2 points are two rows whose
> stated evidence was false when re-executed.** The gap between CONSTRUCTED and CORRECT — the W
> column — is **22.2 points**, and 14 of the 20 rows in it wait on a flag, a client, or a contract
> another surface has not published.

| BUILT-AND-CORRECT | **65** |
|---|---|
| BUILT-BUT-WRONG | **20** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **0** |

---

## 12. The W-column pass, 2026-09-13 — four rows built, two moved BACKWARD, and two citations that had been wrong for a week

*Measured on the branch `claude/sweet-fermat-fmx7up` at working tree `d9ab209d7` **plus this pass's
own edits**. This section is APPEND-ONLY: no verdict above it is edited in place. Two citations
ARE repaired in place — §12.4 says which, why that is not a verdict edit, and what each one used to
say. The Declaration table is **not** touched: this pass's own edits age the census (§12.7), and a
lane that ages a document does not get to re-declare it FRESH in the same breath.*

### 12.0 What was asked, and the two kinds of movement in the answer

§11 left the W column at **20 rows — a 22.2-point gap between CONSTRUCTED and CORRECT.** This pass
was asked to close as many as can actually be closed *by building*. It opened all twenty, re-executed
the greps their evidence names, and found the column is two different things wearing one letter:

| Stage | C | W | N | CONSTRUCTED | CORRECT |
|---|---|---|---|---|---|
| At `3ca68cb06`, where §11 left it | 65 | 20 | 5 | 94.4 % | 72.2 % |
| Rows this lane BUILT (CT-11, CP-01, CM-03, CT-13) | +4 | −4 | 0 | 0.0 | +4.4 |
| Rows moved N → W because the row's own `N` evidence was FALSE (CX-11, CL-05) | 0 | +2 | −2 | +2.2 | 0.0 |
| **After this pass** | **69** | **18** | **3** | **96.7 %** | **76.7 %** |

**Read the two rows of movement separately, because only one of them is work.** The +4.4 correctness
points are four rows this lane wrote code for, each pinned by a test that was watched go RED against
the unfixed code. The +2.2 constructed points are not: they are two NOT-BUILT rows whose stated
absence had quietly become false, and recording them makes the W column BIGGER while making the
document truer. That is the direction this pass took every time the two conflicted.

**Four of the twenty could not be closed for a reason that is not "hard".** CX-03, CX-05, CT-07 and
CT-08 are finished code sitting behind a flag seeded FALSE. No amount of building moves them; §12.3
puts a number on that instead of a mood.

### 12.1 Row moves

| id | was | now | why |
|---|---|---|---|
| CT-11 | W | **C** | **Built.** *"Nothing suppresses paid/featured items when `safeReturnActive`"*, and §10.3's later *"it reads TRIP HEALTH, not `safeReturnActive` — the safe-return leg is still unguarded"*, are both closed. `artifacts/api-server/src/compass/CompassSafetyAttention.ts:115#export async function readSafetyAttention` reads the person-scoped severe-safety state (`safe_return_sessions.status = 'active'`) with `error` BOUND, and `artifacts/api-server/src/compass/CompassSafetyAttention.ts:162#export function applySafetyAttention` withholds the commercial and entertainment candidates while it holds — reusing `classifyForAttention`, the Trips §17.2 classifier, rather than inventing a second vocabulary for "commercial". Applied in the feed at `artifacts/api-server/src/compass/CompassPipeline.ts:241#const safetyHeld = applySafetyAttention` **before scoring**, so a withheld candidate is never scored and no score can put it back (the same ordering rule AT-14 gives the live exclusions), and in `search_places` / `search_events` beside the trip-health reading. **UNGATED — no flag, no projection, no migration**, which is the whole point: the trip-health leg is behind `trip_operational_projections_enabled` and is keyed on a trip, and a Safe Return session belongs to the person and exists with no trip at all. Two asymmetries, both stated and both tested: fail-CLOSED on classification (an unclassifiable candidate is withheld), fail-OPEN on the read (a switch that could not be consulted suppresses nothing). Only the "go out and spend" item types are governed (`artifacts/api-server/src/compass/CompassSafetyAttention.ts:75#export const SUPPRESSIBLE_ITEM_TYPES`) — a notification, a person, a trip or a post is not a commercial recommendation, and emptying a traveller's whole feed the moment they start a timer would be a worse behaviour than the clause asks for. Pinned by `artifacts/api-server/src/test/compassCensusClosure.test.ts:1#/**` block A, ten cases, four mutations. |
| CP-01 | W | **C** | **Built.** *"The traveler recommendation list builds `sharedInterests` reason codes and reads no window"* is no longer true. The list now reads the viewer's own explicit intent (`artifacts/api-server/src/routes/compass.ts:3757#const viewerIntentRead = await readVisibleExplicitIntent`) and each candidate's, at the window visibility the viewer is actually entitled to, through the SAME `readVisibleExplicitIntent` seam `get_travel_compatibility` already used — the two people-ranking surfaces no longer disagree about §8. The weighting is `artifacts/api-server/src/routes/compass.ts:4210#export function applyExplicitIntentWeighting`, pure and separate from the route so the rule is proven rather than inferred. **And the generic half moved too**: the local `overlapRatio * 30` is replaced by `artifacts/api-server/src/routes/compass.ts:3641#score += genericInterestWeight`, so "explicit ABOVE generic" is a comparison between two weights from one module (12 vs 4 per match, 36 vs 16 capped) instead of two scales that cannot be compared. Ungated. **Bounded and inert by default**: the per-candidate reads happen only when the VIEWER has an explicit open-to-plans window, over at most 24 candidates, and the boost is zero without an active window on the other side — so ordering changes only where §8 says it should. Pinned by block C, eight cases, four mutations. |
| CM-03 | W | **C** | **Built.** *"'Where should we go after' and 'quieter/cheaper' have no comparator or sequencing concept in `CompassMediaContext.ts`"* is closed with two typed concepts, neither of which can invent a fact. COMPARATOR: `artifacts/api-server/src/compass/CompassMediaContext.ts:185#export function buildComparatorBaselines` reports, per axis, whether a permitted unexpired claim of that axis's own claim type exists for the subject place — `crowd.level` for *quieter*, `price.cover` for *cheaper* (`artifacts/api-server/src/compass/CompassMediaContext.ts:80#export const COMPARATOR_AXIS_CLAIM`), the claim types `lib/intelContracts` already defines. SEQUENCING: `artifacts/api-server/src/compass/CompassMediaContext.ts:210#export function buildSequencingAnchor` gives "after this" a *this* — and when the media location/gem choke point withheld the place there is **no anchor**, `chainable` is false, the city is not carried, and the prompt says the question cannot be answered instead of letting the model pick a plausible one. **No claim VALUE crosses into either block**, which is the rule `permittedIntelligenceRefs` already followed: the adapter says what grounded intelligence exists and leaves reading it to the live/place tools, so a prompt built minutes ago can never assert a current condition. Ungated. Pinned by block B, nine cases, three mutations. |
| CT-13 | W | **C** | **Built.** *"Versioned algorithm: no — `grep -i algorithm CompassAutopilotEngine.ts` → nothing; `compass_algorithm_versions` exists as a table and nothing stamps a proposal with it"* is closed for both kinds of stored suggestion, in the grammar the intel layer already uses for `PROJECTION_ALGORITHM_VERSION` and its two siblings: `artifacts/api-server/src/compass/CompassAlgorithmVersion.ts:48#export const COMPASS_RANKING_ALGORITHM_VERSION` rides in the `ranking_factors` JSONB beside the factor snapshot a served recommendation already stores, and `artifacts/api-server/src/compass/CompassAlgorithmVersion.ts:52#export const COMPASS_AUTOPILOT_ALGORITHM_VERSION` is stamped on every change of every autopilot proposal at `artifacts/api-server/src/compass/CompassAutopilotEngine.ts:562#changes: p.changes.map` — on the way OUT of `buildRepairProposals`, so a ninth repair rule added later cannot forget to stamp itself. `/compass/why` echoes the version **as stored**, never the current constant: a recommendation served by an older rule set must not claim today's. **No migration**: both stamps ride in JSONB that already exists, which is also why the autopilot stamp is per-change rather than per-proposal — that redundancy is the price of not writing a migration and is stated in the module header rather than discovered. **What it does not claim**: nothing mechanically forces a bump, exactly as nothing does for the three intel constants; what §18 asked for and now holds is that a stored suggestion NAMES the rules that produced it. Pinned by block D, six cases, four mutations — one of which stayed green (§12.5). |
| CX-11 | N | **W** | **Not built — MEASURED, and the row moves the wrong way on purpose.** §10.9 argued CX-11 stays N because the only opportunity object was a *trip* one behind the operational gate, *"not the shared kernel-downstream object Sensing `:118` describes"*. That is now false: the shared object exists. `artifacts/api-server/src/lib/opportunityEngine.ts:68#export const OPPORTUNITY_KINDS` is the stage between the kernel and the surfaces, and census-sensing has already moved its own S56 from N to C. **W and not C** for the same two reasons CX-10 is W: it answers only behind `artifacts/api-server/src/routes/opportunities.ts:63#export const OPPORTUNITY_ENGINE_FLAG` (migration 2840, seeded FALSE), and **Compass is not downstream of it** — the feed surfaces still build candidates directly. Recording this costs 2.2 CONSTRUCTED points in the wrong direction for a lane trying to shrink the W column, and it is what the tree says. |
| CL-05 | N | **W** | **Not built — MEASURED.** *"`CompassTools.ts` declares eleven tools, none layover"* was a claim about the wrong file, and §10.9's restatement of it (*"the twelve layover tools remain absent from a tool list that has grown to thirty-three"*) inherited the error. The twelve §12 tools exist, by name and in the spec's order: `artifacts/api-server/src/services/airport/LayoverCompassService.ts:529#export const LAYOVER_TOOL_NAMES`. census-layover reached the same conclusion independently and moved its own L102–L113 from N to W. **W and not C**: none of the twelve is passed to the model, so they are a boundary a route can call and not yet a tool set Compass reasons with. |

### 12.2 Reasons that are now wrong on rows that did NOT move

Every one of the twenty W rows was re-executed. Six keep their bucket and lose their evidence — and
four of the six lose it to the same cause: **the platform objects Sensing's spec names now exist, and
this census was still measuring Compass's local substitutes for them.**

| requirement | verdict | the reason that expired |
|---|---|---|
| CX-10 (Sensing `:118`, `:191` Context Kernel) | W | *"`CompassContextEngine.ts` is an eleven-state machine that is Compass-local … and is consumed by no other surface"* measures the wrong object. **The Context Kernel the clause demands EXISTS**: `artifacts/api-server/src/lib/contextKernel.ts:49#export const KERNEL_CONTEXTS` is §18.1's nine contexts verbatim and in the spec's order, pure, with no viewer id and no coordinate — census-sensing has moved its own S55 to C. The row stays W on a smaller and more actionable fact: the kernel answers only behind 2840's FALSE flag, and **Compass does not consume it** — `compass/` imports `contextKernel` from nowhere. Group (d) *"needs something nobody has written"* → group (c)+(b): a flag and one wiring. |
| CX-15 (Sensing §6 `ExperienceSession`) | W | *"An equivalent exists under another name and a narrower scope … nothing outside Compass can start one"* is false in **both** halves. The object exists under the spec's own name — `artifacts/api-server/src/lib/experienceSession.ts:190#export function openExperienceSession` — and is startable from `routes/experienceSessions.ts`, which is not Compass. It is not a tracking history by five separate mechanisms its own header enumerates (one subject, one open session, no history read, a bounded life, no coordinate), and census-sensing has moved S54 to C. The row stays W because the route is behind `artifacts/api-server/src/routes/experienceSessions.ts:70#export const EXPERIENCE_SESSION_FLAG` (migration 2841, seeded FALSE). Group (d) → (c). |
| CT-12 (Trips §16 friend nearby → meetup) | W | *"`get_whos_around` … produces presence, not an opportunity"* is answering a question nobody is now asking. The opportunity exists, WITH the reciprocity the clause demands: `artifacts/api-server/src/domain/trips/services/TripSignals.ts:399#if` drops a one-sided case as `TRIP_PRIVACY_SCOPE` and only a `bothSharing` signal becomes a `meetup_opportunity` — and **Compass consumes it**, through `get_live_conditions` → `buildTripPulseProjection`. The row stays W because that projection is behind `trip_operational_projections_enabled`. census-trips has moved its own TR304 to C. Group (d) → (c). |
| CL-04 (Layover §25 Compass row) | W | Two of its four clauses have expired and one contradicts this document's own CL-06. *"The endpoint is unreachable from the app"*: census-layover records an importer and a mounted card for `askCompass` since its §10. *"No tools"*: the twelve exist (CL-05 above). *"No clarification"*: **CL-06 in §10.3 of this very document is `C` for exactly that clarification**, so the two rows have disagreed for two sections. What remains true, and is now the whole reason: no tool is passed to the model, and there are no proactive OpportunityEvents. |
| CT-09 (Trips §4 governed proposal) | W | *"`affectedObjects` still has zero occurrences"* is false as the corpus grep it was stated as — there are eight, at `artifacts/api-server/src/routes/tripDecisions.ts:207#affectsElementIds:` and its tests. They belong to §9.3's decision object, **not** to the proposal `create_proposal` creates, which still carries none. The verdict holds and gains a second reason the row did not have: `create_proposal` REFUSES outright when `trip_kernel_enabled` is false, so the governed proposal is gated as well as incomplete. |
| CX-02 (Sensing `:137` intent modes) | W | *"Three vocabularies"* (§10.5) is stable, but the near-miss is worth naming so the next reader does not mistake it for a fourth: `tonight` and `near_your_area` DO exist in Compass — as **feed section names** in `CompassFeedBuilder`, not as intent modes on shared intelligence. `artifacts/api-server/src/lib/compassDecision.ts:83#export const DECISION_INTENTS` is still four of eight, and Right Now, Tonight, Nearby and Trip are still unrepresented as intents. |

**Two W rows were re-executed and found completely intact**, which is worth as much as a correction:
CT-02 (still exactly eleven `compass/` modules reading `.from("trip*")` directly) and CTG-08
(`artifacts/api-server/src/compass/CompassSocialEngine.ts:436#export async function sharesSocialContext`
is still a fourth resolver; `grep -rn TelegraphRelationship` over `src/` returns **0** — the canonical
model census-telegraph T379 asks for does not exist anywhere yet). CG-01 too: the client still calls
its own `buildCompassStarters` at `app/(tabs)/ai.tsx:399`, and census-input-intelligence G359 is
still W.

### 12.3 The residual, as a number: the four-way test over all 18 W rows

The question asked of each: *would a production deploy and a flag flip, with NO code change, make
this row true?*

| class | count | rows |
|---|---|---|
| **OWNER** — deploy + flag flip closes it; nothing left to build | **6** | CX-03 · CX-05 · CX-15 · CT-07 · CT-08 · CT-12 |
| **BOTH** — needs a flag AND code | **7** | CX-10 · CX-11 · CT-01 · CT-03 · CT-09 · CL-04 · CL-05 |
| **BRANCH** — code alone closes it; no flag is in the way | **5** | CX-02 · CG-01 · CT-02 · CP-02 · CTG-08 |
| **NEITHER** | **0** | — |

**Six of eighteen are finished.** CX-03 and CX-05 wait on `compass_decision_enabled` (2800);
CT-07 and CT-08 on `trip_operational_projections_enabled` (2778); CT-12 on the same;
CX-15 on `experience_session_enabled` (2841). Every one of those flags is seeded FALSE and none of
them is Compass's to flip. **BUILT ON A BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS
NOT FLAG ENABLED** — and after this pass that chain, not missing code, is the single largest thing
standing between Compass and its inbound obligations.

**The five BRANCH rows are the honest backlog**, and three of them are not this census's to write:
CG-01 and CP-02 are CLIENT files (`app/(tabs)/ai.tsx` and a caller for
`GET /compass/people/:userId/passport` that does not exist — owner decision D5), and CTG-08 needs
Telegraph to publish a canonical relationship model before Compass can consume one. That leaves
**CX-02 and CT-02 as the two rows a Compass-owned branch could close with nobody's permission** —
and CX-02 is the one owner decision D3 already warned has no spec to build against.

### 12.4 The two citations that were wrong before this pass, and are wrong no longer

§11.6 recorded that repointing an already-wrong citation by offset *"would carry a wrong citation to
a new number"*, and deliberately left two rather than do that. Both are now repaired by finding the
code the row actually means and anchoring to it. **Neither verdict moves; both stay exactly where
they were.** This is the one kind of in-place edit this section makes, and it is recorded here so it
can be audited rather than discovered.

| row | what it said | what was there | what it says now |
|---|---|---|---|
| CC-15 | `CompassGraphEngine.ts:700-715, 37-40` for the contract; `:698-700` filter + `:704` re-check for the evidence | `:698-700` is a comment about person↔person circle edges; `:700-715` and `:704` are the **circles** builder — `.select("id, owner_id, city, visibility, created_at")`. Nothing in either range reads a memory. | The filter at `:767`/`:768`, the belt-and-braces re-check at `:775`, and the one predicate both go through at `:548`. **The contract now UNDERSTATES the code**: the read is `visibility = 'public'`, not merely `<> 'only_me'` — §11.2's CH-03 note is why, and the row's `C` is stronger than its own sentence claims. |
| CTG-03 | `routes/messaging.ts:2723` for *"a report invalidates the Compass cache"* | A message-**tagging** side-effect (`params: { taggerHandle, … }`), inside a `try` that logs *"message tagging side-effect failed (non-fatal)"*. It has nothing to do with reports or with Compass. | The two real sites, both anchored: `:3435` (`thread_report`) and `:3662` (`message_report`). The `/compass/telegraph` range and the fallback builder's line were repointed and anchored in the same edit. |

**A third class of citation was repaired mechanically, and is worth separating from those two.** This
pass inserted lines into `compass/CompassTools.ts`, `compass/CompassPipeline.ts`,
`compass/CompassMediaContext.ts` and `routes/compass.ts`, displacing **62 anchored and 128 unanchored
citations across twelve documents**. Every one was repointed by looking up the EXACT ORIGINAL LINE
TEXT at `HEAD` and finding that same text in the working tree — never by adding an offset, and never
by nearest candidate. 172 of the 190 resolved to a line whose text is unique in the file; the rest
were disambiguated by a diff opcode map that only ever matches identical lines. One citation was
invisible to that sweep because it was written as a bare `` `:1947#…` `` continuation with no path —
the shape §11.2 of census-layover taught `check-doc-citations` to refuse — and it is now spelled out
in full in `census-highlights-memories.md`.

### 12.5 The mutations

Every claim in §12.1 was executed: the test written first, watched go RED against the unfixed code,
then the fix applied. Each mutation below was applied to the shipped code, run, watched fail,
reverted, and the file compared byte-for-byte with its backup by `cmp` — **identical every time**.

| mutation applied | what went red |
|---|---|
| the pipeline computes the suppression and never applies it (`attended = survivors`) | A1, A2 — 8 pass / 2 fail |
| `readSafetyAttention` drops the `error` binding — an unreadable table reads as "no session" | A7 — 9 / 1 |
| classification fails OPEN — an unclassifiable candidate is kept under suppression | A1, A5 (+A3) — 7 / 3 |
| the pipeline governs EVERY item type, not just the commercial ones | A3 (+A1, A4) — 7 / 3 |
| an EXPIRED claim still counts as a comparator baseline | B3 — 18 / 1 |
| a withheld anchor still leaks its city through the sequencing block | B5 — 18 / 1 |
| any claim grounds any comparator axis (the axis→claim-type binding dropped) | B2, B3 — 17 / 2 |
| the `hasActiveWindow` gate ignored — intent with no open window still boosts | C3 — 26 / 1 |
| the generic term no longer uses the shared weight | C8 — 26 / 1 |
| a boosted traveler's reason code left unchanged | C2 — 26 / 1 |
| the viewer's own explicit-intent read dropped from the route | C8 — 26 / 1 |
| the ranking snapshot loses its version stamp | D3 — 32 / 1 |
| `/compass/why` substitutes the CURRENT constant for the STORED one | D6 — 32 / 1 |
| the version grammar accepts free text | D1, D2 — 32 / 1 |
| autopilot stamps only `changes[0]` | **STAYED GREEN — see below** |

**The mutation that stayed green, and what it cost to fix.** Stamping only the first change of each
proposal was indistinguishable from stamping all of them, because every proposal the D5 fixture
produced carried exactly ONE change. The test asserted a `for` loop over a one-element array and
called it "every change". The fixture now also drives the cancellation-recovery branch, which
produces a proposal with a cancel AND a pull-forward, and D5 asserts outright that one proposal
carries more than one change before it checks them. **The test was wrong before the code was**, and
only a mutation could say so — the same lesson §11.4's `nodeErr` mutation taught one section ago,
learned again by different hands in a different file.

**A mutation that would still stay green, said out loud.** Nothing forces `COMPASS_RANKING_ALGORITHM_VERSION`
to be bumped when a weight changes. A stale version is a wrong version, and D1–D6 cannot see one:
they pin the GRAMMAR and the STAMPING, never the freshness. CT-13's `C` should be read as "a stored
suggestion names its rule set", not "the name is guaranteed current".

### 12.6 What was re-read, and what was not

This pass re-executed **all 20 BUILT-BUT-WRONG rows** — that is what §12.2 and §12.3 are — and
**all 5 NOT-BUILT rows**, which is where CX-11 and CL-05 came from. **The 65 `C` rows were not
re-opened**, except CC-15 and CTG-03, whose citations were repaired without re-reading their
verdicts. §10.6's warning therefore still stands over 63 of them, and it has now been borne out
three times in three sections (CC-05, CX-14, and CC-15's citation): *their citations resolve, which
proves a line exists, not that the sentence about it is still true.*

The production flag and row-count facts in §4 were read on 2026-09-07 and were **not** re-read here.
Nothing in this section is a production measurement.

### 12.7 This section ages this census, and says so

`CENSUS_SCOPE["census-compass.md"]` watches `artifacts/api-server/src/compass/` and
`artifacts/api-server/src/routes/compass.ts`. This pass edited six files under them —
`CompassSafetyAttention.ts` and `CompassAlgorithmVersion.ts` (new), `CompassPipeline.ts`,
`CompassTools.ts`, `CompassMediaContext.ts`, `CompassAutopilotEngine.ts` — and `routes/compass.ts`.
**census-compass is therefore STALE from this commit, deliberately and by its own rule.** The
Declaration table above is left untouched: the four builds in §12.1 are exactly the kind of change
that should age a census, and a lane that both edits the code and re-declares the document FRESH in
the same commit has removed the only signal that would have caught it. The `head_commit` to declare
is **the commit that carries this section and its six files**, and declaring it is the integrating
lane's call, not this one's.

### 12.8 Restated headline

> **Compass, after §12: 90 requirements · 69 BUILT-AND-CORRECT · 18 BUILT-BUT-WRONG ·
> 3 NOT-BUILT · 0 CANNOT-VERIFY → CONSTRUCTED 96.7 % · CORRECT 76.7 %.** Inbound obligations alone
> (70 rows, the figure to trust): 49 C · 18 W · 3 N → CONSTRUCTED 95.7 % · CORRECT 70.0 %. Source
> (c), the twenty contracts Compass states about itself, is unmoved at twenty of twenty — every row
> that moved in this section is an inbound one, so the self-graded half cannot have flattered it.
> Of the 4.4-point correctness move from 72.2 %, **all of it is four rows this lane built**; the
> 2.2-point CONSTRUCTED move on top of that is two NOT-BUILT rows whose absence had become false,
> and it made the W column bigger. The gap between CONSTRUCTED and CORRECT — the W column — is
> **20.0 points**, down from 22.2, and **13 of the 18 rows in it wait on a flag** (6 OWNER + 7 BOTH)
> rather than on code somebody has not written.

| BUILT-AND-CORRECT | **69** |
|---|---|
| BUILT-BUT-WRONG | **18** |
| NOT-BUILT | **3** |
| CANNOT-VERIFY | **0** |
