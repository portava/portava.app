# Map device measurement protocol — M254, M255, M258, M292, M88, M89

**Written:** 2026-09-20 · **Branch:** `claude/portava-continuation-uqta94`
**Covers:** census-map **M254** (initial usable map < 2 s), **M255** (pan
responsiveness ~60 fps), **M258** (GPU-friendly animation layers — the device
half), **M292** (the §38 10:47 PM scenario walked end to end).

---

## 0. What this document is, and the one rule that governs it

This is the **runnable protocol and the ledger**. It is not a result.

Every row in every ledger below reads **NOT RUN**. No measurement in this
document has been taken, because no physical handset was available in the
environment where the harness was written. That is a failed prerequisite, not a
product pass or a product failure.

> **The substitution rule, inherited from
> `docs/architecture/map-sensing-certification.md`:** simulator, web, unit and
> component evidence **must not be entered in these ledgers as a substitute for
> a physical-device result.**

That rule is the reason this document exists separately from the test suite. The
suite proves the *instruments* — it is listed in §5 — and a green suite is not a
number. A row moves off **NOT RUN** only when an operator runs §2–§4 on hardware
and attaches the evidence each row names.

**Note on the certification document.** `docs/architecture/map-sensing-certification.md`
is the programme's existing physical-device ledger. It exists on commit
`3c5a76fd2` and was **not carried across by the port**, so it is absent from this
branch. Porting it is the integration owner's (plan blocker 6). This document
does not duplicate it: it adds the four *timing* protocols that document does not
carry, and defers to it for enrolment, permissions, accessibility and battery.

---

## 1. Prerequisites, all four measurements

Every one of these is a hard prerequisite. A run missing any of them is **NOT
RUN**, not a failure.

| # | Prerequisite | Why it is not negotiable |
|---|---|---|
| P1 | One **mid-tier Android handset**, physical. | The census names the device class. A flagship measures the wrong product and an emulator measures the host. |
| P2 | An **EAS `preview` build**, not a dev client. Exactly: `cd travel-buddy-standalone && npx eas build --profile preview --platform android` (the `preview` profile in `eas.json`: `distribution: internal`, no `developmentClient`). Record the build id EAS prints. | A dev client ships the Metro bundler client and an unminified bundle; its cold start is not the product's. The command is written out because "an EAS preview build" has been read as `--profile development` before, and that build measures the bundler. |
| P3 | Target is a **seeded `portava-ci`**, never production. | M255 and M292 both state this. Production is also the wrong target for a different reason: §6's zone layers must actually be drawn, and production's `geo_zones` holds 0 rows. |
| P4 | CI seeded with curated `geo_zones`, `protected_zones`, `intel_*` snapshots, and `map_projection_enabled` TRUE. | With an empty zone table the pan is measured over an empty map, which is the §42.7 mutation-B5 trap in physical form: a map that draws nothing is very fast. |
| P5 | **Network shaping at ~1.6 Mbit/s down, 300 ms RTT** for M254. | "A normal connection" is the claim under test. Record the shaping tool and its settings. |
| P6 | `adb` reachable, and **GPU profiling enabled** for M255/M258 (`Developer options → Profile GPU rendering → In adb shell dumpsys gfxinfo`). | Without it `framestats` prints no PROFILEDATA block, and the harness reports **NOT RUN** rather than a pass. |

**Record once per session, before any measurement:** build id, app version,
device model, OS version, MapLibre native version, target environment, network
shaping settings, account/cohort, and start time.

---

## 2. M254 — initial usable map under 2 s

### 2.1 What is measured

From the **`/map` route's navigation commit** to **MapLibre's first
fully-rendered frame**.

Both ends are deliberate and neither is the obvious one:

- **Not the tap.** The tap includes the outgoing screen's exit animation, which
  is not the map's cost.
- **Not the component's first render.** By then the router has already done work
  that belongs to opening the map, and measuring from there hides it.
- **Not `onDidFinishLoadingMap`.** The style is parsed; tiles may not be painted.
- **Not the first `onDidFinishRenderingFrame`.** That fires for a partial frame.
  `onDidFinishRenderingFrameFully` is the one that means there is a map on screen.

### 2.2 Instrument

`travel-buddy-standalone/src/features/map/perf/coldStart.ts`.

```ts
let trace = createTrace('cold', 'build 1234 / Pixel 6a / shaped 1.6Mbit');
trace = markNavigationCommitted(trace, performance.now()); // /map route commit
trace = markFirstFullFrame(trace, performance.now());      // onDidFinishRenderingFrameFully
```

