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
| BUILT-AND-CORRECT | **98** |
| BUILT-BUT-WRONG | **26** |
| NOT-BUILT | **2** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (C+W)/127 | **124 / 127 = 97.6 %** |
| **CORRECT%** (raw) = C/127 | **98 / 127 = 77.2 %** |
| **CORRECT% (spec-attributable)** | **26 of the 98 — 20.5 %** |

> **RECOUNTED 2026-09-12 BY THE INTEGRATOR, from the rows and not by addition.**
> §6 and §7 were written concurrently in two worktrees, neither of which could
> see the other's moves. Each closed with its own tally of the table IT could
> see — §6 with C=95 and §7 with C=90 — and each said in its own words that the
> integrator must recount once both were merged rather than add one section's
> moves to the other's headline. This is that recount:
> `check:census-integrity` over the merged document reads **C=98 W=26 N=2 X=1**,
> which is what the four numbers above now state. Neither section's closing
> tally was wrong about its own worktree; neither describes this document.

> **RESTATED 2026-09-12 (§7), from the rows and not by addition.** §7 moves four
> rows into C (S68, S70, S72, S85) and one OUT of it (S97, C → W, because the
> evidence it rested on was a grep that is no longer true). **S66 is built on
> three more surfaces and stays W** — it is a prohibition, and on a default
> deployment none of the three refusals runs; §7.4 gives the reasoning and says
> what a reader who disagrees should do with the other four. These four
> numbers are `check:census-integrity`'s count of the table underneath them in
> THIS worktree, which does not contain the concurrent §6. **The integrator must
> recompute this table after merging §6 and §7 together; do not carry it
> forward by adding one section's moves to the other's headline** — that is the
> failure `check:census-integrity` exists to catch.

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
| S47 | Product surfaces consume projections; they do not reimplement engine logic | **BC** | `src/lib/liveClaimRead.ts` is the single read path, consumed by Map (`mapProjection.ts:98`), Wall (`ContextThreadService.ts:46`), Compass (`CompassMediaContext.ts:58`), Media (`MediaProjectionService.ts:49`), Input (`inputAssistance/liveSuggestions.ts:39`) and Trails (`trailLiveIntel.ts:27`). `LiveForYouService.ts:37-40` reuses `loadNearbyEvents` explicitly so *"The Wall must not implement a second place-state system"*. |
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
coverage** (`lib/discoveryCandidate.ts:122#DiscoveryCandidate`), Compass's
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
(`lib/discoveryCandidate.ts:111#DISCOVERY_CANDIDATE_PROJECTION_FLAG`), and
`whyNow` is always null (`lib/discoveryCandidate.ts:130#whyNow:`) because no
live producer exists for a place on that surface — the module says so itself.
Built, wrong on the one field the row is named for.
*(Re-anchored 2026-09-12 by §7: both line numbers drifted when §7 gave the
field a producer. **SUPERSEDED BY §7** — `whyNow` is no longer always null;
`lib/discoveryLiveRank.ts` produces it and `lib/discoveryCandidate.ts:240` copies
it. The sentence is left standing as §1 measured it; §7.2 moves the row.)*

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
registered at `src/index.ts:149#startSensingRetentionScheduler();`) and the
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
  computes no truth of its own. Registered at the tail of `routes/index.ts:354#compassDecisionRouter`, so no line the other censuses cite in that file moved.
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
  of `routes/index.ts:359#wallMomentsRouter`. 2801 seeds the flag FALSE and
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
  the tail of `routes/index.ts:364#telegraphLiveReferencesRouter`.

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
  the tail of `routes/index.ts:369#adminSafetyCandidatesRouter`;
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

## 6. The stage between the world and the surfaces

**Read against the branch `claude/sensing-lane`, 2026-09-12, by the Sensing
lane.** §6 draws one pipeline — CANONICAL ENTITIES + WORLD / EXPERIENCE STATE
+ USER / TRIP / SOCIAL + SAFETY / POLICY → **CONTEXT KERNEL** → **OPPORTUNITY
ENGINE** → FEATURE-SPECIFIC PROJECTIONS → the surfaces — and this tree had
none of the three middle boxes. S56 read *"no such stage; each surface builds
candidates directly"*; S55 found a context machine that is *"Compass-local …
and has no World, Experience or Attention context"*; S46 found four surfaces
each building its own opportunity. Two of §5's engine rows were in the same
state one layer down: S40 had the crowd vocabulary and *"no `CrowdState`
object"*, S45 had *"no horizon field, no calibration attached to a forecast,
and no `ForecastState`"*.

This section builds those five objects and the route that reaches them. One
migration, **2840**, seeds a flag FALSE — no table, no column, no write path,
and nothing here writes anything at all. Every value is a pure fold over the
ONE live read path every surface already consumes (`lib/liveClaimRead`), the
decision it rests on is §10's engine CALLED rather than restated, and the
route sits in its own file: no existing surface's route, ranker or candidate
builder is touched, so every legacy path keeps working (§1). Every rule went
red under a mutation of the code that pins it before its commit; the mutations
are listed in §6.3.

### 6.1 What was built, and where

- **§5 the Crowd engine's object (S40)** — `lib/crowdState.ts:214#export function buildCrowdState(`
  folds one subject's envelopes into the three axes §5 names and no fourth:
  density from `crowd.level`, momentum from `crowd.trajectory`, and the
  arrival-departure balance from `crowd.direction` with the net accumulation
  that word implies (`lib/crowdState.ts:79#export const NET_ARRIVAL_OF`;
  `test/crowdForecastState.test.ts:96#every direction`). The two axes stay
  two: intelContracts' own ruling that trajectory is intensity and direction
  is flow, and that *"storing one as the other publishes an inference the
  contributor never made"* (`lib/intelContracts.ts:271#Crowd DIRECTION`), is
  enforced rather than quoted — a trajectory is never read as a direction and
  a direction never as a trajectory (`test/crowdForecastState.test.ts:89#never read as direction`;
  B6-M2b red). A missing axis is null with NO refusal; an unrecognised value
  is null WITH a named one, never a guess
  (`test/crowdForecastState.test.ts:108#unrecognised value`). The NEWEST claim
  of an axis wins and the window closes with its FIRST support — the earliest
  expiry among the claims that fed it, never the latest
  (`lib/crowdState.ts:184#export function envelopeTemporal(`;
  `test/crowdForecastState.test.ts:103#the NEWEST claim`; B6-M3, B6-M4 red).
- **§5 it must not claim safety, and cannot claim quality** — `unsafe_density`
  is a specialist-only safety claim, and it is REFUSED as a density rather
  than promoted to the top of the ladder: the level is dropped, the refusal
  `unsafe_density_is_a_safety_claim` is recorded, and the claim feeds nothing
  (`lib/crowdState.ts:227#refusals.push("unsafe_density_is_a_safety_claim")`;
  `lib/crowdState.ts:67#export const DENSITY_LADDER`;
  `test/crowdForecastState.test.ts:121#unsafe_density is REFUSED`; B6-M1 red,
  2 cases). Quality is unrepresentable rather than merely absent: the
  value-bearing keys are the three axes, a caller's extra key is named by
  `crowdStateForeignKeys`, and the serialized state carries no score, rating,
  recommendation, safety word or count
  (`lib/crowdState.ts:119#export const CROWD_STATE_VALUE_KEYS`;
  `test/crowdForecastState.test.ts:131#no quality`).
- **§5 the Forecast engine's object, with the horizon and the calibration the
  row found missing (S45)** — `lib/forecastState.ts:192#export function buildForecastState(`
  extrapolates the current crowd state ONE rung along the density ladder over
  a NAMED horizon (`lib/forecastState.ts:169#export function stepDensity(`;
  `test/crowdForecastState.test.ts:190#one rung`; B6-M8 red), and refuses
  rather than invents in four places: no trajectory evidence is no forecast,
  because silence is not "steady"
  (`lib/forecastState.ts:203#return refuse("no_trajectory_evidence")`;
  `test/crowdForecastState.test.ts:173#silence is not`; B6-M5 red); a safety
  reading makes the subject unforecastable
  (`lib/forecastState.ts:202#safety_level_not_forecastable`; B6-M9 red); a
  horizon past the evidence's usable life is refused
  (`lib/forecastState.ts:87#export const MAX_FORECAST_HORIZON_MINUTES`;
  B6-M10 red); and a trajectory with no level forecasts a DIRECTION and no
  density rather than inventing one. `peaking` is `steady`, not `falling`:
  the evidence says the apex is now and says nothing about a decay rate
  (`lib/forecastState.ts:67#DIRECTION_OF_TRAJECTORY`).
- **§5 a prediction that cannot be read as an observation** — three separate
  mechanisms, because that is the row's whole point. The truth class is
  ASSIGNED `predicted`, never inherited: an `observed`, strong-band,
  many-cohort input still yields a predicted output
  (`lib/forecastState.ts:234#truthClass: "predicted"`;
  `test/crowdForecastState.test.ts:218#ASSIGNED`; B6-M6 red, 2 cases). The
  §18.2 envelope carries `predicted_for` and satisfies lib/experienceTruth's
  predicted_for ⟺ predicted-class invariant on every forecast the module
  returns. And the band can only fall: it is the weaker of the evidence's own
  and the band the CALIBRATION supports, where an uncalibrated forecast's
  calibration band is a ceiling strictly below the Live floor — so no
  uncalibrated forecast can occupy a Live slot
  (`lib/forecastState.ts:90#export const UNCALIBRATED_BAND_CEILING`;
  `lib/forecastState.ts:163#export function bandFromCalibration(`;
  `test/crowdForecastState.test.ts:231#UNCALIBRATED is capped`; B6-M7b red).
  A calibration with an empty sample or no measured accuracy is not a
  calibration (`test/crowdForecastState.test.ts:239#a MEASURED calibration`),
  and the reader supplies none at all, which it says in its own header rather
  than papering over with a default accuracy
  (`lib/contextKernelRead.ts:65#calibration: null`; B6-M25 red).
