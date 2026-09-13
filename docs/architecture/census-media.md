# Portava Media v2 — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt` |
| **`.docx` reconciliation** | Extracted `word/document.xml`, stripped tags, whitespace-normalised, diffed against the `.txt`. **The only differences are three XML entity escapes** (`&amp;` in the title, and no `&lt;`/`&gt;` in this spec). The `.txt` is a faithful transcription; the "`.docx` is authority" clause never had to be exercised. |
| **Section count** | The brief said 50 sections. **50 top-level sections is correct**, but the spec also carries **11 numbered subsections** (§4.1, §6.1, §15.1, §15.2, §16.1, §16.2, §16.3, §23.1, §31.1, §46.1, §46.2) — **61 numbered units**. Counting only the 50 undercounts §16 (three subsections, 31 requirements) and §46 (two subsections, 14 requirements) badly. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. Backend paths relative to `artifacts/api-server/src/`, client paths to `travel-buddy-standalone/` unless stated. |
| `head_commit` | `42aeac38` — DECLARED 2026-09-11, and **it starts a clock rather than certifying a past**. Read the next row before quoting it. |
| **What that declaration does and does not say** | `42aeac38` is #476's squash — the commit where this document itself reached `main`. The 450 verdicts were taken at working tree `68ed59d9`, which this repository's squash-merge orphaned: it resolves in no clone, so **nobody can diff `68ed59d9..42aeac38`, and this declaration does not claim that interval was empty.** What it does claim is mechanically checked: `git diff --name-only 42aeac38..HEAD` over the 26 paths now in `CENSUS_SCOPE["census-media.md"]` returns **0 files**, and from here on any change to one of them ages this census. That is the whole value — before it, `check:census-freshness` reported this document as CANNOT BE CHECKED, which is the weakest of the three states and the one it had been in since it was written. FRESH here means *no counted file has moved since `42aeac38`*. It does **not** mean the rows were re-read; none has been. Declared by the Trips lane while recounting the sibling census, on the pattern `check:census-freshness` itself recommends for an orphaned declaration; if the Media lane disagrees, reverting costs only the check. |
| **Database** | Not queried. Production storage facts are the ones supplied as ground truth plus the committed snapshot `artifacts/api-server/baseline/20260907_production_tables.txt` and `src/scripts/checkProductionDrift.ts:168-176`. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a `file:line` that was opened and read. |
| **Sibling** | `docs/architecture/census-trips.md`, produced in the same pass under the same denominator rule, so the two are directly comparable. Trips scores **47.9 % constructed / 19.7 % correct** — its §36 recount at merged `main` `014a25d5`, which superseded the 41.7 % / 17.3 % this row used to quote. Its spec-attributable figure was **withdrawn**, not restated: §26 of that census established the 0.0 % was false, and no measured replacement exists. |

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
that rather than assume it. I did. Media is different: 62 files in the tree carry the literal string `Media v2` (45 of them
non-test), migrations `2250`/`2255`/`2256`/`2257` name their phase and their spec section
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
| BUILT-AND-CORRECT, spec-attributable | **216** | **48.0 %** |
| BUILT-AND-CORRECT, pre-existing | 75 | 16.7 % |
| (BUILT-AND-CORRECT, total) | 291 | 64.7 % |

Per-section split of the 291 correct verdicts, so the 216 can be re-derived rather than
taken on trust — `A` = attributable, `P` = pre-existing:

`§2 6A · §3 5A · §4 6A · §5 4A · §6/§6.1 1A+2P · §7 8A · §8 1A+1P · §9 4A+2P · §10 4A ·
§11 1A · §12/§13 2A · §14 2A · §15 7A+1P · §16 22A+8P · §17 6A · §18 2A · §19 6A · §20 1A ·
§21 2A · §22 1P · §23 6A · §23.1 2A · §24 2A+12P · §25 3A+3P · §26 3A+1P · §27 1P ·
§28 1A+5P · §29 1A+1P · §30 2A · §31 7A · §31.1 5A · §32 11A · §33 3A · §34 5P · §35 2A ·
§36 4A+4P · §37 4P · §39 1A · §40 21A+2P · §41 8A+2P · §42 3A · §43 10A+3P · §44 4A+9P ·
§45 5A · §46 7A · §46.1 2A+1P · §46.2 5P · §48 8A+2P · §49 5A` = **216 A + 75 P = 291**.

Three sections carry most of the pre-existing share: §24 ranking (12 P — `lib/portavaRank.ts`
and `MediaFeedRankingService.ts` both predate the programme), §44 telemetry (9 P — the eight
social signals were already firing), and §46.2 anti-patterns (5 P — five of the nine are
satisfied by surfaces that were never built rather than by anything Media v2 did).

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

**On "the surface a user reaches", precisely.** `MEDIA_TAB_ENABLED` is itself seeded false
(`2037_media_tab_flags.sql:7-10`), and `app/(tabs)/media.tsx:1-6` records that the route
stays registered for deep-links even then. So there are exactly two reachable
configurations, and the World shell is in neither: with the tab off there is no Media
surface at all, and with it on the landing mode is Watch, because
`MEDIA_VIEW_MODE_FULLSCREEN_ENABLED` is seeded **true** (`2037:17-20`) and the store's
default is `'watch'` (`src/stores/mediaStore.ts:104,145`). Every §46.2 verdict below is
about the second configuration; none of them changes if the tab is dark, because a
disabled surface is not a compliant one.

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
| MD48 | → Event | **C** | `MediaExperienceResolver.ts:33#kind` `kind: "event" | "trip"`, emitted at `:152#event`, gated by `checkEventEligibility` (imported at `:17#checkEventEligibility` from `routes/events.ts`). |
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
| MD68 | MEDIA / DISCOVERY / MAP / COMPASS outputs | **C** | `routes/mediaWorld.ts` (media), `MediaProjectionService.ts:916` map clusters, `compass/CompassMediaContext.ts:232` consumed at `routes/compass.ts:1534#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, Date.now());`. |

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
| MD95 | Ask Compass | **C** | `MediaActionResolver.ts:19-20` (Compass-gated) → `compass/CompassMediaContext.ts:232` `buildCompassMediaContext`, consumed at `routes/compass.ts:1534#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, Date.now());`. |
| MD96 | Save Place | **C** | Resolved to the existing saved-places endpoint and served at `routes/mediaActions.ts:43,82`. |
| MD97 | Add to Trip | **C** | `MediaActionResolver.ts:16-18` — offered only when `canEditPlan` passes, which is the exact gate the trip-plan-item endpoint enforces, so the rail can never grant access the endpoint would deny. |
| MD98 | Create Plan | **C** | Same resolver, Compass-gated (`:19-20`). |
| MD99 | Meet Here | **C** | `MediaActionResolver.ts:18-19` — respects the new-event kill switch. |
| MD100 | Invite People | **N** | No invite member in the resolver's action vocabulary; nothing in `routes/mediaActions.ts` emits one. |
| MD101 | Find Similar / Cheaper / Quieter / Busier | **W** | "Find somewhere like this" reaches Compass as a structured ask (`CompassMediaContext.ts:9-12`). There is no cheaper / quieter / busier comparator anywhere — no comparative modifier in the resolver, the Compass media context, or the projection. One of four. |
| MD102 | See Nearby | **C** | `MediaActionResolver.ts:385-392` — emitted only when a place resolves, targeting `GET /api/media/map` scoped to the media's coarse city. No coordinate leaves the server; the client positions the clusters through the Map gateway it already holds. |
| MD103 | View Event / Passport | **W** | Event refs resolve (`MediaExperienceResolver.ts:152#event`). Passport does not: `MediaActionResolver.ts:53` `MediaEntityKind = "media" \| "place" \| "trip" \| "gem"` has no passport member, and §29 keeps Passport on Postcards. Half built. |
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
| MD163 | §22 Never expose individual routes | **C** | Satisfied structurally by the producer Media would consume: `lib/crowdFlowProducer.ts:14-30` — *"There is no per-actor path type, anywhere. The input unit is ONE HOP … so a path cannot be assembled even internally."* Vacuous on the Media side (MD162), but the guarantee is real and would hold if Media were wired in. |

### §23 Experience Projections · §23.1 Experience Chains

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| MD164 | `MediaExperienceProjection` contract | **C** | `services/media/MediaExperienceResolver.ts:31` onward; served at `routes/mediaWorld.ts:149`. |
| MD165 | An experience resolves from a canonical Event **or** a Trip (`placeIds`, `eventId`, `tripId`) | **C** | `MediaExperienceResolver.ts:33#kind` `kind: "event" | "trip"`, with event eligibility reusing `routes/events.checkEventEligibility` (imported at `:17#checkEventEligibility`) rather than re-implementing it. |
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
| MD176 | §23.1 action: Ask Compass (on an experience) | **C** | `CompassMediaContext.ts:232` carries the experience's entity refs into the Compass ask. |

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
| MD242 | The `CompassMediaContext` contract | **C** | `compass/CompassMediaContext.ts:232` `buildCompassMediaContext`, wired into the real ask path at `routes/compass.ts:1534#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, Date.now());`. |
| MD243 | `entityRefs` — coarse, opaque, viewer-permitted | **C** | `CompassMediaContext.ts:26-53` — refs come from `resolveMediaEntities`, which runs the location/gem choke point, so a hidden venue, a gem-ceilinged place, and a protected gem's **name** are all withheld before anything is rendered into the prompt. |
| MD244 | `viewerContext` | **C** | `CompassMediaContext.ts:69-74` — `viewerCountry` and `subjectCity` only, *"never a coordinate"*. |
| MD245 | `permittedIntelligenceRefs` | **C** | `CompassMediaContext.ts:19-25` — filtered **twice**: the intel comes only from the gated fail-closed live-claim read, then is filtered to refs whose place the viewer is eligible to see. |
| MD246 | Question: "Is this worth going to now?" | **C** | `CompassMediaContext.ts:9-12` names it as the driving case; the context lines are appended to the ask at `routes/compass.ts:1534#const mediaCtx = await buildCompassMediaContext(sc, mediaViewer, mediaId, Date.now());`. |
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

---

## 9. Six C rows executed, four of them wrong, and the two the pass repaired

| Field | Value |
| --- | --- |
| **Measured at** | `3eaf2436f` — the tip of `claude/sweet-fermat-fmx7up` when this pass started, and an ancestor of the branch head that carries §9. The document's single `head_commit` row (§0) is **not** moved: this section re-reads six rows, not 450, and a document-wide declaration must not be moved by a partial re-measurement. The counted files this pass changed are named, one at a time with an argument, in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`. |
| **Method** | For each row: read the OBJECT the row cites, then execute the claim the row makes — follow the call site to a writer, or to the absence of one. Six rows were picked for weight, not for ease: everything §36 (moderation), the two report rows, and §16.1's duplicate check. |
| **What this section is NOT** | A re-measurement of the other 444 rows. Nothing here says they are right; it says nobody re-read them. |
| **Prior sections** | Unchanged and not restated. §1–§8 stand as written. Last statement wins for the six ids below. |

