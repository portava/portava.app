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
> `routes/mapProjection.ts:896#no_zone_model` refuses with `no_zone_model`. *(Line repointed 2026-09-14 from 836, which is 62 lines short of the branch; the fact is unchanged.)* Populating
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
| BUILT-AND-CORRECT | 235 | 237 | 238 | **239** |
| BUILT-BUT-WRONG | 48 | 46 | 45 | **44** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **5** |
| **CONSTRUCTED%** = (239+44)/293 | **283 / 293 = 96.6 %** |
| **CORRECT%** (raw) = 239/293 | **81.6 %** |
| **CORRECT% (spec-attributable)** = 226/293 | **77.1 %** |
| CANNOT-VERIFY share | **5 / 293 = 1.7 %** |

*The two-column rows are the 2026-09-13 pass: M201 and M226 moved W→C after
being built and executed. CONSTRUCTED% does not move, and that is the point —
these were BUILT-BUT-WRONG rows, so closing them is a pure CORRECT% gain. §40
records the moves, the mutations, and what was left alone.*

*The last column is the 2026-10-05 pass: M43 moved W→C (§47). It was built on
2026-09-20 and deliberately not regraded then; §47 is the grading pass that was
owed. CONSTRUCTED% does not move. The spec-attributable figure on the line below
is NOT recomputed by §47 and still reads as it did before this pass.*

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
   `artifacts/api-server/src/routes/mapProjection.ts:197-204`. The header at
   `:181-186` states the intent exactly: *"a failed read returns null, and the
   caller answers with the empty envelope instead of serving unprotected
   objects."*
3. The caller does that — `artifacts/api-server/src/routes/mapProjection.ts:965-980`:
   `if (zones === null)` → `res.json({ enabled: true, objects: [], … sources: [] })`.
4. `GET /api/map/projection/temporal` has the identical branch at
   `artifacts/api-server/src/routes/mapProjectionTemporal.ts:574-591`.
