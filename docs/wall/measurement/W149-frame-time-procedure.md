# W149 — frame-time capture procedure

| Field | Value |
| --- | --- |
| **Census row** | `docs/architecture/census-wall.md` **W149** — "60 fps scroll on supported devices" |
| **Status** | **`?` (CANNOT-VERIFY). This procedure has not been run.** Nothing in this file is a result. |
| **What it needs** | One physical Android phone, one operator, a laptop on the same LAN, ~40 minutes |
| **What it does not need** | Any change to Wall code. The fixture, the stub server and the guard tests already exist. |
| **Origin of the thresholds** | `docs/architecture/wall-certification-packet.md` §1.3, which fixed them before any result existed. **They are not restated as new numbers here** — restating a threshold is how a threshold gets quietly loosened. This file is the operator's copy of the same procedure, expanded so it can be followed at the keyboard without cross-referencing. |

> **Read this before anything else.** The result table at the end is **empty**.
> No capture has been taken, on any device, by anybody. If you are looking for
> the answer to "is the Wall 60 fps", the answer is that nobody knows. Do not
> fill any field below with an estimate, a guess, or a number from a different
> build. A blank row is the truth; a plausible number is a lie that will be
> cited later as evidence.

---

## Step 0 — NAME THE DEVICE. This is the first step because the repo does not name one.

**This repository does not state a supported Android device floor.** That was
checked, not assumed:

- `travel-buddy-standalone/app.json` sets no `minSdkVersion`, no
  `compileSdkVersion` and no device requirement. Its Android block is
  permissions, package name and intent filters only.
- `travel-buddy-standalone/eas.json` declares build profiles and environment
  variables. No device floor, no API level.
- There is no `android/` directory — the app is managed/prebuild, so there is no
  checked-in `build.gradle` stating a floor either. The only `minSdk` string
  anywhere in the package is a fallback default of `24` inside a vendored
  module, `travel-buddy-standalone/vendor/expo-openmls/android/build.gradle`,
  which is that module's own default and **not** a product commitment.
- The census row itself hedges: it says *"the supported floor, **e.g.** a Pixel
  6a"*. An "e.g." is not a named device.

So there are two candidate floors and **they are far apart**: the Expo SDK 54
API floor (API 24, Android 7.0) and the census's example device (Pixel 6a, a
2022 mid-tier phone). A pass on a Pixel 6a says nothing about a phone at API 24.

> **Do not start until the owner has written a device model on the line below.**
> W149's claim is "60 fps on supported devices". Which devices those are is a
> **product commitment**, not something a measurement can discover. Capturing on
> whatever phone is in the drawer produces a number about that phone, and the
> row will not move on it.

| Field | Value |
| --- | --- |
| Device model the 60 fps promise is made about | |
| Named by (owner) | |
| Date named | |

*(unfilled — no device has been named)*

If the named device is **API 31 or later**, use the Perfetto path (Step 5a).
If it is **below API 31**, the `FrameTimeline` data source does not exist and
you must use the weaker `gfxinfo` fallback (Step 5b) **and say so on the form**.

---

## Step 1 — device state

Set all of these and record them. Thermal throttling and battery saver both
change frame times silently, and a capture taken in an unrecorded state is not
comparable to the next one.

- Screen brightness **fixed** (not auto).
- Battery **> 50 %**, and note whether it is on the charger. Keep it the same
  across runs.
- Airplane mode **OFF** — the media must load. This is not optional; see Step 3.
- No other foreground apps; kill recents.
- Let the phone sit for two minutes after installing before capturing, so
  install-time compilation and any thermal spike have settled.

---

## Step 2 — put a 60-item video-bearing For You feed in front of yourself

**Do not build the feed from the database.** The feed is pinned in this
repository so two people's captures are of the same thing:

- `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts:56` — `export const FRAME_CAPTURE_ITEM_COUNT = 60;`
- `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts:148` — `buildFrameCaptureFeed`, deterministic: same options in, byte-identical out
- `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts:256` — `pageOf`, which slices it into real cursor pages
- Served by `travel-buddy-standalone/scripts/serve-wall-frame-fixture.ts`
- Guarded by `travel-buddy-standalone/src/features/wall/certification/__tests__/WallFrameCaptureFixture.component.test.ts` — item count, media presence, video presence, renderable types, paging and reproducibility

**Why a fixture and not Postgres.** W149 is the *client's* number: how long the
device takes to lay out, rasterise and composite while scrolling. The server's
first-page number is a different open row (W146) with a different owner, and its
in-repo guard lives at `artifacts/api-server/src/test/wallPerformance.test.ts`.
Database latency, `feature_flags` state and ranking non-determinism are noise
for a frame trace and would make two captures incomparable. Authentication is
**not** stubbed — the client takes its bearer token from Supabase, not from the
API base URL — so the capture still runs as a real signed-in session.

### 2a — media. The one thing the repo cannot supply, and the thing that matters most.

Image decode and video compositing are the largest per-frame costs in a media
feed. `WALL_FIXTURE_MEDIA_BASE` is **required and has no default**;
`buildFrameCaptureFeed` throws without it rather than emitting a feed of empty
wells.

