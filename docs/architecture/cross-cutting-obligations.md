# Cross-Cutting Obligations — the requirements one spec places on another spec's surface

*Built against the repository at branch `claude/portava-continuation-uqta94`, working tree at
`48b90bbb` plus uncommitted sibling-agent work, on 2026-09-07. This document measures nothing new
about any single spec. It measures the **seams between specs** — the requirements that a reader of
one spec, and of that spec's census, cannot see.*

**This document exists because of a specific, verified misdirection on this branch.** Every census
run so far measured ONE spec in isolation, and every per-spec percentage is therefore an answer to
a narrower question than the one readers ask of it.

---

## The instance that forced this document

`Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:141` (§9, *Required
Tweaks: Wall*) requires:

> Add a server-built `WallMoment` / equivalent projection with subject, transition, occurred_at,
> relevance window, reason, truth class, freshness and expiry.

Verified facts:

| Fact | Verification |
|---|---|
| `WallMoment` has **zero occurrences** outside `docs/` | `grep -rI --exclude-dir={node_modules,.git,docs} WallMoment .` → no output |
| `docs/architecture/census-wall.md` mentions Sensing **zero times** | `grep -ci sensing docs/architecture/census-wall.md` → 0 |
| `census-wall.md` mentions `WallMoment` **zero times** | same grep → 0 |
| `census-sensing.md` counts it as **S74, NOT-BUILT**, inside its own 127 denominator | `census-sensing.md:270` |
| `census-sensing.md` references the Wall **16 times** | `grep -c Wall census-sensing.md` |

So **"Wall 95.1 % constructed / 91.7 % correct"** (`census-wall.md:15-20`) is true *against the
Wall's own spec* and is **not** a statement about everything Portava requires of the Wall. The
obligation is not lost — it is **filed under Sensing's 51.2 %** rather than deducted from the
Wall's 91.7 %. A reader of the per-spec table concludes the Wall is nearly done. It is not.

**This is not a Sensing-only phenomenon.** Section 3 below names the other cross-cutting specs.

---

## Scope, method, and the counting rule

**What counts as a cross-cutting obligation here.** One distinct assertion in spec A that a
*named surface other than A's own subject* must have (or must not have) some property. Where one
sentence names N surfaces, it is counted as **one** obligation with N owing surfaces; the fan-out
is stated in the row. Diagrams, ASCII pipelines and pure prose rationale are excluded, exactly as
the sibling censuses exclude them.

**Sources read.** All eleven `docs/specs/*.txt`. The `.docx` originals were **not** re-extracted
in this pass — `census-sensing.md:6-8` records that the Sensing `.txt` and `.docx` are
byte-identical after whitespace normalisation, and the sibling censuses record the same for their
own specs; where a divergence would change a verdict here I say so. **Could not establish:**
whether the `.docx` originals of the Trips and Global Input Intelligence specs diverge from their
`.txt` — no census has tested those two, and this pass did not extract them.

**Censuses read** (`docs/architecture/`, all eight that existed at the end of this pass):
`census-highlights-memories.md`, `census-layover.md`, `census-map.md`, `census-media.md`,
`census-passport.md`, `census-sensing.md`, `census-telegraph.md`, `census-wall.md`.
`census-media.md` still carried `PLACEHOLDER_CONS` / `PLACEHOLDER_CORR` headline values when read
(`census-media.md:16-18`) — its row-level verdicts are cited here, its headline is not.
**No `census-trips.md` and no `census-input-intelligence.md` existed at any point during this
pass**, re-checked at the end. That absence is the single largest driver of Section 6.

### Two inherited caveats, both load-bearing

1. **A `from("table")` grep misses variable and RPC access.** That exact error was made on this
   branch and wrongly reported `memory_events` as unreferenced.
   `artifacts/api-server/src/scripts/checkWriterlessReads.ts:39` states *"A dynamic `.from(expr)`
   anywhere makes attribution incomplete"* and `:344-345` that the check *"errs toward silence: an
   unattributable write means a table is NOT reported."* Every table-access claim below inherits
   that caveat and is written as *"no direct `.from()` write found"*, never *"no writer exists"*.
2. **Absence of a NAME is not absence of a RESPONSIBILITY.** `UserNowProjection` has zero
   occurrences, yet `routes/compassHome.ts` discharges its responsibility
   (`census-sensing.md:281`, S81 BUILT-AND-CORRECT). Every "zero occurrences" row below therefore
   separately asks whether an equivalent exists under another name, and says so.

---

## 1. Which specs turned out to be cross-cutting

Mention matrix, produced by counting whole-word occurrences of each surface name in each spec
`.txt` (`grep -ow`). Read the rows: a spec with high counts *outside its own column* is placing
demands elsewhere.

| Spec | Wall | Map | Compass | Trips | Telegraph | Passport | Memories | Layover | Discovery | Media |
|---|---|---|---|---|---|---|---|---|---|---|
| **Sensing** | **9** | 11 | 13 | 5 | 5 | 4 | 3 | 5 | 8 | 0 |
| **Global Input Intelligence** | 0 | 5 | **12** | 4 | 6 | 2 | 1 | 0 | 3 | 3 |
| **Layover** | 0 | 15 | **19** | 9 | 3 | 5 | 1 | *19* | 4 | 0 |
| **Trips** | 0 | 11 | **15** | *12* | 3 | 7 | 0 | 1 | 5 | 0 |
| **Passport** | 0 | 8 | 8 | 9 | 4 | *38* | 9 | 0 | 6 | 0 |
| **Media** | 0 | 18 | 13 | 8 | 2 | 7 | 3 | 0 | 5 | *49* |
| **Map** | 0 | *36* | **23** | 4 | 1 | 4 | 2 | 0 | 3 | 0 |
| **Telegraph v1.1** | 0 | 5 | 16 | 10 | *30* | 0 | 10 | 0 | 6 | 7 |
| **Highlights / Memories** | 0 | 0 | 8 | 2 | 1 | 8 | *23* | 0 | 1 | 8 |
| **Wall** | *34* | 7 | 11 | 3 | 1 | 2 | 0 | 0 | 5 | 7 |
| **Media** *(own column italic)* | — | — | — | — | — | — | — | — | — | — |

*Italic = the spec's own subject. Bold = the largest cross-surface count in that row.*

### The answer to "is Sensing the only cross-cutting spec"

**No. Ten of the eleven specs place obligations on surfaces they do not own.** They divide into
three kinds:

| Kind | Specs | How the obligation is worded |
|---|---|---|
| **Declared platform layer** — the spec says outright it is not owned by the surfaces that must consume it | **Global Input Intelligence**, **Sensing** | GII line 8: *"This is not owned by Discovery, Media, Map, Trips, Telegraph, Compass, or Create. Those surfaces consume it through a shared platform layer."* Sensing line 6: *"extends Portava's existing intelligence, map, discovery, wall, Compass, Trips, Telegraph, Memories, safety, and projection infrastructure"*, then eleven per-surface **"Required Tweaks"** sections (§7–§17). |
| **Named integration matrix** — a section that enumerates other surfaces and what each owes | **Layover** (§25 Portava integration points, lines 748–764; §3 domain boundaries, lines 100–124), **Trips** (lines 25, 488), **Passport** (§21, lines 207–221), **Map** (§20 data ownership, line 11), **Media** (lines 423–445) | *"Trips — Detect connection; show Layover card/status; pass flight segments into session creation"* (Layover:749) |
| **Boundary prohibition** — a rule binding a *different* surface's behaviour | **Trips** (line 12), **Telegraph** (lines 25, 285, 606–607), **Highlights/Memories** (§16, lines 461, 742, 582), **Media** (§29, line 277), **Wall** (lines 119, 148), **Map** (lines 143–145, 162, 264) | Trips:12 — *"No Map, Compass, Telegraph, Discovery, Buddy, or UI component may independently invent canonical trip state"* |

The only spec that places **no** obligation on another spec's surface is, arguably, the **Wall**
spec — and even it has four (§17, §22, §11, §33; see Section 2.J). So: **all eleven are
cross-cutting to some degree; Sensing and Global Input Intelligence are cross-cutting by design
and by declaration.**

### A structural finding that outranks the matrix

**The most-obligated surface in Portava has no spec and no census.** `Compass` is referenced by
**every one of the eleven specs** (8–23 mentions each) and is the demanded consumer in Sensing
§10, Layover §12/§25, Trips §12, Passport §18/§21, Highlights §16, Telegraph §18.3, Media §32,
Map §14 and GII §7/§21/§22. There is **no `Portava_Compass_*` spec in `docs/specs/`** (verified by
`ls`) and **no `census-compass.md`** (verified by `ls docs/architecture/census-*.md`). The same is
true of **Discovery**, **Home**, **Safety/Trust**, **Presence**, **Rent-a-Buddy**, **Locate My
Friends**, **Hidden Gems**, **Search**, **Create** and the **Attention Engine**.

Consequence: for those surfaces, **every** obligation on them is a cross-cutting obligation, and
the only measurement any of them has ever received is whatever a *demanding* spec's census
happened to record. There is no denominator anywhere against which "how much of Compass exists"
could be asked.

---

## 2. The registry — every cross-cutting obligation found

**108 obligations** across ten specs. Columns:

- **Owes** — the surface that must do the work.
- **Exists?** — `YES` (file:line), `PARTIAL`, `NO` (zero occurrences, verified by grep), or
  `NAME ABSENT / EQUIVALENT EXISTS`.
- **Counted by** — which census put this in its denominator. **`NOBODY`** is the flag this
  document exists to raise.

### 2.A — Sensing spec, §7–§17 "Required Tweaks" (52) + §1/§6 platform clauses (4) = 56

Every one of these is counted **by `census-sensing.md` only**, inside its 127 denominator, and by
**no** surface census. `census-wall.md`, `census-map.md`, `census-passport.md`,
`census-highlights-memories.md`, `census-media.md` mention Sensing **zero times**;
`census-telegraph.md` mentions it twice and `census-map.md` four times, in both cases only about
*census methodology*, never as an obligation (`census-telegraph.md:7,229`;
`census-map.md:33,36,871`).

#### §7 Required Tweaks: Map — 10, owed by Map

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-01 | Keep current layer census and fallback; do not rewrite the gateway (`:121`) | YES `routes/mapProjection.ts:1056` | S58 **BC** | census-map counts the gateway, not this clause |
| SX-02 | Add server-built `ExperienceState` to place/event Map projections rather than separate overlapping vibe pins (`:122`) | PARTIAL — shape right, payload wrong; `lib/mapProjection.ts:676-701` folds individual claims | S59 **BW** | no |
| SX-03 | Promote `world_pulse` into transient world-change projections: heating up, forming, moving, clearing, unexpected activity, event spillover, traveler surge (`:123`) | PARTIAL — `lib/mapProducers/worldPulseProducer.ts` exists (413 lines) but emits an activity *level*, not a *change*; none of the seven named types exists | S60 **BW** | **overlaps** census-map M282 (Phase 7, `W`) — see §5 |
| SX-04 | Render `crowd_flow` / `traveler_flow` as privacy-safe directional geometry, not ordinary pins (`:124`) | YES `lib/mapAggregation.ts:1192,1236-1237` | S61 **BC** | **overlaps** census-map M63/M69 — see §5 |
| SX-05 | `TemporaryWorldObject` only if no canonical contract exists; no fake permanent Place rows for transient clusters (`:125`) | NAME ABSENT (`TemporaryWorldObject` zero occurrences) / EQUIVALENT EXISTS — synthetic map objects with cell geometry, `mapAggregation.ts:675` | S62 **BC** | no |
| SX-06 | Semantic zoom: city→neighborhood/world dynamics; district→hotspots/flows; place→vibe/crowd/queue (`:126`) | YES `lib/mapAggregation.ts:202-244` | S63 **BC** | **overlaps** census-map M126/M127 — see §5 |
| SX-07 | Truth/freshness/coverage metadata; predicted visually distinguished from observed (`:127`) | PARTIAL — coverage absent from `MapObject` (`lib/mapObjects.ts:362-398`) | S64 **BW** | no |
| SX-08 | Display resolver / clutter budget so safety, mode, zoom, user intent and relevance decide what renders (`:128`) | PARTIAL — priority sort + page cap only (`lib/mapProjection.ts:1166,1226`) | S65 **BW** | no |
| SX-09 | Safety constraints outrank opportunity/vibe; a dangerous place is never simultaneously "best move now" (`:129`) | PARTIAL — true within the Map (`mapObjects.ts:281`), **false across surfaces**: `compass/CompassSafetyFilter.ts:159-197` reads no world safety state | S66 **BW** | no — and the failing half is owed by **Compass and Discovery**, neither of which has a census |
| SX-10 | Map remains a projection consumer, never owner of world truth (`:130`) | YES `lib/mapProducers/worldPulseProducer.ts:11-14` | S67 **BC** | **overlaps** census-map §20 M140–M152 — see §5 |

