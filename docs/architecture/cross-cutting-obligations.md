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

**This is not a Sensing-only phenomenon.** Section 1 below names the other cross-cutting specs, and
Section 8 gives the honest sentence for every surface.

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

**Censuses read.** Eight existed when this pass began; **two more landed while it ran** and were
folded in on re-check, which changed the findings materially and is recorded rather than hidden:

| Census | Denominator | State when read |
|---|---|---|
| `census-sensing.md` | 127 | complete — 81.9 % / 51.2 % |
| `census-wall.md` | 205 | complete — 95.1 % / 91.7 % |
| `census-passport.md` | 169 | complete — 98.2 % / 85.8 % |
| `census-highlights-memories.md` | 266 | complete — 28.6 % / 6.4 % |
| `census-telegraph.md` | 451 | complete — 41.9 % / 21.3 % |
| `census-map.md` | 293 | complete — 96.6 % / 80.2 % |
| `census-layover.md` | 296 | complete — 32.4 % / 3.4 % |
| `census-media.md` | 450 | **completed during this pass** — 80.0 % / 64.7 % / **48.0 % attributable** |
| **`census-input-intelligence.md`** | **373** | **landed mid-pass** (commit `feedfb0a`) — complete, 80.2 % / 61.7 % / **55.5 % attributable** |
| **`census-trips.md`** | **451** | **landed mid-pass, still INCOMPLETE at filing** — headline placeholders, **spec-attributable already final at `0 / 451 = 0.0 %`**; grew 259 → 324 → 557 lines while this document was written, frontier advancing §6 → §16 of 25 |

So **all ten spec subjects now have a census**, and Section 6 shrank from 15 rows to 1 while this
document was being written — twice. What has **not** changed is the finding this document exists for: **not one of
the 108 obligations below is counted by the census of the surface that owes it.**

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

### 2.B — Global Input Intelligence spec (8) — census landed mid-pass

`docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt:8` declares the
spec cross-cutting in its own status line:

> *"This is not owned by Discovery, Media, Map, Trips, Telegraph, Compass, or Create. Those
> surfaces consume it through a shared platform layer."*

**This section was written when the only artifact was
`docs/architecture/input-intelligence-certification.md` — a certification of the platform layer
against §49, scoped to `lib/inputAssistance/*` plus `platform/input-assistance/*` (`:3-14`), which
builds no denominator and never asks, per consuming surface, whether that surface adopted the
layer. All eight rows were then counted by nobody.**

**`census-input-intelligence.md` (373 requirements, 80.2 % constructed / 61.7 % correct / 55.5 %
spec-attributable) landed at commit `feedfb0a` while this pass was running, and it counts all
eight.** They are now counted exactly like Sensing's: **inside GII's own denominator, and by none
of the seven surfaces that owe them.** That census's own closing verdict is worth quoting, because
it contradicts the certification this section originally had to rely on: *"'Recommendation:
certify for launch on the code-verifiable dimensions' — **Not supportable at this denominator.**"*
(`census-input-intelligence.md:1203`).

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
| G-01 | No surface owns a separate autocomplete/typeahead engine; all typed assistance goes through the shared layer (`:8`, core rule `:7`) | Discovery, Media, Map, Trips, Telegraph, Compass, Create | **PARTIAL — three competing paths found.** `routes/discoverySearch.ts:1831` `GET /api/discovery/suggest — grouped live typeahead` imports nothing from `lib/inputAssistance`; `routes/hashtags.ts:8` `GET /api/hashtags/suggestions — autocomplete`; `routes/places.ts:424` `/places/google-autocomplete`. The Wall by contrast delegates correctly (`WallSessionIntentService.ts`, census-wall W67 `C`) | census-input-intelligence **G6 `W`** — *"The layer is real and 10 screens consume it, but four independent engines are still live and unmigrated"*, naming `hooks/useSearchSuggestions.ts` and `hooks/useGooglePlacesAutocomplete.ts` among them. **Counted by no consuming surface's census.** |
| G-02 | §14 Zero-character assistance per context: City picker, Place picker, **Telegraph recipient**, **Compass prompt**, Global Search, **Hidden Gem location** (`:140-152`) | Telegraph, Compass, Hidden Gems, Search, Trips | PARTIAL — policies exist for all six contexts; client wiring found for search / geo picker / telegraph recipient / compass AI / creation only | census-input-intelligence **G85–G90**: Telegraph recipient `C` (G87), Compass prompt `C` (G88), city picker `W`, Global Search `W`, **Place picker `N`**, **Hidden Gem location `W`** |
| G-03 | §16 Context carryover bounded to the active task/session; must not silently change unrelated persistent preferences (`:160-163`) | Trips, Compass, Hidden Gems, Events | PARTIAL — the session-bias comparison exists (`lib/inputAssistance/gateway.ts:165-168`); could not establish that every consuming surface honours the boundedness rule | census-input-intelligence **G107 `W`, G108 `C`** — carryover is bounded correctly but is *only* `applySessionBias` |
| G-04 | §17 Autofilled dependent fields remain visible, attributable and editable; no invisible field mutation (`:164-166`) | Trips, Events, Hidden Gems, Create | COULD NOT ESTABLISH — no cross-field prefill contract found under a searchable name | census-input-intelligence **G109 `W`, G110 `C`** — the city binding is complete; no invisible mutation (`SmartInput.tsx:112-117`) |
| G-05 | §21 Smart action suggestions per surface: Telegraph (share place/meeting point/Trip stop), Search (Add to Trip, Save, Open Map, Ask Compass, directions), Trip (add stop, reorder, invite Crew), Hidden Gem (drop pin, confirm existing), Compass (convert phrase into structured request) (`:201-215`) | Telegraph, Search, Trips, Hidden Gems, Compass | PARTIAL — `'action'` is a declared assistance type (`policyRegistry.ts:99`); per-surface action catalogues not found | census-input-intelligence **G132–G136**: **Telegraph actions `N`**, **Trip actions `N`**, Search actions `W` (*"one of five is real end-to-end"*), Hidden Gem `W` |
| G-06 | §22 AI-assisted writing allowed uses, opt-in and never silently inserted: captions, Event/Trip text, **Postcards/Memories**, Buddy listing, Compass (`:216-229`) | Media, Trips, Events, Memories, Buddy, Compass | PARTIAL — `lib/inputAssistance/aiWriting.ts` exists and the certification passes it on the never-silently-insert dimension | census-input-intelligence **G138 `C`, G139 `C`, G140 `C`, but G141 `N` (Postcards/Memories) and G142 `N` (Buddy listing)** — neither is even an `InputContext` |
| G-07 | §20 Constraint-aware suggestions must demote/remove options outside the Trip date window, behind a Buddy safety/payment gate, at protected/sensitive locations, or beyond allowed live freshness (`:190-200`) | Trips, Buddy, Hidden Gems, Places | PARTIAL — freshness and protected-location handling exist (`lib/inputAssistance/liveSuggestions.ts:12-31`); Trip-window and Buddy-gate constraints not found in the ranking path | census-input-intelligence **G122–G126**: **G124 `W` — the Trip-window filter exists and "no caller passes one"**; G123 `N`; G126 `C` |
| G-08 | §25 Voice and Dictation (`:258`) plus §23 typo correction (`:112`, `:238`) | all typed surfaces | **Typo: PARTIAL** — alias expansion only (`lib/inputAssistance/gateway.ts:155-162`, `applyAliases`). **Voice/dictation: NO — `dictation`, `speechRecognition`, `expo-speech` all zero occurrences, verified by grep** | **The deferral loop closed while this pass ran.** `census-wall.md:247` (W71) declined to score it — *"Whether the shared engine actually implements voice input is a Global Input Intelligence question… censused by the sibling agent on that spec. Not counted for or against the Wall"* — and for most of this pass that census did not exist. It now does, and it agrees: **census-input-intelligence `G163` `N`** — *"There is no dictation transport in the app: `travel-buddy-standalone/package.json` declares no speech dependency"*, plus **G326 `N`** for VoiceOver/TalkBack focus management. W71 is answered: **it does not.** |

