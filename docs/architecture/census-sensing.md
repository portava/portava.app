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

## Declaration

| Field | Value |
|---|---|
| `head_commit` | `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. Its verdicts were taken at a pre-squash working tree that **exists nowhere**: verified against FULL history (`git fetch --unshallow`, 4,300 commits, then `git cat-file -e`), not assumed — a shallow clone had made every such commit look unresolvable for the wrong reason. So nobody can diff that tree against `42aeac38`, and this declaration **does not claim that interval was empty**. What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the paths in `CENSUS_SCOPE` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED — the weakest of the three states, not the safest. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. Declared by the Trips lane while recounting the sibling census; if this lane disagrees, reverting costs only the check. |
| **Note specific to this census** | This document's own CORRECTION HEADER records that it was **already stale when it was committed** — `lib/sensingAnonStore.ts` landed two minutes before it. That file is the first path in this census's scope, so the very defect the header describes by hand is now the one a machine would catch. |
| **§1 (2026-09-12, the Sensing lane)** | The first pass that re-derived rows against the code. `head_commit` stays `42aeac38`: a commit on `claude/sensing-lane` would be an ancestor of nothing once squashed (handoff §0, trap 1), so the files §1 added and the one counted file that changed are acknowledged in `CENSUS_STALENESS_ACKNOWLEDGED.json` against `42aeac38`, per file, and the scope was widened from 85 to the files §1 cites. FRESH after this still means *no counted file has moved since `42aeac38`* — and, for the twenty-eight rows §1 names, that they were re-read on 2026-09-12. |

---

## Headline

| Measure | Value |
|---|---|
| **Denominator — testable requirements** | **127** |
| BUILT-AND-CORRECT | **87** |
| BUILT-BUT-WRONG | **34** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (C+W)/127 | **121 / 127 = 95.3 %** |
| **CORRECT%** (raw) = C/127 | **87 / 127 = 68.5 %** |
| **CORRECT% (spec-attributable)** | **22 of the 87 — 17.3 %** |

> **RESTATED 2026-09-12 (§1): 65 → 77 CORRECT, 39 → 36 WRONG, 22 → 13
> NOT-BUILT. CONSTRUCTED 81.9 % → 89.0 %, CORRECT 51.2 % → 60.6 %.** §1 is the
> first pass to read a verdict in this document against the code. It executed
> the anonymous store on a database (13 cases, two rollback rehearsals) and
> re-derived twenty-eight rows under the bar `census-trips.md` §40 set: twelve
> move into C — the Map behind migration 2350's three FALSE flags, the Wall's
> §5.1 vocabulary, the Experience fold, the mutation-proof list, the S0 map,
> and one prohibition — five move N → W, and thirteen built, tested,
> mutation-proven, database-executed rows on the anonymous ingest path are
> graded **W** because nothing may reach them until the owner decides
> `SENSING_AUTH_POSTURE`. The CORRECTION HEADER's 78 and 83 were counted under
> this document's looser original convention and were never re-derived; this
> is the like-for-like figure under the stricter one. Every verdict moved was
> watched go red under a mutation named beside it. Nothing here is deployed,
> enabled or production-realised: production still holds no sensing table
> and zero rows in every intel table.

> **RESTATED 2026-09-12 (§2): 77 → 80 CORRECT, 13 → 10 NOT-BUILT. CONSTRUCTED
> 89.0 % → 91.3 %, CORRECT 60.6 % → 63.0 %.** §2 is the first section that
> BUILDS rather than re-reads: §10's decision (GO NOW · GO SOON · WAIT · STAY
> · SWITCH · SKIP · RETURN), the switching cost of the current experience and
> §11's peak interception, as a pure engine over the one live read path and a
> route behind `compass_decision_enabled` (2800, seeded FALSE). Three N rows
> into C, S79 re-derived and held; twelve mutations and one database
> rehearsal red then green. Same caveat: built on a branch, not merged, the
> flag the owner's, and nothing to decide on in production while every intel
> table holds zero rows.

> **RESTATED 2026-09-12 (§3): 80 → 84 CORRECT, 36 → 35 WRONG, 10 → 7 NOT-BUILT.
> CONSTRUCTED 91.3 % → 94.5 %, CORRECT 63.0 % → 66.1 %.** §3 builds §9's
> WallMoment — a transition between the current live claim and the
> projection's own previous version, never a repeated snapshot — and §15's
> Attention Engine, which every moment the new Wall route serves passes
> through (relevance, novelty, urgency, half-life, availability,
> interruption cost, attention budget → NOTIFY / WALL / SILENT / IGNORE),
> behind `wall_enabled` and `wall_moments_enabled` (2801, seeded FALSE).
> S73, S74, S102 N → C and S76 W → C; thirteen mutations and one database
> rehearsal red then green. NOTIFY is a routing decision on the wire; no
> dispatcher consumes it, and the section says so. Same caveat as before.

> **RESTATED 2026-09-12 (§4): 84 → 86 CORRECT, 35 WRONG unchanged, 7 → 5 NOT-BUILT.
> CONSTRUCTED 94.5 % → 95.3 %, CORRECT 66.1 % → 67.7 %.** §4 builds §12: a
> conversation shares a CANONICAL REFERENCE to a server-built live object —
> subject, kind, snapshot id, version id, value at share time, truth block,
> and a human line that carries no value — as one `messages` card, and a
> shared reference resolves against the current state with
> `changedSinceShare` on the answer (NULL, never false, when the state cannot
> be read), behind `telegraph_live_references_enabled` (2802, seeded FALSE).
> S87, S88 N → C; S89's vacuity lifted (five `⌀` rows now, strict reading
> 81 / 127 = 63.8 %). Eighteen mutations and one database rehearsal red then
> green. Opportunity is refused as a kind by name because S56 has no object.
> Same caveat as before.

> **RESTATED 2026-09-12 (§5): 86 → 87 CORRECT, 35 → 34 WRONG, 5 NOT-BUILT unchanged.
> CONSTRUCTED 95.3 % unchanged, CORRECT 67.7 % → 68.5 %.** §5 builds §16's
> two missing stages: an anomaly detector over served envelopes and the
> projection's own record (density rising past capacity, material conflict
> at capacity, a rapid density rise; the assertion itself never a
> candidate), filing each new candidate into the EXISTING review queue —
> a `moderation_reports` row, place / safety_concern, no reporter — behind
> `intel_safety_candidates_enabled` (2803, seeded FALSE) and requireAdmin.
> S103 W → C. Eighteen mutations and one database rehearsal red then green.
> Operator-triggered, not scheduled; asserts nothing. Same caveat as before.

**I disagree with commit `0597a245`'s CONSTRUCTED 56.4 % / CORRECT 32.1 %.** I land materially
higher on both — roughly +25 points constructed and +19 points correct. I agree exactly with its
attribution finding: **zero** implemented items are attributable to this specification.

Two sub-scores matter more than the headline and are given because the headline is misleading on
its own:

| Sub-score | Denominator | CONSTRUCTED | CORRECT |
|---|---|---|---|
| **Sensing input + inference core** (§3, §4, and the Vibe/Experience/Forecast/Opportunity/Session engines: S17–S38, S42–S46, S51–S54) | 31 | 87.1 % (was 64.5 %) | **35.5 %** (was 22.6 %) |
| Everything else (invariants, reuse directives, surface integration) | 96 | 99.0 % (was 87.5 %) | 79.2 % (was 60.4 %) |

The high headline is a property of the specification, not a compliment to the tree. This spec is
titled *UPGRADE, DO NOT REBUILD*; §19 says outright *"Do Not Blindly Materialize"*; and a large
fraction of its testable content is **prohibitions and reuse directives** that Portava's
pre-existing intel and map work already satisfies with unusual care. Score the part of the spec
that asks for something *new* — a device sensing boundary, a privacy-reduced ingest, Vibe
inference, ExperienceState, ExperienceSession — and the correct column falls to 35.5 % (22.6 % before §1).

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
it guards is empty): S90, S91, S105, S22, and — since §1 — S9. They are flagged `⌀` in the
table or in §1.3; S89 carried the mark until §4 gave Telegraph a real live-intelligence consumer
and pinned that it exposes no contributor. A reader who rejects vacuous satisfaction should
subtract them: CORRECT% becomes **82 of 127 = 64.6 %** (60 of 127 = 47.2 % before §1).

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

---

## 1. The rows the tree had already earned, re-derived — and the anonymous store executed

**Read against the branch `claude/sensing-lane` (from `802fee52` on
`claude/sweet-fermat-fmx7up`), 2026-09-12, by the Sensing lane.** This is the
first pass that has read a verdict in this document against the code. The
CORRECTION HEADER above records that the tree had moved before the body was
committed and that a later "completion pass" recomputed **78** and then **83**
BUILT-AND-CORRECT without editing a row. Those figures were sentences about
the objects; none of them was re-derived, and they were counted under this
document's original convention — *"code that is correct and would run"*. This
section re-derives every row that convention would have moved, and one
cluster of rows it never looked at (the Map behind migration 2350, the
Discovery candidate behind 2361, the Wall's §5.1 vocabulary), and grades them
under the bar `census-trips.md` §40 states and every Trips section since has
held to:

> a row is **C** when the thing it names is built, pinned by a test that was
> watched go red under a mutation of the code it pins, and **reached** — from a
> registered surface (behind a flag seeded FALSE is fine), from a registered
> scheduler, or, for a prohibition, by an artifact that refuses the violation.
> A row whose thing is built, tested and mutation-proven but reached by
> **nothing**, and cannot be reached without an owner decision, is **W** with
> that stated — exactly as Trips graded TR334, TR342 and TR416.

That bar is stricter than the one the body used, which is why this section
lands at **77** and not 83: the anonymous ingest path (store → policy →
session → aggregate → presence / vibe / differencing / lineage) is built end to
end, proven on a database below, and reached by nothing on both ends — no
route may write it and no surface may read an aggregate until the owner
decides `SENSING_AUTH_POSTURE`
(`docs/architecture/sensing-auth-posture-decision.md`, decisions #1, #2 and
#9 of `sensing-input-gap.md` §3.2). Thirteen rows on that path are graded **W**
here with that reason, twelve of which the completion pass had called C. Every
mutation named below was applied to a backup-restored file and the suite run
red and then green; the two database rehearsals are apply → rollback → red →
apply → green on the lane's own replica (`portava_sensing`), never on
portava-ci and never on production.

### 1.1 What was built, and where

- **The anonymous store, executed** —
  `test/db/sensingAnonStore.db.test.ts:130#foreign` runs 2315, 2340 and 2480
  on the local replica as the roles the grants name. The catalog holds no
  foreign key and no identity-shaped column and RLS is on with no user policy
  (`migrations/2315_sensing_anon_contributions.sql:343#installation_id`); a
  user role cannot read the table and service_role cannot UPDATE a row
  (`test/db/sensingAnonStore.db.test.ts:140#UPDATE`;
  `migrations/2340_sensing_anon_replay_and_time_bounds.sql:137#service_role`);
  a row past 72 hours is unrepresentable
  (`migrations/2315_sensing_anon_contributions.sql:171#sensing_anon_contributions_ttl_check`).
  A replay of one (cohort, contributor) is a unique violation on exactly the
  replay index and the second row never exists
  (`test/db/sensingAnonStore.db.test.ts:164#replay`;
  `migrations/2340_sensing_anon_replay_and_time_bounds.sql:107#sensing_anon_contributions_replay_idx`);
  forty writes from one device are one row, and the aggregate over what the
  database returned is one contributor, below k
  (`test/db/sensingAnonStore.db.test.ts:174#forty`). A bucket two minutes
  ahead of, or 73 hours behind, its `created_at` is a check violation and the
  edge of the window is accepted
  (`test/db/sensingAnonStore.db.test.ts:189#bucket`;
  `migrations/2340_sensing_anon_replay_and_time_bounds.sql:123#sensing_anon_contributions_time_bounds_check`).
  One device in two epochs is two unrelated tokens — the device folds the
  epoch into its secret and the server folds it into the token, each pinned on
  its own (`test/db/sensingAnonStore.db.test.ts:216#oneCommitment`;
  `lib/sensingAnonStore.ts:192#deriveEpochSecret(`;
  `lib/sensingAnonStore.ts:211#deriveContributorToken(`) — and revealing one
  epoch's secret revokes that epoch only, through the SQL function that sees an
  epoch and a token and nothing else
  (`test/db/sensingAnonStore.db.test.ts:205#epochs`;
  `migrations/2315_sensing_anon_contributions.sql:239#revoke_sensing_contributions(`);
  both functions refuse `authenticated`
  (`test/db/sensingAnonStore.db.test.ts:237#service_role`). The purge takes its
  instant and a second pass deletes nothing
  (`test/db/sensingAnonStore.db.test.ts:246#purge`;
  `migrations/2315_sensing_anon_contributions.sql:216#purge_expired_sensing_contributions(`).
  Then the part no unit suite could do: **k** contributors in six parties
  written fifteen minutes ago, read back from the database, clear the real
  privacy gate, and k − 1 do not; the presence state built from the real
  aggregate is `observed` with an unlabelled ordinal and `few` coverage at k
  and `unknown` on every axis below it, and nothing the database returned
  appears in it (`test/db/sensingAnonStore.db.test.ts:260#privacy`;
  `lib/sensingCoverageAggregate.ts:154#aggregateSensingCohort(`;
  `lib/sensingPresenceState.ts:133#buildSensingPresenceState(`); one more
  contributor is not a new publication and the previous value is served
  (`test/db/sensingAnonStore.db.test.ts:316#evaluateDifferencing(agg,`); the
  in-memory revocation model predicts exactly what the SQL function does to a
  fresh read (`test/db/sensingAnonStore.db.test.ts:326#modelSensingRevocation(readCohort(cohortKey),`);
  fifteen contributors with no party tag earn no group credit on the database
  either (`test/db/sensingAnonStore.db.test.ts:336#derived,`). And 2480's
  sessions: a session stores only the bearer's HMAC, its budget is consumed
  atomically in SQL and refused at zero, `unknown` / `not_started` / `expired`
  / `revoked` are told apart, UPDATE is not a path, and the purge removes the
  revoked and the expired (`test/db/sensingAnonStore.db.test.ts:356#budget`;
  `migrations/2480_sensing_contribution_sessions.sql:126#sensing_session_consume(`);
  a scope outside §3's seven verbs and a lifetime past 72 hours are check
  violations, and the contribution store carries no session column
  (`test/db/sensingAnonStore.db.test.ts:403#seven`;
  `migrations/2480_sensing_contribution_sessions.sql:113#sensing_contribution_sessions_scopes_check`).
  The replica carries 2481 because the harness replays every file, so a
  session row names an issuing profile there and an anonymous one is
  unrepresentable — the harness's state, recorded as such, not a posture
  decision. **Rehearsed:** `db/rollback/2026-09-07-2340-sensing-anon-replay-and-time-bounds-rollback.sql`
  applied → the replay, one-device and time-bounds cases red (3) → 2340
  re-applied → 13 / 13; `db/rollback/2026-09-07-2481-sensing-sessions-option-a-issuer-rollback.sql`
  then `db/rollback/2026-09-07-2480-sensing-contribution-sessions-rollback.sql`
  applied → the two session cases red → 2480 and 2481 re-applied → 13 / 13.
  The suite cleans both tables and its seeded profile after itself (0 rows
  either side, measured).
