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
| BUILT-AND-CORRECT | **152** |
| BUILT-BUT-WRONG | **15** |
| NOT-BUILT | **1** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (correct+wrong)/denominator | **167 / 169 = 98.8%** |
| **CORRECT%** = correct/denominator | **152 / 169 = 89.9%** |
| CANNOT-VERIFY share | **1 / 169 = 0.6%** |

Counted from the rows: 152 + 15 + 1 + 1 = 169. Previously 145 / 21 / 2 / 1.

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
   (`PassportProjectionService.ts:958,965`), and `presentationWord(50)` returns
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
   `routes/discoverySearch.ts:420,462,1324`), which is the precise duplication the
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
| P1 | One projection combining identity, travel history, state, availability, intent, trust, credentials, reputation, social context, experience history, plans, privacy, viewer relationship and action eligibility | C | `services/passport/PassportProjectionService.ts:1459` `buildPassportProjection` assembles exactly that set in twelve numbered steps and returns one `PassportProjection` (`:1646-1665`). |

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
| P13 | Travel hero/cover with a circular profile photo overlapping the hero | **W** | A cover exists (`src/components/passport/PassportIdentityCard.tsx:47` `coverUploading`, `:426` change-cover control) and the avatar is circular (`:653` `avatar.s34` with a gold ring), but the composition is a **cream document card with a vertical spine and a left-column avatar** (`:3`, `:391-412`), not a portrait overlapping a hero image. Coherent with the paper metaphor; a literal divergence from §3. Same family as §27. |
| P14 | Name, @handle, verification mark, home country and optional home base immediately visible | C | `PassportProjectionService.buildIdentity:683-696` returns all five, each behind its own gate (`:679-681`); rendered by `PassportIdentityCard`. |
| P15 | Current travel state and Availability/Open to Plans near the top, not buried | C | `src/components/passport/TravelerStateChip.tsx` and `AvailabilityChip.tsx` render in the identity band; server side `buildTravelerState:717` and `buildAvailability:862`. |
| P16 | Trust summary as a concise score/label with drill-down | C | `buildTrust:975` returns label + publicLevel + confidence + domains, numeric score only for self (`:1010-1017`); drill-down via `TrustScoreInfoSheet` and `/passport/trust`. |
| P17 | Travel stats: countries, cities, stamps, Trips | C | `PassportProjectionService.ts:1533-1538` `TravelStats`; `PassportStatsRow` in `PassportIdentityCard`. |
| P18 | Viewer actions Follow / Make a Plan / Message / More; owner actions Edit Passport / Set Availability / My World / Share Passport | C | Viewer: `PassportHomePreviews.tsx:239-249` renders "Make a Plan" gated on `capabilities.actions.can_make_plan`; Follow/Message on the public passport. Owner: `PassportQuickLinks.tsx:57-100` (My World, Trust, Travel Identity, Journeys, Yearbook, Plans, Availability) plus a Share entry delegated to the parent. |
| P19 | High-priority previews: Shared Context, recent stamps, Featured Journey, next Trip, memories | C | `PassportHomePreviews.tsx` — `passport-shared-context-entry` (`:258`), `passport-preview-stamps` (`:280`), `passport-preview-featured-journey` (`:111`), `passport-preview-next-trip` (`:136`), `passport-preview-memories` (`:308`). All five. **This closes the certification's §3 "previews not surfaced" gap.** |

