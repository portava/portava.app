# Portava Wall — Certification Packet for the Four Rows a Tool Cannot Close

| Field | Value |
| --- | --- |
| **Rows in scope** | `census-wall.md` **W149**, **W159**, **W167**, **W168** |
| **Status of all four** | **STILL `X` (CANNOT-VERIFY).** Nothing in this document closes any of them. |
| **What this document is** | The packet — fixtures, harness, procedure, questions, thresholds and recording forms — that makes each remaining human or device step small, exact and reproducible. |
| **Date** | 2026-09-14 |
| **Related, not superseded** | `docs/architecture/wall-certification.md` (the construction certification) is untouched by this document and remains the citable source for construction claims. This packet covers only the four runtime/human rows that certification explicitly deferred. |

> **The one rule this document is written against.** A certification packet is a
> deliverable in its own right, and it is worth having only if nobody is tempted
> to skip to the end. **A fabricated frame-time number or an assumed designer
> sign-off is worse than an open row**, because an open row tells the truth about
> what is known. Every threshold below is stated *before* any result exists, and
> every result table below is **empty**. If you are reading this looking for the
> answer to "is the Wall 60 fps" or "did design sign off": nobody has measured
> it and nobody has signed. That is the finding.

---

## 0. What was automated, and what is left

| Row | Automated in this pass | What a human must still do | Time it should now take |
| --- | --- | --- | --- |
| **W149** performance | The 60-item feed, the server that serves it, the page boundaries, the build/capture/analysis commands, the pass rule | Run it on a physical Android phone | ~40 min, one person, one device |
| **W159** whitespace | The render set — five renderers × two densities × five widths, **actually rendered** and committed | Open one HTML file, answer four yes/no questions, sign | ~20 min, one designer |
| **W167** density | The same render set, built so the cards reach the *ceiling* the question is about | Answer one yes/no question on the same file, sign | included in the above |
| **W168** comprehension | The script, the recruiting screener, the failure threshold, the recording form | Recruit 5–8 people, run it unmoderated, record | ~1 week elapsed, ~3 h of work |

**Two decisions must be made by the owner before any of this runs.** They are in
§5. Neither is a judgement this lane is entitled to make, and both change what
gets measured.

---

## 1. W149 — frame-time capture on a named device

> **Requirement (census W149).** *"A frame-time capture on a named device — a
> Perfetto trace or Flipper frame graph on the supported Android floor, scrolling
> a 60-item For You feed with video, reporting the share of frames over 16.7 ms."*

### 1.1 Was a device or emulator available here? No. This is what was run to establish it.

This was checked rather than assumed, and it was checked in the direction of
trying to find one.

| Check | Command | Result |
| --- | --- | --- |
| Android platform tools on `PATH` | `which adb emulator sdkmanager avdmanager` | none present |
| SDK location | `echo "$ANDROID_HOME / $ANDROID_SDK_ROOT"`, `ls -d /opt/android* /usr/lib/android* ~/Android` | unset; no such directories |
| Any emulator binary anywhere on disk | `find / -maxdepth 6 \( -name adb -o -name emulator -o -name 'qemu-system-*' \) -type f` | **no matches** |
| Installable from apt? | `apt-cache policy android-sdk-platform-tools` | candidate `28.0.2+9` — but that package is `adb`/`fastboot` **only**. It contains no emulator and no system image. |
| Hardware virtualisation | `lscpu \| grep -i virtual`, `grep -c -E 'vmx\|svm' /proc/cpuinfo` | `Hypervisor vendor: KVM`; **0** occurrences of `vmx`/`svm` |
| KVM device node | `ls -l /dev/kvm`, `lsmod \| grep kvm` | **absent**; no module |

**The decisive fact is the last two rows, not the first four.** Missing tooling
is a download away. What is not a download away is acceleration: this container
is itself a KVM *guest*, `/dev/kvm` does not exist inside it, and no `vmx`/`svm`
flag is exposed to the guest — so nested virtualisation is unavailable. An
x86-64 Android system image could only run under pure software emulation (TCG).

