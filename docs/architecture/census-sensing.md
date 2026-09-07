# Census — Sensing + World / Experience Intelligence (v1.0, Sept 2026)

> ## CORRECTION HEADER — added 2026-09-07 after independent re-measurement
>
> A later pass queried both databases and re-derived this census. 127 is
> internally consistent (per-section counts sum to 127 and every S-id range
> matches its section) and there is no section miscount. Several other things
> below are wrong; the body is unedited and these take precedence.
>
> **This census was already STALE when it was committed.** It records
> `lib/sensingAnonStore.ts` as "absent from the worktree". The store landed at
> 06:55:03 (`e7769a45`); this census was committed at 06:57:22 — two minutes
> later, and its own commit amended that store's tripwire test. S18 was BUILT,
> not NOT-BUILT.
>
> **Production readings that are wrong.** This census says "Database: not
> queried" and inherited its facts from a brief.
> - There is no flag named `intel_retention`. `intel_retention_sweep_enabled`
>   is **TRUE in production**; `intel_contribution_retention_enabled` is FALSE
>   but PRESENT; `intel_coverage` is present-and-false, not absent.
> - Not three intel flags are TRUE in production but **eight**:
>   capture_quick_signal, claim_projection_crowd, limited_live,
>   live_label_crowd, missions, retention_sweep_enabled, rewards,
>   trail_followup.
> - Because `intel_limited_live` and `intel_live_label_crowd` are ON while
>   `intel_live_promoted_scopes` has 0 rows and no writer, `liveClaimRead.ts:317`
>   returns `[]` for every subject in production.
> - Production has **no `schema_migration_ledger` table at all**.
>
> **S39 cites the wrong object.** `presence/domain/types.ts:88
> PresenceObservation` is one device's *identifiable* raw observation
> (sessionId, subjectEphemeralId, point) — the opposite of §19's aggregate. A
> name collision, not evidence.
>
> **Attribution: 0.0 % is right for the store and wrong for the tree.** By
> dating, PR #475 landed at 01:32 UTC, five hours BEFORE the spec entered the
> tree at 06:34 UTC, so the store implements an owner ruling rather than the
> document. But `LiveForYouService.ts:117` and
> `wallProjection.ts:136-164,214,307-314,502-508` cite "Sensing §108 / §5.1 /
> §2" and were committed at 08:15 UTC — spec-attributable work this census
> predates.
>
> **CORRECTION TO A CLAIM MADE FROM THIS CENSUS, not to the census itself.**
> On its strength I told the owner that Sensing cannot reach 100 % because S17
> (TLS in transit / at rest) is a deployment fact no code can close. The
> conclusion holds; the reason was wrong and it was the least important cap.
> S17 is HALF code-answerable — `app.ts:26` `helmet()` sets HSTS, and the
> store's at-rest control is application-level (peppered HMAC tokens, the
> device secret never stored). What actually caps Sensing is
> **`intel_observations.actor_id NOT NULL REFERENCES profiles(id)`**
> (`2130:142`), which is what S19/S118/S125 run into.
>
> I also said 11 steps need owner decisions. **Eight do.** Pepper provisioning
> is no longer a decision — `e7769a45` made a dedicated pepper mandatory in
> code, so it is an ops task. "Enabling any flag" has no object: no sensing flag
> exists, and the tripwire asserts none was invented. The abuse budget is half
> engineering — per-credential replay is code (§4.3 names it) and is now built;
> only the per-device rate budget and its key remain a decision.
>
> **`sensing-s0-reuse-map.md` does not summarise itself correctly.** Its own
> table marks **five** contracts truly missing, not four — the summary omits
> `ExperienceSession` — so the split is 5 missing / 6 reusable / 1 blocked, not
> 4 / 5 / 3. Two of its mappings are also wrong: `PresenceObservation → EXTEND
> intel_observations` points at the very table whose `actor_id` FK is the
> blocker, and `CrowdState → REUSE crowdFlowProducer` contradicts this census's
> own S40.
>
> **Recomputed after the completion pass: CORRECT 78/127 = 61.4 %** (was
> 51.2 %), CONSTRUCTED 110/127 = 86.6 %, spec-attributable 12/127 = **9.4 %**
> (was 0.0 %). Under a strict reading where callerless contracts do not count:
> 74/127 = 58.3 %. **Realised in production: still 0.0 %** — there is no sensing
> table, no route, and the pepper without which every write refuses is optional
> at boot.


*Measured against the repository at branch `claude/portava-continuation-uqta94`, HEAD `0177f0be`,
on 2026-09-07. Specification: `docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt`.*

**The .txt and the .docx are byte-identical after whitespace normalisation** (extracted
`word/document.xml`, stripped tags, compared line-by-line: `IDENTICAL`). Nothing in this census
rests on a transcription difference, and the .docx authority clause never had to be exercised.

Paths are relative to `artifacts/api-server/` unless prefixed `travel-buddy-standalone/`,
`docs/` or `pr/475:`.

---

## Headline

| Measure | Value |
|---|---|
| **Denominator — testable requirements** | **127** |
| BUILT-AND-CORRECT | 65 |
| BUILT-BUT-WRONG | 39 |
| NOT-BUILT | 22 |
| CANNOT-VERIFY | 1 |
| **CONSTRUCTED%** = (65+39)/127 | **81.9 %** |
| **CORRECT%** (raw) = 65/127 | **51.2 %** |
| **CORRECT% (spec-attributable)** = 0/127 | **0.0 %** |

**I disagree with commit `0597a245`'s CONSTRUCTED 56.4 % / CORRECT 32.1 %.** I land materially
higher on both — roughly +25 points constructed and +19 points correct. I agree exactly with its
attribution finding: **zero** implemented items are attributable to this specification.

Two sub-scores matter more than the headline and are given because the headline is misleading on
its own:

| Sub-score | Denominator | CONSTRUCTED | CORRECT |
|---|---|---|---|
| **Sensing input + inference core** (§3, §4, and the Vibe/Experience/Forecast/Opportunity/Session engines: S17–S38, S42–S46, S51–S54) | 31 | 64.5 % | **22.6 %** |
| Everything else (invariants, reuse directives, surface integration) | 96 | 87.5 % | 60.4 % |

The high headline is a property of the specification, not a compliment to the tree. This spec is
titled *UPGRADE, DO NOT REBUILD*; §19 says outright *"Do Not Blindly Materialize"*; and a large
fraction of its testable content is **prohibitions and reuse directives** that Portava's
pre-existing intel and map work already satisfies with unusual care. Score the part of the spec
that asks for something *new* — a device sensing boundary, a privacy-reduced ingest, Vibe
inference, ExperienceState, ExperienceSession — and the correct column falls to 22.6 %.

### The caveat that outranks every number here

**Every intel table in production holds zero rows.** `docs/architecture/intel-spine-liveness.md`
measured production directly: `intel_observations`, `intel_claims`, `intel_evidence`,
`intel_state_snapshots`, `intel_coverage_snapshots`, `intel_reward_ledger` and
`intel_contribution_consent` are all `count(*) = 0`, with `intel_capture_quick_signal`,
`intel_claim_projection_crowd` and `intel_rewards` all **TRUE** in production. The gates are open,
the schedulers run, the capture route is reachable from a live client screen, and nothing has ever
entered it.

So the 65 BUILT-AND-CORRECT verdicts below are verdicts about **code that is correct and would
run**. They are not evidence that anything has run. A reader who wants "correct *and*
demonstrated in production" should read the CORRECT column as an upper bound whose realised value
is currently, so far as production rows go, **zero**.

A second liveness fact, from `docs/architecture/sensing-surface-inventory.md`: the migration chain
declares 15 `intel_*` tables and production has 10. `intel_state_snapshot_versions` (2273),
`intel_presence_verifications` (2276), `intel_attributions` (2277), `intel_scoped_trust` (2278)
and `intel_historical_patterns` (2279) exist only in `portava-ci`. Several verdicts below cite
code that targets those tables; where that matters I say so in the row.

---

## Denominator — how 127 was decided

A line of the spec is a **testable requirement** when it asserts a property, artifact or
prohibition that could be *falsified by reading this tree*. Concretely:

**Counted.** Every bullet that asserts a required property (§1's eight directives, §2's ten
semantic separations, §3's nine security properties, §4's boundary/session/ingest/aggregation
rules, §7–§17's per-surface bullets, §18's platform clauses, §20's invariants, §22's repo-safety
rules). Every row of §5's engine table (each row asserts an engine, an output and a forbidden
claim — one requirement). §5.1/§5.2/§5.3/§5.4's contracts. One requirement from §21 for the S0
audit artifact and one for S11 shadow calibration.