### §4 Viewer Context and Server-Side Projection

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P20 | One projection system with context-specific views; no separate profile systems | C | `buildPassportProjection` is the single assembler; `services/passport/PassportConsumerProjections.ts:818` `buildConsumerProjection` derives every consumer variant *from it* rather than re-reading. (Adoption is incomplete — see §21.) |
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
| P42 | Compass and Discovery weight explicit current intent above generic interests | **W** | The projection exposes the distinction (`PassportConsumerProjections.readVisibleExplicitIntent:445`, and the module header documents a bounded `genericInterestWeight` for Compass), but **nothing consumes it**: `buildConsumerProjection` is called only from `routes/rentABuddy.ts:1241`, `routes/trips.ts:467` and `EventPassportService.ts:423`. Neither Compass nor Discovery reads the discovery-card variant — `routes/discovery.ts:1504,2523` and `routes/discoverySearch.ts:420,462,1324` still read `profiles` directly. The weighting exists on the supply side and is not applied on the demand side. |

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
| P50 | Trust confidence matters — an 82 with high evidence is not equivalent to an 82 with little evidence | **W** | The band itself is still travel-derived: `confidence` is computed from `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)` (`buildTrust:1127-1128`) — travel volume, not trust evidence — and it is deliberately **unchanged**, because recalibrating the word a person is labelled with is a product judgement, not a defect fix (`passportProjection.test.ts:302-304` pins "Neutral 50 everywhere reads 'Established' — non-stigmatizing (§10)"). What IS closed is the spec's own hypothetical: migration 2371's `evidence_weight` / `evidence_count`, written by `measureEvidence` (`TrustScoreService.ts:388`) and shaped on every read (`:580`), had NO consumer outside their own writer and its tests before this; they now reach the projection (`PassportProjectionService.ts:1150-1151`) beside `confidenceBasis` (`PassportProjectionService.ts:1152`). Two users showing the same 82 are now distinguishable — one reports `trust_evidence` with its weight and count, the other `travel_proxy` with nulls — which is exactly "same number, different evidence, different meaning". Stays **W** until the band itself is recalibrated against those columns; that is an owner call on labelling, and the basis field makes it a deliberate diff rather than a side effect. |
| P51 | Non-stigmatizing copy for low-evidence accounts | C | `buildTrust:998-1000` and `:1004-1006` — `"New Traveler · Verified"` / `"New Traveler"` when confidence is low; `presentationWord:930-936` deliberately avoids "low/poor/weak". |
| P52 | Trust changes must be internally replayable from evidence/events | C | `trust_events` is an append-only ledger with writers at `TrustEventService.ts:105,217,275`, `TrustAdminService.ts:53-174` and `services/appeals/resolveAppeal.ts:73`; `TrustScoreService` recomputes `trust_profiles` from it. |

### §11 Trust Capabilities

| id | Capability | V | Evidence |
| --- | --- | --- | --- |
| P53 | canJoinPublicTrip | C | `buildOwnerCapabilities:573`. |
| P54 | canHostTrip | C | `:574`. |
| P55 | canCreateLargePlan | C | `:575`. |
| P56 | canUseCrewLocation | C | `:576`. |
| P57 | canContributeLiveIntel | C | `:577`. |
| P58 | canBecomeBuddy | C | `:578`. |
| P59 | **canProvideVisaBuddyService** | **N** | A repo-wide search across the server and client trees for `canProvideVisaBuddyService`, `VisaBuddy` and `visa_buddy` returns **nothing**. The capability named by §11 does not exist in any form. **Classified OWNER 2026-09-08 — `VISA_BUDDY_CAPABILITY` on the blocker ledger.** The other six §11 capabilities are derived at `services/passport/PassportProjectionService.ts:683#buildOwnerCapabilities` and each gates something that exists; a seventh would gate nothing and be read by nothing. More to the point, the tree's only current posture on visas is the OPPOSITE one — the three places the word appears are Layover disclaimers (`services/airport/LayoverSafetyEngine.ts:585`, `:619`, `:628`) whose comment states entry is never confirmed on this tree. Choosing a trust threshold for "may provide visa assistance" would invent immigration-advice policy in a formula. Stays **N**: it is a real gap against the spec, and it is not one engineering may close. |
| P60 | Authorization is server-side; the client must not infer authorization from a displayed score | C | Capabilities and per-viewer actions are booleans computed in `buildOwnerCapabilities`/`buildViewerActions`; the client renders the flags (`src/features/passport/usePassportPlans.ts:210` `canMakePlan: proj.actions.can_make_plan`). A grep for client-side trust-threshold policy (`trust > N`) in the passport tree returns nothing. |