- **§18.1 the nine contexts, as a platform object (S55)** —
  `lib/contextKernel.ts:49#export const KERNEL_CONTEXTS` is the spec's nine
  names in the spec's order (User · Temporal · Spatial · Trip · Social ·
  Experience · World · Safety · Attention) and
  `lib/contextKernel.ts:222#export function assembleContextKernel(` returns
  every one of them as a value or an explicit null
  (`test/opportunityEngine.test.ts:109#the spec's nine names`). A context
  nobody supplied is UNKNOWN and is REPORTED as unknown, never read as its
  empty value — no trip is not "not on a trip"
  (`lib/contextKernel.ts:244#export function unknownContexts(`). Local time
  comes from a DECLARED offset or is null: the server's clock is not a guess
  about a viewer's evening, and an impossible offset is refused rather than
  clamped (`lib/contextKernel.ts:186#export function localHourFrom(`;
  B6-M17b, B6-M18 red). Safety is DERIVED from the world reading and cannot
  be declared: the kernel takes no safety input at all, and a subject is
  suppressed exactly when the crowd fold refused its level as a safety claim
  (`lib/contextKernel.ts:209#export function deriveSafetyContext(`;
  `test/opportunityEngine.test.ts:144#SAFETY is derived`). The kernel carries
  no viewer id, no profile and no coordinate — the viewer's position becomes
  one ETA scalar per subject in the route and is dropped
  (`test/opportunityEngine.test.ts:157#no viewer id`).
- **§5 / §6 the Opportunity stage, and what it refuses to be (S56, S46)** —
  `lib/opportunityEngine.ts:222#export function buildOpportunities(` runs once
  per subject in the kernel's world context and REIMPLEMENTS NO ENGINE: the
  verdict is `lib/compassDecision.decideCompass` — §10's seven decisions with
  safety first, the live-reading rule, friction, intent compatibility, peak
  interception and the switching cost — and this stage only translates four of
  those seven into opportunities and the other three into refusals
  (`lib/opportunityEngine.ts:72#export const KIND_OF_DECISION`;
  `test/opportunityEngine.test.ts:178#only four decisions`). Relevance is
  user-specific and is built from tables that already exist: the Attention
  Engine's own `RELEVANCE_WEIGHT`, the decision engine's own intent-relative
  value, and a discount when the interception is unknown — an unknown ETA is
  an unknown interception, stated, never assumed reachable
  (B6-M13, B6-M14, B6-M15 red). An undeclared intent is an absence, not a
  preference the engine invents.
- **§5 an opportunity claims nothing about the world** — the projection is a
  canonical subject id, a kind, a relevance for THIS request, the reasons, the
  §18.2 window the evidence supports, the §5.1 truth block OF THAT EVIDENCE
  and the claim refs. It has no world value, and that is enforced on the wire
  rather than asserted in a comment: the route scans both the projections and
  the exact bytes it is about to serialize, and REFUSES the whole response if
  either ever grows a density, a trajectory, a vibe or a count
  (`lib/opportunityEngine.ts:151#export const FORBIDDEN_WORLD_VALUE_KEYS`;
  `lib/opportunityEngine.ts:172#export function opportunityWorldValueKeys(`;
  `routes/opportunities.ts:211#const worldValues`). The guard is not vacuous —
  it finds a planted key (`test/opportunityEngine.test.ts:271#not a vacuous check`) —
  and with one planted in the surface projection the route answered
  `db_error` instead of serving it (B6-M20, red, the refusal observed on the
  wire).
- **§20 safety outranks opportunity, before ranking exists** — a suppressed
  subject yields NO projection at ANY relevance label and a refusal that says
  which kind of "no" it is
  (`lib/opportunityEngine.ts:232#reason: "safety_suppressed"`;
  `test/opportunityEngine.test.ts:211#at any relevance`; B6-M11 red). This is
  a second gate, not the only one: the decision engine already answers SKIP on
  a Live `unsafe_density`, and the stage removes the subject before either
  ranking or serialization.
- **§20 silence is reported, never implied** — every subject that produced no
  opportunity produces a NAMED refusal, and "we could not look" is spelled
  differently from "we looked and there is nothing to act on"
  (`test/opportunityEngine.test.ts:188#a DIFFERENT refusal`; B6-M12 red).
- **§6 the feature-specific projections** — `lib/opportunityEngine.ts:321#export const SURFACE_FIELDS`
  and `lib/opportunityEngine.ts:332#export function projectForSurface(` give
  Map, Discovery, Wall, Home and Compass each a SUBSET of the same projection:
  a surface may drop a field and may never add one, and every value a surface
  receives is copied from the stage's output rather than computed
  (`test/opportunityEngine.test.ts:282#a SUBSET`; B6-M16 red).
- **§6 the route, and what it does not read** — `routes/opportunities.ts:106#router.get(`
  serves `GET /api/intel/opportunities` behind `opportunity_engine_enabled`
  (2840, seeded FALSE), read fail-closed: with the flag absent — production's
  state — it answers `feature_disabled` and reads nothing, which is the case
  the suite poisons the snapshot table to prove
  (`routes/opportunities.ts:116#opportunity_engine_enabled`;
  `test/opportunitiesRoute.test.ts:102#the flag ABSENT`; B6-M19 red). Behind
  it the Live gates still decide whether anything is served: with the pilot
  closed every subject is refused `live_intelligence_unavailable` and no
  opportunity is invented to fill the page
  (`routes/opportunities.ts:153#const readable = await liveLabelsServable`;
  `test/opportunitiesRoute.test.ts:147#Live pilot CLOSED`; B6-M21 red). It
  reads NO trip table — the Trips lane owns those reads, and the TripContext
  is what the caller declared for this request and is stored nowhere. The
  place the viewer is already at is context, not an offer
  (B6-M23 red).
- **§5 / §18.2 the world reading is served where a world reading belongs** —
  the response's `contexts.world` carries each subject's `CrowdState` and
  `ForecastState`, or the forecast's named refusal
  (`routes/opportunities.ts:232#world: kernel.world.subjects.map`;
  `test/opportunitiesRoute.test.ts:197#the WORLD block`). Through the route,
  over the fake PostgREST double, a `busy` + `building` subject serves density
  `busy`, momentum `building`, balance NULL (no `crowd.direction` claim: not
  "holding"), and a forecast at the requested 90-minute horizon that expects
  `packed`, is classed `predicted`, is `calibrated: false` and sits at
  `provisional` — below the Live floor. A subject with no trajectory serves
  `no_trajectory_evidence`; a subject with a safety reading serves no density
  and `safety_level_not_forecastable` (B6-M24 red).
- **§18.2 the six temporal fields, on a served state (S110)** — the shared
  envelope existed and was carried by callerless states; it is now on the wire.
  Every opportunity carries `observedAt` / `effectiveFrom` / `effectiveUntil` /
  `expiresAt` / `freshness` / `predictedFor` as its window, a forecast-backed
  one carrying `predicted_for` and an observation-backed one carrying null, and
  the same envelope rides every served crowd and forecast state
  (`lib/crowdState.ts:184#export function envelopeTemporal(`;
  `test/opportunitiesRoute.test.ts:117#a live reading is one go_now`).
- **2840 executed (DB-7)** — on the lane's local replica the file applied
  inside the canonical chain and the row reads FALSE; deleted and re-applied
  it seeds FALSE again; and applied over a row an operator had set TRUE it
  RAISED its postcondition and committed nothing —
  *"this migration refuses to certify a surface an owner has not enabled"*
  (`migrations/2840_opportunity_engine_flag.sql:54#RAISE EXCEPTION`).
  Never on portava-ci, never on production.

### 6.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S40 Crowd engine → `CrowdState` | W | **C** | The object exists with the row's three axes and no fourth — density, momentum, arrival-departure balance — folded from the one read path, with the safety level refused as a density and no quality field representable (B6-M1, B6-M2b, B6-M3, B6-M4 red); served per subject on `GET /api/intel/opportunities` behind 2840's FALSE flag and route-tested. |
| S45 Forecast → `ForecastState` with calibration | W | **C** | Horizon, `predicted_for` and a calibration block, always classed `predicted` and never inheriting the evidence's class (B6-M6 red), capped below the Live floor while uncalibrated (B6-M7b red), refusing rather than forecasting on no trajectory, on a safety reading, and past the evidence's life (B6-M5, B6-M9, B6-M10 red); served with its refusal beside it (B6-M24, B6-M25 red). |
| S46 Opportunity → `OpportunityProjection` | W | **C** | One shared projection for all five surfaces instead of each building its own, carrying relevance, reasons, the evidence's §5.1 truth and §18.2 window and NO world value — the prohibition enforced on the wire, not documented (B6-M20 red, the response refused). The surfaces' legacy builders are untouched and still run, which is what §1 requires of them. |
| S55 Context Kernel with the nine §18.1 contexts | W | **C** | A platform kernel, not a Compass-local one: the nine names in the spec's order, every one present as a value or an explicit null, unknown contexts reported as unknown, safety derived and undeclarable, no viewer id and no coordinate (B6-M17b, B6-M18 red); assembled per request by the route and consumed by the stage below it. `compass/CompassContextEngine.ts` is unchanged and no pre-existing surface has been migrated onto the kernel — that is integration work, not the row's ask. |
| S56 Opportunity Engine downstream of the kernel | N | **C** | The stage exists between the kernel and the surfaces, calls §10's decision engine rather than restating one rule of it, and feeds five feature-specific projections that may drop a field and never add one (B6-M11 to B6-M16 red); reached from a registered route behind 2840's FALSE flag, with a refusal for every subject that produced nothing (B6-M12, B6-M19, B6-M21 red). |
| S110 Six shared temporal semantics | W | **C** | The envelope the row found on callerless states only is now on a served wire: every opportunity's window and every served crowd and forecast state carries all six, with `predicted_for` set iff the state is predicted and null on every observation (B6-M6, B6-M24 red). |

**Held, with the reason.** **S39** stays W: a presence aggregate still has no
consumer, and publishing one is decision #9. **S42**, **S51** and **S52** stay
W: the Vibe engine, its seven candidate signals and its state are built and
guarded, and not one of the signals has a producer — client capture is
decision #6 and this lane does not take it. **S49** stays W with a narrower
gap: the Map's objects (§1), the Wall's moments (§3) and now every state this
section serves carry truth class, confidence, freshness AND coverage;
Discovery's candidate — §8's row, another unit's file — does not. **S57**
holds C and is less vacuous: the client still computes no crowd, vibe, safety,
opportunity or experience value, and there is now a server stage it could
consume instead. **S47** holds C: the stage reads `lib/liveClaimRead` and
nothing else, and calls the decision engine rather than re-deriving it.
**S53** and **S43** hold C: the Map's ExperienceState is untouched and this
section adds no second one — `lib/crowdState` owns the crowd axes the §5.3
tree also carries, and the two are folded from the same claims by the same
vocabulary. **S8** holds C: `unsafe_density` is refused as a density in one
more place. **S44**, **S60**, **S73**, **S74**, **S78**, **S80**, **S86**,
**S87**, **S88**, **S102** and **S103** are untouched by this section.
**S17** stays X. **S18**–**S21**, **S24**–**S26**, **S30**, **S32**, **S33**,
**S35**, **S111**, **S112**, **S113**, **S118**, **S19** and **S54** are
unchanged here and hold for the reasons their rows and §1.3 give — the
anonymous ingest posture, on-device capture and the signal ingest are the
owner's decisions, and no line of this section touches them.