### 9.1 What the report endpoint actually does

MD105 read **C** on this evidence: the row named `POST /media/:id/report` at line 1070 of
`routes/mediaFeed.ts` and said *"not-interested/hide are consumed as ranking penalties"* at
lines 65 to 70 of `services/ranking/MediaFeedRankingService.ts`.
Both halves are false, and the way they are false is worse than either.

**The client sends viewer preferences to the moderation endpoint.** The Media options sheet
is the reachable one — `components/media/MediaMoreMenu.tsx` is imported by `WatchFeed.tsx`
and `GemsFeed.tsx`, which are two of the three modes of the shipped Media tab, not the dark
World shell. For a non-owner its first two rows are "Not interested" and "Hide", **above**
"Report", and both post to the report endpoint:
`travel-buddy-standalone/src/components/media/MediaMoreMenu.tsx:135#await hideMedia(mediaId);`
and `travel-buddy-standalone/src/components/media/MediaMoreMenu.tsx:142#await reportMedia(mediaId, 'hide_from_feed');`,
through `travel-buddy-standalone/src/services/mediaInteractions.ts:124#export async function hideMedia`.

So, before this pass:

- On a **post**, tapping "Not interested" inserted a row into `reports` with
  `reason_code = 'not_interested'` — the table `routes/reports.ts` documents as
  evidence-preserving and never deleted. A viewer's taste became a permanent accusation
  against another user's content.
- On a **gem**, the same tap ran `reportGem`, which inserts `hidden_gem_reports` and then
  increments the gem's report count at
  `artifacts/api-server/src/services/hiddenGems/HiddenGemModerationService.ts:66#const { error: updError } = await db.from("hidden_gems").update({ report_count: next }).eq("id", gemId);`.
  That is the same counter whose sibling function spends a paragraph explaining that a
  report pile must never become a finding, or the trust system becomes a weapon.
- **Nothing was hidden.** `post_hides` — created by
  `artifacts/api-server/src/migrations/0116_post_hides.sql:9#CONSTRAINT post_hides_unique UNIQUE (user_id, post_id)`,
  present in production, and READ by
  `artifacts/api-server/src/routes/pulse.ts:157#const { data: hiddenRows } = await sc`
  to suppress a viewer's hidden posts — was written by **nothing anywhere in the tree**.
  Pulse honoured a list no surface could add to.
- **The cited ranking penalty had no inputs.** `notInterestedPenalty` reads three fields
  (`artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts:348#const hideR = hideRate ?? (notInterestedCount != null ? notInterestedCount / total : 0);`)
  and no producer in the tree set any of them. Every feed was ranked as though nobody had
  ever hidden anything. MD105's second clause described a computation whose operands did
  not exist.

Three further divergences from the contract the row claims: the schema accepted
`z.string().max(100).default("spam")`, so an **unknown** reason was written verbatim as a
`reason_code` and a **missing** reason became a spam report; no severity was computed, so a
`harassment` report from Media never reached the auto-restrict and anti-retaliation path
`routes/reports.ts` exists to run; and there was no rate limit and no duplicate check, with
`alreadyReported` hard-coded false on the post branch.

**MD105: C → W at `3eaf2436f`.** MD371 (`POST /media/:id/report`) stays **C** — the endpoint
§43 names does exist — but its one-citation evidence is exactly the kind of C that cannot
see any of the above, and this section is the correction to that record rather than to the
verdict.

### 9.2 §36's "Safety moderation" is an admin console and an audit log

MD269 read **C** on `media_assets.moderation_status`, `routes/adminMedia.ts`,
`post_media_moderation_ledger` *(in production)* and `lib/moderationAudit.ts`. Executed:

1. **The only production writer of `post_media` rows is the postcard transport**, and it
   promotes to distributable unconditionally. The row is created pending at
   `artifacts/api-server/src/routes/postcards.ts:481#moderation_status: 'pending',` and the
   completion handler sets
   `artifacts/api-server/src/routes/postcards.ts:978#moderation_status:      'approved',`
   with no classifier, no queue and no hold of any kind between them. Nothing decides; the
   state machine's promotion step is a literal.
2. **`post_media_moderation_ledger` has no reader and no writer.** It appears in
   `src/test/generated/liveColumns.json` and the two committed schema snapshots and nowhere
   else — no migration creates it, no module touches it. It was cited as evidence by two
   rows.
3. **`lib/moderationAudit.ts` writes `moderation_actions`** — an audit of what an admin did,
   after they did it. It is a record, not a stage.
4. **`routes/adminMedia.ts` can write exactly three values** —
   `artifacts/api-server/src/routes/adminMedia.ts:846#action === "approve" ? "approved" :`
   and the two beneath it. Reactive and manual.

§36 lists Safety moderation as a **pipeline stage**. What exists is an unconditional
promotion plus a console someone may use afterwards. **MD269 C → W**, and with it
**MD283 C → W** (§37 says video takes the same pipeline as images, which is true and is
the problem — nothing decodes video, so nothing could classify it even in principle) and
**MD351 C → W** (§41 names a *MediaModerationService*; there is no such module, and one of
the four things cited in its place is inert).

### 9.3 The distribution gate was fail-closed at one level and fail-open at the next

MD273 read **C**: *"`filterEligibleMediaCandidates` is the fail-closed distribution gate"*,
plus a second clause naming line 1119 of `services/wall/WallCandidateLoaders.ts` as the place
*"the moderation states that must never reach a social surface"* are listed. The two clauses
are about different code, and the row read them as one gate.

The POST-level gate is an allow-list and is fail-closed. The per-`post_media`-row gate,
fourteen lines below it in the same function, was a **deny-list of two legacy values**,
`rejected` and `flagged`. Migration 2250 then reconciled media moderation onto the §36
vocabulary —
`artifacts/api-server/src/migrations/2250_media_asset_canonical_model.sql:26#3. moderation_status reconciled to a canonical superset`
— adding `limited`, `removed` and `owner_deleted`, and the deny-list was never extended. A
restricted item, a **taken-down** item and an **owner-deleted** item all read as
distributable to the gate this document calls fail-closed. The strict list the row cites,
`artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1120#const QUICK_MEDIA_BLOCKED_MODERATION`,
blocks four of them — but it runs on `media_assets`, the dark canonical layer, not on
`post_media`, where the live gate is. The repository held two answers to one question, in
two files, and the census quoted the strict one while the lax one ran.

**MD273 C → W at `3eaf2436f`.** Bound stated honestly: `adminMedia` cannot write any of the
three leaked states today, so this was a gate standing open, not a leak flowing through it.

### 9.4 MD112's evidence was stale, in the direction that undercounts

MD112 (§16.1 DUPLICATE CHECK) read **N** on *"No gem-level duplicate detection exists at
submission **or anywhere else**."* The second half is false. Gem duplicate detection exists
and is real similarity scoring, not a stub:
`artifacts/api-server/src/lib/inputAssistance/duplicateDetection.ts:110#export function scoreGemDuplicate`
and `artifacts/api-server/src/lib/inputAssistance/duplicateDetection.ts:241#export async function findDuplicateGems`,
consumed by
`artifacts/api-server/src/services/hiddenGems/HiddenGemModerationService.ts:288#export async function getDuplicateCandidates`
and served at
`artifacts/api-server/src/routes/hiddenGems.ts:1500#router.get("/admin/hidden-gems/duplicate-candidates"`.

What is missing is only the placement §16.1 asks for: the submission handler
`artifacts/api-server/src/routes/hiddenGems.ts:267#router.post("/hidden-gems"` does not call
it, so the check is an admin queue rather than a stage. **MD112 N → W.**

**Deliberately not built, and why.** The obvious fix — call `findDuplicateGems` at
submission — would produce a `duplicateCandidates` field on the 201 that no client reads,
because the detector's own contract forbids the only action that would matter: it never
blocks creation and never auto-merges, and leaves the decision to the creation flow or the
user. A server field with no decision behind it is a vacuous C, and shipping one to move a
letter is the failure mode this document exists to catch. What MD112 needs is a client
merge-or-create step; that is a client decision, not a server one, and it is named here
rather than faked.

### 9.5 What this pass built

All five changes are on surfaces a user reaches today. None needs a migration; none is
behind a flag.

1. **The report endpoint now separates three intents.** New module
   `artifacts/api-server/src/lib/reportReasons.ts:119#if (VIEWER_PREFERENCE_REASONS.has(r)) return "preference";`
   classifies a reason as preference, abuse, gem-place-mismatch or unknown, and the endpoint
   dispatches on it at
   `artifacts/api-server/src/routes/mediaFeed.ts:1140#const intent = classifyMediaReportReason(reason);`.
   A preference on a post upserts `post_hides`
   (`artifacts/api-server/src/routes/mediaFeed.ts:1193#const hidden = await hidePostForViewer(sc, user.id, id);`)
   and files nothing; a preference on a gem files nothing at all
   (`artifacts/api-server/src/routes/mediaFeed.ts:1160#res.json({ ok: true, alreadyReported: false, hidden: false, store: "none" });`),
   because production has no per-viewer gem hide store — doing nothing beats filing an
   accusation. An unknown reason is refused instead of defaulted, and `reason` is now
   required: `artifacts/api-server/src/routes/mediaFeed.ts:1131#reason: z.string().min(1).max(100),`.
2. **A real report now carries the real contract.** Rate limit, a duplicate check that
   fails closed the way `reportGem`'s does
   (`artifacts/api-server/src/routes/mediaFeed.ts:1213#const { data: existingReport, error: existingErr } = await sc`),
   and a computed severity
   (`artifacts/api-server/src/routes/mediaFeed.ts:1242#severity: reportSeverityFor(reason),`).
   The vocabulary is now one list, imported by both writers of the `reports` table:
   `artifacts/api-server/src/routes/reports.ts:30#import { REPORT_REASON_CODES, reportSeverityFor }`
   and `artifacts/api-server/src/routes/reports.ts:119#const severity = reportSeverityFor(reason_code);`.
3. **The hide now hides.** A viewer-hide gate in the one choke point every media candidate
   crosses — `artifacts/api-server/src/lib/mediaEligibility.ts:355#if (hiddenPostIds.has(c.id)) return false;`
   — so Watch, Grid and, through `projectCandidatesProtected`, all six World-shell builders
   honour it. Fail-soft, like the mute gate beside it and unlike the block gate: losing it
   costs a preference, not a safety decision.
