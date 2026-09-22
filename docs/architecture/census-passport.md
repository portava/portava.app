# Portava Passport — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt` (§1–35), `.docx` original authoritative |
| **Tree censused** | `claude/portava-continuation-uqta94`, working tree at `ebe72b34`. Sibling agents committed the shared tree during this pass (HEAD is now `2d40aece`); `git diff ebe72b34..2d40aece` over every Wall, Passport, trust and availability path cited below is **empty**, so every verdict holds at HEAD. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a file:line that was opened and read. |
| **Database** | Not queried. Storage facts are the ones supplied as ground truth (25 `passport*`/`stamp*` tables in production). |

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **169** |
| BUILT-AND-CORRECT | **154** |
| BUILT-BUT-WRONG | **13** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (correct+wrong)/denominator | **167 / 169 = 98.8%** |
| **CORRECT%** = correct/denominator | **154 / 169 = 91.1%** |
| CANNOT-VERIFY share | **1 / 169 = 0.6%** |

Counted from the rows: 154 + 13 + 1 + 1 = 169. Previously 145 / 21 / 2 / 1, then
152 / 15 / 1 / 1.

**Amended 2026-09-14 by the palette pass (§15), which is the only edit this block
has taken since `ebe72b34`.** P129 and P132 moved `W→C` after the owner ruled on
the brand palette (`docs/architecture/brand-palette-decision.md`) and each row was
opened and verified individually, which the ruling's own condition requires. Two
rows, **1.2 points** — not the five rows and 3.0 points §12.1 and §12.4 estimated;
§15.2 says which three did not move and why. Everything else in this block is still
the `ebe72b34` measurement and is dated as such.

**Five rows moved on 2026-09-08, and only one of them by building anything.**
P98 (Map) moved N→C when the map adopted a batch Passport projection — that was
work. P95, P99, P100 and P101 moved W→C on the CALL SITES: each was scored
BUILT-BUT-WRONG on the finding "the variant exists and nothing calls it", and
every one of the six variants now has a caller. Those four were already true at
`ebe72b34 + n`; the census had simply not been re-read. `canProvideVisaBuddyService`
(P59) is now the only NOT-BUILT requirement.

**Two more rows moved later the same day, and this time one was built.** **P68**
(verification treatment in the stamp detail view) moved W→C by building it — the
provenance data was already on that screen and only the *presentation* was
unreachable, so the fix was to give it one home rather than a second copy.
**P138** moved W→C on the call sites with no code change: its finding was that
Follow/Message "still gate on `isAuthed`", and they consume the projection's
capabilities; the one surviving `isAuthed` gate covers Report and Block, which
must stay reachable by someone the subject has blocked.

A note on not double-counting: Discovery's search list and Compass's traveler
suggestions still build identity inline. That remainder is carried by **P169
alone**, which stays W. Scoring it again in P95 and P100 would count one gap
three times and make the surface look worse than it is — the same arithmetic
error in the other direction from the one the layover headline made.

**This census still declares NO `head_commit`, deliberately.** The 169 verdicts
were taken at working tree `ebe72b34`; only **P98, P169, P45 and P50** have been
re-read since (P45/P50 on 2026-09-09, against the code cited in those rows).
Declaring a commit would make `check:census-freshness` report FRESH about a
document whose other 165 rows have not been re-verified — a worse lie than
CANNOT BE CHECKED. It joins the checkable set when it is recensused, the way the
Wall and Trust censuses did.

The four re-read rows do NOT move the headline percentages below, which are still
the `ebe72b34` measurement: P45 and P50 were **W** before this re-read and are
**W** after it, for a materially smaller reason. A recount is a recensus's job,
not a two-row edit's, and quoting a new percentage off two rows would be the
arithmetic error §1 of this document warns about in the other direction.

**Verdict on "~92% construction complete": too low on construction, too high on
correctness, and resting on a CANNOT-VERIFY bucket that the spec does not ask
for.**

Passport is **more built** than the certification says and **less right**. At 169
requirements it measures **98.2% constructed** — because six of that document's
nine open findings have since closed: Shared Context is reachable, public
Memories and Plans render, stamp verification is enforced on the card, Travel DNA
persists, §32 telemetry is fully wired, and the event Passport and Yearbook now
exist. Almost nothing named by this spec is simply absent: only
`canProvideVisaBuddyService` (§11) and the Map consumer projection (§21) have no
implementation at all.

But **21 requirements exist and diverge**, which is why CORRECT% is 85.8% rather
than 98%. Three of them matter more than the rest:

1. **Trust presents a constant as a measurement (§9/§10).**
   *Corrected 2026-09-08 — the defect is real and the stated cause was wrong.*
   This read *"`trust_engine_enabled` is seeded false, so nothing writes
   `trust_events`, `trust_profiles` is empty"*. `false` is the SEED value
   (migration `0166_feature_flags_reconcile.sql:25`). Measured read-only against
   production the same day: the flag is **TRUE and has been since 2026-07-17**,
   `trust_events` holds **5** rows (`pulse_post_created` ×4, `first_event_joined`
   ×1, last one 2026-08-16) and `trust_profiles` holds **2**, against **58**
   profile rows. So the engine is not switched off; it is switched on and almost
   silent — 2 of 58 accounts have ever been scored.
   The defect itself is unchanged: `buildDomainTrust` substitutes the neutral 50
   for the overall score and for every missing category
   (`PassportProjectionService.ts:1004,1011`), and `presentationWord(50)` returns
   "Established" (`:933`), so **56 of those 58 accounts are described as an
   Established member of the community across all six trust domains on the
   strength of a hard-coded number** — and that is not waiting on a flag flip.
   **It has harmed nobody, and the reason matters: those 58 are TEST ACCOUNTS.**
   Portava has not launched (see the standing note in
   `truth-percentage-without-deployment.md`). This is a defect that will meet its
   first real user at launch, not one that is misleading anyone today, and no row
   in this census should be read as a claim about live usage. §9 demands
   "domain-specific, confidence-aware and explainable"; the confidence band is
   real but is computed from stamps and trips rather than from trust evidence
   (`:983-985`), so a high-evidence 82 and a no-evidence default are not
   distinguished — the exact equivalence §10 forbids. Open PR **#467** fixes
   precisely this.
2. **The canonical architecture rule the spec closes on is half-adopted (§21/§35).**
   `PassportConsumerProjections` exists, is correct, and has six variants — but
   `buildConsumerProjection` has **three call sites** (Trips, Buddy, Event).
   Discovery, Compass, Telegraph and Safety still build their own identity
   payloads from `profiles` (`routes/discovery.ts:1504,2523`;
   `routes/discoverySearch.ts:441,483,1574`), which is the precise duplication the
   module's own header says it exists to end, and **Map has no variant at all**.
   Four of §21's seven consumers, plus §35's closing rule, are
   built-but-unadopted.
3. **The design system is a coherent, deliberate inversion of §27.** Dark-mode
   first became a light paper palette; purple became a red seal; the blue/teal
   availability accent is absent. Four §27 requirements and §3's hero composition
   diverge for the same reason. This is a product decision, not a defect — but it
   is five requirements the spec asks for and does not get, and no single
   percentage can say that.

**On the CANNOT-VERIFY bucket specifically.** The certification's §7 lists seven
"Runtime QA" items and leans on them for its remaining ~8%. Six of the seven —
on-device layout of ten screens, VoiceOver behaviour, P95 latency, real push and
booking hand-off, live-DB RLS, camera QR round-trip — **are not requirements in
this spec**. §27's one accessibility clause ("colour is never the only status
indicator") is statically decidable and is met; there is no performance table and
no accessibility section as there is in the Wall spec. So the honest
CANNOT-VERIFY count against the *spec text* is **1**, not seven. Those runtime
checks remain genuinely owed before GA — they are simply not the reason the
construction score is below 100.

---

## 1. Denominator: how 169 was counted

Identical rule to the Wall census in this pair, so the two are comparable:

- **A bullet asserting a required property or behaviour = 1 requirement.**
- **A table row naming a required artifact, condition or behaviour = 1
  requirement.** §2's ten surfaces are ten; §6's eight availability types are
  eight; §11's seven capabilities are seven; §21's seven consumers are seven;
  §22's `Visibility` type plus its sixteen privacy-field rows are seventeen; §33's nine phases are nine.
- **A declared TypeScript interface = 1 requirement for the contract**, unless a
  member carries independent behaviour.
- **A named screen, service, endpoint, event group or phase = 1 requirement.**
- **Narrative and rationale = 0.**

Per-section counts: §1:1 §2:11 §3:7 §4:3 §5:4 §6:9 §7:2 §8:5 §9:5 §10:5 §11:8
§12:5 §13:5 §14:5 §15:4 §16:4 §17:3 §18:1 §19:2 §20:5 §21:7 §22:17 §23:1 §24:2
§25:4 §26:2 §27:7 §28:1 §29:1 §30:2 §31:5 §32:7 §33:9 §34:8 §35:2 = **169**.

**Method caveat inherited from `src/scripts/checkWriterlessReads.ts`:** that
script declares that a dynamic `.from(expr)` anywhere makes writer attribution
INCOMPLETE and that it errs toward silence. Where a verdict turns on "nothing
writes X" I read the writer call sites rather than counting greps.

---

## 2. Requirement-by-requirement

Verdict key: **C** = BUILT-AND-CORRECT · **W** = BUILT-BUT-WRONG · **N** =
NOT-BUILT · **?** = CANNOT-VERIFY. Backend paths are relative to
`artifacts/api-server/src/`, client paths to `travel-buddy-standalone/`.

### §1 Canonical Product Definition

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P1 | One projection combining identity, travel history, state, availability, intent, trust, credentials, reputation, social context, experience history, plans, privacy, viewer relationship and action eligibility | C | `services/passport/PassportProjectionService.ts:1527` `buildPassportProjection` assembles exactly that set in twelve numbered steps and returns one `PassportProjection` (`:1646-1665`). |

### §2 Ten Primary Passport Surfaces

| id | Surface | V | Evidence |
| --- | --- | --- | --- |
| P2 | Passport Home | C | `app/(tabs)/passport.tsx` — identity card (`:719`), stats row, quick links (`:52`), home previews (`:53`). |
| P3 | Stamps | C | `services/passport/UnifiedStampService.ts` + `src/components/passport/PassportStampCollection.tsx`, `src/components/stamps/StampDetailModal.tsx`. |
| P4 | Journeys | C | `services/passport/PassportJourneyService.ts`; `src/features/passport/JourneysScreen.tsx`; route `app/passport/journeys.tsx`. |
| P5 | Memories | C | `services/passport/PassportMemoryService.ts`; `src/components/MemoriesTab.tsx`; viewer path now real (P77/F3 below). |
| P6 | Plans | C | `PassportProjectionService.buildUpcomingPlans:1191`; `src/features/passport/PlansScreen.tsx`; route `app/passport/plans.tsx`. |
| P7 | Availability | C | `services/passport/OpenToPlansService.ts` + `routes/availability.ts:688-786` (window CRUD); `src/features/passport/AvailabilityScreen.tsx`. |
| P8 | Trust & Credentials | C | `PassportProjectionService.buildTrust:975` + `services/trust/TrustPrivacyGuard.ts`; `src/features/passport/TrustScreen.tsx`. |
| P9 | Travel Identity | C | `services/passport/PassportTravelIdentityService.ts`; `src/features/passport/TravelIdentityScreen.tsx`; route `app/passport/travel-identity.tsx`. |
| P10 | My World | C | `services/passport/PassportMapService.ts` (city/country only, `:44-47`); `src/features/passport/MyWorldScreen.tsx`; route `app/passport/my-world.tsx`. |
| P11 | Shared Context | C | `services/passport/SharedContextService.ts`; `src/features/passport/SharedContextScreen.tsx`; route `app/passport/shared-context.tsx`. **Now reachable** — `src/components/passport/PassportHomePreviews.tsx:233` pushes it from the viewer's Home preview band (this closes the certification's F1). |
| P12 | A PassportShell composes the ten | C | The owner tab plus `src/features/passport/passportNav.ts` + `src/navigation/portavaRoutes.ts:662-670`; every surface is route-registered and entered from `PassportQuickLinks` or `PassportHomePreviews`. |

### §3 Passport Home Design

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P13 | Travel hero/cover with a circular profile photo overlapping the hero | **W** | A cover exists (`src/components/passport/PassportIdentityCard.tsx:47` `coverUploading`, `:426` change-cover control) and the avatar is circular with a gold ring (`:679#goldRing:` + `:685#avatarPressable`; the `:653` this row used to cite is a 34 px overlay chip, not the portrait — repaired 2026-09-14), but the composition is a **cream document card with a vertical spine and a left-column avatar** (`:3`, `:391-412`), not a portrait overlapping a hero image. Coherent with the paper metaphor; a literal divergence from §3. Same family as §27. **NOT TOUCHED BY THE 2026-09-14 PALETTE RULING, and this is the ruling's own worked counter-example** (`docs/architecture/brand-palette-decision.md` §4): the row fails on a COMPOSITION — a document card with a vertical spine (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:357#<View style={s.spine}>`) and a left-column avatar (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:671#leftCol:`) where §3 asks for a portrait overlapping a hero image. Not one clause of it names a colour, so there was no palette half to close, and the ruling says so directly: *"the mockup approves the palette only — not a new layout."* **Re-read at this tree on 2026-09-14 and the reading is unchanged.** **Stays W**; it moves when someone builds the overlapping-portrait composition or an owner amends §3, and neither is a palette question. See §15.2. |
| P14 | Name, @handle, verification mark, home country and optional home base immediately visible | C | `PassportProjectionService.buildIdentity:683-696` returns all five, each behind its own gate (`:679-681`); rendered by `PassportIdentityCard`. |
| P15 | Current travel state and Availability/Open to Plans near the top, not buried | C | `src/components/passport/TravelerStateChip.tsx` and `AvailabilityChip.tsx` render in the identity band; server side `buildTravelerState:717` and `buildAvailability:862`. |
| P16 | Trust summary as a concise score/label with drill-down | C | `buildTrust:975` returns label + publicLevel + confidence + domains, numeric score only for self (`:1010-1017`); drill-down via `TrustScoreInfoSheet` and `/passport/trust`. |
| P17 | Travel stats: countries, cities, stamps, Trips | C | `PassportProjectionService.ts:1601-1606` `TravelStats`; `PassportStatsRow` in `PassportIdentityCard`. |
| P18 | Viewer actions Follow / Make a Plan / Message / More; owner actions Edit Passport / Set Availability / My World / Share Passport | C | Viewer: `PassportHomePreviews.tsx:239-249` renders "Make a Plan" gated on `capabilities.actions.can_make_plan`; Follow/Message on the public passport. Owner: `PassportQuickLinks.tsx:57-100` (My World, Trust, Travel Identity, Journeys, Yearbook, Plans, Availability) plus a Share entry delegated to the parent. |
| P19 | High-priority previews: Shared Context, recent stamps, Featured Journey, next Trip, memories | C | `PassportHomePreviews.tsx` — `passport-shared-context-entry` (`:258`), `passport-preview-stamps` (`:280`), `passport-preview-featured-journey` (`:111`), `passport-preview-next-trip` (`:136`), `passport-preview-memories` (`:308`). All five. **This closes the certification's §3 "previews not surfaced" gap.** |

### §4 Viewer Context and Server-Side Projection

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P20 | One projection system with context-specific views; no separate profile systems | C | `buildPassportProjection` is the single assembler; `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:892#buildConsumerProjection` `buildConsumerProjection` derives every consumer variant *from it* rather than re-reading. (Adoption is incomplete — see §21.) |
| P21 | `PassportViewerContext` union of nine values | C | `PassportProjectionService.classifyViewerContext:327` + `resolvePassportViewerContext:427`, resolved from the canonical `resolveInteractionPermissions` engine (`:485`), not a passport-local re-implementation. |
| P22 | Privacy filtering happens before data reaches the client | C | Every gate runs inside `buildPassportProjection` before the return: identity gates (`:679-681`), stamp tier + per-stamp (`:1568-1571`), memory tier + per-item (`:1591-1608`), plan per-plan (`:1226-1236`), trust context (`:996-1017`). Viewer identity is resolved server-side from the bearer token (`routes/passport.ts:1497` `getOptionalViewerId`), never from the request body. |

### §5 Current Traveler State

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P23 | Separate permanent identity from temporary traveler state | C | `buildIdentity:666` and `buildTravelerState:717` are distinct producers over distinct sources. |
| P24 | The supported states: Home, Traveling, Exploring, Open to Plans, At Event, With Crew, Unavailable | C | `buildTravelerState:779-787` — all seven, with an explicit precedence chain (`:745-771`). |
| P25 | Every temporary state carries validFrom and expiration semantics | C | `:740-742` initialises both; each derived state sets its own bounds from the underlying record (`:753-754`, `:758-759`, `:763-764`); returned at `:794-795`. |
| P26 | Broad city may be projected; exact location is never ordinary Passport data | C | `:727-730` `showCity = isSelf \|\| (canSeeLocationContext && visibility.showCurrentCity)`, and **the human label is derived from the same gate** (`:774-776`, `displayCity`) — the defect the 2026-09-04 certification found and fixed. Crew and trip-stop states deliberately carry no city at all (`:755`, `:760`). |

### §6 Availability Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P27 | Recurring windows | C | `services/passport/OpenToPlansService.ts:30` `WINDOW_TYPES` includes `recurring`. |
| P28 | Trip-specific windows | C | Same union (`trip`), with `tripId` on the window (`:54-72`). |
| P29 | One-time windows | C | `one_time`. |
| P30 | Plan-derived windows | C | `derived` type + `recordInferredWindow:270`. |
| P31 | Social: open to meeting people | C | `:46` `SOCIAL_AVAILABILITY` + `openToPlans` boolean on the window. |
| P32 | Activity intents (Food · Nightlife · Explore) | C | `:33` `INTENT_TYPES` = Food, Drinks, Nightlife, Explore, Events, MeetTravelers. |
| P33 | Group preference | C | `:36` `GROUP_PREFERENCES` = solo, one_on_one, small_group, crew_only, large_group, any. |
| P34 | Radius / willing travel time | C | `maxTravelMinutes` on the window; validated in `validateCreate:183`. |
| P35 | The `AvailabilityWindow` interface | C | `OpenToPlansService.ts:54-72` — every spec field present, plus `socialAvailability`. |

### §7 Availability Screen Design

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P36 | The availability editor (Open to Plans, tonight window, interests, group preference, travel distance, weekly grid) | C | `src/features/passport/AvailabilityScreen.tsx` + `useAvailabilityEditor.ts`; CRUD at `routes/availability.ts:688-786`. |
| P37 | Never publicly convert inferred availability into an explicit-looking status; inference may only trigger a private prompt | C | `OpenToPlansService.isVisibleTo:168` — a `plan_derived` window is never visible to a non-self viewer; `recordInferredWindow:270` pins `source='plan_derived'`, `visibility='private'`. **Backed at the database**: migration 2260 adds `CHECK (source = 'explicit' OR visibility = 'private')`, making a non-private inferred window unrepresentable. |

### §8 Open to Plans and Intent

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P38 | `SocialAvailability` = open / maybe / crew_only / following_only / not_open | C | `OpenToPlansService.ts:46-47` — exactly those five. |
| P39 | Availability ("can I") distinct from Open to Plans ("do I want invitations") | C | The window carries `startAt`/`endAt` (capability) and `openToPlans` + `socialAvailability` (willingness) as independent fields (`:54-72`). |
| P40 | Temporary intent carries a TTL or an explicit clear | C | `expiresAt` on the window, `effectiveExpiry:130` / `isExpired:140` re-evaluated on every read; `clearWindow:404`. |
| P41 | Current intent examples: Food, Drinks, Nightlife, Explore, Events, Meet Travelers | C | `:33` `INTENT_TYPES` is exactly that list. |
| P42 | Compass and Discovery weight explicit current intent above generic interests | **W** | The projection exposes the distinction (`PassportConsumerProjections.readVisibleExplicitIntent:445`, and the module header documents a bounded `genericInterestWeight` for Compass), **and the "nothing consumes it" finding this row was scored on is FALSE — corrected 2026-09-14 (§14.2/§14.3)**. Both Compass people-ranking surfaces consume it: `artifacts/api-server/src/compass/CompassTools.ts:1938#readVisibleExplicitIntent(sc, targetId` and `artifacts/api-server/src/routes/compass.ts:3912#const viewerIntentRead = await readVisibleExplicitIntent`, both applying the shared bounded weight at `artifacts/api-server/src/routes/compass.ts:4405#export function applyExplicitIntentWeighting`. The function itself is at `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:519#readVisibleExplicitIntent`, not `:445`. **What remains is Discovery alone**, whose content ranker carries no intent term and is on an explicit owner hold (`docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`; `census-discovery.md` A18). Two of two in Compass, zero of one in Discovery. |

### §9 Trust Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P43 | Retain the 0–100 score internally and, where appropriate, visibly | C | `buildTrust:1008-1017` — `score` is populated only when `context === "self"`, via the canonical `getDisplayTrustScore`, so the identity card, Trust screen and Rent-a-Buddy card cannot disagree. |
| P44 | Do not make it a single universal authorization number | C | `buildOwnerCapabilities:566-581` and `buildViewerActions:583-610` return booleans derived from level + restrictions; no surface receives the raw number as an authorization input. |
| P45 | Trust must be domain-specific, confidence-aware and **explainable** | **W** | Domain-specific: yes (`buildDomainTrust:1068-1090`, six domains). Explainable: PARTLY, and the part that was measurably false is now closed. The substitution itself is unchanged and still `applicable: true` — a missing category and a missing profile both read the neutral 50 (`:1075`, `:1153`) and `presentationWord(50)` returns "Established" (`:1047`), so an empty `trust_profiles` still describes every user as an "Established" member across all six domains. What the response no longer does is present that constant as indistinguishable from a measurement: `confidenceBasis` (`trustConfidenceBasis:1107`, wired at `:1152` and returned on BOTH branches, `:1162` and `:1189`) reports `trust_evidence` / `travel_proxy` / `unavailable`, so a consumer can tell the substituted card from a measured one. Stays **W** because the domain WORDS are still the constant's words; changing them is the recalibration P50 records as an owner decision. `passportTrustConfidenceBasis.test.ts` — 8 tests, 4 mutations of the shipped predicate and its wiring each caught. |
| P46 | The evidence → events → domain trust → confidence → policy → projection pipeline | C | `services/trust/TrustEventService.ts:105,217,275` writes `trust_events` (gated on `trust_engine_enabled`, `:85`); `TrustScoreService.ts:276` recomputes `trust_profiles`; `TrustPrivacyGuard` projects. The pipeline is built end to end; the flag is a deployment fact (§3 below). |
| P47 | The six domains: Overall, Traveler, Trip Guest, Trip Host, Contributor, Buddy | C | `buildDomainTrust:955-968` — all six, with Buddy correctly `applicable: false` when the user offers no buddy service (`:966-968`). |