### 2.C — Trips spec (7) — census landed mid-pass and is **still incomplete**

The Trips spec is a boundary-prohibition spec: its central claim is that other surfaces may
orchestrate but not mutate.

**`census-trips.md` landed while this pass ran and is being written as this is filed.** Denominator
**451**; headline still `PLACEHOLDER_C` / `PLACEHOLDER_W` / `PLACEHOLDER_N`; **spec-attributable
already final at `0 / 451 = 0.0 %`**, with the line *"Not one artifact in this tree was built for
this specification, and I could not find one that has ever heard of it."* The file grew 259 → 324 →
557 lines during the writing of this document, its frontier advancing from §6 to §16 of 25. By the
time of filing it covers **six of these seven rows**; only **T-02** (§18 projections) is beyond its
frontier. Re-check `census-trips.md` before trusting the "Counted by" column below — it moved twice
while this table was being written.

| # | Obligation (spec line) | Owes | Exists? | Counted by |
|---|---|---|---|---|
| T-01 | *"No Map, Compass, Telegraph, Discovery, Buddy, or UI component may independently invent canonical trip state"* — all consequential changes pass through the **Trip Kernel** (`:12`) | Map, Compass, Telegraph, Discovery, Buddy | **NO, and violated.** `TripKernel`, `TripCommand`, `expectedTripVersion`, `aggregateVersion` are all **zero occurrences, verified by grep** — there is no kernel. Canonical trip state is written directly from outside `routes/trips`: `compass/CompassAutopilotEngine.ts:206` (`trip_autopilot_settings` upsert) and `:598` (`trip_autopilot_proposals` insert); `routes/airport.ts:181,183,700` (Layover writing `trip_plan_items`); `lib/visuals/service.ts:566` (`trips` update); `routes/requests.ts:529` (`trip_members` update); `routes/admin.ts:2288` (`trips` update). **Caveat:** this list comes from a literal `.from("trip…")` grep and, per `checkWriterlessReads.ts:39,344-345`, is a **floor, not a ceiling** — dynamic `.from(expr)` and RPC writes are invisible to it | **census-trips `TR1` `N`** (landed mid-pass): *"There is no kernel. `routes/trips.ts:1491-1535` writes `trip_plan_items.status` directly…"* — an **additional** violation site my own grep missed, because my filter excluded `routes/trips`. Before that census: only the World-Intelligence subset, by census-sensing S84 (`BC`) |
| T-02 | *"Map, Compass, Discovery, Telegraph, Safety, Buddy, Passport, and Memory consume explicit Trip projections/contracts rather than duplicating Trip semantics"* (`:25`, `:488`) | Map, Compass, Discovery, Telegraph, Safety, Buddy, Passport, Memory | PARTIAL — the Map side is real (census-map M145 `C`, `features/map/trip/tripMapSources.ts:16`, DTOs in, no re-derivation) and Passport's Trips variant is consumed (census-passport P96 `C`). But **none of the eight named projections exists by name**: `TripTodayProjection`, `TripMapProjection`, `TripCompassProjection`, `TripMemoryProjection`, `TripPassportProjection` are **zero occurrences, verified by grep** (`:373`) | Map side by census-map M145; Passport side by census-passport P96. **The projection contracts themselves: NOBODY yet** — Trips §18 is still beyond census-trips' §16 frontier. **This is the last uncounted cross-cutting obligation in Portava.** |
| T-03 | *"Discovery, Compass, Saved Ideas, and Buddy matching consume these [Temporal Freedom] windows rather than independently calculating 'free time'"* (`:185`) | Discovery, Compass, Saved Ideas, Buddy | **NO, and violated.** `FreedomWindow` / `freedom_window` / `temporalFreedom`: **zero occurrences, verified by grep**. Independent free-time arithmetic exists instead: `lib/portavaRank.ts:86` *"Minutes of free window (layover mode / availability) — actionability cap"* and `:246` *"Layover/limited-window mode: must start within the window"*; `routes/hiddenGems.ts:137-138` `minimumLayoverMinutes` | census-layover counts the **engine** (L56–L59) from Layover's side. **census-trips `TR131` `N`, `TR132` `N`, `TR133` `N`** now count the consumer side: *"Each does its own thing: `compass/CompassTools.ts:141-157` `check_trip_conflicts` re-derives overlap from `trip_plan_items.day_date`…"* — an independent-calculation site my grep missed. Still counted by **none** of Discovery, Compass or Buddy |
| T-04 | Compass may create a proposal but cannot silently mutate other participants' commitments (`:234`); Compass authority is bounded — may not invent canonical flight/booking/place facts, relax safety, or expand certified freedom (`:278`) | Compass | PARTIAL — `compass/CompassTools.ts:305` `AddToTripProposal` is a real proposal shape; but `CompassAutopilotEngine.ts:598` inserts `trip_autopilot_proposals` directly, without a kernel to arbitrate | census-trips **TR155 `C`** — *"The one §9 requirement that is genuinely met, and met deliberately: `CompassTools.ts:14` — 'add_to_trip proposes only'"* — and **TR215 `C`** for the authorization bound. **My PARTIAL verdict was too harsh on the proposal path and is corrected by TR155; the autopilot writes remain a separate T-01 violation.** Counted by no Compass census, there being none |
| T-05 | Trips must remain fully operational without Compass; AI is not a safety dependency (`:283`) | Compass, Trips | COULD NOT ESTABLISH — no degradation test for a Compass-absent Trip found | **census-trips TR222 `C`** — *"every trip route is registered independently… `src/test/tripsHostingDegraded.test.ts` exercises the degraded path"*. **My COULD-NOT-ESTABLISH is resolved: it does hold.** |
| T-06 | The Trip Map must never draw a stale location as if it were current; marker treatment and accessible text expose freshness (`:244`) | Map | PARTIAL — the Map carries `freshness` on every object (`lib/mapObjects.ts:362-398`, census-map) but the *trip-crew* staleness rule specifically was not located | **census-trips `TR165` `W` — and it is a violation, not a gap**: *"It does. `buildCrewCard` (`lib/tripCrewLocation.ts:131-146`) returns `statusLabel: \"live_sharing_active\"` with an `areaLabel` whenever a live-share grant is active, regardless of how old…"*. **Counted by census-trips, owed by the Map, and absent from census-map's 96.6 %** |
| T-07 | Public Trip content must not leak lodging detail, exact private location, future absence from home, safety state, or unconsented participant data (`:175`) | Map, Discovery, Wall, Telegraph, Media | PARTIAL — Map's private-anchor handling exists (Map spec §14.1); the cross-surface guarantee was not verified end-to-end here | census-trips **TR117 `C`** for the lodging clause (`src/test/tripPrivacy.test.ts:5-8`); the other four leak classes across five surfaces remain unverified |

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