- **Two pins no suite held** — `test/sensingCensusRederivation.test.ts:32#server`
  pins the server-side epoch fold separately from the device-side one: the
  first mutation of the server fold stayed **green** (46 / 46) because the
  device layer already rotates the commitment, so the layer was unpinned and
  is now pinned on its own; `test/sensingCensusRederivation.test.ts:50#viewer,`
  pins that the Map's Experience fold names no viewer, user, profile,
  preference or taste and that a preference-shaped field on its input changes
  nothing in the state.
- **The S0 map's summary, corrected** —
  `docs/architecture/sensing-s0-reuse-map.md:220#CORRECTION`: the §13 table
  counts five contracts truly missing, six reusable or extendable and one
  blocked; the sentence beneath it said four / five / three, and two of its
  rows name the wrong object (recorded beside them, not rewritten).

### 1.2 What was re-derived, row by row

**(a) The anonymous path — built end to end, proven on the database, reached by nothing until the owner decides.**
`lib/sensingAuthPosture.ts:54#undecided` is the owner's switch and
`lib/sensingAuthPosture.ts:90#sensingEligibility(` refuses every caller while
it reads that; `test/sensingAnonStore.test.ts:501#route` asserts no route
touches the store. So: **S18** (rotating identifiers, N → W): the derivation
exists at two layers and is executed on the database; no writer is registered.
**S20** (eligibility separated from ingest; opaque credential, N → W): the
separation is code — eligibility in one module, the credential in another
(`lib/sensingContributionSession.ts:98#buildSensingSessionRow(`), the row
shape in 2480 with no identity column — and it admits nobody. **S30**
(`IntelligenceContributionSession`, N → W): all eight §4.2 properties are
bound to the primitive that owns each
(`lib/sensingContributionPolicy.ts:66#CONTRIBUTION_PURPOSE_SCOPES`) and the
issued half is a table with a budget consumed in SQL; nothing issues one.
**S25** (seven distinct permissions, W → W): the verbs are distinct in the
policy, in the session row's scope CHECK and in admission
(`lib/sensingContributionPolicy.ts:275#scope_not_granted`), and the ingest
that would enforce them does not exist; the intel human-claim consent stays
one boolean by design. **S33** (replay and rate limit per credential, W → W):
both now keyed on the credential, not the account — the replay index and the
session budget, both executed — and the ingest they guard is the owner's.
**S35** (impossible timestamps, malformed precision, invalid scopes, stale
credentials, W → W): all four rejections exist and three are executed on the
database (`lib/sensingAnonStore.ts:376#observed_at_in_future`;
`lib/sensingContributionSession.ts:141#validateSensingSession(`); the row's
"two of the four are unimplementable" no longer holds, and the ingest does
not. **S39** (Presence engine → aggregate + coverage, W → W): the engine
builds an observed / unknown state from the real gate's decision, names no
person (`lib/sensingPresenceState.ts:69#presence:`), and no surface consumes
it (decision #9). **S24** (anti-differencing, W → W): the control the row
called absent exists (`lib/sensingDifferencingGate.ts:63#minDelta`) and holds
over two real reads; rare-path suppression stays where it was; nothing
publishes an aggregate for the gate to guard. **S111** (four reconciliation
outcomes, W → W): all four are representable and proximity is never ownership
(`lib/sensingSubjectReconciliation.ts:55#OWNERSHIP_EVIDENCE`;
`lib/sensingSubjectReconciliation.ts:104#temporary_world_object`); the
canonical `subject_id NOT NULL` stands and the resolver has no caller.
**S112** (revocation lineage, W → W): defined per stage as data
(`lib/sensingRevocationLineage.ts:56#SENSING_REVOCATION_EFFECT`), executable,
and proven to match the SQL on a real cohort; the stages past aggregate exist
now and the session and memory stages are "prevented" because S54 does not
exist. **S42 / S51 / S52** (the Vibe engine, its signals, its state): the
engine is guarded and pinned (`lib/vibeInference.ts:144#inferVibe(`), its
output carries every §5.2 field, and **not one of its seven candidate signals
has a producer** — client capture is decision #6 — so S42 stays W, and S51
and S52 move N → W: a state nothing can populate is built, not correct.

**(b) The prohibition the engine enforces.** **S9** (rapid movement ≠
dancing, N → **C** `⌀`): high energy with arrhythmic or unbounded motion cannot
raise dance likelihood and unknown periodicity yields null
(`lib/vibeInference.ts:236#VIBE_MIN_PERIODICITY_FOR_DANCE`;
`test/vibeInference.test.ts:51#arrhythmic`), the artifact this document's own
rule for prohibitions asks for. Vacuous in the sense S22 is: the engine it
guards is called by nothing.

**(c) The shared truth vocabulary — on live wires.** **S48** (seven truth
classes, W → **C**): `lib/truthClass.ts:47#TRUTH_CLASSES` is the vocabulary
verbatim with CORROBORATED representable and a fail-weak combinator
(`lib/truthClass.ts:99#weakestTruthClass(`); the Wall serves a class and a
coverage on every Live For You item today
(`services/wall/LiveForYouService.ts:277#truthClass:`;
`test/wallTruthClass.test.ts:229#EVERY`) and derives `corroborated` from
independent sources (`test/wallTruthClass.test.ts:56#corroborated`); the Map
stamps the same class behind 2350's flag. **S110** (six temporal semantics,
W → W): the shared envelope carries all six and enforces `predicted_for` iff
`predicted` (`lib/experienceTruth.ts:66#TemporalEnvelope`;
`lib/experienceTruth.ts:102#predicted_for_without_predicted_class`), and
`predicted_for` reaches the wire on the temporal route; `effective_from` and
`effective_until` are carried only by the callerless sensing states, so four
of six are served, up from four of six declared. **S49** (every consumed
state carries all four fields, W → W): Wall yes, Map yes behind the flag,
Discovery's candidate carries truth class, confidence and freshness and **no
coverage** (`lib/discoveryCandidate.ts:114#DiscoveryCandidate`), Compass's
states carry none of the four.