### §10 Trust & Credentials Design

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P48 | The credentials screen (score/label, credential rows, View Details) | C | `PassportProjectionService.buildCredentials:1024`; `src/features/passport/TrustScreen.tsx` renders domain rows, confidence band, capability chips. |
| P49 | Do not expose private report counts, moderation evidence or safety history | C | `services/trust/TrustPrivacyGuard.getSafeTrustSummary` returns `publicLevel` + human strengths/restrictions + an `onProbation` boolean with no detail; `isEventLlmSafe` drops `reporter_id`/`reviewed_by`. The public path uses `getPublicTrustBadge` (`buildTrust:996`), which carries no counts. |
| P50 | Trust confidence matters — an 82 with high evidence is not equivalent to an 82 with little evidence | **W** | The band itself is still travel-derived: `confidence` is computed from `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)` (`buildTrust:1127-1128`) — travel volume, not trust evidence — and it is deliberately **unchanged**, because recalibrating the word a person is labelled with is a product judgement, not a defect fix (`passportProjection.test.ts:307-309` pins "Neutral 50 everywhere reads 'Established' — non-stigmatizing (§10)"). What IS closed is the spec's own hypothetical: migration 2371's `evidence_weight` / `evidence_count`, written by `measureEvidence` (`TrustScoreService.ts:388`) and shaped on every read (`:580`), had NO consumer outside their own writer and its tests before this; they now reach the projection (`PassportProjectionService.ts:1208-1209`) beside `confidenceBasis` (`PassportProjectionService.ts:1210`). Two users showing the same 82 are now distinguishable — one reports `trust_evidence` with its weight and count, the other `travel_proxy` with nulls — which is exactly "same number, different evidence, different meaning". Stays **W** until the band itself is recalibrated against those columns; that is an owner call on labelling, and the basis field makes it a deliberate diff rather than a side effect. |
| P51 | Non-stigmatizing copy for low-evidence accounts | C | `buildTrust:998-1000` and `:1004-1006` — `"New Traveler · Verified"` / `"New Traveler"` when confidence is low; `presentationWord:930-936` deliberately avoids "low/poor/weak". |
| P52 | Trust changes must be internally replayable from evidence/events | C | `trust_events` is an append-only ledger with writers at `TrustEventService.ts:105,217,275`, `TrustAdminService.ts:53-174` and `artifacts/api-server/src/services/appeals/resolveAppeal.ts:271#.from("trust_events")`; `TrustScoreService` recomputes `trust_profiles` from it. |

### §11 Trust Capabilities

| id | Capability | V | Evidence |
| --- | --- | --- | --- |
| P53 | canJoinPublicTrip | C | `buildOwnerCapabilities:573`. |
| P54 | canHostTrip | C | `:574`. |
| P55 | canCreateLargePlan | C | `:575`. |
| P56 | canUseCrewLocation | C | `:576`. |
| P57 | canContributeLiveIntel | C | `:577`. |
| P58 | canBecomeBuddy | C | `:578`. |
| P59 | **canProvideVisaBuddyService** | **N** | A repo-wide search across the server and client trees for `canProvideVisaBuddyService`, `VisaBuddy` and `visa_buddy` returns **nothing**. The capability named by §11 does not exist in any form. **Classified OWNER 2026-09-08 — `VISA_BUDDY_CAPABILITY` on the blocker ledger.** The other six §11 capabilities are derived at `services/passport/PassportProjectionService.ts:740#buildOwnerCapabilities` and each gates something that exists; a seventh would gate nothing and be read by nothing. **The "only current posture" sentence this row carried was measured FALSE on 2026-09-14 (§14.2), and the truth strengthens the N.** The tree ships TWO visa positions, neither a Layover aside: a curated entry-intelligence subsystem whose honesty contract is official sources plus a standing disclaimer (`artifacts/api-server/src/lib/entryRequirements.ts:4#HONESTY CONTRACT`, `artifacts/api-server/src/lib/entryRequirements.ts:20#export const DISCLAIMER`), and a live abuse policy that classifies a PEER offering visa assistance as a travel-scam family (`artifacts/api-server/src/domain/telegraph/policies/travelScamSignals.ts:111#family: "VISA_HELP"`). The Layover lines are real but are at `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1198#Verify visa rules`, `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1246#Visa or transit-permit requirements`, `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1256#Entry is never confirmed`, not at the `:585/:619/:628` this row cited. Choosing a trust threshold for "may provide visa assistance" would invent immigration-advice policy in a formula. Stays **N**: it is a real gap against the spec, and it is not one engineering may close. |
| P60 | Authorization is server-side; the client must not infer authorization from a displayed score | C | Capabilities and per-viewer actions are booleans computed in `buildOwnerCapabilities`/`buildViewerActions`; the client renders the flags (`src/features/passport/usePassportPlans.ts:210` `canMakePlan: proj.actions.can_make_plan`). A grep for client-side trust-threshold policy (`trust > N`) in the passport tree returns nothing. |

### §12 Stamps and Provenance

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P61 | The eleven stamp types: Country, City, Place, Event, Experience, Hidden Gem, Trip, Contributor, Buddy, Milestone, Special | **W** | Migration `2309_passport_stamp_type_vocabulary.sql:118-133` widens the vocabulary to verification, destination, event, trip, achievement, host, rent_a_buddy, city, neighborhood, plan, hidden_gem, safe_return, activity, trip_crew, compass_ai, qr_checkin. That covers Country (`destination`), City, Event, Experience (`activity`), Hidden Gem, Trip, Buddy (`rent_a_buddy`), Milestone (`achievement`, plus the `stamp_milestones` writer at `StampAwardEngine.ts:549-559`) and Special (`stamp_campaigns`, `routes/adminStamps.ts:357`). **ONE is missing, not two — corrected 2026-09-14 (§14.2).** Contributor EXISTS: `artifacts/api-server/src/migrations/0198_place_contributor_stamps.sql:9#INSERT INTO stamp_definitions` seeds three definitions with `stamp_type = 'place_contributor'`, awarded live by `artifacts/api-server/src/lib/places/placeCollectionsWorker.ts:172#definitionSlug: "place_contributor"` and carried to the Passport by `artifacts/api-server/src/services/passport/UnifiedStampService.ts:219#stampType: r.stamp_definitions?.stamp_type ?? null`. What is genuinely absent is **Place**: no `place` label in either vocabulary, and no caller anywhere passes the `placeId` `createStamp` already writes. Ten of eleven. |
| P62 | `StampSource` eight-value union | C | `services/passport/UnifiedStampService.ts:41-49` — exactly the spec's eight. |
| P63 | `StampVerification` three-value union | C | `UnifiedStampService.ts:57`. |
| P64 | Self-reported / decorative must never visually impersonate verified | C | Server: `verificationFromLevel:125` derives the assertion from the platform-set level, and migration 2149's RLS forces a self-inserted row to `unverified` → `reported`. Client: `src/components/passport/PassportStampCollection.tsx:56-85` — `VERIFICATION_META` gives each state a distinct colour **and** a distinct glyph **and** an accessibility label, and only `verified` wears the green shield. **This closes the certification's F2.** |
| P65 | Verified travel facts derived from canonical provenance, not editable profile fields | C | `PassportProjectionService.mapStamp:1083-1099` copies `s.stampSource` / `s.verification` from `UnifiedStampService`, which derives both from the live `source_type` / `verification_level`; `StampAwardEngine` is server-side only ("never trust client-supplied eligibility"). |

### §13 Stamp Design

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P66 | Premium collectible appearance with perforated / passport-stamp edges | **?** | The perforated-edge half is present and decidable — dashed stamp borders throughout (`src/components/PassportStamps.tsx:104,179`, `src/components/PassportStampCard.tsx:106`, `src/components/ui/VerifiedStamp.tsx:40`, `src/components/PassportVerificationStamp.tsx:154`). "Premium collectible appearance" is the load-bearing clause and it needs a rendered screen, so this is ruled the same way as the Wall census rules "generous whitespace". |
| P67 | Unique country/city/event motifs rather than identical generic badges | C | Per-stamp artwork is a first-class system: `stamp_artwork_definitions` / `stamp_artwork_versions` / `stamp_generation_queue` (all in production), rendered at `PassportStampCollection.tsx:104-111` with a coloured per-kind placeholder fallback (`kindAccent`). |
| P68 | Issue date **and verification treatment** visible in the detail view | C | **Moved W→C 2026-09-08 by building it.** The detail view shows the issue date (`src/components/stamps/StampDetailModal.tsx:191#Earned`) and now the verification treatment beside it (`:208#Verification`), derived by the CANONICAL decision (`src/services/passportStampMappers.ts:37#deriveStampVerification`, from `sourceType` + `verificationLevel`, fail-closed) and rendered from the shared presentation (`src/features/passport/stampVerificationPresentation.ts:42#VERIFICATION_META`). The data was never missing from this screen — `PassportStampNew` already carried both inputs; the PRESENTATION was module-private inside the stamp strip, so it existed in one place and could not be reached from another. Both surfaces now import it and a test asserts neither re-declares the label or the colour. §27 holds and is asserted: three distinct words, glyphs and colours, so the row survives greyscale and a screen reader, and only `verified` wears the shield. |
| P69 | Metallic accents and subtle depth may distinguish premium/earned states | C | `src/theme/passportTokens.ts:17-18` `gold` / `goldLight`; gold-ring avatar (`PassportIdentityCard.tsx:3`); `STAMP_RARITY_COLORS` + rarity pip (`src/components/StampCard.tsx:73,137`). |
| P70 | Stamp detail links to Journey and My World while respecting historical-location privacy | C | `StampDetailModal.tsx:13` imports `journeysHref` / `myWorldHref`; `travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx:225#stamp-open-journey`, `travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx:236#stamp-open-my-world`. Privacy holds because `PassportPrivacyGuard.guardStamp:154` strips `place_id` from a `hidden_gem` stamp and `PassportMapService.buildMapPayload` selects city/neighborhood only (`:44-47`). |

### §14 Journeys and Featured Journey

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P71 | Journeys are chronological projections of canonical Trip/travel records | C | `services/passport/PassportJourneyService.ts` reads canonical trips; route `GET /passport/:userId/journeys` (`routes/passport.ts:1554`). |
| P72 | Group by year, country/city and Trip | C | `PassportJourneyService.ts:308` grouping; consumed by `src/features/passport/JourneysScreen.tsx`. |
| P73 | Show permitted dates, places, memories, stamps, Shared Moments and people context | C | `PassportProjectionService.ts:1642-1651` `JourneyPermissions` threads `canSeeTrips`, `canSeeRestricted`, the per-memory `callerCtx` and `viewerId` for block-filtering the people context; date coarsening at `PassportJourneyService.ts:195`. |
| P74 | Allow one Featured Journey | C | `PassportJourneyService.ts:281` `buildFeaturedJourney`; surfaced at `PassportProjectionService.ts:1653`. |
| P75 | Featured Journey may include route, timeline, places, memories, stamps, people, events and recommendations | **W** | Route, timeline, places, memories, stamps and people are projected; **events and recommendations are not** — `PassportJourneyService` has no event join and no recommendation producer. Six of eight elements. |

### §15 Memories and Shared Memories

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P76 | Memories are travel-contextual, not a generic media grid | C | `PassportProjectionService.ts:1663-1672` projects city, country, category, tripId, earnedAt alongside the photo — never a bare media list. |
| P77 | Views: Trips, Places, People, Timeline and Map | **W** | `src/components/MemoriesTab.tsx:915-917` offers exactly two: **All** (grid) and **Timeline** (`groupMemoriesByTimeline`, `:26,780`). Trips, Places, People and Map views do not exist. **One of five, not two — corrected 2026-09-14 (§14.2)**: only Timeline is one of §15's five; "All" is the ungrouped grid those five are views *of*. (The public-viewer emptiness the certification logged as F3 **is** fixed — `src/components/passport/PassportHomePreviews.tsx:332` `PassportViewerMemoriesList` and `:376` the plans list replace the hardcoded `memories={[]}` / `trips={[]}`.) |
| P78 | Retain permitted place, city, Trip, date, people, event and stamp context | C | The memory projection carries city/country/category/tripId/earnedAt; per-item gating via `filterMemories(raw, callerCtx)` (`:1594`) under the collection tier (`:1592`). |
| P79 | Shared history surfaces "You were here together" / "Our Da Nang Trip" when both viewers have rights | C | `SharedContextService.ts:220-234` reads accepted `shared_moment_memberships` for **both** parties and intersects, emitting `shared_moments` and `shared_trips` facts only on that intersection. |

### §16 Plans and Trip Overlap

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P80 | Represent future travel as well as past | C | `buildUpcomingPlans:1191` selects trips in `planning`/`upcoming`/`active`. |
| P81 | Upcoming Trips require per-plan visibility controls | C | `:1226-1236` — `show_on_profile === false` excludes; `visibility === "public"` admits; `buddies`/`invite` require a full-profile or crew/host relationship; anything else is excluded. Dates are additionally gated on `show_exact_dates` (`:1239`). |
| P82 | When viewing another Passport, compute Trip overlap ("You'll both be in Bangkok Sep 14–17") | C | `SharedContextService` emits the `both_going_to` fact (`:33`) from both parties' permitted plans. |
| P83 | Provide a "Connect for Bangkok" action when policy and eligibility permit | C | `SharedContextService.compassHandoff` (`:40-61`) carries `eligible` + the coarse shared city; `travel-buddy-standalone/src/features/passport/PlansScreen.tsx:169#Connect for {overlap.city}` renders the Connect affordance; `PassportHomePreviews.tsx:239-249` gates the primary "Make a Plan" on the server flag. |

### §17 Shared Context — ME ↔ THEM

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P84 | Calculated for the viewer relationship, not stored as a permanent match score | C | Computed per request inside `buildPassportProjection` step 11 (`:1621-1630`), never persisted; there is no shared-context table. |
| P85 | The possible facts: both in city, both free tonight, mutual follows, shared cities, interest overlap, both going to X, previous trip together, shared moments | C | `SharedContextService.ts:25-33` — all eight fact keys, each emitted from its own gated read (`:311`, `:320`, `:325-331`, `:340`, `:347-353`, `:220-234`). |
| P86 | No dating match score; explainable descriptions plus the contributing facts | C | `:59` `summaryLabel` is a four-value qualitative enum derived from fact count (`:385`); there is no numeric compatibility anywhere in the service, and the facts themselves are returned so the label is always explainable. |

### §18 See What You Could Do — Compass Handoff

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P87 | Both Passports + availability + intent + trust eligibility + city + trip constraints + live Map → Compass → candidate experiences | C | Server seed `SharedContextService.CompassHandoff:40-61` (coarse city, shared window, shared intents, trust eligibility — no coordinates, no private history). Client: `src/features/passport/SharedContextScreen.tsx:284-294` renders "See What You Could Do", `:217-219` pushes `/(tabs)/ai` with a `prefillMessage` built by `buildCompassPrompt`, and `app/(tabs)/ai.tsx:98-104` consumes `prefillMessage` and sends it. The bridge is wired end to end. |

### §19 Travel Identity

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P88 | The ten dimensions | C | `services/passport/PassportTravelIdentityService.ts` — `travel_pace:141`, `planning:156`, `spend_style:171`, `social:191`, `discovery:212`, `rhythm:231`, `energy:275`, `group_style:304`, `interests:320`, `languages:335`. All ten, each carrying its own `evidence` array. |
| P89 | Inferred Travel DNA must be explainable and user-controlled: Show / Hide / Not Me | C | `:40` `TravelDnaState = "shown" \| "hidden" \| "not_me"`; inferred labels at `:352` night_explorer, `:364` hidden_gem_hunter, `:373` food_driven, `:385` globe_trotter, each with evidence. `filterTravelIdentityForViewer` hides `hidden`/`not_me` from non-owners while the owner keeps all to toggle back; persistence via `PUT /passport/me/travel-dna` (`routes/passport.ts:1597`) → `writeTravelDnaPref` (owner-scoped, fail-closed) with RLS from migration 2261. **This closes the certification's F5.** |

### §20 Contributions, Expertise and Reputation

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P90 | The contributions surface (level, accepted reports, confirmations, hidden gems, top expertise) | C | `services/passport/PassportReputationService.ts:51-67` — level, levelLabel, acceptedReports, confirmations, hiddenGems, expertise; `routes/passport.ts:1697` serves it; `src/features/passport/ContributionCard.tsx` + `useContributions.ts` render it. |
| P91 | Reputation reflects usefulness and qualified real-world evidence, not follower count | C | `PassportReputationService.ts:64-67` — "Never follower count; never paid volume"; no follower read exists in the service. |
| P92 | Paid contributions must never increase factual confidence | C | `:18-22` — rows carrying `metadata.paid` / `metadata.sponsored` / `metadata.source in (paid, sponsored)` are **excluded** from the confidence-bearing counts and from the level. |
| P93 | Experience-based expertise ("Knows Bangkok well") derived from legitimate history | C | `:64-67` — city expertise derived from qualified (non-paid) contribution history, most-contributed first. |
| P94 | Host and Buddy reputations are contextual Passport projections, not separate identity systems | C | `PassportProjectionService.loadBuddyReputation:1114` reads the canonical `rent_buddy_profiles` row and returns null when the user offers no service, which both marks the §9 Buddy domain "Not applicable" and withholds the Host Reputation credential. A rating surfaces only with `review_count > 0`. |

### §21 Context-Specific Passport Projections

| id | Consumer | V | Evidence |
| --- | --- | --- | --- |
| P95 | **Discovery** | C | **Moved W→C 2026-09-08 from the call site.** The W said "nothing calls it" and named the three `buildConsumerProjection` sites that existed then. Discovery's person card now consumes the variant: `routes/discoverySearch.ts:3094#buildConsumerProjection`. The inline identity that remains is in the SEARCH LIST (`routes/discoverySearch.ts:687#subtitle`), a different endpoint and a different problem — a bulk list cannot pay the ~34-reads-per-target per-user path. That remainder is carried by **P169**, not double-counted here. |
| P96 | Trips | C | `PassportConsumerProjections.ts:230-241` `TripsProjection` (identity + `TripsTrustEligibility` + host/guest context, deliberately no stamps/memories/plans), consumed at `routes/trips.ts:467`. |
| P97 | Buddy | C | `:178-200` `BuddyProjection` (identity, verification, services, availability, reputation), consumed at `routes/rentABuddy.ts:1368#BuddyProjection`. *(Cited `:1241` until 2026-09-22; that line is a scoring-pool comment and was one at `origin/main` too — a pre-existing wrong pointer, not drift. `BuddyProjection` occurs exactly twice in that file: the import at `:27` and this declaration, whose value comes from `routes/rentABuddy.ts:1386#buildConsumerProjection`. Both lines are byte-identical to `origin/main`.)* |
| P98 | **Map** — aggregate or permission-appropriate presence only | C | **Moved N→C 2026-09-08.** The map now REQUESTS the Passport's map-presence projection instead of rebuilding identity: `services/passport/PassportConsumerProjections.ts:990#buildMapPresenceProjections`, consumed at `lib/mapTravelers.ts:303#buildMapPresenceProjections`. It carries identity ONLY — handle, displayName, avatarUrl, verified — and applies the two rules that govern them (the universal display-name gate and the `show_profile_picture_publicly` opt-out). **It is deliberately NOT a seventh `PassportConsumerVariant`** (`PassportConsumerProjections.ts:150#PassportConsumerVariant`): every variant is reached through `buildConsumerProjection`, which narrows a full per-user assembly (~21 reads plus ~13 for the permissions engine, per target), and the live map returns up to 100 travelers polled every 45 s — the per-user path is ~3,400 reads per poll per viewer. A `"map"` member would advertise that path to the next person wiring a map feature, so `passportMapPresence.test.ts` asserts the union does not gain one and pins the projection at exactly ONE table read for 50 owners. **This was an AUTHORITY defect, not a leak** — `mapTravelers` already applied both rules correctly; they simply lived in a consumer, so a change to the universal display-name rule had two places to land. Output is unchanged and `mapTravelers.test.ts` (14 tests) is green unmodified; the adoption costs no read, because the projection took over the `nameVisibilitySet` call that file already made. `openToMeet` stays behind deliberately: it is a map-ELIGIBILITY signal, not identity. |
| P99 | **Telegraph** | C | **Moved W→C 2026-09-08 from the call site.** The W said a grep for the variant outside its defining module returned nothing. The conversation header now consumes it: `routes/telegraph.ts:386#buildConsumerProjection`. |
| P100 | Compass | C | **Moved W→C 2026-09-08 from the call site.** The W said "no Compass route calls `buildConsumerProjection`". One does: `routes/compass.ts:4754#buildConsumerProjection`, taking the `discovery_card` variant for person cards exactly as the module's header intended. Compass's traveler SUGGESTION LIST (`routes/compass.ts:4011#title: projectedName`) still builds identity inline for the bulk-surface reason above; carried by **P169**. |
| P101 | **Safety** | C | **Moved W→C 2026-09-08 from the call site.** The W said nothing outside the module referenced `toSafetyProjection`. Safe Return does: `routes/safeReturn.ts:1215#buildConsumerProjection`. |

### §22 Privacy Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P102 | `Visibility` = public / followers / following / crew / private | C | `OpenToPlansService.ts:39` `VISIBILITY_POLICIES` is exactly that five-value list; per-stamp and per-memory tiers use their own table vocabularies interpreted by `PassportPrivacyGuard`. |
| P103 | Name / handle: public | C | `buildIdentity:683-685` via the canonical `nameVisibilitySet` choke point (`:1490`). |
| P104 | Profile photo: public | C | `:674` `showAvatar = isSelf \|\| profile.show_profile_picture_publicly !== false`. |
| P105 | Verification: public | C | `:690-691` returned unconditionally. |
| P106 | Home country: user controlled | C | `:679` gated on `visibility.showHomeCountry` (`PassportPrivacyGuard.ts:50-56`, `profile_privacy_settings.show_home_country`). |
| P107 | Home base: user controlled | C | `:680` requires **both** a full-profile relationship and `showHomeCountry` — a home base is a strict refinement of the country, so hiding the country hides the base. |
| P108 | Current city: user controlled | C | `buildTravelerState:727-730` gated on `visibility.showCurrentCity`, label and field alike. |
| P109 | Availability: user controlled | C | `buildPassportProjection:1548` gates the whole availability block on `isSelf \|\| permissions.canSeeAvailability`; window-level `visibility` narrows further (`OpenToPlansService.visibilityAdmits:150`). |
| P110 | Open to Plans: user controlled | C | Same gate; `openToPlans` lives on the window and inherits its `visibility`. |
| P111 | Travel history: user controlled | C | Journeys gated on `canSeeTrips` / `canSeeRestricted` (`:1574-1583`); My World gated by per-stamp filtering (`PassportMapService.buildMapPayload` → `filterStamps`). |
| P112 | Stamps: public / user controlled | C | **Both** gates in order (`:1567-1571`): the collection tier `prefs.stamps_visible` via `tierPermits`, then per-stamp `filterUnifiedStamps`, which fails closed on an absent/unknown tier. |
| P113 | Memories: per item | C | `:1591-1594` — collection tier then `filterMemories(raw, callerCtx)` per item. |
| P114 | Plans: private or followers by default | C | `buildUpcomingPlans:1228` — `show_on_profile === false` excludes, and anything not explicitly `public` requires a full-profile/crew/host relationship. |
| P115 | Languages: user controlled | C | The `languages` dimension passes through `filterTravelIdentityForViewer`, which hides `hidden`/`not_me` items from non-owners. |
| P116 | Travel style: user controlled | C | Same filter over the nine style dimensions. |
| P117 | Trust summary: contextual | C | `buildTrust:996-1017` — `public` gets `getPublicTrustBadge` with no number; other contexts get `getSafeTrustSummary`; the numeric score only for self. |
| P118 | Exact location: never normal Passport data | C | No read path selects a coordinate: `PassportMapService:44-47` selects `country, city, neighborhood, place_id` only; `user_stamps` stores lat/lng as provenance (`StampAwardEngine.ts:333`) and **no projection selects them**; `PassportPrivacyGuard.guardStamp:154` strips `place_id` from a hidden-gem stamp. |

