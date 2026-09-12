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
> `routes/mapProjection.ts:836` refuses with `no_zone_model`. Populating
> `geo_zones` is an ops action, not a migration, so applying every pending
> migration would still leave Crowd Flow dark.
>
> Confirmed rather than corrected: `intel_state_snapshots`, `intel_claims`,
> `intel_observations` and `intel_live_promoted_scopes` all hold 0 rows in
> production, and `user_location_state` holds 5 rows of which **0 are within 60
> minutes**, so the `social_zone` layer is empty there whatever the flags say.
>
> **Method blind spot, confirmed.** This census scored only artifacts citing the
> Map spec, so `lib/tripCrewLocation.ts` — which cites Trips — was invisible to
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
| `head_commit` | `42aeac38` — DECLARED 2026-09-11. It **starts a clock; it does not certify a past.** Read the next row before quoting it. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. Its verdicts were taken at a pre-squash working tree that **exists nowhere**: verified against FULL history (`git fetch --unshallow`, 4,300 commits, then `git cat-file -e`), not assumed — a shallow clone had made every such commit look unresolvable for the wrong reason. So `nobody` can diff that tree against `42aeac38`, and this declaration **does not claim that interval was empty**. What it claims is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the paths in `CENSUS_SCOPE` returns **0 files**, and from here any change to one of them ages this census. Before it, `check:census-freshness` reported this document as CANNOT BE CHECKED — the weakest of the three states, not the safest. FRESH means *no counted file has moved since `42aeac38`*; it does **not** mean the rows were re-read, and none has been. Declared by the Trips lane while recounting the sibling census; if this lane disagrees, reverting costs only the check. |
| **Method** | Requirement-level, four buckets, exactly one bucket per requirement. Every BUILT verdict cites a `file:line` I opened and read. |
| **Database** | Not queried. Every production storage fact below is the ground truth supplied in the brief, or `artifacts/api-server/src/scripts/checkProductionDrift.ts`, which is in the tree. |
| **Section count** | The brief says 39. **The brief is right.** Both the `.txt` and the `.docx` carry exactly 39 numbered sections, `1. Product Definition` … `39. Final Architecture Rule`. Unlike the sibling censuses, I have no correction to make. |

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **293** |
| BUILT-AND-CORRECT | **235** |
| BUILT-BUT-WRONG | **48** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **5** |
| **CONSTRUCTED%** = (235+48)/293 | **283 / 293 = 96.6 %** |
| **CORRECT%** (raw) = 235/293 | **80.2 %** |
| **CORRECT% (spec-attributable)** = 224/293 | **76.5 %** |
| CANNOT-VERIFY share | **5 / 293 = 1.7 %** |

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
| M5 | Crowd Flow | **W** | Producer (`lib/crowdFlowProducer.ts`), gateway lane and client renderer all exist. The mode gate is `CROWD_FLOW: inputs.crowdFlowObjectCount > 0` (`src/stores/mapStore.tsx:98`), and the gateway serves zero objects in production (§Headline). The surface can never open there. |
| M6 | Trip Map | C | `src/features/map/trip/tripMapSources.ts`, `tripMapModel.ts`; capability hard-true at `src/stores/mapStore.tsx:96`. |
| M7 | Locate My Friends | **W** | Complete server (`lib/locateFriendsSession.ts`, 48 KB) and client (`src/services/locateFriends.ts`, `src/components/map/LocateFriendsPanel.tsx`). **All four storage tables are absent from production** — `locate_friends_sessions`, `_members`, `_positions`, `_audit`, `scripts/checkProductionDrift.ts:176-179`. |
| M8 | Intent Mode | C | `src/components/map/IntentSheet.tsx:2`; opened at `app/map/index.tsx:2667`. |
| M9 | Compass Map Recommendations | C | `src/features/map/compass/compassMapModel.ts`; capability hard-true, `src/stores/mapStore.tsx:94`. |
| M10 | Time Machine | **W** | Producer `lib/temporalProjection.ts`, route `routes/mapProjectionTemporal.ts`, control `src/components/map/TimeMachineControl.tsx`. The capability requires the producer be reachable (`src/stores/mapStore.tsx:105-107`), and the temporal route rides `map_projection_enabled` and dies on the same `protected_zones` branch (`routes/mapProjectionTemporal.ts:574-591`). |
| M11 | Layers / Legend | C | `src/components/map/LayersSheet.tsx:2`; opened at `app/map/index.tsx:3230`. |

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
| M26 | The eight-level stack, base geography → critical overlays | C | `src/features/map/render/collision.ts:606-614` — *"§5 stacks the map in levels: activity zones sit at Level 2, crowd flow at Level 3, markers at Level 4 and above"*, enforced by `participatesInCollision` (only Points collide); `src/components/map/ActivityZone.tsx:96` `belowLayerID`. |
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
| M42 | Gold marker = Saved / Passport / Memory | **W** | The **Saved** arm is correct: `lib/mapProducers/savedPlaceProducer.ts:388,396` reads the union of `wishlist_places` + `discovery_place_saves` after PR #446 moved it off writerless `saved_places` (`:18-23`). The **Memory** arm is not: `lib/mapProducers/memoryProducer.ts:35` filters `memory_projections` to `subject_type = 'place'`, and that projector's PLACE lane still reads the writerless `saved_places`, so it has never had an eligible subject. **PR #451 fixes exactly this** and would flip M42 to C. |
| M43 | Blue dot = current user | **W** | The legend glyph is real and drawn — `src/components/map/LayersSheet.tsx:167-170,198` render a `blue_dot` glyph — but **nothing renders the user's own position on the canvas.** `src/components/discovery/DiscoveryMapView.tsx` contains no `UserLocation`, no `showUserLocation` and no user marker; `app/map/index.tsx:851-852` reads `userLat`/`userLng` only to recentre the camera. The map legend documents a marker the map does not draw. |

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
| M58 | Every meaningful live claim supports a Why? interaction | C | `lib/mapObjects.ts:347-357` `MapProvenance` on `MapObject`; `src/components/map/WhyShownSheet.tsx`. |
| M59 | Evidence lines, per claim | C | `lib/mapProjection.ts:833` `describeClaim`; `:607` `eventAdjacencyLine`, `:615` `qualifiedMediaLine` — copy is *"Table 7 VERBATIM"* (`:586`). |
| M60 | "Updated N minutes ago" | C | `lib/mapObjects.ts:355` `MapProvenance.updatedAt`. |
| M61 | Confidence stated on the panel | C | `lib/mapObjects.ts:354` `confidence: ConfidenceState`, required on the provenance bundle. |