#### §8 Required Tweaks: Discovery — 5, owed by Discovery *(no Discovery spec, no census)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-11 | Rank using live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value (`:133`) | NO — the one live-ish input `localMomentum` is behind `discovery_ranking_modifiers_enabled`, absent from production (`lib/discoveryModifiers.ts:60`) | S68 **NB** | **NOBODY else — and GATED**, see §7 |
| SX-12 | Keep search/retrieval truth separate from recommendation ranking; a quiet venue still exists in search (`:134`) | YES `routes/discoverySearch.ts:1-35` vs `lib/discoveryPde.ts` | S69 **BC** | no |
| SX-13 | Server-built `DiscoveryCandidate` with why-now, why-for-user, confidence, freshness, truth class (`:135`) | NO — `whyNow`/`why_now` zero occurrences; `truthClass`/`truth_class` zero occurrences. **Name collision:** `DiscoveryCandidateSignals` exists at `services/wall/WallDiscoveryInsertionService.ts:46` but is the Wall's insertion-scoring shape, carrying none of the five fields | S70 **BW** | no |
| SX-14 | Strengthen Hidden Gems with behavioural evidence; candidates, not automatic canonical gems (`:136`) | YES `services/hiddenGems/HiddenGemContributionService.ts:1-12` | S71 **BC** | no |
| SX-15 | Intent modes — Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip (`:137`) | PARTIAL — nine modes exist with a different vocabulary (`compass/CompassIntentModeEngine.ts:1-22`); Quiet / High Energy / Nearby / Right Now unrepresented | S72 **BW** | no |

#### §9 Required Tweaks: Wall — 5, owed by the Wall

**This is the section the whole document turns on.**

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-16 | Wall consumes meaningful **state transitions**, not repeated snapshots of unchanged state (`:139`) | NO — no transition concept in `services/wall/` or `lib/wallProjection.ts` | S73 **NB** | **no. census-wall.md never asks this question.** |
| SX-17 | Server-built **`WallMoment`** with subject, transition, occurred_at, relevance window, reason, truth class, freshness, expiry (`:141`) | **NO — zero occurrences, verified by grep** (`grep -rI --exclude-dir={node_modules,.git,docs} WallMoment .` → no output). No equivalent under another name: no transition object exists to carry the fields | S74 **NB** | **no** |
| SX-18 | Preserve Wall as chronological/current-life architecture; not an opaque engagement-maximizing ranking feed (`:142`) | YES `services/wall/FollowingFeedService.ts:1-14` | S75 **BC** | **overlaps** census-wall §13/§14 — see §5 |
| SX-19 | Live Now strip consumes current projections; chronological Wall records transitions/history; do not duplicate both (`:143`) | PARTIAL — strip exact (`services/wall/LiveForYouService.ts:1-27`); the transitions half does not exist (SX-16) | S76 **BW** | **overlaps** census-wall W3/W11/W19/W20 for the strip half only — see §5 |
| SX-20 | Personalization controls whether a canonical world event matters to a user; it must not rewrite the world event (`:144`) | YES `services/wall/WallProjectionService.ts:5,306-310` | S77 **BC** | no |

#### §10 Required Tweaks: Compass and Home — 5, owed by Compass/Home *(no spec, no census)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-21 | Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN (`:147`) | **NO — `GO_NOW` zero occurrences, verified by grep**; no equivalent decision vocabulary found | S78 **NB** | **NOBODY else** |
| SX-22 | Compass must ground natural-language claims in structured truth (`:148`) | PARTIAL — input is structured (`compass/CompassStructuredContext.ts:1-20`); **nothing constrains generated language to its inputs' confidence band** (`routes/telegraph.ts:43-57` is a shape sanitizer) | S79 **BW** | **NOBODY else** |
| SX-23 | Current Experience value introduces switching cost (`:149`) | **NO — `switchingCost`/`switching_cost` zero occurrences, verified by grep** | S80 **NB** | **NOBODY else** |
| SX-24 | Home consumes a server-assembled `UserNowProjection`/equivalent (`:150`) | NAME ABSENT (`UserNowProjection` zero occurrences) / **EQUIVALENT EXISTS** — `routes/compassHome.ts:1-20` (403 lines), one endpoint, one client call | S81 **BC** | **NOBODY else** |
| SX-25 | Home answers "what matters right now"; Compass answers "what should I do about it" (`:151`) | YES — `routes/compassHome.ts` vs `routes/compass.ts` | S82 **BC** | **NOBODY else** |

#### §11 Required Tweaks: Trips and Layover — 4, owed by Trips and Layover

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-26 | `TripWorldContext` projection: current world state, nearby opportunities, disruptions, ExperienceSessions, crew context (`:153`) | **NO — `TripWorldContext` zero occurrences, verified by grep.** Nearest thing is `compass/CompassTripContext.ts:1-18` (223 lines), which is trip *grounding* — day N of M, today's plan items — with no world state | S83 **BW** | no (no census-trips; census-layover does not cover it) |
| SX-27 | World Intelligence may propose Trip changes but may not mutate canonical Trip plans; consequential changes pass through Trip Kernel (`:154`) | PARTIAL — no intel module writes a `trip_*` table (subject to the `.from()` caveat) **but there is no Trip Kernel to pass through**: `TripKernel`, `TripCommand`, `expectedTripVersion`, `aggregateVersion` all zero occurrences | S84 **BC** *(for the intel half only)* | see **T-01** — the non-intel half is counted by NOBODY |
| SX-28 | Layover Temporal Freedom Engine intersects feasibility with live Experience value, forecast, friction and safe-return (`:155`) | NO — `grep -rn liveClaimRead services/airport/` → nothing | S85 **BW** | **counted twice**: census-layover L81, L276 record the same absence *"from the other side"* (`census-layover.md:380,703`) — see §5 |
| SX-29 | Peak interception: can the user reach the experience before its useful window decays? (`:156`) | NO — no decay-window or interception arithmetic found | S86 **NB** | no |