### §12 Stamps and Provenance

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P61 | The eleven stamp types: Country, City, Place, Event, Experience, Hidden Gem, Trip, Contributor, Buddy, Milestone, Special | **W** | Migration `2309_passport_stamp_type_vocabulary.sql:118-133` widens the vocabulary to verification, destination, event, trip, achievement, host, rent_a_buddy, city, neighborhood, plan, hidden_gem, safe_return, activity, trip_crew, compass_ai, qr_checkin. That covers Country (`destination`), City, Event, Experience (`activity`), Hidden Gem, Trip, Buddy (`rent_a_buddy`), Milestone (`achievement`, plus the `stamp_milestones` writer at `StampAwardEngine.ts:549-559`) and Special (`stamp_campaigns`, `routes/adminStamps.ts:357`). **Two are missing**: there is no `place` label — a venue/landmark stamp can only ride on `city`/`neighborhood` — and there is **no Contributor stamp type at all** (contributions surface as a credential via `PassportReputationService`, never as a stamp). Nine of eleven. |
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
| P70 | Stamp detail links to Journey and My World while respecting historical-location privacy | C | `StampDetailModal.tsx:13` imports `journeysHref` / `myWorldHref`; `:201` `stamp-open-journey`, `:212` `stamp-open-my-world`. Privacy holds because `PassportPrivacyGuard.guardStamp:154` strips `place_id` from a `hidden_gem` stamp and `PassportMapService.buildMapPayload` selects city/neighborhood only (`:44-47`). |

### §14 Journeys and Featured Journey

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P71 | Journeys are chronological projections of canonical Trip/travel records | C | `services/passport/PassportJourneyService.ts` reads canonical trips; route `GET /passport/:userId/journeys` (`routes/passport.ts:1554`). |
| P72 | Group by year, country/city and Trip | C | `PassportJourneyService.ts:308` grouping; consumed by `src/features/passport/JourneysScreen.tsx`. |
| P73 | Show permitted dates, places, memories, stamps, Shared Moments and people context | C | `PassportProjectionService.ts:1574-1583` `JourneyPermissions` threads `canSeeTrips`, `canSeeRestricted`, the per-memory `callerCtx` and `viewerId` for block-filtering the people context; date coarsening at `PassportJourneyService.ts:195`. |
| P74 | Allow one Featured Journey | C | `PassportJourneyService.ts:281` `buildFeaturedJourney`; surfaced at `PassportProjectionService.ts:1585`. |
| P75 | Featured Journey may include route, timeline, places, memories, stamps, people, events and recommendations | **W** | Route, timeline, places, memories, stamps and people are projected; **events and recommendations are not** — `PassportJourneyService` has no event join and no recommendation producer. Six of eight elements. |

### §15 Memories and Shared Memories

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P76 | Memories are travel-contextual, not a generic media grid | C | `PassportProjectionService.ts:1595-1604` projects city, country, category, tripId, earnedAt alongside the photo — never a bare media list. |
| P77 | Views: Trips, Places, People, Timeline and Map | **W** | `src/components/MemoriesTab.tsx:915-917` offers exactly two: **All** (grid) and **Timeline** (`groupMemoriesByTimeline`, `:26,780`). Trips, Places, People and Map views do not exist. Two of five. (The public-viewer emptiness the certification logged as F3 **is** fixed — `src/components/passport/PassportHomePreviews.tsx:332` `PassportViewerMemoriesList` and `:376` the plans list replace the hardcoded `memories={[]}` / `trips={[]}`.) |
| P78 | Retain permitted place, city, Trip, date, people, event and stamp context | C | The memory projection carries city/country/category/tripId/earnedAt; per-item gating via `filterMemories(raw, callerCtx)` (`:1594`) under the collection tier (`:1592`). |
| P79 | Shared history surfaces "You were here together" / "Our Da Nang Trip" when both viewers have rights | C | `SharedContextService.ts:191-205` reads accepted `shared_moment_memberships` for **both** parties and intersects, emitting `shared_moments` and `shared_trips` facts only on that intersection. |