You must supply, from any static host reachable by the phone:

- `image-0.jpg` … `image-9.jpg` — roughly 1600×1200 photographs, not solid colours
- `video-0.mp4` … `video-2.mp4` — short H.264 clips

> **A capture run against a media base that 404s is NOT a passing capture and
> must not be recorded as one.** A feed of empty placeholder wells scrolls at a
> flawless 60 fps and means nothing. Before you start the trace, look at the
> phone and confirm photographs and video are visibly loading. There is a
> checkbox for this on the form and it is the most important one.

### 2b — run the two servers

```bash
# terminal 1 — media. Any static server; this is only an example.
cd /path/to/your/fixture-media && python3 -m http.server 8081

# terminal 2 — the pinned feed
cd travel-buddy-standalone
WALL_FIXTURE_MEDIA_BASE=http://<LAN-IP>:8081 \
  node --import tsx scripts/serve-wall-frame-fixture.ts
```

It prints `items: 60` and `page size: 20`. Use the laptop's **LAN IP**, not
`localhost` — the phone is what resolves these URLs.

---

## Step 3 — build and install

The app is Expo managed with no checked-in `android/` directory, so this command
prebuilds and then compiles:

```bash
cd travel-buddy-standalone
EXPO_PUBLIC_API_BASE_URL=http://<LAN-IP>:8788 \
  npx expo run:android --variant release
```

- **`--variant release` is not optional.** A debug bundle plus dev-support
  overhead measures the dev tooling, not the app. This is also why Flipper is
  the cross-check and not the primary instrument (Step 5c).
- Keep the Supabase environment variables exactly as they normally are. Only the
  API base moves. Auth must stay real.
- Package under test: **`com.passporttravelbuddy.app`**
  (`travel-buddy-standalone/app.json`).

Record the git sha you built from:

```bash
git rev-parse --short HEAD
```

---

## Step 4 — the scroll that is being measured

1. Sign in normally.
2. Tap the **Wall** tab. The fixture server answers `GET /api/feature-flags`
   with the Wall flags on, so the tab is visible. If it is still hidden:
   ```bash
   adb shell am start -a android.intent.action.VIEW \
     -d "travelbuddy://wall" com.passporttravelbuddy.app
   ```
3. Wait for the first page to settle and for images to appear.
   **Do not trace the cold start.** First-mount cost is a different question from
   scroll frame time, and including it will dominate the result.
4. Start the trace (Step 5).
5. Scroll **from item 1 to the end of item 60 and back to the top**, at a steady
   continuous pace, roughly 8–12 seconds each way. **Do not fling-and-wait** — a
   settled fling measures mostly idle frames and will pass anything.
6. Stop the trace.

**Why the full 60 and not the first screen.** The server page size is 20
(`artifacts/api-server/src/routes/wall.ts:122`, `const DEFAULT_LIMIT = 20;`), and
the fixture serves real pages, so reaching item 60 means the device performs
**two mid-scroll `onEndReached` fetches and two list-data replacements while your
thumb is still moving**. Those are the moments a feed drops frames and they are
deliberately inside the measured window.

What is being exercised is the four windowing constants declared at
`travel-buddy-standalone/src/features/wall/components/WallFeed.tsx:151`
(`initialNumToRender={10}`, and `maxToRenderPerBatch`,
`updateCellsBatchingPeriod`, `windowSize` below it). Only the first is
observable from any existing test; the other three act **only** while scrolling,
which is the entire reason this row needs a device.

---

## Step 5a — capture, Perfetto (API 31+, primary path)

```bash
curl -O https://raw.githubusercontent.com/google/perfetto/main/tools/record_android_trace
chmod +x record_android_trace

./record_android_trace \
  -o wall-w149.perfetto-trace \
  -t 30s -b 64mb \
  sched freq gfx view wm am binder_driver \
  --atrace-app com.passporttravelbuddy.app
```

`gfx` and `view` are the atrace categories carrying the app's frame work.
`record_android_trace` enables the `android.surfaceflinger.frametimeline` data
source, which is what produces per-frame **actual** timings attributed to the
app rather than to SurfaceFlinger.

## Step 5b — capture, `gfxinfo` fallback (API 23–30 only)

```bash
adb shell dumpsys gfxinfo com.passporttravelbuddy.app reset
# ...perform the scroll from Step 4...
adb shell dumpsys gfxinfo com.passporttravelbuddy.app framestats > wall-w149-framestats.csv
```

`framestats` gives per-frame timestamps in nanoseconds; frame duration is
`FRAME_COMPLETED − INTENDED_VSYNC`. **This path is weaker** — it cannot
distinguish app jank from SurfaceFlinger jank — and a capture taken this way
must be marked as such on the form.

## Step 5c — Flipper (cross-check only, never the primary result)