That is why the answer is "no" rather than "not without effort":
**a software-emulated Android's frame times are a property of the host's
emulation speed, not of the device.** Installing several gigabytes of SDK to
produce a number that measures QEMU would be worse than producing no number,
because the number would look like evidence. **W149 stays `X`.**

Flipper was also considered and rejected as the primary path: it attaches to a
**debug** build, and a debug JS bundle plus the dev-support overhead makes
frame times unrepresentative of what ships. Perfetto against a release build is
the right instrument. Flipper remains acceptable only as a cross-check.

### 1.2 The exact procedure — UNEXECUTED

> **This procedure has not been run.** It is written to be run. Nothing below is
> a result.

#### Step 1 — the device

| Field | Value | Why |
| --- | --- | --- |
| Reference device | **Pixel 6a**, 1080×2400 at 411×914 dp | Named in census W149 as the supported-floor example. See §5.2 — the owner must confirm this is the *performance* floor. |
| OS | **Android 12 (API 31) or later** | Perfetto's `FrameTimeline` data source, which is what makes per-frame jank attributable to the app rather than to SurfaceFlinger, requires API 31+. On an older device use the fallback in Step 5b. |
| Build type | **Release**, not debug | A debug bundle measures the dev tooling. |
| Device state | Screen brightness fixed, airplane mode **off** (media must load), battery **> 50 %** and unplugged-then-plugged consistently, no other foreground apps | Thermal throttling and battery saver both silently change frame times. Record the state on the form in §1.4. |

#### Step 2 — the 60-item feed

The feed is **not** taken from a database. It is pinned in this repository so two
people's captures are of the same thing:

- `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts:56#export const FRAME_CAPTURE_ITEM_COUNT = 60;`
- `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts:148#export function buildFrameCaptureFeed(opts: FrameCaptureOptions): WallResponse {`
- Served by `travel-buddy-standalone/scripts/serve-wall-frame-fixture.ts`

**Why a fixture server and not Postgres.** W149 is the *client's* number: how
long the device takes to lay out, rasterise and composite while scrolling.
W146 is the *server's* number and is a separate open row with a separate owner.
Database latency, `feature_flags` state and ranking non-determinism are noise
for a frame trace and would make two captures incomparable. The fixture removes
exactly those and nothing else: identical JSON in, identical component tree out.
Authentication is **not** stubbed — the client takes its bearer token from
Supabase directly (`travel-buddy-standalone/src/services/apiToken.ts:43#export async function freshToken(): Promise<string | null> {`),
not from the API base URL, so the capture still runs as a real signed-in session.

The fixture also serves `GET /api/feature-flags` with the Wall flags on, because
the Wall tab is hidden until the client sees `wall_enabled`. That lets the
capture be driven the way a user drives it — by tapping the tab.

**Media is the one thing this repository cannot supply, and it is the thing that
matters most.** Image decode and video compositing are the largest per-frame
costs in a media feed. `WALL_FIXTURE_MEDIA_BASE` is therefore **required and has
no default**; `buildFrameCaptureFeed` throws without it
(`travel-buddy-standalone/src/features/wall/certification/__tests__/WallFrameCaptureFixture.component.test.ts:25#  it('refuses to build a media-free feed', () => {`).

> **A capture run against a media base that 404s is not a passing capture.**
> Confirm on-device that photographs and video are visibly loading before you
> start the trace. A feed of empty placeholder wells will scroll at a flawless
> 60 fps and mean nothing.

Serve any 10 JPEGs at roughly 1600×1200 as `image-0.jpg` … `image-9.jpg` and
3 short H.264 MP4s as `video-0.mp4` … `video-2.mp4` from any static host.

```bash
# terminal 1 — media (any static server; this is only an example)
cd /path/to/your/fixture-media && python3 -m http.server 8081

# terminal 2 — the pinned feed
cd travel-buddy-standalone
WALL_FIXTURE_MEDIA_BASE=http://<LAN-IP>:8081 \
  node --import tsx scripts/serve-wall-frame-fixture.ts
# prints: items 60, page size 20 -> 3 pages
```

Use the machine's **LAN IP**, not `localhost` — the phone resolves these URLs.