### §23 Location Boundary

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P119 | Passport may say "Traveling in Da Nang" but never exact coordinates; exact location belongs to purpose-bound Presence systems | C | `buildTravelerState:753-765` — the `with_crew` and `exploring` states deliberately carry **no city at all**, with the comment "Crew session location is purpose-bound Presence (§23/§25) — never a city here"; the traveling/at-event states carry a coarse city behind the §22 gate. |

### §24 Blocking and Safety Propagation

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P120 | A Passport block propagates across Discovery, Telegraph, Trips, Presence, Map, Shared Moments, Bump, Buddy and Compass | C | The canonical block set is applied in every one of those trees: `routes/discoverySearch.ts`, `routes/telegraph.ts`, `routes/mapTravelers.ts`, `routes/mapProjection.ts`, `routes/sharedMoments.ts`, `routes/rentABuddy.ts`, `routes/compass.ts`, `routes/follows.ts` (all use `fetchBlockedSet` / `blocks`). Bump/QR resolves through the server passport projection, which collapses a blocked viewer to a minimal restricted card (`PassportProjectionService.ts:1563-1583`). |
| P121 | Blocking is not implemented independently per surface | C | Two shared mechanisms and no third: `resolveInteractionPermissions` (`services/interactionPermissions.ts:222`) for relationship-level authorization, and `lib/blocks.fetchBlockedSet` for row filtering. Passport does not re-implement either — `PassportProjectionService.ts:531` calls the canonical resolver. |

### §25 QR Passport and Bump

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P122 | Share options: QR, Share Link, Copy Link, Bump | C | `src/features/passport/PassportQrSheet.tsx:4` — all four, reachable from `PassportQuickLinks`. |
| P123 | QR projection deliberately minimal | C | `src/features/passport/passportQrProjection.ts:51-60` `MinimalQrProjection` is a closed six-field allow-list (first name only, handle, avatar, verified, verificationLevel, permitted home country/interests); the header (`:11-17`) states that any other key on the input is dropped, and home country / interests are further gated on explicit permission. |
| P124 | Scanning a QR never bypasses privacy policy | C | `passportQrProjection.ts:18-22` — `buildQrPayload` encodes only the passport deep link, so a scan opens the passport and it is **re-projected server-side** under normal policy. |
| P125 | Bump requires affirmative exchange/confirmation; passive proximity must not reveal profiles | C | `PassportQrSheet.tsx:49` `BumpState = 'idle' \| 'awaiting' \| 'confirmed'`; `startBump:107` only opens the panel, and `onBumpConfirmed` fires solely from `confirmBump:112` after an explicit confirmation. |

### §26 My World

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P126 | WORLD → Country → City → Trip → Places → Memories / Stamps | **W** | The hierarchy stops three levels short. `src/features/passport/usePassportWorld.ts:21-55` models `PassportWorld → WorldCountry → WorldCity` with a `stampCount`, and the country drill-down (`app/passport/country/[country].tsx`) shows a stamp grid. There is **no Trip level, no Places level and no Memories level**; the server payload (`PassportMapService.buildMapPayload:61-80`) aggregates stamps by city and stops. Three of six levels. |
| P127 | My World is distinct from the main Map; they deep-link but must not merge truth models | C | `MyWorldScreen.tsx:1-13` states and implements exactly this — it renders from the passport map payload and **deep-links out** to `/map`, never embedding or editing it; the payload is city/zone-level by server invariant so no coordinate is available to merge. |

### §27 Design System

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P128 | Dark-mode first with deep navy/black surfaces | **W** | **HALF-CLOSED 2026-09-14 — the colour half only. Stays `W` on the theme half; see §15.3.** **CLOSED:** *"deep navy/black surfaces"*. The owner ruled SPEC IS STALE and ratified the Passport's light paper identity by name — Paper `#FFFFFF`, Ink `#1C1C1A`, Seal red `#D32F2F` — in `docs/architecture/brand-palette-decision.md`, which also says *"retain the existing Passport and Wall colour identities"*. That is this file exactly: `travel-buddy-standalone/src/theme/passportTokens.ts:8#paper:        '#FFFFFF',` and `travel-buddy-standalone/src/theme/passportTokens.ts:11#ink:          '#1C1C1A',`, under a header that states the direction in its first line (`travel-buddy-standalone/src/theme/passportTokens.ts:2#Passport palette — clean white/cream paper, black ink, red seal.`). The surface colour is no longer a divergence. **NOT CLOSED:** *"Dark-mode first"* is a THEME criterion, and the ruling's condition excludes it in terms — *"this decision does not automatically resolve unrelated theme, layout, or accessibility criteria"*. Re-measured at this tree: **the Passport has no dark mode at all, not a non-default one.** `grep -rn useColorScheme` over `travel-buddy-standalone/src/theme/`, `src/components/passport/` and `src/features/passport/` returns **0**; `PP` is a single frozen object with one value per role and no dark counterpart, and all 14 of its tokens are consumed directly by 60+ call sites with no theme provider between them. The only two `useColorScheme` readers in the client are `travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts:117#const scheme = useColorScheme();` and the tab bar at `travel-buddy-standalone/app/(tabs)/_layout.tsx:129#const colorScheme = useColorScheme();` — neither is a Passport surface. So the row is not "light where the spec said dark"; it is "one theme where the spec said two, dark first". **WHAT WOULD TURN THIS RED / what would close it:** a second `PP` token set selected by the device scheme (or an app setting), the Passport surfaces reading it through a provider instead of importing `PP` directly, and a test that renders a Passport surface under a dark scheme and asserts a dark surface token — OR a second owner ruling saying that a ratified light paper identity retires the dark-mode-first clause outright. **The second is the likelier and cheaper answer and this lane may not take it**; it is recorded in `docs/architecture/blocker-ledger.md` as `PASSPORT_DARK_MODE_FIRST`. |
| P129 | Purple as the Passport identity accent | C | **RULED AND CLOSED 2026-09-14 — verified row by row, not on the ruling alone; see §15.1.** This clause is a pure accent-colour assignment: it names a colour for a role and asserts nothing about layout, hierarchy, type, spacing or contrast, so there is no second half to survive the amendment. `docs/architecture/brand-palette-decision.md` ratifies **Seal red `#D32F2F`** by name and supersedes *"every spec sentence naming purple, navy or indigo as a brand accent"*, of which `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt:274#Purple as the Passport identity accent.` is one — cited here beside the amendment, as that document's §3 requires, because the supplied spec bytes are deliberately not edited. **The ratified colour is what ships.** `travel-buddy-standalone/src/theme/passportTokens.ts:15#seal:         '#D32F2F',` is the accent, and it carries the identity device itself — the verified-passport seal — at `travel-buddy-standalone/src/components/passport/PassportVerifiedSeal.tsx:35#<ShieldCheck size={iconSize} color={PP.seal} strokeWidth={1.8} />` and in that component's rings and arc lettering (`travel-buddy-standalone/src/components/passport/PassportVerifiedSeal.tsx:56#borderColor: PP.seal,`). **And it is the ONLY accent in the palette**, which is what makes "identity accent" the right description rather than a generous one: counted at this tree, the Passport tree's `PP.*` reads are 60 `inkMuted`, 47 `ink`, 36 `borderLight`, 30 `paper`, 17 `paperDeep` — all neutral surface and text — against **6** `PP.seal` and 2 `PP.gold`. One bold device on quiet paper, which is the direction `travel-buddy-standalone/src/theme/passportTokens.ts:2#Passport palette — clean white/cream paper, black ink, red seal.` declares. **WHAT WOULD TURN THIS RED:** `PP.seal` ceasing to be `#D32F2F`, the seal device losing it, or an owner reversal of `docs/architecture/brand-palette-decision.md` supplying a purple hex. No test pins the hex; that is a real and named gap — see §15.5. |
| P130 | Gold for premium/earned travel identity and collectible stamps | C | `passportTokens.ts:17-18` `gold: '#D4AF37'` / `goldLight`, used for the gold-ring avatar (`PassportIdentityCard.tsx:3`) and premium stamp treatment. |
| P131 | Green for verification and positive trust states | C | `PassportStampCollection.tsx:60` `verified: { color: '#2E7D5B' }`; `PassportHero.tsx:406` `rgba(13,155,111,0.10)` for the positive pill. |
| P132 | Blue/teal for availability and social context | C | **THIS ROW'S EVIDENCE WAS FALSE, AND THE REQUIREMENT IS MET. Closed 2026-09-14; see §15.1 and §15.4.** The row said *"there is no blue/teal availability accent in `passportTokens.ts` at all"*. True, and irrelevant — it looked in one of the two palettes. `docs/architecture/brand-palette-decision.md` §2 ratifies **both** (*"Two palettes, both ratified … the shared theme tokens and the Passport document palette are not being merged by this decision"*), and the Passport's availability and shared-context SCREENS import the shared set, not `PP`: `travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:50#import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';` and `travel-buddy-standalone/src/features/passport/SharedContextScreen.tsx:43#import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';`. **Teal-ink is the ratified colour and it is the one carrying these two roles.** The token is `travel-buddy-standalone/src/theme/tokens.ts:14#deep: '#0A3D4A', // teal-ink — destination accents`, named in the ruling. AVAILABILITY: the screen states the mapping in its own header — `travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:24#(color.deep) carries availability / social context per §27` — and then applies it: the window label at `travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:648#color: color.deep,`, the open-to-meet switch track (`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:346#trackColor={{ true: color.deep, false: color.haze }}`), and the selected day/window chips (`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:677#backgroundColor: color.deep,`, `travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:719#backgroundColor: color.deep,`). SOCIAL CONTEXT: the "YOU TWO" summary device is a teal disc at `travel-buddy-standalone/src/features/passport/SharedContextScreen.tsx:378#backgroundColor: color.deep,`, and the traveler-state pill's `social` tone — which is what `traveling`, `exploring`, `at_event` and `with_crew` all resolve to (`travel-buddy-standalone/src/lib/travelerState.ts:73#return 'social';`) — is cyan-teal at `travel-buddy-standalone/src/components/passport/TravelerStateChip.tsx:56#social:   { bg: '#EEF6FA', border: 'rgba(14,116,144,0.35)', text: '#155E75', dot: '#0E7490' },`. **The one colour that is NOT teal, named rather than omitted:** `open_to_plans` resolves to the `positive` tone and renders green (`travel-buddy-standalone/src/components/passport/TravelerStateChip.tsx:55#positive: { bg: '#F0FAF4', border: 'rgba(34,197,94,0.35)', text: '#166534', dot: '#22C55E' },`). That is §27's OTHER colour clause reaching the same state — the ruling preserves *"semantic status colours"* in terms — and it does not reopen this row; §15.4 argues it in full and says what would. The legacy green `AvailabilityChip` is not evidence either way: **no caller anywhere passes `availabilityChip`**, so `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:462#chipState={availabilityChip ?? null}` is always `null` and the component returns without rendering. **WHAT WOULD TURN THIS RED:** the availability screen or the shared-context summary moving off `color.deep`, or the `social` tone ceasing to be a blue-teal. Nothing pins either; see §15.5. |
| P133 | Travel hero image, circular overlapping portrait, rounded cards, restrained glass | **W** | Rounded cards yes; a cover image yes; but the portrait sits in a left column of a document card rather than overlapping a hero (`PassportIdentityCard.tsx:391-412`), and there is no glass treatment. Two of four. **NEVER DEPENDED ON THE PALETTE — re-read 2026-09-14 and left alone.** Both surviving failures are composition and treatment, not colour: the portrait sits in the document card's left column rather than overlapping the hero (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:671#leftCol:`), and there is no glass treatment anywhere in the Passport tree. `docs/architecture/brand-palette-decision.md` amends colour clauses only and closes nothing here. §12.1 and §12.4 grouped this row with the four colour rows under D-DESIGN; that grouping was wrong on this row and on P13, which is why the ruling moved two rows and not five. **Stays W** at two of four. See §15.2. |
| P134 | Colour is never the only status indicator; pair it with text/iconography | C | `PassportStampCollection.tsx:56-85` pairs each verification colour with a distinct glyph **and** an accessibility label; verification pills, availability check+label and trust standing pills all carry text. |