4. **The §36 deny-list is now the union of the two the repository was holding**:
   `artifacts/api-server/src/lib/mediaEligibility.ts:78#export const NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES`.
   It stays a deny-list rather than becoming an allow-list because `post_media` defaults to
   the legacy `'pending'` and an allow-list would hide every new upload — that asymmetry is
   argued in the constant's own header rather than left to look like an oversight.
5. **The §24 penalty stops being a read with no writer.** `loadMediaSignals` now reads the
   `watch_impression` rows `POST /media/:id/view` has always written and nothing has ever
   read, and publishes a hide count **only** where an impression denominator exists —
   without one,
   `artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts:346#const total = totalImpressions ?? 1;`
   would turn a single tap into the maximum penalty.

### 9.6 Mutations, and what each one turned red

Seven. Each was applied, run, reverted, and the file compared byte-for-byte against its
pre-mutation copy with `cmp`. Suite:
`artifacts/api-server/src/test/mediaReportIntent.test.ts:171#describe("classifyMediaReportReason"`,
26 cases, registered in `artifacts/api-server/package.json`.

| Mutation | What it did | What went red |
| --- | --- | --- |
| M1 | restore `.default("spam")` on the reason schema | `refuses a body with no reason` — 1 of 26 |
| M2 | make the classifier never return `preference`, and add the two preference strings to the report vocabulary | 4 red, incl. `hide writes post_hides, not reports` and `a preference on a GEM files nothing and never moves report_count` |
| M3 | delete `severity` from the `reports` insert | `a harassment report is high severity` and `a spam report is normal severity` |
| M4 | delete the viewer-hide gate line from `mediaEligibility` | `a hidden post never reaches the feed` |
| M5 | shrink the deny-list back to `rejected` and `flagged` | 4 red: `owner_deleted`, `removed` and `limited` all became distributable |
| M6 | publish a hide count with no impression denominator | `publishes NO hide count without an impression denominator` |
| M7 | stop counting `watch_impression` rows | `counts distinct hides as notInterestedCount once the item has impressions` |

M2 is the one worth naming: it is not a typo-scale edit but a re-creation of the exact
production behaviour §9.1 reports, and it is the mutation that proves the suite would have
caught the defect had the suite existed.

**What would leave these green and worthless (P24).** M4 and M5 assert on
`filterEligibleMediaCandidates` directly, so both stay green if a FEED stops calling it.
That is not hypothetical for the World shell, whose callers are dark. The partial protection
is `src/test/mediaFeed.test.ts`, which drives the HTTP route. There is still no test that
the shipped route consults the gate *for the hide specifically*; that gap is real and is
stated rather than papered over.

### 9.7 Row moves

Executed at `3eaf2436f`, before this pass's code:

| id | was | now | why |
| --- | --- | --- | --- |
| MD105 | C | W | The reachable "Not interested" and "Hide" rows filed moderation reports on posts and on gems; the cited ranking penalty read three fields no producer wrote; the endpoint accepted any string, defaulted a missing reason to spam, computed no severity, rate-limited nothing and never checked for a duplicate. §9.1. |
| MD273 | C | W | The per-`post_media` gate was the legacy two-value deny-list; `limited`, `removed` and `owner_deleted` — three of the six states 2250 made admissible — passed it. The strict list the row cited runs on a different table. §9.3. |
| MD269 | C | W | §36 Safety moderation has no classifier, no hold and no queue: the postcard transport promotes to approved unconditionally, and one of the four things cited as evidence has no reader or writer in the tree. §9.2. |
| MD283 | C | W | §37 video moderation is the same pipeline, and the pipeline decides nothing. Video is additionally never decoded, so no classifier could run on it even if one existed. §9.2. |
| MD351 | C | W | There is no MediaModerationService. What exists is an admin route, an audit writer, an inert table and the distribution gate — the last of which §9.3 shows was itself half open. §9.2. |
| MD112 | N | W | Stale evidence, in the undercounting direction: gem duplicate detection exists and scores real similarity; it runs in the admin queue rather than at submission, which is W, not N. §9.4. |

After this pass's code, on the branch:

| id | was | now | why |
| --- | --- | --- | --- |
| MD105 | W | C | Preference and abuse are separated and dispatched (§9.5.1); the report half carries the vocabulary, the rate limit, the duplicate check and the severity (§9.5.2); the preference half is stored in `post_hides`, honoured by every media surface (§9.5.3) and reaches the ranker with a denominator (§9.5.5). Seven mutations red. **The C is earned by the fix, not by the original evidence** — the row was silently wrong for as long as it read C. |
| MD273 | W | C | The deny-list is now the union of the two the repository held, and the four leaked states are asserted red by mutation M5. |

MD269, MD283, MD351 and MD112 are **not** repaired and stay where the first table puts
them. A safety classifier, a video decode tier, a moderation service and a client
merge-or-create flow are none of them branch-scale work, and none of them is faked here.

### 9.8 Restated headline

> | Measure | Was, §0 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 291 | **288** |
> | BUILT-BUT-WRONG | 69 | **73** |
> | NOT-BUILT | 88 | **87** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 80.0 % | **361 / 450 = 80.2 %** |
> | **CORRECT%** (raw) = C/450 | 64.7 % | **288 / 450 = 64.0 %** |
>
> **Correctness went DOWN and construction went up by one row.** That is the whole shape of
> this pass: four rows moved backward on executed evidence, two moved forward on code that
> exists and is mutation-tested, and one moved up out of NOT-BUILT because its evidence was
> stale rather than because anything was built for it.

The **spec-attributable** figure (§0: 216 / 450) is **not restated**. Attribution was not
re-run, and adjusting it by subtracting the demoted rows would be arithmetic dressed as
measurement. Read §0's attribution number as measured at `68ed59d9` and untouched here.

### 9.9 CEILING — what this pass could not reach, and why

- **The dark shell is still the ceiling on everything §4.1, §15, §32, §44 and §45.**
  `MEDIA_WORLD_SHELL_ENABLED` is seeded false and `MEDIA_ANALYTICS_ENABLED` is seeded false
  (`artifacts/api-server/src/migrations/2038_media_admin_flags.sql:65#('MEDIA_ANALYTICS_ENABLED', false,`).
  Every §44 telemetry row and every §45 north-star emitter is therefore correct over a path
  nothing reaches — **⌀** by the owner's rule, **C** by this document's own convention (§1,
  *"Flag-dark is a deployment fact, not a verdict"*). Those two rules disagree, and §9.10
  puts the disagreement to the owner rather than silently re-basing a hundred rows.
- **`media_assets` is still on no read path**, so MD36–MD38, MD272 and MD338–MD339 remain
  what §6 already says they are.
- **MD8 (authentic outranks generated) cannot be built without the canonical flip.** The
  ranker has no provenance input because `post_media` has no `source_type` column;
  `media_assets` has one and is dark. Building a penalty term over a field that is always
  null would be a vacuous C, which is why it was not built.
- **Deployment.** Everything in §9.5 is on a branch. Built on a branch is not merged; merged
  is not deployed. Nothing here has run against production data, and no database was queried
  in this pass either.
- **The other 444 rows were not re-read.** Six were, and four of them were wrong. On a
  document with 288 C rows and no prior adversarial re-read, that is not a reassuring
  sample — it is a reason to expect more.

### 9.10 Two decisions surfaced rather than taken

1. **The flag-dark convention contradicts the owner's honesty rule.** §1 of this document
   grades a complete implementation behind a flag seeded OFF as BUILT-AND-CORRECT, following
   the Wall census. The owner's standing rule is that a row is correct only when true on
   every deployment, and that a C over a path nothing reaches is vacuous. Applying the
   owner's rule here would move a large fraction of the 288 — the whole §44 and §45
   telemetry block, the §15 action rail, the §32 Compass affordances and the §4.1 shell —
   from C to W in one edit, and would make this census incomparable with the twelve siblings
   that follow the other convention. **Not taken.** It is a corpus-wide convention change,
   and one lane should not make it inside one document.
2. **`census-media.md` counts `routes/mediaFeed.ts`, which `census-wall.md` also counts.**
   This pass changed it, so both censuses are acknowledged in
   `CENSUS_STALENESS_ACKNOWLEDGED.json` with a per-file argument. One Wall citation — W7's
   `post_saves` anchor — moved by 110 lines and was repointed, not deleted. The
   anchored-citation check is what found it, which is the check working.

---

## 10. CORRECTION to §9.1 — the hide was already built, and Media was bypassing it

**§9.1 states something false, and this section is the correction rather than a
deletion.** The sentence was:

> **Nothing was hidden.** `post_hides` … was written by **nothing anywhere in the tree**.
> Pulse honoured a list no surface could add to.

Both halves are wrong. At `3eaf2436f`, `post_hides` had **one writer and three readers**:

| | Where |
| --- | --- |
| WRITER | `POST /api/posts/:postId/hide` — `artifacts/api-server/src/routes/posts.ts:2619#router.post("/posts/:postId/hide"`, an idempotent upsert on the same conflict target §9 later duplicated |
| READER | the following feed — `artifacts/api-server/src/routes/posts.ts:1238#.from("post_hides")` |
| READER | the global feed — `artifacts/api-server/src/routes/posts.ts:1380#.from("post_hides")` |
| READER | Pulse — `artifacts/api-server/src/routes/pulse.ts:157#const { data: hiddenRows } = await sc` |
| CLIENT | `travel-buddy-standalone/src/services/posts.ts:652#export async function hidePost` , called from `travel-buddy-standalone/src/components/PulseFeedCard.tsx:141#const ok = await hidePost(item.id);` |
| TEST | `artifacts/api-server/src/test/postHide.test.ts:5#- Authenticated user can hide a post (upserts into post_hides, returns { hidden: true })` |

### 10.1 How the error was made, because the method is the point

The absence was established with
`grep -rn "post_hides" src migrations | grep -v "\.test\." | head -20`. The writer sorted
past the cut. **An absence asserted from a truncated list is not a measurement**, and §7's
first method caveat already says this document settles every "nothing writes X" by opening
call sites rather than by counting greps — a rule I stated and then broke in the same
document. The two "nothing writes X" claims §7 names (`media_assets`,
`media_intent_signals`) were settled properly; this third one was not, and it is the one I
added.

It is the same defect class §9 exists to catch, arriving by the same route: a confident
sentence, an anchored citation, and a check underneath it that was never run.

### 10.2 The corrected finding is worse, not weaker

Portava has a **complete, reachable, tested hide feature**: a route, three feed readers, a
client service and a UI entry point on the Pulse card. Tapping "Hide" on a Pulse card
worked. Tapping "Hide" on the **Media** tab — the same gesture, two rows above "Report" in
the same options sheet — posted to `/api/media/:id/report` and filed a moderation report
instead.