#### Step 3 — build and install

```bash
cd travel-buddy-standalone
EXPO_PUBLIC_API_BASE_URL=http://<LAN-IP>:8788 \
  npx expo run:android --variant release
```

Keep the Supabase environment variables as they normally are: auth must stay
real. Only the API base moves.

Package under test: **`com.passporttravelbuddy.app`**.

#### Step 4 — navigation, and the scroll that is being measured

1. Sign in normally.
2. Tap the **Wall** tab. (The fixture's flag response makes it visible. If it is
   still hidden, deep-link instead:
   `adb shell am start -a android.intent.action.VIEW -d "travelbuddy://wall" com.passporttravelbuddy.app`
   — the route file records deep link as the reachable path while the flag is off.)
3. Wait for the first page to settle and for images to appear. **Do not trace the cold start** — first-mount cost is a different question from scroll frame time.
4. Start the trace (Step 5).
5. Scroll **from item 1 to the end of item 60 and back to the top**, at a steady
   continuous pace, roughly 8–12 seconds each way. Do not fling-and-wait; a
   settled fling measures mostly idle frames.
6. Stop the trace.

Item 60 is reached across **three server pages** (`artifacts/api-server/src/routes/wall.ts:124#const DEFAULT_LIMIT = 20;`),
so the scroll includes **two mid-scroll `onEndReached` fetches and two list-data
replacements while the thumb is still moving**. Those are the moments a feed
drops frames and they are deliberately inside the measured window.

#### Step 5a — capture (Perfetto, API 31+, primary path)

```bash
curl -O https://raw.githubusercontent.com/google/perfetto/main/tools/record_android_trace
chmod +x record_android_trace

./record_android_trace \
  -o wall-w149.perfetto-trace \
  -t 30s -b 64mb \
  sched freq gfx view wm am binder_driver \
  --atrace-app com.passporttravelbuddy.app
```

`gfx` and `view` are the atrace categories that carry the app's frame work;
`record_android_trace` enables the `android.surfaceflinger.frametimeline` data
source, which is the one that produces per-frame *actual* timings attributed to
the app.

#### Step 5b — capture (fallback, API 23–30, no FrameTimeline)

```bash
adb shell dumpsys gfxinfo com.passporttravelbuddy.app reset
# ...perform the scroll...
adb shell dumpsys gfxinfo com.passporttravelbuddy.app framestats > wall-w149-framestats.csv
```

`framestats` gives per-frame timestamps in nanoseconds; frame duration is
`FRAME_COMPLETED − INTENDED_VSYNC`. This path is **weaker** — it cannot
distinguish app jank from SurfaceFlinger jank — and a capture taken this way
must say so on the form.

#### Step 6 — the metric, computed not eyeballed

```bash
# Perfetto trace_processor (https://perfetto.dev/docs/analysis/trace-processor)
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

`dur` is in nanoseconds; 16.7 ms = `16700000` ns.

### 1.3 The pass/fail threshold — fixed in advance

> **PASS requires BOTH of the following. Either one failing is a FAIL.**
>
> **T1 — sustained smoothness.** At most **5 %** of app frames during the
> measured scroll exceed **16.7 ms** (`pct_over_16_7ms <= 5.0`).
>
> **T2 — no perceptible hitch.** **No single frame** exceeds **100 ms**
> (`worst_frame_ms < 100`).

**Why two numbers and not one.** A mean or a p50 hides the failure mode people
actually complain about. A feed can hold a 98 % on-time frame rate and still feel
broken if the 2 % lands as one 400 ms freeze when page two arrives. T1 is about
whether scrolling feels smooth; T2 is about whether it ever visibly stalls — and
T2 is the one most likely to catch the mid-scroll data replacement in Step 4.

**Why 5 % and not 0 %.** Zero is unachievable on a real device — GC, thermal
drift and the compositor guarantee occasional long frames — so a 0 % rule would
be failed by a perfect implementation and would therefore be ignored. 5 % of
frames over budget across a ~20 s scroll is roughly one hiccup per second at the
worst, which is at the edge of noticeable. It is a threshold that a good build
passes and a bad build fails, which is the only property a threshold needs.

**Why this is falsifiable.** Both numbers come out of one SQL query over a trace
file that can be attached to the result. Anyone can re-run the query on the same
trace and get the same answer, or re-run the capture and disagree. Neither
number is a judgement and neither can be argued into a pass.

**What a FAIL would mean, stated now so it cannot be renegotiated later.** A
fail does not automatically mean the Wall is wrong: the four windowing constants
at `travel-buddy-standalone/src/features/wall/components/WallFeed.tsx:151#      initialNumToRender={10}`
(and the three below it) are the first thing to tune, and only one of the four is
observable from any existing test. A fail moves W149 to **`W` (BUILT-BUT-WRONG)**,
not to `X`.