---

## 3. Totals

| | |
|---|---|
| **Cross-cutting obligations found** | **108** |
| Counted **only** by the *demanding* spec's census, never by the *owing* surface's census | **106** |
| Counted by **NO census at all**, at the moment of filing | **1** (T-02) |
| Counted by **two** censuses (the same obligation text) | **1** |
| **Counted by the census of the surface that owes them** | **0** |

**The last row is the finding.** Three censuses landed or completed while this pass ran and moved
**14 of the 15** obligations out of the "counted by nobody" column into the "counted by the
demanding spec" column. **Zero moved into the column that would actually help a reader of a
per-surface percentage.** The orphaning problem is being solved by sheer census coverage. The
misfiling problem is not being solved at all, and finishing every remaining census will not
touch it.

Per originating spec:

| Spec | Obligations placed on other surfaces | Its census | Where they are filed |
|---|---|---|---|
| **Sensing** | **56** (52 in §7–§17 "Required Tweaks" + 4 in §1/§6) | `census-sensing.md`, 127 items | inside Sensing's **51.2 % correct** |
| **Global Input Intelligence** | **8** | `census-input-intelligence.md`, 373 items *(landed mid-pass)* | inside GII's **61.7 % correct** |
| **Trips** | **7** | `census-trips.md`, 451 items *(landed mid-pass, frontier §16 of 25)* | **6 filed (TR1, TR117, TR133, TR155, TR165, TR222); 1 not yet reached (T-02)** |
| **Telegraph v1.1** | 7 | `census-telegraph.md`, 451 items | inside Telegraph's 21.3 % correct |
| **Layover** | 6 | `census-layover.md`, 296 items | inside Layover's 3.4 % correct |
| **Passport** | 6 | `census-passport.md`, 169 items | inside Passport's 85.8 % correct |
| **Highlights / Memories** | 5 | `census-highlights-memories.md`, 266 items | inside its 6.4 % correct |
| **Media** | 5 | `census-media.md`, 450 items *(completed during this pass)* | inside Media's **64.7 % correct** |
| **Map** | 4 | `census-map.md`, 293 items | inside Map's 80.2 % correct |
| **Wall** | 4 | `census-wall.md`, 205 items | inside Wall's 91.7 % correct |

