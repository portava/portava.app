# Portava Media v2 — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt` |
| **`.docx` reconciliation** | Extracted `word/document.xml`, stripped tags, whitespace-normalised, diffed against the `.txt`. **The only differences are three XML entity escapes** (`&amp;` in the title, and no `&lt;`/`&gt;` in this spec). The `.txt` is a faithful transcription; the "`.docx` is authority" clause never had to be exercised. |
| **Section count** | The brief said 50 sections. **50 top-level sections is correct**, but the spec also carries **11 numbered subsections** (§4.1, §6.1, §15.1, §15.2, §16.1, §16.2, §16.3, §23.1, §31.1, §46.1, §46.2) — **61 numbered units**. Counting only the 50 undercounts §16 (three subsections, 31 requirements) and §46 (two subsections, 14 requirements) badly. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. Backend paths relative to `artifacts/api-server/src/`, client paths to `travel-buddy-standalone/` unless stated. |
| **Database** | Not queried. Production storage facts are the ones supplied as ground truth plus the committed snapshot `artifacts/api-server/baseline/20260907_production_tables.txt` and `src/scripts/checkProductionDrift.ts:168-176`. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a `file:line` that was opened and read. |

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **449** |
| BUILT-AND-CORRECT | **PLACEHOLDER_C** |
| BUILT-BUT-WRONG | **PLACEHOLDER_W** |
| NOT-BUILT | **PLACEHOLDER_N** |
| CANNOT-VERIFY | **PLACEHOLDER_Q** |
| **CONSTRUCTED%** = (C+W)/449 | **PLACEHOLDER_CONS** |
| **CORRECT%** (raw) = C/449 | **PLACEHOLDER_CORR** |
| **CORRECT% (spec-attributable)** | **PLACEHOLDER_ATTR** |
| CANNOT-VERIFY share | **PLACEHOLDER_QP** |

Three things a reader should take before the table.