So Media did not lack a hide. Media built a **divergent duplicate of a working feature and
pointed it at the moderation queue**. "The feature was never built" would be a gap; this is
a bypass, and a bypass is worse, because the working path's existence is what makes the
wrong one look finished.

### 10.3 Does MD105's verdict move? No — re-derived.

The W at `3eaf2436f` rested on four things. The false one was **decoration on the first,
not load-bearing**, and each of the surviving three is independently sufficient:

| Leg | Status |
| --- | --- |
| Preference taps filed moderation reports on both the post and the gem surface | Holds, and §10.2 strengthens it |
| The report half diverged from the contract: `.default("spam")`, no severity, no rate limit, no duplicate check | Holds — re-verified at `routes/mediaFeed.ts` on the base |
| The "Not Relevant" ranking penalty read three fields no producer in `src` set | Holds — `hideRate` and `notInterestedCount` are consumed and set by nothing; `adminCompass`'s `hideRatePct` is a different field off `hide_category` |
| *"`post_hides` had no writer"* | **FALSE — withdrawn** |

The C after the repair never depended on the withdrawn leg either. What it needs is that
the media path now writes the store and that the media surfaces honour it: the report route
writes through `artifacts/api-server/src/lib/postHide.ts:49#export async function hidePostForViewer`,
the gate at `artifacts/api-server/src/lib/mediaEligibility.ts:355#if (hiddenPostIds.has(c.id)) return false;`
reads it, and the ranker counts it. Mutations M2, M4 and M8 hold all three red.

**No verdict moves.** MD105 stays **C**, re-derived on the corrected premises; MD273,
MD269, MD283, MD351 and MD112 are untouched by this correction — none of them cited
`post_hides`.

| id | was | now | why |
| --- | --- | --- | --- |
| MD105 | C | C | Unchanged. §9.7's W→C is re-derived in §10.3 with the false premise removed; the three surviving legs each carry it on their own. |

### 10.4 Two writers by choice, or one writer by design

§9 wrote a second three-line upsert into `post_hides` rather than reaching the existing
hide path — which, at the time, it did not know existed. Left alone that would be two
copies of an idempotency contract, and the conflict target **is** the contract: get
`onConflict`/`ignoreDuplicates` wrong on one caller and a second tap becomes a 500 on a
gesture whose entire point is that repeating it is harmless. That is the same drift that
had already put two different moderation deny-lists in two files (§9.3).

So this section extracts `artifacts/api-server/src/lib/postHide.ts:58#{ onConflict: "user_id,post_id", ignoreDuplicates: true },`
and routes **both** callers through it —
`artifacts/api-server/src/routes/posts.ts:2637#const hidden = await hidePostForViewer(sc, user.id, postId);`
and `artifacts/api-server/src/routes/mediaFeed.ts:1193#const hidden = await hidePostForViewer(sc, user.id, id);`.
**Two routes reach the hide, by choice; one writer, in one file.** A new case,
`the media hide "writes through the SAME idempotency contract as POST /posts/:postId/hide"`,
asserts the conflict target rather than only the row.

### 10.5 Mutation M8

| Mutation | What it did | What went red |
| --- | --- | --- |
| M8 | change the shared writer's conflict target to `post_id` and `ignoreDuplicates: false` | `writes through the SAME idempotency contract as POST /posts/:postId/hide` — 1 of 27; `postHide.test.ts` stayed green, which is the point: its own fake never inspected the options, so the contract was unasserted on BOTH callers until now |

Applied, run, reverted, `cmp` byte-identical. 27 cases in `mediaReportIntent`, 4 in
`postHide`, all green after revert.

### 10.6 Restated headline — unchanged by this correction

> | Measure | Value |
> | --- | --- |
> | Denominator (testable requirements) | **450** |
> | BUILT-AND-CORRECT | **288** |
> | BUILT-BUT-WRONG | **73** |
> | NOT-BUILT | **87** |
> | CANNOT-VERIFY | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | **361 / 450 = 80.2 %** |
> | **CORRECT%** (raw) = C/450 | **288 / 450 = 64.0 %** |
>
> Identical to §9.8. A correction that withdraws a premise without moving a verdict must
> not move the number either, and saying so is part of the correction.

### 10.7 What §9 got right, kept verbatim because it still applies

§9's closing observation stands and this section is its best illustration: **six rows of a
288-row C column were re-read and four were wrong.** The honest reading was never "four
rows were wrong" — it was "nobody has checked the other 282, and the sample says that
matters." §10 adds the second half: the re-reader is in the sample too. One of the three
supporting claims under the pass's own headline finding was false, it was anchored,
authoritative and wrong for one commit, and it was caught by a reviewer rather than by any
check in this repository. Nothing here can check whether a stated absence was actually
searched for.

**Citations repointed, not deleted.** §9's anchors into `routes/mediaFeed.ts` moved when
§10 changed that file, and §9.5.1's citation of the inline upsert names code §10 replaced.
Both were repointed at the lines the code now occupies, and `census-wall.md` W7's
`post_saves` anchor moved a second time and was repointed again. `check:doc-citations`
found every one of them, which is the third time in two sections that an anchored citation
has earned its keep.

---

## 11. The C column audited — 208 rows machine-resolved, 120 executed, seven wrong

| Field | Value |
| --- | --- |
| **Measured at** | `f8384ea5b` — the tip of `claude/sweet-fermat-fmx7up` when this pass started. The document's `head_commit` row (§0) is **not** moved: this section re-reads a SAMPLE, not 450 rows. The counted files this pass changed are named, with an argument each, in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`. |
| **What §10.7 asked for** | *"six rows of a 288-row C column were re-read and four were wrong … nobody has checked the other 282, and the sample says that matters."* This section checks 120 of them and reports the rate it actually measured, which is far lower than 67 % and still high enough to matter. |
| **Prior sections** | Unchanged and not restated. §1–§10 stand as written. Last statement wins for the ids in §11.9. |

### 11.1 Method, and the two sample sizes — stated separately because only one is a measurement

1. **MACHINE-RESOLVED — 208 of the 288 C rows.** Every C row carrying a
   `file:line` citation had every citation resolved against the tree and the
   cited line printed and read; 208 rows carry at least one, the other 80 cite a
   bare filename or nothing. **Zero citations were out of range.** That result is
   worth exactly what `check:doc-citations` says it is worth — these are all
   UNANCHORED, *"a bare path:line; nothing here can tell you it is wrong"* — and
   at least 20 of the 208 point at a line holding something other than the object
   the row names (§11.8). A range check is not a correctness check, which is the
   whole reason for pass 2.
2. **EXECUTED — 120 of the 288.** The claim itself run down: the call site
   opened, the writer or reader followed to its end, the absence settled by
   enumerating **every** reference rather than by a grep that stops.

**The rate, both ways, because one of them flatters.** Of the 120, **23 are §40
module rows whose requirement IS existence** (MD303–MD312, MD315, MD317–MD319,
MD326–MD328, MD330, MD333–MD337 — each verified present *and* referenced by a
real importer, so none is an orphan file scoring a letter). Those are easy by
construction. The other **97 carry a behavioural claim**, and **seven of the 97
were wrong**:

> **Seven of the 97 executed behavioural C rows were wrong — a 7.2 % error
> rate.** Taken over all 120 executed rows it is 5.8 %.

**What that says about §9's 67 %.** §9 re-read six rows and four were wrong, and
its closing sentence treated that as a reason to expect more. It was — but the
six were chosen adversarially (the whole §36 moderation block and the two report
rows), and 4/6 is not the rate. 7.2 % is. That is the better number and it is
not a reassuring one: applied to the 288 C rows, it projects **roughly twenty
more wrong rows that nobody has found**, and this pass leaves 168 C rows
unexecuted.

**Coverage — every section, named so the sample cannot be read as the easy
ones.** The 120 touch all 38 §5 sections that have a C row:

`§2 MD4·5·7·9·10 · §3 MD12·13·16·17 · §4 MD18·19·20·22·23·24 ·
§5 MD30·31·32·34 · §6 MD39·40·42 · §7 MD45·46·47·49·50·52·54 · §8 MD55·56 ·
§9 MD59·61·62·67·68 · §10 MD69·72·74 · §11 MD80 · §12–§14 MD81·86·88 ·
§15 MD95·96·102·106 · §16 MD108·110·114·116·117·121·122·123·126·127·130·139 ·
§17–§22 MD140·141·142·143·145·148·154·155·156·157·159·161·163 ·
§23 MD164·166·167·168·170·176 · §24 MD178·183·185·190·191·192·193·199 ·
§25 MD202·204·205·206·208 · §26 MD209·210·211·212 ·
§27–§30 MD217·218·220·227·229 · §31 MD230–MD241 ·
§32 MD242·243·244·245·247·250·251·254 · §33 MD256·257·258 ·
§34 MD260·261·262·263 · §35 MD264·265 · §36 MD266·267·272·273 ·
§37 MD278·279·285 · §39 MD302 · §40 the 23 above · §41 MD340·344·352 ·
§42 MD353·354·355 ·
§43 MD357·358·359·361·362·363·364·365·366·368·371·372·373 ·
§44 MD375·377·379·384·386·387·388·389·390·391·392·393 ·
§45 MD394·395·397·398·401 · §46 MD404·406·407·413 · §46.1 MD414·417·418 ·
§46.2 MD420·423·426 · §48 MD430·431·432·434·437·438 · §49 MD442·450`

**The rule that found all seven.** §10.1 says an absence asserted from a
truncated list is not a measurement. Every "nothing writes X" / "nothing reads
X" settled below was settled by enumerating **every** reference to the
identifier across both trees and opening each one. No `head -N` was applied to
any search whose result is asserted here as an absence. Five of the seven were
found the other way round — a row claiming something IS produced, where nothing
produced it.

### 11.2 The 73 W rows, grouped by WHY — sizes, and the full partition

Grouped before anything was built, because the group a row is in decides whether
building it is honest or vacuous. Every one of the 73 appears in exactly one
group; the ids are listed so the partition can be checked rather than trusted.

| Group | Size | What it means |
| --- | --- | --- |
| **(a) Logic wrong in code this branch can fix** | **11** | No migration, no flag, no dark store, no new product decision. |
| **(b) Logic right, nothing reaches it** | **15** | The compliant artifact exists and is correct; the surface a user reaches is the non-compliant twin. |
| **(c) Capped by a flag seeded FALSE or an unapplied migration** | **19** | The code is not the binding constraint. |
| **(d) Needs something nobody has written** | **28** | A classifier, a video decoder, a screen, a client flow. |