### §16 Plans and Trip Overlap

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P80 | Represent future travel as well as past | C | `buildUpcomingPlans:1191` selects trips in `planning`/`upcoming`/`active`. |
| P81 | Upcoming Trips require per-plan visibility controls | C | `:1226-1236` — `show_on_profile === false` excludes; `visibility === "public"` admits; `buddies`/`invite` require a full-profile or crew/host relationship; anything else is excluded. Dates are additionally gated on `show_exact_dates` (`:1239`). |
| P82 | When viewing another Passport, compute Trip overlap ("You'll both be in Bangkok Sep 14–17") | C | `SharedContextService` emits the `both_going_to` fact (`:33`) from both parties' permitted plans. |
| P83 | Provide a "Connect for Bangkok" action when policy and eligibility permit | C | `SharedContextService.compassHandoff` (`:40-61`) carries `eligible` + the coarse shared city; `PlansScreen.tsx:146` renders the Connect affordance; `PassportHomePreviews.tsx:239-249` gates the primary "Make a Plan" on the server flag. |

### §17 Shared Context — ME ↔ THEM

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P84 | Calculated for the viewer relationship, not stored as a permanent match score | C | Computed per request inside `buildPassportProjection` step 11 (`:1621-1630`), never persisted; there is no shared-context table. |
| P85 | The possible facts: both in city, both free tonight, mutual follows, shared cities, interest overlap, both going to X, previous trip together, shared moments | C | `SharedContextService.ts:25-33` — all eight fact keys, each emitted from its own gated read (`:282`, `:291`, `:296-302`, `:311`, `:318-324`, `:191-205`). |
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
| P95 | **Discovery** | C | **Moved W→C 2026-09-08 from the call site.** The W said "nothing calls it" and named the three `buildConsumerProjection` sites that existed then. Discovery's person card now consumes the variant: `routes/discoverySearch.ts:2281#buildConsumerProjection`. The inline identity that remains is in the SEARCH LIST (`routes/discoverySearch.ts:650#subtitle`), a different endpoint and a different problem — a bulk list cannot pay the ~34-reads-per-target per-user path. That remainder is carried by **P169**, not double-counted here. |
| P96 | Trips | C | `PassportConsumerProjections.ts:229-240` `TripsProjection` (identity + `TripsTrustEligibility` + host/guest context, deliberately no stamps/memories/plans), consumed at `routes/trips.ts:467`. |
| P97 | Buddy | C | `:178-200` `BuddyProjection` (identity, verification, services, availability, reputation), consumed at `routes/rentABuddy.ts:1241`. |
| P98 | **Map** — aggregate or permission-appropriate presence only | C | **Moved N→C 2026-09-08.** The map now REQUESTS the Passport's map-presence projection instead of rebuilding identity: `services/passport/PassportConsumerProjections.ts:983#buildMapPresenceProjections`, consumed at `lib/mapTravelers.ts:285#buildMapPresenceProjections`. It carries identity ONLY — handle, displayName, avatarUrl, verified — and applies the two rules that govern them (the universal display-name gate and the `show_profile_picture_publicly` opt-out). **It is deliberately NOT a seventh `PassportConsumerVariant`** (`PassportConsumerProjections.ts:149#PassportConsumerVariant`): every variant is reached through `buildConsumerProjection`, which narrows a full per-user assembly (~21 reads plus ~13 for the permissions engine, per target), and the live map returns up to 100 travelers polled every 45 s — the per-user path is ~3,400 reads per poll per viewer. A `"map"` member would advertise that path to the next person wiring a map feature, so `passportMapPresence.test.ts` asserts the union does not gain one and pins the projection at exactly ONE table read for 50 owners. **This was an AUTHORITY defect, not a leak** — `mapTravelers` already applied both rules correctly; they simply lived in a consumer, so a change to the universal display-name rule had two places to land. Output is unchanged and `mapTravelers.test.ts` (14 tests) is green unmodified; the adoption costs no read, because the projection took over the `nameVisibilitySet` call that file already made. `openToMeet` stays behind deliberately: it is a map-ELIGIBILITY signal, not identity. |
| P99 | **Telegraph** | C | **Moved W→C 2026-09-08 from the call site.** The W said a grep for the variant outside its defining module returned nothing. The conversation header now consumes it: `routes/telegraph.ts:370#buildConsumerProjection`. |
| P100 | Compass | C | **Moved W→C 2026-09-08 from the call site.** The W said "no Compass route calls `buildConsumerProjection`". One does: `routes/compass.ts:4318#buildConsumerProjection`, taking the `discovery_card` variant for person cards exactly as the module's header intended. Compass's traveler SUGGESTION LIST (`routes/compass.ts:3671#title`) still builds identity inline for the bulk-surface reason above; carried by **P169**. |
| P101 | **Safety** | C | **Moved W→C 2026-09-08 from the call site.** The W said nothing outside the module referenced `toSafetyProjection`. Safe Return does: `routes/safeReturn.ts:1156#buildConsumerProjection`. |

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
| P120 | A Passport block propagates across Discovery, Telegraph, Trips, Presence, Map, Shared Moments, Bump, Buddy and Compass | C | The canonical block set is applied in every one of those trees: `routes/discoverySearch.ts`, `routes/telegraph.ts`, `routes/mapTravelers.ts`, `routes/mapProjection.ts`, `routes/sharedMoments.ts`, `routes/rentABuddy.ts`, `routes/compass.ts`, `routes/follows.ts` (all use `fetchBlockedSet` / `blocks`). Bump/QR resolves through the server passport projection, which collapses a blocked viewer to a minimal restricted card (`PassportProjectionService.ts:1495-1515`). |
| P121 | Blocking is not implemented independently per surface | C | Two shared mechanisms and no third: `resolveInteractionPermissions` (`services/interactionPermissions.ts:222`) for relationship-level authorization, and `lib/blocks.fetchBlockedSet` for row filtering. Passport does not re-implement either — `PassportProjectionService.ts:485` calls the canonical resolver. |

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
| P128 | Dark-mode first with deep navy/black surfaces | **W** | `src/theme/passportTokens.ts:7-11` — `paper: '#FFFFFF'`, `paperDeep: '#F7F7F5'`, `ink: '#1C1C1A'`. A light "passport paper" palette, and the file's own header calls it "clean white/cream paper, black ink, red seal". |
| P129 | Purple as the Passport identity accent | **W** | The identity accent is `seal: '#D32F2F'` (`passportTokens.ts:16`) — red, not purple. No purple token exists in the passport palette. |
| P130 | Gold for premium/earned travel identity and collectible stamps | C | `passportTokens.ts:17-18` `gold: '#D4AF37'` / `goldLight`, used for the gold-ring avatar (`PassportIdentityCard.tsx:3`) and premium stamp treatment. |
| P131 | Green for verification and positive trust states | C | `PassportStampCollection.tsx:60` `verified: { color: '#2E7D5B' }`; `PassportHero.tsx:406` `rgba(13,155,111,0.10)` for the positive pill. |
| P132 | Blue/teal for availability and social context | **W** | The Wall-shared token set offers `deep: '#0A3D4A'` (teal-ink) but the passport availability and shared-context surfaces use the paper/ink/seal palette; there is no blue/teal availability accent in `passportTokens.ts` at all. |
| P133 | Travel hero image, circular overlapping portrait, rounded cards, restrained glass | **W** | Rounded cards yes; a cover image yes; but the portrait sits in a left column of a document card rather than overlapping a hero (`PassportIdentityCard.tsx:391-412`), and there is no glass treatment. Two of four. |
| P134 | Colour is never the only status indicator; pair it with text/iconography | C | `PassportStampCollection.tsx:56-85` pairs each verification colour with a distinct glyph **and** an accessibility label; verification pills, availability check+label and trust standing pills all carry text. |