Flipper attaches to a **debug** build. A debug JS bundle plus dev-support
overhead makes frame times unrepresentative of what ships, so a Flipper frame
graph is acceptable only as a sanity cross-check alongside a Perfetto capture,
never as the recorded result on its own. If you run it: attach Flipper to a
debug build, open the **Performance / frame graph** plugin, perform the same
Step 4 scroll, and note qualitatively whether the jank pattern matches the
release trace. Record it in the notes, not in the verdict.

---

## Step 6 — the exact counter to read, and how the share is computed

**Which counter.** `actual_frame_timeline_slice.dur`, filtered to the app's
`upid`. That is the *actual* end-to-end duration of a frame produced by the app
process. Not `expected_frame_timeline_slice` (that is the budget, not the
outcome), and not SurfaceFlinger's own slices.

**How "share of frames over 16.7 ms" is computed.** Not eyeballed off a graph —
run this and paste the numbers onto the form:

```bash
trace_processor_shell wall-w149.perfetto-trace -q - <<'SQL'
SELECT
  COUNT(*)                                            AS frames,
  SUM(CASE WHEN dur > 16700000 THEN 1 ELSE 0 END)     AS over_16_7ms,
  ROUND(100.0 * SUM(CASE WHEN dur > 16700000 THEN 1 ELSE 0 END) / COUNT(*), 2)
                                                      AS pct_over_16_7ms,
  ROUND(MAX(dur) / 1e6, 2)                            AS worst_frame_ms
FROM actual_frame_timeline_slice
WHERE upid = (SELECT upid FROM process WHERE name = 'com.passporttravelbuddy.app');
SQL
```

`dur` is in **nanoseconds**; 16.7 ms = `16700000` ns.
`pct_over_16_7ms` is the number the census row asks for.

For the 5b fallback, compute the same share from the CSV:
`over = count(FRAME_COMPLETED − INTENDED_VSYNC > 16700000)`, `share = over / total`.

---

## Step 7 — the pass/fail line

These thresholds are fixed in advance in
`docs/architecture/wall-certification-packet.md` §1.3. **Do not renegotiate them
after seeing a number.**

> **PASS requires BOTH. Either one failing is a FAIL.**
>
> - **T1 — sustained smoothness.** `pct_over_16_7ms <= 5.0`
> - **T2 — no perceptible hitch.** `worst_frame_ms < 100`

**Why two numbers.** A mean or a p50 hides the failure people actually complain
about. A feed can hold a 98 % on-time frame rate and still feel broken if the
2 % lands as one 400 ms freeze when page two arrives. T1 is whether scrolling
feels smooth; T2 is whether it ever visibly stalls — and T2 is the one most
likely to catch the mid-scroll data replacement in Step 4.

**What a FAIL means, stated now so it cannot be renegotiated later.** A fail does
not automatically mean the Wall is wrong. The four windowing constants at
`travel-buddy-standalone/src/features/wall/components/WallFeed.tsx:151` are the
first thing to tune. A fail moves W149 to **`W` (BUILT-BUT-WRONG)**, not to `C`
and not to `X`.

---

## Result table — **EMPTY. UNFILLED. NO CAPTURE HAS BEEN TAKEN.**

> Every field below is blank on purpose. This table records a measurement that
> **has not happened**. Leave a field blank rather than filling it with anything
> you did not read off a trace on the device named in Step 0.

| Field | Value |
| --- | --- |
| Device (model, as named in Step 0) | |
| OS version / API level | |
| Build sha (`git rev-parse --short HEAD`) | |
| Build variant | ☐ release ☐ debug *(debug is not a valid result)* |
| Date of capture | |
| Operator (name) | |
| Capture path | ☐ Perfetto FrameTimeline ☐ `gfxinfo framestats` (weaker — Step 5b) |
| Media base served | |
| Media confirmed visibly loading on device | ☐ confirmed *(required — see 2a)* |
| Battery % at start / charger / thermal state | |
| Frames captured (`frames`) | |
| Frames over 16.7 ms (`over_16_7ms`) | |
| **Share over 16.7 ms (`pct_over_16_7ms`)** | |
| Worst frame (`worst_frame_ms`) | |
| **T1 — share ≤ 5 %** | ☐ PASS ☐ FAIL |
| **T2 — no frame ≥ 100 ms** | ☐ PASS ☐ FAIL |
| **Verdict** | ☐ PASS → propose W149 `? → C` ☐ FAIL → propose W149 `? → W` |
| Trace file archived at | |
| Flipper cross-check run? (notes only, not the verdict) | |
| Operator signature / date | |

**This table is unfilled.** It contains no measurement, no estimate and no
placeholder. When it is filled, the trace file must be archived alongside it —
a frame-time number whose trace has been thrown away cannot be re-checked by
anyone and is therefore not evidence.

---

## Who does what next

| Who | What |
| --- | --- |
| **Owner** | Name the device in Step 0. Until that line has a model on it, nothing below it is worth running. |
| **Operator with the device** | Steps 1–7, then fill the table and archive the trace. |
| **Integration lead** | Move W149 in `docs/architecture/census-wall.md` on the filled, signed table — `C` on a PASS, `W` on a FAIL. Not on this document, which is only the procedure. |