### §28 Mobile Component Structure

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P135 | The `/features/passport` tree of screens, components and services | C | All ten screens exist and are route-registered; components and services exist with **naming variance** rather than absence — `TravelerStateChip` for `TravelerStateCard`, `PassportStampCollection` for `StampStrip`, `MemoriesTab` for `MemoriesScreen`/`MemoryGrid`, `useTrustProjection.ts` for `trustProjection.ts`, `src/services/passportSharedContext.ts` for `sharedContext.ts`, and `services/passport/PassportPrivacyGuard.ts` (server-side, which is where the spec's own §4 says filtering belongs) for `passportPrivacy.ts`. Substance present; the tree is not literal. |

### §29 Passport Aggregate Contract

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P136 | The `PassportProjection` interface with every declared field | C | Returned at `PassportProjectionService.ts:1714-1733` — userId, identity, travelerState, availability, intent, trust, credentials, stats, stamps, featuredJourney, upcomingPlans, memories, travelIdentity, sharedContext, capabilities, viewerContext. All sixteen. |

### §30 Actions Must Be Server-Projected

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P137 | The actions block: can_follow, can_message, can_make_plan, can_invite_trip, can_view_availability, can_view_trust | C | `buildViewerActions:583-610` — exactly those six, and all six forced false for a blocked or unavailable owner (`:590-599`). |
| P138 | The client must not recreate policy; the server owns authorization | C | **Moved W→C 2026-09-08 from the call sites; no code changed.** The W said the public passport's Follow/Message controls "still gate on `isAuthed`". They do not: `app/passport/[username].tsx:477#viewerActions.canFollow`, `:479#onFollowPress` and `:480#onMessagePress` consume `resolveViewerActions` (`src/features/passport/viewerActions.ts:38#resolveViewerActions`), which reads the projection's `capabilities.actions` verbatim and fails CLOSED — no projection, or a missing flag, offers nothing. `usePassportPlans.ts:210#can_make_plan` likewise. The one surviving `isAuthed` gate (`app/passport/[username].tsx:402#isAuthed`) covers the overflow menu, whose only items are **Report** and **Block** — safety actions that are deliberately NOT in TABLE 29's `can_*` set and must remain reachable by someone the subject has blocked. Gating those on a server capability would be the defect, not the fix. |

### §31 Loading, Caching and Expiration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P139 | The load order: identity → viewer relationship → privacy → state → availability → trust → shared context → stamps/history → plans/memories | C | `buildPassportProjection` follows it in twelve numbered steps (`:1466` profile/identity, `:1478-1493` viewer + privacy, `:1541-1552` state/availability/intent, `:1554` trust, `:1567` stamps, `:1584` journey/plans, `:1590` memories, `:1621` shared context, `:1632` capabilities). Shared context is assembled after stamps rather than before, which is immaterial because the aggregate returns as one document. |
| P140 | Cache relatively static identity, stamp metadata, stats, travel identity and permitted journeys | C | `PassportProjectionService.ts:1755` `PASSPORT_STATIC_MAX_AGE = 3600`, mapped per section at `:1687-1696`. |
| P141 | Short TTLs for availability, current state, Open to Plans, Shared Context, trust and capabilities | C | `:1684` `PASSPORT_DYNAMIC_MAX_AGE = 30`, applied to travelerState, availability, intent, trust, sharedContext and capabilities (`:1697-1703`). |
| P142 | Explicitly expire availability, temporary intent, Open to Plans, event Passport, temporary sharing and location projections | C | `OpenToPlansService.effectiveExpiry:130` / `isExpired:140` re-evaluate on every read; `loadQuickStatus:698-711` drops an expired quick status before it can be projected; `routes/availability.ts` returns non-expired only; event Passport shares carry their own revoke path (`routes/passport.ts:1904`). |
| P143 | Never render stale Availability as current | C | Server drops expired windows before projection; the client blanks the volatile half past its short TTL rather than showing it (`src/hooks/usePassportProjection.ts:17-19`, `travel-buddy-standalone/src/services/passportProjection.ts:599#DENIED_VIEWER_ACTIONS`). The route sets `Cache-Control: <scope>, max-age=<shortest present section TTL>` plus a weak ETag with 304 support (`routes/passport.ts:1502-1511`). |

### §32 Telemetry

| id | Event group | V | Evidence |
| --- | --- | --- | --- |
| P144 | passport_viewed / passport_shared / passport_qr_scanned | C | `src/features/passport/passportTelemetry.ts:46-50,251-256`. |
| P145 | availability_set / availability_expired / open_to_plans_enabled | C | `passportTelemetry.ts:53-57,262`. |
| P146 | stamp_issued / stamp_verified / stamp_viewed | C | Client `stamp_viewed` (`:60`); server `stamp_issued` / `stamp_verified` emitted from the award path (`services/passport/StampAwardEngine.ts:622,629`), both in the allow-list at `lib/passportTelemetry.ts:42-43`. |
| P147 | trust_summary_viewed | C | `passportTelemetry.ts:62`. |
| P148 | shared_context_viewed / make_plan_started | C | `passportTelemetry.ts:64,66`. |
| P149 | journey_viewed / memory_viewed / my_world_opened | C | `passportTelemetry.ts:69-73`; `MyWorldScreen.tsx:27` calls `trackMyWorldOpened`. |
| P150 | follow_from_passport / message_from_passport / trip_invite_from_passport | C | `passportTelemetry.ts:76-80`. |

All eighteen named events exist, allow-listed on both sides (`routes/passport.ts:1802` validates against `PASSPORT_TELEMETRY_EVENTS`), behind `passport_telemetry_enabled` (`:1797`), with a transport wired at `installPassportTelemetry.ts`. **This closes the certification's F4 in full.** *Deployment caveat in §3.*

### §33 Implementation Phases

| id | Phase | V | Evidence |
| --- | --- | --- | --- |
| P151 | 1 — Identity Foundation | C | `buildIdentity`, `buildStats`, server-side privacy filtering in `buildPassportProjection`. |
| P152 | 2 — Travel Identity: Stamps, Journeys, Memories, My World | C | `UnifiedStampService`, `PassportJourneyService`, `PassportMemoryService`, `PassportMapService` + all four client surfaces. |
| P153 | 3 — State & Availability | C | `buildTravelerState`, `buildAvailability`, `OpenToPlansService`, migration 2260. |
| P154 | 4 — Trust | **W** | Structurally complete (`buildTrust`, `TrustPrivacyGuard`, `buildOwnerCapabilities`, `TrustScreen`) but the projection fabricates its central number when the engine is dark — see P45/P50. |
| P155 | 5 — Shared Context | C | `SharedContextService` complete and now reachable from the viewer's Home preview band. |
| P156 | 6 — Real-World Action | C | "Make a Plan" on the viewer passport gated on the server flag; Compass handoff wired end to end (P87); trip invitations via `TripInvitePickerSheet.tsx`. |
| P157 | 7 — Reputation | C | `PassportReputationService` + `ContributionCard` + TrustScreen contributions. |
| P158 | 8 — Sharing: QR, Bump, temporary event Passport | C | QR + affirmative Bump; **temporary event Passport now built** — `services/passport/EventPassportService.ts`, routes `POST /passport/event-share`, `POST /passport/event-share/:eventId/revoke`, `GET /passport/event-passport/:token` (`routes/passport.ts:1877-1976`), client `EventPassportScreen.tsx` + `app/passport/event/[token].tsx`, behind `passport_event_share_enabled`. **Closes F9's first half.** |
| P159 | 9 — Intelligence: Travel DNA, yearbook, deeper Experience Graph | **W** | Travel DNA built (P89); **yearbook now built** — `services/passport/PassportYearbookService.ts` (867 lines), `GET /passport/:userId/yearbook` (`routes/passport.ts:1638`), `YearbookScreen.tsx`, `app/passport/yearbook.tsx`, entered from `PassportQuickLinks.tsx:89`. The **deeper Experience Graph** is still absent as a Passport surface. Two of three. |

### §34 Explicit Non-Goals

| id | Non-goal | V | Evidence |
| --- | --- | --- | --- |
| P160 | Not a generic Instagram profile | C | The aggregate is state/availability/trust/context-led, not a media grid; memories carry travel context by construction (`:1595-1604`). |
| P161 | Not a dating profile or compatibility score | C | `SharedContextService.ts:10` — "deliberately no numeric compatibility"; the summary is a four-value qualitative enum (`:59`). A repo grep for `match_score`/`compatibility`/`dating` in passport code finds only unrelated interest labels. |
| P162 | Not a raw exact-location screen | C | See P118 — no projection selects a coordinate. |
| P163 | Not a place where users self-award verification | C | `StampAwardEngine` is server-side only; migration 2149's RLS forces a self-inserted stamp to `unverified`, which `verificationFromLevel:125` maps to `reported`. |
| P164 | Not a public moderation record | C | `TrustPrivacyGuard.getSafeTrustSummary` exposes no report counts, reporter ids or raw scores. |
| P165 | Not a Trust leaderboard | C | No ranking or comparison surface exists; `artifacts/api-server/src/services/passport/PassportProjectionService.ts:231#"Not a Trust leaderboard"` records the constraint, and the numeric score is self-only. |
| P166 | Not permanent exposure of future travel plans | C | `buildUpcomingPlans:1228` requires `show_on_profile` and an explicit non-private visibility; plans are limited to `planning`/`upcoming`/`active` so a completed trip leaves the Plans surface automatically. |
| P167 | Not a duplicate database for Trips, Buddy, Memory, Map or Presence | C | Every read is from the owning system's table (`trips`, `trip_members`, `rent_buddy_profiles`, `passport_memories`, `passport_stamps`/`user_stamps`); the 25 production `passport*`/`stamp*` tables are Passport-owned domains (stamps, postcards, memories, DNA prefs, visibility prefs, contribution events), not copies of another system's truth. |

### §35 Engineering North Star

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P168 | The complete loop: Passport → Availability → Trust → Shared Context → Compass → Map → Plan → Telegraph → real-world experience → Memory → Stamp → Passport | C | Every hop exists and is wired: availability (`OpenToPlansService`), trust (`buildTrust`), shared context (`SharedContextService`), Compass (`SharedContextScreen.tsx:217` → `app/(tabs)/ai.tsx:104`), plan (`TripInvitePickerSheet`), Telegraph (messaging routes), memory (`PassportMemoryService`), stamp (`StampAwardEngine`, whose `safe_return`/`check_in` sources are literally experience-derived). Unlike the Wall's §41, the Passport loop's return leg **does** close: a real-world experience becomes a stamp through a deployed table (`user_stamps`, `stamp_award_events`). |
| P169 | Other surfaces request the appropriate Passport projection instead of rebuilding identity, availability, trust and social context independently | **W** | **This row was badly stale and its replacement note (written earlier the same day) was wrong too; both are corrected here from the call sites.** It read "adoption is three of seven consumers — Trips, Buddy and Event". Every one of the seven now calls `buildConsumerProjection`: `routes/trips.ts:596#buildConsumerProjection`, `routes/rentABuddy.ts:1386#buildConsumerProjection`, `services/passport/EventPassportService.ts:423#buildConsumerProjection`, `routes/telegraph.ts:386#buildConsumerProjection`, `routes/safeReturn.ts:1215#buildConsumerProjection`, `routes/discoverySearch.ts:3094#buildConsumerProjection` and `routes/compass.ts:4754#buildConsumerProjection`. **What actually remains is not four unadopted consumers — it is two BULK LIST endpoints**, which are different routes from the profile-card ones above and were being counted as the same thing: the discovery search list (`routes/discoverySearch.ts:687#subtitle`) and the Compass traveler suggestions (`routes/compass.ts:4011#title: projectedName`). Both still build identity inline, and both do so for exactly the reason the map did — the per-user projection is ~34 reads per target and a list cannot pay it. **The batch path they need now exists** (P98's `buildMapPresenceProjections`), but it is not a drop-in for either: the map's projection is viewer-INDEPENDENT (a pin carries no follow/friend context), while both of these gate on the viewer relationship — Discovery suppresses the avatar unless `isFollowing || isFriend || show_profile_picture_publicly`, and Compass suppresses the title entirely for a private non-followed profile. Extending the batch projection with a viewer-relationship input is the remaining work, and it is one job, not two. **The row stays W**, but it is a much smaller and much better-specified W than "the single largest structural gap in Passport". |

---

## 3. What could not be verified (1), and the deployment facts

**The CANNOT-VERIFY bucket against this spec's text holds exactly one
requirement:**

| id | § | Why it cannot be settled by construction |
| --- | --- | --- |
| P66 | 13 | "Premium collectible appearance" is an aesthetic judgement needing a rendered screen. The perforated-edge half of the same bullet is present and was verified. |

That the bucket is nearly empty is a property of the spec, not of my leniency.
The Passport spec has no performance-target table and no accessibility section
— unlike the Wall spec, which has both and which yields nine CANNOT-VERIFYs
under the identical method. §27's one accessibility clause ("colour is never the
only status indicator") is a statically decidable pairing requirement, and it is
met (`PassportStampCollection.tsx:56-85` pairs every verification colour with a
distinct glyph *and* an accessibility label).

**Runtime QA is still owed — it is just not a requirement of this spec.**
On-device layout of the ten screens on iOS and Android, VoiceOver/TalkBack
behaviour and dynamic-type scaling, P95 latency and clock-skew behaviour of the
short-TTL projections, a real camera QR round-trip, live-DB RLS behaviour of the
two guard-refused `*SelfVerification` suites, and the flag-gated capability paths
all remain unexercised. Every one of them should be checked before GA. None of
them is a reason a construction score is below 100, and treating them as one is
the main way the existing certification's ~8% shortfall is over-explained.

**Deployment facts that bound the built code.** Not construction verdicts, not
in the 169, and — as with the Wall — the most consequential paragraphs here.

1. **The trust engine is dark, and the projection does not degrade honestly.**
   `trust_engine_enabled` is seeded false (`services/trust/TrustEventService.ts:85`),
   so `trust_events` has no writer in practice, `trust_profiles` is empty, and
   `getTrustProfile` returns null. `buildTrust` then substitutes 50 and every
   user reads "Established". Worse, `getTrustProfile` never destructures `error`,
   so **"this person is established" and "we could not reach the trust engine"
   render identically**. This is the one place in Passport where a deployment
   fact produces a wrong *claim about a person* rather than an empty surface.
2. **`passport_telemetry_events` (migration 2287) is not deployed.** Production's
   25 `passport*`/`stamp*` tables do not include it. All eighteen §32 events are
   emitted correctly on both sides and validated against a server allow-list
   (`routes/passport.ts:1802`); they have nowhere to land. The same holds for
   `event_passport_shares` (migration 2294), so the Phase-8 event Passport is
   built and undeployed.
3. **Two capability flags ship OFF**: `open_to_plans_windows_enabled` and
   `passport_travel_dna_enabled` (migrations 2260, 2261, each with an OFF
   postcondition). The §6/§8 window CRUD and the §19 DNA write path are built and
   unit-tested but have never run against an enabled environment.
   `passport_event_share_enabled` and `passport_telemetry_enabled` are likewise
   gates on their surfaces.
4. **The core Passport is NOT flag-gated** — unlike the Wall, `routes/passport.ts`
   checks a flag only for telemetry (`:1797`) and event shares (`:1936`). The
   identity, stamps, journeys, memories, plans, availability, trust, DNA, My
   World and shared-context paths are live. That is why the fabricated
   "Established" matters now rather than at some future rollout.
5. **Storage matches the design.** All 25 production `passport*`/`stamp*` tables
   are Passport-owned domains — stamps and their artwork/campaign/milestone
   machinery, postcards, memories, DNA preferences, visibility preferences,
   contribution events, reconciliation and admin audit. None duplicates another
   system's truth, which is §34's last non-goal holding. The one Passport-owned
   table the spec implies and production lacks is the telemetry sink.
6. **Writer-attribution caveat.** `src/scripts/checkWriterlessReads.ts:39-41`
   states that a dynamic `.from(expr)` anywhere makes writer attribution
   INCOMPLETE and that the check errs toward silence. Every "nothing writes X" /
   "nothing calls X" claim above was settled by reading the call sites, not by
   grepping `from("…")`.

---

## 4. Reconciliation with `passport-certification.md`

That document certifies `7c03bdc` (2026-09-03) and reports **~92% construction
complete** (backend ~97%, client ~86%) with nine findings F1–F9. This census
reads `ebe72b34`. Six of the nine have closed.

### 4.1 Its findings, re-tested

| Finding | Certification | Now | Evidence |
| --- | --- | --- | --- |
| **F1 · MED** Shared Context orphaned — "no `router.push` reaches it" | open | **CLOSED** | `src/components/passport/PassportHomePreviews.tsx:233` pushes `/passport/shared-context?userId=…` from the viewer band; `:258` `passport-shared-context-entry`. |
| **F2 · MED** Stamp verification not enforced on read/card; `"reported"`/`"decorative"` dead | open | **CLOSED** | `UnifiedStampService.verificationFromLevel:125` derives the assertion from the live level; `PassportStampCollection.tsx:56-85` renders a distinct colour + glyph + a11y label per state, only `verified` wearing the shield. |
| **F3 · MED** Public passport renders empty Memories/Plans (`memories={[]}` / `trips={[]}`) | open | **CLOSED** | `PassportHomePreviews.tsx:332` `PassportViewerMemoriesList`, `:376` the viewer plans list — with the comment recording that the hardcoded empties were the defect. |
| **F4 · MED** §32 telemetry not wired — "none of the spec's passport events are emitted" | open | **CLOSED (construction)** | All eighteen events: `src/features/passport/passportTelemetry.ts:46-80`, server allow-list `lib/passportTelemetry.ts`, route `routes/passport.ts:1764`, transport `installPassportTelemetry.ts`. Table not deployed — §3 above. |
| **F5 · LOW** Travel DNA client persistence unwired | open | **CLOSED** | `PUT /passport/me/travel-dna` (`routes/passport.ts:1597`) + `useTravelIdentity.ts`; still behind `passport_travel_dna_enabled`. |
| **F6 · LOW** Dual availability surfaces writing different backends | open | **still open** | `/availability` (legacy quick-status) and `/passport/availability` (the §7/§8 editor) both exist. Not a spec requirement in itself; folded into P36's evidence rather than scored separately. |
| **F7 · LOW** Viewer actions gate on `isAuthed`, not the server capability flags | open | **still open** | Counted here as **P138 · W**. No client-side policy is *recreated*, so §30's prohibition holds; the positive half is under-consumed. |
| **F8 · DESIGN** §27 dark-mode-first not met | open | **still open, and larger than logged** | Counted as **four** W verdicts (P128 dark-mode, P129 purple, P132 blue/teal, P133 hero composition) plus **P13** in §3. The certification logs it as one design deviation; at requirement grain it is five. |
| **F9 · LOW** Phase 8 event Passport and Phase 9 yearbook not built | open | **CLOSED** | `EventPassportService.ts` + `routes/passport.ts:1877-1976` + `app/passport/event/[token].tsx`; `PassportYearbookService.ts` + `routes/passport.ts:1638` + `app/passport/yearbook.tsx`, entered from `PassportQuickLinks.tsx:89`. Only the "deeper Experience Graph" remains (P159 · W). |

### 4.2 What it did not find

Three requirement-level divergences are not in that document at all, and two of
them are structural:

- **The fabricated trust presentation (P45, P50, P154).** The certification's
  invariant 3 checks that trust is *domain-specific and confidence-aware* and
  passes it, citing `buildTrust:661` and the evidence-derived `confidence`. Both
  citations are accurate. What it does not ask is whether the number the domains
  are computed *from* exists — and it does not: with `trust_engine_enabled` off,
  `buildDomainTrust` reads a literal 50. Every Passport suite the certification
  ran "seeds a populated `trust_profiles` row" (PR #467's own account of why no
  test caught it), so the tests could not have surfaced this.
- **Consumer-projection adoption (P95, P98, P99, P100, P101, P169).** The
  certification does not test §21 at all — that part stands. The rest of this
  bullet was measured at `ebe72b34` and is **superseded as of 2026-09-08**: every
  one of the six variants now has a caller, and Map has a batch projection, so
  §35's rule is adopted on all seven consumer surfaces rather than
  three-sevenths. What remains is narrower and is carried by P169 alone: two BULK
  LIST endpoints — the discovery search list and the Compass traveler
  suggestions — still build identity inline, because a list cannot pay the
  per-user projection's ~34 reads per target and the batch path they need is
  viewer-dependent in a way the map's is not.
- **Coverage holes in surfaces it scored BUILT**: §15's Memories views (two of
  five — Trips, Places, People and Map do not exist, P77), §12's stamp-type
  vocabulary (no Place label, no Contributor type, P61), §14's Featured Journey
  (no events, no recommendations, P75), §26's My World hierarchy (stops at
  Country → City → stamps, P126), §13's detail view (no verification treatment,
  P68).

### 4.3 Net position

| Question | Certification | This census |
| --- | --- | --- |
| How much of the named code exists and is wired? | ~92% | **98.2%** — the certification is stale in Passport's favour; six of nine findings closed |
| How much of it does what the spec says? | not asked | **85.8%** |
| How much is honestly unverifiable *against this spec*? | ~8% narrated as "Runtime QA" | **0.6%** — one requirement. The runtime checks are real and owed, but they are not spec requirements |
| Biggest risk | "UI integration, one design choice, instrumentation — none silent correctness failures" | **A silent correctness failure**: every user is told they are "Established" on the strength of a constant, and an unreachable trust engine is indistinguishable from an established member |

The certification's closing sentence — "none of which are silent correctness
violations today" — is the one claim in it I would withdraw. P45/P50 is exactly
that: a live, user-visible, unfalsifiable claim about a person, produced by a
default that was written kindly and never re-examined. Everything else in the
gap between 98.2% constructed and 85.8% correct is unadopted plumbing or a
deliberate design inversion.

---

## 5. Open PRs that would change a verdict

Censused state is `main`. Four open PRs touch Passport trust rendering; **#467 is
the one that moves a verdict.**

| PR | What it does | Effect on this census |
| --- | --- | --- |
| **#467** — "stop presenting the constant 50 as a trust measurement" | Replaces the 50-substitution with `applicable: false`, a field the contract already carried for the Buddy domain; a domain rates only when at least one of its categories exists. Adds `getTrustProfileResult()` returning `ok \| absent \| unavailable` beside `getTrustProfile` so a failed read stops rendering as "established". | **Would flip P45, P50 and P154 from W to C** — the three verdicts that produce my only silent-correctness finding. CORRECT% would rise from 85.8% to **87.6%**. This is the single highest-value open PR against either spec in this pair. |
| **#453** — "render the trust strengths the server already sends" | `TrustScreen` renders `trust.strengths`, already produced by `TrustPrivacyGuard`. | Strengthens P45's explainability evidence; does not change a verdict on its own. |
| **#454** — "render the server's per-domain trust instead of a client constant" | `TrustScreen`/`useTrustProjection` consume the server's six domains rather than a client-side list. | Reinforces P60 (client renders, never derives). No verdict change — the server was already authoritative; this removes a client-side duplicate. |
| **#455** — "show the owner the recovery steps the server already computed" | Surfaces `TrustRecoveryService` hints on the owner's Trust screen. | Additive to P52's replayability story; no verdict change. |

Taken together the four are a coordinated repair of §9–§11 rendering. Only #467
changes what the product *asserts*; the other three change what it *shows* of
assertions the server already makes correctly.

---

## 6. Addendum (2026-09-07): `stamp_verified` now has a producer, and one deployment fact above is stale

Two corrections to the text above, both read from production rather than
remembered, and one change to the tree.

**Correction — the trust engine is not dark.** Headline item 1 and §3
deployment fact 1 say `trust_engine_enabled` "is seeded false, so nothing
writes `trust_events`". The seed is false; the production row is **TRUE** and
has been since 2026-07-17. Read 2026-09-07: `trust_engine_enabled = true`,
`trust_events` 5 rows, `trust_profiles` 2 rows, `user_stamps` 47 live rows
(0 admin-awarded), `stamp_verified` events **0**. The "Established"
substitution in P45/P50 is therefore produced not by a dark engine but by a
**starved** one: the scorer and scheduler run, and the emitters were the
defect. The P45/P50/P154 verdicts stand; the mechanism named for them was
wrong.

**Correction — P146 is telemetry only.** The row cites `stamp_verified` as
emitted from the award path; that is the §32 *telemetry* event
(`recordPassportEvent`), which lands nowhere (§3 fact 2). Until this addendum
the *Trust* event of the same name — `TRUST_EVENT_TYPES.STAMP_VERIFIED`,
+3 `passport_authenticity` — was declared and produced by nothing, so
`passport_authenticity` could only move DOWN on the live pipeline
(`stamp_disputed`, on revoke).

**Change.** `services/passport/StampAwardEngine.ts` `_awardStampCore` now
calls Trust's `recordStampVerifiedTrustEvent` (`StampAwardEngine.ts:665`) on
its `awarded: true` return — the same placement rule as the §32 events: only
when a `user_stamps` row was written by that call. Provenance: subject = the
stamp owner; source = the `user_stamps` row (one stamp pays once, 365-day
dedup inside Trust); an admin who awarded it is `metadata.awardedByAdminId`,
never the subject; a self-reported tier is refused by the helper. Fail-closed
on the flag (off or unreadable → no event, award unaffected); a ledger write
failure leaves the award awarded and is logged as
`stamp.award.trust_event_failed`. `revokeStamp`, `restoreStamp` and the
`recalculateForUser` backfill never enter `_awardStampCore` and emit nothing;
the heal of a partial failure emits once. Proven award → event →
`runTrustMaintenance` → `trust_profiles` in
`src/test/trustStampVerified.test.ts`; the declared-vs-produced matrix in
`src/test/trustEventCoverage.test.ts` no longer lists `stamp_verified` as
unproduced. No migration is required, and the flag is already on, so this is
live on deploy.

---

## 12. The correctness pass, 2026-09-13 — P169 closed, and a third of what remains is one brand decision

*Re-measured at `3ca68cb06`. **This section does NOT declare a `head_commit`, and §3's refusal
stands** — see §12.5 for exactly how many rows were executed here and why fifteen is not a hundred
and sixty-nine.*

### 12.1 The 15 BUILT-BUT-WRONG rows, grouped by WHY they are wrong

Grouped before anything was built. The question asked of each row: *what exactly stands between this
row and `C`?*

| group | rows | which |
|---|---|---|
| **(a) logic wrong in code this pass owns** | **4** | P169 · P75 · P77 · P126 |
| **(b) logic right, nothing reaches it** | **0** | — |
| **(c) capped by a flag seeded FALSE or an unapplied migration** | **1** | P61 |
| **(d) needs something nobody has written or decided** | **10** | P13 · P42 · P45 · P50 · P128 · P129 · P132 · P133 · P154 · P159 |

**FIVE OF THE FIFTEEN ARE ONE UNMADE BRAND DECISION.** P13, P128, P129, P132 and P133 all say the
same thing in different words: §27 specifies *dark navy/black surfaces, purple as the identity
accent, blue/teal for availability, and a circular portrait overlapping a travel hero*, and the tree
ships a deliberate, internally consistent opposite —
`travel-buddy-standalone/src/theme/passportTokens.ts:2#Passport palette — clean white/cream paper, black ink, red seal.`,
with `paper: '#FFFFFF'`, `ink: '#1C1C1A'`, `seal: '#D32F2F'` and **no purple, navy or teal token at
all** (`grep -i purple` over that file returns nothing). This is not five defects. It is one product
call nobody has made, counted five times because the spec listed it five times, and it is worth
**3.0 points of this census's correctness figure**. Recorded as owner decision D-DESIGN in §12.4.
`census-wall.md` W166 is the same divergence on the other surface, which makes it a portfolio
decision rather than a Passport one.

> **SUPERSEDED 2026-09-14 — and the paragraph above is wrong about its own scope, not only
> about its verdict.** The owner ruled (`docs/architecture/brand-palette-decision.md`) and the
> five rows were then opened one at a time, which is what the ruling's condition demands.
> **Two moved: P129 and P132, worth 1.2 points, not 3.0.** P128 half-closed and stays `W` on a
> THEME criterion the ruling expressly reserves; **P13 and P133 were never palette rows at
> all** — both fail on composition, and grouping them here was a category error that inflated
> the estimate by 60 % before anyone opened them. "Five rows saying the same thing in
> different words" was itself the unverified claim. §15 has the row-by-row.

**Two more are one owner decision about a WORD.** P45 and P50 both turn on whether the neutral 50 a
missing `trust_profiles` row produces may keep being labelled "Established"
(`artifacts/api-server/src/services/passport/PassportProjectionService.ts:1139#return Number.isFinite(v) ? v : 50;`)
and whether the confidence band may keep being derived from travel volume
(`artifacts/api-server/src/services/passport/PassportProjectionService.ts:2346#export function passportTrustConfidence`)
now that `evidence_weight` / `evidence_count` reach the projection. P154 is P45 again under a phase
number. **Three rows, one decision, 1.8 more points.**

So of the 8.9-point gap this census carried into the pass, **4.8 points sit behind two product
decisions and no engineering at all.**

### 12.2 Row moves

| id | was | now | why |
|---|---|---|---|
| P169 | W | **C** | **Built, and the row specified it.** P169's own text: *"What actually remains is not four unadopted consumers — it is two BULK LIST endpoints … Extending the batch projection with a viewer-relationship input is the remaining work, and it is one job, not two."* That job is `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:1153#export async function buildListIdentityProjections`, whose viewer input is `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:1109#export interface ListViewerRelationships`. Both lists adopted it: the Discovery search list at `artifacts/api-server/src/routes/discoverySearch.ts:664#const identity = await buildListIdentityProjections(sc, nameSafe as any[], {` and the Compass traveler suggestions at `artifacts/api-server/src/routes/compass.ts:3968#buildConsumerProjection(sc, "discovery_card"`. Pinned by `artifacts/api-server/src/test/passportListIdentityProjection.test.ts:1#/**` — 14 cases in three blocks, the third of which asserts that NEITHER route still resolves a display name or applies the picture opt-out itself. Also closes census-discovery A15 and the server half of census-compass CP-02. |

### 12.3 The divergence P169 closed was not cosmetic

P169 said both lists *"still build identity inline"*. They did not build the same thing.
`routes/discoverySearch.ts` already resolved the name through `lib/publicIdentity`'s choke point.
`routes/compass.ts` wrote `display_name ?? name ?? username` **inline, without trimming** — a fourth
copy of a rule with three, and the one that disagreed. A subject whose `display_name` is whitespace
therefore rendered as a **blank title** in the Compass traveler list, with nothing on the row to say
whose it was, while the map pin, the search row and the person card all fell through to the handle.

`presentedName`'s own docblock had already recorded this failure mode once —
*"One rule, three implementations, and this was the one that disagreed"* — about a different surface,
a different pass, the same defect. **That is the argument for a shared projection over a shared
comment**, and it is why P169 is `C` on a build rather than on a rename.

What was deliberately NOT unified, because unifying it would be taking a product decision under
cover of a refactor: the fallback label (Discovery falls back to the handle, Compass to the
username) and what else a locked row suppresses (Compass blanks city and username whether or not the
viewer follows; Discovery keeps them once followed). Those differ on purpose. The projection owns
the four facts that were the same and, in one case, wrong.

### 12.4 Owner decisions this pass surfaced rather than took

| # | Decision | Why it is the owner's | Worth |
|---|---|---|---|
| ~~D-DESIGN~~ **RULED 2026-09-14** | §27's palette (dark navy surfaces, purple identity accent, blue/teal availability, portrait over a hero) versus the shipped "passport paper" direction (white/cream, black ink, red seal, gold premium, document card with a spine). ~~Either the spec is amended or five rows stay wrong forever.~~ **The owner amended the spec: `docs/architecture/brand-palette-decision.md` — SPEC IS STALE, palette retained, purple/navy requirements superseded.** | ~~Changing it repaints every Passport surface~~ — and the ruling forbids repainting anything: *"build upon existing components and shared tokens; do not rebuild working screens."* `census-wall.md` W166 was the same call and is also closed. | **CLOSED for P129 and P132 — 1.2 points, not 3.0.** P128 half-closed (theme half open, §15.3); P13 and P133 were never in this decision's scope (§15.2) |
| D-WORD | Whether a substituted neutral 50 may keep the word "Established", and whether the confidence band may stay travel-derived now that `evidence_weight`/`evidence_count` reach the projection. | It changes the label a real person is shown, on evidence that does not exist for 56 of 58 accounts. census-trust A6 is why the evidence does not exist. | P45, P50, P154 — **1.8 points** |
| D-STAMP | Whether the stamp vocabulary gains `place` and `contributor` (P61). It needs a migration widening the CHECK that 2309 set. | Vocabulary is a product decision and a schema change; this pass was forbidden migrations. | P61 — 0.6 points |

