# Portava Map — Requirement Census

> ## CORRECTION HEADER — added 2026-09-07 after independent re-measurement
>
> This census states "**Database: Not queried**". A later pass DID query both
> databases, reproduced most of it, and found three things this document gets
> wrong. The body below is unedited; these corrections take precedence.
>
> **1. Attribution is 75.8 %, not 76.5 %.** Re-measured by resolving the first
> cited path of every BUILT-AND-CORRECT row and testing that file for a Map-spec
> citation: 218 rows resolvable, 215 cite, 3 do not. Two of the three —
> **M144 (`lib/mapTravelers.ts`) and M142 (`services/discovery.ts`)** — pre-date
> the Map spec and cite nothing, so by this census's own rule they are not
> spec-attributable. Verified: **222/293 = 75.8 %**. The denominator itself
> reproduces exactly (M1–M293, no gaps; C 235 / W 48 / N 5 / CV 5).
>
> > **RESTATED 2026-09-14 — the re-measurement stands; the reason given for excluding M142 and
> > M144 does not.** Resolving each row's first cited path and testing that file for a Map-spec
> > citation is exactly the right method, and 215-of-218 is the strongest attribution evidence in
> > this corpus. But *"pre-date the Map spec and cite nothing"* mixes two tests. **"Cite
> > nothing" is sufficient on its own** to keep a row out of the attributable count — that count
> > means "carries an in-file citation of this spec", and these do not. **"Pre-date" adds
> > nothing and must not be relied on**: a file older than the spec's upload may still have been
> > written from it. So M142 and M144 are **attribution UNKNOWN**, not "not this spec's", and
> > **the 222/293 figure is unchanged** — only the label on the three excluded rows moves.
> > See `docs/architecture/attribution-method.md`.
>
> **2. "`map_projection_enabled` seeds FALSE (2201)" is wrong: the row does not
> exist in production at all.** The only `map_*` flags there are
> `map_compass_commands_enabled` and `map_search_enabled`, both TRUE. 2201, 2218
> and 2295 are unapplied, as 2202/2217/2219/2224 are. The consequence is the same
> (a missing flag reads false) but the PREREQUISITES FOR FLIPPING IT DIFFER, which
> matters to anyone planning a rollout.
>
> **3. `geo_zones` holds 0 rows in production — an independent second blocker
> this census does not record.** M5/M67/M119 attribute Crowd Flow's death solely
> to the absent consent table. The empty zone model kills it separately:
> `routes/mapProjection.ts:919#no_zone_model` refuses with `no_zone_model`. *(Line repointed 2026-09-14 from 836, which is 62 lines short of the branch; the fact is unchanged.)* Populating
> `geo_zones` is an ops action, not a migration, so applying every pending
> migration would still leave Crowd Flow dark.
>
> Confirmed rather than corrected: `intel_state_snapshots`, `intel_claims`,
> `intel_observations` and `intel_live_promoted_scopes` all hold 0 rows in
> production, and `user_location_state` holds 5 rows of which **0 are within 60
> minutes**, so the `social_zone` layer is empty there whatever the flags say.
>
> **Method blind spot, confirmed.** This census scored only artifacts citing the
> Map spec, so `domain/trips/services/tripCrewLocation.ts` — which cites Trips — was invisible to
> it, and the stale-crew-location defect had to be found by the Trips census
> instead (fixed in `0b4f1934`). The other people-bearing readers were then
> checked for the same shape: `buddyMapRead.ts` plots a declared meetup base, not
> a live position, so it makes no staleness claim.
>
> **The number, stated twice, because the two are not comparable.**
> Against this spec alone (denominator 293): **96.6 % constructed / 80.2 %
> correct / 75.8 % attributable** — unchanged by the Sensing §7 work, because
> every new behaviour sits behind flags that do not exist in production.
> Against this spec PLUS the ten Sensing §7 obligations (denominator 303):
> **96.7 % constructed / 79.2 % correct** under the production rule, or 80.9 %
> code-level in CI with the flags flipped. Do not publish these as one figure.
>
> **Order of operations if the map is ever to be lit.** Apply **2217
> (`protected_zones`) FIRST** — with the table absent, `loadProtectedZones`
> returns null, both routes answer the empty envelope, and the client treats
> `enabled:true, objects:[]` as an answer rather than falling back
> (`useMapEntities.ts:55-67`). Flipping the gateway before 2217 blanks the map.
> Then 2201 to seed the flag; then per layer, independently: 2218 + 2224 +
> curated `geo_zones` rows for Crowd Flow, 2295 for World Intelligence, 2350 for
> the three Sensing behaviours, a populated `intel_live_promoted_scopes` (a human
> allowlist by design) before any ExperienceState or trend can appear, 2219 for
> Locate My Friends, 2202 for telemetry.


| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Map_Developer_Architecture_and_Design_Spec.txt`, §1–§39. The `.docx` beside it is the authority and **never had to be exercised** — see "The .docx question" below. |
| **Tree censused** | branch `claude/portava-continuation-uqta94`, HEAD `68ed59d9`, 2026-09-07. |
| `head_commit` | `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482, replacing `42aeac38`. **This census is a different case from the other ten re-declared in the same pass.** `42aeac38` was a VALID ancestor of `main`, not an orphan; this census was not broken by the squash. It was STALE in the ordinary way — counted files had changed since `42aeac38` — and that staleness was covered by an entry in CENSUS_STALENESS_ACKNOWLEDGED.json whose per-file argument is preserved under `retired`. That entry was retired in this pass because the squash spent every acknowledgement in the file at once, so the re-declaration now does its job: at `1fe72289b` zero counted files have changed. Nothing was re-measured and NO verdict moves. The prior declaration follows. — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. Its verdicts were taken at a pre-squash working tree that **exists nowhere**: verified against FULL history (`git fetch --unshallow`, 4,300 commits, then `git cat-file -e`), not assumed — a shallow clone had made every such commit look unresolvable for the wrong reason. So `nobody` can diff that tree against `42aeac38`, and this declaration **does not claim that interval was empty**. What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the paths in `CENSUS_SCOPE` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED — the weakest of the three states, not the safest. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. Declared by the Trips lane while recounting the sibling census; if this lane disagrees, reverting costs only the check. |
| **Method** | Requirement-level, four buckets, exactly one bucket per requirement. Every BUILT verdict cites a `file:line` I opened and read. |
| **Database** | Not queried. Every production storage fact below is the ground truth supplied in the brief, or `artifacts/api-server/src/scripts/checkProductionDrift.ts`, which is in the tree. |
| **Section count** | The brief says 39. **The brief is right.** Both the `.txt` and the `.docx` carry exactly 39 numbered sections, `1. Product Definition` … `39. Final Architecture Rule`. Unlike the sibling censuses, I have no correction to make. |

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **293** |
| BUILT-AND-CORRECT | 235 | **237** |
| BUILT-BUT-WRONG | 48 | **46** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **5** |
| **CONSTRUCTED%** = (237+46)/293 | **283 / 293 = 96.6 %** |
| **CORRECT%** (raw) = 237/293 | **80.9 %** |
| **CORRECT% (spec-attributable)** = 226/293 | **77.1 %** |
| CANNOT-VERIFY share | **5 / 293 = 1.7 %** |

*The two-column rows are the 2026-09-13 pass: M201 and M226 moved W→C after
being built and executed. CONSTRUCTED% does not move, and that is the point —
these were BUILT-BUT-WRONG rows, so closing them is a pure CORRECT% gain. §40
records the moves, the mutations, and what was left alone.*

### The attribution finding, stated first because it is the one that differs

**The two prior censuses returned 0.0 % spec-attributable. This one does not.
It returns 76.5 %, and that is not a rounding artifact — it is a different
category of result.**

The Sensing census tested its spec's attribution claim with:

```
grep -rliE "Sensing \+ World|Sensing/World|World / Experience Intelligence" \
  --include=*.ts --include=*.sql --include=*.md artifacts/api-server/src travel-buddy-standalone/src docs
→ (no matches)
```

The same test against this spec:

```
grep -rn "Map spec" --include=*.ts --include=*.tsx --include=*.sql --include=*.md .
→ 88 files, excluding node_modules and the sibling censuses
```

They are not passing mentions. They are section-numbered build records in file
headers, migration comments and test headers:

| Artifact | Line 2 of the file |
| --- | --- |
| `artifacts/api-server/src/lib/mapObjects.ts:2` | *"server mirror of the Map Object contract (Map spec §18)"* |
| `artifacts/api-server/src/lib/mapProjection.ts:2` | *"the Map Intelligence Gateway's shaping layer (Map spec §19)"* |
| `artifacts/api-server/src/lib/crowdFlowProducer.ts:2` | *"the PRODUCER half of Map spec §10 Crowd Flow"* |
| `artifacts/api-server/src/lib/protectedLocations.ts:2` | *"Map spec §24, 'Protected Location and Safety Rules'"* |
| `artifacts/api-server/src/lib/temporalProjection.ts:2` | *"the PRODUCER half of Map spec §15 Time Machine"* |
| `artifacts/api-server/src/lib/locateFriendsSession.ts:2` | *"the server half of Map spec §12 'Locate My Friends'"* |
| `artifacts/api-server/src/lib/mapAggregation.ts:2` | *"the SERVER half of Map spec §31's"* |
| `travel-buddy-standalone/src/features/map/vocabulary.ts:2` | *"the map's shared enumerations (Map spec §17, §30)"* |
| `travel-buddy-standalone/src/features/map/layers/layerModel.ts:2` | *"Map spec §16, 'Layers and Progressive Disclosure'"* |
| `travel-buddy-standalone/src/components/map/MapBottomActions.tsx:2` | *"the persistent action rail (Map spec §3, §25)"* |
| `artifacts/api-server/src/migrations/2218_crowd_flow.sql:1` | *"feature flag for Map spec §10 Crowd Flow"* |
| `artifacts/api-server/src/migrations/2217_protected_locations.sql:3` | *"Protected location policy (Map spec §24)"* |

Eight migrations (2201, 2202, 2216, 2217, 2218, 2219, 2224, 2295), ~40 server
modules, ~70 client modules, and ~57 server + ~140 client test files exist
*because of this document*. The git history is unambiguous — 30+ commits of the
form `feat(map): §NN …` (`git log --oneline -- travel-buddy-standalone/src/features/map`),
including `feat(map): §25 "Share permitted location" — bounded share channel on §12 session`
and `feat(map): §36 Phase 7 contract — four World Intelligence kinds on both mirrors`.

**So the Map is the one spec in this family that produced its own
implementation.** The 11 BUILT-AND-CORRECT verdicts I do *not* attribute to it
are itemised in "Attribution" below.

### The finding that outranks the headline

**In production, `GET /api/map/projection` — the Map Intelligence Gateway, the
single artifact §19 exists to demand — returns `objects: []` on both branches of
its feature flag.**

Not "returns little". Returns nothing, deterministically, and I can show it
without querying anything:

1. `protected_zones` **does not exist in production** (ground truth; ratcheted
   `unapplied` at `artifacts/api-server/src/scripts/checkProductionDrift.ts:110`).
2. `loadProtectedZones` selects from it and returns `null` on any error —
   `artifacts/api-server/src/routes/mapProjection.ts:196-203`. The header at
   `:181-186` states the intent exactly: *"a failed read returns null, and the
   caller answers with the empty envelope instead of serving unprotected
   objects."*
3. The caller does that — `artifacts/api-server/src/routes/mapProjection.ts:964-979`:
   `if (zones === null)` → `res.json({ enabled: true, objects: [], … sources: [] })`.
4. `GET /api/map/projection/temporal` has the identical branch at
   `artifacts/api-server/src/routes/mapProjectionTemporal.ts:574-591`.
5. And if the flag is *off* — which is how migration 2201 seeds it,
   `artifacts/api-server/src/migrations/2201_map_projection_flag.sql:16-18`,
   `('map_projection_enabled', FALSE, …)` — the route returns
   `{ enabled: false, objects: [] }` at `routes/mapProjection.ts:498-500`.

Both branches are empty. This is a **fail-closed** design working exactly as
written, so nothing leaks; but it means the §19 gateway has never served a
single MapObject in production, and every verdict below that cites it describes
code that is correct and would run, not code that has run.

There is a second-order consequence the code comments themselves predict.
`travel-buddy-standalone/src/hooks/useMapEntities.ts:55-67` — *"THE FALLBACK IS
ALL-OR-NOTHING, ON PURPOSE… When the gateway ANSWERS, it owns every layer, even
the ones it returned nothing for"* — and `:702-704` treats `enabled: true` as an
answer. So **flipping `map_projection_enabled` on in production today would
blank the map**, because the gateway would answer `enabled: true, objects: []`
and the client would correctly decline to fall back. The flag is not a rollout
switch until `protected_zones` is applied. That is the single most actionable
sentence in this document.

### What that does to §19 itself

