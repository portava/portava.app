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
| **Denominator (testable requirements)** | **450** |
| BUILT-AND-CORRECT | **291** |
| BUILT-BUT-WRONG | **69** |
| NOT-BUILT | **88** |
| CANNOT-VERIFY | **2** |
| **CONSTRUCTED%** = (C+W)/450 | **360 / 450 = 80.0 %** |
| **CORRECT%** (raw) = C/450 | **291 / 450 = 64.7 %** |
| **CORRECT% (spec-attributable)** | **216 / 450 = 48.0 %** |
| CANNOT-VERIFY share | **2 / 450 = 0.4 %** |

Three things a reader should take before the table.

**1. This is the first spec I have censused whose attribution is not zero.**
Two completed sibling censuses returned 0.0 % spec-attributable, and the brief said to test
that rather than assume it. I did. Media is different: 62 non-test files in the tree carry the literal string
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

## 1. Denominator: how 450 was counted

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
§23.1 6 · §24 25 · §25 7 · §26 7 · §27 2 · §28 7 · §29 2 · §30 3 · §31 7 · §31.1 5 ·
§32 13 · §33 4 · §34 5 · §35 2 · §36 9 · §37 12 · §38 8 · §39 8 · §40 35 · §41 15 ·
§42 4 · §43 17 · §44 20 · §45 9 · §46 11 · §46.1 5 · §46.2 9 · §47 1 · §48 12 · §49 10 ·
§50 0` = **450**.

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

| | count | share of 450 |
| --- | --- | --- |
| BUILT-AND-CORRECT, spec-attributable | **291A** | **291AP** |
| BUILT-AND-CORRECT, pre-existing | 291P | 291PP |

**So: CORRECT% (spec-attributable) = 216 / 450 = 48.0 %.** The programme is real; the
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

**Where I agree — six of eight, and they hold up under a 450-cell mesh.**

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
absent from production". At 450 cells Media is **291ORR correct**. I would not
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
| MD94 | Go There / Show on Map / Directions | **W** | `MediaActionResolver.ts:378-384` emits `show_on_map`, targeting `/api/media/places/:placeId` — a projection, deliberately coordinate-free. There is **no directions action**: no `directions` id in the resolver's thirteen (`:332,340,348,358,378,385,396,413,421,436,458,479,495`), and `directions_tap` exists only as a telemetry name (`routes/mediaAnalyticsBatch.ts:41`) with no emitter. "Go There" and "Directions" are unbuilt; "Show on Map" is built and correct. |
| MD95 | Ask Compass | **C** | `MediaActionResolver.ts:19-20` (Compass-gated) → `compass/CompassMediaContext.ts:98` `buildCompassMediaContext`, consumed at `routes/compass.ts:1484`. |
| MD96 | Save Place | **C** | Resolved to the existing saved-places endpoint and served at `routes/mediaActions.ts:43,82`. |
| MD97 | Add to Trip | **C** | `MediaActionResolver.ts:16-18` — offered only when `canEditPlan` passes, which is the exact gate the trip-plan-item endpoint enforces, so the rail can never grant access the endpoint would deny. |
| MD98 | Create Plan | **C** | Same resolver, Compass-gated (`:19-20`). |
| MD99 | Meet Here | **C** | `MediaActionResolver.ts:18-19` — respects the new-event kill switch. |
| MD100 | Invite People | **N** | No invite member in the resolver's action vocabulary; nothing in `routes/mediaActions.ts` emits one. |
| MD101 | Find Similar / Cheaper / Quieter / Busier | **W** | "Find somewhere like this" reaches Compass as a structured ask (`CompassMediaContext.ts:9-12`). There is no cheaper / quieter / busier comparator anywhere — no comparative modifier in the resolver, the Compass media context, or the projection. One of four. |
| MD102 | See Nearby | **C** | `MediaActionResolver.ts:385-392` — emitted only when a place resolves, targeting `GET /api/media/map` scoped to the media's coarse city. No coordinate leaves the server; the client positions the clusters through the Map gateway it already holds. |
| MD103 | View Event / Passport | **W** | Event refs resolve (`MediaExperienceResolver.ts:519`). Passport does not: `MediaActionResolver.ts:53` `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"` has no passport member, and §29 keeps Passport on Postcards. Half built. |
| MD104 | Share through Telegraph | **W** | The action is emitted (`MediaActionResolver.ts:340-344`) and the endpoint accepts the target (`routes/mediaFeed.ts:2281` `z.enum(["native","copy_link","telegraph"])`) — but the handler **ignores it**: `:2297-2299` records a share event and returns a `shareUrl`, and no Telegraph thread, message or intent is created on any branch. The action resolves to a URL, not to Telegraph. |
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
| MD228 | Search my world | **N** | No search input on `MyWorldMediaScreen.tsx`, no `q`/`query` parameter on `GET /media/me` (`routes/mediaWorld.ts:221-243`), and no media search service at all (MD324). |
| MD229 | Owner-only buckets: Drafts · Archived · Uploads · Processing | **C** | `MediaProjectionService.ts:681-712` builds `drafts`/`archived`/`processing` from the owner's own rows and `:742` counts uploads; the route resolves identity from the session only (`routes/mediaWorld.ts:225-231`). |

### §31 Memory Integration · §31.1 Hidden Gem Memory

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD230 | Visited Hidden Gem | **C** | `services/media/MyWorldMemoryService.ts:47` `visited_hidden_gem`, derived on read from `hidden_gem_visits`. |
| MD231 | Discovered Hidden Gem | **C** | `MyWorldMemoryService.ts:48`. |
| MD232 | Returned to Place | **C** | `MyWorldMemoryService.ts:49`, derived from the §12 episodic core at `:196-202`. |
| MD233 | Night out with Trip Crew | **C** | `MyWorldMemoryService.ts:50`, from `posts.trip_id` + `trip_members`. |
| MD234 | Favorite atmosphere | **C** | `MyWorldMemoryService.ts:51`. |
| MD235 | Saved visual inspiration | **C** | `MyWorldMemoryService.ts:52`, from `post_saves`. |
| MD236 | Experience matched expectation | **C** | `MyWorldMemoryService.ts:53`, from `compass_outcome_events`. |
| MD237 | "You discovered this Gem." | **C** | `MyWorldMemoryService.ts:115-128` `HiddenGemMemoryLineKind` — all five §31.1 lines, verbatim, as a closed union. |
| MD238 | "You were an early contributor." | **C** | `MyWorldMemoryService.ts:117`, rank computed by `distinctUserRank(sc,"hidden_gem_contributions",…)` at `:584`. |
| MD239 | "You brought your Trip Crew here." | **C** | `MyWorldMemoryService.ts:118`. |
| MD240 | "You confirmed it twice." | **C** | `MyWorldMemoryService.ts:119`. |
| MD241 | "You visited before it became popular." | **C** | `MyWorldMemoryService.ts:120`. |