---

## 4. The shape of the failure

The censuses are not wrong. Each one measured its spec faithfully, and Passport's, Layover's and
Input Intelligence's went out of their way to record cross-surface adoption honestly
(`census-passport.md:305-315`, `census-layover.md:694-702`,
`census-input-intelligence.md:305` G6, `census-trips.md` TR133/TR165). The failure is **filing**,
and it has three forms:

**Form 1 — misattribution (106 obligations).** Spec A requires surface B to do something. Census A
counts it. Census B does not know it exists. The per-spec table then reads as if B's percentage
answered "how done is B", which it never did. The Wall/`WallMoment` case is the canonical
instance; Layover's §25 matrix (L-04) and GII's G6 are the same failure in censuses that landed
today.

**Form 2 — orphaning, all but closed (1 obligation).** When this pass began, fifteen obligations
were counted by nobody because two specs had no census. Both censuses arrived during the pass, and
`census-trips.md`'s frontier advanced from §6 to §16 between two readings of it. **The residue is
one row: T-02**, the eight-surface Trip-projection contract, which sits in Trips §18. Expect it to
reach zero shortly — **and expect Form 1 to be entirely unaffected by it.** Orphaning is a problem
that more censuses fix; misfiling is a problem that more censuses *create*.

**Form 3 — the deferral loop, closed today.** `census-wall.md:247` declined to score W71 because
it *"is a Global Input Intelligence question… censused by the sibling agent on that spec"*, and
that census did not then exist. It does now, and answers `N` (G163). Had this document been
written a day earlier, W71 would have been an obligation handed by one census to another census
that never existed. **The failure mode is real even when it resolves.**

---

## 5. Counted twice

Only **one** obligation is counted twice as the *same requirement text* in two denominators:

| Obligation | Counted by | Counted by | Note |
|---|---|---|---|
| **MD-02 / MP-01** — Media Map consumes the canonical Map projection system and owns no second location engine (Media `:217`); Map does not own the facts other domains own (Map `:11`) | census-media §21 | census-map §20 M140–M152 | Two specs asserting the same boundary from opposite sides. Both verdicts agree (`C`), so nothing is inflated — but the boundary is worth **one** fact, not two. |

There is additionally one **finding** counted twice, which the second census flagged itself:

| Finding | Counted by | Counted by | Note |
|---|---|---|---|
| **SX-28** — nothing under `services/airport/` reads `liveClaimRead`; live experience value, forecast and friction never reach the Layover feasibility intersection | census-sensing **S85 `BW`** | census-layover **L81 `N`** and **L276 `N`** | `census-layover.md:380` says so explicitly: *"the same finding `census-sensing.md:290` records from the other side"*. One absence, three requirement rows, two denominators. |

And one **near-miss** worth recording, because it is the shape a future double count will take:

| Near-miss | Detail |
|---|---|
| **G-01 / WL-01** | The Wall spec §17 requires the Wall to consume the shared input layer (census-wall **W67 `C`**); the GII spec requires no surface to build its own (census-input-intelligence **G6 `W`**). The **Wall** is the one surface both agree got it right, and each census reached that verdict independently without citing the other. Two censuses, one fact, two `C`/`W` rows — and if the Wall had got it *wrong*, it would have been marked wrong twice. |

### Artifact-level overlaps — not double counting, but worth knowing

Six artifacts are scored in two censuses against **different** requirement sentences. Neither
census is inflated; but a reader who fixes the artifact should expect two censuses to move.

| Artifact | Sensing row | Surface-census row |
|---|---|---|
| `lib/mapProducers/worldPulseProducer.ts` and the Phase-7 kinds | SX-03 / S60 `BW` (it is a *level*, not a *change*) | census-map **M282 `W`** (built, flag seeded OFF) |
| `lib/mapAggregation.ts` crowd-flow geometry | SX-04 / S61 `BC` | census-map **M63, M69 `C`**; **M5, M221 `W`** (mode unreachable in production) |
| `lib/mapAggregation.ts:202-244` zoom bands | SX-06 / S63 `BC` | census-map **M126, M127 `C`** |
| `routes/mapProjection.ts` gateway ownership split | SX-10 / S67 `BC` | census-map **M140–M152 `C`** |
| `services/wall/FollowingFeedService.ts` chronological contract | SX-18 / S75 `BC` | census-wall §13/§14 rows |
| `services/wall/LiveForYouService.ts` | SX-19 / S76 `BW` (**half** built — the transitions half is missing) | census-wall **W3, W11, W13–W20, W23, W101 — all `C`** |

The last row is the mechanism of the misdirection in miniature. Eleven `C` verdicts in
`census-wall.md` describe the Live For You strip correctly. `census-sensing.md` scores the same
strip `BW` because the Wall spec never asked for the other half — the chronological transition
record — and the Sensing spec did.

---

## 6. Counted by nobody — the blind spots

**1 obligation**, down from 15 when this pass began and from 6 four edits ago. The number moved
twice while this document was being written, as `census-input-intelligence.md` landed and
`census-trips.md` advanced from §6 to §16 of 25 sections.