Both marks are **idempotent**, and the second one has to be:
`onDidFinishRenderingFrameFully` fires on every fully-rendered frame, so without
idempotence "the first frame" would become the last frame before the reading was
taken and the interval would grow for as long as the user panned.

Use one monotonic clock for both marks. `coldStartMs` returns `null` — never `0`
— for a missing mark or an interval that came out negative, so a clock step
cannot be reported as a very fast start.

### 2.3 Procedure

Ten cold starts per arm. A **cold** start means:

1. Force-stop the app (`adb shell am force-stop <pkg>`).
2. Clear the app's caches so the §33 cache arm is genuinely not in play
   (`adb shell pm clear <pkg>` for the no-cache arm; sign in again).
3. Confirm the network shaping is still applied.
4. Launch, navigate to `/map`, and let it settle.
5. Record the trace with `arm: 'cold'`.

Then repeat ten times with the cache warm, recording `arm: 'cached'`.

### 2.4 Pass condition

`reportBothArms(traces)`:

- **Cold arm:** PASS when the **median of ten completed runs is under 2000 ms**.
  Median, not mean — with ten samples a mean is a duration no start ever took.
- **Cached arm:** **reported, never graded.** §33's cache arm is a different
  claim, and giving it the cold budget would let a warm cache close a row that is
  about a traveller's first open in a new city.

Fewer than ten completed runs reports **NOT RUN**, not PASS. This is deliberate:
"no start took 2 s" is trivially true of zero starts.

### 2.5 Ledger

| Arm | n | median | p95 | max | Verdict | Evidence |
|---|---:|---:|---:|---:|---|---|
| cold (no cache) | — | — | — | — | **NOT RUN** | — |
| cached | — | — | — | — | **NOT RUN** (no budget, per §33) | — |

---

## 3. M255 — pan responsiveness ~60 fps

### 3.1 What is measured

**p99 frame time ≤ 16.7 ms** over a **scripted 3-second continuous pan at city
zoom**, read from `adb shell dumpsys gfxinfo <pkg> framestats`, **with the §6
zone-shaped layers actually drawn**.

That last clause is the whole difficulty. A pan over an empty basemap is fast and
proves nothing; P4's seeding exists so that `ActivityZone`, `CrowdFlowLine` and
`TravelerFlowLine` are all on screen during the pan. **Confirm visually, and
record a screenshot, that all three are drawn before starting the pan.** If any
layer is absent the run is NOT RUN.

### 3.2 The 120-frame problem, and why reads are repeated

`framestats` holds only the most recent **~120 frames**. A 3-second pan at 60 fps
is **~180 frames**. A single read taken after the pan therefore misses the first
third of it — including the start of the gesture, which is where the jank
usually is.

So: **read during the pan, faster than the buffer turns over.** Every 1.0–1.5 s
is comfortable. Reads overlap by design, and `mergeFrameStats` deduplicates by
`IntendedVsync`.

### 3.3 Procedure

1. Reset the counters: `adb shell dumpsys gfxinfo <pkg> reset`.
2. Settle the camera at city zoom over the seeded viewport. Do not start the pan
   until the map is idle — a camera still settling is M254's measurement, not
   this one.
3. Script the pan; do not do it by hand. A hand-driven swipe varies in velocity
   between runs, and frame cost depends on velocity.
   ```sh
   # ~3 s continuous drag. Repeat N times back and forth to fill the window.
   adb shell input swipe 900 1000 200 1000 1500
   adb shell input swipe 200 1000 900 1000 1500
   ```
4. While it runs, capture repeatedly:
   ```sh
   adb shell dumpsys gfxinfo <pkg> framestats > frames-01.txt   # t+1.0s
   adb shell dumpsys gfxinfo <pkg> framestats > frames-02.txt   # t+2.0s
   adb shell dumpsys gfxinfo <pkg> framestats > frames-03.txt   # t+3.0s
   ```
5. Merge and grade.

### 3.4 Instrument

`travel-buddy-standalone/src/features/map/perf/frameStats.ts`.

```ts
const merged = mergeFrameStats(files.map((f) => parseFrameStats(readFileSync(f, 'utf8'))));
console.log(formatPanReport(reportPan(merged)));
```

Three parsing decisions are load-bearing and are the reason the parser exists
rather than an `awk` one-liner:

1. **Columns are read by NAME.** The column set changed across API levels
   (`GpuCompleted` arrived in API 28; some OEM builds omit the buffer-duration
   columns). An index-based reader silently reads the wrong column and reports a
   plausible wrong number — worse than failing.