### 6.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B6-M1 | S40 | `lib/crowdState.ts` | `unsafe_density` admitted as a density | 2 | 0 |
| B6-M2b | S40 | `lib/crowdState.ts` | a balance invented from the trajectory | 1 | 0 |
| B6-M3 | S40 | `lib/crowdState.ts` | the first claim of an axis instead of the newest | 2 | 0 |
| B6-M4 | S40, S110 | `lib/crowdState.ts` | the LATEST expiry as the window's end | 1 | 0 |
| B6-M5 | S45 | `lib/forecastState.ts` | no trajectory forecast as "steady" | 1 | 0 |
| B6-M6 | S45, S110 | `lib/forecastState.ts` | the truth class inherited from the evidence | 2 | 0 |
| B6-M7b | S45 | `lib/forecastState.ts` | the uncalibrated ceiling raised into the Live band | 1 | 0 |
| B6-M8 | S45 | `lib/forecastState.ts` | two rungs, and off the end of the ladder | 1 | 0 |
| B6-M9 | S45 | `lib/forecastState.ts` | a safety reading forecast like any other | 1 | 0 |
| B6-M10 | S45 | `lib/forecastState.ts` | the horizon bound dropped | 1 | 0 |
| B6-M11 | S56 | `lib/opportunityEngine.ts` | the safety suppression dropped | 1 | 0 |
| B6-M12 | S56 | `lib/opportunityEngine.ts` | "could not look" spelled as "nothing found" | 1 | 0 |
| B6-M13 | S56 | `lib/opportunityEngine.ts` | the relevance label ignored | 1 | 0 |
| B6-M14 | S56 | `lib/opportunityEngine.ts` | an undeclared intent read as compatible | 1 | 0 |
| B6-M15 | S56 | `lib/opportunityEngine.ts` | an unknown interception read as reachable | 1 | 0 |
| B6-M16 | S46 | `lib/opportunityEngine.ts` | a surface projection that ADDS a world value | 1 | 0 |
| B6-M17b | S55 | `lib/contextKernel.ts` | 3 a.m. classed as early morning | 1 | 0 |
| B6-M18 | S55 | `lib/contextKernel.ts` | an impossible UTC offset accepted | 1 | 0 |
| B6-M19 | S56 | `routes/opportunities.ts` | the flag read ignored | 2 | 0 |
| B6-M20 | S46 | `lib/opportunityEngine.ts` | a world value planted on the WIRE (the route refused: `db_error`) | 4 | 0 |
| B6-M21 | S56 | `routes/opportunities.ts` | the Live gates ignored | 1 | 0 |
| B6-M22 | S55 | `lib/contextKernelRead.ts` | an unreadable notification preference read as "available" | 1 | 0 |
| B6-M23 | S56 | `routes/opportunities.ts` | the place the viewer is at offered back to them | 1 | 0 |
| B6-M24 | S45 | `routes/opportunities.ts` | the forecast's refusal silenced | 2 | 0 |
| B6-M25 | S45 | `lib/contextKernelRead.ts` | a calibration nobody measured | 1 | 0 |
| DB-7 | S56 | replica | 2840 applied in the chain (FALSE), deleted, re-applied (FALSE); over a TRUE row it raised its postcondition and committed nothing | — | — |

### 6.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2840 exists on the
lane's local replica and nowhere else; `opportunity_engine_enabled` is seeded
FALSE and flipping it is the owner's, because it opens a user-facing surface.
No client calls the route — the five surface shapes exist and no surface
consumes one, so `projectForSurface` is a contract with a registered caller
(the route) and no product reader. Nothing has been migrated ONTO the kernel
either: `compass/CompassContextEngine.ts`, the Wall's candidate loaders and
Discovery's ranker all still build what they build, which is what §1 requires
while a new stage is partial and gated, and which means §6's "surfaces consume
projections" is half-built — the projections exist and are served; the
consumption is integration work with its own owner decision.

The forecast is the weakest object here and says so in its own band: no
producer in this tree supplies a MEASURED calibration, so every forecast the
route serves is uncalibrated and capped below the Live floor by construction —
and `intel_attributions`, which a real calibration would come from, is not in
production. In production every intel table holds zero rows and
`intel_live_promoted_scopes` is empty, so behind the flag the route would
serve no opportunity and an empty world block for every place: what it would
refuse there is the pilot, not the schema. And the whole stage still stands on
human taps: there is no device signal, no acoustic feature and no motion
feature to fold, because none is captured (S28, S29). **Realised in
production: 0.0 %**, unchanged.

**The headline, restated from the rows** (the `## Headline` table at the top of
this document is left as §5 wrote it; this lane and the §7 lane land
separately and the integrator recomputes it after both merge, so the restated
count lives here where "last statement wins" can read it):

| Bucket | Count |
|---|---|
| BUILT-AND-CORRECT | **93** |
| BUILT-BUT-WRONG | **29** |
| NOT-BUILT | **4** |
| CANNOT-VERIFY | **1** |

Headline after §6 in this worktree (last statement wins): C=93 W=29 N=4 X=1

### 6.5 A second pass — the bridge from an opportunity to an outcome

§5.4 draws one more arrow after the stage §6.1 built:

>   WORLD STATE → OPPORTUNITY → ACTION → **EXPERIENCE SESSION** → OUTCOME →
>   MEMORY / CALIBRATION (when permitted)

and one constraint on it: *"It is not a raw tracking history."* S54 read
*"No such object. `CompassLiveEngine.ts` is a plan-timing companion session;
`LayoverSessionService` is layover-scoped. Neither bridges a world opportunity
to an outcome."* This pass builds it, and the interesting part is what it
did **not** build.

- **§19 says inspect before materialising, and this is what that found** —
  `lib/experienceSession.ts:10#§19 SAYS INSPECT` records the mapping: the
  OUTCOME already has a canonical owner, because migration 2130 declined the
  Intelligence Gathering spec's `intel_outcomes` table *"in favour of
  canonical_events"* and `lib/intelOutcomes.ts` is that ruling in code; and
  the ACTION spine already exists, with a payload sanitiser that strips raw
  GPS at every depth. So this bridge adds **no table, no column, no index and
  no verb**. A session is TWO ROWS on the existing spine — an opening
  `direction` event and the outcome's own existing verb — and its state is the
  FOLD over them (`lib/experienceSession.ts:300#export function foldSession(`;
  `test/experienceSession.test.ts:152#the fold takes the CLOSE`). The only
  platform change is one new allow-listed payload key beside `intel`, so the
  I4a/I4b outcome contract stays exact
  (`lib/canonicalEvents.ts:122#"experience_session",`;
  `test/experienceSession.test.ts:164#ALLOW-LISTED`). Migration 2841 seeds a
  flag and states the same reasoning in SQL
  (`migrations/2841_experience_session_flag.sql:41#PRECONDITION FAILED: public.canonical_events`).
- **The bridge itself** — `lib/experienceSession.ts:190#export function openExperienceSession(`
  opens a session against an OPPORTUNITY (lib/opportunityEngine's own four
  kinds, §6.1), carrying the subject, the claim refs the opportunity rested on
  and a bounded window; a kind outside that vocabulary is refused as
  `no_opportunity_reference`, because a session with no opportunity is not a
  bridge (`test/experienceSession.test.ts:69#NOT a bridge`; B7-M3 red).
  `lib/experienceSession.ts:254#export function closeExperienceSession(`
  closes it with a RESULT from the existing outcome vocabulary and OPTIONAL
  feedback on the existing 1..5 scale, and the closing event carries the
  outcome's OWN existing verb — so a closed session is, to every existing
  reader, one of the outcome events that already exist
  (`test/experienceSession.test.ts:113#OWN existing verb`; B7-M4 red, 3 cases).
- **Why it is not a tracking history, structurally** — five separate
  mechanisms, none of them a rule someone has to remember.
  ONE SUBJECT: the envelope has a single `subject_id` and every trail-shaped
  key — path, route, trail, waypoints, visits, previous/next subject, track,
  and the coordinate names — is refused at any depth, at build time and again
  on the wire (`lib/experienceSession.ts:105#export const SESSION_FORBIDDEN_KEYS`;
  `lib/experienceSession.ts:127#export function sessionForbiddenKeys(`;
  `routes/experienceSessions.ts:169#const trail = sessionForbiddenKeys`;
  `test/experienceSession.test.ts:83#cannot be given a trail`; B7-M5 red).
  ONE OPEN SESSION: a second while one is open is refused, so sessions cannot
  accumulate into a parallel trail
  (`routes/experienceSessions.ts:147#already_open`;
  `test/experienceSessionsRoute.test.ts:156#a SECOND session`; B7-M9 red).
  NO HISTORY READ: the store exports exactly three functions — the open
  session, one session by id, and an append — and the suite asserts that set
  (`test/experienceSession.test.ts:188#no list, no history`).
  A BOUNDED LOOK-BACK: the one read cannot see further back than a session can
  live, so no query here could answer "where has this person been"
  (`lib/experienceSessionStore.ts:71#const since = new Date(nowMs`; B7-M12 red).
  A BOUNDED LIFE: `expires_at` is mandatory and at most twelve hours, and an
  unbounded one is refused rather than clamped
  (`lib/experienceSession.ts:63#export const MAX_SESSION_HOURS`; B7-M6 red).
- **Closing is terminal, and an expired window cannot be closed with an
  outcome** — a closed session cannot be closed again (B7-M2 red), and a
  session whose window has passed is refused `expired` rather than accepting a
  late outcome: an outcome reported after the window is not evidence about that
  window, and feeding it to the calibration report would be a lie
  (`test/experienceSession.test.ts:141#an EXPIRED session`;
  `test/experienceSessionsRoute.test.ts:314#an EXPIRED session`; B7-M1 red).
  The state itself is folded, never a stored status somebody could set
  (`lib/experienceSession.ts:228#export function sessionState(`).