**(d) The Map behind migration 2350 — three flags seeded FALSE, wired, route-tested.**
`migrations/2350_map_sensing_projection_flags.sql:74#INSERT` seeds
`map_experience_state_enabled`, `map_world_moments_enabled` and
`map_display_resolver_enabled` FALSE and refuses to commit them ON;
`routes/mapProjection.ts:563#map_experience_state_enabled` reads all three
fail-closed, and `test/mapSensingProjectionGates.test.ts:131#ABSENT` proves
that with every flag absent — production's state — not one new field reaches
the wire while the live claims still flow. **S43** (Experience engine, N →
**C**) and **S53** (the §5.3 composite, N → **C**):
`lib/mapExperienceState.ts:220#buildExperienceState(` folds the claims the
gateway already reads into the spec's six-branch tree, each populated leaf
from one claim type and every leaf without a producer null, never a default
(`test/mapExperienceState.test.ts:147#null`); the fold reads no personal
preference (§1.1's pin); it is served on `payload.experienceState` behind the
flag (`lib/mapProjection.ts:781#experienceState`;
`routes/mapProjection.ts:1010#experienceState:`;
`test/mapSensingProjectionGates.test.ts:165#map_experience_state_enabled`).
**S59** (ExperienceState on the place object, not separate pins, W → **C**):
the same fold, onto the same object, and no new kind. **S64** (truth /
freshness / coverage metadata; predicted visibly distinct, W → **C**): the
object carries `truthClass` and `coverage` (`lib/mapObjects.ts:454#truthClass?:`;
`lib/mapProjection.ts:800#truthClass:`) and every forecast object on the
temporal route is stamped `predicted`
(`routes/mapProjectionTemporal.ts:634#predicted`;
`test/mapSensingProjectionGates.test.ts:335#predicted`). **S60** (world_pulse
promoted into the seven change types, W → **C**) and **S44** (World Dynamics
— change, anomalies, hotspots, rhythm; no cause when unknown, W → **C**):
`lib/mapProducers/worldMomentProducer.ts:71#WORLD_CHANGES` is the spec's seven
verbatim; each rides its own published evidence and carries the truth class it
earns — event spillover rests on an inferred cause block and is `inferred`,
never observed (`lib/mapProducers/worldMomentProducer.ts:109#WORLD_CHANGE_TRUTH`;
`test/mapWorldMoments.test.ts:193#INFERRED`); anomaly is `unexpected_activity`
(`test/mapWorldMoments.test.ts:183#unexpected`); hotspots are the pulse and
rhythm is `city_model` (`lib/mapProducers/cityModelProducer.ts`); a sub-floor
cell and a quiet cell serialize identically; wired at
`routes/mapProjection.ts:1297#attachWorldMoments(pulses,` and served with
`moment: null` when nothing changed
(`test/mapSensingProjectionGates.test.ts:272#map_world_moments_enabled`).
**S65** (display resolver — safety, mode, zoom, intent, relevance, W → **C**):
`lib/mapDisplayResolver.ts:268#resolveDisplay(` runs between ranking and
paging, the band sets the budget, the mode allocates it across classes, the
intent reorders within a tier, safety notices are never budgeted, and every
drop is counted by kind (`routes/mapProjection.ts:1319#resolveDisplay(ranked,`;
`test/mapSensingProjectionGates.test.ts:195#map_display_resolver_enabled`).
**S38** (coverage tracked separately from activity, W → **C**): the Map
object now carries `coverage` beside `activity` (`lib/mapObjects.ts:455#coverage?:`),
folded from the read path's own cohort bucket
(`lib/mapExperienceState.ts:164#foldCoverage(`), the Wall carries it beside
its state, and the sensing presence state carries it beside an ordinal.
**S66** (safety outranks opportunity across surfaces, W → W): on the Map an
object at or within 100 m of a notice loses its promotion
(`lib/mapDisplayResolver.ts:226#applySafetyPrecedence(`), and Compass now
EXCLUDES a Live `unsafe_density` subject before ranking behind an env gate
(`compass/CompassLiveConstraints.ts`;
`test/compassCensusGates.test.ts:236#unsafe_density`); Discovery's ranker
still reads no safety state, so a noticed place can still rank there. **S40**
and **S45** stay W: crowd momentum is still a human trajectory tap, not a
computed arrival/departure balance, and a forecast now has a horizon and a
class but no calibration attached.

**(e) Discovery behind 2361.** **S70** (DiscoveryCandidate with why-now,
why-for-user, confidence, freshness, truth class, W → W): built and wired
into `GET /discovery` behind `discovery_candidate_projection_enabled`
(`lib/discoveryCandidate.ts:103#DISCOVERY_CANDIDATE_PROJECTION_FLAG`), and
`whyNow` is always null (`lib/discoveryCandidate.ts:118#whyNow:`) because no
live producer exists for a place on that surface — the module says so itself.
Built, wrong on the one field the row is named for.

**(f) The mutation list, and the audit artifact.** **S125** (W → **C**):
all five invariants the row names are mutation-proven now — no permanent
identity link on the World Intelligence store (2315's postconditions, the
catalog case, the tripwire; the canonical intel FK is for human claims and is
the owner's ruling), no single-device crowd (forty writes → one contributor
on the database; the replay key rolled back → red), no prediction as
observation (`test/truthClass.test.ts:41#CORROBORATED`'s property tests and
the temporal stamp, both red under mutation), no anomaly as safety
(`lib/mapProducers/safetyNoticeProducer.ts:22-32` refuses the fallback and
`experienceTruth` has no safety member), no client-computed vibe
(`test/vibeInference.test.ts:200#client` walks the client tree; a planted
probe turned it red). **S120** (the S0 reuse map, N → **C**):
`docs/architecture/sensing-s0-reuse-map.md` inventories consent, route-flow
contribution, device/session, map projection, intel storage, Wall, Discovery,
Compass, schedulers, RLS, outbox and flags — every item the row lists — and
its summary arithmetic is corrected in §1.1. A document is falsified by
reading, not by a test; none applies.

### 1.3 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S9 Rapid movement ≠ dancing | N | **C** | `⌀` The Vibe engine caps dance likelihood at 0.1 under arrhythmic or unbounded motion and answers null under unknown periodicity; mutation M5 (the contradicted branch removed) turned two cases red. Vacuous: the engine is called by nothing. |
| S18 Short-lived rotating contribution identifiers | N | **W** | Two-layer rotation built and executed on the database, revocation by epoch secret executed; no writer is registered and none may be until `SENSING_AUTH_POSTURE` is decided. Mutations M1 and M1b each red. |
| S20 Eligibility separated from ingest; opaque credential | N | **W** | Eligibility, credential and session are three modules and a table with no identity column; eligibility refuses everyone while the posture reads `undecided` (M12 red). Built, and admitting nobody by owner decision. |
| S24 Anti-differencing and rare-path suppression | W | **W** | The anti-differencing gate the row called absent exists and holds over two real reads (M4 red); rare-path suppression stands; nothing publishes an aggregate for it to guard. |
| S25 Seven verbs as distinct permissions | W | **W** | Distinct in the policy, the session's scope CHECK and admission (M10 red, the scope CHECK executed); the ingest that would enforce them is the owner's; intel human-claim consent stays one boolean. |
| S30 `IntelligenceContributionSession` | N | **W** | All eight §4.2 properties bound to their owning primitives and the issued half a table whose budget is consumed in SQL (M11 red; 2480 rolled back → red); nothing issues a session. |
| S33 Replay and rate limit per credential | W | **W** | Both keyed on the credential now — the replay index (M2 red; rolled back → red) and the session budget (M11 red) — and the ingest they protect does not exist. |
| S35 Reject impossible timestamps, malformed precision, invalid scopes, stale credentials | W | **W** | All four rejections exist (M3, M10, M11 red; the time-bounds CHECK executed and rolled back → red); the row's "two are unimplementable" is false now, and there is no ingest to reject anything. |
| S38 Track coverage separately from activity | W | **C** | `coverage` beside `activity` on the Map object behind 2350 (M15 red through the route), beside the state on every Wall item (M19 red), beside the ordinal on the sensing presence state (M8 red, executed on real rows). |
| S39 Presence engine → aggregate + coverage; no person identity | W | **W** | Built from the real gate's decision, observed / unknown only, names no person (M8 red; executed on k and k − 1 real contributors); no surface consumes it (decision #9). |
| S42 Vibe engine → VibeState; no literal behaviour without evidence | W | **W** | The engine and its guards exist and are pinned (M5 red); none of its inputs has a producer. |
| S43 Experience engine → ExperienceState; no personal preference as world truth | N | **C** | The fold over the gateway's live claims, six branches, null where no engine exists, reading no viewer preference (M20 red); served behind `map_experience_state_enabled` and route-tested. |
| S44 World Dynamics → WorldMoment; no cause when unknown | W | **C** | Change (seven moments), anomaly (`unexpected_activity`), hotspots (`world_pulse`), rhythm (`city_model`); cause only from an inferred block, classed `inferred` (M18 red); behind `map_world_moments_enabled`, route-tested. |
| S48 Seven canonical truth classes | W | **C** | One vocabulary, CORROBORATED representable and produced, fail-weak composition (M9 red); on the Wall's wire today and on the Map's behind the flag. |
| S51 Vibe inferred from motion energy, periodicity, … | N | **W** | The inference over exactly those signals exists and is guarded; not one signal is produced anywhere (S28, decision #6). |
| S52 `VibeState` carries energy, sociality, dance_likelihood, volatility, momentum + truth metadata | N | **W** | The state carries every field named, with truth class always `inferred` and a band below the live floor; nothing can populate it. |
| S53 `ExperienceState` composite | N | **C** | Crowd / Vibe / Behavior / Friction / Dynamics / Truth in the spec's shape on `payload.experienceState`; leaves with no producer are null, never fabricated (M15 red through the route). |
| S59 Server-built ExperienceState on place/event projections, not separate vibe pins | W | **C** | The same fold onto the same object, no new kind (M15 red). |
| S60 world_pulse promoted into seven change types | W | **C** | Heating up, forming, moving, clearing, unexpected activity, event spillover, traveler surge — each from its own published evidence, a quiet cell and a sub-floor cell identical (M18 red). |
| S64 Truth / freshness / coverage metadata; predicted visually distinct | W | **C** | `truthClass` and `coverage` on the object, `predicted` stamped on every forecast object (M15, M16 red through both routes). |
| S65 Display resolver / clutter budget | W | **C** | Safety never budgeted and constraining, band budget, mode shares, intent affinity within a tier, drops counted by kind (M17 red through the route and the unit suite). |
| S66 Safety outranks opportunity; never "best move now" | W | **W** | Map: promotion stripped near a notice (M17 red). Compass: a Live `unsafe_density` subject excluded before ranking, env-gated. Discovery: the ranker reads no safety state. Two of three surfaces. |
| S70 Server-built DiscoveryCandidate | W | **W** | Wired into `GET /discovery` behind 2361's flag with truth class, confidence, freshness and why-for-user; `whyNow` is null on every row because no live producer exists for a place there. |
| S110 Six shared temporal semantics | W | **W** | The shared envelope carries all six and enforces `predicted_for` iff `predicted` (M7 red); `predicted_for` is on the temporal wire; `effective_from` / `effective_until` are carried by callerless states only. |
| S111 Reconciliation: Place / Event / Temporary world object / Unknown | W | **W** | All four representable and proximity never ownership (M6 red); the canonical `subject_id NOT NULL` stands and the resolver has no caller. |
| S112 Revocation lineage | W | **W** | Defined per stage, executable, and proven to match the SQL on a real cohort (M14 red; revocation executed); the session and memory stages are prevented only because nothing bridges to them. |
| S120 S0 reuse map | N | **C** | `sensing-s0-reuse-map.md` exists for this spec and inventories every item the row lists; its summary arithmetic corrected. No test applies to a document. |
| S125 Mutation-prove the five invariants | W | **C** | All five proofs exist and each was watched red: identity link (catalog, tripwire), single-device crowd (forty writes, replay key rolled back), prediction-as-observation (M9, M16), anomaly-as-safety (refused producer, no safety member), client-computed vibe (planted probe, M13). |

**Held, with the reason.** **S17** stays X: the code half is answerable and
built (HSTS via `helmet()`, peppered tokens, the pepper mandatory before any
write); the deployment half is not a file. **S19** and **S118** stay W:
`intel_observations.actor_id NOT NULL REFERENCES profiles(id)` is the owner's
ruling for human claims, the anonymous store carries no FK, and which of the
two postures makes the World Intelligence path FK-free "without exception" is
the undecided decision. **S21**, **S28**, **S29** and **S32** stay as they
are: on-device reduction, the nine device features, acoustic capture and the
signal ingest are decisions #1, #2 and #6, and this lane does not take them.
**S26** stays W: the anonymous half is closed (72 h structural, the sweep
registered at `src/index.ts:151#startSensingRetentionScheduler();`) and the
intel raw purge is behind `intel_contribution_retention_enabled`, FALSE in
production, at 180 days. **S3** and **S106** stay W: `src/presence/domain/`
is unchanged since Phase 0 — types and a transport interface, no store, no
fusion layer. **S40**, **S45**, **S46**, **S49**, **S55**, **S56**, **S66**,
**S68**, **S70**, **S72**, **S73**, **S74**, **S76**, **S78**–**S80**,
**S83**, **S85**–**S88**, **S92**, **S102**, **S103**, **S113** and **S54**
hold for the reasons their rows give; §1.2 re-derives S40, S45, S49, S66 and
S70 and moves none. **S22**, **S89**–**S91** and **S105** hold C and stay
vacuous. **S97** holds C with stronger evidence: the absence the row rested on
is now guarded by a resolver with no distance threshold
(`test/sensingSubjectReconciliation.test.ts:27#PROXIMITY`).

### 1.4 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| M1 | S18 | `lib/sensingAnonStore.ts` | the epoch dropped from the server token HMAC — **stayed green (46 / 46) on the first run**, because the device layer already rotates the commitment; pinned separately, then 1 red | 1 | 0 |
| M1b | S18 | `lib/sensingAnonStore.ts` | the epoch dropped from the device epoch-secret HMAC | 1 | 0 |
| M2 | S33, S125 | `lib/sensingAnonStore.ts` | 23505 no longer a duplicate | 2 | 0 |
| M3 | S35 | `lib/sensingAnonStore.ts` | a future observation accepted | 2 | 0 |
| M4 | S24 | `lib/sensingDifferencingGate.ts` | the minimum delta lowered to 1 | 4 | 0 |
| M5 | S9, S42 | `lib/vibeInference.ts` | the contradicted-evidence branch removed | 2 | 0 |
| M6 | S111 | `lib/sensingSubjectReconciliation.ts` | proximity made ownership | 4 | 0 |
| M7 | S110 | `lib/experienceTruth.ts` | the `predicted_for` iff rule dropped | 1 | 0 |
| M8 | S38, S39 | `lib/sensingPresenceState.ts` | a sub-k cohort rendered observed | 4 | 0 |
| M9 | S48, S125 | `lib/truthClass.ts` | strongest class instead of weakest | 5 | 0 |
| M10 | S25, S30 | `lib/sensingContributionPolicy.ts` | an ungranted scope admitted | 1 | 0 |
| M11 | S30, S33, S35 | `lib/sensingContributionSession.ts` | the budget not refused at zero | 2 | 0 |
| M12 | S20 | `lib/sensingAuthPosture.ts` | the undecided posture admitting a profile | 1 | 0 |
| M13 | S125 | `travel-buddy-standalone/src/` | a client file deriving dance likelihood from motion, planted then removed | 1 | 0 |
| M14 | S112 | `lib/sensingRevocationLineage.ts` | the identity detector blinded | 1 | 0 |
| M15 | S38, S43, S53, S59, S64 | `lib/mapProjection.ts` | the experience state never folded | 14 | 0 |
| M16 | S64, S125 | `routes/mapProjectionTemporal.ts` | the `predicted` stamp dropped | 1 | 0 |
| M17 | S65, S66 | `lib/mapDisplayResolver.ts` | safety precedence never constraining | 4 | 0 |
| M18 | S44, S60 | `lib/mapProducers/worldMomentProducer.ts` | unexpected activity never detected | 1 | 0 |
| M19 | S38, S48 | `services/wall/LiveForYouService.ts` | an unstated class defaulting to `observed` | 1 | 0 |
| M20 | S43 | `lib/mapExperienceState.ts` | the fold reading a viewer preference | 1 | 0 |
| DB-1 | S33, S35, S125 | replica | 2340 rolled back, then re-applied | 3 | 0 |
| DB-2 | S30, S33, S35 | replica | 2481 then 2480 rolled back, then re-applied | 2 | 0 |

### 1.5 The ceiling

Nothing here is deployed, enabled or production-realised, and the section's
arithmetic says so twice. The anonymous path is owner-gated at both ends:
`SENSING_AUTH_POSTURE` reads `undecided`, the tripwire forbids a route, and
publishing any aggregate is decision #9 — so **thirteen built, tested,
mutation-proven and database-executed rows are W**, and will be until a
decision this lane cannot take is taken. 2315 and 2340 exist in portava-ci
and nowhere else; 2480 and 2481 exist only on this lane's replica and were
dry-run on portava-ci inside a rolled-back transaction by the pass that wrote
them; production holds no sensing table and no `SENSING_CONTRIBUTOR_PEPPER`
is known to be set. The twelve rows that moved to C ride surfaces that are
live today (the Wall's truth class and coverage) or are seeded FALSE in every
database (2350's three flags, 2361's one) — and every intel table in
production still holds zero rows, so the Map's fold serves nothing there
whatever its flag says. **Realised in production: 0.0 %**, unchanged.

## 2. The decision Compass emits, the cost of leaving, and the window a traveller can still reach

**Read against the branch `claude/sensing-lane`, 2026-09-12, by the Sensing
lane.** Three N rows whose gap was a whole thing: §10's decision — *GO NOW ·
GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN* — which Compass never emitted
(S78), the switching cost a current experience introduces so Compass does
not keep telling a traveller to abandon a good one (S80), and §11's peak
interception — can the user reach the experience before its useful window
decays (S86). One migration, 2800, seeds a flag FALSE; no table, no column,
no write path. The engine is pure and consumes the ONE live read path every
surface already uses; the route sits in its own file so `routes/compass*.ts`
and `src/compass/**` are untouched. Every rule went red under a mutation
before its commit; the mutations are listed in §2.3.

### 2.1 What was built, and where

- **§10 the decision (S78)** — `lib/compassDecision.ts:80#COMPASS_DECISIONS`
  is the spec's seven words verbatim, and `lib/compassDecision.ts:337#decideCompass(`
  runs the rules in the order the spec's precedence implies: safety outranks
  opportunity — a Live-qualified `unsafe_density` is SKIP for every viewer,
  whatever the intent, ETA or current experience
  (`lib/compassDecision.ts:360#safety_outranks_opportunity`); already at the
  candidate is STAY; without a READING the engine cannot say GO — a reading
  is a claim Compass's own rule Live-qualifies
  (`compass/CompassLiveConstraints.ts:268#isLiveConstraintEligible(`) AND the
  Wall's §5.1 derivation classes as an observation
  (`lib/compassDecision.ts:224#isReading(`), so a sponsored "busy" is
  `inferred` and a materially conflicting one `conflicting` and neither backs
  GO (§2 promotional claim ≠ observed reality); a read the gates refused is
  WAIT with `live_intelligence_unavailable`, nothing served is WAIT with
  `no_live_evidence`, live-but-not-observational evidence is WAIT with
  `evidence_not_observational` — three different facts, three reasons
  (`lib/compassDecision.ts:367#live_intelligence_unavailable`); an emerging,
  building candidate is GO SOON, labelled below the live floor; a refused
  walk-in is SKIP and a queue past the tolerance is WAIT; a candidate at the
  intent floor is SKIP; then interception, RETURN, the switching cost, and GO
  NOW. Every decision carries its grounding — the §5.1 block composed
  weakest-on-every-axis over the claims it rests on
  (`lib/compassDecision.ts:215#truthOf(`; `lib/experienceTruth.ts:159#composeTruth(`) — and a sentence built from templates
  over the claim values with the truth class always in it, a vibe only as
  "reported as", and no template with a behaviour verb, so the engine cannot
  produce "everyone is dancing" (`lib/compassDecision.ts:426#summariseDecision(`;
  `test/compassDecision.test.ts:305#everyone`). Experience value is
  intent-relative — quiet, social, high energy — and UNKNOWN with no intent:
  the engine does not read busy as good (`lib/compassDecision.ts:295#experienceValue(`;
  `test/compassDecision.test.ts:152#intent-relative`). The route
  `GET /api/compass/decision` (`routes/compassDecision.ts:68#router.get(`)
  reads the flag fail-closed (`routes/compassDecision.ts:78#compass_decision_enabled`),
  the place for a walking ETA when the client sends none
  (`routes/compassDecision.ts:106#haversineKm(q.lat,`), asks the Live gates
  whether it may look (`routes/compassDecision.ts:112#liveLabelsServable(sc)`),
  reads the candidate and the current experience through
  `readLiveClaimEnvelopes`, and answers the decision with its reasons,
  grounding, interception and switching-cost report; it writes nothing and
  computes no truth of its own. Registered at the tail of `routes/index.ts:334#compassDecisionRouter`, so no line the other censuses cite in that file moved.
  2800 seeds the flag FALSE and refuses to commit a TRUE row
  (`migrations/2800_compass_decision_flag.sql:34#INSERT`;
  `migrations/2800_compass_decision_flag.sql:47#reads`); the rollback refuses
  over a TRUE row (`db/rollback/2026-09-12-2800-compass-decision-flag-rollback.sql:23#DELETE`)
  and was rehearsed apply → rollback → apply on the lane's replica. The route
  suite drives the real handler over the fake PostgREST double: flag absent
  (production's state), false and unreadable all answer `feature_disabled`
  and read no place and no claim (`test/compassDecisionRoute.test.ts:93#ABSENT`);
  unauthenticated, malformed and unknown place refused; GO NOW with
  corroborated grounding and the interception margin
  (`test/compassDecisionRoute.test.ts:116#GO`); SKIP on `unsafe_density`;
  STAY under the switching cost with the current experience read through the
  same seam; WAIT with `live_intelligence_unavailable` when the pilot is
  closed and `no_live_evidence` when the gates are open and nothing is served
  — production's state, where every intel table holds zero rows
  (`test/compassDecisionRoute.test.ts:152#CLOSED`;
  `test/compassDecisionRoute.test.ts:160#NOTHING`). Nothing person-shaped is
  on the wire: no contributor, coordinate or count.
- **§10 the switching cost (S80)** — `lib/compassDecision.ts:91#SWITCHING_COST`
  is the cost (0.25 of the 0..1 value, a documented tunable; the SHAPE is the
  requirement); with a current experience whose value is known the candidate
  must beat it by more than the cost to be SWITCH, else STAY
  (`lib/compassDecision.ts:391#better_by_more_than_switching_cost`); with a
  current experience whose value is UNKNOWN — no intent, or no reading where
  the traveller is — the engine has no basis to tell them to leave and says
  STAY for that reason, inventing neither a cost nor a preference
  (`lib/compassDecision.ts:389#current_value_unknown`); dwell is revealed
  preference and can only raise a KNOWN current value, bounded
  (`lib/compassDecision.ts:308#currentExperienceValue(`), so an hour at a
  moderate place turns a SWITCH into a STAY
  (`test/compassDecision.test.ts:228#dwell`), and creates no value
  (`test/compassDecision.test.ts:237#creates`). The report says whether the
  cost was applied and both values.
- **§11 peak interception (S86)** — `lib/compassDecision.ts:318#interceptPeak(`:
  arrival = now + ETA against the EARLIEST horizon of the claims that
  qualified — min(`validUntil`, `observedAt` + the family's TTL), the rule
  Compass's arrival forecast already uses
  (`compass/CompassLiveConstraints.ts:505#forecastArrival(`) — reachable when
  arrival precedes it, with the margin in minutes either way; arrival after
  the horizon is WAIT with `window_may_decay_before_arrival` and the sentence
  says by how much (`lib/compassDecision.ts:381#window_may_decay_before_arrival`);
  an unknown ETA is an unknown interception, stated, never assumed reachable
  (`test/compassDecision.test.ts:190#unknown`;
  `test/compassDecision.test.ts:179#EARLIEST`). The route derives the ETA at
  walking speed from the viewer's position when the client sends none, and a
  viewer fifteen kilometres away is told to wait
  (`test/compassDecisionRoute.test.ts:132#walking`).

### 2.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S78 Compass emits a decision: GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN | N | **C** | The seven-word vocabulary verbatim, a pure engine whose rules run safety-first over the one live read path with a reading defined as Live-qualified AND observational, served on `GET /api/compass/decision` behind 2800's FALSE flag with its grounding; route-tested through the real handler; mutations B2-M1 to B2-M4 and B2-M10 to B2-M12 red. |
| S80 Current Experience value introduces switching cost | N | **C** | A cost the candidate must beat, applied only when the current value is KNOWN and intent-relative — never busy = good — with dwell raising a known value and creating none; STAY with the reason when the value is unknown; B2-M7, B2-M8, B2-M9 red. |
| S86 Peak interception: can the user reach the experience before its useful window decays? | N | **C** | Arrival against the earliest qualifying horizon, the margin either way, WAIT when the window would decay first, unknown when the ETA is; the route derives a walking ETA when none is sent; B2-M5, B2-M6 red. |
| S79 Compass must ground natural-language claims in structured truth | W | **W** | The decision surface's language is grounded by construction — templates over claim values with the truth class in every sentence and no behaviour verb, so it cannot say "everyone is dancing" (B2-M11 red) — and the conversational `/compass/ask` and Telegraph model paths are still constrained only by shape sanitizers. One surface of two. |

**Held, with the reason.** **S66** stays W with a narrower gap: the Map
strips promotion near a notice (§1), Compass's ranking excludes a Live
`unsafe_density` subject, and now its decision is SKIP on one — Discovery's
ranker still reads no safety state. **S72** stays W: the intent modes the
decision accepts (quiet, social, high energy, explore) are the engine's, and
`compass/CompassIntentModeEngine.ts` is another unit's file with its own
vocabulary; the shared-intelligence half of the row is not built here.
**S81** and **S82** hold C: Home still answers "what matters right now" and
this route is the first place Compass answers "what should I do about it"
with a decision rather than a ranked list. **S83** stays W: a
`TripWorldContext` belongs to the Trips lane's files and this lane does not
enter them. **S85** stays W: the Layover engine still reads no live seam.

### 2.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B2-M1 | S78 | `lib/compassDecision.ts` | safety no longer outranks | 2 | 0 |
| B2-M2 | S78 | `lib/compassDecision.ts` | no live evidence answered GO NOW | 4 | 0 |
| B2-M3 | S78 | `lib/compassDecision.ts` | a sponsored claim counted as a reading | 3 | 0 |
| B2-M4 | S78 | `lib/compassDecision.ts` | "could not look" collapsed into "saw nothing" | 2 | 0 |
| B2-M5 | S86 | `lib/compassDecision.ts` | interception never fails | 4 | 0 |
| B2-M6 | S86 | `lib/compassDecision.ts` | the horizon taken as the latest, not the earliest | 1 | 0 |
| B2-M7 | S80 | `lib/compassDecision.ts` | the switching cost set to zero | 1 | 0 |
| B2-M8 | S80 | `lib/compassDecision.ts` | dwell ignored | 1 | 0 |
| B2-M9 | S80 | `lib/compassDecision.ts` | an unknown current value defaulted to 0.5 | 2 | 0 |
| B2-M10 | S78 | `lib/compassDecision.ts` | busy read as good with no intent | 2 | 0 |
| B2-M11 | S78, S79 | `lib/compassDecision.ts` | a vibe described whether or not Live-qualified | 2 | 0 |
| B2-M12 | S78 | `routes/compassDecision.ts` | the flag read ignored | 3 | 0 |
| DB-3 | S78 | replica | 2800 applied, rolled back (row gone), applied (FALSE) | — | — |

### 2.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2800 exists on
the lane's replica and nowhere else; `compass_decision_enabled` is seeded
FALSE and is the owner's to turn on — it opens a new user-facing surface.
Behind it the Live gates still decide what is served, and in production
every intel table holds zero rows and `intel_live_promoted_scopes` is empty,
so the route there answers WAIT with `no_live_evidence` for every place: a
decision engine with nothing to decide on, and honest about it. No client
calls the route. **Realised in production: 0.0 %**, unchanged.

## 3. The Wall's moments, and the engine that decides who is interrupted

**Read against the branch `claude/sensing-lane`, 2026-09-12, by the Sensing
lane.** Three N rows and one W row on the Wall side of the spec: §9's
demand that the Wall consume meaningful state transitions rather than
repeated snapshots (S73), the server-built `WallMoment` with subject,
transition, occurred_at, relevance window, reason, truth class, freshness
and expiry (S74), the split between the Live Now strip and a chronological
record of transitions (S76), and §15's mandatory Attention Engine — world
changes routed through relevance, novelty, urgency, half-life, availability,
interruption cost and an attention budget before NOTIFY / WALL / SILENT /
IGNORE (S102). One migration, 2801, seeds a flag FALSE; no table, no column,
no write path, and the engine sends nothing. The Wall's own route file is
untouched; the new route sits beside it behind the Wall's master flag. Every
rule went red under a mutation before its commit; the mutations are listed
in §3.3.

### 3.1 What was built, and where

- **§9 a moment is a change (S73, S74)** — `lib/wallMoments.ts:41#WALL_TRANSITIONS`
  is §9's place-state family: warming, building, peaking, cooling, crowd
  shift, vibe change, queue change, a safety notice activated or cleared.
  `lib/wallMoments.ts:140#detectTransitions(` compares each CURRENT envelope
  — from `readLiveClaimEnvelopes`, the one gated read path — against the
  PREVIOUS readings of the same claim type from the projection's own
  append-only record, and emits a transition only when the value changed:
  the same value projected again is not a moment, and a first reading with
  nothing on record to change from is not a change
  (`lib/wallMoments.ts:161#record`; `test/wallMoments.test.ts:70#same`;
  `test/wallMoments.test.ts:74#first`). The transition is dated when the
  current value BECAME current — the first version that carried it after the
  last differing one — not when it was last observed
  (`lib/wallMoments.ts:165#becameCurrentAt`; `test/wallMoments.test.ts:77#dated`).
  A safety activation comes only from a served `unsafe_density`, the
  specialist-only level no contributor surface can emit
  (`lib/wallMoments.ts:125#safety_notice_activated`;
  `test/wallMoments.test.ts:105#ONLY`); trajectories map emerging → warming,
  building, peaking, declining → cooling, and stable to no moment.
  `lib/wallMoments.ts:189#buildWallMoment(` carries §9's eight fields and the
  §5.1 block of the envelope that evidences it, through the same derivation
  the Compass decision uses (`lib/liveEnvelopeTruth.ts:16#truthOfEnvelope(`),
  so a sponsored change is `inferred` and a stale one `stale`
  (`test/wallMoments.test.ts:136#carries`; `test/wallMoments.test.ts:153#sponsored`);
  the id names the subject, the claim type, the instant and the value, so a
  client can say it has seen it. `lib/wallMoments.ts:208#buildWallMoments(`
  drops the expired and orders newest change first. Nothing person-shaped is
  in a moment (`test/wallMoments.test.ts:157#contributor`).
- **§9 the previous side is a baseline, never a value served (S76)** —
  `lib/wallMomentRead.ts:35#readPreviousReadings(` reads
  `intel_state_snapshot_versions` (2273; present in the 2026-09-08 production
  snapshot) for one subject, privacy-eligible rows only
  (`lib/wallMomentRead.ts:47#privacy_eligible`) — a sub-k version is never
  read, so nothing the gate withheld can leak through a comparison — and
  reports a failed read as a NAMED refusal: an absent table is
  `versions_unavailable`, anything else `error`, never an empty list
  (`lib/wallMomentRead.ts:51#versions_unavailable`;
  `test/wallMomentsRoute.test.ts:167#REFUSAL`;
  `test/wallMomentsRoute.test.ts:163#sub-k`). The Live Now strip is
  untouched and keeps consuming current projections
  (`services/wall/LiveForYouService.ts:212#buildLiveForYou(`); the record of
  transitions is a different object on a different route, so neither
  duplicates the other.
- **§15 the Attention Engine (S102)** — `lib/attentionEngine.ts:42#ATTENTION_ROUTES`
  is NOTIFY / WALL / SILENT / IGNORE, and `lib/attentionEngine.ts:121#routeAttention(`
  decides one moment for one viewer with every factor the row names on the
  decision (`test/attentionEngine.test.ts:63#factor`): novelty first — a
  moment the viewer has seen is IGNORE whatever else is true, a safety
  activation included (`lib/attentionEngine.ts:134#already_seen`;
  `test/attentionEngine.test.ts:70#seen`); half-life — past its relevance
  window IGNORE, most of the way through it stale news
  (`lib/attentionEngine.ts:141#decayed`; `test/attentionEngine.test.ts:86#stale`);
  relevance — none is IGNORE, a saved place or trip stop may be interrupted
  for, a followed place reaches the Wall, merely nearby only when urgent
  (`lib/attentionEngine.ts:57#NOTIFY_RELEVANCE_FLOOR`;
  `lib/attentionEngine.ts:61#RELEVANCE_WEIGHT`;
  `test/attentionEngine.test.ts:102#followed`); urgency from the transition
  kind (`lib/attentionEngine.ts:69#URGENCY_OF`); availability — quiet hours
  or push off defer an urgent change to the Wall, and UNKNOWN availability is
  not availability: an unreadable consent defers too, it is never read as
  consent (`lib/attentionEngine.ts:144#availability_unknown_deferred_to_wall`;
  `test/attentionEngine.test.ts:122#UNKNOWN`); interruption cost against the
  attention budget — the interruptions already delivered in the window
  exhaust it (`lib/attentionEngine.ts:146#budget_exhausted_deferred_to_wall`;
  `lib/attentionEngine.ts:49#ATTENTION_BUDGET_PER_WINDOW`;
  `test/attentionEngine.test.ts:127#budget`); and the safety override — an
  activation for a saved place or trip stop is NOTIFY through quiet hours,
  through an unknown consent read and past the budget, the same override the
  notification path's safety category has, and never past novelty
  (`lib/attentionEngine.ts:139#safety_override`;
  `test/attentionEngine.test.ts:139#through`). The engine reads no clock and
  no database and sends nothing (`test/attentionEngine.test.ts:58#sends`).
- **The route** — `GET /api/wall/moments` (`routes/wallMoments.ts:94#router.get(`)
  reads `wall_enabled` and then `wall_moments_enabled` fail-closed
  (`routes/wallMoments.ts:104#wall_enabled`;
  `routes/wallMoments.ts:108#wall_moments_enabled`), takes the subjects the
  client names — its saved places, its trip stops, the places it is near, a
  viewer-relevant bounded set as the Live For You rule requires — with the
  relevance the client declares and the moment ids it has shown; per subject
  it reads the current claims through the seam
  (`routes/wallMoments.ts:132#readLiveClaimEnvelopes(sc`), the previous
  readings from the record (`routes/wallMoments.ts:137#readPreviousReadings(sc`),
  builds the moments and routes each one for this viewer
  (`routes/wallMoments.ts:144#routeAttention(`) with availability from the
  viewer's notification preferences — quiet hours, push — and the hour's
  delivered notifications as the interruption cost
  (`routes/wallMoments.ts:69#viewerAvailability(sc`;
  `routes/wallMoments.ts:79#notifiesInWindow(sc`); an unknowable count is
  treated as the budget spent. It answers newest change first with a report
  per subject that tells "no moments" from "could not look" and "no versions
  to compare". It writes nothing and sends nothing. Registered at the tail
  of `routes/index.ts:339#wallMomentsRouter`. 2801 seeds the flag FALSE and
  refuses to commit a TRUE row (`migrations/2801_wall_moments_flag.sql:41#INSERT`;
  `migrations/2801_wall_moments_flag.sql:54#reads`); the rollback refuses
  over a TRUE row (`db/rollback/2026-09-12-2801-wall-moments-flag-rollback.sql:23#DELETE`)
  and was rehearsed apply → rollback → apply on the lane's replica. The route
  suite drives the real handler over the fake PostgREST double: the flag
  absent (production's state) or false, or the Wall's master off, answer
  `feature_disabled` and read nothing (`test/wallMomentsRoute.test.ts:99#ABSENT`;
  `test/wallMomentsRoute.test.ts:104#master`); a changed value is a moment
  with its transition, occurred_at, truth and a route for the viewer
  (`test/wallMomentsRoute.test.ts:113#changed`); an unchanged value is not
  (`test/wallMomentsRoute.test.ts:127#UNCHANGED`); a safety activation for a
  saved place is NOTIFY in quiet hours and IGNORE once seen
  (`test/wallMomentsRoute.test.ts:132#safety`); a peak for a saved place is
  deferred to the Wall when the hour's three notifications have spent the
  budget (`test/wallMomentsRoute.test.ts:146#urgent`); the Live pilot closed
  refuses every subject by name, and nothing served for a place — production's
  state — is no moment and no refusal (`test/wallMomentsRoute.test.ts:172#CLOSED`;
  `test/wallMomentsRoute.test.ts:177#nothing`). Nothing person-shaped
  reaches the wire.
- **One module shared, one refactor** — `lib/liveEnvelopeTruth.ts:16#truthOfEnvelope(`
  is the §5.1 block of one live envelope through the Wall's derivation;
  `lib/compassDecision.ts` now imports it instead of defining it, with its
  behaviour unchanged — its two suites pass unmodified (43 / 43), which is
  the re-derivation of S78, S80 and S86 on the refactored file. The
  refactor shortened the file, so every §2 citation into it was re-anchored
  in this section's commit (`check:doc-citations` reported all fourteen and
  is clean again); the code each anchor names did not change.

### 3.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S73 Wall consumes meaningful state transitions, not repeated snapshots of unchanged state | N | **C** | A transition is a change between the current live claim and the projection's own previous version; the same value again is not one and a first reading is not a change (B3-M1 red); served newest-first on `GET /api/wall/moments` behind 2801's FALSE flag and the Wall's master, route-tested (B3-M13 red). |
| S74 Server-built `WallMoment` with subject, transition, occurred_at, relevance window, reason, truth class, freshness, expiry | N | **C** | All eight fields on every moment, occurred_at the instant the value became current (B3-M2 red), a safety activation only from a served `unsafe_density` (B3-M3 red), the expired dropped (B3-M4 red), the truth block the evidencing envelope's own. |
| S76 Live Now strip consumes current projections; chronological Wall records transitions/history; do not duplicate both | W | **C** | The strip is untouched and consumes current envelopes; the moments route is the chronological record of transitions — a different object, with the previous side a privacy-eligible baseline never served (B3-M10, B3-M11 red) — so neither duplicates the other. The Following lane does not interleave moments; a client composes the two. |
| S102 Attention Engine is mandatory: world changes route through relevance, novelty, urgency, half-life, availability, interruption cost and attention budget before NOTIFY / WALL / SILENT / IGNORE | N | **C** | Every moment the route serves passes through the engine (B3-M12 red when skipped) and every factor is on the decision; novelty, half-life, unknown availability, the budget and the safety override each red under their own mutation (B3-M5 to B3-M9). NOTIFY is a routing decision on the wire: no server dispatcher consumes it, and no world change reaches a notification by any other path. |

**Held, with the reason.** **S75** and **S77** hold C: the Following lane is
still strict reverse-chronological and the moments route is a record, not a
ranking; personalization decides whether a moment matters to the viewer and
rewrites nothing in it. **S89** holds C and is less vacuous than it was:
Telegraph still consumes no live intelligence, but the Wall now serves
moments that carry no contributor either. **S87** and **S88** stay N: a
moment is now a canonical object with an id a Telegraph share could
reference, and nothing shares one. **S60** and **S44** hold C: the Map's
world moments are cell-level changes over published aggregates; the Wall's
are place-level changes over projected claims; the two do not overlap and
neither reads the other. **S49** stays W: the Wall's moments carry all four
fields, and Discovery's candidate and Compass's states still do not.

### 3.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B3-M1 | S73 | `lib/wallMoments.ts` | an unchanged value emitted as a moment | 2 | 0 |
| B3-M2 | S74 | `lib/wallMoments.ts` | occurred_at taken from the observation, not the change | 4 | 0 |
| B3-M3 | S74 | `lib/wallMoments.ts` | a safety activation from an ordinary crowd change | 4 | 0 |
| B3-M4 | S74 | `lib/wallMoments.ts` | expired moments served | 1 | 0 |
| B3-M5 | S102 | `lib/attentionEngine.ts` | seen moments not ignored | 2 | 0 |
| B3-M6 | S102 | `lib/attentionEngine.ts` | unknown availability read as available | 1 | 0 |
| B3-M7 | S102 | `lib/attentionEngine.ts` | the budget ignored | 2 | 0 |
| B3-M8 | S102 | `lib/attentionEngine.ts` | the half-life ignored | 1 | 0 |
| B3-M9 | S102 | `lib/attentionEngine.ts` | the safety override dropped | 2 | 0 |
| B3-M10 | S76 | `lib/wallMomentRead.ts` | a sub-k previous version read | 1 | 0 |
| B3-M11 | S76 | `lib/wallMomentRead.ts` | a missing versions table read as "no moments" | 1 | 0 |
| B3-M12 | S102 | `routes/wallMoments.ts` | the engine skipped on the route | 2 | 0 |
| B3-M13 | S73 | `routes/wallMoments.ts` | the flag read ignored | 2 | 0 |
| DB-4 | S73 | replica | 2801 applied, rolled back (row gone), applied (FALSE) | — | — |

### 3.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2801 exists on
the lane's replica and nowhere else; `wall_moments_enabled` is seeded FALSE
behind a `wall_enabled` that is itself FALSE, and both are the owner's. In
production every intel table holds zero rows and `intel_live_promoted_scopes`
is empty, so the route there serves no moment for any place; the versions
table it compares against is in the 2026-09-08 production snapshot, so
where it will refuse is the pilot, not the schema. NOTIFY is a decision no
dispatcher consumes. No client calls the route. **Realised in production:
0.0 %**, unchanged.

## 4. What a conversation shares, and whether it is still true

**Read against the branch `claude/sensing-lane`, 2026-09-12, by the Sensing
lane.** The two N rows of §12: Telegraph must share canonical references to
ExperienceState / Opportunity / WorldMoment / SafetyNotice rather than
copying stale prose (S87), and a shared live object may say that its state
changed since it was shared (S88). One migration, 2802, seeds a flag FALSE;
no table, no column. The write path is ONE `messages` row per share, and
the reason it is the service client's is a fact read off the object, not
the sentence: `public.messages` carries `msg_insert … WITH CHECK (false)`
(`baseline/20260819_baseline_structure.sql:29369#msg_insert`; the same row
on the lane's replica of the 2026-09-08 snapshot, pinned in
`test/db/telegraphLiveReferences.db.test.ts:108#msg_insert`), so an
authenticated member cannot INSERT a message through PostgREST at all.
Telegraph's own route files are untouched; the new router sits beside them.
Every rule went red under a mutation before its commit; the mutations are
listed in §4.3.

### 4.1 What was built, and where

- **§12 a reference, not prose (S87)** — `lib/liveReference.ts:106#LiveReference`
  is what a conversation shares: the subject (a place, id and name), the
  kind, and per claim the snapshot id lib/liveClaimRead already serves as
  provenance, the projection's own version id at share time when the record
  could be read, the comparable VALUE at share time as the baseline "changed
  since" is measured from, the observation time, the validity horizon, and
  the §5.1 truth block composed weakest-wins over the claims
  (`lib/liveReference.ts:82#LiveReferenceClaim`; `lib/liveReference.ts:206#buildLiveReference(`;
  `test/liveReference.test.ts:113#carries`). The ONE human line names the
  subject and the kind and nothing of the state
  (`lib/liveReference.ts:220#referenceText`; `lib/liveReference.ts:76#KIND_WORD`),
  so a client that renders only the line can never present the value as it
  was at share time as if it were current — the test walks every claim's
  value and asserts it is absent from the line
  (`test/liveReference.test.ts:136#text must not carry`;
  `test/telegraphLiveReferencesRoute.test.ts:271#includes`). A sender's own
  note is bounded and never the state's words (`lib/liveReference.ts:197#NOTE_MAX`).
  The kinds are exactly the three objects the tree has a canonical producer
  for — `experience_state` (lib/mapExperienceState, S53), `world_moment`
  (lib/wallMoments, S74), `safety_notice` (lib/mapProducers/safetyNoticeProducer,
  S103's last stage) — and the fourth object §12 names, Opportunity, is
  refused BY NAME because no canonical Opportunity object exists (S56, N):
  `lib/liveReference.ts:61#UNREFERENCEABLE_SPEC_OBJECTS`,
  `lib/liveReference.ts:27#THE FOURTH OBJECT`, `test/liveReference.test.ts:79#opportunity`.
  What each kind points at is fixed: the experience kinds are evidenced by
  the Wall's claim set (`lib/liveReference.ts:64#EXPERIENCE_REFERENCE_CLAIM_TYPES`,
  asserted equal to `routes/wallMoments.ts` at `test/liveReference.test.ts:82#Wall`),
  a safety reference only by the specialist-reviewed `unsafe_density` claim
  (`lib/liveReference.ts:66#SAFETY_REFERENCE_CLAIM_TYPE`, asserted equal to the
  map producer's pair at `test/liveReference.test.ts:82#producer`), a world
  moment only by a transition lib/wallMoments detected
  (`lib/liveReference.ts:145#selectReferenceEnvelopes(`; `test/liveReference.test.ts:104#transition`).
  Nothing to point at is a named refusal, never an empty reference
  (`lib/liveReference.ts:208#nothing_to_reference`; `test/liveReference.test.ts:141#refusal`).
  A version pins ONLY when its value is the served value; a record that has
  not caught up pins nothing rather than a version that says something else
  (`lib/liveReference.ts:168#pinVersionId(`; `test/liveReference.test.ts:175#caught up`).
  The stored body parses back and a foreign body does not
  (`lib/liveReference.ts:273#parseLiveReference(`; `test/liveReference.test.ts:193#refuses`).

- **§12 changed since sharing (S88)** — `lib/liveReference.ts:366#compareLiveReference(`
  measures the shared reference against the CURRENT envelopes the caller
  read through the gate. Per shared claim: the same value on the same
  evidence is `unchanged`, the same value on newer evidence `reaffirmed`
  (`lib/liveReference.ts:354#reaffirmed`), a different value `changed`, no
  current claim `expired` past the shared horizon and `withdrawn` before it
  (`lib/liveReference.ts:350#expired`; `test/liveReference.test.ts:234#withdrawn`;
  `test/liveReference.test.ts:237#expired`); a current claim of a type the
  reference did not carry, within the kind's types, is `added`
  (`lib/liveReference.ts:385#added`; `test/liveReference.test.ts:248#added`).
  `changedSinceShare` is true when any claim is changed / expired /
  withdrawn / added (`lib/liveReference.ts:292#CHANGES_THAT_DIFFER`;
  `lib/liveReference.ts:403#changedSinceShare`). A world-moment reference
  additionally says whether the transition's value is still current
  (`lib/liveReference.ts:398#momentStillCurrent`; `test/liveReference.test.ts:269#momentStillCurrent`).
  When the current state cannot be read the answer is NULL with the
  refusal on it — never false, which would read as "still true"
  (`lib/liveReference.ts:331#refusedComparison(`; `test/liveReference.test.ts:278#null`).

- **the routes** — `routes/telegraphLiveReferences.ts:100#router.post(` is
  `POST /api/telegraph/threads/:threadId/live-references`: requireUser, the
  flag read fail-closed (`routes/telegraphLiveReferences.ts:110#isFlagEnabled`),
  membership by the predicate `authz.is_active_thread_member` uses — a
  present member row with `left_at IS NULL`
  (`lib/liveReferenceMessages.ts:35#isActiveThreadMember(`;
  `lib/liveReferenceMessages.ts:46#left_at`;
  `routes/telegraphLiveReferences.ts:130#forbidden`) — an ACTIVE, unmerged
  place (`routes/telegraphLiveReferences.ts:76#readReferenceablePlace(`), then
  `liveLabelsServable` and `readLiveClaimEnvelopes` — the one gated read
  path, with live intelligence not servable a refusal and not a card
  (`routes/telegraphLiveReferences.ts:141#liveLabelsServable`;
  `routes/telegraphLiveReferences.ts:146#readLiveClaimEnvelopes`;
  `test/telegraphLiveReferencesRoute.test.ts:330#live_intelligence_unavailable`).
  A world moment takes the newest transition lib/wallMoments detects against
  the previous readings (`routes/telegraphLiveReferences.ts:94#readPreviousReadings`;
  `routes/telegraphLiveReferences.ts:96#detectTransitions`). The newest
  privacy-eligible version per claim type is read to pin to, newest-first
  asserted in code as well as asked of the query
  (`lib/liveReferenceMessages.ts:66#readLatestVersions(`;
  `lib/liveReferenceMessages.ts:83#sort`), and an unreadable record is a pin
  withheld, not a share refused (`routes/telegraphLiveReferences.ts:163#versions`;
  `routes/telegraphLiveReferences.ts:182#versionsPinned`). The card is
  written as the service client — `card` / `live_reference`, the body the
  reference — after membership is established, for the reason in the
  module header (`lib/liveReferenceMessages.ts:7#WHY THE WRITE`;
  `lib/liveReferenceMessages.ts:106#insert(`; `lib/liveReferenceMessages.ts:110#msg_type`;
  `test/telegraphLiveReferencesRoute.test.ts:254#rows.length`;
  `test/telegraphLiveReferencesRoute.test.ts:267#ver-now`). Nothing to
  reference is the same named refusal on the wire and no card
  (`routes/telegraphLiveReferences.ts:169#refusal`;
  `test/telegraphLiveReferencesRoute.test.ts:295#nothing_to_reference`).
  `routes/telegraphLiveReferences.ts:188#router.get(` is
  `GET /api/telegraph/live-references/:messageId`: the card by id — absent,
  deleted or another subtype reads as not found
  (`lib/liveReferenceMessages.ts:148#subtype`) — membership on ITS thread,
  a non-member answered exactly as an absent card so membership is not
  disclosed (`routes/telegraphLiveReferences.ts:220#not_found`;
  `test/telegraphLiveReferencesRoute.test.ts:391#absent`), the stored body
  parsed, then the current envelopes through the same gate and the
  comparison (`routes/telegraphLiveReferences.ts:236#compareLiveReference`;
  `routes/telegraphLiveReferences.ts:237#current`), or the refused
  comparison when live intelligence is not servable
  (`routes/telegraphLiveReferences.ts:233#refusedComparison`;
  `test/telegraphLiveReferencesRoute.test.ts:386#null`). The wire carries
  the current claims only through that gate; nothing person-shaped is on it
  (`test/telegraphLiveReferencesRoute.test.ts:282#forbidden`). Registered at
  the tail of `routes/index.ts:344#telegraphLiveReferencesRouter`.

- **2802 and its rollback** — `migrations/2802_telegraph_live_references_flag.sql:47#INSERT`
  seeds `telegraph_live_references_enabled` FALSE, one row, `ON CONFLICT DO
  NOTHING`, with a precondition that `messages` and `message_thread_members`
  exist (`migrations/2802_telegraph_live_references_flag.sql:37#messages`)
  and a postcondition refusing a TRUE row
  (`migrations/2802_telegraph_live_references_flag.sql:60#reads TRUE`).
  `db/rollback/2026-09-12-2802-telegraph-live-references-flag-rollback.sql:28#DELETE`
  removes the FALSE row and refuses over a TRUE one
  (`db/rollback/2026-09-12-2802-telegraph-live-references-flag-rollback.sql:23#reads TRUE`);
  it deletes no card, because a flag removed does not unsend a conversation.
  Rehearsed on the lane's replica: apply → rollback (row gone) → apply
  (FALSE); then the row set TRUE by hand, and BOTH files refused (exit 3
  each), then FALSE restored (DB-5).

- **executed on a database** — `test/db/telegraphLiveReferences.db.test.ts:63#real database`
  runs against the replica as the roles the policies name: the
  `msg_insert` policy reads `false` in `pg_policies` and an authenticated
  active member's INSERT is refused with 42501
  (`test/db/telegraphLiveReferences.db.test.ts:109#msg_insert`;
  `test/db/telegraphLiveReferences.db.test.ts:121#42501`); the service role
  writes the card and the body the database holds parses back as the
  reference (`test/db/telegraphLiveReferences.db.test.ts:125#service role`);
  `msg_select` — as re-created by
  `migrations/2402_telegraph_membership_rls_recursion.sql:176#msg_select`, the
  definition in force — serves it to the active member and to neither the
  stranger nor the member who left (`test/db/telegraphLiveReferences.db.test.ts:144#stranger`;
  `test/db/telegraphLiveReferences.db.test.ts:145#leaver`); and the
  module's membership predicate agrees with `authz.is_active_thread_member`
  for all three (`test/db/telegraphLiveReferences.db.test.ts:154#is_active_thread_member`).

- **what is NOT here** — no Opportunity kind (S56 has no object); no
  dispatcher, no push, no unread count; no change to `routes/telegraph.ts`,
  `routes/telegraphChat.ts` or any Telegraph census file; no read of
  `intel_observations`, `distinct_actors` or `source_count` — the reference
  carries a coarse source class and a band, and the S89 pin walks the
  stored body for every count- or person-shaped key
  (`test/telegraphLiveReferencesRoute.test.ts:282#forbidden`). A ceiling the
  header states outright (`lib/liveReference.ts:35#SAME GATE`): a safety
  reference resolves through lib/liveClaimRead, which applies the per-scope
  pilot allowlist that the map's `readSafetyNotices` deliberately skips, so
  a specialist-reviewed safety claim at a venue outside the promoted scopes
  is visible on the map and not referenceable from a conversation. That is
  recorded rather than hidden behind a bypass of the gateway guard.

### 4.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S87 Share canonical references to ExperienceState / Opportunity / WorldMoment / SafetyNotice rather than copying stale prose | N | **C** | A share is a `card` whose body is subject, kind, snapshot id, version id, value at share time and the truth block, and whose one human line carries no value (B4-M1 red); three kinds for the three objects with a producer, Opportunity refused by name because S56 has no object (B4-M3 red); a version pins only when its value is the served value (B4-M2 red); reached from `POST /api/telegraph/threads/:threadId/live-references` behind 2802's FALSE flag (B4-M13 red), members only (B4-M14 red), through the gated live read (B4-M16 red). |
| S88 Shared live objects may indicate that state changed since sharing | N | **C** | `GET /api/telegraph/live-references/:messageId` resolves the stored reference against the current state and answers per claim unchanged / reaffirmed / changed / expired / withdrawn / added and `changedSinceShare` (B4-M6, B4-M7, B4-M9 red), NULL with the refusal — never false — when the current state cannot be read (B4-M8, B4-M17 red); the newest version is the one pinned (B4-M10 red). |
| S89 Telegraph coordination may consume live intelligence but must not expose anonymous contributors | C | **C** | No longer vacuous: Telegraph now consumes live intelligence through the reference, and the stored body carries no count, cohort, contributor, device or user key (B4-M18 red on the sender id copied in); the current claims reach the wire only through the gated read (B4-M17 red). The `⌀` is lifted. |

**Held, with the reason.** **S90** and **S91** hold C and stay `⌀`: Nearby
& Available and the other coordination paths still read no intel table.
**S56** stays N: refusing to name an Opportunity kind is the correct
consequence of its absence, not a step toward it. **S103** stays W: the
safety reference points at the last stage of the pipeline and adds no
candidate stage. **S54** stays N and **S92** W: a share is not an
ExperienceSession and closes no outcome. **S74** holds C: a world-moment
reference carries the transition exactly as lib/wallMoments detected it and
detects nothing of its own. The observation that the hidden-gem and meetup
card writes in `routes/hiddenGems.ts` and `routes/meetups.ts` go through
the user client against the same `msg_insert … WITH CHECK (false)` is
recorded for the Telegraph lane and grades nothing here: this census counts
no Telegraph row, and whether those writes succeed in production is not
something the replica can say.

### 4.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B4-M1 | S87 | `lib/liveReference.ts` | the human line copies the values | 3 | 0 |
| B4-M2 | S87 | `lib/liveReference.ts` | a version pinned whose value is not the served value | 1 | 0 |
| B4-M3 | S87 | `lib/liveReference.ts` | Opportunity admitted as a kind with no producer | 2 | 0 |
| B4-M4 | S87 | `lib/liveReference.ts` | a safety reference to any crowd claim | 3 | 0 |
| B4-M5 | S87 | `lib/liveReference.ts` | a foreign body parsed as a reference | 2 | 0 |
| B4-M6 | S88 | `lib/liveReference.ts` | a different value read as reaffirmed | 3 | 0 |
| B4-M7 | S88 | `lib/liveReference.ts` | expired and withdrawn swapped | 1 | 0 |
| B4-M8 | S88 | `lib/liveReference.ts` | an unreadable current state read as "unchanged" | 2 | 0 |
| B4-M9 | S88 | `lib/liveReference.ts` | an added facet not a change | 2 | 0 |
| B4-M10 | S88 | `lib/liveReferenceMessages.ts` | the pinned version not the newest | 1 | 0 |
| B4-M11 | S87 | `lib/liveReferenceMessages.ts` | a member who left still a member | 1 | 0 |
| B4-M12 | S88 | `lib/liveReferenceMessages.ts` | a card of another subtype read as a reference | 1 | 0 |
| B4-M13 | S87, S88 | `routes/telegraphLiveReferences.ts` | the flag read ignored on both routes | 2 | 0 |
| B4-M14 | S87 | `routes/telegraphLiveReferences.ts` | a non-member may share | 2 | 0 |
| B4-M15 | S88 | `routes/telegraphLiveReferences.ts` | a non-member may resolve another thread's card | 1 | 0 |
| B4-M16 | S87 | `routes/telegraphLiveReferences.ts` | live gates closed, the share proceeds | 1 | 0 |
| B4-M17 | S88, S89 | `routes/telegraphLiveReferences.ts` | live gates closed, the resolve compares against nothing | 1 | 0 |
| B4-M18 | S89 | `routes/telegraphLiveReferences.ts` | the sender id copied into the reference | 2 | 0 |
| DB-5 | S87 | replica | 2802 applied, rolled back (row gone), applied (FALSE); over a TRUE row both files refused | — | — |

### 4.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2802 exists on
the lane's replica and nowhere else; `telegraph_live_references_enabled` is
seeded FALSE and is the owner's, and it opens a surface that WRITES a
members' message, which is a heavier decision than the read-only surfaces of
§2 and §3. In production every intel table holds zero rows and
`intel_live_promoted_scopes` is empty, so a share there answers
`live_intelligence_unavailable` or `nothing_to_reference` for every place
and writes nothing. No client renders a `live_reference` card; until one
does, a recipient sees whatever their client shows for an unknown card
subtype. The Opportunity kind does not exist because the Opportunity object
does not (S56). The safety ceiling in §4.1 stands. And the comparison is
stateless by design — the reference carries its own baseline — so nothing
here records that a recipient ever resolved it; "changed since sharing" is
answered when asked, not pushed.

## 5. What enters the safety pipeline

**Read against the branch `claude/sensing-lane`, 2026-09-12, by the Sensing
lane.** One W row of §16: world-intelligence evidence / anomaly → SAFETY
CANDIDATE → the existing safety policy / review → the canonical safety
assertion (S103). The row's own finding stands: the last two stages exist
— the specialist-reviewed `crowd.level = unsafe_density` claim is the one
assertion, projected by `lib/mapProducers/safetyNoticeProducer.ts` and
unreachable from every contributor surface — and the first two did not,
so nothing ever entered the pipeline. This section builds the first two
and feeds the third rather than replacing it: a candidate is FILED into the
review queue the platform already has, `moderation_reports`, as a
system-originated `place` / `safety_concern` row — the queue
`routes/admin.ts:2050#/admin/moderation/reports` already serves — and
asserts nothing. One migration, 2803, seeds a flag FALSE; no table, no
column. Every rule went red under a mutation before its commit; the
mutations are listed in §5.3.

### 5.1 What was built, and where

- **§16 the anomaly, and what is never one (S103)** —
  `lib/safetyCandidate.ts:151#detectSafetyCandidates(` reads a subject's
  SERVED envelopes (from `readLiveClaimEnvelopes`, the one gated path) and
  the projection's own previous readings, and emits at most one candidate
  per shape (`lib/safetyCandidate.ts:55#SAFETY_CANDIDATE_REASONS`;
  `lib/safetyCandidate.ts:20#WHAT IS AN ANOMALY`): density rising past
  capacity — `packed` with a `building` / `peaking` trajectory
  (`lib/safetyCandidate.ts:64#CANDIDATE_TRAJECTORIES`;
  `test/safetyCandidate.test.ts:85#rising`); material conflict at capacity
  — `packed` with the cohort in MATERIAL conflict, which
  safetyNoticeProducer's own reading of §10 calls safety information
  (`lib/safetyCandidate.ts:187#material`; `test/safetyCandidate.test.ts:96#material`);
  a rapid density rise — `packed` with a reading at most `moderate` that
  became current inside thirty minutes of the observation
  (`lib/safetyCandidate.ts:127#rapidRiseFrom(`; `lib/safetyCandidate.ts:140#floor`;
  `lib/safetyCandidate.ts:66#RAPID_RISE_WINDOW_MINUTES`;
  `test/safetyCandidate.test.ts:103#rapid`). Never a candidate: the
  assertion itself, because `unsafe_density` is where the pipeline ends
  (`lib/safetyCandidate.ts:63#ASSERTED_CROWD_LEVEL`, asserted equal to the
  map producer's level at `test/safetyCandidate.test.ts:68#producer`;
  `lib/safetyCandidate.ts:160#CANDIDATE_CROWD_LEVEL`;
  `test/safetyCandidate.test.ts:122#assertion`); anything below `packed`;
  and any envelope whose class is not an independent observation — a
  historical pattern, a prediction, or one party talking about itself —
  admitted by source class through lib/intelContracts' own predicates and
  deliberately NOT by truth class, because a cohort in material conflict
  derives a non-observational truth class and is exactly the second shape
  (`lib/safetyCandidate.ts:104#evidenceAdmissible(`;
  `test/safetyCandidate.test.ts:129#non-observational`).

- **§16 the candidate carries evidence and no one** — a candidate is the
  subject, the reason, the snapshot ids and values it rests on, the §5.1
  truth block of that evidence, the instant of detection and the evidence's
  own horizon (`lib/safetyCandidate.ts:86#SafetyCandidate`;
  `lib/safetyCandidate.ts:75#SafetyCandidateEvidence`). Its stored form
  refuses, at write, every count-, cohort-, contributor-, device- or
  user-shaped key (`lib/safetyCandidate.ts:200#CANDIDATE_FORBIDDEN_KEYS`;
  `lib/safetyCandidate.ts:223#must not carry`;
  `test/safetyCandidate.test.ts:159#never a count`) — the rule the safety
  notice keeps ("no presence payload"), because a specialist reading the
  queue is still a reader. It parses back, and a person's own report does
  not parse as the detector's (`lib/safetyCandidate.ts:229#parseCandidateDetails(`;
  `lib/safetyCandidate.ts:235#reason`; `test/safetyCandidate.test.ts:171#did not write`).

- **§16 into the EXISTING review, not a parallel one** —
  `lib/safetyCandidate.ts:246#candidateReportRow(` is the row a candidate is
  filed as: `moderation_reports`, `reporter_id` NULL (the reporter is the
  detector), `subject_type` `place`, `category` `safety_concern`, `status`
  `open`, the candidate in `details` under its own prefix
  (`lib/safetyCandidate.ts:256#reporter_id`; `lib/safetyCandidate.ts:260#category`;
  `lib/safetyCandidate.ts:72#SAFETY_CANDIDATE_DETAILS_PREFIX`;
  `test/safetyCandidate.test.ts:141#no reporter`). That is the queue
  `routes/admin.ts:2050#/admin/moderation/reports` serves to reviewers
  today, with its `place` filter; the row shape is one the table already
  admits, verified on the object rather than assumed — 2803's preconditions
  read the table's own CHECK constraints and the column's nullability and
  refuse to seed a flag for a stage that would fail on its first write
  (`migrations/2803_intel_safety_candidates_flag.sql:51#safety_concern`;
  `migrations/2803_intel_safety_candidates_flag.sql:56#place`;
  `migrations/2803_intel_safety_candidates_flag.sql:61#reporter_id`;
  `migrations/2803_intel_safety_candidates_flag.sql:22#NO TABLE`). The
  service client writes it (`lib/safetyCandidateStore.ts:90#fileCandidateReport(`;
  `lib/safetyCandidateStore.ts:93#insert(`); a candidate already open or
  reviewing for the same subject and reason is not filed again, and a
  reviewer's dismissed or actioned row does not block a fresh one
  (`lib/safetyCandidateStore.ts:64#openCandidateReasons(`;
  `lib/safetyCandidateStore.ts:31#OPEN_REPORT_STATUSES`;
  `lib/safetyCandidateStore.ts:73#status`;
  `test/adminSafetyCandidatesRoute.test.ts:250#not filed again`;
  `test/adminSafetyCandidatesRoute.test.ts:265#DISMISSED`).

- **the routes** — `routes/adminSafetyCandidates.ts:60#router.post(` is
  `POST /api/admin/intel/safety-candidates/scan`: requireAdmin
  (`routes/adminSafetyCandidates.ts:63#requireAdmin(`), the flag read
  fail-closed (`routes/adminSafetyCandidates.ts:70#isFlagEnabled`), live
  intelligence servable or a refusal before anything is read
  (`routes/adminSafetyCandidates.ts:81#liveLabelsServable`;
  `test/adminSafetyCandidatesRoute.test.ts:304#not servable`); the subjects
  the caller names (≤ 50) or, absent, the bounded sweep of every place
  whose current `crowd.level` is served as `packed` — privacy-eligible and
  unexpired, the safety notice read's own two per-row gates, choosing only
  WHERE to look (`routes/adminSafetyCandidates.ts:88#listSweepSubjects(`;
  `lib/safetyCandidateStore.ts:41#listSweepSubjects(`;
  `lib/safetyCandidateStore.ts:50#packed`;
  `test/adminSafetyCandidatesRoute.test.ts:294#sweep`); per subject the
  current envelopes through the gate and the previous readings from the
  record (`routes/adminSafetyCandidates.ts:101#readLiveClaimEnvelopes`;
  `routes/adminSafetyCandidates.ts:103#readPreviousReadings`), a history
  that cannot be read a per-subject REFUSAL and never "no candidate"
  (`routes/adminSafetyCandidates.ts:105#refusal`;
  `test/adminSafetyCandidatesRoute.test.ts:317#REFUSAL`), detection
  (`routes/adminSafetyCandidates.ts:108#detectSafetyCandidates(`), the
  dedupe against the queue (`routes/adminSafetyCandidates.ts:117#open.reasons`)
  and the filing, a refused write named on the answer
  (`routes/adminSafetyCandidates.ts:123#queue_write_failed`;
  `test/adminSafetyCandidatesRoute.test.ts:332#refuses the write`). One row
  per new candidate and nothing else on the wire
  (`test/adminSafetyCandidatesRoute.test.ts:216#ONE report`).
  `routes/adminSafetyCandidates.ts:140#router.get(` is
  `GET /api/admin/intel/safety-candidates`: the detector's own rows still
  open or reviewing, newest first, parsed — a person's report is not among
  them (`lib/safetyCandidateStore.ts:112#listOpenCandidates(`;
  `lib/safetyCandidateStore.ts:121#reporter_id`;
  `test/adminSafetyCandidatesRoute.test.ts:341#not a person`). A non-admin
  is refused before the flag is read
  (`test/adminSafetyCandidatesRoute.test.ts:205#non-admin`). Registered at
  the tail of `routes/index.ts:349#adminSafetyCandidatesRouter`;
  `routes/admin.ts` and `routes/moderation.ts` are untouched.

- **2803 and its rollback** — `migrations/2803_intel_safety_candidates_flag.sql:70#INSERT`
  seeds `intel_safety_candidates_enabled` FALSE, one row, `ON CONFLICT DO
  NOTHING`, with the preconditions above and a postcondition refusing a
  TRUE row (`migrations/2803_intel_safety_candidates_flag.sql:83#reads TRUE`).
  `db/rollback/2026-09-12-2803-intel-safety-candidates-flag-rollback.sql:28#DELETE`
  removes the FALSE row and refuses over a TRUE one
  (`db/rollback/2026-09-12-2803-intel-safety-candidates-flag-rollback.sql:23#reads TRUE`);
  it withdraws no candidate already before a reviewer. Rehearsed on the
  lane's replica: apply → rollback (row gone) → apply (FALSE); then the row
  set TRUE by hand, and BOTH files refused (exit 3 each), then FALSE
  restored (DB-6).

- **executed on a database** — `test/db/safetyCandidate.db.test.ts:55#real database`
  runs against the replica: the row the module builds is accepted by the
  queue's own CHECK constraints when the service role writes it, and the
  details the database holds parse back as the candidate
  (`test/db/safetyCandidate.db.test.ts:76#admits`); a category or subject
  type outside the queue's vocabulary is refused by the same CHECKs
  (`test/db/safetyCandidate.db.test.ts:97#CHECK`); no client role reads a
  reporterless row, because the SELECT policies are `reporter_id =
  auth.uid()` (`test/db/safetyCandidate.db.test.ts:114#no client role`);
  and an authenticated INSERT with no reporter is refused, so a client
  cannot forge a system-originated candidate
  (`test/db/safetyCandidate.db.test.ts:119#cannot file`).

- **what is NOT here** — no scheduler: the stage is operator-triggered,
  because wiring one is a line in `src/index.ts`, a shared file this lane
  does not edit; the sweep is the same read a scheduler would make, and
  registering it is one line at integration. No write to
  `intel_state_snapshots`, `intel_claims` or any intel table; no snapshot,
  no notice, no assertion — a confirmed candidate becomes an assertion only
  through the specialists' existing path, which this section does not
  touch and cannot see. No change to `routes/admin.ts`,
  `routes/moderation.ts` or any file another census counts.

### 5.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S103 World intelligence evidence/anomaly → SAFETY CANDIDATE → existing safety policy/review → canonical safety assertion | W | **C** | The two missing stages exist: three anomaly shapes over served envelopes and the projection's record (B5-M2 to B5-M5 red), the assertion itself never a candidate (B5-M1 red), evidence admitted by source class (B5-M6 red), a candidate carrying refs and values and no one (B5-M7 red), filed into the EXISTING `moderation_reports` review as place / safety_concern with no reporter (B5-M8, B5-M10 red) and not filed twice (B5-M11, B5-M13 red); reached from `POST /api/admin/intel/safety-candidates/scan` behind 2803's FALSE flag and requireAdmin (B5-M14, B5-M15 red), through the gated live read (B5-M16 red). The last two stages are the ones the row already found. |

**Held, with the reason.** **S66** holds C: a candidate outranks nothing
and is rendered nowhere; safety still outranks opportunity on every surface
that renders it. **S104** and **S105** hold C: a candidate reads no trust
score and writes none, and no person is scored by it. **S106** holds W:
the candidate stage is not a Rent-a-Buddy safety path and does not claim
to be. **S74** holds C: a `safety_notice_activated` moment still comes only
from a served `unsafe_density`, never from a candidate. **S8** holds C: a
candidate is not a crowd label; `packed` stays `packed` on every surface
while a specialist decides. What the census cannot say: whether any
specialist reads `GET /admin/moderation/reports` for `place` rows, or how
a confirmed candidate becomes an `unsafe_density` claim — that path is the
specialists' and is not in the tree.

### 5.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B5-M1 | S103 | `lib/safetyCandidate.ts` | the assertion itself admitted as a candidate | 1 | 0 |
| B5-M2 | S103 | `lib/safetyCandidate.ts` | a stable trajectory counted as rising | 2 | 0 |
| B5-M3 | S103 | `lib/safetyCandidate.ts` | minor conflict read as material | 1 | 0 |
| B5-M4 | S103 | `lib/safetyCandidate.ts` | the rapid-rise window ignored | 1 | 0 |
| B5-M5 | S103 | `lib/safetyCandidate.ts` | `busy` admitted as a rise-from level | 2 | 0 |
| B5-M6 | S103 | `lib/safetyCandidate.ts` | a prediction, a pattern or a sponsored claim admitted as evidence | 1 | 0 |
| B5-M7 | S103 | `lib/safetyCandidate.ts` | a count key in the evidence not refused | 1 | 0 |
| B5-M8 | S103 | `lib/safetyCandidate.ts` | filed under another category | 2 | 0 |
| B5-M9 | S103 | `lib/safetyCandidate.ts` | a foreign reason parsed as the detector's | 1 | 0 |
| B5-M10 | S103 | `lib/safetyCandidate.ts` | the details prefix dropped | 2 | 0 |
| B5-M11 | S103 | `lib/safetyCandidateStore.ts` | dismissed and actioned rows treated as still open | 2 | 0 |
| B5-M12 | S103 | `lib/safetyCandidateStore.ts` | the sweep not limited to places served as packed | 1 | 0 |
| B5-M13 | S103 | `routes/adminSafetyCandidates.ts` | an open candidate filed again | 1 | 0 |
| B5-M14 | S103 | `routes/adminSafetyCandidates.ts` | the flag read ignored on both routes | 2 | 0 |
| B5-M15 | S103 | `routes/adminSafetyCandidates.ts` | members admitted as admins | 1 | 0 |
| B5-M16 | S103 | `routes/adminSafetyCandidates.ts` | live gates closed, the scan proceeds | 1 | 0 |
| B5-M17 | S103 | `routes/adminSafetyCandidates.ts` | an unreadable history read as "no candidate" | 1 | 0 |
| B5-M18 | S103 | `routes/adminSafetyCandidates.ts` | a refused queue write swallowed | 1 | 0 |
| DB-6 | S103 | replica | 2803 applied, rolled back (row gone), applied (FALSE); over a TRUE row both files refused | — | — |

### 5.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2803 exists on
the lane's replica and nowhere else; `intel_safety_candidates_enabled` is
seeded FALSE and is the owner's, and it opens a stage that WRITES to the
moderation queue. In production every intel table holds zero rows and
`intel_live_promoted_scopes` is empty, so a scan there reads nothing, sweeps
nothing and files nothing. The stage is operator-triggered, not scheduled;
a scheduler is one line in `src/index.ts` at integration and this census
will not count the stage as automatic until that line exists. A candidate
is a question; whether anyone answers it — whether a specialist reads the
`place` filter of the admin queue and by what path a confirmed candidate
becomes the `unsafe_density` claim the notice producer projects — is
outside the tree and outside this row. And the three shapes are the three
the served vocabulary can express today: no dwell, no flow, no acoustic or
motion signal feeds them, because no such signal is captured (S28, S29).