### §10 Crowd Flow Mode (9)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M62 | Aggregate movement between places or zones | C | `lib/crowdFlowProducer.ts:2`; `produceZoneTransitions` → `deriveCrowdFlow`, zone granularity enforced by type. |
| M63 | Never expose individual routes or imply continuous tracking | C | `lib/crowdFlowProducer.ts:497-498` — cohort is a `Set` of distinct actors across families; `lib/mapAggregation.ts:399-414` puts `crowd_flow` in `NEVER_AGGREGATED_KINDS` because it already carries its own k decision. |
| M64 | Five flow states | C | `src/features/map/render/zoneStyle.ts:95` `FLOW_STATES = ['strong','moderate','emerging','dispersing','unusual']`. |
| M65 | The seven declared input families | **W** | `lib/crowdFlowProducer.ts:289` `WIRED_SIGNAL_SOURCES` is **two** of seven; `:298-300` `DECLARED_BUT_UNFED_FAMILIES` and `:345` `UNFED_FAMILY_BLOCKERS` name, per family, the specific capture that must exist first. Honestly declared, but five families produce nothing. |
| M66 | Minimum cohort density | C | `lib/mapAggregation.ts:351` `MIN_ZONE_COHORT = PRIVACY_THRESHOLD_V1.minUniqueActors`. |
| M67 | Multiple signal families required | **W** | The gate is right — `lib/crowdFlowProducer.ts:497-498` requires ≥ `MIN_SIGNAL_FAMILIES` *observed*, and refuses before it reads (`:914`). But the second family is the accepted-plan hop lane, whose consent record `route_flow_contribution_consent` (`lib/routeHopSignal.ts:115,572`) is **absent from production** (`scripts/checkProductionDrift.ts:180-183`). One family in production ⇒ the producer permanently refuses. |
| M68 | Freshness checks | C | `lib/crowdFlowProducer.ts:509` `SIGNAL_MAX_AGE_MINUTES`; `:653` applied per signal. |
| M69 | Privacy gates | C | `lib/crowdFlowProducer.ts:99` per-family consent; migration `2218_crowd_flow.sql:59` states the four gates as the flag's own description. |
| M70 | Observed movement and inferred cause separately represented | C | `lib/crowdFlowProducer.ts:273-277` `OBSERVED_SIGNAL_FAMILIES` vs `CAUSE_ONLY_SIGNAL_FAMILIES`; `:817` `MAX_INFERRED_CAUSE_CONFIDENCE = 'provisional'` — a cause can never be asserted as strongly as an observation. |