### 1.4 W149 result form — EMPTY, to be filled by whoever runs it

| Field | Value |
| --- | --- |
| Date of capture | |
| Operator (name) | |
| Device model / build fingerprint | |
| Android version / API level | |
| App build (git sha, `--variant`) | |
| Capture path | ☐ Perfetto FrameTimeline ☐ `gfxinfo framestats` (weaker — see 5b) |
| Media base actually served (and confirmed loading on device?) | ☐ confirmed loading |
| Battery % at start / charger state / thermal state | |
| `frames` | |
| `over_16_7ms` | |
| `pct_over_16_7ms` | |
| `worst_frame_ms` | |
| **T1 (≤ 5 %)** | ☐ PASS ☐ FAIL |
| **T2 (no frame ≥ 100 ms)** | ☐ PASS ☐ FAIL |
| **Verdict** | ☐ PASS → propose W149 `X → C` ☐ FAIL → propose W149 `X → W` |
| Trace file archived at | |
| Signature / date | |

---

## 2. W159 — designer sign-off on whitespace and density

> **Requirement (census W159).** *"A named designer's sign-off, or refusal,
> against a screenshot set of the five object renderers at the supported width
> range, recorded in this census with a date."*

### 2.1 The artifact — this one WAS actually rendered

**`docs/architecture/wall-cert-render-set.html`** exists in this repository. It
is not a specification of a screenshot set; it is the set, built by running the
real renderers.

| Property | Value |
| --- | --- |
| Contents | 5 object renderers × 2 densities × 5 widths = **50 rendered cards** |
| Renderers | `SocialPostWallItem`, `VideoWallItem`, `PostcardWallItem`, `SharedMomentWallItem`, `DiscoveryWallItem` |
| Widths | 320, 360, 390, 411, 430 dp (`travel-buddy-standalone/src/features/wall/certification/wallCertFixtures.ts:97#export const CERT_WIDTHS = [320, 360, 390, 411, 430] as const;`) |
| Built by | `travel-buddy-standalone/src/features/wall/certification/__tests__/WallCertRenderSet.webrender.test.tsx` |
| Re-emit | `cd travel-buddy-standalone && WALL_CERT_EMIT=1 npx jest -c jest.web.config.js WallCertRenderSet` |
| How to review | Open the file in a browser. No build, no toolchain, no device. |

**Were these rendered, or only specified? Rendered.** The markup in that file
came out of the actual component tree through `react-dom` with the real
`react-native-web` stylesheet attached. It is not a mock-up and not a
description.

### 2.2 The four fidelity limits — read before signing

The page states all four on its own face as well, so a reviewer cannot sign
without seeing them.

1. **It is `react-native-web`, not React Native on Android.** Layout, spacing and
   type scale come from the real component code, but shadow rendering, font
   metrics and text measurement differ from a device. It is a sound instrument
   for judging **density, rhythm and whitespace** — which is precisely what W159
   and W167 ask — and it is **not** evidence about pixel-exact device
   appearance. A reviewer who wants the latter should ask for device screenshots
   instead; §5.1 records that as an open option.
2. **Media wells are empty.** Every fixture deliberately carries no media URL, so
   `WallImage` takes its own "No preview" branch at the real aspect ratio. No
   bytes are fetched. **Every card is therefore lighter than it will be with a
   photograph in it** — which biases the review *toward* a pass on density. If
   the ceiling card already looks too dense with an empty well, that is a strong
   result; if it looks fine, remember what is missing.