§31 and §31.1 are the only two sections in this spec built **exactly** — seven of seven
and five of five, in spec order, with the labels as written. And the whole surface is
owner-only and re-uses the §12 forget/suppress boundary rather than forking it
(`MyWorldMemoryService.ts:14-30`), so a memory the owner has forgotten cannot resurface
here. (MD238's rank reads `hidden_gem_contributions`, absent from production — §3.)

### §32 Compass Integration

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD242 | The `CompassMediaContext` contract | **C** | `compass/CompassMediaContext.ts:98` `buildCompassMediaContext`, wired into the real ask path at `routes/compass.ts:1484`. |
| MD243 | `entityRefs` — coarse, opaque, viewer-permitted | **C** | `CompassMediaContext.ts:26-33` — refs come from `resolveMediaEntities`, which runs the location/gem choke point, so a hidden venue, a gem-ceilinged place, and a protected gem's **name** are all withheld before anything is rendered into the prompt. |
| MD244 | `viewerContext` | **C** | `CompassMediaContext.ts:49-54` — `viewerCountry` and `subjectCity` only, *"never a coordinate"*. |
| MD245 | `permittedIntelligenceRefs` | **C** | `CompassMediaContext.ts:19-25` — filtered **twice**: the intel comes only from the gated fail-closed live-claim read, then is filtered to refs whose place the viewer is eligible to see. |
| MD246 | Question: "Is this worth going to now?" | **C** | `CompassMediaContext.ts:9-12` names it as the driving case; the context lines are appended to the ask at `routes/compass.ts:1484`. |
| MD247 | Question: "Find somewhere like this." | **C** | Same; `find_similar` action at `MediaActionResolver.ts:396`. |
| MD248 | Question: "Is this still busy?" | **C** | Answerable from `permittedIntelligenceRefs` (gated live claims); returns nothing rather than guessing when live is off. |
| MD249 | Question: "Where is this?" | **C** | `entityRefs` carry the coarse place label subject to the owner's tier and any gem ceiling. |
| MD250 | Question: "Build a plan around this." | **C** | `create_plan` action (`MediaActionResolver.ts:421`), Compass-gated. |
| MD251 | Question: "What's nearby?" | **C** | `see_nearby` (`MediaActionResolver.ts:385`) + the map projection. |
| MD252 | Question: "Where should we go after this?" | **N** | No sequencing concept in the media→Compass context: no next-stop, no chain (MD171), no time-of-evening term. |
| MD253 | Question: "Find a quieter or cheaper version." | **N** | See MD101 — no comparative modifier exists anywhere in the media path. |
| MD254 | Question: "Add this to my Trip." | **C** | `add_to_trip` (`MediaActionResolver.ts:458`), gated by `canEditPlan`. |

### §33 Privacy Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD255 | `MediaVisibility = public \| followers \| following \| trip_crew \| shared_moment \| private` | **W** | The real enum is three values: `0103_post_media.sql:72` states it outright — *"post_visibility enum only has public, trip_only, private — no followers branch"* — and `lib/mediaEligibility.ts:291-315` branches on exactly `public`/`private`/`trip_only`. `media_assets.visibility` (`0191:35`) is bare `TEXT DEFAULT 'inherit'` with **no CHECK at all**. Three of the six named audiences cannot be expressed. |
| MD256 | `LocationVisibility = hidden \| country \| city \| neighborhood \| place \| precise_private` | **C** | `lib/mediaLocationVisibility.ts:41-49` is exactly the six values in exactly that order, with `TIER_RANK` at `:52-60` and `2250:76-78` mirroring it as a DB CHECK defaulted to the **most private** value. |
| MD257 | Media visibility and location visibility are independent axes | **C** | They are computed by different modules from different columns and composed by `stricterTier` (`mediaLocationVisibility.ts:72`): audience is decided by `mediaEligibility`, disclosure by `resolveMediaLocationWithGemProtection` (`:354`). Neither reads the other's column. |
| MD258 | Exact GPS is not normal public media metadata | **C** | Three independent defences: EXIF/atom stripping at upload (`lib/mediaProcessing.ts:1-22`, `lib/videoMetadata.ts`), a projection type with no coordinate field (`mediaProjection.ts:76-97`), and the boundary scrub on all seven World routes (`routes/mediaWorld.ts:84-92`, proven non-vacuous by `src/test/mediaWorldBoundaryScrub.test.ts`). |

### §34 Delayed Publishing

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD259 | Publish now | **C** | Default path, `routes/posts.ts`. |
| MD260 | Publish after I leave | **C** | `lib/delayedPostPublisher.ts:5-8` — `pending_location_exit`, with `publish_eligible_at` set by `POST /api/location/exit-geofence`. |
| MD261 | Hide exact place | **C** | `posts.location_privacy_mode` → `mediaLocationVisibility.ts:412` `locationPrivacyModeToCeiling`, fail-closed to `'city'` on an unrecognised mode (`:410`). |
| MD262 | Show neighborhood only | **C** | `mediaLocationVisibility.ts:98` `approximate → 'neighborhood'`. |
| MD263 | Show city only | **C** | `mediaLocationVisibility.ts:94-96`. |

§34 is entirely **pre-existing** work — `delayedPostPublisher` and `location_privacy_mode`
predate Media v2 and the spec inherited them.

### §35 Evidence-Safe Editing

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD264 | Original → crop / brightness → still evidence-eligible | **C** | `lib/media/mediaEvidenceEligibility.ts:7-11` classifies crop/rotate/straighten/brightness/contrast/colour-temp as non-semantic and eligibility-preserving. |
| MD265 | Original → major generative alteration → still valid social media, not eligible as live evidence | **C** | `mediaEvidenceEligibility.ts:9-24` — generative fill/expand, object add/remove, heavy compositing and `source_type='generated'` all lose evidence eligibility and lose **nothing else**; `:14-19` is fail-closed on an unrecognised operation, and the read path re-verifies so a later generative edit cannot leave a stale link inflating a claim. |

### §36 Moderation

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD266 | Upload | **C** | `lib/mediaPipeline.ts:1-40` — one policy for both transports. |
| MD267 | File validation | **C** | `lib/mediaProcessing.ts:34-60` `sniffMedia` — magic bytes decide, the client's Content-Type is untrusted. |
| MD268 | Processing | **C** | `mediaProcessing.processImage` (re-encode, auto-orient, cap longest edge, strip all EXIF) + `makeThumbnail`. |
| MD269 | Safety moderation | **C** | `media_assets.moderation_status` (`0191:32-34`), `routes/adminMedia.ts`, `post_media_moderation_ledger` (in production), `lib/moderationAudit.ts`. |
| MD270 | Privacy validation | **C** | `lib/mediaLocationVisibility` choke point + `lib/protectedLocations` + the boundary scrub. |
| MD271 | Context qualification | **C** | `resolveMediaEntities` + `lib/mediaEligibility.filterEligibleMediaCandidates`. |
| MD272 | Intelligence eligibility | **C** | `mediaEvidenceEligibility.computeIntelligenceEligibility`, called at `lib/mediaAssets.ts:129`. |
| MD273 | Distribution | **C** | `lib/mediaEligibility.filterEligibleMediaCandidates` is the fail-closed distribution gate; `WallCandidateLoaders.ts:1119` names the moderation states that must never reach a social surface. |
| MD274 | `MediaModerationStatus = processing \| active \| limited \| rejected \| removed \| owner_deleted` | **W** | `2250:26-46` adds the §36 vocabulary as a **superset** alongside the legacy `pending \| approved \| flagged \| rejected`, documents the mapping, and deliberately **updates no row** and leaves the DEFAULT as the legacy `'pending'`. So the canonical vocabulary is admissible and unused: every row in existence carries a legacy value. Conservative and correct as a migration; not §36 as a live state machine. |

### §37 Video Requirements

The certification lists §37 as "runtime QA required — device QA, not a unit-test target".
Six of the eleven are answerable by reading the tree, and the answer is *absent*. Searches
run: `grep -rniE "m3u8|hls|dash|adaptive|textTrack|caption|resumable|transcod|backgroundUpload"`
over `travel-buddy-standalone/src`, `travel-buddy-standalone/app` and
`artifacts/api-server/src`.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD275 | Thumbnail generation | **W** | Server-side thumbnails exist for **images only**: `lib/mediaProcessing.ts:15-16,18-22` — *"Dimensions, thumbnails and pHash remain image-only."* `media_assets.thumbnail_path` exists for video and no writer fills it; `WatchVideoCell.tsx:166` shows a poster *"while buffering"* from a client-supplied URL. |
| MD276 | Duration metadata | **W** | `0191:23` `duration_ms` exists and is client-declared — the server never probes a video (no ffmpeg, `mediaProcessing.ts:18-19`), so duration is whatever the uploader said. `2089_media_assets_ready_requires_dimensions.sql` constrains dimensions, not duration. |
| MD277 | Adaptive playback | **N** | No HLS/DASH anywhere. `WatchVideoCell.tsx:158` plays a single progressive `videoUrl` through `expo-av`. |
| MD278 | Mute state | **C** | `WatchFeedList.tsx:464` holds `isMuted` (defaulting muted), passed to `WatchVideoCell.tsx:160`; `SharedVideoPlayer.tsx:110-113` `setStatusAsync({ isMuted })` with an accessible label at `:178`. |
| MD279 | Seek | **C** | `WatchFeedList.tsx:10` progress bar with pan-to-seek; `:297` throttles seeks to ≈12 fps and `:309` issues a final exact seek. |
| MD280 | Captions | **N** | No caption/subtitle/`textTrack` anywhere in the client. |
| MD281 | Upload resume / retry | **N** | `src/services/media.ts:153` `uploadMedia` is a single `fetch` POST to `/api/media/upload` (`:197`) with no chunking, no range, no resume token and no retry loop. The postcard transport (`lib/mediaPipeline.ts:12-17`) gives progress and cancellation, not resume. |
| MD282 | Compression / transcoding | **N** | `lib/mediaProcessing.ts:18-19` — *"Videos are NOT transcoded here (no ffmpeg in this tier) — they are sniffed and size-capped only; that limitation is documented, not hidden."* Images are re-encoded and capped; video is not. |
| MD283 | Moderation | **C** | `media_assets.moderation_status`, `post_media_moderation_ledger`, `routes/adminMedia.ts` — the same pipeline for video as for images. |
| MD284 | Background upload | **N** | No background task, no `expo-task-manager` upload registration, no queue. `uploadMedia` runs in the foreground and dies with the screen. |
| MD285 | Playback recovery | **C** | `WatchVideoCell.tsx:92-102` reacts to activity changes and holds a `hasHardFailed` latch so a permanently broken source stops retrying; `:179` distinguishes buffering from failure. |
| MD286 | Do not make endless vertical autoplay the primary Media IA | **W** | It is the primary Media IA. `src/stores/mediaStore.ts:104,145` `defaultMode='watch'`; `2037_media_tab_flags.sql:17-20` seeds `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED = true`; `WatchFeedList.tsx:526` drives autoplay from viewability. The compliant alternative exists and is dark. |

### §38 Search

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD287–MD293 | The seven example queries: "What does An Thuong look like right now?" · "Show hidden beaches near Da Nang." · "Nightlife that looks social tonight." · "Show my Bangkok rooftop photos." · "Where was this photo taken?" · "Show festival media from my Vietnam Trip." · "Find places that look like this." | **N** ×7 | There is no media search at all: no `MediaSearchScreen` (MD27), no `mediaSearch` client service (MD324), no `/media/search` route (MD367), and `routes/discoverySearch.ts` / `routes/mapSearch.ts` are place-and-post searches that carry no perspective, freshness or visual-similarity concept. Two of the seven ("Where was this photo taken?", "Find places that look like this") would additionally require capabilities the tree does not have (reverse-geo on stripped media; visual similarity — `lib/media/pHashUtils.ts` exists but serves dedup, not search). |
| MD294 | Result types: Media · Places · Hidden Gems · Events · Trips · Experiences · People | **N** | No media search result union exists to type. |

### §39 Offline / Degraded Mode

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD295 | Cache Trip media | **N** | No media cache. `AsyncStorage` in the media tree is used for the selected mode (`src/stores/mediaStore.ts:166`), the Watch feed's session state, and the contributor opt-in toggle — never for content. |
| MD296 | Cache Saved Places | **N** | As MD295. |
| MD297 | Cache Hidden Gems where permitted | **N** | As MD295. |
| MD298 | Cache Event checkpoint visuals | **N** | As MD295. |
| MD299 | Cache recent relevant Place perspectives | **N** | As MD295. `useLensProjection`/`useMediaWorld` fetch and hold in memory; nothing persists. |
| MD300 | Cache Map thumbnails | **W** | `components/CachedImage.tsx` wraps `expo-image`, which has its own disk cache — a per-image HTTP cache, not a curated offline set, with no eviction policy, no scope and no relation to a trip. It is caching, not §39. |
| MD301 | Cache crew-relevant permitted media | **N** | As MD295. |
| MD302 | Cached intelligence must show last-updated time and never be presented as live | **C** | `src/features/media/state/freshness.ts` `cachedAsOfLabel` ("Cached · updated Nm ago"), used at `MediaWorldShell.tsx:97`; and the never-live guarantee is structural — media freshness cannot take the value `live` (`lib/media/mediaFreshness.ts:21`). The one §39 requirement that is built is the one that matters most. |

### §40 Mobile Client Structure

The eleven screens are counted at §4. This section counts the fifteen components, nine
services, six state modules and five type modules — 35 requirements. A file that exists
under a different name but discharges the named responsibility is **C** with the divergence
noted; a responsibility with no implementation anywhere is **N**.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD303 | `MediaWorldHeader.tsx` | **C** | `src/features/media/components/MediaWorldHeader.tsx` |
| MD304 | `CityVisualPulse.tsx` | **C** | `src/features/media/components/CityVisualPulse.tsx` |
| MD305 | `ExperienceMosaic.tsx` | **C** | `src/features/media/components/ExperienceMosaic.tsx` |
| MD306 | `PerspectiveTile.tsx` | **C** | `src/features/media/components/PerspectiveTile.tsx` |
| MD307 | `PerspectiveMosaic.tsx` | **C** | `src/features/media/components/PerspectiveMosaic.tsx` |
| MD308 | `CurrentPictureBadge.tsx` | **C** | `src/features/media/components/CurrentPictureBadge.tsx` |
| MD309 | `FreshnessBadge.tsx` | **C** | `src/features/media/components/FreshnessBadge.tsx` |
| MD310 | `IntelligenceStrip.tsx` | **C** | `src/features/media/components/IntelligenceStrip.tsx` |
| MD311 | `MediaTimeRail.tsx` | **C** | `src/features/media/components/MediaTimeRail.tsx` |
| MD312 | `ChangingNowCard.tsx` | **C** | `src/features/media/components/ChangingNowCard.tsx` |
| MD313 | `HiddenGemCard.tsx` | **N** | Absent. The gems lens renders the pre-existing `src/components/media/GemsFeed.tsx` + `GemsItemOverlay.tsx` (MD15). |
| MD314 | `MediaContextSheet.tsx` | **N** | Absent — no §7 context sheet exists on any media surface. |
| MD315 | `MediaActionRail.tsx` | **C** | `src/features/media/components/MediaActionRail.tsx:2` (*"spec §14/§15/§15.1/§15.2/§32"*), mounted at `app/media-viewer/[id].tsx:796`. |
| MD316 | `MediaContributionSheet.tsx` | **N** | Absent (with MD28, the whole contribution surface is unbuilt). |
| MD317 | `WhyThisSheet.tsx` | **C** | At `src/components/media/WhyThisSheet.tsx` rather than under `features/media/` — a pre-existing component the shell deliberately reuses (`MediaWorldShell.tsx:9-11`, *"Reuses the existing WhyThisSheet (§47)"*). |
| MD318 | `services/mediaProjection.ts` | **C** | `src/features/media/services/mediaProjection.ts` |
| MD319 | `services/mediaUpload.ts` | **C** | Responsibility discharged by the pre-existing `src/services/media.ts:153` `uploadMedia` (+ `validateMedia` at `:109`, `deleteUploadedMedia` at `:289`). Different path, same job. |
| MD320 | `services/mediaProcessing.ts` | **W** | Processing is entirely server-side (`artifacts/api-server/src/lib/mediaProcessing.ts`), which is the right place for EXIF stripping — but the client has no processing module at all, so client-side compression/resize before upload does not happen and a 15 MB photo travels whole. |
| MD321 | `services/mediaPrivacy.ts` | **W** | Privacy is resolved server-side and correctly (`lib/mediaLocationVisibility`); the client carries no privacy module and therefore no client-side privacy state for a composer to consult. |
| MD322 | `services/mediaContext.ts` | **N** | Only `types/mediaContext.ts` exists — the type, not the service. No client context resolver. |
| MD323 | `services/mediaIntelligence.ts` | **N** | Absent. |
| MD324 | `services/mediaSearch.ts` | **N** | Absent (see §38). |
| MD325 | `services/mediaCache.ts` | **N** | Absent (see §39). |
| MD326 | `services/mediaActions.ts` | **C** | `src/features/media/services/mediaActions.ts` |
| MD327 | `state/mediaWorldStore.ts` | **C** | `src/features/media/state/worldState.ts` + `hooks/useMediaWorld.ts` — renamed, same responsibility. |
| MD328 | `state/mediaViewerStore.ts` | **C** | `src/features/media/state/perspectiveViewer.ts` + `perspectiveViewerContext.ts`. |
| MD329 | `state/mediaMapStore.ts` | **N** | Absent (with MD25, there is no map screen to hold state for). |
| MD330 | `state/mediaTimeStore.ts` | **C** | `src/features/media/state/timeBands.ts`. |
| MD331 | `state/mediaFilterStore.ts` | **N** | Absent. Lens/mode navigation state lives in `state/lens.ts`; there is no filter state. |
| MD332 | `state/myMediaStore.ts` | **N** | Absent — `MyWorldMediaScreen` holds bucket selection in local component state. |
| MD333 | `types/media.ts` | **C** | `src/features/media/types/media.ts` |
| MD334 | `types/perspective.ts` | **C** | `src/features/media/types/perspective.ts` |
| MD335 | `types/mediaExperience.ts` | **C** | `src/features/media/types/mediaExperience.ts` |
| MD336 | `types/mediaContext.ts` | **C** | `src/features/media/types/mediaContext.ts` |
| MD337 | `types/hiddenGemMedia.ts` | **C** | `src/features/media/types/hiddenGemMedia.ts` |

### §41 Server-Side Domain Services

Judged by responsibility, not by name — the divergence is recorded in each row.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD338 | MediaAssetService | **W** | `lib/mediaAssets.ts` is the module, and `:118` makes every write a no-op under the seeded-off flag. The service exists and cannot act. |
| MD339 | MediaAttachmentService | **W** | Same module (`recordMediaAsset` writes both), same gate. Attachments are written on the Memory and Hidden-Gem paths (`PassportMemoryService.ts:133`, `HiddenGemService.ts:150`) and are read on one live path (`WallCandidateLoaders.ts:212`) — so the read side works against rows the write side cannot create. |
| MD340 | MediaProjectionService | **C** | `services/media/MediaProjectionService.ts:1-23`. |
| MD341 | MediaContextResolver | **C** | `MediaActionResolver.resolveMediaEntities` (`:197-260`) + `MediaExperienceResolver.ts`. Merged into two modules rather than named separately. |
| MD342 | MediaPrivacyGateway | **C** | `lib/mediaLocationVisibility.ts` (the choke point, `:354,468,542`) + `lib/mediaEligibility` + `lib/media/mediaLocationSafety.scrubPreciseLocation` as the boundary backstop. |
| MD343 | MediaProvenanceService | **W** | `mediaEvidenceEligibility.initProvenance/appendEdit/normalizeProvenance` exist and are pure; the only caller is on the dark write path (`mediaAssets.ts:126`). No served object has provenance. |
| MD344 | MediaEvidenceQualifier | **C** | `lib/media/mediaEvidenceEligibility.ts:1-31` — the qualifier itself is complete, fail-closed and independently testable. |
| MD345 | MediaPerspectiveService | **C** | `services/media/MediaPerspectiveService.ts`. |
| MD346 | MediaExperienceResolver | **C** | `services/media/MediaExperienceResolver.ts`. |
| MD347 | HiddenGemMediaService | **C** | `services/hiddenGems/HiddenGemService.ts` + `HiddenGemContributionService.ts` + `lib/hiddenGemState.ts`. |
| MD348 | MediaRankingService | **W** | `services/ranking/MediaFeedRankingService.ts` exists and ranks the **legacy** feed on engagement multipliers (§24); the World shell has no ranking stage at all (`MediaProjectionService.ts:846-848` sorts by capture time). Neither is §24's ranker. |
| MD349 | MediaSearchService | **N** | Absent (§38). |
| MD350 | MediaActionResolver | **C** | `services/media/MediaActionResolver.ts`. |
| MD351 | MediaModerationService | **C** | `routes/adminMedia.ts` + `lib/moderationAudit.ts` + `post_media_moderation_ledger` + `lib/mediaEligibility` as the distribution gate. |
| MD352 | MediaProcessingService | **C** | `lib/mediaProcessing.ts` + `lib/mediaPipeline.ts` (one policy for both transports) + `lib/videoMetadata.ts`. |

### §42 Projection Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD353 | Media Context Gateway — canonical systems feed one gateway | **C** | `MediaProjectionService.ts:1-23` is that gateway: *"A THIN reader/aggregator … It owns NO truth."* |
| MD354 | Viewer Eligibility resolves next | **C** | `MediaProjectionService.ts:344` `projectCandidatesProtected` is the only shaping path for a non-owner projection, and it runs eligibility then the location choke point. |
| MD355 | Media Projection stage | **C** | `lib/media/mediaProjection.toMediaProjection` — a field whitelist (`:76-97`), not a policy. |
| MD356 | Media Ranking stage before the client | **N** | The stage does not exist in the World-shell pipeline: `buildWorldProjection` sorts zones by item count (`:456-459`) and `buildTimelineProjection` by capture time (`:846-848`). Nothing between projection and client ranks anything. |

### §43 Suggested API Shape

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD357 | `GET /media/world` | **C** | `routes/mediaWorld.ts:96` |
| MD358 | `GET /media/places/:placeId` | **C** | `routes/mediaWorld.ts:120` |
| MD359 | `GET /media/experiences/:experienceId` | **C** | `routes/mediaWorld.ts:149` |
| MD360 | `GET /media/gems` | **N** | Not registered. The gems lens falls back to the pre-existing `GET /media/gems-feed` (`routes/mediaFeed.ts:795`), which is a ranked social feed, not a §16 gem-state projection. |
| MD361 | `GET /media/people` | **C** | `routes/mediaWorld.ts:196` |
| MD362 | `GET /media/me` | **C** | `routes/mediaWorld.ts:221` |
| MD363 | `GET /media/:mediaId` | **C** | `routes/mediaFeed.ts:1669` (pre-existing). |
| MD364 | `GET /media/:mediaId/actions` | **C** | `routes/mediaActions.ts:43` |
| MD365 | `GET /media/map` | **C** | `routes/mediaWorld.ts:271` |
| MD366 | `GET /media/timeline` | **C** | `routes/mediaWorld.ts:245` |
| MD367 | `GET /media/search` | **N** | Absent (§38). |
| MD368 | `POST /media` | **C** | `POST /api/media/upload` (`src/services/media.ts:197` is its client), plus the signed-URL transport documented at `lib/mediaPipeline.ts:8-17`. |
| MD369 | `POST /media/:id/attachments` | **N** | No attachment endpoint. Attachments are written only from inside two services (`PassportMemoryService.ts:133`, `HiddenGemService.ts:150`); no route creates one. |
| MD370 | `POST /media/:id/contribution` | **W** | The nearest thing is `POST /api/media/:id/intent` (`routes/mediaActions.ts:82,145`) — a want-signal, not a contribution. Gem contributions go to `routes/hiddenGems.ts`, not to a media contribution endpoint. |
| MD371 | `POST /media/:id/report` | **C** | `routes/mediaFeed.ts:1070` |
| MD372 | `POST /media/request-view` | **C** | `routes/mediaViewRequest.ts:61` `POST /v1/media/view-requests` (versioned path), with the opt-in at `:94`, coverage at `:111` and reputation at `:141`. |
| MD373 | Every §43 route resolves viewer eligibility before projecting | **C** | `routes/mediaWorld.ts:18-33` states the invariant for all seven of its routes and `:84-92` `sendProjection` applies the fail-closed scrub to every one, proven structurally by `src/test/mediaWorldBoundaryScrub.test.ts:26-30` (a source-level assertion that no handler calls `res.json` directly). |

### §44 Analytics and Product Telemetry

Twenty named signals. The transport is `routes/mediaAnalyticsBatch.ts` with a closed
allow-list at `:37-44` (an unknown type is dropped, never written) writing to `media_events`
(`2039_media_events.sql:16`); the client emitter is `src/features/media/telemetry/mediaTelemetry.ts`.

| id | Requirement (outcome signals) | V | Evidence |
| --- | --- | --- | --- |
| MD374 | Visual opportunity opened | **N** | No such event name in the allow-list or the client vocabulary; the World shell's opportunity cards emit nothing. |
| MD375 | Place explored | **C** | `place_open` (`mediaAnalyticsBatch.ts:40`) + north-star `media_place_open`. |
| MD376 | Hidden Gem opened | **N** | `gems_filter_change` is in the allow-list; a gem *open* is not. |
| MD377 | Compass invoked | **C** | north-star `media_compass` (`mediaTelemetry.ts:72`). |
| MD378 | Directions started | **W** | `directions_tap` is allow-listed (`:41`) but the §45 `media_route` transition is *"reserved: no rail trigger yet"* (`mediaTelemetry.ts:69-71`); the tap event exists on the legacy gems surface only. |
| MD379 | Added to Trip | **C** | `add_to_trip` (`:41`) + north-star `media_trip_add`. |
| MD380 | Plan created | **C** | north-star `media_plan`. |
| MD381 | Invite sent | **N** | No invite action (MD100), so no invite event. |
| MD382 | Experience completed | **N** | No completion detector for an experience; `completion` in the allow-list is *video* completion, which is the opposite signal. |
| MD383 | Contribution submitted / accepted | **W** | `media_contribution` exists as a north-star name and is declared *"reserved"* with no emitter (`mediaTelemetry.ts:74`); gem contributions emit nothing. |
| MD384 | Correction submitted | **C** | north-star `media_correction` (`mediaTelemetry.ts:75`), emitted from the rail's report/not-relevant action. |
| MD385 | Memory / Postcard created | **N** | No creation event on either path; `MyWorldMemoryService` is read-only by design. |

| id | Requirement (social signals) | V | Evidence |
| --- | --- | --- | --- |
| MD386 | Stamp | **C** | `like`/`react` events (`mediaAnalyticsBatch.ts:40`; `routes/mediaFeed.ts:2099,2126`). |
| MD387 | Comment | **C** | `comment` (`:40`). |
| MD388 | Share | **C** | `share` (`:40`), recorded at `routes/mediaFeed.ts:2291-2298`. |
| MD389 | Save | **C** | `save` (`:40`). |
| MD390 | Qualified view | **C** | `qualified_view` (`:39`), defined as ≥3 s watched (`MediaFeedRankingService.ts:62`). |
| MD391 | Completion | **C** | `completion` (`:39`). |
| MD392 | Rewatch | **C** | `rewatch` (`:39`). |
| MD393 | Profile open | **C** | `profile_open` (`:40`). |

**The shape of the §44 result matters more than the count.** Every one of the eight
*social* signals is built and firing. Six of the twelve *outcome* signals are unbuilt and
three more are names with no emitter. §44's whole point is that outcome signals should be
first-class alongside social ones; the tree has the social half complete and the outcome
half about a third done — and the third that exists (`mediaTelemetry.ts`) only fires from
inside the flag-dark action rail (`MediaActionRail.tsx:51` is its sole caller). The
allow-list header at `mediaAnalyticsBatch.ts:26-32` records that even the names that do
exist were silently dropped until recently: *"the batch endpoint answered `{ ok: true }`
and this line dropped every one of them … the funnel simply read zero."*

### §45 North-Star Metrics

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD394 | Media → Place Open | **C** | `mediaTelemetry.ts:71` `media_place_open`, emitted from the rail. |
| MD395 | Media → Compass | **C** | `mediaTelemetry.ts:72`. |
| MD396 | Media → Route | **N** | `mediaTelemetry.ts:73` — declared *"reserved: no rail trigger yet"*. A name, not a metric. |
| MD397 | Media → Trip Add | **C** | `mediaTelemetry.ts:74` `media_trip_add`. |
| MD398 | Media → Plan | **C** | `mediaTelemetry.ts:75` `media_plan`. |
| MD399 | Media → Real-World Arrival | **N** | `mediaTelemetry.ts:78` — reserved, no emitter, and no arrival detection exists anywhere on a media path. |
| MD400 | Media → Contribution | **N** | Reserved, no emitter. |
| MD401 | Media → Useful Correction | **C** | `mediaTelemetry.ts:76` `media_correction`. |
| MD402 | Do not optimise primarily for minutes watched, infinite scroll depth or forced autoplay completion | **W** | All three are optimised for on the live surface: `MediaFeedRankingService.ts:60-70` multiplies by `watchCompletionRate`, `qualifiedViewCount` and `rewatchRate`; `WatchFeed.tsx:1-8` is an infinite paging feed; `WatchFeedList.tsx:526` autoplays on viewability. The prohibition is not merely unenforced — the forbidden objective is wired into the ranker. |

### §46 Visual Design Specification

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD403 | Dark/night-friendly primary foundation with high contrast and clear state labels | **?** | The shell commits to dark (`MediaWorldShell.tsx:9` *"Night-first dark foundation (§46)"*, `theme/tokens.ts` colour ground) and the state labels are explicit strings from `state/stateColors.ts`. Measured contrast ratios and dynamic-type behaviour on a real device are not in the tree — this is the one §46 item I agree with the certification is genuine runtime QA. |
| MD404 | Large place/world imagery and spatial mosaics instead of repeated stacked cards | **C** | `components/PerspectiveMosaic.tsx` + `ExperienceMosaic.tsx` + `MasonryGrid.tsx`; the World lens renders zones and mosaics, not a card stack. |
| MD405 | Geographic context and Map integration | **W** | Server-side yes (`MediaProjectionService.ts:906-914` delegating placement to the canonical Map). Client-side no: there is no Media Map screen (MD25), no map store (MD329), and My World's map mode is a placeholder (`MyWorldMediaScreen.tsx:95-99`). |
| MD406 | Time rails and temporal state as first-class UI | **C** | `components/MediaTimeRail.tsx` + `state/timeBands.ts` over the four §17 bands; Time is a first-class presentation mode for NOW and PLACES (`state/lens.ts:25-26`). |
| MD407 | Subtle current-state pulses; no fake-live treatment | **C** | `components/FreshnessBadge.tsx` renders a `live` class as a calm recency label; media freshness cannot be `live` at all (`mediaFreshness.ts:21`), so a fake-live treatment has no value to render. |
| MD408 | Minimal visible vanity metrics | **W** | True of the shell (no counts on `PerspectiveTile`), false of the product: `WatchItemOverlay.tsx:134,403-437` renders stamp, comment and save counts through `formatCompactCount` as the primary rail. |
| MD409 | Clear freshness / confidence language | **C** | `state/freshness.ts` (`cachedAsOfLabel`, age copy), `components/CurrentPictureBadge.tsx`, and forecast confidence bands from `mediaTimeBands` (a forecast without one is omitted, MD145). |
| MD410 | Observed, inferred and predicted states use distinct visual treatments | **C** | `mediaTimeBands.ts:50-57` emits `TimeBandRenderClass = "observed" \| "typical" \| "predicted"` precisely so the client can key three treatments; `state/stateColors.ts` + `MediaTimeRail.tsx` consume it. |
| MD411 | Hidden Gems use distinct discovery/protection visual language | **C** | `src/lib/gems/gemStateDisplay.ts` + `components/media/GemsItemOverlay.tsx`; the ten §16 states each get their own label. |
| MD412 | Compass is a primary intelligence/action control | **W** | It is a primary control in the dark rail (`MediaActionRail.tsx`, `ask_compass` at `MediaActionResolver.ts:413`). On the shipped viewer the primary control is Stamp; Compass is not present on `WatchItemOverlay` at all. |
| MD413 | Creator identity is visible but secondary in world-first lenses | **C** | `lib/media/mediaProjection.ts:95` — the contributor field is commented *"visible but secondary in world-first lenses (§46)"*, and `:176-186` projects handle-first with presentation-name opt-in left to the social caller. The World lens groups by zone before contributor (`MediaProjectionService.ts:439`). |

### §46.1 Hidden Gem Visual Language

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD414 | Gem icon or geometric discovery marker | **C** | `Gem` icon used in `app/(tabs)/media.tsx:26`; `components/media/GemsItemOverlay.tsx`. |
| MD415 | Subtle edge glow or contour treatment | **N** | No glow/contour treatment in the gem components; `GemsItemOverlay.tsx` is a standard overlay. |
| MD416 | Map discovery contour / approximate zone treatment | **N** | No map contour rendering. The *data* supports it — `mediaLocationVisibility.ts:98` yields a `neighborhood`-tier disclosure for approximate gems — and no client draws a zone. |
| MD417 | Recently Confirmed / Worth the Detour / Still Hidden / Seasonal labels | **C** | `src/lib/gems/gemStateDisplay.ts` maps the ten `hiddenGemState` values (`lib/hiddenGemState.ts:37-50`) to display labels. |
| MD418 | Avoid Viral / Trending / Hot / popularity-counter language | **C** | No such copy in the gem surfaces, and it is structurally discouraged: `hiddenGemState.ts:28-31` keeps `save_count`/`visit_count` out of ranking, so there is no popularity number to counter with. |

### §46.2 Anti-Patterns

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD419 | No TikTok-style endless vertical video feed | **W** | Built. `src/components/media/WatchFeed.tsx:1-8` + `WatchFeedList.tsx` — a full-screen vertical paging feed, the seeded default mode (`mediaStore.ts:104,145`; `2037:17-20`). |
| MD420 | No Instagram-style creator-first stacked posts | **C** | The Grid mode is a masonry place/media mosaic (`GridFeed.tsx`, `MasonryGrid.tsx`), not a creator-first stack. |
| MD421 | No YouTube thumbnail/title/channel list | **C** | No such list anywhere in the media surfaces. |
| MD422 | No Facebook-style newsfeed cards | **C** | The newsfeed card pattern lives in the Wall, not Media; the media surfaces are feed/mosaic/mosaic. |
| MD423 | No follower/view counts dominating Media | **C** | Follower and view counts are absent from the media overlays — `WatchItemOverlay.tsx` shows stamp/comment/save, not followers or views. |
| MD424 | No Heart/Like as primary hierarchy | **W** | Built. `WatchItemOverlay.tsx:403-411` — the Stamp control sits in `s.heartGroup`, is the first and largest item in the action rail, and carries a compact count. It is the primary hierarchy on the default surface. |
| MD425 | No autoplay as primary navigation | **W** | Built. `WatchFeedList.tsx:526` sets `isActive` from viewability and `WatchVideoCell.tsx:158` `shouldPlay={isActive}` — advancing the feed *is* the play control. |
| MD426 | No random engagement-ranked viral feed | **C** | Ranking is not random and not virality-driven: `portavaRank.ts:182-201` weights recency, geo, taste and actionability above `socialProof 0.25`, and `LOCAL_MOMENTUM_MAX_CONTRIBUTION` is capped by ruling (`:143-150`) so momentum *"cannot lift a place over one the viewer's taste prefers by even a single interest tag."* This one the tree gets right on purpose. |
| MD427 | No full-screen stranger video immediately on Media open | **W** | Built. Opening the Media tab with the seeded flags lands directly in `WatchFeed`, full-screen, autoplaying, with no place or context first. |

### §47 Why This? Explanations

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD428 | "Why you're seeing this" — a per-item explanation naming intent match, distance, perspective freshness, area activity and prior saves | **W** | The sheet exists and is reused by the shell (`src/components/media/WhyThisSheet.tsx`, `MediaWorldShell.tsx:9-11`) over the ranking snapshots written by `MEDIA_RANKING_ENABLED` (`MediaFeedRankingService.ts:20`, `2041_media_ranking_snapshots.sql`). But it explains the **ranker's** reasons — creator boosts, fatigue, diversity — not §47's five, and two of the five (fresh perspectives in the last 10 minutes; area activity increasing) are not ranking inputs at all (MD184, MD185 is recency-of-item not perspective-freshness-of-place). The explanation surface is right and its content is a different explanation. |

### §48 State Ownership

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD429 | Media owns asset, provenance, media presentation | **W** | Presentation yes (`lib/media/mediaProjection.ts`). Asset no — the canonical asset store is dark and unread (MD36). Provenance no (MD343). |
| MD430 | Places owns canonical Place identity | **C** | `places` + the canonical bridge; `MediaActionResolver.ts:201` carries `places.id` opaquely and never re-derives identity from a name or coordinate. |
| MD431 | Hidden Gems owns gem identity and gem-specific state | **C** | `hidden_gems` + `lib/hiddenGemState.ts:13-18`, which derives state at read time so it cannot drift from the owner. |
| MD432 | Trips owns Trip context | **C** | Media reads `trips`/`trip_members` and never writes them; `MediaActionResolver.ts:458` hands "Add to Trip" to the trip endpoint under that endpoint's own gate. |
| MD433 | Events owns event identity and lifecycle | **C** | `MediaExperienceResolver.ts:1-14` reuses `routes/events.checkEventEligibility` rather than re-implementing event visibility. |
| MD434 | Live Intelligence owns current claims, evidence, confidence, freshness | **C** | `lib/liveClaimRead` is the sole source of a current-state label for Media (`MediaProjectionService.ts:379`); media freshness is typed so it cannot claim `live` (`mediaFreshness.ts:21`). |
| MD435 | Discovery owns opportunity ranking | **W** | `services/ranking/DiscoveryRankingService.ts` exists, and Media has its **own** ranker (`MediaFeedRankingService.ts`) with its own boost flags — the ownership line is crossed in the direction §48 forbids. |
| MD436 | Compass owns recommendation and decision support | **C** | `compass/CompassMediaContext.ts:1-14` — *"It does NOT fork the Compass engine; the engine stays propose-only."* Media supplies context and reads nothing back as truth. |
| MD437 | Map owns geographic projection | **C** | `MediaProjectionService.ts:906-914` — the media map carries **no geometry** and omits any cluster it cannot bind to a canonical place (`:934-937`). The strongest ownership boundary in the census. |
| MD438 | Trust owns contributor/evidence reliability | **C** | `MediaContributorReputationService.ts:1-12` reads only intel tables; the pure computation lives in `lib/mediaContributorReputation.ts`; no social table is joined. |
| MD439 | Memory owns experience projection | **C** | `MyWorldMemoryService.ts:1-33` — *"This service CONSUMES the existing Memory system — it never writes a second memory store."* |
| MD440 | Passport owns travel identity | **C** | MD225/MD226; the Media surface reads postcard counts and writes nothing into Passport. |

### §49 Implementation Phases

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD441 | Phase 1 — Canonical Foundation: audit MediaAsset, attachments, upload, processing, storage, visibility, moderation | **?** | The *work* landed (`0191_media_assets.sql:1-9` calls itself *"Phase 1.5 of the media Phase 0 audit"*, `2250` completes the §6 model). The **audit artifact itself is not in the repo**: `docs/media/` holds `4k-pipeline-scoping.md`, `staging-boundary-*.md` and a public-read revocation evidence file, and there is no Phase 0/1 media audit document anywhere under `docs/`. Whether the audit was performed to the standard §49 asks cannot be settled from the tree. |
| MD442 | Phase 2 — New Media Shell: NOW · PLACES · EXPERIENCES · HIDDEN GEMS · PEOPLE · MY WORLD | **C** | `MediaWorldShell.tsx` + `state/lens.ts:24-31` + the five lens screens. Delivered (and dark). |
| MD443 | Phase 3 — Context Projection: wire Places, Events, Trips, People, Hidden Gems | **C** | `MediaActionResolver.resolveMediaEntities` (place/trip/gem), `MediaExperienceResolver` (event/trip), `buildPeopleProjection` (people). |
| MD444 | Phase 4 — Perspectives: mosaics, perspective groups, current picture, freshness | **W** | Mosaics, current picture and freshness are delivered (`PerspectiveMosaic.tsx`, `CurrentPictureBadge.tsx`, `mediaFreshness.ts`). Perspective **groups** are the §12 vantages, which `MediaPerspectiveService.ts:8-12` explicitly declines to invent (MD82–MD85). Three of four. |
| MD445 | Phase 5 — Intelligence: evidence qualification → observations/claims with provenance boundaries | **W** | Qualification is delivered and excellent (`mediaEvidenceEligibility.ts`); the boundary to observations/claims is deliberately **not** wired (`mediaEvidenceLink.ts:130`, flag off). The phase's first half shipped; its second half is a refusal. |
| MD446 | Phase 6 — Discovery + Compass: Show Me Now, Why This, Find Similar, Go There, Ask Compass, I Want This | **W** | Why This (`WhyThisSheet`), Find Similar (`:396`), Ask Compass (`:413`), I Want This (`:358`) delivered. "Show Me Now" has no artifact under that or any equivalent name; "Go There" is show-on-map without directions (MD94). Four of six. |
| MD447 | Phase 7 — Time: Earlier/Now/Typical + forecasts with observed-vs-predicted styling | **C** | `mediaTimeBands.ts` four bands + `TimeBandRenderClass` (MD140–MD145, MD410). |
| MD448 | Phase 8 — Hidden Gem Intelligence: protection, confirmation, access/crowd state, contributor flows | **C** | `lib/hiddenGemState.ts` + `HiddenGemPrivacyGuard` + `HiddenGemVerificationService` + `HiddenGemContributionService` (storage absent from production, §3). |
| MD449 | Phase 9 — My World + Memory: Grid/Timeline/Map, experience grouping, Memories/Postcards | **W** | Grid, Timeline, grouping and Memories/Postcards delivered (`MyWorldMemoryService.ts:47-53`, `MediaProjectionService.ts:742-746`); Map is a placeholder (`MyWorldMediaScreen.tsx:95-99`). |
| MD450 | Phase 10 — Human Network: media missions, Request a View, contributor reputation, coverage gaps | **C** | `MediaViewRequestService.ts:1-27` (missions + request), `MediaContributorReputationService.ts` (reputation), `routes/mediaViewRequest.ts:111` (coverage). All four delivered; the two tables are absent from production (§3). |

---

## 6. What could not be verified

Only **two** requirements are CANNOT-VERIFY, and neither is one the certification listed.

| id | Requirement | Why the tree cannot settle it | What would settle it |
| --- | --- | --- | --- |
| MD403 | §46 dark/night-friendly foundation **with high contrast** and clear state labels | The palette and the labels are in the tree (`theme/tokens.ts`, `state/stateColors.ts`) and the shell commits to dark (`MediaWorldShell.tsx:9`). Measured contrast ratios against rendered imagery, dynamic-type scaling, screen-reader output and touch-target sizes are properties of a device, not of a file. | A device a11y pass. This is the one item where I agree with the certification's "runtime QA required" label. |
| MD441 | §49 Phase 1 — *audit* MediaAsset, attachments, upload, processing, storage, visibility, moderation | The **work** the audit was meant to produce is in the tree and traceable (`0191_media_assets.sql:1-9` calls itself *"Phase 1.5 of the media Phase 0 audit"*; `2250` completes the §6 model). The **audit artifact** is not: `docs/media/` contains `4k-pipeline-scoping.md`, `staging-boundary-decisions.md`, `staging-boundary-step01-evidence.md` and `post-media-public-read-revocation-evidence.md`, and no Phase-0/Phase-1 media audit document exists anywhere under `docs/`. Whether the audit covered what §49 lists is not decidable from what remains. | The audit document, or a decision that the migration headers are the audit. |

**Deliberately not folded into CANNOT-VERIFY** — thirteen verdicts are code-settled and
effect-unresolved. The code question has an answer; whether the code does anything does
not. Listing them here rather than in a bucket keeps the headline honest in both
directions.

| Verdict | What is unresolved | What would settle it |
| --- | --- | --- |
| MD36, MD37, MD38, MD338, MD339 (`media_assets` / attachments) | `media_canonical_enabled` is off, so the canonical asset store has no writer; `media_assets` is in production and, so far as the tree can show, is written by nothing. | A row count, or flipping the flag. |
| MD106 (§15.1 I Want This) | `media_intent_signals` is **absent from production** (`scripts/checkProductionDrift.ts:173`). | Applying 2256. |
| MD154–MD158 (§19 Request-a-View) | `media_view_requests` and `media_view_request_optins` are **absent from production** (`:174-175`). | Applying 2257. |
| MD130–MD139 (§16.3 gem contributions) | `hidden_gem_contributions` is **absent from production** (`:172`), and `routes/hiddenGems.ts:78` imports the service that reads it. | Applying 2252. |
| MD159 (§20 city visual pulse) | Every zone's state label comes from a gated live claim, and `docs/architecture/intel-spine-liveness.md` measured every `intel_*` table at `count(*) = 0` in production. The pulse is correct and can currently only ever render "no state". | Any production observation. |
| MD265 / MD344 (§35 evidence qualification) | The qualifier is complete; its one consumer is behind `media_evidence_enabled`, seeded off with a migration postcondition that refuses an ON seed. | A deliberate flag flip after the §9 boundary review. |
| MD394–MD401 (§45 north-star) | The emitter's only call site is inside the flag-dark action rail. | `MEDIA_WORLD_SHELL_ENABLED`. |

---

## 7. Three method caveats

1. **Writer attribution is incomplete by the repo's own analyzer's admission.**
   `src/scripts/checkWriterlessReads.ts:39-41` — *"A dynamic `.from(expr)` anywhere makes
   attribution incomplete, and the run says so rather than pretending otherwise."* Every
   "nothing writes X" here was settled by opening call sites: `media_assets`'s two writers
   are `routes/posts.ts:256` and `lib/mediaAssets.ts:495`, both routed through the flag
   check at `mediaAssets.ts:118`; `media_intent_signals`'s one writer is
   `routes/mediaActions.ts:161`. A `from("table")` grep alone would have missed both
   directions.

2. **No database was queried.** Production facts come from the supplied ground truth, the
   committed snapshot `baseline/20260907_production_tables.txt`, and
   `scripts/checkProductionDrift.ts`'s classification table. Where a migration's seed
   value disagrees with a production fact, the production fact wins — a migration file is
   not evidence of live state, and `2300:14-25` makes exactly that point about the five
   phantom flags.

3. **Client behaviour is asserted from code, not from a device.** MD277 (adaptive
   playback), MD280 (captions), MD281 (resume), MD284 (background upload) were established
   by searching `travel-buddy-standalone/src`, `travel-buddy-standalone/app` and the
   dependency manifest. A native module reached through a dynamic import from a path I did
   not open would not appear — though for four capabilities that would each need a library,
   a package, or a manifest entry, absence across all three is strong.

---

## 8. If I had to say one thing

The Media v2 programme built, with unusual care, a **correct second Media product** —
world-first, coordinate-free, fail-closed on every privacy branch, honest about what it
does not know (`MediaPerspectiveService.ts:8-12` refusing to invent a vantage;
`mediaAssets.ts:26-50` refusing an implausible capture time; `hiddenGemState.ts:14-18`
refusing to let one report move a gem) — and then left it behind a flag whose own
migration records that it is *"reachable by nothing"*, while the Media a user reaches
remains the full-screen autoplaying stranger-video feed the spec's §46.2 forbids in four
separate clauses.

That is not a construction failure. Every one of the 291 correct verdicts is real code I
read. It is a **shipping** failure, and no certification scoped to construction can see it.