| # | Obligation | Owes | Status |
|---|---|---|---|
| **T-02** | *"Map, Compass, Discovery, Telegraph, Safety, Buddy, Passport, and Memory consume explicit Trip projections/contracts rather than duplicating Trip semantics"* (Trips `:25`, `:488`) | eight surfaces | **PARTIAL, and uncounted.** All five named Trip projection contracts — `TripTodayProjection`, `TripMapProjection`, `TripCompassProjection`, `TripMemoryProjection`, `TripPassportProjection` — are **zero occurrences, verified by grep**. Trips §18 is beyond `census-trips.md`'s current frontier |

**Do not read the "1" as good news.** What the shrinking column actually shows is that
**orphaning was never the main problem.** Every obligation that moved out of this column moved
into *the demanding spec's* denominator, not the owing surface's. The four verified violations
this document surfaced are all now "counted" — and every one of them is counted somewhere its
owner will never look:

| Violation | Counted by | The surface that owes it, and where it is *not* recorded |
|---|---|---|
| **No Trip Kernel exists; canonical trip state is written from seven sites** — `routes/trips.ts:1491-1535`, `compass/CompassAutopilotEngine.ts:206,598`, `routes/airport.ts:181,183,700`, `lib/visuals/service.ts:566`, `routes/requests.ts:529`, `routes/admin.ts:2288` (a **floor**, per `checkWriterlessReads.ts:39,344-345`) | census-trips **TR1 `N`**; the intel subset by census-sensing **S84 `BC`** | Compass and Layover each write canonical trip state. Neither has a row for it: **Compass has no census at all**, and `census-layover.md`'s L267 scores the Trips seam `W` for what it *lacks*, not for what it *writes*. |
| **No Temporal Freedom Engine; free-time arithmetic duplicated** — `lib/portavaRank.ts:86,246`, `routes/hiddenGems.ts:137-138`, `compass/CompassTools.ts:141-157` | census-trips **TR131, TR132, TR133 — all `N`** | Owed by Discovery, Compass, Saved Ideas and Buddy. **None of the four has a census.** |
| **The Trip Map draws stale location as if it were current** — `lib/tripCrewLocation.ts:131-146` returns `live_sharing_active` regardless of age | census-trips **TR165 `W`** — *"It does."* | Owed by the **Map**. `census-map.md` reports 96.6 % constructed / 80.2 % correct over 293 requirements and **does not contain this row**. |
| **Four independent autocomplete engines remain live and unmigrated** — `hooks/useSearchSuggestions.ts`, `hooks/useGooglePlacesAutocomplete.ts` and two others, plus `routes/discoverySearch.ts:1831` and `routes/hashtags.ts:8` server-side | census-input-intelligence **G6 `W`** | Owed by Discovery, Media, Map, Trips, Telegraph, Compass and Create. **Recorded in none of their censuses**; the Wall's, which *does* record its side, marks it `C` (W67). |

Two of my own verdicts were **corrected** by censuses that landed after I wrote them, and are left
visible rather than quietly amended: T-04 (I said PARTIAL; `census-trips` TR155 `C` shows
`CompassTools.ts:14` proposes only, deliberately) and T-05 (I said COULD NOT ESTABLISH;
`census-trips` TR222 `C` names `src/test/tripsHostingDegraded.test.ts`). Both corrections came from
the *demanding* spec's census — which is precisely the asymmetry this document is about: the spec
that demands looks; the surface that owes does not.

### The second-order blind spot — unchanged by any census that landed today

Beyond T-02 there is a category no count captures and nothing that landed today addresses: **the
eleven surfaces with no spec and no census** — Compass, Home, Discovery, Safety/Trust, Presence,
Rent-a-Buddy, Locate My Friends, Hidden Gems, Search, Create, Attention. For those, *every*
obligation is cross-cutting, and the only reason any of them is measured at all is that a demanding
spec's census happened to look. **Compass carries at least 28 inbound obligations from eight
different specs, is a named violator in two of the four violations above, and has never been
measured against a denominator of its own.** Ten spec subjects now have a census; eleven surfaces
still have nothing.

---

## 7. Obligations that are GATED, not merely missing

Per `docs/discovery/ROADMAP.md`, an obligation that may not be built is a different fact from one
nobody built. These rows are **gated**, and the gating line is quoted rather than the obligation
being listed as simply absent.

| Obligation | Gate | Gating line |
|---|---|---|
| **SX-11 / S68** — Discovery ranks on live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value | **RANKER ON EXPLICIT OWNER HOLD** | `ROADMAP.md:222` — *"**RANKER WORK GOES ON EXPLICIT HOLD once Phase B resolves**… **No optimising ranking machinery over an empty corpus.**"* and `:224-226` — *"Item 4 supersedes the redirect's 'Phases A–D land as planned' for the ranker portions specifically."* The one live-ish input, `localMomentum`, sits behind `discovery_ranking_modifiers_enabled`, seeded OFF with a migration postcondition that RAISEs if it is ever seeded on (`ROADMAP.md:648`, `migrations/2289:70-74`) |
| **SX-15 / S72** — intent modes on shared live intelligence | same ranker hold | `ROADMAP.md:648` |
| **SX-13 / S70** — server-built `DiscoveryCandidate` with why-now | same ranker hold; also downstream of Phase B | `ROADMAP.md:530` — Phase B *"**PARKED — 2026-08-15. NOT closed, NOT abandoned, and the exit criterion remains UNMET.** Re-checked 2026-09-05: **unchanged**"* |
| **The `pde` flip and any shadow cohort** that a live-ranking Discovery obligation would ride on | **Phase F owner gates, both unruled** | `ROADMAP.md:534` — *"❄️ **FROZEN** + **NOT AGENT WORK**. The two gates still stand absolutely, and **both are still unruled**"*; `:646-647` — both verified SHUT in code |
| **Phase E measurement readiness**, which any calibration claim (Sensing S11 / shadow mode) would need | **FROZEN** | `ROADMAP.md:533` — *"❄️ **FROZEN** — superseded destination. Step 3… is **still owed and still NOT satisfied**"* |
| **Event Truth** — the contract that would encode *"ABSENCE OF EVIDENCE MUST NEVER SILENTLY BECOME EVIDENCE OF ABSENCE"* (`ROADMAP.md:21`), the general form of Sensing's *"No coverage ≠ quiet"* (SX-… §2) | **Next architectural foundation, not yet built; may run in parallel** | `ROADMAP.md:23-24` — *"**Phase B tests this in the current system. Event Truth must encode it permanently.**"*; `:222` item 3 — *"**Event Truth remains the next architectural foundation** … **Must not become another week of invisible infrastructure**"* |