- **A failed read is a refusal, never "you have no session"** —
  `lib/experienceSessionStore.ts:80#read_failed` returns a named refusal, and
  the route will not open a second session on the strength of a read that
  failed; a refused WRITE is reported rather than logged and swallowed, which
  is why this module does not use the spine's fire-and-forget `recordEvent`
  (`lib/experienceSessionStore.ts:15#WHY NOT recordEvent`;
  `test/experienceSessionsRoute.test.ts:208#a FAILED read`;
  `test/experienceSessionsRoute.test.ts:220#a refused WRITE`; B7-M7, B7-M8 red).
- **Reached, and keyed on the caller** — three routes behind
  `experience_session_enabled` (2841, seeded FALSE), read fail-closed: with the
  flag absent — production's state — all three answer `feature_disabled` and
  neither read nor write, asserted by counting the rows the double stored
  (`routes/experienceSessions.ts:106#experience_session_enabled`;
  `test/experienceSessionsRoute.test.ts:109#the flag ABSENT`; B7-M10 red).
  Every read and write is keyed on the caller's own id, so another person's
  session simply does not resolve
  (`test/experienceSessionsRoute.test.ts:196#does not resolve`; B7-M11 red).
- **2841 executed (DB-8)** — on the lane's local replica: applied (FALSE),
  rolled back with `db/rollback/2026-09-12-2841-experience-session-flag-rollback.sql`,
  re-applied (FALSE); and over a row an operator had set TRUE **both** files
  refused — the migration raised its postcondition and the rollback refused to
  delete a surface someone had enabled
  (`migrations/2841_experience_session_flag.sql:58#RAISE EXCEPTION`). Never on
  portava-ci, never on production.

### 6.6 Row moves (second pass)

| id | was | now | why |
| --- | --- | --- | --- |
| S54 `ExperienceSession` bridges opportunity → action → outcome | N | **C** | The object exists and bridges §6.1's opportunity kinds to the existing outcome vocabulary, adding no table and no verb — two rows on the canonical spine and a fold over them — and it is not a tracking history by five separate mechanisms: one subject with every trail-shaped key refused at any depth, one open session per viewer, a store with no history read, a look-back bounded by one session lifetime, and a bounded life (B7-M1 to B7-M12 red); reached from three routes behind 2841's FALSE flag, route-tested including the OFF arms that write nothing. |

**Held, with the reason.** **S113** (`ExperienceOutcome`: result / calibration
/ optional feedback) stays **W**, with the gap now narrower and exactly
locatable: the result and the optional feedback are real — a close carries an
outcome from the existing vocabulary and an optional 1..5 rating, on the
outcome's own verb — and there is now an ExperienceSession for an outcome to
close, which is what the row said was missing. The calibration half is
unchanged: `lib/intelCalibrationScheduler.ts:80#payload->intel` counts only
events carrying the exact `payload.intel` envelope, which requires a served
snapshot id and claim id pairing that a session's claim refs do not carry, and
`intel_attributions` (2277) is still absent from production. A session close is
therefore visible to a reader of the session, not to the calibration report.
**S92** and **S112** stay W: a session is not a Memory and this pass added no
lineage stage; `lib/sensingRevocationLineage.ts` is unchanged, and canonical
events are covered by the account-deletion path that already owns that table —
which the rollback file states rather than quietly relying on. **S56**, **S46**
and **S55** hold C from §6.1: the session consumes the opportunity kinds and
adds no second stage. **S1** holds C, and this pass is a test of it: the
obvious way to build a session was a table, and §19's instruction to map onto
canonical owners first is why there is not one.

### 6.7 The mutations, second pass

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B7-M1 | S54 | `lib/experienceSession.ts` | an expired session closed with an outcome | 2 | 0 |
| B7-M2 | S54 | `lib/experienceSession.ts` | closing no longer terminal | 2 | 0 |
| B7-M3 | S54 | `lib/experienceSession.ts` | a session opened with no opportunity kind | 1 | 0 |
| B7-M4 | S54 | `lib/experienceSession.ts` | the close written under the opening verb | 3 | 0 |
| B7-M5 | S54 | `lib/experienceSession.ts` | a trail-shaped envelope accepted by the guard | 1 | 0 |
| B7-M6 | S54 | `lib/experienceSession.ts` | the twelve-hour bound dropped | 1 | 0 |
| B7-M7 | S54 | `lib/experienceSessionStore.ts` | a failed read answered as "no session" | 1 | 0 |
| B7-M8 | S54 | `lib/experienceSessionStore.ts` | a refused write swallowed | 1 | 0 |
| B7-M9 | S54 | `routes/experienceSessions.ts` | a second session opened while one is open | 1 | 0 |
| B7-M10 | S54 | `routes/experienceSessions.ts` | the flag read ignored | 2 | 0 |
| B7-M11 | S54 | `lib/experienceSessionStore.ts` | the actor filter dropped from the read | 1 | 0 |
| B7-M12 | S54 | `lib/experienceSessionStore.ts` | the look-back window unbounded | 1 | 0 |
| DB-8 | S54 | replica | 2841 applied (FALSE), rolled back, re-applied (FALSE); over a TRUE row the migration AND the rollback both refused | — | — |

### 6.8 The ceiling, second pass

Nothing here is deployed, enabled or production-realised. 2841 exists on the
lane's local replica and nowhere else; `experience_session_enabled` is seeded
FALSE and is the owner's, and it opens a surface that WRITES canonical events
for a person — the first write surface this lane has built, which is why both
the migration and its rollback refuse to act over a TRUE row. No client calls
any of the three routes, and no surface offers the action that would open a
session: the opportunity stage that would feed it is itself behind 2840's FALSE
flag. The loop the spec draws therefore stops one arrow short of where it
points: OPPORTUNITY → ACTION → SESSION → OUTCOME is built and closes, and
OUTCOME → CALIBRATION does not carry from here, because the calibration report
counts only the `payload.intel` envelope and `intel_attributions` is not in
production (S113, held W above). And the same floor holds as everywhere else in
this census: in production every intel table holds zero rows, so there is no
opportunity to act on in the first place. **Realised in production: 0.0 %**,
unchanged.

**The headline, restated from the rows after the second pass** (the
`## Headline` table at the top of this document is still left as §5 wrote it,
for the reason §6.4 gives):

| Bucket | Count |
|---|---|
| BUILT-AND-CORRECT | **94** |
| BUILT-BUT-WRONG | **29** |
| NOT-BUILT | **3** |
| CANNOT-VERIFY | **1** |

Headline after §6 in this worktree (last statement wins): C=94 W=29 N=3 X=1

### 6.9 The last arrow — an outcome the calibration report can count

§6.6 held **S113** at W with a precise reason: a session close carried a result
and optional feedback, and `lib/intelCalibrationScheduler.ts:80#payload->intel`
counts only events carrying the exact `payload.intel` envelope, which a
session's claim refs cannot supply. That reason is now closed the only way it
could be closed honestly — by going through the path that already exists.

- **One event, both envelopes** — a close that NAMES the served snapshot and
  claim is recorded through `lib/intelOutcomes.recordIntelOutcome`, the
  existing outcome path, with the session's closure riding as a SIBLING of
  `intel` rather than inside it, so the shared I4a/I4b contract is still
  exactly its six keys (`lib/intelOutcomes.ts:178#experienceSession?: Record<string, unknown>;`;
  `lib/intelOutcomes.ts:204#if (input.experienceSession)`;
  `routes/experienceSessions.ts:220#if (q.snapshotId && q.claimId && q.servedAt)`).
  Through the real route the single written event carries `payload.intel`
  byte-exact — snapshot, claim, subject, outcome, the 1..5 rating and
  `served_at` — and `payload.experience_session` naming the session it closed,
  under the outcome's own verb; the suite then applies the calibration
  report's OWN predicate to it (verb ∈ `OUTCOME_VERBS` AND `payload.intel`
  not null) and it matches
  (`test/experienceSessionsRoute.test.ts:229#a close that NAMES`; B7-M13,
  B7-M14 red).
- **What is NOT a second copy** — the served-plausibility check, the
  claim-belongs-to-this-snapshot check and the per-(actor, snapshot) dedup all
  stay in `recordIntelOutcome`; this route adds none of them. A close naming a
  snapshot the viewer was never served is refused with that path's own reason
  and writes nothing (`test/experienceSessionsRoute.test.ts:296#NOT served`).
- **And when nothing permitted it** — §5.4 says MEMORY / CALIBRATION *"when
  permitted"*. A close that names no snapshot is recorded as the session's own
  event with `calibrated: false`, invisible to the calibration report and
  honestly so: no snapshot id is fabricated to be counted
  (`test/experienceSessionsRoute.test.ts:285#names NO snapshot`;
  `routes/experienceSessions.ts:14#THE LAST ARROW`).

### 6.10 Row moves (third pass)

| id | was | now | why |
| --- | --- | --- | --- |
| S113 `ExperienceOutcome`: result / calibration / optional feedback | W | **C** | All three parts, on one event: the result from the existing outcome vocabulary, the optional 1..5 feedback, and the calibration link — the close writes the exact `payload.intel` envelope the daily calibration report filters on, with the session's closure beside it, through the EXISTING outcome path rather than a second copy of its checks (B7-M13, B7-M14 red; the report's own predicate applied to the written event in the suite). A close that names no served snapshot says `calibrated: false` instead of inventing a snapshot id. |

**Held, with the reason.** The ceiling on this row is now a deployment one and
is stated rather than scored: the calibration reader is gated on
`intel_calibration_report`, `intel_attributions` (2277) is still absent from
production, and `experience_session_enabled` is FALSE everywhere — so no such
event can exist in production today, and the row is C about code that is
correct, reached and mutation-proven, not about rows that exist. **S54** holds
C: the bridge is unchanged; this pass only gave its close a second, richer
destination. **S1** holds C: still no second outcome store — the close writes
one canonical event through the one path that already owned outcomes.

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B7-M13 | S113 | `routes/experienceSessions.ts` | the calibration arm never taken | 2 | 0 |
| B7-M14 | S113 | `lib/intelOutcomes.ts` | the session's closure dropped from the event | 1 | 0 |

**The headline, restated from the rows after the third pass** (the
`## Headline` table at the top of this document is still left as §5 wrote it,
for the reason §6.4 gives):

| Bucket | Count |
|---|---|
| BUILT-AND-CORRECT | **95** |
| BUILT-BUT-WRONG | **28** |
| NOT-BUILT | **3** |
| CANNOT-VERIFY | **1** |