#### §12 Required Tweaks: Telegraph — 4, owed by Telegraph

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-30 | Share canonical **references** to ExperienceState / Opportunity / WorldMoment / SafetyNotice rather than copying stale prose (`:158`) | NO — `POST /telegraph/recommend` (`routes/telegraph.ts:63`) returns model-generated prose with no canonical entity id (`sanitizeRec`, `:43-57`) — the exact shape the spec forbids | S87 **NB** | **no. census-telegraph.md does not test this** (it tests the v1.1 spec's own share contract) |
| SX-31 | Shared live objects may indicate that state changed since sharing (`:159`) | NO — no shared-object record exists to carry a change indicator | S88 **NB** | no |
| SX-32 | Telegraph coordination may consume live intelligence but must not expose anonymous contributors (`:160`) | YES, vacuously — `services/wall/LiveForYouService.ts:18-20`, `lib/dataRights.ts:144` | S89 **BC** `⌀` | no |
| SX-33 | Nearby & Available remains separate from anonymous contribution sensing (`:161`) | YES, vacuously — `migrations/2260_availability_windows.sql` + `services/rentBuddy/` read no intel table | S90 **BC** `⌀` | no |

#### §13 Required Tweaks: Memories and Passport — 4, owed by Memories and Passport

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-34 | Raw passive sensing must never automatically become Memory (`:163`) | YES, vacuously — `project_all_memory()` (migrations 2184/2186) projects from an enumerated source set | S91 **BC** `⌀` | **no. census-highlights-memories.md mentions Sensing zero times.** |
| SX-35 | Bridge through `ExperienceSession` and outcome/significance eligibility (`:164`) | **NO — `ExperienceSession` zero occurrences, verified by grep.** Eligibility and decay exist (`lib/memoryProjectionScheduler.ts:7-9`) but the bridge is a graph-edge projection | S92 **BW** | no |
| SX-36 | Passport consumes meaningful visited/experienced outcomes, not raw movement logs (`:165`) | YES — no passport service reads `location_snapshots` / `location_sessions` / `journey_observations` (subject to the `.from()` caveat) | S93 **BC** | **no. census-passport.md mentions Sensing zero times.** |
| SX-37 | World Intelligence, personal Memory and social location remain separate retention/permission domains (`:166`) | YES `lib/locationPurposes.ts:102-314` | S94 **BC** | no |

#### §14 Required Tweaks: Places, Events and Hidden Gems — 4, owed by Places/Events/Hidden Gems *(no spec, no census)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-38 | Do not bloat durable `places` rows with current_vibe / current_crowd / current_energy (`:168`) | YES — those three column names have zero occurrences in `src/` | S95 **BC** | **NOBODY else** |
| SX-39 | Events may expose runtime inferred/official phases, but source and truth classes stay distinct (`:169`) | YES `lib/mapProducers/eventContextProducer.ts:124` | S96 **BC** | **NOBODY else** |
| SX-40 | Temporary activity must not be forced onto the nearest place ID when ownership is unknown (`:170`, restated `:197`) | YES — no nearest-place snapping found | S97 **BC** | **NOBODY else** |
| SX-41 | `HiddenGemCandidate` distinct from canonical Hidden Gem approval (`:171`) | YES `services/hiddenGems/HiddenGemModerationService.ts:198-206,265-305` | S98 **BC** | **NOBODY else** |

#### §15 Required Tweaks: Search, Create and Attention — 4 *(no spec, no census for any of the three)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-42 | Search may use live state as ranking context while preserving lexical/entity correctness (`:173`) | YES `lib/inputAssistance/liveSuggestions.ts:1-11` | S99 **BC** | partially — the GII **certification** covers `liveSuggestions`, but as a platform check, not a Search obligation |
| SX-43 | Autocomplete may surface live/inferred suggestions but must label them as current intelligence (`:174`) | YES `lib/inputAssistance/liveSuggestions.ts:12-23` | S100 **BC** | same |
| SX-44 | Create content and structured intelligence observation are separate commands; a post saying "dead" cannot mutate CrowdState (`:175`) | YES `lib/quickSignal.ts:1-12` | S101 **BC** | **NOBODY else** |
| SX-45 | **Attention Engine is mandatory**: world changes route through relevance, novelty, urgency, half-life, availability, interruption cost and attention budget before NOTIFY / WALL / SILENT / IGNORE (`:176`) | NO — no world change produces a notification at all. What exists is a ten-level priority stack (`compass/CompassNotificationEngine.ts:1-27`) plus dedup/throttle, with **no WALL routing option** | S102 **NB** | **NOBODY else.** The Attention Engine has no spec, no census and no owner. |

#### §16 Required Tweaks: Safety and Trust — 3 *(no spec, no census)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-46 | World evidence/anomaly → SAFETY CANDIDATE → existing review → canonical safety assertion (`:178-179`) | PARTIAL — the last two stages exist (`lib/mapProducers/safetyNoticeProducer.ts:22-32`); **no anomaly detector and no candidate stage**, so nothing enters the pipeline | S103 **BW** | **NOBODY else** |
| SX-47 | Source/signal reliability is not the same as person Trust Score (`:182`) | YES `lib/intelScopedTrust.ts:9-22` — *liveness caveat:* `intel_scoped_trust` (migration 2278) is not in production (`docs/architecture/sensing-surface-inventory.md`) | S104 **BC** | **NOBODY else** |
| SX-48 | Do not score a user as trustworthy because their passive movement looks "normal" (`:183`) | YES, vacuously — `lib/intelScopedTrust.ts:26`, `lib/intelOutcomes.ts:1-22` | S105 **BC** `⌀` | **NOBODY else** |

#### §17 Required Tweaks: Presence, Rent-a-Buddy, Locate My Friends — 4 *(no spec, no census)*

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-49 | Shared platform Presence architecture keeping six privacy classes distinct (`:185`) | PARTIAL — declared and good (`presence/domain/types.ts:19-52,88`), but **no store, no fusion layer**, only `locateFriends` consumes it, and four other presence models run alongside (S3) | S106 **BW** | **NOBODY else** |
| SX-50 | Reuse low-level sensor/proximity infrastructure, not consent/policy semantics (`:186`) | YES `presence/domain/transport.ts:1-17`, `types.ts:148` | S107 **BC** | **NOBODY else** |
| SX-51 | LMF may use identity/relay/checkpoints under group permissions; anonymous World Intelligence may not reverse-resolve contributors (`:187`) | YES `lib/locateFriendsSession.ts:60,75`; `lib/dataRights.ts:144` | S108 **BC** | **NOBODY else** |
| SX-52 | RAB may consume public/aggregate area intelligence and authorized Buddy presence, never individual anonymous contributors (`:188`) | YES — `services/rentBuddy/` reads no intel table (subject to the `.from()` caveat) | S109 **BC** | **NOBODY else** |

#### §1 / §6 — 4 platform clauses that bind other surfaces

| # | Obligation (spec line) | Exists? | census-sensing | Counted elsewhere |
|---|---|---|---|---|
| SX-53 | Existing Map / Discovery / Wall / Compass paths must keep functioning while new projections are partial or gated (`:19`) | YES — every new producer flag-gated fail-closed; `migrations/2295_map_world_intelligence_flag.sql:93-95` *refuses to commit* if the flag were seeded ON | S6 **BC** | no |
| SX-54 | Context Kernel assembling the nine §18.1 contexts, consumed by all surfaces (`:118`, `:191`) | PARTIAL — `compass/CompassContextEngine.ts:1-19` is Compass-local, not consumed by Map/Wall/Discovery, and has **no World, Experience or Attention context**. `ContextKernel`, `WorldContext`, `AttentionContext` all zero occurrences | S55 **BW** | **NOBODY else** |
| SX-55 | Opportunity Engine downstream of the kernel feeding feature-specific projections (`:118`) | NO — each surface builds candidates directly | S56 **NB** | **NOBODY else** |
| SX-56 | Feature clients and React components must not independently calculate crowd, vibe, safety, opportunity, experience value or world-change state (`:119`) | YES — client mirrors server vocabulary as data (`travel-buddy-standalone/src/types/mapObjects.ts`) | S57 **BC** | partially — census-map §20 covers the Map client only |

### 2.B — Global Input Intelligence spec (8) — **NO CENSUS EXISTS**

`docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt:8` declares the
spec cross-cutting in its own status line:

> *"This is not owned by Discovery, Media, Map, Trips, Telegraph, Compass, or Create. Those
> surfaces consume it through a shared platform layer."*

`docs/architecture/input-intelligence-certification.md` exists but is a **certification of the
platform layer against §49**, explicitly scoped to `lib/inputAssistance/*` plus
`platform/input-assistance/*` (`:3-14`). It does not build a denominator and does not ask, per
consuming surface, whether that surface adopted the layer. **Every row below is counted by
nobody.**

Platform-side facts, verified this pass: the policy registry covers **26 typed contexts**
(`lib/inputAssistance/policyRegistry.ts:97-321`, from `global_search` through `compass_prompt`,
`trip_destination`, `hidden_gem_location`, `passport_homebase`, `buddy_service`). Server-side the
gateway has exactly **two** callers — `routes/inputAssistance.ts` and
`services/wall/WallSessionIntentService.ts`. Client-side the SDK has **ten** importing files
(`components/search/SearchSuggestionsPanel.tsx`, `components/selectors/GlobalPlacePicker.tsx`,
`hooks/useUsernameAvailability.ts`, `useGlobalSearchSuggestions.ts`, `useCreationAssistance.ts`,
`useAiWritingAssist.ts`, `useTelegraphRecipients.ts`, `features/wall/components/WallHeader.tsx`
and two more). The certification names five wired surfaces (`:11-13`).

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| G-01 | No surface owns a separate autocomplete/typeahead engine; all typed assistance goes through the shared layer (`:8`, core rule `:7`) | Discovery, Media, Map, Trips, Telegraph, Compass, Create | **PARTIAL — three competing paths found.** `routes/discoverySearch.ts:1831` `GET /api/discovery/suggest — grouped live typeahead` imports nothing from `lib/inputAssistance`; `routes/hashtags.ts:8` `GET /api/hashtags/suggestions — autocomplete`; `routes/places.ts:424` `/places/google-autocomplete`. The Wall by contrast delegates correctly (`WallSessionIntentService.ts`, census-wall W67 `C`) | **NOBODY** |
| G-02 | §14 Zero-character assistance per context: City picker, Place picker, **Telegraph recipient**, **Compass prompt**, Global Search, **Hidden Gem location** (`:140-152`) | Telegraph, Compass, Hidden Gems, Search, Trips | PARTIAL — policies exist for all six contexts; client wiring found for search / geo picker / telegraph recipient / compass AI / creation only | **NOBODY** |
| G-03 | §16 Context carryover bounded to the active task/session; must not silently change unrelated persistent preferences (`:160-163`) | Trips, Compass, Hidden Gems, Events | PARTIAL — the session-bias comparison exists (`lib/inputAssistance/gateway.ts:165-168`); could not establish that every consuming surface honours the boundedness rule | **NOBODY** |
| G-04 | §17 Autofilled dependent fields remain visible, attributable and editable; no invisible field mutation (`:164-166`) | Trips, Events, Hidden Gems, Create | COULD NOT ESTABLISH — no cross-field prefill contract found under a searchable name | **NOBODY** |
| G-05 | §21 Smart action suggestions per surface: Telegraph (share place/meeting point/Trip stop), Search (Add to Trip, Save, Open Map, Ask Compass, directions), Trip (add stop, reorder, invite Crew), Hidden Gem (drop pin, confirm existing), Compass (convert phrase into structured request) (`:201-215`) | Telegraph, Search, Trips, Hidden Gems, Compass | PARTIAL — `'action'` is a declared assistance type (`policyRegistry.ts:99`); per-surface action catalogues not found | **NOBODY** |
| G-06 | §22 AI-assisted writing allowed uses, opt-in and never silently inserted: captions, Event/Trip text, **Postcards/Memories**, Buddy listing, Compass (`:216-229`) | Media, Trips, Events, Memories, Buddy, Compass | PARTIAL — `lib/inputAssistance/aiWriting.ts` exists and the certification passes it on the never-silently-insert dimension | **NOBODY** |
| G-07 | §20 Constraint-aware suggestions must demote/remove options outside the Trip date window, behind a Buddy safety/payment gate, at protected/sensitive locations, or beyond allowed live freshness (`:190-200`) | Trips, Buddy, Hidden Gems, Places | PARTIAL — freshness and protected-location handling exist (`lib/inputAssistance/liveSuggestions.ts:12-31`); Trip-window and Buddy-gate constraints not found in the ranking path | **NOBODY** |
| G-08 | §25 Voice and Dictation (`:258`) plus §23 typo correction (`:112`, `:238`) | all typed surfaces | **Typo: PARTIAL** — alias expansion only (`lib/inputAssistance/gateway.ts:155-162`, `applyAliases`). **Voice/dictation: NO — `dictation`, `speechRecognition`, `expo-speech` all zero occurrences, verified by grep** | **NOBODY — and explicitly deferred to here.** `census-wall.md:247` (W71) declines to score it: *"Whether the shared engine actually implements voice input is a Global Input Intelligence question, out of this spec's tree and censused by the sibling agent on that spec. Not counted for or against the Wall."* `census-wall.md:512` repeats it. **That census does not exist.** This row closes W71: it does not. |

### 2.C — Trips spec (7) — **NO CENSUS EXISTS**

The Trips spec is a boundary-prohibition spec: its central claim is that other surfaces may
orchestrate but not mutate. **No `census-trips.md` existed at any point during this pass.** Every
row below is counted by nobody except where noted.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| T-01 | *"No Map, Compass, Telegraph, Discovery, Buddy, or UI component may independently invent canonical trip state"* — all consequential changes pass through the **Trip Kernel** (`:12`) | Map, Compass, Telegraph, Discovery, Buddy | **NO, and violated.** `TripKernel`, `TripCommand`, `expectedTripVersion`, `aggregateVersion` are all **zero occurrences, verified by grep** — there is no kernel. Canonical trip state is written directly from outside `routes/trips`: `compass/CompassAutopilotEngine.ts:206` (`trip_autopilot_settings` upsert) and `:598` (`trip_autopilot_proposals` insert); `routes/airport.ts:181,183,700` (Layover writing `trip_plan_items`); `lib/visuals/service.ts:566` (`trips` update); `routes/requests.ts:529` (`trip_members` update); `routes/admin.ts:2288` (`trips` update). **Caveat:** this list comes from a literal `.from("trip…")` grep and, per `checkWriterlessReads.ts:39,344-345`, is a **floor, not a ceiling** — dynamic `.from(expr)` and RPC writes are invisible to it | **Only the World-Intelligence subset**, by census-sensing S84 (`BC`). The Compass, Telegraph, Discovery, Buddy and Layover subsets: **NOBODY** |
| T-02 | *"Map, Compass, Discovery, Telegraph, Safety, Buddy, Passport, and Memory consume explicit Trip projections/contracts rather than duplicating Trip semantics"* (`:25`, `:488`) | Map, Compass, Discovery, Telegraph, Safety, Buddy, Passport, Memory | PARTIAL — the Map side is real (census-map M145 `C`, `features/map/trip/tripMapSources.ts:16`, DTOs in, no re-derivation) and Passport's Trips variant is consumed (census-passport P96 `C`). But **none of the eight named projections exists by name**: `TripTodayProjection`, `TripMapProjection`, `TripCompassProjection`, `TripMemoryProjection`, `TripPassportProjection` are **zero occurrences, verified by grep** (`:373`) | Map side by census-map M145; Passport side by census-passport P96. **The projection contracts themselves: NOBODY** |
| T-03 | *"Discovery, Compass, Saved Ideas, and Buddy matching consume these [Temporal Freedom] windows rather than independently calculating 'free time'"* (`:185`) | Discovery, Compass, Saved Ideas, Buddy | **NO, and violated.** `FreedomWindow` / `freedom_window` / `temporalFreedom`: **zero occurrences, verified by grep**. Independent free-time arithmetic exists instead: `lib/portavaRank.ts:86` *"Minutes of free window (layover mode / availability) — actionability cap"* and `:246` *"Layover/limited-window mode: must start within the window"*; `routes/hiddenGems.ts:137-138` `minimumLayoverMinutes` | census-layover counts the **engine** (L56–L59) from Layover's side. The **consumer-side obligation on Discovery/Compass/Saved-Ideas/Buddy: NOBODY** |
| T-04 | Compass may create a proposal but cannot silently mutate other participants' commitments (`:234`); Compass authority is bounded — may not invent canonical flight/booking/place facts, relax safety, or expand certified freedom (`:278`) | Compass | PARTIAL — `compass/CompassTools.ts:305` `AddToTripProposal` is a real proposal shape; but `CompassAutopilotEngine.ts:598` inserts `trip_autopilot_proposals` directly, without a kernel to arbitrate | **NOBODY** |
| T-05 | Trips must remain fully operational without Compass; AI is not a safety dependency (`:283`) | Compass, Trips | COULD NOT ESTABLISH — no degradation test for a Compass-absent Trip found | **NOBODY** |
| T-06 | The Trip Map must never draw a stale location as if it were current; marker treatment and accessible text expose freshness (`:244`) | Map | PARTIAL — the Map carries `freshness` on every object (`lib/mapObjects.ts:362-398`, census-map) but the *trip-crew* staleness rule specifically was not located | Map's own freshness rows by census-map; **this clause: NOBODY** |
| T-07 | Public Trip content must not leak lodging detail, exact private location, future absence from home, safety state, or unconsented participant data (`:175`) | Map, Discovery, Wall, Telegraph, Media | PARTIAL — Map's private-anchor handling exists (Map spec §14.1); the cross-surface guarantee was not verified end-to-end here | **NOBODY** |

### 2.D — Layover spec (6) — counted by `census-layover.md`, filed under Layover

`census-layover.md` landed during this pass and behaves **exactly like `census-sensing.md`**: it
counts the obligations Layover places on Trips, Compass, Map, Telegraph, Safe Return, Discovery,
Rent-a-Buddy and Passport inside **its own 296 denominator** (headline 32.4 % constructed / 3.4 %
correct, `census-layover.md:15-19`). None of those surfaces' own censuses records them.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| L-01 | *"Trips may detect the connection, Compass may converse about it, Map may visualize it, and Safe Return may escalate it, but none of those surfaces owns Layover truth"* (`:59`) | Trips, Compass, Map, Safe Return | PARTIAL | census-layover L11, L16, L17, L18 (`W`,`C`,`W`,`W`) — **not** census-map, no census-trips |
| L-02 | *"All surfaces consume the same certified `LayoverSnapshot` / `RecommendationContract`; no duplicate time-budget logic"* (`:66`) | Trips, Compass, Discovery, Map, Safe Return | **NO by name — `LayoverSnapshot` zero occurrences, verified by grep.** And duplicated time-budget logic exists: `lib/portavaRank.ts:86,246` and `routes/hiddenGems.ts:137-138` compute against a caller-supplied window | census-layover **L6 `W`** — *"three independent uses of it with different inputs"* |
| L-03 | *"One canonical LayoverSnapshot drives Trips, Compass, Discovery, Map and Safe Return"* (`:803`) | Trips, Compass, Discovery, Map, Safe Return | **NO.** Verified: `grep -rIln -i layover` over `src/compass/`, `src/routes/` and `src/lib/` returns only `routes/airport.ts`, `routes/hiddenGems.ts`, `routes/mediaFeed.ts`, `lib/deletionDispositions.ts`, `lib/database.types.ts`, `lib/locationPurposes.ts`, `lib/portavaRank.ts`. **No compass file, no trips route, no discovery route and no map projection references layover at all**; the airport services are imported only by `routes/airport.ts`, their own tests, and `lib/inputAssistance/*` for the static airport dataset | census-layover L267–L275 (all `W`) |
| L-04 | §25 integration matrix — eight named surface obligations: Trips, Compass, Discovery, Map, Telegraph, Safe Return, Rent a Buddy, Passport/Memories (`:748-764`) | eight surfaces | PARTIAL across all eight; Telegraph's is a live defect — *"The message is discarded"* | census-layover L267–L275 |
| L-05 | Hard safety constraints are deterministic and cannot be overridden by Compass/LLM output (`:63`, `:886`) | Compass | YES — `services/airport/LayoverCompassService.ts:53-63` recomputes `hardReturnTime` itself | census-layover **L16 `C`** |
| L-06 | Map consumes the active snapshot and safe-envelope geometry; it does not recalculate feasibility (`:453`) | Map | PARTIAL — the boundary holds (`components/layover/LayoverMapCard.tsx:28-64` computes nothing) but nothing the requirement names is visualised | census-layover L17, L270 (`W`) — **not** census-map |

### 2.E — Passport spec (6) — counted by `census-passport.md`, filed under Passport

Passport's 169-item denominator (98.2 % constructed / 85.8 % correct) **includes** its
obligations on Discovery, Compass, Telegraph, Map, Safety, Trips and Buddy. Those surfaces'
figures do not.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| P-01 | *"Do not create separate profile systems for self, public, Trips, Buddy, Discovery or Telegraph"* (`:57`) | Trips, Buddy, Discovery, Telegraph | YES — `PassportConsumerProjections.ts:818` is the single assembler | census-passport **P20 `C`** |
| P-02 | §21 Context-specific projections for **Discovery, Trips, Buddy, Map, Telegraph, Compass, Safety** (`:207-221`) | six consumers | **PARTIAL — four of six variants have no caller and Map has no variant at all.** `PassportConsumerVariant` (`services/passport/PassportConsumerProjections.ts:82-88`) has six members and **no Map variant**; `buildConsumerProjection` has exactly three call sites (`routes/rentABuddy.ts:1241`, `routes/trips.ts:467`, `EventPassportService.ts:423`) | census-passport **P95 `W` (Discovery), P96 `C` (Trips), P97 `C` (Buddy), P98 `N` (Map), P99 `W` (Telegraph), P100 `W` (Compass), P101 `W` (Safety)** |
| P-03 | *"Other surfaces request the appropriate Passport projection instead of rebuilding identity, availability, trust and social context"* (`:334`, §35 canonical architecture rule) | all consumers | PARTIAL — *"Adoption is three of seven consumers"* | census-passport **P169 `W`**; the census adds (`:561-563`) that the Passport certification *"does not test §21 at all"* |
| P-04 | A Passport block must propagate across Discovery, Telegraph, Trips, Presence, Map, Shared Moments, Bump, Buddy and Compass. *"Do not implement blocking independently per surface."* (`:263`) | nine surfaces | YES — `fetchBlockedSet` applied in every one of the named trees | census-passport **P120 `C`** |
| P-05 | *"Compass and Discovery should weight explicit current intent more heavily than generic interests"* (`:94`) | Compass, Discovery | COULD NOT ESTABLISH — no intent-weighting term located in the Compass or Discovery rankers under a searchable name | census-passport (§9 rows) — the *Passport* side only |
| P-06 | My World and the main Map deep-link but **must not merge truth models** (`:271`) | Map | YES — `MyWorldScreen.tsx:1-13` renders from the passport map payload and deep-links out | census-passport **P127 `C`** — **not** census-map |

### 2.F — Telegraph spec v1.1 (7) — counted by `census-telegraph.md`, filed under Telegraph

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| TG-01 | *"Telegraph must never invent or silently mutate canonical truth owned by Trips, Plans, Events, Memories, Buddy, Safety, Map"* (`:25`) | Telegraph (protecting seven owners) | — | census-telegraph, the Primary Invariant (`:192`) |
| TG-02 | Blocking cascades across direct delivery, location, presence, Nearby, Bump discovery, **shared-memory resurfacing**, **Crew suggestions** and **Compass retrieval** (`:285`) | Memories, Trips/Crew, Compass, Presence, Discovery | PARTIAL — *"Five of eight have real enforcement"* | census-telegraph **T219 `W`** — the Memories, Crew and Compass legs are owed by surfaces whose censuses do not record them |
| TG-03 | *"Every shareable Portava domain registers preview, authorization, current state, actions, search behavior, and revocation through a Telegraph content capability contract"* (`:606`) | Trips, Events, Buddy, Memories, Discovery, Media, Places | **NO — `TelegraphSharedContextProjection` zero occurrences, verified by grep**; no per-domain registration contract found | census-telegraph (§30.16 rows) |
| TG-04 | *"Trips, Events, Buddy, Memories, Discovery, and other source domains retain canonical business truth"*; each registers authorize / preview / execute / compensate (`:607`) | six domains | COULD NOT ESTABLISH | census-telegraph |
| TG-05 | Availability expires automatically and **revokes across Telegraph, Discovery and Compass** (`:87`) | Discovery, Compass | PARTIAL — expiry re-evaluated on every read (`migrations/2260_availability_windows.sql:38-42`); the Discovery and Compass revocation legs are the weak half | census-telegraph **T28 `W`** |
| TG-06 | BLOCK overrides Nearby both directions; Unavailable/Invisible **revokes Nearby, Discovery and Compass availability projections** promptly (`:621`) | Discovery, Compass | PARTIAL | census-telegraph (§30 rows) |
| TG-07 | Deleted / unsent / revoked objects removed from normal search **and Compass retrieval** (`:578`, `:369`) | Compass, Search | PARTIAL — *"Partial, in the one place it can act"* | census-telegraph **T276 `W`** |

### 2.G — Highlights / Memories spec (5) — counted by `census-highlights-memories.md`

That census's denominator is 266 at **28.6 % constructed / 6.4 % correct** — the lowest
constructed figure of any completed census. Its cross-surface rows are inside that number.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| H-01 | §16 Compass Contract: *"Compass is a consumer of Memory facts, not the owner of historical truth… it must not mutate canonical facts through prose generation"*, with eight named read tools (`:460-469`) | Compass | COULD NOT ESTABLISH the tool set; `CompassMemoryProjection` is **zero occurrences, verified by grep** | census-highlights-memories (§16 rows) |
| H-02 | *"Never keep deleted Memories in embeddings, public caches, Highlights, **Passport**, or **Compass** projections"* (`:742`) | Passport, Compass | COULD NOT ESTABLISH — no revocation-propagation harness located | census-highlights-memories (§21 rows) |
| H-03 | Revocation propagation must cover public projection, search index, embedding, profile Highlight, **Trip story derivative**, **Passport reference**, cached narrative and share link (`:582`) | Trips, Passport, Search, Compass | COULD NOT ESTABLISH | census-highlights-memories |
| H-04 | Named cross-surface projections: `PassportMemoryProjection`, `TripMemoryProjection`, `CompassMemoryProjection`, `MapTrailDerivative` (`:518,522,528,536`) | Passport, Trips, Compass, Map | **NO — all four are zero occurrences, verified by grep.** Memory does reach the Map under a different name: `lib/mapProducers/memoryProducer.ts:9` reads `memory_projections` (census-map M147 `C`) | census-highlights-memories (§17 rows); the Map leg additionally by census-map M147 |
| H-05 | *"Planned activity without occurrence evidence cannot earn a visit Memory/Stamp"* (`:660`) | Passport (stamps) | COULD NOT ESTABLISH | census-highlights-memories |

### 2.H — Media spec (5) — counted by `census-media.md`

`census-media.md` was still mid-flight when read (`PLACEHOLDER_CONS` at `:16`); its row-level
verdicts are quoted, its headline is not.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| MD-01 | §29 Passport Boundary: *"Passport continues to use Postcards as its primary media expression. Do not duplicate the full Media product inside Passport."* (`:277`) | Passport | PARTIAL — `MediaActionResolver.ts:53` `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"` has **no passport member** | census-media **MD103 `W`** — **not** census-passport |
| MD-02 | §21 *"Media Map consumes the canonical Map projection system; it does not own a second location engine"* (`:217`) | Map, Media | YES in principle — census-map §20 M140–M152 records the ownership split from the Map side | census-media (§21 rows) and census-map M140–M152 — **see §5, this is a genuine two-census overlap** |
| MD-03 | §2 *"Media does not own truth; Live Intelligence owns current claims and confidence"* (`:37`) | Media, Live Intelligence | YES — `MediaExperienceResolver.ts:24-27` reads current state only through the gated live-claim read | census-media **MD166 `C`** |
| MD-04 | §32 Compass Integration — `CompassMediaContext { mediaAssetId, entityRefs, viewerContext, permittedIntelligenceRefs }` (`:294-304`) | Compass | YES — `compass/CompassMediaContext.ts` exists and is one of the six consumers of `lib/liveClaimRead` (census-sensing S47) | census-media (§32 rows) |
| MD-05 | §15 *"Converts an eligible Trail, Trip recap, creator itinerary, or experience collection into an executable Compass plan"* (`:178`) | Compass, Trips | COULD NOT ESTABLISH — `ExecutableTripExperience` is **zero occurrences, verified by grep** | census-media (§15 rows) |

### 2.I — Map spec (4) — counted by `census-map.md`

`census-map.md` is the outlier: 293 requirements at 96.6 % constructed / 80.2 % correct, and
**76.5 % spec-attributable** where every other completed census returned 0.0 %. Its §20 is the
cleanest cross-cutting artefact in the tree — thirteen rows, each naming a domain that owns a fact
the Map does not.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| MP-01 | §20 Data ownership: Places, Live Intelligence, Discovery, Compass, Presence, Trips, Telegraph, Memory, Passport, Trust, Safety, Buddy each own a named fact and the Map does not (`:11`, `:196-222`) | thirteen domains | YES — *"the gateway satisfies them structurally by calling each owner's privacy-complete reader rather than querying"* (`routes/mapProjection.ts:14-27,52-66`) | census-map **M140–M152, all `C`** |
| MP-02 | §26 *"Pulse and Map must be two presentations of the same underlying intelligence… map states should never contradict Pulse"* (`:264`) | Discovery/Pulse | YES — `features/map/pulse/pulseMapBridge.ts:475-530` has a `findContradictions` function | census-map **M190–M192 `C`** — Discovery has no census to record its half |
| MP-03 | §11 Trip Map renders the current Trip *"without duplicating or replacing Trip ownership"*; proposed changes require user acceptance; the map must not silently rewrite the canonical Trip (`:143-145`) | Trips | YES from the Map side — `features/map/trip/tripMapSources.ts:16` takes DTOs and re-derives nothing | census-map **M145 `C`**; **no census-trips** to record the Trips side |
| MP-04 | §14 *"Compass does not create live facts; it reasons over structured state produced elsewhere"* (`:162`) | Compass | YES — `features/map/compass/compassMapModel.ts:8` | census-map **M143 `C`** |

### 2.J — Wall spec (4) — counted by `census-wall.md`

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| WL-01 | §17 *"The Wall consumes the platform-wide Global Input Intelligence layer; it does not own a separate autocomplete engine"* (`:119`) | Wall (toward GII) | YES — `services/wall/WallSessionIntentService.ts` delegates parsing to `lib/inputAssistance`; the Wall owns no tokenizer | census-wall **W67 `C`** — and note W71, the half it declined, is **G-08** above |
| WL-02 | §22 *"The Wall must not implement a second place-state system. All current-state labels come from the shared Live Places/Live Intelligence projections."* (`:148`) | Wall (toward Live Intelligence) | YES — every current-state label routes through `lib/liveClaimRead`; `LiveForYouService.ts:34-39` explicitly refuses a second events gate | census-wall **W89 `C`** |
| WL-03 | §11 *"Passport may show curated Postcards, but the Wall projection remains a social object"* (`:91`) | Passport | COULD NOT ESTABLISH from the Passport side | census-wall (§11 rows) — **not** census-passport |
| WL-04 | §34 Moderation takedowns propagate to cached Wall projections (`:294`) | Moderation/Safety | COULD NOT ESTABLISH | census-wall (§34 rows) |