With the flag off, the client runs the rollback path: five per-layer fetches
normalised on-device by `travel-buddy-standalone/src/features/map/projection/clientProjection.ts`.
That is *precisely* what §19 forbids ("Never place raw database rows directly on
the map"; "The mobile client should not independently reconstruct Portava
intelligence rules"). The gateway is built, tested, guarded
(`artifacts/api-server/src/test/gatewayBypassGuard.test.ts`) — and not in force.
Hence §19's two central rules score **BUILT-BUT-WRONG**, not CORRECT, at M133
and M139.

---

## 1. The .docx question

The brief makes the `.docx` authoritative. I extracted `word/document.xml`,
stripped tags, and compared paragraph-by-paragraph against the `.txt`:

```
349 paragraphs extracted; diff vs docs/specs/…Spec.txt (leading blank line dropped)
→ 1 difference: "\ No newline at end of file" on the final line
```

**The two are byte-identical.** No verdict here rests on a transcription
difference, and the authority clause never had to be exercised.

---

## 2. Denominator — how 293 was decided

One requirement = one independently testable assertion, falsifiable by reading
this tree. The rule, applied uniformly:

- **A bullet asserting a required property, behaviour or prohibition = 1.**
  (§4's eight appearance bullets; §37's nine non-goals; §28's eight cache rules.)
- **A table row naming a required artifact, kind, layer, surface, mode or state = 1.**
  (§6's fifteen visual bindings; §17's five zoom rows; §20's thirteen ownership
  rows; §16's eleven core layers; §30's seven modes, four overlays and eight
  camera states; §27's nine search categories; §22's eight contribution types;
  §12's six signal rungs; §11's nine Trip Map contents; §8's eight sheet blocks.)
- **An enumerated vocabulary of display VALUES inside a single named axis = 1.**
  §7's table is column-oriented — a row ("Very Quiet | Increasing quickly |
  Confirmed | Live") is not a coherent assertion, but each *column* is. So §7
  contributes 4 axes + 1 lead rule = 5, not 22. Same rule gives §10's five flow
  states 1 and §13's nine primary intents 1. §6's table is row-oriented (each
  row binds one visual to one meaning) and so contributes per row. **This is the
  one place two tables in the same spec are counted differently, and the reason
  is their orientation, not convenience.**
- **A declared interface or discriminated union = 1** for the contract (§18 = 2:
  the kind union and the object interface). Members carrying independent
  behaviour are counted in the section that governs them (§23 privacy,
  §31 priority, §7 freshness), never twice.
- **A named pipeline whose stages are separately observable = 1 per stage.**
  (§21's seven; §33's six; §19's four service stages.)
- **Narrative, rationale and restatement = 0.** §1 contributes 1 (the
  projection-layer principle), §38 contributes 1 (the scenario must be walkable),
  §39 contributes 1 (the seven-questions gate). The rest of those sections is prose.
- **Duplicates merge to a single id at first occurrence.** §25's persistent
  action rail is §3's, counted once at M17. §24's "safety takes precedence" and
  §5's are counted once at M27.

**§29 is counted at 6, not 31.** The section is titled *"Recommended* Mobile
Client Structure" and lists 31 filenames. I count one requirement per directory
(`/screens`, `/modes`, `/components`, `/state`, `/services`, `/types`) — the
testable assertion is that each responsibility has a home, not that a file
carries a particular name. A reader who prefers per-file counting should add 25
to the denominator; the §29 rows below name exactly which files exist and which
do not, so that recount is reproducible from this document.

Per-section contribution: §1:1 §2:10 §3:6 §4:8 §5:2 §6:16 §7:5 §8:9 §9:4 §10:9
§11:12 §12:14 §13:6 §14:3 §15:6 §16:14 §17:5 §18:2 §19:7 §20:13 §21:7 §22:11
§23:8 §24:4 §25:7 §26:3 §27:10 §28:8 §29:6 §30:19 §31:7 §32:4 §33:7 §34:5
§35:17 §36:7 §37:9 §38:1 §39:1 = **293**.

### The rule for "the table exists" and for production absence

Two rules decide the BUILT-BUT-WRONG bucket, and they are the reason this
census scores 80.2 % correct rather than ~96 %:

1. **A table existing is not a requirement being met.** A table nothing writes
   satisfies nothing. Where a verdict turns on "nothing writes X" I read the
   writer sites rather than counting greps.
2. **A requirement whose only sink or only source is a table absent from
   production is BUILT-BUT-WRONG**, however correct the code. This is the brief's
   own rule for Map telemetry, and I apply it uniformly — to §35's sixteen
   events (`map_telemetry_events`), to §12's nine storage-dependent rows
   (`locate_friends_*`), to §24's suppression rule (`protected_zones`) and to
   §10's second signal family (`route_flow_contribution_consent`).

### Method caveat, inherited

`artifacts/api-server/src/scripts/checkWriterlessReads.ts` declares its own
writer attribution **INCOMPLETE** and says it errs toward silence: a dynamic
`.from(expr)` anywhere makes the whole map unreliable, and `checkProductionDrift.ts:158-163`
records that the script *cannot see write-only tables at all*
(`intel_presence_verifications` is written at `IntelCaptureService.ts:303` and
read by nothing, invisible to the checker). **A `from("table")` grep misses
variable and RPC access.** Every "nothing produces X" verdict below was reached
by reading the producer module, not by grepping a table name.

---

## 3. Attribution — which BUILT-AND-CORRECT verdicts are *not* this spec's

224 of the 235 BUILT-AND-CORRECT verdicts rest on artifacts whose own headers
cite this specification by section number. The **11 that do not**:

| ids | Requirement | Whose work it actually is |
| --- | --- | --- |
| M-§21 ×7 | Observation → Evidence → Claim → Confidence → Freshness → Correction → Projected State | **Intelligence Gathering spec (IG-01…IG-10)**, `docs/intelligence-gathering-buildout.md`. `lib/intelContracts.ts`, `lib/confidenceScore.ts`, `lib/freshnessPolicy.ts`, `services/intel/IntelCaptureService.ts` all predate the Map work and cite their own programme. |
| M96 | §22's Observation → Trust → Qualification → Claim pipeline | Same programme. The Map contributed the *prompt* half (`routes/mapObservations.ts`, `features/map/truth/liveTruth.ts`), not the claim engine. |
| M47 | §7 "Certainty" vocabulary | `CONFIDENCE_BANDS` is `intelContracts`'; `lib/mapObjects.ts:194` deliberately *derives* rather than retypes it. The derivation is Map work; the vocabulary is not. |
| M-§23 ×2 | Precision ladder + purpose ceilings | **Presence / Global Input Intelligence spec.** `features/map/presence/presenceLadder.ts:113,145,363` is explicitly a MIRROR of the server's ladder ("MIRROR of the server's `FEATURE_PRECISION_CEILING` (§52)"), a different spec's section numbering. |

**Spec-attributable CORRECT% = 224/293 = 76.5 %.**

> **ATTRIBUTION METHOD NOTE, 2026-09-14 — both halves of this section are evidenced, which is
> rare in this corpus, and it is kept whole.** The 224 rest on artifacts whose own headers cite
> this specification by section number (attributable to THIS spec). The 11 exceptions rest on
> artifacts that name a DIFFERENT programme in their own text — the Intelligence Gathering
> buildout, and a Presence/Global-Input-Intelligence ladder whose mirror says so in its own
> comment (*"MIRROR of the server's `FEATURE_PRECISION_CEILING` (§52)"*, a different document's
> section numbering) — so they are attributable ELSEWHERE, evidenced. **Nothing here is
> attribution-unknown except M142 and M144** (see the correction header). The phrase *"all
> predate the Map work"* in the first row is decoration: the load-bearing half of that row is
> *"and cite their own programme"*, and the row would stand unchanged without the date.

I looked for reasons to score this lower and did not find them. The candidate
objection is that the Map "merely wires up" pre-existing systems — Places,
Trips, Compass, Buddy. But §20 *is* a requirement that Map not own those facts,
and the artifact satisfying it (the gateway delegating to each owner's
privacy-complete reader, `routes/mapProjection.ts:14-27`) was written for this
spec. Wiring is the requirement.

---

## 4. Requirement-by-requirement

Verdict key: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT ·
**?** CANNOT-VERIFY. `⌀` marks a guarantee that holds vacuously (real guard,
currently empty path). Server paths are relative to `artifacts/api-server/src/`,
client paths to `travel-buddy-standalone/` unless stated.

### §1 Product Definition (1)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M1 | The map is a projection layer; canonical facts stay owned by Places, Live Intelligence, Discovery, Compass, Presence, Trips, Memory, Passport, Trust, Safety, Buddy | C | `lib/mapProjection.ts:16-24` — *"It does NOT decide privacy and it does NOT query… Keeping the shaping pure means this layer can never widen what a source exposed."* `routes/mapProjection.ts:14-27` lists the six owning readers it calls instead of querying. |

### §2 Primary Map Surfaces (10)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M2 | ONE persistent Map Shell; the surfaces are coordinated states, not nine tabs | C | `src/features/map/state/mapMachine.ts:1-40` — one pure reducer over three orthogonal axes (mode, overlay, camera); D3 at `:57-64` forbids a secondary mode being silently exited by a selection. |
| M3 | Live Map / Map Home | C | `mapMachine.ts:105` `HOME_MODE = 'LIVE'`; screen at `app/map/index.tsx`. |
| M4 | Live Place | C | `src/components/map/LivePlaceSheet.tsx`; model `src/features/map/place/livePlaceModel.ts:2`. |
| M5 | Crowd Flow | **W** | Producer (`lib/crowdFlowProducer.ts`), gateway lane and client renderer all exist. The mode gate is `src/stores/mapStore.tsx:100#CROWD_FLOW:` — `CROWD_FLOW: inputs.crowdFlowObjectCount > 0` — and the gateway serves zero objects in production. TWO independent blockers, not one: `route_flow_contribution_consent` is absent (M67) **and** `geo_zones` holds no curated rows, which the gateway refuses on separately at `routes/mapProjection.ts:919#no_zone_model`. *(Re-read 2026-09-14: the old citation, line 98, was the §11 TRIP comment two lines above the gate, and the CORRECTION HEADER's line 836 for `no_zone_model` was 62 lines short. Both repointed and anchored; verdict unchanged.)* **Turns red when:** a production `GET /api/map/projection` response over a backfilled viewport carries at least one `objects[].kind === "crowd_flow"`. That needs an ops backfill of `geo_zones` (ops, not a migration) *and* 2218 + 2224 applied (integration owner). Either one alone leaves it W. |
| M6 | Trip Map | C | `src/features/trips/map/tripMapSources.ts`, `tripMapModel.ts`; capability hard-true at `src/stores/mapStore.tsx:96`. |
| M7 | Locate My Friends | **W** | Complete server (`lib/locateFriendsSession.ts`, 48 KB) and client (`src/services/locateFriends.ts`, `src/components/map/LocateFriendsPanel.tsx`). **All four storage tables are absent from production**: none of `locate_friends_sessions`, `_members`, `_positions`, `_audit` appears in `artifacts/api-server/baseline/20260907_production_tables.txt` (431 names), and all four are created by `` `artifacts/api-server/src/migrations/2219_locate_friends_sessions.sql:74#CREATE TABLE IF NOT EXISTS public.locate_friends_sessions (` ``. *(Re-read 2026-09-14: the old citation — `checkProductionDrift.ts`, lines 176-179 — was wrong twice over — those lines are `wall_telemetry_events` / `passport_telemetry_events`, and **that file does not track any `locate_friends_*` table at all**, so the ratchet is silent about this lane. The baseline table list is the artifact that actually carries the fact.)* **Turns red when:** a refreshed `baseline/*_production_tables.txt` contains the four names. Supplied by the operator with production read access, after the integration owner applies 2219. A CI-only apply does not move it — the baseline is production's. |
| M8 | Intent Mode | C | `src/components/map/IntentSheet.tsx:2`; opened at `app/map/index.tsx:2666`. |
| M9 | Compass Map Recommendations | C | `src/features/map/compass/compassMapModel.ts`; capability hard-true, `src/stores/mapStore.tsx:94`. |
| M10 | Time Machine | **W** | Producer `lib/temporalProjection.ts`, route `routes/mapProjectionTemporal.ts`, control `src/components/map/TimeMachineControl.tsx`. The capability requires the producer be reachable (`src/stores/mapStore.tsx:108#TIME_MACHINE:`), and the temporal route rides `map_projection_enabled` (`routes/mapProjectionTemporal.ts:429#map_projection_enabled`) and dies on the same `protected_zones` branch (`:575#loadProtectedZones`, answering `:583#protection_unreadable`). *(Re-read 2026-09-14: lines 105-107 were the comment above the gate and 574 a blank line; both repointed and anchored. Verdict unchanged.)* **Turns red when:** 2217 is applied to production *and* `map_projection_enabled` is TRUE there, and `GET /api/map/projection/temporal?offset=+60m` answers `enabled: true` with a non-null `forecast`. Both are integration-owner/ops acts; neither is code. |
| M11 | Layers / Legend | C | `src/components/map/LayersSheet.tsx:2`; opened at `app/map/index.tsx:3251#visible={overlayOpen('LAYERS')}`. |

### §3 Live Map / Map Home (6)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M12 | Header: menu, current city/area selector, search, layers | C | `src/components/map/MapHeader.tsx:4` quotes the bullet verbatim; `:147` menu, `:151` city selector, `:89` search, `:91` layers. |
| M13 | Filter chips: For You, Live, People, Events, Gems | C | `src/components/map/MapFilterChips.tsx:4` verbatim; five single-select chips with badge counts, `src/features/map/home/homeFilters.ts` computes them. |
| M14 | Map canvas dominates; cards never permanently consume half the viewport | C | `src/components/map/LivePlaceSheet.tsx:68-74` — peek 0.18, and the sheet is the only persistent card; `LivePulseCard.tsx:4-6` restates the constraint as its own design rule. |
| M15 | Floating controls: recenter, navigation/orientation, zoom | C | `src/components/map/MapFloatingControls.tsx:7` verbatim; `:44-47` `ZOOM_STEP/MIN_ZOOM/MAX_ZOOM`; `:126` "Reset orientation to north". |
| M16 | Bottom Live Pulse card summarising the most important nearby change | C | `src/components/map/LivePulseCard.tsx:2-13`; "most important" decided by `selectHeadlinePulseItem` (`src/features/map/pulse/pulseMapBridge.ts:349`). |
| M17 | Persistent action rail: Ask Compass · Meet Here · Add to Trip · Navigate (also §25) | C | `src/components/map/MapBottomActions.tsx:2` — *"the persistent action rail (Map spec §3, §25)"*. |

### §4 Base Map Appearance (8)

All eight are satisfied by a **purpose-built MapLibre style**, `src/constants/mapStyle.ts:121-505`
(`PORTAVA_DARK_MAP_STYLE`), tuned against `src/theme/mapChrome.ts`. The header
at `mapStyle.ts:64-77` documents why OpenFreeMap's own dark style was rejected
*against §4's text* — a genuinely rare thing to find in a repository.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M18 | Dark mode first | C | `mapStyle.ts:121` "the map spec §4 base style"; `DiscoveryMapView.tsx:304` initialises to it. |
| M19 | Near-black/navy chrome, subdued base | C | `src/theme/mapChrome.ts:50-60` — `surface #0E1216`, `surfaceDeep #0B1017`; `:1-8` states the map is the one surface that inverts the app's light system. |
| M20 | Low-saturation streets and buildings | C | `mapStyle.ts:230-231` — minor roads enter at z13 and stay near ground colour, *"§4's 'low-saturation streets'"*. |
| M21 | Recognizable water and major road labels | C | `mapStyle.ts:192-210` water/waterway given the one allowed contrast step; `:365-373` labels limited to motorway refs and named primary/trunk. |
| M22 | Minimal native POI clutter | C | `mapStyle.ts:141-145` — *"There is no `poi` layer, no `poi_label`, no `aerodrome_label`"*; label budget enumerated. |
| M23 | Bright semantic Portava overlays above geography | C | `src/features/map/render/zoneStyle.ts:123-150` `ACTIVITY_RAMP`/`SOCIAL_RAMP` over the subdued base; `mapChrome.ts:34-39` states the base/chrome split. |
| M24 | Rounded translucent cards, large mobile touch targets | C | `mapChrome.ts:44-48` — *"§4 asks for 'rounded translucent cards', so separators and inset fills are alpha-on-white"*; `src/features/map/render/collision.ts:490` `DEFAULT_HIT_BOX 44×44`. |
| M25 | Map motion and pulse are meaningful, not decorative | C | `zoneStyle.ts:209` `MEANINGFUL_CHANGE_TRENDS` — only a meaningful trend earns a pulsing outline; `:223` `DEFAULT_PULSE_PERIOD_MS`. |

### §5 Visual Hierarchy (2)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M26 | The eight-level stack, base geography → critical overlays | C | `src/features/map/render/collision.ts:606-614` — *"§5 stacks the map in levels: activity zones sit at Level 2, crowd flow at Level 3, markers at Level 4 and above"*, enforced by `participatesInCollision` (only Points collide); `src/components/map/ActivityZone.tsx:97#beforeId` `beforeId` — RENAMED IN THE DOCUMENT, not in the code: this row said `belowLayerID`, which is in no file in this repository. The prop is `beforeId` at `:97`, and `:96` is the line that carries the claim — *"Draw this zone beneath an existing layer id (§5's level ordering)"*. Found 2026-09-14 by `check:citation-symbols`; the verdict does not move, because the prop it names does exist and does what the row says. |
| M27 | Safety and active navigation always take visual precedence (also §24) | C | `lib/mapObjects.ts:283-286` `RENDERING_PRIORITY.safety = 120`, `active_navigation = 100`, above every popularity tier; `src/features/map/layers/layerModel.ts:110-118` `ALWAYS_ON_LAYER_IDS = ['safety']`, subtracted from `ToggleableLayerId` so a preference object naming it does not type-check. |

### §6 Map Zones and Semantic Visual Language (16)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M28 | Rely on zones rather than thousands of pins; zones are not exact borders | C | `lib/mapAggregation.ts:216-238` — only `world` and `city` bands aggregate; `:272-335` grid cells, `cellPolygon`. |
| M29 | Soft filled zone = current aggregate activity | C | `src/features/map/render/zoneStyle.ts:87` `ZONE_KINDS`; `src/components/map/ActivityZone.tsx`. |
| M30 | Pulsing outline = meaningful recent change | C | `zoneStyle.ts:66` `OUTLINE_STYLES`, `:209` `MEANINGFUL_CHANGE_TRENDS`. |
| M31 | Dashed boundary = predicted / forecast zone | C | `zoneStyle.ts:22-25` — `resolveOutlineStyle` returns `'dashed'` for a forecast kind *on its first branch*, "asserted exhaustively". |
| M32 | Directional arrows = aggregate crowd flow | C | `zoneStyle.ts:74` `ARROW_DIRECTIONS`; `src/components/map/CrowdFlowLine.tsx`. |
| M33 | Standard marker = Place | C | `lib/mapObjects.ts:93` kind `place`; `src/components/map/EntityMarkers.tsx:41`. |
| M34 | Star = Compass Pick | C | `src/features/map/compass/compassMapModel.ts:379` `COMPASS_STAR_TREATMENT`, `:404` every pick carries it. |
| M35 | Gem = Hidden Gem | C | `lib/mapObjects.ts:98` kind `hidden_gem`. |
| M36 | Event icon = time-bound event | C | `lib/mapObjects.ts:95` kind `event`; `lib/mapProjection.ts:225` `projectEvent`. |
| M37 | Group icon = aggregate social opportunity | C | `lib/mapProjection.ts:117-121` — *"A traveler is projected as a `social_zone` — §6's 'Group icon = Aggregate social opportunity' — never as an identified person on a public map."* |
| M38 | Avatar = permitted identified presence ONLY | C | `lib/mapObjects.ts:271-273` `mayRenderIdentity` requires rung ≥ `approximate`. |
| M39 | Ring = approximate location | C | `src/features/map/presence/locateFriends.ts:435` `APPROXIMATE_DISTANCE_LADDER`; migration `2219_locate_friends_sessions.sql:246` — *"every coarser rung is served as a ring built from a snapped grid cell."* |
| M40 | Checkpoint pin = meeting point | C | `lib/mapProducers/meetingPointProducer.ts:2`; `src/components/map/CheckpointPin.tsx`. |
| M41 | Shield = safety context | C | `lib/mapProducers/safetyNoticeProducer.ts:2`; kind `safety_notice` at `lib/mapObjects.ts:103`. |
| M42 | Gold marker = Saved / Passport / Memory | **W** | The **Saved** arm is correct: `lib/mapProducers/savedPlaceProducer.ts:388,396` reads the union of `wishlist_places` + `discovery_place_saves` after PR #446 moved it off writerless `saved_places` (`:18-23`). The **Memory** arm is not: `lib/mapProducers/memoryProducer.ts:35` filters `memory_projections` to `subject_type = 'place'`, and that projector's PLACE lane still reads the writerless `saved_places`, so it has never had an eligible subject. **PR #451 fixes exactly this** and would flip M42 to C. *(Re-read 2026-09-14: all five citations hold at this tree; the projector's writerless read is `` `artifacts/api-server/src/migrations/2191_memory_projector_content_and_support.sql:179#FROM public.saved_places s` ``.)* **Turns red when:** `project_user_memory`'s PLACE lane reads the `wishlist_places` + `discovery_place_saves` union instead of `saved_places`, and a `memory_projections` row with `subject_type = 'place'` exists for a user who has only union-sourced saves. The migration is PR #451's; this lane does not own the memory projector — raised as a cross-lane request to Highlights & Memories rather than duplicated here, because a second migration redefining the same function hands the integrator a conflict for no earlier landing. |
| M43 | Blue dot = current user | **W** | The legend glyph is real and drawn — `src/components/map/LayersSheet.tsx:167-170,198` render a `blue_dot` glyph — but **nothing renders the user's own position on the canvas.** `src/components/discovery/DiscoveryMapView.tsx` contains no `UserLocation`, no `showUserLocation` and no user marker; `app/map/index.tsx:851#userLat` / `:853#userLng` read them only to recentre the camera. The map legend documents a marker the map does not draw. *(Re-read 2026-09-14: still true. `UserLocation` IS exported by the installed MapLibre SDK, and the repo's own jest stub mirrors that export — so the renderer this row needs already exists in the dependency set and nothing mounts it.)* **Turns red when:** a component test mounts the real map canvas with a viewer position and finds a user-position node in the tree. The canvas is `src/components/discovery/DiscoveryMapView.tsx`, which belongs to the Discovery lane, and `EntityMapLayers` — the one map-owned renderer inside it — is mounted only when `entities.length > 0`, so it is the wrong home for a marker that must draw on an empty map. **Cross-lane request to Discovery**, not buildable from the Map lane's paths. |

### §7 Activity, Trend, Confidence and Freshness (5)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M44 | Observation, confidence, trend and freshness must NOT collapse into one label | C | `lib/mapObjects.ts:365-392` — four independent optional fields on `MapObject` (`freshness`, `confidence`, `activity`, `trend`), each from a separate vocabulary. |
| M45 | Activity vocabulary (Very Quiet…Peak) | C | `lib/mapObjects.ts:246-253` `ACTIVITY_LEVELS`, six values in the spec's order. |
| M46 | Trend vocabulary (Increasing quickly…Rapidly dispersing) | C | `lib/mapObjects.ts:236-243` `TREND_STATES`, six values. |
| M47 | Certainty vocabulary (Confirmed…Unconfirmed) | C *(not spec-attributable)* | `lib/mapObjects.ts:194` `CONFIDENCE_STATES = CONFIDENCE_BANDS`, *derived* from `intelContracts` so a band added there cannot silently fail to reach the map. |
| M48 | Freshness vocabulary (Live…Historical) with real thresholds | C | `lib/mapObjects.ts:120-121` `FRESHNESS_STATES`; `:135-146` thresholds; `:158-172` `deriveFreshness` fails closed on missing/future clocks and lets `expiresAt` beat the bucket. |

### §8 Live Place Surface (9)

All nine cite `src/features/map/place/livePlaceModel.ts`, whose header at `:4-13`
reproduces §8's mock verbatim as the module contract.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M49 | Bottom sheet expanding to a near-full detail view | C | `src/components/map/LivePlaceSheet.tsx:68-77` — peek 0.18 / half 0.50 / full 0.92. |
| M50 | Hero photo / recent Moment | C | `livePlaceModel.ts:64-67` `heroPhotoUrl`, `heroIsMoment`. |
| M51 | Place name · type · distance | C | `livePlaceModel.ts:180-184`, `:236` distance formatter ("Metres under a kilometre; never a fake precision"). |
| M52 | LIVE STATE (activity · trend · updated) | C | `livePlaceModel.ts:123-135`; `:19` — *"A place with no live claim shows NO LIVE STATE."* |
| M53 | Crowd / Trend / Vibe breakdown | C | `livePlaceModel.ts:141-147` `CrowdSection`; `:71-73` vibe, "there is no default vibe". |
| M54 | SOCIAL: friends here, travelers interested | C | `livePlaceModel.ts:74-78` — friends gated by `privacyClass`, the aggregate permitted at `aggregate_only`. |
| M55 | ACCESS: queue, open-until, price | C | `livePlaceModel.ts:160-166`, `:249` price, `:256` queue. |
| M56 | WHY SHOWN | C | `livePlaceModel.ts:262-268` — *"Emits ONLY reasons the inputs actually support."* |
| M57 | ACTIONS: Go · Save · Ask Compass · Add to Trip · Meet Here · Share | C | `lib/mapObjects.ts:308-330` `MAP_ACTIONS`; `src/components/map/MapEntityActionRow.tsx`. |

### §9 Intelligence Provenance (4)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M58 | Every meaningful live claim supports a Why? interaction | C | `lib/mapObjects.ts:408-412#MapProvenance` carries `lines`/`confidence`/`updatedAt`, hung on `MapObject` at `lib/mapObjects.ts:457#provenance`; `src/components/map/WhyShownSheet.tsx` renders it. *(Repointed 2026-09-14 from lines 347-357, which are 61 lines short of the interface; the fact is unchanged.)* |
| M59 | Evidence lines, per claim | C | One line per claim at `lib/mapProjection.ts:725#describeClaim`, whose text is built by `lib/mapProjection.ts:880#describeClaim`; the two Table 7 contextual lines at `lib/mapProjection.ts:615#eventAdjacencyLine` and `lib/mapProjection.ts:623#qualifiedMediaLine` — copy is *"Table 7 VERBATIM"* (`lib/mapProjection.ts:594#VERBATIM`). *(All five repointed 2026-09-14; line 833 named no `describeClaim` at all, and lines 607 and 615 each sat 8 lines above their function.)* |
| M60 | "Updated N minutes ago" | C | `lib/mapObjects.ts:411#updatedAt` on `MapProvenance`. *(Repointed 2026-09-14 from line 355.)* |
| M61 | Confidence stated on the panel | C | `lib/mapObjects.ts:410#ConfidenceState` — `confidence` is REQUIRED on the provenance bundle, so a panel without a stated confidence is unrepresentable. *(Repointed 2026-09-14 from line 354.)* |

### §10 Crowd Flow Mode (9)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M62 | Aggregate movement between places or zones | C | `lib/crowdFlowProducer.ts:2`; `produceZoneTransitions` → `deriveCrowdFlow`, zone granularity enforced by type. |
| M63 | Never expose individual routes or imply continuous tracking | C | `lib/crowdFlowProducer.ts:497-498` — cohort is a `Set` of distinct actors across families; `lib/mapAggregation.ts:399-414` puts `crowd_flow` in `NEVER_AGGREGATED_KINDS` because it already carries its own k decision. |
| M64 | Five flow states | C | `src/features/map/render/zoneStyle.ts:95` `FLOW_STATES = ['strong','moderate','emerging','dispersing','unusual']`. |
| M65 | The seven declared input families | **W** | `lib/crowdFlowProducer.ts:289` `WIRED_SIGNAL_SOURCES` is **two** of seven; `:298-300` `DECLARED_BUT_UNFED_FAMILIES` and `:345` `UNFED_FAMILY_BLOCKERS` name, per family, the specific capture that must exist first. Honestly declared, but five families produce nothing. *(Re-read 2026-09-14: all four citations hold at this tree — `:289#WIRED_SIGNAL_SOURCES`, `:298#DECLARED_BUT_UNFED_FAMILIES`, `:345#UNFED_FAMILY_BLOCKERS`.)* **Turns red when:** `WIRED_SIGNAL_SOURCES` names all seven families **and** each newly-named family has a capture writing rows a producer run can observe. This is the one row in this census that no deployment unblocks: `UNFED_FAMILY_BLOCKERS` states, per family, the capture nobody has written (the entries are product work, not migrations). Moving a family into `WIRED_SIGNAL_SOURCES` without its capture would turn this row green while producing nothing — so the evidence required is a producer run observing that family, not a diff of the constant. |
| M66 | Minimum cohort density | C | `lib/mapAggregation.ts:351` `MIN_ZONE_COHORT = PRIVACY_THRESHOLD_V1.minUniqueActors`. |
| M67 | Multiple signal families required | **W** | The gate is right — `lib/crowdFlowProducer.ts:497-498` requires ≥ `MIN_SIGNAL_FAMILIES` *observed*, and refuses before it reads (`:914`). But the second family is the accepted-plan hop lane, whose consent record `route_flow_contribution_consent` (`lib/routeHopSignal.ts:115,572`) is **absent from production**: `` `artifacts/api-server/src/scripts/checkProductionDrift.ts:273#route_flow_contribution_consent` `` classifies it unapplied, and the name is not in `baseline/20260907_production_tables.txt`. *(Re-read 2026-09-14: lines 180-183 were `passport_telemetry_events`; repointed and anchored.)* One family in production ⇒ the producer permanently refuses. **Turns red when:** 2224 is applied to production and `observedSignalFamilies()` returns ≥ `MIN_SIGNAL_FAMILIES` for a real viewport. Integration owner applies; the operator's refreshed baseline is the evidence. |
| M68 | Freshness checks | C | `lib/crowdFlowProducer.ts:509` `SIGNAL_MAX_AGE_MINUTES`; `:653` applied per signal. |
| M69 | Privacy gates | C | `lib/crowdFlowProducer.ts:99` per-family consent; migration `2218_crowd_flow.sql:59` states the four gates as the flag's own description. |
| M70 | Observed movement and inferred cause separately represented | C | `lib/crowdFlowProducer.ts:273-277` `OBSERVED_SIGNAL_FAMILIES` vs `CAUSE_ONLY_SIGNAL_FAMILIES`; `:817` `MAX_INFERRED_CAUSE_CONFIDENCE = 'provisional'` — a cause can never be asserted as strongly as an observation. |

### §11 Trip Map Mode (12)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M71 | Render the Trip geographically without duplicating or replacing Trip ownership | C | `src/features/trips/map/tripMapSources.ts:16` — pure: DTOs in, `TripMapSource` out; every source is the owning system's own DTO. |
| M72 | Lodging / home base | C | `tripMapSources.ts:152-172` — first accommodation item with a safe coordinate; *"§11 lists lodging first"*. |
| M73 | Itinerary | C | `tripMapSources.ts:192` "Everything else is an itinerary stop", `:213` returned. |
| M74 | Next stop | C | `src/features/trips/map/tripMapModel.ts:275-279` — reservation outranks event start; a planned arrival is not an anchor. |
| M75 | Saved ideas | C | `tripMapSources.ts:220` — ideas with no coordinate are dropped, *"a saved idea with no known location is a wish"*. |
| M76 | Crew | C | `tripMapSources.ts:29-31,64-102` — crew surfaced as **coarse area labels** (`crewAreas`), `source.crew` left empty because it would require coordinates the §23 rung did not grant. The privacy-correct rendering, not a gap. |
| M77 | Routes | C | `tripMapSources.ts:251-253` — one LineString through the plan's stops, styled as a dashed guess rather than a routed path. |
| M78 | Meeting points | C | `tripMapSources.ts:234#meetingPoints.push` is the `meeting_point` branch of `partitionPlanItems`; producer `lib/mapProducers/meetingPointProducer.ts:147#projectMeetingPoint`, read at `:266#readMeetingPoints`. *(Repointed 2026-09-14 from line 213, which sits between two other `meetingPoints` mentions and names none of them.)* |
| M79 | Safe Return context | C | `tripMapSources.ts:282-293` — anchored to lodging because the session itself carries no coordinate (§24). |
| M80 | Compass alternatives | C | `app/map/index.tsx:89` `fetchCompassRecommendations`; `src/features/map/compass/compassMapModel.ts`. |
| M81 | Optimize Today weighs the eight named factors | C | `tripMapModel.ts:29-30` quotes them; `:312-319` `OPTIMIZE_FACTORS` enumerates all eight including `weather`. |
| M82 | Proposed changes require user acceptance; never silently rewrite the Trip | C | `tripMapModel.ts:10` quotes the rule; `:19-26` — `optimizeToday()` returns a **proposal**; `acceptProposal()`/`dismissProposal()` return a change record, *"cannot read 'accepted' as 'saved'"*. |

### §12 Locate My Friends (14)

The code here is the most carefully written in the census — migration
`2219_locate_friends_sessions.sql` makes an unbounded session *unrepresentable*
(`:118`) and a movement history *unstorable* by primary key (`:246`). **None of
it can run in production: all four tables are absent** (`scripts/checkProductionDrift.ts:176-179`).

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M83 | A specialized temporary group/event map | **W** | `lib/locateFriendsSession.ts:2#locateFriendsSession`, `src/components/map/LocateFriendsPanel.tsx`. Storage absent from production — see M7 for the artifact that carries that fact and for what turns this whole block red. |
| M84 | Networked AND degraded/offline operation | C | `src/features/map/presence/eventCachedLocation.ts` (device-local rung); `src/features/map/cache/mapCache.ts:95-102` `event_map` cache class. Client-side, so unaffected by the missing tables. |
| M85 | Approximate location and explicit checkpoints | **W** | `src/features/map/presence/locateFriends.ts:146#RUNG_POLICY` *(repointed 2026-09-14 from lines 139-190, a comment block above the constant)*; positions live in `locate_friends_positions`, absent. Unblocked by 2219 alone — see M7. |
| M86 | Rung 1 — normal network location | **W** | `src/features/map/presence/locateFriends.ts:87#'network_location',`, `:147#network_location:`. Reads/writes `locate_friends_positions`. Unblocked by 2219 alone — see M7. |
| M87 | Rung 2 — event-local cached location | **W** | `src/features/map/presence/locateFriends.ts:88#'event_cached_location',`, `:153#event_cached_location:`; producer commit `bacae0b3`. Same storage — see M7. |
| M88 | Rung 3 — local device proximity | **N** | `src/features/map/presence/presenceLadder.ts:192#CURRENT_STACK_CAPABILITIES` *(repointed 2026-09-14 from lines 189-201, a comment)* has `bleScan/bleAdvertise/backgroundBle/uwb/localPeer` all `false`; *"BLE is entirely absent from today's Portava stack, which is why §12's 'local device proximity' and 'peer relay' rungs are currently unreachable"*. The ladder slot exists; the sensor does not. **Turns red when:** (1) a BLE-capable module is in the app's dependency set and `CURRENT_STACK_CAPABILITIES.bleScan` is `true` because the stack was re-verified, not because the constant was edited; and (2) a rung-3 fix is produced on a real handset — the measurement is a `locate_friends_positions` row written with `rung = 'local_proximity'` from a device with location services OFF, which is the only reading that separates BLE proximity from the network rung above it. No migration, flag or server change moves this row; it is a platform capability the product does not have. |
| M89 | Rung 4 — peer relay / checkpoint | **N** | Same, `src/features/map/presence/presenceLadder.ts:192#CURRENT_STACK_CAPABILITIES`, `src/features/map/presence/locateFriends.ts:165#peer_relay:`, `:194#unsupportedRungs`. **Turns red when:** the same two facts M88 needs, for the peer-relay rung. |
| M90 | Rung 5 — last-known location | **W** | `src/features/map/presence/locateFriends.ts:171#last_known:`. Same storage — see M7. |
| M91 | Rung 6 — manual checkpoint | **W** | `src/features/map/presence/locateFriends.ts:177#manual_checkpoint:`; migration `2219_locate_friends_sessions.sql:246#unstorable`. Same storage — see M7. |
| M92 | Opt-in only | **W** | Structurally perfect and unreachable: `2219_locate_friends_sessions.sql:163#unrepresentable` — *"opted_in_at and consent_source are NOT NULL, so a membership without a recorded consent act is unrepresentable"*. Table absent. |
| M93 | Group-scoped | **W** | Same migration `2219_locate_friends_sessions.sql:163#unrepresentable`; `src/stores/mapStore.tsx:101#LOCATE_FRIENDS:` refuses the mode without a scope *(repointed 2026-09-14 from lines 66-70, the prop's doc comment)*. Table absent — see M7. |
| M94 | Temporary and auto-expiring | **W** | `2219_locate_friends_sessions.sql:83#expires_at` is NOT NULL with no default and `:105#interval` CHECK-bounds it to 12 h; expiry is re-enforced on every read so a stalled sweep cannot serve an expired session (`:118#CHECK-bounded`). `src/features/map/presence/locateFriends.ts:490#MAX_SESSION_MS`. Table absent — see M7. |
| M95 | No public friend tracking | C ⌀ | `lib/locateFriendsSession.ts:105` — *"no `public` member, and adding one would be the §37 non-goal in a single [line]"*; migration `2219:310` "No public read path". Holds vacuously in production, where there is no path at all. |
| M96 | UI states: Nearby ~40-80 m, Last seen 3m ago, Checkpoint: Food Court | C | `locateFriends.ts:103-116` `PROXIMITY_BUCKETS` + `PROXIMITY_BUCKET_RANGE`; `:435` `APPROXIMATE_DISTANCE_LADDER = [0,40,80,150,300,600,1200]` — the spec's own "~40-80m". Pure client formatting. |

### §13 Intent Mode (6)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M97 | Temporary context, NOT a permanent preference rewrite | C | `src/features/map/intent/intentModel.ts:25-28`; server `compass/CompassTemporaryIntent.ts:6` quotes §13's first sentence as its reason to exist. |
| M98 | The nine primary intents | C | `intentModel.ts:54-62` all nine ids; `:69-77` the spec's own labels ("I'm Bored", "Surprise Me"). |
| M99 | Energy control Low ↔ High | C | `intentModel.ts:320,353` `energy`, clamped scale with no silent default (`:111`). |
| M100 | Future novelty control Familiar ↔ Adventurous | C | `intentModel.ts:100,322,354` `novelty` — built although §13 marks it "Future". |
| M101 | Intent carries a TTL or is cleared explicitly | C | `intentModel.ts:13` quotes the rule; `:168` — a long-lived intent "would keep injecting novelty"; `activeIntent()` used at `app/map/index.tsx:51`. |
| M102 | Intent flows Preferences+Context+Trip+LiveWorld → candidates → Compass ranking → Map projection | C | `compass/types.ts:74` `TemporaryIntent` is request-scoped; commit `4d83a353` *"§13 TemporaryIntent reaches Compass ranking end to end"*. |

### §14 Compass Map Mode (3)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M103 | Reduce noise; highlight ~3–5 best next moves | C | `src/features/map/compass/compassMapModel.ts:67-68` `COMPASS_MAP_MIN_PICKS = 3`, `MAX = 5`; `:344` the max is clamped, `:368` fewer candidates returns `insufficient_candidates` rather than padding. |
| M104 | Compass does not create live facts; it reasons over structured state | C | `compassMapModel.ts:8` quotes it; `:191` every WHY input is "optional, all facts from elsewhere". |
| M105 | WHY THIS OPTION panel | C | `compassMapModel.ts:212-223` `COMPASS_WHY_FACTORS`. |

### §15 Time Machine (6)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M106 | Historical and forecast, unmistakably different treatment | C | `src/features/map/time/timeMachine.ts:25-39` — a **discriminated union**, not a convention: the forecast arm pins `kind:'prediction'`, requires `forecastConfidence`, and *excludes* `freshness:'live'` from its type; the observed arms declare `forecastConfidence?: never`. Visually, `zoneStyle.ts:183` `FORECAST_OPACITY_FACTOR = 0.6` on top of the dashed outline — "two independent signals, not one". |
| M107 | Primary control NOW, +30m, +60m, +120m | C | `timeMachine.ts:167-176` `NOW_OFFSET`, `PRIMARY_OFFSETS`; `src/components/map/TimeMachineControl.tsx:2`. |
| M108 | Later controls Yesterday, Tonight, Tomorrow, Last Friday | C | `timeMachine.ts:152` `NAMED_OFFSETS`, `:178` `SECONDARY_OFFSETS`; `:78-85` "Tonight" window resolution. |
| M109 | Historical = observed or reconstructed from qualified historical evidence | C | `timeMachine.ts:15-16` quotes it; `lib/temporalProjection.ts:2` is the honest-history producer (commit `04515576`, "honest history"). |
| M110 | Forecast = predicted and MUST carry forecast confidence | C | `timeMachine.ts:30` — *"The forecast arm REQUIRES `forecastConfidence`, so a forecast without [it]"* does not type-check. |
| M111 | A compact city timeline of expected peaks and cooling | C | `src/components/map/CityTimeline.tsx:2` quotes §15's sentence. |

*(Reachability of the surface as a whole is M10, above: **W**.)*

### §16 Layers and Progressive Disclosure (14)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M112 | Explicit layers plus automatic relevance; do not turn every layer on at once | C | `src/features/map/layers/layerModel.ts:5-30` — a layer is not a boolean; `LAYER_DEFAULT_STATES` at `:143` is `on / off / contextual / always_on`, and a contextual layer has **no stored value**, resolving from context each time, with an explicit user choice outranking it and surviving every context change. |
| M113 | Live Activity | C | `layerModel.ts:69#live_activity` declares the id; `layerModel.ts:159#live_activity` defaults it `on`. *(Both repointed 2026-09-14, each 1-3 lines low.)* |
| M114 | People | C | `layerModel.ts:67`. |
| M115 | Events | C | `layerModel.ts:68`; default `on`. |
| M116 | Trip | C | `layerModel.ts:69`. |
| M117 | Buddies | C | `layerModel.ts:70`; `lib/buddyMapRead.ts:8`. |
| M118 | Saved | C | `layerModel.ts:71`; producer `lib/mapProducers/savedPlaceProducer.ts:388,396` (post-#446 union). |
| M119 | Crowd Flow | **W** | `src/features/map/layers/layerModel.ts:75#'crowd_flow',` *(repointed 2026-09-14 from line 72, which is `'trip'` — three entries earlier in the same array literal)*; the layer is real, the objects are not — see M5/M67, which is also what turns it red. |
| M120 | Hidden Gems | C | `layerModel.ts:73`. |
| M121 | Safety | C | `layerModel.ts:74`; always-on, `:110-118`. |
| M122 | Transport | **N** | `src/features/map/layers/layerModel.ts:78#'transport',` declares the id, `:171#transport:` defaults it `off`, `:637#transport:` gives it a legend entry — **and no `MapObjectKind` maps to it.** `:463#LAYER_FOR_KIND` has no `transport` value *(range repointed 2026-09-14 from lines 470-485, which starts mid-record)*, so `:492#kindsForLayer` returns `[]` by construction. A toggle over an empty set. **Turns red when:** a `transport` renderable exists end to end — but note what that costs, because it is why this is N and not a small build. §18's `MapObjectKind` union is CLOSED at thirteen kinds and this repository has ruled once already that a layer named in one line of the spec is not a licence to invent an object contract for it (`docs/map/scope-ruling-phases-6-7.md:44#Building`); the four Phase-7 kinds were added only on an explicit owner AMENDMENT with a written contract. So the evidence that settles M122 is, in order: (1) an owner ruling that §16's Transport layer admits a kind beyond §18's thirteen, or a ruling that it is base-map styling and the toggle must drive the style rather than a kind set; (2) a named data source — the tree has no transit feed, and `src/constants/mapStyle.ts` is the only place a base-map answer could land; (3) the usual mirror/producer/`LAYER_FOR_KIND` triple. (1) is an owner decision, not a lane's, and (2) then decides which paths do the work. |
| M123 | Memories | **W** | `src/features/map/layers/layerModel.ts:79#'memories',`, `:169#memories:` default `off`, `:475#memory:` maps `memory → memories`. All three re-read and correct at this tree. Its only producer is dead upstream — see M42, whose blocker is code rather than a deployment. **Turns red when:** M42 turns red. PR #451 would flip both. |
| M124 | Suggested defaults (Live Activity/Events/Relevant Places/Saved on; People/Trip/Crowd Flow contextual; Buddies and Memories off) | C | `layerModel.ts:158-181` `LAYER_DEFAULTS`, matching the spec line; `:88-101` explains why `relevant_places` is modelled separately and kept out of `CORE_LAYER_IDS` "so that constant stays a faithful quote of the spec". |
| M125 | Rendering detail changes with zoom, intent, layer, Trip state, Compass state, density, confidence, relevance, relationship, privacy | C | `layerModel.ts:282` `DEFAULT_LAYER_CONTEXT`; `src/features/map/render/collision.ts:227-293` zoom bands, `:318` `LIVE_ZONE_CONFIDENCE_FLOOR`, `:333` `DEMOTED_ZONE_PRIORITY`. |

### §17 Zoom Model (5)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M126 | World: countries visited, upcoming Trips, Passport, major destinations; **no POI pins** | C | `src/features/map/render/collision.ts:265` — `world: ['safety_notice','trip_stop','memory','world_pulse','traveler_flow','personal_city']`. No `place` kind; `safety_notice` is deliberately in this row per §5 (`:252-255`). |
| M127 | City: neighbourhoods, activity zones, major events, major flow, key Compass recs | C | `collision.ts:267` — `['activity_zone','crowd_flow','prediction','event','city_model']`. |
| M128 | District: live places, events, gems, social opportunities, Trip objects | C | `collision.ts:269` — `['place','hidden_gem','social_zone','buddy_zone','saved_place']`. |
| M129 | Street: individual places, **entrances**, authorized crew, meeting points, route context | **W** | `collision.ts:271` introduces `['crew_member','meeting_point']` and inherits places. **There is no entrance kind** in `lib/mapObjects.ts:90#MAP_OBJECT_KINDS` *(range repointed 2026-09-14 from lines 91-110, off by one at both ends)* and no producer for one. Four of the five named renderables are present; entrances are not. **Turns red when:** an `entrance` object is produced and drawn at the street band. Same gate as M122 and for the same reason: §17 is a RENDER table and §18's kind union is closed at thirteen, so this needs (1) an owner ruling that §17's street vocabulary introduces a kind §18 does not list, and (2) a source for entrance geometry — the only candidate in this tree is OSM, which the Discovery tier-1 mapping already reads, so the concrete question is whether `entrance=main|yes` nodes may be projected as map objects. Neither is a lane's call, and neither is blocked by a deployment. |
| M130 | Venue/Event: stages, entrances, checkpoints, food, toilets, group members, meeting zones | **N** | `collision.ts:273` — `venue: []`. The band exists in the vocabulary and inherits everything from `street`, but **not one venue-interior renderable exists**: no stage, entrance, food or toilet kind, no producer, no fixture. §17's fifth row is a zoom threshold with nothing behind it. **Turns red when:** at least one venue-interior renderable exists end to end — kind on both mirrors, producer, fixture, and a `collision.ts` `venue` entry that is no longer `[]`. It needs the SAME owner ruling M129 needs, plus something M129 does not: a venue-interior data source. Nothing in this repository holds stage, food, toilet or checkpoint geometry for any venue, and no integration supplies it, so the settling evidence is a named feed (an event organiser's venue map, or an OSM indoor extract) before any code. This is the largest single gap in this census and it is a product decision, not a build. |

### §18 Map Object Contract (2)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M131 | The `MapObjectKind` union | C | `lib/mapObjects.ts:91-110` — the spec's thirteen kinds **in the spec's own order**, plus `saved_place` and the four §36 Phase 7 kinds appended at the end so the app mirror compares in order. `src/test/mapObjectsContract.test.ts` reads both mirrors and fails on drift; `travel-buddy-standalone/src/types/mapObjects.ts:2` is the other half. |
| M132 | The `MapObject` interface | C | `lib/mapObjects.ts:363-400` — every declared field present (`id`, `kind`, `geometry`, `title`, `subtitle?`, `observedAt?`, `expiresAt?`, `freshness?`, `confidence?`, `sourceRefs?`, `privacyClass`, `interaction?`, `renderingPriority`) plus `activity`/`trend`/`provenance`/`sourceClass`. `sourceClass` is optional for a stated reason at `:366-381`: absent is the only honest value for an object with no live claim, and `coarsenForZone` must be able to `delete` it. |

### §19 Projection Architecture (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M133 | **Never place raw database rows directly on the map** | **W** | The rule is built and not in force. `routes/mapProjection.ts` is the gateway; `map_projection_enabled` seeds **FALSE** (`` `migrations/2201_map_projection_flag.sql:17#('map_projection_enabled', FALSE,` ``) and the flag ROW is absent from production entirely — see the CORRECTION HEADER. `src/hooks/useMapEntities.ts:22#ROLLBACK` describes the fallback; `:786#res.data.enabled` is the only branch that keeps the gateway's objects, and with the flag off `:797#usedGateway` is false and `:793#Roll` runs the per-layer fetches, normalised **on the device** by `src/features/map/projection/clientProjection.ts`. *(Re-read 2026-09-14: lines 702-704 pointed INSIDE the gateway-success branch, i.e. at the path this row says is not taken; repointed to the branch and the fallback.)* That is the forbidden shape, live in production. **Turns red when:** 2217 then 2201 are applied and `map_projection_enabled` is TRUE in production, so `usedGateway` is true on a real device. The order matters and is not negotiable: flipping 2201 before 2217 blanks the map (CORRECTION HEADER). Integration owner + ops; no code in this lane moves it. |
| M134 | A dedicated Map Projection Service | C | `lib/mapProjection.ts:2` — *"the Map Intelligence Gateway's shaping layer (Map spec §19)"*; `:16-24` pure, no I/O, no privacy decisions. |
| M135 | Map Objects as the wire type | C | `lib/mapObjects.ts`; mirrored client-side, drift-guarded. |
| M136 | Map Ranking | C | `lib/mapProjection.ts:1217#rankObjects` — distance is a **tie-break**, not the sort key, because §5 makes safety and navigation precede popularity. *(Repointed 2026-09-14 from line 1166, 51 lines short.)* |
| M137 | Privacy / Eligibility stage | C | `routes/mapProjection.ts:29-36` — the block set is resolved **once**, fail-closed, and handed to every people-bearing source so the request cannot hold two answers to "who is blocked"; `lib/mapObjects.ts:426-434` `isServable` drops `privacyClass:'none'` at the boundary whatever produced it. |
| M138 | Viewport Aggregation | C | `lib/mapAggregation.ts:2`; `:216-238` only wide bands aggregate; `:414` `NEVER_AGGREGATED_KINDS`. |
| M139 | The mobile client must not independently reconstruct Portava intelligence rules; the service is the "Map Intelligence Gateway" | **W** | The name and the guard are real — `src/test/gatewayBypassGuard.test.ts:32#READERS` enumerates each privacy-complete reader with every file allowed to call it and a stated reason, and the test fails on any caller absent from that list *(repointed 2026-09-14 from lines 28-33, the doc comment above it)*. But with the flag off, `clientProjection.ts` **is** a second, on-device reconstruction, and it is the one in service. **Turns red when:** M133 turns red — the same flag flip, in the same order. The guard is not the blocker and never was; it holds today. |

### §20 Data Ownership (13)

All thirteen rows assert that a named system owns a fact and Map does not. The
gateway satisfies them structurally by calling each owner's privacy-complete
reader rather than querying: `routes/mapProjection.ts:14-27` and `:52-66`.

| id | Owner → Owns | V | Evidence |
| --- | --- | --- | --- |
| M140 | Places → place identity and location | C | `lib/mapProjectPlace.ts:3`; `routes/mapProjection.ts` `places` lane. |
| M141 | Live Intelligence → current claims and state | C | `lib/mapProjection.ts:1096#enrichWithLiveClaims` — read-only over `readLiveClaims` envelopes; the no-upgrade rule is stated at `lib/mapProjection.ts:675#Never upgrades` and enforced by `lib/mapProjection.ts:696#applyLiveClaims`. *(Repointed 2026-09-14 from lines 1049 and 667.)* |
| M142 | Discovery → candidate relevance | C | `src/services/discovery.ts` consumed, never re-ranked, by `src/features/map/search/searchAdapter.ts:4`. |
| M143 | Compass → next-best action | C | `src/features/map/compass/compassMapModel.ts:8`. |
| M144 | Presence → people/place presence | C | `lib/mapTravelers.ts` + `readCircleLocations`, both approved-caller-only in `gatewayBypassGuard.test.ts`. |
| M145 | Trips → itinerary and crew context | C | `src/features/trips/map/tripMapSources.ts:16` (DTOs in, no re-derivation). |
| M146 | Telegraph → communication | C | `app/map/index.tsx:153` `openDirectThread` delegates; no message state on the map. |
| M147 | Memory → personal projection and history | C | `lib/mapProducers/memoryProducer.ts:9` reads `memory_projections`, the Memory system's own read model. |
| M148 | Passport → travel identity/history | C | `app/map/index.tsx:36` `getPassportMap`; `lib/mapProducers/personalCityProducer.ts` reads the viewer's own `passport_stamps` only. |
| M149 | Trust → evidence/contributor trust | C | `routes/mapObservations.ts:19` delegates trust context to `services/intel/IntelCaptureService`. |
| M150 | Safety → safety state | C | `lib/mapProducers/safetyNoticeProducer.ts:22` — explicitly states `protected_zones` **is not** a safety source and is not read as one. |
| M151 | Buddy → service availability | C | `lib/buddyMapRead.ts:8`; extraction described at `routes/mapProjection.ts:47-66` precisely to avoid a second "which buddy fields are public". |
| M152 | Map → geographic presentation | C | `lib/mapProjection.ts:16-24` — the map layer shapes and nothing else. |

### §21 Live Intelligence Flow (7)

Seven stages, all present, **none spec-attributable** — this is the Intelligence
Gathering programme's spine (`docs/intelligence-gathering-buildout.md`), which
the Map reads. Liveness caveat: `docs/architecture/intel-spine-liveness.md`
measured every `intel_*` table in production at `count(*) = 0` **with the gates
open**. These verdicts describe code that is correct and would run.

| id | Stage | V | Evidence |
| --- | --- | --- | --- |
| M153 | Observation | C | `services/intel/IntelCaptureService.ts` `writeObservation`. |
| M154 | Evidence | C | `lib/intelEvidenceCapture.ts`; `intel_evidence.observation_id NOT NULL`. |
| M155 | Claim | C | `IntelCaptureService.proposeClaim`, `:510-523`. |
| M156 | Confidence | C | `lib/confidenceScore.ts`; banded by `lib/intelContracts.ts`. |
| M157 | Freshness | C | `lib/freshnessPolicy.ts`, per claim_type TTL; consumed at `lib/mapObjects.ts:135-146`. |
| M158 | Correction / Contradiction | C | `IntelCaptureService.ts:599-608` — a correction supersedes the prior claim and emits `intel.correction.invalidation.completed` for the keys it expired; `lib/intelConflict.ts`. |
| M159 | Projected Map State | C | `lib/intelProjection.ts` → `lib/mapProjection.ts:696#applyLiveClaims`. *(Repointed 2026-09-14 from line 676; `lib/intelProjection.ts` is the Sensing lane's and is cited, not touched, here.)* |

### §22 Map Contributions (11)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M160 | The map is a low-friction capture surface; contributions are observations, not immediate truth | C | `routes/mapObservations.ts:2,13` — one append-only `intel_observations` row per prompt; `src/features/map/truth/contributionFlow.ts:12` — *"A photo is EVIDENCE, not a proposition."* |
| M161 | Crowd level | C | `src/features/map/truth/liveTruth.ts:425` `crowd_level`; reuses `ACTIVITY_LEVELS` so a contributed level and a projected one are the same wire value. |
| M162 | Queue | C | `liveTruth.ts:426`, `:451` `QUEUE_LEVELS`. |
| M163 | Entry / access | C | `liveTruth.ts:427`, `:461` `ENTRY_ACCESS_STATES`. |
| M164 | Vibe | C | `liveTruth.ts:428`, `:477` `VIBE_STATES`. |
| M165 | Event status | C | `liveTruth.ts:429`, `:487` `EVENT_STATUS_STATES`. |
| M166 | Closure | C | `liveTruth.ts:430`, `:505` `CLOSURE_STATES`. |
| M167 | Crowd direction | C | `liveTruth.ts:431`, `:519` `CROWD_DIRECTIONS`. |
| M168 | Current photo / video | C | `liveTruth.ts:432` `media`, `:538` `MEDIA_KINDS`; `contributionFlow.ts:231` — a bare photo is not a §22 contribution "no matter how good the file is". |
| M169 | Prompt → Observation → Identity/Trust → Qualification → Claim → Projection → Map | C *(not spec-attributable)* | `routes/mapObservations.ts:19-20` names each owning module; `:28` refuses a second ingest that would write `intel_observations` itself. |
| M170 | Rewards must never increase factual confidence merely because paid | C | `routes/mapObservations.ts:70` — *"`intel_reward_ledger` and `intel_observations` do not join"*; `lib/mapProjection.ts:518` `sourceCountBucket` is nullable precisely so a paid claim cannot borrow a cohort. |

*Liveness: `intel_observations` exists in production and holds zero rows with
`intel_capture_quick_signal` TRUE. The route is also flag-gated —
`routes/mapObservations.ts:741` `map_contributions_enabled`.*

### §23 Presence and Privacy (8)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M171 | Default public rendering aggregates social presence | C | `lib/mapProjection.ts:41-49`; `:117-121` a traveler is a `social_zone`, never an identified person. |
| M172 | The five-rung `LocationVisibility` ladder | C | `lib/mapObjects.ts:309-316#PRIVACY_CLASSES`; `lib/mapObjects.ts:319#precisionRank`, `lib/mapObjects.ts:324#narrowestPrivacyClass` — combining can only ever tighten. *(All three repointed 2026-09-14, each ~50 lines low.)* |
| M173 | Public stranger → aggregate only | C | `lib/mapProjection.ts:110` `travelerPrivacyClass` defaults to `aggregate_only`; mirrored `src/features/map/projection/clientProjection.ts:226`. |
| M174 | Shared Moment → place-level or delayed | C | `src/features/map/interaction/longPress.ts:273` `SHARE_PRECISION_CEILING = 'place_level'`, `:276` `DEFAULT_SHARE_PURPOSE = 'shared_moment'`; delayed-publish gate at `lib/eventPostsDiscovery.ts:186`. |
| M175 | Trip Crew → approximate, or permitted temporary precise | C | `lib/mapProjection.ts:266-281` — *"A consented circle member is ALWAYS `approximate` — never `place_level`"*, `CIRCLE_PRIVACY_CLASS`. |
| M176 | Locate My Friends → temporary group-scoped approximate/precise | C *(not spec-attributable)* | `src/features/map/presence/presenceLadder.ts:113-145` — a MIRROR of the server's Presence-spec ladder. |
| M177 | Safe Return → purpose-bound precise | C *(not spec-attributable)* | `presenceLadder.ts:330-392` `PRESENCE_PURPOSES` / `PURPOSE_CEILINGS` / `UNKNOWN_PURPOSE_CEILING`; `:452` "the most precise rung `purpose` may reach right now"; `:492` the narrowest-of-all rule. |
| M178 | Temporary location decays Precise → Approximate → Last known → Expired | C | `presenceLadder.ts:529` `DECAY_STAGES` exactly those four, `:541` intervals, `:551` boundaries, `:562` per-stage ceiling. Migration `2219:246` re-applies the decay on **read**, "regardless of whether a sweep has run". |

### §24 Protected Location and Safety Rules (4)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M179 | Suppress sensitive locations **before** data reaches the client | **W** | The gate is written and cannot fire. `lib/protectedLocations.ts:2#protectedLocations`, `:860#applyProtection` is the last step before serialization, ordered correctly at `routes/mapProjection.ts` and (after PR #393's fix) in the temporal route. But `protected_zones` is **absent from production** (`` `artifacts/api-server/src/scripts/checkProductionDrift.ts:229#protected_zones` ``, and the name is not in `baseline/20260907_production_tables.txt`), so the read errors, `routes/mapProjection.ts:227#loadProtectedZones` returns null and the route answers the refusal envelope at `:1047#protection_unreadable`. *(Re-read 2026-09-14: three of these four citations were wrong — line 849 is a field inside an interface and `applyProtection` is 11 lines below it; drift's `protected_zones` entry is at line 157, not 110; and lines 964-979 are the §19 ordering block, not the envelope, which begins 60 lines later.)* The production behaviour is *refuse everything*, not *suppress sensitive locations* — safe, and not the requirement. **Turns red when:** 2217 is applied to production, a refreshed baseline lists `protected_zones`, and a projection response over a viewport containing a curated zone carries `protection` non-null with at least one object coarsened or withheld. Note the second half: applying the table is necessary and NOT sufficient — an empty `protected_zones` makes `applyProtection([], …)` an identity pass (`routes/mapProjection.ts:195#FAIL-CLOSED`), which suppresses nothing. A curated zone set is an ops act after the migration. |
| M180 | The protected categories (residences, medical, shelters, sensitive government, policy-defined) | C | `lib/protectedLocations.ts:81-88` `PROTECTED_CATEGORIES`; migration `2217:66-72` CHECK-constrains the same five; `:102` `policy_ref NOT NULL` so *"a protected location with no recorded policy"* is unrepresentable; `:135` `'allow'` is deliberately not storable — "a protection row that permits is a hole". |
| M181 | Safety and access warnings take precedence over activity ranking | C | `lib/mapObjects.ts:284` `safety: 120`; `lib/protectedLocations.ts:210` `PROTECTION_EXEMPT_KINDS = ['safety_notice']` — a hazard notice is never coarsened away. |
| M182 | The public map never receives more location detail than the viewer is authorized to see | C | `lib/protectedLocations.ts:720#coarsenForZone`, `lib/protectedLocations.ts:798#COARSENED_PAYLOAD_KEYS`; `lib/mapObjects.ts:221-226#verified_firsthand` documents that the strip must be able to delete `sourceClass` because it *"publishes that someone was here"*. *(These three repointed 2026-09-14: line 793 was 5 lines short, and lines 376-381 sat 155 lines past the passage they quote.)* Also `lib/protectedLocations.ts:301#COARSEN_UNSAFE_KINDS` and `:325#RELATIONSHIP_GATED_KINDS` — REPOINTED 2026-09-14 by `check:citation-symbols`: the LINE NUMBERS were right and the FILE was wrong. Both constants live in `protectedLocations.ts`, but `lib/mapObjects.ts:376-381` was cited between them and the opening citation, and a bare `:301` inherits the most recently named file. Anchored so the next shift fails loudly. |

### §25 Interaction System (7)

The persistent rail is M17. The seven long-press actions:

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M183 | Meet here | C | `src/features/map/interaction/longPress.ts:146`; model `src/features/map/meet/meetHereModel.ts`. |
| M184 | Save location | C | `longPress.ts:147`; `:164` `MIN_PRECISION_FOR_PINNING = 'place_level'`. |
| M185 | Add to Trip | C | `longPress.ts:148`; `:211` pushes `interaction.detailRoute` rather than reimplementing the plan picker. |
| M186 | Ask Compass about here | C | `longPress.ts:149`. |
| M187 | Share permitted location | C | `longPress.ts:150,273,309` `BOUNDED_SHARE_CHANNEL_EXISTS = true`, `:323` `SHARE_MAX_TTL_MS = 1 h`. Built by commit `e276136b`, *"§25 'Share permitted location' — bounded share channel on §12 session"*. |
| M188 | Create checkpoint | C | `longPress.ts:151`. |
| M189 | Report what is here | C | `longPress.ts:152`, `:35` gated by `contributionPromptsFor`, `:358` **fails closed when absent**. |

### §26 Pulse Integration (3)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M190 | Pulse and Map are two presentations of the same intelligence | C | `src/features/map/pulse/pulseMapBridge.ts:2,10`; `:170` one routing row per deep-link destination. |
| M191 | A Pulse item deep-links to the corresponding map state | C | `pulseMapBridge.ts:285` `pulseItemToMapState`, `:411` the inverse `mapStateToPulseQuery`; consumed by `LivePulseCard.tsx:8-12`. |
| M192 | Map states must never contradict Pulse | C | `pulseMapBridge.ts:475-530` — a `findContradictions` function whose stated purpose (`:528`) is to catch "the deep link pointed at the wrong object" cases that "would otherwise silently pass". |

### §27 Search (10)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M193 | Places | C | `src/features/map/search/mapSearchModel.ts:42`; adapter `searchAdapter.ts:64,68` (`places`, `activities`). |
| M194 | Events | C | `mapSearchModel.ts:43`; `searchAdapter.ts:69`. |
| M195 | Trips | C | `mapSearchModel.ts:44`; `searchAdapter.ts:70`. |
| M196 | Users | C | `mapSearchModel.ts:45`; `searchAdapter.ts:71` (`travelers → user`). |
| M197 | Buddies | C | `mapSearchModel.ts:46`; `searchAdapter.ts:72`. |
| M198 | Hidden Gems | C | `mapSearchModel.ts:47`; `searchAdapter.ts:73`. |
| M199 | Areas | C | `mapSearchModel.ts:48`; `searchAdapter.ts:79-80` (`cities`, `countries`). |
| M200 | Hashtags | C | `mapSearchModel.ts:49`; `searchAdapter.ts:74`. |
| M201 | Saved items | C | **Moved W→C 2026-09-13.** The row's finding was right: the client carried the whole branch (`mapSearchModel.ts:50`, `:144-148`, `:64`) and the server had no type that could reach it. It has one now — `` `artifacts/api-server/src/routes/discoverySearch.ts:139#saved` `` is wire vocabulary, produced by `` `artifacts/api-server/src/routes/discoverySearch.ts:1328#async function searchSaved(` `` over the two tables saves actually land in (`wishlist_places` + `discovery_place_saves`, as `savedPlaceProducer` reads them after #446), dispatched at `` `artifacts/api-server/src/routes/discoverySearch.ts:2390#case "saved":` ``. The adapter's `saved` key moved out of the tolerated-alias block into the wire table (`` `travel-buddy-standalone/src/features/map/search/searchAdapter.ts:84#saved:` ``) and `savedKind` is now read from the wire rather than hard-coded (`` `travel-buddy-standalone/src/features/map/search/searchAdapter.ts:261#export function savedKindFromMetadata` ``). The map asks for it: `` `travel-buddy-standalone/src/components/map/MapSearchSheet.tsx:182#searchUnified(q,` ``. Executed: `` `artifacts/api-server/src/test/mapSearchSavedItems.test.ts:168#it("dispatchSearch has a` `` (15 cases; deleting the dispatch case reddens 9, dropping either save table reddens 6). **Not in the `all` fan-out** — see the owner decision in §40. |
| M202 | Geographic results centre or frame the relevant map object | C | `mapSearchModel.ts:218` — bounds used where known; `:265-267` a saved area frames as `FOCUS_AREA`, a saved trip as `FOCUS_TRIP`; `:307-309` a saved item inherits the geography of what it saved. `searchAdapter.ts:19` refuses to fall back to the user's position because that "pretends the result is where they are". |

### §28 Offline and Degraded Mode (8)

All eight in `src/features/map/cache/mapCache.ts`, whose `MAP_CACHE_CLASSES`
(`:95-102`) is a one-to-one match with §28's list, each with its own shelf life
(`MAP_CACHE_POLICIES`, `:125`) because *"a trip is planned days ahead, a crowd
observation is worthless in an hour, and safety information must survive"* (`:91-93`).

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M203 | Cache current base-map region | C | `mapCache.ts:96` `base_map_region`, `:128`; pack built by `src/features/map/cache/offlineBaseMap.ts` (commit `da842325`), pruned at `app/map/index.tsx:31`. |
| M204 | Cache current Trip and stops | C | `mapCache.ts:97,136`. |
| M205 | Cache event map and meeting points | C | `mapCache.ts:98,144-148` — 7 days, "venue geometry and meeting points outlive the event day, indoor signal is unreliable". |
| M206 | Cache saved places | C | `mapCache.ts:99,152`. |
| M207 | Cache Crew last-known state | C | `mapCache.ts:100,161` — the member survives even after their position expires. |
| M208 | Cache recent relevant place intelligence | C | `mapCache.ts:101`. |
| M209 | Cache emergency/safety information | C | `mapCache.ts:102,111-116` — the one class allowed to outlive the rest, "still labelled stale like everything else". |
| M210 | Clearly label stale cached intelligence with last-updated time | C | `mapCache.ts:11-26` quotes §28 and §37 together; a cached `live` object comes back **downgraded** to `recent`/`aging`/`stale` with a `staleness` descriptor so the UI can render "Last updated 14m ago". |

### §29 Recommended Mobile Client Structure (6)

Counted per directory (see §2 of this document). **20 of the 31 named files do
not exist under those names**; every responsibility they name has a home.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M211 | `/screens` — MapScreen, PlaceDetailScreen | C | Neither name exists. The map screen is `app/map/index.tsx` (3 464 lines); place detail is `src/components/map/LivePlaceSheet.tsx` — **which §8 requires to be a sheet, not a screen**, so the divergence is the spec obeying itself. |
| M212 | `/modes` — Live, CrowdFlow, Trip, LocateFriends, Compass, TimeMachine | C | No `/modes` directory. Modes are a single reducer (`src/features/map/state/mapMachine.ts`, §30) plus one model per mode: `compass/compassMapModel.ts`, `trip/tripMapModel.ts`, `time/timeMachine.ts`, `presence/locateFriends.ts`, `render/zoneStyle.ts` (flow). Six files ↔ six modes, better factored than six `*Mode.ts`. |
| M213 | `/components` — the fifteen named components | C | Six exist by name (`ActivityZone`, `CrowdFlowLine`, `LivePulseCard`, `MapBottomActions`, `IntentSheet`, `LayersSheet`, `FreshnessBadge`, `ConfidenceIndicator`). The rest are consolidated: `MapCanvas` → `src/components/discovery/DiscoveryMapView.tsx`; `PlaceMarker`/`EventMarker`/`UserMarker`/`CrewMarker`/`SocialCluster` → `src/components/map/EntityMarkers.tsx` (one kind-dispatching layer); `MeetingPoint` → `CheckpointPin.tsx`. |
| M214 | `/state` — mapStore, viewportStore, layerStore, intentStore | C | Only `src/stores/mapStore.tsx` exists by name. Viewport state is inside it (`cameraCenter`, `cameraZoom`); layer state is `src/features/map/layers/layerModel.ts` + `LayersSheet`'s persistence; intent state is `src/features/map/intent/intentModel.ts`. **The consolidation is deliberate and documented** — `mapMachine.ts:33-40` explains what it refuses to duplicate from `mapStore`. |
| M215 | `/services` — mapProjection, mapCache, location | C | All three exist: `src/services/mapProjection.ts:3`, `src/features/map/cache/mapCache.ts`, `src/services/location.ts`. |
| M216 | `/types` — mapObjects | C | `src/types/mapObjects.ts:2`, drift-guarded against the server mirror. |

### §30 Map State Machine (19)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M217–M219 | Modes LIVE, PLACE_SELECTED, COMPASS | C ×3 | `src/features/map/vocabulary.ts:45-51` `MAP_MODES` in §30's own order and **uppercase spelling**, with `:20-30` explaining that the casing is load-bearing (two spellings of one enum makes a `Record<MapMode,…>` lookup return `undefined` with no type error). |
| M220 | Mode TRIP | C | `src/features/map/vocabulary.ts:48#'TRIP',` *(repointed 2026-09-14 from line 49, which is `'CROWD_FLOW'`; the whole `MAP_MODES` block was cited one line low and M221–M223 carried the same shift)*; capability true. |
| M221 | Mode CROWD_FLOW | **W** | `src/features/map/vocabulary.ts:49#'CROWD_FLOW',` *(repointed 2026-09-14 from line 50, which is `'LOCATE_FRIENDS'` — the whole `MAP_MODES` block was cited one line low)*; unreachable in production, and turns red exactly when M5 does. |
| M222 | Mode LOCATE_FRIENDS | **W** | `src/features/map/vocabulary.ts:50#'LOCATE_FRIENDS',` *(repointed from line 51)*; storage absent, and turns red exactly when M7 does. |
| M223 | Mode TIME_MACHINE | **W** | `src/features/map/vocabulary.ts:51#'TIME_MACHINE',` *(repointed from line 52, which is the array's closing `] as const;`)*; gateway-dark, and turns red exactly when M10 does. |
| M224 | Overlay INTENT | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2666`. |
| M225 | Overlay LAYERS | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2545,2569`. |
| M226 | Overlay FILTERS | C | **Moved W→C 2026-09-13.** The reducer was always right; nothing entered the state. Both "filters" affordances dispatch it now — the floating control at `` `travel-buddy-standalone/app/map/index.tsx:2586#onFiltersPress={()` `` (it used to dispatch `'LAYERS'`) and the carousel's empty-state button at `` `travel-buddy-standalone/app/map/index.tsx:2621#onFiltersPress={()` `` — and the sheet reads the machine: `` `travel-buddy-standalone/app/map/index.tsx:3267#visible={overlayOpen('FILTERS')}` ``. The bypassing `filterSheetOpen` `useState` is gone, so D1 mutual exclusion and `resolveBack` now actually govern it. `LayersSheet` keeps its own header entry point (`onLayersPress`), so this did not fix one sheet by breaking another. Executed: `` `travel-buddy-standalone/src/features/map/state/__tests__/filtersOverlay.test.ts:136#test('the` `` (12 cases; restoring the `useState` reddens 2, re-pointing the control at `'LAYERS'` reddens 3). |
| M227 | Overlay SEARCH | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2543-2544`, rendered `:3181`. |
| M228–M235 | Camera FOLLOW_USER, FREE_EXPLORE, FOCUS_PLACE, FOCUS_AREA, FOCUS_ROUTE, FOCUS_TRIP, FOCUS_GROUP, COMPASS_RECOMMENDATIONS | C ×8 | `mapMachine.ts:149-160` all eight in §30's order. `:163-179` `MODE_CAMERA` couples each mode to a framing **as data**, with FOCUS_ROUTE deliberately absent from it because §5 makes navigation cross-cutting rather than a mode (`:178-180`). `:191-215` `OBJECT_KIND_CAMERA` refines by kind — zone-shaped kinds get FOCUS_AREA because "framing them as a pin would imply a precision §23 never granted", and `crew_member` gets FOCUS_GROUP for the same reason. D4 (`:66-73`): a user pan drops to FREE_EXPLORE and changes nothing else. |

### §31 Clustering and Rendering Priority (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M236 | Viewport queries | C | `lib/mapProjection.ts:1175#parseBbox` — rejects malformed, out-of-range and antimeridian-crossing viewports rather than guessing; `lib/mapAggregation.ts:105#bboxContains`. *(`parseBbox` repointed 2026-09-14 from line 1124; `bboxContains` was already right and is now anchored.)* |
| M237 | Server aggregation | C | `lib/mapAggregation.ts:2,216-238,272-335`. |
| M238 | Client clustering | C | `src/features/map/render/collision.ts:474-645`. |
| M239 | Render thresholds | C | `collision.ts:227-236` `ZOOM_BAND_MIN` → band; `:276-293` `VISIBLE_BY_BAND` built cumulatively so "a kind visible at a wider band is always visible closer in". |
| M240 | At wide zoom many places collapse into an area summary / activity zone | C | `lib/mapAggregation.ts:216-219` `AGGREGATING_BANDS = ['world','city']` — "Only `world` and `city` aggregate; `district` and below return" individually. |
| M241 | The twelve-tier priority ladder | C | `lib/mapObjects.ts:283-297` `RENDERING_PRIORITY`, all twelve tiers in the spec's order (safety 120 → generic_poi 10); `:300-320` `KIND_DEFAULT_PRIORITY` assigns every kind a tier. |
| M242 | Hide lower-priority objects when collisions occur | C | `collision.ts:617-645` `resolveCollisions` — deterministic by construction, `kept.length + dropped.length === objects.length` always, "nothing is ever silently truncated"; the "cull, but never to empty" waiver re-runs the whole pass rather than patching the first result. |

### §32 Bottom Sheets and Mobile Motion (4)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M243 | Three snap points: Peek ~15-20 %, Half ~45-55 %, Full ~90-95 % | C | `src/components/map/LivePlaceSheet.tsx:68-77` — 0.18 / 0.50 / 0.92, all inside the spec's bands; `SNAP_ORDER` at `:80`, nearest-snap resolution `:92-96`. |
| M244 | Map stays visible behind Peek and Half | C | `LivePlaceSheet.tsx:114` `scrim: 'rgba(4,6,8,0.55)'` — `mapChrome.ts:76-78` names it `scrimSoft`, "behind a peek/half sheet where the map must stay readable". |
| M245 | Subtle activity pulse, zone expansion, flow motion, new-intelligence transitions, Compass selection, route animation | C | `zoneStyle.ts:209-223`, `:183` forecast dimming; `ActivityZone.tsx`, `CrowdFlowLine.tsx`, `TravelerFlowLine.tsx`. |
| M246 | Avoid constant bouncing markers or animation without semantic meaning | C | `zoneStyle.ts:209` `MEANINGFUL_CHANGE_TRENDS` gates the pulse on a trend that actually changed; no unconditional marker animation exists in `src/components/map/`. |

### §33 Loading Strategy (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M247–M252 | The six-stage ladder: cached geography → position → canonical places/events → live state → social state → Compass personalization | C ×6 | `src/features/map/cache/loadingStrategy.ts:25-34` `LOADING_STAGES`, exactly six in the spec's order; `:37` `INITIAL_STAGE = 'cached_geography'` — *"the stage the map starts at — never 'nothing'"*; `:39` `TERMINAL_STAGE = 'compass'`; `:95` `STAGE_UNLOCKS` says what each stage adds. |
| M253 | The map progressively improves and never blanks while live intelligence loads | C | `loadingStrategy.ts:15,141-146` `renderableAt(stage)` — the contract for "what the screen may ALREADY draw"; `:64` `advanceStage` is monotonic, so a stage can never regress and blank the screen. |

### §34 Performance Targets (5)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M254 | Initial usable map under 2 s on a normal connection | **?** | No timing harness or budget assertion exists in the tree. **The measurement, named:** median over 10 COLD starts (app data cleared between runs) of the interval from the `/map` route's navigation commit to MapLibre's first fully-rendered frame, on a mid-tier Android handset running an EAS `preview` build (the standalone package declares that profile in its EAS config; the local dev path is its Android dev script), with the link shaped to a 4G profile — ~1.6 Mbit/s down, 300 ms RTT — because "a normal connection" is otherwise whatever the tester's wifi is. The §33 cache arm must be reported separately: `MapOpenedPayload` already carries the flag that distinguishes them (`src/features/map/telemetry/mapTelemetry.ts:461#servedFromCache`), and a warm-cache number answers a different requirement. **Who can supply it:** anyone who can run a `preview` build on hardware. Nothing in this repository can. |
| M255 | Pan responsiveness ~60 fps | **?** | **The measurement, named:** 99th-percentile frame time ≤ 16.7 ms over a scripted 3-second continuous pan at city zoom, read from Android GPU frame timing (`adb shell dumpsys gfxinfo <pkg> framestats`) on the same mid-tier handset, **with the §6 zone-shaped layers actually drawn** — activity zones, crowd flow and traveler flow (`src/components/map/ActivityZone.tsx`, `CrowdFlowLine.tsx`, `TravelerFlowLine.tsx`). A pan over an empty base map is not this requirement and is the easy way to produce a green that means nothing, which is the whole risk here: the production map IS empty today (M133), so a device measurement taken against production would measure exactly that empty map. So the run must be against a seeded `portava-ci`, not production. **Who can supply it:** a device pass with the layers populated. |
| M256 | Viewport intelligence first results within ~500-800 ms when cached/server-ready | **?** | **Two measurements, and only one of them needs a device — this X is partly a missing harness, which is worth separating.** (a) SERVER: p50 and p95 of request-receipt to response-flush for `GET /api/map/projection` over 50 warm-cache requests on a seeded `portava-ci`. Nothing blocks this but the fact that nobody has written it; it needs no production access and no handset, and it is the half that would catch a slow projection. (b) DEVICE: camera-settle (the debounce at `src/hooks/useMapEntities.ts`) to first object painted, same handset as M254. (b) additionally requires the gateway to be serving, so it is blocked behind M133; (a) is not. **Who can supply it:** (a) any lane that owns a CI perf harness — this lane can see no such harness anywhere under `artifacts/api-server/src/test/`; (b) a device pass. |
| M257 | Debounce after the camera settles; never re-query on every pixel | C | `app/map/index.tsx:941-947` — *"a coarse centre grid and only re-queries after the §34 settle debounce"*; `:1009` "once the camera settles, the viewport intelligence is fetched"; `src/components/discovery/DiscoveryMapView.tsx:137` reports the camera only on settle. |
| M258 | Keep animation layers GPU-friendly | **?** | **The measurement, named:** GPU overdraw and per-frame layer-rebuild count for the three animated layers under Android's GPU rendering profiler, on the same handset, over the same scripted pan as M255 — the falsifiable form being that no animated layer causes a full style re-layout per frame. **One half of that was NOT a device question, and is now asserted in this tree.** `src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx` renders the real `ActivityZone`, captures the props MapLibre would receive, and pins the three things §34 is asking for on the animation path: sixty consecutive 16 ms frames inside a half-period cost **zero** repaints; each half-period costs exactly **one**; the source `data` keeps its IDENTITY across every pulse repaint, so a pulsing zone never re-uploads its polygon; and the dim→bright interpolation is handed to the GPU as `line-opacity-transition` spanning the gap between JS updates (`src/components/map/ActivityZone.tsx:191#'line-opacity-transition':`). Four mutations were confirmed to redden it: a 16 ms pulse interval, a per-render rebuild of the feature, a removed transition, and a static opacity. **The row stays `?` and the requirement is not weakened** — overdraw and real frame cost are still a handset measurement and this asserts neither. What changed is that the CADENCE half can no longer regress silently, which it could have on the day this row was written. **Who can supply the rest:** a device pass with the GPU profiler. |

### §35 Product Telemetry (17)

**All sixteen events have real emitters. None of them can land.**

`map_telemetry_events` and `map_telemetry_drops` **do not exist in production**
(ground truth; `scripts/checkProductionDrift.ts:121-127`, both `unapplied`, the
note reading *"Telemetry writer targets a table production does not have; the
write fails there"*). The writer is `routes/mapTelemetry.ts:269` (drops) and
`:225` (events), behind a second gate — `map_telemetry_enabled`, seeded OFF
(`:161`, `migrations/2202_map_telemetry.sql`). The client transport is wired
(`app/map/index.tsx:1297-1298` `setMapTelemetryTransport(createFetchTelemetryTransport(…))`
→ `/api/map/telemetry`, `src/features/map/telemetry/mapTelemetry.ts:1281`).

**This is the identical shape the Wall census found** — 13 of 15 Wall telemetry
events landing nowhere — and it is the same root cause, one migration lane
short of production.

| id | Event | V | Emitter |
| --- | --- | --- | --- |
| M259 | `map_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:643#'map_opened',`; 1 emitter: `app/map/index.tsx:1322#emitMapEvent('map_opened',`. `src/features/map/telemetry/mapTelemetry.ts:23#mapSessionId` mints the session id here and nowhere else, so this emitter is also what stops every later event carrying a SYNTHETIC session (`:1011#ensureSession`). |
| M260 | `zone_selected` | **W** | `src/features/map/telemetry/mapTelemetry.ts:644#'zone_selected',`; 3 emitters: `src/components/map/MapEntityPreviewCard.tsx:132#emitMapEvent('zone_selected',`, `src/components/map/MapCarousel.tsx:1240#emitMapEvent('zone_selected',`, `src/components/map/LivePlaceSheet.tsx:321#emitMapEvent('zone_selected',`. *(The third emitter, previously written "+1", is the `LivePlaceSheet` call site above.)* |
| M261 | `place_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:645#'place_opened',`; 3 emitters: `src/components/map/MapEntityPreviewCard.tsx:138#emitMapEvent('place_opened',`, `src/components/map/MapCarousel.tsx:1246#emitMapEvent('place_opened',`, `src/components/map/LivePlaceSheet.tsx:327#emitMapEvent('place_opened',`. |
| M262 | `live_state_viewed` | **W** | `src/features/map/telemetry/mapTelemetry.ts:646#'live_state_viewed',`; 2 emitters: `src/components/map/LivePlaceSheet.tsx:361#emitMapEvent('live_state_viewed',`, `src/components/map/LivePlaceSheet.tsx:385#emitMapEvent('live_state_viewed',`. |
| M263 | `why_shown_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:647#'why_shown_opened',`; 1 emitter: `app/map/index.tsx:2845#emitMapEvent('why_shown_opened',`. **The emitter exists and its payload is wrong.** `WhyShownOpenedPayload.lineCount` means "how many provenance lines the §9 panel showed", and the emitter computes `obj.provenance?.lines.length ?? 0` while `WhyShownSheet` renders `buildWhyPanel(object)`, whose `buildWhyLines` SYNTHESISES lines whenever the server sent none — so every synthesised panel reports 0. `provenanceRefs` diverges the other way: the emitter sends `obj.sourceRefs`, the panel shows `model.lines[].ref`. Built and proven this pass: `src/features/map/telemetry/whyShownOpened.ts:49#whyShownOpenedPayload` derives both from the same `buildWhyPanel` call the sheet renders, with `src/features/map/telemetry/__tests__/whyShownOpened.test.ts` failing when the helper is replaced by the production expression. WIRING IT IS A CROSS-LANE CHANGE — the emitter is in `app/map/index.tsx`, which the Map lane does not own — so the payload defect is open |
| M264 | `compass_requested` | **W** | `src/features/map/telemetry/mapTelemetry.ts:648#'compass_requested',`; 1 emitter: `src/components/map/AskCompassBar.tsx:137#emitMapEvent('compass_requested',`. Mints `decisionId` (`src/features/map/telemetry/mapTelemetry.ts:25#decisionId`). |
| M265 | `compass_option_selected` | **W** | `src/features/map/telemetry/mapTelemetry.ts:649#'compass_option_selected',`; 1 emitter: `src/components/map/MapCarousel.tsx:1256#emitMapEvent('compass_option_selected',`. |
| M266 | `route_started` | **W** | `src/features/map/telemetry/mapTelemetry.ts:650#'route_started',`; 2 emitters: `src/components/map/MapEntityActionRow.tsx:579#emitMapEvent('route_started',`, `src/components/map/LivePlaceSheet.tsx:444#emitMapEvent('route_started',`. *(Re-counted 2026-09-14: **two**, not the three previously claimed. Every `route_started` reference in `travel-buddy-standalone/src` and `travel-buddy-standalone/app` was read; the other four are comments and the type declarations.)* |
| M267 | `trip_stop_added` | **W** | `src/features/map/telemetry/mapTelemetry.ts:651#'trip_stop_added',`; 1 emitter: `src/components/map/MapEntityActionRow.tsx:535#emitMapEvent('trip_stop_added',`. |
| M268 | `plan_joined` | **W** | `src/features/map/telemetry/mapTelemetry.ts:652#'plan_joined',`; 2 emitters: `src/components/map/MapEntityActionRow.tsx:476#emitMapEvent('plan_joined',`, `app/map/index.tsx:407#emitMapEvent('plan_joined',`. |
| M269 | `meet_here_created` | **W** | `src/features/map/telemetry/mapTelemetry.ts:653#'meet_here_created',`; 1 emitter: `app/map/index.tsx:3163#emitMapEvent('meet_here_created',`. |
| M270 | `crew_locate_started` | **W** | `src/features/map/telemetry/mapTelemetry.ts:654#'crew_locate_started',`; 1 emitter: `app/map/index.tsx:2178#emitMapEvent('crew_locate_started',`. |
| M271 | `contribution_submitted` | **W** | `src/features/map/telemetry/mapTelemetry.ts:655#'contribution_submitted',`; 1 emitter: `app/map/index.tsx:2882#emitMapEvent('contribution_submitted',`. `src/features/map/telemetry/mapTelemetry.ts:585#sinceRouteStart` carries the banded time since `route_started`. |
| M272 | `alternative_requested` | **W** | `src/features/map/telemetry/mapTelemetry.ts:656#'alternative_requested',`; 1 emitter: `app/map/index.tsx:3184#emitMapEvent('alternative_requested',`. |
| M273 | `recommendation_accepted` | **W** | `src/features/map/telemetry/mapTelemetry.ts:657#'recommendation_accepted',`; 3 emitters: `src/components/map/MapEntityActionRow.tsx:390#emitMapEvent('recommendation_accepted',`, `src/components/map/MapCarousel.tsx:1266#emitMapEvent('recommendation_accepted',`, `src/components/map/LivePlaceSheet.tsx:438#emitMapEvent('recommendation_accepted',`. |
| M274 | `recommendation_declined` | **W** | `src/features/map/telemetry/mapTelemetry.ts:658#'recommendation_declined',`; 2 emitters: `src/components/map/AskCompassBar.tsx:128#emitMapEvent('recommendation_declined',`, `src/components/map/LivePlaceSheet.tsx:407#emitMapEvent('recommendation_declined',`. |
| M275 | Evaluate real-world outcomes, not only screen engagement | **W** | The design is right and the measurement is impossible. `src/features/map/telemetry/mapTelemetry.ts:25#decisionId` threads one id through `compass_requested → compass_option_selected → recommendation_accepted → route_started → (arrival) → contribution_submitted` (`:34#route_started`), with declines and alternatives as "the negative arm of the same" id (`:37#alternative_requested`) — a genuine outcome loop. It writes to a table that is not there. |

**What turns M259–M275 red, stated once for all seventeen.** The verdicts are
NOT about the emitters — every one of the sixteen was re-counted on 2026-09-14
by reading each `emitMapEvent` call site in `travel-buddy-standalone/src` and
`travel-buddy-standalone/app`, and the counts above are that measurement (one
was wrong: M266 claimed three and has two). They are about the sink. The
settling evidence is a row in `map_telemetry_events` in production carrying that
event name, which needs, in order: 2202 applied (integration owner), then
`map_telemetry_enabled` flipped TRUE — and the flag ROW does not exist in
production either, because 2202 is what creates it. Until then every emit is
accepted by `routes/mapTelemetry.ts` and dropped. Nothing a lane can build moves
any of these seventeen rows; the emitters are already there.

**One thing here IS code and is open: M263's payload.** See that row. A
mis-computed `lineCount` would still be mis-computed the day 2202 lands, and it
is the only defect in this block that a deployment does not fix.

*Privacy backstop, worth recording because it is good: positions are coarsened
to a ~4.9 km geohash cell client-side (`mapTelemetry.ts:104-107`), raw
coordinates are rejected by the route **and** by a DB CHECK function
(`2202_map_telemetry.sql:101,115`), and `viewer_id` is stamped from the bearer
token, never the body.*

### §36 Implementation Phases (7)

| id | Phase | V | Evidence |
| --- | --- | --- | --- |
| M276 | Phase 1 — Foundation | C | §3, §4, §16, §17, §18 rows above; all C. |
| M277 | Phase 2 — Live World | C | §8, §9, §22 rows above; all C (with the zero-row intel caveat). |
| M278 | Phase 3 — Presence & Coordination | **W** | Trip Crew and Meet Here are C (M76, M183); Locate My Friends and offline event maps depend on the four absent `locate_friends_*` tables (M83–M94). **Turns red when:** M7 turns red — a refreshed production baseline listing the four tables — *except* for M88/M89, whose BLE rungs no migration reaches. So this phase can reach C with two rungs still N only if §12's ladder is read as "the rungs the stack supports"; read strictly, M278 cannot close while the stack has no radio. That reading is an owner call and is recorded here rather than taken. |
| M279 | Phase 4 — Crowd Intelligence | **W** | Built and dead: M5, M65, M67. **Turns red when:** all three do. Note M65 is the one that no deployment reaches — five of seven signal families have no capture — so a `geo_zones` backfill plus 2218/2224 lights the surface (M5, M67) and still leaves this phase W on M65. |
| M280 | Phase 5 — Temporal Intelligence | **W** | Built and gateway-dark: M10, M106–M111. **Turns red when:** M10 does — 2217 applied, then `map_projection_enabled` TRUE in production, in that order. Nothing else in the phase has a blocker of its own. |
| M281 | Phase 6 — Journey Intelligence | **N** | Ruled **out of scope** in-repo, before any code: `docs/map/scope-ruling-phases-6-7.md:44#Building` — *"Building them would mean inventing a product from a two-word mention"*, with a table showing every Phase-6 term occurs exactly once in the whole spec. Nothing in main implements route optimization beyond §11's Optimize Today, Along My Way, next-move prediction, recovery, group decision or smart meeting points. **PR #393 is exactly this phase** and would move the verdict. **Turns red when:** either PR #393 lands, or the owner amends the scope ruling the way §36 Phase 7 was amended and the named surfaces are then built. Both are owner/integration acts; the in-repo ruling is what makes N the correct verdict rather than an omission, and a lane building Phase 6 unilaterally would be re-making the mistake the ruling names. |
| M282 | Phase 7 — World Intelligence | **W** | Fully built against an owner-supplied specification (`docs/map/scope-ruling-phases-6-7.md` AMENDMENT, `docs/map/phase-7-world-intelligence.md`): four kinds on both mirrors (`lib/mapObjects.ts:105#"world_pulse",` … `artifacts/api-server/src/lib/mapObjects.ts:108#"personal_city",`; range repointed 2026-09-14 from lines 63-90, which is the comment above the array), four producers (`lib/mapProducers/worldPulseProducer.ts`, `travelerFlowProducer.ts`, `cityModelProducer.ts`, `personalCityProducer.ts`), two client layers (`src/features/map/layers/layerModel.ts:104#'relevant_places',` … `travel-buddy-standalone/src/features/map/layers/layerModel.ts:106#'my_cities',`). Behind `map_world_intelligence_enabled`, **seeded OFF** (`` `migrations/2295_map_world_intelligence_flag.sql:77#'map_world_intelligence_enabled',` `` with `:78#false,`; repointed from line 79, the description string), and downstream of the empty gateway regardless. **Turns red when:** the flag row is TRUE in production *and* M133's gateway is serving, and a projection response carries a `world_pulse`/`traveler_flow`/`city_model` object. Two acts, both the integration owner's. §41.5 records that this row is graded W for a shape `census-media` grades C, and that the convention question is a corpus decision no lane may take. |

### §37 Explicit Non-Goals (9)

A prohibition is BUILT-AND-CORRECT only when a concrete artifact makes the
violation unrepresentable or refuses it. All nine clear that bar.

| id | Non-goal | V | Evidence |
| --- | --- | --- | --- |
| M283 | No generic Google Maps clone | C | `src/constants/mapStyle.ts:141-145` — no POI layer of any kind; the whole label budget is four symbol layers. |
| M284 | No public real-time people tracker | C | `lib/locateFriendsSession.ts:4,105` — *"§37 names two things this feature is one careless decision away from becoming"*; there is no `public` member and no public read path (`migrations/2219:310`). |
| M285 | No permanent exact-location sharing | C | `longPress.ts:323` `SHARE_MAX_TTL_MS = 1 h`; `presenceLadder.ts:529-565` the four-stage decay; `2219:118` the 12-hour CHECK; `locateFriendsSession.ts:874,943` names the exact failure mode it is preventing. |
| M286 | Not a place-rating directory | C | `lib/mapObjects.ts:363-400` — `MapObject` has **no rating axis at all**; §7's four axes are activity, trend, confidence and freshness. |
| M287 | No screen full of unranked POI pins | C | `lib/mapProjection.ts:1217#rankObjects`; `collision.ts:634#resolveCollisions`; `lib/mapAggregation.ts:219#AGGREGATING_BANDS` — only `world` and `city` aggregate, so wide bands collapse to cells. *(`rankObjects` and `resolveCollisions` repointed 2026-09-14.)* |
| M288 | Compass must not invent live conditions | C | `compassMapModel.ts:8,191`; `lib/mapProjection.ts:675#Never upgrades` — *"if the claims are empty the object is returned untouched"* — enforced in `lib/mapProjection.ts:696#applyLiveClaims`. *(Repointed 2026-09-14 from line 667.)* |
| M289 | Predictions must not look like observations | C | `lib/mapObjects.ts:112` `FORECAST_KINDS` + `isForecastKind`; `timeMachine.ts:30-39` the discriminated union; `zoneStyle.ts:22-25,183` dashed **and** dimmed; `lib/mapProjectPlace.ts:202` cites §37 twice. |
| M290 | Paid businesses must not buy factual confidence | C | `lib/mapProjection.ts:518` `sourceCountBucket` nullable and load-bearing; `lib/mapObjects.ts:199-217` publishes the source **class** as a value so a renderer never has to regex English to learn a claim was sponsored; `routes/mapObservations.ts:70` rewards and observations do not join. |
| M291 | Stale claims must not remain visually live | C | `lib/mapObjects.ts:124-127` `mayRenderAsLive` admits only `live`/`recent`; `:158-172` expiry beats the age bucket and a future clock earns `unknown`, not the strongest label; `mapCache.ts:11-26` downgrades cached freshness on the way out; `crowdFlowProducer.ts:507` and `mapAggregation.ts:464,1164` cite the same line. |

### §38 Developer North-Star Scenario (1)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M292 | The 10:47 PM scenario is walkable end to end: busier area, cooling area, event starting, aggregate social opportunity, directional movement, a Compass Pick, an explanation, Go There, routing, arrival, one-tap crowd prompt re-entering the pipeline | **?** | Every component exists and is cited above, and the arrival prompt is real (`src/features/map/arrival/arrivalPromptModel.ts`, commit `35305f6c` *"§38 arrival one-tap prompt"*). But walking it requires a running app, a device, live location and populated intelligence — and three of its six map objects (crowd flow, live zone, prediction) cannot be produced in production today. **The walkthrough, named:** an EAS `preview` build on a mid-tier Android handset with location services on, pointed at a seeded `portava-ci` (curated `geo_zones`, `protected_zones`, `intel_*` snapshots and `map_projection_enabled` TRUE) — NOT production, which cannot produce three of the six objects — with the §35 telemetry transport captured, and the pass condition being ONE `decisionId` appearing across `compass_requested → compass_option_selected → recommendation_accepted → route_started → contribution_submitted` in the captured stream. That is the only reading that distinguishes "every component exists" from "the scenario walks", and the id is already threaded for exactly this purpose (`src/features/map/telemetry/mapTelemetry.ts:25#decisionId`). **Who can supply it:** whoever can seed `portava-ci` and run a build on hardware. **Not folded into either side.** |

### §39 Final Architecture Rule (1)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M293 | Every object must answer at least one of the seven questions | C | `lib/mapObjects.ts:420-434` `isServable` — the last gate before serialization, whose header cites §39 verbatim. Enforcement is **by kind vocabulary**: the predicate rejects an unknown `kind`, and every member of `MAP_OBJECT_KINDS` answers at least one question by construction (`:91-110`, each documented). It also rejects empty titles, unusable geometry and `privacyClass:'none'`. This is a proxy for the seven questions rather than a per-object test of them — a narrower guarantee than §39's wording, but a real and enforced one. |

---

## 5. What could not be verified (5), and why

Five, all genuine, none folded into either side:

| id | Requirement | Why it cannot be settled by reading this tree |
| --- | --- | --- |
| M254 | Initial usable map < 2 s | 10 cold starts, navigation-commit to first fully-rendered MapLibre frame, mid-tier Android on an EAS `preview` build over a 1.6 Mbit/300 ms link; cache and no-cache reported separately. No timing budget, benchmark or CI perf gate exists anywhere under `src/features/map/` or `artifacts/api-server/src/test/`. |
| M255 | Pan at ~60 fps | p99 frame time ≤ 16.7 ms over a scripted 3 s pan, `dumpsys gfxinfo framestats`, **with the zone/flow layers populated** — against a seeded `portava-ci`, since production's map is empty and would measure nothing. |
| M256 | Viewport intelligence in ~500-800 ms | Two halves. Server p50/p95 for `GET /api/map/projection` over 50 warm requests on `portava-ci` — needs no device and is blocked only by the absence of a harness. Device camera-settle-to-first-paint — blocked behind M133. |
| M258 | GPU-friendly animation layers | Overdraw and real frame cost under the Android GPU profiler. The device-free half — repaint cadence, source-identity stability and GPU-side interpolation on the pulsing path — **is now asserted** by `ActivityZone.gpuFriendly.component.test.tsx`; the row stays `?` because that test measures neither overdraw nor frame time. |
| M292 | §38's north-star scenario end to end | A device walkthrough against a seeded `portava-ci`, passing only if ONE `decisionId` spans `compass_requested → … → contribution_submitted` in the captured telemetry stream. Three of its six map objects cannot be produced in production today, so production is the wrong target for the run. |

I deliberately did **not** put the flag-dark and missing-table findings in this
bucket. They are not unverifiable — the flag seeds and the drift ratchet are in
the tree, and I traced both branches of the code by reading it. They are
BUILT-BUT-WRONG, which is a verdict, not an absence of one.

---

## 6. Six deployment facts that decide whether any of this runs

Construction verdicts are not deployment verdicts. In descending order of
consequence:

1. **`protected_zones` is absent from production, and it is a hard dependency of
   the gateway, not an optional one.** Both `/api/map/projection` and
   `/api/map/projection/temporal` answer the empty envelope when it cannot be
   read (`routes/mapProjection.ts:964-979`, `routes/mapProjectionTemporal.ts:574-591`).
   This is the correct fail-closed direction and it means §19 has never served
   an object in production.
2. **Flipping `map_projection_enabled` on today would blank the map, not fill
   it.** The client's all-or-nothing fallback (`src/hooks/useMapEntities.ts:55-67,702-704`)
   treats `enabled: true` as an answer and correctly declines to re-fetch a
   layer the gateway declined — because some legacy transports are fail-OPEN
   where the gateway is fail-CLOSED. Apply 2217 before touching 2201.
3. **`map_telemetry_events` and `map_telemetry_drops` are absent.** All sixteen
   §35 events emit into a void, behind a second flag that is also off. The Map
   currently cannot answer whether it produces real-world outcomes — the very
   question §35's closing line exists to force.
4. **All four `locate_friends_*` tables are absent.** §12 is among the most
   carefully engineered privacy code in the repository — 12-hour CHECK bounds,
   consent columns that are `NOT NULL`, a primary key chosen so a movement
   history is unstorable — and none of it is deployed.
5. **`route_flow_contribution_consent` is absent**, so §10 has one signal family
   in production and its own `MIN_SIGNAL_FAMILIES` gate permanently refuses.
   Crowd Flow is correct, complete and structurally unable to emit.
6. **Every `intel_*` table in production holds zero rows with its gates open**
   (`docs/architecture/intel-spine-liveness.md`). §21's seven stages and §22's
   eleven requirements are code that would run. They have not run.

---

## 7. Open PRs that would change a verdict

Verdicts above are for **main**. Three open PRs touch the map:

| PR | What it does | Verdicts it moves |
| --- | --- | --- |
| **#451** — memory projector PLACE lane | Repoints `project_user_memory`'s PLACE lane off the writerless `saved_places` onto the `wishlist_places` ∪ `discovery_place_saves` union — the same union PR #446 already proved for the Map `saved` layer. Its message states the ordering constraint: pressing `memory_projection` before the migration yields the `{refusal: null, collected: 0}` signature that hid the defect. | **M42** (gold marker = Saved/**Memory**) and **M123** (§16 Memories layer) both W → C. Net +2 CORRECT. |
| **#462** — failed vs empty map reads | Three gateway layers (`travelers`, `gems`, `events`) caught a read failure to `[]` and then pushed their own name into `sources` anyway, so a viewer whose location table returned 42501 was told the layer had been read and the city was empty. `lib/mapTravelers.loadCandidates` manufactured the lie inside the reader and **cached the empty for 20 s under a viewport key shared by every viewer**. | Does not flip a bucket — M137 stays C, because the fail-closed block-set decision is separate. It removes a real correctness defect inside a requirement I scored C, which is worth saying plainly: **M137's citation is sound and its neighbourhood is not.** |
| **#393** — Phase 6 journey intelligence | Along My Way corridor, plus a fix moving the corridor **after** the §24 gate. The commit documents two proven privacy defects in the earlier ordering: the corridor computed detours from the real centroid of a place §24 had just coarsened (two non-parallel requests trilaterate it to ~1 m), and it reported `corridor {kept: 1}` for an object `protection {suppressed: 1}` had refused to serve — a position oracle rendered verbatim as "1 on your way". | **M281** (Phase 6) N → C-or-W. Also relevant to M179: the fixed order is `servableOnly → filterKinds → live enrichment → withholdCoarsenableAggregates → applyProtection → aggregateForViewport → corridor → rankObjects → paginate`. |

---

## 8. Reading the numbers honestly

**96.6 % constructed, 80.2 % correct, 76.5 % spec-attributable.** Three things a
reader should take from that spread:

1. **The 16-point gap between constructed and correct is not noise — it is the
   production story.** Of the 48 BUILT-BUT-WRONG verdicts, **31 are a table that
   is not in production** (17 telemetry, 9 locate-friends, 1 protected-zone
   suppression, 2 crowd-flow families, plus the two gateway rules those absences
   put out of force). Apply migrations 2202, 2217, 2219 and 2224 to production
   and the correct column moves to roughly **94 %** without a line of new code.
   That is an unusual position to be in and it deserves to be said as plainly as
   the gaps do.
2. **The genuinely unbuilt surface is small and honestly declared.** Five
   NOT-BUILT: two §12 rungs that need a radio the stack does not have
   (`presenceLadder.ts:189-201` says so in as many words), the `transport` layer
   with no kind behind it, §17's venue band with nothing venue-shaped to draw,
   and Phase 6 — which a dated in-repo ruling declined to invent from a two-word
   mention. Four of the five are documented refusals rather than oversights.
3. **This spec is the one that built itself.** Where the Sensing and Wall
   censuses found implementations that satisfied their specs by coincidence —
   0.0 % attributable, twice — this one finds 88 files, 8 migrations and 30+
   commits that name it by section number. The question the brief asked me to
   test rather than assume has a different answer here, and the difference is
   not marginal.

---

## 9. Addendum (2026-09-08) — the trip projection now has a reader

Section 7's table lists PRs that would move a verdict. This addendum records a
change on the branch itself, in the same spirit: **what it moves, and what it
does not.**

### What was there

Migration `2520_trip_map_projection_worker.sql` and `lib/mapTripProjectionWorker.ts`
built the Trips-spec §19.4 projection worker — `trip_outbox` drained into
`trip_map_projections` in `aggregate_version` order, idempotent by `event_id`,
with a rebuild path and an atomic publish. It is correct, and it had **no
reader**. `routes/mapProjection.ts` still derived the `trip_stop` layer from
canonical `trips` at request time, so the projection closed **zero** census
rows. 2520's own header said the reader decision was "NOT taken here".

### What is there now

    Trip Kernel event → trip_outbox → trip_map_projection_drain (2520)
      → trip_map_projections (+ the 2610 Map anchor)
      → lib/mapProjectionTripRead → routes/mapProjection.ts
      → GET /api/map/projection → mobile Map

`lib/mapProjectionTripContract.ts` defines the **Map-owned** half of the
contract — ten fields, exactly what `lib/mapProjection.projectTrip` reads, and
deliberately far narrower than `AuthorizedTripView`. `lib/mapProjectionTripRead.ts`
is the reader. Both branches end in the same `projectTrip`, so the served
object cannot drift between them.

### The field 2520 could not supply

2520's `body` is coordinate-free by design (§5.3, §14.4) and carries only
`has_destination_coordinates`. `projectTrip` returns null without
`destinationLat`/`destinationLng`, so the projection was unusable as a map
source on its own. Migration `2610_map_trip_projection_anchor.sql` adds a
**Map-owned anchor** — `destination_lat`, `destination_lng`,
`map_contract_version` as real columns on the Map-owned projection table,
filled by a trigger on the same write the drain already makes. `body` is
untouched. Real columns rather than jsonb keys because **a capability probe
cannot look inside a jsonb value**, and the probe is what makes the gate work.

### Why it is a capability, not a flag (measured 2026-09-07)

| database | 2334/2337/2420 | 2520 | `trip_map_projections` | canonical trips |
| --- | --- | --- | --- | --- |
| production `ajrurzioarfkagpuxfnb` | **not applied** | not applied | absent | **43 rows, live** |
| portava-ci `hwokxgbmezheskbzskfr` | applied | **not applied** | absent | — |

On both, the projection is not merely empty — the table does not exist. A bare
flag would answer "on", the layer would read nothing, and on a map that is
indistinguishable from "you have no trips": 43 real production trips would
vanish the moment an operator flipped a switch. So the gate is the existing
`lib/capability` contract, `FLAG_ENABLED && SCHEMA_CAPABILITY_READY`,
fail-closed on `missing` **and** on `unknown`, with the canonical path as the
not-ready branch. Which branch ran is on the wire: `trips.path` in the body and
the `X-Map-Trip-Source` response header.

### What this does NOT move

No census verdict changes. The `trip_stop` layer already existed and was
already CORRECT; this replaces the *source* behind it under a gate that is OFF
everywhere, and the not-ready branch is byte-identical to what shipped. The
verdict that would move is a future one about §19.4 projection lag, and it
cannot be scored until `2520` and `2610` are applied and both flags
(`trip_map_projection_worker_enabled`, then `map_trip_projection_read_enabled`)
are on — **in that order**, or the reader serves a stale or empty layer.

## 10. Addendum (2026-09-12) — the crew's permitted temporary precise position reaches the Trip Map

Section 4 graded M76 (Crew) C on the reading that `source.crew` stays empty
"because it would require coordinates the §23 rung did not grant", and M175
C on the projection's ceiling. census-trips §58 (TR166, TR281) changed the
input those rows were read against, in `travel-buddy-standalone`; this
addendum re-reads the two rows. **No verdict moves; two evidence lines are
restated.**

### What was there

`tripMapSources.ts` said in its header that the server "declined precision
here" and left `source.crew` empty. It never had: the crew map has issued
`exactCoords` on a card under an active live-share grant since Trips §40.6,
and this client's `CrewMemberCard` type did not carry the field, so the
coordinate was dropped at the type. `crewAreas` — the coarse labels — was
right, and stays.

### What is there now

`travel-buddy-standalone/src/features/trips/map/tripMapSources.ts:133#export function composeCrewPositions(`
takes a pin only from a card that is not hidden, whose live share to THIS
viewer is active, that carries finite `exactCoords`, and whose
`freshnessClass` is LIVE / RECENT — the server's verdict, checked again — and
gives it `precise_temporary`, §23's "permitted temporary precise", which
`tripToMapObjects` can only tighten. The friend / crew marker
(`travel-buddy-standalone/src/components/map/EntityMarkers.tsx:331#function pinFreshnessTreatment(`)
now exposes the object's freshness in its ring (solid live, recent, dimmed
and dashed for stale / unknown) and in an accessibility label its
`Pressable` never had, in the §7 freshness column's own words.

### What this moves, and what it does not

| row | was | now | why |
| --- | --- | --- | --- |
| M76 Crew | C | **C** | Evidence restated: crew is coarse area labels for everyone shown, and a `precise_temporary` pin only where the owning system issued a permitted coordinate over a current position. Nothing is invented from a label; the §23 rung is what the pin carries. |
| M175 Trip Crew → approximate, or permitted temporary precise | C | **C** | Unchanged: the ceiling still narrows and never widens; a trip crew pin arrives at the rung the row names. |

M33 (the Place marker) and M213 (the components) are untouched by the
marker change. `head_commit` stays `42aeac38`: this addendum restates two
rows' evidence, it does not re-measure the census. The staleness ledger
names the four files against this section.

---

## §40 — 2026-09-13: the BUILT-BUT-WRONG bucket, grouped and counted

This census's gap between CONSTRUCTED and CORRECT **is** its W column:
48 / 293 = 16.4 points. Nobody had ever asked *why* those 48 were W, so the
first thing this pass did was sort them into four causes and count each. The
answer decides what a lane can do here, and it is not what the headline
suggests.

| why a row is W | rows | what would close it |
| --- | --- | --- |
| **(c) capped by a flag, an unapplied migration, or an empty table** | **41** | applying a migration / seeding a flag / an ops backfill — **not code** |
| **(a) logic wrong in code** | **3** | a code change (one of the three is a SQL projector) |
| **(b) logic right, nothing reaches it** | **2** | wiring — both built this pass |
| **(d) needs something nobody has written** | **2** | a capture path or a data source that does not exist |

**Eighty-five per cent of this census's correctness gap is a deployment gap,
not a code gap.** 41 of 48 rows are code that is written, reviewed, tested and
unreachable in production because a table is absent, a flag row does not exist,
or a curated dataset was never loaded. A lane with production READ-ONLY cannot
move any of them, and moving them by re-labelling would be a lie. The honest
statement of this census is: *the map is built; the map is not deployed.*

### (c) the 41 — grouped by the single thing blocking each

| blocker | rows |
| --- | --- |
| `map_telemetry` table + `map_telemetry_enabled` (migration 2202, unapplied) | M259–M274, M275 — **17** |
| the four `locate_friends_*` tables (migration 2219, unapplied) | M7, M83, M85, M86, M87, M90, M91, M92, M93, M94 — **10** |
| `map_projection_enabled` (2201) — and `protected_zones` (2217) before it | M10, M133, M139, M179 — **4** |
| Crowd Flow: `geo_zones` holds 0 rows (an **ops** action), plus 2218/2224 | M5, M119, M279 — **3** |
| `route_flow_contribution_consent` absent | M67 — **1** |
| `map_world_intelligence_enabled` seeded OFF (2295) | M282 — **1** |
| downstream of the above, with no blocker of their own | M123, M221, M222, M223, M278, M280 — **6** |

The order in which those blockers must be lifted is already written in this
document's CORRECTION HEADER, and it is not the obvious one: **2217 first**, or
flipping the gateway blanks the map.

### (a) the 3, and why only one arm of one of them was touched

| row | the defect | what happened here |
| --- | --- | --- |
| M42 | the Memory arm reads `memory_projections` filtered to `subject_type='place'`, and migration 2191's PLACE lane projects from the writerless `saved_places` | **Not built.** This census already records that **PR #451 fixes exactly this**. Writing the same migration again would hand the integrator a conflict in the one file both touch, for no earlier landing. |
| M123 | the Memories layer is correct and its only producer is dead upstream | **Not built** — it is M42 wearing a layer name. |
| M43 | the legend draws a `blue_dot` glyph for "Current user" and `DiscoveryMapView` renders no user marker at all; `app/map/index.tsx` reads `userLat`/`userLng` only to move the camera | **Not built.** The claim was re-executed and is still true. The fix is a render, and the only execution available to this lane is a source scan — see "the least flattering thing" below. |

### (d) the 2

**M65** names five of seven §10 signal families with no capture anywhere;
`crowdFlowProducer`'s own `DECLARED_BUT_UNFED_FAMILIES` and
`UNFED_FAMILY_BLOCKERS` say, per family, what must exist first. **M129** needs
an `entrance` kind in `MAP_OBJECT_KINDS`, a producer for it, and a source of
entrance geometry; the repo has none of the three. Neither is a defect to fix;
both are work to commission.

### Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| M201 `Saved items` | W | **C** | §27's ninth heading now has a producer: a `saved` SearchType and a `searchSaved` lane over `wishlist_places` + `discovery_place_saves`, the adapter's `saved` key promoted from tolerated alias to wire vocabulary, `savedKind` read from the wire, and the map's own search sheet asking for it. 15 server cases + 4 client cases; three mutations red. |
| M226 `Overlay FILTERS` | W | **C** | The declared overlay is entered: both filters affordances dispatch `OPEN_OVERLAY FILTERS` and the sheet reads `overlayOpen('FILTERS')`. The bypassing `useState` is deleted, so D1 mutual exclusion and `resolveBack` govern the sheet for the first time. 12 cases; two mutations red. |

### An owner decision this pass surfaced and did NOT take

`saved` is deliberately **absent from the server's `type=all` fan-out**
(`` `artifacts/api-server/src/routes/discoverySearch.ts:2421#// 17 of the 18 non-"all" types run in parallel at FAN_LIMIT items each.` ``).
It is the only viewer-scoped search type — a person's own saves, not a public
corpus — and that fan-out feeds the app's ONE global search as well as the
map's. Folding a private, always-matching bucket into "All" would change what
Discovery and the global search screen show, and what census-discovery and
census-input-intelligence measure, as a side effect of lighting a Map heading.
So the map asks for it explicitly alongside `all`, and **whether "All" should
include your saves is left to the owner.**

### What this pass did NOT do, stated so the next one does not re-derive it

- It did not move any (c) row. Production is read-only here; no migration was
  applied and no flag flipped.
- It did not write the M42 migration, because PR #451 is that migration.
- It did not build M43, M65 or M129.
- `head_commit` stays `42aeac38`. Two rows were re-read and re-executed; the
  other 291 were not. The staleness ledger names the files this section
  changed.

### Separately, and NOT a correctness fix: four rows became countable

`check:census-integrity` reported this census as *"4 counted where this tool
cannot read"*, a phrase that means PROSE. It was not prose. M47, M169, M176 and
M177 are ordinary table rows whose verdict cell reads `C *(not
spec-attributable)*`, and the tokeniser accepted `⌀` as a qualifier but not a
parenthesised one — so it reported C 231 against a document stating 235, and
the discrepancy hid inside an unreconciled-prose number. The tokeniser reads it
now
(`` `artifacts/api-server/src/scripts/checkCensusIntegrity.ts:212#function verdictOf(cell: string)` ``,
executed by
`` `artifacts/api-server/src/test/censusIntegrityQualifiedVerdicts.test.ts:65#describe("the tool reads census-map's qualified verdicts"` ``).

**This built nothing and closed no gap.** It moved the *recount* from
95.2 % / 78.8 % to 96.6 % / 80.2 % — to the numbers this document had always
stated — and the distance between them, which is the only figure that measures
correctness, did not move by a thousandth: it was 48/293 before and 48/293
after. Anyone quoting the recount's improvement as progress is quoting a parser
fix.

## §41 — 2026-09-13: the 85 % re-measured from the production table list, and the row it double-counted

Measured at `d9ab209d7`. `head_commit` stays `42aeac38`; §1–§40 stand as written.
**No verdict moved in either direction.** This section exists because §40's
central number was taken on trust by a later pass, and a number that decides
whether a lane works here should be re-derived rather than quoted.

### §41.1 The claim, and what re-measuring it gives

§40: *"Eighty-five per cent of this census's correctness gap is a deployment
gap, not a code gap"* — 41 of 48.

Re-derived without reading §40's tables: every `M<n>` row in this document was
parsed, last-statement-wins, and each W row's stated blocker was opened. The
extraction agrees with `check:census-integrity` exactly — **46 W**, not 48; §40
moved M201 and M226 out of the W column in the same section that stated 48.

| my classification | rows | share of the 46 |
| --- | --- | --- |
| capped by an absent table, an absent/false flag row, or an empty curated table | **41** | **89.1 %** |
| logic wrong in code | 3 — M42, M123, M43 | 6.5 % |
| needs something nobody has written | 2 — M65, M129 | 4.3 % |

> **The claim is CORRECT and now understates itself.** 41/48 = 85.4 % against
> §40's denominator; 41/46 = **89.1 %** against the W column as it actually
> stands. Both figures rest on the same 41 rows. **The map is built; the map is
> not deployed** remains the honest statement of this census, and a lane with
> production read-only cannot move any of the 41.

### §41.2 The deploy step each capped row waits on, named

Verified against the committed production table list
(`artifacts/api-server/baseline/20260907_production_tables.txt` — 431 tables,
measured 2026-09-07). Of the nine objects below, **exactly one is present**.

| rows | the object that is missing | present in production? | the deploy step |
| --- | --- | --- | --- |
| M259–M274, M275 — **17** | `map_telemetry_events` + `map_telemetry_drops` (`` `artifacts/api-server/src/migrations/2202_map_telemetry.sql:45#CREATE TABLE IF NOT EXISTS public.map_telemetry_events (` ``) and the flag row `` `artifacts/api-server/src/migrations/2202_map_telemetry.sql:176#('map_telemetry_enabled', FALSE,` `` | **no** (both tables absent) | apply 2202, then flip `map_telemetry_enabled` — the flag ROW does not exist either, because 2202 creates it |
| M7, M83, M85, M86, M87, M90, M91, M92, M93, M94 — **10** | the four `locate_friends_*` tables (`` `artifacts/api-server/src/migrations/2219_locate_friends_sessions.sql:74#CREATE TABLE IF NOT EXISTS public.locate_friends_sessions (` ``) | **no** (all four absent) | apply 2219 |
| M10, M133, M139, M179 — **4** | `protected_zones` (`` `artifacts/api-server/src/migrations/2217_protected_locations.sql:60#CREATE TABLE IF NOT EXISTS public.protected_zones (` ``) and the flag row `` `artifacts/api-server/src/migrations/2201_map_projection_flag.sql:17#('map_projection_enabled', FALSE,` `` | **no** (table absent) | **2217 FIRST**, then 2201 — the order in this document's CORRECTION HEADER, and flipping the gateway first blanks the map |
| M5, M119, M279 — **3** | `geo_zones` holds 0 rows; plus 2218 / 2224 | **the table IS present** — the only one of the nine | an **ops backfill** of the curated zone set, not a migration |
| M67 — **1** | `route_flow_contribution_consent` (`` `artifacts/api-server/src/lib/routeHopSignal.ts:115#export const ROUTE_FLOW_CONSENT_TABLE = "route_flow_contribution_consent";` ``) | **no** | apply 2224; the producer requires ≥2 signal families and has exactly one without it |
| M282 — **1** | the flag row `` `artifacts/api-server/src/migrations/2295_map_world_intelligence_flag.sql:77#'map_world_intelligence_enabled',` ``, seeded OFF | n/a — a flag, not a table | flip one flag row |
| M221, M222, M223, M278, M280 — **5** | nothing of their own | — | they fall out when M5 / M7 / M10 / M83–M94 are lifted |

**17 + 10 + 4 + 3 + 1 + 1 + 5 = 41.**

### §41.3 The row §40's own tables count twice

§40's summary table says **(c) = 41** and its blocker table enumerates **42
ids** — because **M123 appears in both** the (c) "downstream of the above" list
and the (a) table, where §40 itself writes *"it is M42 wearing a layer name."*

Resolved here in favour of **(a)**, and the reason is not bookkeeping: M123's
blocker is a code defect — `` `artifacts/api-server/src/migrations/2191_memory_projector_content_and_support.sql:179#FROM public.saved_places s` `` projects the PLACE lane from a writerless
table — and `saved_places` **is** in the production table list. Nothing about
M123 waits on a deployment. So the group sizes are (c) 41, (a) 3, (d) 2 = 46,
and the enumerated list under (c) is the thing that was wrong, not the 41.

### §41.4 M42 / M123 / M43 re-read — and still not built here

- **M42 and M123.** §40 declined to write the migration because PR #451 is that
  migration. Re-executed: the defect is real at HEAD (the line cited above), and
  a second migration redefining `project_user_memory` would hand the integrator
  a conflict for no earlier landing. **The argument holds. Not built.**
- **M43.** Re-executed and still true: the legend draws a `blue_dot` for
  "Current user" and no canvas renders one. It is a React Native marker render
  with no pure surface to drive, so the only assertion available is a source
  scan — which is what §40 said, and saying it twice does not make it a build.
  **Not built.**

### §41.5 A cross-census inconsistency this section can only report

**M282 is graded W here for exactly the shape census-media grades C.** Its own
evidence says *"fully built … four kinds on both mirrors, four producers, two
client layers. Behind `map_world_intelligence_enabled`, seeded OFF."* That is
complete-behind-a-dark-flag. `census-media.md` §11.3.3 keeps MD375 and MD379 at
**C** on the identical reasoning — their only emitter is dark — and
`census-media.md` §12.8 enumerates fourteen media rows that turn on it.

So the open convention question (`census-media` §9.10, restated in §12.8) is a
**corpus** question and the two censuses currently answer it differently. Under
media's convention M282 is C and this census's CORRECT% rises by one row; under
the alternative, fourteen media rows fall to W. **Not taken here, and not takeable
by a lane** — it is one rule for thirteen documents.

### §41.6 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| M123 | W | **W** | Verdict unchanged, GROUP corrected. §40 lists it under both (c) "downstream" and (a); its blocker is M42's writerless-`saved_places` projection, which is code, and `saved_places` is present in production. It belongs to (a) alone, which is what makes §40's (c) enumeration 42 ids under a table saying 41. §41.3. |

Nothing else moved. **No row was built, no migration applied, no flag flipped.**
This section's product is a re-derived number and a corrected partition, and it
closed no gap: the distance between CONSTRUCTED and CORRECT was 46/293 before it
and 46/293 after.

### §41.7 What this section could NOT check

The eight absent objects are absent from a **table list measured 2026-09-07**.
That list is the strongest artifact in the tree for this question and it is six
days old at the time of writing, it names tables and not columns or flag rows,
and nothing in this repository re-measures it. `map_projection_enabled` and
`map_world_intelligence_enabled` are flag ROWS, so their production state is not
visible in a table list at all — both are recorded here on their migration seed
and on the same ledger §40 used, which is one source and not two.

---

## §42 — Evidence pass, 2026-09-14 (the Map lane)

**Nothing moved. No row was closed, no verdict changed, no migration written, no
flag flipped.** What this pass produced is the thing §41 said the corpus was
missing: evidence that can be re-checked. Every one of the 56 W / N / ? rows was
re-opened at this tree, every citation those rows rest on was read, and every row
now says what would settle it and who can supply that.

Read §41.1 first: 41 of the 46 W rows are capped by a deployment this lane cannot
perform, and re-reading them does not change that. This section is about the
other half of a verdict — whether the evidence under it is true.

### §42.1 Seventeen citations were pointing at the wrong line, and three at the wrong file

This census carries the worst-anchored evidence in the corpus: at the start of
this pass, 24 of 395 citations carried an anchor. `check:doc-citations` says of
the rest that *"nothing here can tell you it names the right code"*, and that is
not a theoretical limit here. Opening all of them found:

| row(s) | file | cited line | really at | the shape of the error |
| --- | --- | --- | --- | --- |
| M220–M223 | features/map/vocabulary | 49 / 50 / 51 / 52 | 48 / 49 / 50 / 51 | **the whole `MAP_MODES` block was cited one line low** — including M220, a **C** row, whose line 49 is `'CROWD_FLOW'` |
| M119 | features/map/layers/layerModel | 72 | 75 | three entries early in the same array literal (`'trip'`) |
| M5 | stores/mapStore | 98 | 100 | the §11 TRIP comment two lines above the gate |
| M10 | stores/mapStore | 105-107 | 108 | the comment above the assignment |
| M85 | features/map/presence/locateFriends | 139-190 | 146 | a comment block above the constant |
| M88, M89 | features/map/presence/presenceLadder | 189-201 | 192 | as above |
| M122 | features/map/layers/layerModel | 470-485, 491-494 | 463, 492 | range starts mid-record |
| M129 | lib/mapObjects | 91-110 | 90-109 | off by one at both ends |
| M139 | test/gatewayBypassGuard.test | 28-33 | 32 | the doc comment above `READERS` |
| M179 | lib/protectedLocations | 849 | 860 | a field inside an interface, not `applyProtection` |
| M179 | scripts/checkProductionDrift | 110 | 157 | a Trips comment block, not the `protected_zones` entry |
| M179 | routes/mapProjection | 964-979 | 1024-1043 | the §19 ordering block, not the refusal envelope |
| M133 | hooks/useMapEntities | 702-704 | 700, 707 | **inside the gateway-success branch** — the path that row says is NOT taken |
| M282 | lib/mapObjects | 63-90 | 105-108 | the comment above the array |
| M282 | migrations/2295_map_world_intelligence_flag | 79 | 77-78 | the description string below the flag |
| §Headline | routes/mapProjection | 836 | 898 | 62 lines short of the `no_zone_model` refusal |
| M7, M83–M94 | scripts/checkProductionDrift | 176-179 | — | **wrong file.** Those lines are `wall_telemetry_events` / `passport_telemetry_events`, and that ratchet **does not track any `locate_friends_*` table at all**. The fact lives in the committed production table list, which names 431 tables and none of the four. |
| M67 | scripts/checkProductionDrift | 180-183 | 210 | as above; the consent table's entry is 30 lines down |

None of the seventeen moves a verdict — every one of the underlying claims is
still true at this tree, which is the good news and also the reason this class
survives: a wrong pointer under a right conclusion produces no symptom. What it
destroys is the ability of the next reader to check the conclusion.

**Every citation in all 56 rows is now anchored** (`path:line#needle`), so
`check:doc-citations` re-reads the line rather than measuring the file's length.
The corpus-wide unanchored count fell by 24 and `check:citation-targets` fell
from 275 to 265 — **which means its ceiling in the api-server's `check:citation-targets` script
should be lowered to 265, and that file belongs to the integration owner.**

### §42.2 The §35 emitter counts were re-measured, and one was wrong

M259–M274 each asserted an emitter count that nothing checks. All sixteen were
re-counted by reading every `emitMapEvent` call site in
`travel-buddy-standalone/src` and `travel-buddy-standalone/app` — 25 sites.
Fifteen counts were right. **M266 claimed three emitters for `route_started` and
there are two** (`src/components/map/MapEntityActionRow.tsx:579#emitMapEvent('route_started',`, `src/components/map/LivePlaceSheet.tsx:444#emitMapEvent('route_started',`); the
other four `route_started` occurrences are comments and the type declaration. The
rows now name every call site individually and anchored, so the next re-count is
a re-read rather than a re-derivation.

A caution recorded because this pass nearly shipped the opposite error: an
initial grep that searched the repository-root `app/` instead of
`travel-buddy-standalone/app/` reported **six** §35 events with zero emitters,
and the implementation of one of them was written and mutation-tested before the
search was found to be wrong. All six are emitted from `app/map/index.tsx`. The
work was reverted. A count is evidence for opening a file, never a substitute.

### §42.3 M263 — the one defect in this census that no deployment fixes

`why_shown_opened` fires, and its payload does not describe the panel that was
shown. `WhyShownOpenedPayload.lineCount` is *"how many provenance lines the §9
panel showed"*; the emitter sends `obj.provenance?.lines.length ?? 0` while
`WhyShownSheet` renders `buildWhyPanel(object)`, whose `buildWhyLines`
synthesises the panel's evidence whenever the server sent no `provenance.lines`.
Every synthesised panel therefore reports **0 lines shown** — and the synthesised
case is the common one. `provenanceRefs` diverges the other way: the emitter
sends `obj.sourceRefs`, the panel shows `model.lines[].ref`.

Built this pass: `src/features/map/telemetry/whyShownOpened.ts:49#whyShownOpenedPayload`,
derived from the same `buildWhyPanel` call the sheet renders, with
`src/features/map/telemetry/__tests__/whyShownOpened.test.ts` asserting agreement
against `buildWhyPanel` itself rather than against constants. Four mutations are
recorded in §42.7, including replacing the helper's body with the production
expression — which is the proof that the production expression is wrong.

**It is not wired, and the row stays W.** The emitter is in `app/map/index.tsx`,
outside the Map lane's paths. See §42.4.

### §42.3a M258 — the half of a CANNOT-VERIFY that was hiding behind the device

`ActivityZone`'s `useOpacityPulse` was written against §34 and says so: *"One
`setState` per half-period (≈1.2 s), paired with MapLibre's own
`*-opacity-transition`, hands the actual interpolation to the GPU… A JS-driven
60 fps pulse would re-render a paint object 60 times a second per zone on
screen."* Nothing asserted any of it. A later simplification to an `Animated`
value driving `line-opacity`, or a dropped `useMemo` around the feature, would
have been a per-zone frame-rate regression with no failing test and a row that
said the whole subject needed a handset.

`src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx` now
pins the cadence, the source-identity stability and the GPU-side transition,
mutation-proven five ways (§42.7). **M258 stays `?`**: overdraw and frame cost are still
a device measurement and this test makes no claim about either. The row is the
same verdict with one fewer way to rot.

### §42.3b M256 — the same shape again: a device-free half nobody had written

M256 reads *"viewport intelligence first results within ~500-800 ms **when
cached/server-ready**"*, and §42.5 recorded that its server-side half was still
nobody's. It is written now, for the same reason §42.3a was: the millisecond
budget needs a device and a warm database, but the property the budget RESTS on
does not.

`routes/mapProjection.ts` carries three module-level read-through caches with
30 s TTLs — `protected_zones` at `routes/mapProjection.ts:228#_zoneCache`, flow
`geo_zones` at `routes/mapProjection.ts:282#_flowZoneCache`, and Phase 7's city
model at `routes/mapProjection.ts:317#_cityZoneCache`. Each exports a
`_clear*Cache()` hook, and **eleven map test files import one.** Every single one
uses the hook to DEFEAT the cache so fixtures cannot leak between cases. Not one
asserted that a cache hit avoids the read. The only thing this corpus pinned
about the "cached" in M256's precondition was that the cache can be switched off.

Three cases were added to `src/test/geoZoneSeed.test.ts` — which already drives
the real `/map/projection` route against a fake client, so this is three cases
and a read counter, not a new harness:

1. a second poll inside the TTL re-reads **neither** `geo_zones` nor
   `protected_zones`, and returns the same zone model rather than a cheaper
   emptier one;
2. after `_clearFlowZoneCache()` the next poll **does** read again — without
   this, case 1 is also satisfied by a route that stopped reading altogether;
3. a FAILED read is **not** cached, so a transient database error cannot darken
   Crowd Flow for a full TTL.

**Two things were learned by being wrong.** Case 3 was written expecting an
unreadable `geo_zones` to refuse with `no_zone_model`; the route answers
`zone_read_failed` and keeps the two distinct — an unreadable zone table and an
empty one are different operator problems, and the refusal says which. That is
better than this pass assumed and is now pinned. And `loadProtectedZones` reads
`Date.now()` itself while `loadFlowZones` takes the handler's injected `nowMs`,
even though `routes/mapProjection.ts:486#ONE clock read` states the handler makes
exactly one clock read. The invariant is stated and not held. It is harmless
today — both are TTL comparisons — and it is not a Map-lane fix to smuggle into
an evidence pass, so it is recorded here and nowhere else.

**M256 stays `?`.** No milliseconds are claimed, no device is involved, and
nothing here says anything about a warm production cache. One falsifiable
sub-property closed; the row's own measurement still needs a running server.

### §42.4 Cross-lane requests this pass raises

1. **`app/map/index.tsx:2845#emitMapEvent('why_shown_opened',` → use `whyShownOpenedPayload`.** Replace the inline
   `lineCount` / `provenanceRefs` expressions with one call. One line. §42.3 is
   the argument and the test already exists. (Map-screen owner.)
2. **M43, the blue dot.** The canvas is `src/components/discovery/DiscoveryMapView.tsx`
   (Discovery lane). `EntityMapLayers` — the one map-owned renderer mounted
   inside it — renders only when `entities.length > 0`, so it is the wrong home
   for a marker that must draw on an empty map. The Map lane cannot build this.
3. **M42 / M123.** The memory projector's PLACE lane reads writerless
   `saved_places`. PR #451 is that migration; §40 declined to duplicate it and
   this pass agrees. (Highlights & Memories / integration owner.)
4. **The `check:citation-targets` ceiling, 275 → 265.** §42.1. (Integration owner.)
5. **`CENSUS_STALENESS_ACKNOWLEDGED.json` needs three new file names.** This pass
   adds three files inside census-map's counted scope, and
   `check:census-freshness` fails for this census the moment they are committed
   unless the acknowledgement entry names them:

   - `travel-buddy-standalone/src/features/map/telemetry/whyShownOpened.ts`
   - `travel-buddy-standalone/src/features/map/telemetry/__tests__/whyShownOpened.test.ts`
   - `travel-buddy-standalone/src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx`

   The reason, for the entry: all three are NEW and none changes an existing
   artifact. The first two are the M263 payload builder and its test, built and
   not wired (§42.3); the third is the M258 cadence guard (§42.3a). No verdict
   moves on any of them, and `head_commit` stays `42aeac38` — a new file in
   counted scope ages this census exactly as a changed one does, which is why it
   is declared rather than left to fire. That JSON belongs to the integration
   owner and this lane did not edit it.

   `check:census-freshness` confirms exactly this and nothing more: census-map
   is STALE on precisely those three names and no others. **A fourth is coming**
   — the resumed pass extended `src/test/geoZoneSeed.test.ts` for M256 (§42.3b),
   which is not in `CENSUS_SCOPE` today and so does not yet age this census. It
   should be, and then it will; see request 10.
6. **M122 / M129 / M130 need an owner ruling, not a build.** §18's `MapObjectKind`
   union is closed at thirteen and this repository has already ruled that a
   one-line mention is not a licence to invent an object contract
   (`docs/map/scope-ruling-phases-6-7.md:44#Building`). Transport, entrances and
   venue interiors each need that ruling plus a named data source before any lane
   should write a kind. Building them without it would be the scope creep the
   ruling names.

7. **The standalone `run-node-tests` script spawns `node --import tsx/esm
   --test`, and nothing runs under it.** Every standalone `node:test` file dies
   with `ERR_REQUIRE_CYCLE_MODULE` before a test executes; `--import tsx` runs
   them. Evidence and reproduction in §42.8.1. One word in one `spawnSync`
   argument list. This is not a Map-lane file and the Map lane did not edit it,
   but if it is really dark then every `node:test` assertion in the client —
   Map's included — is currently unexecuted in CI, which would make a large
   number of green-looking claims across several censuses unearned. Someone
   should confirm this against CI's actual logs before believing either me or
   the runner. (Standalone test-infra owner / integration owner.)
8. **`check:citation-symbols` MISPLACED ceiling, 60 → 44.** §42.9 removed all
   sixteen of census-map's entries and the script now prints
   *"44 < 60 — LOWER MAX_MISPLACED_SYMBOLS to 44."* `MAX_MISPLACED_SYMBOLS` lives
   in the `check-citation-symbols` guard, which is not this lane's.
   (Integration owner.)
9. **`check-citation-symbols` belongs in `NOT_GRADED`.** The scope-coverage
   guard's machinery list already carries `check-doc-citations` by name, with a
   comment saying it is *"the one machinery file in the tree that the convention
   already covers in spirit and missed in letter"* — it is no longer the one.
   `check-citation-symbols` sits beside it, same directory, same extension, same
   role, and is not on the list, so a census that names it as the thing that
   measured its citations pays for it in coverage. This pass hit exactly that and
   worked around it by not spelling the filename, which is the wrong fix made by
   the only lane that could not make the right one. (Integration owner —
   `checkCensusScopeCoverage.ts` is explicitly not a lane file.)
10. **`artifacts/api-server/src/test/geoZoneSeed.test.ts` belongs in census-map's
   `CENSUS_SCOPE`.** §42.3b put M256's evidence in that file, so this census now
   cites it — and because it is not watched, census-map's scope coverage fell to
   **exactly its 96% floor** (108 cited, 104 watched) and the file can change
   without aging this census. Both are wrong in the same direction: the test that
   carries a row's evidence is the archetype of a watched file. Adding it raises
   coverage and adds a fourth name to the staleness declaration in request 5.
   `CENSUS_SCOPE` lives in `checkCensusFreshness.ts`, which is explicitly not a
   lane file. (Integration owner.)

### §42.5 What this pass could not verify

- **Production state.** Every "absent from production" in this document still
  rests on one artifact, `baseline/20260907_production_tables.txt`, measured
  2026-09-07 and now a week old. This pass confirmed the four `locate_friends_*`
  tables, `protected_zones`, both `map_telemetry_*` tables and
  `route_flow_contribution_consent` are absent from that list, and that
  `geo_zones` and `saved_places` are present. It did not, and could not,
  re-measure the database. §41.7 stands unchanged.
- **`geo_zones` row count.** The CORRECTION HEADER's "0 rows" is an ops
  observation with no artifact in this tree. The empty-zone refusal path is real
  and now correctly cited (`routes/mapProjection.ts:919#no_zone_model`); whether
  it fires in production today is not checkable from here.
- **Flag rows.** `map_projection_enabled`, `map_telemetry_enabled` and
  `map_world_intelligence_enabled` are rows, not tables, so a table list cannot
  see them. Unchanged from §41.7 and restated because three rows in §42.1 now
  depend on it.
- **M254–M258, M292.** Still `?`. Each now names the measurement, the device and
  who can run it rather than saying "needs a device" — and M256 and M258 each
  turned out to have a half that needs **no** device and was simply unwritten,
  which was being hidden behind the device. M258's device-free half was written
  in the first half of this pass (§42.3a) and M256's in the resumed half
  (§42.3b). **M254, M255 and M292 have no device-free half** and are not
  pretending to: a first-paint budget, a pan frame rate and a walk-through of the
  10:47 PM scenario each need a handset, and no amount of static reading
  substitutes. Saying that plainly is the whole of what this pass can do for
  them.

### §42.7 The failing-first proof, re-established after the restart (2026-09-14)

The container restart took the agent that ran the original mutations, so the
evidence for both new tests existed only in a dead process. §42.3 and §42.3a are
claims about tests, and a claim about a test is worth exactly what its mutation
record is worth. Both were re-run from scratch at this tree. Every mutation below
was applied to the IMPLEMENTATION, never to the test, and every one was restored
and the file checksummed back to its committed bytes before the next was applied.
The third subject, `routes/mapProjection.ts`, belongs to §42.3b rather than to
the restart, and is recorded here with the other two so the whole failing-first
record for this pass sits in one place.

**Runner.** The client suites do not share the api-server's runner:

```
# the §35 payload test (node:test)
cd travel-buddy-standalone && node --import tsx --test \
  src/features/map/telemetry/__tests__/whyShownOpened.test.ts

# the §34 cadence test (jest, component)
cd travel-buddy-standalone && npx jest --forceExit --runTestsByPath \
  src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx
```

`--import tsx`, **not** `--import tsx/esm`, is load-bearing and is not a
preference — see §42.8.

#### M263 — `src/features/map/telemetry/whyShownOpened.ts`, four mutations

Baseline 4/4 pass.

| # | mutation applied to `whyShownOpened.ts` | result | the assertion that caught it |
| --- | --- | --- | --- |
| A1 | body replaced with the production expression: `lineCount: object.provenance?.lines.length ?? 0`, `provenanceRefs: object.sourceRefs ?? []` | **3 of 4 red** | *"synthesised provenance"* — **expected 5, actual 0.** The panel drew five lines and the shipped expression reports none. This is the defect, executed. |
| A2 | `provenanceRefs` always assigned, empty list included | **1 red** | *"omitted rather than empty"* — `hasOwnProperty` true where false was required |
| A3 | refs taken from `object.sourceRefs` instead of `panel.lines[].ref` | **2 red** | *"counts and refs are the panel's own"* — `'src:unused-by-the-panel'` appeared in the payload |
| A4 | `object.title` spread into the §35 `ref` | **1 red** | *"no title, no coordinate"* — `title: 'Cong Caphe'` in the diff |

A1 is the one that matters: it is not a synthetic defect but a verbatim copy of
what `app/map/index.tsx` sends today, and the test rejects it. The row still does
not move — the helper is not wired (§42.4.1) — but the claim that the shipped
emitter is wrong is now executable rather than argued.

#### M258 — `src/components/map/ActivityZone.tsx`, five mutations

Baseline 6/6 pass.

| # | mutation applied to `ActivityZone.tsx` | result | the assertion that caught it |
| --- | --- | --- | --- |
| B1 | `useMemo` dropped from `feature`, rebuilt every render | **1 red** | *"never re-uploads the geometry"* — `toBe` failed with *"serializes to the same string"*, i.e. a fresh polygon object per pulse |
| B2 | `halfPeriod` forced to 16 ms — a JS-driven 60 fps pulse | **2 red** | *"does not re-render at frame rate"* — **expected 0 repaints in one second, got 60**; and the transition duration collapsed 1200 → 16 |
| B3 | `'line-opacity-transition'` deleted from the outline paint | **1 red** | *"hands the interpolation to the GPU"* — transition `undefined` |
| B4 | `useOpacityPulse` returns `pulse.maxOpacity` always — a static zone | **1 red** | *"animates: the outline opacity really does change"* — the anti-vacuity guard fired, as designed |
| B5 | the component returns `null` — nothing rendered at all | **5 of 6 red** | everything except *"does not re-render at frame rate"* |

**B5 is recorded because of what it does NOT catch.** A component that renders
nothing satisfies *"a frame of elapsed time costs nothing"* vacuously. That test
is therefore not load-bearing on its own, and the file is only honest because
test 1 asserts the opacity actually changes before anything else is claimed. Said
plainly rather than left for a reader to discover.

A second limitation, found by B2 and worth the same honesty: *"re-renders exactly
once per half-period"* **passed** under a 16 ms interval, because React batches
the 75 `setState` calls inside one `act()` into a single render. The cadence
property is really pinned by test 2 (zero repaints across sixty discrete frames),
not by test 3. Test 3 is a weaker restatement, and it survived a mutation it
reads as though it should have caught.

Both subjects were restored and re-verified green: `whyShownOpened.ts` 4/4,
`ActivityZone.gpuFriendly` 6/6, both files byte-identical to `88b9e8e1a`.

#### M256 — `routes/mapProjection.ts`, four mutations

Baseline 29/29 pass (26 pre-existing + the 3 of §42.3b). Run with
`SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import
tsx/esm --test src/test/geoZoneSeed.test.ts`.

| # | mutation applied to `routes/mapProjection.ts` | result | the assertion that caught it |
| --- | --- | --- | --- |
| C1 | the flow-zone cache-hit branch never taken | **2 red** | *"the warm poll re-read geo_zones"* (expected 0 extra reads, got 1) and the clear/re-read case |
| C2 | the protected-zone cache-hit branch never taken | **1 red** | *"the warm poll re-read protected_zones"* |
| C3 | a failed `geo_zones` read cached as `[]` for the full TTL | **1 red** | *"a failed read was cached — a transient database error would darken Crowd Flow for a full TTL"* |
| C4 | `loadFlowZones` returns `[]` without reading anything | **5 red** — all three new cases plus two pre-existing | *"the cold request never read geo_zones"* and *"after a clear the loader must go back to the database; if it does not, the first case above proves nothing about caching"* |

C4 is the one that makes the other three mean anything. A cache-hit test that
counted only "zero reads on the second poll" passes a route that has stopped
reading the table at all — the cheapest possible false green, and the exact shape
of the failure this programme has already shipped once. Both anti-vacuity
assertions fired with the messages written for them.

`routes/mapProjection.ts` was restored and confirmed byte-identical
(`git diff` empty); 29/29 green.

### §42.8 Two findings from re-running the suites

1. **`node --import tsx/esm` cannot run any `node:test` file in
   `travel-buddy-standalone` at this tree.** Every single-file invocation dies
   with `ERR_REQUIRE_CYCLE_MODULE` before a test executes, and so does a
   two-file batch. It is not specific to the new test and not specific to the
   Map lane: the pre-existing
   `src/features/map/truth/__tests__/liveTruth.test.ts` fails identically, and
   an import of `src/types/mapObjects.ts` — a file with no imports of its own —
   reproduces it on its own. `--import tsx` (no `/esm`) runs all of them.
   The standalone `run-node-tests` script spawns `--import tsx/esm`, so **the
   standalone node:test runner is dark**, which would mean these suites are not
   running in CI at all. That script is not the Map lane's; see §42.4.7.
2. **The standalone test-typecheck ratchet is unmoved.**
   `node ../scripts/check-test-typecheck.mjs --package travel-buddy-standalone`
   reports 176 diagnostics across 61 files against a baseline of 176 across 61 —
   OK, no file above its baseline and no baseline stale. The two new client test
   files added none, which is the outcome required and not a coincidence worth
   celebrating.

### §42.9 Sixteen more citations were pointing at the wrong line — all in **C** rows

§42.1 anchored every citation in the 56 W / N / ? rows. It did not touch the C
rows, and `check:citation-symbols` — which did not exist when that pass ran —
then found sixteen citations in this census that NAME a symbol the cited line
does not contain. Every one is under a **C** verdict, which is the worse place
for a rotten pointer: nobody re-opens a closed row.

| row | was | is | drift |
| --- | --- | --- | --- |
| M58 | `mapObjects line 347-357` `MapProvenance` | `lib/mapObjects.ts:408-412#MapProvenance` | +61 |
| M59 | `mapProjection line 833` `describeClaim` | `lib/mapProjection.ts:725#describeClaim` (per-claim) + `:880#describeClaim` (the formatter) | the cited line named neither |
| M59 | `mapProjection line 607` `eventAdjacencyLine` | `lib/mapProjection.ts:615#eventAdjacencyLine` | +8 |
| M59 | `mapProjection line 615` `qualifiedMediaLine` | `lib/mapProjection.ts:623#qualifiedMediaLine` | +8 |
| M59 | `mapProjection line 586` "Table 7 VERBATIM" | `lib/mapProjection.ts:594#VERBATIM` | +8 |
| M60 | `mapObjects line 355` `updatedAt` | `lib/mapObjects.ts:411#updatedAt` | +56 |
| M61 | `mapObjects line 354` `ConfidenceState` | `lib/mapObjects.ts:410#ConfidenceState` | +56 |
| M78 | `tripMapSources line 213` `meetingPoints` | `tripMapSources.ts:234#meetingPoints.push` | +21 |
| M113 | `layerModel line 66` `live_activity`, line 158 for the default | `layerModel.ts:69#live_activity`, `:159#live_activity` | +3 / +1 |
| M136, M287 | `mapProjection line 1166` `rankObjects` | `lib/mapProjection.ts:1217#rankObjects` | +51, twice |
| M141 | `mapProjection line 1049` `enrichWithLiveClaims` | `lib/mapProjection.ts:1096#enrichWithLiveClaims` | +47 |
| M141, M288 | `mapProjection line 667` "Never upgrades" | `lib/mapProjection.ts:675#Never upgrades` + `:696#applyLiveClaims` | +8, twice |
| M159 | `mapProjection line 676` `applyLiveClaims` | `lib/mapProjection.ts:696#applyLiveClaims` | +20 |
| M172 | `mapObjects line 258-266` `PRIVACY_CLASSES`, lines 269 and 274 | `lib/mapObjects.ts:309-316#PRIVACY_CLASSES`, `:319#precisionRank`, `:324#narrowestPrivacyClass` | ~+51 each |
| M182 | `protectedLocations line 793` `COARSENED_PAYLOAD_KEYS` | `lib/protectedLocations.ts:798#COARSENED_PAYLOAD_KEYS` | +5 |
| M182 | `mapObjects line 376-381` for the `verified_firsthand` quote | `lib/mapObjects.ts:221-226#verified_firsthand` | **-155** |
| M236 | `mapProjection line 1124` `parseBbox` | `lib/mapProjection.ts:1175#parseBbox` | +51 |
| M287 | `collision line 617` `resolveCollisions` | `collision.ts:634#resolveCollisions` | +17 |

Each replacement was verified by reading the target line before it was written,
not by trusting the checker's suggestion — `describeClaim` in particular has four
mentions and one definition, and the guard's "found at" list omits the
definition, so the obvious repair would have cited a comment. **No verdict moves:
all sixteen underlying claims are true at this tree.** `check:citation-symbols`
falls from 60 misplaced to **44**, ABSENT stays 0, and census-map now contributes
**zero** rows to either class.

**A trap worth naming, because this pass fell into it.** The first draft of these
repairs wrote each old pointer in the repair note as `` `:833` ``. That shape is
not prose — `check:doc-citations` reads a backticked bare `:NNN` as a citation
INHERITING the last file named on the line, so eleven notes about wrong citations
silently became eleven new citations, two of them immediately broken — one
pointed a 347-357 range at `WhyShownSheet`, a 220-line file. The table above then
did the same thing a second way: writing each OLD pointer in its "was" column
re-entered four of the sixteen wrong citations into the corpus, and
`check:citation-symbols` counted them straight back. Historical line numbers in
this census are now written as plain `line 833`, with no extension and no colon,
so nothing parses them. A census that documents its own repairs in the citation
grammar manufactures the rot it is describing — twice, here, before it stopped.

### §42.6 Row moves

**None.** 237 C / 46 W / 5 N / 5 ? is unchanged, and CONSTRUCTED% and CORRECT%
are unchanged. This section moved no row and is not a gain in either number.
The 2026-09-14 resumed pass (§42.3b, §42.7-§42.9) moved none either: it
re-executed the evidence for two tests under nine mutations, wrote M256's
device-free half and proved it under four more, repaired sixteen pointers under
**C** rows, and found two things about the runners. 293 rows, 237 C / 46 W / 5 N
/ 5 ? at both ends — confirmed by `check:census-integrity` after every edit.

### The port's cache fix moves no row, and the reason is a gap in this census

ADDED 2026-09-16 by the INTEGRATING LANE, after merging the map/sensing lane of
the Replit Media/Map/Sensing port.

The port closed a real defect: `mapCache` keyed account-specific map objects
under a city-only, account-agnostic AsyncStorage key, so on one handset the
objects one account had cached — its trip stops, crew members, saved places,
memories and my-cities — were readable by the next account to sign in. The fix
puts the account in the key, refuses to build a key at all when identity is
absent, bumps `MAP_CACHE_VERSION` to v2, purges the v1 entries already on
devices, and discards an in-flight response whose identity changed before it
resolved.

**No verdict in this census moves, and that is the finding.** M203-M210 grade
the cache eight times — base region, trip, event map, saved places, crew state,
place intelligence, safety, staleness labelling — and every one is `C`. Every one
of them was true before the fix and is true after, because **not one of them asks
whose data the cache holds.** Searching this census for any row pairing the cache
with account scoping, viewer isolation or another user returns nothing.

So the census could have been fully green on the cache while the cache leaked
between accounts, and it was. That is not a scoring error to correct after the
fact: each of those rows measured what it said it measured. It is a **scope** gap
— the §28 offline-caching requirements were graded for COVERAGE (is each class
cached?) and never for TENANCY (is each class cached to the right person?), and
a criterion nobody wrote cannot be failed.

Recorded here rather than silently fixed because the next reader deserves to know
that these eight `C`s never carried the meaning they appear to carry. If a
tenancy criterion is ever added to §28, it is a new row and it is `C` at this
commit — not a re-grade of M203-M210.

---

## §43 — 2026-09-20: the production blockers, re-measured live, and the gate the census never named

Every "absent from production" verdict in §41 and §42 rests on one artifact —
`artifacts/api-server/baseline/20260907_production_tables.txt` — and both sections
say so in as many words: *"It did not, and could not, re-measure the database."*
This section re-measures it. The census was right about the method and has since
gone stale about the facts.

### 43.1 What is actually in production, read live on 2026-09-20

| object the census calls absent | live state | rows it was blocking |
| --- | --- | --- |
| `locate_friends_sessions` / `_members` / `_positions` / `_audit` | **all four PRESENT** (9 / 5 / 11 / 8 columns) | M7, M83, M85–M87, M90–M94, M222 |
| `map_telemetry_events`, `map_telemetry_drops` | **both PRESENT**, 0 rows | M259–M275 |
| `protected_zones` | still absent | M10, M133, M139, M179, M223, M280 |
| `route_flow_contribution_consent` | still absent | M67, M5, M119, M221, M279 |
| `geo_zones` | present, 0 rows | M5, M119, M279 |

Three of the four blocking objects the census names are no longer absent. The
committed baselines already said so and were not read: `20260915_production_tables.txt`,
`20260915b_production_tables.txt` and `20260916_production_tables.txt` all list the
four `locate_friends_*` names. The census cites only the 2026-09-07 file, which
does not. **The evidence was in the repository before this pass and the verdicts
were stale against it.**

### 43.2 The gate the census never records, and why no row moves to C here

M7's criterion is *"a refreshed `baseline/*_production_tables.txt` contains the
four names."* **That criterion is met today.** Read literally, M7 and the ten rows
that inherit it are C.

They are not being graded C, because the criterion is incomplete. A third gate
exists that no row in this census names: `locate_friends_enabled`
(`artifacts/api-server/src/lib/locateFriendsSession.ts:99#LOCATE_FRIENDS_FLAG`,
also read by `services/passport/PassportProjectionService.ts:1722`). It is present
in production and **FALSE**.

So the true state of §12 is **deployed and switched off** — which is a different
fact from "the storage does not exist", and a better one, but it is not "works".
Grading eleven rows C on a criterion now known not to capture the thing that
decides whether the feature runs would be scoring to the letter of a sentence this
section has just shown to be incomplete.

**What changes here is the BLOCKER, not the verdict.** For M7, M83, M85–M87,
M90–M94 and M222 the blocker is no longer *storage absent from production*. It is
*`locate_friends_enabled` is FALSE in production*. Any future reader who closes
these rows by applying 2219 will have closed nothing: 2219 is already applied and
its tables are already there.

### 43.3 An owner decision these eleven rows now wait on, shared with fourteen others

Whether a correct implementation behind a dark flag is C or W is **not settled in
this corpus**, and it is not settleable inside one census. §41.5 already recorded
the asymmetry for M282: this census grades that shape W, while `census-media`
§11.3.3 grades the same shape C for MD375 and MD379, and `census-media` §12.8
enumerates fourteen further media rows turning on the same question.

Under media's convention these eleven Map rows are C today. Under this census's
convention they are W. **One rule for thirteen documents**, and a lane cannot take
it. It is recorded here as an open decision rather than resolved in the direction
that happens to raise this census's number.

### 43.4 A ledger class that is not evidence, generalised

Production's `schema_migration_ledger` carries rows for 2201, 2217, 2218, 2219 and
2224, all dated 2026-09-15 with `applied_by='backfill'`. Commit `63772b76c` already
named this class for 2202: *"a ledger row with `applied_by='backfill'` … asserts the
FILENAME existed when 2254 ran and never that the file ran."*

Checked object by object against the live database: **2219 did run** — its four
tables exist. **2201, 2217, 2218 and 2224 did not** — their tables and flag rows are
absent. Four of the five ledger rows describe migrations that never executed.

**No verdict in this census, or any other, may be taken from a `backfill` ledger
row.** The object is the evidence; the ledger row is a filename.

### 43.5 What this section does not do

It re-establishes the state of the 56 not-correct rows and nothing else. No other
row was re-audited, no verdict letter moves, and the tally below is unchanged from
§42.6 — deliberately. Re-measuring a blocker is not the same as passing an
acceptance criterion, and this section is the former.