Headline after §6 in this worktree (last statement wins): C=95 W=28 N=3 X=1
## 7. What Discovery ranks on, what a layover cannot outrun, and the place the Map still snaps to

*Written 2026-09-12 by the Sensing lane's surface-integration half (§1, §2,
§7–§17, §21, §22, §24). Agent D holds §3–§6 and §18–§20 concurrently in another
worktree; nothing here enters those files. Where a row's fix lives in the Trips
or Telegraph trees this section says so and leaves the row where it is.*

Three things happened. Discovery, which ranked on taste, graph, behaviour and
trails and read no live state and no safety state at all, now ranks on the eight
inputs §8 names — through the same engine Compass's §10 decision runs on, behind
a flag seeded FALSE. The Layover engine, which did feasibility and safe-return
without ever reading a live claim, now has friction in the arithmetic: a live
queue is minutes, and the existing safe-return engine — not a new one — decides
what those minutes cost. And a row this census had marked BUILT-AND-CORRECT
turned out not to be: **the Map's §22 zone-contribution ingest assigns an
observation to the NEAREST PLACE to satisfy a foreign key**, which is the one
thing §14 and §18.3 both forbid by name. S97 goes back to W. A fourth thing did
NOT happen, and is recorded because it nearly did: S66 ("safety outranks
opportunity") gained the code it was missing on two more surfaces and **stays
W**, because it is a prohibition and on a default deployment none of the three
refusals is switched on.

### 7.1 What was built, and where

**(a) Discovery ranks on live intelligence, and cannot be made to rank on
absence.** `lib/discoveryLiveRank.ts` is a pure engine that grades one served
row on §8's eight inputs — live ExperienceState, forecast, travel time,
friction, compatibility, freshness, safety, and the composite Opportunity value
— as seven axes plus a safety verdict
(`lib/discoveryLiveRank.ts:369#gradeLiveRow`). Every world fact reaches it as a
`LiveClaimEnvelope` from the one gated read path, and is summarised by
`summariseLiveState` and valued by `experienceValue` **imported from
`lib/compassDecision`**, not restated — so Discovery cannot rank on a reading
Compass's decision would refuse, and the two surfaces cannot drift. That reuse is
the §1 directive applied to this work rather than quoted at it.

Four refusals are the load-bearing part, and each is the property a mutation
turned red (§7.3):

- **Safety outranks opportunity, downward only.** A Live-qualified
  `unsafe_density` sets `demoted` (`lib/discoveryLiveRank.ts:421`), zeroes the
  opportunity value, and the sort puts every demoted row behind every
  non-demoted one before any score is compared
  (`lib/discoveryLiveRank.ts:462`). No mode, no weight and no evidence
  combination can promote it; the suite asserts that over all eight modes.
- **Absence is not quiet.** A row with no live reading is not scored at all
  (`lib/discoveryLiveRank.ts:408#hasWorldEvidence`) and keeps its incoming
  position. A distance alone is not world evidence and never moves anything —
  letting it would have been a second, unaudited distance ranker beside
  `lib/discoveryPde`.
- **"Could not look" is not "saw nothing."** A closed Live gate, or a row with
  no canonical subject to look up, is labelled `unreadable` rather than `none`,
  and the two reach the wire as different facts.
- **Busy is not good.** Crowd level reaches the score only through
  `experienceValue`, which is intent-relative and answers null without a
  declared crowd preference. Under the five modes that declare none, two rows
  differing only in how crowded they are get the identical influence, and their
  order is unchanged.

Influence is bounded in POSITIONS, not in score units: each grade carries a
signed influence in −1..1 and the ranker spends it against the incoming
position, capped at `LIVE_RANK_MAX_POSITIONS`
(`lib/discoveryLiveRank.ts:110#LIVE_RANK_MAX_POSITIONS`) over a head window of
`LIVE_RANK_WINDOW` rows (`:112#LIVE_RANK_WINDOW`). A place nobody has reported
on cannot be pushed off page one by one that has been, and a fully-evidenced
place cannot travel from last to first — the suite places a perfect row last in
a 45-row window and asserts both.

The gated half is `lib/discoveryLiveRankRead.ts`: the flag
(`:45#DISCOVERY_LIVE_RANK_FLAG`), the mode parse that refuses an unknown string
rather than honouring it (`:63#parseIntentMode`), and the one call a serve point
makes (`:130#withDiscoveryLiveRank`), which with the flag off returns the very
array it was handed (`:142`) having read no claim. It is wired into the REAL
feed at both serve points, and **before the page slice** so it decides what page
one contains rather than shuffling what page one already held:
`routes/discovery.ts:1737#withDiscoveryLiveRank` (the cache-A path) and
`:2097#withDiscoveryLiveRank` (the cold path). Migration 2850 seeds
`discovery_live_rank_enabled` FALSE
(`src/migrations/2850_discovery_live_rank_flag.sql:39`) and its postcondition
refuses to commit over a TRUE row (`:46`).

**(b) `whyNow` has a producer.** §1 recorded S70 as built and wrong on exactly
one field: `whyNow` was always null because no live producer existed for a place
on that surface. It exists now. `lib/discoveryCandidate.ts:225#whyNowOf` copies
the grounded reasons the rank engine produced — `crowd_busy`,
`trajectory_building`, `walk_in_refused`, `queue_45m`, `reported_vibe_going_off`
— in the claims' own vocabulary, and answers **null**, never `[]`, whenever no
grade was computed or the grade found no reading (`:240#whyNowOf`). "Absent" and
"nothing observed" both read as null; neither can read as "nothing applies".
The route suite asserts both arms with the candidate projection on: the place
with a reading carries `["crowd_busy"]`, the two without carry null.

**(c) The eight intent modes are §8's, over one engine.**
`lib/discoveryLiveRank.ts:99#DISCOVERY_INTENT_MODES` is the spec's list verbatim
and in its order — Right Now, Tonight, Explore, Quiet, Social, High Energy,
Nearby, Trip — and each mode is a weight vector over the SAME axes
(`:152#INTENT_MODE_PROFILES`), never an axis of its own; the suite asserts the
axis sets are identical across all eight. Quiet / Social / High Energy declare a
crowd preference to the shared `experienceValue`; Right Now weights interception,
Tonight the forecast, Nearby travel time, Trip the durability of the window, and
Explore declares an intent with no crowd table — so five of the eight cannot
value a crowd at all. `GET /discovery?intentMode=…` reaches them.

**(d) A layover's friction became minutes the existing engine can see.**
§11 asks the Temporal Freedom Engine to intersect feasibility with live
Experience value, forecast, friction and safe-return. `lib/layoverLiveIntersection.ts`
is that intersection, and it is deliberately **not** a second feasibility
engine: it changes `assess`'s INPUTS and its candidate set, and the existing
`LayoverSafetyEngine` — the one that already holds the certified deadline —
decides. A Live-qualified `queue.wait` is added to the card's activity time
(`lib/layoverLiveIntersection.ts:190`), capped
(`:117#QUEUE_CAP_MINUTES`); a Live-qualified `unsafe_density` or refused walk-in
drops the card (`:179`); survivors order by intent-relative value with a window
that will have decayed before arrival demoted, never dropped
(`:238#compareByLive`). A card with no reading is returned untouched in every
respect. Only chips that are crowd preferences become one
(`:127#LAYOVER_INTENT_BY_CHIP`): `food`, `shopping` and `culture` say what a
traveller wants to do, not how crowded they want it, and map to nothing.

The wiring is `services/airport/LayoverRecommendationService.ts:74#readLayoverLive`
(flag `:42#LAYOVER_LIVE_INTERSECTION_FLAG`, gates, one read per bridged
candidate), called before the assessment loop (`:456#readLayoverLive`), which
filters the drops and orders the rest (`:466`) and hands `assess` the adjusted
minutes (`:496`) that also land on the row (`:507#activity_time_min`). The
landside candidates gained the ONE bridge that makes a live read possible at
all: `discovery_places.canonical_location_id` is now selected and carried, so a
row with no canonical place has no subject and is never looked up. Migration
2851 seeds `layover_live_intersection_enabled` FALSE
(`src/migrations/2851_layover_live_intersection_flag.sql:42`, postcondition
`:49`). The suite drives the REAL `generateRecommendations` over the fake
PostgREST double: flag absent ⇒ the card keeps its own 90 minutes; flag on ⇒ 180,
because a 90-minute live queue is 90 minutes; a Live `unsafe_density` removes the
landside card and leaves the inside-airport ones; a closed pilot and an unbridged
place each change nothing.

**(e) The finding: the Map snaps a zone observation to the nearest place, to
satisfy a foreign key.** S97 was BUILT-AND-CORRECT on the strength of a grep:
*"No nearest-place snapping exists (`grep -riE "nearest place|nearestPlace|snap
to place"` → nothing)."* That grep now returns `routes/mapObservations.ts`, and
what it returns is not a comment about the prohibition — it is the thing itself.
`resolveZoneAnchorSubject` (`routes/mapObservations.ts:656#resolveZoneAnchorSubject`)
reads the `geo_zones` row a §22 zone contribution names, finds the **nearest**
active place inside it (`:648#NEAREST`), and stores the observation against that
place as `subject_id` (`:802`), recording the zone beside it. Its own header
states the motive in the spec's own terms: *"`intel_observations.subject_id` FKs
`public.places`, and a zone is not a place."* That is "assign to the nearest place
merely to satisfy a foreign key", written out.

What the code does carry, and why it is a mitigation rather than a defence: the
`zone_id` is recorded alongside, so the zone is not lost; every failure branch is
fail-closed to `unknown_subject` rather than a mis-file; and the search radius is
capped (`ZONE_ANCHOR_MAX_RADIUS_M = 3_000`) because *"anchoring a crowd-direction
observation to a place 8 km away would attribute it to somewhere the contributor
never was"* — the module knows the hazard and bounds it. But a 3 km bound on a
mis-attribution is a smaller mis-attribution, not an absent one, and §14's
sentence has no radius in it. The path is reachable: the router is mounted
(`src/routes/index.ts:306#mapObservationsRouter`) behind
`map_contributions_enabled` (`routes/mapObservations.ts:741`).

Why this lane does not fix it: the only two fixes are to refuse §22's zone
contributions outright — deleting a Map feature that another spec asks for — or
to let an observation carry a subject that is not a `places` row, which is
`intel_observations.subject_id NOT NULL REFERENCES public.places(id)`
(`src/migrations/2130_intel_storage.sql:142`), the FK this census's own
CORRECTION HEADER names as what caps Sensing. Both are owner decisions. The row
goes to W with that ceiling stated, not to C with a caveat.

Note what this does **not** contradict: §1's re-derivation of S97 cited
`lib/sensingSubjectReconciliation.ts`, which genuinely refuses proximity and has
no distance threshold. That module is correct and is still correct. It is also
not the only resolver in the tree, and the row is about the tree.

**(f) The C rows re-read, and what my own work did to them.** §2, §9, §12, §14,
§15 and §16 were re-read against the code with the new paths in hand:

- **S7 (busy ≠ good)** holds C, on new evidence, because I built the path that
  could have broken it. `discoveryLiveRank` does convert a crowd level into a
  desirability number — but only through `experienceValue`, which is a statement
  about a viewer's declared preference, not about the place; under the five modes
  that declare none it is null and the crowd contributes nothing. The row's old
  evidence ("no enabled path converts activity into a desirability score") is
  now narrower than the truth and the truth is still on the right side of it.
- **S12 (no coverage ≠ quiet)** holds C and gained a second enforcement point:
  an unobserved place is not scored, so it cannot be ranked as though it had been
  observed and found empty (`lib/discoveryLiveRank.ts:408#hasWorldEvidence`).
- **S16 (user dislike ≠ bad venue)** holds C: the three modules added here
  perform no write of any kind — `grep -nE "\.insert\(|\.upsert\(|\.update\(|\.delete\("`
  over all three returns nothing — and read no personal feedback table.
- **S69 (search truth separate from ranking)** holds C, and is the row most at
  risk from this work. `routes/discoverySearch.ts` is untouched; the live layer
  is applied only to the recommendation feed, and it **re-orders, never
  removes** — the unsafe place is demoted to last and is still served. The
  Layover pass does drop a card, and a layover recommendation is not search.
- **S95** holds C: `grep -rn "current_vibe|current_crowd|current_energy" src/` is
  still zero hits; nothing here put dynamic state on a durable row.
- **S89 / S90** hold C: `grep -rn "intel_observations|intel_state_snapshots|liveClaimRead"`
  over `services/rentBuddy/` and `routes/rentABuddy*.ts` is still zero.
- **S99–S101** hold C: `lib/inputAssistance/liveSuggestions.ts` and
  `lib/quickSignal.ts` are untouched; the live layer built here is a ranking
  consumer and produces no label and no claim.
- **S102** holds C with its §3 ceiling unchanged: NOTIFY is still a routing
  decision no dispatcher consumes.
- **S122 / S123 / S126** hold C on this work's own evidence: 2850 and 2851 are
  additive single-INSERT files with a precondition and a postcondition that
  refuses a TRUE row — all four refusals EXECUTED, not read (DB-7, DB-8); both
  new surfaces ship with positive cases, flag-absent, flag-false,
  unreadable-table, gates-closed, malformed-input and expired-claim cases; and
  both flags are seeded FALSE with the enabling named as an owner decision in
  the migration itself.
- **S121** holds C: `grep -rn intel_live_promoted_scopes src/ --include=*.ts`
  filtered to writes still returns **zero** outside tests and scripts — the
  per-scope promotion allowlist has no writer, which is what the row rests on,
  and neither surface built here writes one.
- **S127** holds C: `grep -n "requiresSeparateControl: true" lib/locationPurposes.ts`
  returns six, not four — the row's claim is a floor and the floor still holds.
- **THE ROUTE-MOUNTING CHECK, applied to §2–§5's C rows rather than assumed.**
  A surface graded BUILT that no router mounts is not built, and this census
  has four new routes from the earlier batches. All four are mounted:
  `src/routes/index.ts:354#compassDecisionRouter` (S78, S79, S80, S86),
  `:339#wallMomentsRouter` (S73, S74, S76, S102),
  `:344#telegraphLiveReferencesRouter` (S87, S88, S89) and
  `:349#adminSafetyCandidatesRouter` (S103). Nothing moves; the check is
  recorded because a later reader should be able to see it was made.

### 7.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S68 Rank using live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value | N | **C** | All eight inputs are axes of one pure engine (`lib/discoveryLiveRank.ts:369#gradeLiveRow`) over the one gated live read, reusing Compass's own `summariseLiveState` / `experienceValue` rather than restating them; wired into the REAL `GET /discovery` at both serve points and before the page slice (`routes/discovery.ts:1737#withDiscoveryLiveRank`, `:2097#withDiscoveryLiveRank`) behind 2850's FALSE flag; influence bounded in positions, absence never scored, "could not look" distinguishable from "saw nothing". Mutations B7-M1 to B7-M10 and B7-R1 to B7-R5 each red. |
| S66 Safety constraints outrank opportunity/vibe; a dangerous place is never simultaneously promoted as "best move now" | W | **W** | **Built on three more surfaces and still W, deliberately.** The gap the row named is closed in CODE: Discovery's ranker reads safety state now — a Live-qualified `unsafe_density` demotes behind every other row before any score is compared (`lib/discoveryLiveRank.ts:462`), asserted over all eight modes and from first position — and on the layover surface the same reading removes the card (`lib/layoverLiveIntersection.ts:179`). It does not move because of **this census's own stricter rule for prohibitions** (see *"The rule for prohibitions"*): a "must never" is C when an artifact makes the violation unrepresentable or refuses it, and on a DEFAULT deployment nothing refuses it. Discovery's demotion is behind 2850, seeded FALSE; the layover drop is behind 2851, seeded FALSE; Compass's exclusion is behind an env constant whose own comment reads *"Default OFF"* (`src/compass/CompassLiveConstraints.ts:79#liveConstraintsEnabled`). Only the Map's unconditional priority sort (`lib/mapObjects.ts:335#safety`) holds everywhere, and §1's promotion-stripping addition to it is itself behind 2350. Four surfaces can refuse; one does. B7-M1 and B7-L3 red. |
| S70 Server-built DiscoveryCandidate with why-now, why-for-user, confidence, freshness and truth class | W | **C** | The one field the row is named for has a producer: `whyNow` carries grounded reasons in the claims' own vocabulary (`lib/discoveryCandidate.ts:240#whyNowOf`) and is null — never `[]` — when no grade was computed or no reading was found (`:225#whyNowOf`); route-tested with the candidate projection on, both arms. The other four fields were already carried. B7-R5 red. |
| S72 Intent modes — Right Now, Tonight, Explore, Quiet, Social, High Energy, Nearby, Trip — on the same shared intelligence | W | **C** | The spec's eight, verbatim and in order (`lib/discoveryLiveRank.ts:99#DISCOVERY_INTENT_MODES`), each a weight vector over the SAME axes of the SAME engine (`:152#INTENT_MODE_PROFILES`) — the suite asserts no mode has an axis of its own — and the crowd preference they declare is Compass's `experienceValue`, so "the same shared intelligence" is literal. Reachable as `GET /discovery?intentMode=…`; an unknown string is not honoured as a mode (B7-R4 red). |
| S85 Layover Temporal Freedom Engine intersects feasibility with live Experience value, forecast, friction and safe-return | W | **C** | The row's finding was `grep -rn liveClaimRead services/airport/` → nothing. It reads it now, and intersects rather than competing: a live queue becomes minutes the EXISTING `LayoverSafetyEngine` rates against the certified deadline (`services/airport/LayoverRecommendationService.ts:496`, `lib/layoverLiveIntersection.ts:190`), a live `unsafe_density` or refused walk-in removes the card, a decaying window demotes and never drops, and a card with no reading is untouched. Driven through the real `generateRecommendations` (90 → 180 minutes under a 90-minute queue). B7-L1 to B7-L4 red. |
| S97 Temporary activity must not be forced onto the nearest place ID when ownership is unknown; never assign to the nearest place merely to satisfy a foreign key | C | **W** | **The C rested on a grep that is now false.** `resolveZoneAnchorSubject` (`routes/mapObservations.ts:656#resolveZoneAnchorSubject`) resolves a §22 zone contribution by finding the **nearest** active place in the zone (`:648#NEAREST`) and storing the observation against it (`:802`); its own header gives the motive as the FK — *"`intel_observations.subject_id` FKs `public.places`, and a zone is not a place"*. Mounted (`src/routes/index.ts:306#mapObservationsRouter`) behind `map_contributions_enabled` (`routes/mapObservations.ts:741`). The 3 km ceiling and the recorded `zone_id` bound the mis-attribution; they do not make it absent, and §14's sentence carries no radius. Not fixable in this lane: the alternatives are deleting a §22 Map feature or removing `subject_id NOT NULL REFERENCES places(id)` (`src/migrations/2130_intel_storage.sql:142`), both owner decisions. |

**Held, with the reason.** **S3** and **S106** stay W, unchanged from §1: the
single presence architecture would have to be a store and a fusion layer that
`circle_presence`, `trip_crew_location_sessions`, `lib/locateFriendsSession` and
the Map's `social_zone`/`buddy_zone`/`crew_member` kinds all consume, and the
crew half of that lives in `src/domain/trips/` and `src/server/trips/`, which
this lane may not enter. Naming the change rather than making it: those four
models need one `PresenceEstimate` producer behind
`src/presence/domain/types.ts`'s existing precision ladder, and the ladder is
already right — it is the store and the four migrations of consumers that do not
exist. **S79** stays W and the gap is now exactly one surface: §2 grounded the
DECISION surface by construction (templates over claim values with the truth
class in every sentence), and this lane did not ground `/compass/ask`. What that
needs is a grounding check over the model's final text against the structured
evidence that was in its context — and the ask pipeline does not currently carry
live claims into context in a comparable form (`src/compass/CompassStructuredContext.ts`
reads none; only `CompassMediaContext.ts:263` does), so the honest order is
evidence-in-context first, checker second. A checker wired to no evidence would
be a callerless contract, which this census counts as built and wrong.
**S83** stays W: a `TripWorldContext` needs `ExperienceSession`s (S54, N, and
§5 is the other lane's) and its natural home is the Trips tree. **S92** stays W
for the same reason — the bridge the row names IS an ExperienceSession.
**S71**, **S73**–**S77**, **S78**, **S80**–**S82**, **S84**, **S86**–**S91**,
**S93**–**S96**, **S98**, **S103**–**S105**, **S107**–**S109**, **S120**–**S127**
hold their verdicts; §7.1(f) re-derives S7, S12, S16, S69, S89, S90, S95,
S99–S102, S122, S123 and S126 against this work and moves none of them.

### 7.3 The mutations, in one place

| # | row(s) | file | what was changed | red | green |
| --- | --- | --- | --- | ---: | ---: |
| B7-M1 | S68, S66 | `lib/discoveryLiveRank.ts` | the safety demotion removed | 2 | 0 |
| B7-M2 | S68 | `lib/discoveryLiveRank.ts` | absence scored — every row graded whether or not it was observed | 6 | 0 |
| B7-M3 | S68 | `lib/discoveryLiveRank.ts` | "could not look" collapsed into "saw nothing" | 1 | 0 |
| B7-M4 | S68, S72 | `lib/discoveryLiveRank.ts` | a crowd valued under a mode that declares no preference | 1 | 0 |
| B7-M5 | S68 | `lib/discoveryLiveRank.ts` | an emerging trajectory counted at a reading's weight | 1 | 0 |
| B7-M6 | S68 | `lib/discoveryLiveRank.ts` | the incoming order discarded (base score zeroed) | 1 | 0 |
| B7-M7 | S68, S70 | `lib/discoveryLiveRank.ts` | a whyNow composed where nothing was live | 2 | 0 |
| B7-M8 | S68 | `lib/discoveryLiveRank.ts` | friction ignored | 2 | 0 |
| B7-M9 | S68 | `lib/discoveryLiveRank.ts` | peak interception never fails | 1 | 0 |
| B7-M10 | S68 | `lib/discoveryLiveRank.ts` | the re-rank window unbounded | 1 | 0 |
| B7-R1 | S68 | `routes/discovery.ts` | the rank computed and the un-ranked list served | 2 | 0 |
| B7-R2 | S68 | `lib/discoveryLiveRankRead.ts` | the flag read ignored | 3 | 0 |
| B7-R3 | S68 | `lib/discoveryLiveRankRead.ts` | the Live gates ignored | 1 | 0 |
| B7-R4 | S72 | `lib/discoveryLiveRankRead.ts` | an unknown intentMode honoured as one | 1 | 0 |
| B7-R5 | S70 | `lib/discoveryCandidate.ts` | the whyNow producer disconnected (back to always null) | 1 | 0 |
| B7-L1 | S85 | `lib/layoverLiveIntersection.ts` | the live queue not added to the activity time | 2 | 0 |
| B7-L2 | S85 | `services/airport/LayoverRecommendationService.ts` | the flag read ignored | 1 | 0 |
| B7-L3 | S85, S66 | `services/airport/LayoverRecommendationService.ts` | the drop not applied to the candidate set | 1 | 0 |
| B7-L4 | S85 | `services/airport/LayoverRecommendationService.ts` | a row with no canonical subject treated as readable | 1 | 0 |
| DB-7 | S68, S122 | throwaway PostgreSQL 16 | 2850 applied (row FALSE), re-applied (idempotent), rolled back (row gone), applied again; over a hand-set TRUE row BOTH the migration and its rollback refused; with `feature_flags` absent the precondition refused | — | — |
| DB-8 | S85, S122 | throwaway PostgreSQL 16 | 2851 applied (row FALSE), rolled back (row gone), applied again; over a hand-set TRUE row both files refused; precondition refused with `feature_flags` absent | — | — |

Every mutation was applied to the file named, run, watched red, and reverted
from a byte copy taken before it; the suites are green with none of them
applied. The two route suites were green on their first run, so B7-R1 to B7-R5
are the only evidence that those suites can fail at all — which is why they are
listed individually rather than summarised.

### 7.4 The ceiling

Nothing here is deployed, enabled or production-realised. 2850 and 2851 exist
on this worktree and on a throwaway PostgreSQL 16 that this lane booted for
them, on its own port and its own data directory, with `public.feature_flags`
and nothing else — which is what DB-7 and DB-8 prove and all they prove. That
database is not the local replica the earlier batches used and it carries no
other object, so "the file executes, is idempotent, rolls back, and refuses
both a TRUE row and a missing table" is the whole claim; it is **not** evidence
that either file replays in the canonical chain, and neither has run against
`portava-ci`. `discovery_live_rank_enabled` and
`layover_live_intersection_enabled` are seeded FALSE and are the owner's — the
first changes the ORDER a real user is served on a live surface, the second can
REMOVE a card a traveller would otherwise have been offered and can change a
safety rating, which is the heavier of the two. Behind both, the Live gates
still decide: in production every intel table holds zero rows and
`intel_live_promoted_scopes` is empty, so with both flags on, `GET /discovery`
there would grade every row `none`, move nothing, and return `whyNow: null`
everywhere — a ranking layer with nothing to rank on, and honest about it. No
client sends `intentMode`, so the eight modes are reachable by the API and by no
screen. The layover pass reads one claim per bridged candidate and most
`discovery_places` rows carry no `canonical_location_id`, so even with rows in
the tables most cards would be untouched.

Two rows are the part of this section that makes the census worse rather than
better, which is the point of re-reading a C. **S97** moved the wrong way
because a verdict had been taken from a grep rather than from the object, and
the object had changed. **S66** did not move at all although this section built
the thing it was missing — and that is the more useful of the two findings,
because it is the shape of a mistake this lane could have made four more times.
Under the convention §1–§5 used, code that is built, correct and behind a FALSE
flag is C with the ceiling stated, and S68, S70, S72 and S85 are graded that way
here. S66 is not a capability but a PROHIBITION, and this census's own rule for
prohibitions is stricter: the violation has to be refused, not merely
refusable. On a default deployment a dangerous place can still be promoted as
the best move now by Discovery, by Compass and on a layover card — three
refusals exist and none of them runs. A reader who applies the strict rule to
the capability rows as well should read S68, S70, S72 and S85 as W too; the
distinction is stated here rather than hidden so that disagreement is possible.
**Realised in production: 0.0 %**, unchanged.

Headline after §7 in this worktree (last statement wins): C=90 W=32 N=4 X=1

## 8. The integrator's recount, after §6 and §7 were merged

§6 and §7 were written at the same time in two worktrees, and neither could see
the other's row moves. Each closed with a tally of the table IT could see — §6
with C=95 W=28 N=3 X=1, §7 with C=90 W=32 N=4 X=1 — and each said, in its own
words, that these must not be added together: the integrator has to recount
from the rows once both sections are in one document. This section is that
recount, and it is the last statement in this census.

`pnpm -s check:census-integrity` over the merged document, which takes the last
verdict stated for each requirement id anywhere in the file:

| Bucket | Count |
|---|---|
| BUILT-AND-CORRECT | **98** |
| BUILT-BUT-WRONG | **26** |
| NOT-BUILT | **2** |
| CANNOT-VERIFY | **1** |

**127 of 127 parsed; CONSTRUCTED 124 / 127 = 97.6 %, CORRECT 98 / 127 = 77.2 %.**
The `## Headline` table at the top of this document now states these four
numbers, and no other tally in this file describes the merged census.

**Nothing about the ceiling changed.** Every row §6 and §7 moved rides a flag
seeded FALSE — 2840, 2841, 2850, 2851 — on migrations no database has applied,
and the intel tables hold zero rows in production. **Realised in production:
0.0 %.** S97 moved OUT of C in §7 and stays out; S66 was built on three more
surfaces and deliberately stays W because a prohibition must refuse, not merely
be refusable.


---

## §8 — 2026-09-13: why the 26 BUILT-BUT-WRONG rows are wrong, counted

The distance between this census's CONSTRUCTED (97.6 %) and CORRECT (77.2 %) is
20.5 points, and that distance **is** the W column: 26 / 127. On a census that
is 97.6 % constructed, those 26 are not unbuilt work — they are built work that
is wrong, unreachable, or waiting on somebody. Nobody had sorted them, so this
pass did, and the sort is the finding.

| why a row is W | rows | who can move it |
| --- | --- | --- |
| **(b) logic right, nothing reaches it — and the "nothing" is the OPEN `SENSING_AUTH_POSTURE` decision** | **13** | the owner, by deciding the posture |
| **(d) needs something nobody has written** | **6** | a commissioned build, mostly outside this lane's trees |
| **(c) capped by an owner decision that is NOT the auth posture** | **5** | the owner, per decision |
| **(a) logic wrong in code** | **1** | a lane — with a §24 prerequisite, below |
| **(f) built, and deliberately held W** | **1** | nobody: this is the census working |

**Twenty-five of the twenty-six are not a lane's to move.** Nineteen wait on a
named owner decision, six need work that has not been commissioned, and one —
S66 — is held at W on purpose because a prohibition must refuse, not merely be
refusable. That is the shape of a census whose code is finished and whose
policy is not.

### (b) the 13 held by `SENSING_AUTH_POSTURE`

S18, S20, S24, S25, S30, S33, S35, S39, S42, S51, S52, S111, S112. Each is
built, each was executed with a red mutation in §7, and each admits nobody
because the posture reads `undecided`. **This pass did not touch them and did
not resolve the posture.** They are listed here only so the count is visible:
half this census's correctness gap is one undecided question.

### (c) the 5 held by other owner decisions

| row | the decision |
| --- | --- |
| S19, S26, S118 | `intel_observations.actor_id uuid NOT NULL REFERENCES profiles(id)` is the design. Removing it is the owner's. |
| S32 | there is no signal ingest, only human-claim capture. Building one is the posture question wearing another name. |
| S97 | the §22 zone anchor resolves to the NEAREST place to satisfy an FK. §7 ruled the alternatives — delete a Map feature, or drop `subject_id NOT NULL REFERENCES places(id)` — both owner decisions. **Re-read this pass and the ruling stands.** |

### (d) the 6 that need work nobody has commissioned

S3 and S106 need one `PresenceEstimate` store and fusion layer behind the
already-correct ladder in `presence/domain/types.ts`, and the crew half lives in
trees this lane may not enter. S21 needs an on-device reduction path: the store
is right and the boundary is server-side, and moving it is a client capture
change, not a server edit. S79 needs live claims carried into `/compass/ask`'s
context before a grounding checker can exist — §7 already establishes that
order. S83 and S92 both need `ExperienceSession` (S54), which does not exist.

### (a) the 1 — and a row correction, because its stated reason is now false

**S49's verdict is right and its evidence is wrong.** The row reads: *"Three of
four. `MapObject` carries `freshness`, `confidence`, `sourceClass` and
`provenance`; it carries **no coverage**, and no truth class per S48."* Executed
2026-09-13, both halves of that are false:

- **S48 moved W→C** in this census's own §6, so there IS a canonical truth
  vocabulary — seven classes with CORROBORATED representable
  (`` `artifacts/api-server/src/lib/truthClass.ts:1#/**` ``).
- **`MapObject` carries both fields.** `truthClass` and `coverage` are declared
  on the envelope
  (`` `artifacts/api-server/src/lib/mapObjects.ts:454#truthClass?:` ``),
  the vocabulary is pinned mutually-assignable with the Wall's so the two cannot
  drift
  (`` `artifacts/api-server/src/lib/mapObjects.ts:278#const _truthClassPin: MutuallyAssignable<TruthClass, WallTruthClass> = true;` ``),
  and `applyLiveClaims` sets them from the ExperienceState
  (`` `artifacts/api-server/src/lib/mapProjection.ts:800#experienceState.truth.truthClass,` ``).
- A **shared envelope carrying exactly the four** exists and is adopted by
  thirteen modules — crowd, vibe, forecast, opportunity, safety, compass
  decision, wall moments, discovery live-rank, layover intersection
  (`` `artifacts/api-server/src/lib/experienceTruth.ts:43#export interface TruthMetadata {` ``).

**The row stays W for a different reason, one nobody had written down.** The one
server-built state Discovery consumes, `DiscoveryCandidate`, carries truth class,
confidence and freshness and **no coverage**
(`` `artifacts/api-server/src/lib/discoveryCandidate.ts:122#export interface DiscoveryCandidate {` ``)
— even though the grade it is built from already carries a full `TruthMetadata`
including coverage
(`` `artifacts/api-server/src/lib/discoveryLiveRank.ts:210#TruthMetadata` ``).
So the gap is one field on one interface, and the value to put in it is already
in the same function.

**It was NOT built here, and the reason is a real one rather than a budget
one.** `MapObject`'s own comment says §24's coarsening must be able to REMOVE
`coverage`, *"because `coverage` restates the cohort `count` deletes"*, and the
Map strips it inside a protected zone. `DiscoveryCandidate` does not run
`protectedLocations`. Copying the bucket across without that pass would publish,
on Discovery, a cohort signal the Map deliberately withholds for the same place
— closing a census row by opening a §24 hole. **The decision this surfaces:
either route `DiscoveryCandidate` through the same coarsening, or rule that a
four-value coverage bucket over an already k-gated state is not protected-zone
sensitive. Either is an owner's call and either closes S49.**

### (f) the 1 held on purpose

S66. Built on three more surfaces in §7 and still W, because a dangerous place
can be refused by three surfaces and is refused by none. Recorded here so the
count of "W rows a lane should move" is not inflated by it.

### C rows executed this pass, and what happened

Seven BUILT-AND-CORRECT rows were re-executed looking for a backward move —
the S66 / S97 outcome is what a working census looks like, and a pass that
finds none should say so rather than imply it did not look.

| row | the claim | result |
| --- | --- | --- |
| S13 | ≥15 actors, ≥5 groups, ≤20 % single-group share, 10-minute delay | **Holds**, value for value, at the cited lines. |
| S16, S67 | `intelProjection.ts` is the SOLE writer of `intel_state_snapshots` | **Holds.** `IntelCaptureService` only reads it (invalidation targets); the only other writes are a retention sweep and two backfills, both in migrations. |
| S47 | product surfaces consume projections and do not reimplement engine logic | **Holds**, and it survived the hardest case: census-map M139 records the client's rollback projector as a second on-device reconstruction, but that module shapes only and refuses to invent freshness or a confidence band. |
| S57 | clients compute no crowd / vibe / safety / opportunity state | **Holds.** Every client reference to `activity` reads `obj.activity`; none derives one. |
| S90, S109 | Rent-a-Buddy reads no intel table | **Holds.** |
| S101 | create-content and observe are separate commands | **Holds.** No path from a post to a claim; `quickSignal` and `mapContributionToClaim` are the only two mappers. |

**No backward move was found.** One row's stated reason was falsified (S49,
above), which is the same defect in a weaker form: a verdict that is right for a
reason that stopped being true.

### What this pass did NOT do

- It did not resolve `SENSING_AUTH_POSTURE`, and did not move any of the 13
  rows that wait on it.
- It did not add `coverage` to `DiscoveryCandidate`, for the §24 reason above.
- It built nothing in this census. `head_commit` is unchanged and no sensing
  row moved in either direction; S49's **evidence** is restated below, its
  verdict is not.

### Row corrections

| id | was | now | why |
| --- | --- | --- | --- |
| S49 `MapObject` | W | **W** | Verdict unchanged, evidence replaced. The stated reason — "no coverage, and no truth class per S48" — is false on both halves since §6 moved S48 to C and `MapObject` gained `truthClass` / `coverage`. The true remaining gap is `DiscoveryCandidate` carrying three of the four. |

## §9 — 2026-09-13: what `SENSING_AUTH_POSTURE` actually blocks, enumerated rather than asserted

Measured at `d9ab209d7`. `head_commit` is unchanged; §1–§8 stand as written.
**No verdict moved in either direction, and nothing was built.** §8 said half
this census's correctness gap is one undecided question and left the sentence
there. This section opens it, because "the owner must decide" is the kind of
claim a lane can be told and cannot check — and it is checkable.

### §9.1 The blockage, stated as a fact about the tree

`SENSING_AUTH_POSTURE` is a source constant, not a flag and not a database row —
`` `artifacts/api-server/src/lib/sensingAuthPosture.ts:54#export const SENSING_AUTH_POSTURE: SensingAuthPosture = "undecided";` ``
— and the module says in its own header that there is *"deliberately no
environment variable or flag that can flip it at runtime."* So no deploy and no
flag flip can move any row that waits on it: only a reviewed diff can, which is
what makes these thirteen different in kind from census-map's 41.

**What it blocks is not a refusal. It is the absence of a caller.**
`sensingEligibility` FAILS CLOSED while the posture reads `undecided`, so a
route that called it would refuse everyone — but no route calls it. Enumerated
exhaustively across both trees (every reference to `sensingEligibility`,
`postureAdmitsAnonymous` and `SENSING_ISSUANCE_CLASSES`, opened one at a time,
with no `head -N` applied to any search asserted here as an absence):

- `` `artifacts/api-server/src/lib/sensingAuthPosture.ts:90#export function sensingEligibility(` `` has **two** referrers. One is
  `src/test/sensingAuthPosture.test.ts`. The other is
  `src/lib/sensingContributionSession.ts`, which imports the issuance-class
  vocabulary and not the function.
- **No route imports any sensing contribution module.** The whole stack —
  `sensingAnonStore`, `sensingAnonService`, `sensingContributionSession`,
  `sensingContributionPolicy`, `sensingPresenceState`, `sensingCoverageAggregate`,
  `sensingDifferencingGate`, `sensingRevocationLineage` — is referenced only by
  its own tests, by its own siblings, by `lib/envValidation.ts` and by
  `scripts/checkCensusFreshness.ts`.
- **`sensing_anon_contributions` has no writer in production code.** The only
  non-test, non-migration module that names the table besides the store itself
  is the retention sweep
  (`` `artifacts/api-server/src/lib/sensingRetentionScheduler.ts:156#gate: "sensing_anon_contributions must exist in this database",` ``),
  which deletes. `src/index.ts` starts that scheduler and imports nothing else
  from the stack.

> **So the posture blocks the EXISTENCE of an ingest route, not its behaviour.**
> The thirteen rows are not "built and refusing"; they are "built and
> unaddressed". Registering a route that called `sensingEligibility` today would
> add a handler that returns `posture_undecided` to every caller forever, which
> moves no row in this census and is the vacuous shape §7 already refuses.

### §9.2 The thirteen re-read, and the count checked

S18, S20, S24, S25, S30, S33, S35, S39, S42, S51, S52, S111, S112 — thirteen ids,
each opened at its last statement. Every one closes on a clause of the same
shape: *"no writer is registered"*, *"admitting nobody by owner decision"*,
*"nothing publishes an aggregate for it to guard"*, *"nothing issues a session"*,
*"the ingest they protect does not exist"*, *"no surface consumes it"*, *"not one
signal is produced anywhere"*, *"nothing can populate it"*, *"the resolver has no
caller"*, *"nothing bridges to them"*. **Thirteen of twenty-six is 50.0 %** — §8's
*"about half"* is exact, not rounded, and this section could not find a
fourteenth or a twelfth.

### §9.3 S49 re-executed — the §24 objection holds at both of its lines

§8 declined to add `coverage` to `DiscoveryCandidate` because the Map strips it
inside a protected zone and Discovery does not run that pass. Both halves were
re-executed here rather than taken:

- The Map does strip it, for the stated reason —
  `` `artifacts/api-server/src/lib/protectedLocations.ts:748#delete out.coverage;` ``,
  under a comment reading *"`coverage` restates the cohort that `count` was
  deleted for."*
- Discovery does not run it. `` `artifacts/api-server/src/lib/discoveryCandidate.ts:122#export interface DiscoveryCandidate {` ``,
  `lib/discoveryLiveRank.ts` and the `routes/discovery*.ts` handlers contain
  **zero** references to `protectedLocations`, `protected_zones` or
  `protectedZone`.

So copying the bucket across would publish on Discovery a cohort signal the Map
withholds for the same place. **S49 stays W, the decision stays the owner's, and
this section adds only that §8's reasoning survived being checked.**

### §9.4 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| S49 | W | **W** | Verdict unchanged, and §8's *reason* re-executed rather than restated: the Map's `coverage` strip and Discovery's absence of any protected-zone pass were both confirmed at the lines above. No new evidence, no move. §9.3. |

Nothing else moved. **No row was built.** This census's headline is unchanged
and is restated from `pnpm -s check:census-integrity` rather than by hand:
**127 rows — 98 C, 26 W, 2 N, 1 X.** CONSTRUCTED 97.6 %, CORRECT 77.2 %, the
distance still 20.5 points and still the W column.

### §9.5 What this section could not settle

**It cannot prove the thirteen are ALL of it.** §9.2 verified that each of the
thirteen closes on an "unreached" clause; it did not verify that no row OUTSIDE
the thirteen also waits on the posture, because that would mean re-executing the
other ninety-eight C rows and this section executed none of them. §8's own
sample found one C row whose stated reason had quietly stopped being true
(S49's), and nothing here re-ran that search.

**And the enumeration in §9.1 is the same class of claim it criticises.** It is
an asserted absence. It was settled by opening every reference rather than by a
grep that stops, which is the strongest method available in this tree — and
there is still nothing in this repository that can check whether a stated
absence was actually searched for.