5. And if the flag is *off* — which is how migration 2201 seeds it,
   `artifacts/api-server/src/migrations/2201_map_projection_flag.sql:16-18`,
   `('map_projection_enabled', FALSE, …)` — the route returns
   `{ enabled: false, objects: [] }` at `routes/mapProjection.ts:499-501`.

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
| M5 | Crowd Flow | **W** | Producer (`lib/crowdFlowProducer.ts`), gateway lane and client renderer all exist. The mode gate is `src/stores/mapStore.tsx:100#CROWD_FLOW:` — `CROWD_FLOW: inputs.crowdFlowObjectCount > 0` — and the gateway serves zero objects in production. TWO independent blockers, not one: `route_flow_contribution_consent` is absent (M67) **and** `geo_zones` holds no curated rows, which the gateway refuses on separately at `routes/mapProjection.ts:896#no_zone_model`. *(Re-read 2026-09-14: the old citation, line 98, was the §11 TRIP comment two lines above the gate, and the CORRECTION HEADER's line 836 for `no_zone_model` was 62 lines short. Both repointed and anchored; verdict unchanged.)* **Turns red when:** a production `GET /api/map/projection` response over a backfilled viewport carries at least one `objects[].kind === "crowd_flow"`. That needs an ops backfill of `geo_zones` (ops, not a migration) *and* 2218 + 2224 applied (integration owner). Either one alone leaves it W. |
| M6 | Trip Map | C | `src/features/trips/map/tripMapSources.ts`, `tripMapModel.ts`; capability hard-true at `src/stores/mapStore.tsx:96`. |
| M7 | Locate My Friends | **W** | Complete server (`lib/locateFriendsSession.ts`, 48 KB) and client (`src/services/locateFriends.ts`, `src/components/map/LocateFriendsPanel.tsx`). **SUPERSEDED 2026-09-26 BY §44 — measured live, all four are now PRESENT on production (0 rows each); the blocker is now the flag `locate_friends_enabled=false`, not the schema. Kept as the record of what was true at the 2026-09-07 baseline.** All four storage tables were absent from production: none of `locate_friends_sessions`, `_members`, `_positions`, `_audit` appears in `artifacts/api-server/baseline/20260907_production_tables.txt` (431 names), and all four are created by `` `artifacts/api-server/src/migrations/2219_locate_friends_sessions.sql:74#CREATE TABLE IF NOT EXISTS public.locate_friends_sessions (` ``. *(Re-read 2026-09-14: the old citation — `checkProductionDrift.ts`, lines 176-179 — was wrong twice over — those lines are `wall_telemetry_events` / `passport_telemetry_events`, and **that file does not track any `locate_friends_*` table at all**, so the ratchet is silent about this lane. The baseline table list is the artifact that actually carries the fact.)* **Turns red when:** a refreshed `baseline/*_production_tables.txt` contains the four names. Supplied by the operator with production read access, after the integration owner applies 2219. A CI-only apply does not move it — the baseline is production's. |
| M8 | Intent Mode | C | `src/components/map/IntentSheet.tsx:2`; opened at `app/map/index.tsx:2691`. |
| M9 | Compass Map Recommendations | C | `src/features/map/compass/compassMapModel.ts`; capability hard-true, `src/stores/mapStore.tsx:94`. |
| M10 | Time Machine | **W** | Producer `lib/temporalProjection.ts`, route `routes/mapProjectionTemporal.ts`, control `src/components/map/TimeMachineControl.tsx`. The capability requires the producer be reachable (`src/stores/mapStore.tsx:108#TIME_MACHINE:`), and the temporal route rides `map_projection_enabled` (`routes/mapProjectionTemporal.ts:429#map_projection_enabled`) and dies on the same `protected_zones` branch (`:575#loadProtectedZones`, answering `:583#protection_unreadable`). *(Re-read 2026-09-14: lines 105-107 were the comment above the gate and 574 a blank line; both repointed and anchored. Verdict unchanged.)* **Turns red when:** 2217 is applied to production *and* `map_projection_enabled` is TRUE there, and `GET /api/map/projection/temporal?offset=+60m` answers `enabled: true` with a non-null `forecast`. Both are integration-owner/ops acts; neither is code. |
| M11 | Layers / Legend | C | `src/components/map/LayersSheet.tsx:2`; opened at `app/map/index.tsx:3282#visible={overlayOpen('LAYERS')}`. |

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
| M42 | Gold marker = Saved / Passport / Memory | C | All three arms are correctly sourced, and the Memory arm is now proven in the environment where its defect could appear. **Saved** was already right: `lib/mapProducers/savedPlaceProducer.ts:388,396` reads the union of `wishlist_places` + `discovery_place_saves` after PR #446 moved it off writerless `saved_places` (`:18-23`). **Memory** was the defect: `lib/mapProducers/memoryProducer.ts:35` filters `memory_projections` to `subject_type = 'place'`, and the projector's PLACE lane read the writerless `saved_places`, so it had never had an eligible subject. `2963_memory_projector_place_lane_union.sql` repoints that lane at the union, bridged into the `discovery_places` id-space by `id`, `canonical_location_id` and `osm_id`; `2965_memory_projector_canon_saves_delete_guard.sql` then qualified the `DELETE FROM _canon_saves` that 2963 shipped unguarded. Both are applied on `portava-ci` and production. **THE BEHAVIOURAL HALF, MEASURED THROUGH THE GUARDED PATH.** `memoryProjectionLifecycleLive.test.ts` calls `project_user_memory_with_retraction` over PostgREST — the session `supautils`' safeupdate guard is armed in — and asserts: `saved_places` is EMPTY (anti-vacuity run rather than claimed, so the pre-2963 lane could not have produced a place projection for anyone); all THREE id-space bridges resolve; the events' `source_ref` names `wishlist_places+discovery_place_saves`; and a second pass adds no duplicates. GREEN on run `35585815607`, job `106292080806`, step 15 `test:memory-projection-lifecycle`. That green is load-bearing rather than decorative: `.github/scripts/run-live-suite.sh` fails the step on `skipped != 0`, `fail != 0`, `pass == 0` or any unaccounted test, so a passing step means every case in the file ran. *(Re-read 2026-09-21: this row was moved to C earlier the same day on a run against a local plain PostgreSQL, which has no safeupdate guard, and moved back to W when 2963's unqualified DELETE proved the projector raised on every real call. A proof run where the defect cannot appear is not evidence — that is why the bar above names the PostgREST path.)* **WHAT THIS ROW DOES NOT CLAIM:** no gold memory pin is drawn for a real user in production today. `memory_projection` is off there, and `checkFlagSchemaPrerequisites` reports `memory_are_new_to_user()` and `memory_remembers_for_user()` absent. Those belong to M123 and the Highlights & Memories lane, not here. |
| M43 | Blue dot = current user | **W** | The legend glyph is real and drawn — `src/components/map/LayersSheet.tsx:167-170,198` render a `blue_dot` glyph — but **nothing renders the user's own position on the canvas.** `src/components/discovery/DiscoveryMapView.tsx` contains no `UserLocation`, no `showUserLocation` and no user marker; `app/map/index.tsx:856#userLat` / `:858#userLng` read them only to recentre the camera. The map legend documents a marker the map does not draw. *(Re-read 2026-09-14: still true. `UserLocation` IS exported by the installed MapLibre SDK, and the repo's own jest stub mirrors that export — so the renderer this row needs already exists in the dependency set and nothing mounts it.)* **Turns red when:** a component test mounts the real map canvas with a viewer position and finds a user-position node in the tree. The canvas is `src/components/discovery/DiscoveryMapView.tsx`, which belongs to the Discovery lane, and `EntityMapLayers` — the one map-owned renderer inside it — is mounted only when `entities.length > 0`, so it is the wrong home for a marker that must draw on an empty map. **Cross-lane request to Discovery**, not buildable from the Map lane's paths. |

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
| M65 | The seven declared input families | **W** | `lib/crowdFlowProducer.ts:290` `WIRED_SIGNAL_SOURCES` is **two** of seven; `:298-300` `DECLARED_BUT_UNFED_FAMILIES` and `:346` `UNFED_FAMILY_BLOCKERS` name, per family, the specific capture that must exist first. Honestly declared, but five families produce nothing. *(Re-read 2026-09-14: all four citations hold at this tree — `:290#WIRED_SIGNAL_SOURCES`, `:299#DECLARED_BUT_UNFED_FAMILIES`, `:346#UNFED_FAMILY_BLOCKERS`.)* **Turns red when:** `WIRED_SIGNAL_SOURCES` names all seven families **and** each newly-named family has a capture writing rows a producer run can observe. This is the one row in this census that no deployment unblocks: `UNFED_FAMILY_BLOCKERS` states, per family, the capture nobody has written (the entries are product work, not migrations). Moving a family into `WIRED_SIGNAL_SOURCES` without its capture would turn this row green while producing nothing — so the evidence required is a producer run observing that family, not a diff of the constant. |
| M66 | Minimum cohort density | C | `lib/mapAggregation.ts:351` `MIN_ZONE_COHORT = PRIVACY_THRESHOLD_V1.minUniqueActors`. |
| M67 | Multiple signal families required | **W** | The gate is right — `lib/crowdFlowProducer.ts:497-498` requires ≥ `MIN_SIGNAL_FAMILIES` *observed*, and refuses before it reads (`:929`). But the second family is the accepted-plan hop lane, whose consent record `route_flow_contribution_consent` (`lib/routeHopSignal.ts:115,587`) is **absent from production**: `` `artifacts/api-server/src/scripts/checkProductionDrift.ts:389#route_flow_contribution_consent` `` classifies it unapplied, and the name is not in `baseline/20260907_production_tables.txt`. *(Re-read 2026-09-14: lines 180-183 were `passport_telemetry_events`; repointed and anchored.)* One family in production ⇒ the producer permanently refuses. **Turns red when:** 2224 is applied to production and `observedSignalFamilies()` returns ≥ `MIN_SIGNAL_FAMILIES` for a real viewport. Integration owner applies; the operator's refreshed baseline is the evidence. |
| M68 | Freshness checks | C | `lib/crowdFlowProducer.ts:510` `SIGNAL_MAX_AGE_MINUTES`; `:653` applied per signal. |
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
| M78 | Meeting points | C | `tripMapSources.ts:234#meetingPoints.push` is the `meeting_point` branch of `partitionPlanItems`; producer `lib/mapProducers/meetingPointProducer.ts:147#projectMeetingPoint`, read at `:268#readMeetingPoints`. *(Repointed 2026-09-14 from line 213, which sits between two other `meetingPoints` mentions and names none of them.)* |
| M79 | Safe Return context | C | `tripMapSources.ts:282-293` — anchored to lodging because the session itself carries no coordinate (§24). |
| M80 | Compass alternatives | C | `app/map/index.tsx:94` `fetchCompassRecommendations`; `src/features/map/compass/compassMapModel.ts`. |
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
| M95 | No public friend tracking | C ⌀ | `lib/locateFriendsSession.ts:110` — *"no `public` member, and adding one would be the §37 non-goal in a single [line]"*; migration `2219:310` "No public read path". Holds vacuously in production, where there is no path at all. |
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
| M138 | Viewport Aggregation | C | `lib/mapAggregation.ts:2`; `:216-238` only wide bands aggregate; `lib/mapAggregation.ts:430#export const NEVER_AGGREGATED_KINDS` `NEVER_AGGREGATED_KINDS`. |
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
| M146 | Telegraph → communication | C | `app/map/index.tsx:159` `openDirectThread` delegates; no message state on the map. |
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
`routes/mapObservations.ts:738` `map_contributions_enabled`.*

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
| M179 | Suppress sensitive locations **before** data reaches the client | **W** | The gate is written and cannot fire. `lib/protectedLocations.ts:2#protectedLocations`, `:860#applyProtection` is the last step before serialization, ordered correctly at `routes/mapProjection.ts` and (after PR #393's fix) in the temporal route. But `protected_zones` is **absent from production** (`` `artifacts/api-server/src/scripts/checkProductionDrift.ts:315#protected_zones` ``, and the name is not in `baseline/20260907_production_tables.txt`), so the read errors, `routes/mapProjection.ts:236#loadProtectedZones` returns null and the route answers the refusal envelope at `:1024#protection_unreadable`. *(Re-read 2026-09-14: three of these four citations were wrong — line 849 is a field inside an interface and `applyProtection` is 11 lines below it; drift's `protected_zones` entry is at line 157, not 110; and lines 964-979 are the §19 ordering block, not the envelope, which begins 60 lines later.)* The production behaviour is *refuse everything*, not *suppress sensitive locations* — safe, and not the requirement. **Turns red when:** 2217 is applied to production, a refreshed baseline lists `protected_zones`, and a projection response over a viewport containing a curated zone carries `protection` non-null with at least one object coarsened or withheld. Note the second half: applying the table is necessary and NOT sufficient — an empty `protected_zones` makes `applyProtection([], …)` an identity pass (`routes/mapProjection.ts:197#FAIL-CLOSED`), which suppresses nothing. A curated zone set is an ops act after the migration. |
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
| M201 | Saved items | C | **Moved W→C 2026-09-13.** The row's finding was right: the client carried the whole branch (`mapSearchModel.ts:50`, `:144-148`, `:64`) and the server had no type that could reach it. It has one now — `` `artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts:108#saved` `` is wire vocabulary, produced by `` `artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts:1315#async function searchSaved(` `` over the two tables saves actually land in (`wishlist_places` + `discovery_place_saves`, as `savedPlaceProducer` reads them after #446), dispatched at `` `artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts:2377#case "saved":` ``. The adapter's `saved` key moved out of the tolerated-alias block into the wire table (`` `travel-buddy-standalone/src/features/map/search/searchAdapter.ts:84#saved:` ``) and `savedKind` is now read from the wire rather than hard-coded (`` `travel-buddy-standalone/src/features/map/search/searchAdapter.ts:261#export function savedKindFromMetadata` ``). The map asks for it: `` `travel-buddy-standalone/src/components/map/MapSearchSheet.tsx:187#requestMapSearchPage(q,` (repointed by census-discovery §80.8: the sheet's two `searchUnified` calls became one gateway request) ``. Executed: `` `artifacts/api-server/src/test/mapSearchSavedItems.test.ts:168#it("dispatchSearch has a` `` (15 cases; deleting the dispatch case reddens 9, dropping either save table reddens 6). **Not in the `all` fan-out** — see the owner decision in §40. |
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
| M224 | Overlay INTENT | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2691`. |
| M225 | Overlay LAYERS | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2545,2569`. |
| M226 | Overlay FILTERS | C | **Moved W→C 2026-09-13.** The reducer was always right; nothing entered the state. Both "filters" affordances dispatch it now — the floating control at `` `travel-buddy-standalone/app/map/index.tsx:2617#onFiltersPress={()` `` (it used to dispatch `'LAYERS'`) and the carousel's empty-state button at `` `travel-buddy-standalone/app/map/index.tsx:2652#onFiltersPress={()` `` — and the sheet reads the machine: `` `travel-buddy-standalone/app/map/index.tsx:3298#visible={overlayOpen('FILTERS')}` ``. The bypassing `filterSheetOpen` `useState` is gone, so D1 mutual exclusion and `resolveBack` now actually govern it. `LayersSheet` keeps its own header entry point (`onLayersPress`), so this did not fix one sheet by breaking another. Executed: `` `travel-buddy-standalone/src/features/map/state/__tests__/filtersOverlay.test.ts:136#test('the` `` (12 cases; restoring the `useState` reddens 2, re-pointing the control at `'LAYERS'` reddens 3). |
| M227 | Overlay SEARCH | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2543-2544`, rendered `:3181`. |
| M228–M235 | Camera FOLLOW_USER, FREE_EXPLORE, FOCUS_PLACE, FOCUS_AREA, FOCUS_ROUTE, FOCUS_TRIP, FOCUS_GROUP, COMPASS_RECOMMENDATIONS | C ×8 | `mapMachine.ts:149-160` all eight in §30's order. `:163-179` `MODE_CAMERA` couples each mode to a framing **as data**, with FOCUS_ROUTE deliberately absent from it because §5 makes navigation cross-cutting rather than a mode (`:178-180`). `:191-215` `OBJECT_KIND_CAMERA` refines by kind — zone-shaped kinds get FOCUS_AREA because "framing them as a pin would imply a precision §23 never granted", and `crew_member` gets FOCUS_GROUP for the same reason. D4 (`:66-73`): a user pan drops to FREE_EXPLORE and changes nothing else. |

### §31 Clustering and Rendering Priority (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M236 | Viewport queries | C | `lib/mapProjection.ts:1175#parseBbox` — rejects malformed, out-of-range and antimeridian-crossing viewports rather than guessing; `lib/mapAggregation.ts:121#bboxContains`. *(`parseBbox` repointed 2026-09-14 from line 1124; `bboxContains` was already right and is now anchored.)* |
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
| M257 | Debounce after the camera settles; never re-query on every pixel | C | `app/map/index.tsx:941-947` — *"a coarse centre grid and only re-queries after the §34 settle debounce"*; `:1009` "once the camera settles, the viewport intelligence is fetched"; `src/components/discovery/DiscoveryMapView.tsx:138` reports the camera only on settle. |
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
| M259 | `map_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:643#'map_opened',`; 1 emitter: `app/map/index.tsx:1353#emitMapEvent('map_opened',`. `src/features/map/telemetry/mapTelemetry.ts:23#mapSessionId` mints the session id here and nowhere else, so this emitter is also what stops every later event carrying a SYNTHETIC session (`:1011#ensureSession`). |
| M260 | `zone_selected` | **W** | `src/features/map/telemetry/mapTelemetry.ts:644#'zone_selected',`; 3 emitters: `src/components/map/MapEntityPreviewCard.tsx:132#emitMapEvent('zone_selected',`, `src/components/map/MapCarousel.tsx:1240#emitMapEvent('zone_selected',`, `src/components/map/LivePlaceSheet.tsx:321#emitMapEvent('zone_selected',`. *(The third emitter, previously written "+1", is the `LivePlaceSheet` call site above.)* |
| M261 | `place_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:645#'place_opened',`; 3 emitters: `src/components/map/MapEntityPreviewCard.tsx:138#emitMapEvent('place_opened',`, `src/components/map/MapCarousel.tsx:1246#emitMapEvent('place_opened',`, `src/components/map/LivePlaceSheet.tsx:327#emitMapEvent('place_opened',`. |
| M262 | `live_state_viewed` | **W** | `src/features/map/telemetry/mapTelemetry.ts:646#'live_state_viewed',`; 2 emitters: `src/components/map/LivePlaceSheet.tsx:361#emitMapEvent('live_state_viewed',`, `src/components/map/LivePlaceSheet.tsx:385#emitMapEvent('live_state_viewed',`. |
| M263 | `why_shown_opened` | **W** | `src/features/map/telemetry/mapTelemetry.ts:647#'why_shown_opened',`; 1 emitter: `app/map/index.tsx:2876#emitMapEvent('why_shown_opened',`. **The emitter exists and its payload is wrong.** `WhyShownOpenedPayload.lineCount` means "how many provenance lines the §9 panel showed", and the emitter computes `obj.provenance?.lines.length ?? 0` while `WhyShownSheet` renders `buildWhyPanel(object)`, whose `buildWhyLines` SYNTHESISES lines whenever the server sent none — so every synthesised panel reports 0. `provenanceRefs` diverges the other way: the emitter sends `obj.sourceRefs`, the panel shows `model.lines[].ref`. Built and proven this pass: `src/features/map/telemetry/whyShownOpened.ts:49#whyShownOpenedPayload` derives both from the same `buildWhyPanel` call the sheet renders, with `src/features/map/telemetry/__tests__/whyShownOpened.test.ts` failing when the helper is replaced by the production expression. WIRING IT IS A CROSS-LANE CHANGE — the emitter is in `app/map/index.tsx`, which the Map lane does not own — so the payload defect is open |
| M264 | `compass_requested` | **W** | `src/features/map/telemetry/mapTelemetry.ts:648#'compass_requested',`; 1 emitter: `src/components/map/AskCompassBar.tsx:137#emitMapEvent('compass_requested',`. Mints `decisionId` (`src/features/map/telemetry/mapTelemetry.ts:25#decisionId`). |
| M265 | `compass_option_selected` | **W** | `src/features/map/telemetry/mapTelemetry.ts:649#'compass_option_selected',`; 1 emitter: `src/components/map/MapCarousel.tsx:1256#emitMapEvent('compass_option_selected',`. |
| M266 | `route_started` | **W** | `src/features/map/telemetry/mapTelemetry.ts:650#'route_started',`; 2 emitters: `src/components/map/MapEntityActionRow.tsx:579#emitMapEvent('route_started',`, `src/components/map/LivePlaceSheet.tsx:444#emitMapEvent('route_started',`. *(Re-counted 2026-09-14: **two**, not the three previously claimed. Every `route_started` reference in `travel-buddy-standalone/src` and `travel-buddy-standalone/app` was read; the other four are comments and the type declarations.)* |
| M267 | `trip_stop_added` | **W** | `src/features/map/telemetry/mapTelemetry.ts:651#'trip_stop_added',`; 1 emitter: `src/components/map/MapEntityActionRow.tsx:535#emitMapEvent('trip_stop_added',`. |
| M268 | `plan_joined` | **W** | `src/features/map/telemetry/mapTelemetry.ts:652#'plan_joined',`; 2 emitters: `src/components/map/MapEntityActionRow.tsx:476#emitMapEvent('plan_joined',`, `app/map/index.tsx:412#emitMapEvent('plan_joined',`. |
| M269 | `meet_here_created` | **W** | `src/features/map/telemetry/mapTelemetry.ts:653#'meet_here_created',`; 1 emitter: `app/map/index.tsx:3194#emitMapEvent('meet_here_created',`. |
| M270 | `crew_locate_started` | **W** | `src/features/map/telemetry/mapTelemetry.ts:654#'crew_locate_started',`; 1 emitter: `app/map/index.tsx:2209#emitMapEvent('crew_locate_started',`. |
| M271 | `contribution_submitted` | **W** | `src/features/map/telemetry/mapTelemetry.ts:655#'contribution_submitted',`; 1 emitter: `app/map/index.tsx:2913#emitMapEvent('contribution_submitted',`. `src/features/map/telemetry/mapTelemetry.ts:585#sinceRouteStart` carries the banded time since `route_started`. |
| M272 | `alternative_requested` | **W** | `src/features/map/telemetry/mapTelemetry.ts:656#'alternative_requested',`; 1 emitter: `app/map/index.tsx:3215#emitMapEvent('alternative_requested',`. |
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
| M287 | No screen full of unranked POI pins | C | `lib/mapProjection.ts:1217#rankObjects`; `collision.ts:634#resolveCollisions`; `lib/mapAggregation.ts:235#AGGREGATING_BANDS` — only `world` and `city` aggregate, so wide bands collapse to cells. *(`rankObjects` and `resolveCollisions` repointed 2026-09-14.)* |
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
   read (`routes/mapProjection.ts:965-980`, `routes/mapProjectionTemporal.ts:574-591`).
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
(`` `artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts:2408#// 17 of the 18 non-"all" types run in parallel at FAN_LIMIT items each.` ``).
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
30 s TTLs — `protected_zones` at `routes/mapProjection.ts:238#_clearProtectedZoneCache`, flow
`geo_zones` at `routes/mapProjection.ts:259#_flowZoneCache`, and Phase 7's city
model at `routes/mapProjection.ts:294#_cityZoneCache`. Each exports a
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
even though `routes/mapProjection.ts:463#ONE clock read` states the handler makes
exactly one clock read. The invariant is stated and not held. It is harmless
today — both are TTL comparisons — and it is not a Map-lane fix to smuggle into
an evidence pass, so it is recorded here and nowhere else.

**M256 stays `?`.** No milliseconds are claimed, no device is involved, and
nothing here says anything about a warm production cache. One falsifiable
sub-property closed; the row's own measurement still needs a running server.

### §42.4 Cross-lane requests this pass raises

1. **`app/map/index.tsx:2876#emitMapEvent('why_shown_opened',` → use `whyShownOpenedPayload`.** Replace the inline
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
  and now correctly cited (`routes/mapProjection.ts:896#no_zone_model`); whether
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
(`artifacts/api-server/src/lib/locateFriendsSession.ts:112#LOCATE_FRIENDS_FLAG`,
also read by `services/passport/PassportProjectionService.ts:1885#const LOCATE_FRIENDS_CAPABILITY_FLAG = "locate_friends_enabled"`). It is present
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

---

## §44 — 2026-09-26: M7's blocker CHANGED CLASS, and the row still does not move

**Re-measured live against production (`ajrurzioarfkagpuxfnb`, read-only), not
acknowledged.** `check:census-freshness` named five counted files changed since
`1fe72289b` and not covered: `lib/crowdFlowProducer.ts`,
`lib/intelEvidenceCapture.ts`, `lib/locateFriendsSession.ts` (+108),
`lib/mapAggregation.ts` (+215) and `routes/mapObservations.ts` (+288/−155).

**NO VERDICT MOVES.** One row's stated evidence is now false and is replaced.

### §44.1 M7 — the four tables are NO LONGER absent from production

M7 reads: *"**All four storage tables are absent from production**: none of
`locate_friends_sessions`, `_members`, `_positions`, `_audit` appears in
`baseline/20260907_production_tables.txt`"*. That baseline is dated 2026-09-07.
Measured against the live database today:

| Object | 2026-09-26, production |
|---|---|
| `locate_friends_sessions` | **present**, 0 rows |
| `locate_friends_members` | **present**, 0 rows |
| `locate_friends_positions` | **present**, 0 rows |
| `locate_friends_audit` | **present**, 0 rows |
| `locate_friends_enabled` | **present, FALSE** |

**2219 has been applied to production since that baseline was taken.** The
schema blocker M7 rests on is gone.

**M7 stays `W`** — and for a blocker of a different kind: the feature is
flag-gated and the flag is off. That distinction is the whole point of
re-measuring rather than acknowledging. "The tables do not exist" and "the
switch is off" are the same verdict and completely different work: the first
needs a migration applied and sanctioned, the second is one owner decision away.
A plan built on the old sentence would have budgeted for the wrong thing.

Note also that the row's evidence is a **baseline text file**, which ages
silently — nothing fails when production moves past it. §43 read the production
blockers live for exactly this reason; this section extends that to M7.

### §44.2 M5, M65, M67 — re-executed, all three hold

| Row | Test | Result today |
|---|---|---|
| M5 | `geo_zones` holds no curated rows | table **present**, **0 rows** — holds |
| M5 / M67 | `route_flow_contribution_consent` absent from production | **absent** — holds |
| M65 | `WIRED_SIGNAL_SOURCES` is two of seven | still exactly `next_stop_contribution`, `accepted_plan` — holds |

M5, M65 and M67 all stay `W`, on conditions re-measured today rather than
carried forward.

`crowdFlowProducer.ts`'s own header remains the honest statement and was
re-read: *"RUNTIME EFFECT TODAY: STILL NONE IN PRACTICE"*, with four
independent blockers, none of them in that file. Two observed families now meet
`MIN_SIGNAL_FAMILIES`, so the producer *could* emit — which changes nothing a
user can see, and the file says so itself.

### §44.3 What the other diffs are

`mapAggregation.ts` (+215) gains the presence gate —
`PRIVACY_CLASS_AS_PRESENCE_PRECISION`, `presenceClassUnder`,
`gatePresenceObject`. That is the Sensing lane's §52 work landing in a file this
census counts; it is graded in census-sensing, not here.
`intelEvidenceCapture.ts` (+30) resolves contributor identities through 3310's
bridge, the same post-3002 correction census-media §18.3 records.
`routes/mapObservations.ts` is the §22 zone route taking its subject from the
resolver.

### §44.4 MOVES NOTHING

Totals unchanged. Four rows re-tested against the live database; three hold on
their original evidence, one holds on replaced evidence and a blocker that has
changed class.

## Cited, not graded (check:census-scope-coverage)

- NOT-GRADED: artifacts/api-server/src/test/censusIntegrityQualifiedVerdicts.test.ts — the suite of check:census-integrity's verdict tokeniser, cited in §40's "four rows became countable" note, which says of itself that it built nothing and closed no gap: it moved the recount to the numbers this document already stated, and no row cites it
- NOT-GRADED: artifacts/api-server/src/services/passport/PassportProjectionService.ts — census-passport's subject, cited in §43.2 only as a second reader of the locate_friends_enabled flag; the hold on M7 and the rows that inherit it rests on that flag being FALSE in production and on lib/locateFriendsSession.ts, which this census watches

---

## §45 — 2026-09-27: the §22 evidence row named its contributor's account, and now does not (lane X)

Branch `lane-x-evidence`, cut from `claude/sensing-completion-20260925` at
`e9e0b0404`. Found by lane I and recorded, not fixed, in census-media §35.7
item 1 (branch `lane-i-intel`, unmerged at the time of writing).

**BUILT ON BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG
ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.** No database was read or
written, no flag was touched, and the two migrations below are applied to no
database.

**One row is re-evidenced and none moves.** M154 stays C (§45.6).

### §45.1 The defect, measured on the base

- **What was stored.** The ownership proof returned the key it proved,
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:183#return { ok: true, reference:` ``,
  and the row stored that value as `reference`
  (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:283#reference: resolved.reference,` ``,
  unchanged in position).
- **What the key contains.** Every key the upload route mints starts with the
  uploader's account id: `` `artifacts/api-server/src/routes/posts.ts:210#const basePath =` ``.
  The ownership proof depends on exactly that segment.
- **What 3002 promised about this table.** Its contributor id is a rotating
  token, `` `artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql:387#COMMENT ON COLUMN public.intel_evidence.actor_id IS` ``.
  3002 relabels `actor_id` on existing rows and nothing else:
  `` `artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql:424#'UPDATE public.%I SET actor_id = public.intel_contributor_token(actor_id, now()) WHERE actor_id IS NOT NULL', t);` ``.
- **So, from 3002 on,** reading one evidence row gave the account, then the
  observation it supports, then that account's token for that week, and so
  every other observation stored under that token. No join and no function
  call was needed.
- **The gates, both verified on this tree.** The route refuses first on
  `` `artifacts/api-server/src/routes/mapObservations.ts:738#if (!(await isFlagEnabled(sc, "map_contributions_enabled"))) return reject("feature_disabled");` ``.
  The capture then refuses on
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:205#if (!(await isFlagEnabled(sc, "intel_capture_quick_signal"))) return reject("disabled");` ``
  and on consent,
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:210#if (!(await hasValidIntelConsent(sc, actorId))) return reject("consent_required");` ``.
  Recorded production facts: `map_contributions_enabled` has no row (read
  2026-09-21, `docs/ops/map-completion-checkpoint.md`), so it reads false.
  `intel_capture_quick_signal` is TRUE (read 2026-09-26,
  `docs/sensing-contributor-identity-cutover-runbook.md` §3). The path is dark
  in production because of the first gate alone.

Reading every reader of the column found the same defect twice more:

1. **The media seam's writer** (`lib/media/mediaEvidenceLink.ts`, no
   production caller, behind `media_evidence_enabled`) mirrored the asset's
   storage path into `reference`. That path also starts with the owner's
   account id.
2. **The only production reader of `reference`, account deletion's
   `collect_intel_evidence_paths`,** read the rows with
   `.eq("actor_id", userId)`. From 3002 on that matches no row. So an erased
   account's evidence photos would have stayed in the bucket, with the step
   reporting success and a count of 0.

### §45.2 Why the reference is not `media_assets.id`

The task named `media_assets.id` as the preferred reference, if the asset
exists at capture time. It is refused on both counts:

- **It may not exist.** The upload route writes the canonical row
  fire-and-forget, `` `artifacts/api-server/src/routes/posts.ts:257#void recordMediaAsset(sc, {` ``,
  and only while `media_canonical_enabled` is on.
- **It is not opaque.** `media_assets.owner_user_id` is one join away for any
  reader of this table. The byte gate itself reads it
  (`` `artifacts/api-server/src/lib/mediaAccess.ts:397#if ((asset as any)?.owner_user_id) {` ``).
  That is the same re-identification, derivable instead of direct.

### §45.3 What was built

**A. The sealed reference.** Gate 5 now proves the key as before and then seals
it: `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:224#const resolved = resolveAndSealOwnedMediaReference(` ``.
The stored value is `ievr1.` followed by base64url(iv, ciphertext, tag):

- The key is zero-padded to a multiple of 64 bytes and encrypted with AES-256-GCM
  (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:439#export function sealEvidenceReference(` ``).
- The encryption key is derived from `INTEL_EVIDENCE_REFERENCE_KEY`, a server
  secret that is not in the database. It has no fallback, and a value shorter
  than 32 characters is refused
  (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:401#const secret = process.env.INTEL_EVIDENCE_REFERENCE_KEY;` ``).
- The observation id is the additional authenticated data, and it also enters
  the synthetic IV
  (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:412#function referenceAad(observationId: string): Buffer {` ``).

What that gives, each property pinned by a test in §45.7:

- **No account id, in any substring or encoding.**
- **A double-tap still dedupes.** The same observation and object always
  produce the same value, so 2223's unique index works unchanged.
- **One photo on two observations gives two unrelated values.** A value
  derived from the key alone would have linked the weekly tokens 3002 keeps
  apart.
- **A reference moved onto another row does not open.**
- **Without the key, the capture refuses and stores nothing.** The refusal is
  `reference_key_unavailable`, which the route maps to 503
  `server_not_configured`
  (`` `artifacts/api-server/src/routes/mapObservations.ts:595#reference_key_unavailable: "server_not_configured"` ``).
  It is decided before any identity or observation read, so it tells the
  caller nothing about which observation ids exist.

Every existing gate is unchanged and still comes first: both flags, consent,
the observed-at clamp, the ownership proof, the owned-observation and subject
check, and retention. One gate was added after consent, Gate 2b (§45.5).

**B. The contributor's reader, through the byte gate.**
`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:567#export async function resolveEvidenceMediaForContributor(` ``
maps an evidence row back to its object. It applies two authorizations in
order:

1. **The row must be the viewer's own.** Its `actor_id` must be one of the
   values 3310's bridge derives from the viewer's account
   (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:585#if (!row || !row.actor_id || !new Set(identities.identities).has(String(row.actor_id))) {` ``).
2. **The byte gate must allow the object**
   (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:603#if (!(await authorizeMediaAccess(sc, viewerId, ref.bucket, ref.path))) {` ``).

The byte gate alone is not enough. For an avatar on a public profile, or a
photo that is also a public post, it serves the bytes to a stranger. Telling
that stranger which observation the photo backs would re-identify the
contributor. A missing row and another person's row get the same answer.

No route calls this reader. Serving evidence to anyone but its contributor is
still the moderation and visibility decision the module reserves, and lane I's
MD65 Question 5.

**C. Account deletion finds the bytes again.** The collection step now calls
`` `artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:669#collectOwnEvidenceObjectKeys(sc, userId, readAll)` ``.
That function reads the rows under every identity the account's rows may carry
(`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:642#for (const identity of identities.identities) {` ``)
and opens each reference.

- An opened key still passes the service's own guard: an allowed bucket, no
  `..`, and a path owner equal to the account being erased.
- A pre-seal plaintext row is still collected, so a legacy row's bytes are not
  orphaned.
- A reference that does not open fails the step, and the receipt carries the
  warning:
  `` `artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:680#if (unopenable > 0) throw new Error(` ``.

The edit is line-neutral. Every citation into the file below line 682 still
lands on its line.

**D. The seam writer stores no key:**
`` `artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:154#reference: null,` ``.
Nothing reads that column for seam rows. The link is `media_asset_id`, and
the bytes go at deletion through `media_assets`.

**E. Only one module may read `reference`.** The module that seals the value
is the only one that opens it. A new test scans all of `src/` outside tests
and migrations, not only `routes/` and `lib/`, and fails on any other file that
selects `reference` from `intel_evidence`. The old rule never saw
`services/`, which is why account deletion's parsing reader went unnoticed.

**F. Operator surface.**
- `INTEL_EVIDENCE_REFERENCE_KEY` is added to the optional boot keys in
  `lib/envValidation.ts`, so an unset key produces a named warning, and to
  `artifacts/api-server/.env.example`.
- The `reference` rationale in `lib/dataRights.ts` now says the value is sealed.

### §45.4 Existing stored rows, measured without a database

**Recorded facts:**

- **Production.** `intel_evidence` held 0 rows on 2026-09-07
  (`docs/architecture/intel-spine-liveness.md`) and 0 rows on 2026-09-26
  (`docs/sensing-contributor-identity-cutover-runbook.md` §3).
- **The route's flag.** Its row is absent from production (2026-09-21, above).
- **3002.** Not applied to production (the same runbook, §3).
- **portava-ci.** Every Map flag is FALSE there, `map_contributions_enabled`
  included (2026-09-20, `docs/ops/map-completion-checkpoint.md`).
- **No count anywhere.** No document records an `intel_evidence` row count for
  portava-ci.

**The answer, stated at its strength:**

- **No row with such a reference is recorded anywhere.**
- **Production.** None can have come from the map path while the flag row is
  absent.
- **Pre-3002 databases** (production, today) store the account id in
  `actor_id` itself, so a plaintext reference there discloses nothing new until
  3002 is applied. The exposure starts at 3002. 3002 relabels `actor_id` only,
  so on any database where the map path had written evidence, 3002 would leave
  those references naming their accounts.
- **What cannot be excluded without a read:** a row written after the last
  recorded read, on any database where both flags were on and a person had
  consented.

**The remediation is prepared, and nothing was run:**

| Step | What | Applied / run |
| --- | --- | --- |
| 1 | `artifacts/api-server/src/migrations/3360_intel_evidence_sealed_reference.sql`: adds a CHECK, NOT VALID, requiring every photo or video `reference` to be NULL or sealed. Also adds `intel_evidence_rekey_reference(uuid, text, text)`, which re-seals ONE row from exactly the plaintext value read. That function lifts the append-only row guard for that one UPDATE, as 3002 §5 did for `actor_id`. EXECUTE is granted to `service_role` only. | no database |
| 2 | `artifacts/api-server/src/scripts/rekeyIntelEvidenceReferences.ts`: a dry run by default that counts the rows and reads only. `--apply` seals each row with the server key and calls the function. It prints counts only, because every value it reads names an account. | not run |
| 3 | `artifacts/api-server/src/migrations/3361_intel_evidence_sealed_reference_validate.sql`: refuses to apply while any plaintext row remains. Otherwise it VALIDATEs the CHECK and drops the function. | no database |

- **Rollbacks** are in `db/rollback/`, one for each migration. Neither un-seals
  anything: the key is not in the database, and un-sealing would restore the
  defect.
- **Where production facts hold** (0 rows), 3360 and 3361 apply back to back and
  the script has nothing to do. A dry run is how an operator confirms that on
  the day.
- **Apply 3360 with or after the sealing code.** Pre-seal code writing a media
  evidence row against 3360's CHECK is refused and stores nothing.
- **Not executed against Postgres.** The shared rules forbid running SQL here,
  so both migrations and both rollbacks were checked by reading and by the
  static guards only. The riskiest statement is the `ALTER TABLE … DISABLE
  TRIGGER` inside a SECURITY DEFINER function. It is 3002 §5's pattern, moved
  into a function, and only a rehearsal can prove it.

### §45.5 Photos under a consent that names Quick Signals: a fail-closed gate, and the owner question it waits on

**Facts, on the base tree:**

- The evidence path accepted any valid intelligence consent. Gate 2 reads only
  `enabled` and `withdrawn_at`
  (`` `artifacts/api-server/src/lib/intelConsent.ts:61#.select("enabled, withdrawn_at")` ``).
- The only version the server stamps is v1
  (`` `artifacts/api-server/src/lib/intelConsent.ts:26#export const INTEL_CONSENT_DISCLOSURE_VERSION = "intel_contributions_v1";` ``).
- v1's words name Quick Signals and nothing else
  (`` `travel-buddy-standalone/src/lib/sensing/consentDisclosure.ts:60#Your Quick Signals can be combined` ``).
- The v2 text is not owner-approved and not in force, and its words
  (`docs/contracts/sensing-consent-disclosure-v2.md`, read 2026-09-27) do not
  name photos or videos either.
- The photo step on the map sheet says only "Answer one of these, then you can
  add a photo to it."
- **Production, read-only, by the integrator on 2026-09-27:**
  - `map_contributions_enabled` and `media_evidence_enabled` have no row;
  - `intel_evidence` has 0 rows;
  - `intel_capture_quick_signal` is true.

  Nothing has been kept. The gap was latent, and would have opened the day the
  map flag was turned on.

**Built on this branch, at the coordinator's request: Gate 2b, fail-closed and
decision-free.**

- **The rule.** A photo or video is kept as evidence only when the
  contributor's RECORDED `consent_version` is in an explicit list of versions
  whose words name photos:
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:211#const photos = await consentCoversPhotoEvidence(sc, actorId);` ``.
- **The list is EMPTY**
  (`` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:788#export const PHOTO_EVIDENCE_CONSENT_VERSIONS` ``).
  No version in force names photos. v2 was read and does not name them either,
  and it is not approved, so it is left out.
- **The refusal.** Every media contribution is refused with
  `consent_does_not_cover_photos`, HTTP 409
  (`` `artifacts/api-server/src/lib/http.ts:108#consent_does_not_cover_photos: 409,` ``).
  It is decided before any row is read or written, so nothing is stored: no
  evidence, and no observation.
- **The tap is unaffected.** It is a separate request on the observation arrow
  and never reaches this gate. The test asserts both halves:
  `` `artifacts/api-server/src/test/intelEvidenceReference.test.ts:660#it("under v1: the tap is recorded` ``.
- **What stayed unchanged.** No consent word, no consent version, no granted
  scope. `SENSING_ANON_GRANTED_SCOPES` is untouched.
- **A test seam.** It names a fictional covering version, so suites can still
  exercise the path after the gate. A test pins that no product file calls it.

**RED WHEN** a contributor holding only v1 (or v2, or no recorded version)
gets a photo or video kept, or a tap stops being recorded because of this gate.

**The owner step it waits on.** Approve disclosure words that name photos and
videos kept as evidence. Then ship, in ONE release:

- that version as `INTEL_CONSENT_DISCLOSURE_VERSION`;
- its words on the client;
- its string in `PHOTO_EVIDENCE_CONSENT_VERSIONS`.

**The question, exactly.** *May the map evidence path keep a person's photo or
video, attached to their own report, under an Intelligence Contributions
consent whose words do not mention photos? If not, which of these should the
product do?* Each answer now maps onto the gate:

| Option | What it permits | What it costs, and where |
| --- | --- | --- |
| **A. A disclosure version that names photos.** Draft words for the owner to edit: *"If you add a photo or video to a report, Portava keeps it with that report as evidence. It is not shown to other people, is kept for up to 180 days, and is deleted with your account."* | Photos are stored only for people whose recorded `consent_version` carries those words. Everyone on v1 is refused photo evidence until they re-consent (the gate's current answer); their taps are unaffected. | Owner-approved copy, then the one release above. The client's existing `needsReconsent` prompts the re-consent. |
| **B. A per-photo notice on the photo step,** on top of the standing consent. The same words are shown before upload. | Anyone with valid consent, v1 included, may attach a photo after seeing words that name photos, once per photo. No re-consent campaign is needed. | Owner-approved sheet copy. A strict-schema field on the media payload of `POST /api/map/observations` saying which notice was shown, with the notice version recorded in `intel_evidence.detail`. Gate 2b would accept that field in place of a listed consent version. Not built. |
| **C. Rule that v1 already covers it.** Read *"Portava uses your contribution"* as including an attached photo. | Photos kept under v1. | One string, `intel_contributions_v1`, added to the list, as the owner's recorded ruling. Lane I and this lane both flag the words as not covering it. |
| **D. Store no photo until A or B exists.** | Nothing is stored. | None: this is the gate's behaviour today. The client still offers the photo step (§45.9 item 5). |

Nothing is live today. The path is behind a flag whose row is absent in
production, and it also needs `INTEL_EVIDENCE_REFERENCE_KEY`.

### §45.6 Rows

| id | was | now | why |
| --- | --- | --- | --- |
| M154 | C | **C** | Re-evidenced; does not move. The Evidence stage still attaches only to an existing, owned observation. It now stores a reference that names no account: `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:224#const resolved = resolveAndSealOwnedMediaReference(` ``, pinned by `` `artifacts/api-server/src/test/intelEvidenceReference.test.ts:241#it("no stored reference, for forty accounts, contains any account id in any substring or encoding"` ``. Before this section the C never asked whose identity the stored row carries, and from 3002 on the row carried the account (§45.1), the same gap the port's cache note found for M203–M210. Under §21's stated convention (code that is correct and would run), activation is not graded. Activation now needs `INTEL_EVIDENCE_REFERENCE_KEY` as well as both flags and consent, and, for a photo to be kept at all, an owner-approved disclosure version in Gate 2b's list (§45.5). |

**For census-sensing's integrator, not restated here, because the rows are not
this census's.** census-sensing §27.5 grades S118 ("the stored side cannot be
reverse-linked to an account") W with implementation "complete".

- **S118's "complete" was not true on the base tree.** This column
  reverse-linked every map-evidenced observation once 3002 applied.
- **On this branch it holds for the map path.**
- **It does not hold for the media seam's callerless writer,** whose
  `media_asset_id` still joins to `media_assets.owner_user_id`. That half is
  census-media §35.4, MD65 Question 3, an owner decision.
- **S19** (no permanent profile foreign key in a contribution record) was
  touched only in spirit. The key was a stored account id, not a foreign key.

Neither verdict moves: both wait on the production cutover.

### §45.7 Mutations, each seen red, every file restored byte-identical

Each mutation was applied to the final tree, the named suites were run, and the
file was restored and compared byte for byte (`filecmp`, then `sha256sum -c`
over all five mutated files).

| # | Mutation | File | Went red |
| --- | --- | --- | --- |
| mutation X1 | THE FIX OUT: Gate 5 stores the plain key again | `lib/intelEvidenceCapture.ts` | 5: forty-accounts no-uuid; two observations unrelated; no-key refusal; and mapMediaEvidence's "stores a SEALED storage key" and "writes exactly one intel_evidence row" |
| mutation X2 | seal not bound to its observation (AAD and IV without the id) | same | 4: unrelated across observations; two observations unrelated; moved reference refused; deletion's unopenable case |
| mutation X3 | reader's contributor check removed | same | refuses a stranger the byte gate alone would serve |
| mutation X4 | reader's byte gate removed | same | refuses the contributor an object the byte gate refuses |
| mutation X5 | deletion reads the account id only, no tokens | same | 3: every-identity collection; unopenable case; no-key case |
| mutation X6 | deletion treats a sealed value as a plain key | same | the same 3 |
| mutation X7 | deletion swallows an unopenable reference | `services/accountDeletion/AccountDeletionService.ts` | 2: unopenable case; no-key case |
| mutation X8 | a constant fallback key | `lib/intelEvidenceCapture.ts` | 4: no-fallback codec case; reader's "says why"; remediation refuses without a key; capture's no-key refusal |
| mutation X9 | a second reader selects `reference` | `lib/media/mediaEvidenceLink.ts` | 2: this lane's one-module scan and mapMediaEvidence's existing "no route and no serving library" scan |
| mutation X10 | seam writer mirrors the storage path again | same | the seam writer stores no storage key |
| mutation X11 | padding no longer hides the key's length | `lib/intelEvidenceCapture.ts` | 5: length hidden; forty-accounts no-uuid; round trip; both reader cases that open a reference |
| mutation G1 | GATE 2b OUT: the consent-coverage line removed | `lib/intelEvidenceCapture.ts` | 3: under v1 the photo is refused and the tap recorded; the recorded version is what decides; no version or a withdrawn grant keeps nothing |
| mutation G2 | v1 added to the shipped list | same | 2: the shipped list is empty; under v1 the photo is refused |
| mutation G3 | the gate ignores the recorded version | same | 2: the recorded version is what decides; no version keeps nothing |
| mutation G4 | the refusal is not a 409 | `lib/http.ts` | the route answers it as HTTP 409 |
| mutation G5 | a product file calls the test seam | `routes/mapObservations.ts` | no product code widens the list through the test seam |

The suite is `artifacts/api-server/src/test/intelEvidenceReference.test.ts`
(26 cases, registered on the `test` line). The existing `mapMediaEvidence`,
`intelContributorConsentBridge`, `accountDeletionEvidenceMedia`,
`accountDeletionPagination`, `mediaEvidenceSeam`, `mapObservations` and
`dataRights` suites stay green. The two that drive a successful capture now
configure a key, as a deployment must, and give their consenting contributors
the fictional covering version, because they test what happens after Gate 2b.

### §45.8 Checks, and the stale files this lane leaves for the integrator

Everything was run on Node 24 at the lane's final tree.

**Passing:**

- `typecheck` is clean. `typecheck:tests` has 863 diagnostics across 115 files,
  which is the baseline and not above it.
- `check:doc-citations` is clean. The UNANCHORED count is 6356 (ceiling 6434);
  this section adds 31 anchored citations and no unanchored one.
- `check:citation-targets` is at its ceiling, 165 / 165.
- These pass: `check:census-integrity`, `check:census-row-move-labels`,
  `check:test-registration`, `check:security-definer-oracles`,
  `check:schema-references`, `check:writerless-reads`, `check:enum-literals`.
- `check:census-scope-coverage` passes. census-map cites 120 files and watches
  120, which is 100%.
- The touched and adjacent suites pass: 49 files, 1072 tests. Seven
  error-envelope suites also pass (122 tests), for the new 409 code in
  `lib/http.ts`.

**Failing, as expected:**

- `check:all` fails only on the five live-database checks (write-path-columns,
  missing-live-columns, authorization-contract, media-objects,
  rank-events-surfaces) and on `check:census-freshness`.

**Stale files.** `check:census-freshness` names three censuses and three
files. The acknowledgement ledger is the integrator's, so each is listed with
its argument:

- census-map, `artifacts/api-server/src/test/intelEvidenceReference.test.ts`.
  The file is new, and this lane added it to census-map's scope as M154's
  evidence. §45.6 re-reads M154 against it.
- census-trust, `lib/envValidation.ts`. One OPTIONAL key is appended to line 44.
  No required key, boot exit or trust verdict changes.
- census-trips and census-trust, `lib/http.ts`. One error code,
  `consent_does_not_cover_photos` (409), is appended on two existing lines
  (the union and the status map). No existing code, status, retryable set or
  sanitised set changes, and no trips or trust route emits it.

**Changed but already named by an existing acknowledgement.** The check
cannot tell this lane's change from the one that was acknowledged, so each is
argued here:

- `lib/intelEvidenceCapture.ts` and `routes/mapObservations.ts` (census-map;
  census-sensing and census-highlights-memories also watch the route). This
  section re-reads M154, the row that grades the capture module. The route
  change is one reason-to-status mapping added on an existing line, and it
  alters no other row's evidence.
- `services/accountDeletion/AccountDeletionService.ts` (census-trust,
  census-layover, census-highlights-memories, census-wall, census-sensing). One
  collection step now reads under every stored identity and opens sealed
  references. The edit is line-neutral, and no other step changes.
- `lib/dataRights.ts` (census-sensing). One rationale string changes. The
  classification does not.
- `lib/media/mediaEvidenceLink.ts` (census-media). The callerless seam writer
  stores `reference: null`. No MD row moves (census-media §39).
- `docs/architecture/telegraph-phase0-inventory.md` (census-telegraph). It was
  regenerated because the migration count went from 607 to 609. Neither new
  migration touches a messaging table.

This section does not restate the census headline, because no row moved.

### §45.9 Found while doing it, recorded and not fixed

1. **The seam's `media_asset_id` is still a derivable account link**
   (§45.6). It is MD65 Question 3's to decide, and the writer has no caller.
2. **There is no key-rotation tool.** Rotating the key orphans every sealed
   reference from account deletion until each row is re-sealed under the new
   key. Both `.env.example` and the module say to treat the key as stable.
3. **The photo sheet shows no retention or visibility words** (§45.5).
   Whichever option the owner picks decides this copy.
4. **3360's function has not been rehearsed** (§45.4). Rehearse it on
   portava-ci before any database it is applied to holds a plaintext row.
5. **The client does not know about Gate 2b.** Once the map flag is on and
   while the list is empty, the sheet still offers the photo step. It uploads
   the bytes through `POST /api/media/upload` before the attach is refused, and
   after the 409 it offers "Try attaching it again", which is refused again.
   - The uploaded object is the person's own, referenced by nothing. Like any
     abandoned upload, account deletion does not find it (see the
     AccountDeletionService header).
   - Before the map flag is turned on, the client should not offer the step
     while the person's consent does not cover photos. That needs a coverage
     bit on the consent state and a client change. Neither is built here.
6. **The media seam's writer has no consent check of any kind.** It has no
   caller, and it must pass Gate 2b the day one is wired (MD65).

### §45.10 Cited, not graded (check:census-scope-coverage)

- NOT-GRADED: artifacts/api-server/src/routes/posts.ts — the upload route, cited in §45.1 and §45.2 only for the shape of the key it mints (`<account>/<ms>.<ext>`) and for its fire-and-forget canonical write; no Map row grades media upload, and the evidence verdict rests on lib/intelEvidenceCapture.ts, which this census watches.
- NOT-GRADED: artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql — the Sensing migration whose tokenised contributor id defines the exposure; census-sensing grades it (S19, S97, S111, S118) and watches it, and no Map row rests on it.
- NOT-GRADED: artifacts/api-server/src/lib/mediaAccess.ts — the byte gate, cited in §45.2 for its read of media_assets.owner_user_id and in §45.3 as the second authorization of the contributor reader; census-media grades it, and M154 rests on the capture module and its test, not on the gate.
- NOT-GRADED: artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts — account deletion's evidence collection step, cited in §45.1 and §45.3 as the reader this lane repaired; the deletion service is graded by census-trust and the other censuses that watch it, and no Map row grades erasure.
- NOT-GRADED: artifacts/api-server/src/lib/media/mediaEvidenceLink.ts — Media's callerless evidence seam, cited in §45.1, §45.3 and §45.6 for its reference column; census-media grades it (MD53, MD65), and no Map row does.
- NOT-GRADED: artifacts/api-server/src/lib/http.ts — the shared error envelope, cited in §45.5 and §45.7 only for the 409 status of the new consent_does_not_cover_photos code; census-trips and census-trust watch it, and no Map row grades the envelope.
- NOT-GRADED: artifacts/api-server/src/lib/intelConsent.ts — cited in §45.5 for which consent columns the gate reads and which version the server stamps; census-sensing grades consent, and §45.5 is an owner question, not a verdict.
- NOT-GRADED: travel-buddy-standalone/src/lib/sensing/consentDisclosure.ts — cited in §45.5 for the words of consent v1; census-sensing grades the disclosure, and §45.5 moves no row.
- NOT-GRADED: artifacts/api-server/src/migrations/3360_intel_evidence_sealed_reference.sql — the remediation migration, applied to no database, cited in §45.4 as prepared work; M154 rests on the application's seal, which it does not depend on.
- NOT-GRADED: artifacts/api-server/src/migrations/3361_intel_evidence_sealed_reference_validate.sql — the remediation's closing migration, applied to no database, cited in §45.4 only.
- NOT-GRADED: artifacts/api-server/src/scripts/rekeyIntelEvidenceReferences.ts — the remediation script, not run, cited in §45.4 only.
- NOT-GRADED: artifacts/api-server/src/lib/envValidation.ts — cited in §45.3 for the boot warning naming the new key; census-trust watches it, and no Map row grades boot configuration.
- NOT-GRADED: artifacts/api-server/src/lib/dataRights.ts — cited in §45.3 for the updated rationale text of intel_evidence.reference; the classification itself is unchanged and no Map row grades it.

### §45.11 3360 and 3361, rehearsed on the local harness (and lane P's 3350–3352, at the coordinator's request)

This supersedes two statements above: §45.4's "Not executed against
Postgres", and §45.9 item 4, which asked for portava-ci. The coordinator
directed the repo's LOCAL harness instead. **Nothing ran on portava-ci or on
production.** No flag was touched.

**Where it ran.**

- The harness's own scripts, `scripts/local-db/up.sh` and then
  `scripts/local-db/run-tests.sh`, on a dedicated cluster so that no other
  lane's cluster was touched: `LOCAL_DB_DIR=/tmp/portava-local-db-lanex`,
  `LOCAL_DB_PORT=54371`, database `portava_local`.
- **PostgreSQL 16.13** (Ubuntu 16.13-0ubuntu0.24.04.1). Production reads
  17.6 (the integrator's read). Nothing rehearsed here depends on the
  difference; §45.11.3 says what 3350 needs from both.
- up.sh's own line, on the final tree:
  `local-db: ready (booted): postgresql://postgres@127.0.0.1:54371/portava_local — baseline 388 tables; chain from 2093: 329 applied in order, 12 known-unreplayable of 341, 2 of those applied on retry`.
  3350–3352 (in their reshaped form), 3359 and 3360–3361 are not among the
  skipped.
- run-tests.sh's own lines:

  ```
      ok 1 - 1. on a table with no plaintext row, 3360 then 3361 leave the CHECK validated and the function dropped
      ok 2 - 2. rollbacks unwind in order (3360's refuses first), and 3360 applies on top of plaintext rows
      ok 3 - 3. the CHECK refuses a NEW plaintext photo or video reference, and admits sealed, NULL and a text_note
      ok 4 - 4. the re-seal function is service_role's only, and changes exactly ONE row
      ok 5 - 5. an EXCEPTION between the DISABLE and the ENABLE leaves the guard enabled, aborted or caught
      ok 6 - 6. 3361 refuses while a plaintext row remains, changing nothing; then validates and drops the function
      ok 7 - 7. both rollbacks run cleanly afterwards, in order
  ok 1 - census-map §45.11 — migrations 3360 and 3361, rehearsed on real PostgreSQL
  # tests 143
  # pass 143
  # fail 0
  # skipped 0
  local-db tests: pass=143 fail=0 skipped=0 (exit 0)
  ```

#### §45.11.1 What the suite proves, against the database

The suite is `artifacts/api-server/src/test/db/intelEvidenceSealedReference.db.test.ts`
(7 cases, registered on the `test` line, where it skips without a database like
every `src/test/db` suite).

- **It applies each migration the way the runner does.** It uses the runner's
  own classifier and its own statement,
  `` `scripts/src/apply-migrations.ts:1253#export function buildApplyStatement(args: {` ``,
  so the body and its ledger row are one transaction:
  `` `artifacts/api-server/src/test/db/intelEvidenceSealedReference.db.test.ts:92#function runnerApply(filename: string, sql: string)` ``.
- **The CHECK** refuses a new plaintext photo or video reference. It admits a
  sealed one, a NULL one and a plaintext `text_note`.
- **The re-seal function** is refused to `anon` and `authenticated`
  ("permission denied for function"). Under `service_role` it re-seals the
  named row and leaves a second row holding the same plaintext value on
  another observation untouched. A stale call returns false and changes
  nothing. A value of the wrong shape is refused. A direct UPDATE afterwards is
  still refused by the append-only guard.
- **The `DISABLE TRIGGER` is re-enabled on every path.** `pg_trigger.tgenabled`
  reads `O` after a success, a stale call and a refusal. It also reads `O` after
  a unique violation raised between the DISABLE and the ENABLE, both when that
  aborts the statement and when a caller catches it and reads the trigger in
  the same transaction:
  `` `artifacts/api-server/src/test/db/intelEvidenceSealedReference.db.test.ts:319#caught:O` ``.
  PostgreSQL's subtransaction rollback undoes the DISABLE with the UPDATE.
- **3361** refuses while a plaintext row remains, and validates nothing, drops
  nothing and writes no ledger row:
  `` `artifacts/api-server/src/test/db/intelEvidenceSealedReference.db.test.ts:329#a refused 3361 wrote no ledger row` ``.
  Once every row is sealed it validates the CHECK and drops the function.
- **Both rollbacks** run cleanly afterwards, in order, and 3360's refuses to
  run first.

#### §45.11.2 Found by the rehearsal, and fixed: a rolled-back file stayed "applied"

The runner writes a `schema_migration_ledger` row in each file's own
transaction. Neither rollback removed it. So after a rollback, the runner's
next plan would have taken 3360 or 3361 as applied and never re-applied it.
Each rollback now deletes its own file's row, and its postcondition refuses to
commit if the row is still there:
`` `db/rollback/2026-09-27-3360-intel-evidence-sealed-reference-rollback.sql:53#DELETE FROM public.schema_migration_ledger` ``,
`` `db/rollback/2026-09-27-3361-intel-evidence-sealed-reference-validate-rollback.sql:122#DELETE FROM public.schema_migration_ledger` ``.
This is the convention of the 10 rollbacks in `db/rollback/` that already do
so. The other 110 do not, and lane P's three are among them (§45.11.3).

#### §45.11.3 Lane P's 3350, 3351 and 3352, applied the way the runner applies them

At the coordinator's request, after merging `wave8-integration` at
`2a60f9c3b` (lane P's 3350 reshaped into one BEGIN…COMMIT with its
postcondition after the COMMIT). None of those files was changed by this lane.

- **The chain, stopped before 3350** (`LOCAL_DB_TO=3350`):
  `local-db: ready (booted): postgresql://postgres@127.0.0.1:54371/portava_local — baseline 388 tables; chain from 2093 to before 3350: 319 applied in order, 12 known-unreplayable of 331, 2 of those applied on retry`.
- **Then the runner's own code** (`classifyMigration`, `buildApplyStatement`,
  `runPlan`). Each statement was sent as ONE query string (`psql -c`), as the
  Management API receives one `query`: body and ledger row in one transaction,
  then any postcondition tail in its own. The rollbacks ran newest first, with
  `psql -f`. The script's output, with its column-header and `(1 row)` lines
  dropped:

  ```
  server_version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
    [state before] 0 |  | 0 | 0 |
  classify 3350_media_neighborhood_only_location_mode.sql: unwrapped, postconditions after COMMIT
  classify 3351_media_find_busier_flag.sql: unwrapped, postconditions none (inside the transaction)
  classify 3352_media_perspective_vantage.sql: unwrapped, postconditions none (inside the transaction)
    [3350 apply exit 0] (no output)
    [3350 postcondition exit 0] NOTICE:  3350: neighborhood_only label present; 0 post(s) carry it on this database (0 on a first apply).
    [3351 apply exit 0] (no output)
    [3352 apply exit 0] NOTICE:  3352: posts.perspective_vantage present; 0 post(s) carry a vantage on this database (0 on a first apply).
  outcome 3350_media_neighborhood_only_location_mode.sql: applied
  outcome 3351_media_find_busier_flag.sql: applied
  outcome 3352_media_perspective_vantage.sql: applied
  ledger checksum matches file bytes 3350_media_neighborhood_only_location_mode.sql: t
  ledger checksum matches file bytes 3351_media_find_busier_flag.sql: t
  ledger checksum matches file bytes 3352_media_perspective_vantage.sql: t
    [state after apply] 1 | media_find_busier_enabled=false,media_neighborhood_only_mode_enabled=false,media_perspective_vantage_enabled=false | 1 | 1 | 3350_media_neighborhood_only_location_mode.sql:manual,3351_media_find_busier_flag.sql:manual,3352_media_perspective_vantage.sql:manual
    [rollback 3352 exit 0] (no output)
    [state after rollback 3352] 1 | media_find_busier_enabled=false,media_neighborhood_only_mode_enabled=false | 0 | 0 | 3350_media_neighborhood_only_location_mode.sql:manual,3351_media_find_busier_flag.sql:manual,3352_media_perspective_vantage.sql:manual
    [rollback 3351 exit 0] (no output)
    [state after rollback 3351] 1 | media_neighborhood_only_mode_enabled=false | 0 | 0 | 3350_media_neighborhood_only_location_mode.sql:manual,3351_media_find_busier_flag.sql:manual,3352_media_perspective_vantage.sql:manual
    [rollback 3350 exit 0] (no output)
    [state after rollback 3350] 1 |  | 0 | 0 | 3350_media_neighborhood_only_location_mode.sql:manual,3351_media_find_busier_flag.sql:manual,3352_media_perspective_vantage.sql:manual
  ```

  The state columns are: the `neighborhood_only` label count, the three flags,
  the `posts.perspective_vantage` column, its CHECK, and the ledger rows.
- **What it shows.**
  - All three applied, their postconditions held, and all three flags were
    seeded FALSE. The ledger checksums match the files' bytes.
  - 3350's `ALTER TYPE … ADD VALUE` ran inside the runner's transaction on 16.
    Both 16 and 17 allow ADD VALUE in a transaction block (since 12). Neither
    allows USING the new label before COMMIT, and 3350's reshaped form does
    not: its only comparison is in the tail, after the COMMIT, on `::text`.
  - Each rollback exited 0 and removed what its header says it removes.
- **Recorded for lane P, not changed here.**
  - 3350's rollback leaves the enum label, as its header says (PostgreSQL has
    no `DROP VALUE`).
  - **All three rollbacks leave their ledger rows** (`applied_by` manual). The
    runner would therefore never apply 3350, 3351 or 3352 again after a
    rollback. This is the gap §45.11.2 closed for 3360 and 3361.
- **The same runner-shaped run for this lane's own files**, on the same
  database afterwards, with the rollbacks as they stood before §45.11.2:
  - 3360 and 3361 classified `unwrapped` with no tail, and both applied
    (`exit 0`, no output) with ledger checksums matching the files;
  - then the CHECK read `validated=true`, the function was gone, and the guard
    read `O`;
  - after the 3361 rollback: `validated=false`, the function back, guard `O`;
  - after the 3360 rollback: no CHECK, no function, guard `O`, and the ledger
    still listing both files as applied. That last line is what exposed
    §45.11.2.

#### §45.11.4 SQL mutations, each seen red on the harness, every file restored byte-identical

Each mutation was applied to one of the four SQL files, the suite was run
against the harness, and the file was restored (`filecmp`, then
`sha256sum -c` over all four: OK). The unmutated run after them: 7/7.

| # | Mutation | File | Cases red (of 7) |
| --- | --- | --- | --- |
| mutation S1 | the CHECK admits a plaintext photo or video | 3360 | 2: the CHECK case; 3361's refusal |
| mutation S2 | the CHECK added VALID (NOT VALID removed) | 3360 | 7 |
| mutation S3 | anon and authenticated may execute the function (revokes and their postcondition removed) | 3360 | 1: the service_role-only case |
| mutation S4 | the guard is not re-enabled after the UPDATE | 3360 | 4 |
| mutation S5 | the exception is swallowed between DISABLE and ENABLE | 3360 | 1: the exception-path case |
| mutation S6 | the re-seal is not limited to the named row | 3360 | 2: the exactly-one-row case; 3361's case |
| mutation S7 | 3361's plaintext precondition removed | 3361 | 1: 3361's refusal |
| mutation S8 | 3361 does not drop the function | 3361 | 7 |
| mutation S9 | 3360's rollback runs while 3361 is applied | 3360 rollback | 6 |
| mutation S10 | 3360's rollback leaves the function | 3360 rollback | 5 |
| mutation S11 | 3361's rollback does not re-create the function | 3361 rollback | 5 |
| mutation S12 | 3360's rollback keeps its ledger row (DELETE and its postcondition removed) | 3360 rollback | 6 |
| mutation S13 | 3361's rollback keeps its ledger row (DELETE and its postcondition removed) | 3361 rollback | 5 |

A red count above the named case includes later cases that fail because the
table was left in the wrong shape. The suite's `before` resets that shape
without reading the migration files, so a mutated file cannot leave the next
run stuck.

#### §45.11.5 Lane V's 3359, applied the way the runner applies it, and its rollback both ways

At the coordinator's request, after merging `wave8-integration` at
`1a5164fc3`, which carries lane V's 3359 (`passport_postcards.media_url` loses
NOT NULL). 3359 and its rollback were not changed by this lane.

- **The chain, stopped before 3359** (`LOCAL_DB_TO=3359`):
  `local-db: ready (booted): postgresql://postgres@127.0.0.1:54371/portava_local — baseline 388 tables; chain from 2093 to before 3359: 326 applied in order, 12 known-unreplayable of 338, 2 of those applied on retry`.
- **Then** one throwaway account and three posts were seeded, 3359 was applied
  through the runner's own `classifyMigration`, `buildApplyStatement` and
  `runPlan` (one query string, body and ledger row in one transaction), and
  the rollback was run with `psql -f`, first with a NULL cover present and
  then with none. The "resolve" step stands in for the operator's deliberate
  resolution that the rollback's message asks for: it deletes the one NULL-cover
  row. The script's output, verbatim except that each `DETAIL: Failing row
  contains (…)` line and the worktree prefix of the rollback's path are
  shortened here:

  ```
  server_version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
    [state before] media_url is_nullable=NO | null covers=0 | ledger 3359=none
    [NULL cover BEFORE 3359 exit 1] ERROR:  null value in column "media_url" of relation "passport_postcards" violates not-null constraint
    [NULL cover BEFORE 3359 exit 1] DETAIL:  Failing row contains (…).
    [non-NULL cover BEFORE 3359 (control) exit 0] (no output)
  classify 3359_passport_postcard_cover_nullable.sql: unwrapped, postconditions none (inside the transaction)
    [3359 apply exit 0] (no output)
  outcome 3359_passport_postcard_cover_nullable.sql: applied
  ledger checksum matches file bytes: t
    [state after 3359] media_url is_nullable=YES | null covers=0 | ledger 3359=manual
    [NULL cover AFTER 3359 exit 0] (no output)
    [state with a NULL cover] media_url is_nullable=YES | null covers=1 | ledger 3359=manual
    [rollback WITH a NULL cover exit 3] psql:…/db/rollback/2026-09-27-3359-passport-postcard-cover-nullable-rollback.sql:30: ERROR:  ROLLBACK REFUSED: 1 passport_postcards row(s) have no cover (media_url IS NULL). Restoring NOT NULL would need a value, and the only one available is a held or removed file. Resolve those rows deliberately first, then re-run this file.
    [rollback WITH a NULL cover exit 3] CONTEXT:  PL/pgSQL function inline_code_block line 6 at RAISE
    [state after the refused rollback] media_url is_nullable=YES | null covers=1 | ledger 3359=manual
    [resolve: delete the NULL-cover row exit 0] (no output)
    [rollback with NO NULL cover exit 0] (no output)
    [state after the rollback] media_url is_nullable=NO | null covers=0 | ledger 3359=manual
    [NULL cover AFTER the rollback exit 1] ERROR:  null value in column "media_url" of relation "passport_postcards" violates not-null constraint
    [NULL cover AFTER the rollback exit 1] DETAIL:  Failing row contains (…).
    [cleanup exit 0] (no output)
  ```

- **What it shows.**
  - Before 3359 a NULL cover is refused by the column (a non-NULL one, the
    control, is written). After it, a NULL cover is written.
  - With a NULL cover present, the rollback refuses (psql exit 3) and changes
    nothing: the column stays nullable and the row stays.
  - With none, it restores NOT NULL, and a NULL cover is refused again.
- **Recorded for lane V, not changed here.** Like lane P's three (§45.11.3),
  3359's rollback leaves its ledger row (`applied_by` manual). After that
  rollback the runner would never apply 3359 again.

### §45.12 The server says whether a photo would be kept, and the map offers the photo step only then

This supersedes §45.9 item 5 and the client clause in §45.5's option D.

**Server.**

- `GET` and `PUT /v1/intel/consent` now carry `coversPhotoEvidence`:
  `` `artifacts/api-server/src/routes/intel.ts:177#res.json(withPhotoEvidenceCoverage(out.state));` ``.
- **It is Gate 2b's own predicate**, not a copy:
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:852#export function photoEvidenceCoveredBy(` ``.
  The gate calls the same function:
  `` `artifacts/api-server/src/lib/intelEvidenceCapture.ts:822#if (!photoEvidenceCoveredBy(state, allowed))` ``.
  The bit is true only for an enabled, unwithdrawn grant whose RECORDED
  `consent_version` is in `PHOTO_EVIDENCE_CONSENT_VERSIONS`. That list is
  empty, so the bit is false for every account today. Nothing invents
  coverage.
- **An unreadable consent row** still answers 500, and carries no bit at all.
- **Tests:** four cases in section G of the capture suite. The last asserts
  the route's answer equals the gate's outcome for every state:
  `` `artifacts/api-server/src/test/intelEvidenceReference.test.ts:852#the route's answer and the gate's answer are the same for every state` ``.

**Client.**

- **The predicate reads the server's answer and nothing else:**
  `` `travel-buddy-standalone/src/features/map/truth/photoEvidenceCoverage.ts:37#return state.coversPhotoEvidence === true;` ``.
  It never derives coverage from a version string on the device, because
  which words name photos is the server's list.
- **The hook** reads the consent once each time capture is enabled, and not
  at all while it is off:
  `` `travel-buddy-standalone/src/hooks/usePhotoEvidenceCoverage.ts:24#if (!enabled) return;` ``.
- **The map passes the picker to the sheet only on the server's yes:**
  `` `travel-buddy-standalone/app/map/index.tsx:792#const requestContributionMedia = photoEvidenceCovered ? pickContributionMedia : undefined;` ``.
  Without a picker the sheet has no photo step
  (`` `travel-buddy-standalone/src/components/map/MapContributionSheet.tsx:199#const mediaOffered = onRequestMedia != null` ``),
  so nothing is uploaded and no orphan object is created.
- **The client type** gains the optional field:
  `` `travel-buddy-standalone/src/services/intelConsent.ts:25#coversPhotoEvidence?: boolean;` ``.
- **FAIL-CLOSED.** The step is withheld when the bit is false, absent (an
  older server), not a boolean, when the read returns nothing or throws, and
  when the grant is disabled or withdrawn. Until the read lands, it is hidden.
  A consent granted elsewhere while the map stays mounted is seen on the next
  mount, which is the safe direction.
- **Line-neutral.**
  - `app/map/index.tsx`: lines 69, 722 and 792 are extended in place. Lane I's
    `onRequestMedia={requestContributionMedia}` stays on line 2905, and no
    cited line moves.
  - `services/intelConsent.ts`: line 25 is extended in place.
  - `routes/intel.ts`: lines 177 and 189 are extended in place, and the import
    is appended after the file's last line. The PUT keeps its old answer when
    the write succeeded but the read-back did not: no state, so no bit.
- **Tests:**
  - the screen:
    `` `travel-buddy-standalone/app/map/__tests__/photoStepCoverage.component.test.tsx:411#is withheld when the server says it would not` ``,
    6 cases;
  - the predicate:
    `` `travel-buddy-standalone/src/features/map/truth/__tests__/photoEvidenceCoverage.test.ts:34#only a boolean true counts` ``,
    4 cases;
  - the sheet without a picker:
    `` `travel-buddy-standalone/src/components/map/__tests__/MapContributionSheet.mediaEvidence.component.test.tsx:282#the tap is reported, the photo step is never announced, and nothing is uploaded` ``.

**RED WHEN** the map offers the photo step, or starts an upload, for an
account whose consent read did not answer `coversPhotoEvidence: true`; or the
server answers true for a version that is not in Gate 2b's list.

**Orphans before this change.** None can exist in production from this path:
`map_contributions_enabled` has no row there (§45.5, the integrator's read of
2026-09-27).

| # | Mutation | File | Went red |
| --- | --- | --- | --- |
| mutation G6 | the consent read is not decorated with the bit | `routes/intel.ts` | 3: the shipped list says false; the recorded version decides; route and gate agree |
| mutation G7 | the bit is true whatever the list says | `lib/intelEvidenceCapture.ts` | 3: the shipped list says false; the recorded version decides (route and gate) |
| mutation C1 | the picker is handed to the sheet unconditionally | `app/map/index.tsx` | 4: withheld on false, on absent, on unreadable, on a throw |
| mutation C2 | the consent is read while capture is off | the hook | 1: no read while capture is off |
| mutation C3 | a valid grant alone offers the step (the bit ignored) | the predicate | 4: withheld on false and on absent (screen); a v1 grant without the yes; only a boolean true |
| mutation C4 | any truthy bit counts | the predicate | 1: only a boolean true |
| mutation C5 | the sheet offers the step without a picker | `MapContributionSheet.tsx` | 1: no picker, no step, no upload |

Every mutated file was restored and compared byte for byte (`filecmp`, then
`sha256sum -c`).

### §45.13 Cited, not graded, by §45.11 and §45.12 (check:census-scope-coverage)

- NOT-GRADED: artifacts/api-server/src/routes/intel.ts — the consent read and write, cited in §45.12 only because they now carry the derived coverage bit; census-sensing and census-highlights-memories watch it, census-sensing grades consent, and no Map row rests on it.
- NOT-GRADED: travel-buddy-standalone/src/services/intelConsent.ts — the client consent service, cited in §45.12 for the optional coversPhotoEvidence field on its state type; the consent flow is census-sensing's, and no Map row rests on this file.
- NOT-GRADED: scripts/src/apply-migrations.ts — the migration runner, cited in §45.11 for the statement the rehearsal reuses so that each file and its ledger row are one transaction; no Map row grades how migrations are applied.
- NOT-GRADED: db/rollback/2026-09-27-3360-intel-evidence-sealed-reference-rollback.sql — the remediation's first rollback, run only on the local harness, cited in §45.11 for its ledger-row removal; no verdict rests on it.
- NOT-GRADED: db/rollback/2026-09-27-3361-intel-evidence-sealed-reference-validate-rollback.sql — the remediation's second rollback, run only on the local harness, cited in §45.11 for its ledger-row removal; no verdict rests on it.

### §45.14 Checks for §45.11–§45.13, and the stale files this round leaves

Everything was run on Node 24 at the lane's final tree, after merging
`wave8-integration` at `1a5164fc3`.

**Passing:**

- **Server.** `typecheck` is clean. `typecheck:tests` has 863 diagnostics
  across 115 files, the baseline.
- **Client.** `typecheck` (with the import-extension check) is clean.
  `typecheck:tests` has 173 across 60, the baseline. eslint reports 0 errors
  on the seven touched client files; its 59 warnings are unused
  eslint-disable directives already in `app/map/index.tsx`. Every `lint:*`
  script and `check:route-registry` pass.
- `check:doc-citations` is clean. The UNANCHORED count is 6372 (ceiling 6434).
  §45.11–§45.13 add 18 anchored citations and no unanchored one.
- `check:citation-targets` is at its ceiling, 165 / 165.
- `check:census-scope-coverage` passes. census-map cites 127 files and watches
  127 (100%), with 20 declared NOT-GRADED.
- These pass: `check:census-row-move-labels`, `check:test-registration` (1491
  registered), `check:security-definer-oracles`, `check:schema-references`,
  `check:writerless-reads`, `check:enum-literals`.
- **The harness:** 143/143, skipped 0 (§45.11).
- **The client suites:** jest 5 suites, 51/51; the predicate's node suite, 4/4.

**Failing, and not this lane's:**

- **The touched and adjacent server suites:** 53 files, 1196 tests, 1195 pass.
  The one failure is a date bomb in
  `accountDeletionSensingRevocationReach` ("one reference removed (P2)",
  2 !== 1).
  - Its fixture pins NOW to 2026-09-26T07:00Z, and its "standing" snapshot
    expires at NOW + 24 h, so it has read as withdrawn since 07:00 UTC today.
  - With the clock moved back one day (`CLOCK_OFFSET_DAYS=-1` through
    the repo's clock-offset preload) the same suite is 14/14.
  - Recorded, not fixed: the file is not this lane's.
- **`check:all`** fails on the five live-database checks (write-path-columns,
  missing-live-columns, authorization-contract, media-objects,
  rank-events-surfaces), on `check:census-freshness`, and on
  `check:census-integrity`.
  - The integrity failure is census-media's stated headline (C 401 / W 37 /
    N 12) against its rows (C 408 / W 34 / N 8).
  - It is inherited. Putting `wave8-integration`'s census-media at
    `2a60f9c3b` into this tree gives the same error, and this lane's only
    census-media change is one prose line.

**Stale files.** `check:census-freshness` names these of this lane's files. The
acknowledgement ledger is the integrator's, so each is listed with its
argument:

- **census-map:** the rehearsal suite, the hook, `photoEvidenceCoverage.ts`
  and its test, the screen's coverage test, the sheet's test, and
  `intelEvidenceReference.test.ts`. §45.11 and §45.12 are this census's own
  reading of every one of them. M154 is unchanged: the evidence path it grades
  now also withholds the photo step the server would refuse.
- **census-media, `lib/intelEvidenceCapture.ts`.** Two exports are appended at
  the end of the file: the predicate and the decorator. Gate 2b's condition
  line now calls the predicate, with the same logic it had inline. No MD row
  moves (census-media §39's new line).
- **census-trips, the rehearsal suite.** census-trips watches `src/test/db/`.
  The suite touches only `intel_evidence`, its two migrations and the ledger;
  no trip table or function. `lib/http.ts` was argued in §45.8.
- **census-trust.** `lib/envValidation.ts` and `lib/http.ts`, as argued in
  §45.8, are unchanged since.

**Changed, but already named by an existing acknowledgement.** The check
cannot tell this lane's change from the acknowledged one:

- `app/map/index.tsx` (census-map, census-discovery). Three line-neutral
  edits; the sheet gets its picker only on the server's yes. No Discovery
  surface is touched.
- `routes/intel.ts` (census-sensing, census-highlights-memories). The consent
  read and write gain one derived boolean. Stamping, versioning and scopes are
  unchanged.

The others are not watched by any census: `services/intelConsent.ts` on the
client, and the two rollbacks. The api package manifest and the freshness
script are machinery.

The other stale entries (MentionInput, tokens, ReportSheet,
PassportMemoryService, mediaLocationVisibility, eventPostsDiscovery, and
census-media's other 87) arrived with the merges and are not this lane's.

This section does not restate any census headline, because no row moved.

---

## §46 — 2026-09-29: the Compass → Map command channel gets its handler, and the circle need-help route gets its button (TM-social lane, MAP-F04 / MAP-F08)

Testing-mode lane `lane-tm-social`, branch cut from `main` at `18518e982`. `head_commit` is **NOT**
re-declared: this records a build and grades no row. Controlled evidence only — component and
unit tests in this repository. No flag was touched, no migration was added, no database was read.

**No row moves.** M9, M104 and M143 are already C and rest on the Compass map model, which is
unchanged; the map-screen change below is covered by this census's existing acknowledgement for
`app/map/index.tsx` and is argued in §46.4 rather than left to that entry.

### 46.1 MAP-F04 — decision: build the command handler; leave `/map/search` uncalled

The work package offered two ways out: handle Compass → Map commands on the map, or retire the
routes. The architecture answers each route separately:

- `POST /map/compass-command` (`artifacts/api-server/src/routes/mapSearch.ts:297#router.post("/map/compass-command"`)
  exists to replace the client's "geocode the query string and fly" heuristic with a
  server-resolved, range-validated set-viewport. The map still ran that heuristic. **Built.**
- `GET /map/search` stays without a client caller **on purpose**, per the mobile reachability
  ledger ("The two map leads", docs/architecture/mobile-reachability-ledger.md): the map's search
  sheet already searches nine entity types through the input-assistance gateway, and `/map/search`
  normalises three, so re-pointing it would be a regression. It is not retired either — deleting
  a flag-gated backend is not a testing-mode change. It remains BACKEND WITH NO MOBILE CONSUMER.

### 46.2 What was built for MAP-F04

- The handler: `travel-buddy-standalone/src/services/mapCompassCommands.ts:148#export async function flyToCompassQuery(`.
  It asks the server with a `go_to` intent, re-validates every returned command against the
  server's own ranges (`travel-buddy-standalone/src/services/mapCompassCommands.ts:67#export function validateClientMapCommands(`),
  and moves the camera only on a valid set-viewport.
- **Flag-off is the old behaviour.** With `map_compass_commands_enabled` off the route answers
  `{ enabled: false }` (`artifacts/api-server/src/routes/mapSearch.ts:304#if (!(await isFlagEnabled(sc, "map_compass_commands_enabled"))) {`)
  and the legacy device-geocoder fly runs unchanged; the same happens when the request cannot be
  made (`travel-buddy-standalone/src/services/mapCompassCommands.ts:156#if (!res.ok || !res.data.enabled) {`).
- **Flag-on with nothing resolvable leaves the map where it is**
  (`travel-buddy-standalone/src/services/mapCompassCommands.ts:165#return { via: 'server', moved: false, explanation: res.data.explanation };`).
  Flying somewhere confident and wrong is the failure the protocol exists to prevent, so the device
  geocoder is not used as a second guess.
- Both Compass flies on the map go through it:
  `travel-buddy-standalone/app/map/index.tsx:1511#void flyToCompassQuery(query, cameraRef, geocodeAndFly);`
  and `travel-buddy-standalone/app/map/index.tsx:3219#void flyToCompassQuery(compassQuery, cameraRef, geocodeAndFly);`.
  Both edits are line-neutral.

Tests: `travel-buddy-standalone/src/services/__tests__/mapCompassCommands.component.test.ts:121#it('flag on + nothing resolvable`
and its 11 siblings (flag off, request failed, set-viewport, validation, the request's shape, and a
source check that no Compass fly calls the device geocoder directly). Red first: the module did
not exist and the route had no caller. Mutations — geocoder as a second guess, the client range
check loosened, one map call site reverted — each reddened the suite; all restored by sha256.

### 46.3 MAP-F08 — the circle need-help button

- The route: `artifacts/api-server/src/routes/circle.ts:1673#router.post("/circle/contexts/:type/:id/need-help"`.
  It marks the caller `needs_help`, logs a check-in and an audit event, and sends ONE push to the
  context's HOST with no location (`artifacts/api-server/src/routes/circle.ts:1734#// Alert the context host only (fire-and-forget).`).
- **Decision: the button says what the route does, not what the catalogue's intent line says.**
  The flow catalogue describes "circle members get an alert with your location". The route
  deliberately does neither — host only, no GPS — and that is the privacy position its own comments
  state. Building a member broadcast with location would be a new safety/privacy feature, not a
  testing-mode wiring; the client therefore offers **Alert the host** and says the location was
  not shared.
- Client: `travel-buddy-standalone/src/services/circle.ts:461#export async function postNeedHelp(`;
  the button's handler `travel-buddy-standalone/src/components/circle/CheckInActions.tsx:72#async function alertHost() {`,
  offered to a member beside **Open Safe Return**
  (`travel-buddy-standalone/src/components/circle/CheckInActions.tsx:129#{ text: 'Alert the host', onPress: () => { void alertHost(); }, style: 'destructive' },`).
  A host is offered Safe Return only (`travel-buddy-standalone/src/components/circle/CheckInActions.tsx:113#if (isHost) {`)
  — the alert would reach nobody but themselves. The screen passes the role in:
  `travel-buddy-standalone/app/circle-presence.tsx:441#isHost={isHostParam}`.
- A 429, a 403 or an outage is **Alert not sent** with the reason, never "sent".

Tests: `travel-buddy-standalone/src/components/circle/__tests__/CheckInActions.needHelp.component.test.tsx:52#it('alerting the host calls the need-help route`
and 5 siblings. Mutations — any response treated as sent, the host branch removed, the host
option removed — each reddened the suite; all restored by sha256.

### 46.4 Why the map-screen change cannot move a verdict here

`app/map/index.tsx` changed on two lines, each replacing `void geocodeAndFly(...)` with the handler
call, plus one joined import. With the flag off — its production state — the handler calls the
same `geocodeAndFly` with the same argument, so the map's behaviour is unchanged. No row of this
census grades the Ask-Compass fly; M9, M104 and M143 grade the Compass map model, which is not
touched.

### 46.5 What is left open

- **The route's own success message was untrue — CLOSED 2026-09-29 (lane TM-create).** It answered "Your circle has been notified" while
  notifying only the host (`circleNeedHelpAlertSilence.test.ts` quotes it). The client never shows
  it; the server copy now names the host only (docs/ops/testing-mode-flows.md, TM-create section).
- **Only `go_to` is issued.** The route also accepts `search`, `select`, `filter` and `clear`; the
  map's Compass bar only ever needs a place to fly to. Nothing on the map yet asks for the others.
- Red if: a Compass fly calls the device geocoder directly again; the client applies an
  unvalidated command; or the need-help button reports a refusal as sent.

- NOT-GRADED: travel-buddy-standalone/src/services/mapCompassCommands.ts — §46.2's Compass → Map command handler; built work for MAP-F04, no Map verdict rests on it
- NOT-GRADED: artifacts/api-server/src/routes/mapSearch.ts — §46.1 cites the compass-command route and its flag gate as the contract the handler calls; no Map verdict rests on it
- NOT-GRADED: artifacts/api-server/src/routes/circle.ts — §46.3 cites the need-help route as the contract the button calls; no Map verdict rests on it
- NOT-GRADED: travel-buddy-standalone/src/services/circle.ts — §46.3's need-help client wrapper; built work, no Map verdict rests on it
- NOT-GRADED: travel-buddy-standalone/src/components/circle/CheckInActions.tsx — §46.3's need-help button; built work for MAP-F08, no Map verdict rests on it
- NOT-GRADED: travel-buddy-standalone/app/circle-presence.tsx — §46.3 cites only the role prop passed to the button; this census grades no circle-presence behaviour
- NOT-GRADED: travel-buddy-standalone/src/services/__tests__/mapCompassCommands.component.test.ts — §46.2's suite for the handler; no verdict rests on it
- NOT-GRADED: travel-buddy-standalone/src/components/circle/__tests__/CheckInActions.needHelp.component.test.tsx — §46.3's suite for the button; no verdict rests on it
- NOT-GRADED: artifacts/api-server/src/test/circleNeedHelpAlertSilence.test.ts — named in §46.5 only because it quotes the route's untrue success message; no Map verdict rests on it

---

## §47 — 2026-10-05: three rows this census called code, re-read against `main` (integration lead)

*Measured at `origin/main` = `2e4683526`. One test file is added by this pass
and nothing else in the tree changes. `head_commit` is not re-declared.*

§41.4 and §42.3 left three rows described as open defects in code: M43, M263 and
M123. All three descriptions are now out of date, in three different ways. One
row moves. Two do not, and the reason each stays W is corrected.

### 47.1 M43 — the viewer's own position is drawn, and the grading pass that was owed is this one

The build landed on 2026-09-20. `CENSUS_STALENESS_ACKNOWLEDGED.json` records it
and says in terms that it *"deliberately does not take that move"*, because
*"regrading M43 needs its full acceptance criteria read against a real user
flow, which is a measuring act and belongs in a grading pass"*. No pass took it,
so for fifteen days this census has said "nothing renders the user's own
position on the canvas" about a canvas that does.

The row's criterion is its own **Turns red when**: *a component test mounts the
real map canvas with a viewer position and finds a user-position node in the
tree*, with the stated trap being a marker that only mounts when other objects
do. Read against the whole path, three links:

1. **The screen gives the canvas the live fix.** The position is the device's
   location, null without one (`travel-buddy-standalone/app/map/index.tsx:857#const userLat = locationState.coords?.lat ?? null;`),
   the canvas the screen mounts is the one under test
   (`travel-buddy-standalone/app/map/index.tsx:2556#const MapComponent = DiscoveryMapView!;`), and both
   coordinates are passed to that element (`travel-buddy-standalone/app/map/index.tsx:2570#userLat={userLat}`).
   **This link had no test.** It has one now:
   `travel-buddy-standalone/src/components/map/__tests__/userPositionWiring.test.ts:88#test('both coordinates are passed to the canvas element itself'`.
2. **The canvas mounts the marker unconditionally**
   (`travel-buddy-standalone/src/components/discovery/DiscoveryMapView.tsx:678#<UserPositionMarker lat={userLat} lng={userLng} />`),
   outside every entity and place branch.
3. **The marker draws, and fails closed** on a missing or degenerate position
   (`travel-buddy-standalone/src/components/map/UserPositionMarker.tsx:138#export function UserPositionMarker`).

**Executed on this tree, not quoted from the build.** The canvas suite and the
marker suite: 2 suites, 17 tests, all passing — including the row's own case,
`travel-buddy-standalone/src/components/map/__tests__/DiscoveryMapView.userPosition.component.test.tsx:120#it('draws the viewer with no entities and no places on the map at all'`.
The new wiring suite: 4 of 4.

**Mutations, each seen red, every file restored byte-identical:**

| mutation | result |
| --- | --- |
| the canvas no longer mounts the marker | canvas suite: 2 failed, 1 passed |
| the screen stops passing the latitude to the canvas | wiring suite: 1 failed |
| the position is taken from the fallback city, not the live fix | wiring suite: 1 failed |
| the canvas is handed the camera centre as the viewer | wiring suite: 2 failed |

**What C does NOT claim here.** No frame was captured on a device: that the dot
is the right size, colour and z-order on a handset is M254–M258's kind of
question and stays with them. And the dot is only drawn for a viewer who has
granted location; a viewer who has not is shown no dot, which is the fail-closed
half of the same component.

### 47.2 M263 — the payload defect is closed and pinned; the row stays W for its siblings' reason

The row still says *"the emitter exists and its payload is wrong"* and that
wiring the fix is *"a cross-lane change"*. It was wired on 2026-09-20: the
emitter hands the panel-derived payload straight through
(`travel-buddy-standalone/app/map/index.tsx:2876#emitMapEvent('why_shown_opened', whyShownOpenedPayload(obj));`),
and a test fails if the call site ever restates the rule instead
(`travel-buddy-standalone/src/features/map/telemetry/__tests__/whyShownOpenedWiring.test.ts:65#test('the emit calls whyShownOpenedPayload'`;
8 of 8 across the two suites on this tree).

So §42.3's heading — *"the one defect in this census that no deployment fixes"*
— no longer describes anything. M263 is now exactly what M259–M274 are: a
correct emitter whose event cannot land, because `map_telemetry_events` does not
exist in production and `map_telemetry_enabled` is seeded OFF. It stays W for
that reason and no other.

### 47.3 M123 — its named blocker cleared; what holds it is a flag, not code

§41.6 says M123's blocker *"is M42's writerless-`saved_places` projection, which
is code"*. M42 has since moved to C: the projector's PLACE lane was repointed at
the canonical save tables by migrations 2963 and 2965, and M42's row records the
live proof. PR #451, which this census named as the fix, was closed unmerged;
2963 is what landed.

M42's row also says what it does not claim, and that sentence is M123's
blocker now: no memory pin is drawn for a real user in production, because
`memory_projection` is off there and two functions it needs are absent. That is
a deployment and a flag. **M123 stays W, and moves from this census's "logic
wrong in code" group to its "built, gated" group.** §41.3's count of three rows
with logic wrong in code is therefore **zero** after this section: M42 moved to
C earlier, M43 moves here, and M123 was never code.

### 47.4 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| M43 | W | **C** | §47.1. Built 2026-09-20 and not regraded then. The row's own criterion — the real canvas, a viewer position, a user-position node, on an empty map — is executed on this tree and mutation-proven, and the one untested link (the screen handing the live fix to the canvas) is now pinned by `travel-buddy-standalone/src/components/map/__tests__/userPositionWiring.test.ts:75#test('the position is the device live fix, not the camera or a fallback'`. Not claimed: any on-device rendering property. |
| M263 | W | **W** | §47.2. Verdict unchanged, reason corrected: the payload defect is closed and pinned. It stays W because its event cannot land — the same production table and flag that hold M259–M274. |
| M123 | W | **W** | §47.3. Verdict unchanged, reason corrected: its named code blocker (M42) is cleared. It stays W on `memory_projection` being off in production. |

### 47.5 Checks

`check:census-integrity`, `check:census-freshness`, `check:census-scope-coverage`,
`check:doc-citations`, `check:citation-targets`, `check:citation-symbols` and
`check:census-policy-citations` were run on this tree after this section was
written. The new test file is inside this census's watched paths, so
`CENSUS_STALENESS_ACKNOWLEDGED.json` names it, with the argument that it is
evidence for the regrade this section takes.

## §48 — 2026-10-05 (lane L): M256's "missing harness" exists; M65 overstates by one family and its criterion is unsatisfiable as written; the classification of every open row. NO VERDICT MOVES

*Measured on branch `claude/mission-l-lead-residual-20261005` (cut from `13170305f`, which
carries §47). No code changes in this section; `head_commit` is not re-declared.*

### 48.1 M256 — the server half is written, registered and passing

M256's cell says its server half is *"a missing harness nobody has written"* and that this lane
*"can see no such harness anywhere under `artifacts/api-server/src/test/`"*. It was written on
2026-09-20/21 (`c36aac77d`, `62bee1776`) and is in the api-server `test` script:
`artifacts/api-server/src/test/mapProjectionPerf.test.ts:271#describe("M256(a) — GET /api/map/projection, 50 warm-cache requests"`,
gating p95 at the top of the band (`artifacts/api-server/src/test/mapProjectionPerf.test.ts:136#const P95_BUDGET_MS = 800;`)
with four anti-vacuity guards that make a route which stops reading fail rather than get faster.
Re-run on this tree: 9 / 9, in-process arm **p50 4.2 ms / p95 54.7 ms** over 50 warm requests.

**M256 stays `?`**, for the reason the harness states about itself: the in-process arm runs over
the PostgREST-shaped double and is a regression gate on route work, not the criterion's latency.
Its live arm needs a disposable local PostgreSQL, which this machine does not have, and the row's
device half (camera-settle to first paint) needs a handset and M133's gateway serving. What
changes is the blocker: not "nobody has written it" but "run its live arm, and run the device".

### 48.2 M65 — four families are unfed, not five, and "names all seven" can never be true

The row: *"five families produce nothing"*, turning red when *"`WIRED_SIGNAL_SOURCES` names all
seven families"*. Read family by family:

- Fed and observed: `next_stop_contribution`, `accepted_plan`
  (`artifacts/api-server/src/lib/crowdFlowProducer.ts:290#export const WIRED_SIGNAL_SOURCES`).
- Fed, CAUSE-ONLY by design: `event_context`
  (`artifacts/api-server/src/lib/crowdFlowProducer.ts:278#export const CAUSE_ONLY_SIGNAL_FAMILIES`),
  produced and attached on the projection route
  (`artifacts/api-server/src/routes/mapProjection.ts:936#causeHypotheses: causes.hypotheses,`).
  It is not "producing nothing", and it can never enter `WIRED_SIGNAL_SOURCES`, because an event
  is a hypothesis about WHY a flow exists, never evidence that anybody moved (§10).
- Unfed, each with its named finding
  (`artifacts/api-server/src/lib/crowdFlowProducer.ts:346#export const UNFED_FAMILY_BLOCKERS`):
  `coarse_transition` (its table is not in this repository's migrations; the purpose that claims
  it is declared precise, 24 h, research-only), `arrival` and `navigation_start` (their sources
  carry a destination only — an origin would have to be taken from a stored position, which §10
  forbids), `aggregate_presence` (presence, not a transition).

So the criterion should read *six observed families* fed, plus the cause family attached. Three of
the four unfed families need a PRODUCT decision about which user act may declare an origin zone —
recorded in lane L's owner-decision list as Q-L5, under OD-MAP-1's opt-in and OD-MAP-7's 180-day
cap — and the fourth needs a migration and a device capture. **M65 stays `W`;** its blocker moves
from "capture nobody has written" to "an owner decision, then capture".

### 48.3 The open rows, classified against the code (lane L triage)

Every non-`C` row was opened at its cited code on this tree. The full ledger, one line per row
with its anchor, is the lane's working file; the shape is:

| class | rows |
| --- | --- |
| a flag, an unapplied migration or an ops load — code complete | M5, M7, M10, M67, M83, M85–M87, M90–M94, M119, M123, M133, M139, M179, M221–M223, M259–M275, M278–M280, M282 |
| a native module plus a device run | M88, M89 |
| a device or seeded-environment measurement | M254, M255, M256 (device half and live arm), M258, M292 |
| an owner product decision (new object kinds, a data source) | M122, M129, M130, M65 (§48.2) |
| descoped by the owner (Phase 6, 2026-10-04 12:05 UTC) | M281 |

Two stale sentences recorded so they are not re-quoted: the M7 family's *"Table absent"* (§43/§44
measured all four `locate_friends_*` tables present in production; the blocker is
`locate_friends_enabled`, FALSE), and the telemetry rows' *"absent in production"* (§43.1: both
telemetry tables present; the blocker is `map_telemetry_enabled`, seeded OFF). Lane L asks the
owner (Q-L6) whether per-user Map telemetry should keep its 90-day retention or follow the 30-day
default set for raw behavioural rows in Q11(a), before collection is ever switched on.

**No row in this census is code-fixable inside this repository without an owner decision, an
applied migration, a flag, a native build or a device.**

### 48.4 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| M256 | ? | **?** | §48.1. The server harness exists and passes; the row's own measurement still needs its live arm and a device. Blocker corrected. |
| M65 | W | **W** | §48.2. Four observed families unfed, not five; `event_context` is fed as a cause; the "all seven" criterion is unsatisfiable by design. Blocker corrected to an owner decision. |

## §49 — 2026-10-06 (lane L): §48.1 corrected — M256's harness gates on V1–V4, and its timing assertion cannot catch a slowdown. NO VERDICT MOVES

Independent verification of §48.1 found two things. **The timing number §48.1 quoted is load noise**:
the verifier's run of the same in-process arm measured p95 ≈ 2.3 ms; §48.1's 54.7 ms was taken while
nine other lanes were running suites on the same machine. Neither figure is evidence of anything but
the machine's load. **And the 800 ms budget cannot catch a regression**: a 120 ms delay added to every
request still passes 9 / 9, because the budget is the criterion's production ceiling applied to an
in-process double that runs two orders of magnitude faster.

So what `mapProjectionPerf.test.ts` actually GATES is V1–V4 — every measured response serves, carries
the whole seeded set, ran the §24 protection gate over it, and read the projection's own tables. The
p50/p95 it prints are informational. Tightening the budget to a value a regression would trip was
considered and not done: on a shared machine the in-process arm's tail already swings by an order of
magnitude with load, so a tight budget would fail on noise and train people to ignore it. The honest
statement is this paragraph. M256 stays `?` on §48.1's reasons: its live arm (a disposable PostgreSQL)
and its device half are unmeasured.

| id | was | now | why |
| --- | --- | --- | --- |
| M256 | ? | **?** | §49. The harness's correctness guards gate; its timing is informational; the row's measurement is still the live arm and a device. |

## §50 — 2026-10-06 (lane L): the projection's protection counts told a viewer that a friend was inside a protected zone; they are server telemetry now. NO VERDICT MOVES

*Found by the Telegraph re-check (same class as the Nearby leak). Measured on branch
`claude/mission-l-lead-residual-20261005` after merging `origin/main` (`824633ce45`). Not live:
`map_projection_enabled` is seeded FALSE and its row is absent from production (§43.4). It must not
ship.*

### 50.1 The defect

`GET /api/map/projection` answered `protection: { evaluated, allowed, coarsened, suppressed,
safetyExempt }`. Circle members go through that pass. With one circle member on the map,
`suppressed: 1` beside an empty object list said that the friend was **inside a protected zone** — a
shelter, a home, a sensitive building — which is exactly the fact the zone exists to hide, and more
than the coarse position it withheld would have said. M179 asks that sensitive locations be suppressed
before data reaches the client; a count attributable to a zone is data reaching the client.

### 50.2 The change

The per-reason counts are removed from the response and recorded as SERVER TELEMETRY
(`artifacts/api-server/src/routes/mapProjection.ts:1067#recordProtectionPass(req.log, "map_projection", protection.report);`;
`artifacts/api-server/src/lib/mapProtectionTelemetry.ts:39#export function recordProtectionPass(`):
logged with the request as counts and a route name only — no viewer, no object id, no zone — and
handed to an in-process sink that tests read. The refusal envelopes keep `protection: null`, which says
nothing about any zone.

### 50.3 Proof

- **Byte-identical responses**: a circle member inside a shelter zone and the same member who opted out
  of sharing produce the same response, compared byte for byte with only `generatedAt` normalised
  (`artifacts/api-server/src/test/mapProjectionLayers.test.ts:881#it("member inside a shelter zone ≡ member who opted out of sharing — byte-identical responses"`);
  likewise against a member whose fix is stale
  (`artifacts/api-server/src/test/mapProjectionLayers.test.ts:888#it("member inside a shelter zone ≡ member whose fix is stale — byte-identical responses"`).
  A control case puts the zone elsewhere and the member IS served, so the comparisons are of real
  absences.
- **The gate still ran**: its counts reach the telemetry sink
  (`artifacts/api-server/src/test/mapProjectionLayers.test.ts:900#it("the gate still RAN — its counts reach server telemetry, not the wire"`).
- Eight suites that used the wire counts as evidence that §24 ran now read them from the sink (a
  shared test helper), including the M256 harness's V3, which is now one telemetry event per measured
  request. Map suites: mapProjection 78, mapProjectPlace 35, mapProjectionPerf 9, mapCrowdFlowLayer 27,
  mapMeetingPointProducer 34, mapSafetyNoticeProducer 24, mapMemoryProducer 31, mapProjectionLayers 56,
  mapProtectionUnreadable 5, mapProjectionTemporalRoute 24, geoZoneSeed 29, protectedLocations 68 — all
  pass. `mapProjectionLiveDb` cannot run on this machine (the CI Supabase guard refuses it without the
  sanctioned project); it was converted the same way and compiles.

Mutations, each red then restored byte-identical (`cmp`):

| mutation | result |
| --- | --- |
| the per-reason counts put back on the response | 3 red |
| only `suppressed` put back, as a single number | 2 red (both byte-identity cases) |
| the telemetry record removed | 1 red |

### 50.4 What this does not change, and one thing left open

- A member inside a COARSEN-class zone (a clinic) whose position is already `approximate` is served
  unchanged, because that zone's floor is `approximate`; no count distinguishes it any more.
- The temporal route (`/map/projection/temporal`) still reports its own protection counts. It serves
  forecasts built from k-anonymous cohorts, never another person's position, so this defect class does
  not reach it; the crowd-flow and Phase 7 `withheldForProtection` counts are aggregate objects for the
  same reason. Recorded so the next reader checks rather than assumes.

### 50.5 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| M179 | W | **W** | §50. A wire leak in this row's own subject is closed and pinned; the row still waits on `protected_zones` existing in production (§43.1). |