**Not gated, and therefore genuinely just missing:** SX-16, SX-17 (`WallMoment`), SX-21
(`GO NOW`), SX-23 (switching cost), SX-26 (`TripWorldContext`), SX-29 (peak interception), SX-35
(`ExperienceSession`), SX-45 (Attention Engine), SX-55 (Opportunity Engine), T-01, T-03, G-08.
Nothing in `ROADMAP.md` mentions any of them.

---

## 8. The sentence a reader may honestly say, per surface

Each sentence below is the longest true statement available. The short form — *"the Wall is 91.7 %
done"* — is **not** available for any surface in Portava, and this section exists so that nobody
says it again.

Inbound counts are obligations owed **by** that surface **from other specs**. They sum to more than
108 because a single obligation naming N surfaces appears in N rows.

> ### Wall
> **The Wall is 95.1 % constructed and 91.7 % correct against its own 205-requirement spec
> (`census-wall.md:15-20`), and it is the strongest of the completed censuses.** It additionally
> owes **7 obligations from other specs** — five from Sensing §9 (SX-16…SX-20), one from Sensing
> §1 (SX-53) and one from Trips §8 (T-07) — **none of which is inside the 205**. Of the five
> Sensing ones, **two exist** (SX-18, SX-20), **one is half-built** (SX-19 — the Live For You
> strip is exact; the chronological transition record it is supposed to complement does not
> exist), and **two have zero occurrences**: the Wall has no state-transition concept at all
> (SX-16) and **`WallMoment` does not exist anywhere in the tree** (SX-17). The Wall's
> outbound obligations (WL-01…WL-04) are counted, but W71 — voice/typo — was deferred to a census
> that was never written.

> ### Map
> **The Map is 96.6 % constructed and 80.2 % correct against its own 293-requirement spec, and is
> the only surface with a non-zero spec-attributable figure (76.5 %, `census-map.md:15-19`).** It
> additionally owes **at least 21 obligations from six other specs** — ten from Sensing §7, four
> from Layover (§3, §13, §25), two from Passport (§21 Map variant, §26), two from Trips, one from
> Media §21, one from Highlights (`MapTrailDerivative`) and one from GII. Of the ten Sensing ones,
> **five are correct and five diverge**: no `ExperienceState` reaches the projection (SX-02),
> `world_pulse` publishes a level rather than a change (SX-03), coverage is absent from `MapObject`
> (SX-07), the display resolver is a priority sort plus a page cap (SX-08), and the safety-outranks-
> opportunity rule **holds inside the Map and fails across surfaces** (SX-09). Passport §21 has
> **no Map variant at all** (P-02 / census-passport P98 `N`). And the Trips census, which landed
> after census-map, records a Map defect census-map does not contain: **the Trip Map draws a stale
> crew location as if it were current** (`census-trips.md` TR165 `W`, *"It does"*,
> `lib/tripCrewLocation.ts:131-146`). **The Map's 80.2 % does not know about it.**

> ### Passport
> **Passport is 98.2 % constructed and 85.8 % correct against its own 169-requirement spec — the
> highest constructed figure in the tree.** It additionally owes **8 obligations from four other
> specs**: two from Sensing §13 (both correct — SX-36, SX-37), one from Media §29 (MD-01, half
> built — `MediaEntityKind` has no passport member), three from Highlights (H-02, H-03, H-04 — all
> `COULD NOT ESTABLISH`, and all four named Memory→Passport projections have zero occurrences),
> one from Layover §25 and one from Trips. **And its own census is the one that shows how thin the
> outbound side is**: §21's consumer projections are *"three of seven consumers"* adopted
> (P169 `W`), with the Passport certification not testing §21 at all
> (`census-passport.md:561-563`).

> ### Telegraph
> **Telegraph is 41.9 % constructed and 21.3 % correct against its own 451-requirement v1.1 spec.**
> It additionally owes **12 obligations from four other specs**: four from Sensing §12 — of which
> **two are NOT-BUILT and two are vacuously satisfied**, meaning the Sensing integration is
> effectively absent (`POST /telegraph/recommend` returns model prose with no canonical entity id,
> which is the exact shape Sensing §12 forbids) — plus one from Layover §25 (where *"the message
> is discarded"*, census-layover L271), two from Trips, two from Passport §21 (its
> `TelegraphHeaderProjection` is built but has no caller, P99 `W`) and three from GII.