### §11 Trip Map Mode (12)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M71 | Render the Trip geographically without duplicating or replacing Trip ownership | C | `src/features/map/trip/tripMapSources.ts:16` — pure: DTOs in, `TripMapSource` out; every source is the owning system's own DTO. |
| M72 | Lodging / home base | C | `tripMapSources.ts:152-172` — first accommodation item with a safe coordinate; *"§11 lists lodging first"*. |
| M73 | Itinerary | C | `tripMapSources.ts:192` "Everything else is an itinerary stop", `:213` returned. |
| M74 | Next stop | C | `src/features/map/trip/tripMapModel.ts:275-279` — reservation outranks event start; a planned arrival is not an anchor. |
| M75 | Saved ideas | C | `tripMapSources.ts:220` — ideas with no coordinate are dropped, *"a saved idea with no known location is a wish"*. |
| M76 | Crew | C | `tripMapSources.ts:29-31,64-102` — crew surfaced as **coarse area labels** (`crewAreas`), `source.crew` left empty because it would require coordinates the §23 rung did not grant. The privacy-correct rendering, not a gap. |
| M77 | Routes | C | `tripMapSources.ts:251-253` — one LineString through the plan's stops, styled as a dashed guess rather than a routed path. |
| M78 | Meeting points | C | `tripMapSources.ts:213` `meetingPoints`; producer `lib/mapProducers/meetingPointProducer.ts`. |
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
| M83 | A specialized temporary group/event map | **W** | `lib/locateFriendsSession.ts:2`, `src/components/map/LocateFriendsPanel.tsx`. Storage absent from production. |
| M84 | Networked AND degraded/offline operation | C | `src/features/map/presence/eventCachedLocation.ts` (device-local rung); `src/features/map/cache/mapCache.ts:95-102` `event_map` cache class. Client-side, so unaffected by the missing tables. |
| M85 | Approximate location and explicit checkpoints | **W** | `src/features/map/presence/locateFriends.ts:139-190` `RUNG_POLICY`; positions live in `locate_friends_positions`, absent. |
| M86 | Rung 1 — normal network location | **W** | `locateFriends.ts:87,147`. Reads/writes `locate_friends_positions`. |
| M87 | Rung 2 — event-local cached location | **W** | `locateFriends.ts:88,153`; producer commit `bacae0b3`. Same storage. |
| M88 | Rung 3 — local device proximity | **N** | `src/features/map/presence/presenceLadder.ts:189-201` — `CURRENT_STACK_CAPABILITIES` has `bleScan/bleAdvertise/backgroundBle/uwb/localPeer` all `false`; *"BLE is entirely absent from today's Portava stack, which is why §12's 'local device proximity' and 'peer relay' rungs are currently unreachable"*. The ladder slot exists; the sensor does not. |
| M89 | Rung 4 — peer relay / checkpoint | **N** | Same, `presenceLadder.ts:189-201`, `locateFriends.ts:165,194` `unsupportedRungs()`. |
| M90 | Rung 5 — last-known location | **W** | `locateFriends.ts:171-175`. Same storage. |
| M91 | Rung 6 — manual checkpoint | **W** | `locateFriends.ts:177`; migration `2219:246`. Same storage. |
| M92 | Opt-in only | **W** | Structurally perfect and unreachable: `2219_locate_friends_sessions.sql:163` — *"opted_in_at and consent_source are NOT NULL, so a membership without a recorded consent act is unrepresentable"*. Table absent. |
| M93 | Group-scoped | **W** | Same migration `:163`; `src/stores/mapStore.tsx:66-70` refuses the mode without a scope. Table absent. |
| M94 | Temporary and auto-expiring | **W** | `2219:118` — `expires_at NOT NULL`, CHECK-bounded to 12 h, expiry re-enforced on every read so a stalled sweep cannot serve an expired session. `locateFriends.ts:490` `MAX_SESSION_MS`. Table absent. |
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
| M113 | Live Activity | C | `layerModel.ts:66` `live_activity`; `:158` default `on`. |
| M114 | People | C | `layerModel.ts:67`. |
| M115 | Events | C | `layerModel.ts:68`; default `on`. |
| M116 | Trip | C | `layerModel.ts:69`. |
| M117 | Buddies | C | `layerModel.ts:70`; `lib/buddyMapRead.ts:8`. |
| M118 | Saved | C | `layerModel.ts:71`; producer `lib/mapProducers/savedPlaceProducer.ts:388,396` (post-#446 union). |
| M119 | Crowd Flow | **W** | `layerModel.ts:72`; the layer is real, the objects are not — see M5/M67. |
| M120 | Hidden Gems | C | `layerModel.ts:73`. |
| M121 | Safety | C | `layerModel.ts:74`; always-on, `:110-118`. |
| M122 | Transport | **N** | `layerModel.ts:78` declares the id, `:171` defaults it `off`, `:637-640` gives it a legend entry — **and no `MapObjectKind` maps to it.** `LAYER_FOR_KIND` (`:470-485`) has no `transport` value, so `kindsForLayer('transport')` returns `[]` by construction (`:491-494`). A toggle over an empty set. |
| M123 | Memories | **W** | `layerModel.ts:79`, `:169` default `off`, `:475` `memory → memories`. Its only producer is dead upstream — see M42. PR #451 would flip this to C. |
| M124 | Suggested defaults (Live Activity/Events/Relevant Places/Saved on; People/Trip/Crowd Flow contextual; Buddies and Memories off) | C | `layerModel.ts:158-181` `LAYER_DEFAULTS`, matching the spec line; `:88-101` explains why `relevant_places` is modelled separately and kept out of `CORE_LAYER_IDS` "so that constant stays a faithful quote of the spec". |
| M125 | Rendering detail changes with zoom, intent, layer, Trip state, Compass state, density, confidence, relevance, relationship, privacy | C | `layerModel.ts:282` `DEFAULT_LAYER_CONTEXT`; `src/features/map/render/collision.ts:227-293` zoom bands, `:318` `LIVE_ZONE_CONFIDENCE_FLOOR`, `:333` `DEMOTED_ZONE_PRIORITY`. |

### §17 Zoom Model (5)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M126 | World: countries visited, upcoming Trips, Passport, major destinations; **no POI pins** | C | `src/features/map/render/collision.ts:265` — `world: ['safety_notice','trip_stop','memory','world_pulse','traveler_flow','personal_city']`. No `place` kind; `safety_notice` is deliberately in this row per §5 (`:252-255`). |
| M127 | City: neighbourhoods, activity zones, major events, major flow, key Compass recs | C | `collision.ts:267` — `['activity_zone','crowd_flow','prediction','event','city_model']`. |
| M128 | District: live places, events, gems, social opportunities, Trip objects | C | `collision.ts:269` — `['place','hidden_gem','social_zone','buddy_zone','saved_place']`. |
| M129 | Street: individual places, **entrances**, authorized crew, meeting points, route context | **W** | `collision.ts:271` introduces `['crew_member','meeting_point']` and inherits places. **There is no entrance kind** in `MAP_OBJECT_KINDS` (`lib/mapObjects.ts:91-110`) and no producer for one. Four of the five named renderables are present; entrances are not. |
| M130 | Venue/Event: stages, entrances, checkpoints, food, toilets, group members, meeting zones | **N** | `collision.ts:273` — `venue: []`. The band exists in the vocabulary and inherits everything from `street`, but **not one venue-interior renderable exists**: no stage, entrance, food or toilet kind, no producer, no fixture. §17's fifth row is a zoom threshold with nothing behind it. |

### §18 Map Object Contract (2)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M131 | The `MapObjectKind` union | C | `lib/mapObjects.ts:91-110` — the spec's thirteen kinds **in the spec's own order**, plus `saved_place` and the four §36 Phase 7 kinds appended at the end so the app mirror compares in order. `src/test/mapObjectsContract.test.ts` reads both mirrors and fails on drift; `travel-buddy-standalone/src/types/mapObjects.ts:2` is the other half. |
| M132 | The `MapObject` interface | C | `lib/mapObjects.ts:363-400` — every declared field present (`id`, `kind`, `geometry`, `title`, `subtitle?`, `observedAt?`, `expiresAt?`, `freshness?`, `confidence?`, `sourceRefs?`, `privacyClass`, `interaction?`, `renderingPriority`) plus `activity`/`trend`/`provenance`/`sourceClass`. `sourceClass` is optional for a stated reason at `:366-381`: absent is the only honest value for an object with no live claim, and `coarsenForZone` must be able to `delete` it. |

### §19 Projection Architecture (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M133 | **Never place raw database rows directly on the map** | **W** | The rule is built and not in force. `routes/mapProjection.ts` is the gateway; `map_projection_enabled` seeds **FALSE** (`migrations/2201_map_projection_flag.sql:16-18`), and `src/hooks/useMapEntities.ts:22-24,702-704` then runs the "ROLLBACK path" — five per-layer fetches normalised **on the device** by `src/features/map/projection/clientProjection.ts`. That is the forbidden shape, live in production. |
| M134 | A dedicated Map Projection Service | C | `lib/mapProjection.ts:2` — *"the Map Intelligence Gateway's shaping layer (Map spec §19)"*; `:16-24` pure, no I/O, no privacy decisions. |
| M135 | Map Objects as the wire type | C | `lib/mapObjects.ts`; mirrored client-side, drift-guarded. |
| M136 | Map Ranking | C | `lib/mapProjection.ts:1166` `rankObjects` — distance is a **tie-break**, not the sort key, because §5 makes safety and navigation precede popularity. |
| M137 | Privacy / Eligibility stage | C | `routes/mapProjection.ts:29-36` — the block set is resolved **once**, fail-closed, and handed to every people-bearing source so the request cannot hold two answers to "who is blocked"; `lib/mapObjects.ts:426-434` `isServable` drops `privacyClass:'none'` at the boundary whatever produced it. |
| M138 | Viewport Aggregation | C | `lib/mapAggregation.ts:2`; `:216-238` only wide bands aggregate; `:414` `NEVER_AGGREGATED_KINDS`. |
| M139 | The mobile client must not independently reconstruct Portava intelligence rules; the service is the "Map Intelligence Gateway" | **W** | The name and the guard are real — `src/test/gatewayBypassGuard.test.ts:28-33` fails when a privacy-complete reader is called from an unapproved caller, per (reader, caller) with a stated reason. But with the flag off, `clientProjection.ts` **is** a second, on-device reconstruction, and it is the one in service. |

### §20 Data Ownership (13)

All thirteen rows assert that a named system owns a fact and Map does not. The
gateway satisfies them structurally by calling each owner's privacy-complete
reader rather than querying: `routes/mapProjection.ts:14-27` and `:52-66`.

| id | Owner → Owns | V | Evidence |
| --- | --- | --- | --- |
| M140 | Places → place identity and location | C | `lib/mapProjectPlace.ts:3`; `routes/mapProjection.ts` `places` lane. |
| M141 | Live Intelligence → current claims and state | C | `lib/mapProjection.ts:1049` `enrichWithLiveClaims` — read-only over `readLiveClaims` envelopes; `:667` "Never upgrades". |
| M142 | Discovery → candidate relevance | C | `src/services/discovery.ts` consumed, never re-ranked, by `src/features/map/search/searchAdapter.ts:4`. |
| M143 | Compass → next-best action | C | `src/features/map/compass/compassMapModel.ts:8`. |
| M144 | Presence → people/place presence | C | `lib/mapTravelers.ts` + `readCircleLocations`, both approved-caller-only in `gatewayBypassGuard.test.ts`. |
| M145 | Trips → itinerary and crew context | C | `src/features/map/trip/tripMapSources.ts:16` (DTOs in, no re-derivation). |
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
| M159 | Projected Map State | C | `lib/intelProjection.ts` → `lib/mapProjection.ts:676` `applyLiveClaims`. |

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
| M172 | The five-rung `LocationVisibility` ladder | C | `lib/mapObjects.ts:258-266` `PRIVACY_CLASSES`; `:269` `precisionRank`, `:274` `narrowestPrivacyClass` — combining can only ever tighten. |
| M173 | Public stranger → aggregate only | C | `lib/mapProjection.ts:110` `travelerPrivacyClass` defaults to `aggregate_only`; mirrored `src/features/map/projection/clientProjection.ts:226`. |
| M174 | Shared Moment → place-level or delayed | C | `src/features/map/interaction/longPress.ts:273` `SHARE_PRECISION_CEILING = 'place_level'`, `:276` `DEFAULT_SHARE_PURPOSE = 'shared_moment'`; delayed-publish gate at `lib/eventPostsDiscovery.ts:186`. |
| M175 | Trip Crew → approximate, or permitted temporary precise | C | `lib/mapProjection.ts:266-281` — *"A consented circle member is ALWAYS `approximate` — never `place_level`"*, `CIRCLE_PRIVACY_CLASS`. |
| M176 | Locate My Friends → temporary group-scoped approximate/precise | C *(not spec-attributable)* | `src/features/map/presence/presenceLadder.ts:113-145` — a MIRROR of the server's Presence-spec ladder. |
| M177 | Safe Return → purpose-bound precise | C *(not spec-attributable)* | `presenceLadder.ts:330-392` `PRESENCE_PURPOSES` / `PURPOSE_CEILINGS` / `UNKNOWN_PURPOSE_CEILING`; `:452` "the most precise rung `purpose` may reach right now"; `:492` the narrowest-of-all rule. |
| M178 | Temporary location decays Precise → Approximate → Last known → Expired | C | `presenceLadder.ts:529` `DECAY_STAGES` exactly those four, `:541` intervals, `:551` boundaries, `:562` per-stage ceiling. Migration `2219:246` re-applies the decay on **read**, "regardless of whether a sweep has run". |

### §24 Protected Location and Safety Rules (4)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M179 | Suppress sensitive locations **before** data reaches the client | **W** | The gate is written and cannot fire. `lib/protectedLocations.ts:2,849` `applyProtection` is the last step before serialization, ordered correctly at `routes/mapProjection.ts` and (after PR #393's fix) in the temporal route. But `protected_zones` is **absent from production** (`scripts/checkProductionDrift.ts:110`), so the read errors, `loadProtectedZones` returns null (`routes/mapProjection.ts:202`) and the route serves the empty envelope (`:964-979`). The production behaviour is *refuse everything*, not *suppress sensitive locations* — safe, and not the requirement. |
| M180 | The protected categories (residences, medical, shelters, sensitive government, policy-defined) | C | `lib/protectedLocations.ts:81-88` `PROTECTED_CATEGORIES`; migration `2217:66-72` CHECK-constrains the same five; `:102` `policy_ref NOT NULL` so *"a protected location with no recorded policy"* is unrepresentable; `:135` `'allow'` is deliberately not storable — "a protection row that permits is a hole". |
| M181 | Safety and access warnings take precedence over activity ranking | C | `lib/mapObjects.ts:284` `safety: 120`; `lib/protectedLocations.ts:210` `PROTECTION_EXEMPT_KINDS = ['safety_notice']` — a hazard notice is never coarsened away. |
| M182 | The public map never receives more location detail than the viewer is authorized to see | C | `lib/protectedLocations.ts:720` `coarsenForZone`, `:793` `COARSENED_PAYLOAD_KEYS`; `lib/mapObjects.ts:376-381` documents that the strip must be able to `delete sourceClass` because `verified_firsthand` *"publishes that someone was here"*. Also `:301` `COARSEN_UNSAFE_KINDS`, `:325` `RELATIONSHIP_GATED_KINDS`. |

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
| M201 | Saved items | **W** | The type is declared (`mapSearchModel.ts:50`), carries a `savedKind` discriminant (`:144-148`), has group copy (`:64`) and is handled by the adapter's client-side alias table (`searchAdapter.ts:107-108`) and both geometry branches (`:277,292-293`). But **`SERVER_TYPE_TO_MAP_TYPE` — the table naming what the unified search actually returns (`:63-80`) — has no entry that yields `'saved'`.** No saved item can arrive from the search; the branch is unreachable from the server. |
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
| M220 | Mode TRIP | C | `vocabulary.ts:49`; capability true. |
| M221 | Mode CROWD_FLOW | **W** | `vocabulary.ts:50`; unreachable in production (M5). |
| M222 | Mode LOCATE_FRIENDS | **W** | `vocabulary.ts:51`; storage absent (M7). |
| M223 | Mode TIME_MACHINE | **W** | `vocabulary.ts:52`; gateway-dark (M10). |
| M224 | Overlay INTENT | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2667`. |
| M225 | Overlay LAYERS | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2546,2569`. |
| M226 | Overlay FILTERS | **W** | Declared at `mapMachine.ts:140` and covered by the reducer — **and never entered.** A repo-wide search for `overlay: 'FILTERS'` outside tests returns nothing; the actual filter sheet is driven by a plain `useState` that bypasses the machine (`app/map/index.tsx:906` `filterSheetOpen`, opened `:2604`, closed `:3240`), and the header's own filters button dispatches `'LAYERS'` instead (`:2569`). A dead state in the machine and a sheet outside it. |
| M227 | Overlay SEARCH | C | `mapMachine.ts:140`; dispatched `app/map/index.tsx:2544-2545`, rendered `:3182`. |
| M228–M235 | Camera FOLLOW_USER, FREE_EXPLORE, FOCUS_PLACE, FOCUS_AREA, FOCUS_ROUTE, FOCUS_TRIP, FOCUS_GROUP, COMPASS_RECOMMENDATIONS | C ×8 | `mapMachine.ts:149-160` all eight in §30's order. `:163-179` `MODE_CAMERA` couples each mode to a framing **as data**, with FOCUS_ROUTE deliberately absent from it because §5 makes navigation cross-cutting rather than a mode (`:178-180`). `:191-215` `OBJECT_KIND_CAMERA` refines by kind — zone-shaped kinds get FOCUS_AREA because "framing them as a pin would imply a precision §23 never granted", and `crew_member` gets FOCUS_GROUP for the same reason. D4 (`:66-73`): a user pan drops to FREE_EXPLORE and changes nothing else. |

### §31 Clustering and Rendering Priority (7)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M236 | Viewport queries | C | `lib/mapProjection.ts:1124` `parseBbox` — rejects malformed, out-of-range and antimeridian-crossing viewports rather than guessing; `lib/mapAggregation.ts:105` `bboxContains`. |
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
| M254 | Initial usable map under 2 s on a normal connection | **?** | Needs a device and a network. No timing harness or budget assertion exists in the tree. |
| M255 | Pan responsiveness ~60 fps | **?** | Needs a device and the map SDK. |
| M256 | Viewport intelligence first results within ~500-800 ms when cached/server-ready | **?** | Needs a running server with a warm cache; also currently unmeasurable because the gateway serves nothing (§Headline). |
| M257 | Debounce after the camera settles; never re-query on every pixel | C | `app/map/index.tsx:942-948` — *"a coarse centre grid and only re-queries after the §34 settle debounce"*; `:1010` "once the camera settles, the viewport intelligence is fetched"; `src/components/discovery/DiscoveryMapView.tsx:137` reports the camera only on settle. |
| M258 | Keep animation layers GPU-friendly | **?** | A rendering property of MapLibre layers on a device. Static reading cannot falsify it. |

### §35 Product Telemetry (17)

**All sixteen events have real emitters. None of them can land.**

`map_telemetry_events` and `map_telemetry_drops` **do not exist in production**
(ground truth; `scripts/checkProductionDrift.ts:121-127`, both `unapplied`, the
note reading *"Telemetry writer targets a table production does not have; the
write fails there"*). The writer is `routes/mapTelemetry.ts:213` (drops) and
`:225` (events), behind a second gate — `map_telemetry_enabled`, seeded OFF
(`:161`, `migrations/2202_map_telemetry.sql`). The client transport is wired
(`app/map/index.tsx:1298-1299` `setMapTelemetryTransport(createFetchTelemetryTransport(…))`
→ `/api/map/telemetry`, `src/features/map/telemetry/mapTelemetry.ts:1281`).

**This is the identical shape the Wall census found** — 13 of 15 Wall telemetry
events landing nowhere — and it is the same root cause, one migration lane
short of production.

| id | Event | V | Emitter |
| --- | --- | --- | --- |
| M259 | `map_opened` | **W** | `mapTelemetry.ts:643`; 1 emitter; `:23` mints `mapSessionId`. |
| M260 | `zone_selected` | **W** | `:644`; 3 emitters (`MapEntityPreviewCard.tsx:132`, `MapCarousel.tsx:1240`, +1). |
| M261 | `place_opened` | **W** | `:645`; 3 emitters (`MapEntityPreviewCard.tsx:138`, `MapCarousel.tsx:1246`). |
| M262 | `live_state_viewed` | **W** | `:646`; 2 emitters. |
| M263 | `why_shown_opened` | **W** | `:647`; 1 emitter. |
| M264 | `compass_requested` | **W** | `:648`; `AskCompassBar.tsx:137`; mints `decisionId` (`:25`). |
| M265 | `compass_option_selected` | **W** | `:649`; `MapCarousel.tsx:1256`. |
| M266 | `route_started` | **W** | `:650`; 3 emitters incl. `MapEntityActionRow.tsx:579`. |
| M267 | `trip_stop_added` | **W** | `:651`; `MapEntityActionRow.tsx:535`. |
| M268 | `plan_joined` | **W** | `:652`; 2 emitters incl. `MapEntityActionRow.tsx:476`. |
| M269 | `meet_here_created` | **W** | `:653`; 1 emitter. |
| M270 | `crew_locate_started` | **W** | `:654`; 1 emitter. |
| M271 | `contribution_submitted` | **W** | `:655`; 1 emitter; `:584` carries the banded time since `route_started`. |
| M272 | `alternative_requested` | **W** | `:656`; 1 emitter. |
| M273 | `recommendation_accepted` | **W** | `:657`; 3 emitters incl. `MapEntityActionRow.tsx:390`. |
| M274 | `recommendation_declined` | **W** | `:658`; 2 emitters incl. `AskCompassBar.tsx:128`. |
| M275 | Evaluate real-world outcomes, not only screen engagement | **W** | The design is right and the measurement is impossible. `mapTelemetry.ts:25-37` threads one `decisionId` through `compass_requested → compass_option_selected → recommendation_accepted → route_started → (arrival) → contribution_submitted`, with declines and alternatives as "the negative arm of the same" id — a genuine outcome loop. It writes to a table that is not there. |

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
| M278 | Phase 3 — Presence & Coordination | **W** | Trip Crew and Meet Here are C (M76, M183); Locate My Friends and offline event maps depend on the four absent `locate_friends_*` tables (M83–M94). |
| M279 | Phase 4 — Crowd Intelligence | **W** | Built and dead: M5, M65, M67. |
| M280 | Phase 5 — Temporal Intelligence | **W** | Built and gateway-dark: M10, M106–M111. |
| M281 | Phase 6 — Journey Intelligence | **N** | Ruled **out of scope** in-repo, before any code: `docs/map/scope-ruling-phases-6-7.md:40-47` — *"Building them would mean inventing a product from a two-word mention"*, with a table showing every Phase-6 term occurs exactly once in the whole spec. Nothing in main implements route optimization beyond §11's Optimize Today, Along My Way, next-move prediction, recovery, group decision or smart meeting points. **PR #393 is exactly this phase** and would move the verdict. |
| M282 | Phase 7 — World Intelligence | **W** | Fully built against an owner-supplied specification (`docs/map/scope-ruling-phases-6-7.md` AMENDMENT, `docs/map/phase-7-world-intelligence.md`): four kinds on both mirrors (`lib/mapObjects.ts:63-90`), four producers (`lib/mapProducers/worldPulseProducer.ts`, `travelerFlowProducer.ts`, `cityModelProducer.ts`, `personalCityProducer.ts`), two client layers (`layerModel.ts:104-106`). Behind `map_world_intelligence_enabled`, **seeded OFF** (`migrations/2295_map_world_intelligence_flag.sql:79`), and downstream of the empty gateway regardless. |

### §37 Explicit Non-Goals (9)

A prohibition is BUILT-AND-CORRECT only when a concrete artifact makes the
violation unrepresentable or refuses it. All nine clear that bar.

| id | Non-goal | V | Evidence |
| --- | --- | --- | --- |
| M283 | No generic Google Maps clone | C | `src/constants/mapStyle.ts:141-145` — no POI layer of any kind; the whole label budget is four symbol layers. |
| M284 | No public real-time people tracker | C | `lib/locateFriendsSession.ts:4,105` — *"§37 names two things this feature is one careless decision away from becoming"*; there is no `public` member and no public read path (`migrations/2219:310`). |
| M285 | No permanent exact-location sharing | C | `longPress.ts:323` `SHARE_MAX_TTL_MS = 1 h`; `presenceLadder.ts:529-565` the four-stage decay; `2219:118` the 12-hour CHECK; `locateFriendsSession.ts:874,943` names the exact failure mode it is preventing. |
| M286 | Not a place-rating directory | C | `lib/mapObjects.ts:363-400` — `MapObject` has **no rating axis at all**; §7's four axes are activity, trend, confidence and freshness. |
| M287 | No screen full of unranked POI pins | C | `lib/mapProjection.ts:1166` `rankObjects`; `collision.ts:617` `resolveCollisions`; `mapAggregation.ts:219` wide bands collapse to cells. |
| M288 | Compass must not invent live conditions | C | `compassMapModel.ts:8,191`; `lib/mapProjection.ts:667` `applyLiveClaims` "Never upgrades: if the claims are empty the object is returned untouched". |
| M289 | Predictions must not look like observations | C | `lib/mapObjects.ts:112` `FORECAST_KINDS` + `isForecastKind`; `timeMachine.ts:30-39` the discriminated union; `zoneStyle.ts:22-25,183` dashed **and** dimmed; `lib/mapProjectPlace.ts:202` cites §37 twice. |
| M290 | Paid businesses must not buy factual confidence | C | `lib/mapProjection.ts:518` `sourceCountBucket` nullable and load-bearing; `lib/mapObjects.ts:199-217` publishes the source **class** as a value so a renderer never has to regex English to learn a claim was sponsored; `routes/mapObservations.ts:70` rewards and observations do not join. |
| M291 | Stale claims must not remain visually live | C | `lib/mapObjects.ts:124-127` `mayRenderAsLive` admits only `live`/`recent`; `:158-172` expiry beats the age bucket and a future clock earns `unknown`, not the strongest label; `mapCache.ts:11-26` downgrades cached freshness on the way out; `crowdFlowProducer.ts:507` and `mapAggregation.ts:464,1164` cite the same line. |

### §38 Developer North-Star Scenario (1)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M292 | The 10:47 PM scenario is walkable end to end: busier area, cooling area, event starting, aggregate social opportunity, directional movement, a Compass Pick, an explanation, Go There, routing, arrival, one-tap crowd prompt re-entering the pipeline | **?** | Every component exists and is cited above, and the arrival prompt is real (`src/features/map/arrival/arrivalPromptModel.ts`, commit `35305f6c` *"§38 arrival one-tap prompt"*). But walking it requires a running app, a device, live location and populated intelligence — and three of its six map objects (crowd flow, live zone, prediction) cannot be produced in production today. **Not folded into either side.** |

### §39 Final Architecture Rule (1)

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| M293 | Every object must answer at least one of the seven questions | C | `lib/mapObjects.ts:420-434` `isServable` — the last gate before serialization, whose header cites §39 verbatim. Enforcement is **by kind vocabulary**: the predicate rejects an unknown `kind`, and every member of `MAP_OBJECT_KINDS` answers at least one question by construction (`:91-110`, each documented). It also rejects empty titles, unusable geometry and `privacyClass:'none'`. This is a proxy for the seven questions rather than a per-object test of them — a narrower guarantee than §39's wording, but a real and enforced one. |

---

## 5. What could not be verified (5), and why

Five, all genuine, none folded into either side:

| id | Requirement | Why it cannot be settled by reading this tree |
| --- | --- | --- |
| M254 | Initial usable map < 2 s | Needs a device, a real network and a cold start. No timing budget, benchmark or CI perf gate exists anywhere under `src/features/map/` or `artifacts/api-server/src/test/`. |
| M255 | Pan at ~60 fps | A property of MapLibre on hardware. Unfalsifiable statically. |
| M256 | Viewport intelligence in ~500-800 ms | Needs a running server with a warm cache. Doubly unmeasurable: the gateway currently returns an empty envelope in production, so there is no viewport intelligence to time. |
| M258 | GPU-friendly animation layers | A runtime rendering property of the style + layer stack. |
| M292 | §38's north-star scenario end to end | Needs a running app, a device, live location, and populated live intelligence. Three of its six map objects cannot be produced in production today. |

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

`travel-buddy-standalone/src/features/map/trip/tripMapSources.ts:133#export function composeCrewPositions(`
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