### 12.5 The `head_commit` refusal STANDS, and here is the number that decides it

§3 refuses to declare a `head_commit` on the argument that doing so would report FRESH about 165 rows
nobody re-read, *"a worse lie than CANNOT BE CHECKED"*. **This pass executed fifteen rows** — every
one of the fifteen BUILT-BUT-WRONG rows, by opening the file its evidence names and running the grep
or reading the lines:

> P13, P42, P45, P50, P61, P75, P77, P126, P128, P129, P132, P133, P154, P159, P169.

Fifteen of 169 is **8.9 %**. Declaring on that would be the same lie with a smaller subject, so the
refusal is not overturned. **What this pass CAN report, which is new:** of the fifteen executed, one
verdict moved (P169) and **one more had false evidence and kept its verdict** — P42's *"nothing
consumes it"* is now wrong, and §12.6 says how. A 1-in-15 evidence-rot rate is not a basis for
extrapolating to the other 154; it is a reason not to declare.

### 12.6 A reason that expired on a row that did not move

| requirement | verdict | the reason that expired |
|---|---|---|
| P42 (Compass and Discovery weight explicit intent above generic interests) | W | ***"Nothing consumes it"* is FALSE.** Compass's `get_travel_compatibility` reads both travellers' explicit windows at the caller's permitted visibility and applies `explicitIntentBoost` — `census-compass.md` CP-01 establishes it and pins it with `test/compass-social.test.ts` D2, and `census-compass.md` §5 lists this row by name as a claim it measured false on 2026-09-07. This census did not pick that up. **The verdict holds for a different reason, which the row should have said:** the demand side is one of *four* surfaces — Compass's compatibility tool consumes it, Compass's traveler recommendation list does not (CP-01's own W), and neither Discovery path does (census-discovery A18, on the explicit ranker hold census-discovery A01 quotes from `docs/discovery/ROADMAP.md`). One of four is still not "Compass and Discovery". |

### 12.7 What was NOT built, and why

- **P75 (events + recommendations in the Featured Journey), P77 (three missing Memory views) and
  P126 (three missing My World levels) are genuine (a) rows and were not built.** They are product
  surface — new joins, new screens, new navigation — not corrections to wrong logic, and each is a
  multi-day build that this pass would have had to design rather than repair. Calling them (a) is the
  honest grade; leaving them is the honest outcome.
- **No migration was written and no flag was flipped**, which is what keeps P61 in (c).
- **No production read was made**, so every deployment fact in §3 remains a 2026-09-07 measurement.

### 12.8 Restated headline

> **Passport, at `3ca68cb06` (measured, NOT declared): 169 requirements · 153 BUILT-AND-CORRECT ·
> 14 BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 167 / 169 = 98.8 % ·
> CORRECT 153 / 169 = 90.5 %.** The gap between them is **8.3 points**, and **4.8 of those points are
> two product decisions** — a palette and a word — with no engineering behind them at all. One row
> moved, on a build the row itself specified.

| BUILT-AND-CORRECT | **153** |
|---|---|
| BUILT-BUT-WRONG | **14** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

---

## 13. The build pass, 2026-09-13 (second) — the two §12.7 deferred as "product surface" were built, and one build closed nothing

*Measured in the working tree at `a23502bc5` **plus this pass's own uncommitted changes**. **This
section does NOT declare a `head_commit`, and §3's refusal stands for a THIRD reason** — see §13.7,
which is not §12.5's argument repeated.*

§12.7 wrote off P75, P77 and P126 together: *"They are product surface — new joins, new screens, new
navigation — not corrections to wrong logic, and each is a multi-day build that this pass would have
had to design rather than repair."* Two of those three were built this pass, server and client, and
they are the two rows that move. The third (P77) is deferred for a reason §12.7 did not have: the
level it is missing belongs to another lane's in-flight work, not to a multi-day design.

All fourteen BUILT-BUT-WRONG rows were re-executed — every file its evidence names was opened and
every absence was established with a counting grep, never a truncated one. Two rows moved, one row
was BUILT and did NOT move, four reasons expired or were narrowed, and the five-row brand decision
was re-measured and confirmed unmoved.

### 13.1 Row moves

| id | was | now | why |
|---|---|---|---|
| P75 | W | **C** | **Built.** The row's finding was exact: `grep -ci event` and `grep -ci recommend` over `PassportJourneyService` both returned **0**. Both producers now exist and are canonical. EVENTS reach a journey by the two links the events feature already records — the FK at `artifacts/api-server/src/services/passport/PassportJourneyService.ts:591#loadTripEvents` reads `events.trip_id`, and the same function resolves the owner's `going` `event_rsvps` against each Trip's own date window (`artifacts/api-server/src/services/passport/PassportJourneyService.ts:569#withinTripWindow`). Visibility is the SAME ladder `tripVisibleToViewer` already applies to the containing trip (`artifacts/api-server/src/services/passport/PassportJourneyService.ts:552#eventVisibleToViewer`), so an event can never be a wider disclosure than the journey it hangs on, and the three `event_state` labels that record a NON-event are on nobody's journey including the owner's (`artifacts/api-server/src/services/passport/PassportJourneyService.ts:536#JOURNEY_EVENT_STATES`). RECOMMENDATIONS are the traveller's own Hidden Gems (`artifacts/api-server/src/services/passport/PassportJourneyService.ts:695#loadTripRecommendations`), and **who may see one is not decided there**: every candidate goes through `mayDiscloseGemIdentity`, the shipped predicate that restates migration 0043's own `hidden_gems_public_read` policy — so Journeys gets the answer Compass and the media surfaces get, from the same function, rather than becoming a fourth copy of the rule. Both elements are gathered ONCE for the list and the featured card together (`artifacts/api-server/src/services/passport/PassportJourneyService.ts:765#loadAttachments`), which is why the aggregate's Featured Journey cannot disagree with the Journeys list about what happened. Typed at `artifacts/api-server/src/services/passport/PassportJourneyService.ts:70#JourneyEvent` and `artifacts/api-server/src/services/passport/PassportJourneyService.ts:98#JourneyRecommendation`. **Rendered, not merely projected**: `travel-buddy-standalone/src/features/passport/JourneysScreen.tsx:266#Events</Text>` and `travel-buddy-standalone/src/features/passport/JourneysScreen.tsx:288#Recommendations</Text>`, typed at `travel-buddy-standalone/src/services/passportProjection.ts:100#JourneyEvent`. Pinned by `artifacts/api-server/src/test/passportJourneyEventsRecommendations.test.ts:1#/**` — 18 cases, watched RED at 17/18 before the build, and by two cases added to `JourneysScreen.component.test.tsx`. Eight of eight §14 elements. |
| P126 | W | **C** | **Built.** The row's finding was exact: the payload aggregated stamps by city and stopped, so Trip, Places and Memories had nowhere to come from. All three now exist, and the marker that carries them is the one this surface already owns — `buildMapPayload` has exactly ONE production caller (`GET /me/passport/map`), so this is My World's own payload and not a widening of the live Map's (§26/P127 hold). Level 4 groups each city's stamps into the Trips they were earned on, reading titles and dates from `trips`; level 5 names places from `places.name`, falling back to the neighbourhood rather than surfacing a uuid; level 6 attaches the owner's memories through the SAME `filterMemories` gate every other Passport surface runs — `artifacts/api-server/src/services/passport/PassportMapService.ts:186#attachTripLevels`, typed at `artifacts/api-server/src/services/passport/PassportMapService.ts:62#WorldTrip`. **The privacy answer is inherited, not re-decided**: the deeper levels are built from the POST-`filterStamps` rows (`artifacts/api-server/src/services/passport/PassportMapService.ts:150#attachTripLevels`), so a public viewer whose `guardStamp` just nulled `place_id` and `neighborhood` on a sensitive stamp has nothing left to make a Place out of — the new level cannot become a second route to a field the guard took away. **Nothing is dropped**: a stamp with no `trip_id` lands in an explicit untripped bucket, and the city's own `stampCount` still equals the sum of its Trips. **Rendered, not merely projected**: `travel-buddy-standalone/src/features/passport/MyWorldScreen.tsx:86#TripBlock`, fed by `travel-buddy-standalone/src/features/passport/usePassportWorld.ts:130#Array.isArray(m.trips)` and typed at `travel-buddy-standalone/src/services/passportStamps.ts:96#PassportWorldTrip`. Pinned by `artifacts/api-server/src/test/passportWorldHierarchy.test.ts:1#/**` — 17 cases, watched RED at 14/16 before the build, and by two cases added to `MyWorldScreen.component.test.tsx`. Six of six §26 levels. |

### 13.2 One row was BUILT and did not move, on purpose

**P45 stays W.** The build is real and is described below; the reason it does not close is that the
row's own stated blocker is a word, and the word is the owner's.

What was wrong and is now fixed: `confidenceBasis` told a consumer what the OVERALL confidence
rested on; the six TABLE 12 domain rows told it nothing. Every one shipped `applicable: true` and a
presentation word whether its categories had been measured or silently replaced by the neutral 50,
so **a traveller with a full `trust_profiles` row and a traveller with none produced six
byte-identical domain rows** — the §10 equivalence, one level down from where the last pass closed
it. Each domain now reports what its word rests on:
`artifacts/api-server/src/services/passport/PassportProjectionService.ts:280#domainTrustBasis`
(`measured` / `partial` / `substituted` / `unavailable` / `not_applicable`), wired at
`artifacts/api-server/src/services/passport/PassportProjectionService.ts:1243#buildDomainTrust` and
carried to the ONE consumer that receives the words at all
(`artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:789#d.basis`). `partial`
exists because a mean of three real scores and one default is neither a measurement nor a default,
and a two-valued field would have had to lie about one of them. Pinned by
`artifacts/api-server/src/test/passportDomainTrustBasis.test.ts:1#/**` — 16 cases, watched RED
before the build (the predicate did not exist), 9 mutations of the shipped predicate and its wiring
each caught.

**What was deliberately NOT changed, and is now PINNED so a later change is deliberate.** The
presentation word of a substituted domain is still "Established", and `applicable` still means only
"this domain does not apply to this person" — the Buddy case — rather than being quietly repurposed
as an evidence flag. Flipping either would be taking D-WORD under cover of a defect fix. The test
asserts both, so the pass that takes D-WORD must change an assertion that says so.

**Why that leaves P45 at W.** §12.1's row closes on *"the domain WORDS are still the constant's
words; changing them is the recalibration P50 records as an owner decision"*. That sentence is still
true. What would close P45 without touching D-WORD is one further step this pass did not take: a
surface that RENDERS the basis beside the word. Which brings the finding in §13.4 — today, none
does.

### 13.3 The fourteen, re-executed

Every row below was opened and re-measured; the verdicts are unchanged unless §13.1 moved them.

| id | re-executed finding | verdict |
|---|---|---|
| P13 · P128 · P129 · P132 · P133 | `travel-buddy-standalone/src/theme/passportTokens.ts:2#Passport` states the direction in its first line and the palette holds it: `paper: '#FFFFFF'`, `ink: '#1C1C1A'`, `seal: '#D32F2F'`. `grep -ci` over that file returns **0** for each of purple, navy, teal, indigo and violet — five counts, none truncated. The composition is a cream document card with a vertical spine and a LEFT-COLUMN avatar (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:3#Premium`), not a portrait overlapping a hero. §12.4's D-DESIGN is confirmed exactly as stated. **SUPERSEDED 2026-09-14 (§15):** the measurement above is correct about `passportTokens.ts` and wrong to conclude from it. `grep -ci teal` over ONE palette file cannot settle P132, because the availability and shared-context screens import the OTHER ratified palette, where teal-ink lives — see the P132 row. And P13/P133's composition finding is not a palette finding at all. | **SPLIT — see §15:** P129 → C, P132 → C, P128 → W (theme half), P13 → W (layout), P133 → W (layout) |
| P42 | The row body's *"nothing consumes it"* is FALSE and §12.6 already said so; this pass re-ran the count and confirms `readVisibleExplicitIntent` has **2** references outside its own definition, both in `artifacts/api-server/src/compass/CompassTools.ts` (its import and its `get_travel_compatibility` call site; that file is being edited by another lane in this tree, so no line number here would stay true). The row's own citation is also stale: the function is at `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:519#readVisibleExplicitIntent`, not `:445`. The verdict holds on §12.6's reason. **Deferred, not attempted** — see §13.5. | W |
| P45 | Built; did not move. §13.2. | W |
| P50 | Confirmed unchanged and deliberately so: the band is still `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)`. §13.2's work did NOT touch it, and the new test asserts `confidence` still reports one of the three existing bands, so a recalibration remains a deliberate diff. D-WORD. | W |
| P61 | Re-executed with counting greps, not samples: `grep -rn stamp_type` over `src/**` (`.ts` and `.sql` both) returns **0** occurrences of `'place'` and **0** of `'contributor'`, and `2309_passport_stamp_type_vocabulary.sql:116#CHECK` is still the only migration defining the constraint. The nine that ARE covered were each re-confirmed present in that array. Nine of eleven stands. **The classification is corrected** — see §13.4. | W |
| P75 | Built and closed. §13.1. | **C** |
| P77 | Re-executed: `travel-buddy-standalone/src/components/MemoriesTab.tsx:769#const MEMORY_VIEW_TABS` offered exactly two views when this was written. **Superseded 2026-09-14 (§17.6): four of five now exist; the verdict is unchanged, held by People.**. **Deferred** — see §13.5, for a reason §12.7 did not have. | W |
| P126 | Built and closed. §13.1. | **C** |
| P154 | Confirmed: it is P45/P50 under a phase number and moves when they do. | W |
| P159 | Re-executed, and the row's word *"absent"* is too strong — see §13.4. Still W: two of three. | W |

### 13.4 Reasons that expired, and evidence that overstated

Recorded separately from the builds, as the method requires. None of these moves a verdict; all
three make a row say something truer than it did.

| row | what this pass measured | consequence |
|---|---|---|
| P45 / P50 | §3 says *"56 of those 58 accounts are described as an Established member of the community across all six trust domains"*. That is true **of the projection**. It is not true of any shipped screen: `deriveTrustView` in `travel-buddy-standalone/src/features/passport/useTrustProjection.ts:277#export function deriveTrustView` builds its own six rows from server-owned CAPABILITY flags and renders "In good standing" / "Not applicable" — it never reads `trust.domains[].presentation` at all. A repo-wide grep finds the server's domain words reaching exactly ONE consumer, the `trips` variant's `trustDomains`, and **no client file consumes that either**. So the harm sentence overstates: today the substituted domain word is an API fact with no rendered surface. It does not weaken D-WORD — a projected field with no consumer is a defect waiting for its first one, and the Trips surface is the consumer it is waiting for — but the census should not claim a screen shows something no screen shows. | P45/P50 verdicts unchanged; §3's harm sentence narrowed |
| P61 | §12.1 groups P61 as **(c) capped by a flag seeded FALSE or an unapplied migration**, and §12.4's D-STAMP says it *"needs a migration widening the CHECK that 2309 set"*. Re-executed, that is only half the cap. A migration alone would add two labels with **no producer** — the precise defect class this repo already tracks in `docs/architecture/trust-unproduced-vocabulary.md`, and it would make the surface measurably worse, not better. What earns a Place stamp and what earns a Contributor stamp are unwritten product decisions; `PassportStampService`'s own union (`artifacts/api-server/src/services/passport/PassportStampService.ts:18#StampType`) would need both, and nothing would ever write either. | P61 is **(c) AND (d)**, not (c); a migration does NOT close it |
| P159 | The row says the deeper Experience Graph *"is still absent as a Passport surface"*. The graph itself is NOT absent: `compass_graph_nodes` / `compass_graph_edges` exist (`artifacts/api-server/src/migrations/20260730_compass_intelligence_graph.sql:10#compass_graph_nodes`), the `experience` node kind was admitted by `artifacts/api-server/src/migrations/2290_intelligence_graph_node_kinds.sql:2#Compass`, and the engine writes person —experienced→ experience —at_place / at_event / during_trip / in_city. A counting grep finds **30** files referencing those tables and **0** of them under `src/services/passport/` or the passport routes. The row's cause is therefore narrower and more actionable than "absent": **the Experience Graph is built and has no Passport reader.** | P159 verdict unchanged; its cause restated |

### 13.5 What was deferred, and the reason for each

- **P42 — deferred deliberately, not skipped.** Its remaining work is entirely in
  `routes/compass.ts` and the Discovery paths; the Passport-side half (the projection exposing the
  distinction) already exists and is consumed. Those two files were being edited by another lane in
  this same tree while this pass ran. Contending for them would risk losing someone else's work to
  a merge, which is a worse outcome than a row that stays W with an accurate reason. **Nothing in
  this pass touched either file.**
- **P77 — deferred for a NEW reason.** Trips, Places and Map are derivable from the existing memory
  payload; **People is not** — `PassportMemory` carries no people at all, and the memory-participant
  visibility work that would give it any is in flight in this tree right now
  (`artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts`, untracked as this was
  written). Building two of the four missing views would not move the verdict and would collide with
  that lane. This is a sequencing answer, not §12.7's "multi-day design" answer.
- **P61 — not attempted.** See §13.4: a migration alone does not close it, and the two product
  decisions it also needs are D-STAMP's.
- **P159 — not attempted.** What the "deeper Experience Graph" IS as a Passport surface is a design
  the spec names in three words and nowhere describes. Shipping a guess would be the failure §12.7
  correctly refused. §13.4 leaves the next pass a smaller job than the row implied.
- **No migration was written and no flag was flipped.** **No production read was made**, so every
  deployment fact in §3 remains a 2026-09-07 measurement.

### 13.6 D-DESIGN, re-measured — and what each row becomes under either answer

The decision is unchanged and unmade. Stating both outcomes explicitly, because the row texts do
not:

- **If the spec's palette is the brand** (dark navy surfaces, purple identity accent, blue/teal
  availability, portrait over a hero): P13, P128, P129, P132 and P133 stay **W** until the tokens
  file and every Passport surface are repainted. Nothing about them is a defect to fix today; they
  are five rows waiting on one repaint.
- **If the shipped paper/ink/seal direction is the brand**: all five become **C** by amending §27
  and §3 of the spec, with no code change at all — the implementation is internally consistent, is
  stated in the tokens file's first line, and satisfies §27's one statically-decidable
  accessibility clause. **That answer alone moves CORRECT% by 3.0 points.**

`census-wall.md` W166 and `census-map`'s accent rows turn on the same call, which is what makes it a
portfolio decision rather than a Passport one. This pass did not take it and did not touch a token.

### 13.7 The `head_commit` refusal stands, and this is a NEW reason for it

§3 and §12.5 both refuse on the same ground: declaring would report FRESH about rows nobody re-read.
That ground still holds — fourteen of 169 is **8.3 %**, which is §12.5's argument with a different
numerator.

**The new reason is stronger and is specific to this pass: there is no commit to declare.** The work
this section reports is UNCOMMITTED — it lives in a working tree shared with five concurrent lanes.
Declaring the current HEAD would name a tree in which **P75 and P126 are still BUILT-BUT-WRONG**, so
the document would point at a commit that falsifies its own two row moves. That is not a weaker lie
than CANNOT BE CHECKED; it is a different and worse one.

A third fact makes the same point from the other side: five of the thirteen censuses are reported
STALE by `check:census-freshness` **right now**, several of them against files this same tree is
still being edited in. A `head_commit` declared into a moving tree is stale before it is read.

**What would make declaring right, stated so the next pass can just do it:** this work committed,
then a recensus that re-reads the remaining 155 rows — not fourteen of them — against that commit.
It joins the checkable set then, the way the Wall and Trust censuses did.

**RE-CHECKED 2026-09-13 by the integrating lane, because the freshness pass is the moment to test a
refusal rather than inherit it. The third reason has EXPIRED; the refusal stands on the first two,
and on a fourth the section could not have known.** §13's work is committed — `cd400d2ff` carries
`PassportJourneyService`, `PassportMapService`, `PassportProjectionService`,
`PassportConsumerProjections`, the three new suites and both screens — so *"there is no commit to
declare"* is no longer true, and a declaration at `cd400d2ff` would name a tree in which P75 and
P126 really are `C`. That is the whole of what has changed. §3's and §12.5's ground is untouched:
fourteen of 169 rows were re-executed this pass, and declaring would report FRESH about the other
155, which is §12.5's argument with a different numerator and is the thing this document has
refused three times. **The fourth reason is mechanical and is worth stating because it means a
declaration would buy nothing even if the first two were waived:** `census-passport.md` has NO entry
in `CENSUS_SCOPE` in `src/scripts/checkCensusFreshness.ts` — deliberately, and that file says why in
a comment naming this document's own refusal — so a `head_commit` declared today would move this
census from *"no head_commit declared — CANNOT BE CHECKED"* to *"declares a commit but has no scope
— CANNOT BE CHECKED"*. Both are reported by name and neither is a pass. **What would make declaring
right is therefore unchanged in substance and now has a second half:** the 155-row recensus above,
AND a `CENSUS_SCOPE` entry listing the paths this document is a measurement of, added in the same
change so the declaration is checkable the moment it is made.

### 13.8 Restated headline

Recomputed by `pnpm -s check:census-integrity`, which parses the tables rather than trusting prose —
never by hand-counting:

> ```
> census      rows     C     W     N    X   denom  unreconciled
> passport     169   155    12     1    1     169  0
> ```

> **Passport, at `a23502bc5` + this pass's uncommitted changes (measured, NOT declared): 169
> requirements · 155 BUILT-AND-CORRECT · 12 BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY →
> CONSTRUCTED 167 / 169 = 98.8 % · CORRECT 155 / 169 = 91.7 %.** The gap is now **7.1 points**, of
> which **4.8 remain two product decisions** — a palette and a word — with no engineering behind
> them. Two rows moved, both by building the thing the row named, server and client. One more was
> built and did not move, because its blocker is a word that is not an engineer's to change.

| BUILT-AND-CORRECT | **155** |
|---|---|
| BUILT-BUT-WRONG | **12** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

---

## 14. The blocker pass, 2026-09-14 — all fourteen re-executed, FOUR carried false evidence, ZERO moved, and every one now says what would move it

*Measured in the working tree at `7d1f2d498` plus six concurrent lanes' uncommitted changes.
**No `head_commit` is declared and §3's refusal stands**, for §12.5's reason with a fourteenth of the
numerator; §13.7's fourth reason (no `CENSUS_SCOPE` entry) is also unchanged.*