### §28 Mobile Component Structure

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P135 | The `/features/passport` tree of screens, components and services | C | All ten screens exist and are route-registered; components and services exist with **naming variance** rather than absence — `TravelerStateChip` for `TravelerStateCard`, `PassportStampCollection` for `StampStrip`, `MemoriesTab` for `MemoriesScreen`/`MemoryGrid`, `useTrustProjection.ts` for `trustProjection.ts`, `src/services/passportSharedContext.ts` for `sharedContext.ts`, and `services/passport/PassportPrivacyGuard.ts` (server-side, which is where the spec's own §4 says filtering belongs) for `passportPrivacy.ts`. Substance present; the tree is not literal. |

### §29 Passport Aggregate Contract

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P136 | The `PassportProjection` interface with every declared field | C | Returned at `PassportProjectionService.ts:1646-1665` — userId, identity, travelerState, availability, intent, trust, credentials, stats, stamps, featuredJourney, upcomingPlans, memories, travelIdentity, sharedContext, capabilities, viewerContext. All sixteen. |

### §30 Actions Must Be Server-Projected

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P137 | The actions block: can_follow, can_message, can_make_plan, can_invite_trip, can_view_availability, can_view_trust | C | `buildViewerActions:583-610` — exactly those six, and all six forced false for a blocked or unavailable owner (`:590-599`). |
| P138 | The client must not recreate policy; the server owns authorization | C | **Moved W→C 2026-09-08 from the call sites; no code changed.** The W said the public passport's Follow/Message controls "still gate on `isAuthed`". They do not: `app/passport/[username].tsx:477#viewerActions.canFollow`, `:479#onFollowPress` and `:480#onMessagePress` consume `resolveViewerActions` (`src/features/passport/viewerActions.ts:38#resolveViewerActions`), which reads the projection's `capabilities.actions` verbatim and fails CLOSED — no projection, or a missing flag, offers nothing. `usePassportPlans.ts:210#can_make_plan` likewise. The one surviving `isAuthed` gate (`app/passport/[username].tsx:402#isAuthed`) covers the overflow menu, whose only items are **Report** and **Block** — safety actions that are deliberately NOT in TABLE 29's `can_*` set and must remain reachable by someone the subject has blocked. Gating those on a server capability would be the defect, not the fix. |

### §31 Loading, Caching and Expiration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P139 | The load order: identity → viewer relationship → privacy → state → availability → trust → shared context → stamps/history → plans/memories | C | `buildPassportProjection` follows it in twelve numbered steps (`:1466` profile/identity, `:1478-1493` viewer + privacy, `:1541-1552` state/availability/intent, `:1554` trust, `:1567` stamps, `:1584` journey/plans, `:1590` memories, `:1621` shared context, `:1632` capabilities). Shared context is assembled after stamps rather than before, which is immaterial because the aggregate returns as one document. |
| P140 | Cache relatively static identity, stamp metadata, stats, travel identity and permitted journeys | C | `PassportProjectionService.ts:1682` `PASSPORT_STATIC_MAX_AGE = 3600`, mapped per section at `:1687-1696`. |
| P141 | Short TTLs for availability, current state, Open to Plans, Shared Context, trust and capabilities | C | `:1684` `PASSPORT_DYNAMIC_MAX_AGE = 30`, applied to travelerState, availability, intent, trust, sharedContext and capabilities (`:1697-1703`). |
| P142 | Explicitly expire availability, temporary intent, Open to Plans, event Passport, temporary sharing and location projections | C | `OpenToPlansService.effectiveExpiry:130` / `isExpired:140` re-evaluate on every read; `loadQuickStatus:698-711` drops an expired quick status before it can be projected; `routes/availability.ts` returns non-expired only; event Passport shares carry their own revoke path (`routes/passport.ts:1904`). |
| P143 | Never render stale Availability as current | C | Server drops expired windows before projection; the client blanks the volatile half past its short TTL rather than showing it (`src/hooks/usePassportProjection.ts:17-19`, `src/services/passportProjection.ts:556`). The route sets `Cache-Control: <scope>, max-age=<shortest present section TTL>` plus a weak ETag with 304 support (`routes/passport.ts:1502-1511`). |

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
| P165 | Not a Trust leaderboard | C | No ranking or comparison surface exists; `PassportProjectionService.ts:226` records the constraint, and the numeric score is self-only. |
| P166 | Not permanent exposure of future travel plans | C | `buildUpcomingPlans:1228` requires `show_on_profile` and an explicit non-private visibility; plans are limited to `planning`/`upcoming`/`active` so a completed trip leaves the Plans surface automatically. |
| P167 | Not a duplicate database for Trips, Buddy, Memory, Map or Presence | C | Every read is from the owning system's table (`trips`, `trip_members`, `rent_buddy_profiles`, `passport_memories`, `passport_stamps`/`user_stamps`); the 25 production `passport*`/`stamp*` tables are Passport-owned domains (stamps, postcards, memories, DNA prefs, visibility prefs, contribution events), not copies of another system's truth. |

### §35 Engineering North Star

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| P168 | The complete loop: Passport → Availability → Trust → Shared Context → Compass → Map → Plan → Telegraph → real-world experience → Memory → Stamp → Passport | C | Every hop exists and is wired: availability (`OpenToPlansService`), trust (`buildTrust`), shared context (`SharedContextService`), Compass (`SharedContextScreen.tsx:217` → `app/(tabs)/ai.tsx:104`), plan (`TripInvitePickerSheet`), Telegraph (messaging routes), memory (`PassportMemoryService`), stamp (`StampAwardEngine`, whose `safe_return`/`check_in` sources are literally experience-derived). Unlike the Wall's §41, the Passport loop's return leg **does** close: a real-world experience becomes a stamp through a deployed table (`user_stamps`, `stamp_award_events`). |
| P169 | Other surfaces request the appropriate Passport projection instead of rebuilding identity, availability, trust and social context independently | **W** | **This row was badly stale and its replacement note (written earlier the same day) was wrong too; both are corrected here from the call sites.** It read "adoption is three of seven consumers — Trips, Buddy and Event". Every one of the seven now calls `buildConsumerProjection`: `routes/trips.ts:575#buildConsumerProjection`, `routes/rentABuddy.ts:1385#buildConsumerProjection`, `services/passport/EventPassportService.ts:423#buildConsumerProjection`, `routes/telegraph.ts:370#buildConsumerProjection`, `routes/safeReturn.ts:1156#buildConsumerProjection`, `routes/discoverySearch.ts:2281#buildConsumerProjection` and `routes/compass.ts:4318#buildConsumerProjection`. **What actually remains is not four unadopted consumers — it is two BULK LIST endpoints**, which are different routes from the profile-card ones above and were being counted as the same thing: the discovery search list (`routes/discoverySearch.ts:650#subtitle`) and the Compass traveler suggestions (`routes/compass.ts:3671#title`). Both still build identity inline, and both do so for exactly the reason the map did — the per-user projection is ~34 reads per target and a list cannot pay it. **The batch path they need now exists** (P98's `buildMapPresenceProjections`), but it is not a drop-in for either: the map's projection is viewer-INDEPENDENT (a pin carries no follow/friend context), while both of these gate on the viewer relationship — Discovery suppresses the avatar unless `isFollowing || isFriend || show_profile_picture_publicly`, and Compass suppresses the title entirely for a private non-followed profile. Extending the batch projection with a viewer-relationship input is the remaining work, and it is one job, not two. **The row stays W**, but it is a much smaller and much better-specified W than "the single largest structural gap in Passport". |

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
