# Census — Compass (the surface with no spec and no census)

*Built against branch `claude/portava-continuation-uqta94` on 2026-09-07, working tree at `4a166aeb`
plus uncommitted sibling work. Server code under `artifacts/api-server/src/` unless a path says
otherwise. Every BUILT verdict cites a `file:line` opened during this pass. Production figures are
aggregate counts read from the production project on 2026-09-07 (read-only; no user row was selected).*

---

## Declaration

| Field | Value |
|---|---|
| `head_commit` | `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
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
| CX-03 | `:147` Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | **N** | `grep -rniE "go_now|go soon|goSoon|switch_cost" compass/ routes/compass*.ts` → one unrelated hit (`routes/compass.ts:145`, timezone comment). Compass returns ranked items, nudges and Plan B (`CompassLiveConstraints.ts:711`), never a decision. |
| CX-04 | `:148` Ground natural-language claims in structured truth | **W** | More grounding exists than the registry credited: the CANDIDATE RULE (`compass/CompassTools.ts:227`), a CONFIDENCE RULE that forbids claiming live status without `verified_live` data (`:231`), factor-grounded "why this" (`CompassRecommendationEngine.ts:23-27`; `routes/compass.ts:945-958`), and UI blocks that drop any id the tools did not return (`CompassUiBlocks.ts:11-15`). All of it is **input**-side or **reference**-side; nothing reads the model's prose back against the confidence band of its inputs. The failure the spec names (*"low-confidence dance_likelihood → 'everyone is dancing'"*) is prevented only by prompt text. |
| CX-05 | `:149` Current Experience value introduces switching cost | **N** | Zero occurrences of `switching`/`switch_cost` in `compass/` and `routes/compass*.ts`. |
| CX-06 | `:150` Home consumes a server-assembled `UserNowProjection`/equivalent | **C** | `routes/compassHome.ts:1-20` — one endpoint assembling bestNextMove, circleActivity, startingSoon, tonightVibe, weatherWindow; `:285` the single route. Name absent, equivalent present (registry SX-24). |
| CX-07 | `:151` Home = "what matters now"; Compass = "what should I do about it" | **C** | `routes/compassHome.ts:285` vs `routes/compass.ts:1303` (`POST /compass/ask`). |
| CX-08 | `:176` Attention Engine is mandatory before NOTIFY / WALL / SILENT / IGNORE | **N** | `compass/CompassNotificationEngine.ts:4-27` is a ten-level priority stack with quiet hours and mutes: a send/suppress filter with no relevance, novelty, half-life, interruption-cost or attention-budget term and no WALL outcome (`:83-90` — the outcome union has no `wall`). Nobody owns this engine (registry SX-45). |
| CX-09 | `:19` Existing Compass paths keep functioning while new projections are partial or gated | **C** | Live intel enters Compass only through the fail-closed `readLiveClaimEnvelopes` seam (`CompassLiveConstraints.ts:11-18`, returns `[]` when anything is off); the stage itself is env-gated OFF (`:76-85`); a disabled `COMPASS_ENABLED` returns an honest fallback envelope (`routes/compassHome.ts:19-20`); `flags.ts:24-37` turns an unreadable `feature_flags` into "every flag off". |
| CX-10 | `:118`, `:191` Context Kernel assembling nine contexts, consumed by all surfaces | **W** | `compass/CompassContextEngine.ts:6-17` is an eleven-state machine that is Compass-local; it has no World, Experience or Attention context and is consumed by no other surface (registry SX-54). |
| CX-11 | `:118` Opportunity Engine downstream of the kernel | **N** | Each Compass surface builds candidates directly (`CompassItemHydrator.ts:7-11`, `CompassFeedBuilder.ts:4-9`); no shared opportunity object (census-sensing S46/S56). |
| CX-12 | `:119` Feature clients must not independently calculate crowd, vibe, safety or opportunity — the Compass client | **C** | `travel-buddy-standalone/src/features/map/compass/compassMapModel.ts:8` *"Compass does not create live facts; it reasons over structured state"* (census-map M104, M288). |
| CX-13 | §6 Product surfaces consume projections; do not reimplement engine logic (S47) | **C** | `compass/CompassMediaContext.ts:26-33` and `CompassLiveConstraints.ts:11-18` both read through `lib/liveClaimRead` and *"never read a snapshot, claim or observation row"*. |
| CX-14 | §6 User dislike ≠ bad venue (S16) | **C** | `compass/CompassFeedbackEngine.ts:23-27` — feedback writes `compass_feedback_events` and `compass_user_preferences` only; no path to an intel claim. |
| CX-15 | §6 `ExperienceSession` bridges opportunity → action → outcome without being a tracking history (S54) | **W** | An equivalent exists under another name and a narrower scope: `compass/CompassOutcomeEngine.ts:4-19` ties recommended → viewed → saved → went → stayed → liked → invited → made_memory → returned back to `compass_served_recommendations`. It bridges a *recommendation* to an outcome, not a *world opportunity*; nothing outside Compass can start one. |

### 2.2 Global Input Intelligence spec — 5 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CG-01 | `:8` Compass consumes the shared layer; no surface builds its own assistance engine | **W** | The client duplicates the server's starter set: `travel-buddy-standalone/src/…/compass/compassPrompt.ts` re-implements `buildCompassStarters` and `app/(tabs)/ai.tsx:399` calls the client one (census-input-intelligence G359 `W`). Client-side; recorded, not edited. |
| CG-02 | `:150-152` Compass prompt: contextual starters based on current surface | **C** | census-input-intelligence G88 `C` (`projection.ts:258-304`), confirmed by the client wiring at `app/(tabs)/ai.tsx:398-410` (G364). |
| CG-03 | `:160-163` Context carryover bounded to the task; Compass prompt carries Trip context; no silent preference rewrite | **C** | Trip context is attached server-side on every ask (`compass/CompassTripContext.ts:1-11`, called at `routes/compass.ts:1459-1463`) and as structured refs on starters (G364). Boundedness: `CompassTemporaryIntent.ts:14-20` *"reads no profile and writes nothing, so it CANNOT rewrite a preference"*; `compass/CompassSearchDecayService.ts:5-9` decays a search nudge so it *"doesn't permanently skew"* the feed. |
| CG-04 | `:213` Compass: convert phrase into structured request/action with referenced entities | **C** | G137 `C` (`semanticIntent.ts:231-268` produces `open_compass` with the parse); the drop is on the *search bar's* client (G305), not Compass's — `app/(tabs)/ai.tsx:98-104` consumes `prefillMessage`. |
| CG-05 | `:216-229` AI-assisted writing for Compass is opt-in, editable, never silently inserted | **C (gated)** | G138/G143 `C`; `compass_ai_writing_enabled` has **no row** in production `feature_flags` (verified 2026-09-07), and `aiWriting.ts:80-90` reads it fail-closed, so no AI writing has run. |

### 2.3 Trips spec — 13 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CT-01 | `:12` No Compass component may independently invent canonical trip state; consequential changes pass through the Trip Kernel | **W — violated** | No kernel exists (census-trips TR1). Compass writes canonical trip tables from **three** engine sites, one more than the registry lists: `compass/CompassAutopilotEngine.ts:206` (`trip_autopilot_settings` upsert), `:598` (`trip_autopilot_proposals` insert), and **`:647-648` (`trip_plan_items` `.update(patch)` when a proposal is confirmed)**; plus `routes/compassAutopilot.ts:229-230,246-247` (proposal status). The engine re-verifies permissions and lock types at confirm (`:66-85`), which is the right *policy* on the wrong *path*. Floor, not ceiling: `.rpc(` in `compass/` is three memory RPCs and one search-signal upsert (`CompassSearchDecayService.ts:87`); no dynamic `.from(expr)` on a trip table. **Production: 0 rows in both autopilot tables** — the violation is structural, not yet a data fact. Owner: Trip Kernel sibling (§8). |
| CT-02 | `:25`, `:373`, `:488` Consume typed Trip projections (`TripCompassProjection`) rather than duplicating Trip semantics | **N** | `TripCompassProjection`: zero occurrences (census-trips TR360 `N`). Compass reads raw `trip_members`/`trips`/`trip_plan_items` (`CompassTools.ts:412-459`; `CompassTripContext.ts:17-21`). Trips' to publish; not closable from Compass. |
| CT-03 | `:185` Consume Temporal Freedom windows rather than independently calculating free time | **W** | No engine exists (TR131), and Compass calculates free time itself in **two** places: `CompassTools.ts:142-156, 647-701` `check_trip_conflicts`, and `compass/CompassSenseEngine.ts:245-246` `free_time_block` (*"no plan item starts within the next 3 hours"* from `trip_plan_items`). census-trips TR133 scores the *consumption* `N`; this row scores the *independent calculation* the clause forbids, which is built and wrong. |
| CT-04 | `:234` Compass may create a proposal but cannot silently mutate others' commitments | **C** | census-trips TR155 `C`: `CompassTools.ts:15-17`, `:161` *"never writes anything"*, `:230`; re-verified. |
| CT-05 | `:278` Authority bound: no bypassing authorization, no invented canonical facts, no relaxed safety, no expanded freedom, no mutation outside the policy path | **C** | TR215–TR219 `C`: `CompassTools.ts:721-726` (`isAcceptedTripMember` + `canEditPlan` before proposing), `:238-250` `sanitizeToolResult`; re-verified. The autopilot confirm write is carried by CT-01, not double-counted here. |
| CT-06 | `:283` Trips remain operational without Compass | **C** | TR222 `C` (`routes/index.ts:146,173,251-254`; `test/tripsHostingDegraded.test.ts`). |
| CT-07 | §12.1 The twelve Compass tools (`getTripContext` … `findMeetingPoint`) | **W** | 3 of 12 exist under other names — `get_current_trip` (TR202 `W`, `CompassTools.ts:76-80`), `get_whos_around` (TR204 `W`), `add_to_trip` (TR210 `W`) — and 9 are absent (TR203, 205–209, 211–212 `N`). |
| CT-08 | §12.3 Value-of-information before asking the traveller | **N** | TR220 `N`; `CompassTools.ts:226` instructs *"CALL the matching tool instead of guessing"* — nothing scores a question. |
| CT-09 | §4 `TripProposal` as a governed object (decision rule, affected objects, expiry) | **W** | **Corrects TR26/TR210** (*"not persisted… no expiresAt"*): the proposal **is** persisted, inside the conversation message payload (`routes/compass.ts:1745-1765` reads `pendingProposals`/`resolvedProposals`), with a 24 h TTL that fails closed on a missing timestamp (`:1728`, `:1771-1774`). What is still missing: `decisionRule`, `affectedObjects`, and a table any *other* participant could see. |
| CT-10 | §15 Compass must escalate to airline / airport / embassy / emergency / human support where appropriate | **N** | No Compass tool or prompt rule names an institution; `services/safeReturn` is not imported by `CompassTools.ts` (TR217). census-trips TR328 credits SafeReturn's contact flow — that is not Compass. |
| CT-11 | §17 Commercial recommendations suppressed when a severe operational/safety state requires attention | **N** | `safety_mode` reaches ranking only as a context boost for `notification`-type items (`compass/CompassScoringEngine.ts:272`); nothing suppresses paid/featured items when `safeReturnActive` (TR319 *"unguarded absence"*). |
| CT-12 | §16 Friend nearby → meetup opportunity, subject to both parties' privacy | **W** | `get_whos_around` is real and privacy-correct (`CompassTools.ts:179-184`; `CompassSocialEngine.ts:350-379` every target through `canViewCirclePresenceBatch`, fail-closed per target) but produces presence, not an opportunity (TR304). |
| CT-13 | §18 Automated suggestions explainable from stored inputs and a versioned algorithm | **W** | Stored inputs: yes — every autopilot proposal persists `reason` and per-item before/after `changes` (`CompassAutopilotEngine.ts:598-606`), and every served recommendation persists its factor snapshot (`routes/compass.ts:945-958`). Versioned algorithm: no — `grep -i "algorithm\|version" CompassAutopilotEngine.ts` → nothing; `compass_algorithm_versions` exists as a table and nothing stamps a proposal with it. |

### 2.4 Layover spec — 7 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CL-01 | `:59` Compass may converse about a layover but does not own feasibility | **C** | census-layover L16 `C`: `services/airport/LayoverCompassService.ts:51-68` recomputes `hardReturnTime` itself; model text reaches only `answer`. |
| CL-02 | `:63`, `:886` Hard safety cannot be overridden by Compass prose | **W** | L3/L101 `W`: structured fields safe by construction; the prose is checked only by prompt text (`LayoverCompassService.ts:71-79`) and a coordinate regex (`LayoverPrivacyGuard.ts:100-106`). Nothing compares the prose with the deterministic verdict. The prose is Compass's, so the row is Compass's. |
| CL-03 | `:66`, `:803` One canonical `LayoverSnapshot` drives Compass; no duplicate time-budget logic | **N** | `grep -rli layover compass/ routes/compass.ts routes/compassHome.ts` → **nothing** (confirms L-03). The only Compass-flavoured layover code lives in `services/airport/` and is reachable only from `routes/airport.ts`. |
| CL-04 | `:748-764` §25 Compass row: tool access to certified context, proactive OpportunityEvents, explanation/clarification | **W** | L268 `W`: explanation only, no tools, no OpportunityEvents, no clarification — and the endpoint is unreachable from the app (layover headline defect 4). |
| CL-05 | §12 Twelve layover tools (`getLayoverContext` …) | **N** | L102–L113 `N`: `CompassTools.ts:61-216` declares eleven tools, none layover. |
| CL-06 | §12 Ask the smallest sufficient number of clarifying questions | **N** | L114 `N`; `LayoverCompassService.ts:90-97` has no tool schema and asks nothing. |
| CL-07 | §23 Contract tests that Compass cannot override deterministic safety fields | **N** | L237 `N`; no test exercises `answerLayoverQuestion` against the engine's numbers. |

### 2.5 Passport spec — 5 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CP-01 | `:94` Weight explicit current intent above generic interests | **W** | **Corrects census-passport P42 / census-discovery A18 / registry P-05** (*"nothing consumes it"* / *COULD NOT ESTABLISH*): `compass/CompassTools.ts:872-896` reads both travellers' explicit windows through `readVisibleExplicitIntent` + `getActiveWindows` at the caller's permitted visibility and applies `explicitIntentBoost` — pinned by `test/compass-social.test.ts` D2. But that is **one of two** people-ranking surfaces: the traveler recommendation list at `routes/compass.ts:3369-3600` builds `sharedInterests` reason codes and reads no window (`grep -i intent` over `:3400-3480` → nothing). |
| CP-02 | `:207-221` Compass consumes its Passport projection variant; §35 does not rebuild identity independently (P100, P169) | **W** | Half-closed since census-passport: `GET /compass/people/:userId/passport` (`routes/compass.ts:4198-4232`) serves `discovery_card` through `buildConsumerProjection` behind the fail-closed `allowDiscoveryPersonCard` gate (`services/passport/PassportConsumerAccess.ts:62-90`). But **no client calls it** (`grep -rn "compass/people/" travel-buddy-standalone/src` → nothing), and the traveler list still reads `profiles` directly — `routes/compass.ts:3369-3376` selects `username, display_name, name, avatar_url, …` — one of the two real direct person-identity readers in the tree (census-discovery C33). Owner decision D2 in §7. |
| CP-03 | `:263` A Passport block propagates into Compass social recommendations | **C** | P120 `C`; re-verified at the two Compass legs: `routes/compass.ts:3350-3366` reads `blocks` **with** `blkErr` bound and answers `block_check_failed` with an empty list (fail-closed), and `CompassTools.ts:1172-1182` re-resolves hidden users per social tool call. |
| CP-04 | §18 Shared context → Compass handoff | **C** | P87 `C` (`SharedContextService.compassHandoff:40-61` → `app/(tabs)/ai.tsx:98-104`). |
| CP-05 | Universal display-name rule (`.agents/memory/display-name-privacy.md`): `@handle` unless opted in; self exempt; via `nameVisibilitySet` | **C** | `routes/compass.ts:3556` `nameVisibilitySet(sc, …)` batched; `:3578-3582` `title` = real name iff `nameOk`, else the **bare** username (null for private non-followed); `data.displayName` null unless `nameOk` (`:3590`). The list excludes the viewer (`:3374` `.neq("id", user.id)`), so the self-exemption cannot be violated here. The client renders `@` from the bare username (`components/compass/CompassTravelerRow.tsx:57-60` via `primaryIdentityText`). **The brief's "third shape, `title`=`@username`" is not what ships** — title is the bare username and this is the *same* shape census-discovery C19 found in Discovery search. |

### 2.6 Telegraph spec v1.1 — 9 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CTG-01 | `:87` Availability expiry revokes across Compass | **C** | The only availability Compass consumes is read live: `CompassTools.ts:59` imports `getActiveWindows` (*"explicit-only, expiry re-evaluated on read"*, `:872-873`), called per tool call at `:889-892`; nothing stores a copy. |
| CTG-02 | `:285` Block cascade into Compass retrieval; no subsystem rediscovers a blocked relationship | **C** | T219 Compass leg `C`: `CompassTools.ts:281-309` `refreshHiddenUsers` per social call; feed-side `CompassSafetyFilter.ts:120-121` conditions 1–2. One hole closed this pass (§3.C CC-08). |
| CTG-03 | `:369`, `:578` Deleted/unsent objects removed from Compass retrieval | **C ⌀** | Compass retrieves **no message content**: `/compass/telegraph` (`routes/compass.ts:4009-4200`) reads `message_thread_members`, `message_threads`, `trips`, `profiles` — never `messages`; the fallback builder reads membership only (`CompassFallbackFeedBuilder.ts:389`). A report invalidates the Compass cache (`routes/messaging.ts:2723`, T276). Vacuous in the one place it could matter. |
| CTG-04 | `:621` Unavailable/Invisible revokes Compass availability projections promptly | **C** | Same read-time path as CTG-01; presence honours pauses/visibility per target through `canViewCirclePresenceBatch` (`CompassSocialEngine.ts:376-379`). |
| CTG-05 | §18.3 Eight conversation tools (`getConversationContext` … `searchAuthorizedConversationContent`) | **N** | T244–T251: 0 of 8 in `CompassTools.ts:61-216`; `create_meetup_draft` exists outside Compass (`routes/telegraphCommands.ts:34`). |
| CTG-06 | §18.3 Compass sees only data authorized to the conversational context | **C** | T252 `C` (`services/telegraphChatSuggestions.ts:18,81,152-163`; `routes/telegraphChat.ts:17-21`). |
| CTG-07 | §18.3 No cross-participant leak, no impersonation, no silent canonical plan | **C** | T253 `C` (`CompassTools.ts:232` SOCIAL RULES; `requires_confirmation: true`). |
| CTG-08 | §30A.1 Canonical relationship model; no independent inference | **W** | T379 `W`: `sharesSocialContext` (`CompassSocialEngine.ts:436-475`) is a fourth relationship resolver with its own vocabulary — correct and fail-closed, not canonical. |
| CTG-09 | §30A.13 Private policy signals constrain, never exposed as a score | **C** | T418 `C`: `CompassTools.ts:835-856` consults `overall_score` as a floor and answers uniformly *"not available"* — never why. Made fail-closed on an unreadable table this pass (CC-07). |

### 2.7 Highlights / Memories spec — 4 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CH-01 | `:460-461` Compass is a consumer of Memory facts; must not mutate canonical facts through prose | **C** | H129 `C`: the tool set has no Memory mutation (`CompassTools.ts:61-216`); `forgetMemory` at `routes/compass.ts:2145` writes `compass_memories` (a chat store), not `memories`. |
| CH-02 | `:462-469` Eight Memory read tools (`getMemory`, `searchMemories`, `getSharedMemories`, `getPlaceHistory`, `getTripMemories`, `getMemoryEvidence`, `createMemoryDraft`, `suggestMemoryCorrection`) | **N** | 0 of 8 in `CompassTools.ts:61-216`. Resolves the registry's H-01 *COULD NOT ESTABLISH*: established absent. Memory reaches the prompt as a projected block instead (CH-04). |
| CH-03 | `:742` Never keep deleted Memories in Compass projections | **W** | Compass's own reads are clean: `CompassGraphEngine.ts:697-703` selects `state = published` and `≠ only_me` (*"belt and braces"* re-check at `:704`); `PassportRemembersService.ts:396-402` drops `deleted/removed/hidden`; the prompt block goes through `memory_retrieve`/`memory_rediscover` (`ProjectedMemoryPrompt.ts:110,120`), Memories-owned RPCs. But a graph **node** built from a memory persists after that memory is deleted: the only pruning is of stale city/time-slice keys (`CompassGraphEngine.ts:1198-1250`); no deletion hook, no per-memory prune. The node carries anchors only (`:693-694` *"never the title, caption or media"*), which bounds the leak to "this owner was at this place/trip/event" — a derived fact of a deleted memory, kept until the next rebuild. |
| CH-04 | `:528` `CompassMemoryProjection` — minimal authorized retrieval facts | **C (gated)** | Equivalent under another name: `compass/ProjectedMemoryPrompt.ts:1-27` — bounded, UGC-wrapped, flag-gated (`memory_projection`, **false in production**), service-role RPC with the caller's own id. |

### 2.8 Media spec — 4 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CM-01 | `:294-304` `CompassMediaContext { mediaAssetId, entityRefs, viewerContext, permittedIntelligenceRefs }` | **C** | `compass/CompassMediaContext.ts:8-12` and the four privacy rules at `:15-35`; consumed at `routes/compass.ts:1484` (MD242–MD246 `C`). |
| CM-02 | `:178` Convert a Trail / Trip recap / itinerary into an executable Compass plan | **N** | MD107 `W` from Media's side (the action adds trip-plan items); on Compass's side no plan compiler exists. Resolves registry MD-05 *COULD NOT ESTABLISH*: absent. |
| CM-03 | §32 The nine questions (*worth going now · find similar · still busy · where is this · build a plan · what's nearby · where after · quieter/cheaper · add to Trip*) | **W** | Four carried (MD246, MD250, `create_plan`, `add_to_trip`); "where should we go after" (MD252) and "quieter/cheaper" (MD101) have no comparator or sequencing concept in `CompassMediaContext.ts`. |
| CM-04 | §33 Compass owns recommendation/decision support; the engine stays propose-only | **C** | MD436 `C`: `CompassMediaContext.ts:12-13` *"does NOT fork the Compass engine; the engine stays propose-only"*. |

### 2.9 Map spec — 3 rows · 2.10 Wall spec — 2 rows · 2.11 Trust — 3 rows

| id | Obligation | V | Evidence |
|---|---|---|---|
| CMP-01 | Map `:162` Compass does not create live facts | **C** | M104/M288 `C` (`compassMapModel.ts:8,191`). |
| CMP-02 | Map §13 TemporaryIntent is a separate, request-scoped addend to Compass ranking — never written back | **C** | `compass/CompassTemporaryIntent.ts:1-29`; `compass/types.ts:74`; census-map M97/M102 `C`. |
| CMP-03 | Map `:162` Compass Map Mode: 3–5 best next moves with a WHY panel | **C** | M103/M105 `C` (`compassMapModel.ts:67-68, 212-223`); server surface `GET /compass/recommendations` (`routes/compass.ts:3115`). |
| CW-01 | Wall `:146` Compass references canonical objects in responses/actions | **C** | `compass/CompassUiBlocks.ts:7-15` — every block reference validated against the turn's tool results; unknown ids dropped. |
| CW-02 | Wall `:143` Ask Compass from a place-linked post | **C (gated)** | W85 `C`; `wall_compass_handoff_enabled` is **false** in production (2026-09-04). |
| CTR-01 | Trust §35 Consume Trust through the canonical read (`getDisplayTrustScore`) | **W** | census-trust A17: four direct reads in Compass. After this pass **three** remain — `CompassProfileService.ts:86-89` (→ `null` when absent, `:251-252`, never substituted), `CompassTools.ts:846-849` (floor, now fail-closed), `CompassActiveUserRewardEngine.ts:188-199` (`trust_caps`). The fourth (`CompassNotificationEngine.ts:450`, pre-edit) read a value the column cannot hold and is replaced (§6 F2). |
| CTR-02 | Trust TABLE 22: permitted trust summary for the Compass person card | **C** | census-trust A14 `C`; served by CP-02's endpoint. `confidence` is wrong there (P50) and is Passport's (#467). |
| CTR-03 | Sensing `:182-183` Compass never scores a person from passive movement (SX-47/48) | **C ⌀** | No Compass module reads `location_snapshots`/`journey_observations` (`grep` over `compass/` → nothing); the Graph reads `memories`, `user_stamps`, `trips`, `events` (`CompassGraphEngine.ts:9-12`). |

**Source (a) totals: 70 rows — C 36 (7 gated/vacuous flagged) · W 19 · N 15 · ? 0.** As found, CX-01 was W: C 35.

---

## 3. Source (c) — what Compass says about itself, measured (20 rows)

| id | Stated contract (where stated) | V | Evidence |
|---|---|---|---|
| CC-01 | Pipeline runs Safety → Eligibility → Live constraints → Privacy → Scoring → Plan B; an excluded item is never scored (`CompassPipeline.ts:3-15`) | **C** | `test/compass-live-constraints.test.ts:234` *"the exclusion happens BEFORE scoring — scoreItem is never called"*. |
| CC-02 | Safety filter FAIL-CLOSED on exception (`CompassSafetyFilter.ts:137-138`) | **C** | `test/compass-hardening.test.ts:267-316` (six hard-filter checks). |
| CC-03 | Eligibility FAIL-OPEN, trust floor 20 applies only to a *known* score (`CompassEligibilityEngine.ts:36, 54-57, 207`) | **C** | `:55-56` `authorTrust !== null && authorTrust < 20` — an absent score passes. Honest, and **vacuous in production**: 56 of 58 users have no `trust_profiles` row, so the floor decides almost nothing. |
| CC-04 | Every tool result is stripped of coordinate-shaped and private keys before reaching the model (`CompassTools.ts:6-8`) | **C** | `:238-250` `PRIVATE_KEY_RE` + recursive `stripCoordinateFields`; applied at `:1185`. |
| CC-05 | *"Eight tools the model may call"* (`CompassTools.ts:4`) | **W → C** | Eleven are declared (`:61-216`; census-layover L102 counted them). Header corrected to eleven and pointed at `TOOL_DEFINITIONS` as the authority. |
| CC-06 | `add_to_trip` proposes only; the server holds the proposal; confirm re-authorizes (`CompassTools.ts:15-17`) | **C** | `:713-726` authorization before proposing; `routes/compass.ts:1730-1778` finds the held proposal in the conversation, refuses resolved/expired ones (24 h TTL, fail-closed on a missing timestamp). |
| CC-07 | *"Below-floor accounts are not surfaced in social answers"* (`CompassTools.ts:835`) | **W → C** | As found (pre-edit `:826-834`), the gate read `{ data: trust }` only and the comment admitted *"fail-open on infra error"*: an **unreadable** `trust_profiles` surfaced a below-floor account for exactly as long as the outage lasted — the same discarded-`error` defect the event gates carried (`10a91737`). Now `:847-856` binds `error` and answers *"not available"*. Absent row still admitted (owner decision D1). |
| CC-08 | `refreshHiddenUsers` *"never widen visibility"* (`CompassTools.ts:268-280, 309`) | **W → C** | As found (pre-edit `:295-297`), with **no** snapshot (`profile` null) and a failed `blocks`/`user_mutes` read it built the base from **empty** hidden lists — every blocked, blocker and muted user un-hidden for that call. Unreachable from `/compass/ask` today (`routes/compass.ts:1407` loads the profile without a `.catch`), but the signature admits null (`:1208`). Now `:301-309` throws with no snapshot, which `executeCompassTool` turns into *"Tool execution failed."* — closed, not empty. |
| CC-09 | A suspended sender is suppressed through safety-filter parity (`CompassNotificationEngine.ts:5-6, 431-436`) | **W → C** | As found (pre-edit `:449-454`), it compared `trust_profiles.public_level === "suspended"` — a value the live CHECK forbids (`trust_profiles_public_level_check`: new_traveler … city_trusted, read from the production catalogue 2026-09-07; census-trust A17 called it dead, confirmed). Suspension lives in `user_account_states` (`lib/circleAccessGuard.ts:72-88`, `lib/http.ts:348-357`). Now `:459-483` reads that table, honours `expires_at`, binds `error` and logs a failed read instead of discarding it. Posture on an unreadable table stays deliver-with-warning, matching the blocked-sender step at `:406-424`. |
| CC-10 | Live-constraint stage gated OFF by an env-guarded constant (`CompassLiveConstraints.ts:36-41, 76-85`) | **C** | `test/compass-live-constraints.test.ts:178-206`; production sets no such variable. |
| CC-11 | Truth boundary: only a Live-band, unexpired, observation-class envelope may exclude; emerging may only nudge (`:19-27`) | **C** | `test/compass-live-constraints.test.ts:266-313`; `test/compassCensusGates.test.ts` D4 re-pins it for the new safety exclusion. |
| CC-12 | *"All Compass services call `isEnabled()`"*; flags read fail-closed (`flags.ts:5, 24-37`) | **C** | `loadFlags` returns `{}` when `data` is null (supabase-js resolves on error → `data` null → every flag false), so an unreadable `feature_flags` turns Compass OFF, not on. |
| CC-13 | `sharesSocialContext` fail-closed (`CompassSocialEngine.ts:436-475`) | **C** | A failed circle read falls through to trips; a failed trip read returns `false` (`:472-474`). No path yields `true` on error. |
| CC-14 | Profile trust read is honest about absence (`CompassProfileService.ts:6, 251-252`) | **C** | `trustScore: trust?.overall_score ?? null` — no `?? 50` anywhere in `compass/` or `routes/compass*.ts` (grep). |
| CC-15 | Graph reads only PUBLISHED, non-`only_me` memories; person nodes store no profile attributes (`CompassGraphEngine.ts:690-705, 37-40`) | **C** | `:698-700` filter + `:704` re-check. |
| CC-16 | Passport Remembers excludes deleted/removed/hidden source Memories (`PassportRemembersService.ts:393`) | **C** | `:400-402`. |
| CC-17 | Projected-memory prompt is flag-gated, bounded, never fatal (`ProjectedMemoryPrompt.ts:20-26`) | **C (gated)** | `memory_projection` false in production; RPCs at `:110,120` take the caller's own id. |
| CC-18 | Autopilot: propose, never auto-execute; durable pending row; permissions and lock types re-verified at confirm (`CompassAutopilotEngine.ts:66-85`) | **C** | `:598-606` insert with before/after; confirm path `:647-648` applies within re-verified permissions. Its own contract holds — which is exactly why CT-01 is a *kernel* violation and not a *policy* one. |
| CC-19 | Explanation keys carrying a safety/moderation downrank never reveal the reason (`CompassExplanationEngine.ts:8-12, 14-22`) | **C** | `test/compass-hardening.test.ts:576-600`. |
| CC-20 | CANDIDATE RULE: the model never invents candidates; UI blocks validated against the turn's tool results (`CompassTools.ts:227`; `CompassUiBlocks.ts:7-15`) | **C** | `CompassUiBlocks.ts:11-15` *"any id the tools did not return is silently dropped"*. |

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
| Nothing consumes explicit intent on the Compass side | `census-passport.md` P42; `census-discovery.md` A18; registry P-05 (*COULD NOT ESTABLISH*) | **FALSE for `get_travel_compatibility`** — `CompassTools.ts:872-896`, pinned by `test/compass-social.test.ts` D2. Still true for the traveler recommendation list (CP-01 `W`). |
| The `add_to_trip` proposal *"is not persisted, has no … `expiresAt`"* | `census-trips.md` TR210, TR26 | **HALF FALSE** — persisted in the conversation message payload (`routes/compass.ts:1745-1765`) with a 24 h TTL (`:1728, :1771-1774`). No `decisionRule`/`affectedObjects` (CT-09 `W`). |
| *"Eight tools the model may call"* | `compass/CompassTools.ts:4` | **FALSE — eleven.** Fixed. |
| Compass writes canonical trip state from two sites (`:206`, `:598`) | registry T-01 and §6; the brief | **FLOOR** — a third: `CompassAutopilotEngine.ts:647-648` updates `trip_plan_items` on confirm; plus `routes/compassAutopilot.ts:229-230, 246-247`. |
| SX-09 Compass half: *"`CompassSafetyFilter.ts:159-197` reads no world safety state"* | registry; census-sensing S66 | **TRUE BUT INCOMPLETE** — the gated live stage *did* read the safety claim and demoted it only against a `quiet` intent (pre-edit `CompassLiveConstraints.ts:392-401`). Worse than not reading it. Fixed under the gate. |
| *"Quiet / High Energy / Nearby / Right Now have no representation"* | census-sensing S72; registry SX-15 | **PARTLY STALE** — `CompassTemporaryIntent` carries `chill`/`party`/`meet_people`/`explore` into ranking. Right Now, Tonight, Nearby, Trip remain absent (4 of 8). |
| Compass uses a *third* redaction shape with `title` = `@username` | the brief for this pass | **NOT WHAT SHIPS** — `title` is the bare username (`routes/compass.ts:3578-3582`); the client prepends `@`. Same shape as Discovery search (census-discovery C19). |
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
| F1 | Social trust floor fails closed on an unreadable `trust_profiles`; absent row unchanged | `compass/CompassTools.ts:835-856` | CC-07; CTG-09 (T418); CTR-01 (one of A17's four reads made safe) |
| F2 | Sender-suspension read moved from the dead `trust_profiles.public_level` compare to `user_account_states` (banned/suspended, `expires_at` honoured), `error` bound and logged | `compass/CompassNotificationEngine.ts:443-483` | CC-09; census-trust A17 dead check |
| F3 | `refreshHiddenUsers` with no snapshot and a failed read now throws (tool answers "failed") instead of using an empty hidden set | `compass/CompassTools.ts:268-309` | CC-08; CTG-02 (T219/T220 Compass leg) |
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
| D2 | Source the traveler recommendation cards (`routes/compass.ts:3369-3600`) from the Passport `discovery_card` projection, behind a flag seeded FALSE — closes CP-02/P169's Compass leg and retires one of the two direct person-identity readers. Cost: one projection per candidate (≤ 50) or a batch variant Passport would have to publish. | Changes what a user sees; touches Passport's contract. |
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
   inside `compass_conversation_messages` payloads (`routes/compass.ts:1745-1765`). Trips §4's
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