**This pass closed nothing, and that is the finding rather than the excuse.** Every one of the
fourteen open rows was opened, re-executed against this tree, and traced to what actually stands
between it and `C`. **The thing standing in front of every one of the fourteen is a decision, a
sibling lane's file or an aesthetic judgement — not one of them is waiting on engineering inside
this census's own paths.** (Two of them, P61 and P159, become this lane's work the moment their
decision is taken; §14.4 says which decision and how small the build then is.) Eight are blocked on two owner decisions (D-DESIGN ×5, D-WORD ×3), one on an owner ruling
recorded in a different census (P42 → `docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`),
one on an owner classification plus a policy question the tree already answers the other way (P59),
one on a migration plus an unmade product decision (P61), one on a client surface and an in-flight
sibling lane (P77), one on a design the spec names in three words (P159), and one on an aesthetic
judgement no static method decides (P66).

What this pass CAN report that is new: **four of the fourteen carried evidence that is measurably
false at this tree** — a 4-in-14 evidence-rot rate against §12.5's 1-in-15 — and in three of the four
the row is *wronger in the census's favour* than the row says, which is the direction that matters.
§14.5 also measures the rot in the §2 main table's citations directly, because that is the part of
this document that cannot be checked by any script in the repo.

### 14.1 Row moves

| id | was | now | why |
|---|---|---|---|
| — | — | — | **None.** No verdict moved. Three suites were extended and six mutations proven (§14.6), but a pinned fact is not a closed row and this section will not pretend otherwise. |

### 14.2 The four rows whose evidence was FALSE at this tree

Recorded before the re-execution table, because each one changes what the row means rather than only
what it cites.

| row | the sentence that is false | what was measured, 2026-09-14 |
|---|---|---|
| **P42** | *"Neither Compass nor Discovery reads the discovery-card variant"*, and §12.6's *"Compass's traveler recommendation list does not"* consume explicit intent. | **Both Compass people-ranking surfaces now consume it.** The compatibility tool at `artifacts/api-server/src/compass/CompassTools.ts:1938#readVisibleExplicitIntent(sc, targetId` (already known), AND the traveler suggestion list at `artifacts/api-server/src/routes/compass.ts:3912#const viewerIntentRead = await readVisibleExplicitIntent`, which reads each candidate at the visibility the viewer is entitled to and applies the shared bounded weight through `artifacts/api-server/src/routes/compass.ts:4405#export function applyExplicitIntentWeighting`. The demand side is **two of two in Compass**, not one of four. The row's own citation is also stale twice over: the function is at `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:519#readVisibleExplicitIntent`, not `:445` (`:445` is now `explicitIntentBoost`), and `buildConsumerProjection`'s three named call sites became seven in §12. |
| **P59** | *"the tree's only current posture on visas is the OPPOSITE one — the three places the word appears are Layover disclaimers (`LayoverSafetyEngine.ts:585`, `:619`, `:628`)"*. | **Wrong on the count, the lines and the posture — and the truth makes the N stronger.** Those three Layover lines are now `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:1198#Verify visa rules`, `:1246` and `:1256`. More to the point the word appears in two systems the row did not see. (1) A whole curated entry-intelligence subsystem: `artifacts/api-server/src/lib/entryRequirements.ts:4#HONESTY CONTRACT` — admin-curated corridor rows only, every row carrying an `official_source_url`, unknown corridors explicit, and `artifacts/api-server/src/lib/entryRequirements.ts:20#export const DISCLAIMER` shipped with every assessment. (2) A live abuse policy that classifies the *peer-to-peer* version of this capability as fraud: `artifacts/api-server/src/domain/telegraph/policies/travelScamSignals.ts:111#family: "VISA_HELP"`, whose patterns include the embassy-insider and fast-track-your-visa offers. So the tree does not merely lack a Visa Buddy; **it ships a policy that reads one as a scam signal and an architecture that answers visa questions from official sources with a disclaimer.** |
| **P61** | *"there is **no Contributor stamp type at all** (contributions surface as a credential via `PassportReputationService`, never as a stamp)"*. Hence *"nine of eleven"*. | **There is one, it is seeded, and it has a live producer.** `artifacts/api-server/src/migrations/0198_place_contributor_stamps.sql:9#INSERT INTO stamp_definitions` seeds three definitions carrying `stamp_type = 'place_contributor'`, awarded at 10 / 50 / 100 posts by `artifacts/api-server/src/lib/places/placeCollectionsWorker.ts:172#definitionSlug: "place_contributor"`, and the label reaches the Passport's own collection verbatim through `artifacts/api-server/src/services/passport/UnifiedStampService.ts:219#stampType: r.stamp_definitions?.stamp_type ?? null`, with TABLE 16 provenance `contribution_earned` (`artifacts/api-server/src/services/passport/UnifiedStampService.ts:100#case "posts"`). **Ten of eleven, not nine.** |
| **P77** | *"two of five"* Memories views. | **One of five.** §15 names Trips, Places, People, Timeline and Map. `travel-buddy-standalone/src/components/MemoriesTab.tsx:769#const MEMORY_VIEW_TABS` (**superseded 2026-09-14 — see §17.6; the two-tab catalogue this cited is gone, the verdict is not**) offers exactly two tabs, and only **Timeline** is one of the five — "All" is the ungrouped grid, which is the surface the five views are views *of*, not a sixth view. The row is one worse than it says. |

### 14.3 The fourteen, re-executed

Every row below was opened at this tree and its claim re-run. Verdicts are unchanged; the findings
are not.