2. **Frame time is `FrameCompleted − IntendedVsync`,** not `− Vsync`. A frame
   that began 30 ms late and then rendered in 8 ms is a dropped frame the user
   saw; measuring from `Vsync` scores it as a comfortable 8 ms.
3. **Rows with non-zero `Flags` are excluded.** Android flags frames that are not
   comparable, including the first frame after a window layout. A 300 ms
   first-draw would otherwise *be* the p99 of a 180-frame pan.

### 3.5 Pass condition

PASS when **p99 ≤ 16.7 ms** over **at least 100 usable frames**. Percentiles are
**nearest-rank**, so every reported number is a frame that actually happened;
nearest-rank p99 ≥ linear p99, so a run that passes here passes under either
method. Fewer than 100 usable frames reports **NOT RUN**.

### 3.6 Ledger

| Run | frames | median | p95 | p99 | over budget | Verdict | Evidence |
|---|---:|---:|---:|---:|---:|---|---|
| city-zoom pan, zones drawn | — | — | — | — | — | **NOT RUN** | — |

---

## 4. M258 — GPU-friendly animation layers (the device half only)

### 4.1 What is already proved, and must not be quoted as the row

The **cadence half is done and is device-free.** It is not part of this protocol
and must not be entered in this ledger:

- `src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx` —
  the pulsing zone: one re-render per half-period, stable source identity, the
  interpolation handed to the GPU as a `*-opacity-transition`.
- `src/components/map/__tests__/FlowLines.gpuFriendly.component.test.tsx` —
  `CrowdFlowLine` and `TravelerFlowLine`: a second of elapsed time produces zero
  repaints, the polyline is never re-uploaded, and the paint does not churn
  across re-renders.

Together those cover the census's own falsifiable form — *"no animated layer
causes a full style re-layout per frame"* — for all three layers.

### 4.2 What still needs the device

**Overdraw**, and absolute frame cost with the layers drawn.

Run over the **same pan as M255 §3.3**, so the two measurements describe one
event rather than two different pans.

1. **Overdraw:** Developer options → *Debug GPU overdraw* → *Show overdraw
   areas*. Screenshot the city-zoom viewport with all three layers drawn.
   Record the worst overdraw tier visible over the zone fills (blue 1×, green 2×,
   light red 3×, dark red 4×+).
2. **Per-layer cost:** Developer options → *Profile GPU rendering* → *On screen
   as bars*, recorded during the pan; plus the `framestats` capture from §3,
   which is the numeric form of the same thing.

### 4.3 Pass condition

- No animated layer causes a full style re-layout per frame — **already proved**
  in §4.1; the device run must not contradict it.
- Overdraw over the zone layers stays at or below **3× (light red)**. Four-plus
  tiers over a full-screen zone fill is the shape that makes a mid-tier GPU miss
  vsync, and it is the specific thing §34 asks to avoid.

### 4.4 Ledger

| Measurement | Result | Verdict | Evidence |
|---|---|---|---|
| Overdraw over §6 zone fills at city zoom | — | **NOT RUN** | Screenshot with overdraw debug on |
| Per-frame layer-rebuild count during the M255 pan | — | **NOT RUN** | GPU bar recording + `framestats` |
| Cadence half (three layers) | PASS | **PASS, device-free** | The two suites named in §4.1 |

---

## 5. M292 — the §38 10:47 PM scenario, walked

### 5.1 The pass condition, quoted

> ONE `decisionId` appearing across
> `compass_requested → compass_option_selected → recommendation_accepted →
> route_started → contribution_submitted` in the captured stream.

### 5.2 Prerequisites beyond §1

| # | Prerequisite | Note |
|---|---|---|
| Q1 | `map_telemetry_enabled` **TRUE on `portava-ci`** | Otherwise every event is dropped and the stream is empty. This is Lane C's flip; coordinate, because four lanes share one CI database. |
| Q2 | Location services **on**, permission granted | §38's scenario is a walk. |
| Q3 | A seeded viewport that can actually answer a Compass request | A refused Compass mints no `decisionId`, and the walk cannot start. |

### 5.3 Procedure

1. Note the wall-clock start and the signed-in viewer id.
2. Open the map. Confirm a `map_opened` event — it mints the `map_session_id`
   every later row carries.
3. Walk §38's scenario on the handset, in order: ask Compass → choose an option →
   accept the recommendation → start the route → arrive → submit a contribution.
4. Leave the app foregrounded long enough for the telemetry queue to flush.
5. Query the rows back from CI — **not** from the client:
   ```sql
   select event_name, map_session_id, seq, client_ts, synthesized_session, payload
   from public.map_telemetry_events
   where viewer_id = '<viewer>' and client_ts >= '<start>'
   order by seq;
   ```