- **(a) — 11.** MD15, MD33, MD94, MD104, MD147, MD213, MD216, MD370, MD378, MD383, MD428.
- **(b) — 15.** MD1, MD2, MD3, MD11, MD29, MD87, MD215, MD286, MD402, MD408, MD412, MD419, MD424, MD425, MD427.
- **(c) — 19.** MD36, MD37, MD38, MD41, MD43, MD44, MD53, MD57, MD60, MD65, MD66, MD188, MD255, MD274, MD338, MD339, MD343, MD429, MD445.
- **(d) — 28.** MD35, MD58, MD71, MD73, MD79, MD101, MD103, MD107, MD112, MD149, MD169, MD187, MD194, MD222, MD269, MD275, MD276, MD283, MD300, MD320, MD321, MD348, MD351, MD405, MD435, MD444, MD446, MD449.

**The uncomfortable result of grouping first: group (a) is 11 rows and this pass
moved none of them.** Each is a small server change whose product would be read
by nothing — and §9.4 already refused exactly that shape and named it: *"A
server field with no decision behind it is a vacuous C, and shipping one to move
a letter is the failure mode this document exists to catch."* The eleven are
re-argued one at a time in §11.6 rather than converted into eleven letters.

### 11.3 Seven C rows executed, and what each of them actually did

#### 11.3.1 MD47 — the §7 Neighborhood edge was drawn in the type and severed in the data

MD47 read **C** on *"`mediaProjection.ts` lines 89-91 carry `neighborhood`/`city`/`country`
as coarse labels."* Those lines are a **type declaration** —
`artifacts/api-server/src/lib/media/mediaProjection.ts:113#neighborhood: string | null;`
today. Executed, the field was `null` on every projection the World shell has
ever served, on every route, for every viewer:

- the raw projector hard-codes it —
  `artifacts/api-server/src/lib/media/mediaProjection.ts:347#neighborhood: null,`
  — which is correct on its own terms, because `posts` has no neighborhood
  column: `MEDIA_PROJECTION_POST_COLUMNS` selects `location_name`,
  `location_city`, `location_country` and `canonical_place_id`, and no fourth
  label;
- the disclosure applier copies it off the resolved disclosure —
  `artifacts/api-server/src/lib/media/mediaProjection.ts:394#neighborhood: d.neighborhood,`;
- and the disclosure's input never carried one. `disclosureForRow` built
  `{ name, city, country, lat, lng }`, so
  `artifacts/api-server/src/lib/mediaLocationVisibility.ts:225#const neighborhood = input.neighborhood ?? null;`
  resolved to `null` every time.

The **tier machinery was complete and correct the whole time**:
`artifacts/api-server/src/lib/mediaLocationVisibility.ts:281#case "neighborhood": {`
discloses the label at the neighborhood and place tiers and nulls it at
city / country / hidden. Only the producer was missing. Two consumers read the
field as a label fallback and have therefore always fallen through to `city`.

**MD47 C → W at `f8384ea5b`**, repaired in §11.4.1.

#### 11.3.2 MD227 — the Tagged bucket was a literal, under a comment that was false

MD227 read **C** for §30's seven My World filters. Six read real rows. The
seventh was
`{ key: "tagged", label: "Tagged", ownerOnly: false, count: 0, media: [] }`,
under the comment *"Tagged has no backing people-tag table yet (pre-launch)"*.

Executed: `public.tags` is created by
`artifacts/api-server/src/migrations/0044_tags_hashtags.sql:15#CREATE TABLE IF NOT EXISTS tags (`,
is in the committed production baseline (`baseline/20260907_production_tables.txt`),
and is **written on the post-create path** —
`artifacts/api-server/src/routes/posts.ts:874#sourceType: 'post',` hands the new
post's id to `processTagging`, which upserts at
`artifacts/api-server/src/services/tagging/TaggingService.ts:392#.from('tags')`
after the tag-permission, block and rate checks. The bucket reported zero over a
populated table, and the comment that explained the zero is the same defect
class §10.1 records against itself: an absence asserted without opening the
writer. Six of seven, which this census grades **W** (MD35: *"Two of three."*).

**MD227 C → W**, repaired in §11.4.2.

#### 11.3.3 MD386, MD387, MD389, MD393 and MD209 — five §44/§26 signals with no producer anywhere

MD386 (Stamp), MD387 (Comment), MD389 (Save) and MD393 (Profile open) each read
**C** citing the batch allow-list —
`artifacts/api-server/src/routes/mediaAnalyticsBatch.ts:38#const VALID_EVENT_TYPES = new Set<string>([`,
whose next three lines name `like`, `comment`, `save`, `profile_open` and
`place_open` among twenty-two accepted event types.
An allow-list entry is a thing the server will ACCEPT. It is not a producer, and
this census already knows the difference: MD213 and MD378 are **W** on the words
*"`directions_tap` is in the batch allow-list … the outcome name exists with no
emitter"*, and MD383 is **W** for the same reason. The four rows above were
graded C on evidence identical in kind.

Settled by enumeration, not by grep-and-stop:

- `media_events` has exactly one writer in the tree —
  `artifacts/api-server/src/lib/mediaAnalytics.ts:189#const { error } = await sc.from("media_events").insert({`
  — and `recordMediaEvent` had five call sites: two `impression`, one branching
  over `rewatch`/`completion`/`qualified_view`/`impression`, one `share`, and
  the batch endpoint.
- On the client, **one** file posts to that endpoint —
  `travel-buddy-standalone/src/hooks/useMediaAnalytics.ts:125#await fetch(` —
  **one** component consumes the hook —
  `travel-buddy-standalone/src/features/media/components/MediaActionRail.tsx:94#const { record } = useMediaAnalytics();`
  — and its recorder is called from exactly **one** place,
  `travel-buddy-standalone/src/features/media/telemetry/mediaTelemetry.ts:235#record(event, payload);`,
  inside `emitMediaNorthStar`, which can only ever emit one of the eight §45
  `media_*` names.

So `like`, `comment`, `save`, `profile_open`, `place_open`, `mode_switch`,
`add_to_trip`, `directions_tap` and the rest of the §44 vocabulary had **no
producer on either side of the wire**. The §44 Stamp / Comment / Save /
Profile-open funnels read zero by construction — the same shape §9.1 found for
`hideRate` and `notInterestedCount` — and the reason the like handler
(`artifacts/api-server/src/routes/mediaFeed.ts:2212#router.post("/media/:id/like", asyncHandler(async (req, res) => {`)
and the save handler recorded nothing is simply that nobody ever added the line.

**MD386, MD387, MD389, MD393 C → W.** MD209 (§26 *"People saved this place"*)
goes with them: it rests on `save` **and** `place_open`, and neither had a
producer. **MD209 C → W.** MD386 and MD389 are repaired in §11.4.3; the other
three are argued in §11.6.

MD375 (§44 Place explored) and MD379 (§44 Added to Trip) were checked in the
same sweep and **stay C**: each also cites a §45 north-star name, and those
eight DO have an emitter — the action rail. That emitter is dark behind
`MEDIA_WORLD_SHELL_ENABLED`, which is the open decision §9.10 put to the owner
and which this section does not pre-empt.

### 11.4 What this pass built

Three changes, all server-side, none behind a new flag, none needing a migration.

1. **The §7 neighborhood label has a producer.**
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:338#export async function loadPlaceNeighborhoods(`
   batches one `places` read over the page's distinct `canonical_place_id`s —
   the same column `buildPlaceProjection` already reads for a place header, so
   Media does not open a second neighborhood source (§48: Places owns place
   identity) — and
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:448#const [ctx, neighborhoods] = await Promise.all([`
   runs it alongside the gem context. The label is handed to the choke point as
   an **input**, never written onto the projection, so `coarsenMediaLocation`
   still decides: a gem-ceilinged or privacy-coarsened item names no
   neighborhood. The gem lookup beside it stays fail-CLOSED while this one is
   fail-SOFT, and the asymmetry is argued in the function's own header rather
   than left to look like an oversight — losing the gem context would WIDEN
   disclosure, losing this one only removes a label.
2. **The §30 Tagged bucket reads the table that was there all along.**
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:1106#export async function loadTaggedPostIds(`
   reads `tags` for `status='approved'`, `source_type='post'`, and
   `artifacts/api-server/src/services/media/MediaProjectionService.ts:1153#export async function loadTaggedMedia(`
   puts those ids through `loadEligibleCandidates` and
   `projectCandidatesProtected` — **being tagged is not consent to see the
   post**, so the blocks / mutes / suspension / visibility / moderation gate,
   the private-account guard and the location choke point all still run. Bound
   stated rather than hidden: `feedType: "for_you"` means a tagged `trip_only`
   or `private` post is withheld rather than guessed at, because admitting it
   would need a membership proof this bucket does not hold.
3. **§44 Stamp and Save emit.**
   `artifacts/api-server/src/routes/mediaFeed.ts:2240#recordMediaEvent("like", {`
   and `artifacts/api-server/src/routes/mediaFeed.ts:2346#recordMediaEvent("save", {`
   — server-side, beside the `share` event that already did this, because the
   server is the only witness to whether the write succeeded. Save emits only
   AFTER the upsert, so the number counts saves that happened rather than taps
   that were attempted. Both sit inside `recordMediaEvent`'s existing
   `MEDIA_ANALYTICS_ENABLED` gate; this pass flips no flag.

### 11.5 Mutations, and what each one turned red

Seven. Each applied, run, reverted, and the file compared byte-for-byte against
its pre-mutation copy with `cmp`. Suite:
`artifacts/api-server/src/test/mediaProjectionGaps.test.ts:242#describe("MD47 — the neighborhood label has a producer", () => {`,
14 cases in three groups, registered in `artifacts/api-server/package.json`.

| Mutation | What it did | What went red |
| --- | --- | --- |
| M9 | drop the `neighborhood` argument from `disclosureForRow`'s call | `a served projection CARRIES the neighborhood at place tier` — 1 of 14 |
| M10 | make `loadPlaceNeighborhoods` return an empty map | 2 red: the loader's own case and the served projection |
| M11 | disclose the neighborhood at the `city` tier too — bypass the choke point | `WITHHOLDS the neighborhood when a Hidden Gem ceiling coarsens the item to city` |
| M12 | restore the hard-coded `count: 0, media: []` on the Tagged bucket | `the Tagged bucket carries the tagged media, not a hard-coded zero` |
| M13 | let `loadTaggedPostIds` admit `status='pending'` tags | `ignores a PENDING tag — a tag awaiting approval is not yet the viewer's` |
| M14 | delete the `like` `recordMediaEvent` call | `POST /media/:id/like records a like media event` |
| M15 | delete the `save` `recordMediaEvent` call | `POST /media/:id/save records a save media event` |

M11 is the one worth naming. M9, M10 and M12–M15 all ask "did the producer come
back", which is the regression that matters here because a missing producer
leaves every existing assertion green — that is exactly how all three defects
survived. M11 asks the other question: it proves the neighborhood travels
THROUGH the privacy choke point rather than around it, so a future "fix" that
wrote the label straight onto the projection goes red instead of quietly naming
a protected gem's neighborhood.