3. **Icons are substituted.** `lucide-react-native` is replaced repo-wide under
   jest by a stand-in that renders nothing, and `react-native-web` drops its
   `size`, so icons would otherwise occupy zero width and pull adjacent text
   14–26 px left. The page draws a neutral 16 px square in their place. Real Wall
   icon sizes, counted from the `size={icon.N}` call sites: 14 (×10), 16 (×8),
   20 (×4), 22 (×2), 26 (×2).
4. **The page requests Roboto**, the Android platform font the app inherits (the
   app sets no `fontFamily` anywhere and never calls `useFonts`). If Roboto did
   not load, wrapping will not match the device. The page says so at the top;
   check it before judging any width.

### 2.3 The review questions — answerable without reading any code

Answer each **YES or NO**. Where the answer is NO, name the card id and width
(both are printed under every card, e.g. `postcard-ceiling` at 320 dp).

| # | Question | YES | NO |
| --- | --- | --- | --- |
| **Q1** | Across all five renderers at all five widths, does the spacing read as **generous** rather than cramped? | ☐ | ☐ |
| **Q2** | Is there any width at which a card reads as **visually broken** — text colliding, a chip row wrapping badly, an element clipped or orphaned? *(NO is the good answer here.)* | ☐ | ☐ |
| **Q3** | At **430 dp**, does the whitespace still read as deliberate, rather than as **emptiness** — lines too long to scan, elements too far apart to group? | ☐ | ☐ |
| **Q4** | Are the five object types **visually distinguishable from one another at a glance** — is a Postcard obviously not a Post with a badge? | ☐ | ☐ |

Cards that are NO: _______________________________________________

### 2.4 W159 threshold — fixed in advance

> **PASS** = **Q1 YES, Q2 NO, Q3 YES, Q4 YES**, signed by a named designer, dated.
>
> **FAIL** = any other combination. A fail must name at least one card id and
> width, so that it points at something changeable.
>
> **NOT A RESULT** = an unsigned review, an undated one, or one by someone who is
> not the named design owner. This is not pedantry: W159's whole content is
> *whose* judgement it is.

**Why this is falsifiable.** The outcome is a named person's recorded yes or no
against a named, digest-pinned artifact, with a refusal required to cite a
specific card. It can be disagreed with by another designer, and it can be shown
to have been about the wrong thing (if the digest has moved — see §2.5). What it
cannot be is quietly assumed.

### 2.5 The sign-off cannot silently go stale

The committed page carries a `RENDER-DIGEST:` of the markup it was built from,
and `WallCertRenderSet.webrender.test.tsx:334#  it('the committed sign-off artifact is still what the renderers produce', () => {`
fails the build if the renderers no longer produce it.

**This is the point of the harness, not a nicety.** A design sign-off names an
artifact and a date. If the renderers move afterwards, the signature comes to
cover something that is no longer shipping — which is exactly how a "certified"
row rots into a lie. Here it cannot happen quietly: change a renderer and the
test goes red and says, in its failure message, that any recorded sign-off is
**void** and names the one command that re-emits the page. Verified by mutation:
widening the chip cap from 3 to 6 turns this test red, and restoring it turns it
green.

---

## 3. W167 — is the ceiling density already too much?

> **Requirement (census W167).** *"The same designer sign-off, answering one
> question this census cannot — whether one action row + at most three chips +
> at most one context thread per card is already too much."*

### 3.1 The reviewer must be looking at the ceiling, not at a typical card

This is the trap W167 sets, and it is why the render set has two densities. A
designer shown a quiet social post will say the density is fine, and will have
answered a question nobody asked. The **`-ceiling`** cards in the render set are
built to reach the maximum the code can currently emit:

- one action row (stamp / comment / share / save / not-interested),
- the full **three** contextual chips — and a **fourth** eligible action that the
  cap drops, so the cap is demonstrably binding rather than merely unreached
  (`travel-buddy-standalone/src/features/wall/certification/wallCertFixtures.ts:156#export const CEILING_DROPPED_LABEL = 'See who is going';`),