### 5.4 Why the assertion is made on rows, not on client payloads

The census is explicit for M275's identical shape: *"queried back after the run —
not asserted on the client payloads."* A client that minted and threaded a
`decisionId` perfectly, while every event was dropped by the bounded queue,
refused by the payload scrubber, or discarded by a dark `map_telemetry_enabled`,
would satisfy a client-side assertion completely and land nothing.

### 5.5 Instrument

`travel-buddy-standalone/src/features/map/perf/decisionChain.ts`.

```ts
console.log(formatChainVerdict(gradeDecisionChain(rows)));
```

It grades four distinct failures separately, because they need different fixes:

- a **missing link** — and it names which;
- **all five present but out of order** — a `contribution_submitted` that preceded
  the `compass_requested` it is supposedly an outcome of is not an outcome loop;
- a chain **spanning two map sessions** — a correlation id that leaked, not one walk;
- rows that carried **no `decisionId`** — the threading broke, which looks
  identical to "the user never finished" unless it is counted.

Rows with `synthesized_session = true` are excluded, for the reason
`2202_map_telemetry.sql` gives in its own comment: they fired before any
`map_opened`, and a chain assembled from strays is not a walk.

An **empty stream FAILS.** It has to — "no `decisionId` was broken" is trivially
true of a capture containing nothing, and a device run that produced no telemetry
is the single most likely way for this row to "pass" with nothing having happened.

### 5.6 Ledger

| Walk | decisionId | events in order | Verdict | Evidence |
|---|---|---|---|---|
| §38 10:47 PM, seeded `portava-ci` | — | — | **NOT RUN** | — |

---

## 6. The instruments, and their own tests

The harness is device-free and is covered by the suite. These prove the
**instruments**; none of them is a measurement, and none may be entered in the
ledgers above.

| Module | Test | Runner |
|---|---|---|
| `src/features/map/perf/statistics.ts` | via the three below | — |
| `src/features/map/perf/coldStart.ts` | `src/features/map/perf/__tests__/coldStart.test.ts` | `npm test` |
| `src/features/map/perf/frameStats.ts` | `src/features/map/perf/__tests__/frameStats.test.ts` | `npm test` |
| `src/features/map/perf/decisionChain.ts` | `src/features/map/perf/__tests__/decisionChain.test.ts` | `npm test` |
| §34 cadence, pulsing zone | `src/components/map/__tests__/ActivityZone.gpuFriendly.component.test.tsx` | `npm run test:component` |
| §34 cadence, both flow layers | `src/components/map/__tests__/FlowLines.gpuFriendly.component.test.tsx` | `npm run test:component` |

Each harness module shares one property, asserted in its own suite: **a
measurement that did not happen reports NOT RUN or FAIL, never PASS.** An empty
cold-start sample, a `framestats` capture with no PROFILEDATA block, a
sub-100-frame pan and an empty telemetry stream all refuse. That property is the
only thing standing between this document and a row closed on a number nobody
took.

---

## 6. M88 / M89 — the BLE rungs, and why there is no procedure yet

### 6.1 The state, checked rather than remembered

M88 (§12 rung 3, local device proximity) and M89 (rung 4, peer relay /
checkpoint) are graded **N**, not W, and that grade is correct: the ladder slot
exists and the sensor does not. Verified on this branch, 2026-09-21:

| Fact | Checked how | Result |
|---|---|---|
| `CURRENT_STACK_CAPABILITIES` | `src/features/map/presence/presenceLadder.ts` | `bleScan`, `bleAdvertise`, `backgroundBle`, `uwb`, `localPeer` all **false** (`backgroundLocation` is the only true one) |
| A BLE package in the client | every dependency and devDependency in `travel-buddy-standalone/package.json` matched against `/ble\|bluetooth\|nearby\|multipeer/i` | **none** |
| The unreachable rungs | `src/features/map/presence/locateFriends.ts` `unsupportedRungs()` | rungs 3 and 4 reported unsupported, by name — and they fail on DIFFERENT capabilities: `RUNG_POLICY.local_proximity.requires` is `bleScan`, `RUNG_POLICY.peer_relay.requires` is `localPeer`. A module that gives one does not give the other. |

So there is nothing to point a handset at. A device session that "tested BLE"
today would be testing a refusal path, and a ledger row recording it as a BLE
measurement would be false.

### 6.2 What has to be true before a procedure can exist

Three things, in order, and none of them is a measurement:

1. **A product decision** to put a radio in the app at all. §12 is opt-in,
   group-scoped and auto-expiring, and BLE advertising is a different privacy
   surface from anything Portava ships today — a device that advertises is
   discoverable by anything listening, not only by the group.
2. **A BLE module** in the client (`react-native-ble-plx` or Expo's
   `expo-bluetooth` when it leaves preview), plus the iOS and Android
   background-mode entitlements, which a `preview` build must actually carry —
   a `preview` build without the background modes measures foreground-only BLE
   and reports a ceiling that is not the product's.
3. **`CURRENT_STACK_CAPABILITIES` flipped to match**, on both the client mirror
   above and the server record it mirrors — `bleScan` for M88, `localPeer` for
   M89, and `backgroundBle` before either can answer with the app backgrounded,
   which is the case §12 actually cares about. The census rows turn red on the
   module plus the capability and not before; flipping the constant without the
   module is the exact move the rows' "turns red when" clauses are written to
   prevent, and `unsupportedRungs()` would then report a rung the device cannot
   supply.

### 6.3 The procedure that WOULD run, written now so nobody invents it later

Recorded at the same standard as §2–§5 so the day the module lands, the
measurement is a checklist rather than a design exercise. It is **NOT RUN** and
cannot be run.

**Prerequisites, additional to P1–P6:** two physical handsets (P1 gives one),
both on the same EAS `preview` build id, Bluetooth on, location permission
granted at "while using" or better on both, and a room where the two can be
placed at a measured distance with no obstruction.

| Step | Action | What is recorded |
|---|---|---|
| B1 | Both devices sign in as members of the SAME temporary Locate group, with `locate_friends_enabled` TRUE on the seeded CI target (P3/P4). | group id, both account ids, TTL |
| B2 | Put the devices 2 m apart. Disable Wi-Fi and cellular on BOTH, so rungs 1 and 2 cannot answer and the ladder must fall to rung 3. | the airplane-mode state of each |
| B3 | Open Locate My Friends on device A. Wait for a rung-3 fix. | time from open to first rung-3 reading, and the reading itself |
| B4 | Repeat at 10 m, then at 30 m with one wall between. | reading and rung at each distance |
| B5 | Kill the app on device B; leave A open. | whether A degrades to rung 5 (last known) or reports rung 4 via a relay |
| B6 | Restore network on A only. | whether A returns to rung 1 and how long that takes |

**Pass condition, M88:** at 2 m and at 10 m, device A reports rung 3 with a
distance band, and the band is one §12 names (`Nearby ~40-80m` and its
siblings) — not a raw metre figure, which §12 deliberately does not surface.
Fewer than five completed reads at a distance reports **NOT RUN**, not PASS.

**Pass condition, M89:** with B unreachable directly, A reports rung 4 through a
third device or an explicit checkpoint, and the UI says so rather than
presenting a stale rung-3 reading as current. A rung that silently keeps showing
the last BLE fix is a FAIL, not a pass — that is the same staleness defect §10's
presence expiry exists to prevent.

### 6.4 Ledger

| Measurement | Distance | Rung reported | Band shown | Reads | Verdict | Evidence |
|---|---|---|---|---|---|---|
| M88 proximity | 2 m | — | — | — | **NOT RUN** (no BLE module in the stack) | — |
| M88 proximity | 10 m | — | — | — | **NOT RUN** (no BLE module in the stack) | — |
| M88 proximity | 30 m + wall | — | — | — | **NOT RUN** (no BLE module in the stack) | — |
| M89 peer relay | B unreachable | — | — | — | **NOT RUN** (no BLE module in the stack) | — |

---

## 7. Open blockers

| Blocker | Strands | What it would take |
|---|---|---|
| No physical handset (plan B4) | M254, M255, M292, M258's device half | One mid-tier Android phone, an EAS `preview` build, and `adb`. |
| `docs/architecture/map-sensing-certification.md` absent from this branch (plan blocker 6) | the certification ledger these four report into | Port it from `3c5a76fd2`. Integration owner's. |
| CI not seeded (plan B3) | M255 P4, M292 Q3 | Curated `geo_zones` / `protected_zones` / `intel_*` rows. Ops, not a migration. |
| `map_telemetry_enabled` on CI (plan B2) | M292 Q1 | Lane C's flip. Four lanes share one CI database — serialise it. |
| No BLE radio in the stack (§6) | M88, M89 | A product decision, a BLE module with background entitlements, and `CURRENT_STACK_CAPABILITIES` flipped to match — in that order. Not a device session: a second handset alone changes nothing. |