| id | re-executed finding | verdict |
|---|---|---|
| P13 | Confirmed unmoved, with two citations repaired. The composition is still a cream document card with a vertical spine (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:357#<View style={s.spine}>`) and a LEFT-COLUMN avatar (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:671#leftCol:`), not a portrait overlapping a hero. The avatar is circular and gold-ringed — but **not at the `:653` this row cites**, which is a 34 px absolute-positioned overlay chip; the real evidence is `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:679#goldRing:` and `:685#avatarPressable` (`borderRadius: AVATAR_SIZE / 2`). D-DESIGN. **Still unmoved 2026-09-14, and now for a stated reason rather than a pending decision: the palette ruling does not reach a composition (§15.2).** | W |
| P42 | **Evidence false — see §14.2.** Compass is two of two; Discovery is zero of one and is the whole of what remains. Discovery's people path is not a ranker at all (`artifacts/api-server/src/routes/discoverySearch.ts:584#.order("name", { ascending: true })` — an alphabetical name-match search that weights no interest term either way), so the clause binds on Discovery's CONTENT ranker, and that ranker is on an explicit owner hold: `docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`, which `census-discovery.md` A18 grades `N — owner hold`. The blocker is an owner ruling, not a contended file. | W |
| P45 | Confirmed unchanged at `artifacts/api-server/src/services/passport/PassportProjectionService.ts:1139#return Number.isFinite(v) ? v : 50;` and `artifacts/api-server/src/services/passport/PassportProjectionService.ts:1112#if (score >= 50) return "Established";`. §13.2's `basis` is live and reaches the trips variant (`artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:789#basis: d.basis`). Re-measured: **`trust.domains` still has no client consumer at all** — a repo-wide grep over `travel-buddy-standalone/src` for `trustDomains` and `domains[` returns **0**, and `useTrustProjection.ts` still builds its own six rows from capability flags. D-WORD, plus a client surface. | W |
| P50 | Confirmed unchanged and deliberately so: `artifacts/api-server/src/services/passport/PassportProjectionService.ts:2346#export function passportTrustConfidence`. `evidenceWeight` / `evidenceCount` / `confidenceBasis` reach the projection beside it and make the two 82s distinguishable; the BAND is still travel-derived, and because `confidence === "low"` is what selects the non-stigmatizing "New Traveler" copy (`artifacts/api-server/src/services/passport/PassportProjectionService.ts:1266#"New Traveler · Verified"`), recalibrating the band changes the word a person is shown. D-WORD. | W |
| P59 | **Evidence false — see §14.2, and the correction strengthens the N.** Re-confirmed absent: `canProvideVisaBuddyService`, `VisaBuddy` and `visa_buddy` return **0** across the server and client trees, and `artifacts/api-server/src/services/passport/PassportProjectionService.ts:740#export function buildOwnerCapabilities` returns exactly six keys. Now pinned by `artifacts/api-server/src/test/passportProjection.test.ts:584#§11 capabilities — six built` so a seventh cannot arrive by accident. | N |
| P61 | **Evidence false on Contributor — see §14.2. Ten of eleven, not nine.** PLACE is the only type with no representation, and re-executing it shows the gap is narrower than "no label": the column is already written (`artifacts/api-server/src/services/passport/PassportStampService.ts:146#place_id: placeId ?? null`), and **no caller anywhere passes `placeId`** — all five `createStamp` call sites (`routes/location.ts`, `routes/hiddenGems.ts`, `routes/geofence.ts`, `routes/safeReturn.ts`, `routes/airport.ts`) omit it. So Place needs a CHECK label (migration, owner) AND a rule for what earns one (product, D-STAMP); it does not need schema work. Pinned by `artifacts/api-server/src/test/passportStampTypeVocabulary.test.ts:202#Contributor exists, Place does not`. | W |
| P66 | Unchanged and still undecidable statically. The perforated half re-confirmed at all four cited files. New evidence the earlier passes did not have, and it is NOT enough to close the row: three RENDERED premium stamps are committed at the repo root (`premium-test-epic.png`, `premium-test-common.png`, `premium-hero-raw.png`) and the epic one shows a gold metallic ring, a scalloped edge, a unique per-city motif and an "OPEN EDITION · EPIC" rarity band. They arrived as a side effect of an unrelated Discovery PR (`a745ba11b`), no code in the tree references them, and a repo-root PNG of unknown provenance is not a rendered screen of the shipped app. | ? |
| P77 | **Evidence false — one of five, not two (§14.2).** Re-executed: `travel-buddy-standalone/src/components/MemoriesTab.tsx:769#const MEMORY_VIEW_TABS` (**superseded 2026-09-14 — see §17.6; the two-tab catalogue this cited is gone, the verdict is not**) still offers exactly two tabs. §13.5's sequencing reason holds and is now sharper: People is blocked on memory-participant visibility, which is live in this tree as another lane's in-flight work (`artifacts/api-server/src/services/memory/**`), and Trips / Places / Map are client surfaces in `travel-buddy-standalone/**`. No part of this row lies in this census's own paths. | W |
| P128 | Confirmed unmoved: `travel-buddy-standalone/src/theme/passportTokens.ts:8#paper:        '#FFFFFF',` and `travel-buddy-standalone/src/theme/passportTokens.ts:11#ink:          '#1C1C1A',`, under a file header that states the direction in its first line. `grep -ci` over that file returns **0** for each of purple, navy, teal, indigo and violet — five counts, re-run, none truncated. D-DESIGN. **Half-closed 2026-09-14 — surfaces ratified, `dark-mode first` still open (§15.3).** | W |
| P129 | Confirmed unmoved: the identity accent is `travel-buddy-standalone/src/theme/passportTokens.ts:15#seal:         '#D32F2F',` — red. No purple token exists. D-DESIGN. **MOVED W→C 2026-09-14 (§15.1).** | W |
| P132 | Confirmed unmoved: no blue or teal token exists in the passport palette at all; availability and shared-context surfaces run on paper/ink/seal. D-DESIGN. **MOVED W→C 2026-09-14, and this finding was FALSE — it read one palette file and the screens use the other (§15.4).** | W |
| P133 | Confirmed unmoved: two of four. Rounded cards and a cover exist; the portrait sits in `:671#leftCol:` of a document card rather than over a hero, and there is no glass treatment. D-DESIGN. **Still unmoved 2026-09-14: never a palette row (§15.2).** | W |
| P154 | Confirmed: it is P45 and P50 under a phase number and moves when they do. Nothing in this row is separately buildable. D-WORD. | W |
| P159 | Confirmed, and §13.4's restatement re-measured exactly: `artifacts/api-server/src/compass/CompassGraphEngine.ts:915#batch.node("experience", key, city, {` writes person —`experienced`→ experience —`at_place` / `during_trip` / `at_event` / `in_city` (`:876`–`:797`), admitted by `artifacts/api-server/src/migrations/2290_intelligence_graph_node_kinds.sql:63#'circle','experience'`. **30** files reference the graph tables and **0** are under `src/services/passport/` or `src/routes/passport*.ts`. The Experience Graph is built and has no Passport reader. | W |

### 14.4 WHAT WOULD TURN EACH OF THESE RED — the deliverable for a row that cannot close

Stated as evidence-and-supplier, not as aspiration. A row whose entry here is vague is a row nobody
can pick up.

| row(s) | What would settle it | Who supplies it |
|---|---|---|
| **P13 · P128 · P129 · P132 · P133** | **One written answer to D-DESIGN**, in either direction, recorded where a census can cite it. If the spec's palette is the brand: a repaint of `travel-buddy-standalone/src/theme/passportTokens.ts` and every surface reading `PP`, and these five stay W until it lands. If the shipped paper/ink/seal direction is the brand: an amendment to spec §3 and §27, after which all five become C **with no code change**, because the implementation is internally consistent and already satisfies §27's one statically-decidable accessibility clause. Nothing an engineer can measure distinguishes the two today — that is the whole of the blocker. | **Owner / design.** `census-wall.md` W166 and `census-map`'s accent rows turn on the same call, so it is a portfolio decision. **Do not take it inside a defect fix.** |
| **P42** | Either (a) the owner lifting the ranker hold at `docs/discovery/ROADMAP.md:222`, followed by an explicit-intent term landing in `artifacts/api-server/src/lib/discoveryPde.ts` / `discoveryModifiers.ts` weighted above the generic interest term — at which point the row closes on the same `explicitIntentBoost` / `genericInterestWeight` pair Compass already shares; or (b) an owner ruling that §8's clause binds only on people-ranking surfaces, in which case the row closes TODAY on Compass's two, because Discovery has no people ranker to violate it. **(b) is a scope ruling and is not an engineer's to take** — it is recorded here so the owner can take it in one reading. | **Owner** (hold or scope). Then the **Discovery lane** builds it; the Passport supply side and the shared weight already exist and need no change. |
| **P45 · P50 · P154** | **One written answer to D-WORD**: may a substituted neutral 50 keep the word "Established", and may `confidence` stay travel-derived now that `evidence_weight` / `evidence_count` reach the projection? A yes closes all three by amending §9/§10's wording. A no is a one-file change in `PassportProjectionService` that this census's own tests are written to catch, because they currently assert the opposite. **Separately and independently of D-WORD**, P45 also needs the client to RENDER `domains[].basis` beside the word (`travel-buddy-standalone/src/features/passport/TrustScreen.tsx` / `useTrustProjection.ts`), which today reads none of the six server domains at all. | **Owner** for the word; the **client lane** for the render. The server half of the explainability is built and shipped. |
| **P59** | An owner ruling on `VISA_BUDDY_CAPABILITY` that answers, in this order: (1) does §11's seventh capability survive at all, or is the spec amended to six? (2) if it survives, what activity does it authorise that `artifacts/api-server/src/domain/telegraph/policies/travelScamSignals.ts:111#family: "VISA_HELP"` does not already classify as fraud? (3) what evidence — not what trust score — qualifies a person for it? Until (2) is answered there is nothing to gate and the flag would be vocabulary with no producer. **Note the asymmetry: amending the spec to six closes this row with zero code.** | **Owner, with legal.** No engineering input is missing. |
| **P61** | Two things, and neither alone: (1) a migration widening `passport_stamps_stamp_type_check` (last set by `artifacts/api-server/src/migrations/2309_passport_stamp_type_vocabulary.sql:116#CHECK`) to admit `place` — a migration number must be allocated by the integration owner; (2) a product rule for what earns a Place stamp and which of the five `createStamp` call sites supplies the `placeId` the writer already accepts. A migration without (2) adds a label with no producer and makes the surface worse. **Contributor no longer blocks this row.** | **Owner** for the vocabulary decision + migration number; then **this lane** builds (2) in a day, since the column, the guard (`PassportPrivacyGuard.guardStamp` already redacts `place_id`) and the read layer are all in place. |
| **P66** | A named person looking at a rendered screen of the shipped Stamps surface on a device and recording a verdict, the way the Wall census rules "generous whitespace". The three committed PNGs are NOT that: they are artwork of unknown provenance sitting at the repo root with no code referencing them. What would make them count is a generator or CI step in the tree that produces them from the shipped pipeline, cited by path. | **Owner / design**, on a device build. No static method reaches this. |
| **P77** | Three of the four missing views (Trips, Places, Map) are derivable from the memory payload that already exists and are pure client work in `travel-buddy-standalone/src/components/MemoriesTab.tsx`. **People is blocked and is why the row cannot close on the other three**: `PassportMemory` carries no people, and the participant-visibility work that would give it any is another lane's in-flight code under `artifacts/api-server/src/services/memory/`. The row turns C when four of five exist; building three of five moves nothing. | The **client lane** for three; the **Highlights & Memories lane** for the participant contract this census must not touch. |
| **P159** | A one-paragraph product definition of what "deeper Experience Graph" IS on the Passport — which of the graph's four experience edges a traveller may see, about whom, and at what viewer relationship. Everything downstream of that sentence is buildable here and is small: the graph is written, the node kind is admitted, and the reader would live in `src/services/passport/` behind the existing `PassportPrivacyGuard` tiers. **Shipping a guess is the failure mode, not the absence.** A second, harder question the definition must answer: the graph is built from `memories` that are published and not `only_me`, so a Passport reader inherits Memory's audience rules and must not become a second route to a memory the memory surface would not show. | **Owner / product** for the definition; then **this lane** for the reader. It is the only one of the fourteen whose remaining engineering is entirely inside this census's own paths. |

### 14.5 The §2 main table's citations have rotted, and no check in this repo can see it

This document's Method line says *"Every BUILT verdict cites a file:line that was opened and read."*
That is no longer verifiable from the document, and the reason is mechanical: the §2 table's
citations are **bare `:NNN` line numbers with no needle**, while `check:doc-citations` (per the lane
rules) only verifies that the file is long enough to have that line. §13's `file:LINE#needle` form
is the one that survives; §2's is not.

Measured, not asserted. Twelve `PassportProjectionService.ts` citations were sampled out of the §2
table and each line was read at this tree:

> `:1527 buildPassportProjection` · `:975 buildTrust` · `:729 buildOwnerCapabilities` ·
> `:683 identity` · `:717 buildTravelerState` · `:862 buildAvailability` · `:1191 buildUpcomingPlans` ·
> `:955 domains` · `:1024 buildCredentials` · `:1083 mapStamp` · `:327 classifyViewerContext` ·
> `:427 resolvePassportViewerContext`

**Eleven of the twelve now point at something else.** `:1527` is a `showDates` ternary;
`buildPassportProjection` is at `:1884`. `:975` and `:1024` are blank lines. `:717` is a
`building_trust: 1` map entry. The single survivor is `:729 buildOwnerCapabilities` — the one
citation in that sample that a later pass had already re-anchored with a needle, in P59's text.

This does not move a verdict: the named functions all exist and were re-read here. It does mean
**the §2 table can no longer be audited by following its own citations**, and a reader who samples
it will conclude the census is wrong when it is merely stale. The repair is mechanical and is the
next recensus's job: re-anchor §2 in `file:LINE#needle` form in the same change that re-reads the
155 rows §13.7 names.

### 14.6 What this pass built — three pinned facts, six mutations, no new files

No row moved, so nothing here is offered as construction. Each addition exists because the census
claim it supports was found rotted once already and has no test standing under it. **No new test
file was created**, deliberately: registering one requires editing `package.json`, which belongs to
the integration owner, and the allowlist route would register a test that never runs.

| where | what it pins | mutation that turned it RED |
|---|---|---|
| `artifacts/api-server/src/test/unifiedStamps.test.ts:253#§12 Contributor stamps reach the Passport` | 4 cases: a `place_contributor` award keeps its catalog label through the unified read, carries `contribution_earned`, does not collapse two tiers into one, and readV2 **still asks the database for `stamp_type`**. | Hard-coding `stampType: null` in `readV2` → cases 1 and 3 RED. **Dropping `stamp_type` from the `stamp_definitions(...)` SELECT did NOT turn the behavioural cases red** — this file's fake ignores the select string — which is why the fourth case reads the shipped source; that mutation turns THAT one RED. Recorded because it is exactly the shape of a test that cannot fail. |
| `artifacts/api-server/src/test/passportStampTypeVocabulary.test.ts:202#Contributor exists, Place does not` | 3 cases: migration 0198 seeds three `place_contributor` definitions, a shipped worker awards them on thresholds, and `createStamp` still writes `place_id` — so P61's residue is a label plus a caller, not schema work. The third also trips if a `place` label ever appears, so the D-STAMP migration must come past an assertion that says to re-read this row. | Retyping 0198's gold tier → case 1 RED; renaming the worker's `definitionSlug` → case 2 RED; deleting `place_id: placeId ?? null` from the insert → case 3 RED. |
| `artifacts/api-server/src/test/passportProjection.test.ts:584#§11 capabilities — six built` | 3 cases: `buildOwnerCapabilities` returns exactly the six §11 capabilities that gate something, `VISA_HELP` is still a live travel-scam family, and `entryRequirements`' curated-source disclaimer is intact — the two artefacts that make P59 a policy question. | Adding a seventh capability key → case 1 RED naming it; renaming the `VISA_HELP` family → case 2 RED; weakening the DISCLAIMER sentence → case 3 RED. |

Run: 1 616 passport/stamp assertions, 1 612 pass. The four failures are the pre-existing guard-refused
`*SelfVerification` suites §3 already names (`assert-nonprod-supabase.sh` refuses without a sanctioned
non-production target); they refuse before executing and are unrelated to this pass.
`typecheck:tests` is at baseline for every file this pass touched.

### 14.7 Cross-lane requests this pass raised rather than took

Each names a file this census does not own, the change, and why it is required.

1. **Discovery lane / owner — P42.** `artifacts/api-server/src/lib/discoveryPde.ts` and
   `discoveryModifiers.ts` need an explicit-current-intent term weighted above the generic interest
   term, reusing `PassportConsumerProjections`' exported `explicitIntentBoost` / `genericInterestWeight`
   rather than a fourth local ratio. **Blocked upstream by the ranker hold**; raised so the work is
   specified when the hold lifts.
2. **Client lane — P45.** `travel-buddy-standalone/src/features/passport/useTrustProjection.ts`
   builds its own six trust rows from capability flags and never reads `trust.domains`. The server
   sends `presentation`, `applicable` AND `basis` per domain. Rendering `basis` beside the word is
   the half of P45 that does **not** require D-WORD.
3. **Client lane — P77.** Trips, Places and Map views in
   `travel-buddy-standalone/src/components/MemoriesTab.tsx`; three of the four missing §15 views are
   derivable from the payload that already ships.
4. **Highlights & Memories lane — P77.** `PassportMemory` carries no people. The People view needs
   the participant-visibility contract being built under `artifacts/api-server/src/services/memory/`.
   This census must not touch it, and building the other three without it does not move the row.
5. **Integration owner — P61.** A migration number in the 2100–2999 band for the `place` vocabulary
   widening, to be allocated only after D-STAMP is ruled. Not requested now; recorded so the sequence
   is unambiguous.

### 14.8 Headline, unchanged

Recomputed by `pnpm -s check:census-integrity`, which parses the tables:

> ```
> census      rows     C     W     N    X   denom  unreconciled
> passport     169   155    12     1    1     169  0
> ```

> **Passport, at `7d1f2d498` + six lanes' uncommitted changes (measured, NOT declared): 169
> requirements · 155 BUILT-AND-CORRECT · 12 BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY →
> CONSTRUCTED 167 / 169 = 98.8 % · CORRECT 155 / 169 = 91.7 %.** Unchanged by this pass, and the
> shape of the remainder is now fully specified: **8 of the 14 open rows are two owner decisions**
> (D-DESIGN 3.0 points, D-WORD 1.8), 3 more are an owner ruling apiece (P42's hold, P59's
> classification, P61's vocabulary), 1 is a client build another lane owns (P77), 1 is a product
> definition (P159) and 1 is an aesthetic judgement (P66). **Zero are blocked on engineering inside
> this census's paths, and that is why zero moved.**

**The first headline block of this document read 152 / 15 / 1 / 1 when this section was written.**
It was the `ebe72b34` measurement and was dated as such; §12.8, §13.8 and this section restate it.
The recensus §13.7 asks for should replace it rather than patch it — a headline edited row by row is
how it drifted in the first place, and three of the thirteen censuses already carry a
CORRECTION HEADER saying so.

> **AMENDED 2026-09-14 (§15).** That block now reads **154 / 13 / 1 / 1** — P129 and P132 moved
> `W→C` on the palette ruling, verified individually. It is still the `ebe72b34` §2 count plus this
> one pass's two moves, and it still does NOT include P75 and P126, which §13.1 moved to `C` and
> §2 never restated. §15.6 carries the figure that counts every row's LATEST statement anywhere in
> this document — **157 / 10 / 1 / 1** — and says plainly which of the two a reader should quote.

---

## §15 — The palette ruling, 2026-09-14: two rows moved, three did not, and the estimate was wrong

*Worktree `/home/user/wt-483` at `7d1f2d498`. This pass touched **no code at all** — no
token, no component, no test. The ruling forbids it in its closing paragraph: "Build upon
existing components and shared tokens; do not rebuild working screens."*

The owner ruled **SPEC IS STALE** on `D-DESIGN` (and on `census-wall.md`'s `D-WALL-COLOUR`,
which is the same call): keep Portava's existing palette — Paper `#FFFFFF`, Ink `#1C1C1A`,
Seal red `#D32F2F`, Vermilion `#FF4D2E`, Teal ink `#0A3D4A` — retain the Passport and Wall
colour identities, and update the conflicting purple/navy requirements. The ruling is at
`docs/architecture/brand-palette-decision.md`. It attaches a condition to itself:

> *Verify each affected requirement before closing it; this decision does not automatically
> resolve unrelated theme, layout, or accessibility criteria.*

**That condition is the whole of this pass, and it changed the answer.** §12.1 and §12.4
recorded five rows under D-DESIGN worth *"3.0 points"*. Opened one at a time, it is **two
rows and 1.2 points**.

### 15.1 What moved

| id | was | now | why |
|---|---|---|---|
| P129 | W | **C** | *"Purple as the Passport identity accent"* is a pure colour-to-role assignment — it asserts nothing about layout, hierarchy, type, spacing or contrast, so there is no second half to survive the amendment. Seal red `#D32F2F` is ratified by name and is what ships: `travel-buddy-standalone/src/theme/passportTokens.ts:15#seal:         '#D32F2F',`, carrying the identity device itself at `travel-buddy-standalone/src/components/passport/PassportVerifiedSeal.tsx:35#<ShieldCheck size={iconSize} color={PP.seal} strokeWidth={1.8} />`. It is also the palette's ONLY accent — counted at this tree, the Passport tree reads `PP.inkMuted` 60 times, `PP.ink` 47, `PP.borderLight` 36, `PP.paper` 30, `PP.paperDeep` 17, against **6** `PP.seal` and 2 `PP.gold` — so "identity accent" is a description of what the file does, not a generous reading of it. |
| P132 | W | **C** | **The row's evidence was FALSE, and the requirement was already met.** See §15.4 — this one did not need the ruling to be *true*, it needed the ruling to stop the obvious objection to it. |

### 15.2 What did NOT move, and the distinction that decides it

The ruling amends **colour clauses**. It says so twice: *"only the colour named in it moves"*,
and *"the mockup approves the palette only — not a new layout."* So the test for each row is
not "is this row in §27?" but **"is the thing this row fails on a colour?"**

| id | fails on | palette half | remainder | verdict |
|---|---|---|---|---|
| P13 | composition | **none — there was never a colour clause in it** | a document card with a vertical spine (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:357#<View style={s.spine}>`) and a left-column avatar (`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:671#leftCol:`) where §3 asks for a circular portrait overlapping a travel hero. The component says so in its own first lines: `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:3#Premium cream/ivory document card with vertical spine, gold-ring avatar,` | **W** |
| P128 | theme **and** surface colour | **closed** — the light paper surfaces are ratified | *"Dark-mode first"*. §15.3. | **W** |
| P133 | composition and treatment | **none** | portrait in the left column, not overlapping a hero; and no glass treatment — `blurview`, `backdropFilter`, `expo-blur` and `glass` return **0** across `src/components/passport/` and `src/features/passport/`. Two of four, unchanged. | **W** |

**P13 is the ruling's own worked counter-example** (`docs/architecture/brand-palette-decision.md`
§4), and this pass re-read it rather than inheriting it. The reading holds: the failure is a
composition, the ruling approves a palette and not a layout, and **P13 must not close**. P133
is the same finding one section later, and the grouping of both under a colour decision in
§12.1/§12.4 is a category error that inflated the D-DESIGN estimate by 60 % before anybody
opened a file. That is the more useful finding here than either row move: **a count of rows
sharing a cause is not evidence about any of them, and this corpus keeps proving it.**

### 15.3 P128 half-closed, and the half that remains is not the one anyone expected

*"Dark-mode first with deep navy/black surfaces"* is two requirements in one sentence.

- **Surfaces — CLOSED.** The ruling ratifies the light paper identity by name and says
  *"retain the existing Passport and Wall colour identities"*. That identity is
  `travel-buddy-standalone/src/theme/passportTokens.ts:8#paper:        '#FFFFFF',` and
  `travel-buddy-standalone/src/theme/passportTokens.ts:11#ink:          '#1C1C1A',`. The ruling
  also removes the obvious objection — that the shared token set says `paper: '#FAF9F6'` and
  `ink: '#11110F'` instead — by ratifying **two** palettes and saying explicitly that the
  near-identical pairs *"are not errors to reconcile"*.
- **Theme — OPEN, and reserved by the ruling in terms.** *"This decision does not automatically
  resolve unrelated **theme** … criteria."* Re-measured here rather than assumed:
  `grep -rn useColorScheme` over `travel-buddy-standalone/src/theme/`,
  `src/components/passport/` and `src/features/passport/` returns **0**. `PP` is one frozen
  object with one value per role and no dark counterpart, consumed directly by 60+ call sites
  with no theme provider between them. The client's only two scheme readers are
  `travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts:117#const scheme = useColorScheme();`
  and the tab bar; neither is a Passport surface. So the Passport does not have a non-default
  dark mode — **it has no dark mode at all.**

**WHAT WOULD TURN P128 RED / what would close it.** Either a second `PP` token set selected by
the device scheme, the Passport surfaces reading it through a provider instead of importing
`PP` directly, and a test that renders a Passport surface under a dark scheme and asserts a
dark surface token — **or** a second owner ruling that a ratified light paper identity retires
the dark-mode-first clause outright. The second is cheaper, likelier, and **not this lane's to
take**; it is recorded in `docs/architecture/blocker-ledger.md` as `PASSPORT_DARK_MODE_FIRST`.
It would have been easy to read the surface ratification as covering the whole sentence and
close this row. The owner's condition is what stops that, and it is right to: a decision about
colour is not a decision about how many themes a product has.

### 15.4 P132: the row was wrong about the code, not only about the verdict

The row read *"there is no blue/teal availability accent in `passportTokens.ts` at all"*, and
§13.3 confirmed it by running `grep -ci teal` over that one file. **The grep was correct and the
conclusion did not follow.** The Passport's availability and shared-context screens do not
import `PP`; they import the shared token set —
`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:50#import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';`
and
`travel-buddy-standalone/src/features/passport/SharedContextScreen.tsx:43#import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';`
— where teal-ink lives: `travel-buddy-standalone/src/theme/tokens.ts:14#deep: '#0A3D4A', // teal-ink — destination accents`.

And it is carrying exactly the two roles §27 assigns it. The availability screen states the
mapping in its own header before applying it —
`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:24#(color.deep) carries availability / social context per §27`
— then paints the window label (`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:648#color: color.deep,`), the open-to-meet switch track
(`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:346#trackColor={{ true: color.deep, false: color.haze }}`) and the selected day and window
chips (`travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:677#backgroundColor: color.deep,`, `travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx:719#backgroundColor: color.deep,`) in it. The
"YOU TWO" summary device is a teal disc at
`travel-buddy-standalone/src/features/passport/SharedContextScreen.tsx:378#backgroundColor: color.deep,`,
and the traveler-state pill's `social` tone — what `traveling`, `exploring`, `at_event` and
`with_crew` all resolve to (`travel-buddy-standalone/src/lib/travelerState.ts:73#return 'social';`)
— is cyan-teal at
`travel-buddy-standalone/src/components/passport/TravelerStateChip.tsx:56#social:   { bg: '#EEF6FA', border: 'rgba(14,116,144,0.35)', text: '#155E75', dot: '#0E7490' },`.

**So what did the ruling actually do for this row?** Not make it true. It removed the one
objection that would otherwise have kept it open: *"teal is not in the Passport palette, so the
Passport is not using teal."* `docs/architecture/brand-palette-decision.md` §2 rules that there
are **two palettes and both are ratified**, and that *"anyone unifying them is making a new
design decision, not executing this one"*. A Passport screen drawing its availability accent
from the shared set is now a ratified arrangement rather than a loose end. Without that, closing
P132 would have been a lane deciding a palette question on its own. This is worth saying because
it is the only row in either census where the ruling's contribution is not the colour it named.

**The one colour that is NOT teal, named rather than omitted.** `open_to_plans` resolves to the
`positive` tone and renders green
(`travel-buddy-standalone/src/components/passport/TravelerStateChip.tsx:55#positive: { bg: '#F0FAF4', border: 'rgba(34,197,94,0.35)', text: '#166534', dot: '#22C55E' },`).
This is §27's own two clauses landing on one state: *"green for verification and positive trust
states"* and *"blue/teal for availability"* both describe an affirmative, opt-in posture, and
the implementation picked green. The ruling preserves *"semantic status colours"* in terms, so
this is ratified rather than excused — and P134 (colour is never the only indicator) is `C`
independently, with the chip pairing tone with a glyph and a label. **It does not reopen P132,
and here is what would:** an owner saying the availability role is teal-only, at which point one
tone entry changes. The legacy green `AvailabilityChip` is not evidence in either direction —
**no caller anywhere passes `availabilityChip`**, so
`travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:462#chipState={availabilityChip ?? null}`
is always `null` and the component renders nothing.

### 15.5 What these two `C` rows do NOT have, said plainly

**Neither P129 nor P132 is pinned by a test.** `census-wall.md` W166 is — its structural half is
enforced by `travel-buddy-standalone/src/features/wall/components/__tests__/WallDesignSystem.component.test.tsx:123#no Wall surface paints an accent background outside the named affordances`,
run green in this worktree — and the Passport has no equivalent. Renaming `PP.seal`, changing its
hex, or moving the availability screen off `color.deep` would turn both rows false and **nothing
in this repository would go red.** By LANE-RULES §5 that is the weakest form of a `C`: the
behaviour is built and reachable, but the failure mode is unguarded.

It is recorded rather than fixed because a token-pinning test is a new test file in the client
tree, and the ruling's *"do not rebuild working screens"* plus this lane's no-code scope put it
out of reach here. **CROSS-LANE REQUEST to the Passport client lane:** a `PassportDesignSystem`
component test in the shape of the Wall's — assert `PP.seal === '#D32F2F'` and that the seal
device consumes it, and that the availability and shared-context surfaces paint `color.deep` —
mutation-proven against both. Until then these two rows rest on a reading of the code at one
commit, which is what §12.5 measured a 1-in-15 rot rate against.

### 15.6 Headline — and why this document now states two numbers

| basis | figure | what it counts |
|---|---|---|
| **§2 rows as they stand** (the top headline block) | **154 / 13 / 1 / 1** | the `ebe72b34` measurement plus this pass's two moves. It does NOT include P75 and P126, which §13.1 moved to `C` on built work and which §2 was never updated to match. |
| **every row's latest statement** (the block below, and what `check:census-integrity` counts) | **157 / 10 / 1 / 1** | the same 169 requirements, taking the newest verdict wherever this document states it — so P75 and P126 count as `C`. |

**Quote the second.** The first is preserved only because §3's refusal to declare a
`head_commit` rests on it and because patching a headline row by row is how the layover census
came to sum to 299 against 296. **The three-row difference is a real defect in this document and
it is not this lane's to repair** — closing it means restating P75 and P126 in §2, which means
re-verifying two builds this lane did not make and did not open. It is the recensus §13.7 asks
for, and this section is one more reason to run it.

> **Passport, at `7d1f2d498` + six lanes' uncommitted changes (measured, NOT declared): 169
> requirements · 157 BUILT-AND-CORRECT · 10 BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY →
> CONSTRUCTED 167 / 169 = 98.8 % · CORRECT 157 / 169 = 92.9 %.** The palette ruling moved
> **1.2 points**, not the 3.0 §12.4 estimated. Of the 10 rows still open, **1 is the residue of
> this ruling** (P128's theme half, now `PASSPORT_DARK_MODE_FIRST` on the blocker ledger), 2 are
> layout that no palette decision reaches (P13, P133), 3 are `D-WORD` (P45, P50, P154), and the
> remaining 4 are P42's ranker hold, P61's vocabulary, P77's Memories views and P159's product
> definition. **Zero are blocked on engineering inside this census's paths.**

| BUILT-AND-CORRECT | **157** |
|---|---|
| BUILT-BUT-WRONG | **10** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

157 + 10 + 1 + 1 = 169.

---

## §16 — The twelve-row pass, 2026-09-14: one row moved, eleven did not, and one of the eleven had a blocker that was not real

*Worktree `/home/user/wt-wallpass` at `7c6255de7`. Scope was the twelve rows this
census does not grade `C`: P13, P42, P45, P50, P59, P61, P66, P77, P128, P133, P154,
P159. Every one was re-executed against THIS tree rather than inherited. Of the
twelve, **one moved, one had its stated blocker corrected, and ten stand where §14 and
§15 left them, for reasons this section states as an action and an owner rather than as
a description.*

### 16.1 What moved

| id | was | now | why |
|---|---|---|---|
| P45 | W | **C** | **Built.** The row's three clauses are domain-specific, confidence-aware and EXPLAINABLE. The first two were already server-side. The third was not, and the reason was worse than §13.2/§14 recorded: `trust.domains` — six domains, each carrying the word the server computed from the canonical categories, an `applicable` flag and a `basis` (`artifacts/api-server/src/services/passport/PassportProjectionService.ts:280#export function domainTrustBasis`) — **had zero client consumers**, and `deriveTrustView` rebuilt six rows from capability flags and printed the constant `In good standing` on every in-scope domain. So a domain the server MEASURED as "Building" or "New" was shown to a person as "In good standing": the client was not duplicating the server, it was **overriding a measured verdict with a flattering constant**, against this census's own §20 canonical-architecture rule and against the hook's own header. The server's rows are now adopted verbatim (`travel-buddy-standalone/src/features/passport/useTrustProjection.ts:253#function domainsFromServer`), and the basis is rendered BESIDE the word rather than only carried on the object — `travel-buddy-standalone/src/features/passport/TrustScreen.tsx:135#const note = row.basisNote;` prints *"Not yet measured — shown at the neutral starting point."* on a substituted standing and **nothing** on a measured one, which is what makes the two distinguishable to a reader instead of only to a consumer. The capability-derived rows survive as a fallback for a server older than TABLE 12, marked `client_derived` (`travel-buddy-standalone/src/features/passport/useTrustProjection.ts:294#basis: 'client_derived'`), and an EMPTY `domains` array is treated as absent (`travel-buddy-standalone/src/features/passport/useTrustProjection.ts:301#const serverDomains`) so a serialization fault cannot read as *"this person has no trust in any area"*. Pinned by `travel-buddy-standalone/src/features/passport/__tests__/TrustDomainsFromServer.component.test.tsx:130#"In good standing" is never printed over a measured verdict` — 12 cases in three blocks, watched RED at 9 of 12 before the build, GREEN at 12 of 12 after, and RED at 9 of 12 again when the fix was reverted with the test kept. |

**What P45 moving does NOT carry with it**, stated so this is not read as bigger than it
is: the neutral-50 default is unchanged, `presentationWord` is unchanged, and the band
that chooses the word is unchanged. **P50 stays `W`** and so does **P154**, which is P50
under a phase number. A word that is now honestly labelled as "not yet measured" is a
different thing from a word that has been recalibrated, and only the first was this
lane's to do.

### 16.2 The blocker that was not real — P159's second question is already answered in the code

§13.5 gave P159 two blockers: a one-paragraph product definition, and *"a second,
harder question the definition must answer: the graph is built from `memories` that are
published and not `only_me`, so a Passport reader inherits Memory's audience rules and
must not become a second route to a memory the memory surface would not show."*

**That sentence is wrong about the code, and the correction removes the harder question
entirely.** The experience-node feed is not "published and not `only_me`" — it is
`published` **AND** `visibility = 'public'`, filtered twice: once in the query
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:902#.eq("visibility", "public")`)
and again per row, belt-and-braces, against a client that might ignore a predicate
(`artifacts/api-server/src/compass/CompassGraphEngine.ts:660#row.state === "published" && row.visibility === "public"`).
Every `experience` node in the graph therefore came from a memory whose audience is
already the world. A Passport reader over those nodes **cannot** be a second route to a
memory the memory surface would not show, because there is no private memory in there to
route.

P159 **stays `W`** — one blocker of two remains, and it is the one §13.5 named first: a
product sentence saying what a "deeper Experience Graph" IS on a Passport, and which of
the four experience edges a traveller sees about whom. That is still an owner's
sentence, and shipping a guess is still the failure mode. What is no longer true is that
it is a privacy question. Re-measured at this tree: **0** files under
`src/services/passport/` or `src/routes/passport*.ts` reference the graph tables, so the
reader itself remains unbuilt and small.

### 16.3 What did not move, what would move it, and whose call it is

| id | re-executed at this tree | what would move it | owner | verdict |
|---|---|---|---|---|
| P13 | Unchanged: `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:357#<View style={s.spine}>` and `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx:671#leftCol:`. | A layout ruling. `docs/architecture/brand-palette-decision.md` is live and declines this in terms — *"the mockup approves the palette only — not a new layout."* Building the §3 composition against a ratified paper identity would be a guess, not a fix. | **Owner / design** | W |
| P42 | Unchanged: Discovery's people path is an alphabetical name match, and its content ranker is on the hold at `docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`. | Lifting that hold. Nothing in this census's paths is involved; Compass is already two of two. | **Owner** (the Discovery hold) | W |
| P50 | Unchanged: `artifacts/api-server/src/services/passport/PassportProjectionService.ts:2346#export function passportTrustConfidence`. §16.1 did not touch it and deliberately so. | Recalibrating the band against migration 2371's `evidence_weight` / `evidence_count`. `confidence === "low"` is what selects the non-stigmatizing copy (`artifacts/api-server/src/services/passport/PassportProjectionService.ts:1266#"New Traveler · Verified"`), so this changes the word a person is shown. `D-WORD`. | **Owner / product** | W |
| P59 | Re-executed with counting greps: `canProvideVisaBuddyService`, `VisaBuddy` and `visa_buddy` return **0** across both trees outside the guard test itself, and `buildOwnerCapabilities` still returns six keys. | A product decision that a seventh capability should exist and gate something. Today it would gate nothing and be read by nothing. `VISA_BUDDY_CAPABILITY` on the blocker ledger. | **Owner / product** | N |
| P61 | Re-executed: `2309_passport_stamp_type_vocabulary.sql` still contains **no** `'place'` label; `place_contributor` is seeded 8× by `0198_place_contributor_stamps.sql`. Ten of eleven. | A **migration** adding the `place` CHECK label, plus a product rule for what earns one. **This lane was instructed not to write a migration and did not.** | **Owner** (label) + **product** (rule); then a migration lane | W |
| P66 | Re-executed: the perforated half holds (`travel-buddy-standalone/src/components/PassportStamps.tsx:104#borderStyle: 'dashed',`), and the three repo-root PNGs are still referenced by **nothing but this census**. | A designer's sign-off against a rendered screen of the shipped stamp surfaces, recorded here with a date. Noted for whoever runs it: the tree DOES ship rarity affordances the earlier passes did not credit — `travel-buddy-standalone/src/components/StampDetailArtwork.tsx:158#rarityBadge` plus sawtooth/wave frames and a legendary glow ring — so the question put to the designer is "is this premium enough", not "is there any premium treatment". | **Owner / design** | ? |
| P77 | Re-executed: `travel-buddy-standalone/src/components/MemoriesTab.tsx:769#const MEMORY_VIEW_TABS` (**superseded 2026-09-14 — see §17.6; the two-tab catalogue this cited is gone, the verdict is not**) still offers exactly two tabs. One of five. | Four views. People is blocked on memory-participant visibility under `artifacts/api-server/src/services/memory/**` — another lane's tree. Trips / Places / Map are buildable client work, but they reach at most four of five, so the row cannot close without the People blocker lifting first. | **Highlights/Memories lane** first, then a client lane | W |
| P128 | Re-executed: `useColorScheme` returns **0** across `travel-buddy-standalone/src/theme/`, `src/components/passport/` and `src/features/passport/`. The Passport has no dark mode at all, not a non-default one. | A ruling on whether *"dark-mode first"* is stale in the same way its *"deep navy/black surfaces"* half was. Building a dark theme today would contradict the palette decision's own ratified light paper identity. `PASSPORT_DARK_MODE_FIRST` on the blocker ledger. | **Owner** | W |
| P133 | Re-executed: `blurview`, `backdropFilter` and `expo-blur` return **0** across both passport directories; the portrait is still in `:671#leftCol:`. Two of four. | The same layout ruling P13 needs, plus a decision on whether "restrained glass" survives the paper metaphor at all. | **Owner / design** | W |
| P154 | Confirmed: it is P45 and P50 under a phase number. **P45 moved and P154 did not**, because P154's own text names the fabricated central NUMBER, which is P50. | P50 moving. | **Owner / product** | W |
| P159 | See §16.2 — one of its two blockers was not real; the other is. **0** graph readers under the Passport paths. | One paragraph from the owner defining the surface. Everything after that sentence is small and lies entirely inside this census's paths. | **Owner / product** for the definition, then this lane | W |

**Read the owner column, not the verdict column.** Ten of the eleven unmoved rows are
waiting on a person to decide something — a word, a layout, a theme, a vocabulary label,
a product sentence. **One** (P77) is waiting on another lane's engineering. **Zero are
waiting on engineering inside this census's paths**, which was already §15's finding and
survives a second re-execution.

### 16.4 Citations repaired, verdicts untouched

Seven citations in this file landed on nothing (`check:citation-targets`). Each was
repointed by reading the claim and finding the line that carries it. **No verdict
moved**, and none of the seven is on a row this pass regraded:

| row | was | now |
|---|---|---|
| P20 | `PassportConsumerProjections.ts` line 825 | `artifacts/api-server/src/services/passport/PassportConsumerProjections.ts:892#buildConsumerProjection` |
| P52 | `resolveAppeal.ts` line 73 | `artifacts/api-server/src/services/appeals/resolveAppeal.ts:271#.from("trust_events")` |
| P70 | lines 201 / 212 of `StampDetailModal.tsx` | `travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx:225#stamp-open-journey` / `travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx:236#stamp-open-my-world` |
| P83 | `PlansScreen.tsx` line 146 | `travel-buddy-standalone/src/features/passport/PlansScreen.tsx:169#Connect for {overlap.city}` |
| P143 | `passportProjection.ts` line 556 | `travel-buddy-standalone/src/services/passportProjection.ts:599#DENIED_VIEWER_ACTIONS` |
| P165 | `PassportProjectionService.ts` line 226 | `artifacts/api-server/src/services/passport/PassportProjectionService.ts:231#"Not a Trust leaderboard"` |
| P50 | line 1199 | `artifacts/api-server/src/services/passport/PassportProjectionService.ts:1266#"New Traveler · Verified"` |

**One finding fell out of a repair and is recorded rather than acted on.** P52's verdict
is `C` on *"`trust_events` is an append-only ledger with writers at …"*. The
`resolveAppeal` call site the row cites is an **UPDATE** — it sets an existing event's
`status` to `dismissed` — not an append. That does not falsify P52 (the ledger exists and
`TrustScoreService` still recomputes from it), but *"append-only"* is the wrong word for
a table with an in-place status mutation, and whether the row should say "ledger with a
soft-dismiss column" is a grading question this pass did not have standing to settle.
**Flagged for the recensus §13.7 asks for.**

### 16.5 Headline — restated from the rows

> **Passport, at `7c6255de7` (worktree): 169 requirements · 158 BUILT-AND-CORRECT · 9
> BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 167 / 169 = 98.8 % ·
> CORRECT 158 / 169 = 93.5 %.** P45 moved on a build, not on a re-reading. The eleven
> that remain are, by owner: **ten waiting on a person's decision** (P13, P42, P50, P59,
> P61, P66, P128, P133, P154, P159) and **one waiting on another lane** (P77).

| BUILT-AND-CORRECT | **158** |
|---|---|
| BUILT-BUT-WRONG | **9** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

158 + 9 + 1 + 1 = 169.

**This census is NOT 100 %, is not close to it on the rows that remain, and none of it is
deployed.** The Passport code in this worktree is on a detached head that has not been
merged; merged would not be deployed either. Nothing in §16 describes running software.

## §17 — The Passport UI pass, 2026-09-14: four views built, ZERO verdicts moved, and a rejected requirement pinned so it cannot be resurrected

This section records a build pass in which **no verdict changed**. That is the
result, not a failure to reach one: of the five rows the pass opened, three are
held by a ratified owner decision that says in terms not to build what they ask
for, one is held by another lane's data model, and one is held by a designer's
judgement that engineering cannot supply. Code was written for all five anyway —
what could be built inside the decisions was built, and what could not was
PINNED so that the next sweep reads a reason rather than an absence.

### 17.1 The five rows

| id | before | after | why it did not move |
|---|---|---|---|
| P13 | W | **W** | Owner ruling. `docs/architecture/brand-palette-decision.md:131` rules on this row BY NAME — *"stays W"*, change *"none"* — as §4's own worked counter-example. |
| P128 | W | **W** | Owner ruling, same artifact, line 129: *"deep navy/black surfaces … the light paper identity is ratified"*. On the blocker ledger as `PASSPORT_DARK_MODE_FIRST`. |
| P133 | W | **W** at two of four clauses. The portrait-over-hero rebuild is ruled out by the same artifact (line 130, *"it was never a colour row"*); whether restrained glass survives the paper metaphor is genuinely UNDECIDED and was left undecided. |
| P77 | W | **W** | Four of §15's five views now exist. The fifth, People, needs a participant field `PassportMemory` does not have. Four of five does not close a row that names five. |
| P66 | X | **X** | Render evidence was produced. The designer's question is *"is this premium ENOUGH"*, not *"is there any premium treatment"*, and that is not an engineering verdict. |

### 17.2 The chronology, because a superseded requirement must prove its authority

`census-passport.md` was first committed **2026-09-09** (`42aeac38e`).
`docs/architecture/brand-palette-decision.md` was ratified **2026-09-14
09:28:13** (`5b60439b1`) — **five days later**, and it rules on P13, P128, P132,
P129 and P133 individually rather than as a class. The later artifact therefore
supersedes the earlier prose for those rows, and the ruling's own sentence bounds
how far: *"The mockup approves the palette only — not a new layout. Build upon
existing components and shared tokens; do not rebuild working screens."*

**The superseded behaviour was NOT implemented.** No Passport dark mode was
added; `useColorScheme` was not introduced; the portrait was not moved over the
hero; no theme token changed. Those are the three things the ruling forbids and
none of them is in this pass's diff.

**They also did NOT become `C`.** A requirement removed from scope is not a
requirement that was met, and `W` — built, and not what the spec's prose asked
for — remains the truthful cell for a screen that exists and deliberately
differs from an older description of it.

### 17.3 The census-schema defect this exposes, restated here rather than worked around

`type Verdict = "C" | "W" | "N" | "X"`
(`artifacts/api-server/src/scripts/checkCensusIntegrity.ts:119#type Verdict`)
has **no terminal state for a requirement intentionally removed from scope**. A
row written `SUPERSEDED` parses to nothing and drops out of the denominator,
which is worse than any of the four wrong answers. So these three rows sit at
`W` with the ruling cited beside them, and the missing fifth verdict is recorded
as a SCHEMA DEFECT — in `docs/architecture/reconciled-baseline-v1.md` §11 and
again here — rather than papered over by abusing `C`, `N` or `X`.

### 17.4 The guard, so a future sweep cannot silently resurrect the rejected work

`travel-buddy-standalone/src/components/passport/__tests__/PassportRatifiedIdentity.decision.component.test.ts`
is a DECISION test, not a behaviour test: every assertion's failure message names
the artifact, the commit `5b60439b1` and the date, so an agent that trips it
reads *why the thing it was about to add was rejected* instead of a bare
red. It also discharges §15.5's cross-lane request — P129 (seal red) and P132
(teal-ink availability) were closed `C` on the ruling and were pinned by NO test
until now.

Deliberately NOT guarded: P133's *"restrained glass"*. Freezing an open question
would be this pass quietly deciding it. `expo-blur` is already a dependency, so
a grep-satisfying import was available and was not taken.

### 17.5 P77 — what was built, and the exact shape of the fifth

Built: **Trips** (keyed by `tripId`, titled from `TripRow.title`), **Places**
(city + country, NFC-normalised on the same key convention as
`travel-buddy-standalone/src/utils/destinationGrouping.ts`), and **Map** (real
MapLibre pins, one per city, trip destination coordinate preferred and
`cityCentroids` as fallback). **Timeline** already existed. Leftover buckets are
RENDERED rather than dropped, and the Map states the count it cannot plot.

**People's dependency, precisely:** `PassportMemory`
(`travel-buddy-standalone/src/services/passportStamps.ts:51#export interface PassportMemory`)
carries no participant field, and the memory-participant visibility contract
belongs to the Highlights/Memories lane under
`artifacts/api-server/src/services/memory/`. The component test **asserts
People's ABSENCE**, so the gap stays visible in a green suite instead of being
inferrable only from a missing tab.

### 17.6 Evidence corrected: the "exactly two tabs" citation, four times over

Four rows in §12.7, §13.5, §14.2 and §16 cite
MemoriesTab.tsx line 917, anchored on the two-entry array literal for the
statement *"still offers exactly two tabs"*. **That statement was true when each
was written and is false now**, and the cited TEXT no longer exists — this is a
re-read, not a repoint. The catalogue is now
`travel-buddy-standalone/src/components/MemoriesTab.tsx:769#const MEMORY_VIEW_TABS`
and holds five entries: `all`, `trips`, `places`, `timeline`, `map`. Each of the
four rows is marked in place with the date and this section, and none of their
verdicts changes: P77 was `W` for the People blocker, and still is.

### 17.7 A pre-existing failure that had stopped EVERY test in the standalone package

`scripts/check-test-mocks.mjs` runs first in **both** `pnpm test` and
`pnpm test:component`, and was failing at clean `HEAD` on three bare
object-literal `jest.mock` factories in
`travel-buddy-standalone/src/features/passport/__tests__/TrustDomainsFromServer.component.test.tsx`.
**No test ran, for any lane, in that package** — confirmed by stashing and
re-running at `HEAD`, and confirmed independently by CI, which reported exactly
these three findings on `a6bb9e3bf` and failed the `standalone · check:all` job
for both of its halves.

Fixed with the guard's own documented escape hatch, written **into the blank
line above each mock so the file's line count is unchanged** — a first attempt
added nine lines and broke the anchor at `census-passport.md:1406`.

### 17.8 Headline — unchanged, and that is the point

> **Passport, at `a2dd0837d`: 169 requirements · 158 BUILT-AND-CORRECT · 9
> BUILT-BUT-WRONG · 1 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 167 / 169 =
> 98.8 % · CORRECT 158 / 169 = 93.5 %.** Identical to §16.5. Three commits, four
> new test files, 30 new tests and a decision guard moved **no** verdict, because
> every row they touched is held by a person and not by a keyboard.

| BUILT-AND-CORRECT | **158** |
|---|---|
| BUILT-BUT-WRONG | **9** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

158 + 9 + 1 + 1 = 169.

**Screenshots were SPECIFIED, not rendered.** No image was produced by this
pass: there is no playwright, puppeteer or chromium in `node_modules` or on
`PATH`. The fixture header carries the exact capture commands. A device
requirement is not discharged from code, and this section does not claim it.

**None of this is deployed.** Three commits on a branch; merged would not be
deployed either.

---

## §18 — Measurability, 2026-09-15: a `head_commit` and a scope, and ZERO verdicts re-graded

This section does one thing: it makes this document the thirteenth census that
`check:census-freshness` can age. It moves **no** verdict, re-reads **no**
requirement row, and changes **no** headline number. §17.8's counts stand
verbatim, re-read from `check:census-integrity` rather than from this document's
prose: **169 rows · 158 C · 9 W · 1 N · 1 X**.

### 18.1 The declaration

| Field | Value |
| --- | --- |
| `head_commit` | `1fe72289b` — **FIRST DECLARATION, 2026-09-15.** It **starts a clock; it does not certify a past.** `1fe72289b` is the squash merge of PR #482, and it is the commit at which THIS DOCUMENT'S CONTENT — §15, §16 and §17 included — reached the default branch: `git log --follow -- docs/architecture/census-passport.md` lists exactly three commits on HEAD's line of history (`42aeac38e`, `014a25d56`, `1fe72289b`) and none since. **Ancestry proved, not assumed:** `git merge-base --is-ancestor 1fe72289b HEAD` exits 0 at HEAD `fd7ce4b80`. Every commit this census was actually MEASURED at is a pre-squash orphan and could not have been declared — `ebe72b34`, `3ca68cb06`, `cd400d2ff`, `a23502bc5` and `a2dd0837d` all resolve in this clone and **not one is an ancestor of HEAD**, which is the failure mode `checkCensusFreshness.ts` refuses by name. Read §18.4 before quoting this row: it says what the declaration does not certify. |

### 18.2 What the checker actually requires, read out of the code

Derived from `artifacts/api-server/src/scripts/checkCensusFreshness.ts` and
`artifacts/api-server/src/scripts/lib/censusHeadCommit.ts`, not from any prose
about them. A census is CHECKABLE only when **both** of these hold:

1. **A `head_commit` TABLE ROW, not a mention.** The parser is two regexes. The
   declaration is `head_commit` followed by a pipe and then, immediately, an
   optionally-backticked hash of 7–40 hex characters; prose may follow the hash
   but nothing may sit between the pipe and it. A line that opens a table cell
   with `head_commit` and yields no hash is reported MALFORMED and FAILS the
   run — a state added after a bolded hash made a real declaration invisible and
   the run passed. Four earlier sections of this document discuss `head_commit`
   in prose; none of them is a declaration, because none is a table row. §18.1
   is, and it is the only one, so the ledger's own `since`-matching regex reads
   it unambiguously.
2. **An entry in `CENSUS_SCOPE`**, the hand-written table at the head of
   `checkCensusFreshness.ts`, mapping this filename to the repo paths the census
   is a measurement OF. A census with a commit and no scope is printed as
   `declares … but has no scope in CENSUS_SCOPE — CANNOT BE CHECKED` and is
   counted in the same "NOT passes" note as one with no commit at all. Every
   path in an entry must EXIST: a pathspec matching nothing gives git an empty
   diff, so a typo reports FRESH while watching nothing.

Then three gates run in order, and each is a failure rather than a warning: the
commit must resolve in this clone; it must be an ancestor of HEAD; and the union
of `commit..HEAD`, `--cached` and working-tree diffs restricted to the scope must
be empty, or else covered file-by-file by an entry in
`CENSUS_STALENESS_ACKNOWLEDGED.json` whose `since` equals the declared commit and
whose `files` array NAMES each changed path. An entry with no `files` covers
nothing; a reason under 80 characters is rejected.

### 18.3 The scope, and how it was derived

The entry added to `CENSUS_SCOPE` lists **119** paths. It was not composed by
judgement. It is the set of repo files THIS DOCUMENT CITES, extracted with
`checkCensusScopeCoverage.ts`'s own citation regex and resolved with its own
resolution rule, minus the machinery that checker's `NOT_GRADED` list excludes —
this census names `checkCensusFreshness.ts`, `checkWriterlessReads.ts` and
`package.json` as things that MEASURED it, and scoping a guard would age this
document on every unrelated lane's guard work. Two deliberate additions sit on
top of the mechanical set and are stated in the entry itself: six citations whose
BASENAME matches two files (this tree carries staging copies under `files/`,
`follows-backend/` and `portava-stamp-wave3-files/`) resolved by hand to the live
path, because a Passport census that does not watch `artifacts/api-server/src/routes/passport.ts`
is §12.5's hole in miniature; and the two standalone stamp components §16
re-cites for P66, alongside the repo-root pair the P66 row cites directly.

`check:census-scope-coverage` had no floor for this census, because a census with
no scope is not floored there at all. One is added at **97 %**, two points below
the measured **99 %** (113 of 114 cited files watched), which is that file's
stated ratchet convention — a floor may be raised and never lowered. The single
unwatched citation is machinery and is named in §18.6.

### 18.4 What this does NOT certify, stated before anyone quotes a green check

**It does not certify that any of the 169 verdicts is right, or that any was
re-read at `1fe72289b`.** None was. §3, §12.5, §13.7 and §14 each refused to
declare on the argument that declaring would "report FRESH about rows nobody
re-read". That argument is answered, not waived, and the answer is mechanical:
FRESH in this checker means *no counted file has changed since the declared
commit*, and the script's own closing note says it does not cover "whether a
census's verdicts are RIGHT; this checks age, not accuracy". CANNOT BE CHECKED is
strictly weaker — it gives no clock at all, so a change to `PassportProjectionService.ts`
was, until this commit, as silent as no change. §13.7 wrote down what would make
declaring right and named two halves: a recensus, **and** a `CENSUS_SCOPE` entry
"added in the same change so the declaration is checkable the moment it is made".
This commit does the second half only. **The recensus is still owed.**

**And one gap is bigger than that sentence implies, so it is named.** The last
measurement in this document is §17's, taken at `a2dd0837d`. `a2dd0837d` is not
an ancestor of `1fe72289b` — the squash makes them two trees, not two points on a
line — and over this census's 119-path scope those two trees differ in **twelve
files**: `CompassTools.ts`, `discoveryModifiers.ts`, `discoveryPde.ts`,
`routes/airport.ts`, `routes/discovery.ts`, `routes/discoverySearch.ts`,
`routes/mapProjection.ts`, `routes/telegraph.ts`, `LayoverSafetyEngine.ts`,
`PassportMapService.ts`, `SharedContextService.ts` and `passportProjection.test.ts`
(1,661 insertions, 297 deletions, `git diff --stat a2dd0837d 1fe72289b`). **None
of the twelve was re-read by this pass**, and the declaration does not claim
otherwise: it says when the DOCUMENT landed, not when its rows were last
executed. That gap existed before this section and was invisible; it is now
written down. It is the first thing the owed recensus should take.

### 18.5 The three counted files that changed since `1fe72289b`, argued one at a time

These are acknowledged in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`,
which is where the checker reads them. The argument is reproduced here because a
ledger entry is easy to write and hard to find.

| file | what changed | why it cannot have moved a verdict |
|---|---|---|
| `artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts` | **One comment line**, +1/−1: a header note changed from "(migration 2721, NOT applied)" to "(migration 2721, applied to production 2026-09-15)". No executable line moved. | This census cites the file once, in §13.5, as the in-flight lane that would have to supply participants before P77's People view could exist. P77's blocker is not in this file at all: it is that `PassportMemory` in `travel-buddy-standalone/src/services/passportStamps.ts` carries no participant field, and that file is byte-identical since `1fe72289b`. A comment cannot add a field. |
| `artifacts/api-server/src/lib/discoveryPde.ts` | +218/−15: DV-54, the neighbourhood geography key, plus per-read failure reporting (`degraded`) on the viewer loads. | This census cites the file in exactly one place, **P42's remedy column**, which states the closure condition: the owner lifting the ranker hold at `docs/discovery/ROADMAP.md:222#RANKER WORK GOES ON EXPLICIT HOLD`, **and** an explicit-intent term landing in `discoveryPde.ts` / `discoveryModifiers.ts` weighted above the generic interest term. Checked at HEAD: `explicitIntent`, `genericInterest` and `readVisibleExplicitIntent` occur **zero** times in either file; `discoveryModifiers.ts` is byte-identical since `1fe72289b`; and ROADMAP line 222 still reads the hold verbatim. A neighbourhood key is not an intent term and a diff is not an owner ruling, so neither limb of P42's condition is met and the row cannot have moved. |
| `artifacts/api-server/src/routes/discovery.ts` | +70/−29 in two regions: DV-54 neighbourhood threading (lines 1113–1308) and the D11 `failedSources` report for the canonical source (line 3794 onward). | The census cites this file once, in the Headline block, for the claim that Discovery still builds identity payloads from `profiles`. That claim's verdict row is **P169**, closed `C` in §12 on `discoverySearch.ts` and `compass.ts` — neither of which is this file. The claim's own subject is untouched: `buildConsumerProjection` has **zero** references in this file at both `1fe72289b` and HEAD, `from("profiles")` likewise zero at both, and the diff contains no line matching `profiles`, `ConsumerProjection`, `identity`, `avatar` or `display_name`. The `profiles:submitted_by!left` embed and the `row.profiles` unwrap that the prose is actually about sit at lines 2974 and 3068, outside both changed regions; every hunk below line 3794 is a same-size replacement, so those lines did not even shift. |

### 18.6 Findings recorded here and deliberately NOT acted on

Not a single verdict was re-graded, per the rule this pass was run under. Three
things were seen while deriving the scope and are left for a later pass:

1. **The Headline's `routes/discovery.ts` citation — the one naming lines 1504
   and 2523 — does not point at what the sentence says.** Line 1504 is a comment about opening hours and 2523
   is a lone `}`, at `1fe72289b` and at HEAD alike — the lines are byte-identical
   across the change, so this is not rot introduced by DV-54. The identity build
   the sentence describes is real and lives at lines 2974 and 3068 of that file.
   **Not repointed here**, because the Headline block is a dated `ebe72b34`
   measurement that §12 has already superseded for this claim, and repointing a
   superseded sentence is an edit to an earlier row.
2. **Two citations name no file in the tree**: `trustProjection.ts` and
   `passportPrivacy.ts`. They are unresolvable rather than wrong — no basename
   matches — so nothing can be watched for them and nothing was guessed.
3. **Two machinery files are counted as graded code by
   `check:census-scope-coverage`, because its `NOT_GRADED` pattern cannot reach
   them.** `artifacts/api-server/src/scripts/lib/censusHeadCommit.ts` is the
   `head_commit` parser §18.2 reads — half of `checkCensusFreshness.ts`, split
   into its own file — and the pattern only matches `src/scripts/*.ts`, not
   `src/scripts/lib/*.ts`. `travel-buddy-standalone/scripts/check-test-mocks.mjs`
   is the standalone package's test-mock guard, cited once in §17.7 as the thing
   that was failing, and it lives outside `artifacts/api-server/` entirely. Both
   are machinery this census NAMES as what measured it, and neither is product
   code any census grades. **Both are left OUT of this scope on the machinery
   rule** rather than watched — scoping a guard would age this census on every
   unrelated lane's guard work — and the coverage ratio below wears the cost:
   113 of 114, with the parser reported as the one unwatched citation. The right
   fix is two entries in `NOT_GRADED`, which is a global list affecting all
   thirteen censuses and can only RAISE a ratio; it is not made here because this
   pass is scoped to one census and a global edit should be argued on its own.

### 18.7 Headline — unchanged, and that is the point

Read from `check:census-integrity` at HEAD `fd7ce4b80`, never hand-counted:

> **Passport: 169 requirements · 158 BUILT-AND-CORRECT · 9 BUILT-BUT-WRONG ·
> 1 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 167 / 169 = 98.8 % · CORRECT
> 158 / 169 = 93.5 %.** Identical to §17.8 and to §16.5. This pass wrote no
> product code and moved no row; what it changed is that from `1fe72289b`
> forward, a change to any of 119 files this document grades is either
> re-measured or argued in writing, instead of being invisible.

| BUILT-AND-CORRECT | **158** |
|---|---|
| BUILT-BUT-WRONG | **9** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |

158 + 9 + 1 + 1 = 169.