**What would leave these green and worthless.** The §44 cases assert on the two
HTTP handlers, so they stay green if a CLIENT stops calling those endpoints —
and they say nothing at all about `comment`, `place_open` or `profile_open`,
which remain unproduced. The §7 and §30 cases drive `buildPlaceProjection` and
`buildMyWorldProjection` directly, so they would not notice a ROUTE that stopped
calling those builders. That is the same P24 gap §9.6 records, still open.

### 11.6 What was NOT built, and the argument for each

**The eleven group-(a) rows**, each a small server change whose product nothing
would read:

- **MD94 / MD213 / MD378 (directions).** `directions_tap` has no emitter because
  there is no directions affordance to tap (MD94). Adding the action id first
  puts a fourteenth entry in the resolver that no rail renders.
- **MD370 / MD383 (contribution).** `media_contribution` is declared *"reserved"*
  and `hidden_gem_contributions` is **absent from production**
  (`scripts/checkProductionDrift.ts`). A contribution endpoint writing to a table
  that is not there is worse than no endpoint.
- **MD104 (Share through Telegraph).** The share handler accepts
  `target: "telegraph"` and returns a URL. Telegraph's own §5 contract
  (`services/telegraph/shareables.ts`) shares by placing an object body into a
  **conversation**, and the media share endpoint holds no conversation id. The
  honest fix is a client composer hand-off; a server field naming a Telegraph
  object that no composer consumes is §9.4's vacuous C again.
- **MD147 (Independent Sources).** `lib/intelIndependence.clusterByIndependence`
  exists and is real. Its detectors merge units on shared evidence media, common
  source and synchronised timing — **none of which a media projection carries**:
  no group key, no asset hash, no source ref. Called with what Media has, every
  perspective becomes its own singleton and `independentSourceCount` equals
  `contributorCount`, which is the precise thing MD147 says is wrong. Building
  the call without the signals would turn a true W into a false C.
- **MD216 (People lens).** §27 names four populations and the builder handles
  two. Adding trip crew makes it three of four, which this census still grades
  W. A build that neither moves the letter nor completes the requirement is
  gold-plating.
- **MD15 / MD33 / MD428 (client-shaped).** The Gems lens ignoring its own mode
  bar, `GET /media/gems` being unserved while the lens renders the pre-existing
  `GemsFeed`, and `WhyThisSheet` explaining the ranker's reasons instead of
  §47's five are all decided in the client. Two of §47's five reasons — fresh
  perspectives in the last 10 minutes, area activity increasing — are not
  ranking inputs at all, so the server has nothing to send.
- **MD43** is in group (c) rather than (a) for a reason worth stating, because
  it looks branch-fixable and is not: `media_attachments.visibility_override`
  has one writer, on the flag-gated canonical path, and **production does not
  have the column** — migration 2250 is unapplied there. A reader for it would
  be a read of a column that does not exist.

**MD387 (Comment), MD393 (Profile open), and MD209's `place_open` half.** Media
has no comment-CREATE endpoint —
`artifacts/api-server/src/routes/mediaFeed.ts:2448#router.get("/media/:id/comments", asyncHandler(async (req, res) => {`
is a read, and comments are created on the posts spine. Emitting a *media*
`comment` signal from the generic post-comment handler would attribute every
Wall and Pulse comment to Media, which is worse than a zero. `profile_open` and
`place_open` are client navigations with no server touchpoint at all. All three
stay **W**.

### 11.7 CORRECTION to §3 — `media_canonical_enabled` is not off in production

§3's gate table records `media_canonical_enabled` as `false`, sourced to
*"`0191_media_assets.sql`, postcondition in `2250`"*, and eight W rows repeat the
phrase "the flag is off". **The seed is false; the database is not.**
`artifacts/api-server/src/lib/mediaAssets.ts:15#travel-buddy  ajrurzioarfkagpuxfnb  (production)  media_canonical_enabled = TRUE`
records a 2026-09-07 measurement, and the same header says in its own words that
*"every comment in this tree that calls the canonical layer 'dark' is reading
the migration, not the database."* This census read the migration.

**No verdict moves, and the corrected reason is worse than the stated one.** The
canonical writer is dead in production not because the flag is off but because
migration **2250 is unapplied there**: the payload names `captured_at`,
`provenance` and `intelligence_eligibility`, that database has none of them, and
since 2026-09-07 a schema-capability guard refuses the write outright rather
than attempting one PostgREST rejects. MD36, MD37, MD38, MD57, MD60, MD338,
MD339, MD343 and MD429 are therefore group **(c)** as §11.2 places them, but for
the migration half of that group and not the flag half. The practical difference
is real: a flag is one row to flip, and an unapplied migration in a production
database is not.

`routes/sharedMoments.ts` gates a contribution on the caller owning a
`media_assets` row, so with the writer dead that request path cannot succeed for
any media uploaded since 2026-08-16 — a consequence §3 could not see while it
believed the layer was merely dark.

### 11.8 The citation decay §5 is carrying, named rather than repointed

At least 20 of the 208 machine-resolved rows cite a line holding something other
than the object the row names. The concentration is `routes/mediaFeed.ts`, which
§9 and §10 grew by about 113 lines: MD55, MD105, MD118, MD203, MD363, MD371,
MD386 and MD388 all cite pre-§9 numbers. Others drifted on their own — MD272
cites `lib/mediaAssets.ts` line 129 for `computeIntelligenceEligibility`, which is at
`artifacts/api-server/src/lib/mediaAssets.ts:366#const intelligenceEligibility = computeIntelligenceEligibility({`;
MD110 and MD114 cite `HiddenGemService.ts` line 150 for a media-attachment write that
is at
`artifacts/api-server/src/services/hiddenGems/HiddenGemService.ts:188#unaffected). Records media_assets + media_attachments(entityType=hidden_gem)`;
MD45 cites `mediaProjection.ts` line 176 for `projectContributor`, now at
`artifacts/api-server/src/lib/media/mediaProjection.ts:294#function projectContributor(row: MediaCandidateRow): MediaContributor`.

Two are worth naming past the line number, because the wrong line carries a
wrong sentence:

- **MD106.** The row says the intent signal is *"written only through the
  service-role endpoint at `routes/mediaActions.ts` line 161, read at
  `MediaActionResolver.ts` line 612."* The two are **the wrong way round**:
  `artifacts/api-server/src/routes/mediaActions.ts:161#.from("media_intent_signals")`
  is the DELETE, and
  `artifacts/api-server/src/services/media/MediaActionResolver.ts:612#.from("media_intent_signals")`
  is the upsert — the writer. Enumerated exhaustively, `media_intent_signals`
  has **no reader anywhere in either tree**, so the asserted read does not exist.
  MD106 **stays C**, re-derived: its requirement is that a want is an intent
  signal and not a Like, which the separate table, the separate grant posture
  and the separate write path all carry on their own. The missing consumer is a
  real gap and it is not the thing MD106 asserts.
- **MD199.** Cites `services/ranking/CreatorCapEnforcer.ts` for the media
  repetition cap. That module is used by Wall, Compass, Pulse and Discovery and
  **not by Media**, which has its own
  `artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts:488#export function enforceMediaCreatorCaps<T extends MediaFeedItem>(`.
  MD199 **stays C** — `seenPenalty`, the fatigue layer and
  `enforceMediaCreatorCaps` satisfy "− Repetition" — on a correctly named module.

**Not repointed here, deliberately.** UNANCHORED sits at its ceiling of 6490 with
zero headroom, and rewriting forty §5 citations inside a pass whose job was to
measure verdicts would fuse two edits that should stay separable. Every citation
this section ADDS carries an anchor. The list above is the finding; a
citation-repointing pass is a different pass, and the ids are named so that pass
does not have to begin by re-deriving them.

### 11.9 Row moves

Executed at `f8384ea5b`, before this pass's code:

| id | was | now | why |
| --- | --- | --- | --- |
| MD47 | C | W | §7 "→ Neighborhood": the field was `null` on every projection ever served. The raw projector hard-codes it and the disclosure input never carried one, so the tier logic — complete and correct — had nothing to disclose. The cited evidence was a type declaration. §11.3.1. |
| MD209 | C | W | §26 "People saved this place" rests on the `save` and `place_open` events; neither had a producer anywhere in either tree. §11.3.3. |
| MD227 | C | W | §30's Tagged filter was `count: 0, media: []` under a comment claiming no backing table, while `public.tags` is in production and written on the post-create path. Six of seven. §11.3.2. |
| MD386 | C | W | §44 Stamp: `like` is an allow-list entry with no emitter — the same evidence that makes MD213 and MD383 W. §11.3.3. |
| MD387 | C | W | §44 Comment: the same, and Media has no comment-create endpoint to emit from. §11.3.3. |
| MD389 | C | W | §44 Save: the same. §11.3.3. |
| MD393 | C | W | §44 Profile open: the same; a client navigation with no server touchpoint. §11.3.3. |

After this pass's code, on the branch:

| id | was | now | why |
| --- | --- | --- | --- |
| MD47 | W | C | `loadPlaceNeighborhoods` produces the label, `disclosureForRow` hands it to the choke point, and the choke point still decides — asserted in both directions by M9/M10 (it arrives) and M11 (it is withheld under a gem ceiling). |
| MD227 | W | C | The Tagged bucket reads `tags` and re-gates every id through the eligibility gate and the location choke point. M12 and M13 red. |
| MD386 | W | C | `POST /media/:id/like` records a `like` media event. M14 red. |
| MD389 | W | C | `POST /media/:id/save` records a `save` media event, after the upsert succeeds. M15 red. |

MD209, MD387 and MD393 are **not** repaired and stay where the first table puts
them, for the reasons in §11.6. MD106 and MD199 had their EVIDENCE corrected and
their verdicts re-derived (§11.8); neither moves.

### 11.10 Restated headline

> | Measure | Was, §10.6 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 288 | **285** |
> | BUILT-BUT-WRONG | 73 | **76** |
> | NOT-BUILT | 87 | **87** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 80.2 % | **361 / 450 = 80.2 %** |
> | **CORRECT%** (raw) = C/450 | 64.0 % | **285 / 450 = 63.3 %** |
>
> **Correctness went down again and construction did not move at all.** Seven
> rows were wrong before this pass touched anything; three of them are still
> wrong afterwards. Construction is identical because nothing here was
> CONSTRUCTED that was not already constructed — the three repairs closed
> producers for fields and events that were already declared, so the W column
> absorbed them and the C+W total never noticed.

The **spec-attributable** figure (§0: 216 / 450) is **not restated**, for the
reason §9.8 gives: attribution was not re-run, and adjusting it by subtracting
the demoted rows would be arithmetic dressed as measurement.