> ### Layover
> **Layover is 32.4 % constructed and 3.4 % correct against its own 296-requirement spec
> (`census-layover.md:15-19`).** It additionally owes **3 obligations from two other specs**: two
> from Sensing §11 (SX-28, SX-29 — no live experience value reaches feasibility; no peak
> interception exists) and one from Trips §1 (T-01 — `routes/airport.ts:181,183,700` writes
> `trip_plan_items` directly, with no Trip Kernel to pass through). **And Layover's own outbound
> obligations are its census's worst column**: all nine §25 integration rows are `W`, and the
> canonical `LayoverSnapshot` that §66 says every surface must consume **does not exist by name and
> is consumed by no surface** — no Compass, Trips, Discovery or Map file references layover at all.

> ### Media
> **Media is 80.0 % constructed and 64.7 % correct against its own 450-requirement spec, at 48.0 %
> spec-attributable — the census completed during this pass.** It additionally owes **4 obligations from three other specs**: two from GII (G-01, G-06),
> one from Trips (T-07) and one from Telegraph (TG-03). Media is also the site of a **semantic
> collision between two specs**: `ExperienceState` in
> `travel-buddy-standalone/src/features/media/types/mediaExperience.ts:13` is a seven-value
> lifecycle enum (`upcoming`…`typical`) required by Media §23, while Sensing §5.3 defines
> `ExperienceState` as a composite of Crowd / Vibe / Behavior / Friction / Dynamics / Truth.
> census-media scores its version `C` (MD164, MD166); census-sensing scores its version `NB`
> (S43). **Both are right about different things under one name, and neither census mentions the
> other.** Note also that census-sensing S43's evidence grep was scoped to the api-server `src/`
> and would not have seen the client declaration — the verdict stands on meaning, but the grep
> that supports it is incomplete.

> ### Highlights / Memories
> **Highlights/Memories is 28.6 % constructed and 6.4 % correct against its own 266-requirement
> spec — the lowest constructed figure of any completed census.** It additionally owes **7
> obligations from four other specs**: two from Sensing §13 (SX-34 satisfied vacuously; SX-35 —
> the `ExperienceSession` bridge — has zero occurrences), two from Telegraph (shared-memory
> resurfacing under block cascade, and the content-capability registration), one from GII, one from
> Layover §25 and one from Trips.

> ### Trips — census in flight
> **No constructed/correct percentage is available yet: `census-trips.md` landed during this pass
> with a 451-requirement denominator, placeholder headline values, and a frontier that advanced from
> §6 to §16 of 25 sections between two readings.** One number it already states is final and is the
> worst in the corpus: **spec-attributable `0 / 451 = 0.0 %`**, with the sentence *"Not one artifact
> in this tree was built for this specification, and I could not find one that has ever heard of
> it."* Trips owes **16 obligations from eight other specs** (two from Sensing §11, three from
> Layover, one from Passport §21, two from Telegraph, four from GII, two from Highlights, one from
> Media, one from Map §11), **none of which census-trips counts**. And Trips itself places **7
> obligations on five other surfaces**, of which **six are now counted by census-trips and one
> (T-02) by nobody** — and **three are verified violations that no surface's census records**:
> there is **no Trip Kernel** and canonical trip state is written from seven sites including
> Compass and Layover (TR1); there is **no Temporal Freedom Engine** and Discovery, Compass and
> Buddy each compute free time themselves (TR131–TR133); and **the Trip Map draws stale crew
> location as current** (TR165).

> ### Global Input Intelligence
> **Global Input Intelligence is 80.2 % constructed and 61.7 % correct against its own
> 373-requirement spec, and at 55.5 % spec-attributable it is the second-highest attribution in the
> corpus after the Map** (`census-input-intelligence.md:19-28`). It additionally owes nothing —
> it is a platform layer, not a surface — but it **places 8 obligations on seven surfaces
> (Discovery, Media, Map, Trips, Telegraph, Compass, Create), none of which is counted by any of
> those seven surfaces' censuses**. Of the eight: the shared layer is real and broad (26 typed
> contexts, `lib/inputAssistance/policyRegistry.ts:97-321`) and ten screens consume it, but **four
> independent autocomplete engines remain live and unmigrated** (G6 `W`), **Telegraph and Trip
> smart actions do not exist** (G133, G135 `N`), **Postcards/Memories and Buddy AI writing are not
> even declared contexts** (G141, G142 `N`), the Trip-window constraint filter **exists and no
> caller passes one** (G124 `W`), and **voice/dictation has zero occurrences** (G163 `N`). That
> census's closing line is the one to quote against the earlier certification: *"'Recommendation:
> certify for launch on the code-verifiable dimensions' — **Not supportable at this
> denominator.**"* (`:1203`)

> ### Compass and Home — **no spec, no census**
> **Compass is the most-obligated surface in Portava and has never been measured.** It is named by
> all eleven specs and carries **at least 28 inbound obligations from eight of them**. Of the five
> that Sensing §10 states explicitly, **three do not exist** (`GO NOW`-class decisions,
> switching cost, and grounded natural-language constraint) and **two do**, one of them under a
> different name (`routes/compassHome.ts` discharges `UserNowProjection`). Compass is also a named
> violator in T-01 (`compass/CompassAutopilotEngine.ts:206,598`) and a named non-adopter in
> Passport P-02/P169.

> ### Discovery — **no spec, no census**
> **No honest percentage is available.** Discovery carries **at least 20 inbound obligations from
> seven specs**. Five come from Sensing §8, of which **three diverge and one is NOT-BUILT** — and
> the NOT-BUILT one (SX-11, live ranking) is the single obligation in this document that is
> explicitly **gated by an owner hold**, not merely unbuilt. Discovery also runs one of the three
> typeahead paths that G-01 forbids (`routes/discoverySearch.ts:1831`).