- the Ask Compass affordance on the place line,
- a place line,
- **one** context thread,
- over text and a media well.

That composition is asserted, per renderer, at
`WallCertRenderSet.webrender.test.tsx:303#  it('the ceiling cards carry the exact composition W167 asks a human to rule on', () => {`.
The cap it is measured against is
`travel-buddy-standalone/src/features/wall/components/objects/wallItemShared.tsx:430#      {actions.slice(0, 3).map((action, idx) => (`.

### 3.2 The question

Review **only the `-ceiling` cards**, at **320 dp** (the worst case) and at
**390 dp**.

| # | Question | YES | NO |
| --- | --- | --- | --- |
| **Q5** | Is **one action row + three chips + one context thread on a single card already too dense** for the Wall's intended feel? | ☐ | ☐ |

**If YES, the refusal must be actionable.** Answer the follow-up:

- The maximum number of contextual chips I would accept on one card is: **____**
- ☐ The context thread should not appear on a card that already has chips
- ☐ The Ask Compass affordance is one affordance too many
- ☐ Other: _______________________________________________

### 3.3 W167 threshold — fixed in advance

> **PASS** = **Q5 = NO**, signed and dated by the named designer.
>
> **FAIL** = **Q5 = YES** *with* a stated maximum chip count or a named element
> to remove.
>
> **NOT A RESULT** = Q5 = YES with no number and no named element. "Too busy" on
> its own changes nothing and cannot be checked later.

**Why this is falsifiable.** The answer is a number or a named element, not an
adjective. If the designer says the maximum is 2, that is a claim the code can be
made to satisfy and a test can then hold — the `slice(0, 3)` cap becomes
`slice(0, 2)` and the existing guard moves with it. A threshold that produces a
new enforceable constant is the only kind of aesthetic threshold worth writing
down.

---

## 4. W168 — unmoderated comprehension test

> **Requirement (census W168).** *"An unmoderated comprehension test — five to
> eight people who have never seen the Wall, asked what the screen is and what
> the Live strip is telling them, with the failure threshold agreed in advance
> and the result recorded."*

### 4.1 What "unmoderated" commits you to

No researcher in the room, no prompting, no clarifying. Participants see the
stimulus and type answers into a form. This matters because the failure mode
being tested for is *a person not understanding on their own*, and a moderator
who says "and what do you think that bar at the top does?" has already supplied
the comprehension being measured.

### 4.2 Recruiting screener

Recruit **5–8** participants (8 preferred; below 5 the test does not satisfy the
requirement). Screen **out** anyone who:

- has used Portava, or has seen the Wall in any form, including in a design review;
- works on Portava, or is related to or lives with someone who does;
- was a participant in a previous round of this test.

Screen **for** a spread across: at least 2 who describe themselves as infrequent
social-media users, and at least 2 who travel less than once a year. Both groups
are the ones most likely to read a travel-social feed as something else.

Record the screener answers. A test whose participants turn out to have seen the
Wall is not a test.

### 4.3 Stimulus

One static screenshot, or a short silent screen recording, of the **For You**
Wall on a phone, showing the header, the Live For You strip, and the first two
to three feed cards — including at least one card that is **not** a plain post.

The stimulus **must be taken from a real device build**, not from the
`react-native-web` render set in §2. The render set is a design-review
instrument with four stated fidelity limits (§2.2) and two of them — empty media
wells and substituted icons — would materially change what a stranger thinks
they are looking at.

### 4.4 The script — exactly this, in this order, no additions

Participants type free-text answers. **Do not offer multiple choice**: a
recognition task measures something easier than comprehension.

1. Look at this screen for as long as you like, then answer in your own words.
   **What is this screen for? What would you use it to do?**
2. **Whose content are you looking at?** How do you think it got here?
3. Look at the strip across the top. **What is it telling you?**
4. **Is anything on this screen live or happening right now?** How can you tell?
5. Point to anything you **did not understand** or that felt like jargon. Quote
   the exact words.
6. If you tapped the item at the top of the feed, **what would you expect to
   happen?**