**1. This is the first spec of the six censused so far whose attribution is not zero.**
Two completed sibling censuses returned 0.0 % spec-attributable and I tested rather than
assumed. Media is different: 62 non-test files in the tree carry the literal string
`Media v2`, migrations `2250`/`2255`/`2256`/`2257` name their phase and their spec section
in their own headers (`2250_media_asset_canonical_model.sql:1-5` — *"Media v2 — Phase 1
(Canonical Foundation) … the full spec §6 MediaAsset / §6.1 MediaAttachment domain
model"*), and `routes/mediaWorld.ts:1-11` maps its seven endpoints onto §43/§4.1/§13/§23/
§27/§30/§17/§21 by number. **Nearly all of the correct column here was built for this
document.** That is a real and unusual finding, and it is the strongest thing I can say
about the Media programme.

**2. The whole thing is dark, and the surface that is not dark is the one §46.2 forbids.**
`MEDIA_WORLD_SHELL_ENABLED` is seeded `false` and migration `2300_phantom_feature_flag_rows.sql:36-42`
says so in its own words: *"The `/media-world` route exists and is reachable by nothing.
The most consequential of the five: the entire Media v2 surface was un-flippable without a
migration."* Behind that one flag sit the §15 action rail, the §44/§45 north-star telemetry,
and the §32 Compass viewer affordances. Meanwhile the Media tab's mode set is seeded
`MEDIA_VIEW_MODE_FULLSCREEN_ENABLED = true` (`2037_media_tab_flags.sql:17-20`) and the
store's default mode is `'watch'` (`src/stores/mediaStore.ts:104,145`) — a full-screen
vertical autoplaying video feed (`src/components/media/WatchFeed.tsx:1-8`,
`WatchVideoCell.tsx:158` `shouldPlay={isActive}`) with a Stamp/comment/save counter rail
(`WatchItemOverlay.tsx:403-437`). §46.2 forbids exactly that, twice.

**3. I disagree with `media-v2-certification.md` on two of its eight properties and on its
whole cannot-verify list.** See §5. The short version: property 6 (§46.2 anti-patterns)
is certified against the new shell rather than against Media, and four of the five
"runtime-QA required" items are ordinary code questions whose answer is *absent*. The
Passport census found six of seven Runtime-QA items were not requirements at all; Media's
inflation is a different shape — the items **are** requirements, they are just not
unanswerable.

---

## 1. Denominator: how 449 was counted

One requirement = one independently testable assertion — one that reading **this tree**
could falsify. The rule, stated so a re-run can reproduce it:

- **A bullet asserting a required property or prohibition = 1.** (§2's ten principles,
  §16.2's eight protections, §46's eleven visual rules, §46.2's nine anti-patterns.)
- **A table row naming a required artifact, signal, state or behaviour = 1.** (§5's six
  mode rows, §25's seven trust dimensions, §28's seven object definitions, §44's twenty
  telemetry signals, §48's twelve ownership rows.)
- **A declared TypeScript interface = 1 for the contract**, plus one per member that
  carries independent behaviour. §10's `IntelligenceEligibility` is 7 (the contract plus
  `reasons`, `freshnessClass`, and the three separate confidences and `expiresAt`, each of
  which is a distinct thing that must be computed); §33's two unions are 1 each.
- **A named endpoint, screen, service, file, phase or pipeline stage = 1.** §43's
  seventeen routes are seventeen; §41's fifteen services are fifteen; §9's ten pipeline
  stages are ten.
- **ASCII mockups contribute 0**, except where the mockup is the only place a required
  artifact is named. This is the one judgement call that materially moves the number.
  Media's spec is mockup-heavy; decomposing the mockups would have pushed the denominator
  past 700 and would have double-counted §40, which already names every component the
  mockups draw. So §4.1, §13, §14, §19, §20, §22 and §47 contribute their *named artifact*
  and not their pixels.
- **Narrative and restatement = 0.** §1's surface table describes seven *other* products'
  primary questions and asserts nothing about Media (**0**). §50's fifteen-verb funnel and
  its "engineering north star" paragraph restate §2/§45 (**0**).
- **Duplicates merge to one id.** The eleven screens appear in both §4 and §40; they are
  counted once, at §4, and §40 contributes only its components/services/state/types. §9's
  four `X ≠ TRUTH` banners restate §2's evidence-candidate principle (MD5) and are not
  re-counted. §5's MY WORLD row and §30's Grid·Timeline·Map line are one requirement.

Per-section contribution:

`§hdr 1 · §1 0 · §2 10 · §3 6 · §4 11 · §4.1 1 · §5 6 · §6 4 · §6.1 5 · §7 10 · §8 4 ·
§9 10 · §10 7 · §11 5 · §12 5 · §13 1 · §14 7 · §15 12 · §15.1 1 · §15.2 1 · §16 1 ·
§16.1 13 · §16.2 8 · §16.3 10 · §17 6 · §18 7 · §19 6 · §20 1 · §21 2 · §22 2 · §23 7 ·
§23.1 6 · §24 24 · §25 7 · §26 7 · §27 2 · §28 7 · §29 2 · §30 3 · §31 7 · §31.1 5 ·
§32 13 · §33 4 · §34 5 · §35 2 · §36 9 · §37 12 · §38 8 · §39 8 · §40 35 · §41 15 ·
§42 4 · §43 17 · §44 20 · §45 9 · §46 11 · §46.1 5 · §46.2 9 · §47 1 · §48 12 · §49 10 ·
§50 0` = **449**.

### The rule for "built the forbidden thing"

§46.2 is a list of things Media must not be. Several §2 principles are the same assertion
in positive form. Where the tree contains a *working implementation of the forbidden
pattern*, the requirement is **BUILT-BUT-WRONG**, not NOT-BUILT — the construction
happened, it just went the wrong way. Where the forbidden path simply does not exist and
nothing guards against it being added, the verdict is **NOT-BUILT (unguarded absence)**,
following the sibling censuses.

A second rule that decides a dozen verdicts: **a spec about *Media* is not satisfied by a
subsystem of Media.** Where the World shell honours a principle and the shipped Watch
surface violates it, the verdict is W. Scoring the shell alone would reproduce exactly the
error I identify in the certification.

### Flag-dark is a deployment fact, not a verdict

Following the Wall census: a correct, complete implementation behind a flag seeded OFF is
**BUILT-AND-CORRECT**, and the darkness is reported separately (§4 below). A verdict is
about construction. This is why the correct column is much higher than the amount of Media
a user can currently reach, and why §4 exists.

### Method caveat inherited from `src/scripts/checkWriterlessReads.ts`

That script declares its own writer attribution INCOMPLETE (*"A dynamic `.from(expr)`
anywhere makes attribution incomplete, and the run says so rather than pretending
otherwise"*). A `from("table")` grep misses variable and RPC access. Every "nothing writes
X" below was settled by opening the call sites, not by counting greps — the two that
matter (`media_assets`, `media_intent_signals`) are cited with the line that decides them.

---

## 2. Attribution — built *for* this spec, or pre-existing?

Two completed sibling censuses returned **0.0 %** attributable. I tested the same question
here and got a different answer.

```
grep -rl "Media v2" --include=*.ts --include=*.tsx --include=*.sql \
  artifacts/api-server/src travel-buddy-standalone/src travel-buddy-standalone/app \
  | grep -v test
→ 45 files
```

plus the whole `services/media/` and `src/features/media/` trees, whose headers cite this
spec by section number without using the phrase: `MediaProjectionService.ts:2`
(*"(§41/§42)"*), `MediaPerspectiveService.ts:2` (*"(§41) … §12/§13"*),
`MediaExperienceResolver.ts:2` (*"(§23/§41)"*), `MediaActionResolver.ts:2`
(*"(§15/§41/§43)"*), `MyWorldMemoryService.ts:2` (*"(§31 / §31.1)"*),
`MediaViewRequestService.ts:2` (*"Media v2 Phase 10 (§19)"*),
`lib/media/mediaTimeBands.ts:2` (*"the §17 Time Architecture"*),
`lib/media/mediaEvidenceEligibility.ts:2` (*"§35 Evidence-Safe Editing + §10"*),
`lib/hiddenGemState.ts:2` (*"Media v2 Phase 8, §16"*),
`compass/CompassMediaContext.ts:2` (*"(§32)"*),
`src/features/media/state/lens.ts:2` (*"spec §3/§5"*),
`src/features/media/telemetry/mediaTelemetry.ts:2` (*"spec §44/§45"*).

Method for the split: a BUILT verdict is **spec-attributable** when the artifact it cites
either names this spec/phase in its own header, or was created by a migration in the
Media v2 band (`2250`–`2257`, `2300`). It is **pre-existing** when the artifact predates
the programme and the spec merely happens to describe it — `lib/mediaProcessing.ts` (EXIF
stripping, written for the privacy audit), `lib/delayedPostPublisher.ts` (§34, a
pre-existing product feature), `services/ranking/MediaFeedRankingService.ts`,
`lib/mediaPipeline.ts`, `lib/mediaAccess.ts`, `services/hiddenGems/*` except the
contribution service, the whole `posts`/`post_media` spine, and the entire legacy
Watch/Grid/Gems client surface.

| | count | share of 449 |
| --- | --- | --- |
| BUILT-AND-CORRECT, spec-attributable | **PLACEHOLDER_CA** | **PLACEHOLDER_CAP** |
| BUILT-AND-CORRECT, pre-existing | PLACEHOLDER_CP | PLACEHOLDER_CPP |

**So: CORRECT% (spec-attributable) = PLACEHOLDER_ATTR2.** The programme is real; the
pre-existing share is mostly §33/§34/§36/§37 (upload, moderation, delayed publishing,
video), which the spec inherited rather than commissioned.

---

## 3. What is actually reachable — the deployment reality

None of the verdicts below turn on this section, and every number in the headline is a
construction number. But a reader who stops at CORRECT% will be misled, so:

| Gate | Seed | What it holds shut |
| --- | --- | --- |
| `MEDIA_WORLD_SHELL_ENABLED` | `false` (`2300:113-116`) | The entire §3–§5 six-lens shell, the §15 action rail (`app/media-viewer/[id].tsx:568`), the §44/§45 north-star emitter (`MediaActionRail.tsx:51` is its only caller), the §32 viewer affordances. `/media-world` is a registered route reachable from no UI. |
| `MEDIA_TAB_ENABLED` | `false` (`2037_media_tab_flags.sql:7-10`) | The Media tab itself. Deep-links still resolve. |
| `media_canonical_enabled` | `false` (`0191_media_assets.sql`, postcondition in `2250`) | Every write to `media_assets`. `lib/mediaAssets.ts:118` — `if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return null;` — is the first line of `recordMediaAsset`, and `routes/posts.ts:256` and `mediaAssets.ts:495` are its only two call sites. **The §6 canonical asset table has no live writer.** |
| `media_evidence_enabled` | `false` (`2255`, postcondition raises if seeded ON) | The §9/§35 media→intel evidence seam. |
| `media_request_a_view_enabled` | `false` (`2257`, same postcondition) | §19 Request-a-View. |
| `trip_readiness_enabled`, `MEDIA_RANKING_ENABLED`, `MEDIA_*_BOOST_*` | `false` | Ranking; the live feed falls back to chronological. |

And three tables the code targets are **absent from production** (`baseline/20260907_production_tables.txt`;
`scripts/checkProductionDrift.ts:173-176` classifies each *"In portava-ci, absent from production"*):
`media_intent_signals` (§15.1 "I Want This"), `media_view_requests` and
`media_view_request_optins` (§19). A fourth, `hidden_gem_contributions` (§16.3), is on the
same list at `checkProductionDrift.ts:172`. `routes/hiddenGems.ts:78` imports the
contribution service that reads it.

So §15.1, §19 and §16.3 are code-correct against storage that does not exist where it
matters. I have kept them BUILT-AND-CORRECT because the code question is settled, and
listed them here and in §7 so nobody reads those rows as "shipped".

---

## 4. Reconciliation with `docs/architecture/media-v2-certification.md`

That report is dated 2026-09-03, is scoped to *"the cross-cutting non-negotiables in §2,
§16.2, §33, §35, §36, §37, §39, §44, §46/§46.2"*, derives **eight load-bearing properties**
from them, and returns **CERTIFIED (construction)** with all eight PASS. It was written
against a spec that was not in the repo. It is now.

**Where I agree — six of eight, and they hold up under a 449-cell mesh.**

| # | Certification property | My finding |
| --- | --- | --- |
| 1 | No precise-location leak | **Agree, with a dated correction below.** `lib/media/mediaProjection.ts:76-97` — `MediaProjection` has no `lat`/`lng` field at all, so the leak is unrepresentable in the type, not merely absent from the copy list. `mediaLocationVisibility.ts:354,542` binds owner tier and gem ceiling before the venue is named. |
| 2 | No fabricated live | **Agree, and it is stronger than the report says.** `mediaFreshness.ts:21` types media freshness as `"fresh" \| "recent" \| "historical"` — the string `live` is structurally unavailable. `mediaTimeBands.ts:16-32` then makes prediction-as-live a *droppable violation* rather than a convention. |
| 3 | Gem de-anonymisation closed | Agree. `mediaLocationVisibility.ts:601` `loadRestrictiveGems` throws rather than returning empty, and the undetermined branch coarsens to `'city'`. Fail-closed on every path I read. |
| 4 | Truth boundary | Agree. `lib/media/mediaEvidenceEligibility.ts:14-19` — an unrecognised edit operation is `unknown` and therefore not evidence-eligible; a generative asset stays fully social. |
| 5 | All new capabilities flag-gated OFF | Agree, and §3 above adds the one the report omits: `media_canonical_enabled`, which means the §6 canonical table has no writer. |
| 8 | Owner-only / privacy | Agree. `MyWorldMemoryService.ts:26-30` and `routes/mediaWorld.ts:220-243` resolve identity from the session only. |
| 7 | Telemetry §44 | **Half-agree.** The forbidden-key guard is real and the payload is coarse. But the report certifies §44 as a *property* when §44 is a **twenty-signal table**, and the emitter covers eight of them, three of those eight are declared "reserved: no rail trigger yet" (`mediaTelemetry.ts:64-77`), and its only call site is inside the flag-dark action rail. §44 scores 8 C / 12 N below, not PASS. |

**Where I disagree.**

**(a) Property 6 (§46.2 anti-patterns) is certified against the wrong object.** The
report's evidence is that *"the World shell is a dashboard … the existing Watch feed is
left untouched and additive, not the new primary."* Both halves are true. But §46.2 is a
list of what **Media** must not be, not a list of what the newest shell must not be, and
the surface a user reaches is `app/(tabs)/media.tsx:55-58` with `defaultMode = 'watch'`
(`src/stores/mediaStore.ts:104,145`) — `WatchFeed.tsx:1-8` *"full-screen vertical video
feed … renders a paging list"*, autoplaying on viewability (`WatchVideoCell.tsx:158`
`shouldPlay={isActive}`; `WatchFeedList.tsx:526` drives `isActive` from viewability
tracking), with a Stamp / comment / save counter rail (`WatchItemOverlay.tsx:403-437`,
`formatCompactCount` at `:134`). That is four §46.2 anti-patterns implemented and working:
*TikTok-style endless vertical video feed*, *Heart/Like as primary hierarchy*, *Autoplay as
primary navigation*, *Full-screen stranger video immediately on Media open*. "Additive, not
the new primary" is the exact inversion — the anti-pattern is the primary and the
compliant shell is the addition, and the compliant shell is behind a flag that
`2300:36-42` says makes it *"reachable by nothing."* I score §46.2 as 4 W / 5 C.

**(b) Property 1's second defence was certified two days before it was provable.** The
report lists *"Fail-closed boundary scrub … applied to every assembled World-shell
response"* as one of two independent non-vacuous defences on 2026-09-03. On 2026-09-05
someone wrote `routes/mediaWorld.ts:71-83` and `src/test/mediaWorldBoundaryScrub.test.ts:1-24`,
which say in their own words: *"Until 2026-09-05 this whole second line of defence was
untested wiring … The scrub could have been deleted from all seven endpoints and nothing
would have noticed — which is the definition of a defence that is not there."* The
certification's own §7 rule was *"no property is marked PASS without running its test"* —
and the test it ran (`mediaWorldProjection.test.ts`) proved defence **1**, which is
precisely why it could not have failed if defence 2 were deleted. The property is fine
today. The certification's evidence for it was not, on the day it was written. This is the
one place I would call the report wrong rather than narrow.

**(c) The cannot-verify bucket is inflated — a different shape from Passport's.**
The Passport census found six of seven "Runtime QA" items were not requirements in the
spec at all. Media's five are all genuine spec content. The inflation is that **four of
the five are ordinary code questions, and the answer is "absent".**

| Certification "runtime-QA required" | My verdict | Why it is not runtime-QA |
| --- | --- | --- |
| *Video playback on device (§37) — adaptive playback, captions, upload resume/retry, background upload, transcoding* | **NOT-BUILT ×6** | Whether an HLS/DASH manifest, a caption track, a resumable uploader, a background-upload task or a transcoder **exists** is answerable by reading the tree, and none does: no `m3u8`/`hls`/`dash`/`textTrack`/`resumable`/`transcod` anywhere in `travel-buddy-standalone/src` or `artifacts/api-server/src`; `lib/mediaProcessing.ts:18-22` states outright *"Videos are NOT transcoded here (no ffmpeg in this tier)"*. Calling these "device QA" moves six absent features out of the gap column. Genuinely device-dependent: playback smoothness and the *quality* of adaptation — not their existence. |
| *Offline / degraded mode on device (§39)* | **NOT-BUILT ×7, C ×1** | §39 names seven things to cache. The tree has one: `state/freshness.ts` `cachedAsOfLabel`, used once (`MediaWorldShell.tsx:97`). There is no media cache, no trip-media bundle, no saved-place cache, no gem cache, no map-thumbnail cache. Absence is a construction fact. |
| *Real-traffic latency & ranking (§24)* | **mixed, mostly W/N** | §24 is a list of 24 named ranking signals. Which of them the ranker reads is a code question; I answer it signal by signal below. Only the resulting *quality* is traffic-dependent. |
| *Device accessibility (§46)* | **CANNOT-VERIFY ×1** | I agree with this one, narrowly: lived contrast/dynamic-type/screen-reader behaviour is not in the tree. It costs one requirement, not eleven. |
| *HTTP suites need `listen(2)`* | not a requirement | Environment note. Fair. |

**Net verdict on the certification.** Its eight properties are a defensible selection and
six survive intact — this is a better artifact than most in `docs/architecture/`. But it
certified **construction of a subsystem** and was read as certifying Media: it scores 8/8
on a mesh with no cell for "the forbidden surface is the default", no cell for "the §6
canonical store has no writer", and no cell for "three of the tables this code targets are
absent from production". At 449 cells Media is **PLACEHOLDER_CORR correct**. I would not
call Media v2 certified.

---

## 5. Requirement-by-requirement

Verdict key: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT ·
**?** CANNOT-VERIFY. A cell reading `**N** ×6` is one verdict applied to the six
consecutive ids named in that row's id column; each id is still individually addressable.
Every BUILT verdict cites a file I opened.

### Header — design constraint

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD1 | Media must not visually or behaviourally resemble Facebook/Instagram/TikTok/YouTube; the hierarchy is World → Experience → Place → Time → People → Media, not Creator → Post → Engagement | **W** | The hierarchy is built and correct in `src/features/media/state/lens.ts:24-31` (six lenses in §3 order) and `screens/MediaWorldShell.tsx:1-15`. It is not the product: the reachable Media surface is `app/(tabs)/media.tsx:55-58` Watch·Grid·Gems with `defaultMode='watch'` (`src/stores/mediaStore.ts:104,145`), and `2300_phantom_feature_flag_rows.sql:36-42` records that `/media-world` *"is reachable by nothing."* |

### §1 Executive Summary — 0 requirements

The eight-row surface table states the *primary question* of Pulse, Discovery, Map, Media,
Compass, Trips, Passport, Telegraph. Seven of those rows assert nothing about Media, and
the Media row (*"What does the world actually look and feel like?"*) is restated as a
testable structure by §3 and §4.1. Narrative.

### §2 Non-Negotiable Product Principles

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD2 | World-first, not creator-first | **W** | World-first exists (`services/media/MediaProjectionService.ts:439` groups by zone before anything else; `lib/media/mediaProjection.ts:95` comments the contributor as *"visible but secondary"*). The live ranker is creator-first: `services/ranking/MediaFeedRankingService.ts:11-15` lists `activeCreatorBoost`, `newCreatorBoost`, `returningCreatorBoost`, `underexposedBoost` as its boost layer and `:16` a per-creator fatigue layer. Creator identity is the ranking axis there, not the world. |
| MD3 | No infinite-feed dependency | **W** | `src/components/media/WatchFeed.tsx:1-8` — *"full-screen vertical video feed … renders a paging list"* — is the default mode of the shipped tab. The World shell has no infinite feed; the shell is not what ships. |
| MD4 | Media does not own truth; Live Intelligence owns current claims and confidence | **C** | `MediaProjectionService.ts:379` `readCurrentState` is the only source of a current-state label and it delegates to `lib/liveClaimRead.readLiveClaimEnvelopes`; `:1-22` states the rule. `lib/media/mediaFreshness.ts:2-12` keeps media freshness a pure age function. |
| MD5 | A photo or video may become an evidence candidate but never becomes truth automatically | **C** | `lib/media/mediaEvidenceLink.ts:130` — `if (!(await isFlagEnabled(sc, MEDIA_EVIDENCE_FLAG))) return refuse("flag_disabled")` — the seam is dark, and even ON it produces a *link*, not a claim: `:69-74` is a refusal taxonomy, and the module never writes `intel_claims`/`intel_state_snapshots`. |
| MD6 | Observed, inferred, user-claimed, generated and predicted information remain distinguishable | **C** | `lib/media/mediaTimeBands.ts:16-32` — Typical is tagged `historical_pattern`, Likely-Next `portava_prediction`, both `NON_OBSERVATION` source classes, both constructed `live:false`. `mediaEvidenceEligibility.ts:38-48` carries the §6 eight-value source vocabulary including `generated`. |
| MD7 | Every meaningful media object connects to action or context | **C** | `services/media/MediaActionResolver.ts:1-33` resolves a per-item action set against the same authorization gate as each target endpoint; `routes/mediaActions.ts:43` serves it. Contextual open: `MediaWorldShell.tsx:63-78` stages the place's other perspectives rather than a global feed. |
| MD8 | Authentic media outranks generated fallback media | **N** | *Unguarded absence.* No `source_type` / provenance term appears in `MediaFeedRankingService.ts` or in the World-shell ordering (`MediaProjectionService.ts:846-848` sorts by `capturedAt` only). Nothing would prevent generated media from outranking authentic media if any existed. |
| MD9 | Privacy, location precision, blocks, trust and eligibility resolve before client projection | **C** | `routes/mediaWorld.ts:18-33` states the invariant and `MediaProjectionService.ts:344` `projectCandidatesProtected` enforces it — every non-owner projection passes `lib/mediaEligibility.filterEligibleMediaCandidates` and then the `lib/mediaLocationVisibility` choke point before shaping. |
| MD10 | Hidden Gems are first-class and require stronger protection than normal Places | **C** | `lib/mediaLocationVisibility.ts:354` `resolveMediaLocationWithGemProtection` applies the stricter of asset tier and gem ceiling; `:542` `gemCeilingForItem` matches by canonical place **and** coordinate proximity; `:601` `loadRestrictiveGems` throws so the caller treats the batch as undetermined rather than open. |
| MD11 | Success is measured by useful real-world outcomes, not merely minutes watched | **W** | The outcome vocabulary exists (`src/features/media/telemetry/mediaTelemetry.ts:71-78`, eight §45 events) and is dark. The live ranker multiplies by `watchCompletionRate`, `qualifiedViewCount` and `rewatchRate` (`MediaFeedRankingService.ts:60-70`) — minutes watched is a first-class ranking input on the surface that ships. |

### §3 Primary Navigation — the six lenses

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD12 | NOW — current visual state around the viewer (city visual pulse, changing-now zones, relevant opportunities) | **C** | `MediaProjectionService.ts:439` `buildWorldProjection` → `cityVisualState` + `forYouNow` + `changingNow`; client `screens/MediaWorldScreen.tsx`. |
| MD13 | PLACES — visual reality organised around canonical Places (Current View mosaics, time rail, place state, actions) | **C** | `MediaProjectionService.ts:503` `buildPlaceProjection`; client `screens/MediaPlacesScreen.tsx:170,213` renders time and map modes. |
| MD14 | EXPERIENCES — media organised around real-world experiences | **C** | `services/media/MediaExperienceResolver.ts:1-14`, resolving a canonical Event or Trip; client `screens/MediaExperiencesScreen.tsx:56`. |
| MD15 | HIDDEN GEMS — protected discovery and current Gem state | **W** | The lens exists but is not a Media v2 projection: `MediaWorldShell.tsx:24` imports the **pre-existing** `components/media/GemsFeed.tsx` and there is no `/media/gems` endpoint in `routes/mediaWorld.ts` (the seven registered routes at `:96,120,149,196,221,245,271` do not include one). §43's `GET /media/gems` is unserved and the lens shows the old feed. |
| MD16 | PEOPLE — explicitly social lens | **C** | `MediaProjectionService.ts:587` `buildPeopleProjection` (the only builder that requests `needFollows: true`, `routes/mediaWorld.ts:214`); client `screens/MediaPeopleScreen.tsx`. |
| MD17 | MY WORLD — owner library and personal experience history | **C** | `MediaProjectionService.ts:660` `buildMyWorldProjection`; `services/media/MyWorldMemoryService.ts:1-33`; client `screens/MyWorldMediaScreen.tsx`. |

### §4 Screen Architecture — the eleven screens

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD18 | Media World / NOW | **C** | `src/features/media/screens/MediaWorldScreen.tsx` |
| MD19 | Media Places | **C** | `src/features/media/screens/MediaPlacesScreen.tsx` |
| MD20 | Media Experience | **C** | `src/features/media/screens/MediaExperiencesScreen.tsx` |
| MD21 | Hidden Gems Media | **N** | No `HiddenGemsMediaScreen`; `find src app -iname "*HiddenGemsMediaScreen*"` → nothing. The lens reuses `components/media/GemsFeed.tsx`, which predates the programme. |
| MD22 | People Media | **C** | `src/features/media/screens/MediaPeopleScreen.tsx` |
| MD23 | My World Media | **C** | `src/features/media/screens/MyWorldMediaScreen.tsx` |
| MD24 | Media Viewer | **C** | `src/features/media/screens/MediaPerspectiveViewerScreen.tsx`, routed at `app/media-perspective/`, entered with a staged entry-context (`MediaWorldShell.tsx:63-78`) rather than a global feed. |
| MD25 | Media Map | **N** | No `MediaMapScreen`. The §21 *projection* exists server-side (`MediaProjectionService.ts:916`); the screen does not, and `MyWorldMediaScreen.tsx:95-99` renders the map mode as a placeholder — *"A map of everywhere you've been arrives with the Media Map phase."* |
| MD26 | Media Timeline / Time Rail | **N** | No `MediaTimelineScreen`. Time is a *mode* inside Places/NOW (`MediaWorldScreen.tsx:52`), not the standalone screen §4 names. `components/MediaTimeRail.tsx` exists. |
| MD27 | Media Search | **N** | No `MediaSearchScreen`, no `mediaSearch` service, no `/media/search` route. |
| MD28 | Media Contribution | **N** | No `MediaContributionScreen` and no `MediaContributionSheet`. |

### §4.1 Media World / NOW

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD29 | The default page is a visual dashboard of the world, not a list of creator posts | **W** | The dashboard is built (`MediaWorldShell.tsx:1-15`: header + 6-lens tab bar + per-lens mode bar). It is not the default page: `app/(tabs)/media.tsx:186-190` hides the World entry behind `MEDIA_WORLD_SHELL_ENABLED`, seeded false (`2300:113-116`), and the default is Watch. |

### §5 Presentation Modes

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD30 | NOW: Overview · Map · Time | **C** | `state/lens.ts:25`; rendered at `MediaWorldScreen.tsx:52,75`. |
| MD31 | PLACES: Overview · Visual · Map · Time | **C** | `state/lens.ts:26`; `MediaPlacesScreen.tsx:170,213`. |
| MD32 | EXPERIENCES: Overview · Visual · Map | **C** | `state/lens.ts:27`; `MediaExperiencesScreen.tsx:56`. |
| MD33 | HIDDEN GEMS: Overview · Visual · Map | **W** | Declared at `state/lens.ts:28`, but the lens renders the pre-existing `GemsFeed`, which has its own filter bar and honours none of the three modes. The mode bar is drawn over a component that ignores it. |
| MD34 | PEOPLE: Visual | **C** | `state/lens.ts:29`; `MediaPeopleScreen.tsx:12` documents visual-only. |
| MD35 | MY WORLD: Grid · Timeline · Map | **W** | Grid and Timeline render (`MyWorldMediaScreen.tsx:118`); Map is a typed placeholder (`:95-99`). Two of three. |

### §6 / §6.1 Canonical domain model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD36 | `MediaAsset` canonical contract (id, owner/uploader, type, storage, dimensions, size, timestamps, statuses, visibility, provenance, eligibility, version) | **W** | The table is complete and matches the spec: `0191_media_assets.sql:12-40` plus `2250_media_asset_canonical_model.sql:70-86` adding `captured_at`, `location_visibility`, `provenance`, `intelligence_eligibility`. **But it is not the canonical asset.** `lib/mediaAssets.ts:118` returns `null` before writing whenever `media_canonical_enabled` is off, and it is off; the two call sites are `routes/posts.ts:256` and `mediaAssets.ts:495`. Meanwhile `lib/media/mediaProjection.ts:130-173` reads `post_media` first and falls back to `posts.media_urls` — **it never reads `media_assets` at all.** Three stores, and the canonical one is on no read path. |
| MD37 | `sourceType` is the eight-value set camera/library/provider/official/community/generated/screenshot/derivative | **W** | `2250:98-108` adds the CHECK — as a **superset including the legacy `'user'`**, documented as such (*"legacy default (0191); kept, not rewritten"*). `0191:31` still defaults `source_type` to `'user'`, so every row written on the dark path lands outside the §6 vocabulary. |
| MD38 | `version` — the asset is a versioned aggregate | **W** | `0191:36` `version INTEGER NOT NULL DEFAULT 1` exists; no writer increments it and no reader compares it. A column, not a concurrency contract. |
| MD39 | `capturedAt` is distinct from `uploadedAt` | **C** | `lib/mediaAssets.ts:26-50` is an unusually candid header: the column, the type and every consumer existed but *"NO production caller ever supplied a non-null value"*. `capturedAtFromImageBytes` (`:69-84`) now reads EXIF from the raw buffer **before** `processImage` strips it, and rejects anything outside `[1990-01-01, now+24h]` — an implausible capture time stays `null` rather than becoming a lie. |
| MD40 | `MediaAttachment` contract (asset↔entity link) | **C** | `0191:46-58`, with `UNIQUE (media_asset_id, entity_type, entity_id)`. Read on a live path at `services/wall/WallCandidateLoaders.ts:212`. |
| MD41 | `entityType` covers post/postcard/memory/trip/place/event/hidden_gem/shared_moment/observation | **W** | `0191:49` is bare `TEXT` with **no CHECK** — nine required values, zero enforced. `2250:47-51` explicitly asserts only position/is_cover/visibility_override. Writers exist for `memory` (`PassportMemoryService.ts:133`) and `hidden_gem` (`HiddenGemService.ts:150`); `shared_moment` and `observation` have none. |
| MD42 | `position` / `isCover` ordering and cover selection | **C** | `0191:51-52` plus the partial cover index `:60-61`; read at `WallCandidateLoaders.ts:212-221`. |
| MD43 | `visibilityOverride` on the attachment | **W** | `0191:53` `visibility_override TEXT` exists and **nothing reads it**: no non-test reference outside `database.types.ts`. A stored override that no serving path consults is not an override. |
| MD44 | A single asset participates in multiple product objects without duplicating the underlying file | **W** | The *schema* makes it possible (`UNIQUE (media_asset_id, entity_type, entity_id)` allows fan-out from one asset). The *product* does the opposite: `.agents/memory/posts-media-urls-vs-post-media.md` records that `posts.media_urls` and `post_media` are *"separate stores that are not kept in sync"*, that `routes/posts.ts` creation *"writes `media_urls` and inserts no `post_media` row in the same handler"*, and that `lib/mediaAccess.ts` authorises by `.contains("media_urls",[publicUrl])` as a **distinct branch** from its `post_media` branch. The file's identity is duplicated across two stores that can disagree, and the canonical third is dark. |

### §7 Context Graph

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD45 | MediaAsset → Person | **C** | `lib/media/mediaProjection.ts:176` `projectContributor` (handle-first, presentation-name opt-in applied by the caller). |
| MD46 | → Place | **C** | `MediaActionResolver.ts:201` `refs.push({ kind:"place", … })`, through the location choke point. |
| MD47 | → Neighborhood | **C** | `mediaProjection.ts:89-91` carries `neighborhood`/`city`/`country` as coarse labels. |
| MD48 | → Event | **C** | `MediaExperienceResolver.ts:519` `kind: "event" \| "trip"`, gated by `checkEventEligibility` (`:1-14`). |
| MD49 | → Trip | **C** | `MediaActionResolver.ts:255` `kind:"trip"`, emitted only when the viewer may see the trip. |
| MD50 | → Hidden Gem | **C** | `MediaActionResolver.ts:222`, and only for a gem the viewer may be told about (`HiddenGemPrivacyGuard.mayDiscloseGemIdentity`, cited at `:31-33`). |
| MD51 | → Shared Moment | **N** | `MediaActionResolver.ts:53` — `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"`. No shared-moment edge anywhere in the context graph, though the product has shared moments. |
| MD52 | → Time | **C** | `mediaProjection.ts:84` `capturedAt`; the writer is `lib/mediaAssets.ts:69-84`. |
| MD53 | → Observation | **W** | The only media→observation path is `lib/media/mediaEvidenceLink.ts`, which is a *link* table behind `media_evidence_enabled` (`:130`), and no projection carries an observation ref. The edge is drawn in code and severed at runtime. |
| MD54 | Context resolution is server-side | **C** | `routes/mediaWorld.ts:18-33`; `resolveMediaEntities` runs in `services/media/`, and the client's `services/mediaProjection.ts` only fetches. |

### §8 Four-Layer Media Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD55 | Social layer (creator, caption, Stamp, comments, shares) owned by Media/Post systems | **C** | `routes/mediaFeed.ts:2099,2126,2251,2305` — like/react/share/comments all on the post spine. |
| MD56 | Context layer (place, area, Event, Trip, people, time) owned by canonical entity systems | **C** | `MediaActionResolver.ts:197-260` resolves refs into the canonical systems rather than storing a copy. |
| MD57 | Provenance layer (source, capture time, edits, location confidence, moderation, trust context) owned by Media + Trust | **W** | Every piece exists — `2250:79` `provenance JSONB`, `mediaEvidenceEligibility.initProvenance/appendEdit`, `MediaContributorReputationService.ts:1-12` for trust — but the provenance column is written only on the `media_canonical_enabled` path (`mediaAssets.ts:118-130`), so no served media object carries a provenance layer. |
| MD58 | Intelligence layer (evidence role, freshness, confidence, corroboration, observations, expiration) owned by Live Intelligence | **W** | Freshness and confidence are attached (`mediaFreshness.ts`, `mediaTimeBands` confidence bands). Evidence role is dark (MD53); corroboration, observation refs and expiration appear on **no** media projection — `MediaProjection` (`mediaProjection.ts:76-97`) has no such field. |

### §9 Media Intelligence Pipeline

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD59 | CAPTURE / UPLOAD | **C** | `lib/mediaPipeline.ts:1-40` — one policy for both upload transports (size caps, rate limits, magic-byte sniffing), written after the two drifted. |
| MD60 | PROVENANCE | **W** | Computed (`mediaEvidenceEligibility.initProvenance`, called at `mediaAssets.ts:126`) but only behind the dark flag; nothing stores or serves it today. |
| MD61 | CONTEXT RESOLUTION | **C** | `MediaActionResolver.resolveMediaEntities`; `MediaExperienceResolver.ts:1-14`. |
| MD62 | PRIVACY / ELIGIBILITY | **C** | `lib/mediaEligibility.filterEligibleMediaCandidates` + `lib/mediaLocationVisibility.ts:354`, both fail-closed. |
| MD63 | EVIDENCE EXTRACTION | **N** | Nothing extracts anything from the media itself. `mediaEvidenceEligibility` **classifies** an asset from its declared source and edit list; there is no pixel/frame/scene analysis anywhere. The stage does not exist. |
| MD64 | QUALIFICATION | **C** | `mediaEvidenceEligibility.isEvidenceEligible` — fail-closed on an unrecognised edit operation (`:14-19`), and the read path re-verifies so a later generative edit cannot leave a stale link. |
| MD65 | OBSERVATION | **W** | Media never becomes an observation. `mediaEvidenceLink` produces a *link* row; `:1-13` states it *"never writes `intel_observations`/`intel_claims`/`intel_state_snapshots`"*. The stage is deliberately not wired, which is right for safety and wrong against §9. |
| MD66 | CLAIM SYSTEM | **W** | The claim system exists (`lib/intelProjection`, `2130_intel_storage.sql`) and has no media input by construction (MD65). |
| MD67 | LIVE INTELLIGENCE | **C** | `lib/liveClaimRead.readLiveClaimEnvelopes`, consumed at `MediaProjectionService.ts:379`; fail-closed to `[]`. |
| MD68 | MEDIA / DISCOVERY / MAP / COMPASS outputs | **C** | `routes/mediaWorld.ts` (media), `MediaProjectionService.ts:916` map clusters, `compass/CompassMediaContext.ts:98` consumed at `routes/compass.ts:1484`. |

### §10 IntelligenceEligibility

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD69 | The `IntelligenceEligibility` contract | **C** | `lib/media/mediaEvidenceEligibility.ts:1-31`, computed by `computeIntelligenceEligibility`, stored in `2250:85` `intelligence_eligibility JSONB`. |
| MD70 | `reasons[]` — a refusal is explained, not silent | **C** | The classifier returns a reason list; `:14-19` documents the fail-closed `unknown` reason. |
| MD71 | `freshnessClass: live \| fresh \| recent \| historical` | **W** | Deliberate, documented divergence: `mediaEvidenceEligibility.ts:26-31` — *"§10's freshnessClass union includes 'live', but the media side caps at 'fresh'"*, and `mediaFreshness.ts:21` types out `live` entirely. I judge the deviation **safer than the spec** and still a deviation from it. |
| MD72 | `captureConfidence` | **C** | Derived from `capturedAt` presence/plausibility (`mediaAssets.ts:26-50` supplies the input; the classifier consumes it). |
| MD73 | `locationConfidence` | **W** | There is a *location tier* (`mediaLocationVisibility.ts:41-49`) and a boolean `hasLocation` input (`mediaAssets.ts:105`), but no confidence scalar: a GPS-verified capture and a hand-typed venue are indistinguishable to the classifier. |
| MD74 | `provenanceConfidence` | **C** | Source class drives it: `mediaEvidenceEligibility.ts:50-56` — only camera/library/community can back evidence; provider/official/generated/derivative/screenshot/legacy-`user` cannot. |
| MD75 | `expiresAt` — operational intelligence value expires | **N** | Explicitly declined: `mediaEvidenceEligibility.ts:29-31` — *"Nor does it stamp an operational `expiresAt`: intel expiry belongs to the observation/claim, not to the asset."* Defensible, but §10 asks for it and no asset carries one. |

### §11 Separate Social and Intelligence Lifetimes

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD76 | The `MediaTemporalState` contract | **N** | `grep -rn "MediaTemporalState" artifacts/api-server/src travel-buddy-standalone/src` → nothing. The type does not exist under this or any equivalent name. |
| MD77 | `socialExpiresAt` | **N** | No social-expiry column or field on `media_assets`, `posts` or `post_media`. |
| MD78 | `intelligenceExpiresAt` | **N** | See MD75 — declined by design. |
| MD79 | `locationDisclosureExpiresAt` | **W** | The *concept* ships as a state machine rather than a timestamp: `lib/delayedPostPublisher.ts:1-16` publishes on geofence exit or a fixed delay, and `posts.location_privacy_mode` (`mediaLocationVisibility.ts:380-412`) drives disclosure. But disclosure never expires — it only begins. There is no path from "shown" back to "hidden". |
| MD80 | A media item may remain social or memorial content after its operational intelligence value expires | **C** | `mediaEvidenceEligibility.ts:21-24` — *"this module NEVER touches social usability … a generative edit stays fully postable/servable social media; the only thing it loses is live-evidence eligibility."* The two lifetimes are genuinely independent in the one place where they meet. |

### §12 Perspectives · §13 Place Current View · §14 Media Viewer

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD81 | Perspective is a permitted visual contribution showing an aspect of a place or experience — not an analytics view | **C** | `services/media/MediaPerspectiveService.ts:1-15`. The primitive is a grouped set of already-eligible projections; the header states explicitly that it is not an analytics view. |
| MD82 | Nightclub perspective groups: Entrance · Queue · Street · Main Room · Stage · Bar · VIP · Outside | **N** | `MediaPerspectiveService.ts:8-12` declines the requirement in its own words: *"There is no perspective COLUMN in the schema today … It NEVER invents a specific physical vantage ('Rooftop', 'Entrance') that the data does not support."* Buckets derive from `category` (`:47-48`), never from a vantage. |
| MD83 | Festival groups: Main Gate · Stage A · Stage B · Food · Bathrooms · Meeting Area · Exit | **N** | As MD82. |
| MD84 | Beach groups: Water · Crowd · Weather · Beachfront · Food · Sunset · Access | **N** | As MD82. |
| MD85 | Restaurant groups: Exterior · Entrance · Seating · Food · View · Queue · Menu context | **N** | As MD82. |
| MD86 | Place Current View — trend, updated-at, current-picture strength, perspective/contributor counts, group chips, what's-changing, actions | **C** | `MediaProjectionService.ts:503` `buildPlaceProjection` returns `currentState` + `perspectives` + `freshness`; rendered by `screens/MediaPlacesScreen.tsx` with `components/CurrentPictureBadge.tsx` and `components/PerspectiveMosaic.tsx`. |
| MD87 | The viewer is contextual, not a TikTok-style vertical stranger-video feed | **W** | The contextual viewer exists (`screens/MediaPerspectiveViewerScreen.tsx`, entered via `MediaWorldShell.tsx:63-78` which stages the place's other perspectives). It is not the viewer a user reaches: `app/media-viewer/[id].tsx` is the shipped one and its §15 rail is gated at `:568` on the dark shell flag; opening from the Watch feed lands in the paging vertical player. |
| MD88 | Entry context **Place** → swipe collection is that Place's other perspectives | **C** | `MediaWorldShell.tsx:63-78` `openPlacePerspectiveViewer` sets `kind:'place'` with the place's groups and hero media, then routes to `/media-perspective/`. |
| MD89 | Entry context **Event** → other Event perspectives | **N** | `state/perspectiveViewerContext.ts` accepts an entry-context kind, and `setPerspectiveViewerContext` has exactly one caller (`MediaWorldShell.tsx:69`) passing exactly one kind. No event producer. |
| MD90 | Entry context **People** → that person / social context | **N** | As MD89. |
| MD91 | Entry context **Trip** → Trip media | **N** | As MD89. |
| MD92 | Entry context **Map** → current geographic cluster | **N** | As MD89, and there is no Media Map screen to enter from (MD25). |
| MD93 | Related-perspectives strip on the viewed item | **C** | `MediaPerspectiveService.ts` groups; `components/PerspectiveMosaic.tsx` renders; the collection is the staged entry context. |

### §15 Media Actions · §15.1 I Want This · §15.2 Do This Experience

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD94 | Go There / Show on Map / Directions | **C** | `services/media/MediaActionResolver.ts:1-33` — each action maps to an existing endpoint and is offered only when the viewer passes that endpoint's own gate; `open_map` is emitted only when the media resolves to a place. |
| MD95 | Ask Compass | **C** | `MediaActionResolver.ts:19-20` (Compass-gated) → `compass/CompassMediaContext.ts:98` `buildCompassMediaContext`, consumed at `routes/compass.ts:1484`. |
| MD96 | Save Place | **C** | Resolved to the existing saved-places endpoint and served at `routes/mediaActions.ts:43,82`. |
| MD97 | Add to Trip | **C** | `MediaActionResolver.ts:16-18` — offered only when `canEditPlan` passes, which is the exact gate the trip-plan-item endpoint enforces, so the rail can never grant access the endpoint would deny. |
| MD98 | Create Plan | **C** | Same resolver, Compass-gated (`:19-20`). |
| MD99 | Meet Here | **C** | `MediaActionResolver.ts:18-19` — respects the new-event kill switch. |
| MD100 | Invite People | **N** | No invite member in the resolver's action vocabulary; nothing in `routes/mediaActions.ts` emits one. |
| MD101 | Find Similar / Cheaper / Quieter / Busier | **W** | "Find somewhere like this" reaches Compass as a structured ask (`CompassMediaContext.ts:9-12`). There is no cheaper / quieter / busier comparator anywhere — no comparative modifier in the resolver, the Compass media context, or the projection. One of four. |
| MD102 | See Nearby | **N** | No nearby action. `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` (`2300:117-120`) gates a gems-feed *filter* that returns `feature_disabled`; it is not a media action. |
| MD103 | View Event / Passport | **W** | Event refs resolve (`MediaExperienceResolver.ts:519`). Passport does not: `MediaActionResolver.ts:53` `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"` has no passport member, and §29 keeps Passport on Postcards. Half built. |
| MD104 | Share through Telegraph | **N** | No telegraph target in the media rail; `src/services/shareActionRegistry.ts` is a separate, pre-existing surface and the rail does not reach it. |
| MD105 | Report / Not Relevant | **C** | `routes/mediaFeed.ts:1070` `POST /media/:id/report`; not-interested/hide are consumed as ranking penalties at `MediaFeedRankingService.ts:65-70`. |
| MD106 | §15.1 "I Want This" — an intent signal, explicitly not a Like | **C** | `2256_media_intent_signals.sql:1-21` gives it its own table and its own grant posture and states the rule — *"a want is never conflated with an engagement count"*; written only through the service-role endpoint at `routes/mediaActions.ts:161`, read at `MediaActionResolver.ts:612`. **Table absent from production** (§3). |
| MD107 | §15.2 "Do This Experience" — convert an eligible Trail / Trip recap / creator itinerary / experience collection into an executable Compass plan | **W** | `MediaActionResolver.ts:16-18` resolves *"Do This Experience"* to the **trip-plan-item** endpoint: it adds items to a trip. There is no compilation into a Compass plan, and no Trail, recap or itinerary source is read. The action exists and does a smaller, different thing. |

### §16 Hidden Gems

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD108 | `HiddenGemState` — the ten-value union | **C** | `lib/hiddenGemState.ts:37-50` is exactly the ten spec values, and `:13-18` makes the state **derived at read time, never stored** — *"It is NEVER a stored source of truth that can drift."* Client labels at `src/lib/gems/gemStateDisplay.ts`. |
| MD109 | §16.1 DISCOVERY | **C** | `services/hiddenGems/HiddenGemDiscoveryService.ts`. |
| MD110 | §16.1 SUBMISSION | **C** | `services/hiddenGems/HiddenGemService.ts:150`; `2057_hidden_gems_add_a_gem_cols.sql`; client `components/media/AddGemForm.tsx`. |
| MD111 | §16.1 ENTITY RESOLUTION | **C** | `2044_hidden_gems_canonical_place_id.sql` bridges a gem to a canonical place id; `HiddenGemDiscoveryService.ts:98` documents the column. |
| MD112 | §16.1 DUPLICATE CHECK | **N** | The only dedup in the tree is perceptual-hash **media** dedup (`lib/media/mediaDedupWorker.ts`, `pHashUtils.ts`, `media_dedup_groups`). No gem-level duplicate detection exists at submission or anywhere else. |
| MD113 | §16.1 SENSITIVE LOCATION CHECK | **C** | `services/hiddenGems/HiddenGemPrivacyGuard.ts`; `2251_hidden_gem_place_protection_index.sql`; `lib/protectedLocations.ts` as the last serialization gate. |
| MD114 | §16.1 MEDIA / PROVENANCE | **C** | `HiddenGemService.ts:150` records `media_assets` + `media_attachments(entityType='hidden_gem')`. |
| MD115 | §16.1 COMMUNITY CONFIRMATION | **C** | `services/hiddenGems/HiddenGemVerificationService.ts` over `hidden_gem_verifications` (in production). |
| MD116 | §16.1 GEM CONFIDENCE | **C** | `hiddenGemState.ts:20-27` `deriveGemConfidence`, reusing `lib/confidenceScore`. |
| MD117 | §16.1 CURRENT GEM STATE | **C** | `hiddenGemState.ts:13-18` `deriveHiddenGemState`. |
| MD118 | §16.1 fan-out to DISCOVERY / MAP / MEDIA / COMPASS | **C** | `routes/mediaFeed.ts:795` gems feed; `services/hiddenGems/CompassHiddenGemService.ts`; `MediaActionResolver.ts:222` gem refs. |
| MD119 | §16.1 VISIT | **C** | `hidden_gem_visits` (in production), write boundary at `2154_hidden_gem_visits_write_boundary.sql`. |
| MD120 | §16.1 OUTCOME | **N** | No gem outcome record. `compass_outcome_events` belongs to Compass and carries no gem-pipeline semantics; nothing closes the loop from a visit to an outcome for the gem. |
| MD121 | §16.1 MEMORY / PASSPORT | **C** | `services/media/MyWorldMemoryService.ts:438,584` derives gem memory and early-contributor rank on read. |
| MD122 | §16.2 Exact location may remain hidden until deliberate open | **C** | `lib/mediaLocationVisibility.ts:94-98` — `protected` / `reveal_after_save` / `reveal_after_acceptance` all map to `'city'`; the finer tier requires the deliberate act. |
| MD123 | §16.2 Approximate area only for sensitive/fragile locations | **C** | `mediaLocationVisibility.ts:98` `approximate → 'neighborhood'`; `:542` `gemCeilingForItem` matches by 300 m (exact) / 1500 m (approximate) proximity as well as canonical place. |
| MD124 | §16.2 Sensitive natural-site and protected-place rules | **C** | `lib/protectedLocations.ts` — server-side, last gate before serialization, fail-closed on unparseable geometry; `2251` indexes gem↔place protection. |
| MD125 | §16.2 Capacity and overcrowding awareness | **C** | `hiddenGemState.ts:37-50` carries `overcrowding_risk` as a first-class state. |
| MD126 | §16.2 No popularity-first ranking | **C** | `hiddenGemState.ts:28-31` — *"save_count and visit_count are not ranking inputs"* — and `:20-27` accepts `saveCount` into the signal set and **deliberately ignores it**, which is a stronger guarantee than not reading it. |
| MD127 | §16.2 Paid promotion never increases factual confidence | **C** | `hiddenGemState.ts:22-27` — *"a paid-promoted gem takes a commercial-risk PENALTY — promotion can only ever lower factual confidence, never lift it."* |
| MD128 | §16.2 Access restrictions and seasonality | **C** | `hiddenGemState.ts:37-50` carries `access_changed`, `seasonal`, `hard_to_find`, `temporarily_unavailable`. |
| MD129 | §16.2 Suppress aggressive recommendations if a small place is being overloaded | **C** | `hiddenGemState.ts:28-31` — an overcrowded / fragile gem is **demoted** in `scoreGemForRanking`. |
| MD130–MD138 | §16.3 the nine structured contributions: still here · still worth it · access changed · closed · too crowded · seasonal · harder to reach · better entrance · no longer hidden | **C** ×9 | `hiddenGemState.ts:53-59` `GEM_CONTRIBUTION_TYPES`, served through `routes/hiddenGems.ts:78` → `HiddenGemContributionService.ts:81,90,186`, stored by `2252_hidden_gem_contributions.sql`. **Deployment caveat: `hidden_gem_contributions` is absent from production** (`scripts/checkProductionDrift.ts:172`). Nine correct implementations against storage that is not there. |
| MD139 | §16.3 Each contribution is an observation, not an immediate canonical state change | **C** | `hiddenGemState.ts:14-18` — *"A single structured contribution is an OBSERVATION, not a canonical flip (§16.3): every contribution-driven state requires `CONTRIBUTION_FLIP_THRESHOLD` independent observations before it changes the state, so no one report can move the gem."* The single best-built requirement in this census. |

### §17 Time · §18 Visual Consensus · §19 Missions / Request a View · §20 Pulse · §21 Map · §22 Crowd Flow

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD140 | EARLIER band | **C** | `lib/media/mediaTimeBands.ts:451` `assembleTimeBands`, called at `MediaProjectionService.ts:878`; Earlier is the observed media record. |
| MD141 | NOW band | **C** | `MediaProjectionService.ts:874` reads `readCurrentState` (gated `liveClaimRead`); empty when live is off, so no fabricated now. |
| MD142 | TYPICAL band | **C** | `mediaTimeBands.ts:22-24` — Typical items are tagged `historical_pattern` and constructed `live:false`; sourced from `readIntelTimeSubstrate` off the live path. |
| MD143 | LIKELY NEXT band | **C** | `mediaTimeBands.ts:23-25` — tagged `portava_prediction`, `live:false`. |
| MD144 | Historical and forecast states must be visually distinct | **C** | `mediaTimeBands.ts:50-57` `TimeBandRenderClass = "observed" \| "typical" \| "predicted"` is emitted for the client to key distinct treatments; `components/MediaTimeRail.tsx` + `state/timeBands.ts` consume it. |
| MD145 | Forecasts carry confidence | **C** | `mediaTimeBands.ts:25-27` — *"a forecast (Likely-Next) MUST carry a confidence band; a predicted item with no derivable confidence is OMITTED, never surfaced bare"*, and `findNeverLiveViolations` drops violators fail-closed with `MediaProjectionService.ts:882-889` logging the removal. |
| MD146 | Media Perspective Resolver stage | **C** | `MediaPerspectiveService.ts:1-15`. |
| MD147 | Independent Sources stage | **W** | The *count* is displayed nowhere and computed nowhere in the media path: `MediaPerspectiveService` counts `contributorCount`, which is distinct contributors, not independent sources. The independence machinery exists (`lib/intelIndependence.ts` merges crews/shared-media/synchronised units) but nothing in Media calls it. |
| MD148 | Coverage Analysis stage | **C** | `routes/mediaViewRequest.ts:111` `GET /v1/media/places/:placeId/visual-coverage` over `lib/missionGeneration` / `intel_mission_candidates`. |
| MD149 | Corroboration stage | **W** | `MediaContributorReputationService.ts:1-12` reads `intel_state_snapshots` for *contributor* corroboration. Nothing corroborates one perspective against another; a place's mosaic carries no agreement measure. |
| MD150 | Contradiction stage | **N** | `lib/intelConflict.ts` exists for intel claims and is not reached from any media path; no media projection carries a contradiction signal. |
| MD151 | Visual Consensus Projection | **N** | No consensus object exists. `grep -rniE "consensus" artifacts/api-server/src/services/media artifacts/api-server/src/lib/media` → nothing. |
| MD152 | When reports disagree, surface uncertainty ("Mixed reports — conditions may be changing") | **N** | *Unguarded absence.* No mixed-reports copy, no uncertainty state on `PlaceProjection` or `WorldZone` (`MediaProjectionService.ts:405-423`). A disagreeing set of perspectives renders as an agreeing one. |
| MD153 | §19 "Last visual update Nm ago" / "Show what's happening?" mission prompt | **C** | `components/RequestAViewPrompt.tsx`; freshness copy from `state/freshness.ts`. |
| MD154 | §19 Request a View — a user requests a specific current perspective | **C** | `services/media/MediaViewRequestService.ts:1-27` + `routes/mediaViewRequest.ts:61`; it **consumes** the existing `intel_mission_candidates` machinery rather than forking a parallel mission system. |
| MD155 | §19 control: opt-in contributor eligibility | **C** | `MediaViewRequestService.ts:20-24` — *"only opted-in + eligible + un-blocked contributors are selected as recipients; block state that cannot be read ⇒ ask nobody"*; opt-in written at `routes/mediaViewRequest.ts:94`. |
| MD156 | §19 control: throttling | **C** | `MediaViewRequestService.ts:14-17` — per-viewer **and** per-place fixed windows via `lib/rateLimit`. |
| MD157 | §19 control: safety | **C** | `MediaViewRequestService.ts:17-20` — a place hosting a restrictive gem or protected location is refused, and an **undetermined** gem lookup is refused rather than guessed. |
| MD158 | §19 control: anti-spam | **C** | `MediaViewRequestService.ts:16` — a near-duplicate OPEN request for the same (place, family) is refused. |
| MD159 | §20 World / City Visual Pulse | **C** | `MediaProjectionService.ts:439-487` — zones with `perspectiveCount`, `freshness`, and a state label **only** from a gated live claim (`:463-476`), with `changingNow` filtered to zones that actually have one (`:479`). Client `components/CityVisualPulse.tsx` + `ChangingNowCard.tsx`. Caveat: with the intel spine holding zero rows in production (`docs/architecture/intel-spine-liveness.md`), the state labels the §20 mockup shows ("Building ↑", "Peak ●") can never appear. |
| MD160 | §21 Media Map consumes the canonical Map projection; it does not own a second location engine | **C** | `MediaProjectionService.ts:906-914` — *"This projection deliberately carries NO geometry: geographic placement is delegated to the canonical Map projection (spec §21)"*, and `:934-937` **omits** any cluster without a canonical place id rather than inventing a position. |
| MD161 | §21 Perspective counts per canonical place | **C** | `MediaProjectionService.ts:916` `buildMediaMapProjection`; served at `routes/mediaWorld.ts:271`. |
| MD162 | §22 Crowd-flow integration — "where the night is moving" from recent perspectives | **N** | Nothing in `services/media/` or `lib/media/` references `crowdFlow` / `crowd_flow`. The producer exists (`lib/mapProducers/crowdFlowProducer.ts`) and Media does not consume it. |
| MD163 | §22 Never expose individual routes | **C** | Satisfied structurally by the producer Media would consume: `lib/mapProducers/crowdFlowProducer.ts:14-30` — *"There is no per-actor path type, anywhere. The input unit is ONE HOP … so a path cannot be assembled even internally."* Vacuous on the Media side (MD162), but the guarantee is real and would hold if Media were wired in. |

### §23 Experience Projections · §23.1 Experience Chains

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD164 | `MediaExperienceProjection` contract | **C** | `services/media/MediaExperienceResolver.ts:31` onward; served at `routes/mediaWorld.ts:149`. |
| MD165 | An experience resolves from a canonical Event **or** a Trip (`placeIds`, `eventId`, `tripId`) | **C** | `MediaExperienceResolver.ts:519` `kind: "event" \| "trip"`, with event eligibility reusing `routes/events.checkEventEligibility` (`:1-14`) rather than re-implementing it. |
| MD166 | `currentState` on an experience | **C** | `MediaExperienceResolver.ts:24-27` reads current state only through the gated live-claim read. |
| MD167 | `perspectiveCount` + `contributorCount` | **C** | Assembled from `MediaPerspectiveService` group counts. |
| MD168 | `freshness` | **C** | `lib/media/mediaFreshness.aggregateFreshness`, imported at `MediaExperienceResolver.ts:29`. |
| MD169 | `confidence` | **W** | The field exists on the shape but no experience-level confidence is computed — the only confidence in the media path is the per-forecast band in `mediaTimeBands`. A declared-but-unfilled field. |
| MD170 | `heroMedia` drawn through the eligibility gate and coarse projector | **C** | `MediaExperienceResolver.ts:10-13` + `projectCandidatesProtected`. |
| MD171 | §23.1 Experience chains (Dinner → Rooftop → Nightclub) | **N** | No chain type, no ordered multi-place experience anywhere in `services/media/`. `MediaExperienceProjection` carries `placeIds: string[]` with no ordering semantics and no traversal. |
| MD172 | §23.1 action: Follow This Night | **N** | No such action in `MediaActionResolver`. |
| MD173 | §23.1 action: Save Route | **N** | Route plans exist (`route_plans`, `routes/routePlan.ts`) and no media action reaches them. |
| MD174 | §23.1 action: Add to Trip (on an experience) | **C** | `MediaActionResolver.ts:16-18` — the same `canEditPlan`-gated trip-plan-item action, offered on experience-bound media. |
| MD175 | §23.1 action: Remix | **N** | No remix concept anywhere in the tree. |
| MD176 | §23.1 action: Ask Compass (on an experience) | **C** | `CompassMediaContext.ts:98` carries the experience's entity refs into the Compass ask. |

### §24 Ranking

Two blocks: sixteen named input signals and eight objective terms. The ranker that serves
the surface a user reaches is `services/ranking/MediaFeedRankingService.ts` over
`lib/portavaRank.ts` (`DEFAULT_WEIGHTS` at `:182-201`); the World shell does not rank at
all — `MediaProjectionService.ts:846-848` sorts by `capturedAt` and `:456-459` by zone size.

| id | Requirement (input signal) | V | Evidence |
| --- | --- | --- | --- |
| MD177 | Viewer intent | **N** | No intent input in `portavaRank.RankCandidate`/`ViewerContext` or in `MediaFeedRankingService`; §15.1's want-signal store is not a ranking input (`media_intent_signals` is read only by `MediaActionResolver.ts:612` for the button's own state). |
| MD178 | Current location | **C** | `portavaRank.ts:189-191` `cityMatch 0.45`, `neighborhoodMatch 0.2`, `distance 0.35`. |
| MD179 | Trip context | **N** | No trip term in `DEFAULT_WEIGHTS`; `kindPrior` has a `trip` candidate kind but no viewer-trip affinity. |
| MD180 | Availability | **C** | `portavaRank.ts:193` `availabilityFit 0.5`. |
| MD181 | Travel preferences | **C** | `portavaRank.ts:187-188` `interestTag 0.3`, `categoryAffinity 0.4`. |
| MD182 | Follow graph | **C** | `portavaRank.ts:184-186` `followedAuthor 0.5`, `mutualAuthor 0.35`, `engagedAuthor 0.3`. |
| MD183 | Discovery behaviour | **C** | `portavaRank.ts:198` `seenPenalty -0.6`; `MediaFeedRankingService.ts:65-70` hide/not-interested rates. |
| MD184 | Live state | **N** | No live-claim term reaches either ranker; `readCurrentState` is a projection input, never a score input. |
| MD185 | Freshness | **C** | `portavaRank.ts:183` `recency 1.0` — the largest single weight. |
| MD186 | Place relevance | **C** | `cityMatch`/`neighborhoodMatch`/`distance` as MD178, plus `bucketClassifier` place buckets (`MediaFeedRankingService.ts:47`). |
| MD187 | Media quality | **W** | Only as *engagement* proxies — `watchCompletionRate`, `qualifiedViewCount`, `rewatchRate` (`MediaFeedRankingService.ts:60-70`). No resolution, sharpness, duration-fit or composition term. Quality is measured by how long people watched, which is the thing §45 forbids optimising for. |
| MD188 | Trust / provenance | **W** | `portavaRank.ts:195-196` `trust 0.3`, `verifiedBonus 0.15` — **author** trust. No `source_type`/provenance term (see MD8), so an `official` or `generated` asset scores identically to a `camera` one. |
| MD189 | Social relevance | **C** | `portavaRank.ts:194` `socialProof 0.25` plus the follow-graph terms. |
| MD190 | Novelty | **C** | `portavaRank.ts:198` `seenPenalty`; `MediaFeedRankingService.ts:16` per-viewer per-session fatigue. |
| MD191 | Privacy | **C** | Not a score term by design — privacy resolves as a **gate** before ranking (`lib/mediaEligibility.filterEligibleMediaCandidates`, `services/ranking/EligibilityChecker.ts`), which is the correct construction of the requirement. |
| MD192 | Safety | **C** | Same gate: moderation states that must never reach a social surface are refused upstream (`WallCandidateLoaders.ts:1119`; `lib/mediaEligibility`). |
| MD193 | Diversity | **C** | `MediaFeedRankingService.ts:17` — a diversity re-ranking pass over city, category and creator; `portavaRank.diversify`. |
| MD194 | Objective: Expected Real-World Utility | **W** | `portavaRank.ts:192` `actionability 0.9`, commented *"the Portava edge: things you can DO"*, is a genuine partial. It is a property of the *candidate kind*, not a prediction of the viewer's real-world action, and it is outweighed in the media path by the engagement multipliers stacked on top of it. |
| MD195 | Objective: Experience Fit | **N** | No experience-fit term in either ranker. |
| MD196 | Objective: Useful Social Connection | **N** | Follow-graph proximity is an input (MD182); nothing scores the *usefulness* of a connection. |
| MD197 | Objective: Contribution Value | **N** | `MediaContributorReputationService` scores a contributor and is not a ranking input — no call site in `services/ranking/`. |
| MD198 | Objective: Narrative Value | **N** | Absent. |
| MD199 | Objective: − Repetition | **C** | `seenPenalty -0.6` + `MEDIA_CREATOR_FATIGUE_ENABLED` fatigue layer + the creator frequency cap (`services/ranking/CreatorCapEnforcer.ts`). |
| MD200 | Objective: − Staleness | **C** | `recency 1.0` decay kernel (`portavaRank.ts:205-206` HOUR/DAY constants). |
| MD201 | Objective: − Low-confidence Live Claims | **N** | *Unguarded absence.* Live claims are not ranking inputs at all (MD184), so there is nothing to penalise and no guard against adding them unpenalised. |

### §25 Creator Popularity vs Intelligence Trust

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD202 | Creator Popularity — audience reach / social popularity | **C** | `services/ranking/CreatorActivityScoreService.ts`; `portavaRank.ts:194` `socialProof`. |
| MD203 | Creator Engagement — stamps, comments, shares, saves | **C** | `routes/mediaFeed.ts:2099-2305`; `media_events` event vocabulary (`2039_media_events.sql:10`). |
| MD204 | Contributor Reliability — usefulness and historical acceptance of structured observations | **C** | `services/media/MediaContributorReputationService.ts:20` `ACCEPTED_STATES`, reading `intel_observations` acceptance. |
| MD205 | Place Expertise — evidence-backed experience in a place/category | **C** | `MediaContributorReputationService.ts:24-27` `ReputationScope.subjectId` — *"Optional place/subject for the Place-Expertise dimension."* |
| MD206 | Live Accuracy — how often current observations are corroborated | **C** | `MediaContributorReputationService.ts:1-12` reads `intel_state_snapshots` for independent corroboration. |
| MD207 | Trip Expertise — relevant journey history | **N** | Not a dimension: `lib/mediaContributorReputation.computeContributorReputation` computes **three** dimensions and nothing reads trip history. |
| MD208 | Buddy Reputation — separate service-context reputation | **C** | Genuinely separate: `services/rentBuddy/` + `rent_buddy_*` tables; no path joins it to media trust. The separation is the requirement and it holds. |

**The load-bearing half of §25 is built and I want it on the record:**
`MediaContributorReputationService.ts:1-12` — *"DELIBERATELY reads NO social table
(passport_stamps, follows, likes). Popularity has no path into this number."* Every read
is `Promise.allSettled` fail-open **to zero**, so a partial DB failure lowers a reputation
and can never inflate one.

### §26 Outcome-Oriented Impact Metrics

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD209 | People saved this place | **C** | `media_events` `save` + `place_open`; `routes/mediaAnalyticsBatch.ts:38-44` allow-list. |
| MD210 | Added to Trips | **C** | `add_to_trip` in the same allow-list; north-star `media_trip_add`. |
| MD211 | Asked Compass | **C** | north-star `media_compass` (`mediaTelemetry.ts:71-78`). |
| MD212 | Created plans | **C** | north-star `media_plan`. |
| MD213 | Started directions | **W** | `directions_tap` is in the batch allow-list (`mediaAnalyticsBatch.ts:41`) but the §45 `media_route` transition is declared *"reserved: no rail trigger yet"* (`mediaTelemetry.ts:69-71`) — the outcome name exists with no emitter. |
| MD214 | Arrived / completed experience where safely measurable | **N** | `media_arrival` is likewise reserved with no emitter, and there is no arrival detector on any media path. |
| MD215 | Views, Stamps, comments and shares remain social analytics but do not dominate the hierarchy | **W** | They dominate both places it matters: the ranker multiplies by `watchCompletionRate`/`qualifiedViewCount`/`rewatchRate` (`MediaFeedRankingService.ts:60-70`), and the shipped viewer's primary rail is Stamp/comment/save with compact counts (`WatchItemOverlay.tsx:403-437`, `:134` `formatCompactCount`). |

### §27 People Lens · §28 Object Semantics · §29 Passport Boundary · §30 My World

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD216 | The People lens prioritises followed users, Trip Crew, Shared Moment participants and relevant creators | **W** | `MediaProjectionService.ts:587` `buildPeopleProjection` is the only builder requesting `needFollows: true` (`routes/mediaWorld.ts:214`) — followed users and creators are handled. Trip Crew and Shared Moment participants are not: no `trip_members` or shared-moment read in the builder. Two of four. |
| MD217 | Uploading media does not imply precise live location | **C** | `lib/mediaProcessing.ts:1-22` strips **all** EXIF including GPS on re-encode, and `lib/videoMetadata.ts` strips the MP4/MOV capture-location atoms; `mediaProjection.ts:76-97` has no coordinate field to carry one even if it survived. |
| MD218 | MediaAsset = photo or video file | **C** | `0191_media_assets.sql:18` `media_type IN ('image','video')`. |
| MD219 | Post = social publication | **C** | `posts` spine; `routes/posts.ts`. |
| MD220 | Postcard = curated travel narrative, Passport-facing media expression | **C** | `passport_postcards`, `routes/postcards.ts`; counted as its own My-World bucket at `MediaProjectionService.ts:743`. |
| MD221 | Memory = preserved meaningful experience | **C** | `memories` table; `services/passport/PassportMemoryService.ts:133`; `MyWorldMemoryService.ts:1-33` consumes rather than forking it. |
| MD222 | Shared Moment = permitted shared real-world experience | **W** | The object exists (`routes/sharedMoments.ts`, shared-moment Wall renderer) but it is **outside the media context graph** (MD51) and outside the People lens (MD216); §28 requires it as a media object semantic and Media cannot address one. |
| MD223 | Perspective = visual contribution to world context | **C** | `MediaPerspectiveService.ts:1-15`. |
| MD224 | Observation = structured intelligence input | **C** | `intel_observations` + `lib/intelContracts.ts`; distinct from every media object, which is the requirement. |
| MD225 | Passport continues to use Postcards as its primary media expression | **C** | `services/passport/` reads `passport_postcards`; no media-world projection is mounted inside Passport. |
| MD226 | Do not duplicate the full Media product inside Passport | **C** | `MyWorldMemoryService.ts:1-33` — the My-World memory reader *consumes* the §12 derived-memory core and reuses `PassportRemembersService`'s suppression filter rather than forking it; `:14-23` is explicit that the allow/deny boundary is shared, not copied. |
| MD227 | My World filters: All · Posts · Postcards · Memories · Trips · Tagged · Hidden Gems | **C** | `MyWorldMediaScreen.tsx:5-7`; server counts at `MediaProjectionService.ts:742-746`. |
| MD228 | Search my world | **N** | No search input on `MyWorldMediaScreen.tsx`, no `q`/`query` parameter on `GET /media/me` (`routes/mediaWorld.ts:221-243`), no media search service (MD27). |
| MD229 | Owner-only buckets: Drafts · Archived · Uploads · Processing | **C** | `MediaProjectionService.ts:681-712` builds `drafts`/`archived`/`processing` from the owner's own rows and `:742` counts uploads; the route resolves identity from the session only (`routes/mediaWorld.ts:225-231`). |