> ### Safety and Trust · Presence, RAB and Locate My Friends · Places, Events and Hidden Gems · Search, Create and Attention — **no spec, no census**
> Between them these carry **34 inbound obligations**, every one of which is recorded only in
> `census-sensing.md` (SX-38…SX-52), `census-passport.md` or `census-layover.md`. The strongest
> single fact: **the Attention Engine, which Sensing §15 calls "mandatory" (SX-45), does not
> exist, has no owner, no spec and no census** — no world change produces a notification at all,
> and the ten-level priority stack that exists instead has **no WALL routing option**.

---

## 9. What could not be established

Stated plainly, because a legitimate "don't know" is more useful here than a guess.

1. ~~**Whether the Trips and Global Input Intelligence `.docx` originals agree with their
   `.txt`.**~~ **Resolved mid-pass by the two censuses that landed.**
   `census-input-intelligence.md:6` reports the GII `.txt` and `.docx` **identical** after
   whitespace/Unicode normalisation; `census-trips.md:6` reports the Trips pair differing only in
   **two XML entity escapes**. No row in this document rests on a transcription difference. What
   still could not be established is the **section count** the two censuses corrected: the GII
   brief said 59 sections and it is 58; the Trips brief said 25 and *"it is a serious undercount
   of the spec, which carries 80 numbered subsections"*. My §-references to those two specs are to
   the top-level headings and are unaffected, but a reader extending this table should use the
   censuses' own numbering.
2. **The completeness of the T-01 violation list.** It was produced by a literal
   `.from("trip…").insert|update|upsert|delete` grep. Per
   `artifacts/api-server/src/scripts/checkWriterlessReads.ts:39` and `:344-345`, dynamic
   `.from(expr)` and RPC writes are invisible to that method, and that check *"errs toward
   silence."* The six call sites named are a **floor**.
3. **Obligations marked `COULD NOT ESTABLISH`**: G-04 (cross-field prefill visibility), T-07
   end-to-end (public Trip leakage across five surfaces — only the lodging clause was resolved,
   by census-trips TR117), P-05 (intent weighting in the Compass/Discovery rankers),
   H-01/H-02/H-03/H-05 (Memory revocation propagation into Passport and Compass), MD-05
   (Trail→executable Compass plan), WL-03, WL-04, TG-04. None was found under a searchable name;
   none is claimed absent. **Two entries that were on this list when it was first written have
   since been resolved by `census-trips.md`** — T-05 (TR222 `C`) and, in the opposite direction,
   T-06 (TR165 `W`, a violation) — and are left visible above rather than silently amended.
4. **The final "Counted by" state of T-02.** `census-trips.md` was actively being written
   throughout this pass (259 → 324 → 557 lines; frontier §6 → §16 of 25), and moved six of the
   seven Trips rows out of "counted by nobody" while this document was open. **T-02 is marked
   "NOBODY yet"; that is true at the moment of filing and is expected to become false.** It is
   recorded rather than smoothed over because the *reason* it will become false — a census
   finishing — is exactly what this document is about, and because the **violations** it
   surfaced (T-01's seven write sites, T-03's duplicated free-time arithmetic, T-06's stale
   Trip-Map location, G-01's four unmigrated autocomplete engines) are facts about the tree that
   no census finishing will change.
5. **Whether any surface census would change its verdict** if it adopted the obligations filed
   here. This document deliberately edits no census. The arithmetic of "Wall 91.7 % over a
   denominator of 205 + 7" is not performed, because the two denominators were built with
   different counting rules and merging them without their authors' rules would manufacture a
   number nobody can defend.
6. **Production liveness.** Every "exists" verdict above describes **code that is correct and
   would run**. `docs/architecture/intel-spine-liveness.md` measured every `intel_*` table in
   production at `count(*) = 0` with the gates open; `census-sensing.md:47-63` and
   `census-layover.md:767` both make the same point about their own numbers. Nothing here is
   evidence that anything has run.

---

## 10. How to use this document

- **Before quoting a per-spec percentage**, read that surface's paragraph in Section 8 and quote
  the whole sentence, not the number.
- **Before starting work on a surface**, read that surface's inbound rows in Section 2. The
  surface's own census is not the requirement list.
- **Before writing a new census**, check Section 2 for obligations other specs place on your
  subject, and say in your census which of them you did and did not count — Passport's and
  Layover's censuses already do this well and are the model.
- **Before deferring a requirement to "the sibling agent on that spec"**, check that the census
  exists. `census-wall.md` W71 did not, and the obligation went to nobody for two weeks.
- **Section 6 is down to one row; Section 2 is the real work queue.** The four boxed violations in
  Section 6 are facts about the tree that no census finishing will fix. Across the whole
  registry the not-gated, not-built set is: SX-16, SX-17 (`WallMoment`), SX-21 (`GO NOW`), SX-23
  (switching cost), SX-26 (`TripWorldContext`), SX-29 (peak interception), SX-35
  (`ExperienceSession`), SX-45 (Attention Engine), SX-55 (Opportunity Engine), T-01, T-03, G-08.
  SX-11 is gated by an owner hold and **must not be started**.
- **Re-read Section 3 against the census list before quoting its totals.** Three censuses landed
  or completed while this document was being written, and moved **14 of 15** obligations between
  columns; `census-trips.md` moved twice on its own. The one number that did not move, and is not
  expected to move, is **zero obligations counted by the census of the surface that owes them**.