7. On a scale of 1–5, **how confident are you** that you understood this screen?
   (1 = not at all, 5 = completely.)

### 4.5 Scoring rubric — fixed before recruiting

Two scorers grade independently, then reconcile. Each participant is graded on
three binary items:

| Item | Passes when the participant… |
| --- | --- |
| **C1 — what the screen is** | (Q1) describes it as a feed/stream of travel posts from people, **without** being told. Accepting "a social feed for travel" and "posts from people I follow about trips". Rejecting "a search results page", "a booking site", "a list of places", "I don't know". |
| **C2 — what the Live strip says** | (Q3 or Q4) conveys that it shows things happening **now** or **recently**, at places. Rejecting "adverts", "stories", "my photos", "I don't know", and any answer that only repeats a word from the screen without meaning. |
| **C3 — no jargon wall** | (Q5) names **zero** viewer-facing words they did not understand. A named word is recorded verbatim; one uncomprehended word fails this item for that participant. |

### 4.6 W168 threshold — fixed in advance, before any participant is recruited

> **PASS** requires **all three**:
>
> **P1.** **≥ 75 %** of participants pass **C1** (6 of 8, or 4 of 5).
> **P2.** **≥ 60 %** of participants pass **C2** (5 of 8, or 3 of 5).
> **P3.** **No single word or phrase** is named as not understood by **more than
> one** participant.
>
> **FAIL** = any of P1, P2, P3 not met. A fail must list the failing item and, for
> P3, the exact words.
>
> **NOT A RESULT** = fewer than 5 participants, a moderated session, a screener
> not recorded, or scoring by one person.

**Why the bar for C2 is lower than for C1.** "What is this screen" is the
requirement's core — a person who cannot answer it has not understood the Wall
at all. The Live strip is a secondary surface; some people will not look at it
in a static stimulus, and holding it to the same bar would fail the row for a
reason about the *test* rather than about the product.

**Why P3 exists and is absolute.** C1 and C2 are proportions and can absorb one
confused participant. Vocabulary cannot: if two strangers independently trip on
the same word, that word is a defect, and it is the *only* part of this row a
tool already guards — the machinery-vocabulary scanner in
`WallDesignSystem.component.test.tsx` refuses twenty internal terms in
viewer-facing strings. P3 is what would catch a *product* word that is plain
English and still meaningless, which no scanner can find.

**Why all of this is falsifiable.** Every threshold is a count over recorded
answers. Two scorers grading independently makes disagreement visible instead of
absorbed. Re-running with new participants can contradict the result.

### 4.7 W168 result form — EMPTY

| Field | Value |
| --- | --- |
| Dates run | |
| Researcher / who recruited | |
| Two scorers (names) | |
| Threshold ratified in advance by (name, date) | |
| Stimulus (build sha, device, file) | |
| Participants recruited / completed | ___ / ___ |
| Screener records archived at | |
| **C1 passes** | ___ / ___ (P1 needs ≥ 75 %) ☐ PASS ☐ FAIL |
| **C2 passes** | ___ / ___ (P2 needs ≥ 60 %) ☐ PASS ☐ FAIL |
| **Words named by > 1 participant** | (P3 fails if non-empty) |
| **Verdict** | ☐ PASS → propose W168 `X → C` ☐ FAIL → propose W168 `X → W` |
| Raw responses archived at | |
| Signature / date | |

---

## 5. Two decisions the owner must make first

Neither is this lane's to make, and both change what gets measured. **Both are
unanswered as of this document's date.**

### 5.1 What is the supported width range?

**Nothing in this repository declares one.** `app.json` sets no minimum width,
the theme declares no breakpoints, and — measured, not assumed — **the Wall
reads no viewport width at all**: `grep -rn 'useWindowDimensions\|Dimensions.get' src/features/wall/`
returns nothing. Width therefore switches no layout in the Wall; it only changes
where text wraps, how tall a fixed-aspect media well is, and whether the
three-chip row wraps.