### 11.11 Decisions surfaced rather than taken

1. **§9.10's first decision is still open, and this pass leaned on it twice.**
   Grading a complete implementation behind a flag seeded OFF as
   BUILT-AND-CORRECT is what keeps MD375 and MD379 at C in §11.3.3 — their only
   emitter is the dark action rail — and what keeps the whole §24 ranking block
   at C over `MEDIA_RANKING_ENABLED`, which returns chronological order when
   off. Applying the owner's "true on every deployment" rule instead would move
   those rows and a hundred like them. **Still not taken here**: it is a
   corpus-wide convention change. It is named again because this section's audit
   depended on it — without it, the §44/§45 block does not split into "has a
   dark emitter" (C) and "has no emitter at all" (W), and that distinction is
   what five of the seven moves rest on.
2. **§9.10's second decision is discharged again, not re-opened.** This pass
   changed `routes/mediaFeed.ts` once more, so `census-wall.md` ages again and is
   acknowledged again with a per-file argument. W7's `post_saves` anchor moved a
   THIRD time — the `save` emitter added eighteen lines above it — and was
   repointed at `routes/mediaFeed.ts:2326#.from("post_saves")`. `check:doc-citations` found it,
   which is the fourth time in three sections that an anchored citation has
   earned its keep, and the only reason this section can say the repoint is
   right rather than hope so.
3. **New, and for the owner rather than for a lane: §3 is wrong about
   production** (§11.7). The remedy is not a document edit — it is a decision
   about migration 2250, which production does not have and which nine W rows
   are waiting on.

### 11.12 The least flattering true thing about this pass

**It measured a column it was also allowed to grade, and the grading went the
way that flattered the measurement.** Seven rows moved C → W and four of those
seven came back to C by the end of the same pass, on code this same pass wrote
and this same pass tested. Nothing outside this section checked either the
demotion or the repair. §10 exists precisely because the previous lane's
headline finding was false, anchored and unreviewed for a commit, and the
structural fact that produced it is unchanged here: **nothing in this repository
can check whether a stated absence was actually searched for**, and five of
§11.3's seven demotions rest on stated absences.

Second, smaller, and still true: **group (a) — the eleven W rows this branch
could fix — is exactly the group this pass did not touch.** Every repair in
§11.4 repairs a row this pass itself demoted an hour earlier. The argument in
§11.6 for leaving the eleven alone is, I believe, correct; it is also the
argument that made the pass's own work the only work it did.

## 12. Group (a) opened — two of the eleven built, one filed under the wrong blocker

Measured at `d9ab209d7`. §1–§11 stand as written; last statement wins for the
ids in §12.7. `head_commit` is **not** moved: this section re-reads a queue, not
450 rows.

### 12.1 What this section was asked for, and what it found first

§11.12 named its own least flattering fact: *"group (a) — the eleven W rows this
branch could fix — is exactly the group this pass did not touch."* This section
took those eleven as its queue. Before building anything it re-executed the
§11.6 argument for each, and the first result is about the queue rather than the
code:

> **One of the eleven is not in group (a), and one of the nineteen in group (c)
> is not in group (c).** §11.6's own sentence moves MD43 into (c) on the ground
> that *"production does not have the column."* Production has the column. §12.5.

Second, and smaller: **§11.2's partition covers 73 rows and the W column is 76.**
MD209, MD387 and MD393 were demoted in §11.3 and never placed in a group — they
belong to (d), (d) and (d) respectively on §11.6's own arguments (no
comment-create endpoint; a client navigation with no server touchpoint; both).
Nothing follows from this for a verdict; it is stated so the next pass does not
read "(a)+(b)+(c)+(d) = the W column" and come up three short.

### 12.2 MD216 — the People lens was two of four, and is now four

The row: *"The People lens prioritises followed users, Trip Crew, Shared Moment
participants and relevant creators … Trip Crew and Shared Moment participants
are not: no `trip_members` or shared-moment read in the builder. Two of four."*

§11.6 declined it on the ground that *"adding trip crew makes it three of four,
which this census still grades W."* That argument is correct about a partial
build and says nothing about a complete one. Both populations were buildable
together, with no migration, no flag and no new table: `trip_members` and
`shared_moment_memberships` are both in the committed production baseline
(`artifacts/api-server/baseline/20260907_production_tables.txt`), and both
already have readers inside the Media lane itself
(`` `artifacts/api-server/src/services/media/MediaExperienceResolver.ts:190#.from("trip_members")` ``).

**Why the two populations were not merely missing but unreachable.** The lens
loaded `feedType: "following"` alone, and that feed type's per-item visibility
gate refuses any author the viewer does not follow —
`` `artifacts/api-server/src/lib/mediaEligibility.ts:381#if (authorId !== viewerCtx.viewerUserId && !viewerCtx.followedCreatorIds.has(authorId)) {` ``.
A Trip Crew member was therefore structurally absent from this lens no matter
what they posted. Meanwhile the client's own copy named both populations to the
user — *"Perspectives from people you follow, your Trip Crew, and Shared Moments
will appear here"*
(`` `travel-buddy-standalone/src/features/media/screens/MediaPeopleScreen.tsx:45#message="Perspectives from people you follow, your Trip Crew, and Shared Moments will appear here."` ``)
— so the lens was advertising two populations the server could not supply.

**Built.** `` `artifacts/api-server/src/services/media/MediaProjectionService.ts:742#export async function loadPeopleAffinities(` ``
resolves both populations in two hops each, where the FIRST hop is the viewer's
own accepted membership — an invitation the viewer never accepted yields nobody,
and an invitation somebody else never accepted does not make them crew. The lens
then runs TWO lanes
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:837#export async function buildPeopleProjection(` ``):
the follow lane unchanged, and an affinity lane that is `feedType: "for_you"`
NARROWED to the crew and Shared Moment ids by a new composing filter
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:200#if (filter.authorIds && filter.authorIds.length > 0) {` ``).

**The bound is stated rather than hidden**, on the precedent §11.4 set for the
Tagged bucket: the affinity lane is PUBLIC-ONLY, so a crew member's `trip_only`
or `private` post is withheld rather than guessed at. Admitting it would need a
per-item membership proof this lane does not carry, and inventing one inside the
choke point is the failure this census exists to catch.

§27's declared order is the priority order, and it beats the perspective count:
a contributor who qualifies under more than one population is counted ONCE, at
the earliest-declared one. `relation` is carried to the client
(`` `travel-buddy-standalone/src/features/media/types/peopleLens.ts:21#export type PeopleLensRelation = 'followed' | 'trip_crew' | 'shared_moment';` ``)
and shown on the section header, so the population is visible and not merely
ordered.

**Three values, not four, and the reason is the row's own.** MD216 credits the
follow graph with *"followed users and creators"*; a "relevant creator" has no
second source, so a fourth enum value would be a vocabulary entry standing in
for a build.

### 12.3 MD147 — Independent Sources was `contributorCount` under a second name

The row: *"the count is displayed nowhere and computed nowhere in the media
path … The independence machinery exists (`lib/intelIndependence.ts`) but
nothing in Media calls it."*

Executed, it was worse than "computed nowhere": the field existed, was served on
every `PerspectiveSummary`, and its entire implementation was
`independentSourceCount: contributors.size` under a comment calling it *"a
coarser, honest proxy"*. Three accounts posting ONE photograph read as three
independent sources — the exact consensus inflation `intelIndependence`'s own
header cites §11 anti-manipulation and AT-04 to refuse.

**§11.6's argument for leaving it is half wrong, and the wrong half is the
load-bearing one.** It says the independence detectors need *"shared evidence
media, common source and synchronised timing — none of which a media projection
carries: no group key, no asset hash, no source ref."* Two of those three are
false:

- **Asset key.** `IndependenceObservation.mediaRefs` is documented as *"asset
  keys / content hashes of media evidence"*
  (`` `artifacts/api-server/src/lib/intelIndependence.ts:66#/** Asset keys / content hashes of media evidence attached to this observation. */` ``).
  The served media URL **is** the asset key: two posts resolving to one stored
  file are one source. The projection has carried it all along.
- **Group key.** `posts.trip_id` is a party token and is already selected by
  `MEDIA_PROJECTION_POST_COLUMNS`. It must never be written onto a projection —
  the projection is a privacy whitelist and trip membership is not on it — but
  it can be handed to the aggregator as an input.
- **Common source** is the half that IS right, and it is *inapplicable* rather
  than missing: no media perspective is ever produced by an official feed or a
  partner API, so there is no reference for a photograph to carry.

**Built.**
`` `artifacts/api-server/src/services/media/MediaPerspectiveService.ts:120#function countIndependentSources(` ``
clusters the perspectives; the party token reaches it as a side channel built
from the candidate rows
(`` `artifacts/api-server/src/services/media/MediaProjectionService.ts:613#function partyTokensByPostId(` ``)
and is asserted never to leave the server on the projection.

**The sync detector is made INERT on purpose, and that is the decision worth
recording.** `valueKey` is the perspective's own id, which cannot collide, so
the synchronised-behaviour rule can never fire. A photograph asserts no value:
two strangers shooting the same bar seconds apart are two witnesses, and mapping
that detector onto `placeId` would destroy honest corroboration rather than
catch coordination. Mutation M24 does exactly that and reddens four cases,
including two that were green before this pass — which is the evidence that the
inertness is a choice and not an omission.

### 12.4 Mutations

Ten. Each applied, run, and reverted, with the file's SHA-256 recomputed after
the revert and compared to the pre-mutation digest. Suites:
`` `artifacts/api-server/src/test/mediaPeopleLensPopulations.test.ts:182#describe("MD216 — loadPeopleAffinities resolves the two missing §27 populations", () => {` ``
(13 cases) and
`` `artifacts/api-server/src/test/mediaIndependentSources.test.ts:85#describe("MD147 — independent sources are CLUSTERED, not counted as contributors", () => {` ``
(14 cases), both registered at the END of `artifacts/api-server/package.json`.

| Mutation | What it did | What went red |
| --- | --- | --- |
| M16 | force the affinity lane's id set empty | 4 of 13 — both populations and the ordering |
| M17 | drop the accepted-status check on the second membership hop | `an UNACCEPTED membership admits nobody — on either table` |
| M18 | sort the lens by perspective count only | `orders the populations as §27 names them` |
| M19a | delete the QUERY-level `for_you` visibility restriction | **nothing** — the per-item gate still refused |
| M19b | delete the query-level restriction AND the per-item `for_you` gate | `THE BOUND: a crew member's trip_only and private posts are withheld` |
| M20 | remove the followed-id pre-filter AND the post-id dedupe | `a person who is BOTH followed and crew is counted ONCE` |
| M21 | restore `independentSourceCount: contributors.size` | 5 of 14 |
| M22 | empty `mediaRefs` — drop the shared-evidence-media signal | 3 of 14, incl. the AT-04 three-copy case |
| M23 | stop passing the party token from the place projection | `two authors of one trip … → 1 independent source` |
| M24 | map the sync detector onto `placeId` instead of the perspective id | 4 of 14, incl. two that assert honest corroboration SURVIVES |