**Not counted, and why.**
- **§23 (Paste-Ready Directive)** is a verbatim restatement of §1–§21. Counting it would
  double-score the whole spec. Excluded entirely.
- **§19's twelve logical contracts** are explicitly *"names describ[ing] responsibilities"* that
  Claude *"must first inspect existing tables/types/services and map … before deciding whether a
  new table/type is needed."* Eleven of the twelve are already counted as §4/§5 engine or contract
  requirements. Only `ExperienceOutcome` is not, so §19 contributes exactly **1**.
- **§24's checklist** restates §3/§5/§9/§10/§13/§20. Only *"Location contribution and social
  live-location permissions are separate"* is not already counted; §24 contributes **1**.
- **Diagrams, ASCII pipelines, prose rationale, and process rules** (§21's S0–S11 ordering,
  §22's "one responsibility per PR") are not falsifiable from a tree. Excluded.
- **Duplicates are merged to a single id** where the same assertion appears twice (e.g. §2
  *"Crowded ≠ unsafe"* and §16 *"Crowded remains ordinary intelligence unless…"* are one
  requirement, S8; §14 and §18.3 both forbid nearest-place snapping — one requirement, S97).

Per-section contribution: §1 6 · §2 10 · §3 11 · §4 11 · §5 16 · §6 3 · §7 10 · §8 5 · §9 5 ·
§10 5 · §11 4 · §12 4 · §13 4 · §14 4 · §15 4 · §16 3 · §17 4 · §18 3 · §19 1 · §20 6 · §21 2 ·
§22 5 · §24 1 = **127**.

### The rule for prohibitions

Most of §2 and §20 are prohibitions. The rule applied here, uniformly:

- A prohibition is **BUILT-AND-CORRECT** when a concrete artifact makes the violation
  unrepresentable or refuses it — a type, a CHECK constraint, an explicit refusal list, a
  fail-closed branch. Citation required.
- A prohibition whose forbidden path simply **does not exist**, with nothing guarding against it
  being added, is **NOT-BUILT** — annotated *unguarded absence*. The guarantee is not
  constructed; it is merely currently unviolated.

Five BUILT-AND-CORRECT verdicts are **vacuous or partly vacuous** (the guard is real but the path
it guards is empty): S89, S90, S91, S105, S22. They are flagged `⌀` in the table. A reader who
rejects vacuous satisfaction should subtract them: CORRECT% becomes 60/127 = **47.2 %**.

---

## Attribution — testing commit `0597a245`'s claim

`0597a245` claims that of the items its census counted implemented, **zero** were attributable to
this specification. **That claim is correct, and I can strengthen it: no artifact in this tree
cites this spec at all.**

```
grep -rliE "Sensing \+ World|Sensing/World|World / Experience Intelligence|Sensing World Experience" \
  --include=*.ts --include=*.sql --include=*.md artifacts/api-server/src travel-buddy-standalone/src docs
→ (no matches)
```

Every BUILT-AND-CORRECT verdict below traces to one of four *other* programmes, each of which
names its own spec in its own file headers:

| Programme | Evidence it is not this spec | What it produced |
|---|---|---|
| **Intelligence Gathering (IG-01…IG-10)** | `docs/intelligence-gathering-buildout.md:1` — *"Implementation of the Intelligence Gathering Implementation Specification … (23 Aug 2026)"*, with a unit→file→migration table | `intelContracts`, `2130_intel_storage`, `privacyGate`, `confidenceScore`, `intelProjection`, `liveClaimRead`, `intelIndependence`, coverage, rewards, outcomes |
| **Map spec Phase 7 / §10 / §17 / §24 / §31 / §36 / §37** | Section numbers cited in-file: `mapProducers/worldPulseProducer.ts:2` (*"Map spec §36 Phase 7"*), `crowdFlowProducer.ts:2` (*"Map spec §10"*), `protectedLocations.ts:2` (*"Map spec §24"*) | `world_pulse`, `crowd_flow`, `traveler_flow`, `city_model`, semantic-zoom bands, `protected_zones` |
| **Wall spec §4/§5/§14/§22** | `LiveForYouService.ts:2` (*"spec §4"*), `FollowingFeedService.ts:2` (*"spec §5 / TABLE 1"*) | Live For You strip, chronological Following lane, Wall projection |
| **Global Input Intelligence / Presence Network / Compass phases** | `docs/architecture/input-intelligence-certification.md`; `presence/domain/types.ts:2` (*"spec §56 Phase 0"*) | `liveSuggestions`, precision ladder, Compass Home/Sense/Live |

**Spec-attributable CORRECT% = 0/127 = 0.0 %.** The only artifact in existence that was built
*for* this spec is PR #475 (`0597a245`), which is **not in HEAD**
(`git merge-base --is-ancestor 0597a245 HEAD` fails; `src/lib/sensingAnonStore.ts` is absent from
the worktree) and is inert even where it is applied. See "PR #475 delta" below.

---

## Requirement-by-requirement

Legend: **BC** BUILT-AND-CORRECT · **BW** BUILT-BUT-WRONG · **NB** NOT-BUILT · **CV** CANNOT-VERIFY ·
`⌀` vacuous satisfaction · all BUILT verdicts carry a file:line I opened.

### §1 Non-Negotiable Upgrade Directive

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S1 | No second intelligence truth store or second lifecycle | **BC** | `src/migrations/2130_intel_storage.sql:15-26` declines four tables the IG spec listed *"because each would duplicate a system that already exists — the spec's own 'no duplicate truth store' rule applied to its own table list"*. One lifecycle: observations → claims → snapshots. |
| S2 | No second place identity | **BC** | `2130:142-146` — `subject_id uuid NOT NULL REFERENCES public.places(id)`; the discovery id space is bridged, not forked (`src/lib/coverageAssembly.ts:10-17`). |
| S3 | No second social presence model | **BW** | Four coexist: `circle_presence`, `trip_crew_location_sessions`, `locateFriendsSession`, and the map's `social_zone`/`buddy_zone`/`crew_member` kinds. `src/presence/domain/types.ts` declares the intended single architecture but is *"Phase-0 types and a transport selector; no store, no fusion layer"* (`src/lib/crowdFlowProducer.ts:388`) and only `locateFriends` consumes it. |
| S4 | Preserve null/unknown when canonical fact is unavailable | **BC** | `src/lib/mapObjects.ts:370-386` — `sourceClass` optional and the optionality documented as load-bearing (*"Every candidate default is a lie"*). `src/lib/mapProjection.ts:682` returns the object untouched when there are no claims. |
| S5 | Do not weaken existing privacy / authz / safety / GPS stripping | **BC** | No weakening found; five standing ratchets: `src/scripts/checkLocationPurposes.ts`, `checkDataRights.ts`, `auditStorageExif.ts`, `checkAuthorizationContract.ts`, `checkSilentSupabaseWrites.ts`. |
| S6 | Existing Map/Discovery/Wall/Compass keep functioning while new projections are partial or gated | **BC** | Every new producer is flag-gated fail-closed with the legacy path intact: `src/routes/mapProjection.ts:1056`, `src/lib/mapProducers/worldIntelligence.ts:62`, `2295_map_world_intelligence_flag.sql:93-95` (postcondition *refuses* to commit if the flag were seeded ON). |

### §2 Hard semantic separations

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S7 | Busy ≠ good | **BC** | Activity and Trend are separate axes (`mapObjects.ts:243-251`, `:233-241`); `mapProjection.ts:900-907` refuses `packed → peak` because *"peak claims the place is at ITS OWN apex … publishes an inference the contributor never made"*. No enabled path converts activity into a desirability score (`discoveryModifiers.ts:60` momentum is behind `discovery_ranking_modifiers_enabled`, absent in production). |
| S8 | Crowded ≠ unsafe | **BC** | `intelContracts.ts:257` `SPECIALIST_ONLY_CROWD_LEVELS = ['unsafe_density']`; `quickSignal.ts:110,170` refuses to emit or validate it from a contributor surface; `mapProjection.ts:906` maps it to `null` activity — *"rendering a dangerous crush as 'Peak' would advertise it as the place to go"*. |
| S9 | Rapid movement ≠ dancing | **NB** | *Unguarded absence.* No motion signal, no periodicity, no `dance_likelihood` anywhere. `VIBE_STATES` (`intelContracts.ts:303`) come only from a human tap in `quickSignal.ts`. Nothing would refuse a motion→vibe inference if one were added. |
| S10 | Inference ≠ observation | **BC** | `crowdFlowProducer.ts:57-70`: `event_context` is rejected at intake (`cause_is_not_observation`); a `CauseHypothesis` has *"no `actorId`, no `groupKey` and no count field"*; cause confidence capped at the observation's own band. Mirrored in types at `presence/domain/types.ts:5-12` (`PresenceObservation` vs `PresenceEstimate`). |
| S11 | Prediction ≠ current truth | **BC** | `mapProjection.ts:697-701` — freshness is gated on source class, not timestamp: a `portava_prediction` two minutes old is capped at `recent`, never `live`. `mapObjects.ts:113` `FORECAST_KINDS`. `worldPulseProducer.ts:54-59` refuses `prediction` as pulse input. |
| S12 | No coverage ≠ quiet | **BC** | `mapProjection.ts:682` — `if (!claims || claims.length === 0) return obj;`. An unobserved place carries no activity level at all, rather than `very_quiet`. |
| S13 | One device ≠ a crowd | **BC** | `src/lib/privacyGate.ts:80-128` with `PRIVACY_THRESHOLD_V1` (`intelContracts.ts:732-739`): ≥15 distinct actors, ≥5 independent groups, ≤20 % single-group share, 10-minute publication delay. A missing group count is a refusal, not an exemption (`privacyGate.ts:101-106`). |
| S14 | Promotional claim ≠ observed reality | **BC** | `intelContracts.ts:44-56` separates `sponsored` / `official_signed` / `imported_owned` from firsthand classes; `:74` `NON_OBSERVATION_SOURCE_CLASSES`; `2130:157` `commercial_disclosure` CHECK (`none…paid`). |
| S15 | World anomaly ≠ safety incident | **BC** | `mapProducers/safetyNoticeProducer.ts:22-32` refuses the allowed fallback of projecting `protected_zones` as safety notices, and reads only the specialist-reviewed `unsafe_density` claim. There is no anomaly→notice path. |
| S16 | User dislike ≠ bad venue | **BC** | The only writer of `intel_claims`/`intel_state_snapshots` is `intelProjection.ts:3-8`, whose inputs are observations, not personal feedback. Compass feedback lands in `compass_*` tables via `CompassFeedbackEngine`; no path reaches a claim. |

### §3 Privacy and identity architecture

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S17 | TLS in transit and encrypted storage at rest | **CV** | `src/app.ts:25` `app.use(helmet())` sets headers, but TLS termination, HSTS enforcement and Supabase at-rest encryption are deployment facts not present in the tree. |
| S18 | Short-lived rotating contribution identifiers; no stable anonymous tracking id | **NB** | Every contribution carries `actor_id`. `presence/domain/transport.ts:35` declares a `subjectEphemeralId` — *"Rotating ephemeral id … never a persistent user id"* — but the module is interface-only with no implementation. |
| S19 | World-intelligence contribution records carry no permanent `profiles.id` / user FK | **BW** | **The spec's named prohibition, violated by the only contribution table.** `2130_intel_storage.sql:142` — `actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`; same on `intel_evidence:236` and `intel_confirmations:265`. |
| S20 | Separate contribution eligibility from ingest; ingest receives an opaque short-lived credential | **NB** | `routes/intel.ts` capture authenticates with the ordinary session (`requireUser`) and the actor id *is* the storage key. No credential concept exists. |
| S21 | Raw precise location reduced on-device or in a narrow trusted boundary as early as practical | **BW** | The store is right, the boundary is wrong. `2130:159-163` stores a derived `presence_attestation`, *"never a pointer to a coordinate row"* — good. But the reduction happens **server-side**, in `services/intel/PresenceVerifier.ts:248,275`, reading identity-linked precise `location_snapshots` rows. Nothing is reduced on the device. |
| S22 `⌀` | Sensitive-location suppression | **BC** | `src/lib/protectedLocations.ts:13-27` — server-side, last gate before serialization, fail-closed on unparseable geometry on *both* sides. Caveat: the policy table ships empty by design (`scripts/checkWriterlessReads.ts:163-171`, quoting migration 2217 *"SHIPS EMPTY BY DESIGN"*), so the correct code currently suppresses nothing. |
| S23 | Cohort thresholds and minimum independence requirements | **BC** | `privacyGate.ts:94-112` plus `intelIndependence.ts:1-46` — shared media, common source and 30-second synchronised-value detectors MERGE units, and *"Merging only ever REDUCES the independent-group count … It can suppress a real signal but can never inflate one."* |
| S24 | Anti-differencing controls and rare-path suppression | **BW** | Rare-path suppression is real: every flow edge is independently k-gated, so *"a chain A→B→C made by one traveller cannot be read back out"* (`crowdFlowProducer.ts:26-30`). Anti-differencing as such is absent — no query-set-size auditing, no noise, no repeated-query budget. The 10-minute publication delay is the nearest thing. |
| S25 | Purpose-scoped authorization: collect / retain / aggregate / infer / personalize / surface / share are distinct permissions | **BW** | `src/lib/locationPurposes.ts:1-25,102-314` is a genuine registry — twelve purposes, each with lawful basis, precision class, retention bound, visibility and deletion behaviour. But the seven **verbs** are not distinct permissions: contribution consent is one boolean (`2172_intel_contribution_consent.sql:31-50`, `intelConsent.ts:42`). |
| S26 | Raw contribution retention short; aggregate retention per explicit policy | **BW** | Both halves exist and both are qualified. Aggregate: `2133` + `intelRetentionScheduler.ts:1-16`, flag-gated. Raw: `2173_intel_contribution_retention.sql:1-3` — *"180-day age-based retention … DISABLED by default"*, and the flag `intel_retention` is **absent from production** (`sensing-surface-inventory.md`). 180 days of actor-linked raw contributions is also not "short" in this spec's sense. |
| S27 | Social location never silently becomes anonymous crowd intelligence, and vice versa | **BC** | `crowdFlowProducer.ts:317-321` defines `purpose_mismatch` as a first-class blocker — *"the source is written, but its declared lawful basis does not cover publication into a public aggregate"* — and `:1015` empties the cohort on a consent-read failure. `route_flow_contribution_consent` is a separate consent scope from `intel_contribution_consent`. |

### §4 Sensing system architecture

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S28 | On-device feature extraction: spatial/temporal bucket, movement_state, motion_energy, periodicity, dwell_bucket, transitions, transport-mode, sensor health | **NB** | No `expo-sensors`, `DeviceMotion`, `Accelerometer`, `Gyroscope` or `Pedometer` anywhere in `travel-buddy-standalone/`. `expo-location` is used for foreground place pickers and geo filters only. None of the nine named features exists. |
| S29 | Coarse acoustic energy/rhythm only under separate explicit permission | **NB** | No acoustic capture and no permission scaffold for one. |
| S30 | `IntelligenceContributionSession`: rotating credential, purpose_scopes, precision_ceiling, sampling_policy, retention_policy, privacy_budget, expiry, revocation | **NB** | `intel_contribution_consent` is a per-account boolean with a version stamp (`2172:31-50`). None of the eight session properties is represented. |
| S31 | Search for and extend existing consent/session/device-authorization structures rather than duplicating | **BC** | This was actually done, and documented: `2130:15-26` declines four duplicate tables; `intelConsent.ts:4-8` routes through `locationPurposes`' `intel_claim` purpose; `privacyGate.ts:4-14` is deliberately generic *"because building the spec's threshold as a new intel-only module would leave that path publishing at k=1 forever"*. |
| S32 | Signal Ingest API with schema validation | **BW** | `routes/intel.ts` + `services/intel/IntelCaptureService.ts` + `intelClaimValidators` is a validated capture API — but it ingests **human claims under session identity**, not privacy-reduced device signal features. There is no signal ingest. |
| S33 | Replay/idempotency protection and rate limiting per credential/device boundary | **BW** | Both exist, both keyed on the account: unique `(actor_id, idempotency_key)` (`2130:196-197`) and `src/lib/intelThrottle.ts`. Per-credential/device is impossible without S18/S20. |
| S34 | Ingest fails explicitly; never returns a plausible empty world | **BC** | Refusal taxonomies rather than empty returns: `crowdFlowProducer.ts:1055` (`ReadCrowdFlowSignalsResult.refusal` + per-family `familyRefusals`, and *"a caller can tell 'we looked and found nothing' from 'we declined to look'"*), `intelRetentionScheduler.ts:47-56` (`reason: disabled\|no_client\|error`). |
| S35 | Reject impossible timestamps, malformed precision, invalid purpose scopes, stale credentials | **BW** | Timestamps: `intelContracts.clampObservedAt` plus the DB backstop `CHECK (observed_at <= received_at + interval '60 seconds')` (`2130:186-190`). Malformed values: `intelClaimValidators`. Purpose scopes and credentials: **do not exist**, so two of the four rejections are unimplementable. |
| S36 | No precise GPS in canonical event payloads | **BC** | `2130:159-163` (attestation, not a coordinate pointer); `2130:230-233` on `intel_evidence.reference` — *"Never raw coordinates: EXIF is stripped upstream and this table must not become a second location store"*; `dataRights.ts:144` marks `distinct_actors` restricted. |
| S37 | A crew / tour group / bus / duplicated devices are not independent confirmations | **BC** | `intelIndependence.ts:15-46` — units, not actors; three merge detectors; `SYNC_WINDOW_SECONDS = 30` (`:55`). `crowdFlowProducer.ts:38-46`: `maxGroupShare` uses the **union** denominator so *"an actor in several crews cannot dilute the dominant group's share"*. |
| S38 | Track coverage separately from estimated activity | **BW** | Coverage exists, but as a *mission-gap priority* (`coverageScore.ts:2-13`, `coverageAssembly.ts`, `intel_coverage_snapshots`), not as metadata on published state. `MapObject` (`mapObjects.ts:362-398`) has `freshness`, `confidence`, `activity`, `sourceClass`, `provenance` — and **no coverage field**. |

### §5 Intelligence engines

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S39 | Presence engine → `PresenceObservation` + coverage; must not claim public person identity | **BW** | The *types* exist and are careful (`presence/domain/types.ts:88,114`); there is no engine. What actually feeds aggregates is human observation counts. No per-zone `PresenceObservation` is ever produced. |
| S40 | Crowd engine → `CrowdState` (density, momentum, arrival-departure balance); must not claim safety or quality | **BW** | The vocabulary is there — `CROWD_LEVELS`, `TRAJECTORIES`, `CROWD_DIRECTIONS` (`intelContracts.ts:246,259,286`), `activityForCohort` (`mapAggregation.ts:534`) — and the must-not-claim half is enforced (S8). But there is no `CrowdState` object: density is a claim value, momentum is a trend label, and arrival/departure balance is a human tap, not a computed balance. |
| S41 | Flow engine → `FlowState`/edges; must not claim individual trajectory | **BC** | The strongest item in the census. `crowdFlowProducer.ts:14-30` — *"There is no per-actor path type, anywhere. The input unit is ONE HOP … so a path cannot be assembled even internally"*; actor ids enter a `Set` and never leave it; `src/test/crowdFlowProducer.test.ts` walks the serialized output for sentinel ids. `deriveCrowdFlow` (`mapAggregation.ts:1115`) applies four gates; geometry is a `LineString` between zone centroids (`:1192,1236-1237`). |
| S42 | Vibe engine → `VibeState`; must not claim literal behaviour without sufficient evidence | **BW** | `vibe.state` exists as a five-value human claim (`intelContracts.ts:303`) with a live-label ruling (`:587`). There is no inference engine and no `VibeState`. |
| S43 | Experience engine → `ExperienceState`; must not treat personal preference as world truth | **NB** | No `ExperienceState` under that or any equivalent name. `grep -ri experience_state\|ExperienceState src/` → nothing. |
| S44 | World Dynamics → `WorldState`/`WorldMoment` (change, anomalies, hotspots, rhythm); must not claim cause when unknown | **BW** | Hotspots and rhythm exist and the must-not-claim half is enforced: `world_pulse` (`worldPulseProducer.ts`), `city_model`, `traveler_flow`, and cause hypotheses structurally separated (S10). **Change** and **anomalies** do not exist — there is no `WorldMoment`, no transition object and no anomaly detector. |
| S45 | Forecast → `ForecastState` with calibration; must not be presented as observed current fact | **BW** | The must-not half is enforced (S11); the engine is thin. `prediction` is a map kind and `portava_prediction` a source class, with `src/lib/temporalProjection.ts` producing time-shifted projections — but no horizon field, no calibration attached to a forecast, and no `ForecastState`. |
| S46 | Opportunity → `OpportunityProjection`; must not claim canonical world truth | **BW** | Wall has a `contextual_opportunity` object type (`services/wall/WallProjectionService.ts:57`) and Compass has recommendations, but each surface builds its own; there is no shared Opportunity engine or projection. |
| S47 | Product surfaces consume projections; they do not reimplement engine logic | **BC** | `src/lib/liveClaimRead.ts` is the single read path, consumed by Map (`mapProjection.ts:98`), Wall (`ContextThreadService.ts:46`), Compass (`CompassMediaContext.ts:38`), Media (`MediaProjectionService.ts:49`), Input (`inputAssistance/liveSuggestions.ts:39`) and Trails (`trailLiveIntel.ts:27`). `LiveForYouService.ts:37-40` reuses `loadNearbyEvents` explicitly so *"The Wall must not implement a second place-state system"*. |
| S48 | Canonical truth classes: OBSERVED / CORROBORATED / INFERRED / PREDICTED / CONFLICTING / STALE / UNKNOWN | **BW** | `grep -ri truth_class\|truthClass` → **nothing**. The concept is spread across four unrelated vocabularies: `SOURCE_CLASSES` (`intelContracts.ts:44`), `CLAIM_STATUSES` (`:138`, has `conflicting`/`expired`), `CONFIDENCE_BANDS` (`:410`) and `FRESHNESS_STATES` (`mapObjects.ts:121`). `presence/domain/types.ts:67-71` `ESTIMATE_STATES` is the closest single vocabulary but is presence-scoped. **CORROBORATED has no representation.** |
| S49 | Every server-built state consumed by Map/Discovery/Wall/Compass carries truth class, confidence, freshness **and coverage** | **BW** | Three of four. `MapObject` (`mapObjects.ts:362-398`) carries `freshness`, `confidence`, `sourceClass` and `provenance`; it carries **no coverage**, and no truth class per S48. |
| S50 | Prediction never rendered indistinguishably from observation | **BC** | Server: `mapProjection.ts:697-701`. Client mirror: `travel-buddy-standalone/src/types/mapObjects.ts:113-117` `FORECAST_KINDS` with the same §37 comment. |
| S51 | Vibe inferred from motion energy, periodicity, bounded movement, dwell, arrival/departure velocity, density, venue context | **NB** | None of the seven candidate signals exists to infer from. |
| S52 | `VibeState` carries energy, sociality, dance_likelihood, volatility, momentum + confidence/coverage/freshness/provenance | **NB** | No such structure. |
| S53 | `ExperienceState` composite: Crowd / Vibe / Behavior / Friction / Dynamics / Truth | **NB** | Absent. Friction (queue/access/wait/transport) exists only as four unrelated claim types (`queue.wait`, `access.walk_in`, `access.reservation`, `transit.condition` — `coverageScore.ts:26-38`); nothing composes them. |
| S54 | `ExperienceSession` bridges opportunity → action → outcome without being a tracking history | **NB** | No such object. `CompassLiveEngine.ts:1-27` is a plan-timing companion session; `LayoverSessionService` is layover-scoped. Neither bridges a world opportunity to an outcome. |

### §6 Platform integration contract

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S55 | Context Kernel assembling canonical entities + world/experience state + user/trip/social + safety/policy, with the nine §18.1 contexts | **BW** | `src/compass/CompassContextEngine.ts:1-19` is an 11-state context machine (safety/booking/arrival/trip/night/private/creator/budget/planning/exploring/normal). It is Compass-local, is not consumed by Map, Wall or Discovery, and has no World, Experience or Attention context. |
| S56 | Opportunity Engine downstream of the kernel, feeding feature-specific projections | **NB** | No such stage; each surface builds candidates directly. |
| S57 | Feature clients and React components must not independently calculate crowd, vibe, safety, opportunity, experience value or world-change state | **BC** | The client mirrors the server vocabulary as **data** and computes none of it: `travel-buddy-standalone/src/types/mapObjects.ts` re-declares the kind/priority/source-class tables; per the input-intelligence certification, `components/freshnessDisplay.ts` *"never synthesizes a label the server did not send (mutation-proofed)"*. The only client-side derivation found is `hooks/useActiveLocation.ts:112` `computeFreshness`, which is the viewer's own location, not world state. |

### §7 Required tweaks: Map

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S58 | Keep current layer census and fallback; do not rewrite the gateway | **BC** | The gateway is intact; every Phase-7 kind is additive behind `map_world_intelligence_enabled` (`mapProducers/worldIntelligence.ts:62`, `routes/mapProjection.ts:1056`). |
| S59 | Add server-built `ExperienceState` to place/event projections rather than separate overlapping vibe pins | **BW** | The **shape** is right and the payload is wrong: `mapProjection.applyLiveClaims` (`:676-701`) folds live claims onto the place object instead of emitting parallel vibe pins — exactly what the spec asks — but what it folds on is individual claims, not an ExperienceState. |
| S60 | Promote `world_pulse` into transient world-change projections: heating up, forming, moving, clearing, unexpected activity, event spillover, traveler surge | **BW** | `world_pulse` exists and is well built (`worldPulseProducer.ts`), but it is an **activity-concentration cell** with `payload.basis = 'observed_aggregates'` — a *level*, not a *change*. None of the seven named change types exists. `TREND_STATES` (`mapObjects.ts:233`) attach to places, not to world objects. |
| S61 | Render crowd_flow / traveler_flow as privacy-safe directional geometry, not ordinary pins | **BC** | `mapAggregation.ts:1192,1236-1237` — a `LineString` between two zone centroids, with `:982` recording *"deliberately NO per-person field and no route geometry"*. `travelerFlowProducer.ts:277` runs its own privacy gate. |
| S62 | `TemporaryWorldObject` only if no canonical contract exists; no fake permanent Place rows for transient clusters | **BC** | Transient clusters are emitted as synthetic map objects with cell/edge geometry and no `places` row: `mapAggregation.ts:675` (`cellPolygon`), `:1236` (flow edge), `meetingPointProducer`. No code inserts a `places` row from activity — the only writer is the manual `scripts/backfill-canonical-places.ts`. |
| S63 | Semantic zoom: city→neighborhood/world dynamics; district→hotspots/flows; place→vibe/crowd/queue | **BC** | `mapAggregation.ts:202-244` — five bands with explicit content ladders, `AGGREGATING_BANDS = ['world','city']`, fail-closed to `world` on a bad zoom. Enforced, not just documented: `worldPulseProducer.ts:280` returns nothing when `!bandCarriesWorldIntelligence(band)`. |
| S64 | Truth/freshness/coverage metadata, and predicted visually distinguished from observed | **BW** | Freshness, confidence, source class, provenance and the predicted/observed split are all present and mirrored on the client. **Coverage is absent from `MapObject`** (`mapObjects.ts:362-398`). |
| S65 | Display resolver / clutter budget so safety, mode, zoom, user intent and relevance decide what renders | **BW** | What exists is a priority sort plus a page cap: `rankObjects` (`mapProjection.ts:1166`), `compareByRenderingPriority` (`mapObjects.ts:420`), `paginate` with `Math.min(200, …)` (`mapProjection.ts:1226`), `filterKinds`. Zoom decides aggregation. **Mode, user intent and relevance decide nothing**, and no budget is allocated across classes. |
| S66 | Safety constraints outrank opportunity/vibe; a dangerous place is never simultaneously promoted as "best move now" | **BW** | True *within the map*: `RENDERING_PRIORITY.safety = 120` (`mapObjects.ts:281`) and `unsafe_density → null` activity. **False across surfaces**: nothing stops Compass or Discovery recommending a place carrying a safety claim. `compass/CompassSafetyFilter.ts:159-197` filters by author/content state (blocks, mutes, moderation) — nineteen rules, none of which reads world safety state. |
| S67 | Map remains a projection consumer, never an owner of world truth | **BC** | Every map producer is pure or read-only; the sole writer of `intel_state_snapshots` is `intelProjection.ts:3-8`. `worldPulseProducer.ts:11-14` — *"This module is PURE and takes `MapObject[]` … it has no database access, so there is no path by which it could reach a presence row"*. |

### §8 Required tweaks: Discovery

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S68 | Rank using live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value | **NB** | `discoveryPde` ranks on taste, graph, behaviour and trails. The one live-ish input, `localMomentum`, is behind `discovery_ranking_modifiers_enabled` (`discoveryModifiers.ts:60`), which is **absent from production**. No live state, no forecast, no friction, no travel time reaches the ranker. |
| S69 | Keep search/retrieval truth separate from recommendation ranking; a quiet venue still exists in search | **BC** | `routes/discoverySearch.ts:1-35` is lexical/entity retrieval with visibility and block filters only; ranking lives in `lib/discoveryPde.ts` / `services/ranking/`. Two separate paths. |
| S70 | Server-built `DiscoveryCandidate` with why-now, why-for-user, confidence, freshness and truth class | **BW** | Reasons exist — `compass/CompassExplanationEngine.ts`, `rank_events.features` — but there is no DiscoveryCandidate projection and none of the five fields is carried as a contract. "Why-now" in particular has no producer (`grep -ri why_now\|whyNow` → nothing). |
| S71 | Strengthen Hidden Gems with behavioural evidence; create candidates, not automatic canonical gems | **BC** | `services/hiddenGems/HiddenGemContributionService.ts:1-12` — *"A contribution is an OBSERVATION … it never touches the gem's canonical status"*; state and confidence are derived at read time from `lib/hiddenGemState`. Candidacy is a real lifecycle: `status='pending'` → admin review → `active` (`HiddenGemModerationService.ts:198-206,265-283`). |
| S72 | Intent modes — Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip — on the same shared intelligence | **BW** | Nine modes exist (`compass/CompassIntentModeEngine.ts:1-22`) but the vocabulary is different (safety/arrival/creator/budget/private/plan_ahead), they are derived from `CompassContext` rather than from shared live intelligence, and Quiet / High Energy / Nearby / Right Now have no representation. |

### §9 Required tweaks: Wall

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S73 | Wall consumes meaningful state transitions, not repeated snapshots of unchanged state | **NB** | `grep -niE "transition\|warming\|heating\|peaking" services/wall/*.ts lib/wallProjection.ts` → nothing. The Wall consumes posts, shared moments and contextual opportunities; it has no transition concept. |
| S74 | Server-built `WallMoment` with subject, transition, occurred_at, relevance window, reason, truth class, freshness, expiry | **NB** | Absent. |
| S75 | Preserve Wall as chronological/current-life architecture; do not turn it into an opaque engagement-maximizing ranking feed | **BC** | The chronological lane is preserved by contract: `services/wall/FollowingFeedService.ts:1-14` — *"strict reverse-chronological … relevance reordering — there is NONE here, by contract"*. The For You lane is ranked but not opaque: `WallRankingService.ts:1-28` publishes the §14 term→signal mapping and wraps the canonical ranker rather than growing a second one. (Tension noted: the Wall does now carry a ranked surface at all.) |
| S76 | Live Now strip consumes current projections; chronological Wall records transitions/history; do not duplicate both | **BW** | Half built. The strip is exactly right — `LiveForYouService.ts:1-27`: reads only `readLiveClaimEnvelopes`, caps at 4 (`:69`), dedupes against the feed. The other half does not exist: the Wall records no transitions (S73). |
| S77 | Personalization controls whether a canonical world event matters to a user; it must not rewrite the world event | **BC** | `WallProjectionService.ts:5,306-310` projects canonical objects; personalization is selection and diversity (`WallDiversityService`, `WallCandidateLoaders`), never mutation of the projected object. |

### §10 Required tweaks: Compass and Home

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S78 | Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | **NB** | `grep -riE "GO_NOW\|go_now\|goNow\|switch_experience"` → nothing. Compass returns ranked items and nudges, not decisions. |
| S79 | Compass must ground natural-language claims in structured truth (low-confidence dance_likelihood cannot become "everyone is dancing") | **BW** | The *input* is structured and privacy-guarded (`compass/CompassStructuredContext.ts:1-20` — no coordinates, UGC delimiters, blocked users filtered) and `makeConfidence('ai_inference')` labels model output honestly (`routes/telegraph.ts:55-56`). But **nothing constrains the generated language to the confidence band of its inputs** — there is no grounding check on the model's claims, only a shape sanitizer (`routes/telegraph.ts:43-57`). |
| S80 | Current Experience value introduces switching cost | **NB** | `grep -riE "switchingCost\|switching_cost\|currentExperience"` → nothing. |
| S81 | Home consumes a server-assembled `UserNowProjection` / equivalent rather than the client querying many domains | **BC** | `routes/compassHome.ts:1-20` — one endpoint assembling bestNextMove, circleActivity, startingSoon, tonightVibe and weatherWindow server-side, with *"every section is backed by real data or omitted (null) — no template cards, no fabricated content"*. The client makes one call. |
| S82 | Home answers "what matters right now"; Compass answers "what should I do about it" | **BC** | Two distinct surfaces: `routes/compassHome.ts` versus `/compass/ask` (`routes/compass.ts`) with its own pipeline. |

### §11 Required tweaks: Trips and Layover

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S83 | `TripWorldContext` projection: current world state, nearby opportunities, disruptions, ExperienceSessions, crew context | **BW** | `compass/CompassTripContext.ts:1-18` is *trip grounding* — day N of M, today's plan items, tomorrow's count. No world state, no opportunities, no disruptions, no sessions. |
| S84 | World Intelligence may propose Trip changes but may not mutate canonical Trip plans; consequential changes pass through Trip Kernel | **BC** | No intel module writes any `trip_*` table; the intel lane's writes are enumerated in `2130:355-360` (grants) and none reaches trips. Trip mutation stays in `services/tripCrew/`, `routes/trips`. |
| S85 | Layover Temporal Freedom Engine intersects feasibility with live Experience value, forecast, friction and safe-return | **BW** | `services/airport/LayoverRecommendationService.ts` + `LayoverSafetyEngine.ts` do feasibility and safe-return. Neither reads `liveClaimRead` (`grep -rn liveClaimRead services/airport/` → nothing), so live experience value, forecast and friction are absent from the intersection. |
| S86 | Peak interception: can the user reach the experience before its useful window decays? | **NB** | No decay-window or interception arithmetic anywhere. |

### §12 Required tweaks: Telegraph

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S87 | Share canonical references to ExperienceState / Opportunity / WorldMoment / SafetyNotice rather than copying stale prose | **NB** | The one Telegraph surface is `POST /telegraph/recommend` (`routes/telegraph.ts:63`), which returns **model-generated prose** — title, reason, locationContext as free strings, with no canonical entity id (`sanitizeRec`, `:43-57`). This is the copied-prose shape the spec forbids. |
| S88 | Shared live objects may indicate that state changed since sharing | **NB** | No shared-object record exists, so nothing can carry a change indicator. |
| S89 `⌀` | Telegraph coordination may consume live intelligence but must not expose anonymous contributors | **BC** | Structurally impossible via the only read path: live envelopes carry *"decision-exposure fields only (no coordinates, contributor ids, or exact cohort counts)"* (`LiveForYouService.ts:18-20`), and `dataRights.ts:144` marks `intel_state_snapshots.distinct_actors` `restricted_no_redistribution`. Vacuous in the sense that Telegraph consumes no live intelligence today. |
| S90 `⌀` | Nearby & Available remains separate from anonymous contribution sensing | **BC** | Separate table family and separate code path: `2260_availability_windows.sql` and `services/rentBuddy/`, which read no intel table (`grep -rn "intel_observations\|liveClaimRead" services/rentBuddy/` → nothing). Vacuous in that anonymous contribution sensing does not exist. |

### §13 Required tweaks: Memories and Passport

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S91 `⌀` | Raw passive sensing must never automatically become Memory | **BC** | Memory is projected from an **enumerated** source set — canonical facts plus `compass_graph_edges` — by `project_all_memory()` (migrations 2184/2186), driven by `lib/memoryProjectionScheduler.ts:4-9`. There is no open ingest into memory. Vacuous in that no passive sensing exists to be excluded. |
| S92 | Bridge through ExperienceSession and outcome/significance eligibility | **BW** | Eligibility and decay exist (`memory_projections`, `memory_sweep_expired()`, `memoryProjectionScheduler.ts:7-9`), but the bridge is a graph-edge projection, not an ExperienceSession — because S54 does not exist. |
| S93 | Passport consumes meaningful visited/experienced outcomes, not raw movement logs | **BC** | `services/passport/PassportProjectionService.ts` and the stamp services project from canonical events and stamps; no passport service reads `location_snapshots`, `location_sessions` or `journey_observations`. |
| S94 | World Intelligence, personal Memory and social location remain separate retention/permission domains | **BC** | `locationPurposes.ts:102-314` — `intel_claim` (consent, derived, 180 d), `aggregate_live_state` (legitimate interest, aggregate, registry TTL), `live_session_sharing`, `journey_observation` (consent, precise, 24 h) and `derived_traveler_state` each carry their own basis, retention, visibility, deletion behaviour and separate-control flag. |

### §14 Required tweaks: Places, Events and Hidden Gems

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S95 | Do not bloat durable `places` rows with current_vibe / current_crowd / current_energy; keep dynamic state in projections | **BC** | `grep -rn "current_vibe\|current_crowd\|current_energy" src/` → **zero hits**, in TypeScript and in SQL. Dynamic state lives in `intel_state_snapshots` (`2130:283-308`) with its own TTL. |
| S96 | Events may expose runtime inferred/official phases, but source classes and truth classes remain distinct | **BC** | `mapProducers/eventContextProducer.ts:124` `eventPhaseAt` derives ongoing/upcoming/ended at read time; `event.status` is a separate contributor claim with its own source class; and the module keeps observed movement and inferred cause in different types (`crowdFlowProducer.ts:57-70`). |
| S97 | Temporary activity must not be forced onto the nearest place ID when ownership is unknown; never assign to the nearest place merely to satisfy a foreign key | **BC** | No nearest-place snapping exists (`grep -riE "nearest place\|nearestPlace\|snap to place"` → nothing). Transient activity is keyed on `zone_id` (a plain text field) and emitted as cell/edge geometry with no place row. |
| S98 | `HiddenGemCandidate` distinct from canonical Hidden Gem approval where the repo already separates candidates/review | **BC** | It does: `hidden_gems.status ∈ {pending, active, hidden, …}` with a real admin queue and duplicate-candidate scoring (`HiddenGemModerationService.ts:198-206,265-305`). |

### §15 Required tweaks: Search, Create and Attention

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S99 | Search can use live state as ranking context while preserving lexical/entity correctness | **BC** | `lib/inputAssistance/liveSuggestions.ts:1-11` attaches a freshness projection and *"nudges the entity's rank slightly via the §15 Freshness component. Nothing else about the suggestion changes"*; canonical entities always outrank `ai_suggestion`. Lexical correctness is owned separately by `dispatchSearch`. |
| S100 | Autocomplete may surface live/inferred suggestions but must label them as current intelligence, not durable metadata | **BC** | `liveSuggestions.ts:12-23` — *"A live label is NEVER manufactured … When live intelligence is off/stale/unavailable/unpromoted, that read returns [] and this attaches NO freshness"*. Eligibility is restricted to place/gem entities (`:24-31`). |
| S101 | Create content and structured intelligence observation must be separate commands; a post saying "dead" cannot mutate CrowdState | **BC** | Two commands: `lib/quickSignal.ts:1-12` maps a chosen option to a canonical claim server-side *"so the client never invents canonical vocabulary"*, reaching `intel_observations` via `IntelCaptureService`. Posts write `posts` and have no path to a claim. |
| S102 | Attention Engine is mandatory: world changes route through relevance, novelty, urgency, half-life, availability, interruption cost and attention budget before NOTIFY / WALL / SILENT / IGNORE | **NB** | No world change produces a notification at all (`grep -rn notif lib/intel*.ts services/intel/ lib/mapProducers/` → nothing). What exists instead is a ten-level notification priority stack with quiet hours and mutes (`compass/CompassNotificationEngine.ts:1-27`) plus dedup/throttle (`services/notifications/NotificationDeduplicationService.ts:16,59`) — a send/suppress filter, not an attention budget, and with no WALL routing option. |

### §16 Required tweaks: Safety and Trust

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S103 | World intelligence evidence/anomaly → SAFETY CANDIDATE → existing safety policy/review → canonical safety assertion | **BW** | The last two stages exist: `safetyNoticeProducer` projects only the already-specialist-reviewed `unsafe_density` claim, and refuses the tempting shortcut of projecting `protected_zones` (`:22-32`). The first two do not: there is **no anomaly detector and no candidate stage**, so nothing ever enters the pipeline. |
| S104 | Source reliability / signal reliability are not the same as person Trust Score | **BC** | `lib/intelScopedTrust.ts:9-22` — a per-scope calibration ledger *"named for what it is … not a ladder, not a public score"*, bridged into the one user-level trust engine as a `trust_events` row under an existing category rather than competing with it. (Liveness caveat: `intel_scoped_trust` (2278) is not in production.) |
| S105 `⌀` | Do not score a user as trustworthy because their passive movement looks "normal" | **BC** | Scoped-trust updates derive from outcome attributions (`intelScopedTrust.ts:26`, `intelOutcomes.ts:1-22` — outcomes are canonical_events with a claim/snapshot envelope), never from movement. `PresenceVerifier` output affects a claim's confidence, not the actor's trust. Vacuous in that passive movement does not exist. |

### §17 Required tweaks: Presence, Rent-a-Buddy, Locate My Friends

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S106 | Shared platform Presence architecture keeping private device / aggregate intelligence / social / trip crew / buddy / public discovery classes distinct | **BW** | The architecture is *declared* and is good — `presence/domain/types.ts:19-52`: a seven-rung precision ladder, `narrowestPrecision` with *"deliberately no `widen` counterpart"*, and per-feature ceilings (`crowd_intelligence: 'presence_only'`, `crew: 'precise'`). But it has no store and no fusion layer (`crowdFlowProducer.ts:388`), only `locateFriends` consumes it, and four other presence models run alongside it (S3). |
| S107 | Reuse low-level sensor/proximity infrastructure where possible, not consent/policy semantics | **BC** | `presence/domain/transport.ts:1-17` is interface-only *"so a transport can be added, swapped, or absent without a feature noticing"*, with `CURRENT_STACK_CAPABILITIES` (`types.ts:148`) stating truthfully that BLE does not exist. Consent stays per-purpose in `locationPurposes.ts`. |
| S108 | LMF may use identity/relay/checkpoints under group permissions; anonymous World Intelligence may not reverse-resolve contributors | **BC** | `lib/locateFriendsSession.ts:60,75` takes its ceiling from `FEATURE_PRECISION_CEILING` rather than re-declaring one (pinned by `test/locateFriendsSession.test.ts:443`). Reverse resolution is blocked on the intel side by envelopes carrying no contributor id and `dataRights.ts:144`. |
| S109 | RAB may consume public/aggregate area intelligence and authorized Buddy presence, but never infer or expose individual anonymous contributors | **BC** | RAB reads no intel table at all (`grep -rn "intel_observations\|intel_state_snapshots\|liveClaimRead" services/rentBuddy/ routes/rentABuddy*.ts` → nothing); the Wall's RAB producer goes through the master gate `services/wall/wallRabGate.ts`. |

### §18 Required platform tweaks

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S110 | Shared temporal semantics: observed_at, effective_from, effective_until, expires_at, freshness, predicted_for | **BW** | Four of six. `observed_at`, `expires_at` (plus `hard_expires_at`) and `captured_at`/`received_at` on `2130:172-179`; `freshness` as a derived state (`mapObjects.ts:121`). **`effective_from`, `effective_until` and `predicted_for` do not exist** — which is why a forecast has no horizon (S45). |
| S111 | Entity reconciliation: observed cluster → Place? Event? Temporary world object? Unknown? | **BW** | Two of four outcomes are representable. `subject_id` is `NOT NULL REFERENCES places(id)` (`2130:142`), so an activity cluster whose owner is **unknown** cannot be stored at all, and there is no temporary-world-object subject class. The prohibition half is honoured (S97); the reconciliation half is not built. |
| S112 | Revocation / lineage: define what revocation removes, expires, prevents and may retain as genuinely de-identified aggregate | **BW** | The first link is exemplary: `erase_intel_for_actor()` (`2130:398-455`) is a single narrow SECURITY DEFINER path, and `2130:449-452` states the retention decision explicitly — derived claims and snapshots survive because *"Deleting them here would destroy other people's contributions"*. The chain past that is undefined because the stages do not exist, and `2130:452` defers recomputation-after-erasure to *"IG-04's responsibility"*. |

### §19 Suggested logical contracts

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S113 | `ExperienceOutcome`: result / calibration / optional feedback | **BW** | `lib/intelOutcomes.ts:1-22` maps outcomes onto `canonical_events` with an exact `payload.intel` envelope, and `intelCalibrationScheduler.ts:1-12` runs a read-only daily calibration report. But the attribution table it feeds (`intel_attributions`, 2277) **is not in production**, and there is no ExperienceSession for an outcome to close. |

### §20 Failure semantics and invariants

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S114 | Schema/permission/infrastructure failure ≠ no activity | **BC** | Refusals are typed and distinguishable everywhere: `crowdFlowProducer.ts:1055` (`SignalReadRefusal` + `familyRefusals`), `intelRetentionScheduler.ts:47-56` (*"an error and a disabled flag both used to return `{purged:0, skipped:true}`, which made a persistently failing sweep indistinguishable from one nobody had switched on"*), `discoveryServePointReport.ts`. |
| S115 | Expired/stale state ≠ current | **BC** | `intel_state_snapshots.expires_at NOT NULL` (`2130:300`) with the reader filtering on it; `MIN_BAND_FOR_LIVE_STATE` (`intelContracts.ts:444`); `FRESHNESS_THRESHOLDS_SECONDS` (`mapObjects.ts:138`); `mayRenderAsLive` (`:126`). |
| S116 | Inference confidence may only decrease through conflict unless new evidence supports an increase | **BC** | `mapAggregation.ts:438-455` takes the **weakest** contributing band and treats a missing band as the weakest — *"silence must not be read as agreement"*; `mapProjection.ts:665-670` — *"a claim can only ever ADD … never overwrite a value the source already asserted with a weaker one"*; conflict caps via `intelConflict.capForConflict` / `MATERIAL_CONFLICT_BAND_CEILING`. (Liveness caveat: the `conflict_state` column comes from 2275, not in production.) |
| S117 | No product surface may fabricate world state to make UI look complete | **BC** | `liveSuggestions.ts:12-19` (no manufactured labels), `LiveForYouService.ts:14-18` (no stale labels, `[]` when not servable), `routes/compassHome.ts:12-14` (*"every section is backed by real data or omitted (null)"*), `worldPulseProducer.ts:47-52` (a sub-k cell and an empty cell serialize byte-identically). |
| S118 | Anonymous intelligence may not be reverse-linked to a Portava account | **BW** | The *published* side is right — aggregates are k-gated and carry no contributor id. The *stored* side fails the §24 checklist item outright: every contribution carries `actor_id uuid NOT NULL REFERENCES public.profiles(id)` (`2130:142`), so the store resolves a contribution to an account trivially, by design. |
| S119 | All consequential canonical mutations use existing command/service/RLS patterns, not client direct writes | **BC** | `2130:352-372` — `authenticated` gets `SELECT` on own rows only and nothing at all on derived state; `intel_state_snapshots` is `service_role` only; the two policies are `USING (actor_id = auth.uid())`. Ratcheted by `scripts/checkSilentSupabaseWrites.ts` and `scripts/rlsDispositions.ts`. |

### §21 Incremental implementation sequence

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S120 | S0: produce a reuse map inventorying consent, contribution, device/session, map projections, intel storage, Wall, Discovery, Compass, schedulers, RLS, outbox and flags | **NB** | No S0 artifact exists **for this spec**. `docs/intelligence-gathering-buildout.md` is the equivalent artifact for the *Intelligence Gathering* spec. (`docs/architecture/sensing-surface-inventory.md` and `intel-spine-liveness.md` were written by sibling agents **during this session, 2026-09-07**, after the tree under census; both state explicitly that no spec was available to them.) |
| S121 | S11: run forecast/vibe in shadow mode and calibrate before aggressive surfacing | **BC** | The discipline is real and repo-wide: `intelCalibrationScheduler.ts:1-12` — a read-only daily report that *"can never certify the gate while any input is uninstrumented … not a green light"*; `lib/qiuShadow.ts`, `lib/discoveryShadow.ts`; per-scope promotion via `intel_live_promoted_scopes`, which has **no writer anywhere** and is documented as a deliberately empty human allowlist (`scripts/checkWriterlessReads.ts:172-181`). |

### §22 PR / repo safety strategy

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S122 | Additive migrations with postconditions; no destructive migration unless separately reviewed | **BC** | Every intel migration read here opens with preconditions and closes with `DO $$ … RAISE EXCEPTION 'POSTCONDITION FAILED'` (`2130:24-64`, `:457-480`; `2295:86-96`). Ratcheted by `scripts/certifyMigrations.ts` and `scripts/checkMigrationLedger.ts`. |
| S123 | Every new server contract gets positive tests, RLS/authz negatives, stale/unknown cases and malformed input cases | **BC** | 40+ intel test files (`src/test/intel*.test.ts`, `crowdFlowProducer.test.ts`, `mapWorldIntelligenceLayer.test.ts`, `crossSystemPrivacy.test.ts`) plus `scripts/rlsDispositions.ts` and `scripts/checkAuthorizationContract.ts` as the authz-negative ratchets. |
| S124 | Use static ratchets for forbidden direct writes, identity joins or bad literals | **BC** | Roughly forty `src/scripts/check*.ts` ratchets, including `checkSilentSupabaseWrites`, `checkWriterlessReads`, `checkEnumLiterals`, `checkNotNullWrites`, `checkLocationPurposes`, `checkDataRights`, `checkSchemaReferences`. |
| S125 | Mutation-prove: no permanent identity link, no single-device crowd, no prediction-as-observation, no anomaly-as-safety, no client-computed vibe | **BW** | Three of five are mutation-proven (`crowdFlowProducer.test.ts` walks serialized output for sentinel actor ids; `privacyGate` k-floor tests; client `freshnessDisplay.test.ts`). **"No permanent identity link" cannot be proven because the link exists** (S19), and "no client-computed vibe" has no vibe to compute (S42). |
| S126 | Feature flags allow shadow/read-only rollout; do not claim LIVE until gate, schema, policy, scheduler, data dependency and production path are satisfied | **BC** | The *mechanism* is exemplary — `2295:93-95` makes it a postcondition failure to seed the flag ON, `check-flag-polarity` classifies every non-`_enabled` flag, and `intelLiveScope` requires per-scope promotion after a density gate. Note the finding this does **not** prevent: `sensing-surface-inventory.md` measured `intel_capture_quick_signal`, `intel_claim_projection_crowd` and `intel_rewards` all TRUE in production against tables that hold zero rows, and four schedulers running against tables that do not exist in production. The rule is built; it was overridden operationally. |

### §24 Developer completion checklist

| id | Requirement | V | Evidence / divergence |
|---|---|---|---|
| S127 | Location contribution and social live-location permissions are separate | **BC** | Four independent controls, each `requiresSeparateControl: true` in `locationPurposes.ts`: `intel_contribution_consent` (2172), `route_flow_contribution_consent`, `user_location_preferences.journey_observation_enabled` (`locationPurposes.ts:266`), and `live_session_sharing` (`:116`). |

---

## PR #475 delta — the only sensing-attributable work that exists

`0597a245` is **not in HEAD** and none of its files is in the worktree, so it contributes nothing
to the numbers above. Read from the ref (`git show pr/475:<path>`), it is real and well-built:
`sensing_anon_contributions` has **zero foreign keys of any kind**, `expires_at NOT NULL` with
`CHECK (expires_at <= created_at + interval '72 hours')` so a long-lived row is unrepresentable,
a server-peppered rotating `contributor_token` per `rotation_epoch`, an ordinal `signal_bucket`
with no `value`/`claim_type`/free text, and three apply-time postconditions that fail the
migration if a FK, an account-shaped column name, or a lifecycle column name appears
(`pr/475:src/migrations/2315_sensing_anon_contributions.sql:107-193, :302-400`).

**If it were merged and applied**, it would move exactly four verdicts, and would not move CORRECT%
by much:

| id | Now | With #475 | Why |
|---|---|---|---|
| S18 rotating contribution ids | NB | **BC** | `sensingAnonStore.ts:38-55` — epoch secret → commitment → server-peppered token; stable within an epoch, unlinkable across. |
| S19 no permanent user FK | BW | BW (unchanged) | The store carries no FK, but `intel_observations.actor_id` is untouched and remains the only contribution table with a writer. The ruling permits both to coexist. |
| S26 raw retention short | BW | **BC** for the anon store | 72 h structural cap. Unchanged for `intel_observations`. |
| S112 revocation/lineage | BW | BW (improved) | `purge_sensing_contributions_for_token()` proves ownership cryptographically without an identity — a genuinely new capability — but the lineage past aggregate still has no stages. |

Net: **+2 BC, −2 NB** → CORRECT% 67/127 = 52.8 %, CONSTRUCTED% unchanged at 81.9 %,
spec-attributable CORRECT% = **2/127 = 1.6 %**.

`docs/architecture/sensing-input-gap.md` enumerates the thirteen layers between a device and a
stored anonymous contribution and finds **none of layers 1–8 exists**: no device secret custody,
no client hash primitive, no reduction pipeline, no HTTP route (ingest, revoke or read), no auth
posture decision, no abuse budget that is not keyed on an identity, no `groupTag` producer, no
feature flag, no scheduler calling the TTL sweep, and no consumer of a cohort aggregate. That is
why the delta is two rows and not twenty.

---

## Why I disagree with 56.4 % / 32.1 %

I cannot reproduce those numbers and neither can anyone else — no denominator, no requirement
list, no citations were recorded, and `sensing-surface-inventory.md` says the same independently.
Reconstructing backwards from the commit message (35 items counted implemented, CORRECT 32.1 %)
implies a denominator near **109** and roughly 62 constructed. Mine is 127 / 104 / 65. So the
disagreement is not mainly about the denominator — it is about **19 requirements' worth of
verdicts**.

The three places I believe the old number was too harsh:

1. **It appears not to have credited the prohibition-style requirements.** §2, §16, §20 and much
   of §7 are things the system must *never* do, and Portava's map and intel layers enforce a
   striking number of them structurally — cause hypotheses that cannot carry a count, a freshness
   function gated on source class rather than timestamp, a crowd level that maps to `null`
   activity, an empty cell and a sub-k cell that serialize byte-identically. Twenty-three of my 65
   BUILT-AND-CORRECT verdicts are prohibitions with a real enforcing artifact.

2. **It appears to have scored the surface sections against the spec's vocabulary rather than its
   responsibilities**, when §19 explicitly says the names *"describe responsibilities"* and warns
   against blind materialisation. `ExperienceState` does not exist and I scored that NOT-BUILT —
   but "Home consumes a server-assembled projection rather than the client querying many domains"
   is satisfied by `compassHome`, and "HiddenGemCandidate distinct from approval" is satisfied by
   `hidden_gems.status`, and those are the requirement, not the noun.

3. **It counted 35 items and I count 65 — but it also counted the same machinery.** The gap is
   mostly items 1 and 2, not a disagreement about `crowdFlowProducer` or `privacyGate`.

Where I agree with it completely, and would put more weight on than either percentage:

- **Attribution is zero.** Not one artifact in the tree cites this spec. Every correct verdict is
  work done for the Intelligence Gathering, Map, Wall, Input-Intelligence or Presence programmes.
- **The real gap is the input layer**, and that judgement survives my higher number intact:
  the sensing input + inference core scores **22.6 % correct**, and §4.1's device boundary,
  §4.2's contribution session, §5.2's Vibe inference, §5.3's ExperienceState and §5.4's
  ExperienceSession are all NOT-BUILT with nothing partial behind them.
- **`intel_observations.actor_id NOT NULL REFERENCES profiles(id)` is the spec's named
  prohibition, violated by the only contribution table with a writer.** Both S19 and S118 turn on
  that one line.

And one thing neither number said, which I would put above both of them: **the machinery that the
correct column counts has, in production, never produced a row.**

---

## What could not be verified, and why

Only **one** requirement is CANNOT-VERIFY as a requirement:

| id | Requirement | Why it cannot be settled from the tree |
|---|---|---|
| **S17** | TLS in transit and encrypted storage at rest | `app.ts:25` sets security headers via `helmet()`, but TLS termination, HSTS enforcement and Supabase's at-rest encryption are properties of the deployment and the managed platform. Nothing in the repository can prove or disprove them. Settling it needs the hosting configuration and the Supabase project settings, not a file. |

Beyond that single requirement, **eleven verdicts are code-correct but carry an unresolved
production-data or production-schema caveat**. These are *not* folded into CANNOT-VERIFY — the
code question is settled — but the effect of the code is not:

| Verdict | What is unresolved | What would settle it |
|---|---|---|
| S22 sensitive-location suppression (BC) | `protected_zones` ships empty by design; the correct gate currently suppresses nothing | a production row count of `protected_zones` |
| S13, S23, S37 privacy/independence gates (BC) | never exercised — all intel tables hold zero rows | any production observation |
| S41 flow engine (BC) | `route_flow_contribution_consent` has no writer and no opt-in endpoint, and `MIN_SIGNAL_FAMILIES = 2` with only two families wired, so `crowd_flow` cannot publish today (`checkWriterlessReads.ts:181-190`) | a privacy-policy decision, then an opt-in surface |
| S104 scoped trust, S113 ExperienceOutcome (BC/BW) | target `intel_scoped_trust` (2278) and `intel_attributions` (2277), **absent from production** | applying 2277–2279, or removing the schedulers |
| S116 confidence monotonicity (BC) | the conflict cap reads `conflict_state` from 2275, **absent from production** | applying 2275 |
| S121 shadow calibration (BC) | `intel_calibration_report` flag is absent from production; the daily report never runs there | seeding the flag |
| S126 flag discipline (BC) | the mechanism is right and was overridden: three flags are TRUE in production against migrations that seed them false | an operator record of who flipped them |
| S1, S2 no-second-store (BC) | verified against the migration chain, which declares 15 `intel_*` tables where production has 10 | reconciling CI and production schema |

Three structural limits on this census, stated so a re-run can improve on them:

1. **Static writer attribution is incomplete, by the repo's own analyzer's admission.**
   `scripts/checkWriterlessReads.ts:39-41`: *"A dynamic `.from(expr)` anywhere makes attribution
   incomplete, and the run says so rather than pretending otherwise."* Every "nothing writes X" or
   "nothing reads X" claim here inherits that caveat. A `from("table")` grep misses variable and
   RPC access — I used it only to *find* candidates, never to conclude absence without also
   reading the module.

2. **Client-side behaviour is asserted from code, not from a device.** S57 (clients compute no
   world truth) and S28/S29 (no device sensing) were established by reading
   `travel-buddy-standalone/src` and its dependency manifest. A native module reached through a
   dynamic import from a path I did not open would not appear.

3. **No database was queried by me.** Production facts in this document come from the supplied
   ground truth and from the two sibling documents that did measure it
   (`intel-spine-liveness.md`, `sensing-surface-inventory.md`). Where those two disagree with a
   migration's seed value, they win — a migration file is not evidence of live state.