**320–430 dp is proposed here, not established.** The reasoning is in
`wallCertFixtures.ts` alongside the array. Confirm or replace it before the
review runs; if it changes, edit `CERT_WIDTHS`, re-emit, and the reviewer never
touches the harness.

**Also to decide:** whether the sign-off may be given against the
`react-native-web` render set at all, or must be given against device
screenshots. §2.2 states the four fidelity limits honestly so the owner can
decide with them in hand. If device screenshots are required, the render set
still serves as the shot list — it names every card and width that must be
captured.

### 5.2 What is the *performance* floor device?

Two different floors are in play and the packet cannot pick between them.

- The **API floor** is **24** (Android 7.0) — the Expo SDK 54 default, which
  `app.json` does not override.
- The **device floor** named by census W149 is a **Pixel 6a**, which is a 2022
  mid-tier phone.

These are far apart. A phone at API 24 is dramatically weaker than a Pixel 6a,
and a 60 fps pass on the latter says nothing about the former. **Someone must
decide which device the 60 fps promise is made about**, because it is a product
commitment, not a measurement. §1.2 is written for the Pixel 6a and is correct
for whatever device is chosen with the model name swapped — except that a device
below API 31 must use the weaker `gfxinfo` fallback in Step 5b.

---

## 6. What was built in this pass

| Path | What it is | Registered by |
| --- | --- | --- |
| `travel-buddy-standalone/src/features/wall/certification/wallCertFixtures.ts` | Deterministic W159/W167 review fixtures: 5 renderers × 2 densities, widths, captions | imported by the harness |
| `travel-buddy-standalone/src/features/wall/certification/__tests__/WallCertRenderSet.webrender.test.tsx` | Renders the set, guards coverage / ceiling composition / reproducibility / artifact freshness | `jest.web.config.js` `testMatch` → `test:component` → `check:all` |
| `docs/architecture/wall-cert-render-set.html` | **The rendered review artifact.** 50 cards. Open in a browser. | generated; guarded by the digest assertion |
| `travel-buddy-standalone/src/features/wall/certification/wallFrameCaptureFixture.ts` | The pinned 60-item W149 feed and its paging | imported by the server and the guard test |
| `travel-buddy-standalone/src/features/wall/certification/__tests__/WallFrameCaptureFixture.component.test.ts` | Guards item count, media presence, video presence, renderable types, paging, reproducibility | `jest.config.js` `testMatch` + `test:component` `--testPathPattern` |
| `travel-buddy-standalone/scripts/serve-wall-frame-fixture.ts` | Stub server for the capture: `/wall`, `/wall/live`, `/wall/quick-media`, telemetry, `/feature-flags` | dev tooling; deliberately outside the Metro module graph |

---

## 7. Proposed census verdicts

**Reported, not written.** `census-wall.md` is the integration lead's to edit;
this lane proposes and does not touch it.

| id | old | proposed | evidence |
| --- | --- | --- | --- |
| W149 | `X` | **stays `X`** | No device and no usable emulator here — established by the six checks in §1.1, of which the decisive ones are `/dev/kvm` absent and zero `vmx`/`svm` flags, making an emulated capture a measurement of QEMU. Packet delivered: pinned 60-item fixture, stub server, exact build/navigate/capture/analyse commands, and a two-part threshold (§1.3). **Unexecuted.** |
| W159 | `X` | **stays `X`** | No designer has reviewed anything. The review artifact now exists and was actually rendered (`docs/architecture/wall-cert-render-set.html`, 50 cards), with four questions, a fixed threshold and a dated signature line (§2). **Unsigned.** |
| W167 | `X` | **stays `X`** | Same sign-off, not given. The ceiling composition the question is about is now built and asserted rather than left to whatever the reviewer happened to be shown (§3.1), and a refusal is required to yield a number the code can be held to (§3.3). **Unsigned.** |
| W168 | `X` | **stays `X`** | No participants have been recruited and no session has been run. Screener, seven-question unmoderated script, two-scorer rubric, three-part pre-agreed threshold and an empty result form are in §4. **Unexecuted.** |

**All four stay `X`.** The packet is the deliverable; the rows are not closed and
claiming otherwise would be the failure this document was written to avoid.