**M19a is reported because it stayed green.** It is the honest half of the pair:
the public-only bound does not rest on the one line the test appears to be
about, it is defended twice, and only removing BOTH layers reddens the case. A
mutation that fails to redden is evidence about the assertion, and suppressing
it would make the other nine look stronger than they are.

**What would leave these green and worthless.** Both suites drive the builders
directly, so neither would notice a ROUTE that stopped calling them — the same
P24 gap §9.6 opened and §11.5 restated, still open. The MD147 cases assert on
`buildPerspectiveSummary`, which is reached from `buildPlaceProjection` alone;
no other builder computes a perspective summary, so there is no second caller
for them to be silent about.

### 12.5 CORRECTION to §11.6 — MD43 is not capped by migration 2250

§11.6 places MD43 in group (c) with an argument stated as fact:
*"`media_attachments.visibility_override` has one writer, on the flag-gated
canonical path, and **production does not have the column** — migration 2250 is
unapplied there. A reader for it would be a read of a column that does not
exist."*

**Production has the column, and 2250 is not what creates it.** The column is
created inline by `0191_media_assets.sql`'s `CREATE TABLE`
(`` `artifacts/api-server/src/migrations/0191_media_assets.sql:52#visibility_override TEXT,` ``),
`media_attachments` is in the production table list
(`artifacts/api-server/baseline/20260907_production_tables.txt`), and the
production structure dump carries the column on that table
(`artifacts/api-server/baseline/20260819_baseline_structure.sql:7227`). 2250 adds
it only conditionally, for a database whose 0191 predates it. The successor
migration says so in its own words: *"§6.1 media_attachments columns (assert
present; 0191 created them)"*
(`` `artifacts/api-server/src/migrations/2470_media_asset_canonical_columns_flag_agnostic.sql:186#-- ── 4. §6.1 media_attachments columns (assert present; 0191 created them) ─────` ``).

**The verdict does not move and the real blocker is different in kind.** MD43
stays **W**. Its own row text is right — *"nothing reads it"* — and the reason no
reader exists is not an absent column but an absent CALLER: the only module that
could consult the override is
`` `artifacts/api-server/src/lib/media/mediaCanonicalRead.ts:199#export async function attachCanonicalMedia(` ``,
which selects `entity_id, position, is_cover` and the asset, never
`visibility_override`, and which that same file records as *"called from
nowhere, and that is a real gap"*. `media_attachments` is also empty in both
databases. So MD43 is a **(d)** row — work nobody has commissioned — not a (c)
row waiting on a deploy. **It was not built here**, because a reader wired into a
function with no caller, over a table with no rows, would move a letter without
moving the product, and that is §9.4's vacuous C.

### 12.6 Migration 2250, re-established at HEAD — it is not the thing nine rows wait on

§11.11 closes on *"a decision about migration 2250, which production does not
have and which nine W rows are waiting on."* Re-executed:

- **2250 cannot be applied to production as written, and not for a reason
  anybody has to decide.** Its final postcondition raises if
  `media_canonical_enabled` is TRUE
  (`` `artifacts/api-server/src/migrations/2250_media_asset_canonical_model.sql:223#RAISE EXCEPTION 'POSTCONDITION FAILED: media_canonical_enabled is ON — Phase 1 must not flip the read path';` ``),
  the flag IS TRUE in production (§11.7's own correction), and the raise is
  inside `BEGIN … COMMIT` — so the transaction rolls back and the columns are
  not created. The ledger records it as `do_not_apply` as written
  (`docs/architecture/migration-disposition-ledger.md:134`).
- **A successor exists and is the file the rows actually wait on.** `2470`
  re-issues the same column set without that postcondition, and is itself
  `blocked_by_owner_decision — MEDIA_CANONICAL_FLAG`
  (`docs/architecture/migration-disposition-ledger.md:130`).
- **So the open item is not "apply 2250".** It is a choice of ORDER, and 2470's
  own header states both: take the flag DOWN and then apply 2250, or apply 2470
  under the live flag. Either creates the four `media_assets` columns; neither
  is a thing a lane may do.

**The count is nine, and §11.6 made it ten by accident.** §11.7 names MD36,
MD37, MD38, MD57, MD60, MD338, MD339, MD343 and MD429 — nine, and all nine rest
on `captured_at` / `provenance` / `intelligence_eligibility`, which production
genuinely lacks. §11.6 added MD43 as a tenth on the visibility_override ground
refuted in §12.5. **Nine is right; MD43 was never one of them.**

### 12.7 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| MD216 | W | **C** | §27's four populations are four. `loadPeopleAffinities` resolves Trip Crew and Shared Moment participants from two tables already in production, a second `for_you`-narrowed lane admits their public perspectives, and §27's declared order beats the count. M16/M17/M18/M20 red; M19b red on the stated public-only bound. §12.2. |
| MD147 | W | **C** | `independentSourceCount` is `clusterByIndependence` over the two signals a perspective carries — the asset key and the party token — instead of a second name for `contributorCount`. Three copies of one photograph are one source. M21/M22/M23 red; M24 red in the other direction, proving the sync detector's inertness is a choice. §12.3. |
| MD43 | W | **W** | Verdict unchanged, blocker replaced. §11.6's *"production does not have the column"* is false — 0191 created it inline and the production dump carries it. The real blocker is that `attachCanonicalMedia` has no caller and `media_attachments` is empty in both databases, which makes MD43 a **(d)** row, not a **(c)** one. §12.5. |

Nothing else moved. The other nine group-(a) rows were re-read and §11.6's
argument holds for each: MD94 / MD213 / MD378 wait on a directions affordance
that does not exist, MD370 / MD383 on a table absent from production,
MD104 on a conversation id the share handler does not hold, MD15 / MD33 / MD428
on decisions taken in the client.

### 12.8 The §9.10 decision, scoped — the rows it moves, and both verdicts

Not taken here. Named exactly, because §11.11 said *"those rows and a hundred
like them"* and a hundred is not a list.

`MEDIA_RANKING_ENABLED` is seeded FALSE
(`` `artifacts/api-server/src/migrations/2038_media_admin_flags.sql:23#('MEDIA_RANKING_ENABLED', false,` ``)
and with it false the ranker returns chronological order with `score=0` and no
snapshot
(`` `artifacts/api-server/src/services/ranking/MediaFeedRankingService.ts:648#if (!flags.rankingEnabled) {` ``).
`MEDIA_WORLD_SHELL_ENABLED` is seeded FALSE
(`` `artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql:116#false,` ``).

| block | rows | verdict as graded today | verdict under *"a flag-dark row is not a realized row"* |
| --- | --- | --- | --- |
| §24 ranker terms — each graded C on a `DEFAULT_WEIGHTS` weight or a ranking layer | MD178, MD180, MD181, MD182, MD183, MD185, MD186, MD189, MD190, MD193, MD199, MD200 — **12** | **C** | **W** |
| §44 outcome names whose only emitter is the dark action rail | MD375, MD379 — **2** | **C** | **W** |

**Two §24 rows are deliberately NOT on that list.** MD191 (Privacy) and MD192
(Safety) are graded C on a GATE that runs before ranking and independently of the
flag, which their own evidence says in as many words. They stay C under either
reading, and including them would have inflated the decision's cost by two.

**The corpus was not enumerated.** These fourteen are the two blocks §11.11
names, verified row by row. Whether the convention has the same cost elsewhere
is unmeasured here — and census-map grades the identical shape the other way
today (`census-map.md` §41), so the decision is a corpus convention and not a
media one.

### 12.9 §11.8 is stale in the direction that matters

§11.8 declined to repoint forty §5 citations because *"UNANCHORED sits at its
ceiling of 6490 with zero headroom."* Measured at `d9ab209d7`:
**6417 of 6490 — 73 of headroom.** The argument for a separate pass still
stands on its own merits; the arithmetic it rested on does not. The forty ids
§11.8 names are still unrepointed and still correct as findings.

Five anchored citations WERE repointed here, by exact original line text and not
by offset, because this section's code displaced them:
`loadPlaceNeighborhoods` 323→338, `[ctx, neighborhoods]` 433→448,
`loadTaggedPostIds` 902→1106, `loadTaggedMedia` 949→1153 in this document, and
the Hidden Gems bucket 861→1065 in `census-highlights-memories.md`.
`census-telegraph.md` cites the same file twice at `:978`, now `:1182`, and both
were repointed — the third time in four sections that an anchored citation has
caught its own decay, and the reason this paragraph can say the repoint is right
rather than hope so.

### 12.10 Restated headline

> | Measure | Was, §11.10 | Now |
> | --- | --- | --- |
> | Denominator (testable requirements) | 450 | **450** |
> | BUILT-AND-CORRECT | 285 | **287** |
> | BUILT-BUT-WRONG | 76 | **74** |
> | NOT-BUILT | 87 | **87** |
> | CANNOT-VERIFY | 2 | **2** |
> | **CONSTRUCTED%** = (C+W)/450 | 80.2 % | **361 / 450 = 80.2 %** |
> | **CORRECT%** (raw) = C/450 | 63.3 % | **287 / 450 = 63.8 %** |
>
> Restated from `pnpm -s check:census-integrity`, not by hand. Construction does
> not move, again and for the same reason: both repairs closed a computation for
> a field that was already declared and already served, so the W column handed
> two rows to the C column and the C+W total never noticed. The gap between the
> two figures fell 16.9 → **16.2** points.

The **spec-attributable** figure (§0: 216 / 450) is **not restated**: attribution
was not re-run, and adjusting it by adding two promoted rows would be arithmetic
dressed as measurement.

### 12.11 The least flattering true thing about this pass

**It closed the two easiest rows in group (a) and left the argument for the
other nine exactly where it found it.** MD216 and MD147 were the two rows whose
requirement was satisfiable entirely inside one server file, over tables that
are already in production, with no product decision in the way. That is why they
were closed, and a pass that picked the two tractable rows out of eleven should
say so rather than imply the queue was worked.

Second, and structural: **§12.5 is the second time in two sections that a stated
deployment blocker turned out to be false when somebody opened the migration.**
§11.7 corrected §3 about `media_canonical_enabled`; §12.5 corrects §11.6 about
`visibility_override`. Both were asserted from reading a migration rather than
the database, both were wrong in the direction that made a row look harder than
it is, and nothing in this repository can catch the next one — the production
table list and the structure dump are the only two artifacts that could, and
neither is consulted by any check.
